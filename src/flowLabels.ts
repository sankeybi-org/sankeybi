/**
 * Flow labels: a figure drawn on the flow itself.
 *
 * This module decides where each label goes and which labels are drawn at all. It is
 * separate from render.ts for the reason layers.ts is: those are decisions, render
 * paints what it is told, and a decision in a pure module can be checked without a
 * DOM.
 *
 * The rules:
 *
 * - The label sits at the midpoint, measured along the route rather than between the
 *   anchors. A wrap or a self-loop travels a long way from the straight line between
 *   its ends, and the middle of that line is usually not on the band at all.
 * - The text is never rotated. Text that follows a band is harder to read and, on a
 *   diagram whose corridors run every which way, makes the picture look busy.
 * - A label is dropped where it does not fit inside the flow or collides with
 *   anything. It is not shrunk, not moved aside and not given a leader line; the
 *   author can widen the flow, drag the route or raise Flow width to get the figure
 *   back. That keeps the rule something a reader can trust: a label on a band always
 *   belongs to that band and always sits inside it.
 *
 * Outside labels are the author's way out of that last rule, and they are off by
 * default. Most flows cannot hold unrotated text, so the figure for the rest would
 * otherwise be available only by hovering. Switched on, a label that cannot go inside
 * is placed clear of the band with a leader line back to the midpoint, the convention
 * Power BI's own pie and donut detail labels use when positioned outside.
 *
 * They are still pure paint: an outside label takes no room in the view fit, because
 * reserving room for it would shrink the pitch, which changes how thick every band is
 * drawn, which changes which labels needed to go outside in the first place. Instead a
 * candidate position must land inside the chrome box to be used at all, so nothing is
 * drawn half clipped, and a label with nowhere to go is dropped.
 */

import { FlowLabelContent, LabelOptions, PixelRect, Point, PositionedNode } from "./model";
import { TEXT_ASCENT, TEXT_DESCENT } from "./layoutText";
import { formatTotal } from "./tooltips";

/** One label, as render should draw it. */
export interface FlowLabelPlacement {
    corridorId: string;
    text: string;
    /** The text's anchor point; it is drawn centred on this. */
    x: number;
    y: number;
    /** The box it was tested against, for the checks and for ink decisions. */
    width: number;
    height: number;
    /**
     * The colour of the stripe it lands on, so ink can be chosen against it. Undefined
     * for an outside label, which sits on the report background rather than on a band:
     * render then uses the theme's own text colour, because `inkOn` of the band would
     * pick white text for open space.
     */
    over: string | undefined;
    /**
     * Present only on an outside label: the leader line, from the label's own box edge to
     * the midpoint of the band it describes. Render draws it as given.
     */
    leader?: { from: Point; to: Point };
}

/** What this module needs to know about one corridor. */
export interface FlowLabelCorridor {
    id: string;
    value: number;
    /** The source node's id, for "percentage of what leaves the source". */
    source: string;
    /** The centreline, from routing (`DiagramRouting.spines`). */
    spine: readonly Point[];
    /** How thick the whole corridor is drawn, in pixels. */
    thickness: number;
    /** The colour under the midpoint, where there is one. */
    colour: string | undefined;
}

export interface FlowLabelInput {
    corridors: readonly FlowLabelCorridor[];
    /** Every node, so a label is never drawn over one. */
    nodes: readonly PositionedNode[];
    content: FlowLabelContent;
    fontSize: number;
    bold: boolean;
    /** The Node labels and Values settings, for `formatTotal` and the injected measurer. */
    labels: LabelOptions;
    /**
     * Place a label that cannot go inside its band outside it, with a leader line back to
     * the midpoint. Off (the default), a label that does not fit is simply not drawn.
     */
    outsideLabels?: boolean;
    /**
     * Where an outside label is allowed to be. Required for `outsideLabels`
     * to do anything: an outside label reserves no room, so one placed past
     * the edge of the drawing area would just be clipped.
     */
    chromeBox?: PixelRect;
}

/** A box, as the fit and collision tests see it. */
interface Box {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * The point half way along a polyline, and the direction of travel there.
 *
 * Half way along rather than half way between the ends: a wrap leaves its node, runs
 * out to a lane and comes back, and the midpoint of the straight line between its
 * anchors can be off the band entirely, which would put the label in open space next
 * to the flow it claims to describe.
 */
export function midpointOf(spine: readonly Point[]): { at: Point; direction: Point } | undefined {
    if (spine.length < 2) {
        return undefined;
    }
    const lengths: number[] = [];
    let total = 0;
    for (let i = 1; i < spine.length; i++) {
        const d = Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y);
        lengths.push(d);
        total += d;
    }
    if (total <= 0) {
        return undefined;
    }
    let walked = 0;
    for (let i = 0; i < lengths.length; i++) {
        if (walked + lengths[i] >= total / 2) {
            // A zero-length segment has no direction; the guard above means this one has length,
            // since it reached past the half way mark.
            const t = (total / 2 - walked) / lengths[i];
            const a = spine[i];
            const b = spine[i + 1];
            return {
                at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
                direction: { x: (b.x - a.x) / lengths[i], y: (b.y - a.y) / lengths[i] }
            };
        }
        walked += lengths[i];
    }
    return undefined;
}

/**
 * Does an unrotated box of `w` x `h` fit inside a ribbon of half-thickness `t`
 * running in direction `d`, centred on the ribbon's centreline?
 *
 * Exactly, for a locally straight ribbon: a point `p` offset from the centre is inside
 * it when `|p x d| <= t`, and over the box's four corners the largest `|p x d|` is
 * `(w/2)|dy| + (h/2)|dx|`.
 *
 * That is why a horizontal flow needs only to be as thick as the text is tall, and a
 * vertical one as thick as the text is long. The asymmetry is inherent in not
 * rotating the text, and it is why most labels appear on the flows that run along the
 * diagram.
 */
export function boxFitsRibbon(w: number, h: number, halfThickness: number, d: Point): boolean {
    return (w / 2) * Math.abs(d.y) + (h / 2) * Math.abs(d.x) <= halfThickness;
}

/**
 * How far an outside label sits clear of the band, and how far each retry steps
 * further out, both as ratios of the font size so they stay right when the author
 * changes the font. At the default 9px these are a 4px gap and 10px steps.
 */
const LEADER_GAP = 4 / 9;
const LEADER_STEP = 10 / 9;
/** How many distances are tried on each side before the label is dropped. */
const LEADER_TRIES = 3;

/** A corridor reduced to what the band-clearance test needs, computed once. */
interface BandMask {
    id: string;
    spine: readonly Point[];
    half: number;
    /** The spine's own bounds, already grown by `half`, for a cheap reject. */
    bounds: Box;
}

function bandMasksOf(corridors: readonly FlowLabelCorridor[]): BandMask[] {
    return corridors
        .filter(c => c.spine.length > 1 && c.thickness > 0)
        .map(c => {
            const half = c.thickness / 2;
            let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
            c.spine.forEach(p => {
                left = Math.min(left, p.x);
                right = Math.max(right, p.x);
                top = Math.min(top, p.y);
                bottom = Math.max(bottom, p.y);
            });
            return { id: c.id, spine: c.spine, half,
                bounds: { left: left - half, right: right + half, top: top - half, bottom: bottom + half } };
        });
}

/**
 * Does a segment touch an axis-aligned box? Slab clipping, the cheap standard test.
 * The box handed in has already been grown by the band's half-thickness, so "touches"
 * means the ribbon overlaps the original box.
 *
 * It is conservative only at the corners, where it treats the ribbon's end as square
 * rather than round. A label rejected for a corner it misses by a hair is moved one
 * step further out, which is not worth the arithmetic.
 */
function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const clip = (p: number, q: number): boolean => {
        // p*t <= q. A zero p means the segment is parallel to this pair of
        // edges: it is either wholly inside the slab or wholly outside it.
        if (p === 0) {
            return q >= 0;
        }
        const r = q / p;
        if (p < 0) {
            if (r > t1) { return false; }
            if (r > t0) { t0 = r; }
        } else {
            if (r < t0) { return false; }
            if (r < t1) { t1 = r; }
        }
        return true;
    };
    return clip(-dx, a.x - box.left) && clip(dx, box.right - a.x)
        && clip(-dy, a.y - box.top) && clip(dy, box.bottom - a.y);
}

/**
 * Is this box clear of every band?
 *
 * Without this test, many outside labels sit on top of a different corridor, which is
 * the misreading the inside-only rule exists to prevent: a figure resting on a band a
 * reader will take it to belong to. A leader line is not enough on its own.
 *
 * Its own band is included rather than excepted. The offset already clears it at the
 * midpoint, so this only matters where a bend of the same corridor comes back round,
 * and there the label is better pushed one step further out.
 */
function boxClearOfBands(box: Box, masks: readonly BandMask[]): boolean {
    return !masks.some(mask => {
        // The spine's own bounds, grown, cannot reach this box: no segment can.
        if (!overlaps(box, mask.bounds)) {
            return false;
        }
        const grown: Box = {
            left: box.left - mask.half,
            right: box.right + mask.half,
            top: box.top - mask.half,
            bottom: box.bottom + mask.half
        };
        for (let i = 1; i < mask.spine.length; i++) {
            if (segmentHitsBox(mask.spine[i - 1], mask.spine[i], grown)) {
                return true;
            }
        }
        return false;
    });
}

/** Where the segment from `inside` out to `at` leaves the box: the leader's start. */
function edgeOfBox(box: Box, at: Point, inside: Point): Point {
    const dx = at.x - inside.x;
    const dy = at.y - inside.y;
    // Largest t in [0, 1] that is still on the box boundary, walking from the label's
    // centre towards the midpoint. A zero component cannot clip.
    let t = 1;
    if (dx !== 0) {
        t = Math.min(t, Math.max((box.left - inside.x) / dx, (box.right - inside.x) / dx));
    }
    if (dy !== 0) {
        t = Math.min(t, Math.max((box.top - inside.y) / dy, (box.bottom - inside.y) / dy));
    }
    return { x: inside.x + dx * t, y: inside.y + dy * t };
}

/**
 * Where an outside label goes, or undefined if it has nowhere to go.
 *
 * Out along the perpendicular to the flow at its midpoint, which is the one direction
 * guaranteed to leave the band by the shortest route and which keeps the leader line at
 * right angles to the thing it points at.
 *
 * Both sides are tried, at `LEADER_TRIES` distances each, and the side further from the
 * middle of the drawing is tried first: the centre of a Sankey is where the nodes and
 * the fat bands are, so pushing labels outwards makes room for them. The first
 * candidate wholly inside the chrome box and clear of everything already placed wins.
 * The search is ordered, so the same diagram labels the same way twice.
 */
function placeOutside(
    mid: { at: Point; direction: Point },
    width: number,
    height: number,
    halfThickness: number,
    fontSize: number,
    taken: readonly Box[],
    chromeBox: PixelRect,
    masks: readonly BandMask[]
): { at: Point; box: Box } | undefined {
    // The left-hand normal to the direction of travel.
    const n = { x: -mid.direction.y, y: mid.direction.x };
    // The label's own half-extent along that normal, so the box clears the band rather
    // than only its centre point doing so; the same projection the inside fit test uses,
    // measured the other way round.
    const reach = (width / 2) * Math.abs(n.x) + (height / 2) * Math.abs(n.y);
    const base = halfThickness + LEADER_GAP * fontSize + reach;

    const centreX = chromeBox.x + chromeBox.width / 2;
    const centreY = chromeBox.y + chromeBox.height / 2;
    // Which way is "outwards" from the middle of the drawing, along n.
    const outward = (mid.at.x - centreX) * n.x + (mid.at.y - centreY) * n.y >= 0 ? 1 : -1;

    for (let step = 0; step < LEADER_TRIES; step++) {
        const distance = base + step * LEADER_STEP * fontSize;
        for (const side of [outward, -outward]) {
            const at = {
                x: mid.at.x + n.x * distance * side,
                y: mid.at.y + n.y * distance * side
            };
            const box: Box = {
                left: at.x - width / 2,
                right: at.x + width / 2,
                top: at.y - height / 2,
                bottom: at.y + height / 2
            };
            const fitsChrome = box.left >= chromeBox.x && box.right <= chromeBox.x + chromeBox.width
                && box.top >= chromeBox.y && box.bottom <= chromeBox.y + chromeBox.height;
            if (fitsChrome
                && !taken.some(other => overlaps(box, other))
                && boxClearOfBands(box, masks)) {
                return { at, box };
            }
        }
    }
    return undefined;
}

/** The figure a label states, before it is formatted. */
function figureOf(
    corridor: FlowLabelCorridor,
    content: FlowLabelContent,
    diagramTotal: number,
    sourceOutflow: number
): { value: number; percent: boolean } {
    if (content === "PercentOfTotal") {
        return { value: diagramTotal > 0 ? corridor.value / diagramTotal * 100 : 0, percent: true };
    }
    if (content === "PercentOfSource") {
        return { value: sourceOutflow > 0 ? corridor.value / sourceOutflow * 100 : 0, percent: true };
    }
    return { value: corridor.value, percent: false };
}

/**
 * A percentage, to one decimal place.
 *
 * It is deliberately not routed through the Values card's decimals or display units:
 * those describe the value field's units, and "1.2M%" is nonsense. One decimal is
 * enough to separate the flows of a diagram and short enough to fit inside a band,
 * which is the constraint that actually binds.
 */
function formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
}

/**
 * Which labels to draw, and where.
 *
 * The order decides who wins a collision, so it is fixed: thickest corridor first, ties
 * by id. A thicker band has more room and carries more of the diagram, so where two
 * labels cannot both be drawn it is the one worth keeping. A deterministic rule means
 * the same diagram labels the same way twice, which iteration order over a Map would
 * not guarantee.
 */
export function placeFlowLabels(input: FlowLabelInput): FlowLabelPlacement[] {
    const diagramTotal = input.corridors.reduce((sum, c) => sum + c.value, 0);
    const outflow = new Map<string, number>();
    input.nodes.forEach(node => outflow.set(node.id, node.outflow));

    const height = (TEXT_ASCENT + TEXT_DESCENT) * input.fontSize;
    const measure = (text: string): number => input.labels.measureText
        ? input.labels.measureText(text, input.fontSize, input.bold, input.labels.font?.family)
        : text.length * 6.2 * input.fontSize / 11;

    // A label may never be drawn over a node: it would read as the node's own.
    // The SHAPE where there is one, since that is what is painted.
    const taken: Box[] = input.nodes.map(node => {
        const halfWidth = Math.max(node.width, node.shapeWidth ?? 0) / 2;
        const halfHeight = Math.max(node.height, node.shapeHeight ?? 0) / 2;
        const cx = node.x + node.width / 2;
        const cy = node.y + node.height / 2;
        return { left: cx - halfWidth, right: cx + halfWidth, top: cy - halfHeight, bottom: cy + halfHeight };
    });

    const ordered = [...input.corridors].sort((a, b) =>
        b.thickness - a.thickness || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Built once, on first use: nothing needs it while outside labels are off,
    // and `placeFlowLabels` runs on every render including a cosmetic one.
    let bandMasks: BandMask[] | undefined;
    const masks = (): BandMask[] => (bandMasks ??= bandMasksOf(input.corridors));

    const placed: FlowLabelPlacement[] = [];
    ordered.forEach(corridor => {
        const mid = midpointOf(corridor.spine);
        if (!mid) {
            return;
        }
        const figure = figureOf(corridor, input.content, diagramTotal,
            outflow.get(corridor.source) ?? 0);
        const text = figure.percent
            ? formatPercent(figure.value)
            : formatTotal(figure.value, input.labels);
        if (text === "") {
            return;
        }
        const width = measure(text);
        const box: Box = {
            left: mid.at.x - width / 2,
            right: mid.at.x + width / 2,
            top: mid.at.y - height / 2,
            bottom: mid.at.y + height / 2
        };
        // Inside always wins, and is tried on exactly the same terms whether or not outside
        // labels are on. Outside is the fallback for the two ways inside can fail (the text does
        // not fit the ribbon, or it does but lands on something), because to a reader those
        // are the same complaint: this flow has no figure on it.
        const insideFits = boxFitsRibbon(width, height, corridor.thickness / 2, mid.direction)
            && !taken.some(other => overlaps(box, other));
        if (insideFits) {
            taken.push(box);
            placed.push({
                corridorId: corridor.id,
                text,
                x: mid.at.x,
                // The baseline, from the box's centre: the same ascent and descent split layout
                // measures a node's label with.
                y: mid.at.y + (TEXT_ASCENT - TEXT_DESCENT) / 2 * input.fontSize,
                width,
                height,
                over: corridor.colour
            });
            return;
        }
        if (!input.outsideLabels || !input.chromeBox) {
            return;
        }
        const out = placeOutside(mid, width, height, corridor.thickness / 2,
            input.fontSize, taken, input.chromeBox, masks());
        if (!out) {
            return;
        }
        taken.push(out.box);
        placed.push({
            corridorId: corridor.id,
            text,
            x: out.at.x,
            y: out.at.y + (TEXT_ASCENT - TEXT_DESCENT) / 2 * input.fontSize,
            width,
            height,
            // Not over a band any more, so render falls back to the theme ink.
            over: undefined,
            // From the label's own edge rather than its centre, so the line
            // does not run under the text it belongs to.
            leader: { from: edgeOfBox(out.box, mid.at, out.at), to: mid.at }
        });
    });
    return placed;
}
