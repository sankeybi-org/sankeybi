/**
 * Collision avoidance: route around any node the corridor would otherwise pass straight
 * through.
 *
 * This is deliberately not pathfinding. A route is already an explicit polyline of waypoints,
 * so avoidance is just "insert waypoints that steer clear", which composes with the rest at no
 * cost: every style consumes a polyline, and curvature and mitred corners still apply on top.
 *
 * It is a heuristic. Each pass pushes the detour lane further out and the result is kept only
 * if it clips fewer nodes than before, so the worst case is the route that would have been
 * drawn anyway. A node boxed in by its neighbours, or a layout where every detour lands on
 * something else, simply does not resolve: it is better to leave the straight line than to
 * thread a contorted path through a dense diagram.
 */

import { Point, PORT_NORMALS, PositionedNode } from "./model";
import { portAxis } from "./flowAxis";
import { Anchor, Built, Route, RouteGeometry, RouteOverridePoints } from "./routeTypes";
import {
    AVOID_ESCALATION, AVOID_MARGIN_FRACTION, AVOID_PASSES, DEGENERATE_LENGTH, LEAD_FRACTIONS, MAX_OBSTACLES,
    MIN_PERPENDICULAR_RUN
} from "./routeConstants";
import { add, dot, midpoint, scale, sub } from "./routeMath";

/**
 * Hands a detoured route the handles of the line it would have been.
 *
 * A detour replaces a direct route's middle outright (`centrelineWith`), so `handlesFor` comes
 * back with a lane and nothing that places the line, and the lane cannot get rid of a detour,
 * only shape it. The author would then be stuck with a route they may themselves have put
 * through a node.
 *
 * This is the one place that holds both routes, so the carry-over belongs here rather than in
 * `handlesFor`, which is handed the detoured centreline and no memory of the other one.
 *
 * A wrap is left alone: its middle is its own construction's lane, on the drawn route, with
 * the detours spliced in beyond it. Nothing was taken away, so there is nothing to give back
 * and no ghost to draw. Only a direct route loses its middle to a detour.
 *
 * The leads come over with it. On a squared detour they cannot change the drawn band at all
 * (the first waypoint takes the stub's own cross coordinate, so the run through the stub is
 * straight), but they do shape the line, which is something the author can see. Marking the
 * whole route `asPlaced` is what says so.
 */
function asPlacedOver(built: Built, base: Built): Built {
    if (!built.handles.detour || built.handles.middle || !base.handles.middle) {
        return built;
    }
    return {
        ...built,
        handles: { ...built.handles, middle: base.handles.middle, asPlaced: true },
        ghost: base.spine
    };
}

export function avoidObstacles(
    build: (detours: Point[], vary?: RouteOverridePoints) => Built,
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    overrides: RouteOverridePoints,
    obstacles: PositionedNode[],
    geometry: RouteGeometry,
    pitch: number,
    enabled: boolean
): Built {
    const base = build([]);
    if (!enabled || obstacles.length === 0) {
        return base;
    }
    const blocking = blockedBy(base.route, obstacles, geometry.bandReach);
    if (blocking.length === 0 || blocking.length > MAX_OBSTACLES) {
        return base;
    }

    const baseMargin = geometry.bandReach + AVOID_MARGIN_FRACTION * pitch;

    /**
     * A hand-placed lane settles it, and the search stands down.
     *
     * The author has said this route goes round, and on which side. The two cheaper repairs below
     * exist to avoid a detour, and running them here could clear the blockage and throw the lane
     * away with it, a drag that silently does nothing. The margin escalation goes too: pushing the
     * lane further out is exactly what the handle has taken over. This is the same bargain as a
     * hand-moved crossover, which stands avoidance down and is merely slid clear
     * (`clearCrossover`).
     *
     * One lane serves every obstacle in the chain, like a wrap's: it is one handle saying one
     * thing, and `detourWaypoints` holds it clear of each obstacle in turn.
     */
    if (overrides.detour) {
        const from = base.handles.source.point;
        const to = base.handles.target.point;
        const lane = overrides.detour[detourLaneAxis(from, to)];
        return asPlacedOver(build(detourWaypoints(from, to, blocking, baseMargin, base.squared,
            lane, geometry.bandReach)), base);
    }

    // The repairs, cheapest-looking first. Both of the first two use a parameter the route
    // already has, so they add no geometry and the corridor comes out as clean as an unobstructed
    // one. Only when neither can reach does it fall back to adding a detour, which an author is
    // likely to tidy by hand, so it is the backstop rather than the answer.
    //
    //   1. Step across somewhere else: a squared route's crossover.
    //   2. Run further out of, or closer to, the ports: a curve's leads, which is what moves its
    //      bow off the obstacle. A squared route has leads too, so this is tried for everything.
    let best = base;
    let fewest = blocking.length;

    if (base.handles.middle) {
        const slid = slideCrossover(build, base.handles.middle.point, base.handles.middle.axis,
            best, fewest, obstacles, geometry, pitch);
        best = slid.best;
        fewest = slid.hits;
    }
    if (fewest > 0) {
        const reshaped = reshapeLeads(build, sourceAnchor, targetAnchor, overrides,
            best, fewest, obstacles, geometry);
        best = reshaped.best;
        fewest = reshaped.hits;
    }
    if (fewest === 0) {
        return best;
    }

    // The detour spans the two port stubs, and the base route has just computed exactly where
    // those are: its own lead handles. Taking them from here rather than from the anchors lets
    // the turns line up with the runs they join, whatever the ports and however long the leads.
    const from = base.handles.source.point;
    const to = base.handles.target.point;
    for (let pass = 0; pass < AVOID_PASSES; pass++) {
        const margin = baseMargin * Math.pow(AVOID_ESCALATION, pass);
        const candidate = build(detourWaypoints(from, to, blocking, margin, base.squared));
        const hits = blockedBy(candidate.route, obstacles, geometry.bandReach).length;
        if (hits < fewest) {
            best = candidate;
            fewest = hits;
        }
        if (fewest === 0) {
            break;
        }
    }
    return asPlacedOver(best, base);
}

/**
 * Tries running further out of, or closer to, each port.
 *
 * This is the curve's equivalent of moving a crossover. A smooth direct route has no crossover
 * (it is one arc between the two stubs), so the only shape it owns is where those stubs sit,
 * and moving them along their normals is what pulls the bow off an obstacle. Correcting such
 * a route by hand means dragging the lead handles, so the router tries that before adding
 * anything.
 *
 * Both leads are swept together first (the symmetric shapes look best), then the asymmetric
 * extremes. An end the author has placed by hand is left exactly where they put it.
 */
function reshapeLeads(
    build: (detours: Point[], vary?: RouteOverridePoints) => Built,
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    overrides: RouteOverridePoints,
    startingBest: Built,
    startingHits: number,
    obstacles: PositionedNode[],
    geometry: RouteGeometry
): { best: Built; hits: number } {
    const capFor = (anchor: Anchor) =>
        portAxis(anchor.port) === "vertical" ? geometry.maxLeadX : geometry.maxLeadY;
    const sourceCap = capFor(sourceAnchor);
    const targetCap = capFor(targetAnchor);
    if (sourceCap <= 0 && targetCap <= 0) {
        return { best: startingBest, hits: startingHits };
    }

    const leadAt = (anchor: Anchor, cap: number, fraction: number): Point =>
        add(anchor.point, scale(PORT_NORMALS[anchor.port], fraction * cap));

    // Where the leads are now, so the sweep can prefer the smallest change that clears: the least
    // reshaping looks the most natural, and leaving a route alone is always better than moving it
    // for no gain.
    const fractionNow = (anchor: Anchor, handle: Point, cap: number) =>
        cap > 0 ? dot(sub(handle, anchor.point), PORT_NORMALS[anchor.port]) / cap : 0;
    const sourceNow = fractionNow(sourceAnchor, startingBest.handles.source.point, sourceCap);
    const targetNow = fractionNow(targetAnchor, startingBest.handles.target.point, targetCap);

    const combinations: [number, number][] = [];
    LEAD_FRACTIONS.forEach(fromFraction => LEAD_FRACTIONS.forEach(toFraction => {
        combinations.push([fromFraction, toFraction]);
    }));
    combinations.sort((a, b) =>
        (Math.abs(a[0] - sourceNow) + Math.abs(a[1] - targetNow))
        - (Math.abs(b[0] - sourceNow) + Math.abs(b[1] - targetNow)));

    let best = startingBest;
    let hits = startingHits;
    for (const [fromFraction, toFraction] of combinations) {
        const vary: RouteOverridePoints = {};
        // Never move an end the author placed themselves.
        if (!overrides.source) {
            vary.source = leadAt(sourceAnchor, sourceCap, fromFraction);
        }
        if (!overrides.target) {
            vary.target = leadAt(targetAnchor, targetCap, toFraction);
        }
        if (!vary.source && !vary.target) {
            break;
        }
        const candidate = build([], vary);
        const candidateHits = blockedBy(candidate.route, obstacles, geometry.bandReach).length;
        if (candidateHits < hits) {
            best = candidate;
            hits = candidateHits;
        }
        if (hits === 0) {
            break;
        }
    }
    return { best, hits };
}

/**
 * Tries stepping across at each blocking node's two sides, nearest to where the crossover
 * already is first, and returns whichever clips least.
 *
 * Deliberately not a search over positions: a crossover only collides because it sits within
 * some node's span along its own axis, so the handful of positions that can fix it are those
 * nodes' edges. It is shared by the automatic avoidance and by the repair applied to a
 * hand-placed crossover, so the two cannot disagree about where "just clear" is.
 */
function slideCrossover(
    build: (detours: Point[], vary?: RouteOverridePoints) => Built,
    current: Point,
    axis: "x" | "y",
    startingBest: Built,
    startingHits: number,
    obstacles: PositionedNode[],
    geometry: RouteGeometry,
    pitch: number
): { best: Built; hits: number } {
    const margin = geometry.bandReach + AVOID_MARGIN_FRACTION * pitch;
    const sides: number[] = [];
    blockedBy(startingBest.route, obstacles, geometry.bandReach).forEach(node => {
        sides.push((axis === "x" ? node.x : node.y) - margin);
        sides.push((axis === "x" ? node.x + node.width : node.y + node.height) + margin);
    });
    sides.sort((a, b) => Math.abs(a - current[axis]) - Math.abs(b - current[axis]));

    let best = startingBest;
    let hits = startingHits;
    for (const side of sides) {
        const candidate = build([], { middle: { ...current, [axis]: side } });
        const candidateHits = blockedBy(candidate.route, obstacles, geometry.bandReach).length;
        if (candidateHits < hits) {
            best = candidate;
            hits = candidateHits;
        }
        if (hits === 0) {
            break;
        }
    }
    return { best, hits };
}

/**
 * Slides a hand-placed crossover clear of anything its route runs through.
 *
 * Not a search: a crossover only collides because it sits within some node's span along its
 * own axis, so the positions that fix it are that node's two sides. Those are tried directly,
 * nearest to where the handle was dropped first, and the first one that clears everything
 * wins. If none does, the least-bad is kept: the same "degrade, don't contort" bargain the
 * automatic avoidance makes.
 *
 * The handle then renders where it ended up, so the snap is visible rather than a silent
 * correction; the stored value is still exactly what was dropped, so moving the node later
 * lets the route return to the intention.
 */
export function clearCrossover(
    build: (detours: Point[], vary?: RouteOverridePoints) => Built,
    middle: Point,
    obstacles: PositionedNode[],
    geometry: RouteGeometry,
    pitch: number,
    enabled: boolean
): Built {
    const asDropped = build([], { middle });
    const axis = asDropped.handles.middle?.axis;
    if (!enabled || obstacles.length === 0 || !axis) {
        return asDropped;
    }
    const hits = blockedBy(asDropped.route, obstacles, geometry.bandReach).length;
    if (hits === 0) {
        return asDropped;
    }
    return slideCrossover(build, middle, axis, asDropped, hits, obstacles, geometry, pitch).best;
}

/** The route's own points, whichever construction produced it. */
function routePoints(route: Route): Point[] {
    return route.kind === "sampled"
        ? route.samples.map(s => ({ x: s.x, y: s.y }))
        : route.vertices;
}

/**
 * Which of these nodes the route actually runs through.
 *
 * Each node's rectangle is inflated by the band's half-width before testing, because the route
 * being tested is a centreline and the ribbon reaches that far either side of it. Testing the
 * centreline alone gives a band that clips something its centreline cleared.
 *
 * There is one reach for the whole band, not a taper along it: packing sizes a slot from the
 * corridor's value and nodes are sized from the packed stack, so a band is the same width at
 * both ends by construction.
 *
 * The result is sorted by id so a diagram routes the same way twice.
 */
export function blockedBy(route: Route, obstacles: PositionedNode[], reach: number): PositionedNode[] {
    const points = routePoints(route);
    const hit = obstacles.filter(node => {
        const minX = node.x - reach;
        const minY = node.y - reach;
        const maxX = node.x + node.width + reach;
        const maxY = node.y + node.height + reach;
        for (let i = 1; i < points.length; i++) {
            if (segmentHitsRect(points[i - 1], points[i], minX, minY, maxX, maxY)) {
                return true;
            }
        }
        return false;
    });
    return hit.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Does the segment a->b touch the axis-aligned rectangle? Liang-Barsky slab clipping: walk
 * the four edges shrinking the parameter range the segment could still be inside, and if any
 * edge empties the range it misses.
 */
function segmentHitsRect(a: Point, b: Point, minX: number, minY: number, maxX: number, maxY: number): boolean {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const clip = (p: number, q: number): boolean => {
        if (Math.abs(p) < DEGENERATE_LENGTH) {
            return q >= 0; // Parallel to this pair of edges: inside the slab or not at all.
        }
        const r = q / p;
        if (p < 0) {
            if (r > t1) { return false; }
            if (r > t0) { t0 = r; }
        } else {
            if (r < t0) { return false; }
            if (r < t1) { t1 = r; }
        }
        return true;
    };
    return clip(-dx, a.x - minX) && clip(dx, maxX - a.x)
        && clip(-dy, a.y - minY) && clip(dy, maxY - a.y);
}

/**
 * Which way a detour between these two stubs runs, and so which axis its lane is measured on:
 * the across axis is the other one.
 *
 * This is one function because three places have to agree about it: the waypoints themselves,
 * the lane handle read back off them, and the projection of a stored lane onto a single
 * number. Derived separately, they would drift apart for a route that arrived at 45 degrees.
 */
function detourRunsHorizontally(from: Point, to: Point): boolean {
    return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
}

/** The axis a detour's lane is measured along: across the way the route runs. */
function detourLaneAxis(from: Point, to: Point): "x" | "y" {
    return detourRunsHorizontally(from, to) ? "y" : "x";
}

/**
 * The lane handle, read back off the waypoints the detour was actually built from rather than
 * predicted from the obstacle. Every other handle follows the same rule, so the dot sits on
 * the drawn route however the geometry ended up (a lane the author dropped inside a node is
 * held clear of it, and the handle has to show that rather than float where the drop was).
 *
 * The lane is found structurally: it is the longest run that travels along the route. A
 * squared detour is turn out, cross into the lane, along it, turn back, so the lane is the
 * consecutive pair sharing an across coordinate, and the handle goes between them, where the
 * eye expects it. A curved detour is a single bow point, and the handle sits on that.
 *
 * Picking the waypoint furthest across from the stubs instead is wrong on a perpendicular
 * pairing: the detour ends with a turn back onto the arrival run's coordinate, which on a
 * perpendicular route is most of the diagram away across the axis, so that point would win and
 * the handle would come out on the riser.
 */
export function detourHandle(detours: Point[], stubOut: Point, stubIn: Point): { point: Point; axis: "x" | "y" } {
    const axis = detourLaneAxis(stubOut, stubIn);
    const along: "x" | "y" = axis === "x" ? "y" : "x";
    let best: [Point, Point] | undefined;
    let reach = -1;
    for (let i = 1; i < detours.length; i++) {
        const a = detours[i - 1];
        const b = detours[i];
        if (Math.abs(a[axis] - b[axis]) > DEGENERATE_LENGTH) {
            continue;
        }
        const span = Math.abs(a[along] - b[along]);
        if (span > reach) {
            reach = span;
            best = [a, b];
        }
    }
    if (best) {
        return { point: midpoint(best[0], best[1]), axis };
    }
    // A curved detour bows around a single point per obstacle, so there is no run to read: the
    // point furthest across from the stubs is the lane.
    const from = stubOut[axis];
    let lane = detours[0];
    detours.forEach(point => {
        if (Math.abs(point[axis] - from) > Math.abs(lane[axis] - from)) {
            lane = point;
        }
    });
    return { point: lane, axis };
}

/**
 * A rectangular detour past each blocking node: turn out of the run, cross into a clear lane,
 * travel along it, and turn back.
 *
 * There are four waypoints per obstacle, not two. Two (just the lane's ends) look fine in a
 * curved style, but they leave nothing to turn the corner into the lane with, so the runs
 * either side of it change both coordinates at once and Orthogonal would draw diagonals
 * through a diagram that is supposed to be square.
 *
 * Everything is computed in (along, across) coordinates and mapped back at the end, so one
 * body handles a horizontal detour and a vertical one rather than two mirrored copies that
 * can drift apart.
 *
 * `from` and `to` are the two port stubs, not the anchors: the detour lives between them, and
 * it is the stubs' cross coordinates the turns have to line up with.
 */
function detourWaypoints(
    from: Point,
    to: Point,
    blockers: PositionedNode[],
    margin: number,
    /**
     * Squared-off routes need the full four-waypoint box. A curved one wants a single point to bow
     * around instead: it passes through the waypoint and eases either side of it, so one point is a
     * graceful swerve where four is a box with the corners rounded off.
     */
    squared: boolean,
    /**
     * A hand-placed lane, already projected onto the across axis, or undefined to choose one. It
     * is held clear of each obstacle on whichever side it was dropped, so dragging it past an
     * obstacle's centre swaps the side the route passes on: one handle for both of the things an
     * author has to say about a detour.
     */
    storedLane?: number,
    /** The band's half-width, so a hand-placed lane can be held just clear of a node. */
    bandReach = 0
): Point[] {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const horizontal = detourRunsHorizontally(from, to);
    const forward = (horizontal ? Math.sign(dx) : Math.sign(dy)) || 1;

    /** (distance along the route, distance across it) back into a point. */
    const at = (alongTo: number, across: number): Point =>
        horizontal ? { x: alongTo, y: across } : { x: across, y: alongTo };
    const alongOf = (node: PositionedNode) =>
        horizontal ? node.x + node.width / 2 : node.y + node.height / 2;

    // Nearest obstacle first, in the direction the corridor travels.
    const ordered = [...blockers].sort((p, q) => (alongOf(p) - alongOf(q)) * forward);

    const points: Point[] = [];
    let across = horizontal ? from.y : from.x;
    ordered.forEach(node => {
        const low = (horizontal ? node.x : node.y) - margin;
        const high = (horizontal ? node.x + node.width : node.y + node.height) + margin;
        const before = forward > 0 ? low : high;
        const after = forward > 0 ? high : low;

        // Which side to pass, measured from where the route actually is by the time it reaches this
        // obstacle rather than from the node's centre. Ties go to the near side, a fixed convention
        // rather than one that depends on iteration order.
        const nearSide = (horizontal ? node.y : node.x) - margin;
        const farSide = (horizontal ? node.y + node.height : node.x + node.width) + margin;
        // A hand-placed lane is taken as dropped, except that it is held out of the obstacle: a lane
        // inside the node defeats the detour, and the clamp is also what makes the far half of the
        // drag mean "pass on the other side". The handle then renders where it ended up while the
        // stored value stays exactly what was dropped, the same bargain `clearCrossover` makes.
        //
        // It is clamped against the band, not against the avoidance margin. The automatic lane already
        // sits a full margin clear, so clamping a drop to the same bound would leave the whole inward
        // half of the handle's travel doing nothing, and a detour that swings out further than it
        // needs to could never be brought in. All the geometry insists on is that the ribbon clears
        // the node, which is its half-width and a pixel: the same floor every other "just clear" in
        // this file takes.
        const lowEdge = horizontal ? node.y : node.x;
        const highEdge = horizontal ? node.y + node.height : node.x + node.width;
        const clearance = bandReach + MIN_PERPENDICULAR_RUN;
        const lane = storedLane === undefined
            ? (Math.abs(across - nearSide) <= Math.abs(across - farSide) ? nearSide : farSide)
            : (storedLane <= (lowEdge + highEdge) / 2
                ? Math.min(storedLane, lowEdge - clearance)
                : Math.max(storedLane, highEdge + clearance));

        if (squared) {
            points.push(at(before, across));   // turn out of the run
            points.push(at(before, lane));     // cross into the lane
            points.push(at(after, lane));      // along it
        } else {
            // One point beside the obstacle; the curve bows around it.
            points.push(at((before + after) / 2, lane));
        }
        across = lane;
    });

    // Turn back onto whatever the arrival run's coordinate is. Only a squared route needs this: a
    // curve simply eases back on its own.
    const arrival = horizontal ? to.y : to.x;
    if (squared && points.length > 0 && Math.abs(across - arrival) > DEGENERATE_LENGTH) {
        const last = points[points.length - 1];
        points.push(at(horizontal ? last.x : last.y, arrival));
    }
    return points;
}
