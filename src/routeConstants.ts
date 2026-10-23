/**
 * Tuning constants shared by the routing modules.
 */

import { RoutingOptions } from "./routeTypes";

/**
 * How far outside a node a wrap route's lane sits, as a fraction of the tighter of the two
 * grid pitches. It is deliberately isotropic and tied to the smaller pitch: scaling each axis
 * by its own pitch would make wraps stretch very wide in a sparse column layout, reaching over
 * half way to the neighbouring column, when all a wrap needs is to clear its own node by a
 * locally sensible margin.
 */
export const CLEARANCE_FRACTION = 0.35;

/**
 * The sliver of straight run a squared-off route keeps beyond the band's own half-width, so
 * its inner edge has somewhere to leave the port face perpendicular. A pixel: enough that the
 * segment has a direction at all, which a zero-length one has not, and small enough to be
 * invisible.
 */
export const MIN_PERPENDICULAR_RUN = 1;

/**
 * How much of the band's half-width a wrap's corner needs to draw cleanly. At 1.0 the inner
 * arc is a sliver and the edge collapses; at 1.5 the band keeps a constant width at every
 * Curvature, and higher changes nothing. It bounds a wrap's lead-in, since the corner cannot
 * be rounder than the run it sits on.
 */
export const CLEAN_CORNER_REACH = 1.5;

/**
 * Where Smooth's Curvature slider starts. 0 on the slider asks for this much of the biggest
 * radius the geometry allows, 100 for all of it; see the remap in `biarcJoinWithStraight`.
 */
export const SMOOTH_CURVATURE_FLOOR = 0.65;

/** Default corner radius for quarter turns, as a fraction of the tighter grid pitch. */
const CURVATURE_FRACTION = 0.35;

export const FALLBACK_COLUMN_GAP = 80;

export const FALLBACK_ROW_PITCH = 60;

export const BAND_SAMPLES = 20;

export const LINE_SAMPLES = 2;

/**
 * How close to a straight run's ends Smooth's extra "shoulder" samples sit, in pixels and as a
 * fraction of the run, whichever is smaller. Close enough that the spline's tangent there is
 * the run's own direction; far enough apart to stay numerically sane on a short run.
 */
export const SHOULDER_LENGTH = 3;

export const SHOULDER_FRACTION = 0.2;

export const STUB_SAMPLES = 3;

export const MIN_PULL = 1;

/** Below this, a dot product counts as "no useful progress in that direction". */
export const PROGRESS_EPSILON = 0.5;

/** Below this a segment has no usable direction, so it cannot contribute a normal. */
export const DEGENERATE_LENGTH = 1e-6;

/** How far a mitred corner may overshoot before it is bevelled instead (SVG's default). */
export const MITER_LIMIT = 4;

/**
 * The closest two consecutive points on a band edge may sit before the spline fit, in
 * pixels. A tight arc's inner edge gets as many samples as its outer one in a fraction of the
 * length, and near-coincident points make the fit wobble, which shows as a faint line along
 * the edge. See `thinEdge`.
 */
export const EDGE_MIN_STEP = 0.5;

/**
 * A turn sharper than this between consecutive (thinned) edge points is a genuine corner (an
 * inner arc that collapsed), and the spline is broken there. A well-sampled arc turns a few
 * degrees a step.
 */
export const EDGE_CORNER_DEGREES = 30;

/** Standard cubic-Bezier approximation of a quarter circle: 4/3 * (sqrt(2) - 1). */
export const CORNER_ARC_KAPPA = 0.5522847498;

/**
 * Barycentric refinement rounds for anchor ordering. Each round is only kept if it crosses
 * strictly less, so this is a ceiling on work rather than a target; a settled diagram stops
 * after one.
 */
export const ORDERING_PASSES = 4;

/**
 * Node avoidance: how far outside a blocking node the detour lane runs, as a fraction of the
 * tighter grid pitch. It is on top of the band's own half-width, which has to be in there or
 * the centreline dodges neatly while the ribbon's edges still clip the node.
 */
export const AVOID_MARGIN_FRACTION = 0.12;

/**
 * Each attempt pushes the lane further out. A smooth route can bow outside its own waypoints,
 * so the first, tightest detour sometimes still clips; escalating gives the curve room rather
 * than declaring failure.
 */
export const AVOID_PASSES = 3;

export const AVOID_ESCALATION = 1.7;

/**
 * Past this many obstacles on one corridor the layout is too dense for a detour to help, and
 * threading between them all would produce something worse than the straight line. Bail and
 * leave the route alone.
 */
export const MAX_OBSTACLES = 4;

export const DEFAULT_ROUTING: RoutingOptions = {
    curvaturePercent: CURVATURE_FRACTION * 100,
    style: "Polyline",
    avoidNodes: true
};

/**
 * How close two segments' angles must be to count as parallel, in degrees, so that key 2
 * decides between them.
 *
 * It is a number, not an epsilon: nothing an author places by hand is ever parallel to within
 * floating-point error, so an epsilon would never let the line's position have a say. A few
 * degrees is the range in which real routes sharing a face are close enough to be treated as
 * parallel; hand-placed parallel routes are far closer.
 */
const PARALLEL_DEGREES = 5;

export const PARALLEL_RADIANS = PARALLEL_DEGREES * Math.PI / 180;

/**
 * How far a painted stripe reaches past its own edge, in pixels, so that neighbours overlap
 * instead of meeting exactly.
 *
 * SVG anti-aliases each path on its own, so two shapes sharing an edge each cover about half
 * the boundary pixel and whatever is behind shows through the difference: the node shape where
 * there is one, the report page where there is not. It shows between a corridor's flow-type
 * stripes, between an arrow's stripes, and where a band meets the arrow continuing it.
 *
 * It is applied to the high edge only, and never to the last stripe of a stack. Stripes are
 * painted low to high, so the later one wins the overlap and the apparent boundary is its low
 * edge, which stays exactly where the flow puts it. Every stripe therefore keeps its true
 * width and the stack keeps its true extent. A symmetric bleed would leave the last stripe 2 x
 * this wider than it should be, which for a stripe at MIN_CORRIDOR_WIDTH is a large relative
 * error, and a Sankey has to be honest about small flows.
 *
 * It is grown geometry rather than a stroke. Stroking each path in its own fill closes the
 * seams too, but leaves visible bumps where a join turns sharply, and a linejoin has no
 * business deciding how thick a band is.
 */
export const STRIPE_BLEED = 0.35;

/**
 * How far an arrow's base reaches back past the container face, over the end of the band it
 * continues, in pixels.
 *
 * It is separate from STRIPE_BLEED because this overlap costs no proportions: it runs along
 * the flow, so no stripe gets wider. A sub-pixel overlap only closes the anti-aliasing seam
 * when the face happens to land well on the pixel grid; a full pixel covers it wherever the
 * face lands, and intermediate values let the seam come back, so this is a floor to keep. The
 * cost is a 1px strip where two translucent layers stack when Flow transparency is above 0.
 *
 * Render grows the shape clip by this same amount; clipping to the outline alone would cut the
 * overlap off again.
 */
export const ARROW_BASE_BLEED = 1;

/** Gap between two staggered lanes, as a fraction of the tighter grid pitch. */
export const LANE_GAP_FRACTION = 0.04;

/**
 * Lead lengths tried when reshaping a curve off an obstacle, as fractions of the lead cap, and
 * swept as a full cross product of the two ends.
 *
 * Zero is in the list and the pairs are asymmetric on purpose: the only clearing combination
 * for some obstructed shapes is a near-zero lead at one end against a long one at the other,
 * which a symmetric search, or one that never tried zero, would miss and hand the case to the
 * detour instead.
 */
export const LEAD_FRACTIONS = [0, 0.2, 0.45, 0.7, 1];
