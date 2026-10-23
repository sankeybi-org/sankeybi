/**
 * Graph analysis: builds the directed node and edge graph, flags self-loops, and
 * assigns automatic stage and order positions, respecting any hand-placed node
 * positions.
 */

import { FlowAxis, FlowRow, Graph, GraphNode } from "./model";
import { NodePositions } from "./positions";

/**
 * Which coordinate carries the stage, and which separates nodes within one. A
 * left-to-right diagram layers into columns and orders down the rows; a top-to-bottom
 * one layers into rows and orders across the columns.
 *
 * The axis comes from the corridors' resolved ports (`axisOf`), not from the Arrange
 * card directly, so there is one answer to "which way does this diagram read" and the
 * data's own ports are part of it.
 */
function rolesOf(axis: FlowAxis): { stage: "column" | "row"; order: "column" | "row" } {
    return axis === "horizontal"
        ? { stage: "column", order: "row" }
        : { stage: "row", order: "column" };
}

export function buildGraph(
    flows: FlowRow[],
    pinned: NodePositions = new Map(),
    axis: FlowAxis = "horizontal"
): { graph: Graph; warnings: string[] } {
    const roles = rolesOf(axis);
    const nodes = new Map<string, GraphNode>();
    const warnings: string[] = [];
    function ensureNode(id: string): GraphNode {
        let n = nodes.get(id);
        if (!n) {
            n = {
                id,
                label: id,
                column: undefined,
                columnIsOverride: false,
                row: undefined,
                rowIsOverride: false,
                inflow: 0,
                outflow: 0,
                isSelfLoop: false
            };
            nodes.set(id, n);
        }
        return n;
    }

    /**
     * Where two flow rows disagree about one node-level field, the first non-blank
     * value wins and a warning says so. This is not last-wins, and not a silent pick.
     *
     * A node's label defaults to its id in `ensureNode`; a different display name,
     * colour and position are the node editor's. What is left to read from the data here
     * is the icon and the author's order.
     */

    function applyIcon(n: GraphNode, icon: string | undefined) {
        if (icon === undefined) {
            return;
        }
        if (n.icon === undefined) {
            n.icon = icon;
        } else if (n.icon !== icon) {
            warnings.push(`Node "${n.id}": conflicting Source/TargetIcon values — using the first.`);
        }
    }

    /**
     * An order is node-level, like the icon: one node is one shape on screen and can
     * hold one place in its stage's queue, or belong to one group. The same
     * first-non-blank-wins rule applies, and a clash really is one here, since a category
     * is already lowercased by the parse, so two values that differ mean two groups.
     *
     * It sets neither override flag: an order is not a coordinate and must not stop
     * `assignOrder` or the arrangers from choosing one.
     */
    function applyOrderOverride(n: GraphNode, order: number | string | undefined) {
        if (order === undefined) {
            return;
        }
        if (n.authoredOrder === undefined) {
            n.authoredOrder = order;
        } else if (n.authoredOrder !== order) {
            warnings.push(`Node "${n.id}": conflicting SourceOrder/TargetOrder values — using ${n.authoredOrder}.`);
        }
    }

    // Aggregated per-corridor totals, used only to build the layering graph (the full
    // corridor objects, with individual flows retained, are built in corridors.ts). The
    // key is the JSON of the pair rather than a delimited string, and the source and
    // target are stored in the value rather than recovered by splitting the key, so a
    // name containing the delimiter cannot corrupt an edge.
    const corridorTotals = new Map<string, { source: string; target: string; value: number }>();

    flows.forEach(f => {
        const s = ensureNode(f.source);
        const t = ensureNode(f.target);

        applyOrderOverride(s, f.sourceOrder);
        applyOrderOverride(t, f.targetOrder);
        applyIcon(s, f.sourceIcon);
        applyIcon(t, f.targetIcon);

        s.outflow += f.value;
        t.inflow += f.value;

        if (f.source === f.target) {
            s.isSelfLoop = true;
        }

        const key = JSON.stringify([f.source, f.target]);
        const existing = corridorTotals.get(key);
        if (existing) {
            existing.value += f.value;
        } else {
            corridorTotals.set(key, { source: f.source, target: f.target, value: f.value });
        }
    });

    // Only `assignStages` wants these: one entry per source and target pair, its value
    // summed. Nothing downstream reads them, so they stay local.
    const edges = Array.from(corridorTotals.values());

    // Hand-placed positions win over a position the data gives. Direct manipulation has
    // to beat the data, or dragging a node would silently snap back. They are applied
    // here, before layering, so the automatic assignment below sees a dragged node
    // exactly as it sees any placed one.
    pinned.forEach((position, id) => {
        const node = nodes.get(id);
        if (!node) {
            return; // a stale entry for a node the data no longer has
        }
        // One axis at a time, so a position that names only one leaves the other to the
        // automatic pass. A dragged node always carries both; this serves callers that want
        // to place a node on one axis only.
        if (position.column !== undefined) {
            node.column = position.column;
            node.columnIsOverride = true;
        }
        if (position.row !== undefined) {
            node.row = position.row;
            node.rowIsOverride = true;
        }
    });

    assignStages(nodes, edges, roles);
    assignOrder(nodes, flows, roles);

    return { graph: { nodes }, warnings };
}

/**
 * A node's stage is one more than the longest chain of predecessors, unless it was
 * placed by hand. Self-loop edges never constrain layering.
 *
 * It is computed with a memoised depth-first search. A predecessor that is currently
 * being resolved (an ancestor of itself in the call stack) means the edge closes a
 * cycle; that edge then does not constrain this node, rather than being followed.
 * Iterative relaxation ("keep raising a stage while a longer path is found") has no
 * cycle protection: each lap around a cycle raises both members further, and
 * bounding the number of passes only caps the damage at a large, wrong value. The
 * search never revisits a node already resolved or in progress, so it cannot ratchet.
 */
function assignStages(
    nodes: Map<string, GraphNode>,
    edges: { source: string; target: string }[],
    roles: { stage: "column" | "row"; order: "column" | "row" }
): void {
    // The stage coordinate, read and written by role rather than by name, so the
    // algorithm is the same whichever axis it lands on.
    const stageOf = (n: GraphNode): number | undefined =>
        (roles.stage === "column" ? n.column : n.row);
    const setStage = (n: GraphNode, value: number): void => {
        if (roles.stage === "column") { n.column = value; } else { n.row = value; }
    };
    const stageIsOverride = (n: GraphNode): boolean =>
        (roles.stage === "column" ? n.columnIsOverride : n.rowIsOverride);
    const predecessorsOf = new Map<string, string[]>();
    edges.forEach(e => {
        if (e.source === e.target) {
            return;
        }
        const list = predecessorsOf.get(e.target);
        if (list) {
            list.push(e.source);
        } else {
            predecessorsOf.set(e.target, [e.source]);
        }
    });

    const RESOLVING = 1;
    const DONE = 2;
    const state = new Map<string, typeof RESOLVING | typeof DONE>();

    function resolveStage(id: string): number | undefined {
        const node = nodes.get(id);
        if (!node) {
            return undefined;
        }
        if (stageIsOverride(node)) {
            return stageOf(node);
        }
        if (state.get(id) === DONE) {
            return stageOf(node);
        }
        if (state.get(id) === RESOLVING) {
            return undefined; // back-edge into an in-progress node: a cycle; it constrains neither side
        }
        state.set(id, RESOLVING);
        const predecessors = predecessorsOf.get(id) ?? [];
        let maxPredecessorStage = 0;
        predecessors.forEach(p => {
            const pStage = resolveStage(p);
            if (pStage !== undefined && pStage > maxPredecessorStage) {
                maxPredecessorStage = pStage;
            }
        });
        // The smallest whole stage strictly beyond every predecessor. Adding 1 alone would
        // be wrong now that hand-placed positions may be fractional: a node placed at 3.5
        // would put its automatic successor at 4.5, and that successor's successor at 5.5, so
        // one local nudge would drag every downstream stage off the grid. Flooring first keeps
        // the nudge local; integer stages behave as before (floor(3) + 1 is 4).
        setStage(node, Math.floor(maxPredecessorStage) + 1);
        state.set(id, DONE);
        return stageOf(node);
    }

    nodes.forEach((n, id) => {
        if (stageOf(n) === undefined) {
            resolveStage(id);
        }
    });

    // Unreachable, since `resolveStage` always sets a node's stage before returning, but
    // kept as a final safety net.
    nodes.forEach(n => {
        if (stageOf(n) === undefined) {
            setStage(n, 1);
        }
    });
}

/**
 * Order within a stage: the order of first appearance, unless declared or placed by
 * hand. This is the simplest assignment that is stable and gives every node its own
 * place; the arrangers improve on it.
 */
function assignOrder(
    nodes: Map<string, GraphNode>,
    flows: FlowRow[],
    roles: { stage: "column" | "row"; order: "column" | "row" }
): void {
    const nextForStage = new Map<number, number>();
    // Read and written by role, as `assignStages` does: on a top-to-bottom diagram the
    // queue is the row's and the place handed out is a column.
    const stageOf = (n: GraphNode): number | undefined =>
        (roles.stage === "column" ? n.column : n.row);
    const orderOf = (n: GraphNode): number | undefined =>
        (roles.order === "column" ? n.column : n.row);
    const setOrder = (n: GraphNode, value: number): void => {
        if (roles.order === "column") { n.column = value; } else { n.row = value; }
    };
    const orderIsOverride = (n: GraphNode): boolean =>
        (roles.order === "column" ? n.columnIsOverride : n.rowIsOverride);

    /**
     * Which stage's queue a node joins. Rounded, because a stage may be fractional: a
     * node hand-placed at 2.5 sits visually among stage 3's nodes, so it takes its place
     * from that queue. Otherwise it would be handed place 1 of an otherwise-empty "stage
     * 2.5" and land on top of whatever is already at place 1 nearby.
     */
    function stageBucket(stage: number): number {
        return Math.round(stage);
    }

    function nodeOrderOfAppearance(id: string): GraphNode | undefined {
        return nodes.get(id);
    }

    const seenOrder: string[] = [];
    const seen = new Set<string>();
    flows.forEach(f => {
        [f.source, f.target].forEach(id => {
            if (!seen.has(id)) {
                seen.add(id);
                seenOrder.push(id);
            }
        });
    });

    // A declared order sorts the queue; it does not pick a slot. `SourceOrder` and
    // `TargetOrder` are relative, so what they decide is who comes before whom within one
    // stage: the places handed out are still 1 to n with no gaps. With nothing declared the
    // queue is appearance order.
    //
    // There are three kinds of entry, in this order:
    //
    // 1. Ranked (a number), in value order. Equal numbers keep their appearance order
    //    here, and only here: the arrangers decide a group's internal order from their
    //    own objective (`holdAuthoredOrder`), which they can because they have
    //    neighbours to read. This pass is the bare grid, before anything is arranged.
    // 2. A category (a string), whose members are pulled together at the first of them.
    //    A category says only that these belong together, so on a grid with no opinion of
    //    its own the group stands where its first member stood.
    // 3. Everything else, in the order it appeared.
    const entries = seenOrder.map((id, appearance) => ({
        id, appearance, order: nodes.get(id)?.authoredOrder
    }));
    const ranked = entries
        .filter(entry => typeof entry.order === "number")
        .sort((a, b) => ((a.order as number) - (b.order as number)) || (a.appearance - b.appearance));
    const queue = ranked.slice();
    const queued = new Set(ranked.map(entry => entry.id));
    entries.forEach(entry => {
        if (queued.has(entry.id)) {
            return;
        }
        // A category takes its whole membership with it, so nothing else can be handed a
        // place between two of its members.
        const run = typeof entry.order === "string"
            ? entries.filter(other => other.order === entry.order && !queued.has(other.id))
            : [entry];
        run.forEach(member => {
            queued.add(member.id);
            queue.push(member);
        });
    });
    queue.forEach(entry => {
        const n = nodeOrderOfAppearance(entry.id);
        const stage = n ? stageOf(n) : undefined;
        if (!n || orderIsOverride(n) || stage === undefined) {
            return;
        }
        const bucket = stageBucket(stage);
        const next = nextForStage.get(bucket) ?? 1;
        setOrder(n, next);
        nextForStage.set(bucket, next + 1);
    });

    // Fallback for anything the pass above somehow missed.
    nodes.forEach(n => {
        const stage = stageOf(n);
        if (orderOf(n) === undefined && stage !== undefined) {
            const bucket = stageBucket(stage);
            const next = nextForStage.get(bucket) ?? 1;
            setOrder(n, next);
            nextForStage.set(bucket, next + 1);
        }
    });
}
