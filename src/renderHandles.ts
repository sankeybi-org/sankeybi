import { AngleSnap, LeadSide, RouteHandles } from "./routeTypes";
import { makeCornerDraggable, makeHandleDraggable, WaypointDragOptions } from "./interaction";
import { Point } from "./model";
import { SelectionSink } from "./selection";
import { RouteHandleKind } from "./positions";
import { addTooltip, el } from "./renderSupport";

/**
 * Draws a corridor's route handles: how far it runs out of each port, and where it
 * steps across. Edit mode only; in a reading view they would be decoration nobody
 * can use, since persisted properties do not stick there.
 */
export function renderRouteHandles(
    svg: SVGSVGElement,
    handles: Map<string, RouteHandles>,
    drag: WaypointDragOptions,
    backgroundColour: string,
    /**
     * The ink for the as-placed handles and their ghost line: the theme's foreground
     * rather than a literal black, so they stay visible on a dark report page.
     */
    foregroundColour: string,
    /** Each detoured corridor's undetoured centreline; empty for an ordinary diagram. */
    ghosts: Map<string, Point[]>,
    /**
     * Every handle is registered against its own corridor, so that selecting one
     * corridor hides the others' handles. Render decides nothing: it says which
     * corridor each dot belongs to, and selection.ts decides whose turn it is to be on
     * screen.
     */
    selection: SelectionSink
): void {
    const label: Record<RouteHandleKind, string> = {
        source: "Drag to change how far this corridor runs out of its port",
        target: "Drag to change how far this corridor runs into its port",
        middle: "Drag to move where this corridor steps across",
        detour: "Drag to move which side of the node this corridor passes, and how far out"
    };
    /**
     * What the same handles mean once avoidance has sent the route round something:
     * they move the dashed line, and the way round follows it. Said outright, because
     * a handle whose drag does not move the band under the pointer reads as broken.
     */
    const asPlacedLabel: Record<RouteHandleKind, string> = {
        source: "Drag to change how far the dashed line runs out of its port."
            + " Clear of the node, and the detour goes",
        target: "Drag to change how far the dashed line runs into its port."
            + " Clear of the node, and the detour goes",
        middle: "Drag to move the dashed line this corridor would take."
            + " Clear of the node, and the detour goes",
        detour: label.detour
    };
    handles.forEach((route, corridorId) => {
        /**
         * A ghost of the line this route would have taken with nothing in its way. Its
         * as-placed handles sit on this, not on the band, so without it a dot floats off
         * the drawing with nothing to explain it.
         *
         * It is registered as a handle, not a decoration, which gives it the same
         * visibility rule as the dots it explains (the selected corridor's only, or every
         * corridor's when nothing is selected). It is never a pointer target.
         */
        const ghost = route.asPlaced ? ghosts.get(corridorId) : undefined;
        if (ghost && ghost.length > 1) {
            const line = el("path");
            line.setAttribute("class", "sankeybi-route-ghost");
            line.setAttribute("d", ghost.map((p, i) =>
                `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" "));
            line.setAttribute("fill", "none");
            line.setAttribute("stroke", foregroundColour);
            line.setAttribute("stroke-width", "1");
            line.setAttribute("stroke-dasharray", "4 3");
            line.setAttribute("opacity", "0.45");
            line.setAttribute("pointer-events", "none");
            svg.appendChild(line);
            selection.registerHandle?.(line, corridorId);
        }
        // The handles pinned to ONE axis. The chamfer is deliberately not in
        // this list -- it has two, so it is drawn below with its own drag.
        ([ "source", "target", "middle", "detour" ] as const).forEach(kind => {
            const handle = route[kind];
            if (!handle) {
                // An L or a smooth curve has no crossover to move, and only a
                // route avoidance sent around something has a lane.
                return;
            }
            // A Smooth self-loop's lead is drawn on the middle of the side it
            // places rather than at its stub, which on a rounded loop is empty
            // space outside the curve (see LeadSide in routing.ts).
            const lead = kind === "source" || kind === "target";
            const side = lead ? (handle as { side?: LeadSide }).side : undefined;
            const at = side ? side.drawn : handle.point;
            // On a detoured route the leads and the middle move the line, not the band you can
            // see, so they are drawn solid in the theme ink where every position handle is
            // otherwise hollow. This is the distinction the corner handle makes for roundness.
            // The lane keeps the hollow look, because it is the one handle here that does shape
            // what is drawn.
            const onGhost = route.asPlaced === true && kind !== "detour";
            const dot = el("circle");
            dot.setAttribute("class", `sankeybi-handle sankeybi-handle-${kind}`
                + (onGhost ? " sankeybi-handle-as-placed" : ""));
            dot.setAttribute("cx", String(at.x));
            dot.setAttribute("cy", String(at.y));
            dot.setAttribute("r", onGhost ? "4.5" : "5");
            dot.setAttribute("fill", onGhost ? foregroundColour : backgroundColour);
            dot.setAttribute("stroke", onGhost ? backgroundColour : "#605E5C");
            dot.setAttribute("stroke-width", "1.5");
            addTooltip(dot, onGhost
                ? `${asPlacedLabel[kind]}. Double-click to reset it.`
                : `${label[kind]}. Double-click to reset it.`);
            svg.appendChild(dot);
            const angleSnap = lead ? (handle as { angleSnap?: AngleSnap }).angleSnap : undefined;
            makeHandleDraggable(dot, corridorId, kind, handle.axis, at, svg, drag, side, angleSnap);
            selection.registerHandle?.(dot, corridorId);
        });
        // The corner handle: a self-loop's, a Smooth direct 90-degree L's, and a Smooth
        // wrap's (the question mark and the C loop). It is drawn solid where the position
        // handles are hollow, so it reads at a glance as a different kind of thing: roundness,
        // not a place.
        if (route.corner) {
            const dot = el("circle");
            dot.setAttribute("class", "sankeybi-handle sankeybi-handle-corner");
            dot.setAttribute("cx", String(route.corner.point.x));
            dot.setAttribute("cy", String(route.corner.point.y));
            dot.setAttribute("r", "4.5");
            dot.setAttribute("fill", "#605E5C");
            dot.setAttribute("stroke", backgroundColour);
            dot.setAttribute("stroke-width", "1.5");
            addTooltip(dot, "Drag along the corner to make this route's corners rounder or sharper. "
                + "Double-click to hand them back to the Curvature setting.");
            svg.appendChild(dot);
            makeCornerDraggable(dot, corridorId, route.corner, svg, drag);
            selection.registerHandle?.(dot, corridorId);
        }
    });
}
