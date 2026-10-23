"use strict";
// tooltips.ts is pure: corridors + settings in, lines out. Everything about
// WHAT a tooltip says is provable here; only how the host paints the lines
// needs a live round.

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const { parseDataView } = require("./parse.js");
const { inferCorridors } = require("./lib/corridors.js");
const {
    corridorTooltipRows, formatTotal, rowsToTitle, nodeTooltipRows, summariseNodes, toTooltipItems
} = require("./lib/tooltips.js");

// Most assertions below are about WHAT a tooltip says, which reads better as
// whole lines; the row/column split is asserted separately in section 8.
const asLine = row => (row.label === "" && row.value === "") ? ""
    : row.value === "" ? row.label : `${row.label}: ${row.value}`;
const nodeTooltipLines = (...args) => nodeTooltipRows(...args).map(asLine);
const corridorLines = (...args) => corridorTooltipRows(...args).map(asLine);
const linesToTitle = lines => lines.join(String.fromCharCode(10));

const ROLES = ["source", "target", "value", "flowType"];
const dataViewOf = rows => ({
    table: {
        columns: ROLES.map(r => ({ roles: { [r]: true } })),
        rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
    }
});
const corridorsOf = rows => inferCorridors(parseDataView(dataViewOf(rows)).flows).corridors;

const LABELS = { units: "TWh", decimalPlaces: 1, nodeTotals: false, basis: "Larger" };
const PLAIN = { ...LABELS, units: "", decimalPlaces: 0 };
const ALL = { totals: true, byFlowType: true, byConnection: true };
const nodeOf = id => ({ id, label: "" });

// The diagram every case below reads from: Grid takes from two sources and
// feeds two, carrying two flow types.
const ROWS = [
    { source: "Wind", target: "Grid", value: 120, flowType: "Electricity" },
    { source: "Solar", target: "Grid", value: 80, flowType: "Electricity" },
    { source: "Boiler", target: "Grid", value: 55, flowType: "Heat" },
    { source: "Grid", target: "Industry", value: 140, flowType: "Electricity" },
    { source: "Grid", target: "Homes", value: 60, flowType: "Electricity" },
    { source: "Grid", target: "Homes", value: 55.5, flowType: "Heat" }
];
const SUMMARIES = summariseNodes(corridorsOf(ROWS));

// ===============================================================
// 1. The summary itself: totals must agree with their own breakdowns.
// ===============================================================
{
    const grid = SUMMARIES.get("Grid");
    check("inflow is the sum of the corridors arriving", grid.inflow === 255, String(grid.inflow));
    check("outflow is the sum of the corridors leaving", grid.outflow === 255.5, String(grid.outflow));

    const typeIn = Array.from(grid.byType.values()).reduce((a, d) => a + d.in, 0);
    const typeOut = Array.from(grid.byType.values()).reduce((a, d) => a + d.out, 0);
    check("the flow-type breakdown sums back to the totals",
        typeIn === grid.inflow && typeOut === grid.outflow, `${typeIn} / ${typeOut}`);

    const connIn = Array.from(grid.byConnection.values()).reduce((a, d) => a + d.in, 0);
    const connOut = Array.from(grid.byConnection.values()).reduce((a, d) => a + d.out, 0);
    check("the connection breakdown sums back to the totals",
        connIn === grid.inflow && connOut === grid.outflow, `${connIn} / ${connOut}`);

    check("a corridor carrying two types splits across both buckets",
        grid.byConnection.get("Homes").out === 115.5, String(grid.byConnection.get("Homes").out));
}

// ===============================================================
// 2. The lines, with everything switched on.
// ===============================================================
{
    const lines = nodeTooltipLines(nodeOf("Grid"), SUMMARIES.get("Grid"), LABELS, ALL, ["Electricity", "Heat"]);
    const expected = [
        "Grid",
        "",
        "Total in: 255.0 TWh",
        "Total out: 255.5 TWh",
        "",
        "Electricity in: 200.0 TWh",
        "Heat in: 55.0 TWh",
        "Electricity out: 200.0 TWh",
        "Heat out: 55.5 TWh",
        "",
        "From Wind: 120.0 TWh",
        "From Solar: 80.0 TWh",
        "From Boiler: 55.0 TWh",
        "To Industry: 140.0 TWh",
        "To Homes: 115.5 TWh"
    ];
    check("all three blocks render exactly as agreed",
        JSON.stringify(lines) === JSON.stringify(expected), lines.join(" | "));
    check("every block is separated by exactly one blank line",
        lines.filter(l => l === "").length === 3);
    check("no line is blank-adjacent to another blank",
        !lines.some((l, i) => l === "" && lines[i + 1] === ""));
    check("the name is first and is never blank", lines[0] === "Grid");
    // The flow-type block groups by DIRECTION, not by type: an
    // interleaved block passes every other assertion in this section, because
    // it carries exactly the same lines in a different order.
    const types = lines.filter(l => / (in|out): /.test(l) && !l.startsWith("Total"));
    const lastIn = types.map(l => l.includes(" in: ")).lastIndexOf(true);
    const firstOut = types.findIndex(l => l.includes(" out: "));
    check("every flow type's in row comes before every out row",
        lastIn < firstOut, types.join(" | "));
}

// ===============================================================
// 3. Each toggle is independent, and off means absent.
// ===============================================================
{
    const only = opts => nodeTooltipLines(nodeOf("Grid"), SUMMARIES.get("Grid"), LABELS,
        { totals: false, byFlowType: false, byConnection: false, ...opts }, ["Electricity", "Heat"]);

    check("totals only", JSON.stringify(only({ totals: true })) ===
        JSON.stringify(["Grid", "", "Total in: 255.0 TWh", "Total out: 255.5 TWh"]));
    check("by flow type only has no Total lines",
        !only({ byFlowType: true }).some(l => l.startsWith("Total ")));
    check("by connection only has no flow-type lines",
        !only({ byConnection: true }).some(l => l.includes("Electricity")));
    check("all three off leaves just the name",
        JSON.stringify(only({})) === JSON.stringify(["Grid"]));
    check("a blank line never trails the last block",
        only({ byConnection: true }).slice(-1)[0] !== "");
}

// ===============================================================
// 4. Zeroes are omitted — a source node has no inflow to report.
// ===============================================================
{
    const wind = nodeTooltipLines(nodeOf("Wind"), SUMMARIES.get("Wind"), LABELS, ALL, ["Electricity", "Heat"]);
    check("a pure source prints no 'Total in' row", !wind.some(l => l.startsWith("Total in")), wind.join(" | "));
    check("...and no 'From' rows", !wind.some(l => l.startsWith("From ")), wind.join(" | "));
    check("...but does print its outflow", wind.includes("Total out: 120.0 TWh"));
    check("...and never prints a 0", !wind.some(l => /: 0\.0 TWh$/.test(l)), wind.join(" | "));

    const industry = nodeTooltipLines(nodeOf("Industry"), SUMMARIES.get("Industry"), LABELS, ALL, []);
    check("a pure sink prints no 'Total out' row", !industry.some(l => l.startsWith("Total out")));
    check("...and no 'To' rows", !industry.some(l => l.startsWith("To ")));
}

// ===============================================================
// 5. Ordering rules.
// ===============================================================
{
    // Legend order, not alphabetical and not insertion order: the legend
    // lists Heat first here, so the tooltip must too.
    const lines = nodeTooltipLines(nodeOf("Grid"), SUMMARIES.get("Grid"), LABELS, ALL, ["Heat", "Electricity"]);
    const types = lines.filter(l => /^(Heat|Electricity)/.test(l));
    check("flow types follow the legend's order, whatever it is",
        types[0].startsWith("Heat"), types.join(" | "));

    const connections = lines.filter(l => l.startsWith("From ") || l.startsWith("To "));
    check("sources come before targets",
        connections.slice(0, 3).every(l => l.startsWith("From ")) &&
        connections.slice(3).every(l => l.startsWith("To ")), connections.join(" | "));
    check("each direction is descending by value",
        connections[0].includes("120") && connections[2].includes("55"), connections.join(" | "));
}
{
    // An untyped bucket isn't in the legend's list; a plain indexOf would
    // return -1 and sort it to the FRONT.
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "A", target: "B", value: 90, flowType: "Electricity" }
    ];
    const s = summariseNodes(corridorsOf(rows));
    const lines = nodeTooltipLines(nodeOf("A"), s.get("A"), PLAIN, ALL, ["Electricity"]);
    const types = lines.filter(l => l.includes(" out: ") && !l.startsWith("Total"));
    check("untyped flows sort last and are labelled (untyped)",
        types[0].startsWith("Electricity") && types[1].startsWith("(untyped)"), types.join(" | "));
}

// ===============================================================
// 6. A self-loop is both ends of itself.
// ===============================================================
{
    const s = summariseNodes(corridorsOf([{ source: "Store", target: "Store", value: 30, flowType: "Heat" }]));
    const lines = nodeTooltipLines(nodeOf("Store"), s.get("Store"), PLAIN, ALL, ["Heat"]);
    check("a self-loop counts in both directions",
        lines.includes("Total in: 30") && lines.includes("Total out: 30"), lines.join(" | "));
    check("...and appears as both a source and a target of itself",
        lines.includes("From Store: 30") && lines.includes("To Store: 30"), lines.join(" | "));
}

// ===============================================================
// 7. Formatting is the Labels card's, everywhere.
// ===============================================================
{
    const lines = nodeTooltipLines(nodeOf("Grid"), SUMMARIES.get("Grid"), PLAIN, ALL, ["Electricity", "Heat"]);
    check("with no units or decimals set, values read plainly",
        lines.includes("Total in: 255") && lines.includes("Total out: 256"), lines.join(" | "));
    check("every value line goes through formatTotal",
        nodeTooltipLines(nodeOf("Grid"), SUMMARIES.get("Grid"), LABELS, ALL, [])
            .filter(l => l.includes(": ")).every(l => l.endsWith(" TWh")));

    // A corridor's box: the pair heads it, then a row per flow type. A click
    // selects the whole corridor, so the box has to describe the whole of one.
    const band = { source: "Grid", target: "Industry", flowType: "Electricity", value: 140 };
    const heat = { source: "Grid", target: "Industry", flowType: "Heat", value: 60 };
    check("a corridor heads with the pair and no figure",
        corridorLines([band], LABELS)[0] === "Grid → Industry",
        corridorLines([band], LABELS).join(" | "));
    check("a single-type corridor is the pair and one formatted row",
        corridorLines([band], LABELS).join(" | ") === "Grid → Industry | Electricity: 140.0 TWh",
        corridorLines([band], LABELS).join(" | "));
    check("...and prints no total, which would repeat the row above it",
        !corridorLines([band], LABELS).some(l => l.startsWith("Total")));
    const multi = corridorTooltipRows([band, heat], LABELS);
    check("a multi-type corridor lists each type and totals them",
        JSON.stringify(multi) === JSON.stringify([
            { label: "Grid → Industry", value: "" },
            { label: "Electricity", value: "140.0 TWh" },
            { label: "Heat", value: "60.0 TWh" },
            // The divider is an empty row; toTooltipItems draws it as a rule.
            { label: "", value: "" },
            { label: "Total", value: "200.0 TWh" }
        ]), JSON.stringify(multi));
    check("types follow LEGEND order, not the order the bands arrive in",
        corridorLines([heat, band], LABELS, ["Electricity", "Heat"])[1] === "Electricity: 140.0 TWh",
        corridorLines([heat, band], LABELS, ["Electricity", "Heat"]).join(" | "));
    check("an untyped band names the untyped bucket",
        corridorLines([{ ...band, flowType: undefined }], PLAIN)[1].startsWith("(untyped)"),
        corridorLines([{ ...band, flowType: undefined }], PLAIN).join(" | "));
    check("a zero-value stripe is not printed",
        corridorLines([band, { ...heat, value: 0 }], LABELS).every(l => !l.startsWith("Heat")),
        corridorLines([band, { ...heat, value: 0 }], LABELS).join(" | "));
    check("no bands at all is no box, not a crash",
        corridorLines([], LABELS).length === 0);
}

// ===============================================================
// 8. Both boxes are built from the same rows, and each row uses BOTH of
//    the host's columns -- an empty displayName left the label column
//    reserved but empty, which wasted space and wrapped the text.
// ===============================================================
{
    const rows = nodeTooltipRows(nodeOf("Grid"), SUMMARIES.get("Grid"), LABELS, ALL, ["Electricity", "Heat"]);
    const items = toTooltipItems(rows);
    const title = rowsToTitle(rows);
    const rule = String.fromCharCode(0x2500).repeat(12);

    // The heading is hoisted into the API's header field, and the rule that
    // followed it goes with it -- a title needs no line under it.
    check("the heading becomes the tooltip's header, not a data row",
        items[0].header === "Grid" && !items.some(i => i.displayName === "Grid"),
        JSON.stringify(items[0]));
    check("...and the rule that followed the heading is dropped with it",
        items.filter(i => i.displayName === rule).length === 2,
        String(items.filter(i => i.displayName === rule).length));
    // The rule lives in the LABEL column, where the text is. In
    // the value column it was drawn over the figures instead.
    check("a separator carries its rule in the label column, not the value",
        items.filter(i => i.displayName === rule).every(i => i.value === ""),
        JSON.stringify(items.filter(i => i.displayName === rule)));
    check("...and no item carries a rule in the value column",
        !items.some(i => i.value === rule), JSON.stringify(items.map(i => i.value)));
    check("one host item per remaining row", items.length === rows.length - 2);
    check("a figure row fills both columns",
        items.some(i => i.displayName === "Total in" && i.value === "255.0 TWh"),
        JSON.stringify(items.slice(0, 4)));
    check("no figure row packs the label into the value",
        items.filter(i => i.displayName !== rule).every(i => !i.value.includes(": ")),
        JSON.stringify(items.map(i => i.value)));
    // Every breakdown off leaves a heading with nothing under it; an empty
    // item list would produce an empty box, so the name becomes the row.
    const bare = toTooltipItems(nodeTooltipRows(nodeOf("Grid"), SUMMARIES.get("Grid"), LABELS,
        { totals: false, byFlowType: false, byConnection: false }));
    check("a heading with nothing under it still says something",
        bare.length === 1 && bare[0].displayName === "Grid", JSON.stringify(bare));
    const oneBand = [{ source: "Grid", target: "Industry", flowType: "Electricity", value: 140 }];
    check("a corridor row separates the flow type from its figure",
        JSON.stringify(corridorTooltipRows(oneBand, LABELS))
        === JSON.stringify([{ label: "Grid → Industry", value: "" }, { label: "Electricity", value: "140.0 TWh" }]),
        JSON.stringify(corridorTooltipRows(oneBand, LABELS)));

    // Whitespace does not survive the host: "", " " and a non-breaking space
    // were all laid out as a short gap rather than a line. A drawn rule is
    // ordinary text, so it cannot be trimmed away.
    check("the remaining separators are drawn as rules",
        items.filter(i => i.displayName === rule).length === 2);
    check("no item is entirely empty",
        items.every(i => i.displayName.length > 0 || i.value.length > 0));

    // The <title> is plain text, where a real blank line does work.
    const lines = title.split(String.fromCharCode(10));
    check("the <title> carries the same facts, newline-separated",
        lines.length === rows.length && lines.includes("Total in: 255.0 TWh"), title);
    check("...with a genuine blank line as the separator",
        lines.filter(l => l === "").length === 3, JSON.stringify(lines));
    check("...and the node's name on its own, with no trailing colon",
        lines[0] === "Grid");
    check("a corridor's <title> is its lines, newline-separated",
        rowsToTitle(corridorTooltipRows([{ source: "A", target: "B", flowType: "X", value: 1 }], PLAIN))
            === "A → B" + String.fromCharCode(10) + "X: 1");
}

// ===============================================================
// 9. Degenerate inputs must not throw — a node may have no corridors at all.
// ===============================================================
{
    const lines = nodeTooltipLines({ id: "Lonely", label: "" }, undefined, LABELS, ALL, []);
    check("a node with no summary still names itself", JSON.stringify(lines) === JSON.stringify(["Lonely"]),
        lines.join(" | "));
    check("a suppressed label falls back to the id",
        nodeTooltipLines({ id: "Grid", label: "" }, SUMMARIES.get("Grid"), LABELS, { totals: true, byFlowType: false, byConnection: false })[0] === "Grid");
    check("an explicit label wins",
        nodeTooltipLines({ id: "Grid", label: "National Grid" }, SUMMARIES.get("Grid"), LABELS, ALL)[0] === "National Grid");
    check("formatTotal handles a zero", formatTotal(0, LABELS) === "0.0 TWh", formatTotal(0, LABELS));
}

if (failures === 0) {
    console.log("\nALL TOOLTIP CHECKS PASSED");
} else {
    console.log(`\n${failures} TOOLTIP CHECK(S) FAILED`);
    process.exit(1);
}
