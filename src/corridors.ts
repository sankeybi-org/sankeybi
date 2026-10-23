/**
 * Corridor inference: groups every flow sharing the same source and target into one
 * corridor, then groups each corridor's flows by flow type into segments. The
 * segments are the basis for the stacked-colour rendering. A flow with no flow type
 * lands in a segment whose `flowType` is undefined, so data that never uses flow
 * types renders as a single untyped segment per corridor.
 */

import { Corridor, CorridorSegment, DEFAULT_PORTS, FlowDirection, FlowRow, Port } from "./model";

/**
 * `portDefaults` is the node editor's "Outflows leave via / Inflows arrive via"
 * (nodeEdits.ts). The data wins: a node default only applies to a corridor none of
 * whose flows set that end's port.
 *
 * `direction` is the Arrange card's Flow direction, which is the last fallback and
 * nothing more: the pair of ports a corridor takes when neither the data nor the node
 * editor has said. There are three levels, most specific first: the flow's own cell,
 * then the node's edit, then this.
 */
export function inferCorridors(
    flows: FlowRow[],
    portDefaults?: { out: (id: string) => Port | undefined; in: (id: string) => Port | undefined },
    direction: FlowDirection = "LeftToRight"
): { corridors: Corridor[]; warnings: string[] } {
    const fallback = DEFAULT_PORTS[direction] ?? DEFAULT_PORTS.LeftToRight;
    const byKey = new Map<string, Corridor>();
    const warnings: string[] = [];

    flows.forEach(f => {
        // The key is the JSON of the pair, not a delimited string: a plain
        // `${source}->${target}` key would merge two unrelated corridors if a name contained
        // the delimiter. The corridor `id` stays a readable string for display and debugging,
        // decoupled from the lookup key so it cannot cause a grouping collision.
        const key = JSON.stringify([f.source, f.target]);
        let c = byKey.get(key);
        if (!c) {
            c = {
                id: `${f.source}→${f.target}`,
                source: f.source,
                target: f.target,
                value: 0,
                isSelfLoop: f.source === f.target,
                flows: [],
                segments: [],
                // Default ports: outgoing leaves the direction's out face, incoming arrives at its in
                // face. Overridden below if any of this corridor's flows bind SourcePort or
                // TargetPort.
                sourcePort: fallback.out,
                targetPort: fallback.in
            };
            byKey.set(key, c);
        }
        c.value += f.value;
        c.flows.push(f);
    });

    byKey.forEach(c => {
        c.segments = buildSegments(c.flows, warnings);
        c.sourcePort = resolvePort(c, "sourcePort", "SourcePort", portDefaults?.out(c.source) ?? fallback.out, warnings);
        c.targetPort = resolvePort(c, "targetPort", "TargetPort", portDefaults?.in(c.target) ?? fallback.in, warnings);
    });

    return { corridors: Array.from(byKey.values()), warnings };
}

/**
 * Resolves one end's port for a corridor from its own flows.
 *
 * Port is corridor-level metadata (two corridors leaving the same node may
 * legitimately use different ports), so this resolves across the flows of a single
 * corridor: the first non-blank value wins and a conflict warns. It falls back to the
 * automatic default when no flow binds it.
 */
function resolvePort(
    corridor: Corridor,
    field: "sourcePort" | "targetPort",
    fieldLabel: string,
    fallback: Port,
    warnings: string[]
): Port {
    let resolved: Port | undefined;
    corridor.flows.forEach(f => {
        const value = f[field];
        if (value === undefined) {
            return;
        }
        if (resolved === undefined) {
            resolved = value;
        } else if (resolved !== value) {
            warnings.push(
                `Corridor ${corridor.source} → ${corridor.target}: conflicting ${fieldLabel} values — using "${resolved}".`
            );
        }
    });
    return resolved ?? fallback;
}

/** Stable sentinel for the "no FlowType bound" group, kept out of the public segment shape. */
const UNTYPED = Symbol("untyped");

function buildSegments(flows: FlowRow[], warnings: string[]): CorridorSegment[] {
    const segmentsByType = new Map<string | typeof UNTYPED, CorridorSegment>();
    const order: (string | typeof UNTYPED)[] = [];

    flows.forEach(f => {
        const key = f.flowType ?? UNTYPED;
        let seg = segmentsByType.get(key);
        if (!seg) {
            seg = { flowType: f.flowType, value: 0, flows: [] };
            segmentsByType.set(key, seg);
            order.push(key);
        }
        seg.value += f.value;
        seg.flows.push(f);

        // The first non-blank explicit value wins per flow type, the same rule as for ports,
        // applied here to FlowColour and FlowDisplayOrder.
        const typeLabel = f.flowType !== undefined ? f.flowType : "(untyped)";
        if (f.flowColour) {
            if (seg.flowColourOverride === undefined) {
                seg.flowColourOverride = f.flowColour;
            } else if (seg.flowColourOverride !== f.flowColour) {
                warnings.push(
                    `FlowType "${typeLabel}" has conflicting FlowColour values — using "${seg.flowColourOverride}".`
                );
            }
        }
        if (f.flowDisplayOrder !== undefined) {
            if (seg.displayOrder === undefined) {
                seg.displayOrder = f.flowDisplayOrder;
            } else if (seg.displayOrder !== f.flowDisplayOrder) {
                warnings.push(
                    `FlowType "${typeLabel}" has conflicting FlowDisplayOrder values — using ${seg.displayOrder}.`
                );
            }
        }
    });

    const segments = order.map(key => segmentsByType.get(key) as CorridorSegment);

    // Sort by explicit DisplayOrder first (undefined sorts after any explicit
    // value), then preserve first-seen order as a stable tiebreak.
    return segments
        .map((seg, index) => ({ seg, index }))
        .sort((a, b) => {
            const ao = a.seg.displayOrder ?? Number.POSITIVE_INFINITY;
            const bo = b.seg.displayOrder ?? Number.POSITIVE_INFINITY;
            if (ao !== bo) {
                return ao - bo;
            }
            return a.index - b.index;
        })
        .map(({ seg }) => seg);
}
