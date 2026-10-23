import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import {
    FormattingSettingsCompositeCard, FormattingSettingsGroup, group, IEnumMember
} from "./settingsSupport";

/**
 * Arrange card: the controls for hand-placed node positions.
 *
 * The persisted positions themselves are not here. `positions.nodes` and `positions.routes` are
 * declared in capabilities.json (a property has to be declared to be persisted) but
 * deliberately given no slice, so a blob of JSON never shows up in the format pane. visual.ts
 * reads them straight off `dataView.metadata.objects`.
 *
 * The two visibility switches do different jobs and are deliberately separate: Show route
 * handles just hides the dots, which is what you want while positioning nodes in a busy
 * diagram, and leaves everything draggable. Lock positions makes the whole diagram static
 * (nothing moves, nothing shows a drag cursor) for when the layout is finished and you do not
 * want to nudge it by accident.
 *
 * The two resets are separate for the same reason: having spent time placing nodes, wanting the
 * routes back to automatic should not cost you the layout, and vice versa. Ticking both resets
 * everything.
 *
 * All three of the reset/lock switches are buttons wearing a toggle's clothes: the formatting
 * model has no action slice, so the visual acts on a reset and immediately writes it back off.
 */
/**
 * Which way a diagram reads when the data does not say. The port roles are optional, and with
 * none of them bound every corridor leaves East and arrives West, a left-to-right Sankey. This
 * offers the other readings without asking the author to bind two more columns.
 *
 * It is a default, not an override: a SourcePort/TargetPort cell in the data still wins, and so
 * does the node editor's "Outflows leave via". A bound port is turned with the rest of the
 * description rather than overridden: the data still says which face, in the frame it was
 * written in.
 *
 * All four readings are offered. The two reversed ones are the same port pairs swapped, and
 * they also turn the picture around: `senseOf` reads the direction of travel off the resolved
 * ports and layout flips the grid->pixel mapping on the stage axis (`columnSign`/`rowSign`). So
 * the coordinates, the author's or the automatic ones, always mean the same thing, stage 1
 * being the first stage, and only which end of the screen they are drawn at changes. Without
 * the flip a right-to-left diagram would draw every corridor leaving a West face to reach a
 * node on its right.
 *
 * The two vertical readings turn the description. A mirror is enough for right to left, which
 * keeps the stage on the column; it is not enough for top to bottom, which moves the stage to
 * the row (`rolesOf`) and so would read an authored grid's stages as lateral position. A sign
 * flip cannot transpose an axis, so the vertical readings transpose it: the data and the
 * author's own stored work alike, ports and coordinates together (`transpose.ts`). It is a
 * transpose and not a rotation: a rotation about the origin sends the lateral coordinate
 * negative while automatic placement uses small positives, so one hand-placed node among
 * automatic ones would be flung off the side. The mirror still does the reversing within each
 * axis.
 */
const FLOW_DIRECTION_OPTIONS: IEnumMember[] = [
    { value: "LeftToRight", displayName: "Left to right" },
    { value: "RightToLeft", displayName: "Right to left" },
    { value: "TopToBottom", displayName: "Top to bottom" },
    { value: "BottomToTop", displayName: "Bottom to top" }
];

export class PositionsCardSettings extends FormattingSettingsCompositeCard {
    flowDirection = new formattingSettings.ItemDropdown({
        name: "flowDirection",
        displayName: "Flow direction",
        description: "Which way the diagram reads. Hand-placed nodes and ports turn with it.",
        items: FLOW_DIRECTION_OPTIONS,
        value: FLOW_DIRECTION_OPTIONS[0] // Left to right: the default
    });

    /**
     * How many steps a grid cell is divided into, not a percentage of one. A percentage cannot
     * express a third: 33% leaves a sliver every cell and the thirds drift out of line across a
     * wide diagram. Counting divisions makes every fraction from a half to a hundredth exact, which
     * is the point of snapping at all.
     */
    snap = new formattingSettings.Slider({
        name: "snap",
        displayName: "Snap to grid",
        description: "Steps per grid cell: 2 for halves, 3 for thirds, up to 100. 0 places freely.",
        value: 32,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    showGrid = new formattingSettings.ToggleSwitch({
        name: "showGrid",
        displayName: "Show grid",
        description: "Draws the snap grid behind the diagram while editing. Never shown when reading.",
        value: false
    });

    showHandles = new formattingSettings.ToggleSwitch({
        name: "showHandles",
        displayName: "Show route handles",
        description: "Shows or hides the route handles. Nodes stay draggable either way.",
        value: true
    });

    lock = new formattingSettings.ToggleSwitch({
        name: "lock",
        displayName: "Lock positions",
        description: "Makes the diagram static: nothing can be dragged and no route handles show.",
        value: false
    });

    /**
     * Lock grid holds the grid and the visible area as they are when it is switched on. Off, the
     * view fits the content, so moving an outermost node rescales the whole diagram; on, the pitch
     * depends only on the visual's size and a drag past the edge is held at it. The window itself
     * is a hidden blob (`positions.grid`), like the positions.
     */
    lockGrid = new formattingSettings.ToggleSwitch({
        name: "lockGrid",
        displayName: "Lock grid",
        description: "Holds the grid and visible area so moving a node never rescales the diagram.",
        value: false
    });

    /**
     * Arrange flows: search route handles for less overlap. A button like the two resets, and its
     * result is ordinary route overrides, so "Reset route handles" undoes it, and anything it gets
     * wrong can still be dragged. Corridors already placed by hand are left alone, so reset first
     * to hand it the whole diagram.
     */
    arrangeFlows = new formattingSettings.ToggleSwitch({
        name: "arrangeFlows",
        displayName: "Arrange flows",
        description: "Separates flows that run along each other. Routes you dragged stay where you put them.",
        value: false
    });

    /**
     * Arrange nodes: logical placement (see `arrangeNodes.ts`). It spends nothing on the crossing
     * count and everything on logical position: columns from the steps required, rows from the
     * most crowded column, each column ordered by what it connects to and placed at the mean of its
     * incoming flows.
     *
     * It writes ordinary node positions, so "Reset node positions" undoes it and every node is
     * still draggable.
     */
    arrangeNodes = new formattingSettings.ToggleSwitch({
        name: "arrangeNodes",
        displayName: "Arrange nodes",
        description: "Rearranges nodes by where their flows say they belong. Nodes you dragged stay put.",
        value: false
    });

    resetNodes = new formattingSettings.ToggleSwitch({
        name: "resetNodes",
        displayName: "Reset node positions",
        description: "Clears hand-placed nodes and arranges them automatically. Route handles are kept.",
        value: false
    });

    resetRoutes = new formattingSettings.ToggleSwitch({
        name: "resetRoutes",
        displayName: "Reset route handles",
        description: "Clears hand-moved route handles so all flows route automatically. Nodes are kept.",
        value: false
    });

    /**
     * Opens the layout file panel. A button wearing a toggle's clothes, like Show editor: the
     * visual opens the panel and writes this straight back off.
     */
    layoutFile = new formattingSettings.ToggleSwitch({
        name: "layoutFile",
        displayName: "Show layout file",
        description: "Shows the layout as text to copy, back up, or paste to restore. Edit mode only.",
        value: false
    });

    name: string = "positions";
    // The card is called "Arrange" and the object name stays `positions`, so every stored
    // position, route handle and grid window keeps its path.
    displayName: string = "Arrange";
    groups: Array<FormattingSettingsGroup> = [
        group("arrangeDirection", "Direction", [this.flowDirection]),
        // Two buttons, deliberately toggles: Arrange nodes places the nodes, Arrange flows (stored as
        // `arrangeFlows`) then searches the route handles.
        group("arrangeAuto", "Auto fit",
            [this.arrangeNodes, this.arrangeFlows]),
        group("arrangeGrid", "Grid", [this.snap, this.showGrid, this.showHandles]),
        group("arrangeLock", "Lock", [this.lock, this.lockGrid]),
        group("arrangeReset", "Reset", [this.resetNodes, this.resetRoutes]),
        group("arrangeFile", "Layout file", [this.layoutFile])
    ];
}
