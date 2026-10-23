/**
 * Background image: a map or picture drawn behind the diagram.
 *
 * Three decisions shape this file.
 *
 * The image is imported inside the visual and stored as a hidden blob. The format
 * pane cannot carry it: its image-upload slice has no property type to declare in
 * `capabilities.json`, and its text boxes stop at a few hundred characters. So the
 * visual reads a picked or pasted file itself and persists it like the position
 * blobs.
 *
 * It is drawn as an `<image>` from a data URL and never inserted into the page. An
 * SVG used as an image runs no script and fetches nothing, and its styles cannot
 * reach the visual's. The text is only read here, as a string, to find its size;
 * nothing parses it into a document, and nothing uses `innerHTML`.
 *
 * There is a hard size limit. The image travels inside the report and with every
 * update the host sends, so `MAX_BACKGROUND_BYTES` refuses a file rather than
 * letting a large map slow every redraw.
 */

import { PixelRect } from "./model";
import { t, tf } from "./i18n";

/** The largest file accepted, in bytes. The stored data URL is about 4/3 of this. */
export const MAX_BACKGROUND_BYTES = 500 * 1024;

export interface BackgroundImage {
    /** `data:<type>;base64,...`, the only form ever drawn. */
    url: string;
    /** Intrinsic size, for the aspect ratio. 0 where the file does not say. */
    width: number;
    height: number;
    /** The file's name, for the format pane's status line. */
    name: string;
    /** Size of the original file in bytes. */
    bytes: number;
}

export type ImportResult = { image: BackgroundImage } | { error: string };

const URL_PATTERN = /^data:image\/(svg\+xml|png|jpeg);base64,[A-Za-z0-9+/]*={0,2}$/;
const MAX_URL_LENGTH = "data:image/svg+xml;base64,".length + Math.ceil(MAX_BACKGROUND_BYTES / 3) * 4;

/** "512 KB": what the status line and the refusal say. */
export function formatBytes(bytes: number): string {
    return bytes < 1024 ? tf("ui.bytes", "{0} bytes", bytes) : tf("ui.kilobytes", "{0} KB", Math.round(bytes / 1024));
}

export function tooBigMessage(bytes: number, limit = MAX_BACKGROUND_BYTES): string {
    return tf("ui.fileTooBig", "That file is {0}; the limit is {1}. "
        + "Simplify the map first (mapshaper.org, for example), or export a smaller image.",
        formatBytes(bytes), formatBytes(limit));
}

function base64Of(bytes: Uint8Array): string {
    // Chunked: String.fromCharCode over half a megabyte at once overflows the
    // argument limit in some engines.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
}

/**
 * An SVG's root start tag, past any BOM, XML declaration, comments,
 * processing instructions and DOCTYPE. Quoted attribute values may hold `>`.
 */
const ROOT_TAG = /^\uFEFF?(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>)*<svg(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/i;

function attribute(attributes: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);
    return match ? (match[2] ?? match[3]) : undefined;
}

/**
 * A length in user units: a plain number or `px`. Anything relative (%, em) says
 * nothing.
 */
function lengthOf(value: string | undefined): number {
    const match = value ? /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(value) : null;
    const n = match ? Number(match[1]) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * An SVG's text as a background. Its size comes from the `viewBox`, else from
 * `width` and `height`. An SVG with a size but no viewBox is given one: used as an
 * image, such an SVG is drawn at its own size and cropped rather than scaled to the
 * box it is put in.
 */
export function backgroundFromSvgText(text: string, name = "pasted SVG", limit = MAX_BACKGROUND_BYTES): ImportResult {
    const utf8 = new TextEncoder().encode(text);
    if (utf8.length > limit) {
        return { error: tooBigMessage(utf8.length, limit) };
    }
    const root = ROOT_TAG.exec(text);
    if (!root) {
        return { error: t("ui.notSvg", "That doesn't look like an SVG: it has to start with an <svg> element.") };
    }
    const attributes = root[1];
    let width = 0;
    let height = 0;
    const viewBox = attribute(attributes, "viewBox");
    const box = viewBox ? viewBox.trim().split(/[\s,]+/).map(Number) : [];
    let source = text;
    if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
        width = box[2];
        height = box[3];
    } else {
        width = lengthOf(attribute(attributes, "width"));
        height = lengthOf(attribute(attributes, "height"));
        if (width > 0 && height > 0) {
            const at = root.index + root[0].length - root[1].length - 1;
            source = `${text.slice(0, at)} viewBox="0 0 ${width} ${height}"${text.slice(at)}`;
        } else {
            width = 0;
            height = 0;
        }
    }
    const encoded = source === text ? utf8 : new TextEncoder().encode(source);
    return {
        image: {
            url: `data:image/svg+xml;base64,${base64Of(encoded)}`,
            width, height, name, bytes: utf8.length
        }
    };
}

/** PNG: the IHDR chunk always comes first, width and height big-endian at 16 and 20. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
    if (bytes.length < 24) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** JPEG: walk the segments to the first start-of-frame marker. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
    let at = 2;
    while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xFF) {
            return undefined;
        }
        const marker = bytes[at + 1];
        if (marker === 0xFF) {
            at++;
            continue;
        }
        const length = (bytes[at + 2] << 8) | bytes[at + 3];
        // SOF0..SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range.
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
        }
        if (length < 2) {
            return undefined;
        }
        at += 2 + length;
    }
    return undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/**
 * A picked file's bytes as a background: PNG and JPEG by their signatures,
 * anything else read as SVG text. The type comes from the CONTENT, never from
 * the file name, so a renamed file is still what it is.
 */
export function backgroundFromBytes(bytes: Uint8Array, name: string): ImportResult {
    if (bytes.length > MAX_BACKGROUND_BYTES) {
        return { error: tooBigMessage(bytes.length) };
    }
    const isPng = PNG_SIGNATURE.every((b, i) => bytes[i] === b);
    const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    if (isPng || isJpeg) {
        const size = isPng ? pngSize(bytes) : jpegSize(bytes);
        if (!size || size.width <= 0 || size.height <= 0) {
            return { error: isPng ? t("ui.pngDamaged", "That PNG file looks damaged: its size can't be read.")
                : t("ui.jpegDamaged", "That JPEG file looks damaged: its size can't be read.") };
        }
        return {
            image: {
                url: `data:image/${isPng ? "png" : "jpeg"};base64,${base64Of(bytes)}`,
                width: size.width, height: size.height, name, bytes: bytes.length
            }
        };
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return { error: t("ui.notImage", "That file isn't an SVG, PNG or JPEG.") };
    }
    const result = backgroundFromSvgText(text, name);
    return "error" in result && !ROOT_TAG.test(text)
        ? { error: t("ui.notImage", "That file isn't an SVG, PNG or JPEG.") }
        : result;
}

/**
 * Reads the persisted blob. Total, like every blob here — and it is also the
 * last line of defence: the report file can be edited by hand, so only a
 * base64 data URL of one of the three image types, within the size limit, is
 * ever handed to the renderer. Anything else is "no background".
 */
export function parseBackground(raw: unknown): BackgroundImage | undefined {
    if (typeof raw !== "string" || raw.trim() === "") {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
    }
    const { url, w, h, name, bytes } = parsed as Record<string, unknown>;
    if (typeof url !== "string" || url.length > MAX_URL_LENGTH || !URL_PATTERN.test(url)) {
        return undefined;
    }
    const size = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    const width = size(w);
    const height = size(h);
    return {
        url,
        width: width > 0 && height > 0 ? width : 0,
        height: width > 0 && height > 0 ? height : 0,
        name: typeof name === "string" ? name.slice(0, 200) : "",
        bytes: size(bytes)
    };
}

export function serialiseBackground(image: BackgroundImage | undefined): string {
    return image
        ? JSON.stringify({ url: image.url, w: image.width, h: image.height, name: image.name, bytes: image.bytes })
        : "";
}

/** width / height, or 0 when the image does not say. */
export function aspectOf(image: BackgroundImage | undefined): number {
    return image && image.width > 0 && image.height > 0 ? image.width / image.height : 0;
}

/**
 * The largest rectangle of this aspect that fits in `box`, centred — the
 * letterbox every fixed-aspect picture gets. An aspect of 0 fills the box.
 */
export function letterbox(box: PixelRect, aspect: number): PixelRect {
    if (!(aspect > 0) || box.width <= 0 || box.height <= 0) {
        return { ...box };
    }
    const width = Math.min(box.width, box.height * aspect);
    const height = width / aspect;
    return {
        x: box.x + (box.width - width) / 2,
        y: box.y + (box.height - height) / 2,
        width,
        height
    };
}

/**
 * Recolouring: whole-picture treatments, applied as an SVG filter on the drawn
 * `<image>`, so they work the same on SVG, PNG and JPEG and never touch the stored
 * file. Colouring individual regions is the author's job in their own map tool: map
 * SVGs say colour in too many ways (attributes, styles, classes, gradients) to rewrite
 * reliably.
 *
 * Tint and Duotone work from brightness (Rec. 709 luma): the darkest parts take the
 * dark colour, the lightest the light one, linearly between. Tint is Duotone with a
 * white light end. Alpha is untouched, so a transparent sea stays transparent.
 */
export type BackgroundFilter =
    | { kind: "none" }
    | { kind: "greyscale" }
    /** Per channel, the value luma 0 and luma 1 map to, each 0..1. */
    | { kind: "duotone"; r: [number, number]; g: [number, number]; b: [number, number] };

/** #RGB or #RRGGBB to 0..1 channels; undefined for anything else. */
export function channelsOf(hex: string): [number, number, number] | undefined {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
    if (!m) {
        return undefined;
    }
    const h = m[1].length === 3 ? m[1].split("").map(c => c + c).join("") : m[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/**
 * The filter for a mode. A colour that cannot be read (a CSS name, say)
 * falls back to the picture as it is rather than to a guess.
 */
export function backgroundFilterOf(mode: string, dark: string, light: string): BackgroundFilter {
    if (mode === "Greyscale") {
        return { kind: "greyscale" };
    }
    if (mode !== "Tint" && mode !== "Duotone") {
        return { kind: "none" };
    }
    const lo = channelsOf(dark);
    const hi = mode === "Tint" ? [1, 1, 1] : channelsOf(light);
    if (!lo || !hi) {
        return { kind: "none" };
    }
    return { kind: "duotone", r: [lo[0], hi[0]], g: [lo[1], hi[1]], b: [lo[2], hi[2]] };
}

/**
 * Node icons: small SVGs drawn as part of a node's label. They get the same vetting as
 * the background (an icon is only ever drawn as a base64 SVG data URL this file
 * produced) with a much smaller limit, because an icon column repeats on every row of
 * the table Power BI sends.
 */
export const MAX_ICON_BYTES = 20 * 1024;

const ICON_URL_PATTERN = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]*={0,2}$/;
const MAX_ICON_URL_LENGTH = "data:image/svg+xml;base64,".length + Math.ceil(MAX_ICON_BYTES / 3) * 4 + 64;

/**
 * An icon from a data cell (or, later, the node editor): the SVG text itself,
 * or an SVG data URL in either encoding — `;base64,` or percent-encoded, the
 * two forms Power BI authors build images in a table with. Whatever arrives,
 * what comes back is re-encoded here, so nothing the cell said is drawn as is.
 */
export function iconFromText(raw: string): ImportResult {
    const text = raw.trim();
    let svg = text;
    const dataUrl = /^data:image\/svg\+xml(;[^,]*)?,/i.exec(text);
    if (dataUrl) {
        const body = text.slice(dataUrl[0].length);
        try {
            if (/;base64/i.test(dataUrl[1] ?? "")) {
                const binary = atob(body.replace(/\s+/g, ""));
                svg = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
            } else {
                svg = decodeURIComponent(body);
            }
        } catch {
            return { error: t("ui.iconUndecodable", "That icon's data URL can't be decoded.") };
        }
    } else if (/^data:/i.test(text)) {
        return { error: t("ui.iconsMustBeSvg", "Icons must be SVG.") };
    }
    return backgroundFromSvgText(svg, "icon", MAX_ICON_BYTES);
}

/** The last line of defence for an icon about to be drawn: only what `iconFromText` makes. */
export function isVettedIcon(url: unknown): url is string {
    return typeof url === "string" && url.length <= MAX_ICON_URL_LENGTH && ICON_URL_PATTERN.test(url);
}
