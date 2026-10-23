import { Point } from "./model";
import { CornerHandle, LeadSide, RouteHandles } from "./routeTypes";
import { RoutingStyle } from "./routingStyle";
import { add, dot, length, midpoint, scale, sub, unit } from "./routeMath";
import { cornerCapAt, uniformCornerCap } from "./curves";

/**
 * The handles a style lets the author touch.
 *
 * Orthogonal offers the step alone: its lead-ins come from the style's defaults and stay
 * uniform across the diagram, which is most of what makes a squared-off diagram look
 * deliberate rather than hand-tweaked. The filtering happens here, on the way to being drawn,
 * rather than in `buildSpine`, because routing itself still needs both leads: avoidance
 * reshapes a blocked route by moving them (`reshapeLeads`).
 */
export function draggableHandles(
    handles: Map<string, RouteHandles>,
    style: RoutingStyle
): Map<string, RouteHandles> {
    if (style !== "Orthogonal") {
        // A direct 90-degree Smooth corner is shaped by its corner handle alone; its leads are
        // derived from the radius, so a lead handle there would only move the same number again.
        const leadless = (route: RouteHandles): boolean =>
            route.hideLeads === true || route.corner?.replacesLeads === true;
        let any = false;
        handles.forEach(route => {
            any = any || leadless(route);
        });
        if (!any) {
            return handles;
        }
        const shown = new Map<string, RouteHandles>();
        handles.forEach((route, id) => shown.set(id, leadless(route)
            ? { middle: route.middle, detour: route.detour, corner: route.corner,
                asPlaced: route.asPlaced }
            : route));
        return shown;
    }
    const out = new Map<string, RouteHandles>();
    handles.forEach((route, id) => {
        if (route.loop) {
            out.set(id, route);
            return;
        }
        // The detour lane shows in every style, a self-loop's handles aside: it is the only control
        // an avoided route has, and hiding it in Orthogonal would leave the style that squares
        // everything off as the one style whose detours cannot be corrected. Built up field by field
        // so a route with neither comes back as the empty set.
        const step: RouteHandles = {};
        // A wrap keeps its leads here. The strip exists for the direct Z, whose leads this style
        // derives from its default; a wrap is built the same way in every style, so its leads place
        // real runs and every one of them is axis-aligned. Without this, a same-axis wrap would have
        // the lane alone and a perpendicular one, which has no lane, would have nothing at all.
        // `routeCorridor` reads the stored overrides again to match.
        //
        // `hideLeads` binds here too. It is routing's answer to "may an author move these", and every
        // style has to read it: an arch is a wrap whose leads are a second name for its lane.
        if (route.wrap && !route.hideLeads) {
            step.wrap = true;
            if (route.source) {
                step.source = route.source;
            }
            if (route.target) {
                step.target = route.target;
            }
        } else if (route.wrap) {
            step.wrap = true;
        }
        if (route.middle) {
            step.middle = route.middle;
        }
        if (route.detour) {
            step.detour = route.detour;
        }
        // Orthogonal is the style this matters most in: its step is the only thing it lets an author
        // place, so a detour there would otherwise leave the lane alone on the route. The flag rides
        // with the step it describes.
        if (route.asPlaced) {
            step.asPlaced = true;
        }
        out.set(id, step);
    });
    return out;
}

/**
 * Where a squared route's corner handle goes: the midpoint of the second corner's arc, the
 * first one past the source stub, which is a loop's outermost corner on the source side
 * (top-right of a default East->West loop). It is fixed by position in the chain rather than
 * by "farthest from the node", which would jump from one side to the other as the two leads
 * passed each other.
 *
 * `uniform` says how the route is drawn, and so what bounds the handle. A self-loop rounds
 * every corner to one radius capped by the shortest edge anywhere on it, so its handle is
 * bounded by that same cap. A wrap between two nodes rounds each corner to what its own two
 * edges allow, so its handle is bounded by this corner's cap alone; bounding it by the
 * whole-path minimum would leave it short of the arc it is drawn on.
 */
export function loopCornerHandle(centreline: Point[], requested: number, minRadius: number, pitch: number,
    uniform = true): CornerHandle | undefined {
    const path = centreline.filter((p, i) => i === 0 || length(sub(p, centreline[i - 1])) > 1e-6);
    const turning: number[] = [];
    for (let i = 1; i < path.length - 1; i++) {
        const bend = dot(unit(sub(path[i], path[i - 1])), unit(sub(path[i + 1], path[i])));
        /**
         * A genuine corner turns strictly between 0 and 180 degrees. Collinear is no corner at all,
         * and neither is a vertex the route doubles back through: `spread` is 1/sin(0) there, so the
         * handle would be at infinity. A same-port wrap whose two nodes sit level runs out to a lane
         * past both of them and straight back along the same line, and its middle vertex is exactly
         * such a reversal. Such vertices are skipped, so the handle moves to the next real corner and
         * the positional rule above still holds.
         */
        if (bend < 1 - 1e-9 && bend > -1 + 1e-9) {
            turning.push(i);
        }
    }
    if (turning.length < 2) {
        return undefined;
    }
    const at = turning[1];
    const apex = path[at];
    const incoming = unit(sub(apex, path[at - 1]));
    const outgoing = unit(sub(path[at + 1], apex));
    const inside = sub(outgoing, incoming);
    if (length(inside) < 1e-9) {
        return undefined;
    }
    const direction = unit(inside);
    // Interior angle between the two runs; the arc's midpoint sits r*(1/sin(phi/2) - 1) from the
    // apex, which is sqrt(2) - 1 at a right angle.
    const interior = Math.acos(Math.max(-1, Math.min(1, dot(scale(incoming, -1), outgoing))));
    const spread = 1 / Math.sin(interior / 2) - 1;
    const maxRadius = uniform ? uniformCornerCap(centreline) : cornerCapAt(path, at);
    const radius = Math.max(0, Math.min(requested, maxRadius));
    return {
        point: add(apex, scale(direction, radius * spread)),
        apex,
        direction,
        spread,
        radius,
        minRadius: Math.min(minRadius, maxRadius),
        maxRadius,
        pitch
    };
}

/**
 * A self-loop lead's side, and the map between its stub and its drawn handle; see `LeadSide`.
 * The side is the run from the stub to the next corner (away from the anchor). The stub is a
 * turning vertex, so that run is square to the port's normal and every point of it shares the
 * stub's coordinate along the drag; its other end is set by the lane (or, on a 90-degree loop,
 * by the other lead), never by this one. So the drawn point is the stub's coordinate along the
 * normal with the side's middle across it.
 */
export function leadSide(
    centreline: Point[],
    atSource: boolean,
    anchor: Point,
    normal: Point,
    floor: number
): LeadSide | undefined {
    const path = centreline.filter((p, i) => i === 0 || length(sub(p, centreline[i - 1])) > 1e-6);
    const at = atSource ? 1 : path.length - 2;
    const far = atSource ? at + 1 : at - 1;
    if (at <= 0 || at >= path.length - 1 || far <= 0 || far >= path.length - 1) {
        return undefined;
    }
    const middle = midpoint(path[at], path[far]);
    // Across the drag, the side's middle; along it, whatever the stub says.
    const across = sub(middle, scale(normal, dot(sub(middle, anchor), normal)));
    const placed = (along: number): Point => add(across, scale(normal, along));
    const alongOf = (point: Point): number => Math.max(floor, dot(sub(point, anchor), normal));
    return {
        drawn: placed(dot(sub(path[at], anchor), normal)),
        toDrawn: stub => placed(alongOf(stub)),
        toStub: point => add(anchor, scale(normal, alongOf(point)))
    };
}

/**
 * Fits a diagonal's two leads so its angle is a multiple of `step` (Octilinear). The diagonal
 * runs between the two lead ends; how far apart those sit across the route is fixed by the
 * nodes, so its angle is set by how far apart they sit along it: `gap = offset / tan(angle)`.
 * Of the allowed angles (every multiple of the step strictly between 0 and 180) the one
 * nearest the diagonal's current angle is chosen, and both leads move by the same amount to
 * realise it, which holds the diagonal's midpoint so the diagram shifts as little as it can.
 * Where that would take a lead below `minLead`, the other lead takes up the difference
 * instead; an angle that needs both below the minimum is not a candidate. Aligned ends have
 * no angle and are left alone, as is a diagonal no allowed angle fits.
 *
 * A lead dragged with the drag-time snap (interaction.ts, `snapLeadToAngle`) arrives already
 * on a step, so this leaves it exactly where it was dropped.
 */
export function fitDiagonalLeads(
    anchorOut: Point,
    exitNormal: Point,
    anchorIn: Point,
    leadOut: number,
    leadIn: number,
    minLead: number,
    step: number
): { out: number; in: number } {
    const between = sub(anchorIn, anchorOut);
    const along = dot(between, exitNormal);
    const offset = length(sub(between, scale(exitNormal, along)));
    if (offset < 0.5) {
        return { out: leadOut, in: leadIn };
    }
    const gap = along - leadOut - leadIn;
    const current = Math.atan2(offset, gap) * 180 / Math.PI;
    let best: { out: number; in: number } | undefined;
    let nearest = Infinity;
    for (let angle = step; angle < 180 - 1e-9; angle += step) {
        const wantedGap = Math.abs(angle - 90) < 1e-9 ? 0 : offset / Math.tan(angle * Math.PI / 180);
        const total = along - wantedGap;
        if (total < 2 * minLead - 1e-9) {
            continue;
        }
        const change = (gap - wantedGap) / 2;
        let out = leadOut + change;
        let inn = leadIn + change;
        if (out < minLead) {
            out = minLead;
            inn = total - minLead;
        } else if (inn < minLead) {
            inn = minLead;
            out = total - minLead;
        }
        const miss = Math.abs(angle - current);
        if (miss < nearest) {
            nearest = miss;
            best = { out, in: inn };
        }
    }
    return best ?? { out: leadOut, in: leadIn };
}
