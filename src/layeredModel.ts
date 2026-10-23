/**
 * The layered model shared by the node arranger.
 *
 * The graph is turned into layers (the stages it already has), with an edge spanning more than
 * one layer becoming a chain of dummy vertices, one per layer it passes. That makes "a band
 * cutting through a column" something the model can see and order rather than an accident of
 * geometry. Corridors that run backwards are reversed for the pass, as usual for layered
 * drawing; self-loops sit outside the model entirely.
 *
 * This module holds the settled pieces `arrangeNodes.ts` builds on: the stage axis, the
 * longest-path layering, the terminal rules for single-port nodes, the author's declared order
 * (`holdAuthoredOrder`), the banished row, the exact crossing count and the unbiased overlap
 * resolver.
 *
 * Every crossing counts 1, and width is not part of any objective. Charging `w(e)*w(f)` as the
 * graph-drawing literature does for weighted instances lets one fat band buy its way straight
 * at the cost of a dozen small tangles, which is the reverse of "better to cross one big
 * corridor than three small ones". Ignoring corridors under a small share of the total is
 * worse still: an ignored corridor stops constraining anything and is still drawn.
 */

import { axisOf } from "./flowAxis";
import { Corridor, FlowAxis, FlowSense, Graph, GraphNode, Port } from "./model";
import { GridPosition, NodePositions } from "./positions";

/**
 * Which way the diagram flows, and therefore which axis is layered.
 *
 * A Sankey drawn with East/West ports reads left to right: its stages are columns and the
 * arranging happens down the rows. One drawn with North/South ports reads top to bottom, and
 * ordering rows within columns there would optimise across the grain, which can make a diagram
 * markedly worse than leaving it alone. So the axis is taken from the ports.
 *
 * It lives in `flowAxis.ts` because `computeLayout` needs it too (every band is scaled by the
 * pitch the nodes pack across the flow) and layout has no business importing the arranger.
 * Re-exported here because the checks and callers know it by this name.
 */
export type { FlowAxis };
export { axisOf };

/**
 * Where a node with only one active port belongs.
 *
 * A node that only sends, or only receives, and does so through a single port sits at the
 * extreme opposite that port's outward normal. A source whose flows leave East faces the
 * diagram from the far West; a sink fed on its South face is fed from below, so it belongs at
 * the top. The axis is the direction of travel (East/West -> columns, North/South -> rows), not
 * the axis the port packs along.
 *
 * It matches what authors of real diagrams do by hand: loss nodes fed on South sit on the top
 * row, and a node fed on North sits on the bottom row.
 */
interface TerminalRule {
    axis: "column" | "row";
    side: "min" | "max";
}

const PORT_NORMAL_SIGN: Record<Port, { axis: "column" | "row"; along: number }> = {
    East: { axis: "column", along: 1 },
    West: { axis: "column", along: -1 },
    South: { axis: "row", along: 1 },
    North: { axis: "row", along: -1 }
};

function terminalRulesOf(input: OrderInput, axis: FlowAxis, sense: FlowSense): Map<string, TerminalRule> {
    const out = new Map<string, TerminalRule>();
    input.graph.nodes.forEach((_node, id) => {
        const ports = new Set<Port>();
        let sends = false;
        let receives = false;
        input.corridors.forEach(corridor => {
            if (corridor.isSelfLoop) {
                return;
            }
            if (corridor.source === id) {
                sends = true;
                ports.add(corridor.sourcePort);
            }
            if (corridor.target === id) {
                receives = true;
                ports.add(corridor.targetPort);
            }
        });
        // Both directions, neither, or more than one face: there is no single outside for it to belong
        // to.
        if (sends === receives || ports.size !== 1) {
            return;
        }
        const normal = PORT_NORMAL_SIGN[Array.from(ports)[0]];
        // On the stage axis the rule is about flow order, not screen order. A source whose flows leave
        // West belongs at its diagram's first stage exactly as an East-leaving one does: a
        // right-to-left diagram is reversed by the mapping (layout's `columnSign`), not by the
        // numbering, so stage 1 is simply drawn at the right-hand end. Without the sense folded in, such
        // a source would ask for the last stage and the mapping would then draw it at the near end, the
        // far side of the diagram from where it belongs.
        //
        // The order axis never reverses, so there it reads the normal as it stands. That is why the
        // sense is applied here rather than to `PORT_NORMAL_SIGN` itself, which `biasOf` also reads.
        const stageAxis = axis === "horizontal" ? "column" : "row";
        const along = normal.axis === stageAxis ? normal.along * sense : normal.along;
        out.set(id, { axis: normal.axis, side: along > 0 ? "min" : "max" });
    });
    return out;
}

/**
 * The same rule, applied to a corridor's other end instead of to the outside of the diagram:
 * which side of its source a target belongs on, along the axis this pass arranges. +1 puts the
 * target at the larger coordinate, -1 at the smaller, 0 is no opinion.
 *
 * A port's outward normal says where the other end is. Flow arrives against the target's
 * normal, so the source lies that way and the target lies the other; it leaves along the
 * source's normal, so the target lies that way. Where only one of the two ports faces along the
 * ordering axis it speaks alone (a North port fed from an East one, say), and where both face
 * along it and disagree, neither is believed.
 */
export function biasOf(corridor: Corridor, orderAxis: "column" | "row"): number {
    const says = (port: Port, sense: number): number => {
        const normal = PORT_NORMAL_SIGN[port];
        return normal.axis === orderAxis ? sense * normal.along : 0;
    };
    const arriving = says(corridor.targetPort, -1);
    const leaving = says(corridor.sourcePort, 1);
    return arriving * leaving < 0 ? 0 : Math.sign(arriving + leaving);
}

/**
 * How far a banished terminal's pull reaches, in corridors. 1 is the node it hangs off; 2 adds
 * that node's own neighbours, which reaches the fuel column feeding a generator. It never
 * cascades past the reach, and it is read only inside a group (`Vertex.anchor`).
 */
const ANCHOR_REACH = 2;

/** One vertex of the layered model: a real node, or a band passing a layer. */
export interface Vertex {
    id: string;
    /** undefined for a dummy: it has no node of its own. */
    node?: GraphNode;
    /**
     * How much room this vertex takes along the ordering axis, in value units: a lane's band
     * width, or the extent its node is drawn at. It is never part of the objective.
     *
     * This is not what the node carries. A node is exactly as big as the bands it holds: its height
     * is the taller of the stacks its East and West edges pack, its width the wider of its North
     * and South ones. So the room it needs along the axis this pass arranges is the stack of the
     * two faces that pack along that axis, and a node fed only on North or South needs none of it:
     * it is drawn at its minimum-height floor. Reserving room for its value instead would float the
     * node holding the fattest flow furthest out of a row of banished nodes, for a node a couple of
     * pixels tall.
     */
    extent: number;
    /** A hand-placed node keeps its slot and its coordinate. */
    pinned: boolean;
    /** Where a pinned node sits on the ordering axis. */
    fixedAt?: number;
    /**
     * A single-port node held at one end of its layer (`terminalRulesOf`), when the end it belongs
     * at is on the ordering axis. It keeps its slot through the sweep, the transposition and the
     * relaxation alike: the rule is about what the diagram means, not something a better crossing
     * count should be able to buy.
     */
    edge?: "min" | "max";
    /**
     * Which end a banished terminal hanging off this vertex pulls it towards, or undefined where
     * nothing does (including where two disagree, which cancel).
     *
     * Read only by `holdAuthoredOrder`, and so only inside a group. A lone vertex already keeps the
     * slot the terminal earned it, through step 5 (which is two-sided, and where a banished
     * terminal is parked beyond the body and really does pull); what loses that slot is joining a
     * group, because the group averages it away. Without this, grouping a node with its siblings
     * would erase exactly the pull a terminal gave it.
     */
    anchor?: "min" | "max";
}

/** One edge of the layered model, always between adjacent layers. */
export interface Segment {
    upper: string;
    lower: string;
    /** The layer this segment leaves: its crossings are counted against it. */
    layer: number;
    /**
     * What the corridor carries. It is never part of the crossing objective (every crossing counts
     * 1); it weights the barycentre, so a node follows the flow that actually matters to it.
     */
    value: number;
    /**
     * Which side of the other end a port normal puts each end, in this segment's own terms: +1 for
     * "the lower end belongs at the larger coordinate", -1 for the smaller, 0 for no opinion.
     *
     * This is `terminalRulesOf`'s rule applied to a neighbour rather than to the outside of the
     * diagram: the same statement, that a port normal says where the other end is. A corridor
     * arriving on North comes from above, so its target belongs below its source; one leaving South
     * goes downward, so its source belongs above its target. Where the two ports disagree neither
     * is believed.
     *
     * It is what puts a node fed on North out of an East port below its feeder: it has two active
     * faces, so no terminal rule fires and the plain mean of its neighbours would pull it above.
     */
    bias: number;
}

export interface OrderInput {
    graph: Graph;
    corridors: Corridor[];
    /**
     * Nodes the author placed by hand, with where they were left: never moved, and they hold their
     * slot in the order so the rest arrange around them.
     *
     * These are positions rather than ids, because `graph` is deliberately the graph before any
     * stored position is applied; see `buildModel` on why the stage has to come from the topology.
     */
    pinned: ReadonlyMap<string, GridPosition>;
    /** The Snap to grid step in grid units; 0 (free placement) means no rounding. */
    snapStep: number;
    /** Forces the axis, for a check that wants to test both on one dataset. */
    axis?: FlowAxis;
    /** The same, for which way along that axis the diagram reads. */
    sense?: FlowSense;
    /** Sweeps of the layer-by-layer pass. */
    iterations?: number;
    /**
     * Passes of the second relaxation, for a check that wants to measure what it is worth by
     * turning it off.
     */
    settlePasses?: number;
}

export interface OrderResult {
    /** A position for every node. */
    positions: NodePositions;
    axis: FlowAxis;
    sense: FlowSense;
    /** The objective: how many pairs of corridors cross, before and after. */
    crossingsBefore: number;
    crossingsAfter: number;
    moved: number;
    /** Layers, and how many dummy vertices the spanning corridors needed. */
    layers: number;
    dummies: number;
}

/** How far apart two entries in a layer sit, before the layer is spread. */
const GAP = 0.25;

/**
 * How much of the stage axis a layer's banished nodes spread across, so that sharing one lane
 * leaves them room to stand side by side. One full stage between two of them, half a stage
 * either side of their own layer; three or more share that same width rather than reaching
 * further into the neighbouring layers.
 *
 * These are stages, not columns. Everything in this file is written in stage/order terms, so on
 * a top-to-bottom diagram this is half a row pitch either side and the nodes sharing one lane
 * share a column.
 */
const STAGE_STAGGER = 1;

/**
 * Which axis carries the stage, and what each node's stage coordinate is.
 *
 * This is not simply "the column": a vertical diagram puts the stage in the row and uses the
 * column for lateral position, so reading its columns as layers would model a diagram that is
 * not there. The rule is:
 *
 * - the stage axis is the one the flow travels along (`axisOf`);
 * - if the author gave coordinates on that axis, they are the stages and the pass leaves them
 *   exactly alone: it only ever rewrites the other one;
 * - otherwise the stage is the longest upstream path, computed here rather than read off
 *   `node.column`, which on a vertical diagram is a lateral position that the data happened to
 *   override.
 */
export interface Frame {
    stageAxis: "column" | "row";
    orderAxis: "column" | "row";
    /** Which layer each node belongs to. */
    layerOf: Map<string, number>;
    /** What to write back on the stage axis: the author's own value, or the layer. */
    stageCoordinateOf: Map<string, number>;
    /**
     * Whether the author wrote the stage coordinates. Where they did, the stage is not this pass's
     * to touch, neither by `frameOf`'s end-layer rule nor by `banishRuled` standing a row's nodes
     * side by side.
     */
    authored: boolean;
}

function frameOf(input: OrderInput, axis: FlowAxis, sense: FlowSense): Frame {
    const stageAxis = axis === "horizontal" ? "column" : "row";
    const orderAxis = axis === "horizontal" ? "row" : "column";
    const explicit = Array.from(input.graph.nodes.values()).some(node =>
        stageAxis === "column" ? node.columnIsOverride : node.rowIsOverride);
    const layerOf = new Map<string, number>();
    const stageCoordinateOf = new Map<string, number>();
    const stages = explicit ? undefined : topologicalStages(input, stageAxis);
    input.graph.nodes.forEach((node, id) => {
        if (explicit) {
            const coordinate = (stageAxis === "column" ? node.column : node.row) ?? 1;
            layerOf.set(id, Math.round(coordinate));
            stageCoordinateOf.set(id, coordinate);
        } else {
            const stage = stages?.get(id) ?? 1;
            layerOf.set(id, stage);
            stageCoordinateOf.set(id, stage);
        }
    });

    // A terminal whose outside is on the stage axis is moved to the end layer: a pure source to the
    // first, a pure sink fed from the forward side to the last. Only where the stages are ours to
    // assign: an author who wrote the coordinates has already said where the node goes, and this
    // pass never moves what it was given.
    if (!explicit) {
        const layers = Array.from(layerOf.values());
        const first = Math.min(...layers);
        const last = Math.max(...layers);
        terminalRulesOf(input, axis, sense).forEach((rule, id) => {
            if (rule.axis !== stageAxis || !layerOf.has(id)) {
                return;
            }
            const want = rule.side === "min" ? first : last;
            layerOf.set(id, want);
            stageCoordinateOf.set(id, want);
        });
    }
    return { stageAxis, orderAxis, layerOf, stageCoordinateOf, authored: explicit };
}

/**
 * The longest upstream path to each node, self-loops excluded and cycles cut: the same
 * layering `assignColumns` does, recomputed here because that one writes into the column
 * whether or not the column is the stage axis.
 *
 * A corridor only advances the stage if it actually travels along it. A corridor fed from
 * "Exportnav" South into North drops; it does not move a column to the right, and counting it
 * as a stage would push the target into a column of its own at the far right of the diagram. A
 * corridor counts when either of its ports faces along the stage axis: East out and North in
 * still crosses the diagram, South out and North in does not.
 *
 * A corridor that does not advance still constrains: its target belongs in the feeder's own
 * stage, beside it, not back at the start of the diagram. Dropping such corridors from the
 * layering entirely would put both of those nodes in column 1, at the far left, the same
 * mistake mirrored.
 */
function topologicalStages(input: OrderInput, stageAxis: "column" | "row"): Map<string, number> {
    const alongStage = (port: Port): boolean =>
        stageAxis === "column" ? (port === "East" || port === "West") : (port === "North" || port === "South");
    /** Each predecessor, and whether reaching this node from it costs a stage. */
    const predecessors = new Map<string, { from: string; step: number }[]>();
    input.corridors.forEach(corridor => {
        if (corridor.isSelfLoop) {
            return;
        }
        const step = alongStage(corridor.sourcePort) || alongStage(corridor.targetPort) ? 1 : 0;
        const entry = { from: corridor.source, step };
        const list = predecessors.get(corridor.target);
        if (list) {
            list.push(entry);
        } else {
            predecessors.set(corridor.target, [entry]);
        }
    });
    const stage = new Map<string, number>();
    const resolving = new Set<string>();
    const resolve = (id: string): number => {
        const known = stage.get(id);
        if (known !== undefined) {
            return known;
        }
        if (resolving.has(id)) {
            return 1; // an edge closing a cycle never constrains the layering
        }
        resolving.add(id);
        let best = 1;
        (predecessors.get(id) ?? []).forEach(entry => {
            best = Math.max(best, resolve(entry.from) + entry.step);
        });
        resolving.delete(id);
        stage.set(id, best);
        return best;
    };
    input.graph.nodes.forEach((_node, id) => resolve(id));
    return stage;
}

/** The layered model: vertices per layer, in order, and the segments between them. */
export interface Model {
    layers: Map<number, Vertex[]>;
    keys: number[];
    segments: Segment[];
    dummies: number;
    /** Every vertex by id, dummies included. */
    vertices: Map<string, Vertex>;
    frame: Frame;
}

/**
 * Builds the layered model from the graph as it stands.
 *
 * The input frame is always the canonical one: the stage in the column, where `assignColumns`
 * puts it from the longest upstream path, and the row as the thing that separates nodes within
 * a stage. The output frame is transposed on a vertical diagram: the stage goes down the rows
 * and the order runs across the columns, because the ports say the flow reads downward, so the
 * stages belong down the page.
 *
 * That is why `graph` must be the graph before any stored position is applied. After a vertical
 * arrangement the stored column is the order and the stored row is the stage; read that back as
 * the input frame and a second press would layer the diagram by its ordering coordinate.
 * Taking the stage from the topology every time (which is what the caller passes) makes the
 * pass idempotent instead.
 */
export function buildModel(input: OrderInput, axis: FlowAxis, sense: FlowSense): Model {
    const frame = frameOf(input, axis, sense);
    const layerOf = frame.layerOf;
    const terminals = terminalRulesOf(input, axis, sense);

    // What each face of each node packs, mirroring layout's `faceValues` (self-loops included,
    // zero-value corridors left out), because the answer has to be the extent the node is drawn at.
    // See `Vertex.extent`.
    const packing: [Port, Port] = frame.orderAxis === "row" ? ["East", "West"] : ["North", "South"];
    const stacks = new Map<string, Record<Port, number>>();
    const stackFor = (id: string): Record<Port, number> => {
        let face = stacks.get(id);
        if (!face) {
            face = { North: 0, South: 0, East: 0, West: 0 };
            stacks.set(id, face);
        }
        return face;
    };
    input.corridors.forEach(corridor => {
        if (corridor.value <= 0) {
            return;
        }
        stackFor(corridor.source)[corridor.sourcePort] += corridor.value;
        stackFor(corridor.target)[corridor.targetPort] += corridor.value;
    });
    const extentOfNode = (id: string): number => {
        const face = stacks.get(id);
        return face ? Math.max(face[packing[0]], face[packing[1]]) : 0;
    };

    // Which vertices a banished terminal pulls on. A terminal held at an end is lifted clear of the
    // body by `banishRuled`, so it stops being a neighbour anything can average against. That costs
    // nothing while the node it hangs off keeps its own slot, and costs the whole pull once that
    // node joins a group, because the group averages its slot away.
    //
    // This is worked out here rather than in the projection, which is handed one layer's vertices
    // and never sees a corridor.
    const banished = new Map<string, "min" | "max">();
    input.graph.nodes.forEach((_node, id) => {
        const rule = terminals.get(id);
        // The same condition `push` uses for `edge` below: a hand-placed node is not banished, and a
        // rule pointing along the stage axis was settled by `frameOf` putting the node in an end layer
        // instead.
        if (rule && rule.axis === frame.orderAxis && !input.pinned.has(id)) {
            banished.set(id, rule.side);
        }
    });
    const anchors = new Map<string, "min" | "max">();
    const cancelled = new Set<string>();
    const claim = (id: string, side: "min" | "max"): void => {
        if (banished.has(id) || cancelled.has(id)) {
            return; // a terminal keeps its own end; a cancelled vertex stays so
        }
        const now = anchors.get(id);
        if (now === undefined) {
            anchors.set(id, side);
        } else if (now !== side) {
            // Opposite ends cancel: a north terminal and a south terminal pull a vertex towards
            // opposite ends, which is the rule `biasOf` already states for two ports that disagree: neither
            // is believed.
            anchors.delete(id);
            cancelled.add(id);
        }
    };
    input.corridors.forEach(corridor => {
        const toTerminal = banished.get(corridor.target);
        const fromTerminal = banished.get(corridor.source);
        if (toTerminal) {
            claim(corridor.source, toTerminal);
        }
        if (fromTerminal) {
            claim(corridor.target, fromTerminal);
        }
    });
    if (ANCHOR_REACH > 1) {
        // One hop further, from the directly tied only. A fuel feeding a generator that vents its
        // losses upward is not itself tied to anything, so a direct-only rule says nothing about the
        // column the author most often groups. The map is snapshotted, so this reaches exactly one hop
        // and cannot cascade across the diagram.
        const direct = new Map(anchors);
        input.corridors.forEach(corridor => {
            const fromSource = direct.get(corridor.source);
            const fromTarget = direct.get(corridor.target);
            if (fromSource !== undefined && !direct.has(corridor.target)) {
                claim(corridor.target, fromSource);
            }
            if (fromTarget !== undefined && !direct.has(corridor.source)) {
                claim(corridor.source, fromTarget);
            }
        });
    }

    const vertices = new Map<string, Vertex>();
    const layers = new Map<number, Vertex[]>();
    const push = (layer: number, vertex: Vertex): void => {
        const list = layers.get(layer);
        if (list) {
            list.push(vertex);
        } else {
            layers.set(layer, [vertex]);
        }
        vertices.set(vertex.id, vertex);
    };

    // The starting order must not depend on the order the rows arrived in. Power BI makes no
    // promise about row order, so a start taken from the order of first appearance would let the
    // same data arrive differently and come out arranged differently.
    //
    // A row therefore counts only where the author actually said it (a data override or a hand
    // placement); otherwise the layer is seeded by node id, which is stable whatever order the rows
    // turn up in.
    //
    // What separates two nodes of the same stage today is the coordinate on the axis this pass is
    // going to rewrite.
    const along = (node: GraphNode): number =>
        (frame.orderAxis === "column" ? node.column : node.row) ?? 1;
    const byLayer = new Map<number, GraphNode[]>();
    input.graph.nodes.forEach((node, id) => {
        const layer = layerOf.get(id) ?? 1;
        const list = byLayer.get(layer);
        if (list) {
            list.push(node);
        } else {
            byLayer.set(layer, [node]);
        }
    });
    Array.from(byLayer.keys()).sort((a, b) => a - b).forEach(layer => {
        // Single-port nodes are sorted to their ends here, not only by the sweep. A crossing search
        // keeps the best arrangement it sees and the starting one is in the running, so an untouched
        // initial order could win on crossings and ship a max-side terminal at the top of its layer.
        const rank = (node: GraphNode): number => {
            const rule = terminals.get(node.id);
            if (!rule || rule.axis !== frame.orderAxis || input.pinned.has(node.id)) {
                return 0;
            }
            return rule.side === "min" ? -1 : 1;
        };
        const members = byLayer.get(layer) as GraphNode[];
        const authored = members.some(node =>
            frame.orderAxis === "column" ? node.columnIsOverride : node.rowIsOverride);
        const list = members
            .slice()
            .sort((a, b) => (rank(a) - rank(b))
                || (authored ? along(a) - along(b) : 0)
                || (a.id < b.id ? -1 : 1));
        list.forEach(node => {
            // A pinned node holds the coordinate it was dropped at, read on the axis the arrangement runs
            // along, which on a vertical diagram is its column.
            const held = input.pinned.get(node.id);
            const rule = terminals.get(node.id);
            push(layer, {
                id: node.id,
                node,
                extent: extentOfNode(node.id),
                pinned: held !== undefined,
                fixedAt: held === undefined
                    ? undefined
                    : (axis === "horizontal" ? held.row : held.column),
                // Only the rules that point along the axis this pass arranges; the others were settled by
                // `frameOf` putting the node in an end layer.
                edge: held === undefined && rule && rule.axis === frame.orderAxis
                    ? rule.side
                    : undefined,
                anchor: anchors.get(node.id)
            });
        });
    });

    const segments: Segment[] = [];
    let dummies = 0;
    input.corridors.forEach(corridor => {
        if (corridor.isSelfLoop) {
            return;
        }
        let from = corridor.source;
        let to = corridor.target;
        let a = layerOf.get(from);
        let b = layerOf.get(to);
        if (a === undefined || b === undefined || a === b) {
            return; // nothing to order: both ends share a layer (or a node is missing)
        }
        let bias = biasOf(corridor, frame.orderAxis);
        if (a > b) {
            // A corridor running backwards. It is reversed for the ordering pass, as layered drawing
            // always does: which end is which does not change whether two bands cross.
            [a, b] = [b, a];
            [from, to] = [to, from];
            bias = -bias; // the rule is about the corridor's ends, not the layers'
        }
        let previous = from;
        for (let layer = a + 1; layer < b; layer++) {
            // Named for the corridor and the layer, not for a counter. A counter numbers lanes in the order
            // the corridors happen to be iterated, which follows the order the rows arrived in, and the id
            // is what the canonical seed sorts by, so unstable ids would mean an unstable arrangement.
            const id = `\u0000${corridor.id}@${layer}`;
            dummies++;
            // A lane is its band, so the room it needs really is its value.
            push(layer, { id, extent: corridor.value, pinned: false });
            segments.push({ upper: previous, lower: id, layer: layer - 1, value: corridor.value, bias });
            previous = id;
        }
        segments.push({ upper: previous, lower: to, layer: b - 1, value: corridor.value, bias });
    });

    // The canonical order, applied to every entry including the lanes: a lane is a vertex of the
    // model like any other and has to take its slot by the same rule, or the layer's order would
    // depend on when its corridor was seen.
    layers.forEach((list, key) => {
        const authored = list.some(vertex => vertex.node && (frame.orderAxis === "column"
            ? vertex.node.columnIsOverride : vertex.node.rowIsOverride));
        const rank = (vertex: Vertex): number =>
            vertex.edge === "min" ? -1 : vertex.edge === "max" ? 1 : 0;
        const positionOf = (vertex: Vertex): number => vertex.node
            ? ((frame.orderAxis === "column" ? vertex.node.column : vertex.node.row) ?? 1)
            : 0;
        layers.set(key, holdAuthoredOrder(list.slice().sort((x, y) => (rank(x) - rank(y))
            || (authored ? positionOf(x) - positionOf(y) : 0)
            || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))));
    });

    return {
        layers,
        keys: Array.from(layers.keys()).sort((a, b) => a - b),
        segments,
        dummies,
        vertices,
        frame
    };
}

/** Each vertex's index within its own layer. */
function indicesOf(model: Model): Map<string, number> {
    const out = new Map<string, number>();
    model.layers.forEach(list => list.forEach((vertex, i) => out.set(vertex.id, i)));
    return out;
}

/**
 * The segments leaving each layer, built once per model and kept against the segment list
 * itself: a search clones a model's layers constantly (`cloneLayers`) but never its segments,
 * so the buckets stay valid for the whole run and a clone shares them.
 */
const segmentBuckets = new WeakMap<Segment[], Map<number, Segment[]>>();
function segmentsLeaving(model: Model, layer: number): Segment[] {
    let buckets = segmentBuckets.get(model.segments);
    if (!buckets) {
        const built = new Map<number, Segment[]>();
        model.segments.forEach(segment => {
            const list = built.get(segment.layer);
            if (list) {
                list.push(segment);
            } else {
                built.set(segment.layer, [segment]);
            }
        });
        segmentBuckets.set(model.segments, built);
        buckets = built;
    }
    return buckets.get(layer) ?? [];
}

/**
 * How many pairs of segments cross between one layer and the next.
 *
 * The accumulation-tree method: walk the segments in order of their upper end, and for each
 * one count how many already-placed segments have a strictly greater lower end, using a binary
 * tree of counters. O(|E| log |V|) rather than the O(|E|^2) of comparing every pair.
 */
function countBetween(model: Model, index: Map<string, number>, layer: number): number {
    const segments = segmentsLeaving(model, layer);
    // Every segment endpoint is a vertex of a layer, so an indexed count and a raw one are the
    // same number here; one pass rather than two.
    if (segments.length < 2) {
        return 0;
    }
    // Sorted by upper end, ties by lower end: two segments leaving the same vertex never cross,
    // and this ordering is what makes that fall out.
    const ordered = segments
        .map(s => ({ upper: index.get(s.upper) ?? 0, lower: index.get(s.lower) ?? 0 }))
        .sort((a, b) => (a.upper - b.upper) || (a.lower - b.lower));

    const size = Math.max(...ordered.map(s => s.lower)) + 1;
    // A power-of-two accumulator tree: leaves count lower ends seen so far.
    let firstLeaf = 1;
    while (firstLeaf < size) {
        firstLeaf *= 2;
    }
    const tree = new Int32Array(2 * firstLeaf);
    let crossings = 0;
    ordered.forEach(segment => {
        let node = segment.lower + firstLeaf;
        tree[node]++;
        while (node > 1) {
            // Every already-placed segment sitting in the right sibling has a greater lower end than this
            // one and a smaller upper end, so it crosses it.
            if (node % 2 === 0) {
                crossings += tree[node + 1];
            }
            node = Math.floor(node / 2);
            tree[node]++;
        }
    });
    return crossings;
}

export function countCrossings(model: Model): number {
    const index = indicesOf(model);
    let total = 0;
    model.keys.forEach(layer => {
        total += countBetween(model, index, layer);
    });
    return total;
}

/**
 * Holds the author's declared node order against the search.
 *
 * `SourceOrder`/`TargetOrder` say who comes before whom inside a stage, and that is not
 * something a better arrangement may buy: the principle the terminal rules are already drawn
 * on. So the order is a constraint and not a seed; an arranging search would permute an
 * authored order away in its first sweep. This runs after every pass that reorders a layer,
 * which keeps every state the search scores a legal one.
 *
 * One projection, three promises:
 *
 *  1. Numbered nodes come out in the author's order. Each value is a group and the groups are
 *     ranked by where the pass left their members, then made non-decreasing by running
 *     maximum, so "between two groups" still means something where the data wants the opposite
 *     order. A category has no rank and is left out of that ordering: its group floats to its
 *     own members' mean, which is the treatment a single unnumbered vertex already gets.
 *  2. Equal values stay together. Every member of a group carries the group's rank, so nothing
 *     can be sorted into the middle of it, and the rank of a contiguous run lies inside that
 *     run, which makes this idempotent and safe to apply after every pass.
 *  3. The arrangement still decides everything the author did not: where each blank goes
 *     relative to the groups (above, between, below) and which member of a group comes first.
 *     Both are read off the slots the pass chose.
 *
 * Pinned and ruled vertices hold their slots, as they do in `sortLayer`, `transpose` and
 * `relocate`. A hand-placed or end-held member is therefore where a group gets broken, which is
 * the agreed precedence: the terminal rule is about what the diagram means, and a drag is the
 * author speaking later.
 *
 * With nothing authored every vertex is keyed by its own index and the sort reproduces the
 * list, so this is exactly a no-op on every diagram that does not use the role.
 */
export function holdAuthoredOrder(list: readonly Vertex[]): Vertex[] {
    const stays = (vertex: Vertex): boolean => vertex.pinned || vertex.edge !== undefined;
    const orderOf = (vertex: Vertex): number | string | undefined => vertex.node?.authoredOrder;
    const free: { vertex: Vertex; index: number }[] = [];
    list.forEach((vertex, index) => {
        if (!stays(vertex)) {
            free.push({ vertex, index });
        }
    });
    if (!free.some(entry => orderOf(entry.vertex) !== undefined)) {
        return list.slice();
    }

    // One group per authored value, a number or a category alike, standing at the mean of the
    // slots the pass left its members in.
    const groups = new Map<number | string, { total: number; count: number }>();
    free.forEach(entry => {
        const value = orderOf(entry.vertex);
        if (value === undefined) {
            return;
        }
        const group = groups.get(value);
        if (group) {
            group.total += entry.index;
            group.count++;
        } else {
            groups.set(value, { total: entry.index, count: 1 });
        }
    });
    // A group anchored by a banished terminal takes that end's slot, not the mean. A member tied
    // to a terminal held at the top earned its slot from that terminal; averaging it against
    // members that are not tied to anything throws the pull away. Where members disagree (one
    // anchored min, another max) neither is believed and the mean stands, which is `biasOf`'s rule.
    const anchorOf = (key: number | string): "min" | "max" | undefined => {
        let found: "min" | "max" | undefined;
        let disagrees = false;
        free.forEach(entry => {
            if (orderOf(entry.vertex) !== key) {
                return;
            }
            const anchor = entry.vertex.anchor;
            if (anchor === undefined) {
                return;
            }
            if (found === undefined) {
                found = anchor;
            } else if (found !== anchor) {
                disagrees = true;
            }
        });
        return disagrees ? undefined : found;
    };
    const meanOf = (key: number | string): number => {
        const group = groups.get(key) as { total: number; count: number };
        const anchor = anchorOf(key);
        if (anchor !== undefined) {
            const slots = free.filter(entry => orderOf(entry.vertex) === key).map(entry => entry.index);
            return anchor === "min" ? Math.min(...slots) : Math.max(...slots);
        }
        return group.total / group.count;
    };
    // Only the ranked groups are ordered against each other, by running maximum over their means.
    // A category asked for no position, so it keeps its own mean and competes for a slot exactly
    // as a lone unnumbered vertex does, which is what "a group without a preference for order"
    // means.
    const rankOf = new Map<number | string, number>();
    let floor = Number.NEGATIVE_INFINITY;
    Array.from(groups.keys())
        .filter(key => typeof key === "number")
        .sort((a, b) => (a as number) - (b as number))
        .forEach(key => {
            floor = Math.max(floor, meanOf(key));
            rankOf.set(key, floor);
        });
    Array.from(groups.keys())
        .filter(key => typeof key !== "number")
        .forEach(key => rankOf.set(key, meanOf(key)));

    const keyOf = (entry: { vertex: Vertex; index: number }): number => {
        const value = orderOf(entry.vertex);
        return value === undefined ? entry.index : (rankOf.get(value) ?? entry.index);
    };
    const ordered = free.slice().sort((a, b) => {
        const byKey = keyOf(a) - keyOf(b);
        if (byKey !== 0) {
            return byKey;
        }
        // A group goes before a blank that asked for the same slot, so the blank cannot split it; then
        // ranked before floating and by value or by key, so two groups sharing a slot never depend on
        // map order; then by the slot the pass chose, which is what decides a group's own first member.
        const x = orderOf(a.vertex);
        const y = orderOf(b.vertex);
        if ((x === undefined) !== (y === undefined)) {
            return x === undefined ? 1 : -1;
        }
        if (x !== undefined && y !== undefined && x !== y) {
            const ranked = typeof x === "number";
            if (ranked !== (typeof y === "number")) {
                return ranked ? -1 : 1;
            }
            return ranked ? (x as number) - (y as number) : (String(x) < String(y) ? -1 : 1);
        }
        return a.index - b.index;
    });

    const out: Vertex[] = [];
    let next = 0;
    list.forEach(vertex => {
        out.push(stays(vertex) ? vertex : ordered[next++].vertex);
    });
    return out;
}

/**
 * The top and bottom of the diagram's body: the nodes that are not held at an edge by the
 * terminal rule. Lanes are excluded: they are invisible, and a lane running above everything
 * would stretch the layers to an edge the reader cannot see.
 *
 * Where an edge is spoken for, its owners define it. A South-fed node owns the top row, so the
 * top is where those nodes are, not wherever some other layer has drifted to. Measuring it the
 * other way makes the reserve unenforceable: the layer breaking the rule defines the edge it is
 * breaking.
 */
export function edgesOf(
    model: Model,
    at: Map<string, number>,
    extentOf: (vertex: Vertex) => number
): { low: number; high: number } {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    model.vertices.forEach(vertex => {
        const place = at.get(vertex.id);
        if (place === undefined || !vertex.node || vertex.edge) {
            return;
        }
        low = Math.min(low, place - extentOf(vertex) / 2);
        high = Math.max(high, place + extentOf(vertex) / 2);
    });
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
        // Every node is ruled: there is no body to stand outside of.
        model.vertices.forEach(vertex => {
            const place = at.get(vertex.id);
            if (place === undefined || !vertex.node) {
                return;
            }
            low = Math.min(low, place - extentOf(vertex) / 2);
            high = Math.max(high, place + extentOf(vertex) / 2);
        });
    }
    return { low, high };
}

/**
 * A node fed from outside the diagram gets a row of its own, past everything else.
 *
 * The terminal rule says a South-fed node belongs at the top and a North-fed one at the bottom.
 * Holding each at the end of its own layer only half says it: layers reach different depths,
 * so the North-fed nodes would end up level with whatever happened to be lowest in their column
 * rather than under the diagram. Here they are lifted clear of the body altogether: above every
 * unruled node, or below every one. The row is empty of everything else by construction, which
 * is what "a row of its own" means.
 *
 * It is one row, and a layer with more than one ruled node stands them side by side on it.
 * Stacking them along the ordering axis would put nodes of the same kind, hanging off the same
 * node, several rows apart. So a whole layer's ruled nodes take one coordinate (the one that
 * clears the body for the deepest of them) and spread across `STAGE_STAGGER` of the stage axis
 * about their own layer, keeping the slot the sweep gave them.
 *
 * "Row" throughout here means the ordering axis: on a top-to-bottom diagram the lane they share
 * is a column and they spread across the rows instead.
 */
export function banishRuled(
    model: Model,
    at: Map<string, number>,
    extentOf: (vertex: Vertex) => number,
    stageAt: Map<string, number>
): void {
    const { low, high } = edgesOf(model, at, extentOf);
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
        return;
    }
    (["min", "max"] as const).forEach(side => {
        model.keys.forEach(key => {
            // In the slot the sweep gave them: they are out of the body, so their coordinate is no longer
            // theirs to be sorted by.
            const ruled = (model.layers.get(key) as Vertex[])
                .filter(vertex => vertex.edge === side && vertex.node && !vertex.pinned);
            if (ruled.length === 0) {
                return;
            }
            // One coordinate for the whole layer, a gap clear of the body, taken from the deepest of them
            // so none of them reaches back into it.
            const edge = side === "min" ? low - GAP : high + GAP;
            const half = Math.max(...ruled.map(vertex => extentOf(vertex) / 2));
            const centre = side === "min" ? edge - half : edge + half;
            // Half a column gap either side of the layer's own centreline, in the order they already stood
            // in, but never where the author wrote the stage themselves, which is not this pass's to move
            // (`frameOf` refuses the same thing for the same reason).
            const span = ruled.length > 1 && !model.frame.authored
                ? STAGE_STAGGER / (ruled.length - 1)
                : 0;
            ruled.forEach((vertex, i) => {
                at.set(vertex.id, centre);
                const stage = stageAt.get(vertex.id);
                if (stage !== undefined && span > 0) {
                    stageAt.set(vertex.id, stage - STAGE_STAGGER / 2 + i * span);
                }
            });
        });
    });
}

/**
 * Pushes overlapping entries apart around their own centre, not down the page.
 *
 * The obvious resolver walks the layer from the top, pushing each entry down until it clears
 * the one above, and then walks back up to catch anything that ran off the bottom. It is
 * systematically biased: the first pass moves things down and the second only corrects the
 * overflow, so a crowded layer ends up below where its flows wanted it.
 *
 * This resolves by runs instead. Entries that cannot all fit where they want to be are merged
 * into a run (a block that moves together) and the run is placed where it minimises the total
 * distance its members travel, which is the mean of what they asked for. Merging repeats until
 * no two runs overlap. Nothing prefers a direction, so nothing drifts in one.
 *
 * A wall (hand-placed, or an end the fill pass nailed down) fixes the run it belongs to: the
 * run is placed so the wall lands exactly on its own position, and everything else arranges
 * around it. Two walls in one run would over-determine it, so the first one wins and the
 * second is treated as ordinary, which cannot happen in practice, since the fill pass only ever
 * holds a layer's two ends and they are never in the same run.
 */
export function resolve(
    list: Vertex[],
    at: Map<string, number>,
    extentOf: (vertex: Vertex) => number,
    gap: number,
    isWall: (vertex: Vertex) => boolean
): void {
    if (list.length === 0) {
        return;
    }
    interface Run {
        members: Vertex[];
        /** Where the first member's centre sits. */
        start: number;
        /** First centre to last centre, so `start + spread` is the last centre. */
        spread: number;
        /** Half the first member's extent: how far the run reaches above `start`. */
        headroom: number;
        /** Half the last member's extent. */
        tailroom: number;
        /** Set where a wall fixes this run's position. */
        anchored: boolean;
    }

    // Each entry starts as a run of its own, standing where it asked to stand.
    const runs: Run[] = list.map(vertex => ({
        members: [vertex],
        start: at.get(vertex.id) ?? 0,
        spread: 0,
        headroom: extentOf(vertex) / 2,
        tailroom: extentOf(vertex) / 2,
        anchored: isWall(vertex)
    }));

    /** Where a run wants to start, given what each member asked for. */
    const wanted = (members: Vertex[]): { start: number; spread: number } => {
        let offset = 0;
        let total = 0;
        let anchor: number | undefined;
        const offsets: number[] = [];
        members.forEach((vertex, i) => {
            if (i > 0) {
                offset += extentOf(members[i - 1]) / 2 + gap + extentOf(vertex) / 2;
            }
            offsets.push(offset);
            const asked = at.get(vertex.id) ?? 0;
            if (anchor === undefined && isWall(vertex)) {
                anchor = asked - offset;
            }
            total += asked - offset;
        });
        return {
            start: anchor !== undefined ? anchor : total / members.length,
            spread: offsets[offsets.length - 1]
        };
    };

    // Merge while two neighbouring runs overlap. Deliberately a fixed point rather than one sweep:
    // merging two runs moves both, which can bring the result into the one above.
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i + 1 < runs.length; i++) {
            const above = runs[i];
            const below = runs[i + 1];
            const clear = above.start + above.spread + above.tailroom + gap + below.headroom;
            if (below.start < clear - 1e-9) {
                const members = above.members.concat(below.members);
                const place = wanted(members);
                runs.splice(i, 2, {
                    members,
                    start: place.start,
                    spread: place.spread,
                    headroom: extentOf(members[0]) / 2,
                    tailroom: extentOf(members[members.length - 1]) / 2,
                    anchored: above.anchored || below.anchored
                });
                merged = true;
                break;
            }
        }
    }

    runs.forEach(run => {
        let offset = 0;
        run.members.forEach((vertex, i) => {
            if (i > 0) {
                offset += extentOf(run.members[i - 1]) / 2 + gap + extentOf(vertex) / 2;
            }
            at.set(vertex.id, run.start + offset);
        });
    });
}

export function snap(value: number, step: number): number {
    const snapped = step > 0 ? Math.round(value / step) * step : value;
    // Four decimals: what the stored blob keeps, so the arrangement scored is the arrangement
    // drawn.
    return Math.round(snapped * 10000) / 10000;
}
