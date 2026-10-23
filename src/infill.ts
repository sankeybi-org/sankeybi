/**
 * Node arrow infill: heads and tails drawn inside a node.
 *
 * A node's arrows are decoration laid inside its container, which is the node shape when there
 * is one and the node rectangle otherwise. Routing is untouched by them: every corridor still
 * leaves and arrives at the node's own edges, and nothing here moves an anchor or changes a
 * path. What this does is continue the packed stack at a face inward, as a head or a tail.
 *
 * This is geometry, so it lives with routing rather than in render, which paints what it is
 * handed. The stripes also have to line up with the bands arriving at that face, which means
 * deriving them from the same anchors and the same per-segment spans `routeCorridor` uses;
 * computed twice, they would drift.
 */

import {
    ArrowOptions, Corridor, CorridorSegment, LayoutResult, Point, Port, PORT_NORMALS, PositionedNode
} from "./model";
import { portAxis } from "./flowAxis";
import { arrowClearanceLoss, arrowDepth, arrowGapPixels, arrowStemInset, stripeGapCount } from "./arrows";
import { Anchor, EndRole, FaceEnd, HalfPlane, NodeInfill } from "./routeTypes";
import { anchorKey } from "./anchors";
import { ARROW_BASE_BLEED, STRIPE_BLEED } from "./routeConstants";
import { stripeOutlineRuns } from "./bands";

/**
 * Sutherland-Hodgman against one half-plane. Every region an arrow slices a stripe into is
 * convex (a head is the triangle itself, and a tail is the two pieces either side of its
 * notch), so one clip per plane is enough and no general polygon boolean is needed.
 */
function clipToHalfPlane(poly: Point[], plane: HalfPlane): Point[] {
    const signedDistance = (p: Point) => plane.a * p.x + plane.b * p.y + plane.c;
    const out: Point[] = [];
    poly.forEach((cur, i) => {
        const prev = poly[(i + poly.length - 1) % poly.length];
        const dPrev = signedDistance(prev);
        const dCur = signedDistance(cur);
        const prevIn = dPrev <= 1e-9;
        const curIn = dCur <= 1e-9;
        if (prevIn !== curIn) {
            const t = dPrev / (dPrev - dCur);
            out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
        }
        if (curIn) {
            out.push(cur);
        }
    });
    return out;
}

/**
 * The two edges of an arrow of half-width `H` and depth `depth`, as half-planes in the local
 * frame: `t` runs inward from the face, `y` along it from the run's centre. Inside the arrow
 * is `|y| <= H * (1 - t/depth)`.
 */
function arrowEdges(H: number, depth: number, stem: number): { upper: HalfPlane; lower: HalfPlane } {
    // Inside the taper is |y| <= H * (1 - (t - stem)/depth), i.e. the same two planes slid `stem`
    // further in. Ahead of them the enclosing rectangle's own sides bind, which is exactly the
    // full-width stem: one convex region covers stem and taper together, so no second polygon is
    // needed.
    return {
        upper: { a: H, b: depth, c: -H * (depth + stem) },
        lower: { a: H, b: -depth, c: -H * (depth + stem) }
    };
}

/**
 * The polygons one stripe contributes.
 *
 * A head is the stripe cut to the taper: the colours hold their widths and only the outer ones
 * are trimmed, so it reads as the stack itself coming to a point. Full width at the face,
 * nothing at the tip.
 *
 * A tail is the other way round: full width at the face, where the band leaves, and notched at
 * its back, deepest inside the node. Its chevron points the way the flow is going, which means
 * the material is `t <= depth * |y| / H`: present everywhere at t = 0, and only at the outer
 * edges by t = depth. A stripe running through the run's centre therefore has a concave vertex
 * there, which is what makes it a tail and not a second head.
 */
function stripeSlices(
    lo: number,
    hi: number,
    H: number,
    depth: number,
    kind: "head" | "tail",
    /** How far the base reaches back past the container's face, to overlap its band. */
    baseBleed = 0,
    /**
     * Full-width run between the face and the taper, which puts the taper where `arrowStemInset`
     * asks however thick the node or its shape happens to be. It is drawn in the stripe's own
     * colours at the band's own width, so the part of it lying over the band is invisible.
     */
    stem = 0
): Point[][] {
    const rect: Point[] = [
        { x: -baseBleed, y: lo }, { x: stem + depth, y: lo },
        { x: stem + depth, y: hi }, { x: -baseBleed, y: hi }
    ];
    if (kind === "head") {
        const { upper, lower } = arrowEdges(H, depth, stem);
        const clipped = clipToHalfPlane(clipToHalfPlane(rect, upper), lower);
        return clipped.length >= 3 ? [clipped] : [];
    }
    // A tail's material is `t <= stem + depth * |y| / H`: full width as far as the notch's
    // vertex, then only the outer edges. The vertex is the apex, where a head's apex is its tip a
    // further `depth` in.
    //
    // It is one polygon, walked from the notch's own profile. Building it as the rectangle clipped
    // to the two notch half-planes gives the right fill, since the two pieces union to exactly
    // this, but each piece then carries the other's taper as a real edge lying inside the
    // material, and an outline strokes every edge it is handed: a slanted line across the tail.
    // That shows when the arrow gap is small, because the stem is `(extent - gap - loss) / 2`:
    // the shorter the gap the longer the stem, and the further that false edge reaches out of the
    // one pixel of base bleed it is otherwise hidden in.
    //
    // The profile is single-valued in `y` (the material reaches `stem + depth * |y| / H`, capped
    // by the rectangle's own far side), so the polygon is the base edge, that profile walked from
    // `lo` up to `hi`, and back.
    //
    // It kinks in exactly three places, and each has to be a vertex or the edge between them is
    // drawn at the wrong slope: the notch apex at y = 0, and the two points y = +-H where the
    // wings meet the rectangle's far side and stop deepening. The wings matter because
    // STRIPE_BLEED can carry a stripe past the run's own edge (a deliberate sub-pixel overlap is
    // wider than a very thin last stripe, so the one before it ends beyond `H`).
    if (!(H > 0) || depth <= 0) {
        return [rect];
    }
    const reach = (y: number): number =>
        Math.min(stem + depth * Math.abs(y) / H, stem + depth);
    const profile: Point[] = [{ x: reach(lo), y: lo }];
    [-H, 0, H].filter(y => y > lo && y < hi).sort((a, b) => a - b)
        .forEach(y => profile.push({ x: reach(y), y }));
    profile.push({ x: reach(hi), y: hi });
    return [[{ x: -baseBleed, y: lo }, ...profile, { x: -baseBleed, y: hi }]];
}

/**
 * The node's container: the shape when one is drawn, the node rectangle otherwise. An arrow's
 * base sits on this box's edge, which makes a head read as entering the shape rather than the
 * invisible node beneath it.
 *
 * Render clips the result to the shape's real outline, so a circle's curve and a rounded
 * rectangle's corners are honoured without this having to know which shape is in use.
 */
function containerOf(node: PositionedNode): { left: number; right: number; top: number; bottom: number } {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const w = node.shapeWidth > 0 ? node.shapeWidth : node.width;
    const h = node.shapeHeight > 0 ? node.shapeHeight : node.height;
    return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

/** Local (inward, along-face) -> world, for one face of a container. */
function faceTransform(
    port: Port,
    box: { left: number; right: number; top: number; bottom: number },
    /** Where the run's centre sits along the face, in world coordinates. */
    mid: number
): (p: Point) => Point {
    switch (port) {
        case "West":
            return p => ({ x: box.left + p.x, y: mid + p.y });
        case "East":
            return p => ({ x: box.right - p.x, y: mid + p.y });
        case "North":
            return p => ({ x: mid + p.y, y: box.top + p.x });
        case "South":
        default:
            return p => ({ x: mid + p.y, y: box.bottom - p.x });
    }
}

/**
 * Which way a face lays a corridor's stripes, as +1 or -1 along that face's own axis.
 *
 * A band offsets each stripe from its spine along the spine's normal, stripe 0 at
 * -halfExtent and increasing; so an arrow continuing that band has to walk the same direction,
 * or its stripes come out in the opposite order from the band they join (right widths,
 * reversed).
 *
 * That direction is not constant. It follows the normal, the normal follows the direction of
 * travel, and travel at an end runs out along the port's outward normal where the flow leaves
 * and in against it where the flow arrives. Four of the eight (port, role) pairs come out
 * reversed from "always forward along the axis". The defaults of a left-to-right diagram, East
 * out and West in, are both in the half that happens to agree, so the difference only shows
 * once diagrams can run top to bottom.
 */
function stripeDirection(port: Port, role: EndRole): number {
    const outward = PORT_NORMALS[port];
    const towards = role === "source" ? 1 : -1;
    const travelX = outward.x * towards;
    const travelY = outward.y * towards;
    // The spine's normal is travel turned a quarter turn, (-ty, tx). An East/West face runs along
    // y and takes that normal's y; a North/South face runs along x and takes its x.
    return portAxis(port) === "vertical" ? travelX : -travelY;
}

/** How deep the container is along a port's inward direction. */
function containerDepth(
    port: Port,
    box: { left: number; right: number; top: number; bottom: number }
): number {
    return portAxis(port) === "vertical" ? box.right - box.left : box.bottom - box.top;
}

/**
 * Every node's arrow stripes.
 *
 * Runs are split by direction and kept contiguous: with the default ports a face carries only
 * inbound or only outbound ends, and this reduces to "one head per face", but a port override
 * can interleave the two and a single triangle spanning both would be wrong.
 */
export function buildNodeInfill(
    layout: LayoutResult,
    anchors: Map<string, Anchor>,
    arrows: ArrowOptions
): NodeInfill[] {
    if (!arrows.heads && !arrows.tails) {
        return [];
    }
    const faces = new Map<string, FaceEnd[]>();
    const add = (nodeId: string, port: Port, corridor: Corridor, role: EndRole) => {
        const anchor = anchors.get(anchorKey(corridor.id, role));
        if (!anchor || corridor.value <= 0) {
            return;
        }
        const centre = portAxis(port) === "vertical" ? anchor.point.y : anchor.point.x;
        const key = `${nodeId}|${port}`;
        const list = faces.get(key);
        const end: FaceEnd = { corridor, role, anchor, centre };
        if (list) {
            list.push(end);
        } else {
            faces.set(key, [end]);
        }
    };
    layout.corridors.forEach(corridor => {
        add(corridor.source, corridor.sourcePort, corridor, "source");
        add(corridor.target, corridor.targetPort, corridor, "target");
    });

    // A run's uncapped depth, so opposite faces can be scaled together below.
    interface Run {
        nodeId: string;
        port: Port;
        kind: "head" | "tail";
        ends: FaceEnd[];
        lo: number;
        hi: number;
        depth: number;
    }
    const runs: Run[] = [];
    faces.forEach((ends, key) => {
        const [nodeId, port] = key.split("|") as [string, Port];
        ends.sort((a, b) => a.centre - b.centre);
        let current: FaceEnd[] = [];
        const flush = () => {
            if (current.length === 0) {
                return;
            }
            // A source end is flow leaving the node, so it is drawn as a tail.
            const kind: "head" | "tail" = current[0].role === "target" ? "head" : "tail";
            if ((kind === "head" && arrows.heads) || (kind === "tail" && arrows.tails)) {
                const lo = Math.min(...current.map(e => e.centre - e.anchor.halfExtent));
                const hi = Math.max(...current.map(e => e.centre + e.anchor.halfExtent));
                runs.push({
                    nodeId, port, kind, ends: current, lo, hi,
                    depth: arrowDepth((hi - lo) / 2, arrows.angleDegrees)
                });
            }
            current = [];
        };
        ends.forEach(end => {
            if (current.length > 0 && current[0].role !== end.role) {
                flush();
            }
            current.push(end);
        });
        flush();
    });

    // Opposite faces share the container's depth. Layout grows the node (or its shape) so both fit
    // at the set angle, but a container can still be shorter than that (a shape sized from a
    // label, say) and an arrow must never run out the far side of the node it is inside.
    const deepest = new Map<string, number>();
    runs.forEach(run => {
        const key = `${run.nodeId}|${portAxis(run.port)}|${run.port}`;
        deepest.set(key, Math.max(deepest.get(key) ?? 0, run.depth));
    });

    // The gap is one number for the whole diagram, so every arrow in it is placed against the
    // same distance.
    const gap = arrowGapPixels(arrows, layout.packingPitch);
    const separation = layout.flowSeparation ?? 0;

    // The stem, one per (node, axis): both facing arrows take the same one, so a head's triangle
    // base and the tail's notch vertex sit level, and so do the head's tip and the tail's wings.
    // The two faces have to be solved together, because what their tapers cost the clearance
    // between them depends on which of the two is the head.
    const axisStem = new Map<string, number>();
    const deepestRun = new Map<string, { head: number; tail: number }>();
    runs.forEach(run => {
        const key = `${run.nodeId}|${run.port}`;
        const face = deepestRun.get(key) ?? { head: 0, tail: 0 };
        face[run.kind] = Math.max(face[run.kind], run.depth);
        deepestRun.set(key, face);
    });
    const EMPTY = { head: 0, tail: 0 };
    layout.nodes.forEach(node => {
        const box = containerOf(node);
        ([["East", "West", "vertical"], ["North", "South", "horizontal"]] as [Port, Port, string][])
            .forEach(([lo, hi, axis]) => {
                const a = deepestRun.get(`${node.id}|${lo}`) ?? EMPTY;
                const b = deepestRun.get(`${node.id}|${hi}`) ?? EMPTY;
                const loss = arrowClearanceLoss(a.head, a.tail, b.head, b.tail);
                axisStem.set(`${node.id}|${axis}`,
                    arrowStemInset(containerDepth(lo, box), gap, loss));
            });
    });

    const out: NodeInfill[] = [];
    // The deepest head drawn on each face, so the label fit below can be re-tested against the
    // room they left. Heads only: a tail is notched, so its material sits at the outer edges and
    // nothing lies on the centre line a label runs along.
    const used = new Map<string, number>();
    runs.forEach(run => {
        const node = layout.nodes.get(run.nodeId);
        if (!node) {
            return;
        }
        const box = containerOf(node);
        const available = containerDepth(run.port, box);
        let depth: number;
        let stem = 0;
        {
            // Both arrows on the axis share this stem, so the head's triangle base and the tail's notch
            // vertex sit level, and so do the head's tip and the tail's wings. The node was floored to
            // hold the gap (`arrowExtentFloor`), so the stem is normally the surplus a shape adds, which is
            // how a gap stops depending on the shape while the arrow still enters it.
            //
            // The angle is never traded for the gap here: both are honoured because the node was sized for
            // both. The clamp is only a backstop against a container too short to hold the arrow at all
            // (a shape sized from a label), and it keeps the arrow inside the node rather than reshaping
            // it to fit.
            stem = axisStem.get(`${run.nodeId}|${portAxis(run.port)}`)
                ?? arrowStemInset(available, gap, run.depth);
            depth = Math.min(run.depth, Math.max(0, available - stem));
        }
        if (depth + stem <= 0.01) {
            return;
        }

        if (run.kind === "head") {
            // The room a head takes from a label is everything it covers, so the stem counts: a head whose
            // taper is held back by a shape still fills the node from the face to its tip.
            used.set(`${run.nodeId}|${run.port}`,
                Math.max(used.get(`${run.nodeId}|${run.port}`) ?? 0, depth + stem));
        }

        const H = (run.hi - run.lo) / 2;
        const mid = (run.lo + run.hi) / 2;
        const toWorld = faceTransform(run.port, box, mid);

        // Flattened first so the last stripe of the whole run is known: like a corridor's stripes,
        // every one but the last bleeds over the next.
        const stripes: { end: FaceEnd; seg: CorridorSegment; lo: number; hi: number }[] = [];
        run.ends.forEach(end => {
            // The same per-segment spans routeCorridor lays across the spine, so a stripe here is the
            // stripe that arrives here, walked in the band's own offset space from -halfExtent up and only
            // then mapped onto the face. Walking the face directly puts the stripes in the wrong order on
            // half the faces; see stripeDirection.
            const corridorValue = end.corridor.value || 1;
            const direction = stripeDirection(run.port, end.role);
            let offset = -end.anchor.halfExtent;
            // The same two lines routeCorridor lays its stripes with, so an arrow's stripes and its
            // band's stay level by construction rather than by agreement.
            const innerGaps = separation * stripeGapCount(end.corridor);
            const flowExtent = end.anchor.halfExtent * 2 - innerGaps;
            let drawn = 0;
            end.corridor.segments.forEach((seg, segIndex) => {
                if (seg.value > 0 && drawn > 0) {
                    offset += separation;
                }
                if (seg.value > 0) {
                    drawn++;
                }
                const span = flowExtent * (seg.value / corridorValue);
                // Bled only when another stripe of the same corridor follows, which is what its band does.
                // Bled per run instead, a face carrying two corridors would have the first one's last stripe
                // bleed here but not in its band, a step at the join.
                //
                // Applied to the high edge in offset space, exactly as the band applies it, so on a reversed
                // face it lands on the low edge in world terms, which is the side the band bleeds there too.
                const lastOfCorridor = segIndex === end.corridor.segments.length - 1;
                const low = offset;
                // Dropped with the seam it closes, exactly as the band drops it.
                const high = offset + span
                    + (separation > 0 || lastOfCorridor ? 0 : STRIPE_BLEED);
                const a = end.centre + direction * low - mid;
                const b = end.centre + direction * high - mid;
                stripes.push({ end, seg, lo: Math.min(a, b), hi: Math.max(a, b) });
                offset += span;
            });
        });
        stripes.forEach(stripe => {
            const { end, seg } = stripe;
            // Inside a node an arrow abuts the shape on its outer edges, which anti-aliases like any other
            // shared edge and shows the shape through it. So unlike a band, whose silhouette reports the
            // value and must stay exact, every edge here bleeds, the outermost ones out over the shape.
            // The apparent boundary between stripes is still the next one's true low edge, so the stripes
            // keep their proportions.
            //
            // This is exactly the band's rule: the low edge is never bled, and the high edge only when
            // another stripe of the same corridor follows it. Bleeding the outer edges as well would make
            // the arrow 2 x STRIPE_BLEED wider than the corridor it continues, with a visible step at the
            // join.
            const lo = stripe.lo;
            const hi = stripe.hi;
            const pieces = stripeSlices(lo, hi, H, depth, run.kind, ARROW_BASE_BLEED, stem);
            if (pieces.length === 0) {
                return;
            }
            const world = (p: Point): string => {
                const w = toWorld(p);
                return `${w.x} ${w.y}`;
            };
            const path = pieces.map(piece =>
                `M ${piece.map(world).join(" L ")} Z`).join(" ");
            const outline = pieces
                .flatMap(piece => stripeOutlineRuns(piece, -ARROW_BASE_BLEED))
                .map(run => `M ${run.map(world).join(" L ")}`)
                .join(" ");
            out.push({
                nodeId: run.nodeId,
                port: run.port,
                corridorId: end.corridor.id,
                flowType: seg.flowType,
                value: seg.value,
                kind: run.kind,
                path,
                outline
            });
        });
    });

    // An arrow eats into the container from its own face, so a label drawn inside has less room
    // than layout could know about: layout is not told whether arrows are on, and their depth is
    // clamped here anyway. Mutating the layout from routing is the same arrangement
    // straighten.ts uses; nothing downstream of render reads labelInside.
    layout.nodes.forEach(node => {
        if (!node.labelInside) {
            return;
        }
        const box = containerOf(node);
        const depthOn = (port: Port) => used.get(`${node.id}|${port}`) ?? 0;
        const freeWidth = (box.right - box.left) - depthOn("West") - depthOn("East");
        const freeHeight = (box.bottom - box.top) - depthOn("North") - depthOn("South");
        if (node.labelBoxWidth > freeWidth || node.labelBoxHeight > freeHeight) {
            node.labelInside = false;
        }
    });
    return out;
}
