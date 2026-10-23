"use strict";
// Validation warnings reaching the report author, and the declared row cap.
//
// Until earlier every warning the parse, the corridor inference, the graph
// build and the colour resolver produced went to `console.warn` and nowhere
// else, so a typo in one cell became a band in the wrong place with no
// explanation. They now go to `host.displayWarningIcon` through
// `summariseWarnings`.
//
// What is asserted:
//
//   1. Nothing wrong means NO icon -- `summariseWarnings` returns undefined,
//      so the caller never raises one.
//   2. Per-row warnings GROUP by what they say. A bad port column produces one
//      sentence per row, and the author must be told it once with a count, not
//      once per row.
//   3. A group counts its rows and names a few examples.
//   4. Groups are ordered commonest-first, with ties by arrival -- not by Map
//      iteration order happening to be insertion order.
//   5. A single problem says what it is on the hover line; several say how many
//      there are, because the hover is one line.
//   6. The detail block is capped, and says how many kinds it left out.
//   7. A warning with no `Row n:` prefix survives intact.
//   8. Real warnings from the real parser go through it -- the wording in
//      dataParsing.ts and the regex here have to agree about the prefix.
//   9. capabilities.json declares a row cap, and visual.ts raises the icon and
//      warns on truncation. Source-level guards, like port-routing-check's
//      capabilities section: the wiring is the half that can silently not
//      happen, and there is no fake host small enough to drive update() with.

const fs = require("fs");
const path = require("path");

const { summariseWarnings, groupWarnings } = require("./lib/warnings.js");
const { parseDataView } = require("./parse.js");

const ROOT = path.join(__dirname, "..");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

// ---------------------------------------------------------------- 1. no icon
console.log("\n-- 1. nothing wrong raises nothing --");
check("no warnings means no icon at all", summariseWarnings([]) === undefined);

// ---------------------------------------------------------- 2-4. the grouping
console.log("\n-- 2-4. grouping, counting, ordering --");
const PORT = 'Source port "Est" is not one of North/South/East/West — ignored.';
const COLOUR = 'Flow colour "reddish" is not a valid colour — ignored.';
const many = [];
for (let row = 10; row < 60; row++) { many.push(`Row ${row}: ${PORT}`); }
many.splice(3, 0, `Row 12: ${COLOUR}`);
many.splice(20, 0, `Row 31: ${COLOUR}`);

const groups = groupWarnings(many);
check("52 warnings of two kinds group into exactly 2", groups.length === 2,
    `${groups.length} groups from ${many.length} warnings`);
check("the commonest group is first", groups[0].message === PORT,
    `first is "${groups[0].message.slice(0, 24)}…"`);
check("a group counts every one of its rows", groups[0].count === 50 && groups[1].count === 2,
    `${groups[0].count} and ${groups[1].count}`);
check("a group names at most 3 example rows, in arrival order",
    groups[0].rows.length === 3 && groups[0].rows[0] === 10 && groups[0].rows[2] === 12,
    `rows [${groups[0].rows.join(", ")}]`);
check("the row prefix is stripped from the message the author reads",
    !groups[0].message.startsWith("Row "), groups[0].message.slice(0, 20));

// Ties by arrival: two messages, one occurrence each, must keep their order.
const tied = groupWarnings(["Row 1: bravo", "Row 2: alpha"]);
check("equal counts order by arrival, not alphabetically",
    tied[0].message === "bravo" && tied[1].message === "alpha",
    `${tied[0].message} then ${tied[1].message}`);
// And it is stable however the Map was filled.
const tiedBack = groupWarnings(["Row 2: alpha", "Row 1: bravo"]);
check("arrival order is genuinely read, not a coincidence of insertion",
    tiedBack[0].message === "alpha", tiedBack[0].message);

// ------------------------------------------------------------- 5. hover lines
console.log("\n-- 5. the hover line --");
const one = summariseWarnings([`Row 41: ${PORT}`]);
check("a single problem states itself on the hover line",
    one.hover === PORT, one.hover);
check("and names its row in the detail",
    one.detail === `${PORT} (row 41)`, one.detail);

const oneKind = summariseWarnings(many.filter(w => w.includes("Source port")));
check("one kind over many rows counts them on the hover line",
    oneKind.hover === `${PORT} (50 rows)`, oneKind.hover);

const twoKinds = summariseWarnings(many);
check("several kinds give a count rather than a truncated sentence",
    twoKinds.hover === "2 kinds of data problem, 52 in total.", twoKinds.hover);
check("the detail lists each kind once, with counts and examples",
    twoKinds.detail.split("\n").length === 2
    && twoKinds.detail.includes("(50 rows, e.g. rows 10, 11 and 12)")
    && twoKinds.detail.includes("(2 rows, e.g. rows 12 and 31)"),
    JSON.stringify(twoKinds.detail));

// ------------------------------------------------------------ 6. the cap
console.log("\n-- 6. the detail block is capped --");
const kinds = [];
for (let k = 0; k < 40; k++) { kinds.push(`Row ${k + 1}: problem number ${k} happened.`); }
const capped = summariseWarnings(kinds);
const lines = capped.detail.split("\n");
check("40 distinct problems do not all get a line", lines.length < 40,
    `${lines.length} lines for 40 kinds`);
check("the last line says how many kinds were left out",
    /…and \d+ more kinds of problem\.$/.test(lines[lines.length - 1]),
    lines[lines.length - 1]);
const omitted = Number(/…and (\d+) more/.exec(lines[lines.length - 1])[1]);
check("the count of omitted kinds adds up", omitted + (lines.length - 1) === 40,
    `${lines.length - 1} listed + ${omitted} omitted`);
check("the detail block stays inside its character ceiling",
    capped.detail.length <= 1600, `${capped.detail.length} chars`);

// ------------------------------------------------- 7. a warning with no row
console.log("\n-- 7. a warning that is not about a row --");
const NO_ROW = "Source, Target, and Value must all be bound before SankeyBI can draw anything.";
const bare = summariseWarnings([NO_ROW]);
check("survives intact, with no row list bolted on",
    bare.hover === NO_ROW && bare.detail === NO_ROW, bare.detail);

// ------------------------------------------- 8. the real parser's own wording
console.log("\n-- 8. against the real parser --");
// A dataView the parser will complain about: the SAME bad port twice, a
// DIFFERENT bad port once, a negative value and a non-numeric one.
const dataView = {
    metadata: { columns: [] },
    table: {
        columns: [
            { displayName: "S", roles: { source: true } },
            { displayName: "T", roles: { target: true } },
            { displayName: "V", roles: { value: true } },
            { displayName: "P", roles: { sourcePort: true } }
        ],
        rows: [
            ["A", "B", 10, "East"],
            ["A", "B", 10, "Est"],
            ["A", "C", 10, "Est"],
            ["A", "C", -5, "East"],
            ["A", "D", "twelve", "East"],
            ["A", "E", 10, "Nrth"]
        ]
    }
};
const parsed = parseDataView(dataView);
check("the parser produced warnings to group (non-vacuous)", parsed.warnings.length >= 5,
    `${parsed.warnings.length} warnings`);
const real = groupWarnings(parsed.warnings);
const prefixed = parsed.warnings.filter(w => /^Row \d+: /.test(w)).length;
check("every real per-row warning carries the prefix this module strips",
    prefixed === parsed.warnings.length,
    `${prefixed} of ${parsed.warnings.length} match /^Row \\d+: /`);
check("no real group still has a row prefix in the message the author reads",
    real.every(g => !/^Row \d+: /.test(g.message)),
    real.map(g => g.message.slice(0, 18)).join(" | "));
// The parser quotes the offending value, which is the half that tells the
// author what to fix -- so the same typo twice is one problem said once, and a
// different typo is a different problem. Both halves asserted, because merging
// on a value-blind template would lose the value and grouping per row would
// lose the count.
const portGroups = real.filter(g => g.message.includes("North/South/East/West"));
const repeated = portGroups.find(g => g.message.includes('"Est"'));
const distinct = portGroups.find(g => g.message.includes('"Nrth"'));
check("the SAME bad port value twice is one group of 2",
    repeated !== undefined && repeated.count === 2,
    repeated ? `count ${repeated.count}` : "group missing");
check("a DIFFERENT bad value is its own group, so the author sees both typos",
    distinct !== undefined && distinct.count === 1 && portGroups.length === 2,
    `${portGroups.length} port groups`);
check("and each group still quotes the value that needs fixing",
    portGroups.every(g => /"[^"]+"/.test(g.message)),
    portGroups.map(g => /"([^"]+)"/.exec(g.message)[1]).join(", "));
const realSummary = summariseWarnings(parsed.warnings);
check("and the whole thing summarises to two non-empty strings",
    realSummary.hover.length > 0 && realSummary.detail.length > 0
    && realSummary.detail.split("\n").length === real.length,
    `${real.length} kinds`);

// --------------------------------------------------- 9. capabilities + wiring
console.log("\n-- 9. the declaration and the wiring --");
const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
// The mapping is CATEGORICAL, so the reduction lives on the
// categories rather than on the table's rows. The row cap it declares is what
// the warning above is about, so this has to follow the mapping.
const reduced = cap.dataViewMappings[0].categorical.categories;
check("capabilities.json declares a data reduction on the categories",
    reduced.dataReductionAlgorithm !== undefined,
    JSON.stringify(reduced.dataReductionAlgorithm));
check("and asks for a window of 30,000 rows",
    reduced.dataReductionAlgorithm
    && reduced.dataReductionAlgorithm.window
    && reduced.dataReductionAlgorithm.window.count === 30000,
    reduced.dataReductionAlgorithm ? String(reduced.dataReductionAlgorithm.window.count) : "absent");
check("the mapping is categorical, which is the only shape highlights arrive on",
    cap.dataViewMappings[0].categorical !== undefined
    && cap.dataViewMappings[0].table === undefined);
// There is no `conditions` block anywhere near it -- toolchain gotcha 1, which
// silently blocks every field drop, and this is the file it happens in.
check("no conditions block was introduced alongside it",
    JSON.stringify(cap.dataViewMappings).indexOf('"conditions"') === -1);

const visual = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");
check("visual.ts raises the header icon from the summary",
    /displayWarningIcon\(\s*summary\.hover\s*,\s*summary\.detail\s*\)/.test(visual));
check("and warns when the host says it truncated the rows",
    /metadata\?\.segment/.test(visual) && /Not all rows were loaded/.test(visual));
check("the warnings are cached, so a viewport-only update still raises them",
    /cachedWarnings/.test(visual)
    && visual.indexOf("this.cachedWarnings = collected") !== -1);
check("every warning stream is collected, not just logged",
    (visual.match(/note\(/g) || []).length >= 5,
    `${(visual.match(/note\(/g) || []).length} note() sites`);
check("no stream still goes only to the console",
    !/Warnings\.forEach\(w => console\.warn/.test(visual));

// AppSource reviewers open the console, and no author ever does (the author,
// earlier). The routine lines go through `debugLog`, which is silent unless
// `localStorage.sankeybi.debug` is "1"; only `console.error` in a catch block
// is unconditional.
const stripped = visual.replace(/function debugLog[\s\S]*?\n\}\r?\n/, "");
check("nothing but debugLog writes to the console log or warn stream",
    !/console\.(log|warn|info|debug)\(/.test(stripped));
check("...and the one console.error left sits in a catch block",
    (visual.match(/console\.error\(/g) || []).length === 4
    && (visual.match(/catch \(error\)/g) || []).length >= 4,
    `${(visual.match(/console\.error\(/g) || []).length} console.error sites`);

console.log(`\n${assertions} assertions, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
