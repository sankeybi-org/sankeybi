"use strict";
// Numbers formatted the way the model and the report ask.
//
// Before this, every figure went through
// `value.toLocaleString(undefined, {min/maxFractionDigits})`, which ignores the
// Value field's own format string entirely and takes its separators from the
// BROWSER's locale rather than the report's.
//
// **What this check can and cannot reach.** `formatting.ts` imports
// `powerbi-visuals-utils-formattingutils`, which is ESM-only with extensionless
// internal imports, so Node cannot require it -- which is exactly why the
// formatter is INJECTED as a function rather than imported where it is used.
// So the library's own behaviour (format strings, cultures, display units) is
// not assertable here and has to be verified live. Everything that is OURS is:
//
//   1. `formatTotal` uses the injected formatter when there is one.
//   2. ...and falls back to the old path when there is not, so every other
//      check in the suite is unaffected -- which is what makes it safe to have
//      left 45 of them alone.
//   3. The units suffix is still appended to whatever the formatter returned.
//   4. The injected formatter genuinely REACHES THE GEOMETRY: a formatter that
//      returns a longer string makes the label box wider, which moves the
//      fitted pitch. That is the half that could silently not happen.
//   5. `labelOptionsFrom` reads the two new settings with the absent-means-X
//      split, and passes the injected fields through untouched.
//   6. The layout and the tooltip are formatted by the SAME function, or a node
//      drawn "255.0 TWh" tooltips as "255" -- the defect formatTotal is shared
//      to prevent.
//   7. capabilities.json declares both new properties, and visual.ts builds the
//      formatter and hands it to BOTH the chrome and render (source-level, like
//      warnings-check section 9: there is no fake host to drive update() with).

const fs = require("fs");
const path = require("path");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

class FakeElement {
    constructor(tag) { this.tag = tag; this.attributes = {}; this.childNodes = []; this.style = {}; }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    appendChild(c) { this.childNodes.push(c); return c; }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const { formatTotal, totalOf, nodeTooltipRows, summariseNodes } = require("./lib/tooltips.js");
const { labelOptionsFrom } = require("./render-api.js");
const { computeLayout, labelLinesOf } = require("./layout-api.js");
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");

const ROOT = path.join(__dirname, "..");

// ------------------------------------------------------- 1-3. formatTotal
console.log("\n-- 1-3. formatTotal takes the formatter it is given --");
const BASE = { nodeTotals: true, basis: "Larger", units: "", decimalPlaces: 0 };

check("the injected formatter is what formats the number",
    formatTotal(1234.5, { ...BASE, formatValue: () => "1,2 tn kr" }) === "1,2 tn kr",
    formatTotal(1234.5, { ...BASE, formatValue: () => "1,2 tn kr" }));

check("no formatter falls back to the fallback path",
    formatTotal(1234.5, { ...BASE, decimalPlaces: 1 })
    === (1234.5).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    formatTotal(1234.5, { ...BASE, decimalPlaces: 1 }));
check("...and the fallback still honours decimalPlaces",
    formatTotal(2, { ...BASE, decimalPlaces: 2 }).includes("2.00")
    || formatTotal(2, { ...BASE, decimalPlaces: 2 }).includes("2,00"),
    formatTotal(2, { ...BASE, decimalPlaces: 2 }));

check("the units suffix is appended to whatever the formatter returned",
    formatTotal(5, { ...BASE, units: "TWh", formatValue: () => "5.0" }) === "5.0 TWh");
check("an empty units string adds no trailing space",
    formatTotal(5, { ...BASE, units: "", formatValue: () => "5.0" }) === "5.0");
// The formatter is handed the raw number, not a pre-rounded one: rounding is
// the formatter's job and doing it twice is how a 0.5 lands on the wrong side.
let seen;
formatTotal(1234.5678, { ...BASE, formatValue: (v) => { seen = v; return "x"; } });
check("the formatter receives the unrounded value", seen === 1234.5678, String(seen));

// ------------------------------------- 4. the formatter reaches the geometry
console.log("\n-- 4. an injected formatter moves the drawing --");
const FLOWS = [
    { rowIndex: 0, flowID: "f1", source: "Kärnbränsle", target: "Kärnkraft", value: 1234.5678 },
    { rowIndex: 1, flowID: "f2", source: "Kärnkraft", target: "Elnät", value: 1234.5678 }
];
const { corridors } = inferCorridors(FLOWS);
const { graph } = buildGraph(FLOWS, undefined, undefined, corridors);

function layoutWith(labels) {
    return computeLayout(graph, corridors, 1200, 800, {
        legendVisible: false, legendPosition: "Bottom", nodeShape: "Rectangle",
        nodeMinWidthPercent: 3, nodeMinHeightPercent: 3, labels
    });
}
const short = layoutWith({ ...BASE, formatValue: () => "1" });
const long = layoutWith({ ...BASE, formatValue: () => "1 234 567,89 miljoner kronor" });
const fallback = layoutWith({ ...BASE });

const widthOf = (l) => Math.max(...[...l.nodes.values()].map(n => n.labelBoxWidth ?? 0));
check("a longer formatted total makes the label box wider",
    widthOf(long) > widthOf(short) + 50,
    `${widthOf(short).toFixed(1)} -> ${widthOf(long).toFixed(1)}`);
check("...and that moves the fitted pitch, so it is a GEOMETRY input",
    Math.abs(long.rowPitch - short.rowPitch) > 0.01 || Math.abs(long.columnGap - short.columnGap) > 0.01,
    `gap ${short.columnGap.toFixed(2)} -> ${long.columnGap.toFixed(2)}`);
check("no formatter at all still lays out (the fallback path is live)",
    Number.isFinite(fallback.columnGap) && fallback.columnGap > 0,
    `gap ${fallback.columnGap.toFixed(2)}`);

// The text the layout measured must be the text render will draw.
const node = [...long.nodes.values()].find(n => n.id === "Kärnkraft");
const drawn = labelLinesOf(node, { ...BASE, formatValue: () => "1 234 567,89 miljoner kronor" },
    true, "1 234 567,89 miljoner kronor").lines.map(l => l.text);
check("the formatted total is the text actually drawn",
    drawn.includes("1 234 567,89 miljoner kronor"), drawn.join(" | "));

// --------------------------------------------------- 5. labelOptionsFrom
console.log("\n-- 5. the absent-means-X split --");
function settings(over) {
    return {
        labelsCard: {
            showNodeTotals: { value: true },
            totalBasis: { value: { value: "Larger" } }
        },
        // The number format moved to its own card -- it is read by
        // node totals, flow labels AND tooltips, and lived only on Labels.
        valuesCard: {
            units: { value: "" },
            decimalPlaces: { value: 1 },
            ...over
        }
    };
}
const bare = labelOptionsFrom(settings({}));
check("a settings object with no displayUnits reads as None",
    bare.displayUnits === "None", String(bare.displayUnits));
check("a settings object with no autoDecimals reads as false",
    bare.autoDecimals === false, String(bare.autoDecimals));
const set = labelOptionsFrom(settings({
    displayUnits: { value: { value: "Millions" } },
    autoDecimals: { value: true }
}));
check("and both are read when they are there",
    set.displayUnits === "Millions" && set.autoDecimals === true,
    `${set.displayUnits} / ${set.autoDecimals}`);
const passed = labelOptionsFrom(settings({}), {
    valueFormat: '#,##0 "kr"', locale: "sv-SE", formatValue: () => "x"
});
check("the injected fields pass through untouched",
    passed.valueFormat === '#,##0 "kr"' && passed.locale === "sv-SE"
    && passed.formatValue(1) === "x",
    `${passed.valueFormat} / ${passed.locale}`);
check("...and do not disturb what the pane said",
    passed.nodeTotals === true && passed.decimalPlaces === 1);
// The whole point of the split: the SETTING defaults to Auto/on, the ABSENT
// field to None/off. The settings defaults live in settings.ts, so they are
// asserted there rather than inferred here.
const src = require("./sources.js").settingsSource();
check("the display-units SETTING defaults to Auto, unlike the absent field",
    /displayUnits[\s\S]{0,400}?value: DISPLAY_UNITS_OPTIONS\[0\] \/\/ Auto/.test(src));
check("the automatic-decimals SETTING defaults to on",
    /autoDecimals = new formattingSettings\.ToggleSwitch\(\{[\s\S]{0,400}?value: true/.test(src));

// ------------------------------------------- 6. the layout and the tooltip
console.log("\n-- 6. the label and its tooltip agree --");
const labels = { ...BASE, units: "TWh", formatValue: (v) => `<<${v.toFixed(3)}>>` };
// The summary is what carries the figures, so it has to be the real one --
// handing nodeTooltipRows `undefined` produced empty rows and the assertion
// passed by measuring nothing, which is how this one was caught.
const summaries = summariseNodes(corridors);
const kärnkraft = [...long.nodes.values()].find(n => n.id === "Kärnkraft");
const rows = nodeTooltipRows(kärnkraft, summaries.get("Kärnkraft"), labels,
    { totals: true, byFlowType: false, byConnection: false }, []);
const shownInTooltip = rows.map(r => r.value).filter(v => v !== "");
check("the tooltip found figures to format at all (non-vacuous)",
    shownInTooltip.length > 0, `${shownInTooltip.length} figures`);
check("every tooltip figure comes from the same formatter as the label",
    shownInTooltip.every(v => v.startsWith("<<")), shownInTooltip.join(" | "));
check("...and the node's own total reads identically in both",
    shownInTooltip.includes(formatTotal(totalOf(kärnkraft, "Larger"), labels)),
    `${formatTotal(totalOf(kärnkraft, "Larger"), labels)} vs ${shownInTooltip.join(" | ")}`);

// --------------------------------------------- 7. declaration and wiring
console.log("\n-- 7. the declaration and the wiring --");
const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
const props = cap.objects.numbers.properties;
check("capabilities.json declares displayUnits as an enumeration of 6",
    props.displayUnits && props.displayUnits.type.enumeration
    && props.displayUnits.type.enumeration.length === 6,
    props.displayUnits ? String(props.displayUnits.type.enumeration.length) : "absent");
check("capabilities.json declares autoDecimals",
    props.autoDecimals !== undefined && props.autoDecimals.type.bool === true);
check("the enumeration values match the type in model.ts",
    props.displayUnits.type.enumeration.map(e => e.value).join(",")
    === "Auto,None,Thousands,Millions,Billions,Trillions",
    props.displayUnits.type.enumeration.map(e => e.value).join(","));

const visual = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");
check("visual.ts reads the Value field's format string",
    /valueFormatOf\(dataView\)/.test(visual));
check("...and the report's locale from the host, not the browser",
    /locale: this\.host\.locale/.test(visual));
check("...and builds one formatter per update",
    (visual.match(/valueFormatterFor\(/g) || []).length === 1,
    `${(visual.match(/valueFormatterFor\(/g) || []).length} call sites`);
// Matched as an ARGUMENT rather than as the LAST one: arguments have been added
// after it TWICE now -- package I's flow-label input, then flow-type
// labels -- so `numbers);` went stale and then `numbers)` did too. Hence the
// word boundary rather than a closing paren or a comma: `numbers` may yet
// become the last argument again.
check("the SAME formatter goes to the layout chrome and to render",
    /labelOptionsFrom\(this\.formattingSettings, numbers\b/.test(visual)
    && /\n\s+numbers[,)]/.test(visual));
check("Auto display units are chosen from the diagram's largest figure",
    /largest = Math\.max\(largest, Math\.abs\(node\.inflow\), Math\.abs\(node\.outflow\)\)/.test(visual));
// nodePart already carries inflow and outflow, so `largest` cannot change
// without the geometry key changing -- which is why it needs no key input.
const key = fs.readFileSync(path.join(ROOT, "src", "geometryKey.ts"), "utf8");
check("the key already covers what Auto units are derived from",
    /node\.inflow,/.test(key) && /node\.outflow,/.test(key));
// And the module boundary that makes the injection necessary in the first place.
const requireable = ["layout", "render", "tooltips", "dataParsing", "model", "graph",
    "corridors", "routing", "colours", "positions", "layers", "order", "separate",
    "overlap", "straighten", "geometryKey", "nodeEdits", "background", "interaction",
    "selection", "warnings"];
const leaked = requireable.filter(name => {
    const file = path.join(ROOT, "src", `${name}.ts`);
    return fs.existsSync(file)
        && fs.readFileSync(file, "utf8").includes("powerbi-visuals-utils-formattingutils");
});
check("no module the checks load imports the ESM-only library",
    leaked.length === 0, leaked.join(", ") || "none");

// --------------------------------------------------- 8. the dependency pin
console.log("\n-- 8. the library version is pinned, and why --");
{
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const range = pkg.dependencies["powerbi-visuals-utils-formattingutils"];
    check("formattingutils is a dependency at all", range !== undefined, String(range));
    // **Exact, not a caret.** 7.0.0 ships the globalize locale table as ESM,
    // and pbiviz 7.2.1's localizationLoader `eval`s that exact file to trim it
    // to the shipped locales -- so 7.0.0 fails `pbiviz package` with
    // "SyntaxError: Unexpected token 'export'" while compiling and linting
    // perfectly happily. A caret range would bring that back on any fresh
    // install, and it does not show up until packaging.
    check("...pinned exactly, not a caret range",
        /^\d+\.\d+\.\d+$/.test(range), String(range));
    check("...to a 6.x, whose locale table the toolchain's loader can read",
        range.startsWith("6."), String(range));
    // And the reason, in the file the loader actually reads.
    const locales = path.join(ROOT, "node_modules", "powerbi-visuals-utils-formattingutils",
        "lib", "globalize", "powerbiGlobalizeLocales.js");
    if (fs.existsSync(locales)) {
        const head = fs.readFileSync(locales, "utf8").slice(0, 200);
        check("the installed locale table is CommonJS, which is what makes it loadable",
            /exports\.locales/.test(head) && !/^\s*export /m.test(head),
            head.split("\n")[0]);
    } else {
        check("the installed locale table is CommonJS, which is what makes it loadable",
            false, "powerbiGlobalizeLocales.js not found");
    }
}

console.log(`\n${assertions} assertions, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
