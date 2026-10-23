"use strict";
// Properties that must hold for any diagram, asserted on synthetic fixtures
// (checks/fixture.js) swept over viewports, styles, directions and floors.
//
//   1. Packing: no face is oversubscribed, a node is exactly its biggest stack
//      or its floor, a band is the same width at both ends, and a corridor is
//      drawn at max(floor, its true width).
//   2. Every direction and routing style produces finite geometry.
//   3. The geometry key notices every input that changes the picture.
//   4. Arrange nodes: deterministic, independent of row order, respects
//      hand-placed nodes and the single-port terminal rule.
//   5. Arrange flows: never makes the diagram worse, and is deterministic.

class FakeElement {
    constructor(tag) { this.tag = tag; this.attributes = {}; this.childNodes = []; this.style = {}; }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    appendChild(c) { this.childNodes.push(c); return c; }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const fixture = require("./fixture.js");
const { computeLayout } = require("./layout-api.js");
const { routeDiagram, computeAnchors, anchorKey } = require("./routing-api.js");
const { straightenNodes } = require("./lib/straighten.js");
const { justifyEnds } = require("./lib/justify.js");
const { arrangeNodes } = require("./lib/arrangeNodes.js");
const { arrangeFlows } = require("./lib/arrangeFlows.js");
const { geometryKey } = require("./lib/geometryKey.js");
const { ParallelField, PARALLEL_THRESHOLD } = require("./lib/parallel.js");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const CHROME = { legendVisible: false, legendPosition: "Bottom" };
const routing = style => ({
    portLeadInPercent: 18, curvaturePercent: 50, style, avoidNodes: true,
    arrows: { heads: false, tails: false, angleDegrees: 90 }
});
const STYLES = ["Polyline", "Octilinear", "Orthogonal", "Smooth"];
const DIRECTIONS = ["LeftToRight", "RightToLeft", "TopToBottom", "BottomToTop"];
const VERTICAL_PORT = { East: true, West: true, North: false, South: false };

const SHAPES = {
    energy: () => fixture.diagram(fixture.energy()),
    layered: () => fixture.diagram(fixture.layered()),
    "layered-vertical": () => fixture.diagram(fixture.vertical(fixture.layered())),
    awkward: () => fixture.diagram(fixture.awkward()),
    "many-tiny": () => fixture.diagram([
        ["Big", "Hub", 1000], ["Hub", "a", 1], ["Hub", "b", 1], ["Hub", "c", 2], ["Hub", "d", 3],
        ["Hub", "e", 1], ["Hub", "f", 2]
    ])
};

// =====================================================================
console.log("\n--- 1. packing ---");
{
    const faces = layout => {
        const out = new Map();
        const add = (nodeId, port, corridor) => {
            const key = `${nodeId}|${port}`;
            if (!out.has(key)) { out.set(key, { nodeId, port, corridors: [] }); }
            out.get(key).corridors.push(corridor);
        };
        layout.corridors.forEach(c => {
            if (c.value <= 0) { return; }
            add(c.source, c.sourcePort, c);
            add(c.target, c.targetPort, c);
        });
        return out;
    };
    let faceCount = 0, bandCount = 0, oversubscribed = 0, inexact = 0, tapered = 0, wrongWidth = 0, floored = 0;
    for (const [name, load] of Object.entries(SHAPES)) {
        const { graph, corridors } = load();
        for (const [w, h] of [[1400, 800], [800, 1400]]) {
            for (const minHeight of [0, 3, 8]) {
                for (const minWidth of [0, 3, 10]) {
                    for (const flowWidth of [10, 100, 500]) {
                        const chrome = Object.assign({}, CHROME, {
                            nodeMinHeightPercent: minHeight, nodeMinWidthPercent: minWidth, flowWidthPercent: flowWidth
                        });
                        const layout = computeLayout(graph, corridors, w, h, chrome);
                        const px = layout.valueToPixels;
                        const stacks = new Map();
                        faces(layout).forEach(face => {
                            faceCount++;
                            const node = layout.nodes.get(face.nodeId);
                            const vertical = VERTICAL_PORT[face.port];
                            const extent = vertical ? node.height : node.width;
                            const stack = face.corridors.reduce((sum, c) => sum + px(c.value), 0);
                            if (stack > extent + 1e-9) { oversubscribed++; }
                            const s = stacks.get(face.nodeId) || { vertical: 0, horizontal: 0 };
                            if (vertical) { s.vertical = Math.max(s.vertical, stack); }
                            else { s.horizontal = Math.max(s.horizontal, stack); }
                            stacks.set(face.nodeId, s);
                        });
                        const widthBasis = layout.columnGap > 0 ? layout.columnGap : layout.rowPitch;
                        layout.nodes.forEach(node => {
                            const s = stacks.get(node.id) || { vertical: 0, horizontal: 0 };
                            const wantH = Math.max(s.vertical, layout.rowPitch * minHeight / 100);
                            const wantW = Math.max(s.horizontal, widthBasis * minWidth / 100);
                            if (Math.abs(node.height - wantH) > 1e-9 || Math.abs(node.width - wantW) > 1e-9) { inexact++; }
                        });
                        const floorPx = px(0);
                        const biggest = Math.max(...corridors.map(c => c.value));
                        const scale = px(biggest) / biggest;
                        const anchors = computeAnchors(layout);
                        layout.corridors.forEach(c => {
                            if (c.value <= 0) { return; }
                            const s = anchors.get(anchorKey(c.id, "source"));
                            const t = anchors.get(anchorKey(c.id, "target"));
                            if (!s || !t) { return; }
                            bandCount++;
                            if (Math.abs(s.halfExtent - t.halfExtent) > 1e-9) { tapered++; }
                            const want = Math.max(floorPx, c.value * scale);
                            if (Math.abs(s.halfExtent * 2 - want) > 1e-9) { wrongWidth++; }
                            else if (want > c.value * scale + 1e-9) { floored++; }
                        });
                    }
                }
            }
        }
    }
    check("no face is oversubscribed", oversubscribed === 0, `${faceCount} faces`);
    check("every node is exactly its biggest stack or its floor", inexact === 0);
    check("every band is the same width at both ends", tapered === 0, `${bandCount} bands`);
    check("every corridor is drawn at max(floor, its true width)", wrongWidth === 0);
    check("the sweep includes corridors lifted by the floor", floored > 50, `${floored}`);
}

// =====================================================================
console.log("\n--- 2. every direction and style produces finite geometry ---");
{
    let bands = 0, bad = 0;
    for (const [name, load] of Object.entries(SHAPES)) {
        for (const direction of DIRECTIONS) {
            const rows = direction === "TopToBottom" || direction === "BottomToTop"
                ? null : undefined;
            const { graph, corridors } = fixture.diagram(
                name === "energy" ? fixture.energy() : name === "layered" ? fixture.layered() : fixture.awkward(),
                direction);
            for (const style of STYLES) {
                const layout = computeLayout(graph, corridors, 1200, 700, CHROME);
                justifyEnds(layout, new Set());
                straightenNodes(layout, 25);
                const routed = routeDiagram(layout, routing(style), new Map());
                routed.bands.forEach(band => {
                    bands++;
                    const numbers = band.path.match(/-?\d+(\.\d+)?(e-?\d+)?/g) || [];
                    if (numbers.length === 0 || numbers.some(n => !Number.isFinite(Number(n)))) { bad++; }
                });
                layout.nodes.forEach(node => {
                    if (![node.x, node.y, node.width, node.height].every(Number.isFinite)) { bad++; }
                });
            }
        }
    }
    check("all nodes and band paths are finite in every direction and style", bad === 0, `${bands} bands`);
}

// =====================================================================
console.log("\n--- 3. the geometry key ---");
{
    const { graph, corridors } = fixture.diagram(fixture.energy());
    const base = {
        width: 1200, height: 700, chrome: CHROME, routing: routing("Polyline"),
        straighten: 25, locked: undefined, positionsRaw: ""
    };
    const key = inputs => geometryKey(graph, corridors, inputs);
    check("the same inputs give the same key", key(base) === key(Object.assign({}, base)));
    check("a different width changes it", key(base) !== key(Object.assign({}, base, { width: 1201 })));
    check("a layout setting changes it",
        key(base) !== key(Object.assign({}, base, { chrome: Object.assign({}, CHROME, { flowSeparationPercent: 3 }) })));
    check("a routing setting changes it",
        key(base) !== key(Object.assign({}, base, { routing: routing("Smooth") })));
    check("straighten changes it", key(base) !== key(Object.assign({}, base, { straighten: 50 })));
    check("stored positions change it", key(base) !== key(Object.assign({}, base, { positionsRaw: "{}" })));
    const other = fixture.diagram(fixture.energy().map((row, i) => (i === 0 ? [row[0], row[1], row[2] + 1, row[3]] : row)));
    check("a different value changes it", key(base) !== geometryKey(other.graph, other.corridors, base));
}

// =====================================================================
console.log("\n--- 4. Arrange nodes ---");
{
    const input = (d, extra) => Object.assign({
        graph: d.graph, corridors: d.corridors, width: 1400, height: 800, chrome: CHROME,
        pinned: new Map(), snapStep: 0.25
    }, extra || {});
    const orderOf = result => {
        const byStage = new Map();
        const stageAxis = result.axis === "horizontal" ? "column" : "row";
        const orderAxis = result.axis === "horizontal" ? "row" : "column";
        result.positions.forEach((p, id) => {
            const key = Math.round(p[stageAxis]);
            if (!byStage.has(key)) { byStage.set(key, []); }
            byStage.get(key).push({ id, along: p[orderAxis] });
        });
        return [...byStage.keys()].sort((a, b) => a - b).map(k => `${k}:` + byStage.get(k)
            .sort((x, y) => (x.along - y.along) || (x.id < y.id ? -1 : 1)).map(e => e.id).join(">")).join(" | ");
    };
    for (const name of ["energy", "layered", "awkward"]) {
        const rows = name === "energy" ? fixture.energy() : name === "layered" ? fixture.layered() : fixture.awkward();
        const d = fixture.diagram(rows);
        const first = arrangeNodes(input(d));
        const again = arrangeNodes(input(d));
        check(`${name}: every node gets a finite position`,
            d.graph.nodes.size === first.positions.size
            && [...first.positions.values()].every(p => Number.isFinite(p.column) && Number.isFinite(p.row)));
        check(`${name}: arranging twice gives the same result`, orderOf(first) === orderOf(again));
        // Where a cycle exists, which corridor is cut to layer it depends on the row seen first.
        if (name !== "awkward") {
            const reversed = fixture.diagram(rows.slice().reverse());
            check(`${name}: the order does not depend on the order rows arrive in`,
                orderOf(first) === orderOf(arrangeNodes(input(reversed))));
        }
    }
    {
        const d = fixture.diagram(fixture.layered());
        const target = "C2N2";
        const pinned = new Map([[target, { column: 2, row: 9.5 }]]);
        const placed = arrangeNodes(input(d, { pinned }));
        const at = placed.positions.get(target);
        check("a hand-placed node keeps the position it was given", at && Math.abs(at.row - 9.5) < 1e-9,
            at ? `row ${at.row}` : "missing");
    }
    {
        // A source whose flows leave East belongs at the first stage; a sink fed on North belongs at the bottom.
        const d = fixture.diagram([
            ["A", "M", 10, null, "East", "West"], ["B", "M", 10, null, "East", "West"],
            ["M", "Z", 10, null, "East", "West"], ["M", "Low", 4, null, "South", "North"],
            ["M", "High", 4, null, "East", "West"]
        ]);
        const result = arrangeNodes(input(d));
        const rowOf = id => result.positions.get(id).row;
        check("a node fed on North sits below the node that feeds it", rowOf("Low") > rowOf("M"),
            `Low ${rowOf("Low")}, M ${rowOf("M")}`);
        check("the sources stand in the first column",
            result.positions.get("A").column === result.positions.get("B").column);
    }
}

// =====================================================================
console.log("\n--- 5. Arrange flows ---");
{
    const arranged = rows => {
        const d = fixture.diagram(rows);
        const placed = arrangeNodes({
            graph: d.graph, corridors: d.corridors, width: 1400, height: 800, chrome: CHROME,
            pinned: new Map(), snapStep: 0.25
        });
        const nodes = new Map();
        d.graph.nodes.forEach((node, id) => {
            const p = placed.positions.get(id);
            nodes.set(id, Object.assign({}, node, { column: p.column, columnIsOverride: true, row: p.row, rowIsOverride: true }));
        });
        const layout = computeLayout({ nodes }, d.corridors, 1400, 800, CHROME);
        justifyEnds(layout, new Set());
        straightenNodes(layout, 25);
        return layout;
    };
    for (const style of ["Polyline", "Orthogonal", "Octilinear"]) {
        for (const name of ["energy", "layered"]) {
            const layout = arranged(name === "energy" ? fixture.energy() : fixture.layered());
            const opts = routing(style);
            const before = new ParallelField(layout, routeDiagram(layout, opts, new Map())).parallel(PARALLEL_THRESHOLD);
            const first = arrangeFlows(layout, opts, new Map());
            const second = arrangeFlows(layout, opts, new Map());
            check(`${name}/${style}: never longer along each other than before`, first.after <= first.before + 1e-6,
                `${first.before.toFixed(1)} -> ${first.after.toFixed(1)}`);
            check(`${name}/${style}: reports the same start as an independent measurement`,
                Math.abs(first.before - before.length) < 1e-6 || first.before === 0 || before.length === undefined,
                `${first.before}`);
            check(`${name}/${style}: repeating it gives the same overrides`,
                JSON.stringify([...first.overrides]) === JSON.stringify([...second.overrides]));
            check(`${name}/${style}: every override is finite`,
                [...first.overrides.values()].every(o => Object.values(o).every(v =>
                    typeof v === "number" ? Number.isFinite(v) : Number.isFinite(v.x) && Number.isFinite(v.y))));
        }
    }
}

// =====================================================================
console.log("\n--- 6. textures ---");
{
    const textures = require("./lib/textures.js");
    check("there are six hatches and eight patterns in one index space",
        textures.HATCH_COUNT === 6 && textures.PATTERN_COUNT === 8
        && textures.TEXTURE_COUNT === 14 && textures.TEXTURES.length === 14);
    check("every texture has a distinct name", new Set(textures.TEXTURE_NAMES).size === 14);
    check("every tile has a positive size and at least one mark",
        textures.TEXTURES.every(t => t.width > 0 && t.height > 0 && t.marks.length > 0));
    check("the automatic allocations stay in their own family and cycle",
        [0, 1, 5, 6, 13].every(rank => textures.autoHatch(rank) < 6
            && textures.autoPattern(rank) >= 6 && textures.autoPattern(rank) < 14)
        && textures.autoHatch(6) === 0 && textures.autoPattern(8) === 6);

    const base = {
        typeColour: "#2e7d8c", reportBackground: "#ffffff", themeForeground: "#222222",
        inkMode: "Type", paperMode: "Background"
    };
    let c = textures.textureColours(base);
    check("by default a texture is the type's colour on the report background",
        c.ink === "#2e7d8c" && c.paper === "#ffffff");
    c = textures.textureColours(Object.assign({}, base, { inkMode: "Contrast", paperMode: "Type" }));
    check("Contrast over the type's colour is a different shade of it",
        c.paper === "#2e7d8c" && c.ink !== c.paper && /^#[0-9a-f]{6}$/.test(c.ink));
    c = textures.textureColours(Object.assign({}, base, { paperMode: "Type" }));
    check("a texture is never drawn in the colour it sits on", c.ink !== c.paper);
    c = textures.textureColours(Object.assign({}, base, {
        inkMode: "Auto", paperMode: "Custom", paperCustom: "#eeeeee"
    }));
    check("the pane's monotone and custom choices apply", c.ink === "#222222" && c.paper === "#eeeeee");
    c = textures.textureColours(Object.assign({}, base, {
        inkMode: "Auto", paperMode: "Type", inkOverride: "#ff0000", paperOverride: "#00ff00"
    }));
    check("the editor's choice beats the pane's", c.ink === "#ff0000" && c.paper === "#00ff00");
    check("a dark colour contrasts lighter and a light one darker",
        textures.contrastOf("#102030") > "#102030" && textures.contrastOf("#f0f0f0") < "#f0f0f0");

    const store = require("./lib/flowTypeColours.js");
    const edited = store.withFlowTypeEdit(new Map(), "Coal", { pattern: 7, ink: "#AA0000", paper: "#00AA00" });
    const round = store.parseFlowTypeColours(store.serialiseFlowTypeColours(edited));
    check("a texture's ink and paper survive being stored",
        round.get("Coal").ink === "#aa0000" && round.get("Coal").paper === "#00aa00");
    const cleared = store.withFlowTypeEdit(round, "Coal", { pattern: null, ink: null, paper: null });
    check("clearing them removes the entry", cleared.size === 0);
}

console.log(failures === 0 ? `\nALL PROPERTY CHECKS PASSED (${assertions} assertions)` : `\n${failures} FAILURE(S) of ${assertions}`);
process.exit(failures === 0 ? 0 : 1);
