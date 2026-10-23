import { DEFAULT_LEGEND_SIZE } from "./model";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { fontControl, FormattingSettingsCard, FormattingSettingsSlice, IEnumMember } from "./settingsSupport";
import { TEXT_COLOUR_OPTIONS } from "./settingsLabels";

const LEGEND_POSITION_OPTIONS: IEnumMember[] = [
    { value: "Top", displayName: "Top" },
    { value: "Bottom", displayName: "Bottom" },
    { value: "Left", displayName: "Left" },
    { value: "Right", displayName: "Right" }
];

/**
 * Legend card: only meaningful once FlowType is bound, but the toggle and position are exposed
 * regardless; visual.ts decides whether there is anything to show a legend for.
 */
export class LegendCardSettings extends FormattingSettingsCard {
    font = fontControl("legend", DEFAULT_LEGEND_SIZE, "Font");

    colourMode = new formattingSettings.ItemDropdown({
        name: "colourMode",
        displayName: "Text colour",
        description: "Automatic uses the theme's text colour. Custom sets one colour.",
        items: TEXT_COLOUR_OPTIONS,
        value: TEXT_COLOUR_OPTIONS[0]
    });

    colour = new formattingSettings.ColorPicker({
        name: "colour",
        displayName: "Custom colour",
        description: "Used when Text colour is Custom.",
        value: { value: "#FFFFFF" }
    });

    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show legend",
        description: "Shows a legend of flow types. Needs a Flow type field.",
        value: true
    });

    position = new formattingSettings.ItemDropdown({
        name: "position",
        displayName: "Position",
        description: "Which side of the diagram the legend sits on.",
        items: LEGEND_POSITION_OPTIONS,
        value: LEGEND_POSITION_OPTIONS[1] // Bottom
    });

    /**
     * A heading on the legend, drawn in bold before the first entry. Blank by default.
     *
     * The entry order has no setting and does not need one: the legend follows `flowDisplayOrder`,
     * which is the author's own control over it and is already shared with the tooltips
     * (tooltips.ts sorts by legend order), so a second way to say it could only make the two
     * disagree.
     */
    titleText = new formattingSettings.TextInput({
        name: "titleText",
        displayName: "Title",
        description: "Bold title before the first entry. Entries follow Flow display order.",
        placeholder: "",
        value: ""
    });

    name: string = "legend";
    displayName: string = "Legend";
    topLevelSlice = this.show;
    slices: Array<FormattingSettingsSlice> = [
        this.position, this.titleText, this.font, this.colourMode, this.colour
    ];
}
