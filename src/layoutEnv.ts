import { WrappedLine } from "./labelWrap";
import { ArrowOptions, GraphNode, GridWindow, LabelOptions, NodeShape, Port } from "./model";
import { FaceDemand } from "./layoutDemand";
import { TextWidths } from "./layoutText";

/** One node's size at a given pair of pitches (see `sizeNodesAt`). */
export interface NodeSize {
    width: number;
    height: number;
    shapeWidth: number;
    shapeHeight: number;
    labelInside: boolean;
    box: { w: number; h: number };
    /**
     * The name's lines at this pitch. A label drawn inside a shape wraps to that shape, so the
     * breaks depend on the node's size and therefore on the pitch; one drawn outside keeps the
     * em-capped wrap. Chosen by table lookup, never by measuring (see `wrapForWidth`).
     */
    nameLines: WrappedLine[];
}

/**
 * Everything the sizing and fitting steps of one layout read, gathered so those steps can be
 * separate functions instead of closures.
 */
export interface LayoutEnv {
    nodes: Map<string, GraphNode>;
    labels: LabelOptions | undefined;
    arrows: ArrowOptions | undefined;
    faces: FaceDemand;

    nodeShape: NodeShape;
    nodeShapeFitLabel: boolean;
    nodeMinWidthPercent: number;
    nodeMinHeightPercent: number;
    nodeShapePaddingPercent: number;
    flowSeparationPercent: number;

    /** The label text, measured once. */
    totalTexts: Map<string, string>;
    textWidths: Map<string, TextWidths>;
    labelBoxes: Map<string, { w: number; h: number }>;
    labelPorts: Map<string, Port>;

    /** The pitch the diagram's thickness is built from, and the scale it gives. */
    packingPitchOf: (rowPitch: number, columnGap: number) => number;
    valueToPixelsAt: (packingPitch: number) => (value: number) => number;
    packsAcrossRows: boolean;

    /** Which way the grid runs on screen, per axis. */
    columnSign: 1 | -1;
    rowSign: 1 | -1;

    /** The extent of the stages on each axis. */
    minColumn: number;
    maxColumn: number;
    minRow: number;
    maxRow: number;
    multiColumn: boolean;

    /** The drawing area in pixels. */
    spanWidth: number;
    usableHeight: number;

    /**
     * Lock grid's window, a background's aspect, and where the flows reached on a first routing.
     */
    locked: GridWindow | undefined;
    backdropAspect: number | undefined;
    flows: GridWindow | undefined;
}
