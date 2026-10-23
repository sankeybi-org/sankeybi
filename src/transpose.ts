/**
 * Turning the diagram a quarter of the way round, which is a transpose and not a
 * rotation.
 *
 * The Flow direction setting promises that an author can write any source or target
 * column or row in flow order (1 for the first stage) and the direction decides which
 * end it is drawn at. For the two horizontal readings a mirror delivers that, because
 * layout's `columnSign` and `rowSign` flip the mapping. For the two vertical readings
 * it does not: a vertical reading makes the row the stage axis, so stages written in
 * the column would read as lateral position. A mirror cannot fix that, because a sign
 * flip preserves which axis is which; only transposing the axes swaps them.
 *
 * So the transform applies to the data and to the author's own stored work. Both
 * describe the diagram in a canonical left-to-right frame, and Flow direction
 * transposes that description onto the screen.
 *
 * Why a transpose and not a rotation. A true quarter turn about the origin,
 * `(c, r) -> (-r, c)`, sends the lateral coordinate negative, while automatic nodes
 * are positive. A diagram where every coordinate is authored then comes out
 * internally consistent and merely translated, which the view fit absorbs, but mixing
 * one hand-placed node with automatically placed ones puts them in different ranges
 * and flings the hand-placed node off the side of the diagram. Forcing it positive
 * again would need a content-derived pivot, and that would move the whole diagram
 * whenever a slicer changes which nodes are present. A quarter turn also sends the
 * top-left node to the top right, where a reader expects it to stay at the top left.
 *
 * `(c, r) -> (r, c)` solves both: positive stays positive, in the range the automatic
 * assignment uses, and the first stage's first node stays at the top left. The stage
 * coordinate comes through untouched (under a vertical reading the stage is the row,
 * and the new row is the old column), which is what makes a transposed grid safe to
 * mix with automatic stage assignment.
 *
 * A transpose is its own inverse, so canonical to screen and screen back to canonical
 * are the same call: there is no sign, turn count or direction of travel to get the
 * wrong way round. Two transposes are the identity, and the checks lean on that.
 *
 * Nothing downstream needs to know. `axisOf` and `senseOf` derive the axis and sense
 * from the corridors' resolved ports, so transposing the ports here makes them agree
 * with the setting by construction. The port mapping is not a free choice: East to
 * South and West to North is how `DEFAULT_PORTS` relates Left to right to Top to
 * bottom, and Right to left to Bottom to top.
 *
 * The grid-to-pixel mapping cannot be transposed instead. A port is a screen direction
 * (East is +x), so transposing the mapping without the ports would desynchronise node
 * sizing, label placement, arrow stripes and every geometric site in the routing. The
 * transform has to land before routing, and this is the one place it does.
 */

import { FlowAxis, FlowRow, GridWindow, Port } from "./model";
import { GridPosition, NodePositions, RouteHandleKind, RouteOverrides } from "./positions";
import { NodeEdits } from "./nodeEdits";

/** The transpose of a port: reflect (x, y) to (y, x). An involution. */
const TRANSPOSED: Record<Port, Port> = {
    East: "South",
    South: "East",
    West: "North",
    North: "West"
};

/**
 * Whether a reading is transposed from the canonical one: true for a vertical
 * reading, false for a horizontal one. That is the whole mapping, because the reversed
 * reading of each axis stays the mirror it already is: right to left is the same
 * diagram read the other way with its rows untouched.
 *
 * So this is a function of the axis, not of the direction, and the two horizontal
 * readings and the two vertical ones cannot come apart.
 */
export function transposedFor(axis: FlowAxis): boolean {
    return axis === "vertical";
}

/** A grid point transposed: `(c, r) -> (r, c)`. */
export function transposePoint(point: GridPosition, on: boolean): GridPosition {
    return on ? { column: point.row, row: point.column } : point;
}

/**
 * A grid rectangle transposed. The two ranges simply swap, and `lo <= hi` survives
 * for free: there is no sign to reorder, unlike a rotation.
 */
export function transposeWindow(window: GridWindow, on: boolean): GridWindow {
    return on
        ? {
            columnLo: window.rowLo, columnHi: window.rowHi,
            rowLo: window.columnLo, rowHi: window.columnHi
        }
        : window;
}

/** Every node placement transposed; the arrange marker rides along untouched. */
export function transposePositions(positions: NodePositions, on: boolean): NodePositions {
    if (!on) {
        return positions;
    }
    const out: NodePositions = new Map();
    positions.forEach((placement, id) => {
        out.set(id, placement.auto
            ? { column: placement.row, row: placement.column, auto: true }
            : { column: placement.row, row: placement.column });
    });
    return out;
}

/**
 * Every route handle transposed.
 *
 * The corner radius is left exactly as it is, because it is not a point: it is a
 * fraction of the tighter grid pitch, and which pitch is tighter is a property of the
 * drawn layout, not of the stored number. It is stamped with the axis it was set at
 * instead, and `withoutStaleRadii` clears it when that no longer matches, so after any
 * change every corner follows the Curvature slider.
 */
export function transposeOverrides(overrides: RouteOverrides, on: boolean): RouteOverrides {
    if (!on) {
        return overrides;
    }
    const kinds: RouteHandleKind[] = ["source", "target", "middle", "detour"];
    const out: RouteOverrides = new Map();
    overrides.forEach((handles, corridorId) => {
        const transposed = { ...handles };
        kinds.forEach(kind => {
            const point = handles[kind];
            if (point) {
                transposed[kind] = transposePoint(point, true);
            }
        });
        out.set(corridorId, transposed);
    });
    return out;
}

/** A port transposed the same way a coordinate is: East is +x, so they must agree. */
export function transposePort(port: Port, on: boolean): Port {
    return on ? TRANSPOSED[port] : port;
}

/**
 * The author's rows, transposed.
 *
 * Returns the same array when there is nothing to do, so the common reading costs one
 * comparison. It never mutates: a `FlowRow` is shared with the cached graph, the
 * corridors and selection's row lookups.
 *
 * It is applied after `parseDataView`, so validation still sees the author's own
 * values.
 */
export function transposeFlows(flows: readonly FlowRow[], on: boolean): FlowRow[] {
    const rows = flows as FlowRow[];
    return on ? rows.map(oneFlow) : rows;
}

function oneFlow(flow: FlowRow): FlowRow {
    const out: FlowRow = { ...flow };
    if (flow.sourcePort !== undefined) {
        out.sourcePort = TRANSPOSED[flow.sourcePort];
    }
    if (flow.targetPort !== undefined) {
        out.targetPort = TRANSPOSED[flow.targetPort];
    }
    // Nothing else on a flow has an axis: the ports above are the whole job here, and the
    // author's order is a sort key with no axis to swap. Hand-placed positions still
    // transpose, in `transposePositions`.
    return out;
}

/**
 * The node editor's own port choices, transposed.
 *
 * They have to be, for the same reason the data's ports are: a bound SourcePort is
 * transposed, so a node-level default left in the frame it was picked in would
 * disagree with it about which way is forward, and the two feed the same
 * `inferCorridors` call. Everything else an edit carries (a label, an icon, a colour,
 * a hidden name) has no frame and is copied through.
 */
export function transposeEditPorts(edits: NodeEdits, on: boolean): NodeEdits {
    if (!on) {
        return edits;
    }
    const out: NodeEdits = new Map();
    edits.forEach((edit, id) => {
        const transposed = { ...edit };
        if (edit.outPort !== undefined) {
            transposed.outPort = TRANSPOSED[edit.outPort];
        }
        if (edit.inPort !== undefined) {
            transposed.inPort = TRANSPOSED[edit.inPort];
        }
        out.set(id, transposed);
    });
    return out;
}
