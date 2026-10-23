/**
 * Everything the host needs to know about what the user is pointing at: click and hover
 * highlighting, cross-filtering, the context menu and tooltips.
 *
 * It is kept out of render.ts for the same reason interaction.ts is: render paints, and it
 * should not know what a click means. Render calls `registerBand` and `registerNode` to say
 * what a painted element is, and this file owns everything that follows from that.
 *
 * The identity problem shapes the whole file. Power BI addresses data by `ISelectionId`,
 * built from rows of the data view, and neither of the two things SankeyBI draws is a row:
 *
 * - A band is an aggregate. `inferCorridors` groups many flows into a corridor and then
 *   into per-flow-type segments, so a band's identity is a set of rows, not one.
 * - A node has no data identity at all. Nodes are derived from the text in the Source and
 *   Target columns; there is no row that is the Grid node. Its identity is every row naming
 *   it at either end.
 *
 * This is the same wall that forced hidden JSON blobs for dragged positions (see
 * positions.ts), where the answer was to avoid data identity entirely. Here that is not
 * possible, so every selectable thing maps to a list of ids, and "is this selected?" is a
 * set question rather than an equality check.
 *
 * Inbound highlighting arrives on `categorical.values[0].highlights`. It needs a
 * categorical data mapping, the only shape for which Power BI delivers highlights.
 */

import powerbi from "powerbi-visuals-api";
import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import ISelectionId = powerbi.visuals.ISelectionId;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ITooltipService = powerbi.extensibility.ITooltipService;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

import { Corridor } from "./model";
import { consumedByDrag } from "./interaction";
import { t, tf } from "./i18n";

/**
 * The API declares `ISelectionId` twice and the two are not structurally compatible:
 * `powerbi.visuals.ISelectionId` carries `equals` and `getKey`, while the one
 * `ISelectionManager` and `ISelectionIdBuilder` are declared against
 * (`powerbi.extensibility.ISelectionId`) is an empty marker interface. They are the same
 * object at runtime; the split is a quirk of how the typings are layered.
 *
 * So the useful one is stored and cast at the manager boundary. The cast is confined to
 * these two helpers, so there is exactly one place to look if the typings are ever
 * reconciled upstream.
 */
type HostSelectionId = powerbi.extensibility.ISelectionId;
const forHost = (ids: ISelectionId[]): HostSelectionId[] => ids as unknown as HostSelectionId[];
const fromHost = (ids: HostSelectionId[]): ISelectionId[] => ids as unknown as ISelectionId[];

/** How much of its normal opacity a thing keeps when something else is selected. */
const DIMMED_OPACITY = 0.25;

/**
 * A stable key for one selectable thing. It is built with `JSON.stringify` rather than a
 * separator-joined string: node ids and flow types come from the author's data, and a
 * value containing whatever separator was picked would silently merge two unrelated
 * things.
 */
export type SelectionKey = string;

/**
 * One key per corridor, not per stripe.
 *
 * A stripe cannot reliably be aimed at: with a minimum corridor width of one pixel a
 * corridor is often thinner than the pointer and its stripes thinner still, and the halo
 * that makes a thin band hittable is wider than the stripes it covers, so several stripes
 * would answer to the same pixel anyway. Selecting the whole corridor is therefore the
 * only choice a pointer can express.
 *
 * What replaces the lost precision is the tooltip: a corridor's box lists every flow type
 * in it with its own figure (`corridorTooltipRows`), so the breakdown is read rather than
 * clicked.
 */
export function bandKey(corridorId: string): SelectionKey {
    return JSON.stringify(["band", corridorId]);
}

export function nodeKey(nodeId: string): SelectionKey {
    return JSON.stringify(["node", nodeId]);
}

/**
 * Which rows another visual has highlighted, or undefined if it has highlighted nothing.
 *
 * `supportsHighlight` makes the host send the full values array plus a parallel
 * `highlights` array with `null` wherever a row is out of scope. The array being absent is
 * how "nothing is highlighted" arrives, so absent must mean no dimming at all rather than
 * everything dimmed.
 *
 * A row whose highlight is non-null is in scope. This is the yes/no view; how much of a row
 * is in scope is `highlightFractionsOf`, which the sub-bands are drawn from. Both read the
 * same array, and a key is lit when its fraction is above zero. This one exists because the
 * lit or dim decision for a node, a label or the hit halo is genuinely binary.
 *
 * Pure, so it is testable without a host.
 */
export function highlightedRowsOf(dataView: DataView | undefined): Set<number> | undefined {
    const fractions = highlightFractionsOf(dataView);
    if (!fractions) {
        return undefined;
    }
    const rows = new Set<number>();
    fractions.forEach((fraction, rowIndex) => {
        if (fraction > 0) {
            rows.add(rowIndex);
        }
    });
    return rows;
}

/**
 * How much of each row is in scope, from 0 to 1, or undefined when nothing is highlighted.
 *
 * The host computes this per row: the magnitude `highlights[i]` carries differs row to row,
 * not as one ratio. Read as a plain yes or no, a partly highlighted selection puts every row
 * in scope, so nothing dims and the highlight looks as if it never arrived.
 */
export function highlightFractionsOf(dataView: DataView | undefined): Map<number, number> | undefined {
    const columns = dataView?.categorical?.values;
    const column = columns && columns.length > 0 ? columns[0] : undefined;
    const highlights = column?.highlights;
    if (!highlights) {
        return undefined;
    }
    const values = column?.values ?? [];
    const fractions = new Map<number, number>();
    highlights.forEach((raw, rowIndex) => {
        if (raw === null || raw === undefined) {
            fractions.set(rowIndex, 0);
            return;
        }
        const highlighted = Number(raw);
        const whole = Number(values[rowIndex]);
        // A zero-valued row cannot be partly anything; treat any non-null highlight on it as wholly
        // in scope rather than dividing by zero.
        const fraction = !isFinite(highlighted) || !isFinite(whole) || whole === 0
            ? 1
            : highlighted / whole;
        fractions.set(rowIndex, Math.max(0, Math.min(1, fraction)));
    });
    return fractions;
}

/**
 * The share of each key that is in scope: the larger of its rows' shares.
 *
 * The larger rather than a weighted mean, for the reason `litKeysFrom` lights a corridor
 * when any one row does: a key standing for several rows is as much in scope as the most
 * in-scope thing under it, and averaging would let a wholly highlighted stripe be reported
 * as half lit because of a sibling. At stripe grain there is usually one row per key anyway.
 */
export function keyFractionsFrom(
    fractions: ReadonlyMap<number, number>,
    rowsByKey: ReadonlyMap<SelectionKey, number[]>
): Map<SelectionKey, number> {
    const byKey = new Map<SelectionKey, number>();
    rowsByKey.forEach((rows, key) => {
        let most = 0;
        rows.forEach(row => {
            most = Math.max(most, fractions.get(row) ?? 0);
        });
        byKey.set(key, most);
    });
    return byKey;
}

/**
 * Which selectable things an inbound highlight lights up.
 *
 * A key is lit when any of its rows is in scope, not all of them: a corridor carrying five
 * flows of which one is highlighted is part of what the other visual is pointing at, and
 * dimming it would hide the connection the reader is being shown. A node follows the same
 * rule for its own rows.
 *
 * Pure, and separate from the host for the reason `buildRowIndex` is.
 */
export function litKeysFrom(
    highlighted: ReadonlySet<number>,
    rowsByKey: ReadonlyMap<SelectionKey, number[]>
): Set<SelectionKey> {
    const lit = new Set<SelectionKey>();
    rowsByKey.forEach((rows, key) => {
        if (rows.some(row => highlighted.has(row))) {
            lit.add(key);
        }
    });
    return lit;
}

/**
 * One stripe's key (a corridor plus one flow type), for dimming only.
 *
 * It is never a selection key. A band's selection key is its corridor's on purpose, because
 * a stripe cannot be aimed at. That reasoning is entirely about hit targets, and an inbound
 * highlight has none: the host says which rows match. So the dimming can be finer than the
 * clicking, and this is the key that makes it so.
 */
export function stripeKey(corridorId: string, flowType: string | undefined): SelectionKey {
    return JSON.stringify(["stripe", corridorId, flowType ?? ""]);
}

/**
 * The rows behind each thing an inbound highlight can light: everything `buildRowIndex`
 * holds, plus one entry per stripe.
 *
 * It is separate from the selection index rather than merged into it, so nothing can
 * accidentally offer a stripe as a click target.
 */
export function buildDimIndex(corridors: Corridor[]): Map<SelectionKey, number[]> {
    const index = buildRowIndex(corridors);
    corridors.forEach(corridor => {
        corridor.segments.forEach(segment => {
            const rows = segment.flows.map(f => f.rowIndex).sort((a, b) => a - b);
            if (rows.length > 0) {
                index.set(stripeKey(corridor.id, segment.flowType), rows);
            }
        });
    });
    return index;
}

/** The rows behind each selectable thing. Pure, with no host, so it is testable. */
export function buildRowIndex(corridors: Corridor[]): Map<SelectionKey, number[]> {
    const index = new Map<SelectionKey, number[]>();
    const nodeRows = new Map<string, Set<number>>();

    const addNodeRow = (nodeId: string, rowIndex: number) => {
        const existing = nodeRows.get(nodeId);
        if (existing) {
            existing.add(rowIndex);
        } else {
            nodeRows.set(nodeId, new Set([rowIndex]));
        }
    };

    corridors.forEach(corridor => {
        // Per corridor: every stripe of it answers to the same key, so they select and dim
        // together. See `bandKey`.
        const rows = corridor.flows.map(f => f.rowIndex).sort((a, b) => a - b);
        if (rows.length > 0) {
            index.set(bandKey(corridor.id), rows);
        }
        // A self-loop names the same node twice; the Set collapses that.
        corridor.flows.forEach(flow => {
            addNodeRow(flow.source, flow.rowIndex);
            addNodeRow(flow.target, flow.rowIndex);
        });
    });

    nodeRows.forEach((rows, nodeId) => {
        index.set(nodeKey(nodeId), Array.from(rows).sort((a, b) => a - b));
    });
    return index;
}

/**
 * A node's one-hop neighbourhood, as the selection keys it covers: the band key of every
 * corridor touching it, and the node key at each of their far ends.
 *
 * Two things read it, and they are the same question asked twice:
 *
 * - What a node's selection lights. Clicking a node cross-filters the report on every row it
 *   touches (`idsFor` walks source and target), so dimming those very flows would have the
 *   diagram disagree with the report it had just filtered. It is one hop, no further: the
 *   corridors and the nodes they land on, so a lit band never runs into a dimmed node.
 * - Which handles it reveals. A handle answers to a band key, so the node keys in the set
 *   never match one, and the two uses share an index instead of keeping two that could
 *   disagree.
 *
 * It is built from the corridors rather than by splitting a corridor id back apart: an id is
 * `source->target` with an arrow character, and a node whose own label carried that arrow
 * would split into the wrong pair. A self-loop names one node twice, so its far end is
 * itself, already in the selection.
 */
function buildNodeNeighbourhood(corridors: Corridor[]): Map<SelectionKey, Set<SelectionKey>> {
    const index = new Map<SelectionKey, Set<SelectionKey>>();
    const add = (nodeId: string, band: SelectionKey, farEnd: SelectionKey) => {
        const key = nodeKey(nodeId);
        let entry = index.get(key);
        if (!entry) {
            entry = new Set<SelectionKey>();
            index.set(key, entry);
        }
        entry.add(band);
        entry.add(farEnd);
    };
    corridors.forEach(corridor => {
        const band = bandKey(corridor.id);
        add(corridor.source, band, nodeKey(corridor.target));
        add(corridor.target, band, nodeKey(corridor.source));
    });
    return index;
}

/**
 * What a selection covers beyond its own keys: the union of the one-hop neighbourhoods of
 * every selected node. Pure, and empty for a selection that holds no node, so clicking a
 * corridor lights and reveals handles for exactly itself.
 */
function neighboursRevealedBy(
    selected: ReadonlySet<SelectionKey>,
    index: ReadonlyMap<SelectionKey, Set<SelectionKey>>
): Set<SelectionKey> {
    const revealed = new Set<SelectionKey>();
    selected.forEach(key => {
        index.get(key)?.forEach(bandKey => revealed.add(bandKey));
    });
    return revealed;
}

/**
 * What a screen reader is told about one shape.
 *
 * It is built from the same tooltip rows a sighted reader sees, so the two cannot drift. The
 * rows carry drawn separators and heading-only entries, which read as noise aloud, so those
 * are dropped and a `label: value` pair is made of everything else.
 *
 * It falls back to the element's own identity where there are no rows at all: with the
 * Tooltips card's switch off, render still has to say what each shape is, or switching
 * tooltips off would switch accessibility off with them.
 */
export function ariaLabelOf(
    rows: readonly { displayName?: string; value?: string }[],
    key: SelectionKey
): string {
    const said = rows
        .map(row => {
            const name = (row.displayName ?? "").trim();
            const value = (row.value ?? "").trim();
            // A drawn rule between blocks, and the repeated-character separators tooltips.ts uses, say
            // nothing aloud.
            if (/^[\u2500-\u257F\s]*$/.test(name) && /^[\u2500-\u257F\s]*$/.test(value)) {
                return "";
            }
            if (value === "") {
                return name;
            }
            return name === "" ? value : `${name}: ${value}`;
        })
        .filter(part => part !== "");
    if (said.length > 0) {
        return said.join(", ");
    }
    // The key is `["node", id]` or `["band", corridorId]`, and a corridor id is
    // `${source}\u2192${target}`, with the arrow character, built in corridors.ts. It is spelled
    // with the escape so it cannot be mistaken for "->" when read.
    try {
        const parsed = JSON.parse(key) as [string, string];
        if (parsed[0] === "band") {
            return `Flow ${parsed[1].replace("\u2192", " to ")}`;
        }
        return `Node ${parsed[1]}`;
    } catch {
        return "Diagram element";
    }
}

/** What render is handed: a way to say what a painted element is. */
export interface SelectionSink {
    /**
     * `dimKey` is optional on both of these, and is the element's own stripe key where it paints
     * one stripe. It refines dimming only: a click still selects the whole corridor, so a sink
     * that ignores it (the hand-built ones in the render checks) behaves as it always did.
     */
    registerBand(element: SVGElement, corridorId: string, tooltip: VisualTooltipDataItem[],
        dimKey?: SelectionKey): void;
    registerNode(element: SVGElement, nodeId: string, tooltip: VisualTooltipDataItem[]): void;
    /** A label or other decoration that should dim along with the thing it belongs to. */
    registerDecoration(element: SVGElement, key: SelectionKey, dimKey?: SelectionKey): void;
    /**
     * How much of this stripe an inbound highlight has in scope, from 0 to 1, or undefined when
     * nothing is highlighted. Render asks so it can draw the in-scope portion as a sub-band; a
     * fraction of 1 or 0 needs no sub-band.
     *
     * Optional and called with `?.`, so the hand-built sinks in the render checks keep working.
     */
    highlightFractionOf?(dimKey: SelectionKey): number | undefined;
    /** The sub-band itself: the in-scope portion of a stripe, drawn over it. */
    registerSubBand?(element: SVGElement, corridorId: string, dimKey: SelectionKey): void;
    /**
     * A route handle, which is hidden while some other corridor is selected.
     *
     * It is the opposite rule from a decoration: a decoration dims with its owner and stays on
     * screen, where a handle for something the author is not working on is clutter over the
     * diagram they are.
     *
     * Optional and called with `?.`, so the hand-built sinks in the render checks keep working.
     */
    registerHandle?(element: SVGElement, corridorId: string): void;
    /**
     * Whether a native `<title>` on a selectable is worth drawing at all.
     *
     * `attach` strips it again in the two cases it must not appear (tooltips switched off, or the
     * host's own themed box will show instead), which in Power BI is every case. Render would
     * build a title element for each band and node purely for it to be taken away again. Absent
     * means "draw them", so a sink that says nothing keeps the old behaviour and the render
     * checks still see their titles.
     */
    readonly nativeTitles?: boolean;
}

/**
 * Cross-filtering is deliberately not a setting: it is what a Power BI visual does when you
 * click it, and the standard behaviour is the right default to hold everyone to. Hover
 * highlighting is not one either; it was judged too busy on a real diagram. Hovering still
 * shows a tooltip, but does not repaint the diagram.
 */
export interface InteractionBehaviour {
    tooltips: boolean;
}

interface Registered {
    element: SVGElement;
    key: SelectionKey;
    /**
     * A route handle: hidden rather than dimmed when something else is selected. `visibility`
     * is what does it, because a hidden element is not a pointer target either, so "visible" and
     * "clickable" are one attribute and no `pointer-events` bookkeeping is needed to undo it.
     */
    handle?: boolean;
    /**
     * A finer key used for dimming only, when one is available: a stripe's, where `key` is its
     * whole corridor's.
     *
     * An inbound highlight lands on rows, so it can say "this flow type, not that one" and the
     * diagram should show exactly that; a click still selects the whole corridor, because that is
     * the only thing a pointer can reach. Two keys rather than one lets the two disagree without
     * either giving ground.
     */
    dimKey?: SelectionKey;
    /**
     * The sub-band drawn over a partly highlighted stripe: it is the in-scope portion, so while
     * an inbound highlight is in force it stays at full opacity whatever its stripe does. On a
     * click it follows its corridor like anything else, which is why it still carries `key`.
     */
    subBand?: boolean;
}

/**
 * A no-op sink, so render never has to branch on whether interactivity is available. Used by
 * the render checks, which have no host.
 */
export const INERT_SELECTION: SelectionSink = {
    registerBand: () => undefined,
    registerNode: () => undefined,
    registerDecoration: () => undefined,
    registerHandle: () => undefined
};

/**
 * How long the pointer must rest on a shape before the host tooltip appears. A tooltip that
 * fires the instant the pointer touches something pops up constantly while a reader is just
 * looking at the diagram. The value is tuned by eye; there is no API that reports the
 * browser's own delay to match it against.
 */
const TOOLTIP_DELAY_MS = 1000;

/** What `tooltipService.show` and `move` want; named so a pending hover can be stored. */
type TooltipArgs = ReturnType<SelectionController["tooltipArgs"]>;

export class SelectionController implements SelectionSink {
    private readonly host: IVisualHost;
    private readonly manager: ISelectionManager;
    private readonly tooltipService: ITooltipService | undefined;
    /**
     * One id per row, shared by every key that includes it, so equality is cheap and consistent.
     */
    private idsByRow = new Map<number, ISelectionId>();
    private rowsByKey = new Map<SelectionKey, number[]>();
    private registered: Registered[] = [];
    /**
     * The root SVG, kept from `attachBackground` so its own summary label can be refreshed each
     * frame.
     */
    private root: SVGSVGElement | undefined;

    private selected = new Set<SelectionKey>();
    /**
     * What an inbound highlight lights, or undefined when nothing is highlighted. It is separate
     * from `selected` because the two are different things: `selected` is what this visual's own
     * user clicked and is cross-filtered out, while this is what another visual is pointing at. A
     * local click wins; see `applyVisualState`.
     */
    private lit: Set<SelectionKey> | undefined;
    /**
     * How much of each key is in scope, from 0 to 1, while an inbound highlight is in force.
     * `lit` is the above-zero half of this; the fractions let a partly highlighted stripe be drawn
     * as a sub-band instead of all or nothing. Undefined exactly when `lit` is.
     */
    private fractions: Map<SelectionKey, number> | undefined;
    /** Told after a click changes the selection; the node editor follows it. */
    public onSelect: ((keys: ReadonlySet<SelectionKey>) => void) | undefined;
    /**
     * The category column selection ids are built against.
     *
     * Any one of them will do: a categorical data view's category columns are parallel, and
     * `identity[i]` is the scope identity of the whole grouping tuple at that index rather than of
     * that one field, so a click filters on everything the row names.
     */
    private categories: DataViewCategoryColumn | undefined;
    /** See `buildNodeNeighbourhood`: what each node's selection covers. */
    private neighboursByNode: Map<SelectionKey, Set<SelectionKey>> = new Map();
    private behaviour: InteractionBehaviour = { tooltips: true };
    /** Pending hover: the delay has not elapsed yet. */
    private tooltipTimer: ReturnType<typeof setTimeout> | undefined;
    private tooltipShown = false;
    /** The latest pointer position, for when the timer does fire. */
    private pendingTooltip: TooltipArgs | undefined;

    constructor(host: IVisualHost) {
        this.host = host;
        this.manager = host.createSelectionManager();
        this.tooltipService = host.tooltipService;
        // Bookmarks, "clear all filters" and another visual's selection all arrive here rather than
        // through a click of ours.
        this.manager.registerOnSelectCallback(ids => {
            this.selected = this.keysMatching(fromHost(ids));
            this.applyVisualState();
        });
    }

    /**
     * Starts a new frame. `render` empties the SVG, so every element the registry holds is about
     * to be detached; keeping them would dim ghosts and leak a render's worth of DOM per update.
     */
    public beginFrame(
        dataView: DataView | undefined,
        corridors: Corridor[],
        behaviour: InteractionBehaviour
    ): void {
        this.describeRoot(corridors);
        // A hover in flight belongs to elements this render is about to throw away; its pointerleave
        // will never arrive, so it would otherwise pop up over a diagram that has already changed
        // underneath it.
        this.hideTooltip();
        this.registered = [];
        this.behaviour = behaviour;
        this.rowsByKey = buildRowIndex(corridors);
        this.neighboursByNode = buildNodeNeighbourhood(corridors);
        this.idsByRow = new Map();
        this.categories = dataView?.categorical?.categories?.[0];
        // Inbound highlighting is recomputed per frame from the data view this render is for, because
        // the host re-sends it with every change of what is highlighted. It is computed against the dim
        // index, not the selection one: that holds a key per stripe as well, so a highlight that names
        // one flow type lights that stripe rather than every corridor carrying it.
        const rowFractions = highlightFractionsOf(dataView);
        if (rowFractions) {
            const dimIndex = buildDimIndex(corridors);
            this.fractions = keyFractionsFrom(rowFractions, dimIndex);
            this.lit = new Set<SelectionKey>();
            this.fractions.forEach((fraction, key) => {
                if (fraction > 0) {
                    (this.lit as Set<SelectionKey>).add(key);
                }
            });
        } else {
            this.fractions = undefined;
            this.lit = undefined;
        }
    }

    /** Built lazily: a diagram may have far more rows than the user ever clicks. */
    private idForRow(rowIndex: number): ISelectionId | undefined {
        const categories = this.categories;
        if (!categories || rowIndex < 0 || rowIndex >= categories.values.length) {
            return undefined;
        }
        const cached = this.idsByRow.get(rowIndex);
        if (cached) {
            return cached;
        }
        const built = this.host.createSelectionIdBuilder()
            .withCategory(categories, rowIndex).createSelectionId();
        const id = fromHost([built])[0];
        this.idsByRow.set(rowIndex, id);
        return id;
    }

    private idsFor(key: SelectionKey): ISelectionId[] {
        const rows = this.rowsByKey.get(key) ?? [];
        const ids: ISelectionId[] = [];
        rows.forEach(row => {
            const id = this.idForRow(row);
            if (id) {
                ids.push(id);
            }
        });
        return ids;
    }

    /**
     * Which of our keys the host's selection covers. Any overlap counts, not all of it: when
     * another visual selects one row of a three-row corridor, that corridor is part of what the
     * user is looking at, and dimming it would say the opposite.
     */
    private keysMatching(ids: ISelectionId[]): Set<SelectionKey> {
        const matched = new Set<SelectionKey>();
        if (ids.length === 0) {
            return matched;
        }
        this.rowsByKey.forEach((_rows, key) => {
            const mine = this.idsFor(key);
            if (mine.some(a => ids.some(b => a.equals(b)))) {
                matched.add(key);
            }
        });
        return matched;
    }

    /**
     * `dimKey` is this element's own stripe key where it paints exactly one stripe,
     * `stripeKey(corridorId, band.flowType)`, built by the caller because an untyped band has a
     * stripe key too and a `flowType` of undefined could not tell the two cases apart.
     *
     * It never changes what a click selects: that is the corridor, always.
     */
    public registerBand(
        element: SVGElement,
        corridorId: string,
        tooltip: VisualTooltipDataItem[],
        dimKey?: SelectionKey
    ): void {
        this.attach(element, bandKey(corridorId), tooltip, dimKey);
    }

    public registerNode(element: SVGElement, nodeId: string, tooltip: VisualTooltipDataItem[]): void {
        this.attach(element, nodeKey(nodeId), tooltip);
    }

    /**
     * What the diagram says it is, on the root. Counts rather than contents: a list of 39 flows
     * read aloud at the door is worse than nothing.
     *
     * It has a label and no role, deliberately. `role="img"` on a container makes assistive
     * technology treat the whole thing as a single image and ignore its descendants, which would
     * hide the per-flow and per-node labels that are the useful half of this.
     */
    private describeRoot(corridors: readonly Corridor[]): void {
        if (!this.root || typeof this.root.setAttribute !== "function") {
            return;
        }
        const nodes = new Set<string>();
        corridors.forEach(c => {
            nodes.add(c.source);
            nodes.add(c.target);
        });
        this.root.setAttribute("aria-label", corridors.length === 0
            ? t("ui.aria.noData", "Sankey diagram, no data")
            : tf("ui.aria.diagram", "Sankey diagram, {0} flows between {1} nodes", corridors.length, nodes.size));
    }

    public registerDecoration(element: SVGElement, key: SelectionKey, dimKey?: SelectionKey): void {
        // Dims with its owner but is not a click target of its own: a label that swallowed clicks
        // would make the node under it hard to hit.
        this.registered.push({ element, key, dimKey });
    }

    /** See `SelectionSink`. Undefined when nothing is highlighted. */
    public highlightFractionOf(dimKey: SelectionKey): number | undefined {
        return this.fractions?.get(dimKey);
    }

    /** See `SelectionSink`. */
    public registerSubBand(element: SVGElement, corridorId: string, dimKey: SelectionKey): void {
        this.registered.push({ element, key: bandKey(corridorId), dimKey, subBand: true });
    }

    public registerHandle(element: SVGElement, corridorId: string): void {
        // Not attached as a selectable: clicking a handle has never meant "select this corridor", and
        // making it one would select on every drag that fell under the click threshold and
        // cross-filter the report with it. It only listens for whose turn it is to be on screen.
        this.registered.push({ element, key: bandKey(corridorId), handle: true });
    }

    private attach(
        element: SVGElement,
        key: SelectionKey,
        tooltip: VisualTooltipDataItem[],
        dimKey?: SelectionKey
    ): void {
        this.registered.push({ element, key, dimKey });
        if (typeof element.addEventListener !== "function") {
            return; // a non-DOM test harness; registration for dimming is still useful
        }
        element.setAttribute("cursor", "pointer");
        // Described to a screen reader, but not focusable. `role="img"` with a label is what a
        // non-text graphic wants: it tells a reader "this is one thing, and here is what it says"
        // rather than leaving it to guess from the SVG, and a browse-mode cursor reaches it without the
        // element being in any tab order.
        //
        // There is deliberately no `tabindex`: keyboard navigation inside a Power BI visual frame does
        // not work reliably, and a `tabindex` with nothing behind it brings back the browser's own
        // focus ring on every click.
        element.setAttribute("role", "img");
        element.setAttribute("aria-label", ariaLabelOf(tooltip, key));
        // render.ts gives every shape a native `<title>`, which the browser shows on its own whatever
        // the visual does. It is stripped both when the host's themed box will appear instead (or a
        // rest on one shape would eventually produce both boxes) and when tooltips are switched off,
        // because off has to mean no tooltip at all. What is left is the one case it exists for:
        // tooltips on, but no service to show them, which is any host that is not Power BI.
        if (this.behaviour.tooltips === false || this.tooltipsLive()) {
            const title = typeof element.querySelector === "function" ? element.querySelector("title") : null;
            if (title) {
                element.removeChild(title);
            }
        }

        element.addEventListener("click", event => this.onClick(event as MouseEvent, key));
        element.addEventListener("contextmenu", event => this.onContextMenu(event as MouseEvent, key));
        // Hover is for the tooltip only. It deliberately does not repaint the diagram: dimming on
        // hover was tried, and on a real diagram the whole picture flickering as the pointer crosses
        // it is more distracting than informative.
        element.addEventListener("pointerenter", event => this.showTooltip(event as PointerEvent, key, tooltip));
        element.addEventListener("pointermove", event => this.moveTooltip(event as PointerEvent, key, tooltip));
        element.addEventListener("pointerleave", () => this.hideTooltip());
        // Pressing on a shape cancels a pending tooltip. A drag starts with a pointerdown and then
        // holds the pointer still on its way, so without this the tooltip fires a second into the drag
        // and follows the node around. A plain click cancels it too, which is right anyway: the reader
        // has stopped reading and started acting.
        element.addEventListener("pointerdown", () => this.hideTooltip());
    }

    /**
     * Clicking the diagram's own background clears the selection, which is how every native Power
     * BI visual behaves. Element handlers stop propagation, so this only ever sees a click that hit
     * nothing.
     */
    public attachBackground(svg: SVGSVGElement): void {
        // Kept so `beginFrame` can keep the root's own summary label current.
        this.root = svg;
        if (typeof svg.addEventListener !== "function") {
            return;
        }
        svg.addEventListener("click", () => {
            if (this.selected.size === 0) {
                return;
            }
            this.selected = new Set();
            this.manager.clear();
            this.applyVisualState();
        });
        svg.addEventListener("contextmenu", event => this.onContextMenu(event as MouseEvent, undefined));
    }

    private onClick(event: MouseEvent, key: SelectionKey): void {
        // The browser synthesises a click at the end of a drag too; that gesture already meant
        // something else.
        if (consumedByDrag(event.currentTarget)) {
            return;
        }
        event.stopPropagation();
        this.select(key, event.ctrlKey || event.metaKey || event.shiftKey);
    }

    /**
     * What selecting one thing does, whether a click or a key did it. It is shared rather than
     * duplicated: these are rules, and two copies of them is how two input methods end up doing
     * subtly different things to the same report.
     */
    private select(key: SelectionKey, multi: boolean): void {
        const wasSelected = this.selected.has(key);

        if (multi) {
            if (wasSelected) {
                this.selected.delete(key);
            } else {
                this.selected.add(key);
            }
        } else {
            // Clicking the one thing already selected clears it, so there is always a way out that does
            // not require finding empty background.
            this.selected = wasSelected && this.selected.size === 1 ? new Set() : new Set([key]);
        }

        const ids: ISelectionId[] = [];
        this.selected.forEach(k => this.idsFor(k).forEach(id => ids.push(id)));
        // Always an absolute set rather than a toggle: our own key set is the source of truth, and
        // letting the host toggle independently is how the two drift apart.
        if (ids.length === 0) {
            this.manager.clear();
        } else {
            this.manager.select(forHost(ids), false);
        }
        this.applyVisualState();
        this.onSelect?.(this.selected);
    }

    private onContextMenu(event: MouseEvent, key: SelectionKey | undefined): void {
        // Always on, whatever the Tooltips card says: the context menu is a certification requirement,
        // so it is not the author's to turn off.
        event.preventDefault();
        event.stopPropagation();
        const ids = key ? forHost(this.idsFor(key)) : [];
        // An empty object is the documented way to ask for the menu with no data point behind it:
        // right-clicking the background still has to offer the report-level commands.
        this.manager.showContextMenu(
            ids.length > 0 ? ids[0] : ({} as HostSelectionId),
            { x: event.clientX, y: event.clientY });
    }

    private tooltipArgs(event: PointerEvent, key: SelectionKey, items: VisualTooltipDataItem[]) {
        return {
            coordinates: [event.clientX, event.clientY],
            isTouchEvent: event.pointerType === "touch",
            dataItems: items,
            identities: this.idsFor(key)
        };
    }

    /** Whether a hover should produce the host's tooltip at all. */
    private tooltipsLive(): boolean {
        return this.behaviour.tooltips && this.tooltipService?.enabled() === true;
    }

    /**
     * See `SelectionSink.nativeTitles`. Exactly the cases `attach` does not strip a title in; the
     * two have to agree, or render would either draw titles that are thrown away or leave out
     * ones that are wanted.
     */
    public get nativeTitles(): boolean {
        return !(this.behaviour.tooltips === false || this.tooltipsLive());
    }

    private showTooltip(event: PointerEvent, key: SelectionKey, items: VisualTooltipDataItem[]): void {
        if (!this.tooltipsLive() || items.length === 0) {
            return;
        }
        this.pendingTooltip = this.tooltipArgs(event, key, items);
        clearTimeout(this.tooltipTimer);
        this.tooltipTimer = setTimeout(() => {
            this.tooltipTimer = undefined;
            const args = this.pendingTooltip;
            if (args === undefined) {
                return;
            }
            this.tooltipShown = true;
            this.tooltipService?.show(args);
        }, TOOLTIP_DELAY_MS);
    }

    private moveTooltip(event: PointerEvent, key: SelectionKey, items: VisualTooltipDataItem[]): void {
        if (!this.tooltipsLive() || items.length === 0) {
            return;
        }
        const args = this.tooltipArgs(event, key, items);
        if (this.tooltipShown) {
            this.tooltipService?.move(args);
            return;
        }
        // Still waiting: remember where the pointer is now, but deliberately do not restart the timer.
        // The delay is measured from entering the shape, so tracing a long band still produces a
        // tooltip rather than deferring it for as long as the pointer keeps moving.
        this.pendingTooltip = args;
    }

    private hideTooltip(): void {
        clearTimeout(this.tooltipTimer);
        this.tooltipTimer = undefined;
        this.pendingTooltip = undefined;
        this.tooltipShown = false;
        this.tooltipService?.hide({ isTouchEvent: false, immediately: false });
    }

    /**
     * Paints the current state. It sets the `opacity` attribute rather than `fill-opacity`, so it
     * composes with whatever each element already uses (a band's own Flow transparency, a shape's
     * border) instead of overwriting it, and so it needs no knowledge of how anything is painted,
     * which keeps the render and interaction split honest.
     */
    public applyVisualState(): void {
        /**
         * A local click beats an inbound highlight. Both dim, and they can be in force at once: another
         * visual is highlighting us and then the reader clicks a flow here. The click wins because it is
         * the more recent, direct action and because it is what this visual is cross-filtering out;
         * showing the old highlight while filtering on the new click would have the diagram disagree
         * with the report.
         *
         * With neither in force nothing dims, which is what an absent `highlights` array means.
         */
        const clicked = this.selected.size > 0;
        const scope = clicked ? this.selected : this.lit;
        const dimming = scope !== undefined && scope.size > 0;
        /**
         * A selected node covers its one hop: its corridors and the nodes at their far ends. They stay
         * lit, and their handles are revealed.
         *
         * Lighting them is the consistent answer. Clicking a node already cross-filters the report on
         * every row it touches (`idsFor` walks source and target), so dimming those same flows would
         * have the diagram contradict the report it had just filtered. It also removes an asymmetry: an
         * inbound selection of the same rows lights the corridors too, because `keysMatching` matches
         * any key whose rows overlap, so one set of rows would otherwise produce two different pictures
         * depending on where the selection came from.
         *
         * It is one hop, no further: a lit band running into a dimmed node reads as a fault, and a
         * second hop would light most of a connected diagram.
         *
         * It is computed once per paint, not once per element: a hub touches a lot of corridors and
         * `registered` holds every drawn thing.
         *
         * Only a click covers its neighbourhood. An inbound highlight is someone else pointing at our
         * data at the grain they named; the host said which rows, and widening that would overstate it.
         */
        const revealed = clicked
            ? neighboursRevealedBy(this.selected, this.neighboursByNode)
            : undefined;
        this.registered.forEach(({ element, key, handle, dimKey, subBand }) => {
            // A click is answered at corridor grain, because that is what a click selected; an inbound
            // highlight is answered at the finest grain the element has, because the host told us which
            // rows.
            const against = !clicked && dimKey !== undefined ? dimKey : key;
            let lit = !dimming || scope.has(against) || revealed?.has(against) === true;
            /**
             * A partial highlight. While an inbound highlight is in force there are two clauses:
             *
             * - a sub-band is the in-scope portion itself, so it is lit;
             * - the stripe under one goes dim, so the portion reads against it rather than over an
             *   identical fill.
             *
             * A `dimKey` is what marks a stripe (a node, a label and the hit halo have none), and every
             * partly highlighted stripe gets a sub-band, so carrying its key is enough to know one is over
             * it. This assumes routing always provides `partialPath`, which it does; a hand-built
             * `RoutedBand` without one would be dimmed with nothing drawn over it.
             *
             * Everything else falls through to the plain rule: lit when any of its rows is in scope. A node
             * on a partly highlighted flow is therefore lit, which is what a reader wants, since the path
             * is what the other visual is pointing at.
             */
            if (dimming && !clicked && this.fractions && !handle) {
                const fraction = this.fractions.get(against) ?? 0;
                if (subBand) {
                    lit = true;
                } else if (dimKey !== undefined && fraction > 0 && fraction < 1) {
                    lit = false;
                }
            }
            if (handle) {
                // A route handle is hidden rather than dimmed: a faint dot over a corridor the author is not
                // working on is still clutter, and still in the way of the one they are. Its opacity is left
                // alone, so the two passes never argue about one attribute.
                //
                // `lit` already carries the neighbourhood, so a corridor touching the selected node shows its
                // handles over a band that is now lit rather than dimmed.
                element.setAttribute("visibility", lit ? "visible" : "hidden");
                return;
            }
            element.setAttribute("opacity", lit ? "1" : String(DIMMED_OPACITY));
        });
    }

    /** For the checks: what the controller currently considers selected. */
    public get selectedKeys(): ReadonlySet<SelectionKey> {
        return this.selected;
    }

    /**
     * For the checks: what an inbound highlight lights, or undefined when nothing is highlighted.
     * The distinction matters: an empty set means "highlighted, but nothing of ours matched", which
     * dims everything.
     */
    public get litKeys(): ReadonlySet<SelectionKey> | undefined {
        return this.lit;
    }
}
