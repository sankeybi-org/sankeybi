/**
 * The visual's own import panel for a background picture (see background.ts for why it
 * cannot live in the format pane).
 *
 * It is edit mode only: the Background card's Import image switch opens a panel that
 * takes a picked file, a dropped file, or SVG text pasted with Ctrl+V. The switch cannot
 * open the file dialog directly, because a browser only opens one on a click inside the
 * visual's own frame, so the panel's "Choose a file" is that click.
 *
 * It is built with `createElement` and `textContent` only. Nothing the author supplies is
 * parsed into this DOM; the file is read as bytes and handed to background.ts, which turns
 * it into a data URL.
 */

import {
    backgroundFromBytes, backgroundFromSvgText, BackgroundImage, formatBytes, ImportResult,
    MAX_BACKGROUND_BYTES, tooBigMessage
} from "./background";
import { t, tf } from "./i18n";

export class BackgroundPanel {
    private panel: HTMLDivElement;
    private error: HTMLParagraphElement;
    private input: HTMLInputElement;

    constructor(target: HTMLElement, private onImport: (image: BackgroundImage) => void) {
        this.panel = document.createElement("div");
        this.panel.className = "sankeybi-bg-panel";
        this.panel.tabIndex = 0;
        this.panel.style.display = "none";

        const heading = document.createElement("div");
        heading.className = "sankeybi-bg-heading";
        heading.textContent = t("ui.background.title", "Background image");
        this.panel.appendChild(heading);

        const help = document.createElement("p");
        help.textContent = tf("ui.background.help", "Choose or drop an SVG, PNG or JPEG file up to {0}, "
            + "or click here and paste SVG text with Ctrl+V. A simplified map (mapshaper.org, for example) keeps the report small. "
            + "While a picture is set, the grid is locked so nodes stay where you put them on it.",
            formatBytes(MAX_BACKGROUND_BYTES));
        this.panel.appendChild(help);

        const drop = document.createElement("label");
        drop.className = "sankeybi-bg-drop";
        this.input = document.createElement("input");
        this.input.type = "file";
        this.input.accept = ".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg";
        this.input.addEventListener("change", () => {
            const file = this.input.files?.[0];
            if (file) {
                this.readFile(file);
            }
            this.input.value = "";
        });
        const dropText = document.createElement("span");
        dropText.textContent = t("ui.background.drop", "Choose a file, or drop one here");
        drop.appendChild(this.input);
        drop.appendChild(dropText);
        drop.addEventListener("dragover", event => {
            event.preventDefault();
            drop.classList.add("sankeybi-bg-over");
        });
        drop.addEventListener("dragleave", () => drop.classList.remove("sankeybi-bg-over"));
        drop.addEventListener("drop", event => {
            event.preventDefault();
            drop.classList.remove("sankeybi-bg-over");
            const file = event.dataTransfer?.files?.[0];
            if (file) {
                this.readFile(file);
            }
        });
        this.panel.appendChild(drop);

        this.error = document.createElement("p");
        this.error.className = "sankeybi-bg-error";
        this.panel.appendChild(this.error);

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = t("ui.cancel", "Cancel");
        cancel.addEventListener("click", () => this.close());
        this.panel.appendChild(cancel);

        this.panel.addEventListener("paste", event => {
            const data = event.clipboardData;
            if (!data) {
                return;
            }
            event.preventDefault();
            const file = data.files?.[0];
            if (file) {
                this.readFile(file);
                return;
            }
            this.finish(backgroundFromSvgText(data.getData("text/plain")));
        });
        this.panel.addEventListener("keydown", event => {
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

    public open(): void {
        this.error.textContent = "";
        this.panel.style.display = "";
        this.panel.focus();
    }

    private close(): void {
        this.panel.style.display = "none";
    }

    private readFile(file: File): void {
        // Refused before reading: there is no point pulling a huge file into memory to say no.
        if (file.size > MAX_BACKGROUND_BYTES) {
            this.finish({ error: tooBigMessage(file.size) });
            return;
        }
        file.arrayBuffer()
            .then(buffer => this.finish(backgroundFromBytes(new Uint8Array(buffer), file.name)))
            .catch(() => this.finish({ error: t("ui.fileUnreadable", "That file couldn't be read.") }));
    }

    private finish(result: ImportResult): void {
        if ("error" in result) {
            this.error.textContent = result.error;
            return;
        }
        this.close();
        this.onImport(result.image);
    }
}
