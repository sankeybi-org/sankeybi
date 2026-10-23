"use strict";
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout, NO_RESERVE } = require("./layout-api.js");
const { routeCorridors } = require("./routing-api.js");

let failures = 0;
function check(label, cond) {
    if (!cond) { failures++; console.log(`FAIL: ${label}`); } else { console.log(`ok:   ${label}`); }
}

// Node thickness is a fraction of the column gap now, not a pixel constant,
// so the expected value has to be computed from the layout under test rather
// than written down here.
const NODE_WIDTH_PERCENT = 3;
const thickness = layout =>
    (layout.columnGap > 0 ? layout.columnGap : layout.rowPitch) * NODE_WIDTH_PERCENT / 100;

// ===================================================================
// Node sizing: North/South ports pack along the node's WIDTH, so a node
// carrying more on those edges than the default bar width can hold must
// grow sideways.
// ===================================================================
{
    const flows = [
        { flowID: "f1", source: "A", target: "B", value: 100, sourcePort: "South", targetPort: "North" },
        { flowID: "f2", source: "C", target: "D", value: 100 }
    ];
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    // Minimum height pinned to 0 here: this block is about what the FLOW
    // sizes. The default floor (3% of the row pitch) is asserted below.
    const layout = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom", nodeMinHeightPercent: 0 });

    const a = layout.nodes.get("A");
    const c = layout.nodes.get("C");
    check(`node A (South port, value 100) widened beyond its set thickness (${a.width.toFixed(0)}px)`, a.width > thickness(layout));
    check(`node C (default East/West ports) keeps the set thickness (${c.width.toFixed(0)}px)`, Math.abs(c.width - thickness(layout)) < 0.01);
    // A node is a bar drawn ACROSS its flow, so one dimension is
    // flow-proportional and the other is just the bar's thickness. With all
    // its flow vertical, A's height is the bar thickness -- NOT the
    // zero-flow minimum, which would render a busy node as a 4px sliver.
    // A node's height is the extent its East/West ports pack into, and A
    // has none -- so with Minimum height at its default of 0 it has no
    // height at all, exactly as a horizontal node has no width at a width
    // floor of 0. Setting the floor is what gives it one.
    check(`node A, with no East/West flow, has no height of its own (${a.height.toFixed(0)}px)`,
        a.height === 0, String(a.height));
    const floored = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom", nodeMinHeightPercent: 5 });
    check("...and a height floor gives it one",
        Math.abs(floored.nodes.get("A").height - floored.rowPitch * 0.05) < 0.01,
        `${floored.nodes.get("A").height.toFixed(2)} vs ${(floored.rowPitch * 0.05).toFixed(2)}`);
    // The floor follows the ROW pitch, not the column gap: prove the
    // two differ here, or the assertion above could not tell them apart.
    check("...a fraction of the ROW pitch, which differs from the column gap here",
        Math.abs(floored.rowPitch - floored.columnGap) > 5,
        `rowPitch ${floored.rowPitch.toFixed(1)} vs columnGap ${floored.columnGap.toFixed(1)}`);
    // And the default is 3%: no setting passed at all.
    const byDefault = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom" });
    check("by default the floor is 3% of the row pitch",
        Math.abs(byDefault.nodes.get("A").height - byDefault.rowPitch * 0.03) < 0.01,
        `${byDefault.nodes.get("A").height.toFixed(2)} vs ${(byDefault.rowPitch * 0.03).toFixed(2)}`);
    check("node C is sized by its East/West demand", c.height > 4.01);
}
{
    // The case the bar-thickness rule must stay distinct from: a node with
    // genuinely no flow at all still collapses to the zero-flow minimum.
    const flows = [
        { flowID: "f1", source: "A", target: "B", value: 0 },
        { flowID: "f2", source: "B", target: "C", value: 0 }
    ];
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom", nodeMinHeightPercent: 0 });
    check("a genuinely zero-flow node still collapses to the minimum",
        Array.from(layout.nodes.values()).every(n => n.height <= 4.01));
}
{
    // Regression: a default-ports dataset must be sized exactly as before.
    const flows = [
        { flowID: "f1", source: "A", target: "B", value: 100 },
        { flowID: "f2", source: "A", target: "C", value: 50 }
    ];
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom" });
    const widths = Array.from(layout.nodes.values()).map(n => n.width);
    check("default-port diagram: every node keeps the set thickness", widths.every(w => Math.abs(w - thickness(layout)) < 0.01));
    check("default-port diagram: node A (throughput 150) is the tallest",
        layout.nodes.get("A").height >= Math.max(...Array.from(layout.nodes.values()).map(n => n.height)));
}

// ===================================================================
// Bands report bounds, and reserving space pulls the layout inward.
// ===================================================================
{
    const flows = [{ flowID: "f1", source: "N", target: "N", value: 40, sourcePort: "East", targetPort: "West" }];
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom" });
    const bands = routeCorridors(layout);

    check("every band reports finite bounds", bands.every(b =>
        Number.isFinite(b.bounds.minX) && Number.isFinite(b.bounds.minY)
        && Number.isFinite(b.bounds.maxX) && Number.isFinite(b.bounds.maxY)));
    check("a self-loop's bounds extend beyond its own node (that's why fitting needs routing first)", (() => {
        const n = layout.nodes.get("N");
        const b = bands[0].bounds;
        return b.minX < n.x || b.maxX > n.x + n.width || b.minY < n.y || b.maxY > n.y + n.height;
    })());
}
{
    const flows = [{ flowID: "f1", source: "A", target: "B", value: 40 }];
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const plain = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom" });
    const reserved = computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom" }, { top: 60, right: 40, bottom: 20, left: 30 });

    check("reserving space moves the layout inward from the left", reserved.nodes.get("A").x > plain.nodes.get("A").x);
    check("reserving space moves the layout inward from the top", reserved.nodes.get("A").y > plain.nodes.get("A").y);
    check("reserving space tightens the column spacing", reserved.columnGap < plain.columnGap);
    check("reserving space tightens the row pitch", reserved.rowPitch < plain.rowPitch);
    check("NO_RESERVE matches the default", computeLayout(graph, corridors, 1200, 800, { legendVisible: false, legendPosition: "Bottom" }, NO_RESERVE).nodes.get("A").x === plain.nodes.get("A").x);
}

if (failures === 0) {
    console.log("\nALL LAYOUT-FIT CHECKS PASSED");
} else {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exit(1);
}
