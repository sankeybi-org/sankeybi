import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import {
    FormattingSettingsCompositeCard, FormattingSettingsGroup, group, IEnumMember
} from "./settingsSupport";
import { TEXT_COLOUR_OPTIONS } from "./settingsLabels";
import { t } from "./i18n";

/**
 * The Flows card: how a flow is drawn: its route, its width, and the gaps around it.
 *
 * There is one colour mode (solid fill), so no colour-mode dropdown. Flow transparency is not a
 * setting either: bands are opaque and a crossing is shown by the crossing channel, which is
 * geometry rather than blending.
 */
export class CorridorsCardSettings extends FormattingSettingsCompositeCard {
    /**
     * The ceiling is measured. Nothing breaks numerically at any setting: geometry stays finite
     * and every corridor still routes even at 5000%. What actually bites:
     *
     *   ~143%  two equally-busy neighbours in a column would just touch, since a node is
     *          0.7 x rowPitch at 100%. Usually later, as adjacent nodes are rarely both at the
     *          diagram's maximum, and overlapping bars may be exactly the wanted look.
     *   500%   nodes reach the full drawing height on a sparse diagram, and layout's cap holds
     *          them there. Past that the slider simply stops having an effect rather than doing
     *          anything strange.
     */
    flowWidth = new formattingSettings.Slider({
        name: "flowWidth",
        displayName: "Flow width",
        description: "Flow thickness as a % of default. Nodes scale with it; busy nodes touch past about 150%.",
        value: 100,
        options: {
            minValue: { value: 10, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 500, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    /**
     * A gap between flows, made of geometry rather than ink. The corridors packed on a node face
     * are held this far apart and the node is sized to hold the gaps, so every flow keeps exactly
     * the width its value earns, where a painted border would read as part of the flow and make it
     * look wider than it is, and masking a channel out could only take the gap from whatever is
     * drawn underneath.
     *
     * It is a percentage of the pitch the nodes pack across, as the arrow gap is, so it means the
     * same pixels whichever way a face runs and it rescales with the tile instead of growing as the
     * viewport shrinks.
     *
     * The arrows follow for free: `buildNodeInfill` reads the same anchors, so a head or a tail is
     * separated exactly as the band it continues, with nothing drawn at the join to be a line.
     */
    /**
     * The flow type colours, as a pair of buttons wearing toggles' clothes, like the node editor's.
     * The colours themselves are a hidden blob (`corridors.flowTypeColours`, see
     * flowTypeColours.ts): a flow type has no data identity of its own in this dataView, so the pane
     * has nothing to keep a per-type colour against.
     */
    /**
     * The colour a flow takes when it has no type. A real pane picker, so it carries the report
     * theme's own swatches, which is what the panel's per-type pickers cannot do
     * (`flowColourPanel.ts`).
     *
     * Its stored value wins; while it has never been set, `visual.ts` writes the theme's own
     * corridor colour into it so the pane shows the colour actually being drawn. That is also why
     * the palette is asked for that colour whether or not this is set: `getColor` hands colours out
     * in call sequence, so skipping the call would shift every flow type's automatic colour, the
     * same trap `colours.ts` documents.
     */
    defaultFlowColour = new formattingSettings.ColorPicker({
        name: "defaultFlowColour",
        displayName: "Default flow colour",
        description: "Colour of flows with no flow type. Typed flows use their type's colour.",
        value: { value: "#605E5C" }
    });

    /**
     * Texture and outline for the whole diagram, with the editor keeping the per-type say.
     *
     * Both are resolved in `resolveFlowTypeColours` and nowhere else, beneath the editor's own
     * choice: panel beats pane, exactly as panel beats data for the colour. That is the one function
     * the legend, the bands, the arrows and the tooltips all read, so a second site applying either
     * is how the legend would stop matching the diagram.
     *
     * Both default to None, so a type with nothing stored draws flat and unedged.
     *
     * They are paint, not geometry: nothing in `LayoutChrome` or `RoutingOptions` reads them and
     * `geometryKey` must not either. But they are data-stage inputs, because
     * `resolveFlowTypeColours` runs inside `update()`'s `dataChanged` branch; `visual.ts` folds both
     * into `flowColoursChanged` for the reason the stored colours are folded in there: a setting the
     * data stages cannot see is a setting that does nothing until something else moves.
     */
    flowTexture = new formattingSettings.ItemDropdown({
        name: "flowTexture",
        displayName: "Flow type textures",
        description: "Fills each flow type with a texture instead of a flat colour, in legend order.",
        items: FLOW_TEXTURE_OPTIONS,
        value: FLOW_TEXTURE_OPTIONS[0] // None
    });

    /**
     * What the textures are drawn in. A texture is a hatch in an ink on the report's background.
     * The ink can be the flow type's own colour, or the whole diagram can be monotone (the
     * publication convention for a texture that carries the type by pattern alone), either in the
     * theme's text colour or in one the author picks.
     *
     * Paint only, read at render time like the border's colour: no geometry reads it and
     * `geometryKey` must not. The default is Follow flow type.
     */
    textureColourMode = new formattingSettings.ItemDropdown({
        name: "textureColourMode",
        displayName: "Texture colour",
        description: "Follow flow type uses each type's colour. Monotone uses one colour, so only patterns differ.",
        items: TEXTURE_COLOUR_OPTIONS,
        value: TEXTURE_COLOUR_OPTIONS[0]
    });

    textureColour = new formattingSettings.ColorPicker({
        name: "textureColour",
        displayName: "Custom texture colour",
        description: "Used when Texture colour is Custom.",
        value: { value: "#605E5C" }
    });

    /**
     * What sits behind the texture. Report background is a texture drawn straight onto the page; Flow
     * type colour fills the band with its colour and draws the texture over it (pair it with Contrast
     * for a tone-on-tone look); Custom picks one colour for every flow type.
     */
    textureBackgroundMode = new formattingSettings.ItemDropdown({
        name: "textureBackgroundMode",
        displayName: "Texture background",
        description: "What sits behind a texture: report background, flow type colour or a custom colour.",
        items: TEXTURE_BACKGROUND_OPTIONS,
        value: TEXTURE_BACKGROUND_OPTIONS[0]
    });

    textureBackground = new formattingSettings.ColorPicker({
        name: "textureBackground",
        displayName: "Custom texture background",
        description: "Used when Texture background is Custom.",
        value: { value: "#FFFFFF" }
    });

    flowOutline = new formattingSettings.ItemDropdown({
        name: "flowOutline",
        displayName: "Border",
        description: "Draws a border inside every flow without changing its width. Dashed suggests estimated.",
        items: FLOW_OUTLINE_OPTIONS,
        value: FLOW_OUTLINE_OPTIONS[0] // None
    });

    /**
     * The outline's ink, one colour for the whole diagram. Automatic is the theme's text colour. A
     * paint input read at render time, like the legend's text colour: it moves no geometry and
     * needs no line in the key. High contrast ignores it, for the reason it ignores the legend's.
     */
    outlineColourMode = new formattingSettings.ItemDropdown({
        name: "outlineColourMode",
        displayName: "Border colour",
        description: "Automatic uses the theme's text colour. Custom uses one colour for all borders.",
        items: TEXT_COLOUR_OPTIONS,
        value: TEXT_COLOUR_OPTIONS[0]
    });

    outlineColour = new formattingSettings.ColorPicker({
        name: "outlineColour",
        displayName: "Custom border colour",
        description: "Used when Border colour is Custom.",
        value: { value: "#605E5C" }
    });

    editFlowColours = new formattingSettings.ToggleSwitch({
        name: "editFlowColours",
        displayName: "Show editor",
        description: "Opens the flow type editor for colours, names, textures and borders. Edit mode only.",
        value: false
    });

    resetFlowColours = new formattingSettings.ToggleSwitch({
        name: "resetFlowColours",
        displayName: "Reset colour edits",
        description: "Clears all flow type editor changes so types follow the data again.",
        // It clears the whole blob, which carries four fields per type. The name stays: it sits in the
        // Colour group and reads as "the edits made in the colour editor", which is what it clears.
        value: false
    });

    flowSeparation = new formattingSettings.Slider({
        name: "flowSeparation",
        displayName: "Between flows",
        description: "Gap between side-by-side flows and between bands, as a % of diagram spacing.",
        value: 0,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 10, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    /**
     * The other half of the separation idea, for flows that cross: the flow that is underneath is
     * erased up to a margin away from the flow crossing over.
     *
     * Geometry cannot do this one: two flows that cross have no gap to open between them, so the
     * channel is erased out of whatever passes underneath rather than reserved. That is the
     * opposite trade from Flow separation and it is the right one here, because the width the lower
     * flow gives up is confined to the crossing, where it reads as depth rather than as a wrong
     * number.
     *
     * It uses the same units as Flow separation so the two read as a pair.
     */
    crossingSeparation = new formattingSettings.Slider({
        name: "crossingSeparation",
        displayName: "Where flows cross",
        description: "Gap erased in the lower flow where one flow crosses over another, in pixels.",
        // On by default, unlike Between flows next to it, which stays at 0. The two are not the same
        // kind of setting: Between flows changes the geometry, so switching it on moves every node and
        // every band, where this one erases a few percent of a band only where two of them genuinely
        // cross. It is a legibility default rather than a restyling, which is what makes it safe to
        // arrive switched on. Nothing else moves: the channel is erased out of the lower band rather
        // than reserved, so no node and no band changes size.
        value: 1,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 10, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    /**
     * Fixed flow baseline: what one full node thickness means, in the data's own units.
     *
     * Off, the reference is the busiest node's own throughput, so that node always takes
     * `PACKING_FRACTION` of its packing pitch and the diagram fills its frame at every selection.
     * The price is that a width means nothing absolute: the same figure draws at different widths
     * in different selections, because the busiest node carries a different amount in each.
     *
     * On, the author's number is the reference instead, so a value draws the same width whichever
     * selection is showing and two selections can be compared by eye.
     *
     * Fitting the frame and absolute comparability are in direct conflict, which is why this is a
     * choice and not a fix. Set at or above the biggest throughput the report can show, nothing
     * overflows and a lighter selection simply reads as thinner, which is the point of the setting.
     * Set below it, the busiest node asks for more than its pitch and the existing cap and
     * `capPacking` absorb it, so it crowds its neighbours rather than breaking. This is deliberately
     * not warned about: a pro user sets this knowing their own magnitudes, and a node's total is
     * already readable from its tooltip and its label.
     */
    fixedBaseline = new formattingSettings.ToggleSwitch({
        name: "fixedBaseline",
        displayName: "Fixed flow baseline",
        description: "Measures flows against a value you set, so widths match across slicer selections.",
        value: false
    });

    /**
     * In data units, not pixels or percent: the same units the value field carries, so the author
     * types a figure they already know. Floored at a small positive number rather than 0, since it
     * is a divisor.
     *
     * There is no upper bound worth setting. Too high simply draws everything thin, which is a
     * legitimate choice for a report whose selections vary a lot.
     */
    /**
     * What the baseline is being set against. It cannot be prepopulated: a slice's default is a
     * static number, and a value written into the box on first use is indistinguishable from one
     * the author typed, so a later selection could not tell whether it was still meant. Reporting
     * it instead lets the author see the magnitude they are choosing against and type a number they
     * mean. It is written by `visual.ts` from the layout every update, the way the Background
     * card's status line is.
     *
     * It is the busiest node's throughput in the data's own units, which is what one full node
     * thickness means while Fixed flow baseline is off, and it moves with every slicer selection,
     * which is the reason the fixed baseline exists.
     */
    baselineCurrent = new formattingSettings.ReadOnlyText({
        name: "baselineCurrent",
        displayName: "Current",
        description: "The busiest node's throughput at the current selection, in Value units.",
        value: ""
    });

    baselineValue = new formattingSettings.NumUpDown({
        name: "baselineValue",
        displayName: "Baseline value",
        description: "Throughput one full node thickness represents. Set at or above your busiest node.",
        value: 100,
        options: {
            minValue: { value: 0.0001, type: powerbi.visuals.ValidatorType.Min }
        }
    });

    routingStyle = new formattingSettings.ItemDropdown({
        name: "routingStyle",
        displayName: "Routing style",
        description: "Polyline: straight runs, one diagonal. Octilinear: 45° diagonals. Orthogonal: right angles. Smooth: arcs.",
        items: ROUTING_STYLE_OPTIONS,
        // Polyline
        value: ROUTING_STYLE_OPTIONS[0] // Polyline
    });

    curvature = new formattingSettings.Slider({
        name: "curvature",
        displayName: "Curvature",
        description: "Corner radius as a % of diagram spacing; 0 is sharp. Resets any hand-set corners.",
        // The default corner roundness is 50. A hand-set radius a report already holds is kept.
        value: 50,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    straighten = new formattingSettings.Slider({
        name: "straighten",
        displayName: "Straighten",
        description: "Nudges nodes so nearly straight routes become straight. 0 leaves nodes on the grid.",
        value: 25,
        options: {
            minValue: { value: 0, type: powerbi.visuals.ValidatorType.Min },
            maxValue: { value: 100, type: powerbi.visuals.ValidatorType.Max }
        }
    });

    avoidNodes = new formattingSettings.ToggleSwitch({
        name: "avoidNodes",
        displayName: "Route around nodes",
        description: "Steers a flow around any node it would otherwise pass through.",
        value: true
    });

    name: string = "corridors";
    // The card is called "Flows": a corridor is the docs' word for one (source, target) pair, and
    // an author says flows. The card holds everything about how a flow is drawn, routing included.
    // The object name stays `corridors`.
    displayName: string = "Flows";
    // Route first: the shape of a flow is the thing an author reaches for most.
    groups: Array<FormattingSettingsGroup> = [
        group("flowsRoute", "Route",
            [this.routingStyle, this.curvature, this.straighten,
                this.avoidNodes]),
        group("flowsWidth", "Width",
            [this.flowWidth, this.fixedBaseline, this.baselineCurrent,
                this.baselineValue]),
        // The group is what tells these two apart. Their descriptions still point at each other by
        // name, because the first thing an author asks is which of the two they want.
        group("flowsGaps", "Gaps", [this.flowSeparation, this.crossingSeparation]),
        // Gaps sits above Colour, so the card reads Route, Width, Gaps, Colour and ends on Per Flow
        // Type, as the Nodes card ends on Per node: the diagram as a whole first, one flow type last.
        group("flowsColour", "Colour",
            [this.defaultFlowColour, this.flowOutline, this.outlineColourMode, this.outlineColour]),
        // The textures live with the editor: they are about flow types (one texture per type), so with
        // no Flow type bound they have nothing to act on, and the whole group is greyed out then
        // (`onPreProcess`, `noFlowTypes`). The border stays in Colour above: it is drawn on every flow,
        // typed or not.
        group("flowsPerType", "Per Flow Type",
            [this.flowTexture, this.textureColourMode, this.textureColour,
                this.textureBackgroundMode, this.textureBackground,
                this.editFlowColours, this.resetFlowColours])
    ];

    /**
     * Set by the visual before the pane is built: true when the data has no flow types at all. The
     * Per Flow Type group is then disabled, with a reason, rather than left offering settings that
     * cannot do anything. It is a plain field, not a slice: it is not a setting and is never
     * stored.
     */
    noFlowTypes = false;

    onPreProcess(): void {
        const perType = this.groups.find(g => g.name === "flowsPerType");
        if (perType) {
            perType.disabled = this.noFlowTypes;
            perType.disabledReason = this.noFlowTypes
                ? t("ui.noFlowTypes", "No Flow type field is bound, so there are no flow types to colour, texture or edit.")
                : undefined;
        }
    }
}

/**
 * A texture on every flow type, allocated the way high contrast allocates its hatches.
 *
 * There are only two states, because the pane cannot sensibly offer a texture per type: a flow
 * type is a category value with no data identity of its own, which is the reason the editor
 * exists (`flowTypeColours.ts`). So the pane says "texture them all" and the editor says which.
 */
const FLOW_TEXTURE_OPTIONS: IEnumMember[] = [
    { value: "None", displayName: "None" },
    { value: "Hatching", displayName: "Auto-hatching" },
    { value: "Pattern", displayName: "Auto-pattern" }
];

/** An outline on every flow, in the same words the editor's own row uses. */
const FLOW_OUTLINE_OPTIONS: IEnumMember[] = [
    { value: "None", displayName: "None" },
    { value: "Solid", displayName: "Solid" },
    { value: "Dashed", displayName: "Dashed" }
];

/** What a texture is drawn in: the type's own colour, or one colour for all. */
/** What sits behind a texture. */
const TEXTURE_BACKGROUND_OPTIONS: IEnumMember[] = [
    { value: "Background", displayName: "Report background" },
    { value: "Type", displayName: "Flow type colour" },
    { value: "Custom", displayName: "Custom" }
];

const TEXTURE_COLOUR_OPTIONS: IEnumMember[] = [
    { value: "Type", displayName: "Follow flow type" },
    { value: "Contrast", displayName: "Contrast with background" },
    { value: "Auto", displayName: "Monotone - automatic" },
    { value: "Custom", displayName: "Monotone - custom" }
];

/**
 * The routing styles. Both lengths are percentages of the logical grid's own spacing rather
 * than raw pixels, so a diagram keeps its proportions as it is resized or as columns are added:
 * the same grid-relative rule the routing constants follow.
 */
// Polyline first: it is the default.
const ROUTING_STYLE_OPTIONS: IEnumMember[] = [
    { value: "Polyline", displayName: "Polyline" },
    { value: "Octilinear", displayName: "Octilinear" },
    { value: "Orthogonal", displayName: "Orthogonal" },
    { value: "Smooth", displayName: "Smooth" }
];
