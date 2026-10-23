import { Point } from "./model";
import { add, length, lineIntersection, scale, sub, unit } from "./routeMath";
import { DEGENERATE_LENGTH, EDGE_MIN_STEP, MITER_LIMIT } from "./routeConstants";
import { SpineSample } from "./routeTypes";
import { splineWithCorners } from "./curves";

/**
 * Offsets a polyline sideways with mitred corners: each band edge vertex is the intersection
 * of the two neighbouring offset lines.
 *
 * This is the sharp-corner counterpart to `offsetFromSpine`. Sweeping a normal along sampled
 * points cannot produce a sharp corner: the normal flips discontinuously there and, on the
 * inside of the turn, consecutive offset points cross over so the ribbon folds through itself.
 * That is why the rounded path floors its radius at the band's half-width. Taking the
 * intersection instead cannot fold, and it handles a tapering band for free since each vertex
 * carries its own offset.
 */
export function offsetPolyline(vertices: Point[], offsets: number[]): Point[] {
    const edges: { a: Point; b: Point }[] = [];
    for (let i = 0; i < vertices.length - 1; i++) {
        const span = sub(vertices[i + 1], vertices[i]);
        if (length(span) < DEGENERATE_LENGTH) {
            continue;
        }
        const direction = unit(span);
        const normal = { x: -direction.y, y: direction.x };
        edges.push({
            a: add(vertices[i], scale(normal, offsets[i])),
            b: add(vertices[i + 1], scale(normal, offsets[i + 1]))
        });
    }
    if (edges.length === 0) {
        return vertices.slice();
    }

    const out: Point[] = [edges[0].a];
    for (let i = 1; i < edges.length; i++) {
        const previous = edges[i - 1];
        const current = edges[i];
        const corner = lineIntersection(previous.a, previous.b, current.a, current.b);
        // A miter on a very sharp turn shoots off to a spike, so past a limit fall back to a bevel:
        // keep both offset endpoints and cut across.
        const reach = corner ? length(sub(corner, vertices[i])) : Infinity;
        if (corner && reach <= MITER_LIMIT * Math.max(Math.abs(offsets[i]), 1)) {
            out.push(corner);
        } else {
            out.push(previous.b, current.a);
        }
    }
    out.push(edges[edges.length - 1].b);
    return out;
}

/**
 * Displaces every spine sample along its local normal, easing from the source offset to the
 * target offset.
 */
export function offsetFromSpine(spine: SpineSample[], sourceOffset: number, targetOffset: number): Point[] {
    return spine.map(s => {
        const offset = sourceOffset * (1 - s.weight) + targetOffset * s.weight;
        return { x: s.x + s.nx * offset, y: s.y + s.ny * offset };
    });
}

/**
 * Assembles a closed band from two mitred edges, joining with straight lines. Deliberately not
 * the spline emitter below: running sharp corners through a curve fit would round off the very
 * thing this path exists to produce.
 */
export function sharpBandPath(lowEdge: Point[], highEdge: Point[]): string {
    const parts: string[] = [`M ${lowEdge[0].x} ${lowEdge[0].y}`];
    lowEdge.slice(1).forEach(p => parts.push(`L ${p.x} ${p.y}`));
    [...highEdge].reverse().forEach(p => parts.push(`L ${p.x} ${p.y}`));
    parts.push("Z");
    return parts.join(" ");
}

/**
 * A band's two long edges, capped only where no arrow continues the flow.
 *
 * The sharp counterpart of `openEdgesFromEdges`, and a sibling of `sharpBandPath` for the same
 * reason `closeBand` dispatches between the two: a sharp route's edges are polylines, not
 * splines, and an outline built the spline way would be the wrong shape on every one of them.
 * The rule, the four cases and the mitre are all that function's; see it for why.
 */
export function sharpOpenEdges(
    lowEdge: Point[], highEdge: Point[],
    closeSource = false, closeTarget = false
): string {
    const to = (p: Point) => `L ${p.x} ${p.y}`;
    const low = lowEdge.slice(1).map(to);
    // Target -> source, so a `L` onto `lowEdge[0]` is the source cap.
    const highBack = [...highEdge].reverse();
    const highRun = highBack.slice(1).map(to);
    if (closeTarget) {
        return [`M ${lowEdge[0].x} ${lowEdge[0].y}`, ...low, to(highBack[0]), ...highRun,
            ...(closeSource ? ["Z"] : [])].join(" ");
    }
    if (closeSource) {
        return [`M ${highBack[0].x} ${highBack[0].y}`, ...highRun, to(lowEdge[0]),
            ...low].join(" ");
    }
    return [`M ${lowEdge[0].x} ${lowEdge[0].y}`, ...low,
        `M ${highEdge[0].x} ${highEdge[0].y}`, ...highEdge.slice(1).map(to)].join(" ");
}

/**
 * Respaces a band edge so no two consecutive points are closer than EDGE_MIN_STEP, keeping
 * both ends exactly where they are.
 *
 * Both edges get the same number of samples, but on a tight bend the inner edge is far
 * shorter, so its points pack together, the edge doubling back on itself where the offset
 * overshoots the arc's centre. The spline through them wobbles, and the wobble anti-aliases to
 * a faint line along the edge.
 *
 * A chain of points each within the step of the next is replaced by points evenly spaced along
 * the chain's own length (one point, its middle, if the chain is shorter than the step).
 * Chains are found the same way from either end, so a mirror-symmetric band stays symmetric;
 * an anchor-first greedy thin would not. The long edge has no such chains and comes back
 * untouched.
 */
function thinEdge(points: Point[]): Point[] {
    if (points.length < 3) {
        return points;
    }
    const chains: Point[][] = [[points[0]]];
    for (let i = 1; i < points.length; i++) {
        const chain = chains[chains.length - 1];
        if (length(sub(points[i], chain[chain.length - 1])) < EDGE_MIN_STEP) {
            chain.push(points[i]);
        } else {
            chains.push([points[i]]);
        }
    }
    const out: Point[] = [];
    chains.forEach((chain, c) => {
        if (chain.length === 1) {
            out.push(chain[0]);
            return;
        }
        const cumulative = [0];
        for (let i = 1; i < chain.length; i++) {
            cumulative.push(cumulative[i - 1] + length(sub(chain[i], chain[i - 1])));
        }
        const total = cumulative[cumulative.length - 1];
        const at = (d: number): Point => {
            let i = 1;
            while (i < chain.length - 1 && cumulative[i] < d) {
                i++;
            }
            const span = cumulative[i] - cumulative[i - 1];
            const t = span > 0 ? (d - cumulative[i - 1]) / span : 0;
            return add(chain[i - 1], scale(sub(chain[i], chain[i - 1]), t));
        };
        const first = c === 0;
        const last = c === chains.length - 1;
        const steps = Math.floor(total / EDGE_MIN_STEP);
        if (steps === 0) {
            // Shorter than a step: one point, pinned to the edge's end if this chain holds one.
            out.push(first ? chain[0] : last ? chain[chain.length - 1] : at(total / 2));
            return;
        }
        for (let k = 0; k <= steps; k++) {
            out.push(at(total * k / steps));
        }
    });
    return out;
}

/**
 * Assembles a closed band from its two smooth edge curves, with straight caps at the anchors.
 */
export function bandPathFromEdges(rawLowEdge: Point[], rawHighEdge: Point[]): string {
    const lowEdge = thinEdge(rawLowEdge);
    const highEdge = thinEdge(rawHighEdge);
    const parts: string[] = [`M ${lowEdge[0].x} ${lowEdge[0].y}`];
    parts.push(splineWithCorners(lowEdge));
    const lastHigh = highEdge[highEdge.length - 1];
    parts.push(`L ${lastHigh.x} ${lastHigh.y}`);
    parts.push(splineWithCorners([...highEdge].reverse()));
    parts.push("Z");
    return parts.join(" ");
}

/**
 * A band's two long edges, with an end cap only where no arrow continues the flow.
 *
 * Why the open form exists: a band's path is a closed polygon, and its two closing moves are
 * the end caps at the source and target faces. A band runs node to node, so those caps always
 * sit on a node face, and stroking the closed path draws a line across the flow at both ends.
 * That makes a hatched band and the arrow head continuing it look like two separate shapes
 * rather than one flow.
 *
 * Why the caps come back when the arrows are off: what an open end buys is continuity into
 * the arrow growing out of that face. With no arrow there the flow really does end at the
 * face, and an outline that simply stops leaves it hanging open. So the rule is: outline the
 * long edges of a flow, and cap an end only where nothing continues it. A source end is drawn
 * as a tail and a target end as a head, so the two toggles answer the two ends independently.
 *
 * It costs no extra geometry. Every string here is one `bandPathFromEdges` already builds: the
 * same `thinEdge` respacing, the same `splineWithCorners` for the low edge, and for the high
 * edge the same reversed spline (direction is immaterial to a stroke, so starting it at
 * `lastHigh` reuses that string exactly). With both ends capped the result is
 * `bandPathFromEdges`, character for character.
 *
 * The one-end forms are walked so that the cap mitres into both edges rather than butting
 * against them as a separate subpath; two butt caps meeting at a band's corner leave a notch
 * the width of the stroke.
 */
export function openEdgesFromEdges(
    rawLowEdge: Point[], rawHighEdge: Point[],
    closeSource = false, closeTarget = false
): string {
    const lowEdge = thinEdge(rawLowEdge);
    const highEdge = thinEdge(rawHighEdge);
    const lastHigh = highEdge[highEdge.length - 1];
    // `low` runs source -> target and `high` back target -> source, so a `L` from the end of
    // either to the start of the other is that face's cap.
    const low = splineWithCorners(lowEdge);
    const high = splineWithCorners([...highEdge].reverse());
    const atLowStart = `M ${lowEdge[0].x} ${lowEdge[0].y}`;
    const atHighEnd = `M ${lastHigh.x} ${lastHigh.y}`;
    if (closeTarget) {
        return [atLowStart, low, `L ${lastHigh.x} ${lastHigh.y}`, high,
            ...(closeSource ? ["Z"] : [])].join(" ");
    }
    if (closeSource) {
        return [atHighEnd, high, `L ${lowEdge[0].x} ${lowEdge[0].y}`, low].join(" ");
    }
    return [atLowStart, low, atHighEnd, high].join(" ");
}

/**
 * A stripe's outline with its base edge dropped, in local coordinates, as one or more open
 * point runs.
 *
 * A stripe is a closed polygon whose base sits at `-ARROW_BASE_BLEED`, a pixel behind the node
 * face and inside the band it continues. Stroking the closed polygon therefore draws a line
 * across the flow right where the arrow is supposed to grow out of it: the same defect as a
 * band's end caps, fixed by the same rule of outlining the long edges and never the ends.
 *
 * The base edge is found here, in local space, where it is simply the edge with both endpoints
 * on the base line; render could not identify it without re-deriving the face, which is
 * geometry it is not allowed to do.
 *
 * The loop is rotated so a base edge falls at the end before walking it, which keeps the
 * surviving edges as one run: splitting the loop in place would leave the piece either side of
 * the base as two runs that want joining, and mitred joins matter at an arrow's tip. A piece
 * with no base edge at all (nothing clipped it) comes back closed.
 */
export function stripeOutlineRuns(piece: Point[], baseAt: number): Point[][] {
    const onBase = (p: Point): boolean => Math.abs(p.x - baseAt) < 1e-6;
    const n = piece.length;
    let cut = -1;
    for (let i = 0; i < n; i++) {
        if (onBase(piece[i]) && onBase(piece[(i + 1) % n])) {
            cut = i;
            break;
        }
    }
    if (cut < 0) {
        return [[...piece, piece[0]]];
    }
    const rotated: Point[] = [];
    for (let k = 1; k <= n; k++) {
        rotated.push(piece[(cut + k) % n]);
    }
    const runs: Point[][] = [];
    let current: Point[] = [];
    for (let i = 0; i + 1 < rotated.length; i++) {
        const a = rotated[i];
        const b = rotated[i + 1];
        if (onBase(a) && onBase(b)) {
            if (current.length > 1) {
                runs.push(current);
            }
            current = [];
            continue;
        }
        if (current.length === 0) {
            current.push(a);
        }
        current.push(b);
    }
    if (current.length > 1) {
        runs.push(current);
    }
    return runs;
}
