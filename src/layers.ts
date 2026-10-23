/**
 * Which corridor is painted on top where two of them cross, and where they cross.
 *
 * SVG z-order is append order and nothing else, so a corridor is either wholly above another or
 * wholly below it. Row order in the data is arbitrary and Power BI promises nothing about it, so
 * using it would let a slicer change which band is on top.
 *
 * The rule: the flow travelling along the diagram wins. On a left-to-right diagram the corridor
 * running more horizontally at the crossing is on top; on a top-to-bottom one, the one running
 * more vertically. The reader is following a flow across the picture, and the band that carries
 * on through the junction is the one that must not be interrupted.
 *
 * The decision is local. Almost every route is an S (out of the port, a diagonal, into the next
 * port), so a corridor has no single direction to be judged by, and a per-corridor score gives
 * no useful ordering when a diagram's corridors all read middling. Each crossing is therefore
 * judged on the two local directions at that crossing, and the resulting preferences, which can
 * disagree, are resolved into one order.
 *
 * Where two crossings of the same pair disagree, one of them must lose: if the same corridor
 * should be on top at both, one z-order satisfies both, but where they want opposite winners no
 * single order can satisfy both and the lighter crossing is given up. Cycles (A over B over C
 * over A) are the other unsatisfiable shape and are almost absent in practice; greedy
 * feedback-arc removal gives up very little weight.
 */

import { axisOf } from "./flowAxis";
import { FlowAxis, LayoutResult, Point, PositionedNode, RoutedBand } from "./model";

/**
 * Below this difference in angle, neither band reads as the through-flow and the crossing gets
 * no vote. It is compared as an angle rather than a cosine: the cosine barely moves near
 * dead-on, so 8 degrees against 18, plainly different to the eye, differ by only 0.04 in
 * cosine, and any cosine threshold would either call that a tie or call one degree a
 * difference.
 */
export const TIE_DEGREES = 10;

/**
 * Within this of the stage axis counts as running along it, and beats the tie band outright:
 * something actually horizontal on a left-to-right diagram should win even where the
 * difference is small.
 *
 * A tenth of a degree, which is what real routes pick: runs that are genuinely axis-aligned
 * cluster at dead-on (float dust off the fit's bisection and Straighten), and there is then a
 * gap before anything slanted. So the cut sits in empty space, and the rule catches what an
 * author would call horizontal without catching anything slanted.
 */
export const AXIS_DEGREES = 0.1;

/**
 * A crossing's weight is the area the two bands hide from each other, which for two straight
 * ribbons is `w1 * w2 / sin(angle between them)` exactly. Nearly-parallel bands would send that
 * to infinity, so the sine is floored at the tie angle, since anything inside it has no
 * preference to weigh anyway.
 */
const MIN_CROSSING_SINE = Math.sin(TIE_DEGREES * Math.PI / 180);

/** One corridor's claim to be above another at one crossing. */
interface Vote {
    over: string;
    under: string;
    /** Hidden area, in square pixels. */
    weight: number;
}

/** A crossing of two spines: where, and which way each was going. */
interface Crossing {
    at: Point;
    /** The two directions, as unit vectors. */
    a: Point;
    b: Point;
}

/** The angle between a direction and the stage axis, in degrees (0..90). */
function angleToAxis(direction: Point, axis: FlowAxis): number {
    const along = Math.abs(axis === "horizontal" ? direction.x : direction.y);
    const across = Math.abs(axis === "horizontal" ? direction.y : direction.x);
    return Math.atan2(across, along) * 180 / Math.PI;
}

/** Where two segments properly cross, or undefined. Touching ends do not count. */
function intersect(p1: Point, p2: Point, p3: Point, p4: Point): Point | undefined {
    const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
    const denominator = d1x * d2y - d1y * d2x;
    if (Math.abs(denominator) < 1e-12) {
        return undefined; // parallel, or one of them has no length
    }
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denominator;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denominator;
    if (t < 0 || t > 1 || u < 0 || u > 1) {
        return undefined;
    }
    return { x: p1.x + d1x * t, y: p1.y + d1y * t };
}

/** A unit vector along a segment, or undefined where it has no length. */
function directionOf(from: Point, to: Point): Point | undefined {
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    return length < 1e-9 ? undefined : { x: dx / length, y: dy / length };
}

/**
 * Every place two spines cross.
 *
 * This is geometric rather than rasterised, which makes it exact and cheap: the crossing point,
 * both local directions and the hidden area all fall out of the two segments that meet, where
 * a raster gives each of them to within a cell and costs a flood fill per patch. It also gets
 * the right answer for free where two bands merely run close and parallel: their spines never
 * cross, and neither of them is the through-flow, so there is no preference to find. A raster
 * reports those as overlap and they have to be filtered back out as ties.
 */
function crossingsOf(first: readonly Point[], second: readonly Point[]): Crossing[] {
    const out: Crossing[] = [];
    for (let i = 0; i + 1 < first.length; i++) {
        for (let j = 0; j + 1 < second.length; j++) {
            const at = intersect(first[i], first[i + 1], second[j], second[j + 1]);
            if (!at) {
                continue;
            }
            const a = directionOf(first[i], first[i + 1]);
            const b = directionOf(second[j], second[j + 1]);
            if (a && b) {
                out.push({ at, a, b });
            }
        }
    }
    return out;
}

/**
 * Where two flows lie on each other, not just cross.
 *
 * A crossing site is the one point where two centrelines meet, and its disc covers only the
 * overlap of two bands there. A flow that runs along another (a thin one lying inside a fat one
 * for a stretch) is crossed at one point or not at all, so the channel would be painted for a
 * sliver of a long overlap.
 *
 * This walks `first` at `step` and reports every sample that is closer to `second` than their
 * half-widths sum less half a pixel: the bands genuinely overlap there. Bands that merely touch
 * (neighbours packed at one face, whose centrelines sit exactly the half-widths apart) are not
 * reported, so a face is not carved up. The result is capped, so a long shared run costs a
 * bounded number of clip discs.
 */
function overlapPoints(
    first: readonly Point[],
    second: readonly Point[],
    half: number,
    step: number
): Point[] {
    const out: Point[] = [];
    const limit = half - 0.5;
    if (limit <= 0 || step <= 0) {
        return out;
    }
    // Per-segment boxes, grown by the limit, so most samples never measure a distance at all. A
    // long shared run against 50-point centrelines would otherwise be very slow.
    const boxes: [number, number, number, number][] = [];
    for (let j = 0; j + 1 < second.length; j++) {
        const a = second[j], b = second[j + 1];
        boxes.push([Math.min(a.x, b.x) - limit, Math.min(a.y, b.y) - limit,
            Math.max(a.x, b.x) + limit, Math.max(a.y, b.y) + limit]);
    }
    const near = (p: Point): boolean => {
        for (let j = 0; j < boxes.length; j++) {
            const box = boxes[j];
            if (p.x < box[0] || p.x > box[2] || p.y < box[1] || p.y > box[3]) {
                continue;
            }
            const a = second[j], b = second[j + 1];
            const vx = b.x - a.x, vy = b.y - a.y;
            const length = vx * vx + vy * vy;
            const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / length));
            if (Math.hypot(a.x + t * vx - p.x, a.y + t * vy - p.y) < limit) {
                return true;
            }
        }
        return false;
    };
    let nextAt = 0;
    let position = 0;
    for (let i = 0; i + 1 < first.length && out.length < MAX_OVERLAP_SITES; i++) {
        const a = first[i], b = first[i + 1];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length === 0) {
            continue;
        }
        while (nextAt <= position + length && out.length < MAX_OVERLAP_SITES) {
            const f = (nextAt - position) / length;
            const p = { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
            if (near(p)) {
                out.push(p);
            }
            nextAt += step;
        }
        position += length;
    }
    return out;
}

/** The most clip discs one pair's overlapping stretch may cost. */
const MAX_OVERLAP_SITES = 120;

/** A crossing hidden behind a node is not a crossing the reader can see. */
function insideANode(point: Point, nodes: readonly PositionedNode[]): boolean {
    return nodes.some(node => point.x >= node.x && point.x <= node.x + node.width
        && point.y >= node.y && point.y <= node.y + node.height);
}

/**
 * Which corridors actually cross, whoever wins.
 *
 * The paint order only records a crossing it can decide: a tie inside `TIE_DEGREES` casts no
 * vote, and a large share of overlaps are ties. The crossing channels need every crossing,
 * decided or not, because two bands meeting at a shallow angle still hide one another, so this
 * is reported separately from the votes rather than inferred from them.
 *
 * It is keyed `"a b"` with the two ids in sorted order, so a pair appears once however many
 * times the two spines meet.
 */
export interface CrossingSite {
    /** Where the two spines meet. */
    at: Point;
    /**
     * How far from that point the two bands still overlap.
     *
     * Two ribbons of half-widths `h1` and `h2` meeting at angle `t` overlap in a parallelogram
     * whose corners sit at `+-(h2/sin t) d1 +-(h1/sin t) d2`, so every point of it is within
     * `(h1 + h2) / sin t` of the crossing. That is this radius: the smallest disc that certainly
     * covers the overlap, and it grows as the crossing shallows, which is right: two bands meeting
     * at 10 degrees genuinely hide each other over a long stretch.
     *
     * The sine is floored at `MIN_CROSSING_SINE` exactly as the weight's is, or a near-parallel
     * pair would ask for an infinite disc.
     */
    radius: number;
}

/** Keyed `"a b"` with the two ids sorted; the sites are every place they meet. */
export type CrossingPairs = ReadonlyMap<string, readonly CrossingSite[]>;

/**
 * The key `crossings` holds a pair under: the two ids sorted, joined by a NUL.
 *
 * NUL and not a space, because a corridor id is `source->target` and node names contain
 * spaces. With a space the pairs ("x", "y z") and ("x y", "z") would key identically, so one
 * crossing could silently stand in for another.
 */
export function crossingKey(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * The paint order, bottom first (the order render appends them in, so the last is on top),
 * and the pairs that cross.
 *
 * Corridors no crossing has an opinion about keep their incoming order, so a diagram with
 * nothing crossing is drawn exactly as it was.
 *
 * It is one pass, because finding the crossings is the expensive half (an O(n^2) sweep of spine
 * segment pairs) and the order is what falls out of it. The channels and the order therefore
 * always agree about what a crossing is, which is the drift `spines` is returned from routing
 * to avoid.
 */
export function paintLayering(
    layout: LayoutResult,
    bands: readonly RoutedBand[],
    spines: ReadonlyMap<string, readonly Point[]>
): { order: string[]; crossings: CrossingPairs } {
    const axis = axisOf(layout.corridors);
    const nodes = Array.from(layout.nodes.values());

    // Corridor order in, corridor order out for anything unconstrained.
    const ids: string[] = [];
    const widths = new Map<string, number>();
    bands.forEach(band => {
        if (!widths.has(band.corridorId)) {
            if (spines.has(band.corridorId)) {
                ids.push(band.corridorId);
            }
            widths.set(band.corridorId, 0);
        }
        widths.set(band.corridorId, (widths.get(band.corridorId) as number) + band.width);
    });

    const boxes = new Map<string, [number, number, number, number]>();
    const boxOf = (id: string, points: readonly Point[]): [number, number, number, number] => {
        let box = boxes.get(id);
        if (!box) {
            box = [Infinity, Infinity, -Infinity, -Infinity];
            points.forEach(p => {
                box = [Math.min((box as number[])[0], p.x), Math.min((box as number[])[1], p.y),
                    Math.max((box as number[])[2], p.x), Math.max((box as number[])[3], p.y)];
            });
            boxes.set(id, box);
        }
        return box;
    };
    const votes: Vote[] = [];
    const crossings = new Map<string, CrossingSite[]>();
    const siteAt = (first: string, second: string, site: CrossingSite): void => {
        const key = crossingKey(first, second);
        const list = crossings.get(key);
        if (list) {
            list.push(site);
        } else {
            crossings.set(key, [site]);
        }
    };
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i], b = ids[j];
            const first = spines.get(a), second = spines.get(b);
            if (!first || !second) {
                continue;
            }
            // Boxes that do not touch cannot cross: a drawn centreline has tens of points, so the
            // segment-pair test is worth skipping.
            const boxA = boxOf(a, first), boxB = boxOf(b, second);
            if (boxA[2] < boxB[0] || boxB[2] < boxA[0] || boxA[3] < boxB[1] || boxB[3] < boxA[1]) {
                continue;
            }
            // Where they lie along each other, which a crossing point misses.
            const half = ((widths.get(a) as number) + (widths.get(b) as number)) / 2;
            overlapPoints(first, second, half, Math.max(2, 0.75 * half)).forEach(at => {
                if (!insideANode(at, nodes)) {
                    siteAt(a, b, { at, radius: half });
                }
            });
            crossingsOf(first, second).forEach(crossing => {
                if (insideANode(crossing.at, nodes)) {
                    return;
                }
                // Before the tie test, deliberately: a tie is two bands that genuinely overlap and cannot be
                // told apart by angle, which is exactly a crossing the reader needs helped. Only the vote is
                // withheld there, never the crossing itself.
                const overlapSine = Math.max(MIN_CROSSING_SINE,
                    Math.abs(crossing.a.x * crossing.b.y - crossing.a.y * crossing.b.x));
                siteAt(a, b, {
                    at: crossing.at,
                    radius: ((widths.get(a) as number) + (widths.get(b) as number))
                        / (2 * overlapSine)
                });
                const angleA = angleToAxis(crossing.a, axis);
                const angleB = angleToAxis(crossing.b, axis);
                const onAxisA = angleA <= AXIS_DEGREES;
                const onAxisB = angleB <= AXIS_DEGREES;
                // Dead-on along the stage axis wins outright. Both dead-on means they are parallel, which is
                // no preference at all.
                if (onAxisA === onAxisB && Math.abs(angleA - angleB) < TIE_DEGREES) {
                    return;
                }
                const aWins = onAxisA !== onAxisB ? onAxisA : angleA < angleB;
                const sine = Math.max(MIN_CROSSING_SINE,
                    Math.abs(crossing.a.x * crossing.b.y - crossing.a.y * crossing.b.x));
                const weight = ((widths.get(a) as number) * (widths.get(b) as number)) / sine;
                votes.push(aWins ? { over: a, under: b, weight } : { over: b, under: a, weight });
            });
        }
    }

    return { order: orderFrom(ids, netPreferences(votes)), crossings };
}

/** The order alone, for callers that paint but do not erase. */
export function paintOrder(
    layout: LayoutResult,
    bands: readonly RoutedBand[],
    spines: ReadonlyMap<string, readonly Point[]>
): string[] {
    return paintLayering(layout, bands, spines).order;
}

/**
 * The votes reduced to one preference per pair.
 *
 * Two crossings of the same pair that want the same winner reinforce each other; two that
 * disagree cancel, and what survives is the heavier one's margin. That is the trade being made
 * deliberately: the crossing given up is the one with less hidden area behind it, rather than
 * whichever the sort happened to lose.
 */
function netPreferences(votes: readonly Vote[]): Vote[] {
    const net = new Map<string, number>();
    votes.forEach(vote => {
        const forward = vote.over < vote.under;
        const key = forward ? `${vote.over}\u0000${vote.under}` : `${vote.under}\u0000${vote.over}`;
        net.set(key, (net.get(key) ?? 0) + (forward ? vote.weight : -vote.weight));
    });
    const out: Vote[] = [];
    net.forEach((value, key) => {
        if (value === 0) {
            return; // two crossings that exactly cancel; neither is preferred
        }
        const [first, second] = key.split("\u0000");
        out.push(value > 0
            ? { over: first, under: second, weight: value }
            : { over: second, under: first, weight: -value });
    });
    return out;
}

/**
 * One order satisfying as much preference weight as it can.
 *
 * Heaviest preference first, keeping each one that does not contradict what is already
 * committed: greedy feedback-arc removal, the standard heuristic for a problem that is NP-hard
 * in general and gives up very little weight on real diagrams.
 *
 * Determinism, as everywhere: equal weights break by corridor id, and the topological sort
 * takes the corridor that came in earliest among those it could take next, so an unconstrained
 * diagram comes out in its original order.
 */
function orderFrom(ids: readonly string[], preferences: readonly Vote[]): string[] {
    const ranked = preferences.slice().sort((p, q) => (q.weight - p.weight)
        || (p.over < q.over ? -1 : p.over > q.over ? 1 : 0)
        || (p.under < q.under ? -1 : p.under > q.under ? 1 : 0));

    // `follows.get(x)` is everything that must be painted after x, transitively.
    const follows = new Map<string, Set<string>>(ids.map(id => [id, new Set([id])]));
    const after = new Map<string, string[]>(ids.map(id => [id, []]));
    const indegree = new Map<string, number>(ids.map(id => [id, 0]));
    ranked.forEach(preference => {
        const over = follows.get(preference.over);
        const under = follows.get(preference.under);
        if (!over || !under || over.has(preference.under)) {
            // Committing this would close a cycle, so it is the one given up.
            return;
        }
        (after.get(preference.under) as string[]).push(preference.over);
        indegree.set(preference.over, (indegree.get(preference.over) as number) + 1);
        // Everything that already had to precede `under` must now also precede everything after
        // `over`. `under` itself is covered, every node's set being seeded with itself.
        ids.forEach(id => {
            const reach = follows.get(id) as Set<string>;
            if (reach.has(preference.under)) {
                over.forEach(later => reach.add(later));
            }
        });
    });

    const position = new Map<string, number>(ids.map((id, index) => [id, index]));
    const ready = ids.filter(id => indegree.get(id) === 0);
    const order: string[] = [];
    while (ready.length > 0) {
        // The earliest corridor that is free to go next, so an unconstrained diagram keeps the order
        // it arrived in.
        let pick = 0;
        for (let i = 1; i < ready.length; i++) {
            if ((position.get(ready[i]) as number) < (position.get(ready[pick]) as number)) {
                pick = i;
            }
        }
        const id = ready.splice(pick, 1)[0];
        order.push(id);
        (after.get(id) as string[]).forEach(next => {
            const left = (indegree.get(next) as number) - 1;
            indegree.set(next, left);
            if (left === 0) {
                ready.push(next);
            }
        });
    }
    // A cycle would strand corridors here, which cannot happen, since every committed preference
    // was checked against the closure before it went in. But a stranded corridor must still be
    // drawn, so anything left is appended in its original order rather than silently dropped.
    if (order.length !== ids.length) {
        const placed = new Set(order);
        ids.forEach(id => {
            if (!placed.has(id)) {
                order.push(id);
            }
        });
    }
    return order;
}
