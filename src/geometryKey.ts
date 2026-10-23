/**
 * The cache key for a laid-out, routed diagram.
 *
 * `update()` runs on every change, and Power BI sends a format change the same way
 * it sends a data change (the data view arrives again with new
 * `metadata.objects`), so there is no flag saying that only the colours moved.
 * Without a key, changing a transparency would lay out and route the whole
 * diagram again on every tick of a slider drag.
 *
 * Two rules keep the key honest, and `geometry-cache-check` pins both:
 *
 * 1. The argument objects go in whole. `chrome` and `routing` are exactly what
 *    `computeLayout` and `routeDiagram` are handed, and they are stringified as
 *    they stand rather than field by field, so a setting added to either is
 *    covered the day it is added.
 * 2. Everything the cached result carries is fingerprinted, not just what the
 *    geometry reads. A cache hit reuses the whole `LayoutResult`, including its
 *    positioned nodes, and render draws a node's label, colour and icon from
 *    those, so a data change that moves nothing must still miss.
 *
 * Deliberately not in the key: the colour palette and theme (layout never reads
 * them and render always re-runs), the tooltip settings (paint and interaction
 * only), and the corridor colours (resolved fresh on every update).
 */

import { Corridor, Graph, GraphNode, GridWindow } from "./model";
import { LayoutChrome } from "./layout";
import { RoutingOptions } from "./routeTypes";

/** Everything the cached geometry depends on besides the graph and corridors. */
export interface GeometryInputs {
    width: number;
    height: number;
    chrome: LayoutChrome;
    routing: RoutingOptions;
    /** The Flows card's Straighten slider, which nudges node positions. */
    straighten: number;
    /** Lock grid's stored window, or undefined when the view fits the content. */
    locked: GridWindow | undefined;
    /**
     * The positions blob as stored: the node placements (which reach the geometry
     * through the graph) and the route handle overrides (which do not, and are the
     * reason this is here).
     */
    positionsRaw: string;
}

/**
 * FNV-1a. Used only for the icon data URLs, which can run to 20KB each: they are
 * part of what a cache hit keeps on screen, so they have to be covered, and a hash
 * covers them without building a key megabytes long.
 */
function hashOf(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        // The FNV prime, by shifts: a plain multiply overflows into a float.
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(36);
}

/** A node's contribution: everything layout measures, plus everything render paints. */
function nodePart(node: GraphNode): string {
    return [
        node.id,
        node.label,
        node.hideTotal ? 1 : 0,
        node.column ?? "",
        node.row ?? "",
        node.columnIsOverride ? 1 : 0,
        node.rowIsOverride ? 1 : 0,
        node.inflow,
        node.outflow,
        node.isSelfLoop ? 1 : 0,
        node.colour ?? "",
        node.icon === undefined ? "" : hashOf(node.icon)
    ].join(",");
}

/** A corridor's: its ends, its ports, and the stripes that make up its band. */
function corridorPart(corridor: Corridor): string {
    return [
        corridor.id,
        corridor.source,
        corridor.target,
        corridor.value,
        corridor.isSelfLoop ? 1 : 0,
        corridor.sourcePort,
        corridor.targetPort,
        corridor.segments.map(s => `${s.flowType ?? ""}:${s.value}`).join("+")
    ].join(",");
}

/**
 * The key. Two updates with equal keys draw the same picture, so the second
 * may reuse the first's layout and routing.
 */
export function geometryKey(graph: Graph, corridors: Corridor[], inputs: GeometryInputs): string {
    const nodes: string[] = [];
    graph.nodes.forEach(node => nodes.push(nodePart(node)));
    return JSON.stringify([
        inputs.width,
        inputs.height,
        inputs.chrome,
        inputs.routing,
        inputs.straighten,
        inputs.locked ?? null,
        inputs.positionsRaw,
        nodes.join(";"),
        corridors.map(corridorPart).join(";")
    ]);
}
