/**
 * Waypoint chains for the routes that are built from waypoints: squared-off direct routes
 * (Z and L), wraps (a lane round the outside of the nodes, an arch, or an S through a gap),
 * and the helpers that decide lead lengths and lane sides.
 */

import { Point, PORT_NORMALS, PositionedNode } from "./model";
import { portAxis } from "./flowAxis";
import { Anchor, PathSegment, Route, RouteGeometry } from "./routeTypes";
import { centreOf, dot, length, midpoint, scale, sub, unit } from "./routeMath";
import { tangentMatchedArc } from "./curves";
import { DEGENERATE_LENGTH, MIN_PERPENDICULAR_RUN, PROGRESS_EPSILON } from "./routeConstants";
import { routeWraps } from "./anchors";

/**
 * A squared-off direct route: a Z when both ports face along the same axis (out, across at
 * the midpoint, in), an L when they are perpendicular. Unlike a wrap route this does not
 * detour around anything: the target is already in front of both faces, so it just needs
 * squaring off. Collinear points fall out when the anchors line up, leaving a straight run.
 */
export function directWaypoints(
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    stubOut: Point,
    stubIn: Point,
    exitNormal: Point,
    /** Hand-moved crossover; where the Z steps across. Undefined means halfway. */
    crossover?: number,
    /**
     * How far the step must stay clear of each stub: the band's half-width, plus a pixel.
     *
     * The mitre needs this much: the corner at the step reaches back half the band's width along
     * this run, so any less and it laps the stub and folds the ribbon. A rounded corner needs the
     * same run to hold its radius.
     */
    stepMargin = 0,
    /**
     * Polyline style: join the two lead-ins with a single diagonal rather than stepping across at
     * a right angle. The hand-moved bend is already accounted for by the time this runs (it slid
     * both stubs), so there is nothing left to place here.
     */
    diagonal = false
): Point[] {
    const points: Point[] = [sourceAnchor.point, stubOut];
    /**
     * The step stays between the two stubs. Dragged past one, the route would double back on
     * itself: the run out of the port and the run into the step would point opposite ways, which
     * reads as a kink rather than as a placement. Clamping here rather than where the drop is
     * stored keeps the stored value exactly what was dropped, so lengthening a lead later lets the
     * step travel back out to where it was asked to be, the same bargain the lead handles and the
     * avoidance slide make.
     */
    const between = (value: number, a: number, b: number): number => {
        const low = Math.min(a, b) + stepMargin;
        const high = Math.max(a, b) - stepMargin;
        // Too short a run to hold the margin at both ends: centre the step, which is the least-bad
        // place for it and where it would have sat had nobody moved it.
        if (low > high) {
            return (a + b) / 2;
        }
        return Math.max(low, Math.min(high, value));
    };
    if (diagonal) {
        // Nothing between the stubs: the run from one to the other is the diagonal. When the anchors
        // line up it comes out axis-aligned, so an aligned corridor still renders dead straight.
    } else if (portAxis(sourceAnchor.port) === portAxis(targetAnchor.port)) {
        if (exitNormal.x !== 0) {
            const midX = crossover !== undefined
                ? between(crossover, stubOut.x, stubIn.x)
                : (stubOut.x + stubIn.x) / 2;
            points.push({ x: midX, y: stubOut.y }, { x: midX, y: stubIn.y });
        } else {
            const midY = crossover !== undefined
                ? between(crossover, stubOut.y, stubIn.y)
                : (stubOut.y + stubIn.y) / 2;
            points.push({ x: stubOut.x, y: midY }, { x: stubIn.x, y: midY });
        }
    } else {
        // Perpendicular ports: one corner, and it goes where the two ports' normal rays cross. The
        // source's ray runs along its own face's normal through its anchor, the target's likewise.
        // Put the corner there and each stub is collinear with the run that follows it, so the whole
        // route collapses to a single clean right angle.
        //
        // The other candidate corner, pairing each stub's own coordinate ((stubOut.x, stubIn.y) here),
        // is also a valid L between the two stubs, but it sits on neither ray, so the stubs no longer
        // line up with it and the route comes out as a four-run staircase.
        points.push(exitNormal.x !== 0
            ? { x: stubIn.x, y: stubOut.y }
            : { x: stubOut.x, y: stubIn.y });
    }
    points.push(stubIn, targetAnchor.point);
    return points;
}

/**
 * Curves through a waypoint chain instead of squaring it off (Smooth style). Interior
 * tangents are taken from the direction between a waypoint's neighbours, then each pair is
 * joined by a tangent-matched cubic, so the joins stay smooth. It is deliberately not a plain
 * spline through the raw waypoints: they are sparse and widely spaced, and fitting one
 * directly reshapes the whole route rather than easing its corners.
 */
export function smoothChain(centreline: Point[], exitTangent: Point, arrivalTangent: Point): PathSegment[] {
    // The first and last runs are the port lead-ins and stay straight, so only the span between
    // them is curved.
    const middle = centreline.slice(1, -1);
    const tangents = middle.map((_point, i) => {
        if (i === 0) {
            return exitTangent;
        }
        if (i === middle.length - 1) {
            return arrivalTangent;
        }
        return unit(sub(middle[i + 1], middle[i - 1]));
    });

    const segments: PathSegment[] = [{ kind: "line", a: centreline[0], b: middle[0] }];
    for (let i = 0; i < middle.length - 1; i++) {
        segments.push({ kind: "cubic", arc: tangentMatchedArc(middle[i], tangents[i], middle[i + 1], tangents[i + 1]) });
    }
    segments.push({ kind: "line", a: middle[middle.length - 1], b: centreline[centreline.length - 1] });
    return segments;
}

/**
 * Keeps the polyline itself for a sharp-cornered band, with the weight at each vertex. Mirrors
 * the sampled path's convention: the two port lead-ins are pinned to weight 0 and 1 so a
 * multi-segment corridor holds its packed port spacing right at the node, and the span between
 * them advances by cumulative length.
 */
export function sharpRoute(centreline: Point[]): Route {
    const vertices = centreline.filter((p, i) => i === 0 || length(sub(p, centreline[i - 1])) > DEGENERATE_LENGTH);
    if (vertices.length < 3) {
        return { kind: "sharp", vertices, weights: vertices.map((_, i) => (i === 0 ? 0 : 1)) };
    }

    // Cumulative length across the middle only (excluding both lead-ins).
    const spans: number[] = [0];
    for (let i = 2; i < vertices.length - 1; i++) {
        spans.push(spans[spans.length - 1] + length(sub(vertices[i], vertices[i - 1])));
    }
    const total = spans[spans.length - 1] || 1;

    const weights = vertices.map((_, i) => {
        if (i <= 1) {
            return 0;
        }
        if (i >= vertices.length - 2) {
            return 1;
        }
        return spans[i - 1] / total;
    });
    return { kind: "sharp", vertices, weights };
}

/**
 * A same-port wrap's arch: both stubs brought to one level and joined.
 *
 * Returns the two lane points, or undefined where the shape or the room says no. One place
 * decides and places it, so the handle that moves the lane and the route it moves cannot
 * drift apart.
 *
 * The lane is a coordinate on the port normal's own axis: the outer of the two stubs, pushed
 * `laneOffset` further out again for staggering, or wherever it was dragged.
 * `withPerpendicular` replaces the coordinate on the axis it is handed, so passing the normal
 * puts both stubs on one level and leaves each where it is across the route.
 */
export function archOf(
    stubOut: Point,
    stubIn: Point,
    normal: Point,
    dragged: number | undefined,
    laneOffset: number
): { a: Point; b: Point; lane: number } {
    const alongX = normal.x !== 0;
    const sign = alongX ? normal.x : normal.y;
    const outer = dot(stubOut, normal) >= dot(stubIn, normal) ? stubOut : stubIn;
    const lane = dragged ?? ((alongX ? outer.x : outer.y) + laneOffset * sign);
    return {
        a: withPerpendicular(stubOut, normal, lane),
        b: withPerpendicular(stubIn, normal, lane),
        lane
    };
}

/**
 * Does this pairing go round as an arch?
 *
 * This is asked of the anchors and the nodes alone, so it can be answered before the lead-ins
 * it decides about: an arch has no lead handles, so it must ignore hand-moved ones. It is one
 * statement of the rule, read by `routeCorridor` (which strips those overrides) and by
 * `buildSpine` (which places the lane).
 */
export function archesBetween(sourceAnchor: Anchor, targetAnchor: Anchor,
    sourceNode: PositionedNode, targetNode: PositionedNode, margin: number): boolean {
    return sourceNode.id !== targetNode.id
        && sourceAnchor.port === targetAnchor.port
        && archFits(PORT_NORMALS[sourceAnchor.port], sourceNode, targetNode, margin);
}

/**
 * Does a same-port wrap have room to go round as an arch?
 *
 * Both ends leave the same face the same way, so the natural shape is one trip over the top:
 * out of the source, along a lane beyond both faces, back down into the target. The only thing
 * that can stop it is one node sitting in the other's way along that lane, and since both runs
 * travel along the port's normal, that is exactly the two nodes overlapping across it.
 *
 * It is deliberately the conservative test: it asks whether the spans overlap at all, not
 * whether this particular descent would clip. It declines an arch that would in fact have
 * fitted rather than draw one that cuts a node, which is the same bargain `leadPastNode`
 * takes.
 */
function archFits(normal: Point, a: PositionedNode, b: PositionedNode, margin: number): boolean {
    const acrossX = normal.x === 0;
    const low = (n: PositionedNode): number => acrossX ? n.x : n.y;
    const high = (n: PositionedNode): number => low(n) + (acrossX ? n.width : n.height);
    return high(a) + margin <= low(b) || high(b) + margin <= low(a);
}

/**
 * The centreline for a wrap route, as axis-aligned waypoints.
 *
 * Ports on the same axis (a same-node East-out/West-in loop, a corridor whose target sits
 * behind it, two nodes meeting on the same compass face) route out to a lane clear of both
 * nodes, along it, and back in. Ports on perpendicular axes need only a single corner,
 * taking each end's own stub coordinate on its own axis.
 */
export function wrapWaypoints(
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    sourceNode: PositionedNode,
    targetNode: PositionedNode,
    stubOut: Point,
    stubIn: Point,
    exitNormal: Point,
    geometry: RouteGeometry,
    /** Hand-moved lane coordinate; undefined means the computed clearing lane. */
    crossover?: number,
    /** How far further out to sit than the plain clearing lane (see `staggerLanes`). */
    laneOffset = 0,
    /** A same-port wrap's two lane points, when it goes round as an arch (`archOf`). */
    arch?: { a: Point; b: Point }
): Point[] {
    const points: Point[] = [sourceAnchor.point, stubOut];
    let arched = false;

    if (portAxis(sourceAnchor.port) === portAxis(targetAnchor.port)) {
        // Which side of the node the lane runs down. For two different nodes that is whichever way
        // the target leans. For a self-loop it cannot be: both ends sit on the same node, at the same
        // extreme, so the lean between them is just the difference in their two band widths, which is
        // noise, and enough to send a loop whose ends are at the top all the way round the bottom.
        // What decides it there is which side of the node the ends themselves are on.
        let perp = wrapLaneSide(sourceAnchor, targetAnchor, sourceNode, targetNode, crossover);
        // A self-loop whose lane has been dragged past its node's far edge runs round that side
        // (`flippedLoops`). Its ends move to that end of their faces too, which usually tips the lean
        // above the same way, but a lone loop's ends sit in the middle of their faces (the packed
        // block stays centred), so there the lane has to decide it.
/**
 * A hand-moved lane never runs through the nodes it goes round, and dropping it past them
 * flips the route to the other side.
 *
 * Routing accepts the flipped shape (a lane dropped below the pair draws a clean horseshoe the
 * other way up), but without this you could not get the lane there:
 *
 * - Part way across, the lane sits inside the nodes and the band would be drawn straight
 *   through both of them. Avoidance does not rescue it, because its slide ignores a
 *   corridor's own two nodes.
 * - A drop is clamped to the viewport (`resolvePoint`), so with the pair against the bottom
 *   edge there would be nowhere below them to drop it. The view only grows to fit the flipped
 *   route once the route has flipped.
 *
 * Held clear, the drag passes the midpoint and the lane lands just beyond the far face: one
 * gesture says both which side and how far out, and neither needs room on screen to reach.
 *
 * The span is the pair's, which for a self-loop is just its own node.
 */
        let loopLane: number | undefined;
        if (crossover !== undefined) {
            // Which side the route runs, including the flip a lane dropped past the far face asks for, was
            // decided by `wrapLaneSide` above, which is also what the packing order reads.
            const alongX = perp.x !== 0;
            const lowOf = (n: PositionedNode): number => alongX ? n.x : n.y;
            const highOf = (n: PositionedNode): number => lowOf(n) + (alongX ? n.width : n.height);
            const selfLoop = sourceNode.id === targetNode.id;
            const low = selfLoop ? lowOf(sourceNode) : Math.min(lowOf(sourceNode), lowOf(targetNode));
            const high = selfLoop ? highOf(sourceNode) : Math.max(highOf(sourceNode), highOf(targetNode));
            const clear = geometry.bandReach + MIN_PERPENDICULAR_RUN;
            loopLane = (alongX ? perp.x : perp.y) < 0
                ? Math.min(crossover, low - clear)
                : Math.max(crossover, high + clear);
            /**
             * Between the two nodes, the lane makes an S. Two different nodes with a clear gap between
             * them along the lane's axis (one entirely before the other, a clearance to spare each side)
             * leave room for the lane there: the out-run climbs only as far as the gap, the lane crosses
             * it, and the in-run rises to the far node's face. Nothing is in the way, because each run
             * stays on its own node's side of the gap.
             *
             * This applies only to a lane the author has placed: the default route is still the
             * round-the-outside one, and a lane dropped anywhere that is not inside the gap is held clear
             * as before.
             */
            if (!selfLoop) {
                const lowS = lowOf(sourceNode), highS = highOf(sourceNode);
                const lowT = lowOf(targetNode), highT = highOf(targetNode);
                const gap = highS + 2 * clear <= lowT
                    ? { from: highS + clear, to: lowT - clear }
                    : highT + 2 * clear <= lowS
                        ? { from: highT + clear, to: lowS - clear }
                        : undefined;
                if (gap && crossover >= gap.from && crossover <= gap.to) {
                    loopLane = crossover;
                }
            }
        }
        /**
         * Two ends on the same port go round as an arch.
         *
         * The lane above is laid across the port's normal, which is right for two ends that leave in
         * opposite directions (N->S, E->W): they have to be brought round the side. Two ends on the
         * same port leave the same way, and routing them round the side would make the route go out
         * past both nodes and come straight back along its own line (N->N side by side: out 98px and
         * back 98px, drawn over itself, with a zero-radius 180-degree turn at the end of it). Offset
         * the nodes and the overlap becomes a back-hook.
         *
         * The arch lays the lane along the normal instead: both stubs reach one level beyond both
         * faces and the run between them joins them directly. Level nodes give a flat-topped arch,
         * offset ones a stair, and neither ever doubles back.
         *
         * Only where it fits (`archFits`): with one node across the other's way the descent would cut
         * it, and the side lane above is then the right shape after all. Never for a self-loop: both
         * ends are the same node, loops are designed once and shared by all four styles, and a
         * 0-degree loop's two stubs already share a line.
         */
        arched = arch !== undefined;
        if (arch) {
            points.push(arch.a, arch.b);
        } else {
            const lane = loopLane ?? crossover
                ?? (laneCoordinate(sourceNode, targetNode, perp, geometry.clearance) + laneOffset);
            points.push(withPerpendicular(stubOut, perp, lane));
            points.push(withPerpendicular(stubIn, perp, lane));
        }
    } else {
        // Exactly one coordinate comes from each end, since the axes differ.
        points.push(exitNormal.x !== 0
            ? { x: stubOut.x, y: stubIn.y }
            : { x: stubIn.x, y: stubOut.y });
    }

    points.push(stubIn, targetAnchor.point);
    /**
     * An arch whose outer stub is already on its lane must leave no trace of the repeat. Both ends
     * reach one level and the outer one is at that level by construction, so its stub and its lane
     * point are the same point. `roundedPolyline` drops repeats, so the band is right either way,
     * but `spine` is handed downstream (layers.ts asks it which way a corridor travels at a point)
     * and a zero-length segment has no direction.
     */
    return arched
        ? points.filter((q, i) => i === 0 || length(sub(q, points[i - 1])) > DEGENERATE_LENGTH)
        : points;
}

/**
 * Where an S lane would sit, or undefined if a wrap has no business in the gap.
 *
 * Two different nodes, joined by ends on opposite sides of the lane axis (E->W, N->S: not the
 * same-port arch), with a clear gap between them along the axis the lane is laid across (one
 * entirely before the other, a clearance to spare each side), are best joined by an S through
 * that gap rather than a loop round the outside of the pair. The lane sits in the middle of
 * the gap, moved on by `laneOffset` (the lane stagger) and held inside it.
 *
 * Only the geometry the two nodes decide. Whether anything else is in the way is the caller's
 * question: it builds the route and asks `blockedBy`.
 */
export function sLaneOf(
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    sourceNode: PositionedNode,
    targetNode: PositionedNode,
    bandReach: number,
    laneOffset: number
): Point | undefined {
    if (sourceNode.id === targetNode.id || sourceAnchor.port === targetAnchor.port
        || portAxis(sourceAnchor.port) !== portAxis(targetAnchor.port)
        || !routeWraps(sourceAnchor, targetAnchor)) {
        return undefined;
    }
    const exitNormal = PORT_NORMALS[sourceAnchor.port];
    // The lane runs across the exit normal: East/West exits lay it at a y.
    const alongY = exitNormal.x !== 0;
    const lowOf = (n: PositionedNode): number => alongY ? n.y : n.x;
    const highOf = (n: PositionedNode): number => lowOf(n) + (alongY ? n.height : n.width);
    const clear = bandReach + MIN_PERPENDICULAR_RUN;
    const lowS = lowOf(sourceNode), highS = highOf(sourceNode);
    const lowT = lowOf(targetNode), highT = highOf(targetNode);
    const gap = highS + 2 * clear <= lowT
        ? { from: highS + clear, to: lowT - clear }
        : highT + 2 * clear <= lowS
            ? { from: highT + clear, to: lowS - clear }
            : undefined;
    if (!gap) {
        return undefined;
    }
    const lane = Math.max(gap.from, Math.min(gap.to, (gap.from + gap.to) / 2 + laneOffset));
    const across = alongY
        ? (sourceAnchor.point.x + targetAnchor.point.x) / 2
        : (sourceAnchor.point.y + targetAnchor.point.y) / 2;
    return alongY ? { x: across, y: lane } : { x: lane, y: across };
}

/**
 * Which side of its nodes a wrap runs round, as a unit vector perpendicular to the exit
 * normal.
 *
 * Two inputs, in order: the geometry (whichever way the far end leans, or for a self-loop which
 * side of its own node the ends sit), and then the hand-moved lane, which wins outright when it
 * was dropped past the far face.
 *
 * It exists to be asked twice. The route decides this for itself, and the order of the ends on
 * their face is decided separately from where the far end sits; if the two disagree, the lane
 * runs over the top of a neighbour while the arrival is packed at the bottom of its face, so
 * the band dives back across it to get in. One function, asked by both, cannot contradict
 * itself.
 */
function wrapLaneSide(
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    sourceNode: PositionedNode,
    targetNode: PositionedNode,
    /** The hand-moved lane coordinate, already projected onto its axis. */
    crossover?: number
): Point {
    const exitNormal = PORT_NORMALS[sourceAnchor.port];
    const selfLoop = sourceNode.id === targetNode.id;
    // For two different nodes that is whichever way the target leans. For a self-loop it cannot
    // be: both ends sit on the same node, at the same extreme, so the lean between them is just
    // the difference in their two band widths, which is noise, and enough to send a loop whose
    // ends are at the top all the way round the bottom. What decides it there is which side of the
    // node the ends themselves are on.
    const toward = selfLoop
        ? sub(midpoint(sourceAnchor.point, targetAnchor.point), centreOf(sourceNode))
        : sub(targetAnchor.point, sourceAnchor.point);
    const perp = perpendicularToward(exitNormal, toward);
    if (crossover === undefined) {
        return perp;
    }
    const alongX = perp.x !== 0;
    const lowOf = (n: PositionedNode): number => alongX ? n.x : n.y;
    const highOf = (n: PositionedNode): number => lowOf(n) + (alongX ? n.width : n.height);
    const low = selfLoop ? lowOf(sourceNode) : Math.min(lowOf(sourceNode), lowOf(targetNode));
    const high = selfLoop ? highOf(sourceNode) : Math.max(highOf(sourceNode), highOf(targetNode));
    const sign = alongX ? perp.x : perp.y;
    const beyond = sign < 0 ? crossover > high : crossover < low;
    return beyond ? scale(perp, -1) : perp;
}

/**
 * The unit vector perpendicular to `normal`, pointing to whichever side `toward` leans. Ties
 * resolve to a fixed convention (up for a vertical perpendicular, right for a horizontal one)
 * rather than to the anchors, so a hair's-breadth packing difference cannot flip a route to the
 * other side of a node between refreshes.
 */
function perpendicularToward(normal: Point, toward: Point): Point {
    const horizontalNormal = Math.abs(normal.x) > Math.abs(normal.y);
    const lean = horizontalNormal ? toward.y : toward.x;
    if (Math.abs(lean) < PROGRESS_EPSILON) {
        return horizontalNormal ? { x: 0, y: -1 } : { x: 1, y: 0 };
    }
    return horizontalNormal
        ? { x: 0, y: Math.sign(lean) }
        : { x: Math.sign(lean), y: 0 };
}

/**
 * How far out along `normal` a port's lead must run to reach a lane clear of both nodes
 * (never shorter than `baseLead`).
 */
export function leadClearing(
    anchor: Point,
    normal: Point,
    a: PositionedNode,
    b: PositionedNode,
    clearance: number,
    baseLead: number
): number {
    const lane = laneCoordinate(a, b, normal, clearance);
    const lanePoint = normal.x !== 0 ? { x: lane, y: anchor.y } : { x: anchor.x, y: lane };
    return Math.max(baseLead, dot(sub(lanePoint, anchor), normal));
}

/**
 * Extends a lead-in far enough that the cross-run leaving it clears `other`, measuring along
 * the port's own axis. Returns the lead unchanged when the run already passes clear, which is
 * the common case, and notably covers a self-loop, whose cross-run travels alongside its node
 * rather than over it.
 *
 * A hand-moved lead may come out the near side instead. The run has to miss the node; which
 * side it misses it on is the author's business, and it is the same single degree of freedom
 * with the same two answers a hand-moved lane already gives a route that wraps. Without this
 * the obstacle is a wall: a lead dragged inward would stop dead at the far edge over its whole
 * travel.
 *
 * Only when it was dragged. The automatic lead keeps going out the far side, so nothing an
 * author has not touched moves, and a drag that asks for the far side still gets it, because
 * the nearer of the two is measured against what was asked for.
 */
export function leadPastNode(anchor: Point, normal: Point, other: PositionedNode, margin: number, lead: number,
    dragged = false): number {
    const horizontal = normal.x !== 0;
    const sign = horizontal ? normal.x : normal.y;
    const anchorCoordinate = horizontal ? anchor.x : anchor.y;
    const runCoordinate = anchorCoordinate + sign * lead;
    const low = (horizontal ? other.x : other.y) - margin;
    const high = (horizontal ? other.x + other.width : other.y + other.height) + margin;
    if (runCoordinate < low || runCoordinate > high) {
        return lead;
    }
    // The two ways out of the obstacle's span, as lead lengths.
    const far = ((sign > 0 ? high : low) - anchorCoordinate) * sign;
    const near = ((sign > 0 ? low : high) - anchorCoordinate) * sign;
    if (!dragged || near < 0) {
        // Behind the face there is no near side to come out on.
        return Math.max(lead, far);
    }
    return Math.abs(near - lead) <= Math.abs(far - lead) ? near : far;
}

/** The coordinate of a travel lane running clear of both nodes, on `perp`'s side. */
function laneCoordinate(a: PositionedNode, b: PositionedNode, perp: Point, clearance: number): number {
    if (perp.y < 0) {
        return Math.min(a.y, b.y) - clearance;
    }
    if (perp.y > 0) {
        return Math.max(a.y + a.height, b.y + b.height) + clearance;
    }
    if (perp.x < 0) {
        return Math.min(a.x, b.x) - clearance;
    }
    return Math.max(a.x + a.width, b.x + b.width) + clearance;
}

/** `point` moved onto the lane, keeping its coordinate on the other axis. */
function withPerpendicular(point: Point, perp: Point, lane: number): Point {
    return perp.x !== 0 ? { x: lane, y: point.y } : { x: point.x, y: lane };
}
