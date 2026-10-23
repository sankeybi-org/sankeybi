/**
 * Arrange flows: nudge route handles until flows stop lying along each other.
 *
 * The Arrange card's button hands this a routed diagram and takes back ordinary route
 * overrides: the same blob a hand drag writes. That is the whole design. Nothing here teaches
 * routing a new trick; it searches the space the author could have dragged through by hand, so
 * the result persists, is undone by Reset route handles, and can be dragged afterwards.
 *
 * It acts only on corridors that lie along another one (`parallel.ts`), and scores that alone:
 * the length they lie together, in pixels. Crossings are not scored, so a flow is never moved to
 * trade one for another.
 *
 * Nothing about a raster is used: a candidate is scored by the centreline `reroute` hands back,
 * against the other corridors' as routing drew them, and a winner is confirmed with a real
 * re-route. The confirmation also requires the diagram's total not to rise, so a move that parts
 * one pair by bringing another together is not kept.
 *
 * Determinism, as everywhere else: corridors are visited in a fixed order (worst first, ties by
 * id), a candidate is kept only if it is strictly better, and the sweep stops as soon as a pass
 * changes nothing.
 */

import { Corridor, LayoutResult, Point, PositionedNode } from "./model";
import { PARALLEL_FLOOR, PARALLEL_THRESHOLD, ParallelField } from "./parallel";
import { DEFAULT_LEAD_FRACTION } from "./routingStyle";
import { DiagramRouting, RouteHandles, RouteOverridePoints, RoutingOptions } from "./routeTypes";
import { draggableHandles } from "./handles";
import { routeDiagram } from "./routing";

/**
 * Candidate offsets for a crossover or bend, as a fraction of the pitch it slides along. They
 * are symmetric, because the better direction depends entirely on what else is in the way, and
 * ordered small-first so a tie keeps the gentler move: a handle that barely moved is easier to
 * recognise as the one you asked for than one flung across the column.
 */
const MIDDLE_OFFSETS = [0.12, -0.12, 0.25, -0.25, 0.4, -0.4];

/**
 * The same for a lead, which has much less room: it sits between the port and the crossover.
 */
const LEAD_OFFSETS = [0.15, -0.15, 0.3, -0.3];

/**
 * What a big move has to be worth.
 *
 * Ordering the offsets small-first only settles a tie. Any improvement at all, however slight,
 * would let the furthest candidate win, and with two sweeps the displacements compound until a
 * line turns in a different column.
 *
 * So a candidate's reach is priced into the choice: it must beat a gentler one by `MOVE_COST`
 * of the corridor's own overlap per pitch moved. The price is relative to the corridor, not
 * absolute, so it means the same on a diagram of any density. The acceptance test itself is
 * unchanged: a candidate still has to reduce the real overlap, and still has to survive the
 * confirming re-route.
 */
const MOVE_COST = 0.25;

/**
 * The furthest a handle may end up from where it started, in pitches, however many sweeps it
 * takes to get there. The price above picks the gentler of two candidates; this is what stops a
 * corridor walking a long way in small steps, which the two sweeps would otherwise let it do.
 */
const MAX_REACH = 0.5;

/**
 * How close to a node column a crossover may sit before it is priced, as a fraction of the
 * pitch it slides in.
 *
 * A step that lands beside a column runs alongside the nodes rather than between them, and
 * reads as part of that column.
 *
 * It is a price and not a hard boundary, deliberately: on a dense diagram the columns are close
 * enough together that a boundary can leave a corridor with no legal candidate at all, and the
 * search would then simply stop improving it. Priced, the search takes the clearest position it
 * can reach and still moves something when every position is near something.
 */
const COLUMN_CLEARANCE = 0.3;

/** What sitting right on a column costs, as a fraction of the corridor's own overlap. */
const COLUMN_COST = 2;

/**
 * Sweeps over the whole diagram. Two, not "until nothing improves": the second pass is where a
 * corridor gets to react to its neighbours having moved, and past that the gains are small for
 * a doubling of the work.
 */
const MAX_SWEEPS = 2;

/**
 * Ceiling on routed trials, whatever the corridor count. A trial is a full re-route of the
 * diagram, so this is what bounds the click's cost on a dense diagram; the spend goes to the
 * worst corridors first, which is why they are sorted by their own overlap before the search
 * starts.
 */
const EVAL_BUDGET = 600;

/** What one candidate asks for: a handle point, or a pair of leads for a bend. */
interface Candidate {
    source?: Point;
    target?: Point;
    middle?: Point;
    /** How far it moves the handle, as a fraction of the pitch it slides in. */
    reach: number;
}

/**
 * The shortest lead Arrange flows may write. A search that is free to pull a lead in leaves a
 * corridor with a stub of a few pixels against a default of around 30. It may lengthen a lead
 * or leave it, and never takes it below the Polyline default (`DEFAULT_LEAD_FRACTION.Polyline`,
 * a quarter of the pitch along that axis), or below where it started, if that was already
 * shorter. The author can drag past it; routing's hard stop is the only floor there.
 *
 * It is present for Polyline only. Smooth, Octilinear and Orthogonal have no limit of the
 * search's own: a lead may go to the hard stop (or, in Smooth, to zero).
 */
interface LeadFloor {
    corridor: Corridor;
    nodes: ReadonlyMap<string, PositionedNode>;
    /** The shortest lead, in pixels, along x and along y. */
    minX: number;
    minY: number;
}

/** The lead limit for one corridor, or none where the style has only the hard stop. */
function leadFloorFor(
    id: string,
    corridors: ReadonlyMap<string, Corridor>,
    layout: LayoutResult,
    options: RoutingOptions
): LeadFloor | undefined {
    const corridor = corridors.get(id);
    if (options.style !== "Polyline" || !corridor) {
        return undefined;
    }
    const fraction = DEFAULT_LEAD_FRACTION.Polyline;
    return {
        corridor,
        nodes: layout.nodes,
        minX: fraction * layout.columnGap,
        minY: fraction * layout.rowPitch
    };
}

/** The pitch a handle on this axis slides in. */
function pitchFor(axis: "x" | "y", layout: LayoutResult): number {
    return axis === "x" ? layout.columnGap : layout.rowPitch;
}

/**
 * The moves available on one corridor.
 *
 * A bend is a gesture, not a stored number (see `RouteHandles.middle`): it slides the two leads
 * together, so its candidates are written as a lead pair, exactly as visual.ts's `slideBend`
 * writes a drag of it. A Z's step or a wrap's lane is a value in its own right and is written
 * as a middle.
 *
 * A stored middle is not offered on a route avoidance sent round something (`asPlaced`).
 * Storing one makes `usesCrossover` true, which stands avoidance down, so the search could take
 * a route that had been steered clear of a node and put it back through it in the name of a
 * slightly lower overlap score. Whether to overrule avoidance is the author's call, which is
 * what the handle is there to let them make; it is not a search's. The bend is still offered on
 * those routes: it writes the two leads, and leads compose with avoidance rather than switching
 * it off.
 */
function candidatesFor(
    handles: RouteHandles,
    layout: LayoutResult,
    /**
     * Where this corridor's handles started, before the search touched anything. The reach is
     * measured from there and not from the current position, or the second sweep simply starts
     * again from wherever the first one left off and the two compound.
     */
    origin?: RouteHandles,
    floor?: LeadFloor
): Candidate[] {
    const out: Candidate[] = [];
    /**
     * How far out from its node a lead point is, along the lead's own axis: the sign is taken from
     * where the lead started, so it needs no knowledge of which port the corridor leaves by.
     */
    const outwardOf = (role: "source" | "target", axis: "x" | "y", start: Point): ((p: Point) => number) | undefined => {
        if (!floor) {
            return undefined;
        }
        const node = floor.nodes.get(role === "source" ? floor.corridor.source : floor.corridor.target);
        if (!node) {
            return undefined;
        }
        const half = axis === "x" ? node.width / 2 : node.height / 2;
        const centre = axis === "x" ? node.x + half : node.y + half;
        const sign = (axis === "x" ? start.x : start.y) >= centre ? 1 : -1;
        // Length of the lead: how far out from the node's face the point is.
        return p => sign * ((axis === "x" ? p.x : p.y) - centre) - half;
    };
    const shortens = (role: "source" | "target", axis: "x" | "y", started: Point, to: Point): boolean => {
        const outward = outwardOf(role, axis, started);
        if (outward === undefined || !floor) {
            return false;
        }
        const limit = axis === "x" ? floor.minX : floor.minY;
        return outward(to) < Math.min(limit, outward(started)) - 1e-6;
    };
    const middle = handles.middle;
    if (middle) {
        const step = pitchFor(middle.axis, layout);
        MIDDLE_OFFSETS.forEach(fraction => {
            const delta = fraction * step;
            if (middle.gesture) {
                if (handles.source && handles.target) {
                    const source = slide(handles.source.point, middle.axis, delta);
                    const target = slide(handles.target.point, middle.axis, delta);
                    if (shortens("source", middle.axis, origin?.source?.point ?? handles.source.point, source)
                        || shortens("target", middle.axis, origin?.target?.point ?? handles.target.point, target)) {
                        return;
                    }
                    out.push({
                        source,
                        target,
                        reach: Math.max(
                            travelled(source, origin?.source?.point ?? handles.source.point,
                                middle.axis, step),
                            travelled(target, origin?.target?.point ?? handles.target.point,
                                middle.axis, step))
                    });
                }
            } else if (!handles.asPlaced) {
                const point = slide(middle.point, middle.axis, delta);
                out.push({
                    middle: point,
                    reach: travelled(point, origin?.middle?.point ?? middle.point, middle.axis, step)
                });
            }
        });
    }
    // A lead moves along its own port's normal, which is the axis routing already recorded for it.
    // Leads are offered even when there is a bend, because the two do different things: the bend
    // slides the crossover holding its angle, a lead alone opens the angle up.
    (["source", "target"] as const).forEach(role => {
        const lead = handles[role];
        if (!lead) {
            return;
        }
        // An Octilinear lead has to be stored with the other one, pinned where it is: the same rule a
        // hand drag follows (visual.ts's `moveHandle`). The 45-degree fit reads both ends, so a lead
        // stored on its own would leave the other to fall back to its default and the fit would then
        // move both, leaving the handle somewhere the search never chose.
        const other = role === "source" ? handles.target : handles.source;
        const pin = lead.angleSnap && other
            ? { [role === "source" ? "target" : "source"]: { x: other.point.x, y: other.point.y } }
            : {};
        const step = pitchFor(lead.axis, layout);
        const from = origin?.[role]?.point ?? lead.point;
        LEAD_OFFSETS.forEach(fraction => {
            const point = slide(lead.point, lead.axis, fraction * step);
            if (shortens(role, lead.axis, from, point)) {
                return;
            }
            out.push({ ...pin, [role]: point, reach: travelled(point, from, lead.axis, step) });
        });
    });
    return out;
}

/** How far a candidate sits from where the handle started, in pitches. */
function travelled(point: Point, from: Point, axis: "x" | "y", step: number): number {
    const delta = axis === "x" ? point.x - from.x : point.y - from.y;
    return step > 0 ? Math.abs(delta) / step : 0;
}

function slide(point: Point, axis: "x" | "y", delta: number): Point {
    return axis === "x" ? { x: point.x + delta, y: point.y } : { x: point.x, y: point.y + delta };
}

/**
 * One corridor's override with a candidate applied, taking each moved handle's position from
 * `drawn` when routing has already placed it.
 */
function withCandidate(
    base: RouteOverridePoints | undefined,
    candidate: Candidate,
    drawn?: RouteHandles
): RouteOverridePoints {
    const out: RouteOverridePoints = { ...(base ?? {}) };
    if (candidate.middle) {
        out.middle = drawn?.middle ? { x: drawn.middle.point.x, y: drawn.middle.point.y } : candidate.middle;
    }
    if (candidate.source) {
        out.source = drawn?.source ? { x: drawn.source.point.x, y: drawn.source.point.y } : candidate.source;
    }
    if (candidate.target) {
        out.target = drawn?.target ? { x: drawn.target.point.x, y: drawn.target.point.y } : candidate.target;
    }
    return out;
}

/** What Arrange flows reports back. */
export interface FlowFitResult {
    /**
     * The corridors this actually moved, in pixels (the caller converts them to grid units, as a
     * drag does). Only the moved ones: a hand-dragged corridor's stored entry carries things this
     * never sees (a corner radius and the curvature it was set at), and writing the whole map back
     * would round-trip those through pixels and lose them.
     */
    overrides: Map<string, RouteOverridePoints>;
    /** Total length, in pixels, over which corridors lie along each other, before and after. */
    before: number;
    after: number;
    /** Number of pairs of corridors that lie along each other, before and after. */
    pairsBefore: number;
    pairsAfter: number;
    /** How many corridors ended up moved. */
    moved: number;
    /** Single-corridor trials routed. Only interesting when tuning the budget. */
    trials: number;
}

export interface ParallelFitTuning {
    /** Overrides `PARALLEL_THRESHOLD`. */
    threshold?: number;
    /** Overrides `PARALLEL_FLOOR`. */
    floor?: number;
    moveCost?: number;
    maxReach?: number;
    columnCost?: number;
    columnClearance?: number;
}

/**
 * Arrange flows. Searches route handles for corridors that lie along another one and scores
 * that alone.
 *
 * It shares the candidates, the reach cap, the move cost, the column price and the lead floor
 * with the rest of this module; none of them is re-derived here.
 *
 * `before` / `after` carry the diagram's total length together, in pixels, and `pairsBefore` /
 * `pairsAfter` the number of parallel pairs.
 */
export function arrangeFlows(
    layout: LayoutResult,
    options: RoutingOptions,
    existing: Map<string, RouteOverridePoints> = new Map(),
    tuning: ParallelFitTuning = {},
    /**
     * True re-routes the whole diagram after every accepted move. False (the default) accepts a
     * move on the strength of its own `reroute` and verifies once at the end of the sweep, falling
     * back to true if the diagram's total came out worse: a full re-route is most of the time on a
     * big diagram.
     */
    confirmEach: boolean = false
): FlowFitResult {
    const moveCost = tuning.moveCost ?? MOVE_COST;
    const maxReach = tuning.maxReach ?? MAX_REACH;
    const columnCost = tuning.columnCost ?? COLUMN_COST;
    const columnClearance = tuning.columnClearance ?? COLUMN_CLEARANCE;
    const threshold = tuning.threshold ?? PARALLEL_THRESHOLD;
    const floor = tuning.floor ?? PARALLEL_FLOOR;

    let current = new Map<string, RouteOverridePoints>(existing);
    let latest = routeDiagram(layout, options, current);
    const origin = new Map(latest.handles);
    if (latest.bands.length === 0) {
        return {
            overrides: new Map(), before: 0, after: 0, pairsBefore: 0, pairsAfter: 0,
            moved: 0, trials: 0
        };
    }

    const corridorOf = new Map(layout.corridors.map(c => [c.id, c] as const));
    const floorOf = (id: string): LeadFloor | undefined => leadFloorFor(id, corridorOf, layout, options);

    // Where the nodes are, per axis, so a crossover can be priced for sitting beside one.
    const spansX: { lo: number; hi: number }[] = [];
    const spansY: { lo: number; hi: number }[] = [];
    layout.nodes.forEach(node => {
        spansX.push({ lo: node.x, hi: node.x + node.width });
        spansY.push({ lo: node.y, hi: node.y + node.height });
    });
    const columnIntrusion = (handles: RouteHandles | undefined): number => {
        const middle = handles?.middle;
        if (!middle) {
            return 0;
        }
        const clear = columnClearance * pitchFor(middle.axis, layout);
        if (clear <= 0) {
            return 0;
        }
        const where = middle.axis === "x" ? middle.point.x : middle.point.y;
        const spans = middle.axis === "x" ? spansX : spansY;
        let nearest = Number.POSITIVE_INFINITY;
        spans.forEach(span => {
            const gap = where < span.lo ? span.lo - where : where > span.hi ? where - span.hi : 0;
            nearest = Math.min(nearest, gap);
        });
        return Number.isFinite(nearest) ? Math.max(0, 1 - nearest / clear) : 0;
    };

    let field = new ParallelField(layout, latest);
    const start = field.parallel(threshold);
    const beforeTotal = field.total(floor);

    let shownFor: DiagramRouting | undefined;
    let shownHandles = new Map<string, RouteHandles>();
    const shown = (routing: DiagramRouting): Map<string, RouteHandles> => {
        if (shownFor !== routing) {
            shownHandles = draggableHandles(routing.handles, options.style);
            shownFor = routing;
        }
        return shownHandles;
    };

    const order = Array.from(start.ids)
        .filter(id => !existing.has(id))
        .filter(id => {
            const handles = shown(latest).get(id);
            return handles !== undefined && candidatesFor(handles, layout, undefined, floorOf(id)).length > 0;
        })
        .map(id => ({ id, cost: field.score(id, undefined, floor) }))
        .filter(entry => entry.cost > 0)
        .sort((a, b) => (b.cost - a.cost) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(entry => entry.id);

    let budget = EVAL_BUDGET;
    let trials = 0;
    const movedIds = new Set<string>();
    // Handles as the last accepted trial drew them, for the fast path, where `latest` is not
    // re-routed between moves.
    const drawn = new Map<string, RouteHandles>();

    for (let sweep = 0; sweep < MAX_SWEEPS && budget > 0; sweep++) {
        let improved = false;
        const sweepStart = current;
        const sweepTotal = field.total(floor);
        for (const id of order) {
            if (budget <= 0) {
                break;
            }
            const handles = drawn.get(id) ?? shown(latest).get(id);
            if (!handles) {
                continue;
            }
            const baseline = field.score(id, undefined, floor);
            if (baseline === 0) {
                continue;
            }
            let best: { asked: RouteOverridePoints; priced: number; spine: Point[]; drawn: RouteHandles } | undefined;
            for (const candidate of candidatesFor(handles, layout, origin.get(id), floorOf(id))) {
                if (budget <= 0) {
                    break;
                }
                if (candidate.reach > maxReach + 1e-9) {
                    continue;
                }
                budget--;
                trials++;
                const asked = withCandidate(current.get(id), candidate);
                const trial = latest.reroute(id, asked);
                if (!trial) {
                    continue;
                }
                const score = field.score(id, trial.spine, floor);
                const priced = score
                    + moveCost * candidate.reach * baseline
                    + columnCost * columnIntrusion(trial.handles) * baseline;
                if (score < baseline && (!best || priced < best.priced)) {
                    best = {
                        asked: withCandidate(current.get(id), candidate, trial.handles),
                        priced, spine: trial.spine, drawn: trial.handles
                    };
                }
            }
            if (!best) {
                continue;
            }
            const next = new Map(current);
            next.set(id, best.asked);
            if (!confirmEach) {
                current = next;
                field.replace(id, best.spine);
                drawn.set(id, best.drawn);
                movedIds.add(id);
                improved = true;
                continue;
            }
            const routing = routeDiagram(layout, options, next);
            const confirmed = new ParallelField(layout, routing);
            if (confirmed.score(id, undefined, floor) < baseline
                && confirmed.total(floor) <= field.total(floor) + 1e-6) {
                current = next;
                latest = routing;
                field = confirmed;
                movedIds.add(id);
                improved = true;
            }
        }
        if (!confirmEach && improved) {
            // One real re-route for the whole sweep's worth of moves.
            const routing = routeDiagram(layout, options, current);
            const confirmed = new ParallelField(layout, routing);
            if (confirmed.total(floor) > sweepTotal + 1e-6) {
                // The approximation misled it: do it move by move.
                current = sweepStart;
                return arrangeFlows(layout, options, existing, tuning, true);
            }
            latest = routing;
            field = confirmed;
            drawn.clear();
        }
        if (!improved) {
            break;
        }
    }

    const changed = new Map<string, RouteOverridePoints>();
    movedIds.forEach(id => {
        const points = current.get(id);
        if (points) {
            changed.set(id, points);
        }
    });
    return {
        overrides: changed,
        before: Math.round(beforeTotal),
        after: Math.round(field.total(floor)),
        pairsBefore: start.pairs,
        pairsAfter: field.parallel(threshold).pairs,
        moved: movedIds.size,
        trials
    };
}
