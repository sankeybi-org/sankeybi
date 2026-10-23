"use strict";
// The hand-tuned layout, as one file.
//
// The placement IS the deliverable on this visual, and until now every blob
// describing it lived in a hidden property the author could not see, copy, back
// up, diff or move. A layout could be destroyed by one wrong toggle with no way
// back, and taking a diagram to next year's report meant rebuilding it.
//
// What is asserted:
//
//   1. **The round trip is exact.** Every node placement, route override,
//      locked grid and node edit survives serialise -> parse unchanged. That is
//      the whole promise; anything less makes the file a trap.
//   2. It is readable: real JSON, with the blobs as objects rather than escaped
//      strings, so a diff shows which node moved.
//   3. The background picture is NOT in it.
//   4. Nothing trusts the file: rubbish, truncated JSON, a missing marker and a
//      newer format version are each refused with a message that says what to
//      do, and a file with one DAMAGED field still restores the other three --
//      the same bargain the hidden blobs already make.
//   5. The WIRING, which is the half that can silently not happen: the panel is
//      given a reader and a writer, and applying a file persists all four blobs
//      in ONE call -- two would redraw the diagram halfway between two layouts.

const fs = require("fs");
const path = require("path");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const { serialiseLayoutFile, parseLayoutFile, LAYOUT_FILE_VERSION } = require("./lib/layoutFile.js");
const positions = require("./lib/positions.js");
const nodeEdits = require("./lib/nodeEdits.js");

const ROOT = path.join(__dirname, "..");

// A layout with something of every kind in it.
const NODES = positions.parseNodePositions(JSON.stringify({
    "Kärnkraft": [2, 3.25],
    "Elnät": [3, 1.5, 1],
    "Förluster kärnkraft": [2.5, 1]
}));
const ROUTES = positions.parseRouteOverrides(JSON.stringify({
    "A->B": { s: [1.5, 2], t: [2.5, 2.25], m: [2, 2.5], r: 0.35, c: 35 },
    "B->C": { d: [3.5, 4] }
}));
const GRID = positions.parseGridWindow(JSON.stringify([1, 8.25, 0.5, 6]));
const EDITS = nodeEdits.parseNodeEdits(JSON.stringify({
    "Kärnkraft": { l: "Nuclear power", h: 0, o: "South", c: "#2E7D32" },
    "Elnät": { i: "", n: "North" }
}));

// ------------------------------------------------------- 1. the round trip
console.log("\n-- 1. the round trip is exact --");
{
    const text = serialiseLayoutFile({ nodes: NODES, routes: ROUTES, grid: GRID, edits: EDITS });
    const back = parseLayoutFile(text);
    check("a file written by the visual is accepted", back.message === undefined,
        back.message ?? "accepted");
    check("the fixture has something of every kind in it (non-vacuous)",
        NODES.size === 3 && ROUTES.size === 2 && EDITS.size === 2 && GRID !== undefined,
        `${NODES.size} nodes, ${ROUTES.size} routes, ${EDITS.size} edits`);

    // Compared through the serialisers: those are what the stored properties
    // hold, so equality there IS equality of what the report will keep.
    check("every node placement survives",
        positions.serialiseNodePositions(back.contents.nodes)
        === positions.serialiseNodePositions(NODES),
        positions.serialiseNodePositions(back.contents.nodes));
    check("...including the auto-placement marker, which decides whether the next press is a no-op",
        positions.serialiseNodePositions(back.contents.nodes).includes("1]"),
        positions.serialiseNodePositions(back.contents.nodes));
    check("every route override survives, radius and Curvature stamp included",
        positions.serialiseRouteOverrides(back.contents.routes)
        === positions.serialiseRouteOverrides(ROUTES),
        positions.serialiseRouteOverrides(back.contents.routes));
    check("the detour lane survives",
        positions.serialiseRouteOverrides(back.contents.routes).includes('"d"'),
        positions.serialiseRouteOverrides(back.contents.routes));
    check("the locked grid survives",
        positions.serialiseGridWindow(back.contents.grid) === positions.serialiseGridWindow(GRID),
        positions.serialiseGridWindow(back.contents.grid));
    check("every node edit survives",
        nodeEdits.serialiseNodeEdits(back.contents.edits) === nodeEdits.serialiseNodeEdits(EDITS),
        nodeEdits.serialiseNodeEdits(back.contents.edits));
    check("and the summary reports what was found",
        back.summary.nodes === 3 && back.summary.routes === 2
        && back.summary.edits === 2 && back.summary.grid === true,
        JSON.stringify(back.summary));

    // Twice through is still the same, which is what makes it safe to keep in
    // source control and paste back repeatedly.
    const twice = serialiseLayoutFile(back.contents);
    check("a second round trip is byte-identical", twice === text);
}

// ------------------------------------------------------- 2-3. what it looks like
console.log("\n-- 2-3. readable, and no picture in it --");
{
    const text = serialiseLayoutFile({ nodes: NODES, routes: ROUTES, grid: GRID, edits: EDITS });
    const raw = JSON.parse(text);
    check("it is real JSON with a version marker",
        raw.sankeybiLayout === LAYOUT_FILE_VERSION, String(raw.sankeybiLayout));
    check("the blobs are embedded as OBJECTS, not escaped strings",
        typeof raw.nodes === "object" && typeof raw.routes === "object"
        && typeof raw.nodeEdits === "object",
        `${typeof raw.nodes} / ${typeof raw.routes} / ${typeof raw.nodeEdits}`);
    check("...so a node's placement is legible in the file",
        Array.isArray(raw.nodes["Kärnkraft"]) && raw.nodes["Kärnkraft"][0] === 2,
        JSON.stringify(raw.nodes["Kärnkraft"]));
    check("it is pretty-printed, so a diff is useful", text.includes("\n  \""));
    check("the background picture is not in it",
        !/image|base64|background/i.test(text));
    // Measured rather than guessed: pretty-printing per NODE is what makes a
    // diff say which node moved, and it costs about twenty lines a node -- 60
    // for this three-node fixture, so a 29-node diagram like a real diagram runs to a
    // few hundred lines and a few kilobytes. That is nothing for a textarea or
    // for source control, which is the bound that actually matters.
    check("a layout file stays small enough to paste",
        text.length < 4000,
        `${text.length} characters over ${text.split("\n").length} lines, for 3 nodes`);
}

// ------------------------------------------------- 4. nothing trusts the file
console.log("\n-- 4. what it refuses, and what it rescues --");
{
    const refused = (text, what) => {
        const r = parseLayoutFile(text);
        check(`${what} is refused with a message`,
            r.message !== undefined && r.message.length > 10 && r.contents === undefined,
            r.message);
    };
    refused("", "an empty box");
    refused("   ", "whitespace");
    refused("not json at all", "text that is not JSON");
    refused('{"sankeybiLayout": 1, "nodes": {', "truncated JSON");
    refused('{"nodes": {}}', "JSON with no version marker");
    refused("[1,2,3]", "a JSON array");
    refused('"a string"', "a JSON string");
    refused(`{"sankeybiLayout": ${LAYOUT_FILE_VERSION + 1}}`, "a file from a newer SankeyBI");

    // A DAMAGED field must not lose the others: the per-field parsers are total.
    const good = serialiseLayoutFile({ nodes: NODES, routes: ROUTES, grid: GRID, edits: EDITS });
    const mangled = JSON.parse(good);
    mangled.routes = "complete nonsense";
    const rescued = parseLayoutFile(JSON.stringify(mangled));
    check("a file with one damaged field still restores the other three",
        rescued.message === undefined
        && rescued.summary.nodes === 3 && rescued.summary.edits === 2
        && rescued.summary.grid === true && rescued.summary.routes === 0,
        JSON.stringify(rescued.summary));
    // And an absent field is simply nothing stored, not an error.
    const sparse = parseLayoutFile(`{"sankeybiLayout": ${LAYOUT_FILE_VERSION}}`);
    check("a file with nothing in it parses to an empty layout",
        sparse.message === undefined && sparse.summary.nodes === 0
        && sparse.summary.routes === 0 && sparse.summary.edits === 0
        && sparse.summary.grid === false,
        JSON.stringify(sparse.summary));
    // A blob that is not JSON is carried through verbatim rather than dropped.
    const asString = parseLayoutFile(JSON.stringify({
        sankeybiLayout: LAYOUT_FILE_VERSION,
        nodes: positions.serialiseNodePositions(NODES)
    }));
    check("a blob embedded as a STRING is read too",
        asString.message === undefined && asString.summary.nodes === 3,
        JSON.stringify(asString.summary));
}

// --------------------------------------------------------------- 5. the wiring
console.log("\n-- 5. the panel and the persist --");
{
    const panel = fs.readFileSync(path.join(ROOT, "src", "layoutFilePanel.ts"), "utf8");
    const nodePanel = fs.readFileSync(path.join(ROOT, "src", "nodeEditorPanel.ts"), "utf8");
    const flowPanel = fs.readFileSync(path.join(ROOT, "src", "flowColourPanel.ts"), "utf8");
    const settings = require("./sources.js").settingsSource();
    const caps = fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8");
    const visual = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");
    check("the layout file has its own panel",
        /class LayoutFilePanel/.test(panel) && /textarea/.test(panel) && /Layout file/.test(panel));
    check("...and holds no rules of its own: it reads and writes through callbacks",
        /this\.file\.read\(\)/.test(panel) && /this\.file\.write\(this\.text\.value\)/.test(panel)
        && !/sankeybiLayout/.test(panel));
    check("...and shows a failure IN the panel rather than throwing it away",
        /this\.error\.textContent = this\.file\.write\(this\.text\.value\) \?\? ""/.test(panel));
    check("...and refills from the stored layout every time it opens",
        /public open\(\): void \{\s*this\.text\.value = this\.file\.read\(\)/.test(panel));

    // earlier: it left the node editor, and became a switch under Arrange.
    check("the node editor no longer carries the layout file",
        !/Layout file/.test(nodePanel) && !/textarea/.test(nodePanel) && !/layoutFile|LayoutFile/.test(nodePanel));
    check("Arrange has a Layout file group with the switch, declared in `positions`",
        /group\("arrangeFile", "Layout file", \[this\.layoutFile\]\)/.test(settings)
        && /"positions": \{[\s\S]*?"layoutFile": \{[\s\S]*?"bool": true/.test(caps));
    check("the switch opens the panel and writes itself straight back off",
        /positionsCard\.layoutFile\.value\) \{\s*this\.openEditorPanel\("file"\);[\s\S]{0,200}?layoutFile: false/.test(visual));

    // "lets not stack them": the three edit panels are never open together.
    const opener = /private openEditorPanel\(which: "nodes" \| "flows" \| "file"\): void \{[\s\S]*?\n    \}/
        .exec(visual);
    check("opening one edit panel closes the other two",
        opener !== null && /this\.nodeEditorPanel\.close\(\);\s*this\.flowColourPanel\.close\(\);\s*this\.layoutFilePanel\.close\(\);/
            .test(opener[0]));
    check("...and all three switches go through it, none opens a panel directly",
        (visual.match(/this\.openEditorPanel\(/g) || []).length === 3
        && !/this\.nodeEditorPanel\.open\(\)/.test(visual.replace(opener ? opener[0] : "", ""))
        && !/this\.flowColourPanel\.open\(\)/.test(visual.replace(opener ? opener[0] : "", "")));
    check("the panels expose close() for it",
        /public close\(\): void/.test(nodePanel) && /public close\(\): void/.test(flowPanel));
    check("visual.ts gives the panel a reader and a writer",
        /read: \(\) => serialiseLayoutFile\(/.test(visual)
        && /write: text => this\.applyLayoutFile\(text\)/.test(visual));
    // ONE persist: four blobs that describe one layout have to land together.
    const apply = /private applyLayoutFile\(text: string\): string \| undefined \{[\s\S]*?\n    \}/
        .exec(visual);
    check("applying a file persists in exactly ONE call",
        apply !== null && (apply[0].match(/persistProperties/g) || []).length === 1,
        apply ? `${(apply[0].match(/persistProperties/g) || []).length} calls` : "method not found");
    check("...covering all four blobs",
        apply !== null && /nodes: serialiseNodePositions/.test(apply[0])
        && /routes: serialiseRouteOverrides/.test(apply[0])
        && /grid: serialiseGridWindow/.test(apply[0])
        && /edits: serialiseNodeEdits/.test(apply[0]));
    check("...and leaves cachedEditsRaw alone, so the update rebuilds the graph",
        apply !== null && !/this.cachedEditsRaws*=/.test(apply[0]));
}

console.log(`\n${assertions} assertions, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
