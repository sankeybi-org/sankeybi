/**
 * Flow-type colours, labels, textures and outlines, resolved once for the whole
 * diagram.
 */

import powerbi from "powerbi-visuals-api";
import ISandboxExtendedColorPalette = powerbi.extensibility.ISandboxExtendedColorPalette;

import { Corridor } from "./model";
import { FLOW_PATTERN_NONE, FlowTypeEdits } from "./flowTypeColours";
import { autoHatch, autoPattern } from "./textures";

/**
 * What the format pane asks for beneath whatever the editor says: Flows > Colour >
 * Texture and Outline. One object rather than extra positional arguments, so every
 * caller of `resolveFlowTypeColours` that builds only the first few keeps working.
 */
export interface FlowPaintDefaults {
    /** "Hatching" or "Pattern" gives every type a texture of that family, allocated in legend order. */
    texture?: "Hatching" | "Pattern" | "None" | string;
    /** An edge on every flow. */
    outline?: "Solid" | "Dashed" | "None" | string;
}

/**
 * A flow type is a global category, so its colour is resolved once across the whole
 * diagram, not per corridor. Otherwise the same type could get two colours in two
 * corridors and the legend would not match what is drawn. Both the legend and the
 * corridor rendering read this one map.
 */
export interface FlowTypeColours {
    /** FlowType name -> resolved hex/colour string, in legend order. */
    colours: Map<string, string>;
    /**
     * Flow type name to what the data's `FlowColour` said, for the types that set one.
     * The colour panel uses it to tell an author where a colour came from and to offer
     * to go back to it; `colours` has already applied the precedence, so it cannot answer
     * that on its own.
     */
    dataColours: Map<string, string>;
    /**
     * Flow type name to what the panel says to call it, for the types that are given a
     * label. Absent means the type's own name is used. The legend and the tooltips both
     * read it, so they cannot disagree about what a type is called; it reaches the
     * tooltips as `LabelOptions.flowTypeLabels`.
     */
    /**
     * Optional, because the checks build this object by hand. Absent reads as "no type
     * has one", which is the right default.
     */
    labels?: Map<string, string>;
    /**
     * Flow type name to the texture index the panel gives it, for the types that have
     * one. Absent means a flat fill. The bands, the arrows and the legend all read it, so
     * a swatch cannot show a texture its band does not.
     */
    patterns?: Map<string, number>;
    /**
     * Flow type name to the texture colour and the colour behind it that the editor sets, for
     * the types that set one. Only what is stored: the pane's own choices are applied where
     * the texture is drawn (`textureColours`).
     */
    inks?: Map<string, string>;
    papers?: Map<string, string>;
    /** Flow type name to the outline style the panel gives it. Absent means no outline. */
    outlines?: Map<string, "solid" | "dashed">;
    /**
     * What the pane asks for, before any per-type choice.
     *
     * Render draws it on a flow with no type at all: everything above is keyed by flow
     * type, and a flow has none when no Flow type field is bound, which is exactly the
     * case where Flows > Colour > Outline would otherwise do nothing. The editor reads it
     * to label its own Auto option with what Auto currently means.
     */
    paneOutline?: "solid" | "dashed";
    /**
     * Flow type name to the texture the pane would give it, whatever the editor says.
     * Empty unless Flows > Colour > Texture is Automatic.
     *
     * It is computed here so the allocation rule (the type's legend rank, modulo the
     * texture count) lives in one place. The editor needs it to say `Auto (Forward)`
     * rather than a bare `Auto`.
     */
    autoPatterns?: Map<string, number>;
    /** See `legendOrder`: FlowDisplayOrder, then the locale's alphabet. */
    order: string[];
    warnings: string[];
}

export function resolveFlowTypeColours(
    corridors: Corridor[],
    colorPalette: ISandboxExtendedColorPalette,
    /** The host's locale, so the alphabetical tiebreak is the viewer's alphabet. */
    locale?: string,
    /**
     * Colours picked in the visual's own panel, which beat the data. See
     * flowTypeColours.ts for why they live in a blob rather than in the format pane, and
     * why an unset type is absent here rather than carrying the data's colour.
     *
     * They are applied in this one function because it is the only place that decides
     * what colour a flow type is.
     */
    overrides?: FlowTypeEdits,
    /**
     * What the format pane asks for, applied under the panel's own choices. It is here
     * rather than in render because this is the only function that decides what a flow
     * type is drawn as.
     */
    defaults?: FlowPaintDefaults
): FlowTypeColours {
    const overrideByType = new Map<string, string>();
    const displayOrderByType = new Map<string, number>();
    /** Flow type to the order it was first met in, for the final tiebreak only. */
    const firstSeen = new Map<string, number>();
    const warnings: string[] = [];

    corridors.forEach(c => {
        c.segments.forEach(seg => {
            if (seg.flowType === undefined) {
                return;
            }
            if (!firstSeen.has(seg.flowType)) {
                firstSeen.set(seg.flowType, firstSeen.size);
            }
            if (seg.displayOrder !== undefined) {
                // The lowest explicit order a type is ever given, not the first one met.
                // `FlowDisplayOrder` may legitimately vary per corridor (it is a within-corridor
                // stacking rule), so "first wins" would make a type's legend rank depend on which
                // corridor came first in the data.
                const existing = displayOrderByType.get(seg.flowType);
                if (existing === undefined || seg.displayOrder < existing) {
                    displayOrderByType.set(seg.flowType, seg.displayOrder);
                }
            }
            if (seg.flowColourOverride) {
                const existing = overrideByType.get(seg.flowType);
                if (existing === undefined) {
                    overrideByType.set(seg.flowType, seg.flowColourOverride);
                } else if (existing !== seg.flowColourOverride
                    && overrides?.get(seg.flowType)?.colour === undefined) {
                    // Already warned once per corridor in corridors.ts for a conflict within a
                    // corridor; this catches the same flow type disagreeing across corridors.
                    //
                    // Silent where the panel has set that type's colour: the author has settled the
                    // conflict, and the warning would name a colour that is no longer the one drawn.
                    warnings.push(
                        `FlowType "${seg.flowType}" has conflicting FlowColour values across corridors — using "${existing}".`
                    );
                }
            }
        });
    });

    const order = legendOrder(firstSeen, displayOrderByType, locale);

    const autoFamily = defaults?.texture === "Hatching" ? autoHatch
        : defaults?.texture === "Pattern" ? autoPattern
            : undefined;
    const paneOutline: "solid" | "dashed" | undefined =
        defaults?.outline === "Solid" ? "solid"
            : defaults?.outline === "Dashed" ? "dashed"
                : undefined;

    const colours = new Map<string, string>();
    const labels = new Map<string, string>();
    const patterns = new Map<string, number>();
    const autoPatterns = new Map<string, number>();
    const outlines = new Map<string, "solid" | "dashed">();
    const inks = new Map<string, string>();
    const papers = new Map<string, string>();
    // In legend order, not data order: `getColor` hands colours out in call sequence, so
    // asking in this order stops a flow type's automatic colour moving when a slicer
    // changes which corridor comes first.
    order.forEach((type, rank) => {
        // `getColor` is asked for every type, whatever wins. It hands colours out in call
        // sequence, so skipping it for an overridden type would shift every later type's
        // automatic colour: picking one type's colour by hand would silently recolour the
        // others.
        const automatic = colorPalette.getColor(type).value;
        colours.set(type, overrides?.get(type)?.colour ?? overrideByType.get(type) ?? automatic);
        const label = overrides?.get(type)?.label;
        if (label !== undefined) {
            labels.set(type, label);
        }
        // Panel beats pane, and "off" in the panel is a choice. A pane default must not
        // override it, or an author could never turn a single type's texture off while the
        // rest follow Automatic. That is why `FLOW_PATTERN_NONE` and `outline: "none"` exist
        // as stored values distinct from absent.
        const pattern = overrides?.get(type)?.pattern;
        if (pattern !== undefined) {
            if (pattern !== FLOW_PATTERN_NONE) {
                patterns.set(type, pattern);
            }
        }
        if (autoFamily !== undefined) {
            // The type's legend rank, which is exactly the index high contrast hatches by
            // (`hatchIndexOf` is `order.indexOf`). A type therefore keeps the same texture when
            // the viewer switches into high contrast, and the automatic allocation does not move
            // when a slicer changes which corridor comes first.
            //
            // It is recorded for every type, including the ones that override it, so the editor
            // can say what its Auto option would do.
            autoPatterns.set(type, autoFamily(rank));
            if (pattern === undefined) {
                patterns.set(type, autoFamily(rank));
            }
        }
        const ink = overrides?.get(type)?.ink;
        if (ink !== undefined) {
            inks.set(type, ink);
        }
        const paper = overrides?.get(type)?.paper;
        if (paper !== undefined) {
            papers.set(type, paper);
        }
        const outline = overrides?.get(type)?.outline;
        if (outline === "solid" || outline === "dashed") {
            outlines.set(type, outline);
        } else if (outline === undefined && paneOutline !== undefined) {
            outlines.set(type, paneOutline);
        }
    });

    return {
        colours, order, dataColours: overrideByType, labels, patterns, outlines, inks, papers,
        autoPatterns,
        ...(paneOutline !== undefined ? { paneOutline } : {}),
        warnings
    };
}

/**
 * The legend's order, and with it the tooltip's type order, the high-contrast hatch
 * assignment and the automatic colour each type is given.
 *
 * It must not depend on the data's row or corridor order, or selecting a different
 * scenario would reshuffle the legend. Three keys:
 *
 * 1. `FlowDisplayOrder` ascending, a type without one sorting after every type with
 *    one. It is the author's own control, already the stacking order within a
 *    corridor.
 * 2. The locale's alphabet, which is the whole order when nothing carries a
 *    `FlowDisplayOrder`. One collator is reused: `localeCompare` builds one per call
 *    and is orders of magnitude slower for a handful of names. `numeric` makes
 *    "Stage 2" precede "Stage 10".
 * 3. First-seen order, because a collator may call two distinct strings equal and
 *    the result has to be a total order.
 */
function legendOrder(
    firstSeen: ReadonlyMap<string, number>,
    displayOrderByType: ReadonlyMap<string, number>,
    locale?: string
): string[] {
    const collator = new Intl.Collator(locale, { numeric: true });
    return [...firstSeen.keys()].sort((a, b) => {
        const ao = displayOrderByType.get(a) ?? Number.POSITIVE_INFINITY;
        const bo = displayOrderByType.get(b) ?? Number.POSITIVE_INFINITY;
        // Guarded rather than subtracted blind: Infinity - Infinity is NaN, and a NaN
        // comparator leaves the array in whatever order it arrived in.
        if (ao !== bo) {
            return ao - bo;
        }
        return collator.compare(a, b)
            || (firstSeen.get(a) as number) - (firstSeen.get(b) as number);
    });
}
