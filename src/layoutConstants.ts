/**
 * Layout constants: the grid-to-pixel conversion, node-size floors, the view fit and the
 * reserved space around the diagram.
 *
 * Everything upstream of layout stays in logical (column, row) space; pixels appear only when
 * layout converts the grid.
 */

export const MARGIN = 24;

/**
 * The thinnest a corridor is ever drawn, in pixels before Flow width scales it. A Sankey has
 * to show a small flow as small, but below a pixel or two it stops being a band at all and
 * becomes an artefact of anti-aliasing, so tiny flows are lifted to this.
 *
 * It is the one place a corridor's width stops being proportional, so a node has to be sized
 * from the widths its corridors are actually drawn at, not from the sum of their values; see
 * `sizeNodes`. Sizing a node from the sum would hand the floor out per corridor and pay for it
 * once, and the packing would then scale a whole face down to fit, squeezing the small bands
 * and taking width off the big one they share a node with.
 *
 * The floor is 1px because a node is sized from what it packs, so whatever the floor lifts is
 * paid for in node thickness: a node drawn fatter than the flow through it, which is the one
 * thing a Sankey must not do. Larger floors measurably pad the node extent, and put a large
 * share of corridors on the floor.
 *
 * What makes 1px safe is that a band does not have to be its own hit area: below
 * `MIN_BAND_HIT` render lays an invisible halo over the corridor, the way a collapsed node gets
 * a hit rectangle.
 */
export const MIN_CORRIDOR_WIDTH = 1;

/**
 * A floor on the reference extent the value->pixels scale is built from, so a diagram squeezed
 * into a tiny tile still has a scale to speak of rather than one collapsing toward zero.
 * Nothing to do with how thin a corridor may be drawn (MIN_CORRIDOR_WIDTH) or how small a node
 * may be (the two sliders).
 */
export const MIN_BASE_BAR_EXTENT = 4;

/**
 * How much of the packing pitch the busiest node takes: the one number the whole diagram's
 * thickness is built from. At 0.7 the heaviest node fills seven tenths of the pitch it stacks
 * along, leaving three for the gap between it and its neighbour.
 */
export const PACKING_FRACTION = 0.7;

/**
 * Floors on the node's two axes: width as a percentage of the column gap, height of the row
 * pitch; each follows its own axis's pitch. A node is otherwise sized by the flow it carries:
 * its height is what its East/West ports have to pack, its width what its North/South ports
 * do. These say how small it may get on each axis when the flow alone would leave it thinner.
 *
 * They name the axis outright rather than a thickness across the flow, which would land on
 * width for an East/West node and on height for a North/South one, so that two sliders could
 * move the same edge and the larger silently win.
 *
 * They are pitch-relative rather than pixel constants, like every other piece of geometry here:
 * a fixed pixel size looks right at one column spacing and wrong at the next. Being a fraction
 * of the gap, the floor falls as columns are added.
 *
 * Minimum height defaults to 3% of the row pitch. It only lifts nodes whose East/West flow is
 * a sliver, mainly North/South-only nodes, which would otherwise have no height at all; a
 * corridor packed on such a face sits centred on it, as a lone corridor always does.
 *
 * Zero on both is a real, supported value: the node collapses and its flows run straight into
 * each other. That is safe because a floor is never the packing extent on an axis that carries
 * demand; that axis is sized by the flow.
 */
export const DEFAULT_NODE_MIN_WIDTH_PERCENT = 3;

export const DEFAULT_NODE_MIN_HEIGHT_PERCENT = 3;

/**
 * A rounded rectangle's corner radius, as a fraction of its shorter side. It is proportional,
 * so a big card and a small one read as the same shape rather than as the same corner in
 * different frames.
 *
 * render.ts sets `rx` from this same constant. Change them together.
 */
export const SHAPE_CORNER_RATIO = 0.18;

/**
 * The margin the fit leaves at each end of each axis, as a fraction of that axis's pitch. The
 * outermost nodes' drawn edges sit this far inside the drawing area. Wrap routes and outside
 * labels that reach further are caught by the overflow pass in visual.ts.
 */
export const FIT_MARGIN = 0.25;

/** Bisection steps in the fit: the pitch to within 2^-50 of the frame. */
export const FIT_BISECTIONS = 50;

/** Rounds of solving each axis given the other. The coupling is weak; two settle it. */
export const FIT_ROUNDS = 2;

/**
 * The least column gap the fit accepts, as a fraction of the widest drawn node, before it
 * stops growing the row pitch (see `capRows`). Loose on purpose: a portrait frame holding wide
 * nodes can fill with nodes much wider than their gap, and overlapping wide nodes are then the
 * author's layout, not the fit's doing. A ratio of 1 letterboxes such a diagram badly; a third
 * leaves ordinary diagrams alone and still stops a single-row North/South chain drawing one
 * node wider than the frame.
 */
export const COLUMN_CAP_RATIO = 1 / 3;

/** How far, in grid units, content must reach past a locked window before it widens it. */
export const LOCK_TOLERANCE = 1e-6;

// The legend's reserved space. A single horizontal row for Top/Bottom, a stacked vertical
// list for Left/Right. Exported so render.ts draws the legend inside exactly the band reserved
// here.
export const LEGEND_BAND_HEIGHT = 24;

export const LEGEND_BAND_WIDTH = 130;

export type LegendPosition = "Top" | "Bottom" | "Left" | "Right";

/**
 * Extra space to hold back on each side, over and above the standard margins. A wrap route
 * travels outside its nodes' bounds, and how far is not known until routing has run, so
 * visual.ts routes once, measures anything that spilled past the viewport, and lays out again
 * reserving that much.
 */
export interface EdgeReserve {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

export const NO_RESERVE: EdgeReserve = { top: 0, right: 0, bottom: 0, left: 0 };
