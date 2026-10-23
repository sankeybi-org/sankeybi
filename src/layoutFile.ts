/**
 * The hand-tuned layout as one file.
 *
 * The placement is the deliverable: a tuned diagram can take an afternoon. The
 * layout lives in hidden visual properties the author cannot see, copy, back up or
 * move, so this module turns it into one JSON document, offered in the node editor
 * as text to copy out and paste back in.
 *
 * - The background picture is deliberately not in it. It can be hundreds of
 *   kilobytes of base64 and has nothing to do with placement; a layout file that
 *   could not be pasted into a text box would not be a layout file.
 * - Each blob is embedded as the object it already is, not as an escaped string, so
 *   the file is readable and a diff shows which node moved. A blob that is not
 *   valid JSON is carried through verbatim as a string rather than dropped.
 * - Import replaces everything and goes through the same total parsers the stored
 *   properties use (`parseNodePositions` and friends), so a hand-edited or
 *   truncated file degrades to "nothing stored" per field rather than breaking the
 *   visual. Nothing here trusts the file.
 */

import { NodeEdits, parseNodeEdits, serialiseNodeEdits } from "./nodeEdits";
import { GridWindow } from "./model";
import { t, tf } from "./i18n";
import {
    NodePositions, parseGridWindow, parseNodePositions, parseRouteOverrides, RouteOverrides,
    serialiseGridWindow, serialiseNodePositions, serialiseRouteOverrides
} from "./positions";

/** The current file format. Bumped only if the shape below changes. */
export const LAYOUT_FILE_VERSION = 1;

/** Everything a layout file carries. */
export interface LayoutContents {
    nodes: NodePositions;
    routes: RouteOverrides;
    grid: GridWindow | undefined;
    edits: NodeEdits;
}

/** A blob as it appears in the file: the parsed object, or the raw text. */
type Embedded = unknown;

/** Embeds a blob as an object where it is JSON, and as text where it is not. */
function embed(blob: string): Embedded {
    if (blob === "") {
        return undefined;
    }
    try {
        return JSON.parse(blob);
    } catch {
        // Unreachable for anything this visual wrote, but a file is a file.
        return blob;
    }
}

/** The inverse: back to the string the stored property holds. */
function unembed(value: Embedded): string {
    if (value === undefined || value === null) {
        return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The file, pretty-printed: it exists to be read, pasted into a text box and put in
 * source control, and two spaces of indent make a diff useful.
 */
export function serialiseLayoutFile(contents: LayoutContents): string {
    return JSON.stringify({
        sankeybiLayout: LAYOUT_FILE_VERSION,
        nodes: embed(serialiseNodePositions(contents.nodes)),
        routes: embed(serialiseRouteOverrides(contents.routes)),
        grid: embed(serialiseGridWindow(contents.grid)),
        nodeEdits: embed(serialiseNodeEdits(contents.edits))
    }, undefined, 2);
}

/**
 * What `parseLayoutFile` found. One type rather than a union: the caller asks one
 * question (did it work, and if not what do I tell the author) and a union makes
 * every call site narrow before it can answer.
 */
export interface LayoutFileResult {
    /** Absent on success; shown to the author otherwise, so it says what to do. */
    message?: string;
    /** Present only where `message` is absent. */
    contents?: LayoutContents;
    /** What was actually found, for the panel to report back. */
    summary?: { nodes: number; routes: number; edits: number; grid: boolean };
}

/**
 * Reads a layout file.
 *
 * It refuses only what it cannot recognise at all: text that is not JSON, or JSON
 * without the marker. Everything past that goes through the stored properties' own
 * total parsers, so a damaged field becomes "nothing stored" for that field and the
 * rest still arrives.
 */
export function parseLayoutFile(text: string): LayoutFileResult {
    const trimmed = (text ?? "").trim();
    if (trimmed === "") {
        return { message: t("ui.layout.pasteFirst", "Paste a layout file into the box first.") };
    }
    let raw: Record<string, unknown>;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return { message: t("ui.layout.notLayout", "That is not a SankeyBI layout file.") };
        }
        raw = parsed as Record<string, unknown>;
    } catch {
        return { message: t("ui.layout.notJson", "That is not valid JSON — paste the whole file, including the braces.") };
    }
    if (typeof raw["sankeybiLayout"] !== "number") {
        return { message: t("ui.layout.noVersion", "That is not a SankeyBI layout file (no \"sankeybiLayout\" version).") };
    }
    // A file from a later version is refused rather than half-read: its fields may
    // mean something else, and quietly importing three of four is worse than saying so.
    if ((raw["sankeybiLayout"] as number) > LAYOUT_FILE_VERSION) {
        return {
            message: tf("ui.layout.newer", "That file was written by a newer version of SankeyBI (format "
                + "{0}, this one reads {1}).", String(raw["sankeybiLayout"]), LAYOUT_FILE_VERSION)
        };
    }
    const contents: LayoutContents = {
        nodes: parseNodePositions(unembed(raw["nodes"])),
        routes: parseRouteOverrides(unembed(raw["routes"])),
        grid: parseGridWindow(unembed(raw["grid"])),
        edits: parseNodeEdits(unembed(raw["nodeEdits"]))
    };
    return {
        contents,
        summary: {
            nodes: contents.nodes.size,
            routes: contents.routes.size,
            edits: contents.edits.size,
            grid: contents.grid !== undefined
        }
    };
}
