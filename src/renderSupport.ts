/**
 * Small helpers shared by the rendering modules: creating SVG elements, theme
 * colours, text ink and fonts.
 */

import { DEFAULT_FONT_FAMILY, FontSpec } from "./model";
import ISandboxExtendedColorPalette = powerbi.extensibility.ISandboxExtendedColorPalette;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Creates an SVG element in the SVG namespace. */
export function el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
    return document.createElementNS(SVG_NS, tag);
}

export function addTooltip(node: SVGElement, text: string): void {
    const title = el("title");
    title.textContent = text;
    node.appendChild(title);
}

/**
 * The colour a node is drawn in when the data does not name one. It is taken from
 * the theme rather than from a picker: node colour is set in the data or left to
 * the theme, and a third place to say it only invited the three to disagree.
 */
export function themeNodeColour(colorPalette: ISandboxExtendedColorPalette): string {
    const neutral = colorPalette.isHighContrast
        ? colorPalette.foreground
        : colorPalette.foregroundNeutralSecondary;
    return neutral?.value ?? "#605E5C";
}

/**
 * The ink for a label drawn inside a shape, chosen against the fill it sits on.
 *
 * Only decidable when the fill is a hex colour: a per-node colour may be any CSS
 * colour name, and resolving one to channels needs a live DOM. `undefined` means
 * "no opinion", and the caller falls back to the theme foreground, which is also
 * right for a transparent shape, where the text sits on the report page.
 *
 * It uses sRGB relative luminance with a threshold of 0.55 rather than 0.5, because
 * mid-tone fills read better with white on them than black.
 */
export function inkOn(fill: string | undefined): string | undefined {
    if (fill === undefined) {
        return undefined;
    }
    const hex = fill.trim();
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    let rgb: number[];
    if (short) {
        rgb = [short[1], short[2], short[3]].map(c => parseInt(c + c, 16));
    } else if (long) {
        rgb = [long[1], long[2], long[3]].map(c => parseInt(c, 16));
    } else {
        return undefined;
    }
    const [r, g, b] = rgb.map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#000000" : "#ffffff";
}

/**
 * Applies a font to a text element. This is the only place that does, so a drawn
 * size and a measured size cannot drift apart.
 */
export function applyFont(text: SVGTextElement, font: FontSpec, size = font.size): void {
    text.setAttribute("font-family", font.family);
    text.setAttribute("font-size", String(size));
    if (font.bold) {
        text.setAttribute("font-weight", "bold");
    }
    if (font.italic) {
        text.setAttribute("font-style", "italic");
    }
}

/**
 * A card's text colour: the author's colour where they chose one, otherwise
 * `undefined` to mean "decide automatically".
 *
 * The reads are optional because the checks build settings by hand, and an absent
 * card must behave as Automatic does.
 */
export function textColourFrom(
    card: { colourMode?: { value?: { value?: unknown } }; colour?: { value?: { value?: string } } }
        | undefined
): string | undefined {
    return String(card?.colourMode?.value?.value) === "Custom"
        ? card?.colour?.value?.value
        : undefined;
}

/** A font control's four properties, with the given size as the default. */
export function fontFrom(
    card: { fontFamily?: { value?: string }; fontSize?: { value?: number };
        bold?: { value?: boolean }; italic?: { value?: boolean } } | undefined,
    size: number
): FontSpec {
    return {
        family: card?.fontFamily?.value || DEFAULT_FONT_FAMILY,
        size: card?.fontSize?.value ?? size,
        bold: card?.bold?.value ?? false,
        italic: card?.italic?.value ?? false
    };
}
