/**
 * Hand-placed node positions and route handles, persisted back into the report.
 *
 * Two decisions shape this file.
 *
 * Positions are logical grid coordinates, never pixels. A dragged pixel position is wrong
 * the moment the visual or the window is resized, or the report is opened on another
 * screen. Decimal columns and rows are what let a grid position express an arbitrary drop
 * point: a node dropped between two columns is simply at 2.37.
 *
 * The positions are one JSON blob, persisted at visual level. Nodes are derived from the
 * Source and Target columns rather than being rows of the data view, so there is no data
 * identity to hang a per-node format object off and selector-based persistence is not
 * available. The blob is declared in `capabilities.json` (a property has to be declared to
 * be persisted) but given no formatting slice, so it never appears in the pane.
 */

import { FlowAxis, FlowRow, GridWindow } from "./model";

export interface GridPosition {
    column: number;
    row: number;
}

/**
 * A stored node position, and whether Arrange nodes put it there.
 *
 * The flag exists because that button writes a position for every node (an arrangement is
 * only the arrangement if nothing is left to the automatic row assignment), and it skips
 * nodes the author placed by hand. Without a way to tell the two apart, the first press
 * would make the whole diagram look hand-placed and every press after it would be a no-op.
 * Dragging a node clears the flag: once you have moved it yourself, it is yours.
 */
export interface NodePlacement extends GridPosition {
    auto?: boolean;
}

export type NodePositions = Map<string, NodePlacement>;

/**
 * A dragged position may sit above or to the left of the grid's usual start (column 0.4,
 * row -1.2), and layout extends the grid to hold it, exactly as it already stretches to
 * hold something dragged past the bottom or right. Clamping at 1 would make the top and left
 * edges walls while the other two gave way.
 */
/** Enough precision for any screen, without persisting float noise. */
const STORED_DECIMALS = 4;

/**
 * Reads the persisted blob. It is deliberately total: anything unparseable, of the wrong
 * shape, or carrying a non-finite or out-of-range number is dropped rather than thrown on.
 * This string survives in a report file and can be edited by hand, so a bad one has to
 * degrade to "no saved positions" instead of breaking the visual.
 */
export function parseNodePositions(raw: unknown): NodePositions {
    const positions: NodePositions = new Map();
    if (typeof raw !== "string" || raw.trim() === "") {
        return positions;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return positions;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return positions;
    }
    Object.entries(parsed as Record<string, unknown>).forEach(([id, value]) => {
        // Two numbers, or two numbers and the arrange marker, which is the literal 1 and nothing
        // else, so a third element of any other value is malformed.
        if (!Array.isArray(value)
            || (value.length !== 2 && !(value.length === 3 && value[2] === 1))) {
            return;
        }
        // `typeof`, not `Number()`. Coercion is far too willing here: `Number(null)` and
        // `Number([])` are both 0 and `Number(true)` is 1, so a malformed entry would quietly become a
        // real position at the grid's origin instead of being discarded. JSON can only produce
        // numbers, strings, booleans, null, objects and arrays, so insisting on a genuine number
        // rejects every one of the others cleanly.
        const column = value[0];
        const row = value[1];
        if (typeof column !== "number" || typeof row !== "number") {
            return;
        }
        if (!Number.isFinite(column) || !Number.isFinite(row)) {
            return;
        }
        positions.set(id, value.length === 3 ? { column, row, auto: true } : { column, row });
    });
    return positions;
}

/**
 * The inverse. Pairs rather than objects, and rounded, purely to keep the string short: it
 * lives in the report's own metadata and is rewritten on every drag.
 */
export function serialiseNodePositions(positions: NodePositions): string {
    if (positions.size === 0) {
        return "";
    }
    const out: Record<string, [number, number] | [number, number, 1]> = {};
    positions.forEach((p, id) => {
        out[id] = p.auto
            ? [round(p.column), round(p.row), 1]
            : [round(p.column), round(p.row)];
    });
    return JSON.stringify(out);
}

function round(value: number): number {
    const factor = Math.pow(10, STORED_DECIMALS);
    return Math.round(value * factor) / factor;
}

/**
 * Rounds a logical grid coordinate to the nearest step, so nodes can be lined up by hand. It
 * is expressed in grid units rather than pixels, so a quarter of a column stays a quarter of
 * a column when the visual is resized, where a 20px step would not.
 *
 * A step of 0 (or anything invalid) means free positioning.
 */
export function snapToGrid(value: number, step: number): number {
    if (!Number.isFinite(step) || step <= 0) {
        return value;
    }
    return Math.round(value / step) * step;
}

/**
 * The one thing a dropped position genuinely cannot be is not a number. There is no floor
 * (see the note at the top of this file), but a NaN would poison every span layout computes
 * from it, so it falls back to the grid's start.
 */
export function clampGridPosition(position: GridPosition): GridPosition {
    return {
        column: Number.isFinite(position.column) ? position.column : 1,
        row: Number.isFinite(position.row) ? position.row : 1
    };
}

/**
 * Which of a corridor's route handles has been moved by hand.
 *
 * This is deliberately not an arbitrary list of waypoints. Every route construction's middle
 * points turn out to be derived from a single free parameter: a Z's two corners share one
 * crossover coordinate, a wrap's two share one lane, an L's single corner is just where the
 * two stubs meet, and a detour's box shares the one lane it travels along. So the honest set
 * of things a person can move is four, each with one degree of freedom: how far the route
 * runs out of each port, where it steps across, and which side it passes an obstacle on.
 *
 * That set is also stable in a way "waypoint number 2" could never be: it does not change
 * when the routing style or the curvature does. Letting people drop free waypoints anywhere
 * gives enough rope to tie a corridor in a knot.
 */
export type RouteHandleKind = "source" | "target" | "middle" | "detour";

export interface RouteHandleOverrides {
    source?: GridPosition;
    target?: GridPosition;
    middle?: GridPosition;
    /**
     * Where a route that has been sent around a node passes it.
     *
     * Avoidance replaces a blocked route's middle with a detour, and a detour has exactly one free
     * parameter, the lane it travels along across the direction it is going. That is the same
     * single degree of freedom a wrap's lane has, so it earns a handle on the same terms as the
     * three above.
     *
     * It is its own field rather than `middle`, which already means the crossover. The two are
     * never both live (a squared detour pins its approach runs to the stubs, so the crossover
     * cannot move the drawing), but sharing one number would mean a lane dropped here is read
     * back as a crossover the moment the obstacle moves away, a visible jump. Kept apart, a stored
     * lane is simply ignored while nothing is in the way and means what it said again if the
     * obstacle comes back, which is the promise `clearCrossover` makes about a hand-placed
     * crossover surviving a node move.
     */
    detour?: GridPosition;
    /**
     * A Smooth self-loop's corner radius, set by its corner handle. It is stored as a fraction
     * of the tighter grid pitch (the unit the Curvature slider uses), not in pixels, so it means
     * the same thing after a resize. It is a length rather than a point because the handle's
     * position is derived from it: a stored point would change the radius every time a lead or the
     * lane moved the corner.
     */
    radius?: number;
    /**
     * The Curvature setting (percent) the radius was set at. A hand-set radius only holds while
     * the slider is at that value: move the slider and every hand-set corner follows it (see
     * `withoutStaleRadii`).
     */
    radiusCurvature?: number;
    /**
     * The port axis the radius was set at. A radius is a fraction of the tighter grid pitch, and a
     * quarter turn can swap which pitch that is, so unlike every other stored handle it has no
     * canonical frame to be turned into, and is stamped instead. A radius set at another axis is
     * not in force, by the same rule the Curvature slider follows.
     */
    radiusAxis?: FlowAxis;
}

export type RouteOverrides = Map<string, RouteHandleOverrides>;

/** Short keys: this string is rewritten on every drag and lives in the report. */
const HANDLE_KEYS: Record<RouteHandleKind, string> = { source: "s", target: "t", middle: "m", detour: "d" };
const RADIUS_KEY = "r";
const RADIUS_CURVATURE_KEY = "c";
const RADIUS_AXIS_KEY = "a";

export function parseRouteOverrides(raw: unknown): RouteOverrides {
    const out: RouteOverrides = new Map();
    if (typeof raw !== "string" || raw.trim() === "") {
        return out;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return out;
    }
    Object.entries(parsed as Record<string, unknown>).forEach(([id, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }
        const entry = value as Record<string, unknown>;
        const handles: RouteHandleOverrides = {};
        let any = false;
        (Object.keys(HANDLE_KEYS) as RouteHandleKind[]).forEach(kind => {
            const point = readPoint(entry[HANDLE_KEYS[kind]]);
            if (point) {
                handles[kind] = point;
                any = true;
            }
        });
        const radius = readRadius(entry[RADIUS_KEY]);
        if (radius !== undefined) {
            handles.radius = radius;
            any = true;
            const at = entry[RADIUS_CURVATURE_KEY];
            if (typeof at === "number" && Number.isFinite(at) && at >= 0) {
                handles.radiusCurvature = at;
            }
            // Only the two real axes; anything else is "not stamped", which reads as not in force rather
            // than as horizontal. A radius nothing can vouch for is exactly what this clears.
            const axis = entry[RADIUS_AXIS_KEY];
            if (axis === "horizontal" || axis === "vertical") {
                handles.radiusAxis = axis;
            }
        }
        if (any) {
            out.set(id, handles);
        }
    });
    return out;
}

/** Total, like readPoint: anything that is not a positive finite number is "not set". */
function readRadius(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPoint(value: unknown): GridPosition | undefined {
    if (!Array.isArray(value) || value.length !== 2) {
        return undefined;
    }
    const [column, row] = value;
    // `typeof`, not `Number()`: coercion would turn null into 0 and quietly invent a handle at the
    // grid's origin.
    if (typeof column !== "number" || typeof row !== "number") {
        return undefined;
    }
    if (!Number.isFinite(column) || !Number.isFinite(row)) {
        return undefined;
    }
    return { column, row };
}

export function serialiseRouteOverrides(overrides: RouteOverrides): string {
    const out: Record<string, Record<string, [number, number] | number | string>> = {};
    let any = false;
    overrides.forEach((handles, id) => {
        const entry: Record<string, [number, number] | number | string> = {};
        let some = false;
        (Object.keys(HANDLE_KEYS) as RouteHandleKind[]).forEach(kind => {
            const point = handles[kind];
            if (point) {
                entry[HANDLE_KEYS[kind]] = [round(point.column), round(point.row)];
                some = true;
            }
        });
        if (handles.radius !== undefined) {
            entry[RADIUS_KEY] = round(handles.radius);
            if (handles.radiusCurvature !== undefined) {
                entry[RADIUS_CURVATURE_KEY] = round(handles.radiusCurvature);
            }
            if (handles.radiusAxis !== undefined) {
                entry[RADIUS_AXIS_KEY] = handles.radiusAxis;
            }
            some = true;
        }
        if (some) {
            out[id] = entry;
            any = true;
        }
    });
    return any ? JSON.stringify(out) : "";
}

/** One handle moved. Passing `undefined` resets that handle to its computed place. */
export function withRouteHandle(
    overrides: RouteOverrides,
    corridorId: string,
    kind: RouteHandleKind,
    position: GridPosition | undefined
): RouteOverrides {
    const next = new Map(overrides);
    const current: RouteHandleOverrides = { ...(next.get(corridorId) ?? {}) };
    if (position) {
        current[kind] = clampGridPosition(position);
    } else {
        delete current[kind];
    }
    return withEntry(next, corridorId, current);
}

/** A corridor's entry, or no entry at all once nothing is left in it. */
function withEntry(next: RouteOverrides, corridorId: string, current: RouteHandleOverrides): RouteOverrides {
    if (current.source || current.target || current.middle || current.detour
        || current.radius !== undefined) {
        next.set(corridorId, current);
    } else {
        next.delete(corridorId);
    }
    return next;
}

/**
 * A self-loop's corner radius set, as a fraction of the tighter grid pitch. Passing
 * `undefined` resets it, so the Curvature slider decides again.
 */
export function withRouteRadius(
    overrides: RouteOverrides,
    corridorId: string,
    radius: number | undefined,
    /** The Curvature setting (percent) in force as the radius is set. */
    curvature?: number,
    /** The port axis in force as it is set; see `radiusAxis`. */
    axis?: FlowAxis
): RouteOverrides {
    const next = new Map(overrides);
    const current: RouteHandleOverrides = { ...(next.get(corridorId) ?? {}) };
    if (radius !== undefined && Number.isFinite(radius) && radius > 0) {
        current.radius = radius;
        if (curvature !== undefined && Number.isFinite(curvature)) {
            current.radiusCurvature = curvature;
        } else {
            delete current.radiusCurvature;
        }
        if (axis !== undefined) {
            current.radiusAxis = axis;
        } else {
            delete current.radiusAxis;
        }
    } else {
        delete current.radius;
        delete current.radiusCurvature;
        delete current.radiusAxis;
    }
    return withEntry(next, corridorId, current);
}

/**
 * The hand-set corner radius in force at this Curvature setting and this port axis: the
 * stored one only if it was set at exactly both, otherwise none, so the corner follows the
 * slider and follows a turn of the diagram. A radius with no recorded setting or no recorded
 * axis is not in force either, since nothing can say it still applies.
 *
 * The axis is here and not in the transposition of the other handles because a radius has no
 * canonical frame. Every other stored handle is a point and turns exactly; a radius is a
 * fraction of the tighter grid pitch, and which pitch that is belongs to the drawn layout
 * rather than to the stored number, so a quarter turn can change what it means without
 * changing it. It is stamped and cleared, by the rule the slider already follows.
 */
export function radiusInForce(
    handles: RouteHandleOverrides, curvature: number, axis?: FlowAxis
): number | undefined {
    if (handles.radius === undefined || handles.radiusCurvature === undefined) {
        return undefined;
    }
    if (axis !== undefined && handles.radiusAxis !== axis) {
        return undefined;
    }
    return Math.abs(handles.radiusCurvature - curvature) < 1e-6 ? handles.radius : undefined;
}

/**
 * Moving the Curvature slider clears every hand-set corner, and so does turning the diagram.
 * Returns the overrides with every radius removed that is not in force, or `undefined` when
 * there is nothing to remove.
 *
 * One rule holds for every corner: after any slider move, all corners follow the slider.
 * Keeping such radii would let moving the slider back restore a corner the author had shaped,
 * but across a diagram it reads as a glitch, since each corner remembers its own setting and
 * a slider change is picked up by one loop and not another with no visible reason.
 *
 * It is stateless on purpose: any radius whose recorded setting differs from the current one
 * can only be there because the slider has moved since, so there is no need to remember what
 * the slider was, which also covers Power BI recreating the visual.
 */
export function withoutStaleRadii(
    overrides: RouteOverrides, curvature: number, axis?: FlowAxis
): RouteOverrides | undefined {
    let next: RouteOverrides | undefined;
    overrides.forEach((handles, corridorId) => {
        if (handles.radius !== undefined && radiusInForce(handles, curvature, axis) === undefined) {
            next = withRouteRadius(next ?? overrides, corridorId, undefined);
        }
    });
    return next;
}

/** A copy of `positions` with one node moved. Drags never mutate the map they read. */
export function withNodeMoved(
    positions: NodePositions,
    nodeId: string,
    position: GridPosition
): NodePositions {
    const next = new Map(positions);
    // `clampGridPosition` returns a bare column and row, so a drag clears the arrange marker by
    // construction: a node you have moved yourself is hand-placed, and the next press of the
    // button leaves it alone.
    next.set(nodeId, clampGridPosition(position));
    return next;
}

/**
 * The nodes the author placed by hand, and where: everything Arrange nodes must not touch.
 * Positions rather than ids, because the arranging pass works from a graph with no stored
 * positions applied and would otherwise have nowhere to read them from.
 */
export function handPlacedPositions(positions: NodePositions): Map<string, GridPosition> {
    const out = new Map<string, GridPosition>();
    positions.forEach((position, id) => {
        if (!position.auto) {
            out.set(id, { column: position.column, row: position.row });
        }
    });
    return out;
}

/**
 * Folds an arrangement into the stored positions.
 *
 * Hand-placed entries are kept exactly as they are: the search was told not to move them, and
 * what it hands back for them is only what it was given. Everything else is marked as
 * automatically placed, so a later press searches it again rather than mistaking it for the
 * author's own work.
 */
export function withAutoPlacement(
    positions: NodePositions,
    placed: NodePositions
): NodePositions {
    const next = new Map(positions);
    const handPlaced = handPlacedPositions(positions);
    placed.forEach((position, id) => {
        if (handPlaced.has(id)) {
            return;
        }
        next.set(id, { column: position.column, row: position.row, auto: true });
    });
    return next;
}

/**
 * Lock grid's stored window: `[columnLo, columnHi, rowLo, rowHi]`, the grid rectangle the
 * drawing area shows. Parsing is total like the other blobs: anything malformed is "nothing
 * stored", which simply means the view fits the content again. A zero-width column range is
 * allowed (a single column has no gap to measure); a zero-height row range is not.
 */
export function parseGridWindow(raw: unknown): GridWindow | undefined {
    if (typeof raw !== "string" || raw.trim() === "") {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed) || parsed.length !== 4
        || !parsed.every(v => typeof v === "number" && Number.isFinite(v))) {
        return undefined;
    }
    const [columnLo, columnHi, rowLo, rowHi] = parsed as number[];
    if (columnHi < columnLo || rowHi <= rowLo) {
        return undefined;
    }
    return { columnLo, columnHi, rowLo, rowHi };
}

export function serialiseGridWindow(window: GridWindow | undefined): string {
    if (!window) {
        return "";
    }
    return JSON.stringify([window.columnLo, window.columnHi, window.rowLo, window.rowHi].map(round));
}

/**
 * Snaps a coordinate, but never out of `[lo, hi]`: where rounding would step past an end, it
 * takes the nearest step on the inside instead. Lock grid needs this, because a drop clamped to
 * the window's edge and then rounded past it would widen the window it is meant to hold. Where
 * no step fits inside the range at all, the unsnapped value (clamped) is the honest answer.
 */
export function snapWithin(value: number, step: number, lo: number, hi: number): number {
    if (hi < lo) {
        return (lo + hi) / 2;
    }
    const clamped = Math.min(Math.max(value, lo), hi);
    const snapped = snapToGrid(clamped, step);
    if (snapped >= lo - 1e-9 && snapped <= hi + 1e-9) {
        return snapped;
    }
    const inward = snapped < lo ? Math.ceil(lo / step - 1e-9) * step : Math.floor(hi / step + 1e-9) * step;
    return inward >= lo - 1e-9 && inward <= hi + 1e-9 ? inward : clamped;
}

/**
 * Arrange nodes under Lock grid: the arrangement mapped onto the locked window. The search
 * works in its own grid units, and fitting the view to it is what normally shows it whole; with
 * the view locked, the positions are moved instead. The arrangement's fitted window (`from`) is
 * mapped affinely onto the locked one (`to`), so it fills the locked view exactly as it would
 * have filled a fitted one. Hand-placed nodes (`keep`) are left where they are. An axis with no
 * extent (a single column) is left alone.
 */
export function mapIntoWindow(
    positions: NodePositions,
    from: GridWindow,
    to: GridWindow,
    keep: (id: string) => boolean,
    snapStep: number
): NodePositions {
    const axis = (fromLo: number, fromHi: number, toLo: number, toHi: number) =>
        fromHi - fromLo > 1e-9 && toHi - toLo > 1e-9
            ? (v: number) => snapToGrid(toLo + (v - fromLo) * (toHi - toLo) / (fromHi - fromLo), snapStep)
            : (v: number) => v;
    const column = axis(from.columnLo, from.columnHi, to.columnLo, to.columnHi);
    const row = axis(from.rowLo, from.rowHi, to.rowLo, to.rowHi);
    const next: NodePositions = new Map();
    positions.forEach((position, id) => {
        next.set(id, keep(id)
            ? position
            : { ...position, column: column(position.column), row: row(position.row) });
    });
    return next;
}

/**
 * `mapIntoWindow`, repeated until the fitted window is the locked one.
 *
 * One map is not quite exact: a node's size in grid units depends on the pitches (a North or
 * South node's width follows the row pitch, not the column gap), so changing the window's shape
 * changes how far the outermost nodes reach. Re-fitting and mapping again converges fast, to
 * under a hundredth of a grid unit after three rounds. `windowOf` is the layout's own fit,
 * passed in so this stays pure. It snaps on the last round only, so the rounding is not
 * compounded.
 */
export function fitIntoWindow(
    positions: NodePositions,
    to: GridWindow,
    keep: (id: string) => boolean,
    snapStep: number,
    windowOf: (positions: NodePositions) => GridWindow,
    rounds = 3
): NodePositions {
    let current = positions;
    for (let round = 0; round < rounds; round++) {
        current = mapIntoWindow(current, windowOf(current), to, keep, round === rounds - 1 ? snapStep : 0);
    }
    return current;
}

/**
 * What the stored arrangement was computed against, as one short string.
 *
 * Only the roles that change the geometry belong in it. Binding a port moves which face a flow
 * leaves by, so an arrangement computed without ports was computed against a different diagram
 * and is worth redoing; binding a colour or a label is not. A role bound but empty reads as
 * unbound, which is the honest answer: it changes nothing about where anything goes.
 *
 * The flags are about what is bound, not what the ports resolve to, and not the values the
 * roles carry. A digest of the resolved ports or values would also change when a slicer drops
 * the last row carrying a port or a category, which would re-arrange the diagram on a filter,
 * the one thing this must never do. The cost is that editing an order once the role is bound
 * does not re-arrange on its own; it needs an Arrange nodes press, like any other change to a
 * layout that already exists.
 *
 * There are four flags, not two: under a single "has ports" flag the first binding would spend
 * the signature and the second, which can change the diagram a great deal, could not be seen.
 * Binding TargetOrder after SourceOrder adds order facts for the sink nodes, which is a
 * different diagram again.
 *
 * Flow direction is deliberately not in here. A direction change needs no arrangement, because
 * the author's grid and their hand placement follow the diagram round (see transpose.ts), and
 * firing one would be destructive: an arrangement writes a position for every node, and a stored
 * position beats a data override, so re-arranging on a direction change would hide the author's
 * own stage and order values.
 *
 * The rule generalises: a signature change is a licence to overwrite the author's layout, so
 * something belongs in here only when the old arrangement is genuinely meaningless for the new
 * diagram, never merely because the picture moved. Declared orders qualify, because a stored
 * arrangement made before the author declared an order may split a group they have just asked
 * for, or run two nodes the opposite way up.
 */
export function fitSignatureOf(flows: readonly FlowRow[]): string {
    const source = flows.some(flow => flow.sourcePort !== undefined);
    const target = flows.some(flow => flow.targetPort !== undefined);
    const sourceOrder = flows.some(flow => flow.sourceOrder !== undefined);
    const targetOrder = flows.some(flow => flow.targetOrder !== undefined);
    return `stv${source ? "+s" : ""}${target ? "+t" : ""}`
        + `${sourceOrder ? "+os" : ""}${targetOrder ? "+ot" : ""}`;
}

/**
 * Whether the arrangement should run on its own this update.
 *
 * An automatic arrangement is never applied over one that already exists. It fires in exactly
 * two cases:
 *
 * - Nothing is stored at all. This covers a chart that has just had Source, Target and Value
 *   bound, and one whose positions have just been reset: reset writes an empty map, so it means
 *   "start over from the best automatic guess" rather than "show me the bare grid".
 * - The signature has changed, which today means ports or orders have been bound or unbound
 *   since the arrangement was made. A signature that was never written does not count as a
 *   change: that is the first case's job, and treating it as a change would re-arrange a diagram
 *   on every update until something stored one.
 *
 * It is deliberately a pure function of five facts, because the one thing that must not go wrong
 * here is a loop: an automatic arrangement that persists, and then fires again on the update its
 * own persist brings, would never settle. `positions-check` walks the whole cycle on it.
 */
export function needsAutomaticArrange(state: {
    /** False in a reading view, where nothing can be written back. */
    canPersist: boolean;
    /** Flows parsed this update; none means there is nothing to arrange. */
    flowCount: number;
    /** Positions stored right now, hand-placed and automatic alike. */
    placedCount: number;
    /** The signature the stored arrangement was made against; "" if none. */
    storedSignature: string;
    /** The signature this update's data asks for. */
    signature: string;
    /** True while either node button is down: a press wins, and writes the signature itself. */
    buttonDown: boolean;
}): boolean {
    if (!state.canPersist || state.flowCount === 0 || state.buttonDown) {
        return false;
    }
    if (state.placedCount === 0) {
        return true;
    }
    return state.storedSignature !== "" && state.storedSignature !== state.signature;
}
