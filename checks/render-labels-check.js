"use strict";
// render.ts has never been covered before, because it needed a DOM. It now
// holds real logic worth checking -- gradient orientation, column-header
// bucketing, total formatting -- so rather than pull in jsdom this drives it
// through a minimal shim covering the handful of DOM calls render.ts makes.

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

// ---------------------------------------------------------------
// The DOM shim: records what render.ts builds.
// ---------------------------------------------------------------
class FakeElement {
    constructor(tag) {
        this.tag = tag;
        this.attributes = {};
        this.childNodes = [];
        this._text = "";
        // Route handles set a cursor and attach listeners; drag-check.js
        // exercises what those listeners do, this shim only has to let them
        // be attached without throwing.
        this.style = {};
        this.handlers = new Map();
    }
    addEventListener(type, fn) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type).push(fn);
    }
    setPointerCapture() { /* no-op */ }
    releasePointerCapture() { /* no-op */ }
    hasPointerCapture() { return false; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    appendChild(child) { this.childNodes.push(child); return child; }
    removeChild(child) {
        this.childNodes = this.childNodes.filter(c => c !== child);
        return child;
    }
    insertBefore(child, before) {
        const i = this.childNodes.indexOf(before);
        this.childNodes.splice(i < 0 ? 0 : i, 0, child);
        return child;
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    set textContent(v) { this._text = v; }
    get textContent() { return this._text; }
    /** Every element in this subtree, self included. */
    all() {
        return this.childNodes.reduce((acc, c) => acc.concat(c.all()), [this]);
    }
    find(tag) { return this.all().filter(e => e.tag === tag); }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { resolveFlowTypeColours } = require("./lib/colours.js");
const { computeLayout, SHAPE_CORNER_RATIO } = require("./layout-api.js");
const { routeCorridors } = require("./routing-api.js");
const { render } = require("./render-api.js");

const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort",
    ];

function dataViewOf(rows) {
    return {
        table: {
            columns: ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
        }
    };
}

const colour = v => ({ value: v });
const palette = {
    isHighContrast: false,
    foreground: colour("#252423"),
    foregroundNeutralSecondary: colour("#605E5C"),
    background: colour("#ffffff"),
    getColor: key => colour(`#palette-${key}`)
};

function settingsOf(over = {}) {
    const item = v => ({ value: { value: v } });
    return {
        nodesCard: {
            fill: item(over.nodeFill ?? "Solid"),
            minWidth: { value: over.nodeMinWidth ?? 3 },
            minHeight: { value: over.nodeMinHeight ?? 3 },
            defaultColour: { value: { value: over.defaultNodeColour ?? "#605E5C" } }
        },
        nodeShapesCard: {
            shape: item(over.nodeShape ?? "None"),

            fitLabel: { value: over.shapeFitLabel ?? false },
            fill: item(over.shapeFill ?? "Node"),
            fillColour: { value: { value: over.shapeFillColour ?? "#FFFFFF" } },
            border: item(over.shapeBorder ?? "Node"),
            borderColour: { value: { value: over.shapeBorderColour ?? "#605E5C" } },
            borderWidth: { value: over.shapeBorderWidth ?? 2 }
        },
        corridorsCard: {
                    },
        labelsCard: {
            showNodeTotals: { value: over.nodeTotals ?? false },
            totalBasis: item(over.basis ?? "Larger")
        },
        valuesCard: {
            units: { value: over.units ?? "" },
            decimalPlaces: { value: over.decimalPlaces ?? 0 }
        },
        positionsCard: {
            snap: { value: over.snap ?? 4 },
            showGrid: { value: over.showGrid ?? false }
        },
        interactionCard: {
            tooltips: { value: true },
            tooltipNodeTotals: { value: over.nodeTotalsTip ?? true },
            tooltipNodeByFlowType: { value: over.nodeTypeTip ?? false },
            tooltipNodeByConnection: { value: over.nodeConnectionTip ?? false }
        },
        legendCard: { show: { value: false }, position: item("Bottom") }
    };
}

function draw(rows, over = {}, viewport = { w: 1400, h: 800 }) {
    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    // **A node colour comes from the node editor**, where it
    // used to come from SourceNodeColour/TargetNodeColour. `applyNodeEdits`
    // writes exactly this field, so setting it here is what an edit does.
    Object.entries(over.nodeColours ?? {}).forEach(([id, colour]) => {
        const node = graph.nodes.get(id);
        if (node) { node.colour = colour; }
    });
    // Likewise a hidden NAME: the editor's `hideName` writes an empty label,
    // where a blank TargetLabel cell used to.
    (over.hideNames ?? []).forEach(id => {
        const node = graph.nodes.get(id);
        if (node) { node.label = ""; }
    });
    const { corridors } = inferCorridors(flows);
    const flowTypeColours = resolveFlowTypeColours(corridors, palette);
    const chrome = {
        legendVisible: false, legendPosition: "Bottom",
        nodeMinWidthPercent: over.nodeMinWidth ?? 3,
        nodeMinHeightPercent: over.nodeMinHeight ?? 3,
        nodeShape: over.nodeShape ?? "None",
        nodeShapeFitLabel: over.shapeFitLabel ?? false,
        arrowHeads: over.arrowHeads ?? false,
        arrowTails: over.arrowTails ?? false,
        arrowAngleDegrees: over.arrowAngle ?? 90,
        labels: {
            nodeTotals: over.nodeTotals ?? false,
            basis: over.basis ?? "Larger",
            units: over.units ?? "",
            decimalPlaces: over.decimalPlaces ?? 0
        }
    };
    const layout = computeLayout(graph, corridors, viewport.w, viewport.h, chrome);
    const routed = require("./routing-api.js").routeDiagram(layout, {
        portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth",
        arrows: {
            heads: over.arrowHeads ?? false,
            tails: over.arrowTails ?? false,
            angleDegrees: over.arrowAngle ?? 90
        }
    });
    const bands = routed.bands;
    const svg = new FakeElement("svg");
    render(svg, layout, bands, palette, settingsOf(over), flowTypeColours, viewport.w, viewport.h,
        undefined, new Map(), corridors, over.sink, routed.infill);
    return { svg, layout, bands, corridors, infill: routed.infill };
}

const texts = svg => svg.find("text").map(t => t.textContent);

// ===============================================================
// 1a. An arrow stripe is registered against its own CORRIDOR.
//
// It is the band's continuation inside the node, so it has to light and dim
// with that band. Keyed to the NODE a node lit by
// the one-hop rule lights every arrow in it, including the stubs of corridors
// that never touch the selected node.
//
// Asserted on what RENDER registers, because the controller cannot be wrong
// here -- it does what the key says, and the key is render's to get right.
// ===============================================================
{
    const seen = [];
    const sink = {
        beginFrame() {}, registerBand() {}, registerNode() {}, registerHandle() {},
        registerDecoration(el, key) { seen.push({ el, key }); }
    };
    const r = draw([
        { source: "A", target: "B", value: 100, flowType: "one" },
        { source: "B", target: "C", value: 60, flowType: "one" },
        // The corridor that made the author raise it: it touches C, so clicking B
        // lights C -- and this flow must not light with it.
        { source: "C", target: "D", value: 40, flowType: "one" }
    ], { arrowHeads: true, arrowTails: true, sink });

    check("the fixture actually drew arrows", r.infill.length >= 6, String(r.infill.length));
    // Match a registered element back to the stripe it was drawn for by its
    // own path data, which is unique per stripe.
    const corridorOf = new Map(r.infill.map(f => [f.path, f.corridorId]));
    const stripes = seen.filter(d => corridorOf.has(d.el.getAttribute("d")));
    check("every arrow stripe is registered", stripes.length === r.infill.length,
        stripes.length + " of " + r.infill.length);
    const wrong = stripes.filter(d =>
        d.key !== JSON.stringify(["band", corridorOf.get(d.el.getAttribute("d"))]));
    check("...against its own corridor, not the node it is drawn in",
        wrong.length === 0, wrong.length + " keyed otherwise, e.g. " + (wrong[0] || {}).key);
    // The statement that matters, said in terms of the diagram: C carries two
    // corridors, and its arrows do not all answer to the same key.
    const atC = r.infill.filter(f => f.nodeId === "C").map(f => f.corridorId);
    check("...so one node's arrows can answer to two different corridors",
        new Set(atC).size === 2, atC.join(" | "));
}

// ===============================================================
// 1. Routing hands render the two anchors a gradient needs.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "C", target: "C", value: 5, sourcePort: "East", targetPort: "West" }
    ];
    const { bands, layout } = draw(rows);
    const ab = bands.find(b => b.source === "A" && b.target === "B");
    const loop = bands.find(b => b.isSelfLoop);
    const a = layout.nodes.get("A"), b = layout.nodes.get("B");

    check("a band's start is its source's East anchor", Math.abs(ab.start.x - (a.x + a.width)) < 0.001,
        `${ab.start.x.toFixed(1)} vs ${(a.x + a.width).toFixed(1)}`);
    check("a band's end is its target's West anchor", Math.abs(ab.end.x - b.x) < 0.001,
        `${ab.end.x.toFixed(1)} vs ${b.x.toFixed(1)}`);
    // Measured against what the drawing guarantees rather than a pixel
    // constant: both ends are anchored on the SAME node, so they cannot be
    // further apart than that node's own diagonal however thick nodes are
    // set. (This was a bare "< 30", which silently assumed a 14px bar.)
    const c = layout.nodes.get("C");
    const loopSpan = Math.hypot(loop.end.x - loop.start.x, loop.end.y - loop.start.y);
    const abSpan = Math.hypot(ab.end.x - ab.start.x, ab.end.y - ab.start.y);
    check("a self-loop's two anchors are within its own node (no gradient axis)",
        loopSpan <= Math.hypot(c.width, c.height) + 0.001,
        `${loopSpan.toFixed(1)} vs diagonal ${Math.hypot(c.width, c.height).toFixed(1)}`);
    check("...far tighter than a band that actually crosses the diagram",
        loopSpan < abSpan / 4, `${loopSpan.toFixed(1)} vs ${abSpan.toFixed(1)}`);
    check("every band carries finite endpoints",
        bands.every(x => [x.start.x, x.start.y, x.end.x, x.end.y].every(Number.isFinite)));
}

// ===============================================================
// 2. Solid is the only colour mode.
//    Gradient along path was removed . It blended each band from its
//    source node colour to its target, which meant colour no
//    longer encoded FlowType and the legend stopped matching what
//    was drawn -- the card had to tell authors to switch the
//    legend off when using it. The 11 assertions here described
//    the gradient's geometry, its stops, its fallbacks and its id
//    uniqueness; all of that is gone, so what is asserted now is
//    the absence, which is what could regress by accident.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10 }
    ];
    const only = draw(rows, { nodeColours: { A: "#ff0000", B: "#0000ff" } });
    check("no gradient is ever emitted", only.svg.find("linearGradient").length === 0,
        String(only.svg.find("linearGradient").length));
    check("...and a band is filled with a flat colour, never a gradient url",
        only.svg.find("path").some(p => /^#/.test(p.getAttribute("fill") || ""))
        && only.svg.find("path").every(p => !/^url\(#sankeybi-gradient/.test(p.getAttribute("fill") || "")),
        [...new Set(only.svg.find("path").map(p => p.getAttribute("fill")))].join(" "));
    // Band paths are no longer given a `fill-opacity`, Flow transparency
    // having gone with the same release. A band is identified by its class.
    const bands = only.svg.find("path").filter(p => p.getAttribute("class") === "sankeybi-band");
    // This fake's getAttribute returns undefined for a missing attribute, not
    // null, so the test is nullish rather than strict.
    check("every band is opaque -- no fill-opacity at all",
        bands.length > 0 && bands.every(p => p.getAttribute("fill-opacity") == null),
        `${bands.length} bands, opacity `
            + bands.map(p => String(p.getAttribute("fill-opacity"))).join("/"));
}

// ===============================================================
// 3. Node colour: the data's override beats the theme's default,
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10 }
    ];
    const { svg, layout } = draw(rows, { nodeShape: "Rectangle", nodeColours: { A: "#abcdef" } });
    const fills = svg.find("rect").map(r => r.getAttribute("fill"));
    // Identified by size, since a shape is a rect too: the anchoring
    // rectangle is the one matching the node itself, and it is never painted.
    let anchors = 0;
    layout.nodes.forEach(n => {
        const rect = svg.find("rect").find(r => Math.abs(Number(r.getAttribute("width")) - n.width) < 0.001
            && Math.abs(Number(r.getAttribute("height")) - n.height) < 0.001);
        if (rect && rect.getAttribute("fill") === "none") { anchors++; }
    });
    check("every anchoring rectangle is transparent", anchors === 2, String(anchors));
    check("the overridden node's colour shows through its shape",
        fills.includes("#abcdef"), fills.join(", "));
    check("...and a node with no override takes the theme's colour",
        fills.includes(palette.foregroundNeutralSecondary.value), fills.join(", "));
}
{
    // Labels follow layout's labelPort, and North/South stack the text
    // ABOVE/BELOW the node rather than beside it -- the visible half of the
    // emptiest-face rule. Asserted on the drawn text, not just on layout.
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "B", target: "C", value: 10 }
    ];
    const { svg, layout } = draw(rows);
    const texts = svg.find("text");
    const textFor = id => texts.find(t => t.textContent === id);
    const a = layout.nodes.get("A"), b = layout.nodes.get("B"), c = layout.nodes.get("C");

    check("every node's name is drawn", ["A", "B", "C"].every(id => Boolean(textFor(id))),
        texts.map(t => t.textContent).join(", "));
    check("the leftmost node's label is right-anchored to the WEST of it",
        textFor("A").getAttribute("text-anchor") === "end"
        && Number(textFor("A").getAttribute("x")) < a.x,
        `${textFor("A").getAttribute("text-anchor")} at ${textFor("A").getAttribute("x")}, node x ${a.x}`);
    check("the rightmost node's label is left-anchored to the EAST of it",
        textFor("C").getAttribute("text-anchor") === "start"
        && Number(textFor("C").getAttribute("x")) > c.x + c.width,
        `${textFor("C").getAttribute("text-anchor")} at ${textFor("C").getAttribute("x")}`);
    check("a mid-chain node's label is centred ABOVE it",
        textFor("B").getAttribute("text-anchor") === "middle"
        && Math.abs(Number(textFor("B").getAttribute("x")) - (b.x + b.width / 2)) < 0.001
        && Number(textFor("B").getAttribute("y")) < b.y,
        `${textFor("B").getAttribute("text-anchor")} at (${textFor("B").getAttribute("x")}, ${textFor("B").getAttribute("y")}), node top ${b.y.toFixed(1)}`);
    check("...and clear of the node rather than touching it",
        b.y - Number(textFor("B").getAttribute("y")) >= 6,
        String(b.y - Number(textFor("B").getAttribute("y"))));
}
{
    // A name outside its node can be clicked to select it, and
    // its hit rectangle must sit BELOW every node's pointer target in paint
    // order, which is the only thing that lets a node's drag win over a name
    // that overlaps it.
    const rows = [{ source: "A", target: "B", value: 10 }];
    const { svg } = draw(rows, { nodeShape: "None", nodeMinWidth: 10, nodeMinHeight: 10 });
    const all = svg.find("rect");
    const nameHits = all.filter(r => r.getAttribute("aria-hidden") === "true");
    const lastName = all.lastIndexOf(nameHits[nameHits.length - 1]);
    const firstNode = all.findIndex(r => r.getAttribute("aria-hidden") !== "true"
        && r.getAttribute("pointer-events") === "all");
    check("each outside name has a hit rectangle", nameHits.length === 2, String(nameHits.length));
    // The letters themselves must not take the pointer, or only the gaps
    // between them reach the rectangle.
    const texts = svg.find("text");
    check("...and no label text takes the pointer itself",
        texts.length > 0 && texts.every(t => t.getAttribute("pointer-events") === "none"),
        `${texts.filter(t => t.getAttribute("pointer-events") !== "none").length} of ${texts.length} do`);
    check("...all of them painted before any node's pointer target", lastName < firstNode,
        `last name ${lastName}, first node ${firstNode}`);
}
{
    // A node too thin to point at gets an invisible rect laid over it to
    // carry the pointer. A normal one deliberately does NOT, so ordinary
    // output is byte-identical to before the hit rectangle existed.
    const rows = [{ source: "A", target: "B", value: 10 }];
    // Shape None, or the shape would be the pointer target instead.
    const fat = draw(rows, { nodeShape: "None", nodeMinWidth: 10, nodeMinHeight: 10 }).svg;
    const none = draw(rows, { nodeShape: "None", nodeMinWidth: 0, nodeMinHeight: 0 }).svg;
    // The anchoring rectangle always takes the pointer now, so "all" no
    // longer identifies a hit rectangle -- COUNT does. A normal node emits
    // one rect; a node too thin to point at emits a second, larger one.
    // The name-click rectangles are aria-hidden and are not node
    // targets, so they are left out of the count.
    const nodeRects = s => s.find("rect").filter(r => r.getAttribute("aria-hidden") !== "true");
    const hitsOf = s => nodeRects(s).filter(r => r.getAttribute("pointer-events") === "all"
        && Number(r.getAttribute("width")) >= 6);
    check("a normal-width node emits one rectangle only", nodeRects(fat).length === 2,
        String(nodeRects(fat).length));
    check("a zero-width node emits a second, hittable one", nodeRects(none).length === 4,
        String(nodeRects(none).length));
    check("...and that second one is what takes the pointer", hitsOf(none).length === 2,
        String(hitsOf(none).length));
    check("the hit rectangle is at least 6px across",
        hitsOf(none).every(r => Number(r.getAttribute("width")) >= 6
            && Number(r.getAttribute("height")) >= 6));
    check("the DRAWN rectangle is still zero-width -- the hit area never inflates it",
        none.find("rect").filter(r => r.getAttribute("width") === "0").length === 2,
        none.find("rect").map(r => r.getAttribute("width")).join(", "));
}

{
    // A shape is pure paint laid over the node's centre, and it becomes the
    // pointer target -- covering the node rectangle by construction, it
    // would otherwise swallow every click meant for the node under it.
    const rows = [{ source: "A", target: "B", value: 10 }];
    const plain = draw(rows, { nodeColours: { A: "#abcdef" } }).svg;
    const shaped = draw(rows, { nodeShape: "Circle", nodeColours: { A: "#abcdef" } }).svg;

    check("no shape is drawn by default", plain.find("circle").length === 0,
        String(plain.find("circle").length));
    check("Circle draws one circle per node", shaped.find("circle").length === 2,
        String(shaped.find("circle").length));
    check("...filled with the node's own colour by default",
        shaped.find("circle").some(c => c.getAttribute("fill") === "#abcdef"),
        shaped.find("circle").map(c => c.getAttribute("fill")).join(", "));
    check("...and it is the element that takes the pointer",
        shaped.find("circle").every(c => c.getAttribute("pointer-events") === "all"));
    check("...leaving the node rectangle inert beneath it",
        shaped.find("rect").every(r => r.getAttribute("pointer-events") === "none"),
        shaped.find("rect").map(r => r.getAttribute("pointer-events")).join(", "));
}
{
    // Fill and border are independent modes, which is what makes "white
    // insides, border still each node's own colour" one change.
    const rows = [{ source: "A", target: "B", value: 10 }];
    const { svg, layout } = draw(rows, {
        nodeShape: "Rounded", shapeFill: "Custom", shapeFillColour: "#ffffff", shapeBorder: "Node",
        nodeColours: { A: "#abcdef" }
    });
    const shape = svg.find("rect").find(r => r.getAttribute("stroke") === "#abcdef");
    check("the border keeps the node's colour", Boolean(shape));
    check("...while the fill is the custom one", shape && shape.getAttribute("fill") === "#ffffff",
        shape && shape.getAttribute("fill"));
    check("a rounded rectangle is actually rounded", shape && Number(shape.getAttribute("rx")) > 0,
        shape && shape.getAttribute("rx"));
    // ...and painted with LAYOUT's corner ratio, not a number of render's
    // own. Layout sizes the shape so exactly this radius clears the node
    // rectangle, so the two constants have to stay the same one.
    // Matched by its own drawn size, not the container's: the outline is
    // inset by half the border, so the two differ by exactly that.
    const rounded = svg.find("rect").filter(r => r.getAttribute("rx") !== undefined
        && r.getAttribute("rx") !== null);
    check("a rounded shape is drawn per node", rounded.length === 2, String(rounded.length));
    check("the drawn radius is layout's own corner ratio",
        rounded.every(r => Math.abs(Number(r.getAttribute("rx"))
            - SHAPE_CORNER_RATIO * Math.min(Number(r.getAttribute("width")), Number(r.getAttribute("height")))) < 0.001),
        rounded.map(r => r.getAttribute("rx")).join(", "));
}
{
    // Label inside: only when it fits, and in ink chosen against the fill.
    // A dark fill must not leave the theme foreground on it.
    const rows = [{ source: "A", target: "Considerably Longer Name", value: 10 }];
    const long = "Considerably Longer Name";
    const tight = draw(rows, { nodeShape: "Rectangle", nodeMinWidth: 0, nodeMinHeight: 0 }).svg;
    const fitted = draw(rows, { nodeShape: "Rectangle", nodeMinWidth: 0, nodeMinHeight: 0, shapeFitLabel: true }).svg;

    // **Found by LINE, because a long name wraps**. This used to
    // match the whole string on one `<text>`; at a 12em budget "Considerably
    // Longer Name" is 149px and breaks, so there is no single element carrying
    // it. Matching the lines it broke into keeps the assertion about what it
    // was always about -- which side of the shape the label sits on -- and
    // pins the wrap at the same time.
    const linesFor = (svg, id) => svg.find("text")
        .filter(t => t.textContent && id.includes(t.textContent));
    check("a long name is drawn on more than one line",
        linesFor(tight, long).length > 1,
        linesFor(tight, long).map(t => JSON.stringify(t.textContent)).join(" + "));
    check("...and the lines together are the whole name, in order",
        linesFor(tight, long).map(t => t.textContent).join(" ") === long,
        linesFor(tight, long).map(t => t.textContent).join(" "));
    check("a long label overflows a small shape and is drawn outside",
        linesFor(tight, long).every(t => t.getAttribute("text-anchor") !== "middle"),
        linesFor(tight, long).map(t => t.getAttribute("text-anchor")).join(","));
    check("...and Fit to label brings it inside instead",
        linesFor(fitted, long).every(t => t.getAttribute("text-anchor") === "middle"),
        linesFor(fitted, long).map(t => t.getAttribute("text-anchor")).join(","));

    const dark = draw(rows, {
        nodeShape: "Rectangle", shapeFitLabel: true, shapeFill: "Custom", shapeFillColour: "#101010"
    }).svg;
    const light = draw(rows, {
        nodeShape: "Rectangle", shapeFitLabel: true, shapeFill: "Custom", shapeFillColour: "#f5f5f5"
    }).svg;
    // Every line of a wrapped label takes the same ink, or the second line
    // would read as a different label.
    check("a label inside a dark shape is drawn in white",
        linesFor(dark, long).length > 0
        && linesFor(dark, long).every(t => t.getAttribute("fill") === "#ffffff"),
        linesFor(dark, long).map(t => t.getAttribute("fill")).join(","));
    check("...and inside a light one, in black",
        linesFor(light, long).length > 0
        && linesFor(light, long).every(t => t.getAttribute("fill") === "#000000"),
        linesFor(light, long).map(t => t.getAttribute("fill")).join(","));
}

{
    // An outside label must clear the SHAPE, not the node rectangle. The
    // shape is laid over the node's centre and is bigger than it, so a label
    // placed off the NODE ended up underneath its own shape -- the name sat
    // across the top of a tall card.
    const id = "MiddleNodeLongName";
    // "Big" dominates the scale so the middle node is small, which is what
    // makes its shape genuinely TALLER than it -- the case that tells a
    // label clearing the shape apart from one merely clearing the node.
    const rows = [
        { source: "Big", target: "Huge", value: 10000 },
        { source: "A", target: id, value: 10 },
        { source: id, target: "C", value: 10 }
    ];
    const { svg, layout } = draw(rows, { nodeShape: "Circle", nodeMinWidth: 8, nodeMinHeight: 5, nodeTotals: true });
    const n = layout.nodes.get(id);
    const shapeTop = n.y + n.height / 2 - n.shapeHeight / 2;
    const texts = svg.find("text");
    const name = texts.find(t => t.textContent === id);

    check("the long name did not fit inside its shape", n.labelInside === false,
        String(n.labelInside));
    check("...so it is drawn above the node", Boolean(name) && Number(name.getAttribute("y")) < n.y,
        name && name.getAttribute("y"));
    check("...and clears the SHAPE, which is taller than the node",
        Number(name.getAttribute("y")) < shapeTop,
        `${name.getAttribute("y")} vs shape top ${shapeTop.toFixed(1)}`);
    check("...as does the total stacked under it",
        texts.filter(t => Number(t.getAttribute("x")) === Number(name.getAttribute("x")))
            .every(t => Number(t.getAttribute("y")) < shapeTop),
        texts.filter(t => Number(t.getAttribute("x")) === Number(name.getAttribute("x")))
            .map(t => t.getAttribute("y")).join(", "));
    check("the shape really is taller than its node (or this proves nothing)",
        n.shapeHeight > n.height + 1,
        `${n.shapeHeight.toFixed(1)} vs ${n.height.toFixed(1)}`);
}



{
    // A shape border is stroked CENTRED on its outline, so half of it fell
    // outside the container -- over the bands, right where they meet the
    // node. That was the faint line along every join, and why Shape: None
    // made it vanish. The drawn outline is inset by half the border so it
    // sits wholly inside.
    const rows = [{ source: "A", target: "B", value: 10 }];
    const border = 6;
    const { svg, layout } = draw(rows, {
        nodeShape: "Rectangle", nodeMinWidth: 20, shapeBorderWidth: border
    });
    let ran = 0;
    let spilling = 0;
    layout.nodes.forEach(n => {
        const cx = n.x + n.width / 2;
        const right = cx + n.shapeWidth / 2;
        const shape = svg.find("rect").find(r => Number(r.getAttribute("stroke-width")) === border);
        if (!shape) { return; }
        ran++;
        // Outer edge of the stroke = drawn edge + half the border.
        const outer = Number(shape.getAttribute("x")) + Number(shape.getAttribute("width"))
            + Number(shape.getAttribute("stroke-width")) / 2;
        if (outer > right + 0.001) { spilling++; }
    });
    check("a shape border stays inside its container", spilling === 0 && ran > 0,
        spilling + " of " + ran);
    check("the border-inset check actually ran", ran >= 1, String(ran));
}

{
    // An arrow reaches back past the container face so it overlaps the band
    // it continues; the clip must be GROWN by that much or it cuts off
    // exactly the overlap meant to cover the seam. Clipping to the shape's
    // own outline is what made a shaped node show a faint line where an
    // unshaped one did not.
    const rows = [
        { source: "A", target: "Mid", value: 100 },
        { source: "Mid", target: "Z", value: 100 }
    ];
    const { svg, layout } = draw(rows, {
        nodeShape: "Rectangle", nodeMinWidth: 20, arrowHeads: true, arrowTails: true
    });
    const n = layout.nodes.get("Mid");
    const left = n.x + n.width / 2 - n.shapeWidth / 2;
    const clips = svg.find("clipPath");
    check("the arrows are clipped to the shape at all", clips.length >= 1, String(clips.length));
    // find() walks the tree, so the clip's own rect is in here too: it is
    // the one whose left edge sits OUTSIDE the container.
    const xs = svg.find("rect").map(r => Number(r.getAttribute("x")));
    check("the clip is grown past the container by exactly the arrow base bleed",
        xs.some(x => Math.abs(x - (left - require("./routing-api.js").ARROW_BASE_BLEED)) < 0.001),
        xs.map(x => x.toFixed(2)).join(", "));

}

// ===============================================================
// 4. Node totals.
// ===============================================================
{
    const rows = [
        { source: "A", target: "H", value: 120 },
        { source: "H", target: "B", value: 90 }
    ];
    const plain = draw(rows);
    check("no totals are drawn when the toggle is off",
        !texts(plain.svg).some(t => t.includes("120")), texts(plain.svg).join(" | "));

    const larger = draw(rows, { nodeTotals: true });
    check("Larger basis reports the hub's bigger side (120)",
        texts(larger.svg).includes("120"), texts(larger.svg).join(" | "));
    check("the node name is still drawn alongside it", texts(larger.svg).includes("H"));

    const outflow = draw(rows, { nodeTotals: true, basis: "Outflow" });
    check("Outflow basis reports 90 for the hub", texts(outflow.svg).includes("90"),
        texts(outflow.svg).join(" | "));
    check("...and 0 for the sink", texts(outflow.svg).includes("0"));

    const inflow = draw(rows, { nodeTotals: true, basis: "Inflow" });
    check("Inflow basis reports 120 for the hub and 90 for the sink",
        texts(inflow.svg).includes("120") && texts(inflow.svg).includes("90"));
}
{
    const rows = [{ source: "A", target: "B", value: 187.456 }];
    check("units are appended", texts(draw(rows, { nodeTotals: true, units: "TWh" }).svg).includes("187 TWh"));
    check("decimal places are honoured",
        texts(draw(rows, { nodeTotals: true, decimalPlaces: 2, units: "TWh" }).svg).includes("187.46 TWh"));
}
{
    // A suppressed label hides the NAME, not the total -- a node showing only
    // its throughput is a real convention in the reference diagrams.
    const rows = [{ source: "A", target: "B", value: 42 }];
    const shown = texts(draw(rows, { nodeTotals: true, hideNames: ["B"] }).svg);
    check("a suppressed label still shows its total", shown.includes("42"), shown.join(" | "));
    check("...but not its name", !shown.includes("B"), shown.join(" | "));
    check("with totals off, a suppressed node draws no text at all",
        !texts(draw(rows, { hideNames: ["B"] }).svg).includes("B"));
}

// ===============================================================
// 6. Route handles are drawn only when there are handles to draw.
//    "Show route handles" works by handing render an empty map, so
//    this is the behaviour that switch depends on.
// ===============================================================
{
    const { routeDiagram } = require("./routing-api.js");
    const rows = [
        { source: "A", target: "B", value: 40, sourceColumn: 1, sourceRow: 1, targetColumn: 3, targetRow: 3 },
        { source: "A", target: "C", value: 20, targetColumn: 3, targetRow: 1 }
    ];
    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const flowTypeColours = resolveFlowTypeColours(corridors, palette);
    const chrome = {
        legendVisible: false, legendPosition: "Bottom"
    };
    const layout = computeLayout(graph, corridors, 1400, 800, chrome);
    const routed = routeDiagram(layout,
        { portLeadInPercent: 18, curvaturePercent: 35, style: "Orthogonal", avoidNodes: true });

    const drag = {
        layout, snapStep: 0, viewport: { width: 1400, height: 800 },
        onCommit: () => {}, onMoveHandle: () => {}, onResetHandle: () => {}
    };
    const drawWith = (handles, withDrag = drag) => {
        const svg = new FakeElement("svg");
        render(svg, layout, routed.bands, palette, settingsOf(), flowTypeColours, 1400, 800, withDrag, handles);
        return svg.find("circle").filter(c => (c.getAttribute("class") || "").includes("sankeybi-handle"));
    };

    check("handles are drawn when supplied", drawWith(routed.handles).length > 0,
        `${drawWith(routed.handles).length} drawn`);
    check("no handles are drawn when the map is empty", drawWith(new Map()).length === 0);
    // `null`, not `undefined` — a default parameter only fills in for
    // undefined, so passing that would hand the drag options straight back.
    check("no handles are drawn outside edit mode", drawWith(routed.handles, null).length === 0);

    // Each corridor contributes its two leads, plus a crossover where the
    // route actually has one.
    const drawn = drawWith(routed.handles);
    let expected = 0;
    routed.handles.forEach(h => { expected += 2 + (h.middle ? 1 : 0); });
    check("one dot per handle the route offers", drawn.length === expected,
        `${drawn.length} vs ${expected}`);
    check("every dot is placed at a real coordinate",
        drawn.every(d => Number.isFinite(Number(d.getAttribute("cx"))) && Number.isFinite(Number(d.getAttribute("cy")))));
}


// ===============================================================
// N. Tooltips: one line per fact, formatted by the Labels card, and the
//    same text in the host's box and the native <title>.
// ===============================================================
{
    const rows = [
        { source: "Grid", target: "Homes", value: 255, flowType: "Electricity" },
        { source: "Grid", target: "Homes", value: 40.5, flowType: "Heat" }
    ];
    // A recording sink: render only tells selection what an element IS, so
    // this is the only way to see the items the host tooltip service gets.
    const sinkOf = () => ({
        bands: [], nodes: [], beginFrame() {}, registerDecoration() {},
        registerBand(el, id, items) { this.bands.push({ el, id, items }); },
        registerNode(el, id, items) { this.nodes.push({ el, id, items }); }
    });
    const over = { units: "TWh", decimalPlaces: 1, nodeTypeTip: true, nodeConnectionTip: true };

    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const flowTypeColours = resolveFlowTypeColours(corridors, palette);
    const chrome = { legendVisible: false, legendPosition: "Bottom" };
    const layout = computeLayout(graph, corridors, 1400, 800, chrome);
    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });

    const sink = sinkOf();
    const svg = new FakeElement("svg");
    render(svg, layout, bands, palette, settingsOf(over), flowTypeColours, 1400, 800, undefined, new Map(), corridors, sink);

    const bandItems = sink.bands.map(b => b.items.map(i => `${i.displayName}=${i.value}`).join(" / "));
    // A corridor's box: the pair as the header, then a row per flow type, and
    // a total only where there is more than one type to add up.
    const gridHomes = sink.bands.find(b => b.id === "Grid→Homes");
    const headers = sink.bands.map(b => b.items[0] && b.items[0].header).filter(Boolean);
    check("a corridor tooltip leads with the pair, as the box's header",
        headers.includes("Grid → Homes"), headers.join(" | "));
    check("...and lists the flow type with its figure",
        !!gridHomes && gridHomes.items.some(i => i.displayName === "Electricity" && i.value === "255.0 TWh"),
        gridHomes ? JSON.stringify(gridHomes.items) : "no Grid→Homes band");
    check("...and totals a corridor carrying more than one type",
        !!gridHomes && gridHomes.items.some(i => i.displayName === "Total" && i.value === "295.5 TWh"),
        gridHomes ? JSON.stringify(gridHomes.items) : "");
    // (The single-type "no redundant total" rule is asserted on
    // corridorTooltipRows directly in tooltips-check, rather than by adding a
    // corridor here and moving the node figures every other case reads.)

    const gridItems = sink.nodes.find(n => n.id === "Grid").items;
    const grid = gridItems.map(i => `${i.displayName}=${i.value}`);
    check("a node tooltip leads with the node's name, as the box's header",
        gridItems[0].header === "Grid", JSON.stringify(gridItems[0]));
    check("...carries its totals, formatted", grid.includes("Total out=295.5 TWh"), grid.join(" | "));
    check("...its flow types", grid.includes("Electricity out=255.0 TWh"), grid.join(" | "));
    check("...and its connections", grid.includes("To Homes=295.5 TWh"), grid.join(" | "));
    check("blocks are separated by a drawn rule, in the label column",
        gridItems.filter(i => i.displayName === String.fromCharCode(0x2500).repeat(12)).length === 2,
        grid.join(" | "));

    // The <title> fallback has to be the same text, or the tooltip changes
    // wording the moment the host service is unavailable.
    const titles = svg.find("title").map(t => t.textContent);
    check("the band <title> is the corridor's lines, newline-separated",
        titles.some(t => t.startsWith("Grid → Homes\n") && t.includes("Electricity: 255.0 TWh")
            && t.includes("Heat: 40.5 TWh") && t.includes("Total: 295.5 TWh")), titles.join(" | "));
    check("the node <title> is the same lines, newline-separated",
        titles.some(t => t.startsWith("Grid\n") && t.includes("Total out: 295.5 TWh")), titles.join(" | "));

    // The three node toggles reach render from the Interaction card.
    const plainSink = sinkOf();
    render(new FakeElement("svg"), layout, bands, palette, settingsOf({ units: "TWh", decimalPlaces: 1 }),
        flowTypeColours, 1400, 800, undefined, new Map(), corridors, plainSink);
    const plainGrid = plainSink.nodes.find(n => n.id === "Grid").items.map(i => `${i.displayName}=${i.value}`);
    check("with the breakdown toggles off, only the totals show",
        !plainGrid.some(v => v.includes("Electricity")) && !plainGrid.some(v => v.startsWith("To ")) &&
        plainGrid.includes("Total out=295.5 TWh"), plainGrid.join(" | "));

    // Without corridors there is nothing to break down; the tooltip must
    // still name the node rather than throwing.
    const bareSink = sinkOf();
    render(new FakeElement("svg"), layout, bands, palette, settingsOf(over), flowTypeColours, 1400, 800,
        undefined, new Map(), [], bareSink);
    check("no corridors supplied still names every node",
        bareSink.nodes.every(n => n.items.length === 1), JSON.stringify(bareSink.nodes.map(n => n.items.length)));
}

// ===============================================================
// N. The snap grid: edit mode only, stepped by the Snap slider, with
//    whole columns and rows drawn heavier.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "B", target: "C", value: 10 }
    ];
    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const flowTypeColours = resolveFlowTypeColours(corridors, palette);
    const chrome = { legendVisible: false, legendPosition: "Bottom" };
    const layout = computeLayout(graph, corridors, 1400, 800, chrome);
    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });

    // The drag options render() treats as "edit mode".
    const editing = { layout, viewport: { width: 1400, height: 800 }, snapStep: 0.25,
        onMoveNode() {}, onMoveHandle() {}, onResetHandle() {} };
    const draw = (over, drag) => {
        const svg = new FakeElement("svg");
        render(svg, layout, bands, palette, settingsOf(over), flowTypeColours, 1400, 800,
            drag, new Map(), corridors);
        return svg;
    };
    const grid = svg => svg.find("g").filter(g => g.getAttribute("class") === "sankeybi-grid");
    const lines = svg => (grid(svg)[0] ? grid(svg)[0].find("line") : []);

    check("no grid when the toggle is off", lines(draw({ showGrid: false }, editing)).length === 0);
    check("no grid outside edit mode, however the toggle is set",
        lines(draw({ showGrid: true }, undefined)).length === 0);

    const on = draw({ showGrid: true, snap: 4 }, editing);
    check("the grid is drawn when both hold", lines(on).length > 0, String(lines(on).length));

    // It must sit UNDER everything: first child of the SVG.
    check("...behind the diagram, not over it",
        on.childNodes[0] === grid(on)[0], on.childNodes[0].tag);
    check("...and never swallows a click",
        grid(on)[0].getAttribute("pointer-events") === "none");

    const widths = lines(on).map(l => Number(l.getAttribute("stroke-width")));
    const majors = widths.filter(w => w === 1).length;
    const minors = widths.filter(w => w === 0.5).length;
    check("whole columns and rows are drawn heavier than the sub-steps",
        majors > 0 && minors > 0 && majors < minors, `${majors} major, ${minors} minor`);
    check("every line is faint", lines(on).every(l => Number(l.getAttribute("stroke-opacity")) <= 0.25));
    check("...and takes its colour from the theme",
        lines(on).every(l => l.getAttribute("stroke") === palette.foreground.value));

    // The slider counts DIVISIONS of a cell, so a bigger number is a finer
    // grid, and 0 -- free placement -- leaves only the whole columns and rows.
    const fine = lines(draw({ showGrid: true, snap: 10 }, editing)).length;
    const coarse = lines(draw({ showGrid: true, snap: 2 }, editing)).length;
    const free = lines(draw({ showGrid: true, snap: 0 }, editing));
    check("more divisions means more lines", fine > coarse, `${fine} vs ${coarse}`);
    check("1 division is whole cells, same as free placement",
        lines(draw({ showGrid: true, snap: 1 }, editing)).length === free.length);
    check("snap 0 draws only whole columns and rows",
        free.length > 0 && free.every(l => Number(l.getAttribute("stroke-width")) === 1),
        String(free.length));

    // Thirds have to be EXACT: a percentage slider could only offer 33%,
    // which leaves a sliver every cell and drifts across a wide diagram.
    const thirds = lines(draw({ showGrid: true, snap: 3 }, editing))
        .filter(l => l.getAttribute("x1") === l.getAttribute("x2"))
        .map(l => Number(l.getAttribute("x1"))).sort((x, y) => x - y);
    const gaps = thirds.slice(1).map((x, i) => x - thirds[i]);
    check("thirds are evenly spaced, to the pixel",
        gaps.length > 2 && Math.max(...gaps) - Math.min(...gaps) < 0.001,
        `${Math.min(...gaps).toFixed(4)} .. ${Math.max(...gaps).toFixed(4)}`);
    check("...and three of them make exactly one column",
        Math.abs(gaps[0] * 3 - layout.columnGap) < 0.001,
        `${(gaps[0] * 3).toFixed(4)} vs ${layout.columnGap.toFixed(4)}`);

    // Lines must land where computeLayout puts a grid coordinate, or a
    // dragged node would snap somewhere the grid doesn't show.
    // computeLayout puts a column line at the node's own x, and a row line
    // through its vertical CENTRE (the y formula subtracts half the height).
    // Both have to be true or a dragged node would snap somewhere the grid
    // doesn't show.
    const verticals = lines(on).filter(l => l.getAttribute("x1") === l.getAttribute("x2"));
    const horizontals = lines(on).filter(l => l.getAttribute("y1") === l.getAttribute("y2"));
    const b = layout.nodes.get("B");
    check("a column line falls on the node's own x",
        verticals.some(l => Math.abs(Number(l.getAttribute("x1")) - b.x) < 0.001),
        `node at ${b.x.toFixed(1)}, lines at ${verticals.map(l => Number(l.getAttribute("x1")).toFixed(0)).join(",")}`);
    check("...and a row line through its centre",
        horizontals.some(l => Math.abs(Number(l.getAttribute("y1")) - (b.y + b.height / 2)) < 0.001),
        `centre ${(b.y + b.height / 2).toFixed(1)}`);
    check("every coordinate is finite",
        lines(on).every(l => ["x1", "y1", "x2", "y2"].every(a => Number.isFinite(Number(l.getAttribute(a))))));
}

if (failures === 0) {
    console.log("\nALL RENDER/LABEL CHECKS PASSED");
} else {
    console.log(`\n${failures} RENDER/LABEL CHECK(S) FAILED`);
    process.exit(1);
}
