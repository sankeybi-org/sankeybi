import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { FormattingSettingsCard, FormattingSettingsSlice, IEnumMember } from "./settingsSupport";

/**
 * The Arrows group of the Nodes card: an arrow head or tail.
 *
 * Arrows are drawn inside the node's container (its shape when one is on, its rectangle
 * otherwise), so turning a shape on makes the arrows enter and leave that shape instead.
 * Routing is untouched either way: corridors still meet the node's own edges, and this is
 * decoration behind them.
 *
 * There is one angle rather than a depth. Depth is then derived from how much value a face
 * carries, so every arrowhead in the diagram has identical proportions instead of the busiest
 * one being blunter than the rest.
 *
 * The gap is what the author sets, and the node is sized to hold it. The gap is the visible
 * break in the flow, from a head's tip to a tail's notch, and the node's thickness along the
 * flow is what varies.
 */

/**
 * Background: a map or picture behind the diagram. The picture itself is a hidden blob
 * (`background.image`) that the visual's own import panel writes; the format pane has no slice
 * that can carry a file (see background.ts). While one is set, Lock grid is forced on and
 * hidden, so the nodes placed on the picture stay on it.
 */
const BACKGROUND_COLOUR_OPTIONS: IEnumMember[] = [
    { value: "Original", displayName: "Original" },
    { value: "Greyscale", displayName: "Greyscale" },
    { value: "Tint", displayName: "Tint" },
    { value: "Duotone", displayName: "Duotone" }
];

export class BackgroundCardSettings extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show",
        description: "Shows or hides the background picture without removing it.",
        value: true
    });

    /** What is set, or how to set one. Written by visual.ts every update. */
    status = new formattingSettings.ReadOnlyText({
        name: "status",
        displayName: "Image",
        description: "Whether a background image is set, and how to set one.",
        value: ""
    });

    transparency = new formattingSettings.Slider({
        name: "transparency",
        displayName: "Transparency",
        description: "0% shows the picture as is; higher fades it behind the flows.",
        value: 0,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    /**
     * Whole-picture colour treatments (background.ts). Colouring single regions is left to the
     * author's map tool.
     */
    colourMode = new formattingSettings.ItemDropdown({
        name: "colourMode",
        displayName: "Colour",
        description: "Original, Greyscale, Tint (one colour) or Duotone (a dark and a light colour).",
        items: BACKGROUND_COLOUR_OPTIONS,
        value: BACKGROUND_COLOUR_OPTIONS[0]
    });

    /** Tint's colour, and Duotone's dark end. Relabelled by visual.ts to match the mode. */
    darkColour = new formattingSettings.ColorPicker({
        name: "darkColour",
        displayName: "Dark parts",
        description: "Colour for the picture's dark parts. For Tint, the tint colour.",
        value: { value: "#5B7A99" }
    });

    lightColour = new formattingSettings.ColorPicker({
        name: "lightColour",
        displayName: "Light parts",
        description: "Colour for the picture's light parts.",
        value: { value: "#F3F2F1" }
    });

    /**
     * Buttons wearing toggles' clothes, like the Arrange resets: the visual acts on one and writes
     * it straight back off. Import opens the panel in the visual (see backgroundPanel.ts).
     */
    importImage = new formattingSettings.ToggleSwitch({
        name: "importImage",
        displayName: "Import image",
        description: "Choose, drop or paste an SVG, PNG or JPEG up to 500 KB. Edit mode only.",
        value: false
    });

    remove = new formattingSettings.ToggleSwitch({
        name: "remove",
        displayName: "Remove image",
        description: "Removes the picture from the report.",
        value: false
    });

    name: string = "background";
    displayName: string = "Background image";
    topLevelSlice = this.show;
    slices: Array<FormattingSettingsSlice> = [
        this.status, this.importImage, this.colourMode, this.darkColour, this.lightColour,
        this.transparency, this.remove
    ];
}
