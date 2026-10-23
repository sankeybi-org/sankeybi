/**
 * Layout: converts each node's logical (column, row) into pixel (x, y), sizes the nodes,
 * fits the view and computes the value->pixels scale. Everything upstream stays in logical
 * space; pixels appear only here.
 */

import {
    ArrowOptions, Corridor, Graph, GridWindow, LabelOptions, LayoutResult, NodeShape, PixelRect, Port,
    PositionedNode
} from "./model";
import { buildFaceDemand } from "./layoutDemand";
import { labelPortOf } from "./layoutText";
import { letterbox } from "./background";
import { axisOf, senseOf } from "./flowAxis";
import { measureLabels, reachOf, sizeNodesAt } from "./layoutSizing";
import { LayoutEnv, NodeSize } from "./layoutEnv";
import { contentExtentAt, solveGrid } from "./layoutFit";
import { flowSeparationPixels } from "./arrows";
import {
    DEFAULT_NODE_MIN_HEIGHT_PERCENT, DEFAULT_NODE_MIN_WIDTH_PERCENT, EdgeReserve, LEGEND_BAND_HEIGHT,
    LEGEND_BAND_WIDTH, LegendPosition, MARGIN, MIN_BASE_BAR_EXTENT, MIN_CORRIDOR_WIDTH, NO_RESERVE,
    PACKING_FRACTION
} from "./layoutConstants";

/**
 * Everything outside the diagram itself that eats into the space nodes can use, plus the
 * format-pane choices that change how big a node has to be.
 *
 * They are bundled rather than passed positionally, since a run of booleans and enums in the
 * argument list grows with every setting added. A caller that omits a field gets the "no
 * chrome" default, which is what every synthetic check wants.
 */
export interface LayoutChrome {
    legendVisible: boolean;
    legendPosition: LegendPosition;
    /**
     * How thick flows are drawn, as a percentage of the default. Optional so the synthetic checks'
     * chrome literals do not all have to carry it.
     */
    flowWidthPercent?: number;
    /**
     * What one full node thickness means, in the data's own units.
     *
     * Undefined (the default, and what every synthetic check gets) means the reference is the
     * busiest node's own throughput, so that node always takes `PACKING_FRACTION` of its packing
     * pitch and the diagram fills its frame at every selection. Set, it is the author's fixed
     * reference instead, so a value draws the same width whichever selection is showing and two of
     * them can be compared by eye.
     *
     * It is a divisor, so a number at or below zero is ignored rather than guarded against
     * downstream.
     */
    flowBaselineValue?: number;
    /**
     * What the Labels card is showing. Layout needs it to measure a node's label block, which
     * decides whether the label fits inside a shape.
     */
    labels?: LabelOptions;
    /** The decorative overlay, if any, and how big it is drawn. */
    nodeShape?: NodeShape;
    /** Node floors as a percentage of the column gap, the same basis as node width. */
    nodeMinWidthPercent?: number;
    nodeMinHeightPercent?: number;
    /**
     * Whether a shape grows sideways to hold a label that would otherwise overflow it. Off, the
     * label moves outside instead.
     */
    nodeShapeFitLabel?: boolean;
    /**
     * How far a shape hangs outside the node, on every side, as a percentage of the pitch the
     * nodes pack across. The node itself is untouched: this is the one way to have shapes that stay
     * proportional to the flow they carry and still sit proud of it, where raising a minimum floor
     * instead levels every node to the same size.
     */
    nodeShapePaddingPercent?: number;
    /**
     * A background image is set: its width / height, or 0 where the file does not say. Undefined
     * means no background. It acts only under Lock grid (which a background forces on): the locked
     * frame is then mapped onto the largest rectangle of this aspect inside the chrome box rather
     * than onto the whole box, so the picture keeps its shape and stays under the nodes at any tile
     * size. See `LayoutResult.backdrop`.
     */
    backdropAspect?: number;
    /**
     * How far apart two corridors packed on one face are held, as a percentage of the pitch the
     * nodes pack across (`flowSeparationPixels`).
     *
     * It is a layout input, because the gaps are room the node has to find: a face carrying `n`
     * corridors is sized to `sum(widths) + (n - 1) x separation`. No flow's own width changes
     * anywhere; the node grows instead, which is the point of doing this in the packing rather than
     * in the paint.
     */
    flowSeparationPercent?: number;
    /**
     * The Node arrows card. A layout input, because a node has to be thick enough along the flow
     * to hold the gap the author asked for plus a taper at each end; see `arrowExtentFloor`.
     */
    arrows?: ArrowOptions;
}

const DEFAULT_CHROME: LayoutChrome = {
    legendVisible: false,
    legendPosition: "Bottom"
};

export function computeLayout(
    graph: Graph,
    corridors: Corridor[],
    viewportWidth: number,
    viewportHeight: number,
    chrome: LayoutChrome = DEFAULT_CHROME,
    reserve: EdgeReserve = NO_RESERVE,
    /** Lock grid's stored window; undefined fits the view to the content. */
    locked?: GridWindow,
    /**
     * Where the flows reached on a first routing (`flowExtentOf`), counted as content by the fit.
     */
    flows?: GridWindow
): LayoutResult {
    const nodes = graph.nodes;
    const {
        legendVisible, legendPosition,
        flowWidthPercent = 100,
        flowBaselineValue,
        nodeShape = "None",
        nodeMinWidthPercent = DEFAULT_NODE_MIN_WIDTH_PERCENT,
        nodeMinHeightPercent = DEFAULT_NODE_MIN_HEIGHT_PERCENT,
        nodeShapeFitLabel = false,
        nodeShapePaddingPercent = 0,
        flowSeparationPercent = 0,
        labels,
        arrows
    } = chrome;

    const columns = Array.from(nodes.values()).map(n => n.column ?? 1);
    // The columns the content actually occupies, not capped at 1. The view fits the content (see
    // `FIT_MARGIN`), so an empty leading column is simply not shown; an author who wants empty
    // space held uses Lock grid.
    const maxColumn = columns.length > 0 ? Math.max(...columns) : 1;
    const minColumn = columns.length > 0 ? Math.min(...columns) : 1;
    // The same, down the rows: the fit needs both ends of whichever axis carries the stages, which
    // on a top-to-bottom diagram is this one.
    const rows = Array.from(nodes.values()).map(n => n.row ?? 1);
    const maxRow = rows.length > 0 ? Math.max(...rows) : 1;
    const minRow = rows.length > 0 ? Math.min(...rows) : 1;

    const faces = buildFaceDemand(nodes, corridors, arrows);
    const { demandOf, autoBaseline, flowDirectionOf } = faces;

    const labelPorts = new Map<string, Port>();
    nodes.forEach(n => {
        labelPorts.set(n.id, labelPortOf(demandOf(n.id), n.column ?? 1, minColumn, maxColumn));
    });

    const legendTop = legendVisible && legendPosition === "Top" ? LEGEND_BAND_HEIGHT : 0;
    const legendBottom = legendVisible && legendPosition === "Bottom" ? LEGEND_BAND_HEIGHT : 0;
    const legendLeft = legendVisible && legendPosition === "Left" ? LEGEND_BAND_WIDTH : 0;
    const legendRight = legendVisible && legendPosition === "Right" ? LEGEND_BAND_WIDTH : 0;

    // Under Lock grid nothing is reserved: the stored frame already holds, in grid units, the room
    // the label and overflow reserves took when it was captured. Reserving again would make the
    // pitch follow whichever node happened to be outermost, so a drag near the edge would move the
    // margin, and with it the grid the lock is meant to hold.
    const edge: EdgeReserve = locked ? NO_RESERVE : reserve;
    let topMargin = MARGIN + legendTop + edge.top;
    // No label reserves: outside labels are part of the content the fit measures (see `reachOf`),
    // node by node, where they are drawn.
    let leftOffset = MARGIN + legendLeft + edge.left;
    const rightMargin = MARGIN + legendRight + edge.right;
    let spanWidth = Math.max(1, viewportWidth - leftOffset - rightMargin);
    let usableHeight = Math.max(1, viewportHeight - topMargin - MARGIN - legendBottom - edge.bottom);
    // The chrome box less any reserve: what a locked frame fills.
    const chromeBox: PixelRect = {
        x: leftOffset - edge.left,
        y: topMargin - edge.top,
        width: spanWidth + edge.left + edge.right,
        height: usableHeight + edge.top + edge.bottom
    };
    // A background under the lock: the frame fills the picture's own rectangle, letterboxed in the
    // chrome box, so the grid and the picture scale together and neither is stretched when the tile
    // changes shape.
    const backdropAspect = chrome.backdropAspect;
    if (locked && backdropAspect !== undefined && backdropAspect > 0) {
        const box = letterbox(chromeBox, backdropAspect);
        leftOffset = box.x;
        topMargin = box.y;
        spanWidth = box.width;
        usableHeight = box.height;
    }

    const multiColumn = maxColumn > minColumn;

    /**
     * The reference the whole diagram's thickness is measured against. By default it is the
     * busiest node's own throughput, which makes the diagram fill its frame at every selection and
     * makes a width mean nothing absolute, since the divisor moves with the data. The author may
     * pin it instead, and then a value draws the same width in every selection.
     *
     * The same number is used for the node and for the slots packed onto its edges, which is the
     * invariant that keeps a node exactly as thick as the flows through it. Pinning a second
     * reference anywhere would reintroduce two formulas for one number, which tapers bands.
     */
    const maxNodeThroughput =
        flowBaselineValue !== undefined && flowBaselineValue > 0 ? flowBaselineValue : autoBaseline;
    // The Flow width setting scales one number, which is what makes it coherent: `valueToPixels`
    // sizes both a node and the slots packed onto its edges, so nodes and the bands they carry grow
    // together and a node stays exactly as thick as the flows through it, the property that makes a
    // Sankey readable. Scaling bands alone would leave them either overflowing their node or short
    // of filling it.
    const flowScale = Math.max(0.01, flowWidthPercent / 100);
    const drawingHeight = usableHeight + edge.top + edge.bottom;
    const drawingWidth = spanWidth + edge.left + edge.right;
    /**
     * Which pitch the diagram's thickness is built from: the one the nodes pack across. A
     * left-to-right diagram stacks its nodes down the rows, so a node may take `PACKING_FRACTION` of
     * the row pitch; a top-to-bottom one stacks them across the columns, so it is the column gap
     * that has to hold them. Using the row pitch whichever way the diagram ran would, on a vertical
     * diagram, measure the pitch along the flow rather than across it, drawing nodes wider than the
     * space between their own columns.
     *
     * There is only one scale per diagram, and there has to be. A band's width must be constant
     * along its length, and a corridor leaving East and arriving North is measured vertically at one
     * end and horizontally at the other, so scaling each axis by its own pitch would taper every
     * L-shaped band. The question is only which pitch, and the honest answer is the one the nodes
     * are stacked along.
     *
     * A single-column diagram has no column gap to be a fraction of, so a vertical one falls back to
     * the row pitch, the same fallback the minimum-width floor makes and for the same reason.
     */
    // A single-column diagram has no column gap to pack across whichever way its ports point, and
    // a single-row one has no stages to spread down, so both fall back to packing across the rows.
    // Folding them in here keeps every "which axis?" question below down to one answer.
    const flowAxis = axisOf(corridors);
    const packsAcrossRows = !multiColumn || maxRow <= minRow || flowAxis === "horizontal";
    /**
     * Which way the grid runs on screen, per axis. It is read off the resolved ports like the axis
     * itself, so the picture cannot disagree with the ports the corridors actually use and a
     * cosmetic update still skips the pipeline (`corridorPart` already carries both ports).
     *
     * Only the stage axis reverses. Everything above this line (the automatic stages, the arranging
     * pass, the author's own coordinates) works in flow order, and this decides which end of the
     * screen stage 1 is drawn at. A flip is exactly equivalent to mirroring the stage coordinates.
     */
    const reversed = senseOf(corridors, flowAxis) < 0;
    const columnSign: 1 | -1 = reversed && flowAxis === "horizontal" ? -1 : 1;
    const rowSign: 1 | -1 = reversed && flowAxis === "vertical" ? -1 : 1;
    /**
     * Flow width, corrected for the frame's aspect on a vertical reading. The scale is built from
     * the pitch the nodes pack across, and on a top-to-bottom diagram that is the column gap
     * (`width / columns`) where a left-to-right one uses `height / rows`. In a landscape frame the
     * same diagram turned would draw its flows `width / height` thicker while the runs between
     * stages got shorter. This multiplier restores the thickness, applied here rather than written
     * into the setting so that a resize or a data-driven flip stays right and the slider still
     * reads what the author set.
     *
     * It applies only where the scale really is the column gap (`!packsAcrossRows`), and never
     * above 1: a portrait frame already has the thinner across pitch. It is measured on the
     * unreserved drawing extent, like the cap beside it, so the overflow pass's second layout draws
     * the same factor as the first.
     */
    const aspectScale = !packsAcrossRows && drawingWidth > 0 && drawingHeight > 0
        ? Math.min(1, drawingHeight / drawingWidth)
        : 1;
    const packingPitchOf = (rowPitch: number, columnGap: number): number =>
        (packsAcrossRows || columnGap <= 0 ? rowPitch : columnGap);
    /** The drawing measured across the flow: what a node may never outgrow. */
    const drawingAcross = packsAcrossRows ? drawingHeight : drawingWidth;
    /** The value->pixels scale at a given packing pitch, which the fit solves for. */
    const valueToPixelsAt = (packingPitch: number): ((value: number) => number) => {
        const baseBarHeight = Math.max(MIN_BASE_BAR_EXTENT, packingPitch * PACKING_FRACTION);
        // A node can never grow tall enough to spill the viewport. This is not cosmetic: node height
        // is derived from rowPitch, and visual.ts reserves whatever spills and lays out again, so an
        // oversized node would shrink rowPitch, which shrinks the node, a correction chasing the thing
        // it corrects. Without the cap, a tall-node diagram peaks and then goes backwards, rowPitch
        // collapsing as Flow width rises.
        //
        // The bound is `usableHeight`. A tighter "twice the row pitch" (exactly the room a node
        // centred on an extreme row has) does not remove the residual dip, which comes from bands
        // spilling rather than nodes, and it clips the plateau on a many-row diagram. Do not
        // reintroduce it without re-measuring both shapes.
        //
        // What remains is a small dip at high Flow width on a tall-node diagram, because band thickness
        // is flow-derived too, so fatter flows still spill a little and the reserve still nudges
        // rowPitch. That feedback is inherent to having a fit-to-viewport pass at all; removing it
        // entirely would mean clipping fat diagrams instead. The catastrophic case, rowPitch collapsing
        // to 1px, is what this cap prevents.
        //
        // It is measured against the unreserved drawing extent, so the cap is the same number on both of
        // visual.ts's passes. Using the reserved `usableHeight` instead would let the cap ratchet: the
        // second pass has less height, so it caps harder, so the diagram is thinner than the first pass
        // had already proved it could be. It is measured across the flow, which is the width on a
        // top-to-bottom diagram: the extent a node grows along, and the one it could spill.
        const barScale = Math.min(baseBarHeight * flowScale * aspectScale, drawingAcross) / baseBarHeight;
        // The floor is applied before the scale, so Flow width is a genuine uniform multiplier on every
        // corridor. Applied after, it would be an absolute pixel constant the setting could not touch,
        // and any corridor small enough to land on it would render at exactly MIN_CORRIDOR_WIDTH at
        // every setting while its neighbours grew.
        return (value: number) =>
            Math.max(MIN_CORRIDOR_WIDTH, (value / maxNodeThroughput) * baseBarHeight) * barScale;
    };

    const { totalTexts, textWidths, labelBoxes } = measureLabels(nodes, labels);

    const env: LayoutEnv = {
        nodes, labels, arrows, faces, nodeShape, nodeShapeFitLabel, nodeMinWidthPercent,
        nodeMinHeightPercent, nodeShapePaddingPercent, flowSeparationPercent,
        totalTexts, textWidths, labelBoxes, labelPorts, packingPitchOf, valueToPixelsAt,
        packsAcrossRows, columnSign, rowSign, minColumn, maxColumn, minRow, maxRow, multiColumn,
        spanWidth, usableHeight, locked, backdropAspect, flows
    };
    const sizeNodes = (rowPitch: number, columnGap: number) => sizeNodesAt(env, rowPitch, columnGap);
    const contentExtent = (rowPitch: number, columnGap: number, withFlows = true) =>
        contentExtentAt(env, rowPitch, columnGap, withFlows);
    const { columnGap, rowPitch, originColumn, originRow } = solveGrid(env);

    const sizes = sizeNodes(rowPitch, columnGap);
    const valueToPixels = valueToPixelsAt(packingPitchOf(rowPitch, columnGap));
    const positioned = new Map<string, PositionedNode>();
    nodes.forEach(n => {
        const col = n.column ?? 1;
        const row = n.row ?? 1;
        const size = sizes.get(n.id) as NodeSize;
        const x = leftOffset + (col - originColumn) * columnGap * columnSign;
        const y = topMargin + (row - originRow) * rowPitch * rowSign - size.height / 2;
        // How far what is drawn for this node reaches past its rectangle: the same reach the fit
        // measured. Lock grid holds a dragged node's whole reach inside the frame, label included, with
        // this.
        const reach = reachOf(env, n, size, labelPorts.get(n.id) ?? "East");

        positioned.set(n.id, {
            drawnReach: {
                left: Math.max(0, -reach.left),
                right: Math.max(0, reach.right - size.width),
                up: Math.max(0, reach.up - size.height / 2),
                down: Math.max(0, reach.down - size.height / 2)
            },
            ...n,
            x,
            y,
            width: size.width,
            height: size.height,
            flowDirection: flowDirectionOf(n.id),
            labelPort: labelPorts.get(n.id) ?? "East",
            shapeWidth: size.shapeWidth,
            shapeHeight: size.shapeHeight,
            labelInside: size.labelInside,
            // Layout's own breaks, carried so render draws the lines the fit measured instead of
            // re-deriving them without a viewport.
            nameLines: size.nameLines,
            labelBoxWidth: size.box.w,
            labelBoxHeight: size.box.h
        });
    });

    // What the drawing area shows, in grid units: the thing Lock grid stores. It is still a grid
    // range with lo <= hi: the origin is one end of it, and which end depends on the axis's sign.
    const columnReach = columnGap > 0 ? spanWidth / columnGap : 0;
    const rowReach = usableHeight / rowPitch;
    const window: GridWindow = {
        columnLo: columnSign > 0 ? originColumn : originColumn - columnReach,
        columnHi: columnSign > 0 ? originColumn + columnReach : originColumn,
        rowLo: rowSign > 0 ? originRow : originRow - rowReach,
        rowHi: rowSign > 0 ? originRow + rowReach : originRow
    };

    // The same, widened to the chrome box: what Lock grid stores. Mapped onto that box with no
    // reserves (see `edge`), it reproduces this exact drawing, so switching the lock on changes
    // nothing on screen. `edge` is measured in pixels per side, so on a reversed axis the left
    // reserve widens the grid's high end and the right one its low end.
    const edgeLowColumn = columnSign > 0 ? edge.left : edge.right;
    const edgeHighColumn = columnSign > 0 ? edge.right : edge.left;
    const edgeLowRow = rowSign > 0 ? edge.top : edge.bottom;
    const edgeHighRow = rowSign > 0 ? edge.bottom : edge.top;
    const frame: GridWindow = {
        columnLo: columnGap > 0 ? window.columnLo - edgeLowColumn / columnGap : window.columnLo,
        columnHi: columnGap > 0 ? window.columnHi + edgeHighColumn / columnGap : window.columnHi,
        rowLo: window.rowLo - edgeLowRow / rowPitch,
        rowHi: window.rowHi + edgeHighRow / rowPitch
    };

    // The picture covers the stored frame, placed through the same mapping as every node:
    // unwidened that is exactly the letterboxed box, and where content has widened the view the
    // picture shrinks with the grid rather than sliding out from under the nodes.
    let backdrop: PixelRect | undefined;
    if (locked && backdropAspect !== undefined) {
        const lowColumn = columnSign > 0 ? locked.columnLo : locked.columnHi;
        const lowRow = rowSign > 0 ? locked.rowLo : locked.rowHi;
        const low = {
            x: leftOffset + (lowColumn - originColumn) * columnGap * columnSign,
            y: topMargin + (lowRow - originRow) * rowPitch * rowSign
        };
        backdrop = {
            x: columnGap > 0 ? low.x : leftOffset,
            y: low.y,
            width: columnGap > 0 ? (locked.columnHi - locked.columnLo) * columnGap : spanWidth,
            height: (locked.rowHi - locked.rowLo) * rowPitch
        };
    }

    return {
        chromeBox, backdrop, autoBaseline,
        nodes: positioned, corridors, valueToPixels, columnGap, rowPitch,
        packingPitch: packingPitchOf(rowPitch, columnGap),
        flowSeparation: flowSeparationPixels(
            flowSeparationPercent, packingPitchOf(rowPitch, columnGap)),
        contentTop: topMargin, contentLeft: leftOffset, originColumn, originRow,
        columnSign, rowSign, window, frame,
        content: contentExtent(rowPitch, columnGap),
        nodeContent: contentExtent(rowPitch, columnGap, false)
    };
}
