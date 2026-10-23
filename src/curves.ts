/**
 * Curve construction: arcs and their joins, the rounded polyline, and sampling a route
 * into a spine and fitting a smooth edge through the samples.
 */

import { Point } from "./model";
import { Arc, PathSegment, SpineSample } from "./routeTypes";
import {
    add, arcLength, cubicPoint, cubicTangent, dot, length, midpoint, reverseCubic, scale, segmentLength,
    sub, unit
} from "./routeMath";
import {
    BAND_SAMPLES, CORNER_ARC_KAPPA, DEGENERATE_LENGTH, EDGE_CORNER_DEGREES, LINE_SAMPLES, MIN_PULL,
    PROGRESS_EPSILON, SHOULDER_FRACTION, SHOULDER_LENGTH, SMOOTH_CURVATURE_FLOOR, STUB_SAMPLES
} from "./routeConstants";

/**
 * Arc, straight, arc: one arc at each end and a straight between them that is the two arcs'
 * common tangent.
 *
 * The common tangent is what makes it smooth. A straight laid along the chord is tangent to
 * nothing, so each side would need a biarc (an S) to reconcile the port's direction with the
 * chord's, and an S either side of a straight is a visible wobble. A common tangent joins all
 * three pieces tangentially by construction, so there is one arc per end and nothing to
 * reconcile.
 *
 * Everything follows from the radius: at 0 the arcs vanish and the join is the straight chord,
 * and as it grows the arcs lengthen while the straight shrinks, reaching zero at the radius
 * where the two circles touch, which is the plain biarc. So the three lengths are one family
 * with a single parameter.
 *
 * The sign conventions are enumerated rather than derived: which side each circle sits on, and
 * whether the straight is the circles' inner or outer tangent, depend on the port pairing and
 * which way the route turns, and there are only four combinations. Building all four and
 * keeping the shortest valid one is shorter to write and harder to get subtly wrong across 16
 * pairings than a table of cases would be.
 */
function tangentJoin(p0: Point, t0: Point, p1: Point, t1: Point, radius: number):
    { segments: PathSegment[]; radius: number } | undefined {
    if (!(radius > 0)) {
        return undefined;
    }
    const perpOf = (v: Point): Point => ({ x: -v.y, y: v.x });
    const best: { segments: PathSegment[]; length: number }[] = [];

    /**
     * Four side combinations, and for each of them both of the two common tangents. A pair of
     * circles has two inner tangents and two outer, and picking one by a sign rule chooses the
     * wrong one: each candidate's second arc comes out as the complement of the first, so every
     * one is rejected as going the long way and the join silently stays straight.
     */
    for (const s0 of [1, -1]) {
        for (const s1 of [1, -1]) {
            for (const flip of [1, -1]) {
            const c1 = add(p0, scale(perpOf(t0), s0 * radius));
            const c2 = add(p1, scale(perpOf(t1), s1 * radius));
            const between = sub(c2, c1);
            const centreGap = length(between);
            if (centreGap < 1e-6) {
                continue;
            }
            const u = unit(between);

            // Same turn at both ends -> the straight is the circles' outer tangent, parallel to the line
            // of centres. Opposite turns -> the inner one, which crosses between them and needs room to
            // do it.
            let direction: Point;
            let through: Point;
            if (s0 === s1) {
                direction = u;
                through = add(c1, scale(perpOf(u), flip * radius));
            } else {
                if (centreGap < 2 * radius) {
                    continue; // circles too close for a crossing tangent
                }
                const turn = Math.asin((2 * radius) / centreGap) * flip;
                direction = {
                    x: u.x * Math.cos(turn) - u.y * Math.sin(turn),
                    y: u.x * Math.sin(turn) + u.y * Math.cos(turn)
                };
                through = midpoint(c1, c2);
            }

            // Where each circle touches that line.
            const footOf = (centre: Point): Point => {
                const offset = sub(centre, through);
                return add(through, scale(direction, dot(offset, direction)));
            };
            const a = footOf(c1);
            const b = footOf(c2);
            // The straight has to run forwards, and each arc has to be the one that leaves its port
            // rather than the long way round.
            if (dot(sub(b, a), direction) < 0) {
                continue;
            }
            const first = arcCubics(p0, t0, a);
            const second = arcCubics(b, direction, p1);
            if (!first || !second) {
                continue;
            }
            /**
             * Reject anything degenerate before reading into it. An arc built from a non-finite radius
             * comes back with an empty segment list, and `Math.abs(NaN - radius) > 1` is false, so a NaN
             * would pass the radius test below and the arrival check would then read `segments[-1].kind`
             * off nothing. This is the only way this construction can throw.
             */
            if (first.segments.length === 0 || second.segments.length === 0
                || !Number.isFinite(first.radius) || !Number.isFinite(second.radius)) {
                continue;
            }
            if (Math.abs(first.radius - radius) > 1 || Math.abs(second.radius - radius) > 1) {
                continue;
            }
            /**
             * An arc may sweep most of the way round. Where the far stub sits behind both tangents there
             * is no short-way join at all, but a pair of three-quarter arcs meets perfectly well, looping
             * out and back. `arcCubics` splits at 90 degrees, so the piece count is the sweep; four pieces
             * is a full circle, which is where a route stops being a route.
             *
             * The shortest candidate still wins, so where a short-way join exists this changes nothing; it
             * only fills in the cases that would otherwise come back empty.
             */
            if (first.segments.length > 4 || second.segments.length > 4) {
                continue;
            }
            // The route must leave forwards and arrive forwards, not double back on itself at either
            // port.
            if (dot(sub(a, p0), t0) < -1e-6 || dot(sub(p1, b), t1) < -1e-6) {
                continue;
            }
            // ...and the route must actually arrive along t1, not against it.
            const tail = second.segments[second.segments.length - 1];
            const arrival = tail.kind === "cubic"
                ? unit(sub(tail.arc.p3, tail.arc.p2))
                : unit(sub(tail.b, tail.a));
            if (dot(arrival, t1) < 0.99) {
                continue;
            }

            const straight = length(sub(b, a));
            const segments: PathSegment[] = [...first.segments];
            if (straight > DEGENERATE_LENGTH) {
                segments.push({ kind: "line", a, b });
            }
            segments.push(...second.segments);
            best.push({ segments, length: straight + arcLength(first) + arcLength(second) });
            }
        }
    }
    if (best.length === 0) {
        return undefined;
    }
    best.sort((x, y) => x.length - y.length);
    return { segments: best[0].segments, radius };
}

/**
 * Smooth's join with a straight down the middle, which is what Curvature means in this style.
 *
 * At Curvature 0 the straight is the whole distance between the two handles, so the join is
 * Polyline's diagonal and the arcs vanish. At 100 it is zero and the join is all arc. In
 * between it is proportional, so the slider trades a straight run against the size of the
 * bends either side of it.
 *
 * It is built by putting the straight down first, centred on the chord and along it, and then
 * solving a biarc into its near end and another out of its far end. Each side is a biarc
 * rather than a single arc because a lone circular arc cannot be given both its end point and
 * its end tangent, and the straight needs the curve to arrive along it.
 */
export function biarcJoinWithStraight(p0: Point, t0: Point, p1: Point, t1: Point,
    /**
     * Curvature as a fraction. 0 keeps the whole join straight; 1 takes the arcs as far as they go,
     * which is the plain biarc with no straight left.
     */
    curvature: number,
    /**
     * The band's half-width: no arc may be tighter than this. The radius is a number that can be
     * read before anything is drawn, which is the whole advantage of arcs over a cubic: an arc
     * tighter than the ribbon is thick would turn its inner edge inside out, so the join stays
     * straight instead.
     */
    minRadius: number): PathSegment[] | undefined {
    const span = length(sub(p1, p0));
    if (span < Math.max(DEGENERATE_LENGTH, 2 * minRadius)) {
        return undefined; // no room to bend at all: Polyline's straight build
    }

    /**
     * The plain biarc is the far end of the family: its radius is the one at which the straight
     * between the two arcs has shrunk to nothing. Curvature interpolates the radius between 0 and
     * that, and the arc and straight lengths follow from it rather than being set separately.
     * Where the biarc has no solution (the far stub behind both tangents) the family still
     * exists, so the search below just needs another ceiling to start from.
     */
    const full = biarcSegments(p0, t0, p1, t1);
    const ceiling = full ? full.radius : span;
    /**
     * The slider is remapped onto the useful part of the range. Below about two thirds the arcs
     * are tight enough that a join either pinches the ribbon or is refused outright, so the whole
     * bottom of the slider would do much the same thing. Spreading 0-100 across the top third
     * gives every position a distinct shape.
     *
     * The consequence is that Curvature 0 does not mean "straight": it means the roundest-but-one,
     * and Polyline is where to go for a straight diagonal.
     */
    const fraction = SMOOTH_CURVATURE_FLOOR
        + (1 - SMOOTH_CURVATURE_FLOOR) * Math.max(0, Math.min(1, curvature));

    /**
     * The biggest radius an arc-straight-arc join can take, found by bisection, because it is not
     * the biarc's own.
     *
     * The two circles' inner tangent needs their centres further apart than twice the radius, and
     * growing the radius moves the centres as well, so past some radius there is no such tangent
     * and the construction has no answer at all. Without this, the upper half of the slider would
     * produce nothing and silently leave the join straight.
     *
     * Bisection rather than algebra: the feasible set is an interval in the radius (a bigger
     * radius is only ever harder to fit), and twelve halvings land within a pixel of its edge on
     * any diagram this will draw.
     */
    let feasible = 0;
    let beyond = ceiling;
    for (let i = 0; i < 12; i++) {
        const middle = (feasible + beyond) / 2;
        if (tangentJoin(p0, t0, p1, t1, middle)) {
            feasible = middle;
        } else {
            beyond = middle;
        }
    }
    // At the top of the slider: the plain biarc where there is one, and otherwise the roundest
    // arc-straight-arc the geometry allows, which stops a corridor dropping to Polyline just
    // because the biarc's own equation had no positive root.
    if (fraction >= 1) {
        if (full) {
            return full.segments;
        }
        if (feasible < minRadius) {
            return undefined;
        }
        const widest = tangentJoin(p0, t0, p1, t1, feasible);
        return widest ? widest.segments : undefined;
    }

    /**
     * The radius the setting asks for. The half-width is a refusal, not a floor to raise it to:
     * asked for less, the join stays straight rather than bending tighter than the ribbon is
     * thick. Raising it instead would make Curvature 0 draw the tightest arcs it was allowed,
     * which is the opposite of what 0 means here.
     */
    const wanted = fraction * feasible;
    if (wanted < minRadius) {
        return undefined;
    }
    const join = tangentJoin(p0, t0, p1, t1, wanted);
    return join ? join.segments : undefined;
}

/**
 * Two circular arcs, tangent to each port and to each other where they meet.
 *
 * The point of a biarc is that the radius is a property you can read, not something that
 * falls out of where the endpoints happen to sit. A cubic-based route has the opposite flaw:
 * squeeze the endpoints together and the curve's radius collapses with them, and once it
 * drops below the band's half-width the inner edge turns inside out. A biarc's arcs swing
 * wide instead.
 *
 * The construction is the standard equal-tangent one: pick the tangent length `d` that makes
 * the two arcs meet tangentially, put the joint midway between the two tangent points, and
 * each arc is then fully determined. It returns undefined where the geometry is degenerate
 * (the two stubs collinear, or no positive `d`), leaving the caller to fall back to its plain
 * curve.
 */
function biarcSegments(p0: Point, t0: Point, p1: Point, t1: Point):
    { segments: PathSegment[]; radius: number } | undefined {
    const v = sub(p1, p0);
    const t = add(t0, t1);
    // 2(1 - T0.T1). The sign matters only where the tangents are not parallel: with it the wrong
    // way round the discriminant comes out negative for every perpendicular pairing, so there is
    // no solution and a 90-degree route stays an L. Parallel tangents make this term zero either
    // way, which is why same-axis routes work regardless.
    const a = 2 * (1 - dot(t0, t1));
    const b = 2 * dot(v, t);
    const c = -dot(v, v);

    let d: number;
    if (Math.abs(a) < 1e-9) {
        // Parallel tangents (the common East->West case): the quadratic degenerates to a linear one.
        if (Math.abs(b) < 1e-9) {
            return undefined;
        }
        d = -c / b;
    } else {
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) {
            return undefined;
        }
        const root = Math.sqrt(discriminant);
        d = (-b + root) / (2 * a);
        if (d <= 0) {
            d = (-b - root) / (2 * a);
        }
    }
    if (!(d > 0) || !Number.isFinite(d)) {
        return undefined;
    }

    const joint = midpoint(add(p0, scale(t0, d)), sub(p1, scale(t1, d)));
    const first = arcCubics(p0, t0, joint);
    const second = arcCubics(p1, scale(t1, -1), joint);
    if (!first || !second) {
        return undefined;
    }
    // The second arc was built backwards from the far port so its tangent is the one that is
    // known there; flip it to run with the route.
    return {
        segments: [...first.segments, ...second.segments.reverse().map(reverseCubic)],
        radius: Math.min(first.radius, second.radius)
    };
}

/**
 * A circular arc from `from` to `to`, leaving `from` along `tangent`, as cubic Beziers. Split
 * at 90 degrees: one cubic approximates a quarter circle well and a half circle badly.
 */
export function arcCubics(from: Point, tangent: Point, to: Point): { segments: PathSegment[]; radius: number } | undefined {
    const chord = sub(to, from);
    if (length(chord) < DEGENERATE_LENGTH) {
        return undefined;
    }
    const heading = unit(tangent);
    const cross = heading.x * chord.y - heading.y * chord.x;
    if (Math.abs(cross) < 1e-9) {
        // Straight on: no arc at all, and nothing that can bend too tightly.
        return { segments: [{ kind: "line", a: from, b: to }], radius: Infinity };
    }
    const radius = dot(chord, chord) / (2 * Math.abs(cross));
    const side = Math.sign(cross);
    const normal = { x: -heading.y * side, y: heading.x * side };
    const centre = add(from, scale(normal, radius));

    const angleOf = (point: Point): number => Math.atan2(point.y - centre.y, point.x - centre.x);
    const startAngle = angleOf(from);
    let sweep = angleOf(to) - startAngle;
    // Take the turn that leaves `from` in the tangent's own direction.
    while (sweep * side < 0) {
        sweep += side * 2 * Math.PI;
    }
    while (Math.abs(sweep) > 2 * Math.PI) {
        sweep -= side * 2 * Math.PI;
    }

    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = sweep / pieces;
    const kappa = (4 / 3) * Math.tan(step / 4);
    const segments: PathSegment[] = [];
    for (let i = 0; i < pieces; i++) {
        const a0 = startAngle + step * i;
        const a1 = a0 + step;
        const start = { x: centre.x + radius * Math.cos(a0), y: centre.y + radius * Math.sin(a0) };
        const end = { x: centre.x + radius * Math.cos(a1), y: centre.y + radius * Math.sin(a1) };
        segments.push({
            kind: "cubic",
            arc: {
                p0: start,
                p1: { x: start.x - kappa * radius * Math.sin(a0), y: start.y + kappa * radius * Math.cos(a0) },
                p2: { x: end.x + kappa * radius * Math.sin(a1), y: end.y - kappa * radius * Math.cos(a1) },
                p3: end
            }
        });
    }
    return { segments, radius };
}

export function tangentMatchedArc(p0: Point, t0: Point, p3: Point, t1: Point): Arc {
    const span = sub(p3, p0);
    const distance = length(span);
    const pullFor = (tangent: Point): number => {
        const progress = dot(span, tangent);
        // When a tangent points across or away from the destination there is no meaningful "half the
        // run" to use, so fall back to a fraction of the straight-line distance, enough to let the
        // curve sweep round.
        const base = progress > PROGRESS_EPSILON ? progress * 0.5 : distance * 0.4;
        return Math.max(MIN_PULL, base);
    };
    return {
        p0,
        p1: add(p0, scale(t0, pullFor(t0))),
        p2: sub(p3, scale(t1, pullFor(t1))),
        p3
    };
}

function sampleWith(point: Point, tangent: Point, weight: number): SpineSample {
    const len = length(tangent) || 1;
    return { x: point.x, y: point.y, nx: -tangent.y / len, ny: tangent.x / len, weight };
}

/**
 * The one statement of how much room a corner has, shared by everything that needs it:
 * `roundedPolyline` (which draws the arcs), `uniformCornerCap` and `cornerCapAt` (which bound
 * the handles that set them). With three copies of this rule a handle would come to sit off
 * the arc it is meant to be on, so it lives here once.
 *
 * - A vertex `turns` only if the two runs either side of it are not collinear. Counting every
 *   interior vertex as a turn would be the conservative reading, but a Z's lead and the run
 *   that follows it are collinear, so the stub is not a corner at all, and charging the run two
 *   arcs would halve its radius.
 * - An edge's `share` is what it can spare for a corner at one of its ends: all of it if the
 *   other end goes straight through, half if that end turns too. The ends of the path are
 *   anchors, not corners.
 */
function cornerShares(points: Point[]): {
    path: Point[];
    turns: (i: number) => boolean;
    share: (i: number) => number;
} {
    const path = points.filter((p, i) => i === 0 || length(sub(p, points[i - 1])) > 1e-6);
    const turns = (i: number): boolean => {
        if (i <= 0 || i >= path.length - 1) {
            return false;
        }
        return dot(unit(sub(path[i], path[i - 1])), unit(sub(path[i + 1], path[i]))) < 1 - 1e-9;
    };
    const share = (i: number): number => {
        const edge = length(sub(path[i + 1], path[i]));
        const corners = (turns(i) ? 1 : 0) + (turns(i + 1) ? 1 : 0);
        return corners > 0 ? edge / corners : Infinity;
    };
    return { path, turns, share };
}

/** What one corner's own two edges can hold: the per-corner cap `roundedPolyline` applies. */
export function cornerCapAt(points: Point[], at: number): number {
    const { turns, share } = cornerShares(points);
    return turns(at) ? Math.min(share(at - 1), share(at)) : Infinity;
}

/**
 * The largest radius every corner of `points` can take at once: exactly the cap
 * `roundedPolyline` applies with `uniform` set, so the corner handle can sit on the arc
 * actually drawn and stop where the drawing stops.
 */
export function uniformCornerCap(points: Point[]): number {
    const { path, turns, share } = cornerShares(points);
    let cap = Infinity;
    for (let i = 1; i < path.length - 1; i++) {
        if (turns(i)) {
            cap = Math.min(cap, share(i - 1), share(i));
        }
    }
    return cap;
}

/**
 * Turns a centreline polyline into straight runs joined by quarter turns. With `uniform`
 * set every corner takes one radius, capped by the shortest edge in the whole path;
 * otherwise each corner takes the most its own two edges allow.
 */
export function roundedPolyline(points: Point[], radius: number, uniform = false): PathSegment[] {
    const path = points.filter((p, i) => i === 0 || length(sub(p, points[i - 1])) > 1e-6);
    if (path.length < 2) {
        return [];
    }
    if (path.length === 2) {
        return [{ kind: "line", a: path[0], b: path[1] }];
    }

    // An interior edge has a corner at both ends and must fit two arcs; the first and last edges
    // have one each, so capping them at half their length would throttle the radius for no reason
    // (the port lead-ins are usually the shortest edges in the path). The rule itself is stated
    // once, in `cornerShares`: the handles that set a radius bound themselves by the same thing,
    // and a second copy is how they drift off the drawn arc.
    const { turns, share } = cornerShares(path);

    /**
     * Each corner takes the largest radius its own two edges can hold. A single uniform radius,
     * capped by the shortest edge anywhere on the route, would let one short run crimp every
     * corner on a corridor spanning the whole diagram.
     *
     * Self-loops keep the uniform radius (`uniform` set): a loop is a small shape whose four
     * corners are seen together, and unequal radii read as a stadium rather than a rounded
     * rectangle. The two cases want different answers: a long route is read corner by corner, a
     * loop all at once.
     */
    const requested = Math.max(0, radius);
    const radiusAt = (i: number): number => Math.min(requested, share(i - 1), share(i));
    let uniformRadius = requested;
    if (uniform) {
        for (let i = 1; i < path.length - 1; i++) {
            if (turns(i)) {
                uniformRadius = Math.min(uniformRadius, radiusAt(i));
            }
        }
    }

    const segments: PathSegment[] = [];
    let cursor = path[0];
    for (let i = 1; i < path.length - 1; i++) {
        // A vertex the route does not actually turn at needs no arc, and must not consume the radius
        // either: an arc there eats r off both of its edges, so a vertex that no longer constrains r
        // could have one longer than the edge it sits on and the path would double back on itself.
        // Straight stays straight by passing it through.
        if (!turns(i)) {
            continue;
        }
        const corner = path[i];
        const incoming = unit(sub(corner, path[i - 1]));
        const outgoing = unit(sub(path[i + 1], corner));
        const r = uniform ? uniformRadius : radiusAt(i);
        const arcStart = add(corner, scale(incoming, -r));
        const arcEnd = add(corner, scale(outgoing, r));
        segments.push({ kind: "line", a: cursor, b: arcStart });
        segments.push({
            kind: "cubic",
            arc: {
                p0: arcStart,
                p1: add(arcStart, scale(incoming, r * CORNER_ARC_KAPPA)),
                p2: sub(arcEnd, scale(outgoing, r * CORNER_ARC_KAPPA)),
                p3: arcEnd
            }
        });
        cursor = arcEnd;
    }
    segments.push({ kind: "line", a: cursor, b: path[path.length - 1] });
    return segments;
}

/**
 * Samples a route's segments into the spine.
 *
 * The first and last segments are the port lead-ins, pinned to weight 0 and 1 so a
 * multi-segment corridor keeps its exact packed port spacing as a flat parallel run right at
 * the node, only redistributing across the middle. Everything between advances by cumulative
 * chord length, so the taper stays even however the segments differ in length.
 */
export function sampleSegments(segments: PathSegment[], exitTangent: Point, arrivalTangent: Point,
    /** Smooth only: extra samples pinning a straight run's direction at its ends. */
    shoulders = false): SpineSample[] {
    if (segments.length === 0) {
        return [];
    }

    const middle: { point: Point; tangent: Point }[] = [];
    let started = false;
    for (let s = 1; s < segments.length - 1; s++) {
        const segment = segments[s];
        // Skip degenerate segments. At high curvature the corner radii grow until the straight run
        // between two corners vanishes, and a zero-length segment has no direction: its normal comes
        // out as (0,0), so the band pinches to nothing and shows as a gap.
        if (segmentLength(segment) < DEGENERATE_LENGTH) {
            continue;
        }
        /**
         * Where along this segment to sample.
         *
         * A cubic is sampled evenly. A straight run also gets a shoulder sample a few pixels in from
         * each end, and that is not decoration: the band's edges are fitted with a Catmull-Rom spline
         * through these points, and such a spline takes its tangent at a point from the points either
         * side. Where a long straight run meets an arc, the neighbour on the straight side would be
         * half a run away while the one on the curve side is a few pixels ahead, so the fitted tangent
         * would lean into the curve and the join would bulge away from the straight it is supposed to
         * continue. The curve needs a little straight run of its own to start from.
         */
        const stops = (): number[] => {
            if (segment.kind === "cubic") {
                return Array.from({ length: BAND_SAMPLES + 1 }, (_, i) => i / BAND_SAMPLES);
            }
            const run = segmentLength(segment);
            const shoulder = shoulders && run > 0 ? Math.min(SHOULDER_FRACTION, SHOULDER_LENGTH / run) : 0;
            const inner = Array.from({ length: LINE_SAMPLES - 1 }, (_, i) => (i + 1) / LINE_SAMPLES);
            return [0, shoulder, ...inner, 1 - shoulder, 1]
                .filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-9);
        };
        // Skip t=0 once something has been emitted; it repeats the previous end.
        stops().forEach((t, i) => {
            if (started && i === 0) {
                return;
            }
            middle.push(segment.kind === "cubic"
                ? { point: cubicPoint(segment.arc, t), tangent: cubicTangent(segment.arc, t) }
                : { point: add(segment.a, scale(sub(segment.b, segment.a), t)), tangent: sub(segment.b, segment.a) });
        });
        started = true;
    }

    let travelled = 0;
    const cumulative = middle.map((sample, i) => {
        if (i > 0) {
            travelled += length(sub(sample.point, middle[i - 1].point));
        }
        return travelled;
    });
    const totalLength = travelled || 1;

    const first = segments[0];
    const last = segments[segments.length - 1];
    const samples: SpineSample[] = [];
    sampleLead(first, STUB_SAMPLES, false, exitTangent).forEach(s => samples.push(sampleWith(s.point, s.tangent, 0)));
    middle.forEach((sample, i) => samples.push(sampleWith(sample.point, sample.tangent, cumulative[i] / totalLength)));
    sampleLead(last, STUB_SAMPLES, true, arrivalTangent).forEach(s => samples.push(sampleWith(s.point, s.tangent, 1)));
    return samples;
}

/**
 * Samples a lead-in/lead-out segment; the outgoing one omits its end point, the incoming one
 * omits its start. `fallbackTangent` covers a zero-length lead, where the segment has no
 * direction of its own: without it the normal comes out as (0,0) and the band collapses to a
 * line.
 */
function sampleLead(segment: PathSegment, steps: number, incoming: boolean, fallbackTangent: Point): { point: Point; tangent: Point }[] {
    const a = segment.kind === "line" ? segment.a : segment.arc.p0;
    const b = segment.kind === "line" ? segment.b : segment.arc.p3;
    const span = sub(b, a);
    const tangent = length(span) > 1e-6 ? span : fallbackTangent;
    const out: { point: Point; tangent: Point }[] = [];
    for (let i = incoming ? 1 : 0; incoming ? i <= steps : i < steps; i++) {
        out.push({ point: add(a, scale(span, i / steps)), tangent });
    }
    return out;
}

/**
 * Fits a real smooth curve (Catmull-Rom converted to cubic Bezier `C` commands) through
 * sampled points, rather than joining them with straight `L` segments: raising the sample
 * count would shrink a polyline's facets but never eliminate them, whereas a piecewise-Bezier
 * curve stays smooth at any zoom. Collinear runs stay straight, so the flat stubs and
 * genuinely straight corridors are not bowed by the fit.
 *
 * Each control arm is capped at a third of its own segment. Plain Catmull-Rom takes an arm's
 * length from the neighbours, so where a long straight meets short arc steps the arm dwarfs
 * its segment and the drawn edge shoots out along the straight and doubles back: a zero-width
 * spike that anti-aliases to a hairline. With even spacing the arm is already under the cap,
 * so an evenly sampled run is drawn as plain Catmull-Rom would draw it; only the direction
 * comes from the neighbours, never an outsized length.
 */
function catmullRomToBezier(points: Point[]): string {
    const parts: string[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        const cap = length(sub(p2, p1)) / 3;
        const arm = (span: Point): Point => {
            const reach = length(span) / 6;
            return scale(span, reach > cap && reach > 0 ? cap / reach / 6 : 1 / 6);
        };
        const c1 = add(p1, arm(sub(p2, p0)));
        const c2 = sub(p2, arm(sub(p3, p1)));
        parts.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`);
    }
    return parts.join(" ");
}

/**
 * Fits the spline in runs, broken wherever the edge turns sharper than EDGE_CORNER_DEGREES.
 * Once `thinEdge` has collapsed a tight inner arc it is a real corner, and a single
 * Catmull-Rom through it takes its tangents from points on two different sides, bowing the
 * straights either side inward. Ending one run and starting the next there keeps each
 * straight straight.
 */
export function splineWithCorners(points: Point[]): string {
    const limit = Math.cos(EDGE_CORNER_DEGREES * Math.PI / 180);
    const runs: string[] = [];
    let start = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const a = sub(points[i], points[i - 1]);
        const b = sub(points[i + 1], points[i]);
        const cos = (a.x * b.x + a.y * b.y) / (length(a) * length(b));
        if (cos < limit) {
            runs.push(catmullRomToBezier(points.slice(start, i + 1)));
            start = i;
        }
    }
    runs.push(catmullRomToBezier(points.slice(start)));
    return runs.filter(run => run.length > 0).join(" ");
}
