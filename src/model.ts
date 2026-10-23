/**
 * Shared types for the SankeyBI pipeline.
 *
 * Data flows through these shapes in order: `FlowRow` (parsed) -> `Corridor` (flows grouped
 * per source and target) -> `PositionedNode` and `LayoutResult` (laid out) -> `RoutedBand`
 * (ready to paint).
 */

export interface Point {
    x: number;
    y: number;
}

/** One parsed row from the bound data. */
export interface FlowRow {
    /**
     * This flow's index into the data view's parallel columns, and the only thread back to data
     * Power BI can address. Selection ids are built with `withCategory(categories[0], rowIndex)`,
     * and an inbound highlight arrives as an array indexed the same way, so cross-filtering,
     * cross-highlighting and the context menu all depend on it surviving parsing.
     *
     * It is not an author-supplied identifier. Rows skipped by validation never become a
     * `FlowRow`, so indices are sparse with respect to the data view: never derive one by
     * counting flows.
     */
    rowIndex: number;
    source: string;
    target: string;
    value: number;
    flowType?: string;
    flowColour?: string;
    flowDisplayOrder?: number;
    /**
     * Where a node sits among the others at its stage, lowest first, or which group it belongs
     * to with no opinion about where.
     *
     * A number ranks. It is relative, not a coordinate: it says who comes before whom, so the
     * places handed out are still 1..n with no gaps, and a diagram numbered 10, 20, 30 is drawn
     * exactly like one numbered 1, 2, 3. Equal values mean "keep these together".
     *
     * A string is a category: every node carrying it forms one closed group, which the
     * arrangement places and orders internally as it sees fit. One category value does this in
     * every stage it appears in, which numbers cannot do, since a rank has to be chosen per
     * stage. Categories are lowercased and trimmed by the parse so a stray capital cannot split a
     * group.
     *
     * Blank means the arrangement decides. Node-level like the label, so the first non-blank wins
     * and a clash warns. Because it is relative, `transpose.ts` has nothing to do to it: an order
     * has no axis to swap.
     */
    sourceOrder?: number | string;
    targetOrder?: number | string;
    sourcePort?: Port;
    targetPort?: Port;
    /** Per-node icon (a vetted SVG data URL, see background.ts); node-level, like the label. */
    sourceIcon?: string;
    targetIcon?: string;
}

/** Which figure a node's total reports. */
export type TotalBasis = "Larger" | "Outflow" | "Inflow";

/**
 * The font the visual draws its text in, matching `.sankeybi-root` in style/visual.less.
 * Measuring with a different family from the one the browser renders with makes real text
 * measurement worse than an estimate, so the two must be changed together.
 */
export const DEFAULT_FONT_FAMILY = "\"Segoe UI\", sans-serif";

/**
 * The default text sizes. They are the defaults of the font controls, so an untouched report
 * is drawn at these.
 */
export const DEFAULT_LABEL_SIZE = 11;

export const DEFAULT_TOTAL_SIZE = 9;

export const DEFAULT_LEGEND_SIZE = 11;

/** A flow's own label: smaller than a node's, because it has to fit inside a band. */
export const DEFAULT_FLOW_LABEL_SIZE = 9;

/**
 * Does this node's inflow disagree with its outflow?
 *
 * Only an intermediate node can be unbalanced: a pure source has no inflow and a pure sink no
 * outflow, so neither can ever agree and flagging them would flag half the diagram.
 *
 * The tolerance is a percentage of the node's own throughput rather than an absolute figure,
 * because diagrams are often drawn from printed totals, which are rounded and rarely balance
 * exactly.
 *
 * This is a decision about the data, so it lives here rather than in render.ts, which paints
 * what it is told.
 */
export function isUnbalanced(
    node: { inflow: number; outflow: number },
    tolerancePercent: number
): boolean {
    if (node.inflow <= 0 || node.outflow <= 0) {
        return false;
    }
    const throughput = Math.max(node.inflow, node.outflow);
    return Math.abs(node.inflow - node.outflow) > throughput * Math.max(0, tolerancePercent) / 100;
}

/**
 * What a flow's own label states. A percentage is of the whole diagram or of the source node,
 * which are different questions: "4% of all the energy" against "40% of what leaves this
 * node".
 */
export type FlowLabelContent = "Value" | "PercentOfTotal" | "PercentOfSource";

/** One text element's font, as the author set it. */
export interface FontSpec {
    family: string;
    size: number;
    bold: boolean;
    italic: boolean;
}

/** The font a text element falls back to: what the visual always drew with. */
export function defaultFont(size: number): FontSpec {
    return { family: DEFAULT_FONT_FAMILY, size, bold: false, italic: false };
}

/**
 * How far a figure is scaled before it is drawn. Auto picks one unit for the whole diagram,
 * from its largest figure: per-label units would put "1.2M" beside "840K", which makes a
 * diagram hard to read.
 */
export type DisplayUnits = "Auto" | "None" | "Thousands" | "Millions" | "Billions" | "Trillions";

/**
 * Everything the label layer needs, read once from the Labels card. It lives here rather
 * than in render.ts because tooltips.ts formats the same numbers the same way: a node drawn
 * "255.0 TWh" must not tooltip as "255".
 */
export interface LabelOptions {
    /**
     * What each flow type is called, for the types the colour panel gives a label
     * (`flowTypeColours.ts`). Absent means every type uses its own name.
     *
     * It is carried here because `LabelOptions` already reaches both places a type's name becomes
     * text, the legend and the per-type tooltip breakdown, so the two cannot disagree about what a
     * type is called.
     */
    flowTypeLabels?: ReadonlyMap<string, string>;
    nodeTotals: boolean;
    basis: TotalBasis;
    units: string;
    decimalPlaces: number;
    /** The Value field's own format string, from the model. Absent where the field has none. */
    valueFormat?: string;
    /** The report's locale (`IVisualHost.locale`). Absent = the browser's. */
    locale?: string;
    /**
     * Absent means `None`. The setting itself defaults to `Auto`; the two are deliberately
     * different so a hand-built options object draws unscaled figures.
     */
    displayUnits?: DisplayUnits;
    /**
     * Follow the model's format string for decimal places, ignoring `decimalPlaces`. Absent
     * means false; the setting itself defaults to on.
     */
    autoDecimals?: boolean;
    /**
     * The formatter itself, injected (formatting.ts). The library it is built with is ESM-only,
     * so it cannot be imported by any module the checks load; this carries it in instead. Absent
     * falls back to `toLocaleString`.
     *
     * It is deliberately not what the geometry cache keys on: `geometryKey` stringifies `chrome`
     * whole and `JSON.stringify` drops functions, so the key sees the data this was built from
     * (the fields above) instead.
     */
    formatValue?: (value: number) => string;
    /**
     * How wide a string will actually be drawn, injected for the same reason as `formatValue`.
     * Absent falls back to the per-character estimate in layoutText.ts.
     *
     * The font is not a parameter: a measurer is built for one font and one weight (see
     * formatting.ts), and the size is passed because a name and a total are drawn at different
     * sizes.
     */
    measureText?: (text: string, fontSize: number, bold: boolean, family?: string) => number;
    /**
     * The font a node's name is drawn in. A geometry input: it decides how wide the label is,
     * which decides whether it fits inside its shape and how far it reaches, and the view fit
     * measures that reach.
     *
     * Absent means the default sizes.
     */
    font?: FontSpec;
    /**
     * A node's total: its own size and weight, the family following the name's. Two families
     * inside one label block reads as a mistake.
     */
    totalSize?: number;
    totalBold?: boolean;
    /**
     * The author's own label colour, where they chose one. Absent means decide automatically:
     * picked against the fill for a label inside a shape (`inkOn`), the theme's foreground
     * outside it.
     *
     * It is carried here so that layout's copy of the label options has it too.
     */
    colour?: string;
    /** Icon edge length in px. Optional so hand-built test options needn't carry it. */
    iconSize?: number;
    /** How an icon is coloured: as drawn, in its label's ink, or in its node's colour. */
    iconColour?: IconColour;
}

export type IconColour = "Original" | "Ink" | "Node";

/** A node in the graph. */
export interface GraphNode {
    id: string;
    /** Resolved display label; an empty string means "render no label". */
    label: string;
    column?: number;
    columnIsOverride: boolean;
    row?: number;
    rowIsOverride: boolean;
    /**
     * The author's declared place among the nodes at this node's stage, from
     * SourceOrder/TargetOrder; undefined where they said nothing. A constraint on the order, never
     * a coordinate: `graph.ts` sorts the stage's queue by it and `layeredModel.ts` holds it against
     * the search.
     *
     * The value is the group key, whichever kind it is: a number also ranks that group against the
     * others, a category does not and leaves it to float where its members' flows want it.
     */
    authoredOrder?: number | string;
    inflow: number;
    outflow: number;
    isSelfLoop: boolean;
    /**
     * Explicit fill, if any. Undefined means "no override": render.ts then falls back to the
     * Nodes card's colour, and that in turn to the theme.
     */
    colour?: string;
    /**
     * An icon drawn as part of the label: a vetted SVG data URL. Measured with the label, so it
     * moves inside or outside with it.
     */
    icon?: string;
    /**
     * Draw no total for this node. Set in the data stage together with the label it goes with,
     * so layout reserves nothing for it. Absent follows `labels.nodeTotals`.
     */
    hideTotal?: boolean;
}

export interface Graph {
    nodes: Map<string, GraphNode>;
}

/**
 * One flow type's contribution to a corridor. `flowType` undefined means the flow rows in
 * this segment did not bind FlowType at all; they are kept as their own segment rather than
 * merged into a real type, so single-colour corridors work unchanged when FlowType is unused.
 */
export interface CorridorSegment {
    flowType: string | undefined;
    value: number;
    /** First non-blank explicit FlowColour among this segment's flows, if any. */
    flowColourOverride?: string;
    /** First non-blank explicit FlowDisplayOrder among this segment's flows, if any. */
    displayOrder?: number;
    flows: FlowRow[];
}

/**
 * A connection surface on a node: which edge a corridor leaves or arrives on. By default
 * outgoing is East and incoming is West; the SourcePort and TargetPort columns override that
 * per corridor.
 */
export type Port = "North" | "South" | "East" | "West";

export const PORTS: readonly Port[] = ["North", "South", "East", "West"];

/**
 * A port's outward normal: the direction pointing away from the node through that edge, in
 * SVG coordinates (y grows downward). Routing uses this for both the straight stub direction
 * and the curve's tangent at that end, which lets one construction serve all 16
 * source/target port pairings instead of enumerating them.
 */
export const PORT_NORMALS: Record<Port, { x: number; y: number }> = {
    North: { x: 0, y: -1 },
    South: { x: 0, y: 1 },
    East: { x: 1, y: 0 },
    West: { x: -1, y: 0 }
};

/**
 * Which way a diagram reads when the data does not say. A port bound in the data, or set on a
 * node in the node editor, still wins; see `inferCorridors`.
 */
export type FlowDirection = "LeftToRight" | "RightToLeft" | "TopToBottom" | "BottomToTop";

/**
 * The ports a corridor falls back to, end by end, under each direction.
 *
 * The two reversed readings are the same pairs swapped; the work they need is in the
 * automatic grid, which counts its stages outward from the sources and so has to know which
 * end of the diagram that is. See `senseOf`.
 */
export const DEFAULT_PORTS: Record<FlowDirection, { out: Port; in: Port }> = {
    LeftToRight: { out: "East", in: "West" },
    RightToLeft: { out: "West", in: "East" },
    TopToBottom: { out: "South", in: "North" },
    BottomToTop: { out: "North", in: "South" }
};

/**
 * Which way the diagram reads: left to right, or top to bottom. Two passes need it and
 * neither owns it: `arrangeNodes` lays the stages out along it, and `computeLayout` scales
 * every band by the pitch the nodes pack across it. It lives here with the ports it is
 * derived from.
 */
export type FlowAxis = "horizontal" | "vertical";

/**
 * Which way along that axis the diagram travels: +1 where the stages ascend with the flow
 * (left to right, top to bottom), -1 where they descend (right to left, bottom to top).
 *
 * Read off the resolved ports exactly as `axisOf` is, so the automatic grid cannot disagree
 * with the ports the corridors actually use. A sense taken from the direction setting would be
 * wrong the moment the data binds its own ports.
 *
 * Counted per corridor end, like the axis. A source's port normal points the way the flow
 * leaves, so it votes as it stands; a target's points out of the target, against the arrival,
 * so it votes negated. An end facing across the stage axis has a zero component along it and
 * so abstains. Ties go forward.
 */
export type FlowSense = 1 | -1;

/** The port on the far side of the node. */
export const OPPOSITE_PORT: Record<Port, Port> = {
    North: "South",
    South: "North",
    East: "West",
    West: "East"
};

/**
 * What a node looks like. The rectangle routing anchors to is never painted: it is always
 * transparent, and exists only to be pointed at and to dim. The shape is pure paint: it never
 * moves an anchor, and routing knows nothing about it beyond how much room it leaves an
 * arrow.
 */
export type NodeShape = "None" | "Rectangle" | "Rounded" | "Circle";

/**
 * Where the gap between a node's arrows comes from.
 *
 * `NodeSize`: the arrows are fitted into whatever the size sliders leave, so the visible
 * break in the flow is the node's own extent less the head's depth. The gap then varies with
 * flow width (a fatter head eats more of a fixed node), and the tip angle can be clamped well
 * below what was asked for.
 *
 * `SetGap` makes the gap the quantity the author sets, with everything else derived. See
 * `arrowStemInset`.
 */
/**
 * The Node arrows card, as both layout and routing see it.
 *
 * It lives here rather than in routing so that layout and routing read one type and one set
 * of numbers: under `SetGap` the gap is a layout input, since a node has to be thick enough
 * along the flow to hold it.
 */
export interface ArrowOptions {
    heads: boolean;
    tails: boolean;
    /** The included angle at an arrow's tip, in degrees. */
    angleDegrees: number;
    /**
     * The gap, as a percentage of the pitch the nodes pack across (`packingPitch`), the one pitch
     * every band width is already scaled by. A horizontal node and a vertical one in the same
     * diagram therefore get the same number of pixels, whichever way the flow runs. A percentage
     * of the tighter pitch, or of each axis's own pitch, would not give that.
     */
    gapPercent?: number;
}

/**
 * Where a node shape's fill or border colour comes from. `Node` is the per-node colour (the
 * data's override, else the card default), which makes "white insides, border still the node's
 * own colour" a two-setting change rather than a per-node one.
 */
export type ShapePaint = "Node" | "Custom" | "Transparent" | "Background";

/** One inferred corridor: all the flows between a source and a target. */
export interface Corridor {
    id: string;
    source: string;
    target: string;
    value: number;
    isSelfLoop: boolean;
    flows: FlowRow[];
    /** Per-flow-type segments, stacked within the corridor's packed anchor slot. */
    segments: CorridorSegment[];
    /**
     * Resolved ports for this corridor's two ends. Corridor-level, not node-level: two corridors
     * leaving the same node can legitimately use different ports. The first non-blank value wins
     * across the corridor's own flows.
     */
    sourcePort: Port;
    targetPort: Port;
}

/** A node with its pixel position and size, once the logical grid has been mapped to pixels. */
export interface PositionedNode extends GraphNode {
    x: number;
    y: number;
    height: number;
    width: number;
    /**
     * Which way this node's flow is heading: the port carrying the most outgoing value, or, for a
     * node with no outflow at all, the far side of the port carrying the most incoming value (so a
     * sink fed from the West still points East rather than back at its own supply). Decided here
     * rather than in render.ts, which stays free of geometry decisions.
     */
    flowDirection: Port;
    /**
     * Which face the node's label sits against: its emptiest, so the text lands where no
     * corridor is competing for the space.
     *
     * Decided in layout rather than in render because the left and right label reserves have to
     * be held back before any node is positioned, and they are only needed if some node on the
     * outermost column actually wants its label there. Working it out twice would let the reserve
     * and the drawing disagree.
     */
    labelPort: Port;
    /**
     * The node shape's painted size, or 0 x 0 when there is no shape. Width and height are
     * separate only because "fit to label" grows the width; without it they are equal and the
     * shape is square.
     */
    shapeWidth: number;
    shapeHeight: number;
    /**
     * Whether the label is drawn inside the shape rather than against `labelPort`. Layout decides
     * it from the room the container has; routing then narrows it, because arrow heads and tails
     * eat into that room.
     */
    labelInside: boolean;
    /**
     * The name's drawn lines, as layout broke them.
     *
     * They are handed over rather than re-derived: the wrap budget comes from the viewport, render
     * has no viewport, and a render that re-measured could draw a different number of lines from
     * the ones the view fit measured. One entry unless the name wrapped; none when it is
     * suppressed.
     */
    nameLines: { text: string; width: number }[];
    /**
     * How much room the label block needs, as layout measured it. Carried on the node so routing
     * can re-test the fit against what the arrows left, rather than measuring the text a second
     * time.
     */
    labelBoxWidth: number;
    labelBoxHeight: number;
    /**
     * How far what is drawn for the node (its shape and outside label) reaches past its rectangle
     * on each side, in pixels, never negative. The fit measures the same reach, and Lock grid
     * holds a dragged node's whole reach inside the frame with it. Absent means the rectangle
     * alone.
     */
    drawnReach?: { left: number; right: number; up: number; down: number };
    /**
     * An inside label is always centred on its container. Shifting it into the room an arrow head
     * leaves would buy space, but an off-centre label reads as a mistake.
     */
}

/** A rectangle in pixels. */
export interface PixelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface LayoutResult {
    /**
     * The chrome box: the viewport less margin, title, legend and headers, with no reserve and no
     * letterbox. A locked frame fills it, or, with a background, the largest rectangle of the
     * picture's aspect inside it.
     */
    chromeBox: PixelRect;
    /**
     * Where the background picture is drawn: the locked frame's rectangle. Present only with a
     * background set and the grid locked.
     */
    backdrop?: PixelRect;
    nodes: Map<string, PositionedNode>;
    corridors: Corridor[];
    valueToPixels: (value: number) => number;
    /**
     * The busiest node's throughput, in the data's own units: the reference one full node
     * thickness means when Fixed flow baseline is off.
     *
     * Reported so the Flows card can show it beside Baseline value: an author setting an absolute
     * baseline has to know the magnitude they are setting it against, and it changes with every
     * slicer selection. It is an output, not an input, so it is not part of `geometryKey`;
     * `flowBaselineValue` is the input and is already covered by `LayoutChrome`.
     */
    autoBaseline: number;
    /**
     * Pixels per logical column and row. Routing geometry that is not a corridor's own packed
     * width (stub lengths, self-loop bulge and so on) sizes itself as a fraction of these rather
     * than using standalone pixel constants, so it stays proportionate to the diagram's density.
     */
    columnGap: number;
    rowPitch: number;
    /**
     * The pitch the nodes pack across: the row pitch on a left-to-right diagram, the column gap
     * on a top-to-bottom one. It is the pitch `valueToPixels` is built from, and so the one scale
     * the whole diagram shares. Carried here because routing needs it for the arrow gap and
     * should not re-derive which axis the diagram packs across.
     */
    packingPitch: number;
    /**
     * How far apart two corridors packed on one face are held, in pixels
     * (`flowSeparationPixels`, resolved against `packingPitch`).
     *
     * Carried here rather than read from settings twice: layout sizes each node's faces to hold
     * these gaps and routing's `packPort` lays the slots out with them, and the two must use one
     * number. A node sized by one formula and packed by another would taper its bands.
     *
     * Absent means 0.
     */
    flowSeparation?: number;
    /**
     * Pixel y where the diagram's own content begins: below the title, the legend band and any
     * column-header band layout reserved. render.ts hangs the column headers off this rather than
     * recomputing the same stack of reserves.
     */
    contentTop: number;
    /**
     * Pixel x of the leftmost column, the other half of the grid's origin. Dragging needs both to
     * convert a dropped pixel back into a logical column and row (see gridPositionOf).
     */
    contentLeft: number;
    /**
     * The logical column and row that sit at (contentLeft, contentTop).
     *
     * Fitted to the content: a quarter of a pitch outside the outermost node's drawn edge
     * (`FIT_MARGIN`), so usually fractional. With Lock grid on, the stored window's low corner
     * instead.
     */
    originColumn: number;
    originRow: number;
    /**
     * Which way each axis's grid coordinate runs on screen: +1 ascending (column 1 at the left,
     * row 1 at the top), -1 descending.
     *
     * Only the stage axis is ever -1, and only where the resolved ports read backwards along it:
     * Right to left, or Bottom to top. Everything above the mapping works in flow order, where
     * stage 1 is the first stage; this is the one thing that knows which end of the screen that
     * is drawn at. `pixelPositionOf` and `gridPositionOf` stay exact inverses through it, which
     * leaves every drag, snap and lock path unchanged.
     */
    columnSign: 1 | -1;
    rowSign: 1 | -1;
    /** What the drawing area shows, in grid units. A locked drag is held inside it. */
    window: GridWindow;
    /**
     * The same widened to the whole chrome box (the viewport less its margin, title, legend and
     * headers), with the label and overflow reserves folded in as grid extent. Lock grid stores
     * this: mapped back onto that box with nothing reserved, it reproduces the drawing exactly.
     * Under the lock it equals `window`.
     */
    frame: GridWindow;
    /**
     * What is drawn, in grid units: every node's drawn box and outside label, and the flows where
     * they were passed in. The fit puts a quarter of a pitch between this and `window` on every
     * side.
     */
    content: GridWindow;
    /** The same without the flows: nodes and their labels only. */
    nodeContent: GridWindow;
}

/**
 * A rectangle of the grid, in grid units: the columns and rows that map onto the drawing
 * area's edges. A single-column diagram has no column extent (`columnLo === columnHi`).
 */
export interface GridWindow {
    columnLo: number;
    columnHi: number;
    rowLo: number;
    rowHi: number;
}

/**
 * One routed flow-type segment: a ready-to-paint SVG path, already offset into a
 * constant-width band (or, for a self-loop, an open stroked path; see routing.ts). render.ts
 * just colours and paints these; it does no geometry of its own.
 */
export interface RoutedBand {
    corridorId: string;
    source: string;
    target: string;
    flowType: string | undefined;
    value: number;
    path: string;
    /**
     * The two long edges, capped only where no arrow continues the flow. Stroke this, not `path`:
     * a band runs node to node, so the closed path's two closing moves are caps sitting on a node
     * face, and stroking one where an arrow grows out of that face draws a line across the flow at
     * the join. Where the arrow is switched off the flow does end there, and the cap comes back.
     * See `openEdgesFromEdges`.
     */
    edges: string;
    /**
     * Informational only: self-loops route through the same machinery as every other corridor.
     */
    isSelfLoop: boolean;
    /**
     * Axis-aligned extent of this band's geometry. A wrap route deliberately travels outside its
     * nodes' bounds, so the diagram can only tell whether it fits the viewport after routing:
     * visual.ts unions these and, if anything spills, reserves the overflow and lays out again.
     */
    bounds: Bounds;
    /**
     * The two port anchors this band runs between, in travel order. Only the Gradient colour mode
     * uses them: it blends along the band's direction of travel, which needs the corridor's own
     * axis rather than its bounding box, since a band that doubles back has a bounding box that
     * says nothing about which way it flows.
     */
    start: Point;
    end: Point;
    /**
     * How thick this stripe is drawn, in pixels; the same at both ends, since packing sizes a
     * slot from the corridor's value and a node is sized to hold that slot without squeezing it.
     *
     * Render needs it to decide whether a band is too thin to point at: a band is its own hit
     * area, so below a few pixels it needs an invisible halo laid over it, exactly as a collapsed
     * node needs a hit rectangle. Excludes STRIPE_BLEED, which is overlap to close a seam and not
     * width the flow is entitled to.
     */
    width: number;
    /**
     * This stripe drawn at a fraction of its width, measured from its low edge: the sub-band an
     * inbound partial highlight is shown with. `partialPath(0.2)` is the first fifth of the
     * stripe, and `partialPath(1)` is `path` itself.
     *
     * It is a function because the fraction is data (`highlights[i] / values[i]`), so it changes
     * with whatever another visual has highlighted and there is nothing to precompute it from at
     * routing time.
     *
     * It is routing's own edge builder, handed out rather than reproduced. Nothing downstream
     * re-derives what routing gives it, and a sub-band is band geometry: interpolating between
     * two edges in render would be a drift hazard. This closes over the same `edgeFor` the real
     * edges came from, so a sub-band and its parent cannot disagree.
     *
     * Optional: the synthetic checks build `RoutedBand` literals by hand, and a band without it
     * simply shows no sub-band.
     */
    partialPath?: (fraction: number) => string;
}

export interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface ParseResult {
    flows: FlowRow[];
    warnings: string[];
}
