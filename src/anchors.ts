/**
 * Port packing: where every corridor end attaches to its node.
 *
 * Corridor ends that share a node face are stacked into contiguous, non-overlapping slots
 * sized by value. Grouping is per face, not per direction: a node can have corridors leaving
 * and arriving on the same face, and they would overlap if packed separately. East/West faces
 * pack along the node's height, North/South along its width.
 *
 * The order within a face is decided in two ways: a sweep that scores crossings on the chord
 * between anchors (the default), and the stub-line rule, which reads the drawn routes and is
 * applied where the author has moved a handle.
 */

import { Corridor, LayoutResult, Point, Port, PORT_NORMALS, PositionedNode } from "./model";
import { portAxis } from "./flowAxis";
import { stripeGapCount } from "./arrows";
import {
    Anchor, EndRole, PackingOrder, PortEnd, PortGroup, RouteHandles, Slot, StubLineEnd
} from "./routeTypes";
import { dot, segmentsCross, sub } from "./routeMath";
import { ORDERING_PASSES, PARALLEL_RADIANS, PROGRESS_EPSILON } from "./routeConstants";
import { RoutingStyle } from "./routingStyle";

/** Anchor map key: one entry per corridor end, since the two differ. */
export function anchorKey(corridorId: string, role: EndRole): string {
    return `${corridorId}|${role}`;
}

/**
 * Does this corridor have to double back on itself, rather than running forward out of one
 * port and straight into the other? True when either end sits behind the face its own port
 * points out of.
 *
 * Exported so straighten.ts asks the same question `buildSpine` does: only a direct route can
 * ever be pulled straight, and "direct" has to mean exactly what routing means by it or the
 * nudge would be spent on a route that will be squared off around a node anyway.
 */
export function routeWraps(sourceAnchor: Anchor, targetAnchor: Anchor): boolean {
    const exitNormal = PORT_NORMALS[sourceAnchor.port];
    const entryNormal = PORT_NORMALS[targetAnchor.port];
    const targetIsBehindExit = dot(sub(targetAnchor.point, sourceAnchor.point), exitNormal) < PROGRESS_EPSILON;
    const sourceIsBehindEntry = dot(sub(sourceAnchor.point, targetAnchor.point), entryNormal) < PROGRESS_EPSILON;
    return targetIsBehindExit || sourceIsBehindEntry;
}

/** The key a PackingOrder is held against. */
function faceKeyOf(nodeId: string, port: Port): string {
    return `${nodeId}|${port}`;
}

/**
 * The stub-line packing rule.
 *
 * The ordering object is the line segment joining a corridor's two lead-in handles. Every
 * style places its leads on the port normals and differs only in how it connects them, so
 * that segment is the same object in all four, which makes this style-agnostic where the
 * straight chord between the two anchors is not. It also moves when the author drags a lead,
 * so a hand-placed route can say what the packing order should be.
 *
 *   key 1  the segment's own angle against this face's outward normal.
 *   key 2  where two segments are parallel (within `PARALLEL_DEGREES`) key 1 cannot separate
 *          them, so the middle handle does: the route's own crossing run (an Orthogonal step,
 *          a dragged bend, an avoided route's lane), ordered across the cluster's direction of
 *          travel.
 *
 * Key 2 is the middle handle, not the stub line's own position. The extended stub-to-stub
 * line's perpendicular offset is nowhere near where the vertical actually runs on an
 * Orthogonal Z, so on a diagram whose corridors mostly travel across the flow, where nearly
 * every segment is near 90 degrees to the normal and key 1 says nothing at all, the thing the
 * author was moving would have no say.
 *
 * Key 2's sign comes out of a cross product, not a convention. Order a cluster by `d x via` in
 * the face's own frame, `d` being the cluster's mean direction and `via` the middle handle.
 * Checked against what must not cross: two runs heading down off an East face want the one
 * that turns down later on top (its horizontal run is longer, so an earlier turn would cut
 * across it); two heading up want the opposite; two heading straight out order by their
 * middles' across position. The cross product gives all three, where a hand-written sign rule
 * would need three cases and get one of them wrong.
 *
 * It is applied only where the author has dragged something. The automatic diagram keeps the
 * chord sweep below, with which the handle line agrees on nearly every pair anyway, so
 * running it everywhere moves diagrams for nothing. It is also what makes the rule terminate:
 * applied once in answer to a drag rather than chased to a fixed point, it cannot oscillate;
 * the keys-from-routes-from-keys loop can cycle.
 *
 * There is no guard. A dragged handle is the author saying what they want; a painted-overlap
 * test that refused it would be a drag that silently does nothing.
 *
 * Orthogonal takes its own path. Every other style lets the author drag the leads, so key 1
 * answers a drag directly; a Z's leads come from the style's defaults and cannot move, which
 * leaves the step as the only thing the author can say, and a step only speaks inside a
 * parallel cluster. There, key 1 is used for its sign alone: everything travelling one way
 * across the face is one group, ordered by where its vertical actually runs.
 *
 * That ordering is what must not cross: a Z leaves the face, runs out to its step, turns, and
 * runs in. Two Zs off an East face both heading up cannot cross exactly when the one that
 * turns sooner sits higher, since its horizontal run is the shorter one and a later turn above
 * it would have to cut across. Two heading down want the reverse. Hence ascending in the
 * step's own coordinate for one direction, descending for the other, which is the same cross
 * product the parallel clusters use, specialised to a right angle.
 */
function stubLineKeys(
    spine: Point[], role: EndRole, port: Port, perpendicular: boolean, via?: Point,
    /** Where this end's straight run stops; see `runEndsOf`. */
    runEnd?: Point,
    /** A self-loop or a wrap: take key 2 from the first corner. */
    loop = false
): Omit<StubLineEnd, "key" | "at" | "pinned"> | undefined {
    // Oriented from this end: anchor, this end's stub, ... , the far stub.
    const points = role === "source" ? spine : [...spine].reverse();
    if (points.length < 3) {
        return undefined;
    }
    // On a 90-degree L the lead-in is where the straight stops, not the port stub. The straight
    // runs on past the stub to the corner, so the stub is not the point the route departs from,
    // and a pair compared at their stubs is compared at two points neither route has started
    // turning at. Smooth needs no fixing here because its leads are derived from the corner
    // radius, so its stub already is this point.
    const mine = runEnd ?? points[1];
    const theirs = points[points.length - 2];
    const normal = PORT_NORMALS[port];
    const vertical = portAxis(port) === "vertical";
    const across = (p: Point): number => (vertical ? p.y : p.x);
    const forward = (p: Point): number => p.x * normal.x + p.y * normal.y;

    // Key 1 is the lead-in to lead-in segment's own angle. Ending it at the middle handle instead
    // would let the middle replace the far stub and reorder every face rather than the ones key 1
    // cannot separate; the middle belongs to key 2.
    //
    // A 90-degree L is the exception, and it is a right angle by construction. A direct
    // perpendicular pairing leaves this face, runs out, and turns, so its crossing run is square to
    // the face whatever the two lead-ins happen to line up as, and the segment between them is a
    // diagonal the route never travels. Reporting that diagonal's angle would put two such routes
    // on their own among the ordinary corridors instead of together where the turn positions can
    // order them. It reads as 90 degrees, signed by the way it crosses this face, and key 2 then
    // does the work: the run sits at the far node's lead-in.
    //
    // A loop is signed by its first corner, not by the far lead. The far lead is the wrong witness
    // for a loop: on a 180-degree self-loop it sits on the opposite face a few pixels away, so the
    // sign it gives is noise, and the end would then pack mid-face while the route goes round the
    // top, crossing its own node. The corner says which way the route actually turns on leaving,
    // which is the only thing the slot has to agree with. One witness answers both keys: which
    // side here, and how far out below.
    const toward = (loop ? points[2] : undefined) ?? theirs;
    const turning = perpendicular && Math.abs(across(toward) - across(mine)) > PROGRESS_EPSILON;
    const angle = turning
        ? Math.sign(across(toward) - across(mine)) * Math.PI / 2
        : Math.atan2(across(theirs) - across(mine), forward(theirs) - forward(mine));

    // Key 2's input: where the route's own crossing run sits. The middle handle is that run (an
    // Orthogonal step, a dragged bend, an avoided route's lane), and where a route has none, the
    // far stub stands in.
    //
    // A loop's is its first corner. A loop leaves the face, runs out, and turns: the segment from
    // this end's stub to that corner is the one that travels across the face, which is what an
    // Orthogonal Z's middle line is. It is read off the spine and not from a stored handle, so it
    // is the distance the author can see whether anything has been dragged or not.
    //
    //   F->C East  1132,439 -> 1174,439 -> 1174,778 -> 274,778 -> ...
    //              anchor      stub        CORNER
    //
    // With key 1 at +-90 the cluster's mean is square to the face, so `cos(mean)` is 0 and key 2
    // collapses to -+`forward(point)`: the corner's distance out along the port normal, signed by
    // the way the cluster crosses. Nearest the face is the most extreme end, and the sign makes
    // that true on either side without a rule of its own.
    const point = (loop ? points[2] : undefined) ?? via ?? theirs;
    return {
        angle,
        via: { forward: forward(point), across: across(point) },
        // The pair constraint needs both ends of the chord in this face's frame, and it moves the stub
        // between candidate slots, so the stub's forward reach (its lead-in length) is kept apart from
        // the across coordinate, which is whichever slot is being tried.
        stubForward: forward(mine),
        // The pair constraint gets the same witness. `pairFits` asks where each corridor heads, and
        // for a loop that is its first corner, not the far lead-in; the loop never travels toward
        // that. Left as `theirs` it would let the swap pass reorder a loop against an ordinary
        // connector on a chord the route has nothing to do with, undoing what keys 1 and 2 had just
        // decided. For everything else `toward` is `theirs`, so nothing else moves.
        far: { forward: forward(toward), across: across(toward) }
    };
}

/**
 * The pair constraint. For two ends sharing a face, is `upper` above `lower` an arrangement
 * that can be drawn without them crossing?
 *
 *   x  a corridor's own chord angle: where its route actually heads.
 *   y  the angle of the line joining the two corridors' lead-in handles.
 *
 * The upper corridor must leave above that line (`x < y`) and the lower one below it. That is
 * what an angle alone cannot say: the angle knows where a corridor is going but nothing about
 * where its neighbour's lead-in sits, and `y` is exactly that missing term. It is why a long
 * lead-in with a shallow angle and a short lead-in with a sharp one can be ordered wrongly by
 * the angle: the two stubs are far apart along the face's normal, so `y` swings a long way
 * from square and stops agreeing with the bare angle.
 *
 * It is a constraint, not a key. Where it speaks it is almost always right, but it is silent
 * for most pairs (either order satisfies it), so it cannot order a whole face on its own.
 * Applied as a constraint over the angle order it corrects the angle's mistakes without
 * disturbing the rest. Constraining the upper corridor alone is nearly as accurate but speaks
 * for far fewer pairs.
 *
 * It was characterised on idealised Polyline geometry (a four-point polyline, one slot gap,
 * band widths ignored), so the ranking is what that establishes, not the rate a real diagram
 * would show.
 */
function pairFits(
    upper: StubLineEnd, upperAcross: number,
    lower: StubLineEnd, lowerAcross: number
): boolean {
    const upperStub = { forward: upper.stubForward, across: upperAcross };
    const lowerStub = { forward: lower.stubForward, across: lowerAcross };
    const angleBetween = (
        from: { forward: number; across: number },
        to: { forward: number; across: number }
    ): number => Math.atan2(to.across - from.across, to.forward - from.forward);
    return angleBetween(upperStub, upper.far) < angleBetween(upperStub, lowerStub)
        && angleBetween(lowerStub, lower.far) > angleBetween(lowerStub, upperStub);
}

/** Every face's order under the stub-line rule, read off the routes in hand. */
export function stubLineOrder(
    layout: LayoutResult,
    spines: Map<string, Point[]>,
    anchors: Map<string, Anchor>,
    handles: Map<string, RouteHandles>,
    /** Where each L's straight runs stop, keyed by corridor: the lead-ins. */
    runEnds: Map<string, { source: Point; target: Point }>,
    style: RoutingStyle
): PackingOrder {
    const faces = new Map<string, StubLineEnd[]>();
    const add = (corridor: Corridor, role: EndRole, nodeId: string, port: Port): void => {
        const spine = spines.get(corridor.id);
        const node = layout.nodes.get(nodeId);
        const mine = anchors.get(anchorKey(corridor.id, role));
        const source = anchors.get(anchorKey(corridor.id, "source"));
        const target = anchors.get(anchorKey(corridor.id, "target"));
        if (!spine || !node || !mine || !source || !target) {
            return;
        }
        // The route's own middle control where it has one: an Orthogonal step, a dragged bend, or the
        // lane an avoided route passes on.
        const route = handles.get(corridor.id);
        // A direct perpendicular pairing draws an L, whichever style it is in: out, then square. Its
        // two ports face along different axes.
        const perpendicular = portAxis(corridor.sourcePort) !== portAxis(corridor.targetPort);
        // A loop reads as a right angle, because it is one. It leaves the face, runs out and turns,
        // exactly as a 90-degree L does, so the segment between its two lead-ins is a diagonal the
        // route never travels, and key 1 belongs at +-90 with key 2 doing the work. Nothing about a
        // loop is special here.
        const loop = corridor.isSelfLoop || routeWraps(source, target);
        const ends = runEnds.get(corridor.id);
        const keys = stubLineKeys(spine, role, port, perpendicular || loop,
            (route?.middle ?? route?.detour)?.point,
            ends && (role === "source" ? ends.source : ends.target), loop);
        if (!keys) {
            return;
        }
        const face = faceKeyOf(nodeId, port);
        const list = faces.get(face) ?? [];
        list.push({
            key: anchorKey(corridor.id, role),
            at: portAxis(port) === "vertical" ? mine.point.y : mine.point.x,
            // Nothing is pinned. The extremes are not imposed on a dragged face: a self-loop's two ends
            // get opposite +-90 signs, because each one's far lead sits on the other side of it along the
            // face, so they fall into the two outermost clusters of their own accord. A face the author
            // has not touched is left to the sweep.
            pinned: false,
            ...keys
        });
        faces.set(face, list);
    };
    layout.corridors.forEach(corridor => {
        if (corridor.value <= 0) {
            return;
        }
        add(corridor, "source", corridor.source, corridor.sourcePort);
        add(corridor, "target", corridor.target, corridor.targetPort);
    });

    const order: PackingOrder = new Map();
    faces.forEach((list, face) => {
        // The slots as they stand, so a pinned end can keep the one it has.
        const slots = [...list].sort((a, b) => a.at - b.at);
        const free = slots.filter(end => !end.pinned);
        if (free.length < 2) {
            return; // nothing this rule can say: one free end, or none
        }
        // Sorted by angle, then every run of parallel segments re-sorted by key 2. Clustered rather
        // than compared with a tolerance inside one comparator: "within 2 degrees" is not transitive
        // (a ties b, b ties c, a and c do not), and a sort handed an inconsistent comparator may
        // return anything at all.
        free.sort((a, b) => a.angle - b.angle);
        const ordered: StubLineEnd[] = [];
        // On a Z the leads cannot be dragged, so key 1 never answers the author and only the step
        // does: everything travelling one way across the face is one group, however steeply, ordered
        // by its step. Octilinear follows Orthogonal: its 45-degree fit pulls a steep segment to
        // exactly square, so the ends that should be compared by their crossing runs already read the
        // same angle.
        const byDirection = style === "Orthogonal";
        const clustered = (first: StubLineEnd, next: StubLineEnd): boolean =>
            (byDirection
                ? (first.angle < 0) === (next.angle < 0)
                : next.angle - first.angle <= PARALLEL_RADIANS);
        let start = 0;
        while (start < free.length) {
            let end = start;
            while (end + 1 < free.length && clustered(free[start], free[end + 1])) {
                end++;
            }
            const parallel = free.slice(start, end + 1);
            if (parallel.length > 1) {
                // Key 2: the middle handles, ordered across the cluster's own direction of travel, `d x via`
                // in this face's frame. See the rule's comment for why the cross product is the sign. A Z's
                // group spans every angle on its side of the face, so its direction is the right angle its
                // route actually turns through, not the mean of a spread that means nothing.
                const mean = byDirection
                    ? (parallel[0].angle < 0 ? -Math.PI / 2 : Math.PI / 2)
                    : parallel.reduce((sum, entry) => sum + entry.angle, 0) / parallel.length;
                const forward = Math.cos(mean);
                const across = Math.sin(mean);
                const key2 = (entry: StubLineEnd): number =>
                    forward * entry.via.across - across * entry.via.forward;
                parallel.sort((a, b) => key2(a) - key2(b));
            }
            ordered.push(...parallel);
            start = end + 1;
        }

        // The pair constraint, over the angle order (see `pairFits`). Only where the leads are the
        // author's to place: a Z's are fixed by the style's defaults and an Octilinear one is pulled
        // to 45 degrees, so for those two the direction-and-step order above is the answer and this
        // would only argue with it.
        //
        // It is applied by adjacent swaps from the angle order rather than by sorting, because the
        // constraint is a comparator that is undecided on most pairs, and a sort handed one of those
        // returns anything it likes. Swapping only where the constraint speaks leaves the angle order
        // standing everywhere else. Passes are capped, so an inconsistent set of preferences settles
        // rather than spinning.
        if (!byDirection) {
            const acrossOf = ordered.map((_entry, index) => free[index].at).sort((a, b) => a - b);
            for (let pass = 0; pass < ordered.length; pass++) {
                let swapped = false;
                for (let i = 0; i + 1 < ordered.length; i++) {
                    const upper = ordered[i];
                    const lower = ordered[i + 1];
                    const fits = pairFits(upper, acrossOf[i], lower, acrossOf[i + 1]);
                    const flipped = pairFits(lower, acrossOf[i], upper, acrossOf[i + 1]);
                    if (!fits && flipped) {
                        ordered[i] = lower;
                        ordered[i + 1] = upper;
                        swapped = true;
                    }
                }
                if (!swapped) {
                    break;
                }
            }
        }
        // The free ends take the free slots, in the rule's order; the pinned ones stay exactly where
        // the packing already put them.
        let next = 0;
        order.set(face, slots.map(slot => (slot.pinned ? slot.key : ordered[next++].key)));
    });
    return order;
}

/** Whether two packings put every end in exactly the same place. */
export function sameAnchors(a: Map<string, Anchor>, b: Map<string, Anchor>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    let same = true;
    a.forEach((anchor, key) => {
        const other = b.get(key);
        if (!other || other.point.x !== anchor.point.x || other.point.y !== anchor.point.y
            || other.halfExtent !== anchor.halfExtent) {
            same = false;
        }
    });
    return same;
}

/**
 * Where every corridor end actually attaches to its node. Exported because straighten.ts
 * needs the same answer before routing: a corridor is straight when its two anchors line up,
 * and an anchor sits wherever port packing put it, not at the node's centre.
 *
 * Keyed by `anchorKey(corridor.id, role)`. An end whose node is missing, or whose corridor
 * packs to nothing (zero value), simply has no entry.
 */
export function computeAnchors(
    layout: LayoutResult,
    /**
     * A face order decided elsewhere (`stubLineOrder`, fed back in by `routeDiagram`). Where a
     * face has one, it wins outright and the sweep below is skipped: the order has already been
     * decided against the routes the sweep could only guess at with a chord.
     */
    order?: PackingOrder
): Map<string, Anchor> {
    const { nodes, corridors, valueToPixels } = layout;

    const groups: PortGroup[] = [];
    const groupsByKey = new Map<string, PortGroup>();
    const addEnd = (nodeId: string, port: Port, end: PortEnd) => {
        const node = nodes.get(nodeId);
        if (!node) {
            return;
        }
        const key = `${nodeId}|${port}`;
        const group = groupsByKey.get(key);
        if (group) {
            group.ends.push(end);
        } else {
            const created: PortGroup = { node, port, ends: [end] };
            groupsByKey.set(key, created);
            groups.push(created);
        }
    };

    corridors.forEach(c => {
        addEnd(c.source, c.sourcePort, { corridor: c, role: "source" });
        addEnd(c.target, c.targetPort, { corridor: c, role: "target" });
    });

    /** This face's sort key: a handed-in order wins, otherwise the sweep's. */
    const keyFor = (
        group: PortGroup,
        reference: Map<string, Anchor> | undefined,
        reorderable: Set<string>
    ): ((end: PortEnd) => number) => {
        const forced = order?.get(faceKeyOf(group.node.id, group.port));
        if (!forced) {
            return sortKeyFor(group, nodes, reference, reorderable);
        }
        const at = new Map(forced.map((key, index) => [key, index]));
        // An end the order says nothing about keeps its place after the rest, which a stable sort then
        // leaves in the order it arrived.
        return (end: PortEnd): number => at.get(anchorKey(end.corridor.id, end.role)) ?? forced.length;
    };

    const packWith = (
        reference: Map<string, Anchor> | undefined,
        reorderable: Set<string>
    ): Map<string, Anchor> => {
        const anchors = new Map<string, Anchor>();
        groups.forEach(group => {
            packPort(group, keyFor(group, reference, reorderable), valueToPixels,
                layout.flowSeparation ?? 0)
                .forEach(({ end, slot }) => {
                    anchors.set(anchorKey(end.corridor.id, end.role), anchorFor(group.node, group.port, slot));
                });
        });
        return anchors;
    };

    // Crossing minimisation. The first pass orders each edge by the other endpoint's node centre,
    // because the real answer is circular: which slot a corridor should take here depends on which
    // slot it took over there, and vice versa. Barycentric iteration breaks that: re-order using
    // the anchors the previous pass actually produced, and repeat.
    //
    // Each round is accepted only if it genuinely crosses less, which is what makes this safe: a
    // barycentric sweep can oscillate between two orderings of equal quality, and without the
    // guard the result would depend on where the iteration happened to stop. Scoring it also means
    // the pass can never make a diagram worse than the plain heuristic it replaced.
    //
    // There is no special placement of wraps and self-loops here. The chord this sweep scores
    // travels nowhere near either route, so they are `stubLineOrder`'s business for every face: it
    // reads the drawn routes, so a loop's first corner orders it on the same terms as an L's
    // crossing run.
    //
    // A handed-in order has already decided every face it names, against those routes rather than
    // against a chord, so there is nothing for the sweep to improve there and running it would
    // only fight the answer.
    if (order && order.size > 0) {
        return packWith(undefined, new Set());
    }

    let best = packWith(undefined, new Set());
    const reorderable = chordLikeCorridors(best, corridors);
    let bestScore = chordCrossings(best, corridors, reorderable);
    for (let pass = 0; pass < ORDERING_PASSES && bestScore > 0; pass++) {
        const candidate = packWith(best, reorderable);
        const score = chordCrossings(candidate, corridors, reorderable);
        if (score >= bestScore) {
            break; // settled, or the sweep would make it worse
        }
        best = candidate;
        bestScore = score;
    }
    return best;
}

/**
 * Which corridors the ordering sweep is allowed to move.
 *
 * Only those whose real route actually follows the straight chord between their anchors,
 * because the chord is all the score can see. A wrap route exits its port heading away from
 * its destination and comes back round the far side (see `routeWraps`), so its band travels
 * nowhere near its chord; a self-loop's chord is a near-degenerate stub across one node.
 * Reordering either of those optimises a number that does not describe them, and can move a
 * corridor to the other end of its face, improving the chord score while visibly worsening the
 * diagram.
 *
 * So the rule is: do not reorder what you cannot measure. Anything excluded here keeps the
 * first pass's node-centre ordering.
 *
 * Wrap-ness is judged once, from the first pass's anchors, and then held fixed; otherwise it
 * would be circular in the same way the ordering itself is, and could flip between rounds.
 */
function chordLikeCorridors(anchors: Map<string, Anchor>, corridors: Corridor[]): Set<string> {
    const chordLike = new Set<string>();
    corridors.forEach(c => {
        if (c.isSelfLoop) {
            return;
        }
        const source = anchors.get(anchorKey(c.id, "source"));
        const target = anchors.get(anchorKey(c.id, "target"));
        if (source && target && !routeWraps(source, target)) {
            chordLike.add(c.id);
        }
    });
    return chordLike;
}

/**
 * How to order the ends packed onto one edge.
 *
 * Both forms sort by where the corridor's other end sits along this edge's own packing axis
 * (the standard barycentric key), so corridors sharing an edge leave it in the same order they
 * arrive elsewhere, which is what keeps them from crossing. The difference is only how good the
 * estimate is: with no reference anchors yet, the other node's centre is the best available
 * proxy; once a previous pass has produced anchors, the other end's actual position is the real
 * thing.
 *
 * A corridor outside `reorderable` always takes the proxy, whichever pass this is, which pins
 * it where the first pass put it; see `chordLikeCorridors` for why a wrap route or a self-loop
 * must not be moved by a chord-based score.
 */
function sortKeyFor(
    group: PortGroup,
    nodes: Map<string, PositionedNode>,
    reference: Map<string, Anchor> | undefined,
    reorderable: Set<string>
): (end: PortEnd) => number {
    const here = anchorFor(group.node, group.port, { centre: centreAlong(group), halfExtent: 0 }).point;
    return (end: PortEnd): number => {
        if (reference && reorderable.has(end.corridor.id)) {
            const other = reference.get(anchorKey(end.corridor.id, end.role === "source" ? "target" : "source"));
            if (other) {
                return departureAngle(group.port, here, other.point);
            }
        }
        const otherId = end.role === "source" ? end.corridor.target : end.corridor.source;
        const node = nodes.get(otherId);
        if (!node) {
            return 0;
        }
        return departureAngle(group.port, here, { x: node.x + node.width / 2, y: node.y + node.height / 2 });
    };
}

/** The middle of a node's face, along that face's own packing axis. */
function centreAlong(group: PortGroup): number {
    return portAxis(group.port) === "vertical"
        ? group.node.y + group.node.height / 2
        : group.node.x + group.node.width / 2;
}

/**
 * The angle a corridor leaves this face at: the key the whole ordering rests on. Zero is
 * straight out along the port's normal, negative leans toward the start of the face (up, or
 * left), positive toward its end.
 *
 * Angle is used rather than the other end's position. Position is only equivalent when the
 * corridors run roughly parallel; when two targets sit at very different distances it gives
 * the wrong answer. A corridor to a near, low node and one to a far, lower node can leave in
 * one order, arrive in the same order, and still cross in the middle, because the near one
 * dives steeply to get there while the far one descends gently. Sorting by the angle they fan
 * out at keeps them apart, and degenerates to position ordering when the distances are
 * similar.
 *
 * It is measured in the port's own frame: `forward` along its outward normal, `across` along
 * the axis the face packs, so one expression serves all four. A wrap (forward <= 0, the target
 * behind the face) never reaches here.
 */
function departureAngle(port: Port, from: Point, to: Point): number {
    const normal = PORT_NORMALS[port];
    const delta = sub(to, from);
    const forward = dot(delta, normal);
    const across = portAxis(port) === "vertical" ? delta.y : delta.x;
    return Math.atan2(across, forward);
}

/**
 * How many pairs of corridors cross, measured on the straight line between each one's two
 * anchors.
 *
 * It is a deliberate proxy for what the eye sees: the real bands curve. It is only honest for
 * corridors whose route follows their chord, so only those are counted: `scoreable` is
 * `chordLikeCorridors`' answer, and the same set the sweep is allowed to reorder. Scoring a
 * band whose path bears no relation to the line being measured would mislead the pass.
 *
 * It is O(corridors^2), which is fine at the scale this is designed for (tens of nodes, low
 * hundreds of flows).
 */
function chordCrossings(anchors: Map<string, Anchor>, corridors: Corridor[], scoreable: Set<string>): number {
    const chords: { a: Point; b: Point }[] = [];
    corridors.forEach(c => {
        if (!scoreable.has(c.id)) {
            return;
        }
        const source = anchors.get(anchorKey(c.id, "source"));
        const target = anchors.get(anchorKey(c.id, "target"));
        if (source && target) {
            chords.push({ a: source.point, b: target.point });
        }
    });

    let crossings = 0;
    for (let i = 0; i < chords.length; i++) {
        for (let j = i + 1; j < chords.length; j++) {
            if (segmentsCross(chords[i].a, chords[i].b, chords[j].a, chords[j].b)) {
                crossings++;
            }
        }
    }
    return crossings;
}

/**
 * Packs one edge's corridor ends into contiguous, non-overlapping slots, centred within the
 * node's extent along that edge. East/West edges pack along the node's height; North/South
 * along its width. The node was sized to hold whichever of its two stacks is the larger on
 * each axis, so an edge either fills its extent exactly or sits centred with room to spare.
 * Neither case needs anything scaled.
 */
function packPort(
    group: PortGroup,
    sortKey: (end: PortEnd) => number,
    valueToPixels: (value: number) => number,
    /**
     * The gap held between adjacent corridors on this face, in pixels
     * (`LayoutResult.flowSeparation`). Every corridor still gets exactly the width its value
     * converts to; the gaps go between them, and the node was sized to hold them: `stackOf` adds
     * the same `(n - 1)` of them, from the same number, so the face cannot come out
     * oversubscribed.
     */
    separation = 0
): { end: PortEnd; slot: Slot }[] {
    // A zero-value corridor renders as a zero-width band regardless, so packing it would only
    // reserve space (via `valueToPixels`' floor) that it never uses, squeezing its real siblings
    // for nothing.
    const packable = group.ends.filter(e => e.corridor.value > 0);
    if (packable.length === 0) {
        return [];
    }

    const vertical = portAxis(group.port) === "vertical";
    const extent = vertical ? group.node.height : group.node.width;
    const origin = vertical ? group.node.y : group.node.x;

    // Stable sort, so equal keys keep insertion order: layouts must be deterministic, and an
    // unstable tie-break would reshuffle a diagram between refreshes for no reason.
    const ordered = [...packable].sort((a, b) => sortKey(a) - sortKey(b));
    // Every corridor gets exactly the width its value converts to. Nothing is scaled to fit,
    // because nothing can fail to fit: `sizeNodes` measures a node against these same converted
    // widths, so the node's extent is at least this stack by construction. (Sizing the node from
    // the total value instead would disagree with the sum of the widths wherever
    // MIN_CORRIDOR_WIDTH lifts a corridor, squeezing a face's bands below what they carry and
    // leaving a band narrower at one end than the other.)
    //
    // A corridor's slot is its flow width plus the gaps held between its own stripes, so the
    // stripes keep exactly the widths their values earn and the corridor grows instead.
    // `stackOf` reserves the identical two counts from the identical helper, which is what stops a
    // face being oversubscribed.
    const widths = ordered.map(e =>
        valueToPixels(e.corridor.value) + separation * stripeGapCount(e.corridor));
    const gaps = separation * Math.max(0, widths.length - 1);
    const packedTotal = widths.reduce((sum, w) => sum + w, 0) + gaps;

    // The packed block is always centred on the edge, whatever is in it, including a self-loop.
    // The order decides where a loop sits relative to its neighbours, which is what avoids
    // crossings; it deliberately does not shove the whole block to one side, since a lone
    // corridor on an edge belongs in the middle of it regardless of type.
    let cursor = origin + (extent - packedTotal) / 2;
    return ordered.map((end, i) => {
        const width = widths[i];
        const slot: Slot = { centre: cursor + width / 2, halfExtent: width / 2 };
        // The gap goes after each corridor but the last, which keeps the block's outer edges flush
        // with the node it was sized against.
        cursor += width + (i < ordered.length - 1 ? separation : 0);
        return { end, slot };
    });
}

/** A packed slot's centre point on its node edge. */
function anchorFor(node: PositionedNode, port: Port, slot: Slot): Anchor {
    switch (port) {
        case "East":
            return { point: { x: node.x + node.width, y: slot.centre }, port, halfExtent: slot.halfExtent };
        case "West":
            return { point: { x: node.x, y: slot.centre }, port, halfExtent: slot.halfExtent };
        case "North":
            return { point: { x: slot.centre, y: node.y }, port, halfExtent: slot.halfExtent };
        case "South":
        default:
            return { point: { x: slot.centre, y: node.y + node.height }, port, halfExtent: slot.halfExtent };
    }
}
