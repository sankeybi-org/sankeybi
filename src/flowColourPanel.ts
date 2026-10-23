/**
 * The flow type colour panel: a colour, name, texture and outline per flow type, chosen
 * in the visual rather than in the data.
 *
 * It is in the visual and not the format pane for the reason the node editor is: there
 * is no data identity at the grain of one flow type to hang a per-value format object
 * off (see flowTypeColours.ts). It opens from a button on the Flows card, starts
 * bottom-left, is dragged by its title bar and is edit mode only, exactly as the node
 * editor is.
 *
 * It is built with `createElement` and `textContent` only. Flow type names come from
 * the author's data and are never parsed into this DOM.
 */

import { FLOW_PATTERN_NONE, FlowTypeEdits } from "./flowTypeColours";
import { TEXTURE_COUNT, TEXTURE_NAMES, tileDataUri } from "./textures";
import { clampPanel, PanelPlacement } from "./nodeEditorPanel";
import { closePanelMenus, MenuItem, panelMenu } from "./panelMenu";
import { t, tf } from "./i18n";

/** Gap between the panel and the visual's edges, in pixels. Matches the node editor's. */
const PANEL_INSET = 8;

/**
 * One row of the panel: a flow type, the colour actually being drawn for it, and where
 * that colour came from.
 *
 * `drawn` is the resolved colour: the panel's own pick if there is one, else the data's
 * `FlowColour`, else the palette's automatic choice. It prefills the picker, so a row
 * always opens on the colour on screen rather than on a default nobody chose.
 * `fromData` is what the data says, kept separately so the row can say where the colour
 * came from and offer to go back to it.
 *
 * The texture and the outline are what is stored, not what is drawn, which is the
 * opposite of `drawn` and deliberate. Since the pane can ask for a texture or an outline
 * on every type, "nothing stored" is a real third state that the control has to be able
 * to show (`Auto`), and a row prefilled from the resolved value could never offer it:
 * the author would open the editor and find every type apparently set by hand.
 */
export interface FlowTypeRow {
    type: string;
    drawn: string;
    fromData?: string;
    /** What the legend and the tooltips call it now -- the label, or its name. */
    shownAs: string;
    /**
     * The texture stored for this type: an index, or `FLOW_PATTERN_NONE` for flat by
     * choice. Absent means Auto, which follows the pane.
     */
    pattern?: number;
    /** The outline stored for this type. Absent means Auto. */
    outline?: "solid" | "dashed" | "none";
    /** Whether this type is drawn with a texture now, whether chosen here or by the pane. */
    textured?: boolean;
    /** Which texture it is drawn with, for the preview. */
    textureIndex?: number;
    /** The texture colour and the colour behind it stored for this type. Absent means Auto. */
    ink?: string;
    paper?: string;
    /** What is drawn now, so each picker opens on what is on screen. */
    inkDrawn?: string;
    paperDrawn?: string;
    /** What Auto currently gives it, so the Auto row can say so. */
    autoPattern?: number;
    autoOutline?: "solid" | "dashed";
}

/**
 * What a row may change. `null` clears a field, which means "follow the pane again" for
 * the texture and the outline and "follow the data again" for the colour and the label.
 * `"none"` and `FLOW_PATTERN_NONE` are the opposite: off, and stored, so a pane default
 * cannot fill them back in.
 */
export interface FlowTypePatch {
    colour?: string | null;
    label?: string | null;
    pattern?: number | null;
    ink?: string | null;
    paper?: string | null;
    outline?: "solid" | "dashed" | "none" | null;
}

/**
 * What each texture is called in the picker, in `hatchPatterns`' own order. Words rather
 * than a number, because "3" says nothing about what it draws; the names are the shapes,
 * not an aesthetic ("Cross", not "Mesh"), so an author choosing one for "projected" can
 * predict what appears.
 */
const patternName = (index: number): string => t(`texture.${TEXTURE_NAMES[index]}`, TEXTURE_NAMES[index]);

/**
 * What `Auto` currently amounts to, said in the menu itself. A bare "Auto" leaves the
 * author to look at the pane to find out what it means, and the answer differs per row
 * for the texture, since the allocation is by legend rank. Both read what `colours.ts`
 * resolved, so the label and the diagram cannot disagree.
 */
function textureName(index: number | undefined): string {
    return index === undefined ? t("ui.flowColours.flat", "flat")
        : TEXTURE_NAMES[index] !== undefined ? patternName(index) : tf("ui.flowColours.textureN", "texture {0}", index + 1);
}

function outlineName(style: "solid" | "dashed" | undefined): string {
    return style === undefined ? t("ui.flowColours.noEdgeLower", "no edge")
        : style === "solid" ? t("ui.flowColours.solidLower", "solid") : t("ui.flowColours.dashedLower", "dashed");
}

export class FlowColourPanel {
    private panel: HTMLDivElement;
    private list: HTMLDivElement;
    private placement: PanelPlacement = { kind: "bottom" };
    private rows: FlowTypeRow[] = [];
    private overrides: FlowTypeEdits = new Map();
    /**
     * What the list was last drawn from. `undefined` while the panel is closed, because
     * `open` redraws from scratch anyway, and a stale key would make the first change after
     * opening compare against something no longer on screen. The node editor's `factsKey`
     * works the same way.
     */
    private drawnKey: string | undefined;

    constructor(
        private target: HTMLElement,
        /** Writes one type's edits; `null` for a field clears it back to the data's. */
        private onChange: (type: string, patch: FlowTypePatch) => void
    ) {
        this.panel = document.createElement("div");
        this.panel.className = "sankeybi-bg-panel sankeybi-flowcolour-panel";
        this.panel.tabIndex = 0;
        this.panel.style.display = "none";
        this.panel.style.position = "absolute";

        const bar = document.createElement("div");
        bar.className = "sankeybi-bg-heading";
        const title = document.createElement("span");
        title.textContent = t("ui.flowColours.title", "Flow type colours");
        bar.appendChild(title);
        const done = document.createElement("button");
        done.type = "button";
        done.textContent = t("ui.done", "Done");
        done.addEventListener("click", () => this.close());
        bar.appendChild(done);
        this.panel.appendChild(bar);
        this.makeDraggable(bar);

        const help = document.createElement("p");
        help.textContent = t("ui.flowColours.help", "A colour chosen here beats a Flow colour from the data, "
            + "which beats the automatic palette. The legend follows whatever is drawn.");
        this.panel.appendChild(help);

        // Column titles. The two menus carry only "Auto", "Flat" or "Dashed", which says
        // nothing about what is being chosen; the titles sit over them in the same fixed widths
        // the row uses (`style/visual.less`).
        const heads = document.createElement("div");
        heads.className = "sankeybi-flowcolour-heads";
        [["colour", ""], ["preview", t("ui.flowColours.headPreview", "Preview")],
            ["name", t("ui.flowColours.headFlowType", "Flow type")],
            ["pattern", t("ui.flowColours.headTexture", "Texture")],
            ["texcolours", t("ui.flowColours.headInk", "Ink / back")],
            ["pattern", t("ui.flowColours.headBorder", "Border")], ["reset", ""]].forEach(([kind, text]) => {
            const cell = document.createElement("span");
            cell.className = `sankeybi-flowcolour-head-${kind}`;
            cell.textContent = text;
            heads.appendChild(cell);
        });
        this.panel.appendChild(heads);

        this.list = document.createElement("div");
        this.list.className = "sankeybi-flowcolour-list";
        // A menu is placed against its button's rectangle and lives in the visual's root, so
        // scrolling the rows under it would leave it behind, pointing at a row that has moved.
        // Closing is the honest answer; a native popup does the same.
        this.list.addEventListener("scroll", () => closePanelMenus());
        this.panel.appendChild(this.list);

        this.panel.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                this.close();
            }
        });
        target.appendChild(this.panel);
        this.place(this.placement);
    }

    /**
     * The flow types and their resolved colours, handed over on every update.
     *
     * While the panel is closed this keeps the model and returns, as the node editor's
     * `setModel` does: `open` redraws from scratch, and doing the work on every update
     * meant stringifying the whole list for nothing.
     *
     * While it is open the list is rebuilt only when what it is drawn from moves. Every
     * change here saves at once, the save brings an update round, and rebuilding then would
     * take the picker out from under the pointer.
     */
    public setModel(rows: FlowTypeRow[], overrides: FlowTypeEdits): void {
        this.rows = rows;
        this.overrides = overrides;
        if (this.panel.style.display === "none") {
            this.drawnKey = undefined;
            return;
        }
        const key = this.keyOf(rows, overrides);
        if (key !== this.drawnKey) {
            this.build();
        }
    }

    /** Edit mode only; leaving it closes an open panel. */
    public setAvailable(available: boolean): void {
        if (!available) {
            this.close();
        }
    }

    public open(): void {
        this.panel.style.display = "";
        this.build();
        this.place(this.placement);
        this.panel.focus();
    }

    public close(): void {
        closePanelMenus();
        this.panel.style.display = "none";
        this.drawnKey = undefined;
    }

    /** What the list is drawn from, as one string. */
    private keyOf(rows: FlowTypeRow[], overrides: FlowTypeEdits): string {
        return JSON.stringify(rows.map(r => [
            r.type, r.drawn, r.fromData ?? "", r.shownAs,
            overrides.get(r.type)?.colour ?? "", overrides.get(r.type)?.label ?? "",
            // The stored pair drives the controls and the auto pair their labels, so a pane change
            // has to rebuild the list too. Without the auto fields here, turning Texture on would
            // leave every row still saying "Auto (flat)".
            r.pattern ?? "", r.outline ?? "",
            r.autoPattern ?? "", r.autoOutline ?? "",
            // The texture colours too: a stored one decides whether Reset shows, and the drawn pair
            // is what each picker opens on.
            r.textured ? 1 : 0, r.textureIndex ?? "", r.ink ?? "", r.paper ?? "", r.inkDrawn ?? "", r.paperDrawn ?? ""
        ]));
    }

    private build(): void {
        while (this.list.firstChild) {
            this.list.removeChild(this.list.firstChild);
        }
        this.drawnKey = this.keyOf(this.rows, this.overrides);
        if (this.rows.length === 0) {
            const empty = document.createElement("p");
            empty.textContent = t("ui.flowColours.empty", "No flow types. Bind a field to Flow type to colour flows by category.");
            this.list.appendChild(empty);
            return;
        }
        // Legend order, because that is the order the author sees everywhere else: the legend
        // itself, a corridor's tooltip and the high-contrast hatches all follow it.
        this.rows.forEach(row => this.list.appendChild(this.buildRow(row)));
    }

    private buildRow(row: FlowTypeRow): HTMLDivElement {
        const el = document.createElement("div");
        el.className = "sankeybi-flowcolour-row";

        // The picker is the control. A native `<input type="color">` can say any colour, where
        // the theme swatches that were tried offered only the colours the diagram already had.
        //
        // It takes only #rrggbb, so a data colour given by name, or a palette colour in any
        // other notation, starts it on a neutral grey rather than being silently rewritten. The
        // node editor's colour row makes the same choice.
        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = /^#[0-9a-f]{6}$/i.test(row.drawn) ? row.drawn.toLowerCase() : "#605e5c";
        // Where the colour came from, said here now that the row has no status text: Reset appearing
        // already says that something is chosen.
        picker.title = this.overrides.get(row.type)?.colour !== undefined ? t("ui.flowColours.colourChosen", "Colour chosen here")
            : row.fromData ? tf("ui.flowColours.colourFromData", "Colour from the data: {0}", row.fromData)
                : t("ui.flowColours.colourAuto", "Automatic colour from the palette");
        picker.addEventListener("change", () => this.onChange(row.type, { colour: picker.value }));
        el.appendChild(picker);

        // A preview of the flow as it is drawn now: its colour, or its texture in the ink and paper
        // chosen. It follows every edit, because each one rebuilds the row.
        const preview = document.createElement("span");
        preview.className = "sankeybi-flowcolour-preview";
        preview.setAttribute("aria-hidden", "true");
        if (row.textured && row.textureIndex !== undefined && row.inkDrawn !== undefined
            && row.paperDrawn !== undefined) {
            preview.style.backgroundImage = `url("${tileDataUri(row.textureIndex, row.inkDrawn, row.paperDrawn)}")`;
        } else {
            preview.style.backgroundColor = row.drawn;
        }
        el.appendChild(preview);

        // The name is editable. A flow type is a category value, so it is whatever the model
        // calls it, often a code ("BIO_SOLID") where the legend wants words. The box holds what
        // is shown, so it opens on the label if there is one and on the type's own name if not;
        // emptying it goes back to the name rather than storing a copy of it, which is the rule
        // the colour follows too.
        //
        // The box commits on `change`, not `input`: every edit here persists, and persisting per
        // keystroke would bring an update round mid-word and take the box out from under the
        // author. The node editor's text fields commit the same way.
        const name = document.createElement("input");
        name.type = "text";
        name.className = "sankeybi-flowcolour-name";
        name.value = row.shownAs;
        name.title = row.shownAs === row.type
            ? row.type
            : tf("ui.flowColours.nameTitle", "{0} (flow type \"{1}\")", row.shownAs, row.type);
        name.addEventListener("change", () => this.onChange(row.type, { label: name.value }));
        el.appendChild(name);

        // The texture, compact so a row stays one line. `Auto` follows the pane's own Texture
        // setting; `Flat` holds this one type flat whatever the pane asks for, which is why the
        // stored value has a third state (`FLOW_PATTERN_NONE`).
        //
        // It is a `panelMenu`, not a `<select>`: a native list is drawn by the browser against
        // where it thinks the box is on screen, and inside a report canvas that the host scrolls
        // and scales it can land nowhere near the row.
        const patternItems: MenuItem[] = [
            // The button says "Auto"; the menu says what Auto amounts to here, which differs per row
            // because the allocation is by legend rank.
            { value: "auto", label: tf("ui.flowColours.autoOf", "Auto ({0})", textureName(row.autoPattern)),
                short: t("ui.flowColours.auto", "Auto") },
            { value: "none", label: t("ui.flowColours.flatMenu", "Flat") }
        ];
        for (let i = 0; i < TEXTURE_COUNT; i++) {
            patternItems.push({ value: String(i), label: patternName(i) });
        }
        el.appendChild(panelMenu({
            root: this.target,
            className: "sankeybi-flowcolour-pattern",
            title: tf("ui.flowColours.textureTitle", "Fill this flow type with a texture instead of a flat colour."
                + " Auto follows the Flow type textures setting on the Flows card, which gives"
                + " this type {0}.", textureName(row.autoPattern)),
            items: patternItems,
            value: row.pattern === undefined ? "auto"
                : row.pattern === FLOW_PATTERN_NONE ? "none" : String(row.pattern),
            onPick: value => this.onChange(row.type, {
                pattern: value === "auto" ? null
                    : value === "none" ? FLOW_PATTERN_NONE : Number(value)
            })
        }));

        // The texture's ink and the colour behind it, shown for a type that has a texture and laid out
        // (but hidden) for one that does not, so the columns after them stay in the same place. Each
        // opens on what is drawn; choosing one stores it for this type, beating the Flows card, and
        // double-clicking a picker hands that colour back to the card.
        const colours = document.createElement("span");
        colours.className = "sankeybi-flowcolour-texcolours";
        colours.style.visibility = row.textured ? "visible" : "hidden";
        const texturePicker = (
            kind: "ink" | "paper", drawn: string | undefined, stored: string | undefined, title: string
        ): HTMLInputElement => {
            const input = document.createElement("input");
            input.type = "color";
            input.value = drawn !== undefined && /^#[0-9a-f]{6}$/i.test(drawn) ? drawn.toLowerCase() : "#605e5c";
            input.title = title + (stored !== undefined
                ? t("ui.flowColours.textureSet", " (chosen here; double-click to follow the Flows card)")
                : t("ui.flowColours.textureFromCard", " (from the Flows card; choose a colour to override it for this type)"));
            if (stored !== undefined) {
                input.className = "sankeybi-flowcolour-set";
            }
            input.addEventListener("change", () => this.onChange(row.type,
                kind === "ink" ? { ink: input.value } : { paper: input.value }));
            input.addEventListener("dblclick", () => this.onChange(row.type,
                kind === "ink" ? { ink: null } : { paper: null }));
            return input;
        };
        colours.appendChild(texturePicker("ink", row.inkDrawn, row.ink, t("ui.flowColours.inkTitle", "Texture colour")));
        colours.appendChild(texturePicker("paper", row.paperDrawn, row.paper, t("ui.flowColours.paperTitle", "Colour behind the texture")));
        el.appendChild(colours);

        // The outline, for a flow that is projected or estimated. It is narrow, like the texture:
        // the name should take the room.
        el.appendChild(panelMenu({
            root: this.target,
            className: "sankeybi-flowcolour-pattern",
            title: tf("ui.flowColours.borderTitle", "Draw a border on this flow type's edges -- dashed reads as projected."
                + " Auto follows the Flows card's setting, which is {0}.", outlineName(row.autoOutline)),
            items: [
                { value: "auto", label: tf("ui.flowColours.autoOf", "Auto ({0})", outlineName(row.autoOutline)),
                    short: t("ui.flowColours.auto", "Auto") },
                { value: "none", label: t("ui.flowColours.noEdge", "No edge") },
                { value: "solid", label: t("ui.flowColours.solid", "Solid") },
                { value: "dashed", label: t("ui.flowColours.dashed", "Dashed") }
            ],
            value: row.outline ?? "auto",
            onPick: value => this.onChange(row.type, {
                outline: value === "auto"
                    ? null
                    : value as "solid" | "dashed" | "none"
            })
        }));

        const chosen = this.overrides.get(row.type);
        const back = document.createElement("button");
        back.type = "button";
        back.className = "sankeybi-flowcolour-reset";
        back.textContent = t("ui.flowColours.reset", "Reset");

        // Offered only where there is something to go back to, and it removes the stored values
        // rather than writing the current ones into them: a measure-bound Flow colour would
        // otherwise be frozen at whatever it happened to be when the panel was open, and a
        // texture at whatever the pane was asking for that day.
        //
        // It clears every field (colour, name, texture, texture colours, outline). With nothing left the entry
        // is dropped (`withFlowTypeEdit`), so the type follows the data and the Flows card again.
        //
        // The button is always there and hidden when there is nothing to reset, so the texture
        // and border columns sit in the same place on every row and under their titles.
        back.style.visibility = chosen !== undefined ? "visible" : "hidden";
        {
            back.title = row.fromData
                ? t("ui.flowColours.resetFromData", "Clear everything chosen here for this flow type: its colour and name"
                    + " go back to the data's, and its texture and border to the Flows card's.")
                : t("ui.flowColours.resetAuto", "Clear everything chosen here for this flow type: its colour goes back to"
                    + " the automatic palette, its name to the type's own, and its texture"
                    + " and border to the Flows card's.");
            back.addEventListener("click", () => this.onChange(row.type,
                { colour: null, label: null, pattern: null, ink: null, paper: null, outline: null }));
            el.appendChild(back);
        }
        return el;
    }

    /** Puts the panel where `placement` says. Mirrors the node editor's. */
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

    /** Dragging by the title bar, with pointer capture, as the node editor does. */
    private makeDraggable(handle: HTMLElement): void {
        let start: { pointerX: number; pointerY: number; x: number; y: number } | undefined;
        handle.addEventListener("pointerdown", (event: PointerEvent) => {
            if ((event.target as HTMLElement | null)?.tagName === "BUTTON" || event.button !== 0) {
                return;
            }
            start = {
                pointerX: event.clientX, pointerY: event.clientY,
                x: this.panel.offsetLeft, y: this.panel.offsetTop
            };
            handle.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        handle.addEventListener("pointermove", (event: PointerEvent) => {
            if (start) {
                this.place({
                    kind: "free",
                    x: start.x + event.clientX - start.pointerX,
                    y: start.y + event.clientY - start.pointerY
                });
            }
        });
        const end = (event: PointerEvent): void => {
            if (start && handle.hasPointerCapture(event.pointerId)) {
                handle.releasePointerCapture(event.pointerId);
            }
            start = undefined;
        };
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    }
}
