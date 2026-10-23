import { ArrowOptions, Corridor, GraphNode, OPPOSITE_PORT, Port } from "./model";
import { arrowDepthFactor, stripeGapCount } from "./arrows";

/** A figure per edge of a node. */
type PerPort<T> = Record<Port, T>;

/** The empty face stacks and gap counts, shared so lookups need no allocation. */
export const NO_FACES: PerPort<number[]> = { North: [], South: [], East: [], West: [] };
export const NO_GAPS: PerPort<number> = { North: 0, South: 0, East: 0, West: 0 };

/** What the corridors ask of each node, worked out once per layout. */
export interface FaceDemand {
    /** Value each node has to fit on each of its edges. */
    demandOf: (nodeId: string) => PerPort<number>;
    /**
     * Busiest edge on the axis that packs along the node's height (East/West) or width
     * (North/South).
     */
    demandAlong: (nodeId: string, axis: "vertical" | "horizontal") => number;
    /**
     * The corridor values packed onto each edge of each node, and the stripe gaps those corridors
     * hold.
     */
    faceValues: Map<string, PerPort<number[]>>;
    faceStripeGaps: Map<string, PerPort<number>>;
    /** The same, restricted to the ends an arrow head or tail is drawn on. */
    headFaceValues: Map<string, PerPort<number[]>>;
    tailFaceValues: Map<string, PerPort<number[]>>;
    headStripeGaps: Map<string, PerPort<number>>;
    tailStripeGaps: Map<string, PerPort<number>>;
    arrowHeads: boolean;
    arrowTails: boolean;
    /** Depth of an arrow taper per unit of half-stack, from the one arrow angle. */
    arrowFactor: number;
    /** Which way a node's flow is heading. */
    flowDirectionOf: (nodeId: string) => Port;
    /** The busiest node's throughput: the default thickness reference. */
    autoBaseline: number;
}

export function buildFaceDemand(
    nodes: Map<string, GraphNode>,
    corridors: Corridor[],
    arrows: ArrowOptions | undefined
): FaceDemand {
    // How much value each node has to fit on each of its four edges. A node is sized by its
    // busiest edge per axis, not by its total throughput: once ports are overridable, everything
    // could leave via North, and an edge has to be big enough to pack what actually lands on it.
    // With the default ports (out->East, in->West) this reduces to max(inflow, outflow).
    // It is kept split by direction as well as by port: the total decides how big an edge has to
    // be, but only the outgoing half can say which way the node's flow is heading.
    //
    // This is computed up here, before any margin, because `labelPorts` below decides which face
    // each node labels against from this same demand, and the fit then measures the label where
    // that puts it.
    const portDemand = new Map<string, Record<Port, number>>();
    const outDemand = new Map<string, Record<Port, number>>();
    const inDemand = new Map<string, Record<Port, number>>();
    const noDemand = (): Record<Port, number> => ({ North: 0, South: 0, East: 0, West: 0 });
    const addTo = (map: Map<string, Record<Port, number>>, nodeId: string, port: Port, value: number) => {
        let demand = map.get(nodeId);
        if (!demand) {
            demand = noDemand();
            map.set(nodeId, demand);
        }
        demand[port] += value;
    };
    corridors.forEach(c => {
        addTo(portDemand, c.source, c.sourcePort, c.value);
        addTo(portDemand, c.target, c.targetPort, c.value);
        addTo(outDemand, c.source, c.sourcePort, c.value);
        addTo(inDemand, c.target, c.targetPort, c.value);
    });
    const demandOf = (nodeId: string): Record<Port, number> => portDemand.get(nodeId) ?? noDemand();
    /**
     * Each node's busiest edge per axis: `vertical` is the pair that packs along the node's height
     * (East/West), `horizontal` the pair that packs along its width (North/South).
     *
     * It is computed once here rather than per node per trial. `sizeNodes` is the fit's inner loop
     * (it runs a few hundred times per layout while the pitches are being solved) and demand
     * depends only on the corridors, which nothing below touches. A keyed memo is slower than the
     * precomputed array: building a string key and hitting a Map costs more than the little
     * filter/map chain. Precomputing wins because it does the work once per node, not once per node
     * per trial. Do not reintroduce a memo here.
     */
    const demandAxes = new Map<string, { vertical: number; horizontal: number }>();
    nodes.forEach(n => {
        const demand = demandOf(n.id);
        demandAxes.set(n.id, {
            vertical: Math.max(demand.East, demand.West),
            horizontal: Math.max(demand.North, demand.South)
        });
    });
    const NO_AXIS_DEMAND = { vertical: 0, horizontal: 0 };
    /**
     * Busiest edge on the axis that packs along the node's height (East/West) or width
     * (North/South).
     */
    const demandAlong = (nodeId: string, axis: "vertical" | "horizontal"): number =>
        (demandAxes.get(nodeId) ?? NO_AXIS_DEMAND)[axis];

    /**
     * Every corridor value that packs onto each of a node's four edges, which is what `sizeNodes`
     * measures a node against. The values are kept rather than a total, because a corridor's drawn
     * width is floored at MIN_CORRIDOR_WIDTH and so is not proportional to its value: what a face
     * has to hold is the sum of the widths its corridors are drawn at, and that can only be had by
     * converting each one separately.
     *
     * Zero-value corridors are left out, exactly as `packPort` leaves them out: they draw as
     * nothing and reserve nothing. A self-loop appears on both of the edges it uses, since it puts
     * an end on each.
     *
     * It is built once, out of the fit's way: `sizeNodes` runs a few hundred times per layout while
     * the pitches are solved, and this depends only on the corridors.
     */
    const faceValues = new Map<string, Record<Port, number[]>>();
    const faceFor = (nodeId: string): Record<Port, number[]> => {
        let face = faceValues.get(nodeId);
        if (!face) {
            face = { North: [], South: [], East: [], West: [] };
            faceValues.set(nodeId, face);
        }
        return face;
    };
    /**
     * How many separation gaps each face holds, counted once here for the same reason
     * `faceValues` is: it depends only on the corridors, and `sizeNodes` runs a few hundred times
     * per layout.
     *
     * Two kinds, summed: one between each pair of corridors on the face (`values.length - 1`,
     * added at the point of use since the count of entries lives with the values), and one between
     * each pair of stripes inside every corridor on it (`stripeGapCount`). `packPort` and
     * `routeCorridor` lay out exactly these two, from the same helper.
     */
    const faceStripeGaps = new Map<string, Record<Port, number>>();
    const stripeGapsFor = (nodeId: string): Record<Port, number> => {
        let face = faceStripeGaps.get(nodeId);
        if (!face) {
            face = { North: 0, South: 0, East: 0, West: 0 };
            faceStripeGaps.set(nodeId, face);
        }
        return face;
    };
    corridors.forEach(c => {
        if (c.value <= 0) {
            return;
        }
        faceFor(c.source)[c.sourcePort].push(c.value);
        faceFor(c.target)[c.targetPort].push(c.value);
        const inner = stripeGapCount(c);
        stripeGapsFor(c.source)[c.sourcePort] += inner;
        stripeGapsFor(c.target)[c.targetPort] += inner;
    });
    /**
     * The same, but split by role and holding only the ends an arrow is actually drawn for: a head
     * needs Arrow heads on, a tail needs Arrow tails. This is separate from `faceValues`, which
     * sizes the node from everything it holds whatever is drawn over it.
     *
     * It is split because what the two facing tapers cost the clearance between them depends on
     * which of the two is the head (see `arrowClearanceLoss`); a node cannot be floored without
     * knowing that.
     *
     * One face can interleave inbound and outbound ends (a port override), and routing then splits
     * it into a run apiece, each tapering from its own extent. This measures the whole face
     * instead, so the depth it provisions for is never less than the deepest run's. That is the
     * direction that matters: over-providing is absorbed by the arrow's stem and the gap comes out
     * exactly as asked, where under-providing would shorten the gap.
     *
     * Built once, outside the fit.
     */
    const arrowHeads = arrows?.heads === true;
    const arrowTails = arrows?.tails === true;
    // One angle for the diagram, so this is one number for the diagram, computed out of the fit's
    // inner loop rather than as a tangent per face per node per trial pitch.
    const arrowFactor = arrows ? arrowDepthFactor(arrows.angleDegrees) : 0;
    const headFaceValues = new Map<string, Record<Port, number[]>>();
    const tailFaceValues = new Map<string, Record<Port, number[]>>();
    // The stripe gaps of the same subsets, so a run that is only part of a face can still be
    // measured against the extent it is actually drawn in.
    const headStripeGaps = new Map<string, Record<Port, number>>();
    const tailStripeGaps = new Map<string, Record<Port, number>>();
    const gapsIn = (into: Map<string, Record<Port, number>>, nodeId: string): Record<Port, number> => {
        let face = into.get(nodeId);
        if (!face) {
            face = { North: 0, South: 0, East: 0, West: 0 };
            into.set(nodeId, face);
        }
        return face;
    };
    if (arrowHeads || arrowTails) {
        const faceIn = (into: Map<string, Record<Port, number[]>>, nodeId: string) => {
            let face = into.get(nodeId);
            if (!face) {
                face = { North: [], South: [], East: [], West: [] };
                into.set(nodeId, face);
            }
            return face;
        };
        corridors.forEach(c => {
            if (c.value <= 0) {
                return;
            }
            const inner = stripeGapCount(c);
            // A source end is flow leaving, so it is drawn as a tail.
            if (arrowTails) {
                faceIn(tailFaceValues, c.source)[c.sourcePort].push(c.value);
                gapsIn(tailStripeGaps, c.source)[c.sourcePort] += inner;
            }
            if (arrowHeads) {
                faceIn(headFaceValues, c.target)[c.targetPort].push(c.value);
                gapsIn(headStripeGaps, c.target)[c.targetPort] += inner;
            }
        });
    }
    /**
     * Which way this node's flow is heading (see `PositionedNode.flowDirection`). Scanned
     * East-first so a node with a genuine tie, equal load leaving two opposite edges, points the
     * way the diagram itself reads rather than whichever port happens to sort first.
     */
    const SCAN_ORDER: readonly Port[] = ["East", "South", "North", "West"];
    const busiest = (demand: Record<Port, number>): Port | undefined => {
        let best: Port | undefined;
        let bestValue = 0;
        SCAN_ORDER.forEach(p => {
            if (demand[p] > bestValue) {
                bestValue = demand[p];
                best = p;
            }
        });
        return best;
    };
    const flowDirectionOf = (nodeId: string): Port => {
        const out = busiest(outDemand.get(nodeId) ?? noDemand());
        if (out) {
            return out;
        }
        // No outflow at all: a sink. Point onward, away from where its supply arrived, rather than
        // back down its own inbound corridor.
        const incoming = busiest(inDemand.get(nodeId) ?? noDemand());
        return incoming ? OPPOSITE_PORT[incoming] : "East";
    };

    // One value->pixels scale for the whole diagram, not a per-column packing.
    const autoBaseline = Math.max(
        1,
        ...Array.from(nodes.values()).map(n => Math.max(
            demandAlong(n.id, "vertical"),
            demandAlong(n.id, "horizontal")
        ))
    );

    return {
        demandOf, demandAlong, faceValues, faceStripeGaps,
        headFaceValues, tailFaceValues, headStripeGaps, tailStripeGaps,
        arrowHeads, arrowTails, arrowFactor, flowDirectionOf, autoBaseline
    };
}
