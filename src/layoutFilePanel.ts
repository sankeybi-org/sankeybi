/**
 * The layout file's own panel.
 *
 * It is edit mode only: the Arrange card's Layout file switch opens it, as the
 * Background card's Import image opens its panel, and it writes itself back off.
 *
 * It holds no rules of its own: `read` hands back the layout as text, and `write` applies
 * a pasted one and returns an error message or undefined. `layoutFile.ts` serialises and
 * parses, and `visual.ts` persists, so a failure is reported in the panel; the author is
 * holding a paste that did not work, and a console line is no use to them.
 *
 * It is built with `createElement` and `textContent` only; the text is never parsed into
 * this DOM.
 */

import { t } from "./i18n";

export interface LayoutFileHost {
    read: () => string;
    write: (text: string) => string | undefined;
}

export class LayoutFilePanel {
    private panel: HTMLDivElement;
    private text: HTMLTextAreaElement;
    private error: HTMLDivElement;

    constructor(target: HTMLElement, private file: LayoutFileHost) {
        this.panel = document.createElement("div");
        this.panel.className = "sankeybi-bg-panel";
        this.panel.tabIndex = 0;
        this.panel.style.display = "none";

        const head = document.createElement("div");
        head.className = "sankeybi-node-head";
        head.style.cursor = "default";
        const heading = document.createElement("div");
        heading.className = "sankeybi-bg-heading";
        heading.textContent = t("ui.layout.title", "Layout file");
        const done = document.createElement("button");
        done.type = "button";
        done.textContent = t("ui.done", "Done");
        done.addEventListener("click", () => this.close());
        head.appendChild(heading);
        head.appendChild(done);
        this.panel.appendChild(head);

        const hint = document.createElement("p");
        hint.textContent = t("ui.layout.hint", "Every hand-placed node, route handle, locked grid and node edit, as text. "
            + "Copy it to keep a backup or to move this layout to another report; paste one in and "
            + "press Apply to restore it. The background picture is not included.");
        this.panel.appendChild(hint);

        this.text = document.createElement("textarea");
        this.text.rows = 8;
        this.text.spellcheck = false;
        this.text.style.width = "100%";
        this.text.style.boxSizing = "border-box";
        this.text.style.fontFamily = "monospace";
        this.panel.appendChild(this.text);

        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "sankeybi-node-button";
        apply.textContent = t("ui.layout.apply", "Apply");
        apply.addEventListener("click", () => this.apply());
        this.panel.appendChild(apply);

        this.error = document.createElement("div");
        this.error.className = "sankeybi-bg-error";
        this.panel.appendChild(this.error);

        this.panel.addEventListener("keydown", event => {
            // A textarea owns Escape no more than any text box does, and a panel that cannot be
            // closed from the keyboard is a trap.
            if (event.key === "Escape") {
                this.close();
            }
        });
        target.appendChild(this.panel);
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

    /** Fills the box with the layout as it stands now, and shows the panel. */
    public open(): void {
        this.text.value = this.file.read();
        this.error.textContent = "";
        this.panel.style.display = "";
        this.panel.focus();
    }

    public close(): void {
        this.panel.style.display = "none";
    }

    /** Applies whatever is in the box. */
    private apply(): void {
        this.error.textContent = this.file.write(this.text.value) ?? "";
    }
}
