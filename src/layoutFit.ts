import { GridWindow } from "./model";
import { COLUMN_CAP_RATIO, FIT_BISECTIONS, FIT_MARGIN, FIT_ROUNDS, LOCK_TOLERANCE } from "./layoutConstants";
import { LayoutEnv, NodeSize } from "./layoutEnv";
import { reachOf, sizeNodesAt } from "./layoutSizing";

/**
 * The content's extent in grid units, both axes, at these pitches: every node's drawn box and
 * outside label, and, when visual.ts has routed once and passed them in, the flows. A flow's
 * extent is carried in grid units because its geometry is pitch-relative (lanes, leads and band
 * widths are all fractions of a pitch), so it holds as the pitch is solved for; a label's is in
 * pixels, and is measured at each trial.
 */
export function contentExtentAt(env: LayoutEnv, rowPitch: number, columnGap: number, withFlows = true): GridWindow {
    const { nodes, labelPorts, columnSign, rowSign, flows, locked } = env;
    const sizes = sizeNodesAt(env, rowPitch, columnGap);
    let columnLo = Number.POSITIVE_INFINITY;
    let columnHi = Number.NEGATIVE_INFINITY;
    let rowLo = Number.POSITIVE_INFINITY;
    let rowHi = Number.NEGATIVE_INFINITY;
    nodes.forEach(n => {
        // sizeNodes covers exactly these nodes, so this always hits.
        const size = sizes.get(n.id) as NodeSize;
        const reach = reachOf(env, n, size, labelPorts.get(n.id) ?? "East");
        const column = n.column ?? 1;
        const row = n.row ?? 1;
        // The grid deltas this node's drawn reach covers, per axis. On a reversed axis the pixel
        // reaches swap ends (what reaches left covers higher columns), so both are formed and then
        // ordered, rather than one being assumed to be the low one. `columnSign` and `rowSign` are
        // constants hoisted above the fit, so this costs two multiplies and two comparisons per node
        // per trial.
        const columnA = columnGap > 0 ? reach.left / columnGap * columnSign : 0;
        const columnB = columnGap > 0 ? reach.right / columnGap * columnSign : 0;
        columnLo = Math.min(columnLo, column + Math.min(columnA, columnB));
        columnHi = Math.max(columnHi, column + Math.max(columnA, columnB));
        const rowA = rowPitch > 0 ? -reach.up / rowPitch * rowSign : 0;
        const rowB = rowPitch > 0 ? reach.down / rowPitch * rowSign : 0;
        rowLo = Math.min(rowLo, row + Math.min(rowA, rowB));
        rowHi = Math.max(rowHi, row + Math.max(rowA, rowB));
    });
    if (!Number.isFinite(columnLo)) {
        return { columnLo: 1, columnHi: 1, rowLo: 1, rowHi: 1 };
    }
    if (withFlows && flows && !locked) {
        if (columnGap > 0) {
            columnLo = Math.min(columnLo, flows.columnLo);
            columnHi = Math.max(columnHi, flows.columnHi);
        }
        rowLo = Math.min(rowLo, flows.rowLo);
        rowHi = Math.max(rowHi, flows.rowHi);
    }
    return { columnLo, columnHi, rowLo, rowHi };
}

/**
 * Where the grid sits: its two pitches and the coordinate drawn at the low pixel edge of each
 * axis.
 */
export interface GridFit {
    columnGap: number;
    rowPitch: number;
    originColumn: number;
    originRow: number;
}

/**
 * Solves the pitches and origin: from the locked window if there is one, else by fitting the
 * content.
 */
export function solveGrid(env: LayoutEnv): GridFit {
    const {
        packsAcrossRows, usableHeight, spanWidth, minColumn, maxColumn, minRow, maxRow, multiColumn,
        columnSign, rowSign, locked, backdropAspect, nodeMinWidthPercent, nodeMinHeightPercent
    } = env;
    const sizeNodes = (rowPitch: number, columnGap: number) => sizeNodesAt(env, rowPitch, columnGap);
    const contentExtent = (rowPitch: number, columnGap: number, withFlows = true) =>
        contentExtentAt(env, rowPitch, columnGap, withFlows);

/**
 * The pitch at which the content, plus FIT_MARGIN of a pitch at each end, exactly fills `space`
 * pixels. `extentPixels` is the content's drawn extent at a trial pitch; it only grows as the
 * pitch does (positions and node sizes both scale with it), so the answer is unique and
 * bisection finds it to far below a pixel. Nothing here chases its own correction: the function
 * being solved is fixed, only the trial pitch moves.
 */
const solvePitch = (space: number, extentPixels: (pitch: number) => number): number => {
    let lo = 1e-6;
    let hi = space / (2 * FIT_MARGIN);
    if (extentPixels(lo) + 2 * FIT_MARGIN * lo >= space) {
        return lo;
    }
    for (let i = 0; i < FIT_BISECTIONS; i++) {
        const mid = (lo + hi) / 2;
        if (extentPixels(mid) + 2 * FIT_MARGIN * mid > space) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return (lo + hi) / 2;
};
const solveRows = (columnGap: number): number => solvePitch(usableHeight, pitch => {
    const extent = contentExtent(pitch, columnGap);
    return (extent.rowHi - extent.rowLo) * pitch;
});
const solveColumns = (rowPitch: number): number => solvePitch(spanWidth, gap => {
    const extent = contentExtent(rowPitch, gap);
    return (extent.columnHi - extent.columnLo) * gap;
});

let columnGap: number;
let rowPitch: number;
let originColumn: number;
let originRow: number;
const lockedColumns = locked !== undefined && locked.columnHi - locked.columnLo > 1e-9;
const lockedRows = locked !== undefined && locked.rowHi - locked.rowLo > 1e-9;
if (locked && (lockedColumns || !multiColumn) && lockedRows) {
    // Lock grid: the window is the author's, not the content's. The pitch then depends only on the
    // viewport, so moving a node anywhere inside the window rescales nothing. Content the window
    // does not hold (a new node from the data, a slicer) still widens it, since hiding data would
    // be worse than bending the lock, but it never narrows.
    let window = { ...locked };
    const pitchesOf = (w: GridWindow) => ({
        gap: lockedColumns ? spanWidth / (w.columnHi - w.columnLo) : 0,
        pitch: usableHeight / (w.rowHi - w.rowLo)
    });
    const trial = pitchesOf(window);
    const content = contentExtent(trial.pitch, trial.gap);
    // Widened only where content is genuinely outside: a node dropped flush against the edge
    // measures a hair past it in floating point, and "widening" by 1e-15 would change the pitch it
    // was held to.
    const lower = (held: number, wanted: number) => (wanted < held - LOCK_TOLERANCE ? wanted : held);
    const upper = (held: number, wanted: number) => (wanted > held + LOCK_TOLERANCE ? wanted : held);
    window = {
        columnLo: lockedColumns ? lower(window.columnLo, content.columnLo) : window.columnLo,
        columnHi: lockedColumns ? upper(window.columnHi, content.columnHi) : window.columnHi,
        rowLo: lower(window.rowLo, content.rowLo),
        rowHi: upper(window.rowHi, content.rowHi)
    };
    const final = pitchesOf(window);
    columnGap = final.gap;
    rowPitch = final.pitch;
    // The grid coordinate drawn at the low pixel edge, which on a reversed axis is the window's
    // high end.
    originColumn = lockedColumns
        ? (columnSign > 0 ? window.columnLo : window.columnHi)
        : minColumn;
    originRow = rowSign > 0 ? window.rowLo : window.rowHi;
    // Widening one axis alone would stretch a background picture against the grid it is drawn in.
    // With one set, both pitches shrink by the same factor instead (the tighter axis's), and the
    // other axis's spare is shared either side, so the picture only ever scales.
    if (lockedColumns && backdropAspect !== undefined && backdropAspect > 0) {
        const held = pitchesOf(locked);
        const scale = Math.min(1, final.gap / held.gap, final.pitch / held.pitch);
        columnGap = held.gap * scale;
        rowPitch = held.pitch * scale;
        const spareColumns = spanWidth / columnGap - (window.columnHi - window.columnLo);
        const spareRows = usableHeight / rowPitch - (window.rowHi - window.rowLo);
        originColumn = columnSign > 0
            ? window.columnLo - spareColumns / 2
            : window.columnHi + spareColumns / 2;
        originRow = rowSign > 0
            ? window.rowLo - spareRows / 2
            : window.rowHi + spareRows / 2;
    }
} else {
    // Fit to the visible space: the outermost nodes' drawn edges sit FIT_MARGIN of a pitch inside
    // the drawing area, on both axes, rather than a whole spare pitch above and below the content.
    // Rescaling the mapping is what makes this worthwhile: the pitch grows, and every band with it,
    // where spreading the grid positions further apart would have shrunk them.
    //
    // The two axes are coupled (a North/South node's width comes from the row pitch; a shape's
    // floor can reach across), so each is solved exactly given the other, a fixed number of times.
    // It ends on the columns: widths depend strongly on the row pitch, whereas heights depend on
    // the column gap only through a shape's floor, so the last word goes to the axis that would
    // otherwise be left furthest out.
    //
    // Filling the height can leave the width impossible: a North/South node is as wide as its flow,
    // and its flow scales with the row pitch. On a single-row diagram in a portrait frame that
    // would make one node wider than the whole visual. So the row pitch is capped where the column
    // gap would fall below COLUMN_CAP_RATIO of the widest drawn node, and the height left over is
    // shared equally above and below, the same letterboxing any fixed-aspect picture gets.
    //
    // The two axes are used in the roles the fit gives them, so that the sequence below can be
    // written once. The packing axis is the one the nodes stack across (the pitch every band is
    // scaled by, `packingPitchOf`) and the other axis carries the stages. On a left-to-right
    // diagram those are the rows and the columns.
    const packingSpace = packsAcrossRows ? usableHeight : spanWidth;
    const otherSpace = packsAcrossRows ? spanWidth : usableHeight;
    const otherSpan = packsAcrossRows ? maxColumn - minColumn : maxRow - minRow;
    // The floor the last stage's own node needs room for, on the other axis: the closed form below
    // has to leave space for it.
    const otherFloor = Math.max(0, (packsAcrossRows ? nodeMinWidthPercent : nodeMinHeightPercent) / 100);
    /** rowPitch and columnGap, from the pair in their fit roles. */
    const pitchesOf = (packing: number, other: number): [number, number] =>
        (packsAcrossRows ? [packing, other] : [other, packing]);
    const solvePacking = (other: number): number =>
        (packsAcrossRows ? solveRows(other) : solveColumns(other));
    const solveOther = (packing: number): number =>
        (packsAcrossRows ? solveColumns(packing) : solveRows(packing));

    // Filling the packing axis can leave the other one impossible: a node is as thick as its flow
    // on both axes and both follow the one packing pitch, so growing that pitch grows the extent
    // it does not pay for. On a single-row diagram in a portrait frame that would make one node
    // wider than the whole visual. So the packing pitch is capped where the other axis's step
    // would fall below COLUMN_CAP_RATIO of the biggest drawn node, and what is left over is shared
    // equally at both ends, the same letterboxing any fixed-aspect picture gets.
    const biggestStep = otherSpan > 0 ? otherSpace / (otherSpan + 2 * FIT_MARGIN) : 0;
    const otherFits = (packing: number): boolean => {
        let biggest = 0;
        const [row, gap] = pitchesOf(packing, biggestStep);
        sizeNodes(row, gap).forEach(size => {
            biggest = Math.max(biggest, packsAcrossRows
                ? Math.max(size.width, size.shapeWidth)
                : Math.max(size.height, size.shapeHeight));
        });
        if (biggest <= 0) {
            return true;
        }
        const step = biggest * COLUMN_CAP_RATIO;
        const [tryRow, tryGap] = pitchesOf(packing, step);
        const extent = contentExtent(tryRow, tryGap);
        const span = packsAcrossRows
            ? extent.columnHi - extent.columnLo
            : extent.rowHi - extent.rowLo;
        return (span + 2 * FIT_MARGIN) * step <= otherSpace;
    };
    const capPacking = (pitch: number): number => {
        // Nor where it cannot help: a shape widened to hold its label does not narrow with the pitch,
        // and chasing it would squash the diagram flat for nothing. Then the other axis spills, as it
        // always could, and visual.ts's overflow pass makes room.
        if (otherSpan <= 0 || otherFits(pitch) || !otherFits(1e-6)) {
            return pitch;
        }
        let lo = 1e-6;
        let hi = pitch;
        for (let i = 0; i < FIT_BISECTIONS; i++) {
            const mid = (lo + hi) / 2;
            if (otherFits(mid)) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        return lo;
    };

    // A closed form, because the step has to leave room for the last stage's own node as well as
    // the gaps between them.
    let other = otherSpan > 0 ? otherSpace / (otherSpan + otherFloor + 2 * FIT_MARGIN) : 0;
    let packing = capPacking(solvePacking(other));
    if (otherSpan > 0) {
        // Stops when a round returns exactly what it was given. Each solve is a deterministic function
        // of the other axis's pitch, so once neither pitch moves at all, every later round, and the
        // closing solveOther, reproduces the same two numbers. It is exact equality, not a tolerance:
        // a pitch that differs in its last bit still changes what is drawn, because Smooth's join and
        // the flow passes both have genuine decision boundaries in them. This saves most of the solves
        // at no cost to the drawing, and a diagram that genuinely keeps moving still gets its full
        // FIT_ROUNDS.
        let settled = false;
        for (let round = 0; round < FIT_ROUNDS && !settled; round++) {
            const wasOther = other;
            const wasPacking = packing;
            other = solveOther(packing);
            packing = capPacking(solvePacking(other));
            settled = other === wasOther && packing === wasPacking;
        }
        // The last word goes to the other axis, unless the rounds already settled, in which case it
        // would return what it was just handed. The packing axis owns the node sizes, so the other one
        // is what would otherwise be left furthest out: on a horizontal diagram widths depend strongly
        // on the row pitch while heights depend on the column gap only through a shape's floor, and on
        // a vertical one it is the other way round.
        if (!settled) {
            other = solveOther(packing);
        }
    }
    // A single-column diagram leaves `other` at 0, which is a columnGap of 0.
    [rowPitch, columnGap] = pitchesOf(packing, other);
    const content = contentExtent(rowPitch, columnGap);
    // The letterbox goes on the packing axis, which is the one the cap above may have stopped
    // short of filling.
    const contentPacking = packsAcrossRows
        ? content.rowHi - content.rowLo
        : content.columnHi - content.columnLo;
    const sparePacking = Math.max(0, packingSpace / packing - contentPacking - 2 * FIT_MARGIN);
    // The low-pixel-edge end of each axis, then moved to the far end of the drawing area where
    // that axis is reversed. The flip is a relabelling of which coordinate lands where, so the
    // pitches solved above are untouched by it and the picture comes out an exact mirror.
    const columnBase = packsAcrossRows
        ? (multiColumn ? content.columnLo - FIT_MARGIN : minColumn)
        : content.columnLo - FIT_MARGIN - sparePacking / 2;
    const rowBase = packsAcrossRows
        ? content.rowLo - FIT_MARGIN - sparePacking / 2
        : content.rowLo - FIT_MARGIN;
    originColumn = columnSign > 0 || !(columnGap > 0)
        ? columnBase
        : columnBase + spanWidth / columnGap;
    originRow = rowSign > 0 ? rowBase : rowBase + usableHeight / rowPitch;
}

    return { columnGap, rowPitch, originColumn, originRow };
}
