import { GridWindow, LayoutResult, PixelRect } from "./model";

/**
 * Where the routed flows reach, in grid units (`undefined` when there are none). visual.ts
 * routes once, measures this, and if it reaches past the nodes and labels lays out again with
 * it counted as content, so the fit's margin sits outside the outermost flow instead of a flow
 * spilling flush against one edge.
 */
export function flowExtentOf(layout: LayoutResult, bands: { bounds: { minX: number; minY: number; maxX: number; maxY: number } }[]): GridWindow | undefined {
    if (bands.length === 0) {
        return undefined;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    bands.forEach(b => {
        minX = Math.min(minX, b.bounds.minX);
        minY = Math.min(minY, b.bounds.minY);
        maxX = Math.max(maxX, b.bounds.maxX);
        maxY = Math.max(maxY, b.bounds.maxY);
    });
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
        return undefined;
    }
    const a = gridPositionOf(layout, minX, minY);
    const b = gridPositionOf(layout, maxX, maxY);
    // Ordered, not assumed: on a reversed axis the lowest pixel is the highest grid coordinate,
    // and a window with lo > hi would read as negative extent and make the fit's flow pass ask for
    // a smaller diagram than it drew.
    return {
        columnLo: Math.min(a.column, b.column), columnHi: Math.max(a.column, b.column),
        rowLo: Math.min(a.row, b.row), rowHi: Math.max(a.row, b.row)
    };
}

/** The smallest window holding both. */
export function unionOf(a: GridWindow, b: GridWindow): GridWindow {
    return {
        columnLo: Math.min(a.columnLo, b.columnLo),
        columnHi: Math.max(a.columnHi, b.columnHi),
        rowLo: Math.min(a.rowLo, b.rowLo),
        rowHi: Math.max(a.rowHi, b.rowHi)
    };
}

/**
 * Would another flow pass move anything? The content the fit should have used (nodes and
 * labels, widened to where the flows were actually drawn) against the content it did use, in
 * pixels. More than a pixel apart on any side and the layout is re-solved with the measured
 * flows.
 *
 * A second pass is sometimes needed because a flow is not quite proportional to one pitch: a
 * band's width follows the row pitch while a wrap's lane follows the tighter one, so
 * re-solving the pitches moves the flows a little. Each pass leaves a fraction of the previous
 * miss, so most diagrams settle in one or two, and one whose flows stay inside its nodes needs
 * none.
 */
export function flowPassNeeded(layout: LayoutResult, measured: GridWindow | undefined): boolean {
    const wanted = measured ? {
        columnLo: Math.min(layout.nodeContent.columnLo, measured.columnLo),
        columnHi: Math.max(layout.nodeContent.columnHi, measured.columnHi),
        rowLo: Math.min(layout.nodeContent.rowLo, measured.rowLo),
        rowHi: Math.max(layout.nodeContent.rowHi, measured.rowHi)
    } : layout.nodeContent;
    const used = layout.content;
    const byColumns = layout.columnGap > 0
        ? Math.max(Math.abs(wanted.columnLo - used.columnLo), Math.abs(wanted.columnHi - used.columnHi)) * layout.columnGap
        : 0;
    const byRows = Math.max(Math.abs(wanted.rowLo - used.rowLo), Math.abs(wanted.rowHi - used.rowHi)) * layout.rowPitch;
    return Math.max(byColumns, byRows) > 1;
}

/**
 * The inverse of the two lines at the heart of computeLayout:
 *
 *     x = leftOffset + (col - originColumn) * columnGap
 *     y = topMargin  + (row - originRow)    * rowPitch - height / 2
 *
 * Dragging is what needs this: a drop lands on a pixel and has to be stored as a logical grid
 * position, because pixels stop meaning anything the moment the visual is resized. Decimal
 * columns and rows are what make the answer expressible: a drop between two columns is simply
 * 2.37.
 *
 * It is kept here, immediately beside the forward transform, so the two cannot drift apart.
 * `centreY` is used rather than the node's top, since the caller knows the node's height and
 * the row is defined against its middle.
 *
 * A single-column diagram has columnGap 0 and every node at column 1; there is no horizontal
 * grid to land on, so the column cannot move.
 */
export function gridPositionOf(
    layout: LayoutResult,
    x: number,
    centreY: number
): { column: number; row: number } {
    const column = layout.columnGap > 0
        ? (x - layout.contentLeft) / (layout.columnGap * layout.columnSign) + layout.originColumn
        : layout.originColumn;
    const row = layout.rowPitch > 0
        ? (centreY - layout.contentTop) / (layout.rowPitch * layout.rowSign) + layout.originRow
        : layout.originRow + 1;
    return { column, row };
}

/**
 * The drawing area in pixels: the layout's grid window mapped through the same transform as
 * everything else. Lock grid bounds drops to it.
 */
export function drawingAreaOf(layout: LayoutResult): { left: number; top: number; right: number; bottom: number } {
    const a = pixelPositionOf(layout, layout.window.columnLo, layout.window.rowLo, 0);
    const b = pixelPositionOf(layout, layout.window.columnHi, layout.window.rowHi, 0);
    return {
        left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
        right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y)
    };
}

/**
 * The grid window a pixel rectangle shows under this layout's mapping. What a background
 * import stores as the locked frame: the rectangle the picture will fill, read through the grid
 * as it is drawn now, so the diagram keeps its place and scale when the lock starts mapping the
 * frame onto it. A single-column layout has no column scale, and keeps its own columns.
 */
export function frameOfRect(layout: LayoutResult, rect: PixelRect): GridWindow {
    const columnAt = (x: number) =>
        layout.originColumn + (x - layout.contentLeft) / (layout.columnGap * layout.columnSign);
    const rowAt = (y: number) =>
        layout.originRow + (y - layout.contentTop) / (layout.rowPitch * layout.rowSign);
    // A reversed axis maps the rectangle's low pixel edge to the grid's high end, so the pair is
    // ordered rather than taken as it comes.
    const columns = [columnAt(rect.x), columnAt(rect.x + rect.width)];
    const rows = [rowAt(rect.y), rowAt(rect.y + rect.height)];
    return {
        columnLo: layout.columnGap > 0 ? Math.min(...columns) : layout.frame.columnLo,
        columnHi: layout.columnGap > 0 ? Math.max(...columns) : layout.frame.columnHi,
        rowLo: Math.min(...rows),
        rowHi: Math.max(...rows)
    };
}

/** Where computeLayout will put a node of this height at this logical position. */
export function pixelPositionOf(
    layout: LayoutResult,
    column: number,
    row: number,
    height: number
): { x: number; y: number } {
    return {
        x: layout.contentLeft + (column - layout.originColumn) * layout.columnGap * layout.columnSign,
        y: layout.contentTop + (row - layout.originRow) * layout.rowPitch * layout.rowSign - height / 2
    };
}
