/**
 * The routing styles, which of them behave alike, and each style's default lead-in.
 */

/**
 * The default lead-in per style, as a fraction of that axis's grid pitch. Polyline leaves its
 * face along the normal for a quarter of a pitch, which is also the limit Arrange flows keeps
 * it to. The other three start at zero; Orthogonal and Octilinear are held off the face only
 * by the hard stop (`bandReach + MIN_PERPENDICULAR_RUN`), and Smooth has no stop, its arcs
 * sizing themselves to the room there is.
 *
 * A lead the author drags is absolute and replaces this for that end.
 */
export const DEFAULT_LEAD_FRACTION: Record<RoutingStyle, number> = {
    Polyline: 0.25,
    Smooth: 0,
    Octilinear: 0,
    Orthogonal: 0
};

/**
 * How a route is drawn.
 *
 * - `Polyline` (the default): Orthogonal with one diagonal in place of each right-angle step.
 * - `Orthogonal`: right angles throughout.
 * - `Smooth`: Polyline with its joins drawn as circular arcs.
 * - `Octilinear`: Polyline with every diagonal at 45 degrees.
 *
 * Every route is squared off where it wraps, in every style: a curve through the clearing
 * lane would cut the node the lane exists to miss.
 */
export type RoutingStyle = "Smooth" | "Orthogonal" | "Polyline" | "Octilinear";

/**
 * Octilinear behaves as Polyline in everything but its diagonal angles. This is the one test
 * for "behaves as Polyline", so a new special case cannot forget it.
 */
export function polylineFamily(style: RoutingStyle): boolean {
    return style === "Polyline" || style === "Octilinear";
}

/** The angle step Octilinear keeps its diagonals to, in degrees. */
export const OCTILINEAR_STEP = 45;

/**
 * Maps a stored style name onto a current one. Anything unrecognised gets the default,
 * Polyline.
 */
export function normaliseStyle(value: string | undefined): RoutingStyle {
    if (value === "Orthogonal" || value === "Polyline" || value === "Smooth" || value === "Octilinear") {
        return value;
    }
    if (value === "Biarc" || value === "Supersmooth" || value === "Hybrid") {
        return "Smooth";
    }
    return "Polyline";
}
