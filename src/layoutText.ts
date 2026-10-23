/**
 * Label text: measuring it, laying a node's label block out, and deciding which face of the
 * node a label sits against.
 */

import { GraphNode, LabelOptions, NodeShape, OPPOSITE_PORT, Port, PORTS, PositionedNode } from "./model";
import { WrapOption, WrappedLine } from "./labelWrap";
import { formatTotal, totalOf } from "./tooltips";

/**
 * The fallback for how wide a label will be: a fixed ~6.2px per character.
 *
 * A per-character constant is the width of one font at one size, and wrong by a lot on real
 * proportional text, so `LabelOptions.measureText` supplies the real thing where there is a
 * live host to measure with. These remain for the synthetic checks, which run in Node with no
 * DOM: absent a measurer, everything below uses the estimate.
 */
const SHAPE_CHAR_WIDTH = 6.2;

/** The total is drawn a couple of points smaller than the name (9px vs 11px). */
const SHAPE_TOTAL_CHAR_WIDTH = 5.1;

/**
 * How wide one string is, measured if we can and estimated if we cannot.
 *
 * It is never called from inside the fit's bisection. Every caller measures once per layout
 * (the strings a node draws do not depend on the pitch) and passes the numbers down. See
 * `textWidths` in `computeLayout`.
 */
export function widthOfText(
    text: string,
    fontSize: number,
    labels: LabelOptions | undefined,
    bold = false
): number {
    if (text === "") {
        return 0;
    }
    if (labels?.measureText) {
        return labels.measureText(text, fontSize, bold, labels.font?.family);
    }
    return text.length * perCharAt(fontSize);
}

/**
 * The fallback's per-character width. It is exactly the base constants at the two default
 * sizes, and scaled with the size for anything else, which only a check that sets a font size
 * without a measurer can reach.
 */
function perCharAt(fontSize: number): number {
    if (fontSize === LABEL_NAME_SIZE) {
        return SHAPE_CHAR_WIDTH;
    }
    if (fontSize === LABEL_TOTAL_SIZE) {
        return SHAPE_TOTAL_CHAR_WIDTH;
    }
    return SHAPE_CHAR_WIDTH * fontSize / LABEL_NAME_SIZE;
}

/** The two widths a node's label block is built from, measured once. */
export interface TextWidths {
    /**
     * The name's drawn lines, each with the width it was measured at. One entry unless it wrapped
     * (`labelWrap.ts`), and none for a suppressed name, so `name` below is the widest line, which is
     * what budgets the label block either way.
     */
    nameLines: WrappedLine[];
    name: number;
    total: number;
    /**
     * Every way the name can be broken, and what each costs, computed once so the fit can ask "how
     * many lines at this width?" without measuring. See `wrapOptionsOf`.
     */
    wrapOptions: WrapOption[];
}

/** The widest of a name's lines, or 0 when it has none. */
export function widestOf(lines: WrappedLine[]): number {
    return lines.reduce((w, line) => Math.max(w, line.width), 0);
}

/**
 * Breathing space either side of a label inside its container. A larger margin moves a label
 * outside while there is still obvious room around it, so this is deliberately tight. The
 * character estimate above is already generous, which leaves enough margin in practice.
 */
export const SHAPE_PADDING = 4;

/**
 * Room one drawn line takes, as a ratio of its font size. The ratios are written as
 * 14/11 for a name and 12/9 for a total, so at the default sizes they give 14px and 12px and a
 * font control scales them with the size.
 */
export const LINE_HEIGHT_NAME = 14 / 11;

const LINE_HEIGHT_TOTAL = 12 / 9;

/** The font size a node's name is drawn at. */
export function nameSizeOf(labels: LabelOptions | undefined): number {
    return labels?.font?.size ?? LABEL_NAME_SIZE;
}

/** The font size a node's total is drawn at, under a name. */
export function totalSizeOf(labels: LabelOptions | undefined): number {
    return labels?.totalSize ?? LABEL_TOTAL_SIZE;
}

/**
 * How much room a node's label block actually needs.
 *
 * Measuring the name alone is wrong twice over: a node total is a second line, so the block is
 * taller, and a total like "1,234.5 TWh" can be wider than the name above it. Both would show
 * up as text spilling out of the bottom of a shape it had been declared to fit.
 *
 * `labels` is optional because the synthetic checks' chrome literals do not all carry it;
 * absent, no total is drawn and none is budgeted for.
 */
export function labelBoxOf(
    node: GraphNode,
    labels: LabelOptions | undefined,
    /** Measured once per layout by the caller; absent, measured here. */
    widths?: TextWidths
): { w: number; h: number } {
    const showName = node.label !== "";
    const nameText = showName ? (node.label || node.id) : "";
    const totalText = labels?.nodeTotals && !node.hideTotal
        ? formatTotal(totalOf(node as PositionedNode, labels.basis), labels)
        : "";
    const icon = iconSizeOf(node, labels);
    if (nameText === "" && totalText === "" && icon === 0) {
        return { w: 0, h: 0 };
    }
    const nameSize = nameSizeOf(labels);
    const totalSize = nameText !== "" ? totalSizeOf(labels) : nameSize;
    // However many lines the name wrapped to: the block has to budget for all of them or a
    // wrapped label would be measured shorter than it is drawn.
    const nameLineCount = widths
        ? widths.nameLines.length
        : (nameText !== "" ? 1 : 0);
    const textHeight = nameLineCount * nameSize * LINE_HEIGHT_NAME
        + (totalText !== "" ? totalSize * LINE_HEIGHT_TOTAL : 0);
    // Inside a shape the icon stacks above the text (see `labelLinesOf`), so it adds to the height
    // and can only widen the block to its own size.
    return {
        w: Math.max(
            widths ? widestOf(widths.nameLines) : widthOfText(nameText, nameSize, labels, labels?.font?.bold),
            widths ? widths.total : widthOfText(totalText, totalSize, labels, labels?.totalBold),
            icon
        ) + 2 * SHAPE_PADDING,
        h: textHeight + icon + (icon > 0 && textHeight > 0 ? ICON_GAP : 0)
    };
}

/** Default icon edge, px: a little taller than a name's cap height plus its total. */
export const DEFAULT_ICON_SIZE = 16;

/** Between an icon and its text. */
const ICON_GAP = 3;

/** A node's icon edge in px, or 0 when it has none. */
export function iconSizeOf(node: GraphNode, labels: LabelOptions | undefined): number {
    if (!node.icon) {
        return 0;
    }
    const size = labels?.iconSize ?? DEFAULT_ICON_SIZE;
    return Number.isFinite(size) ? Math.max(4, Math.min(128, size)) : DEFAULT_ICON_SIZE;
}

/**
 * The smallest a shape may be drawn: big enough to cover the node rectangle, so no band ever
 * appears to poke out of the shape standing in for the node.
 *
 * It is floored per axis, not by the node's longer side. Covering a 34x263 node with a square
 * would mean a 263x263 square, an enormous block over a thin tall bar, where what the shape is
 * meant to look like is that bar's card. Per axis it comes out 34 wide and 263 tall, and the
 * size setting then widens it from there.
 *
 * A circle is the exception and takes the rectangle's diagonal rather than its longer side: a
 * circle whose diameter is only the longer side leaves the rectangle's corners outside it, and
 * a corridor anchored near the end of a long face is drawn exactly there, so it would graze
 * past the circle it is supposed to be entering.
 */
export function shapeFloorFor(shape: NodeShape, width: number, height: number): { w: number; h: number } {
    if (shape === "Circle") {
        const diameter = Math.hypot(width, height);
        return { w: diameter, h: diameter };
    }
    return { w: width, h: height };
}

/**
 * How far an outside label sits off the node's drawn box. render.ts places labels with this
 * same constant, and the fit measures them with it; change them together. Because the fit
 * measures each label where it is actually drawn (`labelReachOf`), a short name costs only its
 * own width and a long one is never clipped.
 */
const LABEL_GAP = 6;

/**
 * Which face a node's label sits against: its emptiest.
 *
 * "Emptiest" alone leaves three-way ties everywhere (a source node has nothing on West, North
 * or South), so the order below breaks them by convention rather than by whichever port
 * happens to sort first. The outermost columns prefer to label outward, into the reserve that
 * exists for exactly that, which keeps a source node's name off the diagram. A mid-chain node,
 * busy East and West, labels North instead: the row pitch already carries a spare pitch above
 * row 1, so there is room for it.
 *
 * Demand is compared first and the order only breaks ties, so a node that is genuinely busy on
 * all four faces still puts its label against the quietest.
 */
export function labelPortOf(
    demand: Record<Port, number>,
    column: number,
    minColumn: number,
    maxColumn: number
): Port {
    // One anchored face and the label goes opposite it, wherever the node sits. This has to come
    // before the column preferences: a source node in an interior column has three empty faces,
    // and the general order would send its label North purely because North sorts first, when the
    // obvious place is the free side facing away from its one corridor. The outermost columns
    // behave this way anyway.
    const live = PORTS.filter(p => demand[p] > 0);
    if (live.length === 1) {
        return OPPOSITE_PORT[live[0]];
    }

    const preference: Port[] = [];
    if (column === minColumn) {
        preference.push("West");
    }
    if (column === maxColumn) {
        preference.push("East");
    }
    (["North", "South", "East", "West"] as Port[]).forEach(p => {
        if (!preference.includes(p)) {
            preference.push(p);
        }
    });
    let best = preference[0];
    preference.forEach(p => {
        if (demand[p] < demand[best]) {
            best = p;
        }
    });
    return best;
}

/** Where a node's icon is drawn: a square, top-left corner and edge. */
export interface LabelIcon {
    x: number;
    y: number;
    size: number;
}

/** One drawn line of a node's label. */
export interface LabelLine {
    text: string;
    x: number;
    y: number;
    anchor: "start" | "middle" | "end";
    fontSize: number;
    /** The total under a name: drawn muted. */
    muted: boolean;
    /**
     * How wide this line is drawn, measured where the line was built. Carried on the line so
     * `textBoxOf` reads a number rather than re-deriving one: it is called for every line at every
     * trial pitch of the fit.
     */
    width: number;
}

/** Font sizes of a label's two lines, and the text metrics the fit measures them with. */
export const LABEL_NAME_SIZE = 11;

export const LABEL_TOTAL_SIZE = 9;

/**
 * A glyph's reach above and below its baseline, as a fraction of the font size. Exported so
 * flowLabels.ts measures a label's height the same way rather than keeping its own copy.
 */
export const TEXT_ASCENT = 0.8;

export const TEXT_DESCENT = 0.25;

/**
 * The offsets that place a label block, each as a fraction of the font size it belongs to.
 * They are ratios so that a font size change scales the whole block.
 */
const BASELINE_DROP = 4 / 11;

const NAME_LIFT = 5 / 11;

const TOTAL_DROP = 7 / 9;

const NORTH_LIFT = 6 / 11;

const SOUTH_DROP = 8 / 11;

/**
 * Where a node's label lines are drawn: the one place that decides it. render.ts paints
 * exactly these lines, and the fit measures exactly these (`labelReachOf`), so the margin the
 * fit leaves is round what is drawn.
 *
 * `shapeDrawn`: whether a node shape is painted over the node. A label sits inside it
 * (centred) when layout found it fits, and otherwise LABEL_GAP off whatever is drawn: the
 * shape's box where there is one, since a label placed off the node rectangle would end up
 * underneath its own shape.
 */
export function labelLinesOf(
    node: Pick<PositionedNode, "id" | "label" | "x" | "y" | "width" | "height" | "shapeWidth" | "shapeHeight"
        | "labelPort" | "labelInside"> & Partial<Pick<PositionedNode, "nameLines">> & GraphNode,
    labels: LabelOptions | undefined,
    shapeDrawn: boolean,
    /**
     * The formatted total, when the caller already has it. Formatting is the expensive part and
     * never changes with the pitch, so the fit does it once.
     */
    totalText?: string,
    /**
     * The two measured widths, from the caller that measured them once for the whole layout.
     * Absent (render, which draws each label once), they are measured here.
     */
    widths?: TextWidths
): { lines: LabelLine[]; inside: boolean; icon?: LabelIcon } {
    // Explicit label suppression hides the name, not the total: a node showing only its throughput
    // is a real convention in reference diagrams, and the two are separate settings.
    const showName = node.label !== "";
    const showTotal = Boolean(labels?.nodeTotals) && !node.hideTotal;
    const iconSize = iconSizeOf(node, labels);
    if (!showName && !showTotal && iconSize === 0) {
        return { lines: [], inside: false };
    }
    const inside = node.labelInside && shapeDrawn;
    const nameSize = nameSizeOf(labels);
    const totalSize = showName ? totalSizeOf(labels) : nameSize;
    const centreX = node.x + node.width / 2;
    const centreY0 = node.y + node.height / 2;
    let x = centreX;
    let anchor: LabelLine["anchor"] = "middle";
    // Every offset below is a ratio of the font size, written so it comes out at the identical
    // pixel at the default size.
    let baseY = centreY0 + BASELINE_DROP * nameSize;
    const boxW = shapeDrawn ? node.shapeWidth : node.width;
    const boxH = shapeDrawn ? node.shapeHeight : node.height;
    if (!inside) {
        switch (node.labelPort) {
            case "West":
                x = centreX - boxW / 2 - LABEL_GAP;
                anchor = "end";
                break;
            case "North":
                baseY = centreY0 - boxH / 2 - LABEL_GAP;
                break;
            case "South":
                baseY = centreY0 + boxH / 2 + LABEL_GAP + SOUTH_DROP * nameSize;
                break;
            case "East":
            default:
                x = centreX + boxW / 2 + LABEL_GAP;
                anchor = "start";
                break;
        }
    }
    // Two lines centre on the node between them rather than the name sitting where a lone name
    // would and the total hanging below it. Stacked above the node, the pair has to clear it, so
    // the block grows upward from the node's edge instead of straddling it.
    const bothLines = showName && showTotal;
    // The name's lines, as layout broke them. Absent (a hand-built node in a check), it is the one
    // line this always drew, measured here, so nothing that does not wrap can move.
    const nameText = node.label || node.id;
    const nameLines: WrappedLine[] = showName
        ? (node.nameLines && node.nameLines.length > 0
            ? node.nameLines
            : [{ text: nameText, width: widths ? widths.name : widthOfText(nameText, nameSize, labels, labels?.font?.bold) }])
        : [];
    // How far the block grows past one line, each way. The extra lines are spread symmetrically
    // about where a single line sat, so a wrapped label stays centred on its node rather than
    // hanging off one side, and at one line this is exactly 0.
    const spread = (nameLines.length - 1) / 2 * nameSize * LINE_HEIGHT_NAME;
    // Stacked above or below the node, the block has to clear it, so growing symmetrically would
    // push it over the node's edge: North lifts by the growth and South drops by it. Against a
    // side, centred is right already.
    const clear = inside ? 0
        : node.labelPort === "North" ? -spread
            : node.labelPort === "South" ? spread
                : 0;
    const centreY = (!inside && node.labelPort === "North" && bothLines
        ? baseY - NORTH_LIFT * nameSize
        : baseY) + clear;
    const lines: LabelLine[] = [];
    nameLines.forEach((line, i) => {
        lines.push({
            text: line.text,
            x,
            y: centreY + (bothLines ? -NAME_LIFT * nameSize : 0)
                + (i - (nameLines.length - 1) / 2) * nameSize * LINE_HEIGHT_NAME,
            anchor,
            fontSize: nameSize,
            muted: false,
            width: line.width
        });
    });
    if (showTotal && labels) {
        const text = totalText ?? formatTotal(totalOf(node as PositionedNode, labels.basis), labels);
        const bold = showName ? labels.totalBold : labels.font?.bold;
        lines.push({ text, x,
            // Below the lowest name line, so a wrapped name does not land on top of its own total.
            // `spread` is 0 at one line.
            y: centreY + (bothLines ? TOTAL_DROP * totalSize + spread : 0), anchor,
            fontSize: totalSize, muted: showName,
            // The hoisted pair already measured a lone total at the name's size (see `textWidths`), so
            // either branch is measuring the right thing.
            width: widths ? widths.total : widthOfText(text, totalSize, labels, bold) });
    }
    if (iconSize === 0) {
        return { lines, inside };
    }
    return { ...withIcon(lines, iconSize, inside, node.labelPort, { x, centreX, centreY0, boxH }), inside };
}

/**
 * Adds the icon to a label block. The text is placed first, exactly as without an icon; the
 * icon then takes its place against that block and the text moves over to make room:
 *
 *  - Above the name inside a shape (the pair re-centred on the node) and on a North or South
 *    face: stacking suits circles and squares, and a label above or below a node is read top
 *    to bottom anyway.
 *  - Beside the name, on the side nearest the node, on an East or West face: a stacked block
 *    beside a thin bar would be taller than the bar.
 *
 * A node with an icon but no text (its name suppressed, no total) keeps the icon alone where
 * the text would have started.
 */
function withIcon(
    lines: LabelLine[],
    size: number,
    inside: boolean,
    port: Port,
    at: { x: number; centreX: number; centreY0: number; boxH: number }
): { lines: LabelLine[]; icon: LabelIcon } {
    let top: number;
    let bottom: number;
    if (lines.length > 0) {
        top = Number.POSITIVE_INFINITY;
        bottom = Number.NEGATIVE_INFINITY;
        lines.forEach(line => {
            const box = textBoxOf(line);
            top = Math.min(top, box.top);
            bottom = Math.max(bottom, box.bottom);
        });
    } else {
        // A zero-height block where the text would have started.
        const y = inside ? at.centreY0
            : port === "North" ? at.centreY0 - at.boxH / 2 - LABEL_GAP
                : port === "South" ? at.centreY0 + at.boxH / 2 + LABEL_GAP
                    : at.centreY0;
        top = y;
        bottom = y;
    }
    const gap = lines.length > 0 ? ICON_GAP : 0;
    const shift = (dx: number, dy: number) => lines.map(line => ({ ...line, x: line.x + dx, y: line.y + dy }));
    if (inside) {
        const dy = (size + gap) / 2;
        return { lines: shift(0, dy), icon: { x: at.centreX - size / 2, y: top + dy - gap - size, size } };
    }
    switch (port) {
        case "North":
            return { lines, icon: { x: at.centreX - size / 2, y: top - gap - size, size } };
        case "South":
            return { lines: shift(0, size + gap), icon: { x: at.centreX - size / 2, y: top, size } };
        case "West":
            return { lines: shift(-(size + gap), 0), icon: { x: at.x - size, y: (top + bottom) / 2 - size / 2, size } };
        case "East":
        default:
            return { lines: shift(size + gap, 0), icon: { x: at.x, y: (top + bottom) / 2 - size / 2, size } };
    }
}

/**
 * The box a drawn line of text covers.
 *
 * The width was measured where the line was built (`labelLinesOf`), because this is called for
 * every line at every trial pitch of the fit and real measurement there would cost hundreds of
 * times over. A hand-built line in a check has no width, and falls back to the per-character
 * estimate.
 */
export function textBoxOf(line: LabelLine): { left: number; right: number; top: number; bottom: number } {
    const width = line.width ?? line.text.length * perCharAt(line.fontSize);
    const left = line.anchor === "start" ? line.x : line.anchor === "end" ? line.x - width : line.x - width / 2;
    return {
        left,
        right: left + width,
        top: line.y - TEXT_ASCENT * line.fontSize,
        bottom: line.y + TEXT_DESCENT * line.fontSize
    };
}
