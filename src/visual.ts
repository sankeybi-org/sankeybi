import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISandboxExtendedColorPalette = powerbi.extensibility.ISandboxExtendedColorPalette;

import { computeLayout, LayoutChrome } from "./layout";
import { EdgeReserve, LegendPosition } from "./layoutConstants";
import {
    drawingAreaOf, flowExtentOf, flowPassNeeded, frameOfRect, gridPositionOf, pixelPositionOf, unionOf
} from "./layoutView";
import {
    ArrowOptions, Corridor, DEFAULT_FONT_FAMILY, DEFAULT_PORTS, DisplayUnits, FlowAxis, FlowDirection,
    FlowRow, Graph, GridWindow, LabelOptions, LayoutResult, NodeShape, Point, RoutedBand
} from "./model";
import { axisOf, axisOfDirection, normaliseFlowDirection } from "./flowAxis";
import { reconcileArrowSwitch, reconcileShapeSwitch } from "./headerSwitch";
import { VisualFormattingSettingsModel } from "./settings";
import { parseDataView, valueFormatOf } from "./dataParsing";
import { buildGraph } from "./graph";
import { inferCorridors } from "./corridors";
import { FlowPaintDefaults, FlowTypeColours, resolveFlowTypeColours } from "./colours";
import { DiagramRouting, NodeInfill, RouteHandles, RouteOverridePoints } from "./routeTypes";
import { draggableHandles } from "./handles";
import { normaliseStyle, RoutingStyle } from "./routingStyle";
import { routeDiagram } from "./routing";
import { geometryKey } from "./geometryKey";
import { CrossingPairs, paintLayering } from "./layers";
import { arrangeNodes } from "./arrangeNodes";
import { arrangeFlows } from "./arrangeFlows";
import { straightenNodes } from "./straighten";
import { justifyEnds } from "./justify";
import { labelOptionsFrom, NumberFields } from "./renderLabels";
import { render, textureColoursFor } from "./render";
import { formatTotal } from "./tooltips";
import { FlowLabelCorridor } from "./flowLabels";
import { parseLayoutFile, serialiseLayoutFile } from "./layoutFile";
import { textMeasurerFor, valueFormatterFor } from "./formatting";
import { WaypointDragOptions } from "./interaction";
import { summariseWarnings } from "./warnings";
import {
    transposedFor, transposeEditPorts, transposeFlows, transposeOverrides, transposePositions,
    transposeWindow
} from "./transpose";
import {
    fitIntoWindow, fitSignatureOf, GridPosition, handPlacedPositions, needsAutomaticArrange, NodePositions,
    parseGridWindow, parseNodePositions, parseRouteOverrides, radiusInForce, RouteHandleKind,
    RouteOverrides, serialiseGridWindow, serialiseNodePositions, serialiseRouteOverrides, withAutoPlacement,
    withNodeMoved, withoutStaleRadii, withRouteHandle, withRouteRadius
} from "./positions";
import {
    aspectOf, backgroundFilterOf, BackgroundImage, formatBytes, letterbox, parseBackground,
    serialiseBackground
} from "./background";
import { BackgroundPanel } from "./backgroundPanel";
import {
    applyLabelScope, applyNodeEdits, NodeDataFacts, NodeEdits, parseNodeEdits, portDefaultsOf,
    serialiseNodeEdits
} from "./nodeEdits";
import { NodeEditorPanel } from "./nodeEditorPanel";
import { LayoutFilePanel } from "./layoutFilePanel";
import { FlowColourPanel, FlowTypePatch, FlowTypeRow } from "./flowColourPanel";
import { closePanelMenus } from "./panelMenu";
import { localiseModel, setLocalizer, t } from "./i18n";
import {
    FlowTypeEdits, flowTypeLabel, parseFlowTypeColours, serialiseFlowTypeColours, withFlowTypeEdit
} from "./flowTypeColours";
import { SelectionController } from "./selection";

/**
 * The Snap to grid setting as a step in grid units: 4 divisions -> 0.25, 3 -> a third exactly,
 * 0 -> no snapping at all. Shared by the drag layer and the grid render so a line cannot land
 * anywhere a drop would not.
 */
function snapStepOf(divisions: number): number {
    const n = Math.floor(divisions);
    return n >= 1 ? 1 / n : 0;
}

/** The node a selection names, if it names exactly one (see selection.ts `nodeKey`). */
function nodeIdOf(keys: ReadonlySet<string>): string | undefined {
    const nodes: string[] = [];
    keys.forEach(key => {
        try {
            const parsed = JSON.parse(key);
            if (Array.isArray(parsed) && parsed[0] === "node" && typeof parsed[1] === "string") {
                nodes.push(parsed[1]);
            }
        } catch {
            // Not a key of ours; ignore it.
        }
    });
    return nodes.length === 1 ? nodes[0] : undefined;
}

/**
 * Plain layout-and-route passes spent fitting the view round the flows, before the one
 * conservative pass that follows if they have not settled. Most diagrams need none or one; a
 * narrow portrait tile around a wide diagram needs all of them.
 */
const MAX_FLOW_PASSES = 3;

/** Ignore sub-pixel spill; re-laying out for it would be churn for nothing. */
const OVERFLOW_TOLERANCE = 1;

/**
 * How far the diagram spills past the viewport on each side, or undefined if it all fits.
 * Covers the nodes as well as the bands: a shape grown to hold its label reaches past the node
 * rectangle it stands in for, so it is not only wrap routes that can end up outside the space
 * layout reserved.
 */
function overflowOf(layout: LayoutResult, bands: RoutedBand[], width: number, height: number): EdgeReserve | undefined {
    const minX: number[] = [];
    const minY: number[] = [];
    const maxX: number[] = [];
    const maxY: number[] = [];
    bands.forEach(b => {
        minX.push(b.bounds.minX);
        minY.push(b.bounds.minY);
        maxX.push(b.bounds.maxX);
        maxY.push(b.bounds.maxY);
    });
    layout.nodes.forEach(n => {
        minX.push(n.x);
        minY.push(n.y);
        maxX.push(n.x + n.width);
        maxY.push(n.y + n.height);
    });
    if (minX.length === 0) {
        return undefined;
    }
    const reserve: EdgeReserve = {
        left: Math.max(0, -Math.min(...minX)),
        top: Math.max(0, -Math.min(...minY)),
        right: Math.max(0, Math.max(...maxX) - width),
        bottom: Math.max(0, Math.max(...maxY) - height)
    };
    const spill = Math.max(reserve.left, reserve.top, reserve.right, reserve.bottom);
    return spill > OVERFLOW_TOLERANCE ? reserve : undefined;
}

/**
 * What the flow labels need from the routed diagram.
 *
 * A corridor's drawn thickness is the sum of its stripes' widths: routing reports each stripe's
 * width and it is the same at both ends by construction, so one number per corridor is exact
 * rather than an approximation. The stripe gaps that Flow separation opens are deliberately not
 * added: leaving them out makes the thickness slightly conservative, which errs toward not
 * drawing a label that would not quite fit.
 *
 * The colour each label sits on is left to render, which is where the flow-type colours are
 * resolved: they depend on the palette as well as the data.
 */
function flowLabelInputOf(
    corridors: Corridor[],
    bands: RoutedBand[],
    spines: Map<string, Point[]>
): FlowLabelCorridor[] {
    const thickness = new Map<string, number>();
    bands.forEach(band => {
        thickness.set(band.corridorId, (thickness.get(band.corridorId) ?? 0) + band.width);
    });
    const out: FlowLabelCorridor[] = [];
    corridors.forEach(corridor => {
        const spine = spines.get(corridor.id);
        const width = thickness.get(corridor.id);
        if (!spine || width === undefined) {
            return;
        }
        out.push({
            id: corridor.id,
            value: corridor.value,
            source: corridor.source,
            spine,
            thickness: width,
            colour: undefined
        });
    });
    return out;
}

/**
 * The selector that addresses the visual as a whole when persisting an object. The host's
 * typings declare `selector` non-nullable, but `null` is what it expects for a visual-level
 * object.
 */
const WHOLE_VISUAL = null as unknown as powerbi.VisualObjectInstance["selector"];

/** What the formatting service gets before any data has arrived; it yields the defaults. */
const NO_DATA_VIEW = undefined as unknown as powerbi.DataView;

/**
 * Diagnostic output, silent by default. The Arrange summaries and data warnings are
 * developer-facing (the data warnings already reach the author through the host's warning
 * icon). Switch them on from the browser console with
 * `localStorage.setItem("sankeybi.debug", "1")` and reload.
 *
 * Storage can be blocked in a sandboxed frame; then logging is simply off. Only
 * `console.error`, inside the catch blocks, is unconditional: it reports a failure and says why
 * a button did nothing.
 */
function debugLog(...parts: unknown[]): void {
    try {
        if (window.localStorage?.getItem("sankeybi.debug") === "1") {
            console.log(...parts);
        }
    } catch {
        // blocked storage: logging stays off
    }
}

interface FrameInputs {
    background: BackgroundImage | undefined;
    bands: RoutedBand[];
    canPersist: boolean;
    crossings: CrossingPairs;
    dataView: powerbi.DataView;
    flowTypeColours: FlowTypeColours;
    height: number;
    infill: NodeInfill[];
    labelOptions: LabelOptions;
    layout: LayoutResult;
    locked: GridWindow | undefined;
    numbers: NumberFields;
    order: readonly string[];
    routed: DiagramRouting;
    routingOptions: { curvaturePercent: number; style: RoutingStyle; avoidNodes: boolean; arrows: ArrowOptions; };
    width: number;
}

interface ArrangeFlowsInputs {
    canPersist: boolean;
    layout: LayoutResult;
    overrides: Map<string, RouteOverridePoints>;
    routingOptions: { curvaturePercent: number; style: RoutingStyle; avoidNodes: boolean; arrows: ArrowOptions; };
}

interface GridButtonInputs {
    background: BackgroundImage | undefined;
    canPersist: boolean;
    layout: LayoutResult;
    lockGrid: boolean;
    storedGrid: GridWindow | undefined;
}

interface GeometryInputs {
    chrome: LayoutChrome;
    graph: Graph;
    height: number;
    locked: GridWindow | undefined;
    routingOptions: { curvaturePercent: number; style: RoutingStyle; avoidNodes: boolean; arrows: ArrowOptions; };
    straighten: number;
    width: number;
}

interface ArrangeNodesInputs {
    canPersist: boolean;
    chrome: LayoutChrome;
    flowDirection: FlowDirection;
    height: number;
    locked: GridWindow | undefined;
    stored: powerbi.DataViewObject | undefined;
    width: number;
}

interface ChromeInputs {
    background: BackgroundImage | undefined;
    flowTypeColours: FlowTypeColours;
    graph: Graph;
}

interface DataStageInputs {
    dataView: powerbi.DataView;
    directionChanged: boolean;
    flowColoursChanged: boolean;
    flowDirection: FlowDirection;
    flowPaint: FlowPaintDefaults;
    flowPaintChanged: boolean;
    labelScope: { shown: boolean; terminalOnly: boolean; };
    labelScopeChanged: boolean;
    options: VisualUpdateOptions;
    positionsChanged: boolean;
}

interface EditorButtonInputs {
    canPersist: boolean;
    dataView: powerbi.DataView;
}

/**
 * SankeyBI: publication-quality, interactive energy and material flow diagrams for Power BI.
 *
 * `update()` runs the pipeline: parse, transpose, graph, node edits, corridors, colours, layout,
 * justify, straighten, route, render, then wires interaction and selection. The data stages
 * are skipped on viewport-only updates, and layout and routing on updates that only changed how
 * the diagram is painted.
 */
export class Visual implements IVisual {
    private events: IVisualEventService;
    private host: IVisualHost;
    private colorPalette: ISandboxExtendedColorPalette;
    private target: HTMLElement;
    private svg: SVGSVGElement;
    private emptyStateText: HTMLElement;
    private readonly formattingSettingsService = new FormattingSettingsService();
    /**
     * Starts as the defaults (a model built from no data view), because the host can query the
     * format pane before the first `update()`: it re-instantiates the visual on a theme change,
     * high contrast included.
     */
    private formattingSettings: VisualFormattingSettingsModel =
        this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, NO_DATA_VIEW);

    // Cached results of the data-dependent pipeline stages (parse/graph/corridors/colours), reused
    // across update() calls that only changed the viewport (resize) rather than the data; see
    // update() below.
    /**
     * The parsed rows, kept so Arrange nodes can rebuild the graph without the stored positions
     * applied. Its layered model takes each node's stage from the topology, and `cachedGraph` has
     * hand-placed and previously-arranged positions folded in as overrides; on a vertical diagram
     * those have the stage in the row and the order in the column, so reading them back as stages
     * would layer the diagram by its own ordering coordinate on the second press.
     */
    private cachedFlows: FlowRow[] = [];
    private cachedGraph: Graph | undefined;
    private cachedCorridors: Corridor[] = [];
    private cachedFlowTypeColours: FlowTypeColours | undefined;
    // The persisted node positions this cached graph was built with. A drag changes positions
    // without changing data, so the graph has to be rebuilt when this string moves even though the
    // Data flag will not be set.
    private cachedPositionsRaw = "";
    /**
     * The signature this instance last arranged against, remembered as well as persisted.
     *
     * The persisted copy is what carries the fact across sessions; this one carries it across the
     * updates of this one, and it is the authority while the visual is open. In memory there is no
     * round trip through `persistProperties` to doubt.
     *
     * It stays empty until this instance arranges something, so a report that already has
     * positions and no stored signature is still left alone.
     */
    private cachedFitSignature = "";
    // The last frame's layout and handle positions. Polyline's bend gesture is expressed relative
    // to where the handles actually ended up, rather than re-derived here: routing is the only
    // thing that knows that, and a second opinion about it is a drift hazard.
    private lastLayout: LayoutResult | undefined;
    private lastHandles: Map<string, RouteHandles> = new Map();
    /**
     * The last laid-out and routed diagram, with the key of everything it was computed from
     * (`geometryKey`). Reused wherever the key still matches, which is every update that only
     * changed how the diagram is painted.
     */
    private cachedGeometry: {
        key: string;
        layout: LayoutResult;
        routed: DiagramRouting;
        /**
         * Which corridor is painted over which (layers.ts). Kept with the geometry because it is a
         * pure function of it: a cosmetic update reuses it along with the layout and the routes, and
         * nothing that changes it can change without changing the key.
         */
        order: readonly string[];
        /**
         * Which pairs of corridors actually cross. Kept for the same reason the order is: it falls out
         * of the same sweep and is a pure function of the geometry, so a cosmetic update reuses it and
         * the crossing channels cost nothing on a colour tweak.
         */
        crossings: CrossingPairs;
    } | undefined;
    /**
     * Hand placement in screen terms: what every geometry, drag, snap and routing path reads.
     */
    private nodePositions: NodePositions = new Map();
    /** The Arrows header switch as last seen consistent; see `headerSwitch.ts`. */
    private arrowSwitchLast: boolean | undefined;
    /** The Shapes header switch as last seen consistent, and the shape to restore. */
    private shapeSwitchLast: boolean | undefined;
    private shapeSwitchRestore: string | undefined;
    private routeOverrides: RouteOverrides = new Map();
    /**
     * The same, canonical: the left-to-right frame, which is what the blobs hold and what
     * `persistPositions` writes back.
     *
     * The pair above is derived from these by one turn every update (`transposedFor(handleAxis)`),
     * so hand placement follows the diagram when it is turned instead of being left behind in the
     * frame it was made in. They are kept as their own copy rather than re-parsed, because the parse
     * is gated on the blob changing and a direction change does not change the blob.
     */
    private storedPositions: NodePositions = new Map();
    private storedOverrides: RouteOverrides = new Map();
    /** The node editor's edits, canonical: its ports have a frame. */
    private storedEdits: NodeEdits = new Map();
    /**
     * Selection and cross-highlighting. Constructed once and kept for the visual's lifetime, not
     * per update: it holds the host's selection manager and the current selection, both of which
     * have to survive the re-renders that a resize, a format change or a drag all trigger.
     */
    private selection: SelectionController;
    /** The background import panel; offered in edit mode only. */
    private backgroundPanel: BackgroundPanel;
    /** The node editor, its edits, and what the data says about each node (for the editor). */
    private nodeEditorPanel: NodeEditorPanel;
    private layoutFilePanel: LayoutFilePanel;
    private flowColourPanel: FlowColourPanel;
    /** The panel's colours, and the raw blob they were parsed from. */
    private flowTypeOverrides: FlowTypeEdits = new Map();
    private cachedFlowColoursRaw = "";
    /**
     * The pane's own Texture and Outline, tracked as a data-stage input, for exactly the reason the
     * blob above is: both are resolved by `resolveFlowTypeColours` inside the `dataChanged` branch,
     * so a setting the gate cannot see is a setting that does nothing until the data moves.
     *
     * It is kept apart from `cachedFlowColoursRaw` so the blob is only re-parsed when the blob
     * itself changes; these two change what is resolved from it, not what it says.
     */
    private cachedFlowPaintRaw = "";
    /** Node labels' switch and Just terminal nodes, as last seen; see `applyLabelScope`. */
    private cachedLabelScope = "";
    /**
     * The theme's own colour for a flow with no type.
     *
     * It is asked for after the flow types, which is the order render asks in: `getColor` hands
     * colours out in call sequence, so asking for this key earlier would take a palette slot ahead
     * of the flow types and recolour every one of them.
     */
    private themeCorridorColour = "#605E5C";
    private nodeEdits: NodeEdits = new Map();
    private cachedEditsRaw = "";
    /** The Flow direction the corridors and the automatic grid were last built with. */
    private cachedFlowDirection: FlowDirection = "LeftToRight";
    /**
     * The axis every stored route handle is written against. Set from the Flow direction setting
     * at the top of each update, and written back by `persistPositions` on the same call that writes
     * the handles, so the marker and the handles it describes cannot disagree, whichever of the
     * drag, button or import paths did the writing. The stored blobs are canonical, so this is
     * always written horizontal.
     */
    private handleAxis: FlowAxis = "horizontal";
    private nodeFacts: NodeDataFacts[] = [];
    /**
     * Every validation warning the last data update produced, kept so a viewport-only update can
     * raise the same header icon: those updates skip the parse entirely, so the warnings are not
     * reproduced.
     */
    private cachedWarnings: string[] = [];
    /**
     * The Value field's own format string, from the last data update. Cached beside the flows for
     * the same reason they are: a viewport-only update never sees the parse.
     */
    private cachedValueFormat: string | undefined;
    /**
     * Lock grid's stored window, kept so the layout-file panel can read it. The update path uses
     * its own local, which is read fresh from the dataView.
     */
    private cachedGrid: GridWindow | undefined;
    /**
     * Real text measurement, built once for the visual's lifetime. The family is the stylesheet's,
     * which is what the browser will actually render with; measuring with a different one is the
     * single way this can be worse than an estimate.
     */
    private readonly measureText = textMeasurerFor(DEFAULT_FONT_FAMILY);

    constructor(options: VisualConstructorOptions) {
        try {
            this.events = options.host.eventService;
            this.host = options.host;
            setLocalizer(options.host.createLocalizationManager?.());
            this.selection = new SelectionController(options.host);
            this.colorPalette = options.host.colorPalette;
            this.target = options.element;

            this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
            this.svg.setAttribute("class", "sankeybi-root");
            this.target.appendChild(this.svg);
            this.selection.attachBackground(this.svg);

            this.emptyStateText = document.createElement("div");
            this.emptyStateText.setAttribute("class", "sankeybi-empty-state");
            this.emptyStateText.textContent = t("ui.emptyState", "Add Source, Target, and Value fields to see the diagram.");
            this.emptyStateText.style.display = "none";
            this.target.appendChild(this.emptyStateText);

            // The panel's button and dialog are positioned against the host element, which is not
            // guaranteed to be a positioning context.
            this.target.style.position = "relative";
            this.backgroundPanel = new BackgroundPanel(this.target, image => this.importBackground(image));
            this.backgroundPanel.setAvailable(false);
            this.nodeEditorPanel = new NodeEditorPanel(this.target,
                edits => this.persistEdits(edits));
            this.layoutFilePanel = new LayoutFilePanel(this.target, {
                // A layout file holds the canonical frame, which is what makes one portable: written from a
                // top-to-bottom report and pasted into a left-to-right one, it describes the same layout rather
                // than one lying on its side. The file carries no orientation of its own, so this is also the
                // only frame it could mean.
                read: () => serialiseLayoutFile({
                    nodes: this.storedPositions,
                    routes: this.storedOverrides,
                    grid: this.cachedGrid
                        ? transposeWindow(this.cachedGrid, transposedFor(this.handleAxis))
                        : undefined,
                    edits: this.storedEdits
                }),
                write: text => this.applyLayoutFile(text)
            });
            this.layoutFilePanel.setAvailable(false);
            this.flowColourPanel = new FlowColourPanel(this.target,
                (type, patch) => this.persistFlowColour(type, patch));
            this.flowColourPanel.setAvailable(false);
            // The editor follows the diagram: clicking a node opens it there.
            this.selection.onSelect = keys => {
                const id = nodeIdOf(keys);
                if (id !== undefined) {
                    this.nodeEditorPanel.focusNode(id);
                }
            };
        } catch (error) {
            console.error("[SankeyBI] Error in constructor", error);
            throw error;
        }
    }

    public update(options: VisualUpdateOptions): void {
        this.events.renderingStarted(options);

        try {
            const dataView = options.dataViews && options.dataViews[0];
            this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(
                VisualFormattingSettingsModel, dataView);

            const { stored, flowColoursChanged, flowPaint, flowPaintChanged, labelScope, labelScopeChanged, flowDirection, directionChanged, positionsChanged } = this.readStoredInputs({ dataView });

            // Whether this frame may write anything back. Every button below wears a toggle's clothes (the
            // formatting model has no action slice, so the visual acts on one and writes it straight back
            // off), and a reading view cannot persist, so it would act on the same toggle at every update
            // and never clear it.
            const canPersist = options.viewMode === powerbi.ViewMode.Edit
                || options.viewMode === powerbi.ViewMode.InFocusEdit;
            // Lock grid: the window it holds, once one has been captured. Until then (the frame the
            // toggle goes on) the view fits the content, and that fitted window is what gets captured
            // below. It is stored in the canonical frame like the other blobs, so a locked view holds a
            // region of the diagram and turns with it.
            const canonicalGrid = parseGridWindow(stored?.["grid"]);
            const storedGrid = canonicalGrid
                ? transposeWindow(canonicalGrid, transposedFor(this.handleAxis))
                : undefined;
            this.cachedGrid = storedGrid;
            const { background } = this.presentPane({ canPersist, dataView });
            const lockGrid = this.formattingSettings.positionsCard.lockGrid.value || background !== undefined;
            const locked: GridWindow | undefined = lockGrid ? storedGrid : undefined;
            this.clearStaleRadii({ canPersist });

            if (this.handleEditorButtons({ canPersist, dataView })) {
                this.events.renderingFinished(options);
                return;
            }
            // Show arrows is the header switch of the Arrows group: it reads as heads-or-tails, and
            // flipping it sets both. Heads and tails remain the settings that say what is drawn. No early
            // return: the persist brings `update()` round again consistent. The pane is only built in edit
            // mode, so a reading view has nothing to reconcile and `last` is left alone there.
            if (canPersist) {
                const arrows = this.formattingSettings.nodeShapesCard;
                const reconciled = reconcileArrowSwitch(this.arrowSwitchLast, {
                    show: arrows.showArrows.value,
                    heads: arrows.heads.value,
                    tails: arrows.tails.value
                });
                this.arrowSwitchLast = reconciled.last;
                if (reconciled.write) {
                    this.host.persistProperties({
                        merge: [{
                            objectName: "nodeShapes",
                            selector: WHOLE_VISUAL,
                            properties: reconciled.write
                        }]
                    });
                }
                // The Shapes header switch is the same idea over the Shape dropdown: off is None, and on
                // restores what was there.
                const shapes = reconcileShapeSwitch(
                    this.shapeSwitchLast, this.shapeSwitchRestore, {
                        show: arrows.showShapes.value,
                        shape: arrows.shape.value.value as string
                    });
                this.shapeSwitchLast = shapes.last;
                this.shapeSwitchRestore = shapes.restore;
                if (shapes.write) {
                    this.host.persistProperties({
                        merge: [{
                            objectName: "nodeShapes",
                            selector: WHOLE_VISUAL,
                            properties: shapes.write
                        }]
                    });
                }
            }

            if (this.handleResets()) {
                this.events.renderingFinished(options);
                return;
            }

            this.runDataStages({
                dataView,
                directionChanged,
                flowColoursChanged,
                flowDirection,
                flowPaint,
                flowPaintChanged,
                labelScope,
                labelScopeChanged,
                options,
                positionsChanged
            });
            // Raised on every update, not only the ones that parse. The host drops a visual's warnings as
            // each update begins, so a viewport-only tick that said nothing would clear an icon whose cause
            // is still in the data.
            const summary = summariseWarnings(this.cachedWarnings);
            if (summary) {
                this.host.displayWarningIcon(summary.hover, summary.detail);
            }
            this.refreshPanels({ flowDirection });

            const width = options.viewport.width;
            const height = options.viewport.height;

            // No graph means no rows worth drawing: the parse above clears it whenever the data comes back
            // empty.
            const graph = this.cachedGraph;
            const flowTypeColours = this.cachedFlowTypeColours;
            if (!graph || !flowTypeColours) {
                this.svg.style.display = "none";
                this.emptyStateText.style.display = "block";
                this.events.renderingFinished(options);
                return;
            }

            this.svg.style.display = "block";
            this.emptyStateText.style.display = "none";

            const { numbers, routingOptions, straighten, labelOptions, chrome } = this.buildChrome({ background, flowTypeColours, graph });
            if (this.runArrangeNodes({
                canPersist,
                chrome,
                flowDirection,
                height,
                locked,
                stored,
                width
            })) {
                this.events.renderingFinished(options);
                return;
            }

            const geometry = this.layOutAndRoute({
                chrome,
                graph,
                height,
                locked,
                routingOptions,
                straighten,
                width
            });
            const { order, crossings } = geometry;
            let { layout, overrides, routed, bands, infill } = geometry;

            if (this.handleGridButtons({
                background,
                canPersist,
                layout,
                lockGrid,
                storedGrid
            })) {
                this.events.renderingFinished(options);
                return;
            }

            if (this.runArrangeFlows({ canPersist, layout, overrides, routingOptions })) {
                this.events.renderingFinished(options);
                return;
            }

            this.drawFrame({
                background,
                bands,
                canPersist,
                crossings,
                dataView,
                flowTypeColours,
                height,
                infill,
                labelOptions,
                layout,
                locked,
                numbers,
                order,
                routed,
                routingOptions,
                width
            });

            this.events.renderingFinished(options);
        } catch (error) {
            console.error("[SankeyBI] Error in update()", error);
            this.events.renderingFailed(options, String(error));
        }
    }

    /**
     * Reads the stored blobs and settings that feed later stages, and notes which of them changed.
     */
    private readStoredInputs(args: { dataView: powerbi.DataView }) {
        const { dataView } = args;
        const stored = dataView?.metadata?.objects?.["positions"];
        // The cache key for the stored positions: nodes and routes. The handles reach the geometry
        // through this string (it is what `geometryKey` is handed). The two fields are joined with
        // U+0000, which JSON text cannot contain, so no blob can forge a join.
        const positionsRaw = `${String(stored?.["nodes"] ?? "")}\u0000${String(stored?.["routes"] ?? "")}`;
        // The node editor's edits: like the positions, a change to them is a change to the graph even
        // with no data change.
        const editsRaw = String(dataView?.metadata?.objects?.["nodeEdits"]?.["edits"] ?? "");
        const editsChanged = editsRaw !== this.cachedEditsRaw;
        if (editsChanged) {
            // Canonical, like the position blobs; `this.nodeEdits` is derived from it in screen terms once
            // the axis is known below, because a node port has a frame (`turnEditPorts`).
            this.storedEdits = parseNodeEdits(editsRaw);
            this.cachedEditsRaw = editsRaw;
        }
        // The flow type colours are a data-stage input, for the same reason the edits and the flow
        // direction are: `colours.ts` resolves a type's colour inside the `dataChanged` branch, so a
        // colour changed with nothing else changing would never be re-resolved and the pick would do
        // nothing until the next data change. They are tracked by raw string, exactly as the edits are.
        const flowColoursRaw =
            String(dataView?.metadata?.objects?.["corridors"]?.["flowTypeColours"] ?? "");
        const flowColoursChanged = flowColoursRaw !== this.cachedFlowColoursRaw;
        if (flowColoursChanged) {
            this.flowTypeOverrides = parseFlowTypeColours(flowColoursRaw);
            this.cachedFlowColoursRaw = flowColoursRaw;
        }
        // The pane's Texture and Outline, under the panel's own choices. Read here, beside the blob,
        // because they reach the same function and so have to reach the same gate.
        const flowPaint: FlowPaintDefaults = {
            texture: String(this.formattingSettings.corridorsCard.flowTexture.value.value),
            outline: String(this.formattingSettings.corridorsCard.flowOutline.value.value)
        };
        const flowPaintRaw = `${flowPaint.texture}|${flowPaint.outline}`;
        const flowPaintChanged = flowPaintRaw !== this.cachedFlowPaintRaw;
        if (flowPaintChanged) {
            this.cachedFlowPaintRaw = flowPaintRaw;
        }
        // The Node labels switch and Just terminal nodes are data-stage inputs: they blank a node's
        // label before layout, in the same branch the edits are applied in, so a change with nothing
        // else changing has to re-run it or the setting does nothing until something moves. An absent
        // switch (a check's settings) is on.
        const labelScope = {
            shown: this.formattingSettings.labelsCard.showLabels?.value !== false,
            terminalOnly: Boolean(this.formattingSettings.labelsCard.terminalLabelsOnly?.value)
        };
        const labelScopeRaw = `${labelScope.shown}|${labelScope.terminalOnly}`;
        const labelScopeChanged = labelScopeRaw !== this.cachedLabelScope;
        if (labelScopeChanged) {
            this.cachedLabelScope = labelScopeRaw;
        }
        // Flow direction is a data-stage input, not a cosmetic one: it is the last fallback for a
        // corridor's ports, so it rebuilds the corridors and, through `axisOf`, the automatic grid with
        // them. It is tracked beside the edits for that reason: a setting the data stages cannot see is
        // a diagram that does not change until something else moves.
        const flowDirection = normaliseFlowDirection(
            this.formattingSettings.positionsCard.flowDirection.value.value);
        const directionChanged = flowDirection !== this.cachedFlowDirection;
        this.cachedFlowDirection = flowDirection;
        // The axis every stored route handle is judged against. From the setting, never from `axisOf`;
        // see `axisOfDirection`.
        this.handleAxis = axisOfDirection(flowDirection);
        const positionsChanged = positionsRaw !== this.cachedPositionsRaw || editsChanged;
        if (positionsChanged) {
            // The blobs hold the left-to-right frame; they are turned into screen terms below.
            this.storedPositions = parseNodePositions(String(stored?.["nodes"] ?? ""));
            this.storedOverrides = parseRouteOverrides(String(stored?.["routes"] ?? ""));
            this.cachedPositionsRaw = positionsRaw;
        }
        // Turned into screen terms every update, not just when the blob changes. The canonical blob
        // does not move when the direction does, so gating this on `positionsChanged` would leave the
        // old frame on screen until something else was edited. Everything downstream reads these two
        // and is in screen terms throughout, so no geometry, drag or routing code knows the canonical
        // frame exists.
        const onScreen = transposedFor(this.handleAxis);
        this.nodePositions = transposePositions(this.storedPositions, onScreen);
        this.routeOverrides = transposeOverrides(this.storedOverrides, onScreen);
        this.nodeEdits = transposeEditPorts(this.storedEdits, onScreen);
        return { stored, flowColoursChanged, flowPaint, flowPaintChanged, labelScope, labelScopeChanged, flowDirection, directionChanged, positionsChanged };
    }

    /** Pane visibility and status text, the panel palette, and the Import image button. */
    private presentPane(args: { canPersist: boolean; dataView: powerbi.DataView }) {
        const { canPersist, dataView } = args;
        // A background forces the lock: the nodes are placed on the picture, and a view that refitted
        // itself to the content would slide them off it. It is forced, not just defaulted: the toggle
        // is hidden while a picture is set, and comes back with its own value when the picture is
        // removed.
        const background = parseBackground(dataView?.metadata?.objects?.["background"]?.["image"]);
        const backgroundCard = this.formattingSettings.backgroundCard;
        backgroundCard.status.value = background
            ? `${background.name || "Image"} (${formatBytes(background.bytes)}). Lock grid stays on while it is set.`
            : "None. Switch on Import image to add an SVG, PNG or JPEG.";
        backgroundCard.remove.visible = background !== undefined;
        // The pickers only where the mode reads them, labelled for it.
        const colourMode = String(backgroundCard.colourMode.value.value);
        backgroundCard.darkColour.visible = colourMode === "Tint" || colourMode === "Duotone";
        backgroundCard.darkColour.displayName = colourMode === "Tint" ? "Tint colour" : "Dark parts";
        backgroundCard.lightColour.visible = colourMode === "Duotone";
        this.formattingSettings.positionsCard.lockGrid.visible = background === undefined;
        // The decimal box is hidden while Automatic decimals is on, so the pane never shows a number
        // that is being ignored.
        this.formattingSettings.valuesCard.decimalPlaces.visible =
            !this.formattingSettings.valuesCard.autoDecimals.value;
        // Each custom-colour picker only where its mode reads it, the way the Background card hides
        // its tint colours.
        const custom = (card: { colourMode: { value: { value: unknown } };
            colour: { visible?: boolean } }): void => {
            card.colour.visible = String(card.colourMode.value.value) === "Custom";
        };
        custom(this.formattingSettings.labelsCard);
        custom(this.formattingSettings.legendCard);
        this.applyPanelPalette();
        this.backgroundPanel.setAvailable(canPersist);
        // Import image opens the panel and flips itself back off. No early return: the diagram still
        // draws under the panel.
        if (canPersist && backgroundCard.importImage.value) {
            this.backgroundPanel.open();
            this.host.persistProperties({
                merge: [{ objectName: "background", selector: WHOLE_VISUAL, properties: { importImage: false } }]
            });
        }
        return { background };
    }

    /**
     * Moving the Curvature slider clears hand-set corner radii so every corner follows the slider
     * together.
     */
    private clearStaleRadii(args: { canPersist: boolean }) {
        const { canPersist } = args;
        // Moving the Curvature slider clears every hand-set corner, so all of them follow it together
        // (`withoutStaleRadii`). Nothing returns early: this frame already draws right, since a radius
        // not set at this Curvature is never applied anyway.
        const curvatureNow = this.formattingSettings.corridorsCard.curvature.value;
        const cleared = canPersist
            ? withoutStaleRadii(this.routeOverrides, curvatureNow, this.handleAxis)
            : undefined;
        // Rotating the diagram does not clear stored point handles: a point handle is stored canonical
        // and turned on read, so it follows the diagram. The corner radius can still go stale: it is a
        // fraction of the tighter pitch, which a quarter turn can swap, so it is stamped with its axis
        // and cleared when that no longer matches, the same rule the Curvature slider follows.
        if (canPersist && cleared) {
            this.persistPositions(this.nodePositions, cleared);
        }
    }

    /** The editor panels, Reset node edits, and the header switches for arrows and shapes. */
    private handleEditorButtons(args: EditorButtonInputs) {
        const { canPersist, dataView } = args;
        // The node editor: Reset clears every edit (a button, back off at once, returning like the
        // other resets); Edit nodes opens the panel and flips itself back off without returning.
        this.nodeEditorPanel.setAvailable(canPersist);
        this.layoutFilePanel.setAvailable(canPersist);
        this.flowColourPanel.setAvailable(canPersist);
        if (canPersist && this.formattingSettings.nodeShapesCard.resetEdits.value) {
            this.host.persistProperties({ merge: [
                { objectName: "nodeEdits", selector: WHOLE_VISUAL, properties: { edits: "" } },
                { objectName: "nodeShapes", selector: WHOLE_VISUAL, properties: { resetEdits: false } }
            ] });
            return true;
        }
        if (canPersist && this.formattingSettings.nodeShapesCard.editNodes.value) {
            this.openEditorPanel("nodes");
            // Opened with a node already selected: start on it.
            const selectedNode = nodeIdOf(this.selection.selectedKeys);
            if (selectedNode !== undefined) {
                this.nodeEditorPanel.focusNode(selectedNode);
            }
            this.host.persistProperties({ merge: [{ objectName: "nodeShapes", selector: WHOLE_VISUAL, properties: { editNodes: false } }] });
        }
        // Show layout file opens the layout's own panel and flips itself back off, like Edit nodes. No
        // early return.
        if (canPersist && this.formattingSettings.positionsCard.layoutFile.value) {
            this.openEditorPanel("file");
            this.host.persistProperties({ merge: [{ objectName: "positions", selector: WHOLE_VISUAL, properties: { layoutFile: false } }] });
        }
        // The Flow colour picker shows the theme's colour until it is set. A pane picker has no unset
        // state of its own (the model fills in the declared default), so the raw objects are what say
        // whether the author has chosen one. Until they have, the slice is filled with the theme's own
        // colour, so the pane shows the colour being drawn rather than a grey nobody picked, and render
        // reads the slice either way.
        if (dataView?.metadata?.objects?.["corridors"]?.["defaultFlowColour"] === undefined) {
            this.formattingSettings.corridorsCard.defaultFlowColour.value =
                { value: this.themeCorridorColour };
        }
        // Show editor opens the flow type colour panel and flips itself back off, like Edit nodes. No
        // early return: the diagram still draws under the panel.
        if (canPersist && this.formattingSettings.corridorsCard.editFlowColours.value) {
            this.openEditorPanel("flows");
            this.host.persistProperties({
                merge: [{
                    objectName: "corridors", selector: WHOLE_VISUAL,
                    properties: { editFlowColours: false }
                }]
            });
        }
        // The reset clears the blob and the button together, so the update it brings round re-resolves
        // every type from the data again.
        if (canPersist && this.formattingSettings.corridorsCard.resetFlowColours.value) {
            this.flowTypeOverrides = new Map();
            this.host.persistProperties({
                merge: [{
                    objectName: "corridors", selector: WHOLE_VISUAL,
                    properties: { flowTypeColours: "", resetFlowColours: false }
                }]
            });
        }
        return false;
    }

    /** Reset node positions and Reset route handles. */
    private handleResets() {
        // The two resets are separate because the two kinds of hand-placement are: wanting routes back
        // to automatic should not cost you a node layout you spent time on.
        //
        // They run after the blobs are read, so the half that is not being reset carries over from what
        // is actually stored rather than from whatever this instance last happened to see. They return
        // early because persistProperties brings us straight back round; rendering here would show the
        // pre-reset diagram for a frame.
        const resetNodes = this.formattingSettings.positionsCard.resetNodes.value;
        const resetRoutes = this.formattingSettings.positionsCard.resetRoutes.value;
        if (resetNodes || resetRoutes) {
            this.persistPositions(
                resetNodes ? new Map() : this.nodePositions,
                resetRoutes ? new Map() : this.routeOverrides,
                { nodes: resetNodes, routes: resetRoutes });
            return true;
        }
        return false;
    }

    /**
     * Parses the data and builds graph, corridors and colours, when the data or anything feeding
     * those stages changed.
     */
    private runDataStages(args: DataStageInputs) {
        const { dataView, directionChanged, flowColoursChanged, flowDirection, flowPaint, flowPaintChanged, labelScope, labelScopeChanged, options, positionsChanged } = args;
        // Power BI calls update() on both data changes and viewport-only changes (every tick of an
        // interactive resize drag uses the same code path). Only computeLayout/routeCorridors/render
        // below actually consume width/height; re-parsing, re-graphing and re-inferring corridors on a
        // resize-only tick reproduces identical output for real cost, so skip those stages unless this
        // update actually carries a data change (or nothing has been parsed yet).
        const dataChanged = this.cachedGraph === undefined
            || Boolean(options.type & powerbi.VisualUpdateType.Data)
            || positionsChanged
            || directionChanged
            || flowColoursChanged
            || flowPaintChanged
            || labelScopeChanged;
        if (dataChanged) {
            // Collected as well as logged: the console line is what a developer reads, the header icon is
            // what the report author reads, and they carry the same list by construction.
            const collected: string[] = [];
            const note = (list: string[]): void => {
                list.forEach(w => debugLog("[SankeyBI]", w));
                collected.push(...list);
            };
            // The row cap, said out loud. capabilities.json asks for a 30,000-row window; a `segment` on
            // the metadata is the host saying it had more to give. A partial Sankey is a wrong diagram
            // rather than an incomplete one (flows are missing and the nodes they fed no longer balance), so
            // this warns rather than paging through with `fetchMoreData`.
            if (dataView?.metadata?.segment) {
                note(["Not all rows were loaded, so some flows are missing."
                    + " Summarise the data before binding it, or reduce the number of rows."]);
            }
            const { flows: authored, warnings } = parseDataView(dataView);
            note(warnings);
            // The author's own description, turned onto the screen. A vertical reading makes the row the
            // stage axis, so an authored grid written in the column (which is what the Flow direction
            // description asks for) would read as lateral position. A mirror cannot fix it; only a
            // transpose swaps an axis.
            //
            // Here, between the parse and the corridors, and nowhere else: validation has already seen the
            // author's own values, and everything downstream reads the turned ports, so `axisOf` and
            // `senseOf` agree with the setting by construction. See `transpose.ts`.
            const flows = transposeFlows(authored, transposedFor(this.handleAxis));
            this.cachedFlows = flows;
            this.cachedValueFormat = valueFormatOf(dataView);

            if (flows.length > 0) {
                // Corridors first, then the graph. The automatic stages have to run along the axis the flow
                // actually travels, and that is a property of the resolved ports (the data's, the node
                // editor's, and the Flow direction default, in that order). Deriving it from the card alone
                // would let the grid and `axisOf` disagree whenever the data binds its own ports. The two
                // stages are otherwise independent: `inferCorridors` reads flows, not the graph.
                const { corridors, warnings: corridorWarnings } =
                    inferCorridors(flows, portDefaultsOf(this.nodeEdits), flowDirection);
                note(corridorWarnings);

                const { graph, warnings: graphWarnings } =
                    buildGraph(flows, this.nodePositions, axisOf(corridors));
                note(graphWarnings);
                // Edits beat the data for label, name and icon; for ports the data wins and an edit only
                // fills the blanks.
                this.nodeFacts = applyNodeEdits(graph, this.nodeEdits);
                applyLabelScope(graph, corridors, this.nodeEdits, labelScope);

                const flowTypeColours = resolveFlowTypeColours(
                    corridors, this.colorPalette, this.host.locale, this.flowTypeOverrides,
                    flowPaint);
                note(flowTypeColours.warnings);
                // After the types, never before: see the field's comment.
                this.themeCorridorColour =
                    this.colorPalette.getColor("sankeybi-corridor").value;

                this.cachedGraph = graph;
                this.cachedCorridors = corridors;
                this.cachedFlowTypeColours = flowTypeColours;
            } else {
                this.cachedGraph = undefined;
                this.cachedFlowTypeColours = undefined;
                this.nodeFacts = [];
            }
            this.cachedWarnings = collected;
        }
    }

    /** Hands the node editor and the flow colour editor what they list. */
    private refreshPanels(args: { flowDirection: FlowDirection }) {
        const { flowDirection } = args;
        this.nodeEditorPanel.setModel(this.nodeFacts, this.nodeEdits,
            DEFAULT_PORTS[flowDirection]);
        // Legend order, and the colour actually drawn for each type: the panel prefills a picker from
        // what is on screen rather than from a default nobody chose. `fromData` is kept apart so a row
        // can say where its colour came from and offer to go back to it.
        // Whether a type is drawn with a texture now, and the two colours it is drawn in: the same
        // function the bands use, so each picker opens on what is on screen.
        const drawnColours = this.cachedFlowTypeColours;
        const coloursFor = textureColoursFor(this.formattingSettings, this.colorPalette, this.themeCorridorColour);
        const textured = (type: string): boolean => drawnColours?.patterns?.has(type) === true;
        const texturePair = (type: string): { ink: string; paper: string } =>
            drawnColours ? coloursFor(type, drawnColours) : { ink: "#605e5c", paper: "#ffffff" };
        const colourRows: FlowTypeRow[] = (this.cachedFlowTypeColours?.order ?? []).map(type => {
            const fromData = this.cachedFlowTypeColours?.dataColours.get(type);
            const stored = this.flowTypeOverrides.get(type);
            return {
                type,
                drawn: this.cachedFlowTypeColours?.colours.get(type) ?? "#605e5c",
                // What the legend and the tooltips call it now, so the box opens on what is on screen rather
                // than on a default.
                shownAs: flowTypeLabel(type, this.cachedFlowTypeColours?.labels),
                // What is stored, not what is drawn. The resolved maps have the pane's defaults folded in, so
                // a row filled from them could not tell "Auto" from "set by hand", and every type would open
                // looking edited. The auto pair beside it is what the control's own `Auto` option says it would
                // do, read from `colours.ts` so the label and the diagram cannot disagree.
                ...(stored?.pattern !== undefined ? { pattern: stored.pattern } : {}),
                ...(stored?.outline !== undefined ? { outline: stored.outline } : {}),
                ...(stored?.ink !== undefined ? { ink: stored.ink } : {}),
                ...(stored?.paper !== undefined ? { paper: stored.paper } : {}),
                ...(textured(type) ? { textured: true, textureIndex: drawnColours?.patterns?.get(type), inkDrawn: texturePair(type).ink, paperDrawn: texturePair(type).paper } : {}),
                ...(this.cachedFlowTypeColours?.autoPatterns?.has(type)
                    ? { autoPattern: this.cachedFlowTypeColours.autoPatterns.get(type) }
                    : {}),
                ...(this.cachedFlowTypeColours?.paneOutline !== undefined
                    ? { autoOutline: this.cachedFlowTypeColours.paneOutline }
                    : {}),
                ...(fromData !== undefined ? { fromData } : {})
            };
        });
        this.flowColourPanel.setModel(colourRows, this.flowTypeOverrides);
    }

    /**
     * The settings that shape layout and routing, gathered into the layout chrome and routing
     * options.
     */
    private buildChrome(args: ChromeInputs) {
        const { background, flowTypeColours, graph } = args;
        // Numbers, formatted the way the model and the report ask. The largest figure in the diagram
        // is what Auto display units choose from, so every label gets the same unit: scaling each on
        // its own would print "1.2M" beside "840K".
        let largest = 0;
        graph.nodes.forEach(node => {
            largest = Math.max(largest, Math.abs(node.inflow), Math.abs(node.outflow));
        });
        const numbers: NumberFields = {
            valueFormat: this.cachedValueFormat,
            locale: this.host.locale,
            measureText: this.measureText,
            formatValue: valueFormatterFor({
                displayUnits: (this.formattingSettings.valuesCard.displayUnits?.value?.value
                    ?? "None") as DisplayUnits,
                autoDecimals: this.formattingSettings.valuesCard.autoDecimals?.value ?? false,
                decimalPlaces: this.formattingSettings.valuesCard.decimalPlaces.value
            }, {
                valueFormat: this.cachedValueFormat,
                locale: this.host.locale,
                largest
            })
        };
        const legendVisible = this.formattingSettings.legendCard.show.value && flowTypeColours.order.length > 0;
        const legendPosition = this.formattingSettings.legendCard.position.value.value as LegendPosition;
        // One arrow options object for both stages. The gap is a layout input as well as a routing
        // one (the node is sized to hold it), and layout placing the apex against a different number
        // from the one routing draws to would be a gap that is never quite what was asked for.
        const arrows: ArrowOptions = {
            heads: this.formattingSettings.nodeShapesCard.heads.value,
            tails: this.formattingSettings.nodeShapesCard.tails.value,
            angleDegrees: this.formattingSettings.nodeShapesCard.angle.value,
            gapPercent: this.formattingSettings.nodeShapesCard.gapPercent.value
        };
        const routingOptions = {
            curvaturePercent: this.formattingSettings.corridorsCard.curvature.value,
            style: normaliseStyle(String(this.formattingSettings.corridorsCard.routingStyle.value.value)),
            avoidNodes: this.formattingSettings.corridorsCard.avoidNodes.value,
            arrows
        };
        const straighten = this.formattingSettings.corridorsCard.straighten.value;
        const labelOptions = labelOptionsFrom(this.formattingSettings, numbers,
            flowTypeColours?.labels);
        const chrome: LayoutChrome = {
            legendVisible,
            legendPosition,
            nodeShape: this.formattingSettings.nodeShapesCard.shape.value.value as NodeShape,
            nodeMinWidthPercent: this.formattingSettings.nodeShapesCard.minWidth.value,
            nodeMinHeightPercent: this.formattingSettings.nodeShapesCard.minHeight.value,
            nodeShapeFitLabel: this.formattingSettings.nodeShapesCard.fitLabel.value,
            nodeShapePaddingPercent: this.formattingSettings.nodeShapesCard.padding.value,
            labels: labelOptions,
            arrows,
            flowWidthPercent: this.formattingSettings.corridorsCard.flowWidth.value,
            // Undefined unless the toggle is on, so the auto reference is untouched by the setting.
            // `LayoutChrome` is what `geometryKey` hashes whole, so this is covered by the key the day it
            // is added.
            flowBaselineValue: this.formattingSettings.corridorsCard.fixedBaseline.value
                ? this.formattingSettings.corridorsCard.baselineValue.value
                : undefined,
            flowSeparationPercent: this.formattingSettings.corridorsCard.flowSeparation.value,
            backdropAspect: background ? aspectOf(background) : undefined
        };
        return { numbers, routingOptions, straighten, labelOptions, chrome };
    }

    /**
     * Arrange nodes button, and the automatic arrangement that runs once when there is nothing
     * stored.
     */
    private runArrangeNodes(args: ArrangeNodesInputs) {
        const { canPersist, chrome, flowDirection, height, locked, stored, width } = args;
        // Arrange nodes rearranges the nodes themselves, on the abstract layered graph rather than by
        // measuring drawings (`arrangeNodes.ts`). It needs no layout and no routing of its own (the
        // model is which node is above which), only the chrome, since the positions it writes are
        // measured against the same grid layout will build. So it sits before the layout rather than
        // after it: the diagram this frame would have drawn is thrown away by the early return anyway,
        // and laying it out first would cost a full pass for a picture nobody sees.
        //
        // It returns early like the other buttons: persistProperties brings us straight back round, and
        // painting the old arrangement first would show a frame of it. Anything below that also writes
        // (the Lock grid capture, Remove image) is simply deferred to that next update, exactly as the
        // resets above defer it.
        const logical = this.formattingSettings.positionsCard.arrangeNodes.value;

        // The arrangement also runs on its own, once. A fit is never applied over an arrangement that
        // exists. It fires only where there is nothing stored at all, and again when the bound roles
        // change in a way that changes the geometry: binding a port moves which face a flow leaves by,
        // so the old arrangement was computed against a different diagram.
        //
        // Reset re-fits: "Reset node positions" writes an empty map, so the next update finds nothing
        // stored and arranges again. Reset means "start over from the best automatic guess" rather than
        // "show me the bare grid".
        //
        // It runs in edit mode only, because it has to persist what it did or it would run at every
        // update forever; `canPersist` already says so for every other button here. The decision itself
        // lives in `positions.ts`, as a pure function of five facts: nothing in visual.ts is reachable
        // by the checks, and the one thing that must not go wrong here is a loop.
        //
        // The signature covers the bound roles only, not the Flow direction axis. The transpose makes
        // hand placement follow the diagram round, so a direction change needs no arrangement, and
        // firing one would be destructive: an arrangement writes a position for every node, replacing
        // the author's own placement.
        const fitSignature = fitSignatureOf(this.cachedFlows);
        // What this instance arranged wins over what was stored: see `cachedFitSignature`.
        const fittedAs = this.cachedFitSignature || String(stored?.["fitted"] ?? "");
        const automatic = needsAutomaticArrange({
            canPersist,
            flowCount: this.cachedFlows.length,
            placedCount: this.nodePositions.size,
            storedSignature: fittedAs,
            signature: fitSignature,
            buttonDown: logical
        });
        // The one combination that should be impossible: the roles changed, the visual could act, and
        // it did not. It is said out loud rather than left silent, because a trigger that fires and
        // changes nothing looks exactly like one that never fired. Nothing in `update()` is reachable
        // by the checks, so the console is the only witness there is.
        if (canPersist && !logical
            && fittedAs !== "" && fittedAs !== fitSignature && !automatic) {
            debugLog(`[SankeyBI] roles changed ${fittedAs} -> ${fitSignature}`
                + ` but the arrangement did not re-run`);
        }

        if (canPersist && (logical || automatic)) {
            const what = automatic ? "Arrange nodes (automatic)" : "Arrange nodes";
            let placed = this.nodePositions;
            // Its own try/catch, for the reason the route fit has one: a throw left to update()'s outer
            // catch skips the persist below, and the button stays down with nothing drawn and nothing said.
            try {
                // One snapshot, derived here. The staged graph is rebuilt from `cachedFlows` (staged from the
                // topology, not from what is stored), while the corridors would otherwise be taken from the
                // cache. That pairing is only safe while the two cannot disagree, and they can: binding a port
                // would arrange the diagram with the new flows and the old ports, and the arrangement would
                // come out the same as before the ports existed.
                //
                // Deriving both from `cachedFlows` makes the mismatch impossible rather than unlikely: graph,
                // corridors and axis come from one set of rows by construction. It costs one `inferCorridors`
                // on a fit, which is a button press or a once-per-signature automatic run, never a render.
                const staging = inferCorridors(
                    this.cachedFlows, portDefaultsOf(this.nodeEdits), flowDirection).corridors;
                const staged = buildGraph(this.cachedFlows, new Map(), axisOf(staging)).graph;
                const request = {
                    graph: staged,
                    corridors: staging,
                    pinned: handPlacedPositions(this.nodePositions),
                    snapStep: snapStepOf(this.formattingSettings.positionsCard.snap.value)
                };
                const arranged = arrangeNodes(request);
                placed = withAutoPlacement(this.nodePositions, arranged.positions);
                // With the grid locked, the arrangement is fitted into the locked window rather than the view
                // being fitted to it: lay it out as the fit would, then map that fitted window onto the locked
                // one. Hand-placed nodes stay put.
                if (locked) {
                    const handPlaced = handPlacedPositions(this.nodePositions);
                    const flows = this.cachedFlows;
                    const corridors = staging;
                    const edits = this.nodeEdits;
                    // Edited labels and icons change how far a label reaches, so the trial layouts carry them too.
                    const axis = axisOf(corridors);
                    const trialGraph = (trial: NodePositions) => {
                        const graph = buildGraph(flows, trial, axis).graph;
                        applyNodeEdits(graph, edits);
                        applyLabelScope(graph, corridors, edits, {
                            shown: this.formattingSettings.labelsCard.showLabels?.value !== false,
                            terminalOnly: Boolean(
                                this.formattingSettings.labelsCard.terminalLabelsOnly?.value)
                        });
                        return graph;
                    };
                    placed = fitIntoWindow(placed, locked, id => handPlaced.has(id),
                        snapStepOf(this.formattingSettings.positionsCard.snap.value),
                        trial => computeLayout(trialGraph(trial), corridors, width, height, chrome).frame);
                }
                // Crossings are only a report for Arrange nodes; worth printing, because a diagram that looks
                // tangled is worth being able to put a number on.
                debugLog(`[SankeyBI] ${what}: crossings ${arranged.crossingsBefore} -> `
                    + `${arranged.crossingsAfter} (${arranged.axis}, ${arranged.layers} layers, `
                    + `${arranged.dummies} pass-through lanes), ${arranged.moved} nodes moved`);
            } catch (error) {
                console.error(`[SankeyBI] ${what} failed`, error);
                placed = this.nodePositions;
            }
            // Arrange flows always follows Arrange nodes. Setting the toggle rather than calling the route
            // fit here is deliberate: the route fit needs the layout the new positions produce, and the
            // persist brings us straight back round with exactly that. It then releases the toggle itself,
            // as a hand press would.
            this.cachedFitSignature = fitSignature;
            this.persistPositions(placed, this.routeOverrides, {
                arrangeNodes: logical,
                chainRoutes: true,
                fitted: fitSignature
            });
            return true;
        }
        return false;
    }

    /**
     * Lays the diagram out and routes it, reusing the cached geometry when nothing that shapes it
     * has changed.
     */
    private layOutAndRoute(args: GeometryInputs) {
        const { chrome, graph, height, locked, routingOptions, straighten, width } = args;
        // Geometry is kept between updates, because most updates do not change it. A format change
        // arrives exactly as a data change does (the dataView comes back with new
        // `metadata.objects`), so laying out and routing unconditionally would mean every colour,
        // tooltip or legend tweak paying for the whole pipeline, and again on every tick of a slider
        // drag. The key covers everything the kept result depends on or carries; see `geometryKey`.
        //
        // Hand-placed nodes: a column holding one is left to the author (`justify.ts`).
        const handPlacedIds = new Set(handPlacedPositions(this.nodePositions).keys());
        const key = geometryKey(graph, this.cachedCorridors, {
            width, height, chrome, routing: routingOptions, straighten,
            locked, positionsRaw: this.cachedPositionsRaw
        });
        const reusable = this.cachedGeometry?.key === key ? this.cachedGeometry : undefined;
        let layout = reusable
            ? reusable.layout
            : computeLayout(graph, this.cachedCorridors, width, height, chrome, undefined, locked);
        // Rebuilt rather than kept: it is a pure function of the layout, the stored handles and the
        // Curvature, all of which the key already covers, and Arrange flows below wants it either way.
        let overrides = this.overridesInPixels(layout);
        let routed: DiagramRouting;
        // Which corridor is painted over which: reused with the cached geometry, or decided below once
        // the routes are final.
        let painting: { order: readonly string[]; crossings: CrossingPairs } | undefined = reusable;
        if (reusable) {
            routed = reusable.routed;
        } else {
            // Straighten must see the same flipped self-loops routing will, or the two disagree about
            // where every other end on those faces sits.
            justifyEnds(layout, handPlacedIds);
            straightenNodes(layout, straighten);
            routed = routeDiagram(layout, routingOptions, overrides);
        }
        let bands = routed.bands;
        let infill: NodeInfill[] = routed.infill;

        // The outermost drawn thing sets the view. Nodes and labels are measured inside the fit; flows
        // can only be measured once routed. So where they reach past the nodes (a wrap round the
        // outside, a self-loop over the top), lay out once more with them counted as content, and the
        // margin lands outside the flow instead of the flow sitting flush against one edge. This is
        // measured in grid units, which the flows' pitch-relative geometry holds to. Where nothing
        // reaches past (most diagrams), there is no second pass at all.
        //
        // It repeats while it still moves things (see `flowPassNeeded`), at most MAX_FLOW_PASSES
        // times. A wrap can change shape as the gap narrows, so a diagram occasionally has not settled
        // by then; one last pass with the union of what was assumed and what was drawn then lands every
        // flow inside the frame, at the cost of part of that side's margin.
        if (!reusable) {
            let flows: GridWindow | undefined;
            for (let pass = 0; pass <= MAX_FLOW_PASSES && !locked; pass++) {
                const measured = flowExtentOf(layout, bands);
                if (!measured || !flowPassNeeded(layout, measured)) {
                    break;
                }
                flows = pass < MAX_FLOW_PASSES || !flows ? measured : unionOf(flows, measured);
                layout = computeLayout(graph, this.cachedCorridors, width, height, chrome, undefined, undefined, flows);
                overrides = this.overridesInPixels(layout);
                justifyEnds(layout, handPlacedIds);
                straightenNodes(layout, straighten);
                routed = routeDiagram(layout, routingOptions, overrides);
                bands = routed.bands;
                infill = routed.infill;
            }

            // A wrap route deliberately travels outside its nodes' bounds, so whether it fits can only be
            // known once it has been routed. If anything spilled past the viewport, reserve exactly that
            // much and lay out again. One extra pass only: the second layout is strictly tighter, so it
            // cannot spill further, and re-routing forever chasing a moving target is not worth it.
            //
            // Not under Lock grid: the locked frame already holds the room this pass reserved when it was
            // captured, and reserving again would move the grid the lock is holding still.
            const overflow = locked ? undefined : overflowOf(layout, bands, width, height);
            if (overflow) {
                layout = computeLayout(graph, this.cachedCorridors, width, height, chrome, overflow, locked, flows);
                // The second layout is a different grid, so its nodes need straightening again from scratch:
                // the first pass's nudges were measured against positions that no longer exist.
                overrides = this.overridesInPixels(layout);
                justifyEnds(layout, handPlacedIds);
                straightenNodes(layout, straighten);
                routed = routeDiagram(layout, routingOptions, overrides);
                bands = routed.bands;
                infill = routed.infill;
            }

            // Kept only once every pass above has had its say, so what is stored is the diagram as drawn.
            // The result is read from here on and never fed back in: `straightenNodes` and
            // `buildNodeInfill` both write to the layout they are given, so re-running them over a kept one
            // would compound.
            //
            // The paint order is decided here rather than in render, and on the final routes: which
            // corridor is on top depends on where each one actually travels, so a flow pass that reshapes a
            // route can change the answer. Render paints; it decides nothing. The crossings come back with
            // it: finding them is the expensive half, and the channels and the order then always agree about
            // what a crossing is.
            const layering = paintLayering(layout, bands, routed.centrelines);
            painting = layering;
            this.cachedGeometry = { key, layout, routed, order: layering.order, crossings: layering.crossings };
        }
        if (!painting) {
            throw new Error("SankeyBI: the paint order was neither cached nor computed");
        }
        const { order, crossings } = painting;
        return { order, crossings, layout, overrides, routed, bands, infill };
    }

    /** Captures or releases the locked grid window, and handles Remove image. */
    private handleGridButtons(args: GridButtonInputs) {
        const { background, canPersist, layout, lockGrid, storedGrid } = args;
        // Lock grid switched on: capture the window this frame shows, so the locked view starts out
        // exactly as the fitted one looked. Switched off: drop it, and the view fits the content again.
        // No early return, since this frame is already drawn right either way. With a background, what
        // is captured is the picture's own letterboxed rectangle read through this grid, so locking maps
        // the grid onto the picture without rescaling what is drawn.
        if (canPersist && lockGrid && !storedGrid) {
            this.persistGrid(background
                ? frameOfRect(layout, letterbox(layout.chromeBox, aspectOf(background)))
                : layout.frame);
        } else if (canPersist && !lockGrid && storedGrid) {
            this.persistGrid(undefined);
        }

        // Remove image: a button like the resets. The frame handed back is the whole chrome box read
        // through this grid, so if Lock grid is on underneath, the diagram keeps its place and scale; if
        // it is off, the next update clears the frame and the view refits.
        if (canPersist && this.formattingSettings.backgroundCard.remove.value) {
            this.host.persistProperties({
                merge: [
                    { objectName: "background", selector: WHOLE_VISUAL, properties: { image: "", remove: false } },
                    { objectName: "positions", selector: WHOLE_VISUAL, properties: this.gridProperties(frameOfRect(layout, layout.chromeBox)) }
                ]
            });
            return true;
        }
        return false;
    }

    /**
     * Arrange flows button: searches handle positions that part flows lying along each other,
     * stores them, and releases the button.
     */
    private runArrangeFlows(args: ArrangeFlowsInputs) {
        const { canPersist, layout, overrides, routingOptions } = args;
        // Arrange flows is a button like the two resets, but it can only act here: it searches handle
        // positions by re-routing them, so it needs a laid-out, routed diagram, which is what the lines
        // above just produced, overflow pass included. What it writes is ordinary route overrides, so
        // the diagram it asks for is one the author could have dragged by hand, "Reset route handles"
        // undoes it, and anything it gets wrong is still draggable. It returns early for the same reason
        // the resets do: persistProperties brings us straight back round, and painting the unfitted
        // diagram first would show a frame of the old routes.
        if (canPersist && this.formattingSettings.positionsCard.arrangeFlows.value) {
            let stored = this.routeOverrides;
            // Its own try/catch, so a failure releases the button. Left to update()'s outer catch, a throw
            // in the search would skip the persist below and the toggle would stay down with nothing drawn
            // and nothing said, which is what a stuck button looks like from the format pane. Whatever
            // happens here, the button comes back up and the diagram is drawn: a fit that fails is worth a
            // console line, not a visual that stops working.
            try {
                const fitted = arrangeFlows(layout, routingOptions, overrides);
                fitted.overrides.forEach((points, corridorId) => {
                    (["source", "target", "middle"] as RouteHandleKind[]).forEach(kind => {
                        const point = points[kind];
                        if (point) {
                            // Through the grid, exactly as a drop does: a stored handle is in grid units so it survives a
                            // resize (positions.ts).
                            stored = withRouteHandle(stored, corridorId, kind,
                                gridPositionOf(layout, point.x, point.y));
                        }
                    });
                });
                debugLog(`[SankeyBI] Auto-fit: overlap ${fitted.before} -> ${fitted.after} cells, `
                    + `parallel pairs ${fitted.pairsBefore} -> ${fitted.pairsAfter}, `
                    + `${fitted.moved} corridors moved`);
            } catch (error) {
                console.error("[SankeyBI] Auto-fit failed", error);
                stored = this.routeOverrides;
            }
            this.persistPositions(this.nodePositions, stored, { arrangeFlows: true });
            return true;
        }
        return false;
    }

    /** Wires dragging, tooltips and selection, then paints the diagram. */
    private drawFrame(args: FrameInputs) {
        const { background, bands, canPersist, crossings, dataView, flowTypeColours, height, infill, labelOptions, layout, locked, numbers, order, routed, routingOptions, width } = args;
        // Dragging is an authoring action: in a published report's reading view persistProperties does
        // not stick, so offering handles there would be a promise the host cannot keep. "Lock
        // positions" is the author's own version of the same thing: once a layout is finished, nothing
        // should move by accident.
        const editing = canPersist && !this.formattingSettings.positionsCard.lock.value;
        const drag: WaypointDragOptions | undefined = editing
            ? {
                layout,
                // The setting counts divisions of a cell; the drag layer wants the step itself, so 4 becomes a
                // quarter and 3 an exact third. The snap works in grid units, so a quarter-column stays a
                // quarter-column however the visual is resized.
                snapStep: snapStepOf(this.formattingSettings.positionsCard.snap.value),
                viewport: { width, height },
                // Lock grid: a drop past the edge is held at it, so a drag can never widen the window.
                bounds: locked ? drawingAreaOf(layout) : undefined,
                onCommit: (nodeId, position) => this.moveNode(nodeId, position),
                onMoveHandle: (corridorId, kind, position) => this.moveHandle(corridorId, kind, position),
                onResetHandle: (corridorId, kind) => this.moveHandle(corridorId, kind, undefined),
                onResizeCorner: (corridorId, radius) => this.resizeCorner(corridorId, radius)
            }
            : undefined;

        this.lastLayout = layout;
        this.lastHandles = routed.handles;
        // What Baseline value is being set against, in the data's own units: the busiest node's
        // throughput at this selection, which is what one full node thickness means while Fixed flow
        // baseline is off. Written here rather than beside the Background card's status line because
        // only the finished layout knows it.
        this.formattingSettings.corridorsCard.baselineCurrent.value =
            `${formatTotal(layout.autoBaseline, labelOptions)} at this selection`;

        // Handing render an empty handle map is how "Show route handles" is turned off: nodes stay
        // draggable, the dots simply are not there to clutter a diagram being laid out.
        const handles = this.formattingSettings.positionsCard.showHandles.value
            ? draggableHandles(routed.handles, routingOptions.style)
            : new Map();

        // Reset the registry before painting: render empties the SVG, so every element the controller
        // is holding is about to be detached.
        this.selection.beginFrame(dataView, this.cachedCorridors, {
            tooltips: this.formattingSettings.interactionCard.tooltips.value
        });
        render(this.svg, {
            layout,
            bands,
            colorPalette: this.colorPalette,
            settings: this.formattingSettings,
            flowTypeColours,
            viewportWidth: width,
            viewportHeight: height,
            drag,
            routeHandles: handles,
            corridors: this.cachedCorridors,
            selection: this.selection,
            infill,
            background: background && this.formattingSettings.backgroundCard.show.value
                ? {
                    url: background.url,
                    transparency: this.formattingSettings.backgroundCard.transparency.value,
                    filter: backgroundFilterOf(String(this.formattingSettings.backgroundCard.colourMode.value.value),
                        this.formattingSettings.backgroundCard.darkColour.value.value,
                        this.formattingSettings.backgroundCard.lightColour.value.value)
                }
                : undefined,
            paintOrder: order,
            // Only detoured corridors are in here, so an ordinary diagram hands render an empty map and it
            // draws nothing extra.
            routeGhosts: routed.ghosts,
            // Crossing separation is pure paint, so it is read here rather than keyed; at 0 render adds no
            // element at all. It is in pixels: 1 means 1px.
            crossings: {
                margin: Math.max(0, this.formattingSettings.corridorsCard.crossingSeparation.value),
                silhouettes: routed.silhouettes,
                pairs: crossings
            },
            numbers,
            // A corridor's drawn thickness is the sum of its stripes', which routing reports per band.
            // Built here because the spines are routing's and render is not handed them.
            flowLabelInput: flowLabelInputOf(this.cachedCorridors, bands, routed.spines)
        });
        // And re-apply afterwards, so a selection made before a resize or a format change is still
        // visibly selected after it.
        this.selection.applyVisualState();
    }

    /**
     * Records one dropped node. Called from the drag layer on release only, never during a drag,
     * since persistProperties triggers a fresh update() and the diagram would redraw under the
     * pointer.
     */
    private moveNode(nodeId: string, position: GridPosition): void {
        this.persistPositions(withNodeMoved(this.nodePositions, nodeId, position), this.routeOverrides);
    }

    /** The stored grid handle positions converted to pixels for this layout. */
    private overridesInPixels(layout: LayoutResult): Map<string, RouteOverridePoints> {
        const out = new Map<string, RouteOverridePoints>();
        this.routeOverrides.forEach((handles, corridorId) => {
            const points: RouteOverridePoints = {};
            (["source", "target", "middle", "detour"] as RouteHandleKind[]).forEach(kind => {
                const p = handles[kind];
                if (p) {
                    points[kind] = pixelPositionOf(layout, p.column, p.row, 0);
                }
            });
            // Already in the unit routing wants (a fraction of the tighter grid pitch), so it passes
            // straight through, but only while the Curvature slider is where it was when the radius was
            // set; move the slider and the corner follows it (`radiusInForce`).
            const radius = radiusInForce(handles, this.formattingSettings.corridorsCard.curvature.value, this.handleAxis);
            if (radius !== undefined) {
                points.radius = radius;
            }
            out.set(corridorId, points);
        });
        return out;
    }

    /** Moves one route handle, or resets it to its computed place when undefined. */
    private moveHandle(corridorId: string, kind: RouteHandleKind, position: GridPosition | undefined): void {
        // Whether the middle handle is a bend or a stored crossover is routing's answer, not one to
        // infer from the style: a wrap route has a lane in every style, and treating a Smooth
        // self-loop's lane as a bend would write the drag into two lead overrides the lane never reads,
        // so the handle would sit still.
        if (kind === "middle" && this.lastHandles.get(corridorId)?.middle?.gesture) {
            this.slideBend(corridorId, position);
            return;
        }
        // An Octilinear lead pins the other lead where it is. The drag snapped the angle with the
        // other end held still, but that end may never have been stored (it sits where the 45-degree
        // fit put it), and left unstored it falls back to its default and the fit moves both, so the
        // drop lands off the pointer. Storing both, like the bend gesture does, keeps the promise the
        // ghost made.
        const route = this.lastHandles.get(corridorId);
        const layout = this.lastLayout;
        // Leads only: the middle is a bend or a crossover and the detour is a lane, and neither snaps
        // an angle.
        const isLead = kind === "source" || kind === "target";
        if (position && layout && route && isLead && route[kind]?.angleSnap) {
            const otherKind: RouteHandleKind = kind === "source" ? "target" : "source";
            const other = route[otherKind];
            if (other) {
                const pinned = gridPositionOf(layout, other.point.x, other.point.y);
                this.persistPositions(this.nodePositions, withRouteHandle(
                    withRouteHandle(this.routeOverrides, corridorId, kind, position), corridorId, otherKind, pinned));
                return;
            }
        }
        this.persistPositions(
            this.nodePositions,
            withRouteHandle(this.routeOverrides, corridorId, kind, position));
    }

    /**
     * A Smooth self-loop's corner handle: its radius, or `undefined` to hand the corners back to
     * the Curvature slider. Stored on its own: the handle's position is derived from it, so
     * dragging a lead or the lane later keeps the roundness the author chose.
     */
    private resizeCorner(corridorId: string, radius: number | undefined): void {
        // Stamped with the axis as well as the Curvature: a radius is a fraction of the tighter pitch,
        // which a quarter turn can swap, so it is the one stored handle that cannot be turned and is
        // cleared instead (`radiusInForce`).
        let overrides = withRouteRadius(this.routeOverrides, corridorId, radius,
            this.formattingSettings.corridorsCard.curvature.value, this.handleAxis);
        // Where the corner handle is the route's only control (a direct 90-degree Smooth corner), its
        // leads are hidden, so resetting it also clears any left over from older lead handles, or a
        // corner shaped that way could never go back to the default.
        if (radius === undefined && this.lastHandles.get(corridorId)?.corner?.replacesLeads) {
            overrides = withRouteHandle(withRouteHandle(overrides, corridorId, "source", undefined),
                corridorId, "target", undefined);
        }
        this.persistPositions(this.nodePositions, overrides);
    }

    /**
     * Polyline's bend handle is a gesture, not a stored value.
     *
     * Its job is to move the bend while holding the angle (an angle matched to others by hand is
     * annoying to lose), and that is "move both leads by the same amount in opposite directions",
     * so it is written into the two lead overrides rather than stored as a third number. With the
     * model kept at two free numbers there is nothing left to disagree: a stored bend position
     * would have to be applied on top of the leads, and whichever order the two were resolved in,
     * one of them would stop landing where it was dropped.
     *
     * Double-clicking it resets both leads, since between them they are where the bend is.
     */
    private slideBend(corridorId: string, position: GridPosition | undefined): void {
        const layout = this.lastLayout;
        const handles = this.lastHandles.get(corridorId);
        if (!layout || !handles?.middle) {
            return;
        }
        const clear = (overrides: RouteOverrides): RouteOverrides =>
            withRouteHandle(withRouteHandle(overrides, corridorId, "source", undefined),
                corridorId, "target", undefined);
        if (position === undefined) {
            this.persistPositions(this.nodePositions, clear(this.routeOverrides));
            return;
        }

        const axis = handles.middle.axis;
        const drop = pixelPositionOf(layout, position.column, position.row, 0);
        const delta = drop[axis] - handles.middle.point[axis];
        const slid = (point: { x: number; y: number }): GridPosition => {
            const moved = axis === "x"
                ? { x: point.x + delta, y: point.y }
                : { x: point.x, y: point.y + delta };
            return gridPositionOf(layout, moved.x, moved.y);
        };
        if (!handles.source || !handles.target) {
            return;
        }
        let overrides = withRouteHandle(this.routeOverrides, corridorId, "source", slid(handles.source.point));
        overrides = withRouteHandle(overrides, corridorId, "target", slid(handles.target.point));
        this.persistPositions(this.nodePositions, overrides);
    }

    /**
     * Writes the positions blob back into the report.
     *
     * The local copy is updated to match rather than waiting for the update() this triggers: two
     * drags in quick succession would otherwise both build on the stale map and the first would be
     * lost.
     */
    private persistPositions(
        positions: NodePositions,
        overrides: RouteOverrides,
        /** Which of the card's "buttons" to put back up, having just acted on them. */
        acted: {
            nodes?: boolean; routes?: boolean; arrangeFlows?: boolean;
            arrangeNodes?: boolean;
            /** Puts Arrange flows down, so it runs on the update this persist brings. */
            chainRoutes?: boolean;
            /** The bound-role signature the arrangement was computed against. */
            fitted?: string;
        } = {}
    ): void {
        this.nodePositions = positions;
        this.routeOverrides = overrides;
        // Every caller hands these in screen terms (a drag, a button, the route fit, an arrange), so
        // this is the one place that turns them back to the canonical left-to-right frame. The stored
        // blobs therefore hold the same frame whatever direction they were written in.
        const back = transposedFor(this.handleAxis);
        this.storedPositions = transposePositions(positions, back);
        this.storedOverrides = transposeOverrides(overrides, back);
        const nodes = serialiseNodePositions(this.storedPositions);
        const routes = serialiseRouteOverrides(this.storedOverrides);
        // The cached raw string is deliberately not written here. The update this persist brings
        // round has to see the positions as changed, or it skips the data stages and `cachedGraph`
        // keeps the old placements (`buildGraph` takes them as node overrides), and the node that was
        // just dragged snaps back until something else moves.
        const properties: Record<string, powerbi.DataViewPropertyValue> =
            { nodes, routes };
        // Left up, every later update would reset again and nothing could ever be placed by hand.
        if (acted.nodes) {
            properties.resetNodes = false;
        }
        if (acted.routes) {
            properties.resetRoutes = false;
        }
        if (acted.arrangeFlows) {
            properties.arrangeFlows = false;
        }
        if (acted.arrangeNodes) {
            properties.arrangeNodes = false;
        }
        // Down, not up: this is the one that asks for a button rather than releasing one. It cannot
        // collide with `acted.arrangeFlows` above, which only ever runs on the route fit's own persist.
        if (acted.chainRoutes) {
            properties.arrangeFlows = true;
        }
        if (acted.fitted !== undefined) {
            properties.fitted = acted.fitted;
        }
        this.host.persistProperties({
            merge: [{
                objectName: "positions",
                selector: WHOLE_VISUAL,
                properties
            }]
        });
    }

    /**
     * Stores an imported picture, and with it the frame the lock will hold: the picture's
     * letterboxed rectangle read through the grid as drawn now, so the diagram keeps its place and
     * scale and the picture simply appears behind it. Before anything has been drawn there is no
     * grid to read, and the frame is captured on the next update instead.
     */
    private importBackground(image: BackgroundImage): void {
        const merge: powerbi.VisualObjectInstance[] = [
            { objectName: "background", selector: WHOLE_VISUAL, properties: { image: serialiseBackground(image) } }
        ];
        const layout = this.lastLayout;
        if (layout) {
            merge.push({
                objectName: "positions", selector: WHOLE_VISUAL,
                properties: this.gridProperties(frameOfRect(layout, letterbox(layout.chromeBox, aspectOf(image))))
            });
        }
        this.host.persistProperties({ merge });
    }

    /**
     * Writes the node editor's edits. The local copy is updated at once, like the positions, so two
     * quick edits do not both build on a stale map; the cached raw string is left alone, so the
     * update this triggers rebuilds the graph with them.
     */
    private persistEdits(edits: NodeEdits): void {
        this.nodeEdits = edits;
        // Turned back to canonical on the way out, like the positions: the panel hands these in screen
        // terms because that is the face the author is looking at.
        this.storedEdits = transposeEditPorts(edits, transposedFor(this.handleAxis));
        this.host.persistProperties({
            merge: [{
                objectName: "nodeEdits", selector: WHOLE_VISUAL,
                properties: { edits: serialiseNodeEdits(this.storedEdits) }
            }]
        });
    }

    /**
     * Puts the visual's own panels into high contrast, or takes them out.
     *
     * The diagram answers `isHighContrast`, and so must its UI: `style/visual.less` would otherwise
     * carry hardcoded colours and no high-contrast handling, and the node editor, the flow colour
     * editor and the background import panel would stay white-on-grey while the diagram around them
     * went black-on-white.
     *
     * Every colour in the stylesheet is `var(--name, <its default literal>)`. This sets the
     * variables only in high contrast and clears them otherwise, which is what makes an ordinary
     * report unchanged: unset variable, default literal. One place decides it for all three panels.
     *
     * High contrast has two colours, not a palette. The neutral variants are not available to it,
     * so muted text, rules and borders all become the foreground, and a hover cannot signal itself
     * with a background. It gets an outline instead.
     */
    private applyPanelPalette(): void {
        const style = this.target.style;
        const panel: Record<string, string> = {
            "--sankeybi-fg": this.colorPalette.foreground.value,
            "--sankeybi-bg": this.colorPalette.background.value,
            "--sankeybi-line": this.colorPalette.foreground.value,
            "--sankeybi-rule": this.colorPalette.foreground.value,
            "--sankeybi-edge": this.colorPalette.foreground.value,
            "--sankeybi-muted": this.colorPalette.foreground.value,
            "--sankeybi-error": this.colorPalette.foreground.value,
            "--sankeybi-hover": this.colorPalette.background.value,
            "--sankeybi-hover-outline": `1px solid ${this.colorPalette.foreground.value}`,
            // The UA's own button chrome is a colour the mode has not got, so an unclassed button takes
            // the panel's border here instead.
            "--sankeybi-control-border": `1px solid ${this.colorPalette.foreground.value}`,
            // A drop shadow is a colour the mode does not have.
            "--sankeybi-shadow": "none"
        };
        Object.keys(panel).forEach(name => {
            if (this.colorPalette.isHighContrast) {
                style.setProperty(name, panel[name]);
            } else {
                style.removeProperty(name);
            }
        });
    }

    /**
     * Writes one flow type's colour, or clears it back to the data's.
     *
     * The local copy is updated at once so the panel and the next update agree, but
     * `cachedFlowColoursRaw` is deliberately left alone, the rule `persistEdits` already follows.
     * The colours are a data-stage input, so the update this persist brings round has to see them as
     * changed or the stages that resolve them are skipped and the new colour never reaches the
     * diagram.
     */
    private persistFlowColour(type: string, patch: FlowTypePatch): void {
        const next = withFlowTypeEdit(this.flowTypeOverrides, type, patch);
        this.flowTypeOverrides = next;
        this.host.persistProperties({
            merge: [{
                objectName: "corridors",
                selector: WHOLE_VISUAL,
                properties: { flowTypeColours: serialiseFlowTypeColours(next) }
            }]
        });
    }

    /** Writes Lock grid's window, or clears it. Only this one property is merged. */
    private persistGrid(window: GridWindow | undefined): void {
        this.host.persistProperties({
            merge: [{
                objectName: "positions",
                selector: WHOLE_VISUAL,
                properties: this.gridProperties(window)
            }]
        });
    }

    /**
     * The `positions` properties for a write that is about the grid window.
     *
     * Canonical like the other two blobs, and for the same reason: Lock grid holds a region of the
     * diagram, so when the diagram turns the held region should turn with it rather than staying
     * where it was on screen. Every caller hands a screen window in.
     *
     * It carries the node and route blobs too, from the canonical copies, so one write always
     * describes one consistent layout. Writing them back is a no-op in content whenever they are
     * already canonical.
     */
    private gridProperties(window: GridWindow | undefined): Record<string, powerbi.DataViewPropertyValue> {
        const canonical = window ? transposeWindow(window, transposedFor(this.handleAxis)) : undefined;
        return {
            nodes: serialiseNodePositions(this.storedPositions),
            routes: serialiseRouteOverrides(this.storedOverrides),
            grid: serialiseGridWindow(canonical)
        };
    }

    /**
     * Opens one of the three edit panels and closes the other two. They share the bottom-left of
     * the visual and a layout file sits over the middle, so two open at once cover each other and
     * the diagram under them. Closing is done here rather than in each panel because no panel knows
     * the others exist: the visual is the one place that does, and the three switches that open
     * them are all handled in `update()`.
     */
    private openEditorPanel(which: "nodes" | "flows" | "file"): void {
        this.nodeEditorPanel.close();
        this.flowColourPanel.close();
        this.layoutFilePanel.close();
        if (which === "nodes") {
            this.nodeEditorPanel.open();
        } else if (which === "flows") {
            this.flowColourPanel.open();
        } else {
            this.layoutFilePanel.open();
        }
    }

    /**
     * Applies a pasted layout file, or says why it would not.
     *
     * One persist for all four blobs: they describe one layout, and landing them separately would
     * redraw the diagram halfway between two of them.
     *
     * It returns an error message for the panel to show, or `undefined` on success: the author is
     * holding a paste that did not work, and a console line would be no use to them.
     */
    private applyLayoutFile(text: string): string | undefined {
        const read = parseLayoutFile(text);
        if (read.message !== undefined || !read.contents) {
            return read.message ?? "That layout file could not be read.";
        }
        const { nodes, routes, grid, edits } = read.contents;
        // The local copies are updated at once so the panel and the next update agree;
        // `cachedEditsRaw` is deliberately left alone, so the update that the persist brings round sees
        // the edits as changed and rebuilds the graph, the rule `persistEdits` already follows. The file
        // is canonical (see `read` above), so the stored copies take it as it stands and the screen
        // copies are turned out of it: the same two frames every other path keeps.
        const onScreen = transposedFor(this.handleAxis);
        this.storedPositions = nodes;
        this.storedOverrides = routes;
        this.storedEdits = edits;
        this.nodePositions = transposePositions(nodes, onScreen);
        this.routeOverrides = transposeOverrides(routes, onScreen);
        this.nodeEdits = transposeEditPorts(edits, onScreen);
        this.cachedGrid = grid ? transposeWindow(grid, onScreen) : undefined;
        this.host.persistProperties({ merge: [{
            objectName: "positions",
            selector: WHOLE_VISUAL,
            properties: {
                nodes: serialiseNodePositions(nodes),
                routes: serialiseRouteOverrides(routes),
                grid: serialiseGridWindow(grid)
            }
        }, {
            objectName: "nodeEdits",
            selector: WHOLE_VISUAL,
            properties: { edits: serialiseNodeEdits(edits) }
        }] });
        return undefined;
    }

    /**
     * Called by the host when the visual is removed. Closes the visual's own panels and any open
     * dropdown, which holds a document-level listener while it is showing.
     */
    public destroy(): void {
        closePanelMenus();
        this.nodeEditorPanel.close();
        this.flowColourPanel.close();
        this.layoutFilePanel.close();
    }

    /**
     * Returns the format pane model: the cards, groups and slices with their current values.
     * The host calls it each time the pane opens and after every format change, and it can be
     * asked for before the first `update()`.
     */
    public getFormattingModel(): powerbi.visuals.FormattingModel {
        // No flow types, no Per Flow Type settings: greyed out by the card's `onPreProcess`. Read from
        // what the data stages last resolved, which is also what the editor lists, so the two cannot
        // disagree.
        this.formattingSettings.corridorsCard.noFlowTypes =
            (this.cachedFlowTypeColours?.order.length ?? 0) === 0;
        localiseModel(this.formattingSettings);
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }
}
