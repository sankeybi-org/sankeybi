/**
 * The node editor: a list of every node, opened from the Nodes card's Edit nodes
 * switch, where the author sets a label, hides the name, imports an icon, picks a
 * colour, or picks the faces a node's flows use.
 *
 * It starts in the bottom-left corner, with the list scrolling past about fifteen rows,
 * and moves out of the way of what is under it: drag its title bar anywhere in the
 * visual (`PanelPlacement`, kept for the session, not saved). It follows the diagram:
 * the node clicked there opens here (`focusNode`). See nodeEdits.ts for what is stored
 * and which source wins.
 *
 * It is built with `createElement` and `textContent` only. The one thing the author
 * supplies that is shown as an image, the icon preview, is a data URL that
 * background.ts has already vetted and re-encoded.
 *
 * It never rebuilds under the author's hand. Every change is saved at once, and saving
 * triggers an update; rebuilding the list then would throw away focus mid-edit, and
 * rebuilding a row on a text box's blur would detach the checkbox the author was
 * clicking. So a change redraws only the parts of its own row that show the result, and
 * the whole list is rebuilt only when the nodes change, or the edits change from
 * outside (Reset node edits).
 */

import { Port, PORTS } from "./model";
import { t, tf } from "./i18n";
import { iconFromText, MAX_ICON_BYTES, tooBigMessage } from "./background";
import {
    iconBudgetUsed, MAX_EDIT_ICONS_TOTAL, MAX_EDIT_LABEL, NodeDataFacts, NodeEdit, NodeEdits,
    serialiseNodeEdits, withNodeEdit
} from "./nodeEdits";

/** Where the panel sits: its starting corner, or where the author dragged it. */
export type PanelPlacement = { kind: "bottom" } | { kind: "free"; x: number; y: number };

/** Gap between the panel and the visual's edges, px. */
const PANEL_INSET = 8;

/** What the list is drawn from, as one string: the panel rebuilds when this moves. */
function keyOfFacts(facts: NodeDataFacts[]): string {
    return JSON.stringify(facts.map(f => [f.id, f.label, f.icon ?? "", f.colour ?? ""]));
}

/**
 * A dragged position held inside the visual: the panel's top-left corner, so
 * that the whole panel stays within the container, inset by PANEL_INSET. A
 * panel bigger than the container is pinned to the top-left inset instead of
 * being pushed off the far side.
 */
export function clampPanel(
    x: number, y: number,
    panel: { width: number; height: number },
    container: { width: number; height: number }
): { x: number; y: number } {
    const clamp = (v: number, size: number, room: number) =>
        Math.max(PANEL_INSET, Math.min(v, room - size - PANEL_INSET));
    return { x: clamp(x, panel.width, container.width), y: clamp(y, panel.height, container.height) };
}

export class NodeEditorPanel {
    private panel: HTMLDivElement;
    private list: HTMLDivElement;
    private placement: PanelPlacement = { kind: "bottom" };
    private facts: NodeDataFacts[] = [];
    /** What "Default" means right now; see `setModel`. */
    private defaultPorts: { out: Port; in: Port } = { out: "East", in: "West" };
    private edits: NodeEdits = new Map();
    /** undefined while the panel is closed: nothing has been drawn to compare against. */
    private factsKey: string | undefined = "";
    private expanded = new Set<string>();
    private rows = new Map<string, HTMLDivElement>();
    constructor(
        private target: HTMLElement,
        private onChange: (edits: NodeEdits) => void
    ) {
        this.panel = document.createElement("div");
        this.panel.className = "sankeybi-bg-panel sankeybi-node-panel";
        this.panel.tabIndex = 0;
        this.panel.style.display = "none";

        const head = document.createElement("div");
        head.className = "sankeybi-node-head";
        const heading = document.createElement("div");
        heading.className = "sankeybi-bg-heading";
        heading.textContent = t("ui.nodes.title", "Nodes");
        const done = document.createElement("button");
        done.type = "button";
        done.textContent = t("ui.done", "Done");
        done.addEventListener("click", () => this.close());
        head.appendChild(heading);
        head.appendChild(done);
        this.panel.appendChild(head);
        this.makeDraggable(head);

        const help = document.createElement("p");
        help.textContent = t("ui.nodes.help", "Click a node in the diagram to open it here. Changes take priority over the data "
            + "and are saved as you make them; Reset node edits in the Nodes card clears them all.");
        this.panel.appendChild(help);

        this.list = document.createElement("div");
        this.list.className = "sankeybi-node-list";
        this.panel.appendChild(this.list);

        this.panel.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                this.close();
            }
        });
        target.appendChild(this.panel);
        this.place(this.placement);
    }

    /** Puts the panel where `placement` says. */
    private place(placement: PanelPlacement): void {
        this.placement = placement;
        const style = this.panel.style;
        style.left = `${PANEL_INSET}px`;
        if (placement.kind === "bottom") {
            style.top = "auto";
            style.bottom = `${PANEL_INSET}px`;
        } else {
            const at = clampPanel(placement.x, placement.y,
                { width: this.panel.offsetWidth, height: this.panel.offsetHeight },
                { width: this.target.clientWidth, height: this.target.clientHeight });
            this.placement = { kind: "free", x: at.x, y: at.y };
            style.left = `${at.x}px`;
            style.top = `${at.y}px`;
            style.bottom = "auto";
        }
    }

    /**
     * Dragging by the title bar. Pointer capture keeps the drag going when the
     * pointer outruns the bar; Done keeps its own click.
     */
    private makeDraggable(handle: HTMLElement): void {
        let start: { pointerX: number; pointerY: number; x: number; y: number } | undefined;
        handle.addEventListener("pointerdown", (event: PointerEvent) => {
            if ((event.target as HTMLElement | null)?.tagName === "BUTTON" || event.button !== 0) {
                return;
            }
            start = { pointerX: event.clientX, pointerY: event.clientY, x: this.panel.offsetLeft, y: this.panel.offsetTop };
            handle.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        handle.addEventListener("pointermove", (event: PointerEvent) => {
            if (start) {
                this.place({ kind: "free", x: start.x + event.clientX - start.pointerX, y: start.y + event.clientY - start.pointerY });
            }
        });
        const end = (event: PointerEvent) => {
            if (start && handle.hasPointerCapture(event.pointerId)) {
                handle.releasePointerCapture(event.pointerId);
            }
            start = undefined;
        };
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    }

    /** Edit mode only; leaving it closes an open panel. */
    public setAvailable(available: boolean): void {
        if (!available) {
            this.close();
        }
    }

    public isOpen(): boolean {
        return this.panel.style.display !== "none";
    }

    /**
     * What the data says about each node, and the stored edits. Rebuilds the list only where
     * it would otherwise be wrong: the nodes changed, or the edits differ from what this
     * panel last wrote.
     */
    /**
     * `defaultPorts` is the pair the Flow direction setting falls back to, so the "Default
     * (...)" option names the face that is actually used. A node port turns with the
     * diagram, so a fixed East and West would be wrong once the diagram reads vertically.
     */
    public setModel(facts: NodeDataFacts[], edits: NodeEdits, defaultPorts?: { out: Port; in: Port }): void {
        if (defaultPorts) {
            this.defaultPorts = defaultPorts;
        }
        // Closed: keep the model, do none of the comparing. This runs on every update, and the
        // comparison stringifies every node's facts, icons included, which are data URLs of up
        // to 20KB each. Nothing can be rebuilt while the panel is shut, and `open` redraws the
        // list from scratch anyway. The key is dropped rather than left stale, so the first
        // change after opening is measured against what `open` actually drew.
        if (!this.isOpen()) {
            this.facts = facts;
            this.edits = edits;
            this.factsKey = undefined;
            return;
        }
        const factsKey = keyOfFacts(facts);
        const outside = serialiseNodeEdits(edits) !== serialiseNodeEdits(this.edits);
        const changed = factsKey !== this.factsKey || outside;
        this.facts = facts;
        this.factsKey = factsKey;
        this.edits = edits;
        if (changed) {
            this.renderList();
        }
        // The visual may have been resized: a dragged panel is held inside it.
        if (this.isOpen() && this.placement.kind === "free") {
            this.place(this.placement);
        }
    }

    public open(): void {
        this.panel.style.display = "";
        this.renderList();
        // What is now on screen, so the next update measures against it.
        this.factsKey = keyOfFacts(this.facts);
        this.place(this.placement);
        this.panel.focus();
    }

    /**
     * Opens one node's settings (the node the author clicked in the diagram), closing the
     * others so the list stays short, and scrolls it into view. Nothing happens while the
     * panel is closed, or for an id not in the list.
     */
    public focusNode(id: string): void {
        const facts = this.facts.find(f => f.id === id);
        if (!this.isOpen() || !facts || (this.expanded.size === 1 && this.expanded.has(id))) {
            return;
        }
        const others = [...this.expanded].filter(other => other !== id);
        this.expanded = new Set([id]);
        others.forEach(other => {
            const was = this.facts.find(f => f.id === other);
            if (was) {
                this.renderRow(was);
            }
        });
        this.renderRow(facts);
        const row = this.rows.get(id);
        if (row && typeof row.scrollIntoView === "function") {
            row.scrollIntoView({ block: "nearest" });
        }
    }

    public close(): void {
        this.panel.style.display = "none";
    }

    private commit(id: string, patch: Partial<Record<keyof NodeEdit, unknown>>): void {
        this.edits = withNodeEdit(this.edits, id, patch);
        this.onChange(this.edits);
    }

    private renderList(): void {
        while (this.list.firstChild) {
            this.list.removeChild(this.list.firstChild);
        }
        this.rows.clear();
        const sorted = [...this.facts].sort((a, b) =>
            this.shownName(a).localeCompare(this.shownName(b), undefined, { sensitivity: "base" }));
        if (sorted.length === 0) {
            const empty = document.createElement("p");
            empty.textContent = t("ui.nodes.empty", "No nodes yet: add Source, Target and Value fields.");
            this.list.appendChild(empty);
        }
        sorted.forEach(facts => {
            const row = document.createElement("div");
            row.className = "sankeybi-node-row";
            this.rows.set(facts.id, row);
            this.list.appendChild(row);
            this.renderRow(facts);
        });
    }

    /** The name the node is drawn with: the edit, else the data, else its id. */
    private shownName(facts: NodeDataFacts): string {
        const label = this.edits.get(facts.id)?.label;
        return label !== undefined && label.trim() !== "" ? label : (facts.label || facts.id);
    }

    private renderRow(facts: NodeDataFacts): void {
        const row = this.rows.get(facts.id);
        if (!row) {
            return;
        }
        while (row.firstChild) {
            row.removeChild(row.firstChild);
        }
        const header = document.createElement("button");
        header.type = "button";
        header.className = "sankeybi-node-header";
        header.addEventListener("click", () => {
            if (this.expanded.has(facts.id)) {
                this.expanded.delete(facts.id);
            } else {
                this.expanded.add(facts.id);
            }
            this.renderRow(facts);
        });
        row.appendChild(header);
        this.renderHeader(facts, header);
        if (this.expanded.has(facts.id)) {
            row.appendChild(this.details(facts, header));
        }
    }

    private renderHeader(facts: NodeDataFacts, header: HTMLButtonElement): void {
        while (header.firstChild) {
            header.removeChild(header.firstChild);
        }
        const name = document.createElement("span");
        name.textContent = `${this.expanded.has(facts.id) ? "▾" : "▸"} ${this.shownName(facts)}`;
        header.appendChild(name);
        if (this.edits.has(facts.id)) {
            const tag = document.createElement("span");
            tag.className = "sankeybi-node-tag";
            tag.textContent = t("ui.nodes.edited", "edited");
            header.appendChild(tag);
        }
    }

    private field(labelText: string, control: HTMLElement, hint?: string): HTMLDivElement {
        const wrap = document.createElement("div");
        wrap.className = "sankeybi-node-field";
        const label = document.createElement("label");
        label.textContent = labelText;
        wrap.appendChild(label);
        wrap.appendChild(control);
        if (hint !== undefined) {
            const small = document.createElement("div");
            small.className = "sankeybi-node-hint";
            small.textContent = hint;
            wrap.appendChild(small);
        }
        return wrap;
    }

    private details(facts: NodeDataFacts, header: HTMLButtonElement): HTMLDivElement {
        const box = document.createElement("div");
        box.className = "sankeybi-node-details";
        const edit = (): NodeEdit => this.edits.get(facts.id) ?? {};
        const refreshHeader = () => this.renderHeader(facts, header);

        // Label. Saved on change (blur or Enter), never per keystroke.
        const label = document.createElement("input");
        label.type = "text";
        label.maxLength = MAX_EDIT_LABEL;
        label.value = edit().label ?? "";
        label.addEventListener("change", () => {
            const value = label.value.trim();
            this.commit(facts.id, { label: value === "" ? undefined : value });
            refreshHeader();
        });
        box.appendChild(this.field(t("ui.nodes.label", "Label"), label, facts.label === ""
            ? t("ui.nodes.labelHidden", "The data hides this name. Leave blank to follow the data.")
            : tf("ui.nodes.labelFromData", "From data: {0}. Leave blank to follow the data.", facts.label)));

        // Hide name. Stored only where it differs from the data.
        const hide = document.createElement("input");
        hide.type = "checkbox";
        const dataHides = facts.label === "";
        hide.checked = edit().hideName ?? dataHides;
        hide.addEventListener("change", () => {
            this.commit(facts.id, { hideName: hide.checked === dataHides ? undefined : hide.checked });
            refreshHeader();
        });
        box.appendChild(this.field(t("ui.nodes.hideName", "Hide name"), hide,
            t("ui.nodes.hideNameHint", "The total and the icon still show.")));

        // Icon.
        const iconBox = document.createElement("div");
        iconBox.className = "sankeybi-node-icon";
        box.appendChild(this.field(t("ui.nodes.icon", "Icon"), iconBox));
        this.renderIcon(facts, iconBox, refreshHeader);

        // Colour. Saved when the picker closes ("change"), not on every
        // step of a drag across it ("input").
        const colourBox = document.createElement("div");
        colourBox.className = "sankeybi-node-icon";
        box.appendChild(this.field(t("ui.nodes.colour", "Colour"), colourBox));
        this.renderColour(facts, colourBox, refreshHeader);

        // Ports: the data wins per flow, so these only fill the blanks.
        const portSelect = (current: Port | undefined, fallback: string, onPick: (port: Port | undefined) => void) => {
            const select = document.createElement("select");
            [["", tf("ui.nodes.portDefault", "Default ({0})", fallback)], ...PORTS.map(p => [p, p])].forEach(([value, text]) => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = text;
                select.appendChild(option);
            });
            select.value = current ?? "";
            select.addEventListener("change", () => {
                onPick(select.value === "" ? undefined : select.value as Port);
                refreshHeader();
            });
            return select;
        };
        box.appendChild(this.field(t("ui.nodes.outflows", "Outflows leave via"),
            portSelect(edit().outPort, this.defaultPorts.out,
                port => this.commit(facts.id, { outPort: port }))));
        box.appendChild(this.field(t("ui.nodes.inflows", "Inflows arrive via"),
            portSelect(edit().inPort, this.defaultPorts.in,
                port => this.commit(facts.id, { inPort: port })),
            t("ui.nodes.portsHint", "Applies to flows whose port isn't set in the data. A port set in the data for a particular flow always wins.")));

        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = t("ui.nodes.resetNode", "Reset this node");
        reset.addEventListener("click", () => {
            this.commit(facts.id, { label: undefined, hideName: undefined, icon: undefined, outPort: undefined, inPort: undefined, colour: undefined });
            this.renderRow(facts);
        });
        box.appendChild(reset);
        return box;
    }

    private renderColour(facts: NodeDataFacts, box: HTMLDivElement, refreshHeader: () => void): void {
        while (box.firstChild) {
            box.removeChild(box.firstChild);
        }
        const edited = this.edits.get(facts.id)?.colour;
        const picker = document.createElement("input");
        picker.type = "color";
        // A colour input only takes #rrggbb; a data colour given by name (or
        // none at all) starts the picker on the default grey.
        const start = edited ?? facts.colour;
        picker.value = start && /^#[0-9a-f]{6}$/i.test(start) ? start : "#605e5c";
        picker.addEventListener("change", () => {
            this.commit(facts.id, { colour: picker.value });
            this.renderColour(facts, box, refreshHeader);
            refreshHeader();
        });
        box.appendChild(picker);
        const status = document.createElement("span");
        status.textContent = edited !== undefined ? t("ui.nodes.colourEdited", "Edited")
            : facts.colour ? tf("ui.nodes.colourFromData", "From data: {0}", facts.colour)
                : t("ui.nodes.colourDefault", "Default (the theme's)");
        box.appendChild(status);
        if (edited !== undefined) {
            const back = document.createElement("button");
            back.type = "button";
            back.textContent = facts.colour ? t("ui.nodes.useDataColour", "Use data colour") : t("ui.nodes.useDefault", "Use default");
            back.addEventListener("click", () => {
                this.commit(facts.id, { colour: undefined });
                this.renderColour(facts, box, refreshHeader);
                refreshHeader();
            });
            box.appendChild(back);
        }
    }

    private renderIcon(facts: NodeDataFacts, box: HTMLDivElement, refreshHeader: () => void): void {
        while (box.firstChild) {
            box.removeChild(box.firstChild);
        }
        const edited = this.edits.get(facts.id)?.icon;
        const shown = edited !== undefined ? (edited === "" ? undefined : edited) : facts.icon;
        if (shown) {
            const preview = document.createElement("img");
            preview.className = "sankeybi-node-preview";
            preview.alt = "";
            preview.src = shown;
            box.appendChild(preview);
        }
        const status = document.createElement("span");
        status.textContent = edited !== undefined
            ? (edited === "" ? t("ui.nodes.iconHidden", "None (the data's icon is hidden)") : t("ui.nodes.iconImported", "Imported"))
            : (facts.icon ? t("ui.nodes.iconFromData", "From data") : t("ui.nodes.iconNone", "None"));
        box.appendChild(status);

        const error = document.createElement("div");
        error.className = "sankeybi-bg-error";
        const redraw = () => {
            this.renderIcon(facts, box, refreshHeader);
            refreshHeader();
        };

        const choose = document.createElement("label");
        choose.className = "sankeybi-node-button";
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".svg,image/svg+xml";
        input.style.display = "none";
        const take = (file: File | undefined) => {
            if (!file) {
                return;
            }
            if (file.size > MAX_ICON_BYTES) {
                error.textContent = tooBigMessage(file.size, MAX_ICON_BYTES);
                return;
            }
            file.text().then(text => {
                const result = iconFromText(text);
                if ("error" in result) {
                    error.textContent = result.error;
                    return;
                }
                const url = result.image.url;
                if (iconBudgetUsed(this.edits, facts.id) + url.length > MAX_EDIT_ICONS_TOTAL) {
                    error.textContent = t("ui.nodes.iconsLimit", "The imported icons together have reached their limit. Remove some, or use smaller SVGs.");
                    return;
                }
                this.commit(facts.id, { icon: url });
                redraw();
            }).catch(() => { error.textContent = t("ui.fileUnreadable", "That file couldn't be read."); });
        };
        input.addEventListener("change", () => {
            take(input.files?.[0]);
            input.value = "";
        });
        choose.appendChild(input);
        choose.appendChild(document.createTextNode(t("ui.nodes.chooseSvg", "Choose SVG…")));
        box.addEventListener("dragover", event => event.preventDefault());
        box.addEventListener("drop", event => {
            event.preventDefault();
            take(event.dataTransfer?.files?.[0]);
        });
        box.appendChild(choose);

        if (shown) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = t("ui.nodes.remove", "Remove");
            // Where the data has an icon, "remove" has to be stored, or the
            // data's would simply come back.
            remove.addEventListener("click", () => {
                this.commit(facts.id, { icon: facts.icon ? "" : undefined });
                redraw();
            });
            box.appendChild(remove);
        }
        if (edited !== undefined && facts.icon) {
            const back = document.createElement("button");
            back.type = "button";
            back.textContent = t("ui.nodes.useDataIcon", "Use data icon");
            back.addEventListener("click", () => {
                this.commit(facts.id, { icon: undefined });
                redraw();
            });
            box.appendChild(back);
        }
        box.appendChild(error);
    }
}
