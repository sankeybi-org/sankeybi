/**
 * Painting: turns the laid-out, routed diagram into SVG.
 *
 * This module does no geometry of its own. Every position, path and size it paints was decided
 * upstream; it only chooses colours, draws elements in the right order and wires them to
 * selection and tooltips.
 */

import {
    Corridor, DEFAULT_FLOW_LABEL_SIZE, DEFAULT_LEGEND_SIZE, FlowLabelContent, LabelOptions, LayoutResult,
    NodeShape, Point, PositionedNode, RoutedBand, ShapePaint
} from "./model";
import { VisualFormattingSettingsModel } from "./settings";
import { FlowTypeColours } from "./colours";
import { WaypointDragOptions } from "./interaction";
import { NodeInfill, RouteHandles } from "./routeTypes";
import { INERT_SELECTION, SelectionSink } from "./selection";
import { FlowLabelCorridor, placeFlowLabels } from "./flowLabels";
import { LegendPosition } from "./layoutConstants";
import { NodeTooltipOptions, nodeTooltipRows, summariseNodes, TooltipRow } from "./tooltips";
import { beginIds } from "./renderIds";
import { BackgroundPaint, renderBackground, renderGrid } from "./renderBackground";
import { labelOptionsFrom, NumberFields, renderFlowLabels } from "./renderLabels";
import { el, fontFrom, textColourFrom, themeNodeColour } from "./renderSupport";
import { bandColour, hatchPatterns, renderBands } from "./renderBands";
import { TEXTURE_COUNT, TexturePaperMode, TextureInkMode, textureColours } from "./textures";
import { renderBalanceMarkers, renderNodes, ShapeOptions } from "./renderNodes";
import { renderLegend } from "./renderLegend";
import { renderRouteHandles } from "./renderHandles";

import ISandboxExtendedColorPalette = powerbi.extensibility.ISandboxExtendedColorPalette;

/** What a render draws, besides the SVG it draws into. */
export interface RenderInput {
    layout: LayoutResult;
    bands: RoutedBand[];
    colorPalette: ISandboxExtendedColorPalette;
    settings: VisualFormattingSettingsModel;
    flowTypeColours: FlowTypeColours;
    viewportWidth: number;
    viewportHeight: number;
    /** Present only in edit mode; absent leaves the diagram static. */
    drag?: WaypointDragOptions;
    /** Each corridor's route handles, from routing, for drawing and dragging. */
    routeHandles?: Map<string, RouteHandles>;
    /**
     * The corridors behind the bands. Only the node tooltips need them, for the per-type and
     * per-connection breakdowns, which no other stage carries: a PositionedNode knows its totals
     * but not their composition.
     */
    corridors?: Corridor[];
    /**
     * What each painted element is, for selection and tooltips (selection.ts owns what clicking or
     * hovering it means). Defaults to a no-op, so a render without a host needs no special case.
     */
    selection?: SelectionSink;
    /** Node arrow stripes from routing; empty when node arrows are off. */
    infill?: NodeInfill[];
    /** The background picture, drawn into `layout.backdrop`; absent draws none. */
    background?: BackgroundPaint;
    /**
     * Corridor ids bottom-first (layers.ts). Empty or absent paints them in the order the bands
     * arrive.
     */
    paintOrder?: readonly string[];
    /**
     * The undetoured centreline of each corridor that avoidance sent round something. Drawn faint
     * under that corridor's handles, which sit on it rather than on the band.
     */
    routeGhosts?: Map<string, Point[]>;
    /**
     * Crossing separation: erase a channel `margin` pixels wide around a corridor wherever a
     * corridor painted above it crosses. Absent or 0 adds no element at all.
     */
    crossings?: {
        margin: number;
        /** Each corridor's own outline, from routing. */
        silhouettes: ReadonlyMap<string, string>;
        /** Where each pair of corridors crosses, and how far they overlap there. */
        pairs: ReadonlyMap<string, readonly { at: Point; radius: number }[]>;
    };
    /**
     * The model's format string, the report's locale and the formatter built from them
     * (formatting.ts). Absent formats with `toLocaleString`.
     */
    numbers?: NumberFields;
    /**
     * Each corridor's spine and drawn thickness, for the flow labels. Built in visual.ts because it
     * needs routing's spines. Absent, no flow label is drawn whatever the card says.
     */
    flowLabelInput?: readonly FlowLabelCorridor[];
}

/** Draws the whole diagram into `svg`, replacing what was there. */
export function render(svg: SVGSVGElement, input: RenderInput): void {
    const {
        layout, bands, colorPalette, settings, flowTypeColours, viewportWidth, viewportHeight, drag,
        routeHandles = new Map(), corridors = [], selection = INERT_SELECTION, infill = [], background,
        paintOrder = [], routeGhosts = new Map(), crossings, numbers, flowLabelInput
    } = input;
    const { reusable } = prepareSvg({ background, svg, viewportHeight, viewportWidth });

    // Behind everything, the snap grid included.
    if (background && layout.backdrop) {
        renderBackground(svg, layout.backdrop, background, reusable);
    }

    // Its own <defs>, appended only in high contrast: an ordinary render adds no element at all.
    const highContrastDefs = el("defs");
    // The palette is asked whatever the author has chosen. `getColor` hands colours out in call
    // sequence, so skipping it when the Flow colour picker is set would shift every flow type's
    // automatic colour; `colours.ts` documents the same trap for the per-type overrides. The
    // optional read is for the synthetic checks, which build settings by hand; `visual.ts` fills
    // the slice with this very colour while the author has not set one, so the pane shows what is
    // drawn.
    const themeCorridor = colorPalette.getColor("sankeybi-corridor").value;
    const defaultColour =
        settings.corridorsCard?.defaultFlowColour?.value?.value ?? themeCorridor;
    // The fallback for a node whose colour the data does not name: the theme's, not a picker's;
    // see `themeNodeColour`.
    const nodeColour = themeNodeColour(colorPalette);

    const legendVisible = settings.legendCard.show.value && flowTypeColours.order.length > 0;
    const legendPosition = settings.legendCard.position.value.value as LegendPosition;

    const labels = labelOptionsFrom(settings, numbers, flowTypeColours.labels);
    const nodeTooltipOptions: NodeTooltipOptions = {
        totals: settings.interactionCard.tooltipNodeTotals.value,
        byFlowType: settings.interactionCard.tooltipNodeByFlowType.value,
        byConnection: settings.interactionCard.tooltipNodeByConnection.value
    };

    // First, so everything else sits on top of it. Edit mode only (`drag` present), like the route
    // handles: a grid is a scaffold for placing things by hand, and a reading view has nothing to
    // place.
    if (drag && settings.positionsCard.showGrid.value) {
        renderGrid(svg, layout, viewportWidth, viewportHeight,
            settings.positionsCard.snap.value,
            colorPalette.foreground.value, colorPalette.isHighContrast === true);
    }

    // High contrast: the flow types are carried by hatches rather than by colour, because colour
    // is the one thing the mode takes away. Built once here, and shared with the legend so the two
    // cannot disagree.
    const hatching = colorPalette.isHighContrast
        ? {
            fills: hatchPatterns(highContrastDefs, colorPalette.foreground.value,
                colorPalette.background.value),
            ink: colorPalette.foreground.value
        }
        : undefined;

    const { typePatterns, outlineInk } = paintBands({
        bands,
        colorPalette,
        crossings,
        defaultColour,
        flowTypeColours,
        hatching,
        highContrastDefs,
        labels,
        layout,
        paintOrder,
        selection,
        settings,
        svg
    });
    const nodeSummaries = summariseNodes(corridors);
    const nodeTooltip = (node: PositionedNode): TooltipRow[] => nodeTooltipRows(
        node, nodeSummaries.get(node.id), labels, nodeTooltipOptions, flowTypeColours.order);

    const shapes: ShapeOptions = hatching
        // High contrast: a node colour from the data, or from a picker, is exactly what the mode is
        // telling us not to use. So a node becomes background-filled and foreground-outlined, which is
        // what the native visuals do there, and the border is at least a pixel so it reads.
        ? {
            shape: settings.nodeShapesCard.shape.value.value as NodeShape,
            fill: "Custom",
            fillColour: colorPalette.background.value,
            border: "Custom",
            borderColour: colorPalette.foreground.value,
            borderWidth: Math.max(1, settings.nodeShapesCard.borderWidth.value)
        }
        : {
            shape: settings.nodeShapesCard.shape.value.value as NodeShape,
            fill: settings.nodeShapesCard.fill.value.value as ShapePaint,
            fillColour: settings.nodeShapesCard.fillColour.value.value,
            border: settings.nodeShapesCard.border.value.value as ShapePaint,
            borderColour: settings.nodeShapesCard.borderColour.value.value,
            borderWidth: settings.nodeShapesCard.borderWidth.value
        };
    paintNodes({
        colorPalette,
        defaultColour,
        drag,
        flowTypeColours,
        hatching,
        infill,
        labels,
        layout,
        nodeColour,
        nodeTooltip,
        outlineInk,
        selection,
        shapes,
        svg,
        typePatterns
    });

    paintFlowLabels({
        bands,
        colorPalette,
        defaultColour,
        flowLabelInput,
        flowTypeColours,
        labels,
        layout,
        selection,
        settings,
        svg
    });

    // Edit mode only (`drag` present), like the snap grid and the route handles.
    if (drag && settings.labelsCard.showUnbalanced?.value) {
        renderBalanceMarkers(svg, layout,
            settings.labelsCard.balanceTolerance?.value ?? 0.5,
            // In high contrast only foreground/background/hyperlink may be used, so the sentiment colour is
            // not available there; and a theme need not define one at all, hence the Fluent error red the
            // in-visual panels already use.
            colorPalette.isHighContrast
                ? colorPalette.foreground.value
                : (colorPalette.negative?.value ?? "#A4262C"),
            selection);
    }
    if (legendVisible) {
        renderLegend(svg, flowTypeColours, legendPosition, viewportWidth, viewportHeight,
            fontFrom(settings.legendCard.font, DEFAULT_LEGEND_SIZE),
            (settings.legendCard.titleText?.value ?? "").trim(),
            // High contrast overrides a custom colour: there the foreground is the only ink the mode
            // allows, and honouring a picker would put back the thing the mode exists to remove.
            (hatching ? undefined : textColourFrom(settings.legendCard))
                ?? colorPalette.foreground.value,
            hatching, typePatterns, labels.measureText);
    }
    // Last, so handles sit above everything they are used to reshape.
    if (drag) {
        renderRouteHandles(svg, routeHandles, drag, colorPalette.background.value,
            colorPalette.foreground.value, routeGhosts, selection);
    }
}

interface PrepareInputs {
    background: BackgroundPaint | undefined;
    svg: SVGSVGElement;
    viewportHeight: number;
    viewportWidth: number;
}

/** Empties the SVG and sizes it, keeping a background picture that has not changed. */
function prepareSvg(args: PrepareInputs) {
    const { background, svg, viewportHeight, viewportWidth } = args;
    // Taken out before the clear below, so the picture survives it; see `renderBackground`'s
    // `existing`. Only when it is the same picture: a different one has to be decoded whatever we
    // do.
    const kept = typeof svg.querySelector === "function"
        ? svg.querySelector(".sankeybi-background") as SVGImageElement | null
        : null;
    const reusable = kept && background && kept.getAttribute("href") === background.url
        ? kept
        : undefined;

    if (reusable) {
        // Everything but the picture, which stays in the tree throughout: appendChild on a child
        // already in place moves it rather than reinserting it, so the decoded image is never let go
        // of.
        Array.prototype.slice.call(svg.childNodes as unknown as ArrayLike<Node>)
            .forEach((child: Node) => {
                if (child !== reusable) {
                    svg.removeChild(child);
                }
            });
    } else {
        while (svg.firstChild) {
            svg.removeChild(svg.firstChild);
        }
    }

    svg.setAttribute("width", String(viewportWidth));
    svg.setAttribute("height", String(viewportHeight));
    svg.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);
    return { reusable };
}

interface BandPaintInputs {
    bands: RoutedBand[];
    colorPalette: ISandboxExtendedColorPalette;
    crossings: { margin: number; silhouettes: ReadonlyMap<string, string>; pairs: ReadonlyMap<string, readonly { at: Point; radius: number; }[]>; } | undefined;
    defaultColour: string;
    flowTypeColours: FlowTypeColours;
    hatching: { fills: string[]; ink: string; } | undefined;
    highContrastDefs: SVGDefsElement;
    labels: LabelOptions;
    layout: LayoutResult;
    paintOrder: readonly string[];
    selection: SelectionSink;
    settings: VisualFormattingSettingsModel;
    svg: SVGSVGElement;
}

/**
 * The ink and the paper a flow type's texture is drawn in: the editor's choice for that type, else the
 * pane's Texture colour and Texture background, else the defaults. Read at paint time, so it is a paint
 * input and no geometry reads it. The editor uses the same function to open on what is on screen.
 */
export function textureColoursFor(
    settings: VisualFormattingSettingsModel,
    colorPalette: ISandboxExtendedColorPalette,
    defaultColour: string
): (type: string, colours: FlowTypeColours) => { ink: string; paper: string } {
    const card = settings.corridorsCard as unknown as {
        textureColourMode?: { value?: { value?: unknown } };
        textureColour?: { value?: { value?: string } };
        textureBackgroundMode?: { value?: { value?: unknown } };
        textureBackground?: { value?: { value?: string } };
    };
    const inkMode = String(card.textureColourMode?.value?.value ?? "Type") as TextureInkMode;
    const paperMode = String(card.textureBackgroundMode?.value?.value ?? "Background") as TexturePaperMode;
    return (type, colours) => textureColours({
        typeColour: colours.colours.get(type) ?? defaultColour,
        reportBackground: colorPalette.background.value,
        themeForeground: colorPalette.foreground.value,
        inkMode,
        inkCustom: card.textureColour?.value?.value,
        paperMode,
        paperCustom: card.textureBackground?.value?.value,
        inkOverride: colours.inks?.get(type),
        paperOverride: colours.papers?.get(type)
    });
}

/** Flow-type textures and outlines, then the bands themselves. */
function paintBands(args: BandPaintInputs) {
    const { bands, colorPalette, crossings, defaultColour, flowTypeColours, hatching, highContrastDefs, labels, layout, paintOrder, selection, settings, svg } = args;
    // The author's own textures, drawn in each flow type's own colour on the report background, so
    // a hatched flow reads as a version of that flow rather than as the accessibility mode.
    //
    // Not in high contrast: there the mode assigns a hatch per type and takes colour away
    // altogether, so an author's choice of either has nothing to act on, and two pattern sets would
    // fight over which texture means which type, which is the one thing the legend has to be able
    // to say.
    //
    // There is one set of textures per colour rather than per type, so types sharing a colour share the
    // patterns; the sets are keyed by the colour so the id cannot collide with high contrast's set
    // or with another colour's.
    const typePatterns = new Map<string, string>();
    const authored = flowTypeColours.patterns;
    // The texture's ink and the colour behind it come from the editor, then the pane
    // (`textureColoursFor`). One set of textures is built per ink-and-paper pair, so types that end
    // up with the same two colours share patterns, and the ids cannot collide.
    const coloursFor = textureColoursFor(settings, colorPalette, defaultColour);
    if (!hatching && authored !== undefined && authored.size > 0) {
        const defs = el("defs");
        const sets = new Map<string, string[]>();
        authored.forEach((index, type) => {
            const { ink, paper } = coloursFor(type, flowTypeColours);
            const key = `${ink}|${paper}`;
            let set = sets.get(key);
            if (!set) {
                set = hatchPatterns(defs, ink, paper, `sankeybi-pattern-${sets.size}`, TEXTURE_COUNT);
                sets.set(key, set);
            }
            typePatterns.set(type, set[index % set.length]);
        });
        svg.appendChild(defs);
    }
    if (hatching) {
        svg.appendChild(highContrastDefs);
    }
    // The outline's ink: the author's colour where they chose one, else the theme's foreground.
    // One value for the bands and the arrows, so the two cannot disagree. Only read where outlines
    // are drawn at all; high contrast hands both `undefined` above.
    const corridorsCard = settings.corridorsCard as unknown as {
        outlineColourMode?: { value?: { value?: unknown } };
        outlineColour?: { value?: { value?: string } };
    };
    const outlineInk = String(corridorsCard.outlineColourMode?.value?.value) === "Custom"
        ? (corridorsCard.outlineColour?.value?.value ?? colorPalette.foreground.value)
        : colorPalette.foreground.value;
    renderBands(svg, layout, bands, flowTypeColours, defaultColour, labels,
        selection, flowTypeColours.order, paintOrder, crossings, hatching, typePatterns,
        hatching ? undefined : {
            styles: flowTypeColours.outlines,
            untyped: flowTypeColours.paneOutline,
            ink: outlineInk
        });
    return { typePatterns, outlineInk };
}

interface NodePaintInputs {
    colorPalette: ISandboxExtendedColorPalette;
    defaultColour: string;
    drag: WaypointDragOptions | undefined;
    flowTypeColours: FlowTypeColours;
    hatching: { fills: string[]; ink: string; } | undefined;
    infill: NodeInfill[];
    labels: LabelOptions;
    layout: LayoutResult;
    nodeColour: string;
    nodeTooltip: (node: PositionedNode) => TooltipRow[];
    outlineInk: string;
    selection: SelectionSink;
    shapes: ShapeOptions;
    svg: SVGSVGElement;
    typePatterns: Map<string, string>;
}

/** Nodes with their arrows, labels and tooltips. */
function paintNodes(args: NodePaintInputs) {
    const { colorPalette, defaultColour, drag, flowTypeColours, hatching, infill, labels, layout, nodeColour, nodeTooltip, outlineInk, selection, shapes, svg, typePatterns } = args;
    beginIds(svg);
    const infillByNode = new Map<string, NodeInfill[]>();
    infill.forEach(stripe => {
        const list = infillByNode.get(stripe.nodeId);
        if (list) {
            list.push(stripe);
        } else {
            infillByNode.set(stripe.nodeId, [stripe]);
        }
    });
    renderNodes(svg, layout, nodeColour, colorPalette.background.value, shapes,
        colorPalette.foreground.value,
        id => infillByNode.get(id) ?? [],
        // The arrows take the band's hatch in high contrast, not its colour. An arrow head or tail is
        // the continuation of the band it belongs to (same width, same stripes), so painting it a
        // palette colour while the band it grows out of is hatched would leak a colour the mode
        // forbids. The legend order comes with it, because that is what picks the hatch.
        { colours: flowTypeColours, fallback: defaultColour, opacity: 1 },
        flowTypeColours.order, hatching, typePatterns,
        // The arrows take the author's outline too. Gating the stripe outline on high contrast would
        // give a dashed flow a dashed band edge and then nothing from the node face inward: the outline
        // would stop exactly where the flow is supposed to continue. The same expression the bands are
        // given, so the two cannot diverge.
        hatching ? undefined : {
            styles: flowTypeColours.outlines,
            untyped: flowTypeColours.paneOutline,
            ink: outlineInk
        },
        labels, nodeTooltip, selection, drag);
}

interface FlowLabelInputs {
    bands: RoutedBand[];
    colorPalette: ISandboxExtendedColorPalette;
    defaultColour: string;
    flowLabelInput: readonly FlowLabelCorridor[] | undefined;
    flowTypeColours: FlowTypeColours;
    labels: LabelOptions;
    layout: LayoutResult;
    selection: SelectionSink;
    settings: VisualFormattingSettingsModel;
    svg: SVGSVGElement;
}

/**
 * Flow labels, drawn over the bands and nodes: they are placed clear of every node, so nothing
 * covers one.
 */
function paintFlowLabels(args: FlowLabelInputs) {
    const { bands, colorPalette, defaultColour, flowLabelInput, flowTypeColours, labels, layout, selection, settings, svg } = args;
    // Flow labels, over the bands and the nodes alike: they are already placed clear of every node
    // (flowLabels.ts), so drawing them last among the content means nothing can cover one.
    if (settings.flowLabelsCard?.show?.value && flowLabelInput) {
        const flowFont = fontFrom(settings.flowLabelsCard.font, DEFAULT_FLOW_LABEL_SIZE);
        // The colour under each midpoint, from the band this render is painting, so Automatic ink is
        // chosen against what is actually drawn.
        const underLabel = new Map<string, string>();
        bands.forEach(band => {
            if (!underLabel.has(band.corridorId)) {
                underLabel.set(band.corridorId,
                    bandColour(band, flowTypeColours, defaultColour));
            }
        });
        renderFlowLabels(svg,
            placeFlowLabels({
                corridors: flowLabelInput.map(c => ({ ...c, colour: underLabel.get(c.id) })),
                nodes: [...layout.nodes.values()],
                content: (settings.flowLabelsCard.content?.value?.value ?? "Value") as FlowLabelContent,
                fontSize: flowFont.size,
                bold: flowFont.bold,
                labels,
                outsideLabels: settings.flowLabelsCard.outside?.value ?? false,
                // The box an outside label has to stay inside. Pure paint: it reserves nothing, so this is a
                // bound, not a reserve.
                chromeBox: layout.chromeBox
            }),
            flowFont,
            String(settings.flowLabelsCard.colourMode?.value?.value) === "Custom"
                ? settings.flowLabelsCard.colour.value.value
                : undefined,
            colorPalette.foreground.value,
            selection);
    }
}
