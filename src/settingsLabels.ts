import { DEFAULT_FLOW_LABEL_SIZE, DEFAULT_LABEL_SIZE, DEFAULT_TOTAL_SIZE } from "./model";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { DEFAULT_ICON_SIZE } from "./layoutText";
import {
    fontControl, FormattingSettingsCard, FormattingSettingsCompositeCard, FormattingSettingsGroup,
    FormattingSettingsSlice, group, IEnumMember
} from "./settingsSupport";

export const TEXT_COLOUR_OPTIONS: IEnumMember[] = [
    { value: "Auto", displayName: "Automatic" },
    { value: "Custom", displayName: "Custom" }
];

const DISPLAY_UNITS_OPTIONS: IEnumMember[] = [
    { value: "Auto", displayName: "Auto" },
    { value: "None", displayName: "None" },
    { value: "Thousands", displayName: "Thousands" },
    { value: "Millions", displayName: "Millions" },
    { value: "Billions", displayName: "Billions" },
    { value: "Trillions", displayName: "Trillions" }
];

const TOTAL_BASIS_OPTIONS: IEnumMember[] = [
    { value: "Larger", displayName: "Larger of in/out" },
    { value: "Outflow", displayName: "Outflow" },
    { value: "Inflow", displayName: "Inflow" }
];

/**
 * Node labels card: names, totals and node icons.
 *
 * Per-node totals are auto-computed only: keying overrides by node id through the format pane
 * is fragile, and doing it properly needs per-node format objects.
 */
export class LabelsCardSettings extends FormattingSettingsCompositeCard {
    /** A node's name. Its family is the one a node's total follows too. */
    font = fontControl("label", DEFAULT_LABEL_SIZE, "Font");

    colourMode = new formattingSettings.ItemDropdown({
        name: "colourMode",
        displayName: "Text colour",
        description: "Automatic picks black or white to suit the node fill. Custom sets one colour.",
        items: TEXT_COLOUR_OPTIONS,
        value: TEXT_COLOUR_OPTIONS[0]
    });

    colour = new formattingSettings.ColorPicker({
        name: "colour",
        displayName: "Custom colour",
        description: "Used when Text colour is Custom.",
        value: { value: "#FFFFFF" }
    });

    /**
     * Just terminal nodes: only the ends of the diagram keep a name. Off by default. It is a
     * data-stage input: it blanks `label` before layout, so the reserve a name would have taken is
     * not taken; see `hideInteriorLabels`.
     */
    terminalLabelsOnly = new formattingSettings.ToggleSwitch({
        name: "terminalLabelsOnly",
        displayName: "Just terminal nodes",
        description: "Labels only nodes where flows start or end.",
        value: false
    });

    /**
     * The card's own switch, in its header like Legend's. Off, no node is named and no total is
     * drawn; icons are a separate thing and stay. On by default.
     *
     * Names are blanked before layout (`applyLabelScope`) and the totals go through
     * `labels.nodeTotals`, so the reserve both would have taken is not taken: no new geometry input.
     */
    showLabels = new formattingSettings.ToggleSwitch({
        name: "showLabels",
        displayName: "Show",
        description: "Draws node names and totals. Off gives their space back to the diagram.",
        value: true
    });

    /** A total is part of what a node says, so it sits with what is named, in Content. */
    showNodeTotals = new formattingSettings.ToggleSwitch({
        name: "showNodeTotals",
        displayName: "Show node totals",
        description: "Draws each node's total under its name.",
        value: false
    });

    totalBasis = new formattingSettings.ItemDropdown({
        name: "totalBasis",
        displayName: "Totals from",
        description: "Which figure totals report. Larger of in/out matches the tooltip.",
        items: TOTAL_BASIS_OPTIONS,
        value: TOTAL_BASIS_OPTIONS[0] // Larger
    });

    /**
     * A total's size and weight. It has no family of its own: two families inside one label block
     * reads as a mistake, so it follows the name's.
     */
    totalFontSize = new formattingSettings.NumUpDown({
        name: "totalFontSize",
        displayName: "Total text size",
        description: "Size of the total under a node's name.",
        value: DEFAULT_TOTAL_SIZE,
        options: {
            minValue: { value: 4, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 60, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    totalBold = new formattingSettings.ToggleSwitch({
        name: "totalBold",
        displayName: "Total bold",
        description: "Draws node totals in bold.",
        value: false
    });

    /**
     * Node icons come from the Source icon / Target icon fields; these say how big and what
     * colour. They are measured with the label, so an icon that does not fit a shape takes its
     * label outside with it.
     */
    iconSize = new formattingSettings.Slider({
        name: "iconSize",
        displayName: "Icon size",
        description: "Icon edge length in pixels. Icons come from the Source icon and Target icon fields.",
        value: DEFAULT_ICON_SIZE,
        options: {
            minValue: { value: 4, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 128, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    iconColour = new formattingSettings.ItemDropdown({
        name: "iconColour",
        displayName: "Icon colour",
        description: "Original keeps each icon as drawn; Label colour or Node colour recolours it.",
        items: ICON_COLOUR_OPTIONS,
        value: ICON_COLOUR_OPTIONS[0]
    });

    /**
     * A data-quality cue, not a decoration. Edit mode only, like Show grid: a warning marker in
     * front of a report reader is worse than none, and the author is who needs to see it.
     */
    showUnbalanced = new formattingSettings.ToggleSwitch({
        name: "showUnbalanced",
        displayName: "Flag unbalanced nodes",
        description: "Marks nodes whose in and out differ by more than the tolerance. Edit mode only.",
        value: false
    });

    balanceTolerance = new formattingSettings.NumUpDown({
        name: "balanceTolerance",
        displayName: "Balance tolerance (%)",
        description: "How far in and out may differ before a node is flagged, as a % of throughput.",
        value: 0.5,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 50, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    name: string = "labels";
    // The card is called "Node labels". The number format lives in its own card (Values), because
    // `formatTotal` serves node totals, flow labels and tooltips alike, and the balance check's
    // marker is a node label's business. The object stays `labels`.
    displayName: string = "Node labels";
    topLevelSlice = this.showLabels;
    groups: Array<FormattingSettingsGroup> = [
        // Content before Text, as the Flow labels card has it: what is named first, how it is set
        // second. A total is part of what a node says, so its switch is an ordinary row here; a group
        // has one header slice and Content's is the card's own.
        group("labelsContent", "Content",
            [this.terminalLabelsOnly, this.showNodeTotals, this.totalBasis,
                this.totalFontSize, this.totalBold]),
        group("labelsText", "Text", [this.font, this.colourMode, this.colour]),
        group("labelsIcons", "Icons", [this.iconSize, this.iconColour]),
        group("labelsBalance", "Balance check",
            [this.balanceTolerance], this.showUnbalanced)
    ];
}

const ICON_COLOUR_OPTIONS: IEnumMember[] = [
    { value: "Original", displayName: "Original" },
    { value: "Ink", displayName: "Label colour" },
    { value: "Node", displayName: "Node colour" }
];

const FLOW_LABEL_CONTENT_OPTIONS: IEnumMember[] = [
    { value: "Value", displayName: "Value" },
    { value: "PercentOfTotal", displayName: "% of all flows" },
    { value: "PercentOfSource", displayName: "% of its source node" }
];

/**
 * Flow labels: a figure drawn on the flow itself.
 *
 * It is its own card rather than more slices on Flows, because this is the "data labels" idea
 * every Power BI visual has and an author looks for it by that shape.
 *
 * A label that does not fit is not drawn; see flowLabels.ts for why it is not shrunk, moved
 * aside or given a leader line instead.
 */
export class FlowLabelsCardSettings extends FormattingSettingsCompositeCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show",
        description: "Draws a figure mid-flow. Flows too thin or steep to hold one stay unlabelled.",
        value: false
    });

    content = new formattingSettings.ItemDropdown({
        name: "content",
        displayName: "Label shows",
        description: "What each label reports: the value, a % of all flows or a % of its source node.",
        items: FLOW_LABEL_CONTENT_OPTIONS,
        value: FLOW_LABEL_CONTENT_OPTIONS[0] // Value
    });

    /**
     * Outside labels. Most flows cannot hold unrotated text, so the figure for the rest would only
     * be available on hover. On, a label that will not go inside is drawn clear of the band with a
     * leader line back to its midpoint, which is what Power BI's own pie and donut detail labels do
     * when positioned outside.
     *
     * It is off by default, because the rule that a label on a band always sits inside that band is
     * the one a reader can trust without being taught, and this trades some of that for coverage.
     */
    outside = new formattingSettings.ToggleSwitch({
        name: "outside",
        displayName: "Label flows that don't fit",
        description: "Draws labels for thin or steep flows just outside, with a line back to the flow.",
        value: false
    });

    font = fontControl("flowLabel", DEFAULT_FLOW_LABEL_SIZE, "Font");

    colourMode = new formattingSettings.ItemDropdown({
        name: "colourMode",
        displayName: "Colour",
        description: "Automatic picks black or white to suit the flow underneath. Custom sets one colour.",
        items: FLOW_LABEL_COLOUR_OPTIONS,
        value: FLOW_LABEL_COLOUR_OPTIONS[0] // Automatic
    });

    colour = new formattingSettings.ColorPicker({
        name: "colour",
        displayName: "Custom colour",
        description: "Used when Colour is Custom.",
        value: { value: "#FFFFFF" }
    });

    name: string = "flowLabels";
    displayName: string = "Flow labels";
    // `show` is the card's header switch, which also avoids two slices both called "Show" in one
    // card.
    topLevelSlice = this.show;
    groups: Array<FormattingSettingsGroup> = [
        group("flowLabelsContent", "Content", [this.content, this.outside]),
        group("flowLabelsText", "Text", [this.colourMode, this.colour, this.font])
    ];
}

const FLOW_LABEL_COLOUR_OPTIONS: IEnumMember[] = [
    { value: "Auto", displayName: "Automatic" },
    { value: "Custom", displayName: "Custom" }
];

/**
 * Values: how every figure in the diagram is written.
 *
 * It is its own card because it is genuinely shared. `formatTotal` is what writes a node total,
 * a flow label and a tooltip, and these four slices are what it reads; an author who switched
 * flow labels on and wanted one decimal place should not have to look under node labels for it.
 *
 * The object is named `numbers` rather than `values`: an author never sees an object name, and
 * `values` is close enough to the `value` data role and the dataViewMapping's own `values`
 * field to be worth avoiding.
 */
export class ValuesCardSettings extends FormattingSettingsCard {
    /**
     * Auto picks one unit for the whole diagram, from its largest figure. Scaling each label on its
     * own would print "1.2M" beside "840K".
     */
    displayUnits = new formattingSettings.ItemDropdown({
        name: "displayUnits",
        displayName: "Display units",
        description: "Auto scales every figure by one unit, chosen from the largest value.",
        items: DISPLAY_UNITS_OPTIONS,
        value: DISPLAY_UNITS_OPTIONS[0] // Auto
    });

    /**
     * On, the Value field's own format string decides how many decimals a figure gets: what a
     * report author has already set up in the model, and what every other visual on the page is
     * obeying. It defaults on.
     */
    autoDecimals = new formattingSettings.ToggleSwitch({
        name: "autoDecimals",
        displayName: "Automatic decimals",
        description: "Follows the Value field's format. Off lets you set decimal places.",
        value: true
    });

    units = new formattingSettings.TextInput({
        name: "units",
        displayName: "Units",
        description: "Unit of measure added to every total, e.g. TWh.",
        // Deliberately blank. A placeholder such as "TWh" renders greyed inside the empty box, which
        // reads as a value that is already set.
        placeholder: "",
        value: ""
    });

    decimalPlaces = new formattingSettings.NumUpDown({
        name: "decimalPlaces",
        displayName: "Decimal places",
        description: "Decimal places shown on every figure. Hidden while Automatic decimals is on.",
        value: 0,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 4, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    name: string = "numbers";
    displayName: string = "Values";
    slices: Array<FormattingSettingsSlice> = [
        this.displayUnits, this.autoDecimals, this.decimalPlaces, this.units
    ];
}
