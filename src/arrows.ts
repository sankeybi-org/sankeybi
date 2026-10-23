import { ArrowOptions } from "./model";

/**
 * Depth of an arrow whose base is `halfExtent` from its centre, at the set tip angle. The
 * angle is one number for the whole diagram, so the depth is derived rather than set and
 * every arrowhead has identical proportions however much value it carries.
 *
 * 90 degrees gives a 45-degree taper (depth == halfExtent); smaller is sharper and deeper.
 * The angle is clamped well away from 0 and 180, where the tangent sends the depth to
 * infinity or collapses it to nothing.
 *
 * It lives here rather than in routing because layout needs it too: a node (or its shape) has
 * to be grown deep enough to hold head and tail at the set angle, and that has to be the same
 * number routing then draws to.
 */
export function arrowDepth(halfExtent: number, angleDegrees: number): number {
    const angle = Math.max(10, Math.min(170, angleDegrees));
    return halfExtent / Math.tan((angle * Math.PI / 180) / 2);
}

/**
 * Depth per unit of half-extent at one angle: the reciprocal of the tangent above, for the
 * layout fit alone. The angle is one number for the whole diagram, but depths are wanted per
 * node per face per trial pitch, which would put a very large number of `Math.tan` calls
 * inside the fit's bisection.
 *
 * Deliberately not used by `arrowDepth`. Multiplying by a reciprocal differs from dividing in
 * the last bit, and `arrowDepth` sets the geometry that is drawn. Here it feeds only the
 * node-size floor, where a last-bit difference is absorbed.
 */
export function arrowDepthFactor(angleDegrees: number): number {
    const angle = Math.max(10, Math.min(170, angleDegrees));
    return 1 / Math.tan((angle * Math.PI / 180) / 2);
}

export const NO_ARROWS: ArrowOptions = {
    heads: false, tails: false, angleDegrees: 90, gapPercent: 0
};

/**
 * The gap between a node's arrows, in pixels: one number for the whole diagram.
 *
 * The author sets the gap and everything else is derived from it: layout floors the node
 * along the flow to hold it, and routing places the apex against it.
 *
 * Arrows that are off cost nothing: with no heads and no tails every face depth is 0, and
 * `arrowExtentFloor` returns 0 on a `deepest` of 0 rather than `2 x deepest`.
 */
export function arrowGapPixels(arrows: ArrowOptions, packingPitch: number): number {
    return packingPitch * Math.max(0, arrows.gapPercent ?? 0) / 100;
}

/**
 * The gap held between two corridors packed side by side on one node face, in pixels.
 *
 * It is a percentage of the pitch the nodes pack across, for the reason
 * `ArrowOptions.gapPercent` is: that is the single pitch every band width is already scaled
 * by, so a face that packs down the rows and a face that packs across the columns, in the
 * same diagram, are separated by the same number of pixels. It also rescales with the
 * viewport, where a raw pixel count would grow visually as the tile shrank.
 *
 * It never takes width from a flow. Every corridor is still drawn at exactly
 * `valueToPixels(value)`; the gaps are added to the stack the node is sized from, so the node
 * grows by `(n - 1) x separation` on that face and the bands leave already apart. Painting a
 * border would make a flow look wider than the value it reports, and masking one out could
 * only take the gap from whatever is drawn underneath.
 *
 * Absent or zero means no gap: nothing is added to any stack.
 */
export function flowSeparationPixels(percent: number | undefined, packingPitch: number): number {
    return packingPitch * Math.max(0, percent ?? 0) / 100;
}

/**
 * How many gaps sit inside one corridor: one between each pair of stripes it actually draws,
 * so `k - 1` for `k` drawn stripes and 0 for a plain band.
 *
 * The same number is read in four places (`packPort` and `stackOf` to make room for the gaps,
 * `routeCorridor` and `buildNodeInfill` to lay them out), and any disagreement between them
 * would taper a band. So it is counted once, here, beside the pixels it is multiplied by.
 *
 * A zero-value stripe is not counted, because it is not drawn: a flow type a scenario does not
 * have would otherwise claim a gap on each side and read as one double-width gap in the
 * middle of a band.
 */
export function stripeGapCount(corridor: { segments: readonly { value: number }[] }): number {
    let drawn = 0;
    for (let i = 0; i < corridor.segments.length; i++) {
        if (corridor.segments[i].value > 0) {
            drawn++;
        }
    }
    return Math.max(0, drawn - 1);
}

/**
 * What the two facing arrows cost the clearance between them, and how deep the deeper of them
 * is. One axis of one node; faces that carry nothing are left out.
 *
 * Every arrow in a diagram shares one tip angle, so every taper has the same slope
 * `k = depth / halfWidth`. A head reaches deepest on the centre line and shallowest at its
 * base corners; a tail is the other way up, its notch vertex on the centre line and its wings
 * furthest in. So along the face the two boundaries are straight lines, and the clearance
 * between them is whatever the node has left after both stems and this:
 *
 *   on the centre line, a head costs its depth and a tail costs nothing;
 *   at the shared edge, a tail costs `m` and a head costs `depth - m`,
 *
 * where `m` is the shallower arrow's depth, as far out as both runs still exist. The loss is
 * the worse of the two ends, since both are linear in the offset and so cannot peak in
 * between. `deepest` is simply the largest of the four and is left to the caller.
 *
 * The arguments are four numbers rather than a list of faces because this runs per node per
 * trial pitch inside the fit's bisection, where allocating arrays and objects per call would
 * cost more than the arithmetic.
 *
 * For the ordinary head-against-tail node the two lines are parallel, so the clearance is the
 * same all the way across the face. A head facing a head, or a tail facing a tail, genuinely
 * narrows towards one end, and then this is the narrowest it gets.
 */
export function arrowClearanceLoss(
    headA: number, tailA: number, headB: number, tailB: number
): number {
    const a = Math.max(headA, tailA);
    const b = Math.max(headB, tailB);
    if (a <= 0 && b <= 0) {
        return 0;
    }
    // As far out as both runs still exist. With only one face it is that face's own depth, so a
    // terminal node takes the stem it would otherwise have had.
    const m = a > 0 && b > 0 ? Math.min(a, b) : Math.max(a, b);
    const centre = headA + headB;
    const edge = Math.max(Math.min(tailA, m), headA - m)
        + Math.max(Math.min(tailB, m), headB - m);
    return Math.max(centre, edge);
}

/**
 * The whole of the gap rule: both arrows on an axis take the same stem, and this is it. It is
 * the distance from each face to where that face's taper begins. A head's triangle starts
 * here and a tail's notch vertex sits here, so the apex of a tail is at the same distance as
 * the base of the head's triangle, and the head's apex at the same distance as the tail's
 * wings.
 *
 * This decouples three things. The node's size and shape stop mattering, because whatever
 * room is left between the arrow's face and its own taper is filled by a full-width stem of
 * the same stripes, which is invisible where it lies over the band it continues; that is also
 * why an arrow can still enter the shape without the shape setting the gap. And the flow's
 * size stops mattering, because the tapers are accounted for in `loss` rather than by moving
 * a face.
 *
 * Stems are equal rather than the apexes. Putting both apexes the same distance in forces a
 * tail's stem to be a whole taper longer than the head's, so the tail intrudes twice as far
 * into the node as the head does and the node has to be that much thicker to hold it. Equal
 * stems make the two arrows mirror each other, and the node comes out thinner for the same
 * gap.
 *
 * It applies to terminal nodes too: a pure source or sink has one arrow and no second one to
 * be separated from, so it takes the stem it would otherwise have had, which leaves exactly
 * the gap between its taper and the far face.
 *
 * Never negative: a container too short for the gap (a shape sized from a label) puts the
 * taper on the face rather than outside it.
 */
export function arrowStemInset(containerExtent: number, gap: number, loss: number): number {
    return Math.max(0, (containerExtent - gap - loss) / 2);
}

/**
 * How thick a node has to be along the flow: enough for the gap plus what the two tapers cost
 * it, and never less than twice the deeper arrow, or that one would run out through the far
 * face where its opposite number is shallow enough to leave the first term small.
 *
 * The gaps come out equal and the node thicknesses vary. This is arithmetic rather than a
 * choice (a 45-degree head on a 60px flow is 30px deep whatever else is true), so the tip
 * angle is the lever.
 *
 * Only the flow axis is floored. The axis the bands pack across is still exactly the stack it
 * holds, so the value-proportional axis never moves.
 */
export function arrowExtentFloor(gap: number, loss: number, deepest: number): number {
    return deepest > 0 ? Math.max(gap + loss, 2 * deepest) : 0;
}

/**
 * Whether an axis has arrows on both of its faces, which is what the floor above is providing
 * room for: a head on one side, a tail on the other, and the gap between them.
 *
 * Where only one face carries anything there is no second arrow to be separated from, so
 * `arrowExtentFloor`'s `2 * deepest` would buy a blank half node rather than a clearance.
 * `gap + loss` is no better on its own, since `arrowClearanceLoss` falls back to that one
 * face's own depth.
 *
 * The arguments are four numbers in the same order as `arrowClearanceLoss`, for the same
 * reason: this runs per node per trial pitch inside the fit's bisection.
 */
export function arrowFacesOppose(
    headA: number, tailA: number, headB: number, tailB: number
): boolean {
    return Math.max(headA, tailA) > 0 && Math.max(headB, tailB) > 0;
}
