/**
 * Route construction: the geometric core.
 *
 *   1. Port selection: each corridor end uses its resolved port (corridors.ts, defaulting to
 *      outgoing -> East and incoming -> West).
 *   2. Port packing: corridor ends sharing a (node, port) face are stacked into contiguous,
 *      non-overlapping slots sized by value (anchors.ts).
 *   3. Anchor generation: each slot's centre point on its face, plus the half-extent that
 *      becomes the band's half-width at that end.
 *   4. Route generation: a straight stub out of each port along that port's outward normal,
 *      joined by waypoints or tangent-matched arcs. Driving both the stub direction and the
 *      curve's end tangents off PORT_NORMALS lets a single construction serve all 16
 *      source/target port pairings rather than enumerating them.
 *   5. Corridor geometry: one shared "spine" per corridor; every segment's edges are a fixed
 *      perpendicular offset from that same spine, so a multi-flow-type band's segments stay
 *      parallel along the whole route.
 *   6. Flow geometry: segments subdivide the corridor's packed slot proportionally by value,
 *      filling from the same side of the ribbon at both ends, so a band never twists between
 *      its endpoints.
 *
 * Self-loops are not a special case. A self-loop is a corridor whose two anchors happen to sit
 * on the same node, so it flows through the same packing, spine and offset machinery as
 * everything else, including getting properly offset parallel bands per flow type.
 */

import { Corridor, LayoutResult, Point, Port, PORT_NORMALS, PositionedNode, RoutedBand } from "./model";
import { NO_ARROWS, stripeGapCount } from "./arrows";
import { portAxis } from "./flowAxis";
import {
    Anchor, Built, BuiltHandles, CornerHandle, DiagramRouting, PathSegment, RouteGeometry, RouteHandles,
    RouteOverridePoints, RoutingOptions
} from "./routeTypes";
import {
    CLEAN_CORNER_REACH, CLEARANCE_FRACTION, DEFAULT_ROUTING, FALLBACK_COLUMN_GAP, FALLBACK_ROW_PITCH,
    LANE_GAP_FRACTION, MIN_PERPENDICULAR_RUN, PROGRESS_EPSILON, STRIPE_BLEED
} from "./routeConstants";
import { anchorKey, computeAnchors, routeWraps, sameAnchors, stubLineOrder } from "./anchors";
import { buildNodeInfill } from "./infill";
import { DEFAULT_LEAD_FRACTION, OCTILINEAR_STEP, polylineFamily } from "./routingStyle";
import {
    archesBetween, archOf, directWaypoints, leadClearing, leadPastNode, sharpRoute, sLaneOf, smoothChain,
    wrapWaypoints
} from "./waypoints";
import { avoidObstacles, blockedBy, clearCrossover, detourHandle } from "./avoidance";
import {
    bandPathFromEdges, offsetFromSpine, offsetPolyline, openEdgesFromEdges, sharpBandPath, sharpOpenEdges
} from "./bands";
import { add, boundsOf, dot, midpoint, scale, sub, unit } from "./routeMath";
import { fitDiagonalLeads, leadSide, loopCornerHandle } from "./handles";
import { arcCubics, biarcJoinWithStraight, roundedPolyline, sampleSegments } from "./curves";

/** What the centreline, handles and run ends of one route are read from. */
interface SpineContext {
    sourceAnchor: Anchor;
    targetAnchor: Anchor;
    sourceNode: PositionedNode;
    targetNode: PositionedNode;
    geometry: RouteGeometry;
    /** Avoidance detours the route must pass through. */
    detours: Point[];
    /** How far this route's lane sits beyond the plain clearing lane. */
    laneOffset: number;
    exitNormal: Point;
    entryNormal: Point;
    /** The far end sits behind the near port's face, so the route doubles back. */
    wraps: boolean;
    /** A same-axis direct route joined by one diagonal (Polyline, Octilinear, Smooth). */
    diagonal: boolean;
    diagonalAxis: "x" | "y";
    arches: boolean;
    archMiddle: ReturnType<typeof archOf> | undefined;
    selfLoop: boolean;
    loopFloor: number;
    wrapLeadFloor: number;
    smoothWrapRadius: boolean;
    cornerRadius: number;
    quarterCorner: CornerHandle | undefined;
    stubOut: Point;
    stubIn: Point;
    crossover: number | undefined;
    crossoverAxis: "x" | "y";
    sameAxis: boolean;
    exitIsX: boolean;
}

/** Just the bands: what render.ts and every synthetic check want. */
export function routeCorridors(
    layout: LayoutResult,
    options: RoutingOptions = DEFAULT_ROUTING,
    overrides: Map<string, RouteOverridePoints> = new Map()
): RoutedBand[] {
    return routeDiagram(layout, options, overrides).bands;
}

/**
 * Bands plus each corridor's draggable handle positions.
 *
 * The handles come back from routing rather than being recomputed by the caller because
 * routing is the only thing that knows where they ended up: a lead is capped and floored, a
 * crossover may have been left where the clearing lane put it. Deriving them a second time
 * elsewhere would be a drift hazard.
 */
export function routeDiagram(
    layout: LayoutResult,
    options: RoutingOptions = DEFAULT_ROUTING,
    /** Hand-moved handle positions in pixels, keyed by corridor id. */
    overrides: Map<string, RouteOverridePoints> = new Map()
): DiagramRouting {
    const { nodes, corridors, columnGap, rowPitch } = layout;
    const gap = columnGap || FALLBACK_COLUMN_GAP;
    const pitch = rowPitch || FALLBACK_ROW_PITCH;

    // Reassigned by the stub-line pass below; `routeOne` and `staggerLanes` read it at call time,
    // so re-routing after a repack uses the new anchors.
    let anchors = computeAnchors(layout);

    const allNodes = Array.from(nodes.values());

    /** One corridor's geometry, or undefined where either end is missing. */
    const routeOne = (corridor: Corridor, laneOffset: number) => {
        const source = nodes.get(corridor.source);
        const target = nodes.get(corridor.target);
        const sourceAnchor = anchors.get(anchorKey(corridor.id, "source"));
        const targetAnchor = anchors.get(anchorKey(corridor.id, "target"));
        if (!source || !target || !sourceAnchor || !targetAnchor) {
            return undefined;
        }

        // A corridor's own two nodes are never obstacles: it starts and ends on their edges, so it
        // necessarily touches them.
        const obstacles = allNodes.filter(n => n.id !== corridor.source && n.id !== corridor.target);
        return routeCorridor(
            corridor, sourceAnchor, targetAnchor, source, target, obstacles,
            overrides.get(corridor.id) ?? {}, laneOffset, gap, pitch, options,
            layout.flowSeparation ?? 0);
    };

    type Routed = { bands: RoutedBand[]; handles: RouteHandles; spine: Point[]; drawn: Point[]; ghost?: Point[]; runEnds?: { source: Point; target: Point }; silhouette?: string };
    /**
     * Every corridor's geometry, keyed by corridor. `previous` lets the lane pass keep what it
     * already drew for the corridors it is not moving: a corridor's route is a function of its
     * own anchors, its own overrides and its own lane offset alone (`routeOne` above takes nothing
     * else), so re-routing one that was not staggered can only reproduce what is already in hand.
     * On typical diagrams the lane pass moves only a handful of the corridors.
     */
    const routeAll = (laneOffsets: Map<string, number>, previous?: Map<string, Routed>) => {
        const byCorridor = new Map<string, Routed>();
        corridors.forEach(corridor => {
            const kept = previous && !laneOffsets.has(corridor.id)
                ? previous.get(corridor.id)
                : undefined;
            const routed = kept ?? routeOne(corridor, laneOffsets.get(corridor.id) ?? 0);
            if (routed) {
                byCorridor.set(corridor.id, routed);
            }
        });
        return byCorridor;
    };

    /** Flattened in corridor order, which is the order the bands are painted in. */
    const assemble = (byCorridor: Map<string, Routed>) => {
        const bands: RoutedBand[] = [];
        const handles = new Map<string, RouteHandles>();
        const spines = new Map<string, Point[]>();
        const centrelines = new Map<string, Point[]>();
        const ghosts = new Map<string, Point[]>();
        const runEnds = new Map<string, { source: Point; target: Point }>();
        const silhouettes = new Map<string, string>();
        corridors.forEach(corridor => {
            const routed = byCorridor.get(corridor.id);
            if (routed) {
                bands.push(...routed.bands);
                handles.set(corridor.id, routed.handles);
                spines.set(corridor.id, routed.spine);
                centrelines.set(corridor.id, routed.drawn);
                if (routed.ghost) {
                    ghosts.set(corridor.id, routed.ghost);
                }
                if (routed.runEnds) {
                    runEnds.set(corridor.id, routed.runEnds);
                }
                if (routed.silhouette) {
                    silhouettes.set(corridor.id, routed.silhouette);
                }
            }
        });
        return { bands, handles, spines, centrelines, ghosts, runEnds, silhouettes };
    };

    // Route once, see which wrap routes ended up sharing a lane, then route the ones that share
    // again with them fanned out. Measuring the first pass's actual lanes rather than recomputing
    // them means the stagger cannot drift away from the geometry it is staggering, and when
    // nothing shares a lane, which is the common case, the second pass never happens at all.
    let laneOffsets = new Map<string, number>();
    const drawAll = () => {
        const first = routeAll(new Map());
        const firstDrawn = assemble(first);
        laneOffsets = staggerLanes(firstDrawn.handles, anchors, corridors, nodes, pitch);
        return laneOffsets.size > 0 ? assemble(routeAll(laneOffsets, first)) : firstDrawn;
    };
    let routed = drawAll();

    // The stub-line packing pass (see `stubLineOrder`), on every face. The crossing sweep cannot
    // score a loop, because the chord it measures is not where the route goes, so this rule has to
    // answer for all of them. It can: it reads the drawn routes, and a loop's first corner is its
    // crossing run on the same terms as an L's.
    //
    // It runs once, not to a fixed point. The keys are read off the routes and the routes come
    // from the packing the keys decide, so iterating can cycle, making the answer depend on where
    // the iteration stopped.
    {
        const order = stubLineOrder(layout, routed.spines, anchors, routed.handles,
            routed.runEnds, options.style);
        if (order.size > 0) {
            const repacked = computeAnchors(layout, order);
            if (!sameAnchors(anchors, repacked)) {
                anchors = repacked;
                routed = drawAll();
            }
        }
    }

    const reroute = (corridorId: string, override: RouteOverridePoints) => {
        const corridor = corridors.find(c => c.id === corridorId);
        if (!corridor) {
            return undefined;
        }
        const source = nodes.get(corridor.source);
        const target = nodes.get(corridor.target);
        const sourceAnchor = anchors.get(anchorKey(corridor.id, "source"));
        const targetAnchor = anchors.get(anchorKey(corridor.id, "target"));
        if (!source || !target || !sourceAnchor || !targetAnchor) {
            return undefined;
        }
        const obstacles = allNodes.filter(n => n.id !== corridor.source && n.id !== corridor.target);
        return routeCorridor(
            corridor, sourceAnchor, targetAnchor, source, target, obstacles,
            override, laneOffsets.get(corridor.id) ?? 0, gap, pitch, options,
            layout.flowSeparation ?? 0);
    };

    // Built from the same anchors the bands were, so a node's arrow stripes line up with the bands
    // arriving at that face by construction.
    return { ...routed, infill: buildNodeInfill(layout, anchors, options.arrows ?? NO_ARROWS), reroute };
}

/**
 * Fan out wrap routes that would otherwise run along the same lane.
 *
 * A same-axis wrap detours to a lane clear of its two nodes. Two corridors converging on one
 * node from the same side compute that lane from nearly the same geometry and get nearly the
 * same answer, so their bands travel along it stacked exactly on top of each other.
 *
 * This is done as a sweep, not a bucket. Grouping lanes by their rounded coordinate fixes
 * nothing, because two lanes computed from nearly identical geometry come out at, say, 684.0
 * and 678.9: different keys, yet bands 60px wide sitting on top of each other. What matters is
 * whether two lanes are closer than the width they need, not whether they are equal. So the
 * lanes on each side of a node are walked from the inside out, and each is pushed only as far
 * as it takes to clear the one before it: corridors already far enough apart are left exactly
 * where they were.
 *
 * A hand-moved crossover is not staggered: it already has an explicit lane, and moving it
 * would be arguing with the person who placed it.
 */
function staggerLanes(
    handles: Map<string, RouteHandles>,
    anchors: Map<string, Anchor>,
    corridors: Corridor[],
    nodes: Map<string, PositionedNode>,
    pitch: number
): Map<string, number> {
    interface LaneMember {
        id: string;
        /** The lane's position measured so that larger always means further out. */
        depth: number;
        along: number;
        halfWidth: number;
        outward: number;
    }
    const groups = new Map<string, LaneMember[]>();

    corridors.forEach(corridor => {
        if (corridor.isSelfLoop) {
            return;
        }
        // Only a same-axis wrap travels along a lane; a perpendicular one is a single corner and a
        // direct route has no lane at all.
        if (portAxis(corridor.sourcePort) !== portAxis(corridor.targetPort)) {
            return;
        }
        const source = anchors.get(anchorKey(corridor.id, "source"));
        const target = anchors.get(anchorKey(corridor.id, "target"));
        const handle = handles.get(corridor.id)?.middle;
        const sourceNode = nodes.get(corridor.source);
        if (!source || !target || !handle || !sourceNode || !routeWraps(source, target)) {
            return;
        }

        const axis = handle.axis;
        const lane = handle.point[axis];
        // Which way is "further out": away from the node the lane skirts.
        const centre = axis === "y" ? sourceNode.y + sourceNode.height / 2 : sourceNode.x + sourceNode.width / 2;
        const outward = lane >= centre ? 1 : -1;
        // Grouped only by which side of the node the lane is on. How close two lanes are is the
        // sweep's business, not the key's.
        const key = `${axis}|${outward}`;

        const member: LaneMember = {
            id: corridor.id,
            depth: outward * lane,
            along: (source.point[axis] + target.point[axis]) / 2,
            halfWidth: Math.max(source.halfExtent, target.halfExtent),
            outward
        };
        const existing = groups.get(key);
        if (existing) {
            existing.push(member);
        } else {
            groups.set(key, [member]);
        }
    });

    const offsets = new Map<string, number>();
    const gap = LANE_GAP_FRACTION * pitch;
    groups.forEach(members => {
        if (members.length < 2) {
            return; // nothing to fan out
        }
        // Innermost first, so each is only ever pushed outward past the ones already placed. Ties
        // break on position then id: the sweep has to give the same answer twice.
        members.sort((a, b) => (a.depth - b.depth) || (a.along - b.along) || (a.id < b.id ? -1 : 1));

        let frontier = -Infinity;
        members.forEach(member => {
            const wanted = Math.max(member.depth, frontier + member.halfWidth + gap);
            if (wanted > member.depth) {
                offsets.set(member.id, member.outward * (wanted - member.depth));
            }
            frontier = wanted + member.halfWidth;
        });
    });
    return offsets;
}

/**
 * Builds the corridor's shared spine once, then lays each flow-type segment across it as a
 * fixed perpendicular offset.
 *
 * In normal space the slot always spans [-halfExtent, +halfExtent], and segments fill it in the
 * same order from the same side at both ends, so a band can never twist internally regardless
 * of which ports it uses. Its screen-space stacking may flip if the route doubles back on
 * itself, which is what a ribbon does when it reverses direction.
 */
function routeCorridor(
    corridor: Corridor,
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    sourceNode: PositionedNode,
    targetNode: PositionedNode,
    /** Every node this corridor should route around: everything but its own two ends. */
    obstacles: PositionedNode[],
    /** Hand-moved handle positions for this corridor, in pixels. */
    userOverrides: RouteOverridePoints,
    /** How far this corridor's lane sits beyond the plain clearing lane. */
    laneOffset: number,
    columnGap: number,
    rowPitch: number,
    options: RoutingOptions,
    /** The gap held between this corridor's own stripes, in pixels. */
    separation = 0
): { bands: RoutedBand[]; handles: RouteHandles; spine: Point[]; drawn: Point[]; ghost?: Point[];
    runEnds?: { source: Point; target: Point }; silhouette?: string } {
    /**
     * Orthogonal ignores hand-moved leads, because it does not offer their handles
     * (`draggableHandles`). Honouring them anyway would leave a route with invisible controls the
     * author could neither see nor reset: a lead dragged in another style would go on holding the
     * stub out. Its step is the one thing this style lets you place, so it is the one override it
     * reads.
     *
     * They are dropped here rather than inside `buildSpine`, which must keep honouring the leads it
     * is handed: avoidance reshapes a blocked route by varying them (`reshapeLeads`), and that has
     * nothing to do with what the author moved. The values stay in the blob either way, so
     * switching back to Smooth or Polyline finds them again.
     */
    // Polyline's 90-degree corner hides its leads too. Its corner sits where the two port
    // directions cross, which the nodes fix, and each lead's end lies partway along a straight
    // run, so the two lead handles would do nothing at all. Same rule as Orthogonal: a hidden
    // handle's stale override is ignored rather than left shaping the route with no way to see or
    // reset it.
    const corridorWraps = routeWraps(sourceAnchor, targetAnchor);
    const perpendicularDirect = portAxis(sourceAnchor.port) !== portAxis(targetAnchor.port)
        && !corridorWraps;
    /**
     * Orthogonal's strip is for direct routes only.
     *
     * The decision above is about the Z: its leads come from the style's defaults by
     * construction, so the step is the one thing this style lets an author place and a stored lead
     * could only shape it unseen. Applied to the whole style, it would reach wraps too, and a wrap
     * in Orthogonal is built exactly as it is in every other style, so its leads place real runs
     * there. Stripping them would leave a same-axis wrap with fewer handles than the other styles
     * show, and the perpendicular ones with none at all.
     *
     * Nothing about the style is relaxed by this. A wrap's leads only ever place axis-aligned
     * runs, which is what being squared off means in all four styles, so no drag of one can
     * produce a diagonal.
     */
    // A self-loop is exempt: its handles are the same in every style.
    const leadsHidden = corridor.source !== corridor.target
        && ((options.style === "Orthogonal" && !corridorWraps)
            || (polylineFamily(options.style) && perpendicularDirect));
    // The detour lane survives the strip, because it is shown in every style
    // (`draggableHandles`). The rule here is that a hidden handle's override is ignored, not that a
    // stripped style keeps only its middle. Dropping the lane would leave Orthogonal and Polyline's
    // 90-degree corner drawing a handle whose stored value nothing reads.
    const overrides: RouteOverridePoints = leadsHidden
        ? {
            ...(userOverrides.middle !== undefined ? { middle: userOverrides.middle } : {}),
            ...(userOverrides.detour !== undefined ? { detour: userOverrides.detour } : {})
        }
        : userOverrides;

    // A band as wide as the node it wraps needs its clearance and its corner radius sized against
    // that width, not just the grid: a rounded corner tighter than the band's own half-width
    // inverts the inner edge (the ribbon folds through itself), and a lane closer than that leaves
    // the outer edge lying across the node bar. The radius floor is a correctness bound on the
    // rounded path, not a style choice, which is why sharp corners need the mitred construction
    // instead, and why Curvature 0 drops the floor rather than fighting it.
    const bandReach = Math.max(sourceAnchor.halfExtent, targetAnchor.halfExtent);
    const pitch = Math.min(columnGap, rowPitch);
    const leadFraction = options.portLeadInPercent !== undefined
        ? Math.max(0, options.portLeadInPercent) / 100
        : DEFAULT_LEAD_FRACTION[options.style];
    const curvatureFraction = Math.max(0, options.curvaturePercent) / 100;
    // Which of this band's two ends an arrow will grow out of, and so which the outline leaves
    // open (`openEdgesFromEdges`). Read from the same `options.arrows` `buildNodeInfill` is handed,
    // so the two cannot disagree about whether anything continues a face.
    const arrowHeads = options.arrows?.heads === true;
    const arrowTails = options.arrows?.tails === true;
    // A direct corridor between adjacent cells has one grid space to fit both lead-ins and the
    // bend between them, so each end can claim at most half of it less the room the curve needs.
    // This is sized from the curvature setting rather than the corner radius below: the radius is
    // floored at the band's half-width to stop corners inverting the inner edge, but a direct
    // route has no corners, so a fat band would lose its lead-in for a reason that does not apply
    // to it.
    //
    // Smooth needs none of it: a Smooth join sizes its own arcs to whatever room is left, so
    // reserving room in advance would only shorten the leads for nothing (on a direct 90-degree
    // pairing it would take both leads to zero at Curvature 100 and pin each handle against its
    // node face).
    const curveRoom = options.style === "Smooth" ? 0 : curvatureFraction * pitch;
    const geometry: RouteGeometry = {
        leadX: leadFraction * columnGap,
        leadY: leadFraction * rowPitch,
        maxLeadX: Math.max(0, 0.5 * columnGap - curveRoom),
        maxLeadY: Math.max(0, 0.5 * rowPitch - curveRoom),
        clearance: CLEARANCE_FRACTION * pitch + 2 * bandReach,
        radius: curvatureFraction <= 0 ? 0 : Math.max(curvatureFraction * pitch, bandReach),
        curvature: curvatureFraction,
        bandReach,
        pitch,
        style: options.style
    };
    /**
     * The S lane. Where this wrap has a clear gap between its two nodes, the lane sits in it by
     * default; see `sLaneOf`. Set once below, before anything is built from it, and only where the
     * author has not placed a lane.
     */
    let autoLane: Point | undefined;
    const build = (detours: Point[], vary: RouteOverridePoints = {}) =>
        buildSpine(sourceAnchor, targetAnchor, sourceNode, targetNode, geometry,
            detours,
            { ...overrides, ...(autoLane && overrides.middle === undefined ? { middle: autoLane } : {}), ...vary },
            laneOffset);
    if (overrides.middle === undefined) {
        const candidate = sLaneOf(sourceAnchor, targetAnchor, sourceNode, targetNode, geometry.bandReach, laneOffset);
        if (candidate) {
            const trial = build([], { middle: candidate });
            if (blockedBy(trial.route, obstacles, geometry.bandReach).length === 0) {
                autoLane = candidate;
            }
        }
    }
    // Avoidance replaces a route's middle outright, so it would silently overwrite a hand-moved
    // crossover. Where one has been set, avoidance stands down and the crossover is instead slid
    // clear of anything it lands in (the same bargain the lead handles make: the drop is stored as
    // given and corrected where the geometry insists). A dragged lead composes fine with
    // avoidance, since the detours sit between the two stubs, so it does not switch anything off.
    //
    // A Polyline diagonal has no stored crossover to protect (its bend is held in the two leads;
    // see `buildSpine`), so a `middle` value left in the blob by another style must not stand
    // avoidance down here. Otherwise switching a corridor to Polyline after moving its crossover
    // in Orthogonal would silently cost it node avoidance, and the slide it stood down for would
    // do nothing, the construction never reading it.
    const usesCrossover = overrides.middle !== undefined
        && !(polylineFamily(options.style) && !routeWraps(sourceAnchor, targetAnchor)
            && portAxis(sourceAnchor.port) === portAxis(targetAnchor.port));
    const built = usesCrossover && overrides.middle
        ? clearCrossover(build, overrides.middle, obstacles, geometry, pitch,
            options.avoidNodes !== false)
        : avoidObstacles(build, sourceAnchor, targetAnchor, overrides, obstacles,
            geometry, pitch, options.avoidNodes !== false);
    const route = built.route;
    const totalValue = corridor.value || 1;

    /**
     * The edge builder, kept out of the stripe loop so the silhouette can be built from the
     * identical function the stripes were. Re-deriving it would be the drift hazard `spine` and
     * `handles` are returned from here to avoid: a channel that does not lie on the band it
     * belongs to is worse than no channel.
     */
    let edgeAt: ((sourceOffset: number, targetOffset: number) => Point[]) | undefined;

    let sourceCursor = -sourceAnchor.halfExtent;
    let targetCursor = -targetAnchor.halfExtent;
    // The gaps come out of the slot, never out of a stripe. `packPort` widened this corridor's
    // slot by exactly these, so taking them back off here leaves each stripe the width its value
    // earns and puts the gaps between them. At separation 0 this is plain arithmetic on the slot.
    const innerGaps = separation * stripeGapCount(corridor);
    const sourceFlow = sourceAnchor.halfExtent * 2 - innerGaps;
    const targetFlow = targetAnchor.halfExtent * 2 - innerGaps;
    let drawn = 0;

    const bands = corridor.segments.map((seg, segIndex) => {
        const fraction = seg.value / totalValue;
        // Before each drawn stripe but the first, so the corridor's own outer edges stay its own: the
        // same "between, never outside" rule the face packing follows. A zero-value stripe is not drawn
        // and so opens no gap.
        if (seg.value > 0 && drawn > 0) {
            sourceCursor += separation;
            targetCursor += separation;
        }
        if (seg.value > 0) {
            drawn++;
        }
        const sourceSpan = sourceFlow * fraction;
        const targetSpan = targetFlow * fraction;

        // High edge only, and not on the last stripe: the next stripe is painted over this one, so the
        // boundary the eye sees is its low edge, which stays true. Widths and the stack's extent are
        // exact.
        //
        // A gap removes the seam, so it removes the bleed. STRIPE_BLEED is a deliberate sub-pixel
        // overlap to close the anti-aliasing join between two touching stripes; with a gap between
        // them there is no join, and bleeding into the gap would draw every stripe wider than its
        // value, breaking the one property the gap feature exists to hold.
        const bleed = separation > 0 || segIndex === corridor.segments.length - 1
            ? 0 : STRIPE_BLEED;
        const sourceLow = sourceCursor;
        const sourceHigh = sourceCursor + sourceSpan + bleed;
        const targetLow = targetCursor;
        const targetHigh = targetCursor + targetSpan + bleed;
        sourceCursor += sourceSpan;
        targetCursor += targetSpan;

        const edgeFor = (sourceOffset: number, targetOffset: number): Point[] =>
            route.kind === "sampled"
                ? offsetFromSpine(route.samples, sourceOffset, targetOffset)
                : offsetPolyline(route.vertices, route.weights.map(w => sourceOffset * (1 - w) + targetOffset * w));
        edgeAt = edgeFor;
        const lowEdge = edgeFor(sourceLow, targetLow);
        const highEdge = edgeFor(sourceHigh, targetHigh);
        const closeBand = (low: Point[], high: Point[]): string =>
            route.kind === "sharp" ? sharpBandPath(low, high) : bandPathFromEdges(low, high);
        const path = closeBand(lowEdge, highEdge);
        // The same dispatch as `closeBand`, deliberately. An outline built only the spline way would
        // be the wrong shape on every sharp route, and there is exactly one place that knows which
        // kind this is.
        //
        // An end no arrow continues is capped. A source end is drawn as a tail and a target end as a
        // head (`buildNodeInfill`), so each toggle answers its own end, and with both off the outline
        // is the closed band path.
        const edges = route.kind === "sharp"
            ? sharpOpenEdges(lowEdge, highEdge, !arrowTails, !arrowHeads)
            : openEdgesFromEdges(lowEdge, highEdge, !arrowTails, !arrowHeads);

        /**
         * The stripe at a fraction of its width, from the low edge, for an inbound partial highlight.
         *
         * The span includes the bleed, so `partialPath(1)` is `path`, which is provably the same
         * geometry rather than a near-miss. The fraction is clamped, because it comes from the host as
         * `highlights[i] / values[i]` and a float off the model is not guaranteed to land inside
         * [0, 1].
         *
         * The `f >= 1` early return is load-bearing, not an optimisation.
         * `sourceLow + 1 * (sourceSpan + bleed)` is not bitwise `sourceCursor + sourceSpan + bleed`, so
         * computing it the long way differs in the last bit and prints a different path string on
         * Polyline, Octilinear and Orthogonal.
         */
        const partialPath = (fraction: number): string => {
            const f = Math.max(0, Math.min(1, fraction));
            if (f >= 1) {
                return path;
            }
            return closeBand(lowEdge, edgeFor(
                sourceLow + f * (sourceSpan + bleed),
                targetLow + f * (targetSpan + bleed)));
        };

        return {
            corridorId: corridor.id,
            source: corridor.source,
            target: corridor.target,
            flowType: seg.flowType,
            value: seg.value,
            path,
            edges,
            partialPath,
            isSelfLoop: corridor.isSelfLoop,
            bounds: boundsOf(lowEdge.concat(highEdge)),
            start: { ...sourceAnchor.point },
            end: { ...targetAnchor.point },
            // The two spans are equal by construction (both are the same fraction of a slot sized from
            // the corridor's value, and the node was sized to hold that slot), so either states the
            // stripe's thickness. The bleed is left out: it is overlap to close a seam, not width the flow
            // has earned.
            width: sourceSpan
        };
    });

    /**
     * The corridor's outline, as one closed path: its first stripe's low edge and its last
     * stripe's high edge, which are the only two edges that are not painted over by a neighbour.
     * Neither carries `STRIPE_BLEED` (the low edge never does, the last high edge never does), so
     * the outline is exactly what the eye sees.
     *
     * It covers the whole slot, gaps included: with Flow separation on, the gaps inside a band are
     * see-through, and a crossing channel drawn per stripe would let the band underneath show
     * through them. A flow passing over another occludes as one flow.
     */
    const silhouette = edgeAt
        ? (route.kind === "sharp"
            ? sharpBandPath(edgeAt(-sourceAnchor.halfExtent, -targetAnchor.halfExtent),
                edgeAt(sourceAnchor.halfExtent, targetAnchor.halfExtent))
            : bandPathFromEdges(edgeAt(-sourceAnchor.halfExtent, -targetAnchor.halfExtent),
                edgeAt(sourceAnchor.halfExtent, targetAnchor.halfExtent)))
        : undefined;

    // What was drawn: the sampled centreline, or the vertices of a sharp route.
    const centre: Point[] = route.kind === "sampled"
        ? route.samples.map(sample => ({ x: sample.x, y: sample.y }))
        : route.vertices;
    return { bands, handles: built.handles, spine: built.spine, drawn: centre, ghost: built.ghost,
        runEnds: built.runEnds, silhouette };
}

/**
 * A route is an explicit centreline polyline:
 *
 *     anchor -> lead-in waypoint -> [waypoints] -> lead-in waypoint -> anchor
 *
 * The lead-in waypoints are the port stubs, treated as ordinary waypoints with one axis
 * pinned: they sit on their port's outward normal ray, so their coordinate across the port
 * face is fixed at the anchor's, and only their distance out from the face is free. That
 * pinning is what makes every subsequent run axis-aligned (and therefore every turn a genuine
 * quarter turn): with the stub distance and the waypoint distance chosen independently, the
 * run between them is diagonal and the corners come out lopsided. It also gives the useful
 * design control of a longer straight run out of the port before the bend starts.
 *
 * Two ways the polyline gets turned into geometry:
 *
 *  - Direct routes (the common case) keep one smooth tangent-matched join between the two
 *    stubs. Control points sit along the port normals, so when the anchors line up the whole
 *    control polygon is collinear and the corridor renders as a genuinely straight line.
 *
 *  - Wrap routes, where one end sits behind the other's port face so a direct curve would cut
 *    through a node, use axis-aligned runs joined by quarter turns of one uniform radius.
 *    Same-axis ports route via a lane clear of both nodes; perpendicular ports need only a
 *    single corner.
 *
 * The Orthogonal style reuses this: it is the quarter-turn path applied to direct routes too.
 */
function buildSpine(
    sourceAnchor: Anchor,
    targetAnchor: Anchor,
    sourceNode: PositionedNode,
    targetNode: PositionedNode,
    geometry: RouteGeometry,
    /** Extra waypoints the route must pass through, from avoidance. */
    detours: Point[] = [],
    /** Hand-moved handle positions, in pixels. */
    overrides: RouteOverridePoints = {},
    /** How far this route's lane sits beyond the plain clearing lane. */
    laneOffset = 0
): Built {
    const exitNormal = PORT_NORMALS[sourceAnchor.port];
    const entryNormal = PORT_NORMALS[targetAnchor.port];
    const arrivalTangent = scale(entryNormal, -1);

    const sourceAlongX = portAxis(sourceAnchor.port) === "vertical";
    const targetAlongX = portAxis(targetAnchor.port) === "vertical";
    // Read before the leads, because an arch ignores hand-moved ones.
    const wraps0 = routeWraps(sourceAnchor, targetAnchor);
    const leads = resolveLeads({
        entryNormal,
        exitNormal,
        geometry,
        overrides,
        sourceAlongX,
        sourceAnchor,
        sourceNode,
        targetAlongX,
        targetAnchor,
        targetNode,
        wraps0
    });
    const { arches, wraps, diagonal, diagonalAxis, wrapLeadFloor, selfLoop, loopFloor, smoothWrapRadius } = leads;
    let { leadOut, leadIn, cornerRadius, quarterCorner } = leads;

    const stubOut = add(sourceAnchor.point, scale(exitNormal, leadOut));
    const stubIn = add(targetAnchor.point, scale(entryNormal, leadIn));

    /**
     * Smooth is Polyline with the join between the two straights replaced.
     *
     * Polyline runs straight out of each port and joins those two runs with a diagonal; Smooth
     * joins them with two circular arcs instead, tangent to each straight and to each other. That
     * is the whole difference, and it is why there is no fallback here and nothing that
     * "switches": where the two stubs have met there is simply no run left to bend, so the join is
     * the straight one Polyline would have drawn, built by Polyline's own construction rather than
     * by dropping a straight segment into this one. That distinction matters: a zero-length join
     * sampled through the smooth path pinches the ribbon, where Polyline's build holds it.
     *
     * It applies to any direct route, same-axis or perpendicular. The construction never cared
     * whether the two tangents were parallel; parallel is just the branch where the quadratic
     * degenerates, so a 90-degree pairing is the general case and gets arcs where Polyline draws
     * an L.
     *
     * Wraps, self-loops included, keep the chain. A wrap exists because the far end sits behind
     * the near port's face, and its waypoints are what carry it round the outside; a biarc knows
     * nothing about that. A 180-degree self-loop (East->West on one node) has no positive tangent
     * length at all, both tangents pointing away from the destination, so there is nothing to
     * draw; a 90-degree one does solve, but its arcs then sweep back through the node.
     */
    // A 90-degree corner is one arc at every Curvature. Its two stubs sit the same distance from
    // the corner, so a single circle is tangent to both. Handed to `biarcJoinWithStraight` it
    // would come out as a quarter circle only at Curvature 100; below that the slider would shrink
    // the arcs and put a straight between them, and the corner handle, which assumes one arc,
    // would sit off the band's centre. Here Curvature is already spent on the radius itself, so the
    // join is just that arc.
    const biarcJoin = geometry.style === "Smooth" && !wraps
        ? (quarterCorner
            ? arcCubics(stubOut, exitNormal, stubIn)?.segments
            : biarcJoinWithStraight(stubOut, exitNormal, stubIn, arrivalTangent,
                geometry.curvature, geometry.bandReach))
        : undefined;

    // Which routes get squared off. Every wrap route is: a curve through the clearing lane cuts
    // through the node the lane exists to miss. So is every Orthogonal and Polyline route, and a
    // Smooth one wherever there are no arcs to put in the join: with the stubs met there is no run
    // to bend, and it is Polyline.
    const squaredOff = geometry.style === "Orthogonal" || polylineFamily(geometry.style) || wraps
        || (geometry.style === "Smooth" && biarcJoin === undefined);

    /**
     * The centreline for this route, with any avoidance detours folded in.
     *
     * A wrap route keeps its own middle waypoints, which exist to get around the corridor's own two
     * nodes, and a detour does not replace that job, so the detours are spliced in just before the
     * arrival lead-in. A direct route's middle is only there to square off an unobstructed run, so
     * the detours stand in for it entirely.
     */
    const sameAxis = portAxis(sourceAnchor.port) === portAxis(targetAnchor.port);
    /**
     * Where the route steps across, and along which axis that step may be moved. Only a same-axis
     * route has one: a perpendicular pairing is an L whose corner is simply where the two stubs
     * meet, so it moves when a lead does and needs no handle of its own.
     *
     * For a direct Z the free coordinate runs along the route (how far out the step happens); for
     * a wrap it is the lane, across it. Same handle, opposite axis, which is why the stored
     * override is a full point that gets projected rather than a bare number.
     */
    const crossoverAxis: "x" | "y" = exitNormal.x !== 0
        ? (wraps ? "y" : "x")
        : (wraps ? "x" : "y");
    const crossover = sameAxis
        ? (overrides.middle
            ? overrides.middle[crossoverAxis]
            : undefined)
        : undefined;

    /**
     * A question mark's elbow: the corner between its outbound run and its middle line. It is
     * where the two stubs' rays cross, the grip sits on it, and it slides along the source port's
     * normal, which is that port's lead-in.
     *
     * The middle line stays at 90 degrees, as in Orthogonal in all cases, so Octilinear has no
     * angled run left to fit here.
     *
     * Not a self-loop: a 90-degree loop is a perpendicular wrap too, but loops are designed once
     * and drawn identically in all four styles.
     */
    const exitIsX = exitNormal.x !== 0;

    /**
     * Two ends on the same port go round as an arch; see `archOf` and `archFits` for the shape
     * and when it applies.
     *
     * Its lane is `middle`, read on the normal's axis rather than across it. It is a coordinate on
     * the route either way, so the handle lands near the shape it replaces rather than jumping off
     * the diagram.
     */
    const archMiddle = arches
        ? archOf(stubOut, stubIn, exitNormal,
            overrides.middle ? (exitIsX ? overrides.middle.x : overrides.middle.y) : undefined,
            laneOffset)
        : undefined;

    const ctx: SpineContext = {
        sourceAnchor, targetAnchor, sourceNode, targetNode, geometry, detours, laneOffset,
        exitNormal, entryNormal, wraps, diagonal, diagonalAxis, arches, archMiddle, selfLoop,
        loopFloor, wrapLeadFloor, smoothWrapRadius, cornerRadius, quarterCorner, stubOut, stubIn,
        crossover, crossoverAxis, sameAxis, exitIsX
    };

    if (squaredOff) {
        const centreline = spineCentreline(ctx);
        // Curvature 0 means genuinely sharp: keep the polyline and mitre its corners, rather than
        // rounding them off with an arc. The radius is the one in force, not the slider's: a corner
        // handle can round a loop the Curvature slider left sharp.
        const route = cornerRadius <= 0
            ? sharpRoute(centreline)
            : {
                kind: "sampled" as const,
                samples: sampleSegments(
                    // A self-loop is judged as one small shape, so its corners share a radius; everything else is
                    // read corner by corner.
                    roundedPolyline(centreline, cornerRadius, sourceNode.id === targetNode.id),
                    exitNormal, arrivalTangent)
            };
        return {
            route,
            handles: spineHandles(ctx, centreline),
            squared: true,
            spine: centreline,
            // A sharp corner has no arc, so its run ends at the corner itself.
            runEnds: spineRunEnds(ctx, route.kind === "sampled"
                ? route.samples.map(sample => ({ x: sample.x, y: sample.y }))
                : centreline)
        };
    }

    // A direct route with nothing in its way keeps its single tangent-matched join, the
    // construction that makes an aligned corridor render as a genuinely straight line. Only once
    // there is something to route around does it need the waypoint chain.
    const chained = wraps || detours.length > 0;
    const centreline = chained ? spineCentreline(ctx) : undefined;
    const segments: PathSegment[] = centreline
        ? smoothChain(centreline, exitNormal, arrivalTangent)
        : [
            { kind: "line", a: sourceAnchor.point, b: stubOut },
            // Smooth draws the middle as circular arcs whose radius can be read off rather than hoped
            // for. Only Smooth reaches here unsquared, and only with a join to draw (`squaredOff` takes the
            // rest), so the straight is unreachable. It is here so a future style that forgets that draws a
            // plain diagonal, not a gap.
            ...(biarcJoin ?? [{ kind: "line" as const, a: stubOut, b: stubIn }]),
            { kind: "line", a: stubIn, b: targetAnchor.point }
        ];

    return {
        route: {
            kind: "sampled",
            /**
             * Shoulder samples go to the style whose straight runs sit next to a densely sampled curve,
             * which is Smooth: its join is arc-straight-arc, and the straight is sampled twice against
             * twenty points per arc, so the spline fitted through them would lean into the curve at each
             * join. Orthogonal and Polyline have no curve beside their straights to lean into.
             */
            samples: sampleSegments(segments, exitNormal, arrivalTangent,
                geometry.style === "Smooth")
        },
        handles: spineHandles(ctx, centreline),
        squared: false,
        // Unchained, the drawn middle is one join between the two stubs, so the stub-to-stub chord is
        // the polyline that stands for it, which is what `directWaypoints` would have produced anyway
        // with no crossover to step across.
        spine: centreline ?? [sourceAnchor.point, stubOut, stubIn, targetAnchor.point],
        // Smooth's leads are derived from the radius, so each stub already sits where its straight
        // run stops. Nothing to look for.
        runEnds: portAxis(sourceAnchor.port) !== portAxis(targetAnchor.port)
            && !wraps && detours.length === 0
            ? { source: stubOut, target: stubIn }
            : undefined
    };
}

function spineCentreline(ctx: SpineContext): Point[] {
    const {
        sourceAnchor, targetAnchor, sourceNode, targetNode, geometry, detours, laneOffset,
        exitNormal, wraps, diagonal, archMiddle, stubOut, stubIn, crossover
    } = ctx;
    if (wraps) {
        const base = wrapWaypoints(sourceAnchor, targetAnchor, sourceNode, targetNode, stubOut, stubIn, exitNormal, geometry, crossover, laneOffset, archMiddle);
        if (detours.length === 0) {
            return base;
        }
        // Every construction ends [..., stubIn, targetAnchor.point].
        return [...base.slice(0, -2), ...detours, ...base.slice(-2)];
    }
    if (detours.length === 0) {
        return directWaypoints(sourceAnchor, targetAnchor, stubOut, stubIn, exitNormal,
            crossover, geometry.bandReach + MIN_PERPENDICULAR_RUN, diagonal);
    }
    return [sourceAnchor.point, stubOut, ...detours, stubIn, targetAnchor.point];
}

/** The handle positions to draw, read back off the centreline just built. */
function spineHandles(ctx: SpineContext, centreline: Point[] | undefined): BuiltHandles {
    const {
        sourceAnchor, targetAnchor, geometry, detours, exitNormal, entryNormal, wraps,
        diagonal, diagonalAxis, arches, archMiddle, selfLoop, loopFloor, wrapLeadFloor,
        smoothWrapRadius, cornerRadius, quarterCorner, stubOut, stubIn, crossoverAxis,
        sameAxis, exitIsX
    } = ctx;
    const leadAxis = (port: Port): "x" | "y" => (portAxis(port) === "vertical" ? "x" : "y");
    const result: BuiltHandles = {
        source: { point: stubOut, axis: leadAxis(sourceAnchor.port) },
        target: { point: stubIn, axis: leadAxis(targetAnchor.port) }
    };
    // The two middle points of a Z or a lane sit either side of the step; the handle goes between
    // them, which is where the eye expects it. A diagonal has no such pair (the run between the two
    // stubs is its middle), so its handle sits at that run's midpoint, still on the route. It is
    // the only handle here that is a gesture rather than a stored value: sliding it holds the angle
    // and moves the bend, which visual.ts writes into the two lead overrides. Nothing about the
    // diagonal's construction reads `overrides.middle`, which stops a third stored number
    // re-coupling the two free ones.
    //
    // Octilinear's diagonal: each lead snaps the angle as it is dragged, so the drop lands already
    // fitted and the fit above leaves it be.
    if (geometry.style === "Octilinear" && diagonal) {
        const minLead = geometry.bandReach + MIN_PERPENDICULAR_RUN;
        const step = OCTILINEAR_STEP;
        result.source.angleSnap = { other: stubIn, anchor: sourceAnchor.point, normal: exitNormal, minLead, step };
        result.target.angleSnap = { other: stubOut, anchor: targetAnchor.point, normal: entryNormal, minLead, step };
    }
    // A diagonal is tested first, so its bend can never come back as a stored crossover. Detoured,
    // its centreline grows past six points and the crossover branch below would claim it, reading
    // the handle off two detour waypoints and dropping `gesture`. The result would be a dead
    // control: Polyline's construction never reads `overrides.middle`, so the drag would move
    // nothing, while in Smooth and Orthogonal the stored middle would stand avoidance down, so the
    // one drag an author reached for would put the band back through the node it had just been
    // routed around.
    //
    // A detour replaces a direct route's middle outright (see `centrelineWith`), so once one is in
    // place there is no crossover and no bend left to put a handle on; the lane handle below
    // stands in for both. A wrap keeps its middle: its lane is its own construction's and the
    // detours are spliced in beyond it.
    if (wraps || detours.length === 0) {
        if (diagonal) {
            // A diagonal's middle is a bend, never a stored crossover: it reads off the run between the
            // two stubs, or straight off the stubs where a style draws that run as one curve and leaves no
            // waypoint chain to read.
            result.middle = centreline && centreline.length === 4
                ? { point: midpoint(centreline[1], centreline[2]), axis: diagonalAxis, gesture: true }
                : { point: midpoint(stubOut, stubIn), axis: diagonalAxis, gesture: true };
        } else if (archMiddle) {
            // An arch's lane run joins its two lane points, and the handle goes between them: the same
            // rule as a Z's step. It is taken from the arch itself rather than off the centreline, whose
            // length varies: the outer stub is on the lane by construction, so that repeat is deduped away
            // and the pair is not always at [2] and [3].
            result.middle = {
                point: midpoint(archMiddle.a, archMiddle.b),
                axis: exitIsX ? "x" : "y"
            };
        } else if (sameAxis && centreline && centreline.length >= 6) {
            result.middle = { point: midpoint(centreline[2], centreline[3]), axis: crossoverAxis };
        }
    }
    if (detours.length > 0) {
        result.detour = detourHandle(detours, stubOut, stubIn);
    }
    if (quarterCorner) {
        result.corner = quarterCorner;
    }
    if (selfLoop && centreline) {
        result.loop = true;
        const corner = loopCornerHandle(centreline, cornerRadius, loopFloor, geometry.pitch);
        if (corner) {
            result.corner = corner;
        }
    }
    // The same handle on a Smooth wrap between two nodes (the question mark and the C loop).
    // Drawn per-corner, so bounded per-corner.
    if (smoothWrapRadius && centreline) {
        const corner = loopCornerHandle(centreline, cornerRadius, loopFloor, geometry.pitch, false);
        if (corner) {
            result.corner = corner;
        }
    }
    // Mid-side lead handles on every self-loop. A 0-degree loop (East->East) has both stubs on one
    // line, so moving one lead's side would drag the other's stub with it; its handles stay at the
    // stubs.
    if (selfLoop && centreline && sourceAnchor.port !== targetAnchor.port) {
        const out = leadSide(centreline, true, sourceAnchor.point, exitNormal, loopFloor);
        const back = leadSide(centreline, false, targetAnchor.point, entryNormal, loopFloor);
        if (out && result.source) {
            result.source.side = out;
        }
        if (back && result.target) {
            result.target.side = back;
        }
    }
    /**
     * A wrap's lead handles are drawn on the middle of the run each one places.
     *
     * A wrap leaves its port, runs out to a lane or a corner, travels, and comes back in; each lead
     * sets where one of those runs sits. Drawn at its stub, a handle sits at the end of its run,
     * which reads as belonging to the next one: the same confusion the Z's middle avoids by
     * sitting between its two waypoints rather than on one. `leadSide` already does exactly this
     * for a self-loop's sides, and `path[at]`/`path[far]` pick out the stub and the waypoint after
     * it, which for every one of these shapes is the run being placed.
     *
     * An arch has none of this: both its ends reach one level, so a lead there would be a second
     * name for the lane.
     */
    if (!selfLoop && wraps && centreline && !arches) {
        const out = leadSide(centreline, true, sourceAnchor.point, exitNormal, wrapLeadFloor);
        const back = leadSide(centreline, false, targetAnchor.point, entryNormal, wrapLeadFloor);
        if (out && result.source) {
            result.source.side = out;
        }
        if (back && result.target) {
            result.target.side = back;
        }
    }
    if (arches) {
        result.hideLeads = true;
    }
    if (wraps && !selfLoop) {
        result.wrap = true;
    }

    // No gesture on the middle line: level, it would be the target lead's handle drawn a second
    // time.
    if (polylineFamily(geometry.style) && !wraps
        && portAxis(sourceAnchor.port) !== portAxis(targetAnchor.port)) {
        result.hideLeads = true;
    }
    return result;
}

/**
 * Where each end's straight run stops: the start of the corner arc on a 90-degree L.
 *
 * The packing rule compares two corridors by their lead-in points, and for an L the port stub
 * is the wrong one: the straight carries on past it to the corner, so the stub is not where the
 * route departs from. The arc start is. That is also the whole difference between Smooth's L
 * and a squared one: Smooth derives its leads from the radius, so its stub already is the arc
 * start.
 *
 * It is read off what was drawn rather than recomputed: the radius in force is `cornerRadius`
 * capped per corner inside `roundedPolyline`, and deriving it a second time here would be the
 * drift hazard `handles` and `spine` are returned from this function to avoid.
 */
function spineRunEnds(ctx: SpineContext, points: Point[]): { source: Point; target: Point } | undefined {
    const {
        sourceAnchor, targetAnchor, detours, exitNormal, entryNormal, wraps
    } = ctx;
    if (portAxis(sourceAnchor.port) === portAxis(targetAnchor.port) || wraps
        || detours.length > 0 || points.length < 2) {
        return undefined;
    }
    // The last point still on the port's outward ray, from each end.
    const onRay = (p: Point, anchor: Point, normal: Point): boolean => {
        const offset = sub(p, anchor);
        // Distance across the port's outward ray: still on the straight run while that is nothing.
        return Math.abs(offset.x * -normal.y + offset.y * normal.x) < PROGRESS_EPSILON;
    };
    let source = points[0];
    for (const p of points) {
        if (!onRay(p, sourceAnchor.point, exitNormal)) {
            break;
        }
        source = p;
    }
    let target = points[points.length - 1];
    for (let i = points.length - 1; i >= 0; i--) {
        if (!onRay(points[i], targetAnchor.point, entryNormal)) {
            break;
        }
        target = points[i];
    }
    return { source, target };
}

interface LeadInputs {
    entryNormal: Point;
    exitNormal: Point;
    geometry: RouteGeometry;
    overrides: RouteOverridePoints;
    sourceAlongX: boolean;
    sourceAnchor: Anchor;
    sourceNode: PositionedNode;
    targetAlongX: boolean;
    targetAnchor: Anchor;
    targetNode: PositionedNode;
    wraps0: boolean;
}

/**
 * How far each end runs straight out of its port before the route turns, and the corner
 * radius.
 */
function resolveLeads(args: LeadInputs) {
    const { entryNormal, exitNormal, geometry, overrides, sourceAlongX, sourceAnchor, sourceNode, targetAlongX, targetAnchor, targetNode, wraps0 } = args;
    // A dragged lead handle replaces the default lead-in for that end: an explicit placement beats
    // a default. Only the distance along the port normal is taken: the handle is pinned across the
    // face, so dragging it sideways would break the perpendicular exit the whole port model rests
    // on. It still goes through the floors and caps below, which are correctness bounds rather
    // than style; see the comment on `leadOut`.
    const leadFrom = (anchor: Anchor, normal: Point, override: Point | undefined, fallback: number): number =>
        override ? Math.max(0, dot(sub(override, anchor.point), normal)) : fallback;
    /**
     * An arch has no lead handles, so it ignores hand-moved leads: the standing rule that a hidden
     * handle's stored value must not go on shaping the route unseen. Its two ends reach one level
     * and the lane places it; a lead there would be a second name for that number. The predicate is
     * anchor- and node-level, so it can be asked before the leads it decides about.
     */
    const arches = archesBetween(sourceAnchor, targetAnchor, sourceNode, targetNode,
        2 * Math.max(sourceAnchor.halfExtent, targetAnchor.halfExtent));
    const baseLeadOut = leadFrom(sourceAnchor, exitNormal,
        arches ? undefined : overrides.source,
        sourceAlongX ? geometry.leadX : geometry.leadY);
    const baseLeadIn = leadFrom(targetAnchor, entryNormal, arches ? undefined : overrides.target,
        targetAlongX ? geometry.leadX : geometry.leadY);

    // Is the other end in front of this port's face, or behind it? Measured from the anchors, so
    // it does not shift with the lead-in length below.
    const wraps = wraps0;

    /**
     * A same-axis direct route in Polyline, Octilinear or Smooth joins its two lead-ins with one
     * diagonal (or curve) instead of stepping across at a right angle. Wraps are deliberately
     * excluded: their clearance maths assumes axis-aligned runs, and a diagonal across a clearing
     * lane is exactly where a band would start clipping the nodes that lane exists to miss.
     */
    const straightOrCurvedDiagonal = polylineFamily(geometry.style)
        || geometry.style === "Smooth";
    const diagonal = straightOrCurvedDiagonal && !wraps
        && portAxis(sourceAnchor.port) === portAxis(targetAnchor.port);
    /** Which way a hand-moved bend slides. Same rule as `crossoverAxis` below. */
    const diagonalAxis: "x" | "y" = exitNormal.x !== 0 ? "x" : "y";

    const bounded = boundLeads({
        baseLeadIn,
        baseLeadOut,
        diagonal,
        exitNormal,
        geometry,
        sourceAlongX,
        sourceAnchor,
        sourceNode,
        targetAlongX,
        targetAnchor,
        targetNode,
        wraps
    });
    const { wrapLeadFloor } = bounded;
    let { leadOut, leadIn } = bounded;

    const cleared = clearOtherNode({
        entryNormal,
        exitNormal,
        geometry,
        leadIn,
        leadOut,
        overrides,
        sourceAnchor,
        sourceNode,
        targetAnchor,
        targetNode,
        wraps
    });
    leadOut = cleared.leadOut;
    leadIn = cleared.leadIn;

    const radius = loopAndWrapRadius({
        baseLeadIn,
        baseLeadOut,
        geometry,
        leadIn,
        leadOut,
        overrides,
        sourceNode,
        targetNode,
        wraps
    });
    const { selfLoop, loopFloor, smoothWrapRadius } = radius;
    let { cornerRadius } = radius;
    leadOut = radius.leadOut;
    leadIn = radius.leadIn;

    const corner = quarterCornerLeads({
        entryNormal,
        exitNormal,
        geometry,
        leadIn,
        leadOut,
        overrides,
        sourceAnchor,
        targetAnchor,
        wraps
    });
    let { quarterCorner } = corner;
    leadOut = corner.leadOut;
    leadIn = corner.leadIn;
    return { arches, wraps, diagonal, diagonalAxis, wrapLeadFloor, selfLoop, loopFloor, smoothWrapRadius, leadOut, leadIn, cornerRadius, quarterCorner };
}

interface LeadBoundInputs {
    baseLeadIn: number;
    baseLeadOut: number;
    diagonal: boolean;
    exitNormal: Point;
    geometry: RouteGeometry;
    sourceAlongX: boolean;
    sourceAnchor: Anchor;
    sourceNode: PositionedNode;
    targetAlongX: boolean;
    targetAnchor: Anchor;
    targetNode: PositionedNode;
    wraps: boolean;
}

/**
 * The leads after the style's floors and ceilings: band half-width, span between anchors,
 * 45-degree fit.
 */
function boundLeads(args: LeadBoundInputs) {
    const { baseLeadIn, baseLeadOut, diagonal, exitNormal, geometry, sourceAlongX, sourceAnchor, sourceNode, targetAlongX, targetAnchor, targetNode, wraps } = args;
    // On a wrap route the lead-in has to be long enough to fit the corner that follows it, or the
    // uniform radius gets throttled by the shortest edge and a wide band's inner edge folds
    // through itself. A direct route has no corners, so instead it takes the ceiling that keeps
    // both ends plus the bend inside one grid space. The ceiling deliberately does not apply to
    // wrap routes: it is always below the radius they need, so it would stop the lead-in having any
    // effect on them.
    /**
     * A wrap's lead-in is floored by the band, not by the Curvature slider.
     *
     * Flooring it at `geometry.radius` would force the corner to fit whole before the route could
     * turn. Since that radius is `curvature x pitch`, the lead-in would do nothing below it, and
     * the slider would only reach the route once it exceeded the radius.
     *
     * The bound that is real is the band's: `roundedPolyline` caps each corner at what its own
     * edges allow, so a short lead makes a tight corner, and a corner tighter than the band's
     * half-width turns the ribbon inside out. Half-width alone is not enough, though: the inner arc
     * is then a sliver and the edge collapses. A floor of 1.5 x half-width + 1px keeps the drawn
     * band at constant width at every curvature, and larger floors change nothing, so the floor is
     * the band's own measurement and the corner yields to the lead rather than the lead yielding to
     * the corner. That is the rule a self-loop has always followed: rounding never resizes a loop;
     * the corners grow into the straights and stop.
     *
     * A self-loop keeps the radius floor. It rounds every corner to one radius capped by its
     * shortest edge, so a short lead throttles the whole loop.
     */
    const wrapLeadFloor = sourceNode.id === targetNode.id
        ? geometry.radius
        : (geometry.curvature <= 0 ? 0 : CLEAN_CORNER_REACH * geometry.bandReach + MIN_PERPENDICULAR_RUN);
    let leadOut = wraps
        ? Math.max(baseLeadOut, wrapLeadFloor)
        : Math.min(baseLeadOut, sourceAlongX ? geometry.maxLeadX : geometry.maxLeadY);
    let leadIn = wraps
        ? Math.max(baseLeadIn, wrapLeadFloor)
        : Math.min(baseLeadIn, targetAlongX ? geometry.maxLeadX : geometry.maxLeadY);

    /**
     * A same-axis direct route's leads are bounded by the span between the two anchors, not by
     * half a grid space.
     *
     * A ceiling of half a grid cell each, less the curve's room, would be a proxy for the thing
     * that actually matters: two lead-ins must not run past each other, or the curve between them
     * doubles back. Measured against one cell it would also bind corridors spanning several
     * columns, where there is plainly room, so a dragged lead would stop a third of the way along a
     * route with two thirds of it still free.
     *
     * Bounding against the real distance says exactly what was meant and scales with the diagram.
     * The pair is scaled in proportion when it overruns, so neither end is singled out. Polyline
     * keeps no ceiling at all: a diagonal has no curve to double back, and letting its stubs meet
     * is what makes a right angle reachable by hand.
     */
    if (!wraps && !diagonal && portAxis(sourceAnchor.port) === portAxis(targetAnchor.port)) {
        leadOut = Math.max(0, baseLeadOut);
        leadIn = Math.max(0, baseLeadIn);
        const available = Math.max(0, dot(sub(targetAnchor.point, sourceAnchor.point), exitNormal));

        // The stubs may never cross, whatever the defaults ask for: past that the two lead-ins run
        // through each other and the curve between them doubles back. This one has no floor; it is the
        // hard bound the reserve above is a softer version of.
        const total = leadOut + leadIn;
        if (total > available && total > 0) {
            const clamp = available / total;
            leadOut *= clamp;
            leadIn *= clamp;
        }
    }

    if (diagonal) {
        /**
         * A diagonal's two leads are free and independent. The only rule left is the one the whole
         * port model rests on: each stub stays on its port's outward normal, so the band still leaves
         * and arrives perpendicular to the node face. Everything else a lead could be clamped by is
         * gone here:
         *
         *  - the half-a-grid-space ceiling, which exists so a curve between two lead-ins cannot double
         *    back. A diagonal has no curve to double back, and the ceiling would make a right angle
         *    unreachable. Free, a lead can be pulled until the two stubs meet, which is a right angle,
         *    or past each other, which is the author's business.
         *
         * What it does not escape is the half-width floor below: a diagonal leaving the face with less
         * than that reaches back across the node, and no placement makes that correct.
         *
         * Two independent leads also fully determine the diagonal, which is why this style has no
         * middle handle: a third control would be a second name for the same two numbers, and coupling
         * it to these makes the handles stop following the cursor.
         */
        leadOut = Math.max(0, baseLeadOut);
        leadIn = Math.max(0, baseLeadIn);
    }

    /**
     * A squared-off route's lead has a per-corridor minimum: the band's half-width, plus a pixel.
     *
     * The step may be dragged right back to the stub, and when it is, the route's cross-run sits on
     * the stub, so the band straddles it, reaching half its own width back towards the node. With a
     * short lead that lands across the node itself: a corridor of half-width 80 would overshoot the
     * node face by exactly 80.
     *
     * The extra pixel is not decoration. At exactly the half-width the band's inner edge turns the
     * moment it leaves the face, so its perpendicular run is zero-length, and a zero-length segment
     * has no direction, which is how a band comes to pinch to nothing. A pixel keeps every
     * corridor leaving and arriving perpendicular whatever its width.
     *
     * It is per corridor rather than global, since it is that corridor's own width that decides it,
     * and applied after the ceiling rather than before: this is a correctness bound, like the wrap
     * routes' radius floor, and beats a cap that is only there to keep two lead-ins inside one grid
     * space.
     *
     * Polyline is included: its turn is shallower, so it cuts back less, but it still cuts back.
     * Its leads stay draggable; a drag below the floor simply stops following the cursor, which is
     * the same bargain a wrap route's lead already makes. Smooth needs none of this: its direct
     * routes have no corner at the stub to straddle.
     */
    if ((geometry.style === "Orthogonal" || polylineFamily(geometry.style)) && !wraps) {
        const floor = geometry.bandReach + MIN_PERPENDICULAR_RUN;
        leadOut = Math.max(leadOut, floor);
        leadIn = Math.max(leadIn, floor);
    }

    /**
     * Octilinear: every diagonal is fitted to 45 degrees, always. It is applied to whatever the
     * leads are (the default lead-in, a hand-moved lead, avoidance reshaping a blocked route), so
     * there is no one-off "push" to get out of step. See `fitDiagonalLeads`.
     */
    if (geometry.style === "Octilinear" && diagonal) {
        const fitted = fitDiagonalLeads(sourceAnchor.point, exitNormal, targetAnchor.point, leadOut, leadIn,
            geometry.bandReach + MIN_PERPENDICULAR_RUN, OCTILINEAR_STEP);
        leadOut = fitted.out;
        leadIn = fitted.in;
    }
    return { wrapLeadFloor, leadOut, leadIn };
}

interface ClearanceInputs {
    entryNormal: Point;
    exitNormal: Point;
    geometry: RouteGeometry;
    leadIn: number;
    leadOut: number;
    overrides: RouteOverridePoints;
    sourceAnchor: Anchor;
    sourceNode: PositionedNode;
    targetAnchor: Anchor;
    targetNode: PositionedNode;
    wraps: boolean;
}

/** On a wrap, lengthens each lead so its cross-run clears the node at the other end. */
function clearOtherNode(args: ClearanceInputs) {
    const { entryNormal, exitNormal, geometry, overrides, sourceAnchor, sourceNode, targetAnchor, targetNode, wraps } = args;
    let { leadIn, leadOut } = args;
    // With ports on perpendicular axes the route is a single L, so each lead-in sets where one of
    // the two long cross-runs sits. Those runs have to clear the other node, including the band's
    // own width, or the ribbon clips it, so each lead extends past it where the plain lead is not
    // already clear. Same-axis routes do not need this: their cross-run already travels along a
    // clearing lane by construction.
    //
    // This applies only where the run would actually cross the other node. Flooring both leads at
    // a lane past the bounding box of both nodes whether anything is in the way or not would be
    // the blunter test, and would make a route run far out and back for no reason. It would also
    // make the handle one-way: the floor is applied after a dragged override, so outward it would
    // follow, while inward it would stop dead at the lane and no drag could reach the S.
    //
    // A 90-degree self-loop keeps the lane. Both its runs travel alongside the one node, so the
    // clearing is what gives the hook its size rather than something it is dodging, and a loop is
    // designed once and shared by every style.
    if (wraps && portAxis(sourceAnchor.port) !== portAxis(targetAnchor.port)) {
        if (sourceNode.id === targetNode.id) {
            leadOut = leadClearing(sourceAnchor.point, exitNormal, sourceNode, targetNode, geometry.clearance, leadOut);
            leadIn = leadClearing(targetAnchor.point, entryNormal, sourceNode, targetNode, geometry.clearance, leadIn);
        } else {
            // Each lead places the run that travels along the other port's axis, so each is tested against
            // the other node: the same pairing, margin and test as the same-axis branch below.
            const margin = 2 * geometry.bandReach;
            leadOut = leadPastNode(sourceAnchor.point, exitNormal, targetNode, margin, leadOut,
                overrides.source !== undefined);
            leadIn = leadPastNode(targetAnchor.point, entryNormal, sourceNode, margin, leadIn,
                overrides.target !== undefined);
        }
    } else if (wraps) {
        // Same-axis wrap: each lead-in sets where its cross-run to the lane sits, and that run has to
        // clear the other node. It only extends when the run would actually cross it: a self-loop's run
        // travels alongside its node rather than over it, and inflating those would fatten every loop
        // in the diagram for no reason.
        const margin = 2 * geometry.bandReach;
        leadOut = leadPastNode(sourceAnchor.point, exitNormal, targetNode, margin, leadOut,
            overrides.source !== undefined);
        leadIn = leadPastNode(targetAnchor.point, entryNormal, sourceNode, margin, leadIn,
            overrides.target !== undefined);
    }
    return { leadOut, leadIn };
}

interface RadiusInputs {
    baseLeadIn: number;
    baseLeadOut: number;
    geometry: RouteGeometry;
    leadIn: number;
    leadOut: number;
    overrides: RouteOverridePoints;
    sourceNode: PositionedNode;
    targetNode: PositionedNode;
    wraps: boolean;
}

/** Corner radius for a self-loop or a Smooth wrap, and the hand-set leads of a self-loop. */
function loopAndWrapRadius(args: RadiusInputs) {
    const { baseLeadIn, baseLeadOut, geometry, overrides, sourceNode, targetNode, wraps } = args;
    let { leadIn, leadOut } = args;
    /**
     * A Smooth self-loop has one handle per job. The two leads place its vertical sides,
     * independently; the lane places its top; and a corner handle sets its roundness. Coupling the
     * radius to the leads would make a loop's size and its roundness impossible to choose
     * separately: a wide loop could not have tight corners.
     *
     *  - A dragged lead goes where it was put, floored only at the band's half-width. The usual
     *    wrap floor (the lead at least the corner radius) is a style bound whose job, stopping a
     *    short lead throttling the radius, is the corner handle's now.
     *  - The radius is the corner handle's if it has been moved, otherwise the Curvature slider's,
     *    and `roundedPolyline`'s uniform cap stops it where a straight runs out. So rounding a
     *    corner never resizes the loop: the corners grow into the straights and stop. Letting an
     *    untouched lead grow to make room would mean rounding a corner could widen the loop, the
     *    one handle doing two jobs again.
     *  - This applies only once a handle has been moved. Untouched, a loop is identical to the
     *    same loop in every other style (a wrap is squared off the same way in all of them).
     */
    let cornerRadius = geometry.radius;
    /**
     * Self-loops are the same in every routing style. A loop is a wrap, and a wrap is squared off
     * identically in every style; what could differ is the handles and what they can do. Every
     * style takes the same design: independent leads drawn halfway along their sides, floored only
     * at the band's half-width + 1px; the lane; and the corner handle for roundness, with its
     * Curvature hop. The styles differ on corridors between two nodes, never on a loop.
     */
    const selfLoop = sourceNode.id === targetNode.id;
    const loopFloor = geometry.bandReach + MIN_PERPENDICULAR_RUN;
    /**
     * A Smooth wrap between two nodes takes a hand-set corner radius too.
     *
     * The radius handle already exists on a direct 90-degree L in Smooth, and on every self-loop
     * in every style. The two wrap shapes between two nodes, the question mark (perpendicular) and
     * the C loop (same-axis), would otherwise have their roundness set only for the whole diagram
     * at once, with the Curvature slider.
     *
     * This is Smooth only: it is the style whose whole premise is that joins are drawn as arcs, so
     * a per-corridor radius is a setting it already has a vocabulary for.
     *
     * The route is still drawn corner by corner (`roundedPolyline`'s `uniform` stays false for
     * anything but a self-loop). This sets the radius each corner asks for, exactly as the
     * Curvature slider does, and each still takes what its own two edges allow. The floor is the
     * same correctness bound a loop takes: below the band's half-width the inner edge inverts.
     */
    const smoothWrapRadius = !selfLoop && wraps && geometry.style === "Smooth";
    if (smoothWrapRadius && overrides.radius !== undefined) {
        cornerRadius = Math.max(loopFloor, overrides.radius * geometry.pitch);
    }
    if (selfLoop) {
        if (overrides.source !== undefined) {
            leadOut = Math.max(loopFloor, baseLeadOut);
        }
        if (overrides.target !== undefined) {
            leadIn = Math.max(loopFloor, baseLeadIn);
        }
        if (overrides.radius !== undefined) {
            cornerRadius = Math.max(loopFloor, overrides.radius * geometry.pitch);
        }
    }
    return { selfLoop, loopFloor, smoothWrapRadius, cornerRadius, leadOut, leadIn };
}

interface QuarterCornerInputs {
    entryNormal: Point;
    exitNormal: Point;
    geometry: RouteGeometry;
    leadIn: number;
    leadOut: number;
    overrides: RouteOverridePoints;
    sourceAnchor: Anchor;
    targetAnchor: Anchor;
    wraps: boolean;
}

/** A direct 90-degree Smooth join is one quarter circle: its two leads move together. */
function quarterCornerLeads(args: QuarterCornerInputs) {
    const { entryNormal, exitNormal, geometry, overrides, sourceAnchor, targetAnchor, wraps } = args;
    let { leadIn, leadOut } = args;
    /**
     * A 90-degree Smooth join is one quarter circle, so its two leads move together.
     *
     * A single arc tangent to both ports exists only if the two stubs are the same distance from
     * the corner where the two port rays cross; that distance is the radius. Unequal, no single
     * arc is tangent to both, and the join falls back to a pair of them, which gives a warped
     * shape.
     *
     * So the smaller of the two implied radii wins and both leads are set from it. This is
     * stateless, which matters: coupled handles that store the pair have to guess which one the
     * author last moved, and every version of that guess ends with a handle that will not follow
     * the cursor. Here there is nothing stored: whichever handle sits closer to the corner sets the
     * radius and the other follows it.
     */
    let quarterCorner: CornerHandle | undefined;
    if (geometry.style === "Smooth" && !wraps
        && portAxis(sourceAnchor.port) !== portAxis(targetAnchor.port)) {
        // The corner is where the two rays meet: each port keeps its own coordinate along its normal
        // and takes the other's across it.
        const corner = exitNormal.x !== 0
            ? { x: targetAnchor.point.x, y: sourceAnchor.point.y }
            : { x: sourceAnchor.point.x, y: targetAnchor.point.y };
        const reachOut = dot(sub(corner, sourceAnchor.point), exitNormal);
        const reachIn = dot(sub(corner, targetAnchor.point), entryNormal);
        // Only where the corner lies ahead of both ports; behind either, this is not the
        // quarter-circle case at all.
        if (reachOut > 0 && reachIn > 0) {
            // An arc tighter than the band's half-width turns the ribbon inside out, and the extra pixel
            // keeps a perpendicular run at each face: the same floor every squared style takes, stated here
            // as a radius because for this join the radius is the lead.
            const minRadius = geometry.bandReach + MIN_PERPENDICULAR_RUN;
            // The corner handle sets the radius. A direct 90-degree corner has one real parameter (its
            // runs lie on the port rays, which the nodes fix), so its lead handles are hidden and ignored.
            //
            // Untouched, it follows the Curvature slider like every other route: the same pitch-relative
            // radius a squared corner takes. A hand-set radius only reaches here while the slider is where
            // it was set (visual.ts, `radiusInForce`), so moving the slider hops the corner to the new
            // setting and the handle can adjust it again from there.
            const radius = Math.max(minRadius, overrides.radius !== undefined
                ? overrides.radius * geometry.pitch
                : geometry.radius);
            // Where the corner is too close to hold even that, both ends give way in proportion rather
            // than one being singled out.
            const fit = Math.min(1, reachOut / radius, reachIn / radius);
            leadOut = Math.max(0, reachOut - radius * fit);
            leadIn = Math.max(0, reachIn - radius * fit);
            const drawn = radius * fit;
            const direction = unit(scale(add(exitNormal, entryNormal), -1));
            const spread = Math.SQRT2 - 1;
            const maxRadius = Math.min(reachOut, reachIn);
            quarterCorner = {
                point: add(corner, scale(direction, drawn * spread)),
                apex: corner,
                direction,
                spread,
                radius: drawn,
                minRadius: Math.min(minRadius, maxRadius),
                maxRadius,
                pitch: geometry.pitch,
                replacesLeads: true
            };
        }
    }
    return { quarterCorner, leadOut, leadIn };
}
