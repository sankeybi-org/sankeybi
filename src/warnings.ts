/**
 * What the report author is told when the data is wrong.
 *
 * The parse, the corridor inference, the graph build and the colour resolver all
 * produce warnings. They go to `host.displayWarningIcon`, which takes one hover
 * line and one detail block, so this module turns up to a few thousand per-row
 * strings into something a person can read. It is kept pure, and out of
 * visual.ts, because what to say is a decision that can be checked.
 *
 * Warnings are grouped by message rather than de-duplicated. A bad port column
 * produces the same sentence for every row that has it, so a plain de-duplication
 * collapses nothing (the row number differs) and a plain list buries the author
 * in repetition. The row prefix is stripped to make the key; each group carries
 * its count and a couple of example rows, and the sentence is said once.
 */

/** The two strings `displayWarningIcon` takes. */
export interface WarningSummary {
    /** One line, shown on the header icon's hover. */
    hover: string;
    /** The full block, shown when the author opens the warning. */
    detail: string;
}

/** One group of identical warnings, and where they came from. */
interface WarningGroup {
    /** The message with any `Row n: ` prefix removed. */
    message: string;
    count: number;
    /** Up to `MAX_EXAMPLE_ROWS` row numbers, in the order they arrived. */
    rows: number[];
    /** Where this group first appeared, so ties order deterministically. */
    firstSeen: number;
}

/** How many distinct messages the detail block lists before summarising. */
const MAX_DETAIL_GROUPS = 12;
/** How many row numbers a group names as examples. */
const MAX_EXAMPLE_ROWS = 3;
/**
 * A ceiling on the detail block. The host lays this out in a small panel, and
 * a wall of text is no more use than the console was.
 */
const MAX_DETAIL_CHARS = 1500;

/** `Row 41: something` splits into the row number and the message after it. */
const ROW_PREFIX = /^Row (\d+): /;

/**
 * Groups the warnings by what they SAY, keeping counts and example rows.
 *
 * Exported for the checks: the grouping is the part with rules in it, and
 * asserting on the two rendered strings alone would not say whether a group
 * counted its rows correctly.
 */
export function groupWarnings(warnings: string[]): WarningGroup[] {
    const groups = new Map<string, WarningGroup>();
    warnings.forEach((warning, index) => {
        const match = ROW_PREFIX.exec(warning);
        const message = match ? warning.slice(match[0].length) : warning;
        const row = match ? Number(match[1]) : undefined;
        const existing = groups.get(message);
        if (existing === undefined) {
            groups.set(message, {
                message,
                count: 1,
                rows: row === undefined ? [] : [row],
                firstSeen: index
            });
            return;
        }
        existing.count += 1;
        if (row !== undefined && existing.rows.length < MAX_EXAMPLE_ROWS) {
            existing.rows.push(row);
        }
    });
    // Commonest first, so the author reads the problem affecting most of the data
    // before a one-off. Ties go by arrival, so the order does not depend on Map
    // iteration.
    return [...groups.values()].sort((a, b) =>
        b.count - a.count || a.firstSeen - b.firstSeen);
}

/** "row 41", "rows 41 and 42", "rows 41, 42 and 43". */
function rowList(rows: number[]): string {
    if (rows.length === 0) {
        return "";
    }
    const label = rows.length === 1 ? "row" : "rows";
    const names = rows.map(String);
    const joined = names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `${label} ${joined}`;
}

/** One detail line: the message, how many rows it hit, and which. */
function detailLine(group: WarningGroup): string {
    if (group.count === 1) {
        // A single occurrence names its row inline rather than as an "e.g.".
        const where = rowList(group.rows);
        return where === "" ? group.message : `${group.message} (${where})`;
    }
    const examples = rowList(group.rows);
    const rows = `${group.count} rows`;
    return examples === "" ? `${group.message} (${group.count} times)`
        : `${group.message} (${rows}, e.g. ${examples})`;
}

/**
 * The hover line. One problem says what it is; several say how many there are,
 * because the hover is one line and a truncated sentence is worse than a count.
 */
function hoverLine(groups: WarningGroup[], total: number): string {
    if (groups.length === 1) {
        const only = groups[0];
        return only.count === 1 ? only.message
            : `${only.message} (${only.count} rows)`;
    }
    return `${groups.length} kinds of data problem, ${total} in total.`;
}

/**
 * Turns every warning this update produced into the two strings the header
 * icon takes, or `undefined` where there is nothing wrong -- the caller then
 * does not raise an icon at all.
 */
export function summariseWarnings(warnings: string[]): WarningSummary | undefined {
    if (warnings.length === 0) {
        return undefined;
    }
    const groups = groupWarnings(warnings);
    const lines: string[] = [];
    let used = 0;
    let listed = 0;
    for (const group of groups.slice(0, MAX_DETAIL_GROUPS)) {
        const line = detailLine(group);
        if (used + line.length > MAX_DETAIL_CHARS && listed > 0) {
            break;
        }
        lines.push(line);
        used += line.length + 1;
        listed += 1;
    }
    const remaining = groups.length - listed;
    if (remaining > 0) {
        lines.push(`…and ${remaining} more kind${remaining === 1 ? "" : "s"} of problem.`);
    }
    return { hover: hoverLine(groups, warnings.length), detail: lines.join("\n") };
}
