/**
 * A group's header switch that is derived from the settings under it.
 *
 * The settings underneath stay the ones that say what is drawn; the switch only
 * ever writes. It reads as the state of what it summarises, and drives that state
 * when the author flips it. It cannot be a pure function of the stored values,
 * because "the last child just went off" and "the header was just flipped on" are
 * stored identically (children off, header on). What tells them apart is the
 * header's last consistent value, which the caller holds in memory:
 *
 * - consistent (the header equals the derived state): nothing to write, remember it;
 * - inconsistent and the header is what it was last time: a child moved, so the
 *   header follows;
 * - inconsistent and the header moved: the author flipped it, so the children
 *   follow.
 *
 * `last` only advances when consistent, so an update that arrives before a persist
 * has landed repeats the same idempotent write rather than undoing it. Pure.
 */

/** What a reconciliation asks the caller to do. */
export type HeaderSwitchAction = "none" | "followChildren" | "driveChildren";

export interface HeaderSwitchResult {
    /** The header value to remember; carry it into the next call as `last`. */
    last: boolean | undefined;
    action: HeaderSwitchAction;
}

function reconcileHeaderSwitch(
    last: boolean | undefined,
    show: boolean,
    derived: boolean
): HeaderSwitchResult {
    if (show === derived) {
        return { last: show, action: "none" };
    }
    if (last === undefined || show === last) {
        return { last, action: "followChildren" };
    }
    return { last, action: "driveChildren" };
}

// Arrows: the header is on when heads or tails is.

export interface ArrowSwitchState {
    show: boolean;
    heads: boolean;
    tails: boolean;
}

export interface ArrowSwitchResult {
    last: boolean | undefined;
    /** Properties of `nodeShapes` to persist, or null when nothing is needed. */
    write: { showArrows?: boolean; heads?: boolean; tails?: boolean } | null;
}

export function reconcileArrowSwitch(
    last: boolean | undefined,
    now: ArrowSwitchState
): ArrowSwitchResult {
    const r = reconcileHeaderSwitch(last, now.show, now.heads || now.tails);
    if (r.action === "none") {
        return { last: r.last, write: null };
    }
    return r.action === "followChildren"
        ? { last: r.last, write: { showArrows: now.heads || now.tails } }
        : { last: r.last, write: { heads: now.show, tails: now.show } };
}

// Shapes: the header is on when the shape is anything but None.

/** What turning shapes back on picks when nothing better is remembered. */
const DEFAULT_SHAPE = "Rectangle";

export interface ShapeSwitchState {
    show: boolean;
    /** The Shape dropdown's value: "None", "Rectangle", "Rounded", "Circle". */
    shape: string;
}

export interface ShapeSwitchResult {
    last: boolean | undefined;
    /** The last non-None shape seen, so switching back on restores it. */
    restore: string;
    /** Properties of `nodeShapes` to persist, or null when nothing is needed. */
    write: { showShapes?: boolean; shape?: string } | null;
}

/**
 * Shapes off is the shape "None", and switching back on restores the shape that
 * was there rather than a fixed one: an author who chose Circle, switched shapes
 * off to look at the flows and back on again expects the circles. `restore` is
 * held in memory like `last`; with nothing remembered it is `DEFAULT_SHAPE`, which
 * is also the setting's own default.
 */
export function reconcileShapeSwitch(
    last: boolean | undefined,
    restore: string | undefined,
    now: ShapeSwitchState
): ShapeSwitchResult {
    const derived = now.shape !== "None";
    const remembered = derived ? now.shape : (restore || DEFAULT_SHAPE);
    const r = reconcileHeaderSwitch(last, now.show, derived);
    if (r.action === "none") {
        return { last: r.last, restore: remembered, write: null };
    }
    return r.action === "followChildren"
        ? { last: r.last, restore: remembered, write: { showShapes: derived } }
        : {
            last: r.last,
            restore: remembered,
            write: { shape: now.show ? remembered : "None" }
        };
}
