/**
 * Background picture and snap grid.
 */

import { BackgroundFilter } from "./background";
import { LayoutResult, PixelRect } from "./model";
import { el } from "./renderSupport";

/** Grid line weights and opacities: faint enough to sit under the diagram. */
const GRID_MINOR_WIDTH = 0.5;

const GRID_MAJOR_WIDTH = 1;

const GRID_MINOR_OPACITY = 0.1;

const GRID_MAJOR_OPACITY = 0.22;

/** Below this spacing in pixels a sub-grid reads as a wash, so it is not drawn. */
const MIN_GRID_SPACING = 6;

/** What render needs to paint the background picture. */
export interface BackgroundPaint {
    /** A base64 data URL that `parseBackground` has already vetted. */
    url: string;
    /** 0 (opaque) to 100 (invisible). */
    transparency: number;
    /** A colour treatment (background.ts); none or absent draws it as it is. */
    filter?: BackgroundFilter;
}

/** One filter per visual: each visual is its own iframe, so the id cannot clash. */
const BACKGROUND_FILTER_ID = "sankeybi-bg-filter";

/**
 * The colour treatment as an SVG filter. It uses `sRGB` interpolation, since the default
 * linearRGB would shift every colour the author picked. Luma coefficients are Rec. 709; the
 * component transfer then maps luma 0..1 onto the dark..light colour per channel. Alpha passes
 * through untouched.
 */
function backgroundFilterElement(filter: BackgroundFilter): SVGFilterElement | undefined {
    if (filter.kind === "none") {
        return undefined;
    }
    const element = el("filter");
    element.setAttribute("id", BACKGROUND_FILTER_ID);
    element.setAttribute("color-interpolation-filters", "sRGB");
    const luma = el("feColorMatrix");
    if (filter.kind === "greyscale") {
        luma.setAttribute("type", "saturate");
        luma.setAttribute("values", "0");
        element.appendChild(luma);
        return element;
    }
    const row = "0.2126 0.7152 0.0722 0 0";
    luma.setAttribute("type", "matrix");
    luma.setAttribute("values", `${row} ${row} ${row} 0 0 0 1 0`);
    element.appendChild(luma);
    const transfer = el("feComponentTransfer");
    ([["feFuncR", filter.r], ["feFuncG", filter.g], ["feFuncB", filter.b]] as const).forEach(([tag, ends]) => {
        const func = el(tag);
        func.setAttribute("type", "table");
        func.setAttribute("tableValues", `${ends[0]} ${ends[1]}`);
        transfer.appendChild(func);
    });
    element.appendChild(transfer);
    return element;
}

/**
 * The background picture, as an `<image>`: an SVG drawn this way runs no script and loads
 * nothing external (see background.ts). The rectangle has the picture's own aspect already
 * (layout letterboxed it), so "none" only matters where the file gave no size, and then it
 * fills the frame. It is never a pointer target: a click on the map is a click on the
 * background.
 */
export function renderBackground(
    svg: SVGSVGElement,
    rect: PixelRect,
    paint: BackgroundPaint,
    /**
     * The `<image>` from the last render, when it is carrying this same picture. It is reused
     * rather than replaced: its `href` is a base64 data URL of up to 500KB, and a fresh element
     * would make the browser decode the picture again on every settings change and every tick of a
     * resize. Everything else here is set below, so a reused element ends up in exactly the state a
     * new one would.
     */
    existing?: SVGImageElement
): void {
    const filter = paint.filter ? backgroundFilterElement(paint.filter) : undefined;
    if (filter) {
        const defs = el("defs");
        defs.appendChild(filter);
        svg.appendChild(defs);
    }
    const image = existing ?? el("image");
    image.setAttribute("class", "sankeybi-background");
    image.setAttribute("x", String(rect.x));
    image.setAttribute("y", String(rect.y));
    image.setAttribute("width", String(Math.max(0, rect.width)));
    image.setAttribute("height", String(Math.max(0, rect.height)));
    image.setAttribute("preserveAspectRatio", "none");
    image.setAttribute("href", paint.url);
    image.setAttribute("opacity", String(1 - Math.max(0, Math.min(100, paint.transparency || 0)) / 100));
    image.setAttribute("pointer-events", "none");
    if (filter) {
        image.setAttribute("filter", `url(#${BACKGROUND_FILTER_ID})`);
    } else if (existing && typeof existing.removeAttribute === "function") {
        // A reused element may still carry the last render's treatment.
        existing.removeAttribute("filter");
    }
    svg.appendChild(image);
}

/**
 * The snap grid, drawn behind everything while editing.
 *
 * Positions come from computeLayout's own transform rather than a second opinion about where
 * the grid is, so a line lands exactly where a dragged node snaps: the same reason
 * gridPositionOf/pixelPositionOf live beside computeLayout. Whole columns and rows are drawn
 * heavier than the sub-steps, so the structure still reads through the detail.
 *
 * Colour is the theme's foreground at low opacity rather than a chosen grey, which keeps it
 * faint on a light theme and on a dark one. In high contrast subtlety is exactly wrong, so it
 * goes solid there.
 */
export function renderGrid(
    svg: SVGSVGElement,
    layout: LayoutResult,
    viewportWidth: number,
    viewportHeight: number,
    /** The Snap to grid slider: how many steps a cell is divided into. 0 = free placement. */
    snapDivisions: number,
    colour: string,
    highContrast: boolean
): void {
    const { columnGap, rowPitch, contentLeft, contentTop, originColumn, originRow,
        columnSign, rowSign } = layout;
    if (!(columnGap > 0) || !(rowPitch > 0)) {
        return; // a degenerate layout has no grid to show
    }

    const group = el("g");
    group.setAttribute("class", "sankeybi-grid");
    // Nothing here is a click target: the grid is a backdrop, and swallowing clicks would break
    // selection and background-clear-to-deselect.
    group.setAttribute("pointer-events", "none");

    const line = (x1: number, y1: number, x2: number, y2: number, major: boolean): void => {
        const l = el("line");
        l.setAttribute("x1", String(x1));
        l.setAttribute("y1", String(y1));
        l.setAttribute("x2", String(x2));
        l.setAttribute("y2", String(y2));
        l.setAttribute("stroke", colour);
        l.setAttribute("stroke-width", String(major ? GRID_MAJOR_WIDTH : GRID_MINOR_WIDTH));
        l.setAttribute("stroke-opacity", String(highContrast
            ? (major ? 1 : 0.6)
            : (major ? GRID_MAJOR_OPACITY : GRID_MINOR_OPACITY)));
        group.appendChild(l);
    };

    /**
     * One axis' worth of lines. It is stepped in grid coordinates from the first step inside the
     * viewport, not from the origin: the view is fitted to the content, so the origin is usually
     * fractional, and stepping from it would put every line between the places a drop can snap to.
     * It covers the whole viewport rather than the diagram's extent, so a node dragged past the old
     * edge still has grid under it.
     *
     * A sub-step finer than MIN_GRID_SPACING pixels is dropped rather than drawn: below that it
     * reads as a wash rather than a grid, and on a big diagram at a fine snap it would be thousands
     * of lines.
     */
    const axis = (origin: number, offset: number, pitch: number, sign: 1 | -1, extent: number,
        draw: (at: number, major: boolean) => void): void => {
        const step = snapDivisions >= 1 ? 1 / Math.floor(snapDivisions) : 1;
        const fine = step < 1 && step * pitch >= MIN_GRID_SPACING ? step : 1;
        // On a reversed axis the viewport's low pixel edge is the high grid coordinate, so the two ends
        // are ordered rather than taken as they come; unordered, `first` would exceed `last` and no
        // grid would be drawn at all. The pitch itself carries the sign, as the mapping does.
        const signed = pitch * sign;
        const ends = [(origin + (0 - offset) / signed) / fine, (origin + (extent - offset) / signed) / fine];
        const first = Math.ceil(Math.min(...ends) - 1e-9);
        const last = Math.floor(Math.max(...ends) + 1e-9);
        for (let k = first; k <= last; k++) {
            // Counted in whole steps and multiplied out, so a third stays a third however many are added
            // up.
            const coordinate = k * fine;
            const at = offset + (coordinate - origin) * pitch * sign;
            if (at < -1e-6 || at > extent + 1e-6) {
                continue;
            }
            // Whole columns and rows carry the weight. Compared against the grid coordinate, not the
            // pixel, so it stays right at any zoom.
            draw(at, Math.abs(coordinate - Math.round(coordinate)) < 1e-6);
        }
    };

    axis(originColumn, contentLeft, columnGap, columnSign, viewportWidth,
        (x, major) => line(x, 0, x, viewportHeight, major));
    axis(originRow, contentTop, rowPitch, rowSign, viewportHeight,
        (y, major) => line(0, y, viewportWidth, y, major));

    svg.appendChild(group);
}
