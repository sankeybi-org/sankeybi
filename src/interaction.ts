/**
 * Node and route-handle dragging.
 *
 * This is kept out of render.ts, which stays a painter: this file owns pointer
 * handling and the pixel-to-grid conversion, and hands render nothing but a function to
 * attach to a shape.
 *
 * A drag moves a ghost outline and only commits on release. Re-running the pipeline on
 * every pointermove would be expensive and would fight Power BI's own update cycle:
 * `persistProperties` triggers an `update()`, so committing mid-drag would redraw the
 * diagram under the pointer dozens of times a second.
 */

import { LayoutResult, Point, PositionedNode } from "./model";
import { gridPositionOf, pixelPositionOf } from "./layoutView";
import { clampGridPosition, GridPosition, RouteHandleKind, snapToGrid, snapWithin } from "./positions";
import { AngleSnap, CornerHandle, LeadSide } from "./routeTypes";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Ignore a click that merely twitched; only a real move should persist anything. */
const DRAG_THRESHOLD = 3;

/**
 * Shapes whose last pointer sequence was a real drag, past the threshold.
 *
 * The browser synthesises a `click` after any pointerdown and pointerup pair, so without
 * this a node that was dragged across the diagram would also select itself on release,
 * and the report would cross-filter behind the author. A drag and a click share the same
 * gesture right up to the threshold, which is why the decision can only be made here.
 *
 * It is a WeakSet so a shape from a previous render is collected with the rest of the
 * discarded SVG; the flag is consumed once and never persists.
 */
const draggedShapes = new WeakSet<EventTarget>();

/** True if this shape just finished a real drag, and clears the flag. */
export function consumedByDrag(shape: EventTarget | null): boolean {
    if (!shape || !draggedShapes.has(shape)) {
        return false;
    }
    draggedShapes.delete(shape);
    return true;
}

export interface DragOptions {
    /** Where the diagram currently is, for converting pixels back to grid units. */
    layout: LayoutResult;
    /** Snap step in logical grid units; 0 places freely. */
    snapStep: number;
    /** The visual's own size, which bounds where a node can be dropped. */
    viewport: { width: number; height: number };
    /**
     * Lock grid: the drawing area, in pixels, that a node's drawn extent must stay inside.
     * Absent, the viewport bounds it and the grid extends to hold whatever is dropped;
     * present, a drop past the edge is held at it, so dragging can never widen the locked
     * window.
     */
    bounds?: { left: number; top: number; right: number; bottom: number };
    /** Called once, on release, with the node's new logical position. */
    onCommit: (nodeId: string, position: GridPosition) => void;
}

/** The same, for the three handles that shape a corridor's route. */
export interface WaypointDragOptions extends DragOptions {
    onMoveHandle: (corridorId: string, kind: RouteHandleKind, position: GridPosition) => void;
    onResetHandle: (corridorId: string, kind: RouteHandleKind) => void;
    /**
     * A self-loop's corner radius, as a fraction of the tighter grid pitch; `undefined`
     * resets it to the Curvature slider's.
     */
    onResizeCorner: (corridorId: string, radius: number | undefined) => void;
}

/**
 * Screen coordinates to the SVG's own user space. `getScreenCTM` accounts for whatever
 * scaling the host has applied to the visual's frame; the bounding rectangle is a
 * fallback for when it is not available (and for a non-rendering test harness).
 */
function toUserSpace(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
    const ctm = typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
    if (ctm && typeof svg.createSVGPoint === "function") {
        const point = svg.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        const mapped = point.matrixTransform(ctm.inverse());
        return { x: mapped.x, y: mapped.y };
    }
    const rect = svg.getBoundingClientRect();
    const width = Number(svg.getAttribute("width")) || rect.width || 1;
    const height = Number(svg.getAttribute("height")) || rect.height || 1;
    return {
        x: (clientX - rect.left) * (width / (rect.width || 1)),
        y: (clientY - rect.top) * (height / (rect.height || 1))
    };
}

/** Where a node would sit if dropped here: snapped, clamped, and back in pixels. */
function resolveDrop(
    options: DragOptions,
    node: PositionedNode,
    left: number,
    top: number
): { position: GridPosition; x: number; y: number } {
    // Bounded by the visual itself, so a node cannot be dropped somewhere it cannot be
    // seen. Pointer capture keeps events coming after the pointer leaves the visual, and
    // without this a drag onto the rest of the report canvas resolves to a far-off column
    // which the grid then stretches to hold, squashing the whole diagram. The grid should
    // grow past its old edges, but not to wherever a pointer happened to end up offscreen.
    if (options.bounds) {
        return resolveLockedDrop(options, options.bounds, node, left, top);
    }
    const boundedLeft = Math.max(0, Math.min(left, options.viewport.width - node.width));
    const boundedTop = Math.max(0, Math.min(top, options.viewport.height - node.height));
    const raw = gridPositionOf(options.layout, boundedLeft, boundedTop + node.height / 2);
    const position = clampGridPosition({
        column: snapToGrid(raw.column, options.snapStep),
        row: snapToGrid(raw.row, options.snapStep)
    });
    const pixels = pixelPositionOf(options.layout, position.column, position.row, node.height);
    return { position, x: pixels.x, y: pixels.y };
}

/**
 * A drop under Lock grid. The node's drawn extent (its shape, where that is bigger than
 * the node) is held inside the locked drawing area, and the snap is taken inside that
 * range too, so no drop, however far past the edge, can leave anything outside the
 * window for layout to widen it to hold.
 */
function resolveLockedDrop(
    options: DragOptions,
    bounds: { left: number; top: number; right: number; bottom: number },
    node: PositionedNode,
    left: number,
    top: number
): { position: GridPosition; x: number; y: number } {
    // Everything drawn for the node (shape and outside label), as layout measured it for
    // the fit, so a node held at the edge keeps its label in.
    const shapeX = Math.max(0, node.shapeWidth - node.width) / 2;
    const shapeY = Math.max(0, node.shapeHeight - node.height) / 2;
    const reach = node.drawnReach ?? { left: shapeX, right: shapeX, up: shapeY, down: shapeY };
    // The range of node-rectangle positions whose drawn extent fits, in grid units.
    const lo = gridPositionOf(options.layout, bounds.left + reach.left, bounds.top + reach.up + node.height / 2);
    const hi = gridPositionOf(options.layout, bounds.right - reach.right - node.width,
        bounds.bottom - reach.down - node.height / 2);
    const raw = gridPositionOf(options.layout, left, top + node.height / 2);
    const position = clampGridPosition({
        column: options.layout.columnGap > 0
            ? snapWithin(raw.column, options.snapStep, lo.column, hi.column)
            : raw.column,
        row: snapWithin(raw.row, options.snapStep, lo.row, hi.row)
    });
    const pixels = pixelPositionOf(options.layout, position.column, position.row, node.height);
    return { position, x: pixels.x, y: pixels.y };
}

/**
 * The pointer lifecycle every draggable thing shares: capture, a movement threshold, a
 * ghost that is cleaned up however the drag ends, and a commit that happens on release
 * and nowhere else.
 *
 * `track` decides what the drag currently means, in whatever terms the caller cares
 * about. It is called on every move; release needs no further call, since the last move
 * already computed the result.
 */
function attachDrag<T>(
    shape: SVGElement,
    svg: SVGSVGElement,
    track: (pointer: Point, delta: Point) => { value: T; ghost: SVGElement } | undefined,
    commit: (value: T) => void
): void {
    let ghost: SVGElement | undefined;
    let origin: Point | undefined;
    let pending: T | undefined;
    let moved = false;

    const clearGhost = () => {
        if (ghost) {
            svg.removeChild(ghost);
            ghost = undefined;
        }
    };

    const onPointerDown = (event: PointerEvent) => {
        // Left button only; a right-click belongs to the context menu.
        if (event.button !== 0) {
            return;
        }
        origin = toUserSpace(svg, event.clientX, event.clientY);
        pending = undefined;
        moved = false;
        if (typeof shape.setPointerCapture === "function") {
            shape.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
    };

    const onPointerMove = (event: PointerEvent) => {
        if (!origin) {
            return;
        }
        const pointer = toUserSpace(svg, event.clientX, event.clientY);
        const delta = { x: pointer.x - origin.x, y: pointer.y - origin.y };
        if (!moved && Math.hypot(delta.x, delta.y) < DRAG_THRESHOLD) {
            return;
        }
        moved = true;

        const tracked = track(pointer, delta);
        if (!tracked) {
            return;
        }
        pending = tracked.value;
        if (ghost !== tracked.ghost) {
            clearGhost();
            ghost = tracked.ghost;
            svg.appendChild(ghost);
        }
    };

    /** Ends the drag without deciding anything; returns what was in flight. */
    const teardown = (event: PointerEvent): T | undefined => {
        if (!origin) {
            return undefined;
        }
        origin = undefined;
        clearGhost();
        if (typeof shape.releasePointerCapture === "function" && shape.hasPointerCapture?.(event.pointerId)) {
            shape.releasePointerCapture(event.pointerId);
        }
        // A drag that never passed the threshold is a click, not a move: persisting there
        // would write the thing's own current position back and quietly pin it. When it did
        // pass, the shape is marked so the click the browser is about to synthesise does not
        // also select it.
        if (moved) {
            draggedShapes.add(shape);
        }
        const result = moved ? pending : undefined;
        pending = undefined;
        moved = false;
        return result;
    };

    const onPointerUp = (event: PointerEvent) => {
        const dropped = teardown(event);
        if (dropped !== undefined) {
            commit(dropped);
        }
    };

    /**
     * Escape, a cancelled touch, or the browser taking capture away. This is deliberately
     * not a commit: an abandoned drag must leave things where they were. `lostpointercapture`
     * also fires after a normal release, but by then teardown has run and this is a no-op.
     */
    const onPointerAbort = (event: PointerEvent) => {
        teardown(event);
    };

    shape.addEventListener("pointerdown", onPointerDown);
    shape.addEventListener("pointermove", onPointerMove);
    shape.addEventListener("pointerup", onPointerUp);
    shape.addEventListener("pointercancel", onPointerAbort);
    shape.addEventListener("lostpointercapture", onPointerAbort);
}

function makeGhost(tag: "rect" | "circle"): SVGElement {
    const ghost = document.createElementNS(SVG_NS, tag);
    ghost.setAttribute("class", "sankeybi-drag-ghost");
    ghost.setAttribute("fill", "none");
    ghost.setAttribute("stroke", "#605E5C");
    ghost.setAttribute("stroke-width", "1.5");
    ghost.setAttribute("stroke-dasharray", "4 3");
    ghost.setAttribute("pointer-events", "none");
    return ghost;
}

/**
 * Makes one node shape draggable.
 *
 * The ghost shows the snapped destination rather than following the pointer exactly, so
 * what you see during the drag is where the node will land.
 */
export function makeNodeDraggable(
    shape: SVGElement,
    node: PositionedNode,
    svg: SVGSVGElement,
    options: DragOptions
): void {
    shape.style.cursor = "move";
    const ghost = makeGhost("rect");
    ghost.setAttribute("width", String(node.width));
    ghost.setAttribute("height", String(node.height));

    attachDrag<GridPosition>(
        shape, svg,
        (_pointer, delta) => {
            const drop = resolveDrop(options, node, node.x + delta.x, node.y + delta.y);
            ghost.setAttribute("x", String(drop.x));
            ghost.setAttribute("y", String(drop.y));
            return { value: drop.position, ghost };
        },
        position => options.onCommit(node.id, position)
    );
}

/**
 * An Octilinear lead dragged with its diagonal's angle snapped.
 *
 * With the other end held, the lead alone sets the diagonal's angle, so snapping the
 * angle means choosing the lead: the along-route gap between the two lead ends is
 * `offset / tan(angle)`, where `offset` is how far apart the ends sit across the route
 * (the nodes fix that). Of the allowed angles (every multiple of the step strictly
 * between 0 and 180 degrees, so 45 gives 45, 90 and 135) the one nearest the angle the
 * pointer asks for wins, among those that keep the lead at or past the shortest routing
 * allows. 90 degrees is the two ends meeting, a right-angle step; past 90 the dragged
 * lead has run beyond the other end.
 *
 * Aligned ends (no offset) have no angle to snap, and the lead moves freely, as it does
 * when no allowed angle fits. Pure, so it is checked without a browser.
 */
export function snapLeadToAngle(point: Point, snap: AngleSnap, stepDegrees: number): Point {
    const toOther = { x: snap.other.x - snap.anchor.x, y: snap.other.y - snap.anchor.y };
    const reach = toOther.x * snap.normal.x + toOther.y * snap.normal.y;
    const offset = Math.hypot(toOther.x - snap.normal.x * reach, toOther.y - snap.normal.y * reach);
    const wanted = (point.x - snap.anchor.x) * snap.normal.x + (point.y - snap.anchor.y) * snap.normal.y;
    const at = (lead: number): Point => ({
        x: snap.anchor.x + snap.normal.x * lead,
        y: snap.anchor.y + snap.normal.y * lead
    });
    if (!(stepDegrees > 0) || offset < 0.5) {
        return at(Math.max(snap.minLead, wanted));
    }
    const asked = Math.atan2(offset, reach - wanted) * 180 / Math.PI;
    let best: number | undefined;
    let nearest = Infinity;
    for (let angle = stepDegrees; angle < 180 - 1e-9; angle += stepDegrees) {
        const lead = Math.abs(angle - 90) < 1e-9
            ? reach
            : reach - offset / Math.tan(angle * Math.PI / 180);
        if (lead < snap.minLead - 1e-9) {
            continue;
        }
        const miss = Math.abs(angle - asked);
        if (miss < nearest) {
            nearest = miss;
            best = lead;
        }
    }
    return at(best ?? Math.max(snap.minLead, wanted));
}

/** Where a point lands if dropped exactly here, with no grid snap. */
function resolveExact(options: DragOptions, x: number, y: number): { position: GridPosition; x: number; y: number } {
    const boundedX = Math.max(0, Math.min(x, options.viewport.width));
    const boundedY = Math.max(0, Math.min(y, options.viewport.height));
    const position = clampGridPosition(gridPositionOf(options.layout, boundedX, boundedY));
    const pixels = pixelPositionOf(options.layout, position.column, position.row, 0);
    return { position, x: pixels.x, y: pixels.y };
}

/** Where a bare point would land if dropped here: snapped, and back in pixels. */
function resolvePoint(options: DragOptions, x: number, y: number): { position: GridPosition; x: number; y: number } {
    const boundedX = Math.max(0, Math.min(x, options.viewport.width));
    const boundedY = Math.max(0, Math.min(y, options.viewport.height));
    const raw = gridPositionOf(options.layout, boundedX, boundedY);
    const position = clampGridPosition({
        column: snapToGrid(raw.column, options.snapStep),
        row: snapToGrid(raw.row, options.snapStep)
    });
    const pixels = pixelPositionOf(options.layout, position.column, position.row, 0);
    return { position, x: pixels.x, y: pixels.y };
}

/** Radius of a route handle, and of the ghost that follows the pointer. */
const HANDLE_RADIUS = 5;

/**
 * One of a corridor's three route handles: drag to move it, double-click to put it
 * back where routing wanted it.
 *
 * A handle is constrained to a single axis. A lead handle may only slide along its
 * port's normal, because dragging it sideways would break the perpendicular exit the
 * whole port model rests on; a crossover may only slide along the one coordinate that
 * means anything for its construction. The handle's other coordinate stays exactly
 * where routing put it, so what you can do is adjust the route's own shape rather than
 * invent a new one.
 *
 * Reset is a double-click rather than a modifier-click, which would collide with Power
 * BI's own selection gestures.
 */
export function makeHandleDraggable(
    handle: SVGElement,
    corridorId: string,
    kind: RouteHandleKind,
    axis: "x" | "y",
    origin: Point,
    svg: SVGSVGElement,
    options: WaypointDragOptions,
    /**
     * Present when the handle is drawn on the middle of the loop side it places rather than
     * at its stub (a Smooth self-loop's lead). The pointer moves the drawn point; `toStub`
     * turns that into the stub, which is what is snapped and stored, and `toDrawn` keeps
     * the ghost on the side.
     */
    side?: LeadSide,
    /** Present on an Octilinear diagonal's lead: snap its angle while dragging. */
    angleSnap?: AngleSnap
): void {
    handle.style.cursor = axis === "x" ? "ew-resize" : "ns-resize";
    const ghost = makeGhost("circle");
    ghost.setAttribute("r", String(HANDLE_RADIUS));

    attachDrag<GridPosition>(
        handle, svg,
        pointer => {
            if (angleSnap) {
                const along = snapLeadToAngle({
                    x: axis === "x" ? pointer.x : origin.x,
                    y: axis === "y" ? pointer.y : origin.y
                }, angleSnap, angleSnap.step);
                // Not grid-snapped: an angle and a grid step cannot both hold, and the angle is what
                // the setting was chosen for.
                const exact = resolveExact(options, along.x, along.y);
                ghost.setAttribute("cx", String(exact.x));
                ghost.setAttribute("cy", String(exact.y));
                return { value: exact.position, ghost };
            }
            if (side) {
                const stub = side.toStub({
                    x: axis === "x" ? pointer.x : origin.x,
                    y: axis === "y" ? pointer.y : origin.y
                });
                const snapped = resolvePoint(options, stub.x, stub.y);
                const shown = side.toDrawn({ x: snapped.x, y: snapped.y });
                ghost.setAttribute("cx", String(shown.x));
                ghost.setAttribute("cy", String(shown.y));
                return { value: snapped.position, ghost };
            }
            const drop = resolvePoint(
                options,
                axis === "x" ? pointer.x : origin.x,
                axis === "y" ? pointer.y : origin.y);
            ghost.setAttribute("cx", String(drop.x));
            ghost.setAttribute("cy", String(drop.y));
            return { value: drop.position, ghost };
        },
        position => options.onMoveHandle(corridorId, kind, position)
    );

    handle.addEventListener("dblclick", event => {
        event.preventDefault();
        event.stopPropagation();
        options.onResetHandle(corridorId, kind);
    });
}

/**
 * A Smooth self-loop's corner handle: drag along the corner's diagonal to make the
 * loop's corners rounder (inwards) or sharper (towards the corner).
 *
 * It is constrained to that diagonal like every other handle is to its one axis: the
 * pointer is projected onto the line through the corner's apex, so only the component
 * along it counts. Two things differ from the position handles, both on purpose:
 *
 * - It is not snapped to the grid. A radius is a length, not a place, and snapping the
 *   pointer to grid points before projecting it onto a diagonal would make the handle
 *   lurch between the few spots where the two happen to line up.
 * - The ghost stops where the drawing will. Rounding never resizes the loop, so the
 *   limits cannot move during the drag: tighter than the band's half-width the ribbon
 *   turns inside out, and rounder than `maxRadius` a straight has run out. Clamping the
 *   ghost there shows the result honestly instead of a handle that jumps back on
 *   release.
 */
export function makeCornerDraggable(
    handle: SVGElement,
    corridorId: string,
    corner: CornerHandle,
    svg: SVGSVGElement,
    options: WaypointDragOptions
): void {
    handle.style.cursor = Math.sign(corner.direction.x) === Math.sign(corner.direction.y)
        ? "nwse-resize" : "nesw-resize";
    const ghost = makeGhost("circle");
    ghost.setAttribute("r", String(HANDLE_RADIUS));
    const low = corner.minRadius;
    const high = Math.max(low, corner.maxRadius);

    attachDrag<number>(
        handle, svg,
        pointer => {
            const along = (pointer.x - corner.apex.x) * corner.direction.x
                + (pointer.y - corner.apex.y) * corner.direction.y;
            const radius = Math.max(low, Math.min(high,
                corner.spread > 0 ? Math.max(0, along) / corner.spread : low));
            ghost.setAttribute("cx", String(corner.apex.x + corner.direction.x * radius * corner.spread));
            ghost.setAttribute("cy", String(corner.apex.y + corner.direction.y * radius * corner.spread));
            return { value: radius / corner.pitch, ghost };
        },
        radius => options.onResizeCorner(corridorId, radius)
    );

    handle.addEventListener("dblclick", event => {
        event.preventDefault();
        event.stopPropagation();
        options.onResizeCorner(corridorId, undefined);
    });
}
