/**
 * Painting the nodes: the transparent hit rectangle, the decorative shape, arrow stripes,
 * labels and icons, and the balance markers.
 */

import {
    DEFAULT_LABEL_SIZE, defaultFont, isUnbalanced, LabelOptions, LayoutResult, NodeShape, PositionedNode,
    ShapePaint
} from "./model";
import { SHAPE_CORNER_RATIO } from "./layoutConstants";
import { LabelIcon, labelLinesOf, TEXT_ASCENT, TEXT_DESCENT } from "./layoutText";
import { nextId } from "./renderIds";
import { NodeInfill } from "./routeTypes";
import { FlowTypeColours } from "./colours";
import { rowsToTitle, TooltipRow, toTooltipItems } from "./tooltips";
import { bandKey, nodeKey, SelectionSink } from "./selection";
import { DragOptions, makeNodeDraggable } from "./interaction";
import { ARROW_BASE_BLEED } from "./routeConstants";
import { isVettedIcon } from "./background";
import { addTooltip, applyFont, el, inkOn } from "./renderSupport";
import { AuthorOutline, hatchIndexOf, INSIDE_STROKE, insideOutline } from "./renderBands";

/**
 * The smallest a node may be and still be comfortably hittable.
 *
 * A node thin enough to need this is exactly the case the Minimum width and Minimum height
 * floors allow: at 0% there is no rectangle at all to point at, and the node would become
 * unselectable and untooltippable. So when the drawn rectangle falls below this, an invisible
 * one of this size is laid over it to carry the pointer, and the drawn rectangle keeps only its
 * appearance.
 *
 * It is deliberately not applied to the drawn shape: inflating what is painted would make "zero
 * width" quietly mean "6px", which is the whole point of the setting. A normal-width node gets
 * no hit rectangle at all.
 *
 * It is measured against what is drawn: the shape where there is one, the node rectangle
 * otherwise. A shape is sized from the node (`shapeFloorFor` returns the node's own size for
 * Rectangle and Rounded), so a node collapsed to nothing gets a shape collapsed to nothing,
 * which would become the pointer target and could not be hovered, clicked or dragged.
 *
 * Which axis runs out first is per diagram, because the two floors are percentages of
 * different pitches.
 */
const MIN_NODE_HIT = 6;

/** What a shape's fill or border resolves to, or undefined for "don't paint it". */
function shapePaint(
    mode: ShapePaint,
    nodeColour: string,
    custom: string,
    backgroundColour: string
): string | undefined {
    switch (mode) {
        case "Node": return nodeColour;
        case "Custom": return custom;
        case "Background": return backgroundColour;
        case "Transparent":
        default: return undefined;
    }
}

/**
 * How big an element is actually painted, read back off its own attributes.
 *
 * It is read rather than recomputed so it cannot drift from what `shapeElement` decided: the
 * border inset alone is the difference between a shape that needs a hit rectangle and one that
 * does not.
 */
function paintedSize(element: SVGElement): { width: number; height: number } {
    // Keyed on the attributes the element carries rather than its tag name: a circle is the thing
    // with an `r`, whatever it calls itself. The fake DOM the render checks drive this through
    // exposes `tag` rather than `tagName`, so reading `tagName` would measure every shape as 0x0.
    // A radius of "0" falls through to the width/height branch, which reads 0 x 0 for a circle and
    // reaches the same verdict: too small to point at.
    const radius = element.getAttribute("r");
    if (radius) {
        const r = Number(radius);
        return { width: r * 2, height: r * 2 };
    }
    return {
        width: Number(element.getAttribute("width") ?? 0),
        height: Number(element.getAttribute("height") ?? 0)
    };
}

/**
 * The shape itself, centred on the node. Pure paint: no anchor moves for it.
 *
 * `inset` pulls the drawn outline in by half the border width, so the border lands wholly
 * inside the container instead of straddling its edge. SVG has no stroke alignment (a stroke
 * is centred on the path), so otherwise half of it would fall outside the shape, over the
 * bands exactly where they meet the node, drawing a faint line along every join. The clip
 * path passes 0: it wants the container's true outline, not the border's.
 */
function shapeElement(node: PositionedNode, shape: NodeShape, inset = 0): SVGElement {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    if (shape === "Circle") {
        const circle = el("circle");
        circle.setAttribute("cx", String(cx));
        circle.setAttribute("cy", String(cy));
        circle.setAttribute("r", String(Math.max(0, node.shapeWidth / 2 - inset)));
        return circle;
    }
    const width = Math.max(0, node.shapeWidth - 2 * inset);
    const height = Math.max(0, node.shapeHeight - 2 * inset);
    const rect = el("rect");
    rect.setAttribute("x", String(cx - width / 2));
    rect.setAttribute("y", String(cy - height / 2));
    rect.setAttribute("width", String(width));
    rect.setAttribute("height", String(height));
    if (shape === "Rounded") {
        // SHAPE_CORNER_RATIO, not a local constant: layout sizes the shape so this exact radius clears
        // the node rectangle, so the two have to be the same number or the corner bites back into the
        // node.
        rect.setAttribute("rx", String(Math.min(width, height) * SHAPE_CORNER_RATIO));
    }
    return rect;
}

/** Everything the Node shapes card decided, resolved once for the whole render. */
export interface ShapeOptions {
    shape: NodeShape;
    fill: ShapePaint;
    fillColour: string;
    border: ShapePaint;
    borderColour: string;
    borderWidth: number;
}

/**
 * A node's icon, as an `<image>` from its vetted data URL (background.ts), so an icon's SVG
 * runs no script and loads nothing. It is recoloured, where asked, by a filter that keeps the
 * icon's shape (its alpha) and floods it with one colour, which is right for the
 * single-colour line art icons usually are. It is never a pointer target, like the label text:
 * it dims with its node instead.
 */
function renderIcon(svg: SVGSVGElement, url: string, icon: LabelIcon, colour: string | undefined): SVGImageElement {
    const image = el("image");
    image.setAttribute("x", String(icon.x));
    image.setAttribute("y", String(icon.y));
    image.setAttribute("width", String(icon.size));
    image.setAttribute("height", String(icon.size));
    image.setAttribute("preserveAspectRatio", "xMidYMid meet");
    image.setAttribute("href", url);
    image.setAttribute("pointer-events", "none");
    if (colour !== undefined) {
        const id = nextId("icon");
        const defs = el("defs");
        const filter = el("filter");
        filter.setAttribute("id", id);
        filter.setAttribute("color-interpolation-filters", "sRGB");
        const flood = el("feFlood");
        flood.setAttribute("flood-color", colour);
        filter.appendChild(flood);
        const composite = el("feComposite");
        composite.setAttribute("in2", "SourceAlpha");
        composite.setAttribute("operator", "in");
        filter.appendChild(composite);
        defs.appendChild(filter);
        svg.appendChild(defs);
        image.setAttribute("filter", `url(#${id})`);
    }
    svg.appendChild(image);
    return image;
}

export function renderNodes(
    svg: SVGSVGElement,
    layout: LayoutResult,
    defaultNodeColour: string,
    backgroundColour: string,
    shapes: ShapeOptions,
    foregroundColour: string,
    /** This node's arrow stripes, already built by routing. */
    infillOf: (nodeId: string) => NodeInfill[],
    /** Flow-type colours and the fallback, so a stripe matches its band. */
    infillPaint: { colours: FlowTypeColours; fallback: string; opacity: number },
    /** Legend order: what picks a flow type's hatch, so a stripe takes its band's. */
    flowTypeOrder: readonly string[],
    /** Present only in high contrast, where a stripe is hatched, not coloured. */
    hatching: { fills: readonly string[]; ink: string } | undefined,
    /**
     * FlowType -> the author's texture. An arrow is the continuation of its band (same width, same
     * stripes), so it takes the band's fill, texture included, or a hatched flow would run into a
     * flat arrow head.
     */
    typePatterns: ReadonlyMap<string, string>,
    /**
     * The author's outline per flow type, and its ink. Undefined in high contrast, which outlines
     * everything in the foreground already.
     */
    authorOutline: AuthorOutline | undefined,
    labels: LabelOptions,
    /** What this node's tooltip says, built in render() from the Interaction card. */
    tooltipRows: (node: PositionedNode) => TooltipRow[],
    selection: SelectionSink,
    drag?: DragOptions
): void {
    // Where an outside name can be clicked to select its node. This is a layer of its own, added
    // before any node's pointer target and so below all of them: what is painted later is hit
    // first, which makes a node's drag win over a name that overlaps it, and the route handles
    // (drawn after every node) win over both. It is click only; a name is not draggable. A name
    // inside its shape needs nothing: the node already covers it.
    const labelHits = el("g");
    svg.appendChild(labelHits);
    layout.nodes.forEach(node => {
        const colour = node.colour ?? defaultNodeColour;
        const rows = tooltipRows(node);

        const rect = el("rect");
        rect.setAttribute("x", String(node.x));
        rect.setAttribute("y", String(node.y));
        rect.setAttribute("width", String(node.width));
        rect.setAttribute("height", String(node.height));
        // The anchoring rectangle is never painted. What a node looks like is its shape; this exists
        // to be pointed at and to dim with its node, so it is transparent and nothing more.
        rect.setAttribute("fill", "none");
        // An unfilled rect is invisible to the pointer as well as the eye, so without this a node
        // could not be hovered, clicked or dragged.
        rect.setAttribute("pointer-events", "all");
        svg.appendChild(rect);

        // The decorative overlay, drawn after the bands (nodes always are) so it sits over them, and
        // before the label so the text stays on top of its own shape.
        let shapeEl: SVGElement | undefined;
        let shapeFill: string | undefined;
        if (shapes.shape !== "None" && node.shapeWidth > 0) {
            const stroke = shapePaint(shapes.border, colour, shapes.borderColour, backgroundColour);
            const border = stroke !== undefined && shapes.borderWidth > 0 ? shapes.borderWidth : 0;
            // Inset by half the border, so it sits wholly inside the container rather than painting over
            // the bands outside it.
            shapeEl = shapeElement(node, shapes.shape, border / 2);
            shapeFill = shapePaint(shapes.fill, colour, shapes.fillColour, backgroundColour);
            shapeEl.setAttribute("fill", shapeFill ?? "none");
            if (border > 0 && stroke !== undefined) {
                shapeEl.setAttribute("stroke", stroke);
                shapeEl.setAttribute("stroke-width", String(border));
            }
            svg.appendChild(shapeEl);
        }

        // The arrows: the packed stack at each face, continued inward. Drawn after the shape, or the
        // shape would cover them: it is the container they sit inside, not a backdrop behind them.
        const stripes = infillOf(node.id);
        if (stripes.length > 0) {
            // A shape's real outline is a circle or a rounded rectangle; routing built the arrows against
            // its bounding box, so they are clipped back to it here. Only render knows the outline, which
            // is why the clip lives here and not in routing.
            let clipRef = "";
            if (shapeEl) {
                const clip = el("clipPath");
                const clipId = nextId("nodeclip");
                clip.setAttribute("id", clipId);
                // Grown by the arrow's base bleed, not the shape's exact outline: an arrow reaches that far
                // back past the container face so it overlaps the band it continues, and clipping to the
                // outline would cut off precisely the overlap that covers that seam.
                clip.appendChild(shapeElement(node, shapes.shape, -ARROW_BASE_BLEED));
                svg.appendChild(clip);
                clipRef = `url(#${clipId})`;
            }
            stripes.forEach(stripe => {
                const path = el("path");
                path.setAttribute("d", stripe.path);
                // The same index the band took, so a head and the band it continues can never carry different
                // textures.
                const stripeFill = hatching
                    ? hatching.fills[hatchIndexOf(stripe.flowType, flowTypeOrder)
                        % hatching.fills.length]
                    : stripe.flowType === undefined
                        ? infillPaint.fallback
                        : typePatterns.get(stripe.flowType)
                            ?? infillPaint.colours.colours.get(stripe.flowType)
                            ?? infillPaint.fallback;
                path.setAttribute("fill", stripeFill);
                path.setAttribute("fill-opacity", String(infillPaint.opacity));
                path.setAttribute("stroke", "none");
                // Decoration: the node under it stays the click target.
                path.setAttribute("pointer-events", "none");
                if (clipRef) {
                    path.setAttribute("clip-path", clipRef);
                }
                svg.appendChild(path);
                // Outlined on its own edges, never its base. It is outlined for the reason a hatched band is
                // (the texture otherwise just stops, with no edge to say where the arrow is), but the stroke
                // goes on the outline routing hands out, not round the filled polygon. The polygon's base sits
                // a pixel behind the face, inside the band, so stroking it would draw a line across the flow
                // exactly where the arrow grows out of it.
                //
                // It is one element, for the same two reasons as a band's outline: high contrast needs every
                // arrow edged, and the author may ask for one per flow type. An arrow is the continuation of
                // its band, so it has to carry whatever the band carries.
                const stripeStyle = stripe.flowType !== undefined
                    ? authorOutline?.styles?.get(stripe.flowType)
                    : authorOutline?.untyped;
                if ((hatching || stripeStyle !== undefined) && stripe.outline !== "") {
                    const edge = el("path");
                    edge.setAttribute("d", stripe.outline);
                    edge.setAttribute("class", "sankeybi-arrow-edge");
                    edge.setAttribute("fill", "none");
                    edge.setAttribute("stroke",
                        hatching ? hatching.ink : (authorOutline?.ink ?? "#605e5c"));
                    if (!hatching && stripeStyle === "dashed") {
                        // The same dash the band carries, in the same pixels, or the line type would change at the
                        // join.
                        edge.setAttribute("stroke-dasharray", "4 3");
                    }
                    // Doubled and clipped to the stripe, for the reason a band's outline is (`insideOutline`): a
                    // centred stroke would put half a pixel outside, and an arrow that is wider than the band it
                    // continues shows a step at the join.
                    edge.setAttribute("stroke-width", String(INSIDE_STROKE));
                    edge.setAttribute("pointer-events", "none");
                    const defs = el("defs");
                    edge.setAttribute("clip-path", insideOutline(defs, stripe.path));
                    svg.appendChild(defs);
                    if (clipRef) {
                        // An element takes one clip-path, and the stripe clip is on the path itself, so the shape clip
                        // goes on a wrapper, and the two intersect as they must.
                        const holder = el("g");
                        holder.setAttribute("clip-path", clipRef);
                        holder.appendChild(edge);
                        svg.appendChild(holder);
                    } else {
                        svg.appendChild(edge);
                    }
                    selection.registerDecoration(edge, bandKey(stripe.corridorId));
                }
                /**
                 * An arrow stripe answers to its own corridor, not to the node it is drawn in. It is that
                 * band's continuation inside the node (same width, same stripes, same order), so it lights and
                 * dims with the band it continues, and a corridor cannot be dim with a lit stub of itself
                 * inside a node.
                 *
                 * Otherwise a node lit by the one-hop rule would light every arrow in it, including those of
                 * corridors that do not touch the clicked node at all.
                 *
                 * `NodeInfill` carries `corridorId` per stripe, so this is the key the stripe already knew;
                 * nothing is re-derived.
                 */
                selection.registerDecoration(path, bandKey(stripe.corridorId));
            });
        }

        // Whichever element the pointer actually meets carries the tooltip, the selection and the
        // drag; the others are decoration that only have to dim along with it. A shape covers the node
        // rectangle by construction, so when there is one it has to be the target, otherwise it would
        // swallow every click meant for the node under it.
        let target: SVGElement = rect;
        if (shapeEl) {
            // An unfilled shape is invisible to the pointer without this, exactly as for the hit rectangle
            // below.
            shapeEl.setAttribute("pointer-events", "all");
            rect.setAttribute("pointer-events", "none");
            selection.registerDecoration(rect, nodeKey(node.id));
            target = shapeEl;
        }
        // Measured off the element that will carry the pointer, rather than predicted from the node: a
        // shape is drawn inset by half its border (`shapeElement`), so a shape 7.4px tall is painted
        // 5.4px tall, and a prediction from `node.shapeHeight` would call that big enough.
        const drawn = paintedSize(target);
        if (drawn.width < MIN_NODE_HIT || drawn.height < MIN_NODE_HIT) {
            const hit = el("rect");
            const w = Math.max(drawn.width, MIN_NODE_HIT);
            const h = Math.max(drawn.height, MIN_NODE_HIT);
            hit.setAttribute("x", String(node.x + node.width / 2 - w / 2));
            hit.setAttribute("y", String(node.y + node.height / 2 - h / 2));
            hit.setAttribute("width", String(w));
            hit.setAttribute("height", String(h));
            hit.setAttribute("fill", "none");
            // Without this an unfilled rect is invisible to the pointer, which is the opposite of what it
            // is here for.
            hit.setAttribute("pointer-events", "all");
            svg.appendChild(hit);
            // Whatever was the target a moment ago is now decoration: it keeps its appearance and still
            // dims, but the pointer meets the rectangle laid over it. (Where there is a shape the rectangle
            // was demoted above, so this only ever has the one element left to stand down.)
            target.setAttribute("pointer-events", "none");
            selection.registerDecoration(target, nodeKey(node.id));
            target = hit;
        }
        if (selection.nativeTitles !== false) {
            addTooltip(target, rowsToTitle(rows));
        }
        selection.registerNode(target, node.id, toTooltipItems(rows));
        if (drag) {
            makeNodeDraggable(target, node, svg, drag);
        }

        // Where each line goes is layout's decision (`labelLinesOf`), so the fit measures exactly what
        // is painted here.
        const { lines, inside, icon } = labelLinesOf(node, labels, shapeEl !== undefined);
        // Inside its shape, in ink chosen against the fill it lands on: the default fill is the node's
        // own colour, which is often dark enough that the theme foreground would be unreadable on it.
        const ink = inside ? (inkOn(shapeFill) ?? foregroundColour) : undefined;
        if (!inside && lines.length > 0) {
            // One box over the whole block, wrapped lines and total together.
            let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
            lines.forEach(line => {
                const from = line.anchor === "start" ? line.x
                    : line.anchor === "end" ? line.x - line.width : line.x - line.width / 2;
                left = Math.min(left, from);
                right = Math.max(right, from + line.width);
                top = Math.min(top, line.y - line.fontSize * TEXT_ASCENT);
                bottom = Math.max(bottom, line.y + line.fontSize * TEXT_DESCENT);
            });
            const pad = 3;
            const hit = el("rect");
            hit.setAttribute("x", String(left - pad));
            hit.setAttribute("y", String(top - pad));
            hit.setAttribute("width", String(right - left + 2 * pad));
            hit.setAttribute("height", String(bottom - top + 2 * pad));
            hit.setAttribute("fill", "none");
            hit.setAttribute("pointer-events", "all");
            labelHits.appendChild(hit);
            selection.registerNode(hit, node.id, toTooltipItems(rows));
            // The node's own target is what a reader hears; this is a second way to reach it with a
            // pointer, not a second thing.
            hit.setAttribute("aria-hidden", "true");
        }
        if (icon && node.icon && isVettedIcon(node.icon)) {
            const tint = labels.iconColour === "Ink" ? (ink ?? foregroundColour)
                : labels.iconColour === "Node" ? colour
                    : undefined;
            selection.registerDecoration(renderIcon(svg, node.icon, icon, tint), nodeKey(node.id));
        }
        lines.forEach(line => {
            const text = el("text");
            text.setAttribute("x", String(line.x));
            text.setAttribute("y", String(line.y));
            text.setAttribute("text-anchor", line.anchor);
            // The size comes from the line, which layout both set and measured at; the family from the font
            // the author chose. A total's weight is its own setting, a name's is the label font's.
            applyFont(text, {
                ...(labels.font ?? defaultFont(DEFAULT_LABEL_SIZE)),
                bold: line.muted ? (labels.totalBold ?? false) : (labels.font?.bold ?? false)
            }, line.fontSize);
            // A custom colour wins outright, inside a shape as well as outside: explicit beats automatic,
            // which is the precedence this visual uses everywhere, and a setting that lost to a luminance
            // test would be a setting that does nothing.
            //
            // Every label gets an explicit fill. Outside a shape, setting none falls back to SVG's own
            // default black, which is fine on a light report by luck and invisible on a dark one.
            //
            // Inside a shape the ink is picked against the fill (`inkOn`), because the text sits on a
            // colour of the author's choosing. Outside, the right answer is simply the theme's foreground,
            // which follows the report. A muted total is the same ink held back with opacity either way,
            // never a fixed grey, which vanishes on a dark background exactly as the black did.
            text.setAttribute("fill", labels.colour ?? ink ?? foregroundColour);
            // Never a pointer target: painted after its hit rectangle, so without this the letters would
            // catch the pointer and only the gaps between them reach the rectangle below, making a name
            // that selects only when clicked between glyphs.
            text.setAttribute("pointer-events", "none");
            if (line.muted) {
                text.setAttribute("fill-opacity", "0.75");
            }
            text.textContent = line.text;
            svg.appendChild(text);
            // Dims with its node but is not itself a click target: a label that swallowed clicks would
            // make a thin bar hard to hit.
            selection.registerDecoration(text, nodeKey(node.id));
        });
    });
}

/** The marker's edge, in px. A diagnostic overlay, so it has no grid-relative size. */
const BALANCE_MARKER = 9;

/**
 * Marks every node whose inflow and outflow disagree.
 *
 * Edit mode only, and off by default: this is a data-quality cue for the author while they are
 * building, and a warning triangle in front of a report reader is worse than no warning at all.
 *
 * It is drawn just outside the node's top-right corner so it does not sit on the label, and
 * registered as a decoration: it dims with its node and is never a pointer target, the rule the
 * label and the icon already follow. It takes no room and moves nothing, so there is no
 * geometry input here and nothing for the geometry key to cover.
 */
export function renderBalanceMarkers(
    svg: SVGSVGElement,
    layout: LayoutResult,
    tolerancePercent: number,
    colour: string,
    selection: SelectionSink
): void {
    layout.nodes.forEach(node => {
        if (!isUnbalanced(node, tolerancePercent)) {
            return;
        }
        // Measured from the node's centre out to whichever is drawn wider, the node or its shape:
        // node.x/y are edges of the node rect, and a shape can be bigger than it.
        const halfWidth = Math.max(node.width, node.shapeWidth ?? 0) / 2;
        const halfHeight = Math.max(node.height, node.shapeHeight ?? 0) / 2;
        const right = node.x + node.width / 2 + halfWidth;
        const top = node.y + node.height / 2 - halfHeight;
        const x = right + 2;
        const y = top - BALANCE_MARKER - 2;
        const tri = el("path");
        tri.setAttribute("d",
            `M ${x + BALANCE_MARKER / 2} ${y} `
            + `L ${x + BALANCE_MARKER} ${y + BALANCE_MARKER} `
            + `L ${x} ${y + BALANCE_MARKER} Z`);
        tri.setAttribute("fill", colour);
        tri.setAttribute("pointer-events", "none");
        svg.appendChild(tri);
        selection.registerDecoration(tri, nodeKey(node.id));
    });
}
