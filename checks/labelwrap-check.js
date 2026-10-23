"use strict";
// **Wrapping a long node name**.
//
// long names "look wrong as it currently works". A name was drawn on one
// line however long it was, and because an outside label is content the view
// fit measures, one long name set the pitch of the whole diagram.
//
// What is asserted:
//   1. `wrapText` itself: greedy on whitespace, never breaking a word, total
//      on empty input, and a name that fits comes back as ONE line carrying
//      the width the caller would have measured anyway.
//   2. The budget is a multiple of the FONT SIZE, so it holds still under a
//      resize. (A viewport fraction was the first design: it re-broke every
//      line on a tile drag, and each re-break moves the pitch.)
//   3. **An unwrapped diagram is byte-identical**, which is what bounds the
//      blast radius: only names past the budget may move anything.
//   4. The lines reach the geometry -- the fit measures the wrapped block, so
//      a wrapped name reaches LESS far and the diagram comes out bigger.
//   5. The stacking: N lines spread symmetrically about where one line sat, a
//      total that stays below the lowest line, and North/South blocks that
//      still clear their node.
//   6. Layout HANDS the lines to render rather than render re-deriving them --
//      render has no font budget of its own and would silently draw a
//      different number of lines from the ones the fit measured.

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); } else {
        failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`);
    }
}

const fs = require("fs");
const path = require("path");
const { parseDataView } = require("./lib/dataParsing.js");
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");
const {
    computeLayout, labelLinesOf, LABEL_NAME_SIZE, LABEL_TOTAL_SIZE, textBoxOf
} = require("./layout-api.js");
const { wrapText, wrapWidthOf, WRAP_EMS } = require("./lib/labelWrap.js");
const model = require("./model-api.js");
const { dataViewFromHeader } = require("./dataview.js");

const PER_CHAR = 6.2;
const measure = text => (text === "" ? 0 : text.length * PER_CHAR);
const LABELS = { showNodeNames: true, showNodeTotals: false, basis: "Outflow", units: "",
    decimals: 0, iconSize: 16, iconColour: "Original" };
const CHROME = { legendVisible: false, legendPosition: "Bottom", nodeShape: "Rectangle",
    nodeMinWidthPercent: 3, nodeMinHeightPercent: 3, flowWidthPercent: 100, labels: LABELS };
const ROLE_OF = {
    FlowID: "flowID", Source: "source", Target: "target", Value: "value",
    SourceLabel: "sourceLabel", TargetLabel: "targetLabel"
};

// =====================================================================
console.log("--- 1. wrapText: greedy, and it never breaks a word ---");
{
    const budget = 10 * PER_CHAR;   // ten characters of the fallback
    check("an empty name is no lines at all", wrapText("", budget, measure).length === 0);
    const short = wrapText("Short", budget, measure);
    check("a name that fits is ONE line", short.length === 1 && short[0].text === "Short");
    check("...carrying the width the caller would have measured anyway",
        short[0].width === measure("Short"), String(short[0].width));

    const wrapped = wrapText("one two three four", budget, measure);
    check("a long name breaks on whitespace", wrapped.length > 1,
        wrapped.map(l => JSON.stringify(l.text)).join(" + "));
    check("...greedily -- each line is as full as it can be",
        wrapped.every(l => l.width <= budget || l.text.indexOf(" ") === -1),
        wrapped.map(l => l.width.toFixed(0)).join(","));
    check("...with every word kept, in order",
        wrapped.map(l => l.text).join(" ") === "one two three four");
    check("...and each line's width is its own measurement",
        wrapped.every(l => Math.abs(l.width - measure(l.text)) < 1e-9));

    // A single over-long word overflows rather than being cut in half: a
    // mid-word break reads as a bug.
    const oneWord = wrapText("Kraftvarmeverksanlaggning", budget, measure);
    check("one over-long word is never split", oneWord.length === 1,
        oneWord.map(l => l.text).join("|"));
    check("...it overflows the budget instead", oneWord[0].width > budget);
    // And a long word among short ones takes its own line.
    const mixed = wrapText("a Kraftvarmeverksanlaggning b", budget, measure);
    check("a long word among short ones takes its own line",
        mixed.some(l => l.text === "Kraftvarmeverksanlaggning"),
        mixed.map(l => JSON.stringify(l.text)).join(" + "));

    check("no budget means no wrapping", wrapText("one two three four", 0, measure).length === 1);
    check("a negative budget is the same", wrapText("one two three four", -5, measure).length === 1);
}

// =====================================================================
console.log("\n--- 2. the budget is a multiple of the FONT SIZE ---");
// Not of the viewport: a viewport fraction re-breaks every line when the tile
// is dragged, and a re-break moves the label's reach, which moves the pitch,
// which moves the whole diagram.
{
    check("the budget scales with the font size",
        wrapWidthOf(11) === 11 * WRAP_EMS && wrapWidthOf(22) === 22 * WRAP_EMS,
        `${wrapWidthOf(11)}px at 11, ${wrapWidthOf(22)}px at 22`);
    check("no font size means no budget, so no wrapping",
        wrapWidthOf(0) === 0 && wrapWidthOf(-1) === 0 && wrapWidthOf(NaN) === 0);
    // The property that matters: the same name breaks the same way whatever
    // the viewport is.
    const name = "Egenanvandning for energiproduktion";
    const at = w => {
        const flows = [{ flowID: "f", source: name, target: "B", value: 10 }];
        const dv = dataViewFromHeader(["FlowID", "Source", "Target", "Value"],
            flows.map(f => [f.flowID, f.source, f.target, f.value]), ROLE_OF);
        const parsed = parseDataView(dv).flows;
        const { corridors } = inferCorridors(parsed);
        const graph = buildGraph(parsed, new Map(), model.axisOf(corridors)).graph;
        const l = computeLayout(graph, corridors, w, 800, CHROME);
        return l.nodes.get(name).nameLines.map(x => x.text).join("|");
    };
    check("the same name breaks the same way at any viewport width",
        at(600) === at(1200) && at(1200) === at(2400), at(1200));
}

// =====================================================================
console.log("\n--- 3. an unwrapped diagram is byte-identical ---");
// The blast radius: only a name past the budget may move anything. Every
// synthetic check in the suite relies on this.
function layoutOf(rows, w = 1200, h = 800, chrome = CHROME) {
    const dv = dataViewFromHeader(
        ["FlowID", "Source", "Target", "Value", "SourceLabel", "TargetLabel"],
        rows.map(r => [r.flowID ?? "f", r.source, r.target, r.value,
            r.sourceLabel ?? null, r.targetLabel ?? null]), ROLE_OF);
    const flows = parseDataView(dv).flows;
    const { corridors } = inferCorridors(flows);
    const graph = buildGraph(flows, new Map(), model.axisOf(corridors)).graph;
    return computeLayout(graph, corridors, w, h, chrome);
}
{
    const shortRows = [
        { source: "Coal", target: "Power", value: 10 },
        { source: "Gas", target: "Power", value: 6 },
        { source: "Power", target: "Homes", value: 16 }
    ];
    const l = layoutOf(shortRows);
    let singles = 0;
    l.nodes.forEach(n => { if (n.nameLines.length === 1) { singles++; } });
    check("short names are all one line", singles === l.nodes.size, `${singles}/${l.nodes.size}`);
    // Every one of them sits exactly where a single line always sat: the
    // spread is (N-1)/2 line heights, which is 0 at one line.
    let worst = 0;
    l.nodes.forEach(n => {
        const { lines } = labelLinesOf(n, LABELS, true);
        const bare = labelLinesOf({ ...n, nameLines: [] }, LABELS, true);
        lines.forEach((line, i) => {
            worst = Math.max(worst, Math.abs(line.y - bare.lines[i].y),
                Math.abs(line.x - bare.lines[i].x));
        });
    });
    check("...and a one-line label lands where it did before wrapping existed",
        worst === 0, `worst ${worst}`);
}

// =====================================================================
console.log("\n--- 4. the wrapped block reaches less far, so the fit gives more ---");
// The point of wrapping BEFORE the fit: the fit measures the wrapped block, so
// a wrapped name reaches less far and the pitch it solves for is bigger.
// Measured against a name of the SAME length that cannot wrap -- no spaces to
// break on -- so the only difference between the two runs is the wrap itself.
{
    const NO_SHAPE = { ...CHROME, nodeShape: "None" };
    const spaced = "Considerably Longer Node Name";
    const solid = "ConsiderablyLongerNodeNamexxx";
    check("the two names measure the same", measure(spaced) === measure(solid),
        `${measure(spaced).toFixed(0)}px vs ${measure(solid).toFixed(0)}px`);

    const rowsFor = name => [{ source: name, target: "B", value: 10 },
        { source: "B", target: "C", value: 10 }];
    const wrapped = layoutOf(rowsFor(spaced), 1200, 800, NO_SHAPE);
    const unwrapped = layoutOf(rowsFor(solid), 1200, 800, NO_SHAPE);
    const a = wrapped.nodes.get(spaced);
    const b = unwrapped.nodes.get(solid);

    check("the one with spaces wrapped", a.nameLines.length > 1,
        a.nameLines.map(l => l.text).join(" / "));
    check("the one without could not", b.nameLines.length === 1);
    check("the widest wrapped line is inside the budget",
        Math.max(...a.nameLines.map(l => l.width)) <= wrapWidthOf(LABEL_NAME_SIZE),
        `${Math.max(...a.nameLines.map(l => l.width)).toFixed(0)}px of `
        + `${wrapWidthOf(LABEL_NAME_SIZE)}px`);

    const across = n => n.drawnReach.left + n.drawnReach.right;
    const down = n => n.drawnReach.up + n.drawnReach.down;
    check("the wrapped label reaches LESS far horizontally",
        across(a) < across(b), `${across(a).toFixed(0)}px wrapped vs ${across(b).toFixed(0)}px not`);
    // The vertical half of the trade shows in the label BLOCK, not in
    // `drawnReach`: this node is taller than its own label, so the extra line
    // is absorbed by the node's height and never reaches past it (both 0px
    // here). The block is what the fit budgets, so it is what to measure.
    check("...and the label BLOCK is narrower and taller, which is the trade",
        a.labelBoxWidth < b.labelBoxWidth && a.labelBoxHeight > b.labelBoxHeight,
        `${a.labelBoxWidth.toFixed(0)}x${a.labelBoxHeight.toFixed(0)} wrapped vs `
        + `${b.labelBoxWidth.toFixed(0)}x${b.labelBoxHeight.toFixed(0)} not`);
    check("...with the node absorbing the extra height rather than growing",
        down(a) === down(b), `${down(a).toFixed(0)}px both`);
    // Which is what buys the pitch -- the number that makes the diagram bigger.
    check("so the fit solves for a WIDER column pitch",
        wrapped.columnGap > unwrapped.columnGap,
        `${wrapped.columnGap.toFixed(1)}px vs ${unwrapped.columnGap.toFixed(1)}px `
        + `(+${((wrapped.columnGap / unwrapped.columnGap - 1) * 100).toFixed(0)}%)`);
}


// =====================================================================
console.log("\n--- 5. the stacking ---");
{
    const base = {
        id: "N", label: "", x: 0, y: 0, width: 20, height: 40,
        shapeWidth: 20, shapeHeight: 40, labelInside: false, inflow: 10, outflow: 10
    };
    const threeLines = [{ text: "one", width: 18 }, { text: "two", width: 18 },
        { text: "three", width: 30 }];
    const withTotals = { ...LABELS, showNodeTotals: true, nodeTotals: true };
    ["East", "West"].forEach(port => {
        const node = { ...base, label: "one two three", labelPort: port, nameLines: threeLines };
        const { lines } = labelLinesOf(node, LABELS, false);
        check(`${port}: three lines are drawn`, lines.length === 3);
        const ys = lines.map(l => l.y);
        check(`${port}: evenly spaced`,
            Math.abs((ys[1] - ys[0]) - (ys[2] - ys[1])) < 1e-9, ys.map(y => y.toFixed(1)).join(","));
        // Symmetric about where one line sat.
        const one = labelLinesOf({ ...node, nameLines: [{ text: "one two three", width: 80 }] },
            LABELS, false).lines[0].y;
        check(`${port}: centred on where a single line sat`,
            Math.abs((ys[0] + ys[2]) / 2 - one) < 1e-9, `${((ys[0] + ys[2]) / 2).toFixed(2)} vs ${one}`);
    });
    // The total stays clear of the lowest name line.
    {
        const node = { ...base, label: "one two three", labelPort: "East", nameLines: threeLines };
        const { lines } = labelLinesOf(node, withTotals, false, "10 TWh");
        const total = lines[lines.length - 1];
        check("the total is the last line and sits below every name line",
            total.text === "10 TWh" && lines.slice(0, -1).every(l => l.y < total.y),
            `total at ${total.y.toFixed(1)}, names ${lines.slice(0, -1).map(l => l.y.toFixed(1))}`);
        check("...and does not overlap the lowest one",
            textBoxOf(total).top >= textBoxOf(lines[lines.length - 2]).bottom - 1e-9,
            `${textBoxOf(total).top.toFixed(1)} vs ${textBoxOf(lines[lines.length - 2]).bottom.toFixed(1)}`);
    }
    // Stacked above or below, the block must still CLEAR the node.
    {
        const north = labelLinesOf({ ...base, label: "one two three", labelPort: "North",
            nameLines: threeLines }, withTotals, false, "10 TWh");
        const bottom = Math.max(...north.lines.map(l => textBoxOf(l).bottom));
        check("a North block stays above the node however many lines it has",
            bottom <= base.y + 1e-6, `lowest ink ${bottom.toFixed(1)}, node top ${base.y}`);
        const south = labelLinesOf({ ...base, label: "one two three", labelPort: "South",
            nameLines: threeLines }, withTotals, false, "10 TWh");
        const top = Math.min(...south.lines.map(l => textBoxOf(l).top));
        check("a South block stays below it",
            top >= base.y + base.height - 1e-6,
            `highest ink ${top.toFixed(1)}, node bottom ${base.y + base.height}`);
    }
}

// =====================================================================
console.log("\n--- 6. layout HANDS the lines to render ---");
// Render has no font budget of its own and must not re-derive the breaks, or
// it would draw a different number of lines from the ones the fit measured --
// the same rule routing follows for `spine` and `handles`.
{
    const long = "Considerably Longer Node Name Indeed";
    const l = layoutOf([{ source: long, target: "B", value: 10 }]);
    const node = l.nodes.get(long);
    check("the positioned node carries its own lines",
        Array.isArray(node.nameLines) && node.nameLines.length > 1,
        `${node.nameLines.length} lines`);
    // Render's call: no widths, no total text -- exactly render.ts's arguments.
    const asRender = labelLinesOf(node, LABELS, true);
    check("render's call reproduces them without measuring anything",
        asRender.lines.map(x => x.text).join("|") === node.nameLines.map(x => x.text).join("|"),
        asRender.lines.map(x => x.text).join("|"));
    // A node with no lines (a check's hand-built one) still gets the single
    // line it always did, so nothing that predates this moves.
    const bare = labelLinesOf({ ...node, nameLines: [] }, LABELS, true);
    check("a node with no carried lines falls back to one measured line",
        bare.lines.length === 1 && bare.lines[0].text === long);
}

// =====================================================================
console.log("\n--- 11. a label wraps to ITS OWN BOX, like a text box ---");
/**
 * **the author,**: three labels in one column, and only the LONGEST
 * wrapped and tucked inside its shape while the two shorter ones were pushed
 * outside -- "something illogical happening". It was. The wrap triggered on a
 * fixed width (12em) that bears no relation to the node it sits in, so with
 * the three names measuring 106px, 154px and 127px against a 132px budget,
 * only the middle one broke.
 *
 * A text box wraps to ITS BOX. The box here is the node's shape, whose width
 * is pitch-derived -- so the breakpoints are precomputed per name
 * (`wrapOptionsOf`, CSS's intrinsic sizing) and the fit picks the fewest lines
 * that fit by table lookup, measuring nothing. The fit therefore KNOWS the
 * wrap it is measuring, which is what keeps the drawing snug to the frame; a
 * post-fit pass was tried in between and `fit-check` rejected it, because
 * changing what is drawn after the solve breaks the fit's own promise.
 */
{
    const NAMES = ["Forluster omvandling", "Industri (icke energiandamal)",
        "Industri (energiandamal)"];
    const measureAt = (t, size) => t.length * (size === 11 ? 5.3 : 4.3);
    const at = (minWidth, totals) => {
        const labels = { ...LABELS, measureText: measureAt,
            showNodeTotals: Boolean(totals), nodeTotals: Boolean(totals), units: "TWh" };
        const chrome = { ...CHROME, nodeShape: "Rectangle", labels,
            nodeMinWidthPercent: minWidth, nodeMinHeightPercent: 14 };
        const rows = NAMES.map(n => ({ source: n, target: "Hub", value: 10 }))
            .concat([{ source: "Hub", target: "Out", value: 30 }]);
        const l = layoutOf(rows, 1200, 800, chrome);
        return NAMES.map(n => {
            const node = l.nodes.get(n);
            return { name: n, width: node.shapeWidth, inside: node.labelInside,
                lines: node.nameLines.map(x => x.text) };
        });
    };

    // **The case from the screenshot.** A shape that holds none of the three
    // on one line holds ALL of them wrapped -- the point being that they now
    // behave alike instead of one of them behaving differently.
    const band = at(25);
    check("every label in a column behaves the same way",
        band.every(r => r.inside), band.map(r => `${r.name.slice(0, 12)}:${r.inside}`).join(" "));
    check("...each wrapped to the shape it sits in",
        band.every(r => r.lines.length > 1),
        band.map(r => JSON.stringify(r.lines)).join(" "));
    check("...and none of them would have fitted on one line",
        band.every(r => measureAt(r.name, 11) > r.width),
        band.map(r => `${measureAt(r.name, 11).toFixed(0)}>${r.width.toFixed(0)}`).join(" "));

    // Only as much as it needs: a wider shape lets the short one stop wrapping
    // while the long ones still break.
    const wider = at(30);
    check("a shape wide enough stops the short name wrapping",
        wider[0].lines.length === 1, JSON.stringify(wider[0].lines));
    check("...while the longer ones still break",
        wider.slice(1).every(r => r.lines.length > 1),
        wider.slice(1).map(r => r.lines.length + "ln").join(" "));

    // Showing totals adds height, and must not quietly let a label in.
    const withTotals = at(25, true);
    check("turning totals on does not change who is inside",
        withTotals.every((r, i) => r.inside === band[i].inside));
}


console.log(`\n${assertions} assertions`);
if (failures === 0) {
    console.log("ALL LABEL WRAP CHECKS PASSED");
} else {
    console.log(`${failures} LABEL WRAP CHECK(S) FAILED`);
    process.exit(1);
}
