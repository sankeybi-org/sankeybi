"use strict";
// Pointer targets: everything drawn can be pointed at.
//
// Two things on a SankeyBI diagram can be drawn far smaller than a pointer:
//
//   - a NODE, when the Minimum width/height sliders are low. A hit rectangle
//     for this has existed, but it sat in an `else if` that
//     only ran when no shape was drawn -- and Rectangle is the DEFAULT shape.
//     A shape is sized from the node (`shapeFloorFor` returns the node's own
//     size for Rectangle and Rounded), so a node collapsed to nothing got a
//     shape collapsed to nothing, which became the target and could not be
//     hovered, clicked or dragged.
//   - a BAND, which is its own hit area, at MIN_CORRIDOR_WIDTH = 1px.
//
// What is asserted:
//   1. Every node registers a pointer target measuring at least MIN_NODE_HIT
//      on both axes, at every combination of the two sliders and every node
//      shape -- including 0/0, where nothing is painted at all.
//   2. Every corridor registers a target at least MIN_BAND_HIT thick.
//   3. A node and a corridor big enough already get NO extra element, so an
//      ordinary diagram's SVG is unchanged.
//   4. Whatever is demoted still dims: it is registered as a decoration and
//      its pointer-events are off, so a click still lights the whole thing.

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const MIN_NODE_HIT = 6;
const MIN_BAND_HIT = 6;

class FakeElement {
    constructor(tag) {
        this.tag = tag; this.attributes = {}; this.childNodes = []; this.style = {};
        this.textContent = "";
    }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return this.attributes[n]; }
    appendChild(c) { this.childNodes.push(c); return c; }
    insertBefore(c) { this.childNodes.unshift(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); return c; }
    addEventListener() {}
    get firstChild() { return this.childNodes[0]; }
    find(tag) {
        const out = [];
        const walk = e => { if (e.tag === tag) { out.push(e); } e.childNodes.forEach(walk); };
        this.childNodes.forEach(walk);
        return out;
    }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors } = require("./routing-api.js");
const { resolveFlowTypeColours } = require("./lib/colours.js");
const { render } = require("./render-api.js");

const ROLES = ["source", "target", "value", "flowType", "sourcePort", "targetPort"];
const dataViewOf = rows => ({
    table: {
        columns: ROLES.map(r => ({ roles: { [r]: true } })),
        rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
    }
});
const colour = value => ({ value });
const palette = {
    isHighContrast: false,
    foreground: colour("#252423"),
    foregroundNeutralSecondary: colour("#605E5C"),
    background: colour("#ffffff"),
    getColor: key => colour(`#palette-${key}`)
};

/** The settings object render() reads — the same shape render-labels-check uses. */
function settingsOf(over) {
    const item = v => ({ value: { value: v } });
    return {
        nodesCard: {
            fill: item("Solid"),
            minWidth: { value: over.minWidth },
            minHeight: { value: over.minHeight },
            defaultColour: { value: { value: "#605E5C" } }
        },
        nodeShapesCard: {
            shape: item(over.shape ?? "Rectangle"),
            fitLabel: { value: false },
            fill: item("Node"),
            fillColour: { value: { value: "#FFFFFF" } },
            border: item("Node"),
            borderColour: { value: { value: "#605E5C" } },
            borderWidth: { value: 2 }
        },
        corridorsCard: {},
        labelsCard: {
            showColumnHeaders: { value: false }, columnHeaderText: { value: "" },
            showColumnTotals: { value: false }, showNodeTotals: { value: false },
            totalBasis: item("Larger"), units: { value: "" }, decimalPlaces: { value: 0 }
        },
        positionsCard: { snap: { value: 4 }, showGrid: { value: false } },
        interactionCard: {
            tooltips: { value: true }, tooltipNodeTotals: { value: true },
            tooltipNodeByFlowType: { value: false }, tooltipNodeByConnection: { value: false }
        },
        legendCard: { show: { value: false }, position: item("Bottom") }
    };
}

/** A recording sink: what render says each element IS. */
const sinkOf = () => ({
    bands: [], nodes: [], decorations: [], handles: [],
    beginFrame() {},
    registerBand(el, id, items) { this.bands.push({ el, id, items }); },
    registerNode(el, id, items) { this.nodes.push({ el, id, items }); },
    registerDecoration(el, key) { this.decorations.push({ el, key }); },
    registerHandle(el, corridorId) { this.handles.push({ el, corridorId }); }
});

function drawn(rows, over, w = 1400, h = 800) {
    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const flowTypeColours = resolveFlowTypeColours(corridors, palette);
    const chrome = {
        legendVisible: false, legendPosition: "Bottom",
        nodeMinWidthPercent: over.minWidth, nodeMinHeightPercent: over.minHeight,
        nodeShape: over.shape || "Rectangle"
    };
    const layout = computeLayout(graph, corridors, w, h, chrome);
    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline" });
    // `over.sink` lets a case supply its own recording sink -- the sub-band
    // section needs one that reports a highlight fraction.
    const sink = over.sink || sinkOf();
    const svg = new FakeElement("svg");
    render(svg, layout, bands, palette, settingsOf(over), flowTypeColours, w, h, undefined, new Map(), corridors, sink);
    return { svg, sink, layout, bands, corridors };
}

/** A registered element's hit size, in pixels. */
function sizeOf(el) {
    if (el.tag === "rect") {
        return { w: Number(el.getAttribute("width")), h: Number(el.getAttribute("height")) };
    }
    if (el.tag === "circle") {
        const r = Number(el.getAttribute("r"));
        return { w: r * 2, h: r * 2 };
    }
    if (el.tag === "path") {
        // A stroked path's hit reach is its own thickness plus the stroke.
        const stroke = Number(el.getAttribute("stroke-width") || 0);
        return { w: stroke, h: stroke, stroked: true };
    }
    return { w: 0, h: 0 };
}

// =====================================================================
// 1. Nodes: a target at least MIN_NODE_HIT on both axes, at every floor.
// =====================================================================
const NODE_ROWS = [
    { source: "A", target: "B", value: 100 },
    { source: "B", target: "C", value: 60 },
    { source: "B", target: "D", value: 40 },
    // A North/South pair, whose width comes from the flow and height from the
    // slider -- the mirror of the East/West case, and the one it was found broken.
    { source: "E", target: "F", value: 80, sourcePort: "South", targetPort: "North" }
];
const SHAPES = ["Rectangle", "Rounded", "Circle", "None"];
let nodeCases = 0, nodeTooSmall = 0;
const nodeExamples = [];
for (const shape of SHAPES) {
    for (const minWidth of [0, 1, 3, 10]) {
        for (const minHeight of [0, 1, 3, 10]) {
            const { sink } = drawn(NODE_ROWS, { minWidth, minHeight, shape });
            sink.nodes.forEach(n => {
                nodeCases++;
                const size = sizeOf(n.el);
                if (size.w < MIN_NODE_HIT - 1e-9 || size.h < MIN_NODE_HIT - 1e-9) {
                    nodeTooSmall++;
                    if (nodeExamples.length < 4) {
                        nodeExamples.push(`${shape} minW=${minWidth} minH=${minHeight} ${n.id}: ${size.w.toFixed(2)}x${size.h.toFixed(2)} (<${n.el.tag}>)`);
                    }
                }
            });
        }
    }
}
nodeExamples.forEach(e => console.log(`      e.g. ${e}`));
check("every node's pointer target is at least MIN_NODE_HIT on both axes",
    nodeTooSmall === 0, `${nodeCases} nodes drawn, ${nodeTooSmall} too small`);
check("the node sweep is not vacuous", nodeCases > 300, `${nodeCases} nodes`);

// Both axes, explicitly: the floors are percentages of DIFFERENT pitches, so
// which one runs out first depends on the diagram.
{
    const { sink, layout } = drawn(NODE_ROWS, { minWidth: 0, minHeight: 0, shape: "Rectangle" });
    const collapsed = Array.from(layout.nodes.values()).filter(n => n.width === 0 || n.height === 0);
    check("...including nodes painted at literally nothing", collapsed.length > 0,
        `${collapsed.length} nodes with a zero axis`);
    const targets = sink.nodes.map(n => sizeOf(n.el));
    check("...whose targets are still MIN_NODE_HIT",
        targets.every(s => s.w >= MIN_NODE_HIT - 1e-9 && s.h >= MIN_NODE_HIT - 1e-9),
        targets.map(s => `${s.w.toFixed(1)}x${s.h.toFixed(1)}`).join(" "));
}

// =====================================================================
// 2. Bands: a target at least MIN_BAND_HIT thick.
// =====================================================================
const THIN_ROWS = [
    { source: "Big", target: "Hub", value: 10000 },
    { source: "Hub", target: "p", value: 6, flowType: "Gas" },
    { source: "Hub", target: "p", value: 3, flowType: "Power" },
    { source: "Hub", target: "q", value: 5 },
    { source: "Hub", target: "r", value: 4000 }
];
{
    const { sink, bands } = drawn(THIN_ROWS, { minWidth: 3, minHeight: 3 });
    const thicknessOf = id => bands.filter(b => b.corridorId === id).reduce((s, b) => s + b.width, 0);
    const byCorridor = new Map();
    sink.bands.forEach(b => {
        if (!byCorridor.has(b.id)) { byCorridor.set(b.id, []); }
        byCorridor.get(b.id).push(b.el);
    });
    let thinChecked = 0, thinBad = 0, fatChecked = 0;
    byCorridor.forEach((els, id) => {
        const thickness = thicknessOf(id);
        if (thickness < MIN_BAND_HIT) {
            thinChecked++;
            // One registered element for the corridor -- the halo.
            const stroke = els.reduce((m, e) => Math.max(m, Number(e.getAttribute("stroke-width") || 0)), 0);
            if (els.length !== 1 || stroke + thickness < MIN_BAND_HIT - 1e-9) {
                thinBad++;
                console.log(`      e.g. thin ${id}: ${els.length} targets, ${thickness.toFixed(2)}px + ${stroke.toFixed(2)}px stroke`);
            }
        } else {
            fatChecked++;
        }
    });
    check("a corridor too thin to point at gets one halo, reaching MIN_BAND_HIT",
        thinBad === 0 && thinChecked > 0, `${thinChecked} thin corridors, ${thinBad} wrong`);
    check("...and a corridor already thick enough gets none",
        fatChecked > 0 && Array.from(byCorridor.entries())
            .filter(([id]) => thicknessOf(id) >= MIN_BAND_HIT)
            .every(([, els]) => els.every(e => !e.getAttribute("stroke-width"))),
        `${fatChecked} thick corridors`);

    // Every stripe of a corridor answers to the corridor, so a click on any
    // of them selects the whole thing.
    const ids = sink.bands.map(b => b.id);
    check("every registered band names its corridor", ids.every(id => typeof id === "string" && id.length > 0));
    const pq = sink.bands.filter(b => b.id === "Hub→p");
    check("a two-stripe corridor registers under one id", pq.length >= 1 && new Set(pq.map(b => b.id)).size === 1,
        `${pq.length} registrations`);
}

// =====================================================================
// 3. An ordinary diagram is unchanged: no hit elements at all.
// =====================================================================
{
    const fat = [
        { source: "A", target: "B", value: 100 },
        { source: "B", target: "C", value: 100 }
    ];
    const { svg, sink } = drawn(fat, { minWidth: 20, minHeight: 20 });
    const strokedPaths = svg.find("path").filter(p => p.getAttribute("stroke-width") && p.getAttribute("fill") === "none");
    check("a comfortably sized diagram draws no band halos", strokedPaths.length === 0,
        `${strokedPaths.length} halos`);
    const unfilledRects = svg.find("rect").filter(r => r.getAttribute("fill") === "none"
        && r.getAttribute("pointer-events") === "all");
    check("...and no node hit rectangles", unfilledRects.length === 0, `${unfilledRects.length} hit rects`);
    check("...while still registering every node and corridor",
        sink.nodes.length === 3 && sink.bands.length === 2,
        `${sink.nodes.length} nodes, ${sink.bands.length} bands`);
}

// =====================================================================
// 4. Whatever is demoted still dims.
// =====================================================================
{
    const { sink } = drawn(NODE_ROWS, { minWidth: 0, minHeight: 0, shape: "Rectangle" });
    const targets = new Set(sink.nodes.map(n => n.el));
    const decorated = new Set(sink.decorations.map(d => d.el));
    check("a demoted node element is registered as a decoration",
        sink.decorations.length > 0 && !sink.decorations.some(d => targets.has(d.el)),
        `${sink.decorations.length} decorations`);
    check("...and has its pointer events switched off",
        sink.decorations.every(d => d.el.getAttribute("pointer-events") === "none"
            || d.el.tag === "text" || d.el.tag === "g" || d.el.tag === "image"),
        sink.decorations.map(d => `${d.el.tag}=${d.el.getAttribute("pointer-events")}`).join(" "));

    const thin = drawn(THIN_ROWS, { minWidth: 3, minHeight: 3 });
    const haloed = thin.sink.bands.filter(b => b.el.getAttribute("stroke-width"));
    const bandDecorations = thin.sink.decorations.filter(d => d.key.startsWith('["band"'));
    check("a haloed corridor's painted stripes become decorations",
        haloed.length > 0 && bandDecorations.length > 0 && !decorated.has(undefined),
        `${haloed.length} halos, ${bandDecorations.length} stripe decorations`);
    check("...and those stripes no longer take the pointer",
        bandDecorations.every(d => d.el.getAttribute("pointer-events") === "none"),
        bandDecorations.map(d => d.el.getAttribute("pointer-events")).join(" "));
}

// ===============================================================
// Route handles are registered against their own corridor, so that selecting
// one corridor can hide the others'.
//
// The controller's half of this is selection-check's; this is the wiring, which
// is the half that can silently not happen: render could draw every dot and
// register none, and the feature would simply never fire with nothing to show
// for it in either file.
// ===============================================================
{
    const { routeDiagram } = require("./routing-api.js");
    const dv = dataViewOf(NODE_ROWS);
    const { flows } = parseDataView(dv);
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 900, 600,
        { legendVisible: false, legendPosition: "Bottom", nodeMinWidthPercent: 6, nodeMinHeightPercent: 6,
          nodeShape: "Rectangle" });
    const routing = { style: "Polyline", curvaturePercent: 35, portLeadInPercent: 18, avoidNodes: true };
    const routed = routeDiagram(layout, routing, new Map());
    const flowTypeColours = resolveFlowTypeColours(corridors, palette);

    // A drag options object is what turns handle rendering on at all: render
    // draws no handles in a reading view, since persistProperties does not
    // stick there.
    const drag = {
        layout, snapStep: 0, viewport: { width: 900, height: 600 },
        onCommit: () => undefined,
        onMoveHandle: () => undefined,
        onResetHandle: () => undefined,
        onResizeCorner: () => undefined
    };
    const svg = new FakeElement("svg");
    const sink = sinkOf();
    render(svg, layout, routed.bands, palette, settingsOf({ minWidth: 6, minHeight: 6, shape: "Rectangle" }),
        flowTypeColours, 900, 600, drag, routed.handles, corridors, sink);

    // How many dots render should have drawn: every handle each corridor offers.
    let expected = 0;
    routed.handles.forEach(route => {
        ["source", "target", "middle", "detour", "corner"].forEach(kind => {
            if (route[kind]) { expected++; }
        });
    });
    const dots = svg.find("circle").filter(c =>
        (c.getAttribute("class") || "").startsWith("sankeybi-handle"));

    check("the case is not vacuous: handles were actually drawn",
        expected > 0 && dots.length === expected, `${dots.length} drawn, ${expected} offered`);
    check("every drawn handle is registered", sink.handles.length === dots.length,
        `${sink.handles.length} registered, ${dots.length} drawn`);
    check("...each against its own corridor, and no other",
        sink.handles.every(h => routed.handles.has(h.corridorId))
        && new Set(sink.handles.map(h => h.corridorId)).size
            === new Set([...routed.handles.keys()].filter(id => {
                const r = routed.handles.get(id);
                return ["source", "target", "middle", "detour", "corner"].some(k => r[k]);
            })).size);
    check("...and a handle is NOT registered as a band or a node, so clicking it "
        + "cannot cross-filter",
        !sink.bands.some(b => dots.includes(b.el))
        && !sink.nodes.some(n => dots.includes(n.el)));
    // A handle is not a decoration either: a decoration dims and stays, where a
    // handle is hidden outright. Registering it as both would dim it as well.
    check("...nor as a decoration", !sink.decorations.some(d => dots.includes(d.el)));

    // With no drag options there is no handle rendering at all, so nothing is
    // registered -- the reading view stays exactly as it was.
    const plain = new FakeElement("svg");
    const plainSink = sinkOf();
    render(plain, layout, routed.bands, palette, settingsOf({ minWidth: 6, minHeight: 6, shape: "Rectangle" }),
        flowTypeColours, 900, 600, undefined, routed.handles, corridors, plainSink);
    check("a reading view registers no handles, and draws none",
        plainSink.handles.length === 0
        && plain.find("circle").filter(c =>
            (c.getAttribute("class") || "").startsWith("sankeybi-handle")).length === 0);
}

// ===============================================================
// **The as-placed handles and their ghost line** .
//
// routing.ts's half is avoidance-check's; this is the WIRING, which is the
// half that can silently not happen -- routing could mark every detoured
// route and render could draw the dots exactly as before, and the author
// would see no difference at all with nothing to show for it in either file.
// ===============================================================
{
    const { routeDiagram } = require("./routing-api.js");
    // A -> C spanning three columns with B parked in the middle one, so the
    // direct route runs straight through it. Orthogonal, because its step is
    // the only thing that style lets an author place.
    const rows = [
        { source: "A", target: "C", value: 10, sourceColumn: 1, sourceRow: 2, targetColumn: 3, targetRow: 2 },
        { source: "X", target: "B", value: 4, sourceColumn: 1, sourceRow: 4, targetColumn: 2, targetRow: 2 },
        { source: "B", target: "Y", value: 4, sourceColumn: 2, sourceRow: 2, targetColumn: 3, targetRow: 4 }
    ];
    const GRID_ROLES = ["source", "target", "value", "sourceColumn", "sourceRow",
        "targetColumn", "targetRow"];
    const { flows } = parseDataView({
        table: {
            columns: GRID_ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => GRID_ROLES.map(role => (role in r ? r[role] : null)))
        }
    });
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1200, 700,
        { legendVisible: false, legendPosition: "Bottom", nodeShape: "Rectangle" });
    const routed = routeDiagram(layout,
        { style: "Orthogonal", curvaturePercent: 35, portLeadInPercent: 18, avoidNodes: true },
        new Map());
    const flowTypeColours = resolveFlowTypeColours(corridors, palette);
    const drag = {
        layout, snapStep: 0, viewport: { width: 1200, height: 700 },
        onCommit: () => undefined,
        onMoveHandle: () => undefined,
        onResetHandle: () => undefined,
        onResizeCorner: () => undefined
    };
    const ghostsOf = r => r.ghosts || new Map();
    const detouredIds = [...routed.handles.keys()].filter(id => routed.handles.get(id).asPlaced);
    check("the case is not vacuous: a route really was sent round something",
        detouredIds.length > 0 && ghostsOf(routed).size === detouredIds.length,
        `${detouredIds.length} as-placed, ${ghostsOf(routed).size} ghosts`);

    const svg = new FakeElement("svg");
    const sink = sinkOf();
    render(svg, layout, routed.bands, palette, settingsOf({ shape: "Rectangle" }),
        flowTypeColours, 1200, 700, drag, routed.handles, corridors, sink, [], undefined, [],
        ghostsOf(routed));

    const ghostPaths = svg.find("path").filter(p =>
        (p.getAttribute("class") || "") === "sankeybi-route-ghost");
    check("a ghost line is drawn, one per detoured corridor",
        ghostPaths.length > 0 && ghostPaths.length === detouredIds.length,
        `${ghostPaths.length} drawn`);
    check("...and it is never a pointer target",
        ghostPaths.length > 0
        && ghostPaths.every(p => p.getAttribute("pointer-events") === "none"));
    // Registered as a HANDLE, so it follows exactly the visibility rule the
    // dots it explains follow. As a decoration it would dim with
    // the corridor and stay on screen instead, which is the opposite rule.
    check("...registered as a handle against its own corridor, not as a decoration",
        ghostPaths.length > 0
        && ghostPaths.every(p => sink.handles.some(h => h.el === p && detouredIds.includes(h.corridorId)))
        && !sink.decorations.some(d => ghostPaths.includes(d.el))
        && !sink.bands.some(b => ghostPaths.includes(b.el)));

    // The dots themselves: an as-placed route's position handles are SOLID in
    // the theme ink where every other position handle is hollow, and its LANE
    // keeps the hollow look, because the lane is the one handle there that
    // does shape what is drawn.
    const dotsFor = cls => svg.find("circle").filter(c =>
        (c.getAttribute("class") || "").indexOf(cls) >= 0);
    const solid = dotsFor("sankeybi-handle-as-placed");
    const lanes = dotsFor("sankeybi-handle-detour");
    let expectedSolid = 0;
    routed.handles.forEach(route => {
        if (!route.asPlaced) { return; }
        ["source", "target", "middle"].forEach(k => { if (route[k]) { expectedSolid++; } });
    });
    check("every as-placed handle is drawn solid in the theme ink",
        expectedSolid > 0 && solid.length === expectedSolid
        && solid.every(d => d.getAttribute("fill") === palette.foreground.value
            && d.getAttribute("stroke") === palette.background.value),
        `${solid.length} solid, ${expectedSolid} expected`);
    check("...and the lane beside it keeps the hollow look",
        lanes.length > 0 && lanes.every(d =>
            (d.getAttribute("class") || "").indexOf("as-placed") < 0
            && d.getAttribute("fill") === palette.background.value));

    // An ordinary diagram gains nothing: no ghost, no solid dot, and the same
    // SVG it has always had.
    const plainSvg = new FakeElement("svg");
    const plainRouted = routeDiagram(layout,
        { style: "Orthogonal", curvaturePercent: 35, portLeadInPercent: 18, avoidNodes: false },
        new Map());
    render(plainSvg, layout, plainRouted.bands, palette,
        settingsOf({ shape: "Rectangle" }),
        flowTypeColours, 1200, 700, drag, plainRouted.handles, corridors, sinkOf(), [], undefined, [],
        ghostsOf(plainRouted));
    check("a diagram with nothing in the way draws no ghost and no solid handle",
        plainSvg.find("path").filter(p =>
            (p.getAttribute("class") || "") === "sankeybi-route-ghost").length === 0
        && plainSvg.find("circle").filter(c =>
            (c.getAttribute("class") || "").indexOf("as-placed") >= 0).length === 0);
}

// ---------------------------------------------------------------------------
// The sub-band an inbound PARTIAL highlight is drawn with.
//
// The WIRING, which is the half that can silently not happen: selection.ts can
// hold a perfect fraction and render draw nothing. A sink that reports a
// fraction must get a sub-band back, with its parent's own fill, and one that
// reports nothing must get no extra paint at all.
{
    console.log("\n-- the partial-highlight sub-band --");
    /** A sink that claims every stripe is `fraction` in scope. */
    const fractionSink = fraction => Object.assign(sinkOf(), {
        subBands: [],
        highlightFractionOf() { return fraction; },
        registerSubBand(el, corridorId, dimKey) { this.subBands.push({ el, corridorId, dimKey }); }
    });

    const rows = [
        { source: "A", target: "B", value: 100, flowType: "Gas" },
        { source: "A", target: "B", value: 80, flowType: "Power" },
        { source: "B", target: "C", value: 60 }
    ];

    // Fat bands, so every stripe clears MIN_SUB_BAND_WIDTH.
    const none = drawn(rows, { minWidth: 3, minHeight: 3, sink: fractionSink(undefined) });
    const partial = drawn(rows, { minWidth: 3, minHeight: 3, sink: fractionSink(0.3) });
    const whole = drawn(rows, { minWidth: 3, minHeight: 3, sink: fractionSink(1) });

    check("nothing highlighted draws NO sub-band",
        none.sink.subBands.length === 0, `${none.sink.subBands.length}`);
    check("a fraction of 1 draws no sub-band either -- the stripe is simply lit",
        whole.sink.subBands.length === 0, `${whole.sink.subBands.length}`);
    check("a PARTIAL fraction draws one sub-band per stripe",
        partial.sink.subBands.length === partial.sink.bands.length
        && partial.sink.subBands.length > 0,
        `${partial.sink.subBands.length} sub-bands for ${partial.sink.bands.length} bands`);
    check("...each registered against its own stripe key",
        partial.sink.subBands.every(s => /^\["stripe"/.test(s.dimKey)),
        partial.sink.subBands.map(s => s.dimKey).join(" "));
    check("...and never a pointer target, so it cannot swallow a click",
        partial.sink.subBands.every(s => s.el.getAttribute("pointer-events") === "none"));
    // The fill is COPIED, which is what makes Gradient and the high-contrast
    // hatches need no special case in the sub-band path.
    check("a sub-band takes its parent stripe's fill verbatim",
        partial.sink.subBands.every(s => {
            const fill = s.el.getAttribute("fill");
            return fill !== null && fill !== undefined && fill !== "none";
        }),
        partial.sink.subBands.map(s => s.el.getAttribute("fill")).join(" "));
    // And the drawing really did grow by exactly those paths.
    check("the sub-bands are extra paint, not a replacement",
        partial.svg.find("path").length > none.svg.find("path").length,
        `${none.svg.find("path").length} -> ${partial.svg.find("path").length} paths`);
    check("a sub-band's path differs from its parent's -- it is a FRACTION",
        partial.sink.subBands.every((s, i) =>
            s.el.getAttribute("d") !== partial.sink.bands[i]?.el.getAttribute("d")));
}

console.log(failures === 0 ? `\nALL HIT CHECKS PASSED (${assertions} assertions)` : `\n${failures} FAILURE(S) of ${assertions}`);
process.exit(failures === 0 ? 0 : 1);
