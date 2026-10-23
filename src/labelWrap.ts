/**
 * Breaking a long node name over more than one line.
 *
 * A name drawn on one line however long it is would set the pitch of the whole
 * diagram, because an outside label is content the view fit measures.
 *
 * `labelLinesOf` is the one place that decides where a label's lines go: the fit
 * measures exactly those lines and render paints exactly those lines. Wrapping must
 * not break that, which rules out two obvious homes:
 *
 * - Not at render time. Render would make a label narrower than the fit reserved
 *   (harmless) and taller (not): the extra lines would grow into the node above or
 *   below in the same column, and the fit cannot know.
 * - Not inside the fit's loop to a pitch-derived width. A node's size comes from
 *   the pitch the fit is still solving for, so the lines would be re-broken at
 *   every trial, which multiplies the text measurements by hundreds, and a narrower
 *   pitch would make labels taller, growing the extent on the other axis, so the
 *   solve need not converge.
 *
 * So wrapping runs once per layout, in the pass that already measures each label,
 * against a budget taken from the font size rather than the pitch. The fit loop
 * then costs what it always did, and the invariant holds because `labelLinesOf`
 * still decides for both callers.
 *
 * The rule is greedy, on whitespace, and a single word is never broken: a mid-word
 * break reads as a bug, so an over-long word takes its own line and overflows the
 * budget. There is no line cap, so nothing is hidden. A name that already fits comes
 * back as one line, so a diagram with short names is untouched.
 */

/** One drawn line of a wrapped name, with the width it was measured at. */
export interface WrappedLine {
    text: string;
    width: number;
}

/**
 * `text` broken into lines no wider than `maxWidth`, measured with `measure`.
 *
 * `maxWidth <= 0` means no wrapping, which is how a caller with no budget gets a
 * single line.
 *
 * It is total: an empty or blank name comes back as no lines at all, which is what
 * `labelLinesOf` already does with a suppressed name.
 */
export function wrapText(
    text: string,
    maxWidth: number,
    measure: (text: string) => number
): WrappedLine[] {
    if (text === "") {
        return [];
    }
    const whole = measure(text);
    // The common case: one line, with the width the caller would have measured anyway.
    if (!(maxWidth > 0) || whole <= maxWidth) {
        return [{ text, width: whole }];
    }
    const words = text.split(/\s+/).filter(w => w !== "");
    if (words.length <= 1) {
        // Nothing to break on. Overflow rather than split a word.
        return [{ text, width: whole }];
    }
    const lines: WrappedLine[] = [];
    let line = words[0];
    let width = measure(line);
    for (let i = 1; i < words.length; i++) {
        const candidate = `${line} ${words[i]}`;
        const candidateWidth = measure(candidate);
        if (candidateWidth <= maxWidth) {
            line = candidate;
            width = candidateWidth;
        } else {
            lines.push({ text: line, width });
            line = words[i];
            width = measure(line);
        }
    }
    lines.push({ text: line, width });
    return lines;
}

/**
 * How wide a name may be drawn before it wraps, as a multiple of its own font size.
 *
 * It is not a fraction of the viewport: resizing the tile would then re-break every
 * line, and a re-break changes the label's reach, which changes the pitch and moves
 * the whole diagram. A multiple of the font size holds still under resize, and it is
 * the honest expression of why a line is broken: past about twenty characters a label
 * stops reading as a name.
 *
 * Twelve ems leaves typical names alone and catches the genuinely long ones. Below
 * about ten, short names start breaking and names reach three lines; above about
 * eighteen nothing wraps at all. The break rule matters more than the number: names
 * such as "Combined heat and power" split on their one sensible space, and a bracketed
 * suffix stays with the word it belongs to.
 */
export const WRAP_EMS = 12;

/** The budget in pixels for a name drawn at `fontSize`. */
export function wrapWidthOf(fontSize: number): number {
    return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * WRAP_EMS : 0;
}

/**
 * **One way a name can be broken**, and how wide that costs.
 *
 * `width` is the WIDEST line in the option, which is what the text needs to be
 * given. The options for a name are ordered by line count, so the first one
 * that fits is also the one with the fewest lines.
 */
export interface WrapOption {
    lines: WrappedLine[];
    width: number;
}

/**
 * Every distinct way greedy wrapping can break this name.
 *
 * A text box wraps to its box, and the box here is a node's shape, whose width comes
 * from the pitch the fit is still solving for. Measuring the wrap inside that solve
 * would re-break every label at every trial, and letting the drawn lines change after
 * the solve would break the fit's promise about where the outermost drawn thing sits.
 *
 * The way out is that the break points are a property of the text, not of the layout.
 * The whole string on one line is the widest outcome, the widest single word is the
 * narrowest, and between them greedy wrapping has only a handful of distinct
 * outcomes, one per line count. Computed once here, the fit can ask "how many lines at
 * this width?" as a table lookup with no measurement, so it costs O(nodes) rather than
 * O(nodes x trials) and knows the wrap it is measuring.
 *
 * Every achievable line is some run of consecutive words, so those runs are the only
 * budgets at which the greedy outcome can change: O(words^2) measurements, once.
 * `MAX_WRAP_WORDS` bounds that for a pathological name; past it only the single line
 * is offered.
 */
const MAX_WRAP_WORDS = 12;

export function wrapOptionsOf(
    text: string,
    measure: (text: string) => number
): WrapOption[] {
    if (text === "") {
        return [];
    }
    // Memoised, because the budget sweep below asks for the same runs of words over and
    // over: every candidate budget re-wraps the whole name, and a run's width cannot
    // depend on the budget.
    const seen = new Map<string, number>();
    const measured = (run: string): number => {
        const known = seen.get(run);
        if (known !== undefined) {
            return known;
        }
        const width = measure(run);
        seen.set(run, width);
        return width;
    };
    const whole: WrapOption = { lines: [{ text, width: measured(text) }], width: measured(text) };
    const words = text.split(/\s+/).filter(w => w !== "");
    if (words.length < 2 || words.length > MAX_WRAP_WORDS) {
        return [whole];
    }
    // The budgets at which the greedy outcome can change: the width of every
    // run of consecutive words.
    const budgets = new Set<number>();
    for (let i = 0; i < words.length; i++) {
        for (let j = i; j < words.length; j++) {
            budgets.add(measured(words.slice(i, j + 1).join(" ")));
        }
    }
    // Narrowest option per line count wins: two budgets that break the same
    // way are the same option.
    const best = new Map<number, WrapOption>();
    [...budgets].sort((a, b) => a - b).forEach(budget => {
        const lines = wrapText(text, budget, measured);
        const width = lines.reduce((w, line) => Math.max(w, line.width), 0);
        const current = best.get(lines.length);
        if (!current || width < current.width) {
            best.set(lines.length, { lines, width });
        }
    });
    return [...best.values()].sort((a, b) => a.lines.length - b.lines.length);
}

/**
 * The fewest-lines option that fits `available`, or `undefined` where even the
 * narrowest does not. Pure arithmetic — this is what the fit calls, per node
 * per trial pitch, and it must never measure anything.
 */
export function wrapForWidth(
    options: readonly WrapOption[],
    available: number
): WrapOption | undefined {
    return options.find(option => option.width <= available);
}
