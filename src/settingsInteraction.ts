import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { FormattingSettingsCard, FormattingSettingsSlice } from "./settingsSupport";

/**
 * Tooltips card.
 *
 * It deliberately holds only tooltips. Cross-filter on click is not a setting: filtering the
 * page is simply what a Power BI visual does when you click it, and making it optional would
 * invite a report where clicking looks interactive and silently filters nothing. The context
 * menu is absent for a different reason: it is a certification requirement, so it is not the
 * author's to switch off.
 */
export class InteractionCardSettings extends FormattingSettingsCard {
    tooltips = new formattingSettings.ToggleSwitch({
        name: "tooltips",
        displayName: "Tooltips",
        description: "Shows a tooltip on hover with the flow or node's values.",
        value: true
    });

    /**
     * What a node's tooltip lists. Three independent switches rather than a dropdown: a designer
     * may legitimately want all three at once. A band's tooltip has no equivalent; it is one line
     * by design.
     */
    tooltipNodeTotals = new formattingSettings.ToggleSwitch({
        name: "tooltipNodeTotals",
        displayName: "Node total",
        description: "Shows a node's total in and out.",
        value: true
    });

    tooltipNodeByFlowType = new formattingSettings.ToggleSwitch({
        name: "tooltipNodeByFlowType",
        displayName: "Node total by flow type",
        description: "Breaks a node's totals down by flow type, in legend order.",
        value: false
    });

    tooltipNodeByConnection = new formattingSettings.ToggleSwitch({
        name: "tooltipNodeByConnection",
        displayName: "Node total by source and target",
        description: "Breaks a node's totals down by the node at the other end.",
        value: false
    });

    name: string = "interaction";
    // The card is called "Tooltips": tooltips are all it holds.
    displayName: string = "Tooltips";
    topLevelSlice = this.tooltips;
    slices: Array<FormattingSettingsSlice> = [
        this.tooltipNodeTotals, this.tooltipNodeByFlowType, this.tooltipNodeByConnection
    ];
}
