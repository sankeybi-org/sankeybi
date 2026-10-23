"use strict";
/**
 * s-lane-check -- a wrap's lane may be placed BETWEEN its two nodes, which makes
 * an S.
 *
 * The lane of a wrap between two different nodes was held beyond both of them,
 * so for a lower node's East exit into the West of the node above it there was
 * nowhere to put the lane but over the top of the upper node: a loop. The
 * cleanest route is an S through the gap between them, and the lane handle now
 * reaches it.
 *
 * Pinned, in all four styles:
 *  - a lane dropped inside a clear gap stays where it was dropped, and the
 *    spine is the S: out, along the gap, in;
 *  - nothing on that spine is inside either node;
 *  - the DEFAULT route is the S too wherever the gap is
 *    clear, and still round the outside where something sits in it;
 *  - a lane dropped inside the nodes' own span, or in a gap too tight to clear
 *    them, is still held clear as before.
 */
const { dataViewFromHeader } = require("./dataview.js");
const { parseDataView } = require("./lib/dataParsing.js");
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeDiagram } = require("./routing-api.js");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const CHROME = {
    legendVisible: false, legendPosition: "Bottom", nodeShape: "Rectangle",
    nodeMinWidthPercent: 3, nodeMinHeightPercent: 0
};

/** Lower -> Upper, East into West, the two in one column and `rows` rows apart. */
function build(rows, blocker) {
    const data = [
        ["Lower", "Upper", "10", "East", "West"],
        ["Src", "Lower", "10", null, null],
        ["Upper", "Sink", "10", null, null]
    ];
    if (blocker) {
        data.push(["Src", "Block", "5", null, null], ["Block", "Sink", "5", null, null]);
    }
    const { flows } = parseDataView(dataViewFromHeader(
        ["Source", "Target", "Value", "SourcePort", "TargetPort"], data,
        { Source: "source", Target: "target", Value: "value", SourcePort: "sourcePort", TargetPort: "targetPort" }));
    const graph = buildGraph(flows).graph;
    const corridors = inferCorridors(flows).corridors;
    const place = { Lower: [1, rows], Upper: [1, 0], Src: [0, rows], Sink: [2, 0], Block: [1, Math.round(rows / 2)] };
    const nodes = new Map();
    graph.nodes.forEach((node, id) => {
        const p = place[id];
        nodes.set(id, Object.assign({}, node,
            { column: p[0], columnIsOverride: true, row: p[1], rowIsOverride: true }));
    });
    const layout = computeLayout({ nodes }, corridors, 900, 600, CHROME);
    const id = corridors.find(c => c.source === "Lower" && c.target === "Upper").id;
    return { layout, id };
}

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const insideNode = (layout, p) => Array.from(layout.nodes.values())
    .some(n => p.x > n.x + 0.5 && p.x < n.x + n.width - 0.5 && p.y > n.y + 0.5 && p.y < n.y + n.height - 0.5);

["Polyline", "Octilinear", "Orthogonal", "Smooth"].forEach(style => {
    const opts = { curvaturePercent: 50, style, avoidNodes: true, arrows: { heads: false, tails: false, angleDegrees: 90 } };
    {
        const { layout, id } = build(4);
        const lower = layout.nodes.get("Lower"), upper = layout.nodes.get("Upper");
        const defaults = routeDiagram(layout, opts, new Map()).spines.get(id);
        const top = Math.min(...defaults.map(p => p.y));
        const between = defaults.filter(p => p.y > upper.y + upper.height && p.y < lower.y);
        check(`${style}: the default wrap is the S through the gap`,
            top >= upper.y && between.length >= 2,
            `lane y=${between.map(p => p.y.toFixed(0)).join(",")}, node top ${upper.y.toFixed(0)}`);

        const mid = (upper.y + upper.height + lower.y) / 2;
        const spine = routeDiagram(layout, opts,
            new Map([[id, { middle: { x: lower.x, y: mid } }]])).spines.get(id);
        const lane = spine.filter(p => near(p.y, mid));
        check(`${style}: a lane dropped in the gap stays there (an S)`,
            lane.length === 2, `${lane.length} points at y=${mid.toFixed(0)}`);
        check(`${style}: the S keeps below the top of the upper node's face and above the lower node`,
            Math.min(...spine.map(p => p.y)) >= upper.y - 1 && Math.max(...spine.map(p => p.y)) <= lower.y + lower.height + 1);
        check(`${style}: no point of the S is inside a node`,
            !spine.some(p => insideNode(layout, p)));
    }
    {
        // A node in the gap: the S would cut it, so the default stays outside.
        const { layout, id } = build(4, true);
        const upper = layout.nodes.get("Upper");
        const spine = routeDiagram(layout, opts, new Map()).spines.get(id);
        check(`${style}: with a node in the gap the default stays round the outside`,
            Math.min(...spine.map(p => p.y)) < upper.y, `lane at y=${Math.min(...spine.map(p => p.y)).toFixed(0)}`);
    }
    {
        // Dropped on the upper node's own span: held clear, as it always was.
        const { layout, id } = build(4);
        const upper = layout.nodes.get("Upper");
        const inside = upper.y + upper.height / 2;
        const spine = routeDiagram(layout, opts,
            new Map([[id, { middle: { x: upper.x, y: inside } }]])).spines.get(id);
        const top = Math.min(...spine.map(p => p.y));
        check(`${style}: a lane dropped inside a node's own span is still held clear`,
            top < upper.y, `lane at y=${top.toFixed(0)}, node top ${upper.y.toFixed(0)}`);
    }
    {
        // Rows too close together to leave a clearance each side: no gap.
        const { layout, id } = build(1);
        const lower = layout.nodes.get("Lower"), upper = layout.nodes.get("Upper");
        const mid = (upper.y + upper.height + lower.y) / 2;
        const spine = routeDiagram(layout, opts,
            new Map([[id, { middle: { x: lower.x, y: mid } }]])).spines.get(id);
        const tooTight = lower.y - (upper.y + upper.height) < 8;
        if (tooTight) {
            check(`${style}: adjacent rows leave no gap, so the lane is held clear`,
                !spine.some(p => near(p.y, mid)));
        }
    }
});

console.log(`\n${assertions - failures}/${assertions} assertions passed`);
if (failures > 0) {
    console.log(`FAILURES: ${failures}`);
    process.exit(1);
}
