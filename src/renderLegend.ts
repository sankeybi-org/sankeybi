import { FlowTypeColours } from "./colours";
import { LEGEND_BAND_WIDTH, LegendPosition, MARGIN } from "./layoutConstants";
import { DEFAULT_LEGEND_SIZE, FontSpec, LabelOptions } from "./model";
import { applyFont, el } from "./renderSupport";

/**
 * The legend: a swatch and the flow type's name per entry, laid out in the band
 * that layout reserved for the chosen position. It is a single row (Top, Bottom)
 * or a single column (Left, Right) and does not wrap, so a very large number of
 * flow types can overflow the band.
 */
export function renderLegend(
    svg: SVGSVGElement,
    flowTypeColours: FlowTypeColours,
    position: LegendPosition,
    viewportWidth: number,
    viewportHeight: number,
    font: FontSpec,
    /** Blank for no title, which is the default. */
    title: string,
    /** The theme's foreground, for every piece of text the legend draws. */
    ink: string,
    /** High contrast: the hatches the bands are carrying, so the legend matches. */
    hatching: { fills: readonly string[]; ink: string } | undefined,
    /**
     * Flow type to the author's texture. The swatch has to carry whatever its bands
     * carry, or the legend stops saying what the diagram means.
     */
    typePatterns: ReadonlyMap<string, string>,
    /** Real text measurement, where the host can supply it (formatting.ts). */
    measure: LabelOptions["measureText"]
): void {
    const SWATCH = 10;
    const SWATCH_GAP = 5;
    const ENTRY_GAP = 16;
    const ROW_HEIGHT = 18;

    const group = el("g");
    group.setAttribute("class", "sankeybi-legend");

    // The title is drawn in bold and measured, so the first swatch starts clear of it.
    const titleFont: FontSpec = { ...font, bold: true };
    const titleWidth = title === ""
        ? 0
        : (measure
            ? measure(title, titleFont.size, true, titleFont.family)
            : title.length * 6.6) + ENTRY_GAP;

    if (position === "Top" || position === "Bottom") {
        const y = position === "Top" ? 16 : viewportHeight - 10;
        let x = MARGIN;
        if (title !== "") {
            const heading = el("text");
            heading.setAttribute("x", String(x));
            heading.setAttribute("y", String(y));
            applyFont(heading, titleFont);
            heading.setAttribute("fill", ink);
            heading.textContent = title;
            group.appendChild(heading);
            x += titleWidth;
        }
        flowTypeColours.order.forEach(type => {
            x += renderLegendEntry(group, x, y, labelOfType(type, flowTypeColours),
                hatching ? hatching.ink : (flowTypeColours.colours.get(type) ?? "#999999"),
                SWATCH, SWATCH_GAP, font, ink,
                hatching
                    ? hatching.fills[flowTypeColours.order.indexOf(type) % hatching.fills.length]
                    : typePatterns.get(type),
                measure);
            x += ENTRY_GAP;
        });
    } else {
        let startY = MARGIN + 10;
        const x = position === "Left" ? MARGIN : Math.max(MARGIN, viewportWidth - LEGEND_BAND_WIDTH + MARGIN);
        // Stacked, so the title takes a row rather than width.
        if (title !== "") {
            const heading = el("text");
            heading.setAttribute("x", String(x));
            heading.setAttribute("y", String(startY));
            applyFont(heading, titleFont);
            heading.setAttribute("fill", ink);
            heading.textContent = title;
            group.appendChild(heading);
            startY += ROW_HEIGHT;
        }
        flowTypeColours.order.forEach((type, i) => {
            renderLegendEntry(group, x, startY + i * ROW_HEIGHT,
                labelOfType(type, flowTypeColours),
                hatching ? hatching.ink : (flowTypeColours.colours.get(type) ?? "#999999"),
                SWATCH, SWATCH_GAP, font, ink,
                hatching
                    ? hatching.fills[flowTypeColours.order.indexOf(type) % hatching.fills.length]
                    : typePatterns.get(type),
                measure);
        });
    }

    svg.appendChild(group);
}

/**
 * What a legend entry is called: the colour panel's label for that flow type, or
 * the type's own name. Read from the same object the tooltips read it from, so the
 * legend and a tooltip cannot disagree. The entry's width is measured from this,
 * not from the type name, or a longer label would overlap the next entry.
 */
function labelOfType(type: string, flowTypeColours: FlowTypeColours): string {
    return flowTypeColours.labels?.get(type) ?? type;
}

/** Draws one swatch+label pair anchored at (x, y); returns its approximate pixel width. */
function renderLegendEntry(
    group: SVGGElement,
    x: number,
    y: number,
    label: string,
    colour: string,
    swatchSize: number,
    swatchGap: number,
    font: FontSpec,
    /** The theme's foreground, for the entry's text. */
    ink: string,
    /** The swatch's texture, where it has one: high contrast's hatch or the author's. */
    hatch: string | undefined,
    /** Real text measurement, where the host can supply it (formatting.ts). */
    measure: LabelOptions["measureText"]
): number {
    const rect = el("rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y - swatchSize));
    rect.setAttribute("width", String(swatchSize));
    rect.setAttribute("height", String(swatchSize));
    rect.setAttribute("fill", hatch ?? colour);
    if (hatch) {
        // A hatched swatch needs an outline for the same reason a hatched band does: the
        // texture alone has no edge.
        rect.setAttribute("stroke", colour);
        rect.setAttribute("stroke-width", "1");
    }
    group.appendChild(rect);

    const text = el("text");
    text.setAttribute("x", String(x + swatchSize + swatchGap));
    text.setAttribute("y", String(y));
    applyFont(text, font);
    // The theme's ink, not SVG's default black, so the legend stays readable on a dark
    // report page.
    text.setAttribute("fill", ink);
    text.textContent = label;
    group.appendChild(text);

    // Measured where the host can, so a long flow-type name does not run into the
    // entry beside it. About 6.2px per character is the fallback, as for labels.
    return swatchSize + swatchGap
        + (measure
            ? measure(label, font.size, font.bold, font.family)
            : label.length * 6.2 * font.size / DEFAULT_LEGEND_SIZE);
}
