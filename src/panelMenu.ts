/**
 * A dropdown whose list is an element the visual owns.
 *
 * A native `<select>`'s list is not part of the page: the browser draws it as its
 * own popup and positions it from where it believes the element is on screen. A
 * Power BI custom visual lives in a sandboxed frame inside a report canvas that the
 * host scrolls, scales and transforms, and the popup can land nowhere near the box
 * that opened it. Nothing can be fixed from inside the page, because the thing in
 * the wrong place is not in the page.
 *
 * So the list is a `<div>` placed by the visual against the button's own rectangle.
 *
 * It is appended to the visual's root, not to the row. The editor's row list is
 * `overflow: auto`, and an absolutely positioned child of a scrolling box is
 * clipped by it. The root clips nothing, so the list is placed in the root's
 * coordinates and `clampPanel` keeps it inside the visual, which is the rule the
 * panels themselves are placed by.
 *
 * Only one menu is open at a time, module-wide: opening a second closes the first,
 * as a native popup would.
 *
 * This is deliberately not a general widget. It has no roles, arrow-key handling or
 * focus styling; a `<button>` is already focusable and operable by Enter. What it
 * adds over a `<select>` is a list that is where it should be.
 */

import { clampPanel } from "./nodeEditorPanel";

/**
 * One row of a menu. `value` is what `onPick` receives.
 *
 * `short` is what the button says when this row is the current one, where the row's
 * own label would be too long for it. The detail belongs in the menu, where the
 * choice is made and there is room; the button is one column of a row and has to
 * stay a fixed width, or the rows come out ragged.
 */
export interface MenuItem {
    value: string;
    label: string;
    short?: string;
}

/** Closes whatever menu is open, so only one ever is. */
let dismiss: (() => void) | undefined;

/** Shuts any open menu. Called when a panel closes or its list scrolls. */
export function closePanelMenus(): void {
    dismiss?.();
}

export interface PanelMenuOptions {
    /** Where the list is appended: the visual's root, which clips nothing. */
    root: HTMLElement;
    /** Extra class on the button, for width and font. */
    className?: string;
    /** The button's `title`, as the `<select>`'s was. */
    title?: string;
    items: readonly MenuItem[];
    /** Which item is current; an unknown value shows the first item's label. */
    value: string;
    onPick: (value: string) => void;
}

/**
 * The button that opens a menu. The list is built on open and thrown away on
 * close, so a rebuilt row cannot leave one behind.
 */
export function panelMenu(options: PanelMenuOptions): HTMLButtonElement {
    const { root, items, onPick } = options;
    const button = document.createElement("button");
    button.type = "button";
    button.className = ["sankeybi-menu-button", options.className ?? ""].join(" ").trim();
    if (options.title !== undefined) {
        button.title = options.title;
    }

    const caption = document.createElement("span");
    caption.className = "sankeybi-menu-caption";
    const current = items.find(i => i.value === options.value) ?? items[0];
    // `textContent`, never `innerHTML`: a label can carry a flow type's own name.
    caption.textContent = current?.short ?? current?.label ?? "";
    button.appendChild(caption);
    const chevron = document.createElement("span");
    chevron.className = "sankeybi-menu-chevron";
    chevron.textContent = "▾";
    button.appendChild(chevron);

    let list: HTMLDivElement | undefined;

    const close = (): void => {
        if (list) {
            list.remove();
            list = undefined;
        }
        if (dismiss === close) {
            dismiss = undefined;
        }
        document.removeEventListener("pointerdown", onOutside, true);
    };

    /**
     * Capturing, so a click anywhere closes the menu before that click does whatever
     * else it does: a pointerdown on another row's button has to find this menu
     * already gone, or two would be open at once.
     */
    function onOutside(event: Event): void {
        const at = event.target as Node | null;
        if (list && at && (list.contains(at) || button.contains(at))) {
            return;
        }
        close();
    }

    const open = (): void => {
        closePanelMenus();
        list = document.createElement("div");
        list.className = "sankeybi-menu-list";
        items.forEach(item => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "sankeybi-menu-item";
            row.textContent = item.label;
            if (item.value === options.value) {
                // An attribute rather than a class, so the stylesheet can say "the current one" in
                // one selector.
                row.setAttribute("aria-checked", "true");
            }
            row.addEventListener("click", () => {
                close();
                onPick(item.value);
            });
            list?.appendChild(row);
        });
        root.appendChild(list);

        // Measured after appending, because a menu's size is its content's; the panels
        // are placed in the same order.
        const b = button.getBoundingClientRect();
        const r = root.getBoundingClientRect();
        const size = { width: list.offsetWidth, height: list.offsetHeight };
        // Below the button, or above it where below would not fit. A row near the bottom
        // of the visual is the common case, and clamping alone would slide the list up over
        // the button that opened it.
        const below = b.bottom - r.top + 2;
        const above = b.top - r.top - size.height - 2;
        const room = { width: root.clientWidth, height: root.clientHeight };
        const wanted = below + size.height <= room.height || above < 0 ? below : above;
        const at = clampPanel(b.left - r.left, wanted, size, room);
        list.style.left = `${at.x}px`;
        list.style.top = `${at.y}px`;

        dismiss = close;
        document.addEventListener("pointerdown", onOutside, true);
    };

    button.addEventListener("click", () => {
        if (list) {
            close();
        } else {
            open();
        }
    });
    // Escape closes the MENU and stops there: the panel's own Escape handler
    // would otherwise close the whole editor, which is not what a reader who
    // has just opened a list by mistake is asking for.
    button.addEventListener("keydown", event => {
        if (event.key === "Escape" && list) {
            event.stopPropagation();
            close();
        }
    });
    return button;
}
