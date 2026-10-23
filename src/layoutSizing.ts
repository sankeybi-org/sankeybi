import { wrapForWidth, wrapOptionsOf, WrappedLine, wrapText, wrapWidthOf } from "./labelWrap";
import { ArrowOptions, GraphNode, LabelOptions, Port, PositionedNode } from "./model";
import {
    arrowClearanceLoss, arrowExtentFloor, arrowFacesOppose, arrowGapPixels, flowSeparationPixels
} from "./arrows";
import { formatTotal, totalOf } from "./tooltips";
import {
    iconSizeOf, labelBoxOf, labelLinesOf, LINE_HEIGHT_NAME, nameSizeOf, SHAPE_PADDING, shapeFloorFor,
    textBoxOf, TextWidths, totalSizeOf, widestOf, widthOfText
} from "./layoutText";
import { NO_FACES, NO_GAPS } from "./layoutDemand";
import { LayoutEnv, NodeSize } from "./layoutEnv";
import { SHAPE_CORNER_RATIO } from "./layoutConstants";

/**
 * What one edge's packed corridors add up to, at this value->pixels scale, including the gaps
 * held between them.
 *
 * There are `(n - 1)` gaps, not `n`: the packed block is centred on the face and its outer
 * edges are flush with the node, so a face carrying one corridor is exactly what it would be
 * without gaps and a sparse diagram does not grow at all. `packPort` lays the same gaps out
 * between the same slots, and the two must agree exactly or the face is oversubscribed.
 */
const stackOf = (
    values: number[],
    valueToPixels: (value: number) => number,
    /**
     * Gaps to make room for, as a count: one between each pair of corridors on the face, plus one
     * between each pair of stripes inside them. Passed as a count rather than pixels so the caller
     * cannot forget to multiply, and so this stays one line in the fit's loop.
     */
    gapCount: number,
    separation: number
): number => {
    let total = 0;
    for (let i = 0; i < values.length; i++) {
        total += valueToPixels(values[i]);
    }
    return total + separation * Math.max(0, gapCount);
};

/**
 * Formats and measures every node's label text once per layout. The fit asks for node sizes at
 * many trial pitches, and the text does not change with the pitch, so nothing below measures
 * inside the fit.
 */
export function measureLabels(nodes: Map<string, GraphNode>, labels: LabelOptions | undefined): {
    totalTexts: Map<string, string>;
    textWidths: Map<string, TextWidths>;
    labelBoxes: Map<string, { w: number; h: number }>;
} {
// Formatted once: the fit measures the label at every trial pitch, and formatting there would
// make a layout dramatically slower. This comes before the widths, because a total's width is
// the width of its formatted string.
const totalTexts = new Map<string, string>();
if (labels?.nodeTotals) {
    nodes.forEach(n => {
        if (!n.hideTotal) {
            totalTexts.set(n.id, formatTotal(totalOf(n as PositionedNode, labels.basis), labels));
        }
    });
}
// Measured once, for the same reason. Real text measurement costs far more than formatting,
// and the strings are fixed for the whole layout; only where they are drawn depends on the
// pitch. Everything below reads these numbers; nothing measures inside `sizeNodes` or
// `reachOf`.
const textWidths = new Map<string, TextWidths>();
const nameSize = nameSizeOf(labels);
const totalSize = totalSizeOf(labels);
// Wrapped here and only here. The breaks are decided once, against a budget from the font size
// rather than the pitch the fit is still solving for, so the fit loop below costs what it would
// without wrapping and the lines render draws are the lines the fit measured. See
// `labelWrap.ts` for why it is not the viewport either.
const wrapWidth = wrapWidthOf(nameSize);
nodes.forEach(n => {
    const nameText = n.label !== "" ? (n.label || n.id) : "";
    const measure = (text: string) => widthOfText(text, nameSize, labels, labels?.font?.bold);
    const nameLines = wrapText(nameText, wrapWidth, measure);
    textWidths.set(n.id, {
        nameLines,
        // The full breakpoint table, for the inside-the-shape test below. The em cap above still
        // governs a label drawn outside, where there is no box to wrap to and only readability bounds
        // the line.
        wrapOptions: wrapOptionsOf(nameText, measure),
        name: widestOf(nameLines),
        // A node whose name is suppressed draws its total at the name's size, so it is measured at
        // that size too; see `labelLinesOf`.
        total: widthOfText(totalTexts.get(n.id) ?? "",
            n.label !== "" ? totalSize : nameSize, labels,
            n.label !== "" ? labels?.totalBold : labels?.font?.bold)
    });
});
// A label's size does not depend on the grid either.
const labelBoxes = new Map<string, { w: number; h: number }>();
nodes.forEach(n => labelBoxes.set(n.id, labelBoxOf(n, labels, textWidths.get(n.id))));
    return { totalTexts, textWidths, labelBoxes };
}

/**
 * Every node's size at a given pair of pitches. The fit asks what the nodes would measure at a
 * pitch it is still solving for: a node's height is a fraction of the row pitch, so fitting its
 * edge to the frame makes the pitch depend on itself.
 */
export function sizeNodesAt(env: LayoutEnv, rowPitch: number, columnGap: number): Map<string, NodeSize> {
    const {
        nodes, labels, arrows, nodeShape, nodeShapeFitLabel, nodeMinWidthPercent, nodeMinHeightPercent,
        nodeShapePaddingPercent, flowSeparationPercent, textWidths, labelBoxes, packingPitchOf, valueToPixelsAt
    } = env;
    const {
        faceValues, faceStripeGaps, headFaceValues, tailFaceValues, headStripeGaps, tailStripeGaps,
        arrowHeads, arrowTails, arrowFactor
    } = env.faces;
    const packingPitch = packingPitchOf(rowPitch, columnGap);
    const valueToPixels = valueToPixelsAt(packingPitch);
    // A single-column diagram has no column gap at all, so there is no horizontal pitch for the
    // width floor to be a fraction of. Falling back to the row pitch keeps the setting meaningful
    // there (it is still the grid's own scale, just the only one that exists), where a raw pixel
    // fallback would be the one place the diagram stopped following its grid.
    const widthBasis = columnGap > 0 ? columnGap : rowPitch;
    const nodeMinWidth = widthBasis * Math.max(0, nodeMinWidthPercent) / 100;
    // Height's floor is a fraction of the row pitch: each axis's floor follows the pitch of the
    // axis it measures.
    const nodeMinHeight = rowPitch * Math.max(0, nodeMinHeightPercent) / 100;
    const shapePadding = packingPitch * Math.max(0, nodeShapePaddingPercent) / 100;
    // Follows the trial pitch like every other size here, so the fit solves for a diagram whose
    // gaps are the ones that will be drawn.
    const separation = flowSeparationPixels(flowSeparationPercent, packingPitch);
    const sizes = new Map<string, NodeSize>();
    nodes.forEach(n => {
        // A node is exactly as big as the bands it has to hold, on each axis independently: its height
        // is the taller of the stacks its East and West edges pack, its width the wider of its North
        // and South ones. The two sliders below are floors on that and nothing else; where a floor is
        // the larger, the node simply overhangs its bands.
        //
        // It is measured against the widths the corridors are drawn at, not `valueToPixels` of their
        // total. Those agree wherever every corridor is above MIN_CORRIDOR_WIDTH, since the conversion
        // is linear there; at the floor they cannot, because the floor is handed out once per corridor
        // and a total collects it once. The difference would fall on `packPort`, which has no way of
        // knowing the node was too small and would scale the whole face down to fit, so a band would
        // come out narrower at the crowded end than the other. Sizing from the stack is what makes that
        // squeeze impossible rather than merely rare.
        //
        // An edge with nothing on it contributes nothing, which is what lets a floor of zero collapse a
        // node to a line: `faceValues` holds no entry rather than a zero to convert, and
        // `valueToPixels(0)` would come back at the floor.
        const faces = faceValues.get(n.id) ?? NO_FACES;
        const inner = faceStripeGaps.get(n.id) ?? NO_GAPS;
        const gapsOn = (port: Port, values: number[]) => values.length - 1 + inner[port];
        const eastStack = stackOf(faces.East, valueToPixels, gapsOn("East", faces.East), separation);
        const westStack = stackOf(faces.West, valueToPixels, gapsOn("West", faces.West), separation);
        const northStack = stackOf(faces.North, valueToPixels, gapsOn("North", faces.North), separation);
        const southStack = stackOf(faces.South, valueToPixels, gapsOn("South", faces.South), separation);
        const vPixels = Math.max(eastStack, westStack);
        const hPixels = Math.max(northStack, southStack);
        // Absolute floors, applied last so nothing above can undercut them. They sit on the node
        // rather than on its shape: the shape is sized from the node, so these reach it too.
        //
        // The arrow gap is the third floor, and it is on the flow axis only. An East/West arrow drives
        // inward along x, so it is the width that has to hold it, which is why the stacks below are
        // crossed over: width is floored by the East/West arrows, height by the North/South ones.
        //
        // The node is as thick as the gap plus a taper each end, so the visible break in the flow is
        // the number the author set rather than whatever the sliders happened to leave over. The trade
        // is stated in `arrowExtentFloor`: the gaps come out equal and the node thicknesses vary.
        //
        // The packing axis is untouched, so a node is still exactly the stack of bands it holds there
        // and the value-proportional axis never moves.
        let arrowWidthFloor = 0;
        let arrowHeightFloor = 0;
        if (arrowHeads || arrowTails) {
            const heads = headFaceValues.get(n.id) ?? NO_FACES;
            const tails = tailFaceValues.get(n.id) ?? NO_FACES;
            // The face stacks are already summed above, so a face whose drawn ends are its ends (every
            // pure face, which is nearly all of them) needs no second pass over its values. Only a face
            // mixing inbound and outbound ends is summed again.
            const headGaps = headStripeGaps.get(n.id) ?? NO_GAPS;
            const tailGaps = tailStripeGaps.get(n.id) ?? NO_GAPS;
            const stackFor = (values: number[], port: Port, whole: number, own: Record<Port, number>) => {
                if (values.length === 0) {
                    return 0;
                }
                // With the gaps: routing measures a run between the anchors of its first and last end, so the
                // separations between them are inside the extent the taper is cut from. A run is a stretch of
                // consecutive same-role ends, so there are exactly `length - 1` of them, and the pure-face case
                // reuses `whole`, which already carries the face's own.
                return values.length === (faces[port] as number[]).length
                    ? whole
                    : stackOf(values, valueToPixels, values.length - 1 + own[port], separation);
            };
            const depthAt = (stack: number) => (stack > 0 ? stack / 2 * arrowFactor : 0);
            const hE = depthAt(stackFor(heads.East, "East", eastStack, headGaps));
            const tE = depthAt(stackFor(tails.East, "East", eastStack, tailGaps));
            const hW = depthAt(stackFor(heads.West, "West", westStack, headGaps));
            const tW = depthAt(stackFor(tails.West, "West", westStack, tailGaps));
            const hN = depthAt(stackFor(heads.North, "North", northStack, headGaps));
            const tN = depthAt(stackFor(tails.North, "North", northStack, tailGaps));
            const hS = depthAt(stackFor(heads.South, "South", southStack, headGaps));
            const tS = depthAt(stackFor(tails.South, "South", southStack, tailGaps));
            const gap = arrowGapPixels(arrows as ArrowOptions, packingPitch);
            /**
             * A terminal node is only as deep as its one arrow. Giving it the stem an interior node would
             * have means a blank outer half, since `2 * deepest` is clearance for a second arrow that a
             * pure source or sink does not have. The arrow fills the node exactly.
             *
             * Three conditions, each load-bearing:
             *
             *  - Terminal in the graph, not merely one-sided on this axis. An L-shaped interior node (fed
             *    from the West, drained to the North) has one arrow per axis too, and shrinking it would
             *    push a head and a tail into the same small box.
             *  - No opposing face on this axis. A sink fed from the East and the West is terminal and still
             *    has two heads pointing at each other, which need the clearance exactly as an interior
             *    node's do.
             *  - Node shape `None`. With a shape the container is the shape, which is sized from the node
             *    and hangs outside it, so a thinner node would not close the blank space; it would
             *    reappear as stem between the arrow and the shape's edge (`arrowStemInset`).
             *
             * Routing needs no counterpart: it derives the stem from the container it is given
             * (`arrowStemInset`), and on a snug node that comes out 0, which is the arrow filling the box.
             * One formula, one place: the invariant that keeps a node the size of what it holds.
             */
            const snug = nodeShape === "None" && (n.inflow <= 0 || n.outflow <= 0);
            // East/West arrows drive inward along x, so they floor the width; North/South ones the height.
            arrowWidthFloor = snug && !arrowFacesOppose(hE, tE, hW, tW)
                ? Math.max(hE, tE, hW, tW)
                : arrowExtentFloor(gap,
                    arrowClearanceLoss(hE, tE, hW, tW),
                    Math.max(hE, tE, hW, tW));
            arrowHeightFloor = snug && !arrowFacesOppose(hN, tN, hS, tS)
                ? Math.max(hN, tN, hS, tS)
                : arrowExtentFloor(gap,
                    arrowClearanceLoss(hN, tN, hS, tS),
                    Math.max(hN, tN, hS, tS));
        }
        const width = Math.max(hPixels, nodeMinWidth, arrowWidthFloor);
        const height = Math.max(vPixels, nodeMinHeight, arrowHeightFloor);

        // The decorative overlay. Square from one setting, floored so it always covers the node
        // rectangle, and, only with Fit to label, grown sideways to hold a name that would otherwise
        // overflow it. Without that, an overflowing label moves outside instead and the shape keeps the
        // size it was asked for.
        let shapeWidth = 0;
        let shapeHeight = 0;
        let labelInside = false;
        const widths = textWidths.get(n.id);
        // The em-capped wrap is what a label drawn outside uses, and the starting point here; the
        // inside test may replace it below.
        let nameLines: WrappedLine[] = widths?.nameLines ?? [];
        // Measured once for every node above, so this always hits.
        const box = labelBoxes.get(n.id) as { w: number; h: number };
        if (nodeShape !== "None") {
            // Sized purely from the node, which already carries the minimums, so moving either slider
            // moves the node and the shape together rather than letting them drift apart.
            const floor = shapeFloorFor(nodeShape, width, height);
            shapeWidth = floor.w;
            shapeHeight = floor.h;
            if (nodeShapeFitLabel) {
                // Both axes: a name and a total are two lines, and a shape wide enough for the text can still
                // be too short for it.
                shapeWidth = Math.max(shapeWidth, box.w);
                shapeHeight = Math.max(shapeHeight, box.h);
                // A circle is one diameter, so it has to clear both.
                if (nodeShape === "Circle") {
                    const diameter = Math.max(shapeWidth, shapeHeight);
                    shapeWidth = diameter;
                    shapeHeight = diameter;
                }
            }
            // A rounded corner would otherwise bite through the node rectangle it is covering, leaving the
            // outermost corridor on a face anchored outside the card.
            //
            // Which axis grows follows the node's routing, not whichever would be cheapest: wide enough
            // where corridors run horizontally, tall enough where they run vertically, both where they do
            // both. A per-node cost heuristic would grow different nodes in different directions, and the
            // shapes would stop looking like one family across a diagram. A node with no corridors at all
            // cannot strand an anchor, but is still widened so it matches its neighbours.
            //
            // Growing an axis raises `min(width, height)` and so the radius itself, which raises the
            // requirement again. The iteration is a contraction (each pass moves the radius by a factor of
            // 2 * SHAPE_CORNER_RATIO = 0.36), so this settles in a handful of passes; the loop is capped,
            // and the clearance property is asserted however it was reached.
            if (nodeShape === "Rounded") {
                const growWidth = vPixels > 0 || hPixels === 0;
                const growHeight = hPixels > 0;
                for (let pass = 0; pass < 8; pass++) {
                    const radius = SHAPE_CORNER_RATIO * Math.min(shapeWidth, shapeHeight);
                    const wantWidth = growWidth ? width + 1 + 2 * radius : 0;
                    const wantHeight = growHeight ? height + 1 + 2 * radius : 0;
                    if (wantWidth <= shapeWidth + 1e-6 && wantHeight <= shapeHeight + 1e-6) {
                        break;
                    }
                    shapeWidth = Math.max(shapeWidth, wantWidth);
                    shapeHeight = Math.max(shapeHeight, wantHeight);
                }
            }
            // Shape padding, last of all: the shape is drawn this much proud of whatever it would
            // otherwise have been, on every side. It comes after the corner solve rather than before it, so
            // the slider means exactly what it says on every shape; applied to the floor instead, padding
            // would partly substitute for the growth a Rounded shape needs to keep its corner clear of the
            // node, and the same percentage would grow a rounded shape less than a rectangular one. The
            // same number of pixels goes on both axes, since it is measured against the one pitch the whole
            // diagram is scaled by.
            shapeWidth += 2 * shapePadding;
            shapeHeight += 2 * shapePadding;

            // Does it fit inside, on one line or on any number? Measured last, after every growth above,
            // padding included since it is room the label can sit in, and against both axes: a block that
            // fits the width can still be too tall.
            //
            // A text box wraps to its box, so the shape is the box and the question is which break fits it.
            // `wrapForWidth` answers from the precomputed table (the fewest lines whose widest line clears
            // the room), so this costs a comparison per option and measures nothing, which is what lets it
            // live in the fit's own loop where the shape's width is finally known. Asking only whether the
            // em-capped block fitted would push a label outside a shape while a wider one wrapped and sat
            // inside it.
            //
            // The icon and the total are in the width test too, exactly as `labelBoxOf` budgets them: the
            // block is as wide as the widest of the three. Comparing the name alone would let a wide icon
            // or a long total slip inside a shape too narrow for it.
            const room = shapeWidth - 2 * SHAPE_PADDING;
            const others = Math.max(widths?.total ?? 0, iconSizeOf(n, labels));
            const option = wrapForWidth(widths?.wrapOptions ?? [], room);
            if (option && Math.max(option.width, others) <= room) {
                // The block's height for this many lines. Arithmetic off the hoisted box rather than
                // re-running `labelBoxOf`, which would re-format the total at every trial pitch.
                const grown = (option.lines.length - (widths?.nameLines.length ?? 1))
                    * nameSizeOf(labels) * LINE_HEIGHT_NAME;
                if (box.h + grown <= shapeHeight) {
                    labelInside = true;
                    nameLines = option.lines;
                }
            }
        }
        sizes.set(n.id, { width, height, shapeWidth, shapeHeight, labelInside, box, nameLines });
    });
    return sizes;
}

/**
 * How far each node's drawn extent reaches about the point its grid position lands on:
 * horizontally from its left edge (where a column lands), vertically about its centre (where a
 * row does). The shape, when there is one, is centred on the node and may be bigger than it.
 */
export function reachOf(env: LayoutEnv, node: GraphNode, size: NodeSize, labelPort: Port) {
    const { labels, nodeShape, totalTexts, textWidths } = env;
    const drawnWidth = Math.max(size.width, size.shapeWidth);
    const drawnHeight = Math.max(size.height, size.shapeHeight);
    let left = size.width / 2 - drawnWidth / 2;
    let right = size.width / 2 + drawnWidth / 2;
    let up = drawnHeight / 2;
    let down = drawnHeight / 2;
    // The label, placed exactly as render.ts will draw it, about a node whose left edge is at 0 and
    // whose centre is at height 0.
    const { lines, icon } = labelLinesOf({
        ...node, x: 0, y: -size.height / 2, width: size.width, height: size.height,
        shapeWidth: size.shapeWidth, shapeHeight: size.shapeHeight,
        labelPort, labelInside: size.labelInside,
        nameLines: size.nameLines
    }, labels, nodeShape !== "None" && size.shapeWidth > 0, totalTexts.get(node.id),
    textWidths.get(node.id));
    if (icon) {
        left = Math.min(left, icon.x);
        right = Math.max(right, icon.x + icon.size);
        up = Math.max(up, -icon.y);
        down = Math.max(down, icon.y + icon.size);
    }
    lines.forEach(line => {
        const box = textBoxOf(line);
        left = Math.min(left, box.left);
        right = Math.max(right, box.right);
        up = Math.max(up, -box.top);
        down = Math.max(down, box.bottom);
    });
    return { left, right, up, down };
}
