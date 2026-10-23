import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { DEFAULT_NODE_MIN_HEIGHT_PERCENT, DEFAULT_NODE_MIN_WIDTH_PERCENT } from "./layoutConstants";
import {
    FormattingSettingsCompositeCard, FormattingSettingsGroup, group, IEnumMember
} from "./settingsSupport";

const NODE_SHAPE_OPTIONS: IEnumMember[] = [
    { value: "None", displayName: "None" },
    { value: "Rectangle", displayName: "Rectangle" },
    { value: "Rounded", displayName: "Rounded rectangle" },
    { value: "Circle", displayName: "Circle" }
];

/**
 * `Transparent` and `Background` are not the same thing and can read as if they were.
 * Transparent shows whatever is behind the node, a background picture included; Background
 * paints the theme's background colour, which knocks that picture out. With a map loaded they
 * look nothing alike.
 */
const SHAPE_PAINT_OPTIONS: IEnumMember[] = [
    { value: "Node", displayName: "Node colour" },
    { value: "Custom", displayName: "Custom" },
    { value: "Transparent", displayName: "Transparent" },
    { value: "Background", displayName: "Theme background" }
];

/**
 * Node shapes card: everything about how a node looks and how big it is.
 *
 * There is no separate card for the node itself. The rectangle routing anchors to is never
 * painted (it is always transparent and exists only to be pointed at), so splitting "the node"
 * from "its shape" would be a distinction only the code cares about. One card says how big a
 * node is and what it looks like. The default colour comes from the theme, because the author
 * names node colours in the data or leaves them alone, and a third place to say it would only
 * invite the three to disagree.
 *
 * Fill and border both default to the node's own colour, so turning a shape on changes the look
 * without losing per-node colouring. Because each is a mode rather than a bare colour picker,
 * "white insides but the border keeps each node's colour" is one change here rather than a
 * per-node edit.
 */
export class NodeShapesCardSettings extends FormattingSettingsCompositeCard {
    /**
     * A node is sized by the flow it carries; these say how small it may get on each axis. They
     * name the axis outright rather than a thickness across the flow, which would land on width for
     * an East/West node and on height for a North/South one, so that two sliders could move the
     * same edge and the larger silently win. A shape is sized from its node, so these reach the
     * shape too.
     */
    minWidth = new formattingSettings.Slider({
        name: "minWidth",
        displayName: "Minimum width",
        description: "Least node width as a % of the diagram spacing between columns. Flows size nodes otherwise.",
        value: DEFAULT_NODE_MIN_WIDTH_PERCENT,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    minHeight = new formattingSettings.Slider({
        name: "minHeight",
        displayName: "Minimum height",
        description: "Least node height as a % of the diagram spacing between rows. Flows size nodes otherwise.",
        value: DEFAULT_NODE_MIN_HEIGHT_PERCENT,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    /**
     * The Shapes group's header switch. On while the Shape dropdown is anything but None; flipping
     * it off sets None, and flipping it back on restores the shape that was there. The dropdown
     * stays the setting that says what is drawn, so this is never read by a renderer.
     */
    showShapes = new formattingSettings.ToggleSwitch({
        name: "showShapes",
        displayName: "Show shapes",
        description: "Draws node shapes. Off leaves only the flows.",
        value: true
    });

    shape = new formattingSettings.ItemDropdown({
        name: "shape",
        displayName: "Shape",
        description: "Decorative shape over the node's centre. It never moves or resizes a route.",
        items: NODE_SHAPE_OPTIONS,
        // Rectangle, not None: the anchoring rectangle is never painted, so None would leave a diagram
        // with no visible nodes at all. This is the plain bar an untouched visual draws.
        value: NODE_SHAPE_OPTIONS[1] // Rectangle
    });

    padding = new formattingSettings.Slider({
        name: "padding",
        displayName: "Overhang flows",
        description: "How far a node extends past its flows, as a % of diagram spacing.",
        value: 0,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    fitLabel = new formattingSettings.ToggleSwitch({
        name: "fitLabel",
        displayName: "Overhang to fit label",
        description: "Widens a node so an overflowing label fits inside. Needs a shape.",
        value: false
    });

    fill = new formattingSettings.ItemDropdown({
        name: "fill",
        displayName: "Fill",
        description: "Node shape fill: node colour, custom, none or theme background.",
        items: SHAPE_PAINT_OPTIONS,
        value: SHAPE_PAINT_OPTIONS[0] // Node colour
    });

    fillColour = new formattingSettings.ColorPicker({
        name: "fillColour",
        displayName: "Fill colour",
        description: "Used when Fill is Custom.",
        value: { value: "#FFFFFF" }
    });

    border = new formattingSettings.ItemDropdown({
        name: "border",
        displayName: "Border",
        description: "Node shape border: node colour, custom, none or theme background.",
        items: SHAPE_PAINT_OPTIONS,
        value: SHAPE_PAINT_OPTIONS[0] // Node colour
    });

    borderColour = new formattingSettings.ColorPicker({
        name: "borderColour",
        displayName: "Border colour",
        description: "Used when Border is Custom.",
        value: { value: "#605E5C" }
    });

    borderWidth = new formattingSettings.Slider({
        name: "borderWidth",
        displayName: "Border width",
        description: "Thickness of the node border, in pixels.",
        value: 2,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 10, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    /**
     * The node editor: buttons wearing toggles' clothes, like the Arrange resets. Edit nodes opens
     * the editor panel in the visual; the edits themselves are a hidden blob (`nodeEdits.edits`,
     * see nodeEdits.ts), since nodes are not data rows and the pane has nowhere to keep a per-node
     * value.
     */
    editNodes = new formattingSettings.ToggleSwitch({
        name: "editNodes",
        displayName: "Show editor",
        description: "Opens the node editor for labels, names, icons and faces. Edits beat the data. Edit mode only.",
        value: false
    });

    resetEdits = new formattingSettings.ToggleSwitch({
        name: "resetEdits",
        displayName: "Reset node edits",
        description: "Clears all node editor changes so nodes follow the data again.",
        value: false
    });

    // The arrows are a group of this card; their properties live on the `nodeShapes` object.
    /**
     * One switch in the group's header. It shows whether `heads` or `tails` is on, and flipping it
     * sets both; `headerSwitch.ts` reconciles the three. It is deliberately not a third state that
     * gates the other two: heads and tails stay the settings that decide what is drawn, so an
     * author can switch either off inside and nothing is fighting them. Edit mode only, since a
     * reading view cannot persist.
     */
    showArrows = new formattingSettings.ToggleSwitch({
        name: "showArrows",
        displayName: "Show arrows",
        description: "Turns arrow heads and tails on or off together.",
        value: false
    });

    heads = new formattingSettings.ToggleSwitch({
        name: "heads",
        displayName: "Arrow heads",
        description: "Continues each face's incoming flows into the node as an arrow head.",
        value: false
    });

    tails = new formattingSettings.ToggleSwitch({
        name: "tails",
        displayName: "Arrow tails",
        description: "Notches the back of each face's outgoing flows so the node reads as an arrow tail.",
        value: false
    });

    angle = new formattingSettings.Slider({
        name: "angle",
        displayName: "Arrow angle",
        description: "Angle at the arrow tip in degrees. Lower is sharper; 90 gives a 45° taper.",
        value: 120,
        options: {
            minValue: { value: 10, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 170, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    gapPercent = new formattingSettings.Slider({
        name: "gapPercent",
        displayName: "Arrow gap",
        description: "Break from a head's tip to a tail's notch, as a % of diagram spacing.",
        value: 8,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 200, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    name: string = "nodeShapes";
    // The object name is "nodeShapes"; the card is shown to the author as "Nodes".
    displayName: string = "Nodes";
    groups: Array<FormattingSettingsGroup> = [
        // Min Gap Size holds the two floors only. The two overhangs belong to Shapes: an overhang is
        // how far the drawn shape stands proud of its flows, and it is the shape that stands.
        group("nodesSize", "Min Gap Size", [this.minWidth, this.minHeight]),
        // The group is Shapes, and its header switch is "shape is not None": the same derived switch
        // as the arrows, and the same file; see `headerSwitch.ts`. A group's own name is a uid, the
        // object is still `nodeShapes`.
        group("nodesShapes", "Shapes",
            [this.shape, this.padding, this.fitLabel, this.fill, this.fillColour,
                this.border, this.borderColour, this.borderWidth],
            this.showShapes),
        // Show arrows is the group's header switch: on when heads or tails are, and flipping it sets
        // both. See `headerSwitch.ts`.
        group("nodesArrows", "Arrows",
            [this.heads, this.tails, this.angle, this.gapPercent],
            this.showArrows),
        group("nodesPerNode", "Per node", [this.editNodes, this.resetEdits])
    ];
}
