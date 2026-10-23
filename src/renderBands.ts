/**
 * Painting the bands: colours, high-contrast hatches, the author's outlines and textures,
 * crossing channels, hit halos and partial-highlight sub-bands.
 */

import { LabelOptions, LayoutResult, Point, RoutedBand } from "./model";
import { FlowTypeColours } from "./colours";
import { nextId } from "./renderIds";
import { bandKey, SelectionSink, stripeKey } from "./selection";
import { crossingKey } from "./layers";
import { corridorTooltipRows, rowsToTitle, toTooltipItems } from "./tooltips";
import { addTooltip, el } from "./renderSupport";
import { HATCH_COUNT, TEXTURES } from "./textures";

/**
 * What the author has asked to outline, and the ink to draw it in.
 *
 * `styles` is per flow type, which is every flow that has one. `untyped` is the pane's own
 * outline for a flow that has none: a report with no Flow type field bound, where a per-type
 * map can say nothing and `Flows > Colour > Outline` would otherwise look broken. Both are
 * resolved in `colours.ts`, so render only looks a style up and never decides one.
 *
 * Undefined as a whole in high contrast, which already outlines every band in the foreground.
 */
export interface AuthorOutline {
    styles?: ReadonlyMap<string, "solid" | "dashed">;
    untyped?: "solid" | "dashed";
    ink: string;
}

/**
 * Which hatch a flow type gets: its position in the legend's order, so a band and its legend
 * entry carry the same texture by construction rather than by both happening to compute the
 * same thing.
 */
export function hatchIndexOf(flowType: string | undefined, flowTypeOrder: readonly string[]): number {
    if (flowType === undefined) {
        return 0;
    }
    const at = flowTypeOrder.indexOf(flowType);
    return at < 0 ? 0 : at;
}

/**
 * One hatch per flow type, for high-contrast mode.
 *
 * High contrast allows the foreground, the background and the hyperlink colour and nothing
 * else, so colour cannot carry the flow type. Texture can. These are built once per render into
 * `<defs>` and referenced by `url(#...)`.
 *
 * `patternUnits="userSpaceOnUse"` makes the texture the same size everywhere rather than scaling
 * with whichever band it lands on: the default objectBoundingBox would make a thick band's
 * hatch coarse and a thin one's invisible.
 */
export function hatchPatterns(
    defs: SVGElement, ink: string, paper: string,
    /**
     * Distinguishes one set of textures from another. High contrast builds one set in the theme's ink;
     * an author's patterns are a set per colour used, and two sets sharing `sankeybi-hatch-0` would
     * make the second silently take the first's colours.
     */
    idPrefix = "sankeybi-hatch",
    /** How many textures to build: the hatches alone by default, or every texture. */
    count = HATCH_COUNT
): string[] {
    const refs: string[] = [];
    for (let index = 0; index < count; index++) {
        const tile = TEXTURES[index];
        const id = `${idPrefix}-${index}`;
        const pattern = el("pattern");
        pattern.setAttribute("id", id);
        pattern.setAttribute("patternUnits", "userSpaceOnUse");
        pattern.setAttribute("width", String(tile.width));
        pattern.setAttribute("height", String(tile.height));
        const paperRect = el("rect");
        paperRect.setAttribute("width", String(tile.width));
        paperRect.setAttribute("height", String(tile.height));
        paperRect.setAttribute("fill", paper);
        pattern.appendChild(paperRect);
        tile.marks.forEach(spec => {
            const mark = el(spec.tag);
            Object.keys(spec.attrs).forEach(name => mark.setAttribute(name, spec.attrs[name]));
            if (spec.filled) {
                mark.setAttribute("fill", ink);
            } else {
                mark.setAttribute("stroke", ink);
                mark.setAttribute("stroke-width", String(tile.strokeWidth));
                mark.setAttribute("fill", "none");
            }
            pattern.appendChild(mark);
        });
        defs.appendChild(pattern);
        refs.push(`url(#${id})`);
    }
    return refs;
}

/** A band's flat colour: its flow type's colour, or the default where it has none. */
export function bandColour(band: RoutedBand, flowTypeColours: FlowTypeColours, defaultColour: string): string {
    if (band.flowType === undefined) {
        return defaultColour;
    }
    return flowTypeColours.colours.get(band.flowType) ?? defaultColour;
}

/**
 * How far a crossing mask's white rectangle reaches past the chrome box.
 *
 * A wrap's lane and a spilling band can both be drawn outside it (the overflow pass reserves
 * what it can, and under Lock grid nothing is reserved at all), and anything outside a mask's
 * own rectangle is masked out, so a mask sized to the box exactly would erase a corridor's
 * overhang entirely rather than leaving it alone.
 */
const MASK_OVERSCAN = 4000;

/**
 * An outline drawn wholly inside its shape, so a flow is still painted exactly as wide as its
 * value.
 *
 * SVG has no stroke alignment: a stroke is centred on its path, so half of a 1px outline would
 * fall outside the band. The painted extent would grow by 1px whatever the band carried (1.7%
 * on a 60px band and 50% on a 2px one), which is the width-dependent distortion proportional
 * bands exist to prevent, and on a face packed without Flow separation the outer half would
 * land on the neighbour and overpaint it.
 *
 * The same defect `shapeElement` fixes for a node's border, where half the stroke would fall
 * outside the container, over the bands exactly where they meet the node. A shape can be inset
 * because it is one closed path; a band's outline is its two long edges, which would have to be
 * offset inward as geometry, so the stroke is clipped to the filled shape instead and doubled,
 * leaving the inner half at the full 1px and nothing outside. This is pure paint, with nothing
 * for routing to hand out.
 */
export function insideOutline(defs: SVGElement, fillPath: string): string {
    const id = nextId("edgeclip");
    const clip = el("clipPath");
    clip.setAttribute("id", id);
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    const shape = el("path");
    shape.setAttribute("d", fillPath);
    clip.appendChild(shape);
    defs.appendChild(clip);
    return `url(#${id})`;
}

/** Stroke width to ask for when half of it will be clipped away. */
export const INSIDE_STROKE = 2;

/**
 * Draws routing's precomputed geometry. Every corridor, self-loops included, is a filled
 * closed band routed through the same spine and offset machinery, so there is no separate
 * stroked-path branch.
 *
 * Both tooltips a hover can produce come from the same lines (tooltips.ts): the host's themed
 * box, and the native `<title>` that remains as the fallback when the service is disabled or
 * absent (and is what a plain browser shows outside a Power BI host).
 */
export function renderBands(
    svg: SVGSVGElement,
    layout: LayoutResult,
    bands: RoutedBand[],
    flowTypeColours: FlowTypeColours,
    defaultColour: string,
    labels: LabelOptions,
    selection: SelectionSink,
    /** Legend order, so a corridor's tooltip lists its types as the legend does. */
    flowTypeOrder: readonly string[],
    /** Corridor ids bottom-first; empty keeps the order the bands arrive in. */
    paintOrder: readonly string[],
    /** See render()'s own parameter. */
    crossings?: {
        margin: number;
        silhouettes: ReadonlyMap<string, string>;
        pairs: ReadonlyMap<string, readonly { at: Point; radius: number }[]>;
    },
    /**
     * High contrast only: one `url(#...)` per hatch, and the ink to outline a hatched band with.
     * Absent means ordinary colour, which is every normal render and every synthetic check.
     */
    hatching?: { fills: readonly string[]; ink: string },
    /** FlowType -> the author's texture, where one is chosen. Empty in high contrast. */
    typePatterns: ReadonlyMap<string, string> = new Map(),
    /**
     * The author's own outline per flow type, and the ink to draw it in. Undefined in high
     * contrast, which already outlines every band in the foreground; a choice there would say
     * nothing.
     */
    authorOutline?: AuthorOutline
): void {
    const hatches = hatching?.fills;
    const hatchInk = hatching?.ink;
    const defs = el("defs");
    // Grouped by corridor, because a click selects a corridor and its tooltip describes the whole
    // of one. Insertion order is kept, so the painting order is exactly the order the bands
    // arrive in.
    const byCorridor = new Map<string, RoutedBand[]>();
    bands.forEach(band => {
        const group = byCorridor.get(band.corridorId);
        if (group) {
            group.push(band);
        } else {
            byCorridor.set(band.corridorId, [band]);
        }
    });

    // Z-order is append order and nothing else, so the whole of the layering rule is this sort: a
    // corridor's stripes stay together and keep their own low-to-high order, which is what
    // STRIPE_BLEED depends on, and only the groups move. A corridor the order does not mention
    // keeps its place relative to the others, so an empty order paints as the bands arrive.
    const rank = new Map(paintOrder.map((id, index) => [id, index]));
    const ordered = Array.from(byCorridor.keys()).map((id, index) => ({ id, index }));
    ordered.sort((a, b) =>
        ((rank.get(a.id) ?? paintOrder.length + a.index) - (rank.get(b.id) ?? paintOrder.length + b.index))
        || (a.index - b.index));

    /**
     * A channel erased through whatever passes underneath a crossing.
     *
     * A transparent gap cannot be painted, and it must not be painted in the background colour,
     * which matches what is actually behind the visual only by luck and is plainly wrong over a
     * background picture. So it is a mask: white everywhere, black where a corridor painted above
     * this one crosses it, which is exactly where this one should not be drawn.
     *
     * Two things keep it honest. The eraser is stroked and not filled, so a corridor with Flow
     * transparency above 0 still blends with what is under it everywhere except the channel itself;
     * filling would occlude outright and change what transparency means. And only pairs that
     * genuinely cross are erased (`layers.ts`), so two corridors merely packed side by side into a
     * node face never eat into one another; that gap is Flow separation's job, and it is made of
     * geometry rather than of erasure.
     *
     * A corridor with nothing crossing above it gets no mask at all, so an ordinary diagram is
     * unchanged and a margin of 0 draws byte-identically.
     */
    const maskFor = new Map<string, string>();
    if (crossings && crossings.margin > 0 && ordered.length > 1) {
        const rankOf = new Map(ordered.map((entry, index) => [entry.id, index]));
        ordered.forEach(({ id: corridorId }) => {
            const above: { outline: string; sites: readonly { at: Point; radius: number }[] }[] = [];
            ordered.forEach(({ id: other }) => {
                if ((rankOf.get(other) as number) <= (rankOf.get(corridorId) as number)) {
                    return; // painted below or equal: it cannot cover this one
                }
                const sites = crossings.pairs.get(crossingKey(corridorId, other));
                if (!sites || sites.length === 0) {
                    return; // they never cross, so there is nothing to erase
                }
                const outline = crossings.silhouettes.get(other);
                if (outline) {
                    above.push({ outline, sites });
                }
            });
            if (above.length === 0) {
                return;
            }
            const mask = el("mask");
            const maskId = nextId("crossmask");
            mask.setAttribute("id", maskId);
            // userSpaceOnUse and a rectangle over the whole viewport: the default objectBoundingBox units
            // would make every number relative to whichever band the mask happened to be applied to.
            mask.setAttribute("maskUnits", "userSpaceOnUse");
            const all = el("rect");
            all.setAttribute("x", String(-MASK_OVERSCAN));
            all.setAttribute("y", String(-MASK_OVERSCAN));
            all.setAttribute("width", String(layout.chromeBox.width + 2 * MASK_OVERSCAN));
            all.setAttribute("height", String(layout.chromeBox.height + 2 * MASK_OVERSCAN));
            all.setAttribute("fill", "white");
            mask.appendChild(all);
            above.forEach(({ outline, sites }) => {
                const cut = el("path");
                cut.setAttribute("d", outline);
                // Stroked at twice the margin so half of it, the outer half, reaches that far beyond the
                // crossing band's own edge, which is the gap the reader sees. Not filled: see above.
                cut.setAttribute("fill", "none");
                cut.setAttribute("stroke", "black");
                cut.setAttribute("stroke-width", String(crossings.margin * 2));
                cut.setAttribute("stroke-linejoin", "round");
                cut.setAttribute("stroke-linecap", "round");
                // Only at the crossings. The eraser is the whole outline, because that is the shape the
                // channel has to follow; where it applies is a disc per crossing, sized by layers.ts to cover
                // the two bands' actual overlap and grown by the margin the channel adds. So two corridors that
                // cross once and then run alongside each other are erased at the crossing and nowhere else.
                const clip = el("clipPath");
                const clipId = nextId("crosscut");
                clip.setAttribute("id", clipId);
                clip.setAttribute("clipPathUnits", "userSpaceOnUse");
                sites.forEach(site => {
                    const disc = el("circle");
                    disc.setAttribute("cx", String(site.at.x));
                    disc.setAttribute("cy", String(site.at.y));
                    disc.setAttribute("r", String(site.radius + crossings.margin));
                    clip.appendChild(disc);
                });
                defs.appendChild(clip);
                cut.setAttribute("clip-path", `url(#${clipId})`);
                mask.appendChild(cut);
            });
            defs.appendChild(mask);
            maskFor.set(corridorId, `url(#${maskId})`);
        });
    }

    ordered.forEach(({ id: corridorId }) => {
        const group = byCorridor.get(corridorId) as RoutedBand[];
        const maskRef = maskFor.get(corridorId);
        const rows = corridorTooltipRows(group, labels, flowTypeOrder);
        const title = selection.nativeTitles !== false ? rowsToTitle(rows) : undefined;
        const items = toTooltipItems(rows);
        const painted: SVGElement[] = [];
        group.forEach(band => {
            const path = el("path");
            path.setAttribute("d", band.path);
            // A band says what it is. Nothing else distinguishes a band's path from a node's or an arrow's,
            // and a check that identified one by an incidental attribute would break for a reason
            // unconnected to what it tests, which is what a class fixes.
            path.setAttribute("class", "sankeybi-band");
            // High contrast cannot use colour, so the flow type is carried by a hatch instead and the band
            // is outlined so its edges read. High contrast's hatch comes first (the mode's choice is not the
            // author's to override), then the author's texture, then the flat colour.
            const fill = hatches
                ? hatches[hatchIndexOf(band.flowType, flowTypeOrder) % hatches.length]
                : (band.flowType !== undefined ? typePatterns.get(band.flowType) : undefined)
                    ?? bandColour(band, flowTypeColours, defaultColour);
            path.setAttribute("fill", fill);
            // Deliberately not stroked to close anti-aliasing seams: that thickens tapering stripes
            // unevenly, and the faint lines have a different cause anyway (see shapeElement's border
            // inset).
            //
            // The outline is its own element, drawn on the band's two long edges only. Stroking the filled
            // path would outline the closed polygon, whose two closing moves are the end caps at the source
            // and target faces, so a line would be drawn across the flow at each node, and a hatched band
            // with an arrow head continuing it would read as two shapes rather than one. Routing hands out
            // `edges` for this; render may not derive it.
            //
            // Moving it off the filled path also settles the sub-band: a sub-band copies its parent's
            // `stroke`, and a portion of a band outlined all round would have a line across the middle of a
            // flow. There is now no stroke to copy.
            path.setAttribute("stroke", "none");
            // The painted stripes only, never the hit halo below: a mask suppresses hit-testing as well as
            // paint, and masking the halo would make a thin corridor unclickable exactly where another one
            // crosses it.
            if (maskRef) {
                path.setAttribute("mask", maskRef);
            }
            svg.appendChild(path);
            // One outline element, two reasons to draw it. High contrast needs every band edged, or the
            // texture simply stops with nothing to say where one band ends and the next begins. An author
            // may ask for one per flow type, the publication convention for a projected or estimated flow.
            // Either way it goes on `band.edges`, the two long edges, so a flow still runs continuously
            // into its node and its arrow head.
            const authorStyle = band.flowType !== undefined
                ? authorOutline?.styles?.get(band.flowType)
                : authorOutline?.untyped;
            if (hatches || authorStyle !== undefined) {
                const outline = el("path");
                outline.setAttribute("d", band.edges);
                outline.setAttribute("class", "sankeybi-band-edge");
                outline.setAttribute("fill", "none");
                outline.setAttribute("stroke",
                    hatches ? (hatchInk as string) : (authorOutline?.ink ?? "#605e5c"));
                // Doubled and clipped to the band, so the visible inner half is a full pixel and nothing is
                // painted outside the band's own width; see `insideOutline`.
                outline.setAttribute("stroke-width", String(INSIDE_STROKE));
                outline.setAttribute("clip-path", insideOutline(defs, band.path));
                if (!hatches && authorStyle === "dashed") {
                    // In pixels, not a fraction of the pitch: this is ink, like a label's size, and a dash that
                    // rescaled with the diagram would read as a different line type at a different zoom.
                    outline.setAttribute("stroke-dasharray", "4 3");
                }
                // Erased by a crossing exactly as the band is, or the outline would survive in the channel the
                // band was removed from.
                if (maskRef) {
                    outline.setAttribute("mask", maskRef);
                }
                // Decoration: the band under it keeps the click and the hover. It is not pushed into
                // `painted`, which is parallel to `group` for `registerBand`; an extra element there would shift
                // every later band's registration onto the wrong corridor. It is registered as a decoration
                // instead, which is also what makes it dim with the band rather than staying bright over a
                // dimmed one.
                outline.setAttribute("pointer-events", "none");
                svg.appendChild(outline);
                selection.registerDecoration(outline, bandKey(band.corridorId));
            }
            painted.push(path);
        });

        // A corridor thinner than this cannot be pointed at, so an invisible twin of its widest stripe
        // is laid over it, stroked out to the minimum. Stroke rather than a fatter fill: the halo has to
        // sit either side of a band that may be one pixel wide, and a stroke is the only thing that
        // grows a path symmetrically without knowing which way it runs.
        const thickness = group.reduce((sum, b) => sum + b.width, 0);
        if (thickness < MIN_BAND_HIT) {
            const widest = group.reduce((a, b) => (b.width > a.width ? b : a), group[0]);
            const hit = el("path");
            hit.setAttribute("d", widest.path);
            hit.setAttribute("fill", "none");
            hit.setAttribute("stroke", "none");
            hit.setAttribute("stroke-width", String(MIN_BAND_HIT - thickness));
            // "all" so the path answers over its fill area as well as its stroke, neither of which is
            // painted.
            hit.setAttribute("pointer-events", "all");
            svg.appendChild(hit);
            // The stripes keep their colour and still dim; the halo carries the pointer. Each stripe
            // carries its own dim key as well as its corridor's, so an inbound highlight naming one flow
            // type dims the others beside it rather than lighting the whole corridor. The index is the
            // stripe's position in `group`, which `painted` is built from one-for-one above.
            painted.forEach((p, i) => {
                p.setAttribute("pointer-events", "none");
                selection.registerDecoration(p, bandKey(widest.corridorId),
                    stripeKey(group[i].corridorId, group[i].flowType));
            });
            if (title !== undefined) {
                addTooltip(hit, title);
            }
            selection.registerBand(hit, widest.corridorId, items);
            // Here too, so a thin corridor shows its in-scope portion like any other. Leaving this out
            // would make MIN_BAND_HIT a second threshold on the sub-band by accident.
            paintSubBands(svg, group, painted, selection);
            return;
        }

        painted.forEach((p, i) => {
            if (title !== undefined) {
                addTooltip(p, title);
            }
            selection.registerBand(p, group[0].corridorId, items,
                stripeKey(group[i].corridorId, group[i].flowType));
        });
        paintSubBands(svg, group, painted, selection);
    });

    if (defs.childNodes.length > 0) {
        svg.insertBefore(defs, svg.firstChild);
    }
}

/**
 * The thinnest a corridor may be drawn and still be comfortably hittable, in pixels.
 *
 * A band has no hit machinery of its own: it is its painted fill, so at `MIN_CORRIDOR_WIDTH`
 * (1px) a small flow would be a one-pixel target for tooltips and cross-filter, which in
 * practice means untouchable. Below this an invisible halo is laid over the corridor instead,
 * and the painted stripes become decoration.
 *
 * It is applied per corridor rather than per stripe, which is what makes it honest: the halo is
 * wider than the stripes it covers, so per stripe the halos would overlap and whichever was
 * drawn last would answer for all of them. Since a click selects the whole corridor anyway
 * (`bandKey`), overlapping halos within one corridor all mean the same thing.
 *
 * Two corridors can still overlap each other's halos, and there the one drawn later wins, the
 * same bargain thin nodes have always made.
 */
const MIN_BAND_HIT = 6;

/**
 * The in-scope portion of a partly-highlighted stripe, drawn over it.
 *
 * Another visual highlighting at a finer grain than the Sankey (a bar chart on FlowType and
 * Scenario against a Sankey on FlowType alone) sends each row's share rather than a yes/no, so
 * the diagram can say "this much of this flow" in the one language it already speaks: band
 * width means value, so a fraction of the width means a fraction of the value.
 *
 * The sub-band takes its parent's `fill` and `mask` verbatim, so the high-contrast hatches need
 * no special case here: the portion is painted with whatever the whole was painted with.
 *
 * It is drawn however thin the stripe is. A floor on its width would be pointless, since a
 * sub-band nobody can see costs nothing, and it would need a second rule beside it for the
 * stripes that fell under it. One rule that is sometimes invisible beats two rules.
 */
function paintSubBands(
    svg: SVGSVGElement,
    group: readonly RoutedBand[],
    painted: readonly SVGElement[],
    selection: SelectionSink
): void {
    if (!selection.highlightFractionOf || !selection.registerSubBand) {
        return;
    }
    group.forEach((band, i) => {
        const key = stripeKey(band.corridorId, band.flowType);
        const fraction = selection.highlightFractionOf?.(key);
        // Nothing to say at 0 (dimmed anyway) or 1 (lit anyway), and nothing to draw on a band routing
        // gave no `partialPath`.
        if (fraction === undefined || fraction <= 0 || fraction >= 1 || !band.partialPath) {
            return;
        }
        const parent = painted[i];
        const sub = el("path");
        sub.setAttribute("d", band.partialPath(fraction));
        ["fill", "fill-opacity", "mask", "stroke", "stroke-width"].forEach(attribute => {
            const value = parent?.getAttribute(attribute);
            if (value !== null && value !== undefined) {
                sub.setAttribute(attribute, value);
            }
        });
        // Never a pointer target: the stripe underneath already answers, and a sub-band that swallowed
        // the click would make a flow selectable only where another visual happened to be highlighting
        // it.
        sub.setAttribute("pointer-events", "none");
        svg.appendChild(sub);
        selection.registerSubBand?.(sub, band.corridorId, key);
    });
}
