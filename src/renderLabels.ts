/**
 * Label settings and flow-label painting.
 */

import { VisualFormattingSettingsModel } from "./settings";
import {
    DEFAULT_LABEL_SIZE, DEFAULT_TOTAL_SIZE, DisplayUnits, FontSpec, IconColour, LabelOptions, TotalBasis
} from "./model";
import { FlowLabelPlacement } from "./flowLabels";
import { bandKey, SelectionSink } from "./selection";
import { applyFont, el, fontFrom, inkOn, textColourFrom } from "./renderSupport";

/**
 * The Node labels card, resolved into the shape the rest of the pipeline uses.
 *
 * Exported because layout needs it too: whether a node's label fits inside its
 * shape depends on the total's text, and layout decides that. It is built in one
 * place so the block layout measures is the block render draws.
 */
export function labelOptionsFrom(
    settings: VisualFormattingSettingsModel,
    /**
     * What the pane cannot say: the model's format string, the report's locale and the
     * formatter built from them. Built in visual.ts because the library is ESM-only and
     * this module is one the checks load (see formatting.ts). Absent, formatting falls
     * back to `toLocaleString`.
     */
    numbers?: NumberFields,
    /**
     * What each flow type is called, from the colour panel. Passed in rather than read
     * from the settings, because the labels live in a blob the pane has no slice for
     * and `colours.ts` resolves them.
     */
    flowTypeLabels?: ReadonlyMap<string, string>
): LabelOptions {
    return {
        ...numbers,
        ...(flowTypeLabels !== undefined && flowTypeLabels.size > 0 ? { flowTypeLabels } : {}),
        // Optional reads: the checks build settings by hand.
        iconSize: settings.labelsCard.iconSize?.value,
        iconColour: (settings.labelsCard.iconColour?.value?.value ?? "Original") as IconColour,
        // The card's own switch turns the totals off with the names; an absent one (a
        // check's hand-built settings) counts as on.
        nodeTotals: (settings.labelsCard.showLabels?.value ?? true)
            && settings.labelsCard.showNodeTotals.value,
        basis: settings.labelsCard.totalBasis.value.value as TotalBasis,
        units: (settings.valuesCard?.units?.value ?? "").trim(),
        // The slider clamps this in the pane, but a stored value could be anything, and
        // `toLocaleString` throws on a fraction-digit count outside 0-20.
        decimalPlaces: Math.max(0, Math.min(4, Math.round(settings.valuesCard?.decimalPlaces?.value || 0))),
        // Optional reads again: a check's settings object has neither.
        displayUnits: (settings.valuesCard?.displayUnits?.value?.value ?? "None") as DisplayUnits,
        autoDecimals: settings.valuesCard?.autoDecimals?.value ?? false,
        font: fontFrom(settings.labelsCard.font, DEFAULT_LABEL_SIZE),
        colour: textColourFrom(settings.labelsCard),
        totalSize: settings.labelsCard.totalFontSize?.value ?? DEFAULT_TOTAL_SIZE,
        totalBold: settings.labelsCard.totalBold?.value ?? false
    };
}

/** The number-formatting facts `labelOptionsFrom` cannot read from the pane. */
export type NumberFields = Pick<LabelOptions,
    "valueFormat" | "locale" | "formatValue" | "measureText">;

/**
 * Paints the flow labels that flowLabels.ts decided on.
 *
 * Every decision is already made by then (which labels, where, and what they say).
 * This picks the ink and draws them, which is all render is for.
 *
 * Each label is a decoration of its corridor: it dims when another corridor is
 * selected, and it is never a pointer target, so a label cannot swallow the click
 * meant for the band it sits on.
 */
export function renderFlowLabels(
    svg: SVGSVGElement,
    placements: readonly FlowLabelPlacement[],
    font: FontSpec,
    custom: string | undefined,
    fallbackInk: string,
    selection: SelectionSink
): void {
    placements.forEach(label => {
        const ink = custom ?? (label.over ? (inkOn(label.over) ?? fallbackInk) : fallbackInk);
        // The leader line goes first, so the text is painted over its own line rather than
        // under it where the two meet. It is a hairline and un-capped: it is a pointer, and
        // anything heavier competes with the bands.
        if (label.leader) {
            const line = el("line");
            line.setAttribute("x1", String(label.leader.from.x));
            line.setAttribute("y1", String(label.leader.from.y));
            line.setAttribute("x2", String(label.leader.to.x));
            line.setAttribute("y2", String(label.leader.to.y));
            line.setAttribute("stroke", ink);
            line.setAttribute("stroke-width", "1");
            line.setAttribute("pointer-events", "none");
            svg.appendChild(line);
            selection.registerDecoration(line, bandKey(label.corridorId));
        }
        const text = el("text");
        text.setAttribute("x", String(label.x));
        text.setAttribute("y", String(label.y));
        text.setAttribute("text-anchor", "middle");
        applyFont(text, font);
        // Automatic reads the band's own colour, as a label inside a node shape does; a
        // fixed ink vanishes on half the palette. `inkOn` returns undefined for a colour it
        // cannot resolve, which falls back to the theme. An outside label has no band under
        // it and carries no `over`, so it takes the theme ink by the same path.
        text.setAttribute("fill", ink);
        text.setAttribute("pointer-events", "none");
        text.textContent = label.text;
        svg.appendChild(text);
        selection.registerDecoration(text, bandKey(label.corridorId));
    });
}
