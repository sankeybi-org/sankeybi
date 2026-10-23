/**
 * Arrange nodes: logical placement.
 *
 * The crossing count is a weak proxy for how a diagram reads: a layout with fewer crossings can
 * still paint more overlap, and a diagram with no crossings can still gain a lot from better
 * placement. The quality comes from where the order is drawn, not from a crossing search. So
 * this arranger drops the crossing objective altogether (crossings are still counted, but only
 * to be reported) and spends everything on logical position instead.
 *
 * What it shares with `layeredModel.ts`, deliberately: the stage axis, the longest-path
 * layering, the rule that a corridor only advances a stage if it travels along one, the
 * terminal rule for single-port nodes, the drawn-extent measurement, the banished row and the
 * unbiased overlap resolver are all imported, not forked. They are settled and mirrored for
 * vertical diagrams, and re-deriving them here would only let the two drift. What is new is
 * steps 5 and 6 below.
 *
 * The method. It is described left to right and written in stage/order terms throughout, so it
 * mirrors for the other three directions.
 *
 * 1. Flow direction: `axisOf` / `senseOf`.
 * 2. Columns from the steps required: `topologicalStages`.
 * 3. Rows from the most crowded column: `spanOf`, counting nodes rather than the packed extent,
 *    with the extra rows at the ends added outside the body by `banishRuled`.
 * 4. North/South terminals to the top or bottom row: `terminalRulesOf` and `banishRuled`.
 *    They stand one half-column slot out from the node they hang off (`BANISH_STEP`).
 * 5. The order within a column: `orderLayers`, the fixed point of "every node sits at the
 *    weighted mean of everything it connects to", the weight falling off as the connection
 *    reaches further across the diagram. That puts nodes feeding the same place next to each
 *    other. It is the same iteration as the closed-form answer: unpinned, the minimiser of that
 *    quadratic is the Fiedler vector of the weighted Laplacian, and repeated averaging is power
 *    iteration toward it.
 * 6. Where the columns sit: `place`. The first and last columns are spread evenly, then one
 *    sweep in flow order puts each middle node at the mean of its incoming flows, with the
 *    drawn extents parted afterwards.
 *
 * Even first, displace second. Packing each layer in proportion to what its entries carry gives
 * one uniform gap but uneven centres, and pins the first entry's leading edge to the top of the
 * grid, so a fat node at the top of one layer puts its centre further in than a thin one beside
 * it and the edges read ragged. Here every centre starts evenly spaced and only a real
 * collision of drawn extents moves anything, which is `resolve`'s job.
 *
 * Nothing in the ordering looks at a value. The weights in step 5 are purely topological (how
 * many stages a connection reaches across), so the arrangement cannot change when a slicer
 * changes the numbers; ordering by throughput would draw two different diagrams for the same
 * corridors. Step 6 does weight its mean by what a corridor carries, which moves coordinates,
 * never the order, and `VALUE_WEIGHTING` turns it off.
 */

import { axisOf, senseOf } from "./flowAxis";
import { Corridor, FlowAxis, FlowSense, Port } from "./model";
import { NodePositions } from "./positions";
import {
    banishRuled, biasOf, buildModel, countCrossings, holdAuthoredOrder, Model, OrderInput, OrderResult,
    resolve, snap, Vertex
} from "./layeredModel";

/**
 * How much room an entry is given, as a share of what it is: a node's extent is counted at
 * 125% and a pass-through lane's at 105%, so a column's total is
 * `1.25 x sum(nodes) + 1.05 x sum(lanes)`, and the busiest column's total is the extent the
 * diagram has to fit.
 *
 * This replaces a flat quarter-row between every pair of neighbours, which charged a hairline
 * lane exactly what it charged a node: a column of many lanes would ask for far more rows than
 * the span holds before a node was counted, and the resolver would pay for it by throwing real
 * nodes far outside the span.
 *
 * The allowance is part of the extent, so two neighbours are parted when
 * `|xi - xj| < (ei' + ej') / 2` with `e' = allowance x extent`, and the gap handed to `resolve`
 * is 0. An allowance of 1 and 1 turns this off, and then `CLEARANCE` applies.
 *
 * These are visual tuning dials, not measured values.
 */
const NODE_ALLOWANCE = 1.25;
const LANE_ALLOWANCE = 1.05;

/**
 * The last column keeps the first column's pitch: with fewer entries than the first column it
 * is spread as though it had as many, its entries in the middle slots, so a first column of 7
 * and a last of 5 gets a blank at the top and at the bottom. Otherwise it would be stretched
 * flush across the whole span whatever its count, which puts a pair of sinks in opposite
 * corners. Off, the last column is spread flush.
 */
const MATCH_FIRST_COLUMN = true;

/**
 * The flat gap between two drawn edges, in grid units along the ordering axis: the whole of
 * spacing before the allowances, and still what a port's own rule keeps clear whatever the
 * packing does. With the allowances on, the packing gap is 0, and a port that wanted a quarter
 * row clear would otherwise stand on its feeder.
 */
const CLEARANCE = 0.25;

/**
 * How fast a connection's pull falls off with the distance it reaches, as
 * `1 / max(1, stages) ^ DECAY`.
 *
 * 2 makes a neighbour four times the pull of a node two columns away. 1 is gentler and lets
 * distant structure speak; 0 ignores distance altogether, which is the null hypothesis for the
 * whole idea.
 *
 * `max(1, ...)` gives a corridor whose two ends share a stage the same pull as an adjacent one
 * rather than an infinite one. Those corridors exist (a South->North corridor drops a row
 * without advancing a column). `layeredModel.ts` drops them from its model entirely, since
 * there is nothing to order when both ends share a layer; here they pull their two ends
 * together, which is what they mean.
 */
const ORDER_DECAY = 2;

/**
 * The same falloff for step 6's placement mean, and it is deliberately 0.
 *
 * There are two dials rather than one, because the two steps are not asking the same question.
 * The order is a topological statement and a distant connection says less about it than a near
 * one. A node's position is the mean of what feeds it, and a flow does not feed it less for
 * having come further: with the ordering's falloff, a node fed once from an adjacent column and
 * heavily from three columns back would be dragged onto the near feeder because the one
 * adjacent corridor out-weighs the much larger distant one; flat, it sits between the two,
 * which is where it belongs.
 */
const PLACE_DECAY = 0;

/** Passes of the ordering fixed point. It stops early when the order settles. */
const ORDER_PASSES = 60;

/**
 * How much a corridor's size counts in step 6's mean: 1 weights by what it carries, 0 by
 * topology alone. Coordinates only, never the order.
 */
const VALUE_WEIGHTING = 1;

/** Smallest room any entry gets, so a hairline flow still parts its neighbours. */
const MIN_EXTENT = 0.05;

/**
 * How far apart the slots are for a banished terminal, in stages: half a column from the node
 * it hangs off, another half for each one after it.
 *
 * One number serves both a whole-stage offset and a centred half-stage split, which would
 * otherwise disagree and put a vertical branch half a column either side of the wrong column.
 * See `placeBanished`.
 */
const BANISH_STEP = 0.5;

/**
 * How far a node stands clear of a feeder that a longer flow has to get past.
 *
 * Sitting level with the node that feeds you is the right answer when that is the only thing
 * feeding you, or when everything feeding you is the same distance back: the band runs
 * straight in. It is the wrong answer the moment something feeds you from further back,
 * because that band now has to pass the nearer node to reach you, and level leaves it nowhere
 * to pass. A node fed from one column back at one row and from three columns back at another
 * would otherwise make the distant band cross the near feeder to arrive a quarter row above
 * it.
 *
 * It is half a row: the smaller of half a row or a full row, and the one that costs least
 * elsewhere.
 */
const PASSING_CLEARANCE = 0.5;

export interface ArrangeNodesInput extends OrderInput {
    /**
     * A flat gap between two drawn edges, in grid units. Unset: 0 with the allowances on,
     * `CLEARANCE` with them off.
     */
    clearance?: number;
    /** A node's extent is counted at this multiple; 1 with `laneAllowance` 1 is off. */
    nodeAllowance?: number;
    /** The same for a pass-through lane. */
    laneAllowance?: number;
    /**
     * Spread the last column on the first column's pitch, blanks shared top and bottom, rather
     * than flush across the whole span. Default on.
     */
    matchFirstColumn?: boolean;
    /** The exponent of the distance falloff in the ordering (step 5). */
    orderDecay?: number;
    /** The same for the placement mean (step 6). A separate dial for a separate question. */
    placeDecay?: number;
    /** Passes of the ordering fixed point. */
    orderPasses?: number;
    /** 1 weights step 6's mean by what a corridor carries, 0 by topology alone. */
    valueWeighting?: number;
    /** Stages between a banished terminal's slots. */
    banishStep?: number;
    /** How far clear of a nearer feeder a longer flow's target stands. */
    passClearance?: number;
}

/**
 * One pull of the logical model.
 *
 * Unlike `layeredModel.ts`'s `Segment` this is not restricted to adjacent layers: a corridor
 * spanning three columns pulls its two real ends together directly, at a ninth of a neighbour's
 * weight, rather than only through the chain of lanes standing in for it. The lanes are linked
 * too (they still have to be ordered, because the packing reserves room for them) but by their
 * own chain.
 */
interface Link {
    a: string;
    b: string;
    /** The ordering weight: distance only, never a value. */
    orderWeight: number;
    /** The placement weight, under its own falloff. */
    placeWeight: number;
    /** What the corridor carries, for step 6's mean only. */
    value: number;
    /**
     * A link of a lane chain rather than a corridor between two nodes.
     *
     * A spanning corridor is in here twice over: once as the direct pull between its two real
     * ends, and once as the chain of lanes standing in for it. Both are wanted, but not by the same
     * vertex. A real node must read only the direct links, or a corridor that spans would vote
     * twice, the second vote cast at a lane's position rather than at the neighbour's. A lane reads
     * only its chain, which is all it is ever in.
     */
    chain: boolean;
    /**
     * Which side of its source a port normal puts the target: +1 for the larger coordinate, -1 for
     * the smaller, 0 for no opinion. This is `layeredModel.ts`'s `biasOf`, shared rather than
     * restated.
     *
     * A corridor arriving on North comes from above, so its target belongs below its source; one
     * leaving South goes downward, so its source belongs above its target. Where the two ports
     * disagree, neither is believed. `a` is always the corridor's source and `b` its target, so the
     * sign can be oriented per end.
     */
    bias: number;
}

export function arrangeNodes(input: ArrangeNodesInput): OrderResult {
    const axis = input.axis ?? axisOf(input.corridors);
    const sense = input.sense ?? senseOf(input.corridors, axis);
    const model = buildModel(input, axis, sense);
    const before = countCrossings(model);

    const nodeAllowance = input.nodeAllowance ?? NODE_ALLOWANCE;
    const laneAllowance = input.laneAllowance ?? LANE_ALLOWANCE;
    const proportional = nodeAllowance !== 1 || laneAllowance !== 1;
    // The allowance is the spacing when it is on, so the flat gap goes with it.
    const clearance = input.clearance ?? (proportional ? 0 : CLEARANCE);
    const span = spanOf(model);
    const links = linksOf(input.corridors, model,
        input.orderDecay ?? ORDER_DECAY, input.placeDecay ?? PLACE_DECAY);
    const extentOf = extentScaleOf(model, span, clearance,
        vertex => (vertex.node ? nodeAllowance : laneAllowance), proportional);

    orderLayers(model, links, span, input.orderPasses ?? ORDER_PASSES);
    // Reported, not optimised: a diagram that looks tangled is worth being able to put a number
    // on, and this is the only place that number still appears.
    const after = countCrossings(model);

    const positions = place(model, input, {
        span,
        clearance,
        portClearance: input.clearance ?? CLEARANCE,
        matchFirstColumn: input.matchFirstColumn ?? MATCH_FIRST_COLUMN,
        links,
        extentOf,
        valueWeighting: input.valueWeighting ?? VALUE_WEIGHTING,
        banishStep: input.banishStep ?? BANISH_STEP,
        passClearance: input.passClearance ?? PASSING_CLEARANCE
    });

    let moved = 0;
    positions.forEach((placed, id) => {
        const node = input.graph.nodes.get(id);
        if (!node) {
            return;
        }
        if (Math.abs((node.column ?? 1) - placed.column) > 1e-6
            || Math.abs((node.row ?? 1) - placed.row) > 1e-6) {
            moved++;
        }
    });

    return {
        positions,
        axis,
        sense,
        crossingsBefore: before,
        crossingsAfter: after,
        moved,
        layers: model.layers.size,
        dummies: model.dummies
    };
}

/**
 * Step 3: how many rows the grid needs: the most crowded column's node count, less one,
 * because a span is the distance between the first centre and the last.
 *
 * This is a node count, deliberately not the packed extent `layeredModel.ts` sizes its span
 * from: the extents come back in `extentScaleOf`, which is where "if something is big enough
 * then it needs to be moved" lives.
 *
 * Lanes are not counted. A band merely passing a column does need room, and gets it in the
 * resolver, but giving it a whole row of its own would blow the grid out for something the
 * reader cannot see. Nodes the terminal rule banishes are not counted either, because they
 * leave the body; `banishRuled` puts them outside it.
 */
function spanOf(model: Model): number {
    let most = 1;
    model.keys.forEach(key => {
        const nodes = (model.layers.get(key) as Vertex[])
            .filter(vertex => vertex.node && !vertex.edge);
        most = Math.max(most, nodes.length);
    });
    return Math.max(1, most - 1);
}

/**
 * The value-to-grid scale, solved from the column that is hardest to fit.
 *
 * Every entry's drawn extent has to be in the same units as the span before the resolver can
 * tell a collision from a clearance, and there are no pixels here (turning a grid into pixels
 * is layout's job, and a scale read off one axis's pitch can be badly out). So the scale is
 * solved from the arrangement itself: the largest one under which every layer's entries, lanes
 * included, still fit the span with the minimum clearance between them.
 *
 * That makes the busiest layer exactly full, which is the honest statement (it is the column
 * that sets the scale in the drawing too), and it leaves the second sweep something to do.
 * Every other layer has slack and stays on its even centres.
 */
function extentScaleOf(
    model: Model,
    span: number,
    clearance: number,
    allowance: (vertex: Vertex) => number,
    proportional: boolean
): (vertex: Vertex) => number {
    let scale = Number.POSITIVE_INFINITY;
    model.keys.forEach(key => {
        const entries = (model.layers.get(key) as Vertex[]).filter(vertex => !vertex.edge);
        const total = entries.reduce(
            (sum, vertex) => sum + (proportional ? allowance(vertex) : 1) * Math.max(0, vertex.extent), 0);
        if (total <= 0 || entries.length === 0) {
            return;
        }
        const gaps = (entries.length - 1) * clearance;
        const room = Math.max(0, span - gaps);
        if (!proportional) {
            scale = Math.min(scale, room / total);
            return;
        }
        // Allowances on: what the column takes at scale `s` is the sum of each entry's allowed extent,
        // floors included. That is monotone in `s`, so the largest scale that fits is found by
        // bisection. Without the floors it is `room / total` exactly; with them a column of hairline
        // lanes cannot claim to fit by shrinking below what each is held at anyway.
        const takes = (s: number): number => gaps + entries.reduce(
            (sum, vertex) =>
                sum + Math.max(MIN_EXTENT, allowance(vertex) * Math.max(0, vertex.extent) * s), 0);
        let best = 0;
        if (takes(0) <= span) {
            let lo = 0;
            let hi = room / total;
            for (let i = 0; i < 40; i++) {
                const mid = (lo + hi) / 2;
                if (takes(mid) <= span) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            best = lo;
        }
        scale = Math.min(scale, best);
    });
    if (!Number.isFinite(scale) || scale <= 0) {
        // Nothing carries anything, or no layer has room to spare: every entry falls back to the floor
        // and the even centres carry the arrangement.
        scale = 0;
    }
    return (vertex: Vertex): number => proportional
        ? Math.max(MIN_EXTENT, allowance(vertex) * Math.max(0, vertex.extent) * scale)
        : Math.max(MIN_EXTENT, vertex.extent * scale);
}

/**
 * Every pull in the model: the real corridors between real nodes, weighted by how far across
 * the diagram they reach, plus the lane chains that stand in for the spanning ones.
 *
 * A lane chain is weighted 1. A lane is not a logical relationship, it is a reservation, so it
 * is pulled into line by its own neighbours and takes no part in step 6's forward sweep.
 */
function linksOf(corridors: Corridor[], model: Model, orderDecay: number, placeDecay: number): Link[] {
    const links: Link[] = [];
    const layerOf = model.frame.layerOf;
    corridors.forEach(corridor => {
        if (corridor.isSelfLoop) {
            return;
        }
        const a = layerOf.get(corridor.source);
        const b = layerOf.get(corridor.target);
        if (a === undefined || b === undefined) {
            return;
        }
        const stages = Math.max(1, Math.abs(a - b));
        links.push({
            a: corridor.source,
            b: corridor.target,
            orderWeight: 1 / Math.pow(stages, orderDecay),
            placeWeight: 1 / Math.pow(stages, placeDecay),
            value: corridor.value,
            chain: false,
            bias: biasOf(corridor, model.frame.orderAxis)
        });
    });
    // The lanes, along the chain `buildModel` already built for them.
    model.segments.forEach(segment => {
        const upper = model.vertices.get(segment.upper);
        const lower = model.vertices.get(segment.lower);
        if (!upper || !lower || (upper.node && lower.node)) {
            return; // two real nodes: their own corridor has said it already
        }
        links.push({
            a: segment.upper, b: segment.lower, orderWeight: 1, placeWeight: 1,
            value: segment.value, chain: true, bias: 0
        });
    });
    return links;
}

/** Even centres across the span, in the order given. */
function spread(list: Vertex[], span: number, at: Map<string, number>): void {
    if (list.length === 0) {
        return;
    }
    if (list.length === 1) {
        at.set(list[0].id, span / 2);
        return;
    }
    const step = span / (list.length - 1);
    list.forEach((vertex, i) => at.set(vertex.id, i * step));
}

/**
 * Even centres on the pitch a column of `slots` entries would have across the span, with the
 * entries standing in the middle of those slots: a column of 5 under a first column of 7 keeps
 * the first column's pitch and one blank slot at the top and at the bottom; an odd difference
 * gives half a slot each side. A column with as many as `slots` (or more) is simply spread, as
 * `spread`.
 */
function spreadAsSlots(list: Vertex[], span: number, slots: number, at: Map<string, number>): void {
    if (list.length === 0) {
        return;
    }
    if (slots < 2 || list.length >= slots) {
        spread(list, span, at);
        return;
    }
    const step = span / (slots - 1);
    const lead = (slots - list.length) / 2;
    list.forEach((vertex, i) => at.set(vertex.id, (lead + i) * step));
}

/**
 * Step 5: the order within each column.
 *
 * The fixed point of "every vertex sits at the weighted mean of everything it connects to".
 * Each pass averages, re-sorts every layer by the result, and re-spreads it evenly across the
 * span. The re-spread is what stops the whole diagram collapsing onto one point (the
 * degenerate minimiser of the same quadratic) and it keeps every pass reading positions on one
 * scale.
 *
 * Only the order is taken out of this. The coordinates are thrown away and step 6 computes its
 * own, so the re-spread costs nothing.
 *
 * It stops when the order stops changing, which is the only thing it is being asked for. A
 * pinned node is frozen where the author dropped it, and the terminal rule outranks the mean: a
 * single-port node is held at its end of the layer exactly as `layeredModel.ts` holds it,
 * because the rule is about what the diagram means and not something a better arrangement
 * should be able to buy. A tie goes to the node id, which keeps the arrangement independent of
 * the order the rows arrived in (`buildModel` says why that matters).
 */
function orderLayers(model: Model, links: Link[], span: number, passes: number): void {
    const at = new Map<string, number>();
    const start = (): void => {
        model.keys.forEach(key => {
            const all = model.layers.get(key) as Vertex[];
            spread(all.filter(vertex => !vertex.edge), span, at);
            all.forEach(vertex => {
                // A banished node still needs somewhere to stand while the others settle around it, and it
                // belongs past them on the side its rule names. `banishRuled` has the last word.
                if (vertex.edge) {
                    at.set(vertex.id, vertex.edge === "min" ? -span : 2 * span);
                }
                if (vertex.pinned && vertex.fixedAt !== undefined) {
                    at.set(vertex.id, vertex.fixedAt);
                }
            });
        });
    };
    start();

    const pulls = new Map<string, { weight: number; total: number }>();
    const prime = (id: string): { weight: number; total: number } => {
        let entry = pulls.get(id);
        if (!entry) {
            entry = { weight: 0, total: 0 };
            pulls.set(id, entry);
        }
        return entry;
    };

    let fingerprint = fingerprintOf(model);
    for (let pass = 0; pass < passes; pass++) {
        pulls.clear();
        links.forEach(link => {
            const from = at.get(link.a);
            const to = at.get(link.b);
            if (from === undefined || to === undefined) {
                return;
            }
            const pull = (id: string, towards: number): void => {
                // A node reads corridors, a lane reads its chain: see `Link.chain`.
                if (link.chain && model.vertices.get(id)?.node) {
                    return;
                }
                const entry = prime(id);
                entry.weight += link.orderWeight;
                entry.total += link.orderWeight * towards;
            };
            pull(link.a, to);
            pull(link.b, from);
        });
        model.vertices.forEach((vertex, id) => {
            if (vertex.pinned || vertex.edge) {
                return;
            }
            const pull = pulls.get(id);
            if (pull && pull.weight > 0) {
                at.set(id, pull.total / pull.weight);
            }
        });

        model.keys.forEach(key => {
            const all = model.layers.get(key) as Vertex[];
            const rank = (vertex: Vertex): number =>
                vertex.edge === "min" ? -1 : vertex.edge === "max" ? 1 : 0;
            const sorted = all.slice().sort((x, y) => (rank(x) - rank(y))
                || ((at.get(x.id) ?? 0) - (at.get(y.id) ?? 0))
                || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
            // Held to the author's order here too, and not only in step 6: step 6 returns early for the
            // first column, which keeps exactly the order this fixed point gave it, so a projection
            // downstream never reaches it. The spread below then follows the held order, which puts a
            // group's members at consecutive coordinates rather than merely in consecutive slots. It is
            // idempotent, so the fingerprint below still settles.
            const held = holdAuthoredOrder(sorted);
            model.layers.set(key, held);
            // A layer holding a hand-placed node is not re-spread: the pinned node is a wall and an even
            // spread would walk the others through it. Everything else in that layer keeps what the mean
            // gave it, and step 6's resolver parts them around the wall.
            if (!held.some(vertex => vertex.pinned)) {
                spread(held.filter(vertex => !vertex.edge), span, at);
            }
        });

        const next = fingerprintOf(model);
        if (next === fingerprint) {
            break;
        }
        fingerprint = next;
    }
}

/**
 * Where a banished terminal stands along the stage axis. There are two cases, and they are
 * genuinely different.
 *
 * A terminal fed by a corridor that advances the stage (`East->South`, `East->North`) steps out
 * from the node it hangs off: half a column away, and another half for each one after it in the
 * same place. The flow travels, so the terminal belongs past its source.
 *
 * A vertical tree, reached only by corridors that advance nothing (a `South->North` drop on a
 * left-to-right diagram), hangs directly under the node it comes from instead, because the flow
 * does not travel: it drops. So the anchor's own column is the centre, and the members are
 * spread symmetrically about it, half a column apart:
 *
 * | members | offsets from the anchor's column |
 * |---|---|
 * | 1 | 0 |
 * | 2 | -0.25, +0.25 |
 * | 3 | -0.5, 0, +0.5 |
 *
 * This is `(i - (n - 1) / 2) x BANISH_STEP`: always half a column between neighbours, always
 * centred on the anchor.
 *
 * The anchor is the nearest node that stays in the body. It is looked for through the
 * non-advancing corridors first, and that search also decides which of the two rules applies:
 * found there, this is a tree and the whole branch centres on one column however deep it runs;
 * not found, the terminal hangs off a travelling corridor and steps out instead.
 *
 * The slots are per side. Two terminals banished to opposite ends of the diagram cannot
 * collide, so they both take the first slot.
 *
 * It runs after `banishRuled`, which keeps the last word on the ordering axis (the row the
 * branch stands on) and whose own `STAGE_STAGGER` is simply overwritten here. A stage the author
 * wrote is never touched.
 */
function placeBanished(
    model: Model,
    input: ArrangeNodesInput,
    at: Map<string, number>,
    stageAt: Map<string, number>,
    step: number
): void {
    if (model.frame.authored) {
        return;
    }
    const stageAxis = model.frame.stageAxis;
    const alongStage = (port: Port): boolean => stageAxis === "column"
        ? (port === "East" || port === "West")
        : (port === "North" || port === "South");

    /**
     * Neighbours, whichever way the corridor runs; `verticalOnly` drops the travelling ones.
     */
    const neighboursOf = (verticalOnly: boolean): Map<string, string[]> => {
        const map = new Map<string, string[]>();
        input.corridors.forEach(corridor => {
            if (corridor.isSelfLoop) {
                return;
            }
            if (verticalOnly
                && (alongStage(corridor.sourcePort) || alongStage(corridor.targetPort))) {
                return;
            }
            const join = (from: string, to: string): void => {
                const list = map.get(from);
                if (list) {
                    list.push(to);
                } else {
                    map.set(from, [to]);
                }
            };
            join(corridor.source, corridor.target);
            join(corridor.target, corridor.source);
        });
        // Sorted, so which anchor is found at equal depth cannot depend on the order the rows arrived
        // in.
        map.forEach(list => list.sort());
        return map;
    };
    const vertical = neighboursOf(true);
    const every = neighboursOf(false);

    const anchorVia = (neighbours: Map<string, string[]>, from: string): string | undefined => {
        const seen = new Set([from]);
        const queue = [from];
        while (queue.length > 0) {
            const here = queue.shift() as string;
            for (const other of neighbours.get(here) ?? []) {
                if (seen.has(other)) {
                    continue;
                }
                seen.add(other);
                const vertex = model.vertices.get(other);
                if (vertex && vertex.node && !vertex.edge) {
                    return other;
                }
                queue.push(other);
            }
        }
        return undefined;
    };

    interface Group { members: Vertex[]; stage: number; direction: number; tree: boolean }
    const groups = new Map<string, Group>();
    model.vertices.forEach(vertex => {
        if (!vertex.edge || !vertex.node || vertex.pinned) {
            return;
        }
        // The vertical search first: finding an anchor that way is what makes this a tree.
        let tree = true;
        let anchor = anchorVia(vertical, vertex.id);
        if (anchor === undefined) {
            tree = false;
            anchor = anchorVia(every, vertex.id);
        }
        if (anchor === undefined) {
            return;
        }
        // The drawn stage, not the layer's: a tree hangs under where its anchor actually ends up,
        // including when `placeTurns` has moved it.
        const stage = stageAt.get(anchor) ?? model.frame.stageCoordinateOf.get(anchor);
        if (stage === undefined) {
            return;
        }
        let receives = false;
        input.corridors.forEach(corridor => {
            if (!corridor.isSelfLoop && corridor.target === vertex.id) {
                receives = true;
            }
        });
        const direction = receives ? 1 : -1;
        const key = tree
            ? `tree|${anchor}|${vertex.edge}`
            : `step|${anchor}|${direction}|${vertex.edge}`;
        const group = groups.get(key);
        if (group) {
            group.members.push(vertex);
        } else {
            groups.set(key, { members: [vertex], stage, direction, tree });
        }
    });

    // The banished lane sits half a stage clear of the body, and no further, centre to centre.
    // `banishRuled` puts it at the body's painted edge, less `GAP`, less the widest banished node's
    // half-extent, so the node's own width would push the whole lane out and the terminals would
    // land a full column clear of the body. Measured from the outermost body node's centre, which
    // is what the gap between two columns looks like, half a stage is half a stage whatever the
    // terminal carries.
    //
    // There is one lane per side, which is what "a row of its own" means: a per-node clearance
    // would float the fattest terminal further out than the rest.
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    model.vertices.forEach(vertex => {
        const where = at.get(vertex.id);
        if (vertex.node && !vertex.edge && where !== undefined) {
            lowest = Math.min(lowest, where);
            highest = Math.max(highest, where);
        }
    });
    if (Number.isFinite(lowest) && Number.isFinite(highest)) {
        (["min", "max"] as const).forEach(side => {
            const lane = side === "min" ? lowest - step : highest + step;
            model.vertices.forEach(vertex => {
                if (vertex.edge === side && vertex.node && !vertex.pinned) {
                    at.set(vertex.id, lane);
                }
            });
        });
    }

    groups.forEach(group => {
        // In the order the ordering axis already gave them, so the slots do not reshuffle a branch the
        // rest of the pass has arranged.
        const members = group.members.slice().sort((x, y) =>
            ((at.get(x.id) ?? 0) - (at.get(y.id) ?? 0)) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
        if (group.tree) {
            const first = -(members.length - 1) / 2;
            members.forEach((vertex, i) => stageAt.set(vertex.id, group.stage + (first + i) * step));
        } else {
            members.forEach((vertex, i) =>
                stageAt.set(vertex.id, group.stage + group.direction * step * (i + 1)));
        }
    });
}

/**
 * A node reached only by a 90-degree turn stands half a column from what feeds it, not a whole
 * one.
 *
 * A corridor leaving `East` and arriving `North` crosses into the next stage (`topologicalStages`
 * counts it, and rightly, because the flow does travel), but it turns a right angle on the way,
 * so it covers half the ground a straight `East->West` corridor does. Drawing it a full column
 * wide leaves a gap the band does not fill.
 *
 * This is the same half-column that `placeBanished` gives a terminal hanging off a travelling
 * corridor: it is one rule about what a right angle is worth. `BANISH_STEP` is shared between
 * them.
 *
 * It applies only where every stage-advancing corridor into the node turns. One straight feeder
 * and the node is a full stage on, because that corridor really does cross the whole gap; the
 * turn then arrives alongside it. The stage is taken from the latest of the feeders, so a node
 * fed from two different stages clears them both.
 *
 * It moves where the node is drawn, never the layering. The node is still topologically one
 * stage on: it keeps its layer, its slot in the order and its place in the forward sweep, and
 * only the stage coordinate written out changes. Nodes are visited in stage order so a chain of
 * turns accumulates rather than each one measuring from a stale position.
 *
 * Vertical corridors, advancing nothing, are not turns and take no part here; a tree of those
 * hangs under its anchor (`placeBanished`).
 */
function placeTurns(
    model: Model,
    input: ArrangeNodesInput,
    stageAt: Map<string, number>,
    step: number
): void {
    if (model.frame.authored) {
        return; // a stage the author wrote is never this pass's to move
    }
    const stageAxis = model.frame.stageAxis;
    const alongStage = (port: Port): boolean => stageAxis === "column"
        ? (port === "East" || port === "West")
        : (port === "North" || port === "South");

    const incoming = new Map<string, Corridor[]>();
    input.corridors.forEach(corridor => {
        if (corridor.isSelfLoop) {
            return;
        }
        const list = incoming.get(corridor.target);
        if (list) {
            list.push(corridor);
        } else {
            incoming.set(corridor.target, [corridor]);
        }
    });

    const ordered = Array.from(model.vertices.values())
        .filter(vertex => vertex.node && !vertex.edge && !vertex.pinned)
        .sort((x, y) => ((stageAt.get(x.id) ?? 0) - (stageAt.get(y.id) ?? 0))
            || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    ordered.forEach(vertex => {
        const advancing = (incoming.get(vertex.id) ?? []).filter(corridor =>
            alongStage(corridor.sourcePort) || alongStage(corridor.targetPort));
        if (advancing.length === 0) {
            return;
        }
        const straight = advancing.some(corridor =>
            alongStage(corridor.sourcePort) && alongStage(corridor.targetPort));
        if (straight) {
            return;
        }
        let latest = Number.NEGATIVE_INFINITY;
        advancing.forEach(corridor => {
            const there = stageAt.get(corridor.source);
            if (there !== undefined) {
                latest = Math.max(latest, there);
            }
        });
        if (Number.isFinite(latest)) {
            stageAt.set(vertex.id, latest + step);
        }
    });
}

/** Every layer's order as one string, only ever compared with another of its own. */
function fingerprintOf(model: Model): string {
    return model.keys
        .map(key => (model.layers.get(key) as Vertex[]).map(vertex => vertex.id).join(","))
        .join("|");
}

interface PlaceOptions {
    span: number;
    clearance: number;
    /** What a port's own rule keeps clear, independent of how entries are packed. */
    portClearance: number;
    matchFirstColumn: boolean;
    links: Link[];
    extentOf: (vertex: Vertex) => number;
    valueWeighting: number;
    banishStep: number;
    passClearance: number;
}

/**
 * Step 6: where the columns sit, with the order held.
 *
 * 6.1: the first and last columns are spread evenly across the span. They are the two the flow
 * cannot position, and the two the eye reads as the diagram's edges.
 *
 * 6.2: then one sweep in flow order. Each middle node goes to the mean of the nodes its
 * incoming flows come from, nearest columns weighted most, and the layer's drawn extents are
 * parted before the next layer reads it. It runs forward only, which is what makes one pass
 * exact: every position a layer depends on is final before that layer is computed.
 *
 * A node in a middle column with nothing upstream (a source that appears mid-diagram) falls
 * back to its outgoing flows, read at the even centres the ordering left them on.
 */
function place(model: Model, input: ArrangeNodesInput, options: PlaceOptions): NodePositions {
    const {
        span, clearance, portClearance, matchFirstColumn, links, extentOf, valueWeighting,
        banishStep, passClearance
    } = options;
    const at = new Map<string, number>();
    const bodies = new Map<number, Vertex[]>();

    model.keys.forEach(key => {
        const all = model.layers.get(key) as Vertex[];
        const body = all.filter(vertex => !vertex.edge);
        bodies.set(key, body);
        spread(body, span, at);
        all.forEach(vertex => {
            if (vertex.edge) {
                at.set(vertex.id, span / 2);
            }
            if (vertex.pinned && vertex.fixedAt !== undefined) {
                at.set(vertex.id, vertex.fixedAt);
            }
        });
    });

    /** Which layer each vertex lives in: a lane's is its own, not its node's. */
    const layerOfVertex = new Map<string, number>();
    model.keys.forEach(key =>
        (model.layers.get(key) as Vertex[]).forEach(vertex => layerOfVertex.set(vertex.id, key)));

    // Every link indexed by each end, so a layer can ask what pulls on it.
    const touching = new Map<string, { other: string; weight: number; value: number; bias: number }[]>();
    links.forEach(link => {
        // Oriented per end. `bias` is stated as "which side of its source the target belongs", so the
        // target wants `+bias` of clearance from the source and the source wants `-bias` from the
        // target.
        const add = (id: string, other: string, bias: number): void => {
            if (link.chain && model.vertices.get(id)?.node) {
                return; // a node reads corridors, a lane reads its chain
            }
            const entry = { other, weight: link.placeWeight, value: link.value, bias };
            const list = touching.get(id);
            if (list) {
                list.push(entry);
            } else {
                touching.set(id, [entry]);
            }
        };
        add(link.a, link.b, -link.bias);
        add(link.b, link.a, link.bias);
    });

    /**
     * Clear of the feeders a longer flow has to pass. See `PASSING_CLEARANCE`. The node is pushed
     * to the side the distant flow comes from, because that is the side it can reach without
     * crossing the nearer feeder at all; pushed the other way it would still cross, just with room
     * to do it in.
     *
     * It applies only where the feeders are at mixed distances. Everything one stage back and level
     * is exactly right; everything three stages back and level is also right, because they all
     * pass the same gap together.
     */
    const passing = (vertex: Vertex, key: number, want: number): number => {
        const feeders: { other: string; value: number; back: number; bias: number }[] = [];
        (touching.get(vertex.id) ?? []).forEach(entry => {
            const there = layerOfVertex.get(entry.other);
            if (there !== undefined && there < key) {
                feeders.push({
                    other: entry.other, value: entry.value, back: key - there, bias: entry.bias
                });
            }
        });
        if (feeders.length === 0) {
            return want;
        }
        const nearest = Math.min(...feeders.map(f => f.back));
        const distant = feeders.filter(f => f.back > nearest);
        if (distant.length === 0) {
            return want;
        }
        let weight = 0;
        let total = 0;
        distant.forEach(f => {
            const where = at.get(f.other);
            if (where !== undefined) {
                const w = Math.max(1e-6, f.value);
                weight += w;
                total += w * where;
            }
        });
        if (weight <= 0) {
            return want;
        }
        const from = total / weight;
        // Grouped by neighbour, not by corridor. Two nodes can be joined both ways round, and then
        // the pair appears twice with opposite biases, because a bias is stated relative to a
        // corridor's own source. Taken one corridor at a time, the backwards one would let a push
        // through that the forwards one forbids.
        const nearby = new Map<string, { at: number; biases: number[] }>();
        feeders.filter(f => f.back === nearest).forEach(f => {
            const here = at.get(f.other);
            if (here === undefined) {
                return;
            }
            const entry = nearby.get(f.other) ?? { at: here, biases: [] };
            entry.biases.push(f.bias);
            nearby.set(f.other, entry);
        });
        let out = want;
        nearby.forEach(near => {
            const side = Math.sign(from - near.at);
            if (side === 0) {
                return;
            }
            // A port normal outranks this. Where a corridor between these two says which side the target
            // belongs on, that is a statement about what the ports mean, and a passing lane does not get to
            // overrule it: it would only trade one crossing for another.
            if (near.biases.some(bias => bias !== 0 && bias !== side)) {
                return;
            }
            const floor = near.at + side * passClearance;
            out = side > 0 ? Math.max(out, floor) : Math.min(out, floor);
        });
        return out;
    };

    const first = model.keys[0];
    const last = model.keys[model.keys.length - 1];

    /** The slot step 5 gave each entry, so a tie in the sort below is settled. */
    const slotOf = new Map<string, number>();
    model.keys.forEach(key =>
        (model.layers.get(key) as Vertex[]).forEach((vertex, i) => slotOf.set(vertex.id, i)));

    /** The mean the entries on one side of a vertex ask it to sit at. */
    const meanOf = (vertex: Vertex, key: number, side: "before" | "after"): number | undefined => {
        let weight = 0;
        let total = 0;
        (touching.get(vertex.id) ?? []).forEach(entry => {
            const there = layerOfVertex.get(entry.other);
            if (there === undefined) {
                return;
            }
            if (side === "before" ? there >= key : there <= key) {
                return;
            }
            const where = at.get(entry.other);
            if (where === undefined) {
                return;
            }
            // Where the ports say this end belongs, not where the other end is. A corridor whose port
            // normal runs along this axis does not want its two ends level; it wants one clear of the other,
            // by the room the two of them take. An unbiased corridor asks for level. It is a pull, not a
            // constraint: it moves the mean, and the mean is then resolved like any other.
            const neighbour = model.vertices.get(entry.other);
            const clear = entry.bias === 0 || !neighbour ? 0
                : portClearance + (extentOf(vertex) + extentOf(neighbour)) / 2;
            const size = Math.max(1e-6, entry.value);
            const w = entry.weight * Math.pow(size, valueWeighting);
            weight += w;
            total += w * (where + entry.bias * clear);
        });
        return weight > 0 ? total / weight : undefined;
    };

    model.keys.forEach(key => {
        const body = bodies.get(key) as Vertex[];

        // The first column keeps the order step 5 gave it, evenly spread. It is the one layer with no
        // upstream to read, and it is the reason step 5 exists at all: the first column should be
        // optimally sorted by the algorithm first.
        if (key === first) {
            resolve(body, at, extentOf, clearance, vertex => vertex.pinned);
            return;
        }

        const wanted = new Map<string, number>();
        body.forEach(vertex => {
            const asked = vertex.pinned
                ? at.get(vertex.id)
                : (meanOf(vertex, key, "before") ?? meanOf(vertex, key, "after") ?? at.get(vertex.id));
            if (asked !== undefined) {
                wanted.set(vertex.id, vertex.pinned ? asked : passing(vertex, key, asked));
            }
        });

        // The order follows the mean, it does not override it.
        //
        // If step 5's order were held through step 6 by `resolve`, which only ever parts entries in the
        // order it is handed, the two steps could disagree, because they are not asking the same
        // question: step 5 pulls a vertex from both sides, step 6 reads only what flows into it. A node
        // with one inflow and several heavy outflows would be dragged up its column by step 5 while
        // step 6 never saw the outflows at all, and the drawing would put it above a node every mean
        // asks it to sit below. Sorting by the mean here makes the two incapable of disagreeing:
        // upstream is final before this layer is read, so the mean is well defined and the sort is
        // deterministic.
        //
        // It is then held to the author's own order. The mean decides everything the author did not,
        // which here is where each blank goes relative to the numbered groups, and which member of a
        // group comes first. `resolve` parts entries in the order it is handed, so the projection
        // reaches the coordinates as well as the slots: a group's members come out as one run, at one
        // clearance.
        const sorted = holdAuthoredOrder(body.slice().sort((x, y) =>
            ((wanted.get(x.id) ?? 0) - (wanted.get(y.id) ?? 0))
            || ((slotOf.get(x.id) ?? 0) - (slotOf.get(y.id) ?? 0))
            || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
        bodies.set(key, sorted);
        // Written back into the model, so the banished nodes, the output and anything else reading a
        // layer sees the order that was drawn. The banished entries keep their ends, as `buildModel`
        // put them.
        const all = model.layers.get(key) as Vertex[];
        model.layers.set(key, all.filter(vertex => vertex.edge === "min")
            .concat(sorted, all.filter(vertex => vertex.edge === "max")));

        if (key === last) {
            // The last column is spread evenly, in the order its inflows chose for it: 6.1's rule, with 6.2
            // deciding only the order. It is skipped where the author has pinned something in it, because
            // an even spread would walk the others through the wall.
            if (!sorted.some(vertex => vertex.pinned)) {
                // On the first column's pitch when there are fewer of them, so two or three sinks stand
                // together mid-height with the blank shared top and bottom, rather than in opposite corners.
                spreadAsSlots(sorted, span,
                    matchFirstColumn ? (bodies.get(first) as Vertex[]).length : 0, at);
            }
            // ...and then nudged off it where a longer flow needs to get past. The even spread is not a
            // mean, so nothing above has had a chance to apply the passing clearance here, and the last
            // column is exactly where it bites, because that is where the flows that have come furthest
            // arrive.
            sorted.forEach(vertex => {
                const now = at.get(vertex.id);
                if (!vertex.pinned && now !== undefined) {
                    at.set(vertex.id, passing(vertex, key, now));
                }
            });
        } else {
            sorted.forEach(vertex => {
                const asked = wanted.get(vertex.id);
                if (!vertex.pinned && asked !== undefined) {
                    at.set(vertex.id, asked);
                }
            });
        }
        resolve(sorted, at, extentOf, clearance, vertex => vertex.pinned);
    });

    // Step 4's other half: the banished terminals. `banishRuled` lifts them onto a row of their
    // own, clear of the body; `placeBanished` then says where along the stage axis each one stands.
    // One rule covers both the terminal hanging straight off a node and the vertical branch.
    const stageAt = new Map(model.frame.stageCoordinateOf);
    placeTurns(model, input, stageAt, banishStep);
    banishRuled(model, at, extentOf, stageAt);
    placeBanished(model, input, at, stageAt, banishStep);

    // The grid starts at 1: shift everything so the topmost real node does. Hand-placed nodes are
    // not shifted with it (they keep the coordinates they were dropped at), so they are left out of
    // the measurement too.
    let lowest = Number.POSITIVE_INFINITY;
    model.vertices.forEach(vertex => {
        const where = at.get(vertex.id);
        if (vertex.node && !vertex.pinned && where !== undefined) {
            lowest = Math.min(lowest, where - extentOf(vertex) / 2);
        }
    });
    const shift = Number.isFinite(lowest) ? 1 - lowest : 0;

    const positions: NodePositions = new Map();
    model.keys.forEach(key => {
        (model.layers.get(key) as Vertex[]).forEach(vertex => {
            const node = vertex.node;
            const where = at.get(vertex.id);
            if (!node || where === undefined) {
                return;
            }
            const held = input.pinned.get(node.id);
            if (held) {
                positions.set(node.id, { column: held.column, row: held.row });
                return;
            }
            const along = snap(where + shift, input.snapStep);
            const stage = stageAt.get(node.id) ?? key;
            positions.set(node.id, model.frame.stageAxis === "column"
                ? { column: stage, row: along }
                : { column: along, row: stage });
        });
    });
    return positions;
}

export type { FlowAxis, FlowSense };
