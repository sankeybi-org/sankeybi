/**
 * Tooltip content, kept out of render.ts because render paints and what a tooltip
 * says is a decision.
 *
 * Everything here builds `TooltipRow[]`, and both tooltips a hover can produce are
 * made from that one list: the host's themed box (via `toTooltipItems`) and the
 * native SVG `<title>` (via `rowsToTitle`). They carry the same facts by
 * construction, so the wording cannot drift between the two.
 *
 * There is one fact per row: a node carrying several flow types reads far better as
 * a list than as packed "in X / out Y" rows.
 */

import powerbi from "powerbi-visuals-api";
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

import { Corridor, LabelOptions, PositionedNode, RoutedBand, TotalBasis } from "./model";
import { t, tf } from "./i18n";

/**
 * One row of a tooltip: a label and the figure it names. Both fields are filled
 * wherever there is something for each, because the host lays a row out as two
 * columns and reserves the label's column whether or not anything is in it. Putting
 * a whole sentence in one field leaves that column empty and squeezes the text into
 * what is left, which wastes space and breaks lines mid-sentence.
 */
export interface TooltipRow {
    label: string;
    /** Empty for a row that is only a heading, e.g. the node's own name. */
    value: string;
}

/** The bucket untyped flows report under -- matches corridors.ts's warnings. */
const UNTYPED_LABEL = "(untyped)";
const untyped = (): string => t("ui.tooltip.untyped", UNTYPED_LABEL);

/**
 * A separator between two blocks: a drawn rule in the host's box, and a blank line
 * in the native `<title>` where one works.
 *
 * Whitespace does not survive the host: an empty string, a plain space and a
 * non-breaking space in both fields all lay out as a short gap rather than a line,
 * so the blocks never separate. A rule is ordinary text the host has no reason to
 * collapse, and it reads as a divider besides.
 */
const DIVIDER = "─".repeat(12);
const DIVIDER_ROW: TooltipRow = { label: "", value: "" };

function isDivider(row: TooltipRow): boolean {
    return row.label === "" && row.value === "";
}

/**
 * Formats a value the way the Values card asks for. The column headers, the node
 * totals and every tooltip go through here, so a node drawn "255.0 TWh" cannot
 * tooltip as "255".
 */
export function formatTotal(value: number, labels: LabelOptions): string {
    // The injected formatter honours the model's format string, the report's locale and
    // the display units (formatting.ts). Without one, as in the checks, it falls back to
    // `toLocaleString`.
    const text = labels.formatValue
        ? labels.formatValue(value)
        : value.toLocaleString(undefined, {
            minimumFractionDigits: labels.decimalPlaces,
            maximumFractionDigits: labels.decimalPlaces
        });
    return labels.units ? `${text} ${labels.units}` : text;
}

/**
 * The single number a node is labelled with, on whichever basis the Node labels card
 * asks for.
 *
 * It sits beside `formatTotal` rather than in render.ts because layout needs it too:
 * how wide a node's label block comes out decides whether it fits inside a node shape,
 * and that has to be the same string render draws, or the fit is measured against text
 * that never appears.
 */
export function totalOf(node: PositionedNode, basis: TotalBasis): number {
    switch (basis) {
        case "Outflow":
            return node.outflow;
        case "Inflow":
            return node.inflow;
        case "Larger":
        default:
            return Math.max(node.inflow, node.outflow);
    }
}

/** Which breakdowns a node's tooltip lists. */
export interface NodeTooltipOptions {
    totals: boolean;
    byFlowType: boolean;
    byConnection: boolean;
}

/** In and out for one bucket of a node's throughput. */
interface Directional {
    in: number;
    out: number;
}

/**
 * What a node's tooltip can report, in the three groupings the Interaction
 * card offers. Derived from corridors rather than from bands: a zero-value
 * corridor is deliberately never packed or drawn, but it is still a fact
 * about the data and belongs in a breakdown if anything asks for it.
 */
export interface NodeSummary {
    inflow: number;
    outflow: number;
    /** Keyed by FlowType; `undefined` is the untyped bucket. */
    byType: Map<string | undefined, Directional>;
    /** Keyed by the node at the OTHER end. */
    byConnection: Map<string, Directional>;
}

function emptySummary(): NodeSummary {
    return { inflow: 0, outflow: 0, byType: new Map(), byConnection: new Map() };
}

function bucket<K>(map: Map<K, Directional>, key: K): Directional {
    let entry = map.get(key);
    if (entry === undefined) {
        entry = { in: 0, out: 0 };
        map.set(key, entry);
    }
    return entry;
}

/**
 * Stage 14 support: every node's throughput, broken down three ways. Built
 * once per frame rather than per hover -- a tooltip must not be doing work
 * proportional to the dataset while the pointer moves.
 *
 * A self-loop's node is both ends, so it legitimately appears under both "from
 * X" and "to X", exactly as it counts towards both inflow and outflow.
 */
export function summariseNodes(corridors: Corridor[]): Map<string, NodeSummary> {
    const summaries = new Map<string, NodeSummary>();
    const summaryOf = (id: string): NodeSummary => {
        let s = summaries.get(id);
        if (s === undefined) {
            s = emptySummary();
            summaries.set(id, s);
        }
        return s;
    };

    corridors.forEach(corridor => {
        const source = summaryOf(corridor.source);
        const target = summaryOf(corridor.target);
        // Per segment, not per corridor: the flow-type breakdown is the whole
        // point, and a corridor's segments are where the types live.
        corridor.segments.forEach(segment => {
            source.outflow += segment.value;
            bucket(source.byType, segment.flowType).out += segment.value;
            bucket(source.byConnection, corridor.target).out += segment.value;

            target.inflow += segment.value;
            bucket(target.byType, segment.flowType).in += segment.value;
            bucket(target.byConnection, corridor.source).in += segment.value;
        });
    });
    return summaries;
}

/**
 * A corridor's box: `Grid -> Industry` as the header, then one row per flow type in
 * it with its own figure, and a total where there is more than one type to add up.
 *
 * It is per corridor rather than per stripe, because a click selects a whole corridor
 * (`bandKey`) and a tooltip has to describe what the click will select. A thin stripe
 * cannot be aimed at, but every type in the corridor can be read.
 *
 * Name and figure stay in separate columns rather than one long sentence, so the host
 * has no reason to break a line mid-sentence. Zeroes are not printed, and the types
 * follow legend order, as everywhere else.
 */
export function corridorTooltipRows(
    bands: readonly RoutedBand[],
    labels: LabelOptions,
    flowTypeOrder: readonly string[] = []
): TooltipRow[] {
    if (bands.length === 0) {
        return [];
    }
    const first = bands[0];
    const rows: TooltipRow[] = [{ label: `${first.source} → ${first.target}`, value: "" }];
    const typed = bands
        .filter(b => b.value > 0)
        .sort((a, b) => typeRank(a.flowType, flowTypeOrder) - typeRank(b.flowType, flowTypeOrder)
            || (a.flowType ?? UNTYPED_LABEL).localeCompare(b.flowType ?? UNTYPED_LABEL));
    typed.forEach(b => {
        rows.push({
            label: b.flowType === undefined
                ? untyped()
                : (labels.flowTypeLabels?.get(b.flowType) ?? b.flowType),
            value: formatTotal(b.value, labels)
        });
    });
    // A single-type corridor's total is the row above it, so adding one would
    // print the same figure twice.
    if (typed.length > 1) {
        rows.push(DIVIDER_ROW);
        rows.push({ label: t("ui.tooltip.total", "Total"), value: formatTotal(typed.reduce((s, b) => s + b.value, 0), labels) });
    }
    return rows;
}

/**
 * Flow types in the order the LEGEND lists them, so a tooltip and the legend
 * agree about which type comes first. Anything the legend doesn't know about
 * (including the untyped bucket) sorts to the end rather than jumping to the
 * front on a -1 index.
 */
function typeRank(flowType: string | undefined, order: readonly string[]): number {
    if (flowType === undefined) {
        return Number.MAX_SAFE_INTEGER;
    }
    const index = order.indexOf(flowType);
    return index < 0 ? Number.MAX_SAFE_INTEGER - 1 : index;
}

/** Descending by value, then by name, so equal figures still sort predictably. */
function byValueThenName(a: [string, number], b: [string, number]): number {
    return b[1] - a[1] || a[0].localeCompare(b[0]);
}

/**
 * The rows a node's tooltip shows: its name, then whichever of the three
 * breakdowns the Interaction card has switched on, each separated by a rule.
 * A zero is never printed -- a source node has no inflow, and a row of zeroes
 * is noise in a box that has to be read at a glance.
 */
export function nodeTooltipRows(
    node: PositionedNode,
    summary: NodeSummary | undefined,
    labels: LabelOptions,
    options: NodeTooltipOptions,
    flowTypeOrder: readonly string[] = []
): TooltipRow[] {
    // A node with no corridors at all still names itself.
    const totals = summary ?? emptySummary();
    // The node's own label may be suppressed on the diagram, but a tooltip with no
    // subject is useless, so fall back to the id.
    const blocks: TooltipRow[][] = [[{ label: node.label || node.id, value: "" }]];

    if (options.totals) {
        const rows: TooltipRow[] = [];
        if (totals.inflow > 0) {
            rows.push({ label: t("ui.tooltip.totalIn", "Total in"), value: formatTotal(totals.inflow, labels) });
        }
        if (totals.outflow > 0) {
            rows.push({ label: t("ui.tooltip.totalOut", "Total out"), value: formatTotal(totals.outflow, labels) });
        }
        blocks.push(rows);
    }

    if (options.byFlowType) {
        const ordered = Array.from(totals.byType.entries())
            .sort((a, b) => typeRank(a[0], flowTypeOrder) - typeRank(b[0], flowTypeOrder)
                || (a[0] ?? UNTYPED_LABEL).localeCompare(b[0] ?? UNTYPED_LABEL));
        // Every inbound type, then every outbound one, rather than each type's own pair
        // together. On a node carrying many types, interleaving puts rows in alternating
        // directions, so reading off what the node takes in means skipping every other line.
        // Legend order still decides the order within each group.
        const typeName = (flowType: string | undefined): string =>
            flowType === undefined ? untyped() : (labels.flowTypeLabels?.get(flowType) ?? flowType);
        const rowsFor = (direction: "in" | "out"): TooltipRow[] => ordered
            .filter(([, amounts]) => amounts[direction] > 0)
            .map(([flowType, amounts]) => ({
                label: direction === "in"
                    ? tf("ui.tooltip.typeIn", "{0} in", typeName(flowType))
                    : tf("ui.tooltip.typeOut", "{0} out", typeName(flowType)),
                value: formatTotal(amounts[direction], labels)
            }));
        // The direction stays in each label rather than becoming a sub-heading:
        // a drawn rule means "next breakdown" everywhere else in the box, and
        // one inside a block would make it mean two things at once.
        blocks.push([...rowsFor("in"), ...rowsFor("out")]);
    }

    if (options.byConnection) {
        const incoming: [string, number][] = [];
        const outgoing: [string, number][] = [];
        totals.byConnection.forEach((amounts, other) => {
            if (amounts.in > 0) {
                incoming.push([other, amounts.in]);
            }
            if (amounts.out > 0) {
                outgoing.push([other, amounts.out]);
            }
        });
        blocks.push([
            // Sources first, then targets: a node reads left to right on the
            // diagram and its tooltip should too.
            ...incoming.sort(byValueThenName).map(([other, v]) => ({
                label: tf("ui.tooltip.from", "From {0}", other), value: formatTotal(v, labels)
            })),
            ...outgoing.sort(byValueThenName).map(([other, v]) => ({
                label: tf("ui.tooltip.to", "To {0}", other), value: formatTotal(v, labels)
            }))
        ]);
    }

    // A switched-on breakdown with nothing to report contributes no block at
    // all, rather than a stray rule at the end of the box.
    const present = blocks.filter(block => block.length > 0);
    const rows: TooltipRow[] = [];
    present.forEach((block, i) => {
        if (i > 0) {
            rows.push(DIVIDER_ROW);
        }
        rows.push(...block);
    });
    return rows;
}

/**
 * The host tooltip's items: label in `displayName`, figure in `value`, which is the
 * two-column layout the host is built around.
 *
 * A separator's rule goes in the label column. The host right-aligns the label column
 * and left-aligns the value one, so a rule in the value column begins where the
 * numbers begin and stands clear of the text it divides. The label column is the
 * wider of the two and holds what a reader scans down, so a divider belongs there.
 *
 * A leading heading row (a node's own name) is hoisted into the API's `header` field
 * instead of being emitted as a data row, so the host gives it its own title
 * treatment. The host reads the header off the first item, so it goes there; the
 * separator that followed the heading is dropped with it, since a title needs no rule
 * beneath it. The host owns that box's layout and the API offers no alignment.
 */
export function toTooltipItems(rows: TooltipRow[]): VisualTooltipDataItem[] {
    const heading = rows.length > 0 && !isDivider(rows[0]) && rows[0].value === ""
        ? rows[0].label
        : undefined;
    let body = heading === undefined ? rows : rows.slice(1);
    if (heading !== undefined && body.length > 0 && isDivider(body[0])) {
        body = body.slice(1);
    }

    const items: VisualTooltipDataItem[] = body.map(row => isDivider(row)
        ? { displayName: DIVIDER, value: "" }
        : { displayName: row.label, value: row.value });

    // A heading with nothing under it (every breakdown switched off) still has
    // to say something, or the hover produces an empty box.
    if (heading === undefined) {
        return items;
    }
    if (items.length === 0) {
        return [{ displayName: heading, value: "" }];
    }
    items[0] = { ...items[0], header: heading };
    return items;
}

/**
 * The same rows as the native `<title>` wants them: one string, real newlines.
 * A separator is a genuine blank line here, which that box does render.
 */
export function rowsToTitle(rows: TooltipRow[]): string {
    return rows
        .map(row => {
            if (isDivider(row)) {
                return "";
            }
            return row.value === "" ? row.label : `${row.label}: ${row.value}`;
        })
        .join("\n");
}
