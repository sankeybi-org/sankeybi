/**
 * Snap-to-straight: nudges nodes by a few pixels so near-aligned direct corridors come out genuinely straight.
 *
 * The logical grid puts nodes on whole rows and columns, and port packing then puts each corridor's anchor wherever its slot happens to fall on the node's edge. The two rarely coincide exactly, so a corridor that reads as horizontal is usually a few pixels off, enough for routing to put a visible kink in it.
 *
 * This runs between `computeLayout` and `routeDiagram`, and it moves the nodes themselves rather than adjusting the route: an anchor is a point on a node's edge, so a route bent to meet a straight line would simply detach from its port.
 *
 * Hand-placed nodes are nudged too. Excluding them would switch the feature off exactly when it is wanted most, and a few pixels does not contradict a grid-scale placement. The Straighten setting bounds the damage instead: it scales both how far a node may move and how busy a node may be before it is left alone.
 */

import { Corridor, LayoutResult, PositionedNode } from "./model";
import { portAxis } from "./flowAxis";
import { Anchor } from "./routeTypes";
import { anchorKey, computeAnchors, routeWraps } from "./anchors";

/** Below this, two anchors already line up and there's nothing to gain. */
const ALIGNED_EPSILON = 0.05;
/** Largest nudge at Straighten 100, as a fraction of that axis's grid pitch. */
const MAX_TOLERANCE_FRACTION = 0.5;
/** Straighten points per extra corridor a node may carry and still be nudged. */
const DEGREE_STEP = 25;
/** Keep this much clear between a nudged node and its neighbour. */
const NEIGHBOUR_MARGIN = 2;
/**
 * Nudges are measured against a fresh packing, and a nudge can in principle
 * reorder a busy edge's slots (packing order depends on where the OTHER ends
 * sit). Re-measuring catches that; a handful of passes is plenty, since each
 * one either settles or is bounded by the same tolerance.
 */
const MAX_PASSES = 4;

/** Which coordinate has to match for a corridor to be straight. */
type CrossAxis = "x" | "y";

interface Candidate {
    corridor: Corridor;
    axis: CrossAxis;
    /** How far the target anchor sits off the source anchor's line. */
    delta: number;
}

export function straightenNodes(
    layout: LayoutResult,
    straightenPercent: number
): void {
    const strength = Math.max(0, Math.min(100, straightenPercent)) / 100;
    if (strength <= 0) {
        return;
    }

    const tolerance: Record<CrossAxis, number> = {
        // A corridor running left-to-right is straightened by moving nodes
        // vertically, so its budget comes from the ROW pitch, and vice versa.
        y: strength * MAX_TOLERANCE_FRACTION * (layout.rowPitch || 0),
        x: strength * MAX_TOLERANCE_FRACTION * (layout.columnGap || 0)
    };
    if (tolerance.x <= 0 && tolerance.y <= 0) {
        return;
    }

    // How busy a node may be and still be considered movable. At low
    // settings only leaf-ish nodes with a single corridor are touched (where
    // a nudge can't trade one kink for another); the ceiling rises with the
    // setting until at 100 any node is fair game.
    const maxDegree = strength >= 1 ? Infinity : 1 + Math.floor(straightenPercent / DEGREE_STEP);

    const degreeOf = new Map<string, number>();
    layout.corridors.forEach(c => {
        degreeOf.set(c.source, (degreeOf.get(c.source) ?? 0) + 1);
        if (c.target !== c.source) {
            degreeOf.set(c.target, (degreeOf.get(c.target) ?? 0) + 1);
        }
    });

    // Total displacement is budgeted against where computeLayout put each
    // node, not against the last pass — otherwise repeated passes could walk
    // a node arbitrarily far in small steps.
    const origin = new Map<string, { x: number; y: number }>();
    layout.nodes.forEach(n => origin.set(n.id, { x: n.x, y: n.y }));

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (!straightenPass(layout, tolerance, maxDegree, degreeOf, origin)) {
            return;
        }
    }
}

/** One measure-and-nudge sweep. Returns true if anything moved. */
function straightenPass(
    layout: LayoutResult,
    tolerance: Record<CrossAxis, number>,
    maxDegree: number,
    degreeOf: Map<string, number>,
    origin: Map<string, { x: number; y: number }>
): boolean {
    const anchors = computeAnchors(layout);
    const candidates = collectCandidates(layout, anchors);
    if (candidates.length === 0) {
        return false;
    }

    // Highest value first: when a node carries several straightenable
    // corridors, the biggest one is the one worth aligning to, and taking it
    // first means the smaller ones are then measured against a node that has
    // already committed to it.
    candidates.sort((a, b) => b.corridor.value - a.corridor.value);

    // A node only moves once per pass. Without this, the second candidate
    // touching a node would silently undo the first.
    const moved = new Set<string>();
    let anyMoved = false;

    candidates.forEach(entry => {
        // Re-read the misalignment rather than trusting the value measured at
        // the top of the pass: an earlier nudge in this same pass may have
        // moved one of these two nodes already, in which case the corridor is
        // no longer off by what it was. The sorted list only fixes the ORDER
        // candidates are considered in.
        const candidate = remeasure(entry, anchors);
        if (!candidate) {
            return;
        }
        const budget = tolerance[candidate.axis];
        if (Math.abs(candidate.delta) <= ALIGNED_EPSILON || Math.abs(candidate.delta) > budget) {
            return;
        }

        const choice = chooseMover(layout, candidate, maxDegree, degreeOf, moved);
        if (!choice) {
            return;
        }
        const { node, shift } = choice;

        // Bounded by where the node started, so passes can't accumulate past
        // the setting's tolerance.
        const start = origin.get(node.id);
        if (start) {
            const already = candidate.axis === "y" ? node.y - start.y : node.x - start.x;
            if (Math.abs(already + shift) > budget) {
                return;
            }
        }

        if (Math.abs(shift) > freeRoom(layout, node, candidate.axis, shift)) {
            return;
        }
        if (!improvesAlignment(layout, anchors, node.id, candidate.axis, shift)) {
            return;
        }

        if (candidate.axis === "y") {
            node.y += shift;
        } else {
            node.x += shift;
        }
        // Packing is relative to the node's own edge, so every anchor on this
        // node travels with it rigidly — no need to re-pack mid-pass.
        shiftAnchors(layout, anchors, node.id, candidate.axis, shift);
        moved.add(node.id);
        anyMoved = true;
    });

    return anyMoved;
}

/** The same candidate, with its misalignment re-read from the current anchors. */
function remeasure(candidate: Candidate, anchors: Map<string, Anchor>): Candidate | undefined {
    const source = anchors.get(anchorKey(candidate.corridor.id, "source"));
    const target = anchors.get(anchorKey(candidate.corridor.id, "target"));
    if (!source || !target) {
        return undefined;
    }
    return { ...candidate, delta: target.point[candidate.axis] - source.point[candidate.axis] };
}

/**
 * Corridors that could be dead straight but aren't quite.
 *
 * Only a DIRECT route between OPPOSITE ports on the same axis qualifies:
 * East->West is a straight horizontal run once the two anchors share a y.
 * East->East has both ends facing the same way, and a perpendicular pairing
 * is an L by construction — neither becomes a straight line however the
 * nodes move, so nudging for them would just displace nodes for nothing.
 */
function collectCandidates(layout: LayoutResult, anchors: Map<string, Anchor>): Candidate[] {
    const candidates: Candidate[] = [];
    layout.corridors.forEach(corridor => {
        if (corridor.isSelfLoop || corridor.value <= 0) {
            return;
        }
        if (portAxis(corridor.sourcePort) !== portAxis(corridor.targetPort)) {
            return;
        }
        if (corridor.sourcePort === corridor.targetPort) {
            return;
        }
        const source = anchors.get(anchorKey(corridor.id, "source"));
        const target = anchors.get(anchorKey(corridor.id, "target"));
        if (!source || !target || routeWraps(source, target)) {
            return;
        }
        // East/West ports face along x, so the run is horizontal and it's the
        // anchors' y values that have to match.
        const axis: CrossAxis = portAxis(corridor.sourcePort) === "vertical" ? "y" : "x";
        candidates.push({ corridor, axis, delta: target.point[axis] - source.point[axis] });
    });
    return candidates;
}

/**
 * Which end to move, and by how much. The less-constrained node gives way —
 * moving the node with fewer corridors attached disturbs less of the rest of
 * the diagram. Ties break on total flow, then on id, so the result doesn't
 * depend on map ordering.
 */
function chooseMover(
    layout: LayoutResult,
    candidate: Candidate,
    maxDegree: number,
    degreeOf: Map<string, number>,
    moved: Set<string>
): { node: PositionedNode; shift: number } | undefined {
    const source = layout.nodes.get(candidate.corridor.source);
    const target = layout.nodes.get(candidate.corridor.target);
    if (!source || !target) {
        return undefined;
    }

    // Moving the source by +delta brings it onto the target's line; moving
    // the target by -delta does the reverse.
    const options: { node: PositionedNode; shift: number }[] = [
        { node: source, shift: candidate.delta },
        { node: target, shift: -candidate.delta }
    ];

    const eligible = options.filter(o => !moved.has(o.node.id) && (degreeOf.get(o.node.id) ?? 0) <= maxDegree);
    if (eligible.length === 0) {
        return undefined;
    }
    eligible.sort((a, b) => {
        const byDegree = (degreeOf.get(a.node.id) ?? 0) - (degreeOf.get(b.node.id) ?? 0);
        if (byDegree !== 0) {
            return byDegree;
        }
        const byFlow = (a.node.inflow + a.node.outflow) - (b.node.inflow + b.node.outflow);
        if (byFlow !== 0) {
            return byFlow;
        }
        return a.node.id < b.node.id ? -1 : 1;
    });
    return eligible[0];
}

/**
 * How far this node can move in the given direction before it runs into a
 * neighbour. Only nodes that overlap it on the OTHER axis can be run into —
 * a node in the next column is never in the way of a vertical nudge.
 */
function freeRoom(layout: LayoutResult, node: PositionedNode, axis: CrossAxis, shift: number): number {
    const near = (n: PositionedNode) => (axis === "y" ? n.y : n.x);
    const far = (n: PositionedNode) => (axis === "y" ? n.y + n.height : n.x + n.width);
    const otherNear = (n: PositionedNode) => (axis === "y" ? n.x : n.y);
    const otherFar = (n: PositionedNode) => (axis === "y" ? n.x + n.width : n.y + n.height);

    let room = Infinity;
    layout.nodes.forEach(other => {
        if (other.id === node.id) {
            return;
        }
        // Disjoint on the other axis -> can't collide however far we move.
        if (otherFar(other) <= otherNear(node) || otherNear(other) >= otherFar(node)) {
            return;
        }
        const gap = shift > 0 ? near(other) - far(node) : near(node) - far(other);
        if (gap < 0) {
            return; // already overlapping or behind us on this side
        }
        room = Math.min(room, gap - NEIGHBOUR_MARGIN);
    });
    return Math.max(0, room);
}

/**
 * The net-benefit guard. A node may carry several straightenable corridors,
 * and aligning the biggest one can pull the others further out of true. The
 * nudge is only worth making if the diagram's total misalignment — weighted
 * by flow, so a big corridor's kink counts for more than a small one's —
 * doesn't get worse.
 */
function improvesAlignment(
    layout: LayoutResult,
    anchors: Map<string, Anchor>,
    nodeId: string,
    axis: CrossAxis,
    shift: number
): boolean {
    let before = 0;
    let after = 0;
    collectCandidates(layout, anchors).forEach(c => {
        if (c.axis !== axis) {
            return;
        }
        // delta is measured target-minus-source, so moving the SOURCE closes
        // the gap and moving the TARGET opens it by the same amount.
        let shifted = c.delta;
        if (c.corridor.source === nodeId) {
            shifted -= shift;
        }
        if (c.corridor.target === nodeId) {
            shifted += shift;
        }
        if (shifted === c.delta) {
            return; // untouched by this move; contributes equally to both sides
        }
        before += c.corridor.value * Math.abs(c.delta);
        after += c.corridor.value * Math.abs(shifted);
    });
    return after <= before;
}

/** Move every anchor belonging to this node, since they travel with it. */
function shiftAnchors(
    layout: LayoutResult,
    anchors: Map<string, Anchor>,
    nodeId: string,
    axis: CrossAxis,
    shift: number
): void {
    layout.corridors.forEach(c => {
        if (c.source === nodeId) {
            const a = anchors.get(anchorKey(c.id, "source"));
            if (a) {
                a.point[axis] += shift;
            }
        }
        if (c.target === nodeId) {
            const a = anchors.get(anchorKey(c.id, "target"));
            if (a) {
                a.point[axis] += shift;
            }
        }
    });
}
