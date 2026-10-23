/**
 * Node edits: per-node settings the author changes in the node editor rather than
 * in the data. These are a label, whether the name shows, an icon, a colour, and
 * which face a node's flows use.
 *
 * Nodes are not data rows, so the format pane has nowhere to keep a per-node value
 * (there is no selector to store it against, and `capabilities.json` cannot declare
 * properties per node). Like the positions, the edits are one hidden JSON blob keyed
 * by node id, written by the editor panel.
 *
 * Precedence: for the label, the name, the icon and the colour, an edit beats the
 * data, which beats the automatic default. For ports the data wins: a port is set
 * per flow in the data, and a node-level edit only fills the flows whose port the
 * data leaves blank.
 *
 * Edits for a node that is no longer in the data are kept, as positions are: a
 * slicer can take a node away and bring it back.
 */

import { Corridor, Graph, Port, PORTS } from "./model";
import { isVettedIcon } from "./background";

/** One node's edits. Every field is optional; absent means "follow the data". */
export interface NodeEdit {
    /** The label to show, instead of the data's. */
    label?: string;
    /** true hides the name, false shows it even where the data blanks it; absent follows the data. */
    hideName?: boolean;
    /** A vetted SVG data URL; "" means no icon even where the data has one; absent follows the data. */
    icon?: string;
    /** The face outflows leave by, where the data leaves a flow's source port blank. */
    outPort?: Port;
    /** The face inflows arrive by, where the data leaves a flow's target port blank. */
    inPort?: Port;
    /** The node's colour, #RRGGBB, instead of the data's or the theme's. */
    colour?: string;
}

export type NodeEdits = Map<string, NodeEdit>;

/** Longest label kept. A label is one line; anything longer is a mistake. */
export const MAX_EDIT_LABEL = 200;
/** All edited icons together, in stored characters. They travel in the report. */
export const MAX_EDIT_ICONS_TOTAL = 300 * 1024;

const isHexColour = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const isPort = (v: unknown): v is Port => typeof v === "string" && (PORTS as readonly string[]).includes(v);

/** Stored characters the edited icons take. */
export function iconBudgetUsed(edits: NodeEdits, except?: string): number {
    let used = 0;
    edits.forEach((edit, id) => {
        if (id !== except && edit.icon) {
            used += edit.icon.length;
        }
    });
    return used;
}

/**
 * Reads the blob. It is total: a field of the wrong shape is dropped on its own, a
 * node with nothing left is dropped, and icons past the total budget are dropped (in
 * the blob's order) rather than failing the lot.
 */
export function parseNodeEdits(raw: unknown): NodeEdits {
    const edits: NodeEdits = new Map();
    if (typeof raw !== "string" || raw.trim() === "") {
        return edits;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return edits;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return edits;
    }
    let iconChars = 0;
    Object.entries(parsed as Record<string, unknown>).forEach(([id, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return;
        }
        const v = value as Record<string, unknown>;
        const edit: NodeEdit = {};
        if (typeof v.l === "string") {
            edit.label = v.l.slice(0, MAX_EDIT_LABEL);
        }
        if (v.h === 1 || v.h === 0) {
            edit.hideName = v.h === 1;
        }
        if (v.i === "") {
            edit.icon = "";
        } else if (isVettedIcon(v.i) && iconChars + v.i.length <= MAX_EDIT_ICONS_TOTAL) {
            edit.icon = v.i;
            iconChars += v.i.length;
        }
        if (isPort(v.o)) {
            edit.outPort = v.o;
        }
        if (isPort(v.n)) {
            edit.inPort = v.n;
        }
        if (isHexColour(v.c)) {
            edit.colour = v.c;
        }
        if (Object.keys(edit).length > 0) {
            edits.set(id, edit);
        }
    });
    return edits;
}

export function serialiseNodeEdits(edits: NodeEdits): string {
    const out: Record<string, Record<string, string | number>> = {};
    edits.forEach((edit, id) => {
        const e: Record<string, string | number> = {};
        if (edit.label !== undefined) {
            e.l = edit.label;
        }
        if (edit.hideName !== undefined) {
            e.h = edit.hideName ? 1 : 0;
        }
        if (edit.icon !== undefined) {
            e.i = edit.icon;
        }
        if (edit.outPort) {
            e.o = edit.outPort;
        }
        if (edit.inPort) {
            e.n = edit.inPort;
        }
        if (edit.colour) {
            e.c = edit.colour;
        }
        if (Object.keys(e).length > 0) {
            out[id] = e;
        }
    });
    return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}

/**
 * One node's edit changed: fields set to `undefined` in `patch` go back to the
 * data. A node left with nothing edited disappears from the map.
 */
export function withNodeEdit(edits: NodeEdits, id: string, patch: Partial<Record<keyof NodeEdit, unknown>>): NodeEdits {
    const next: NodeEdits = new Map(edits);
    const edit: Record<string, unknown> = { ...(edits.get(id) ?? {}) };
    Object.entries(patch).forEach(([key, value]) => {
        if (value === undefined) {
            delete edit[key];
        } else {
            edit[key] = value;
        }
    });
    if (Object.keys(edit).length === 0) {
        next.delete(id);
    } else {
        next.set(id, edit as NodeEdit);
    }
    return next;
}

/** What the data alone says about a node, before any edit. The editor shows it. */
export interface NodeDataFacts {
    id: string;
    /** The data's label: the id where no label field says otherwise, "" where the data blanks it. */
    label: string;
    icon?: string;
    /** The data's node colour, if it sets one. */
    colour?: string;
}

/**
 * Applies the label, name and icon edits to a freshly built graph, in place, and
 * returns what the data said first (for the editor). Ports are applied separately,
 * in `inferCorridors`, because the data wins there.
 */
export function applyNodeEdits(graph: Graph, edits: NodeEdits): NodeDataFacts[] {
    const facts: NodeDataFacts[] = [];
    graph.nodes.forEach(node => {
        facts.push({ id: node.id, label: node.label, icon: node.icon, colour: node.colour });
        const edit = edits.get(node.id);
        if (!edit) {
            return;
        }
        // The name: an edited label, else the data's, else the id. The hide switch decides
        // whether it is shown at all.
        const edited = edit.label !== undefined && edit.label.trim() !== "" ? edit.label : undefined;
        if (edit.hideName === true) {
            node.label = "";
        } else if (edited !== undefined) {
            // Shown even where the data blanks the name: the edit wins.
            node.label = edited;
        } else if (edit.hideName === false && node.label === "") {
            node.label = node.id;
        }
        if (edit.icon !== undefined) {
            node.icon = edit.icon === "" ? undefined : edit.icon;
        }
        if (edit.colour !== undefined) {
            node.colour = edit.colour;
        }
    });
    return facts;
}

/**
 * Node labels > Just terminal nodes: blanks the name of every node that something
 * flows through, so only the ends of the diagram are named.
 *
 * A terminal node is one with no flow in or no flow out: a pure source or a pure
 * sink, wherever its stage is. A self-loop is neither in nor out. A node nothing
 * touches is terminal.
 *
 * It blanks `label` as the editor's Hide name does, so layout reserves nothing for
 * the name and a label that is not drawn is not measured. It also sets `hideTotal`,
 * so layout reserves nothing for a figure that is not drawn. It runs after
 * `applyNodeEdits`, which reports what the data said first, because the editor must
 * keep showing the real names.
 *
 * The editor has the last word: a node whose edit says Show name keeps its label and
 * its total, because that is the author asking for this one by hand.
 */
export function hideInteriorLabels(graph: Graph, corridors: readonly Corridor[], edits: NodeEdits): void {
    const receives = new Set<string>();
    const sends = new Set<string>();
    corridors.forEach(corridor => {
        if (corridor.isSelfLoop || corridor.source === corridor.target) {
            return;
        }
        sends.add(corridor.source);
        receives.add(corridor.target);
    });
    graph.nodes.forEach(node => {
        const through = receives.has(node.id) && sends.has(node.id);
        if (through && edits.get(node.id)?.hideName !== false) {
            node.label = "";
            node.hideTotal = true;
        }
    });
}

/**
 * Which node names the Node labels card lets through: the card's own switch, and
 * Just terminal nodes under it.
 *
 * - `shown: false` blanks every name;
 * - otherwise `terminalOnly` blanks the ones something flows through.
 *
 * One function, so the diagram and the trial layouts the arrangers build cannot
 * apply it differently. A node's total is not decided here: the switch turns
 * `labels.nodeTotals` off, which is a layout input of its own.
 */
export function applyLabelScope(
    graph: Graph,
    corridors: readonly Corridor[],
    edits: NodeEdits,
    scope: { shown: boolean; terminalOnly: boolean }
): void {
    if (!scope.shown) {
        graph.nodes.forEach(node => {
            if (edits.get(node.id)?.hideName !== false) {
                node.label = "";
            }
        });
    } else if (scope.terminalOnly) {
        hideInteriorLabels(graph, corridors, edits);
    }
}

/** The node-level port defaults the edits give `inferCorridors`. */
export function portDefaultsOf(edits: NodeEdits): { out: (id: string) => Port | undefined; in: (id: string) => Port | undefined } {
    return {
        out: id => edits.get(id)?.outPort,
        in: id => edits.get(id)?.inPort
    };
}
