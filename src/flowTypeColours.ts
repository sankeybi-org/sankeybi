/**
 * Per-flow-type edits made in the visual: what a flow type is drawn as and what it
 * is called, chosen in the visual's own panel rather than in the data.
 *
 * Why not the format pane. A per-value picker in the pane persists against a data
 * identity, and this data view has none at the grain of one flow type: all the
 * grouping roles go into one `categories` bag, so `identity[i]` identifies the whole
 * grouping tuple at that row (see selection.ts). A picker keyed to that would store
 * a value against one row, so a flow type spanning thirty rows would take it on one
 * of them. The node positions and node edits hit the same wall and have the same
 * answer: one hidden JSON blob, declared in `capabilities.json` so it can be
 * persisted but given no slice, written by a panel in the visual.
 *
 * Precedence: the panel wins. A colour chosen here beats a `FlowColour` from the
 * data, which beats the palette's automatic choice; a label chosen here beats the
 * flow type's own name. `resolveFlowTypeColours` applies both, and nothing else
 * decides either: the legend, the bands, the sub-bands, the hatch order and the
 * tooltips all read the maps it returns, so a second site applying an override is how
 * the legend would stop matching the diagram.
 *
 * Unset means follow the data. That lets the panel prefill every row with what is
 * actually being drawn and still tell "this is what you are getting" from "this is
 * what you asked for". A field only lands in the blob once the author sets it, and
 * clearing one removes it rather than storing the data's value, otherwise a
 * measure-bound `FlowColour` would be frozen at whatever it was the day somebody
 * opened the panel.
 *
 * Edits for a flow type no longer in the data are kept, as positions and node edits
 * are: a slicer can take a type away and bring it back.
 */

import { TEXTURE_COUNT } from "./textures";

/** What the panel may change about one flow type. */
export interface FlowTypeEdit {
    /** `#RRGGBB`. Beats a `FlowColour` from the data. */
    colour?: string;
    /** What the legend and the tooltips call this type, instead of its own name. */
    label?: string;
    /**
     * A texture instead of a flat fill, as an index into the six hatches.
     *
     * They are the same six textures high contrast uses, but drawn in the flow type's
     * own colour on the report background rather than in the theme's ink, so the result
     * reads as a hatched version of the flow. They are ignored in high contrast, where
     * the mode assigns its own hatch per type.
     *
     * `FLOW_PATTERN_NONE` means flat by choice, which is not the same as absent: absent
     * means "follow the pane", and the pane can ask for a texture on every type, so an
     * author needs a way to say "not this one" that the pane default does not fill back
     * in. Absent still draws flat, because the pane setting defaults to None.
     */
    pattern?: number;
    /**
     * The colour the texture is drawn in (`#RRGGBB`), instead of whatever the pane gives it.
     * It only means something on a type that has a texture.
     */
    ink?: string;
    /** The colour behind the texture (`#RRGGBB`), instead of whatever the pane gives it. */
    paper?: string;
    /**
     * An outline on the flow's long edges, solid or dashed.
     *
     * This is the publication convention for a flow that is projected, estimated or
     * otherwise not measured: the band keeps its colour and gains a dashed edge. It is
     * drawn on `RoutedBand.edges` (the two long edges, never the ends), so a flow still
     * runs continuously into its node and its arrow head, and it uses the theme's ink
     * like a label, because the flow's own colour against its own fill would be
     * invisible.
     *
     * High contrast already outlines every band in the foreground, so an author's
     * choice there would say nothing; it is ignored, as the texture is.
     *
     * `"none"` is no edge by choice, for the same reason as `FLOW_PATTERN_NONE`.
     */
    outline?: "solid" | "dashed" | "none";
}

/** Flow type name -> its edits. */
export type FlowTypeEdits = Map<string, FlowTypeEdit>;

/**
 * Longest flow type name kept as a key. Flow types are category values, and a key
 * longer than this is a mistake rather than a name.
 */
const MAX_FLOW_TYPE_KEY = 200;

/** Longest label kept. A legend entry is one line; anything longer is a mistake. */
const MAX_FLOW_TYPE_LABEL = 200;

/**
 * How many textures there are to choose from: the hatches and the graphic patterns, one
 * index space (see `textures.ts`).
 */
export const FLOW_PATTERN_COUNT = TEXTURE_COUNT;

/**
 * "Flat, and I mean it": the stored value that holds a type's texture off against
 * a pane asking for one.
 *
 * It is a sentinel in the same field rather than a separate field, because the three
 * states are one choice made in one control: follow the pane (absent), flat (this),
 * or texture `n`. Two fields would allow "flat and texture 3" to be stored at once,
 * which the control cannot express.
 */
export const FLOW_PATTERN_NONE = -1;

/**
 * The most types stored. They travel in the report, and a diagram with more flow
 * types than this has stopped being readable long before: the legend cycles its
 * hatches at six in high contrast, and `getColor` cycles its palette too.
 */
export const MAX_FLOW_TYPE_COLOURS = 200;

const isHexColour = (v: unknown): v is string =>
    typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/**
 * Reads the blob. It is total, as every blob here: a field of the wrong shape is
 * dropped on its own rather than failing the lot, an entry left with nothing is
 * dropped, and entries past the cap are dropped in the blob's own order so the
 * result is stable.
 */
export function parseFlowTypeColours(raw: unknown): FlowTypeEdits {
    const out: FlowTypeEdits = new Map();
    if (typeof raw !== "string" || raw.trim() === "") {
        return out;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return out;
    }
    Object.entries(parsed as Record<string, unknown>).forEach(([type, value]) => {
        if (out.size >= MAX_FLOW_TYPE_COLOURS || type === "" || type.length > MAX_FLOW_TYPE_KEY) {
            return;
        }
        const edit: FlowTypeEdit = {};
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const v = value as Record<string, unknown>;
            if (isHexColour(v.c)) {
                edit.colour = v.c.toLowerCase();
            }
            if (typeof v.l === "string" && v.l.trim() !== "") {
                edit.label = v.l.slice(0, MAX_FLOW_TYPE_LABEL);
            }
            if (typeof v.p === "number" && Number.isInteger(v.p)
                && v.p >= FLOW_PATTERN_NONE && v.p < FLOW_PATTERN_COUNT) {
                edit.pattern = v.p;
            }
            if (isHexColour(v.f)) {
                edit.ink = v.f.toLowerCase();
            }
            if (isHexColour(v.b)) {
                edit.paper = v.b.toLowerCase();
            }
            if (v.o === "solid" || v.o === "dashed" || v.o === "none") {
                edit.outline = v.o;
            }
        }
        if (edit.colour !== undefined || edit.label !== undefined
            || edit.pattern !== undefined || edit.outline !== undefined
            || edit.ink !== undefined || edit.paper !== undefined) {
            out.set(type, edit);
        }
    });
    return out;
}

export function serialiseFlowTypeColours(edits: FlowTypeEdits): string {
    const out: Record<string, Record<string, string | number>> = {};
    edits.forEach((edit, type) => {
        const e: Record<string, string | number> = {};
        if (isHexColour(edit.colour)) {
            e.c = edit.colour.toLowerCase();
        }
        if (edit.label !== undefined && edit.label.trim() !== "") {
            e.l = edit.label.slice(0, MAX_FLOW_TYPE_LABEL);
        }
        if (edit.pattern !== undefined && Number.isInteger(edit.pattern)
            && edit.pattern >= FLOW_PATTERN_NONE && edit.pattern < FLOW_PATTERN_COUNT) {
            e.p = edit.pattern;
        }
        if (isHexColour(edit.ink)) {
            e.f = edit.ink.toLowerCase();
        }
        if (isHexColour(edit.paper)) {
            e.b = edit.paper.toLowerCase();
        }
        if (edit.outline === "solid" || edit.outline === "dashed" || edit.outline === "none") {
            e.o = edit.outline;
        }
        if (Object.keys(e).length > 0) {
            out[type] = e;
        }
    });
    return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}

/**
 * Normalised to lower case so the panel's comparison of what is stored against what
 * a picker reports cannot differ by case.
 */
export function withFlowTypeEdit(
    edits: FlowTypeEdits,
    type: string,
    patch: {
        colour?: string | null;
        label?: string | null;
        pattern?: number | null;
        ink?: string | null;
        paper?: string | null;
        outline?: "solid" | "dashed" | "none" | null;
    }
): FlowTypeEdits {
    if (type === "" || type.length > MAX_FLOW_TYPE_KEY) {
        return edits;
    }
    const next: FlowTypeEdits = new Map(edits);
    const current = next.get(type);
    const edit: FlowTypeEdit = { ...(current ?? {}) };

    if (patch.colour === null) {
        delete edit.colour;
    } else if (patch.colour !== undefined && isHexColour(patch.colour)) {
        edit.colour = patch.colour.toLowerCase();
    }
    if (patch.label === null || (typeof patch.label === "string" && patch.label.trim() === "")) {
        delete edit.label;
    } else if (typeof patch.label === "string") {
        edit.label = patch.label.slice(0, MAX_FLOW_TYPE_LABEL);
    }

    if (patch.pattern === null) {
        delete edit.pattern;
    } else if (typeof patch.pattern === "number" && Number.isInteger(patch.pattern)
        && patch.pattern >= FLOW_PATTERN_NONE && patch.pattern < FLOW_PATTERN_COUNT) {
        edit.pattern = patch.pattern;
    }

    if (patch.ink === null) {
        delete edit.ink;
    } else if (patch.ink !== undefined && isHexColour(patch.ink)) {
        edit.ink = patch.ink.toLowerCase();
    }
    if (patch.paper === null) {
        delete edit.paper;
    } else if (patch.paper !== undefined && isHexColour(patch.paper)) {
        edit.paper = patch.paper.toLowerCase();
    }

    if (patch.outline === null) {
        delete edit.outline;
    } else if (patch.outline === "solid" || patch.outline === "dashed"
        || patch.outline === "none") {
        edit.outline = patch.outline;
    }

    if (edit.colour === undefined && edit.label === undefined
        && edit.pattern === undefined && edit.outline === undefined
        && edit.ink === undefined && edit.paper === undefined) {
        next.delete(type);
    } else if (current !== undefined || next.size < MAX_FLOW_TYPE_COLOURS) {
        next.set(type, edit);
    }
    return next;
}

/**
 * Sets or clears fields of one flow type's edit, returning a new map.
 *
 * `null` for a field clears it, which means "follow the data again"; that is a
 * removal rather than a stored copy of the data's value (see the module comment).
 * `undefined` leaves a field as it was, so the colour and the label can be changed
 * independently. An entry left with neither is dropped.
 */
export function flowTypeLabel(
    type: string,
    labels: ReadonlyMap<string, string> | undefined
): string {
    return labels?.get(type) ?? type;
}
