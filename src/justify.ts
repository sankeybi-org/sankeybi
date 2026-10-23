/**
 * Even whitespace between the boxes of the first and last columns.
 *
 * The arranger spaces node centres evenly, but the boxes layout draws are sized by
 * the flows they carry, so the whitespace between them comes out ragged. Once the
 * boxes exist their gaps can be equalised. This runs between `computeLayout` and
 * `straightenNodes` and moves nothing that is stored: it adjusts the pixel
 * positions of one layout.
 *
 * - Each end keeps its outermost edges: the first node's top and the last node's
 *   bottom stay where layout put them, so the fit sees the same extent.
 * - A last column with fewer boxes than the first stands inside the first column's
 *   height, leaving at most `MAX_BLANK_ROWS` of blank at each end and equal
 *   whitespace between its boxes. If keeping the first column's own whitespace
 *   would leave less blank than that, it keeps it.
 * - A last column with as many boxes or more spreads across the first column's top
 *   and bottom when its boxes fit in that height, so the two ends are level. If
 *   they do not fit it keeps its own edges.
 * - A column holding a hand-placed node is left alone.
 * - Order is kept: boxes are only slid within the column's edges.
 */

import { axisOf } from "./flowAxis";
import { LayoutResult, PositionedNode } from "./model";

/**
 * The most blank a shorter last column may leave at its top and at its bottom,
 * in rows. Without a cap, keeping the first column's whitespace for a short column
 * bunches it into the middle.
 */
const MAX_BLANK_ROWS = 0.5;

/** A box in a column along the cross axis: where it starts and how big it is. */
interface Slot {
    node: PositionedNode;
    top: number;
    size: number;
}

/**
 * Spreads the boxes of the first and last columns so the whitespace between them
 * is equal. Does nothing for fewer than three nodes or when `enabled` is false.
 */
export function justifyEnds(
    layout: LayoutResult,
    handPlaced: ReadonlySet<string> = new Set(),
    enabled = true
): void {
    if (!enabled || layout.nodes.size < 3) {
        return;
    }
    const horizontal = axisOf(layout.corridors) === "horizontal";
    const stageOf = (node: PositionedNode): number | undefined => horizontal ? node.column : node.row;
    // The stage runs along x on a left-to-right diagram, so boxes are distributed
    // along y; on a top-to-bottom one, along x.
    const topOf = (node: PositionedNode): number => horizontal ? node.y : node.x;
    const sizeOf = (node: PositionedNode): number => horizontal ? node.height : node.width;
    const place = (node: PositionedNode, top: number): void => {
        if (horizontal) {
            node.y = top;
        } else {
            node.x = top;
        }
    };

    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    layout.nodes.forEach(node => {
        const stage = stageOf(node);
        if (stage !== undefined && Number.isFinite(stage) && !node.isSelfLoop) {
            low = Math.min(low, stage);
            high = Math.max(high, stage);
        }
    });
    if (!Number.isFinite(low) || low === high) {
        return;
    }

    const column = (stage: number): Slot[] => {
        const slots: Slot[] = [];
        layout.nodes.forEach(node => {
            if (!node.isSelfLoop && stageOf(node) === stage) {
                slots.push({ node, top: topOf(node), size: sizeOf(node) });
            }
        });
        return slots.sort((a, b) => a.top - b.top);
    };
    const pinned = (slots: Slot[]): boolean => slots.some(slot => handPlaced.has(slot.node.id));
    const total = (slots: Slot[]): number => slots.reduce((sum, slot) => sum + slot.size, 0);
    const extent = (slots: Slot[]): { top: number; bottom: number } => ({
        top: Math.min(...slots.map(slot => slot.top)),
        bottom: Math.max(...slots.map(slot => slot.top + slot.size))
    });
    /** Slides the boxes down the column with one gap between them, starting at `top`. */
    const lay = (slots: Slot[], top: number, gap: number): void => {
        let cursor = top;
        slots.forEach(slot => {
            place(slot.node, cursor);
            cursor += slot.size + gap;
        });
    };

    const first = column(low);
    const last = column(high);

    // The first column: equal whitespace between its own outermost edges.
    let firstGap: number | undefined;
    let firstExtent: { top: number; bottom: number } | undefined;
    if (first.length >= 2 && !pinned(first)) {
        const edges = extent(first);
        const free = edges.bottom - edges.top - total(first);
        if (free > 0) {
            firstGap = free / (first.length - 1);
            firstExtent = edges;
            lay(first, edges.top, firstGap);
        }
    }

    // The last column: its own edges when it is as long as the first, or the first
    // column's whitespace, centred on the first column, when shorter.
    if (last.length >= 2 && !pinned(last)) {
        const own = extent(last);
        if (firstGap !== undefined && firstExtent && last.length < first.length) {
            const span = firstExtent.bottom - firstExtent.top;
            // The blank that keeping the first column's whitespace would leave at each end,
            // capped at half a row of the cross axis's pitch.
            const kept = total(last) + (last.length - 1) * firstGap;
            const pitch = horizontal ? layout.rowPitch : layout.columnGap;
            const blank = Math.max(0, Math.min((span - kept) / 2, MAX_BLANK_ROWS * (pitch || 0)));
            const room = span - 2 * blank - total(last);
            if (room >= 0) {
                lay(last, firstExtent.top + blank, room / (last.length - 1));
                return;
            }
        }
        // As many boxes or more: level with the first column's top and bottom where the
        // boxes fit in that height, otherwise its own edges.
        if (firstExtent) {
            const inFirst = firstExtent.bottom - firstExtent.top - total(last);
            if (inFirst > 0) {
                lay(last, firstExtent.top, inFirst / (last.length - 1));
                return;
            }
        }
        const free = own.bottom - own.top - total(last);
        if (free > 0) {
            lay(last, own.top, free / (last.length - 1));
        }
    }
}
