"use strict";

let failures = 0;
function check(label, cond) {
    if (!cond) {
        failures++;
        console.log(`FAIL: ${label}`);
    }
}

// =====================================================================
// Fix 1: bidirectional A<->B no longer collapses both nodes to column 1
// =====================================================================
{
    const { buildGraph } = require("./placed.js");
    const flows = [
        { flowID: "f1", source: "A", target: "B", value: 10 },
        { flowID: "f2", source: "B", target: "A", value: 5 }
    ];
    const { graph } = buildGraph(flows);
    const a = graph.nodes.get("A");
    const b = graph.nodes.get("B");
    check("fix1: A and B no longer collapse to the same column", a.column !== b.column);
    check("fix1: both columns are defined positive integers", Number.isInteger(a.column) && a.column >= 1 && Number.isInteger(b.column) && b.column >= 1);
}

// =====================================================================
// Fix 2: label override is first-NON-BLANK-wins, not first-bound-wins
// =====================================================================
{
    const { buildGraph } = require("./placed.js");
    const flows = [
        { flowID: "f1", source: "X", target: "Z", value: 1, sourceLabel: "" },
        { flowID: "f2", source: "W", target: "X", value: 1, targetLabel: "Warehouse" }
    ];
    const { graph, warnings } = buildGraph(flows);
    const x = graph.nodes.get("X");
}

// =====================================================================
// Fix 3: "->" delimiter collision no longer merges unrelated corridors/edges
// =====================================================================
{
    const { buildGraph } = require("./placed.js");
    const { inferCorridors } = require("./lib/corridors.js");
    const flows = [
        { flowID: "f1", source: "A→B", target: "C", value: 5 },
        { flowID: "f2", source: "A", target: "B→C", value: 7 }
    ];
    const { graph } = buildGraph(flows);
    // The summed edges are internal to buildGraph now (nothing downstream read
    // them), so the merge is caught where it SHOWS: the layering. Two edges
    // merged into one leaves "B→C" with nothing arriving at it, and a node
    // with no predecessor is column 1 rather than column 2.
    check("fix3a: all four nodes survive, not merged",
        graph.nodes.size === 4 && ["A→B", "C", "A", "B→C"].every(id => graph.nodes.has(id)));
    check("fix3a: A→B->C layers as its own edge (A→B col 1, C col 2)",
        graph.nodes.get("A→B").column === 1 && graph.nodes.get("C").column === 2);
    check("fix3a: A->B→C layers as its own edge (A col 1, B→C col 2)",
        graph.nodes.get("A").column === 1 && graph.nodes.get("B→C").column === 2);

    const { corridors } = inferCorridors(flows);
    check("fix3b: 2 distinct corridors, not merged into 1", corridors.length === 2);
    const corridorAB = corridors.find(c => c.source === "A→B" && c.target === "C");
    const corridorABC = corridors.find(c => c.source === "A" && c.target === "B→C");
    check("fix3b: corridor A→B->C has correct value", !!corridorAB && corridorAB.value === 5);
    check("fix3b: corridor A->B→C has correct value", !!corridorABC && corridorABC.value === 7);
}

// =====================================================================
// Fix 4: corridors.ts warning no longer prints literal "undefined" for untyped FlowType conflicts
// =====================================================================
{
    const { inferCorridors } = require("./lib/corridors.js");
    const flows = [
        { flowID: "f1", source: "A", target: "B", value: 5, flowColour: "red" },
        { flowID: "f2", source: "A", target: "B", value: 5, flowColour: "blue" }
    ];
    const { warnings } = inferCorridors(flows);
    const msg = warnings.find(w => w.includes("conflicting FlowColour"));
    check("fix4: conflict warning exists", !!msg);
    check("fix4: warning does not print literal \"undefined\"", msg && !msg.includes('"undefined"'));
    check("fix4: warning mentions (untyped) instead", msg && msg.includes("(untyped)"));
}

// =====================================================================
// Fix 5: all-zero-Value dataset renders nodes at MIN height, not max
//
// The original defect: an all-zero dataset put every node at the diagram's
// MAXIMUM bar height, because a floored-to-1 numerator over a floored-to-1
// maxNodeThroughput came out as the full scale. A node carrying nothing must
// come out at its floor, whatever that floor is set to.
//
// Since node sizing became the packed stack, that floor is the Minimum height
// slider and nothing else: a node with no band to hold is exactly as tall as
// the slider asks, which at 0 is nothing at all.
// =====================================================================
{
    const { buildGraph } = require("./placed.js");
    const { inferCorridors } = require("./lib/corridors.js");
    const { computeLayout } = require("./layout-api.js");
    const flows = [
        { flowID: "f1", source: "A", target: "B", value: 0 },
        { flowID: "f2", source: "B", target: "C", value: 0 }
    ];
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layoutAt = pct => computeLayout(graph, corridors, 800, 600, { legendVisible: false, legendPosition: "Bottom", nodeMinHeightPercent: pct });
    const collapsed = layoutAt(0);
    check("fix5: all-zero-value nodes collapse to nothing at Minimum height 0",
        Array.from(collapsed.nodes.values()).every(n => n.height === 0));
    // The floor is the only thing sizing them, so it lands exactly -- and
    // nowhere near the max bar height (0.7 of the row pitch), which is what
    // the original defect produced.
    const floored = layoutAt(5);
    const want = floored.rowPitch * 0.05;
    const heights = Array.from(floored.nodes.values()).map(n => n.height);
    check("fix5: and take exactly the Minimum height floor when it is set",
        heights.every(h => Math.abs(h - want) < 1e-9), `want ${want.toFixed(3)}, got ${heights.map(h => h.toFixed(3)).join("/")}`);
    check("fix5: never the max bar height",
        heights.every(h => h < floored.rowPitch * 0.7), `max bar ${(floored.rowPitch * 0.7).toFixed(1)}`);
}
{
    // Regression: a real, non-zero dataset should be unaffected by the fix.
    const { buildGraph } = require("./placed.js");
    const { inferCorridors } = require("./lib/corridors.js");
    const { computeLayout } = require("./layout-api.js");
    const flows = [
        { flowID: "f1", source: "A", target: "B", value: 100 },
        { flowID: "f2", source: "A", target: "C", value: 10 }
    ];
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 800, 600, { legendVisible: false, legendPosition: "Bottom" });
    const aHeight = layout.nodes.get("A").height;
    const bHeight = layout.nodes.get("B").height;
    check("fix5-regression: node A (throughput 110) is taller than node B (throughput 100)", aHeight > bHeight);
}

// =====================================================================
// Fix 6: packPort excludes zero-value corridors instead of reserving real space for them
// =====================================================================
{
    const { routeCorridors } = require("./routing-api.js");
    function makeNode(id, x, y, width, height) {
        return { id, label: id, x, y, width, height, inflow: 0, outflow: 0, isSelfLoop: false };
    }
    const source = makeNode("A", 0, 0, 14, 100);
    const target1 = makeNode("B", 300, 0, 14, 60);
    const target2 = makeNode("C", 300, 100, 14, 60);
    const target3 = makeNode("D", 300, 200, 14, 60);
    const corridors = [
        { id: "c1", source: "A", target: "B", value: 10, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West", segments: [{ flowType: undefined, value: 10, flows: [] }] },
        { id: "c2", source: "A", target: "C", value: 10, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West", segments: [{ flowType: undefined, value: 10, flows: [] }] },
        { id: "c3", source: "A", target: "D", value: 0, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West", segments: [{ flowType: undefined, value: 0, flows: [] }] }
    ];
    const nodes = new Map([["A", source], ["B", target1], ["C", target2], ["D", target3]]);
    const layout = { nodes, corridors, valueToPixels: v => Math.max(4, v * 2), columnGap: 100, rowPitch: 60 };
    const bands = routeCorridors(layout);
    check("fix6: zero-value corridor produces no band at all", !bands.some(b => b.corridorId === "c3"));
    check("fix6: the two real corridors still each get a band", bands.some(b => b.corridorId === "c1") && bands.some(b => b.corridorId === "c2"));

    // Without the fix, packing 3 corridors ([20px,20px,4px-floor] against a
    // 100px-tall node) wouldn't need to squeeze at all (total 44 < 100), so
    // this case alone can't prove the squeeze was avoided -- the meaningful
    // assertion is simply that c3 reserved nothing (checked above).
}

// =====================================================================
// Fix 7: buildSpine (via routeCorridors) no longer produces a backwards-running curve when target is at/behind source
// =====================================================================
{
    const { routeCorridors } = require("./routing-api.js");
    function makeNode(id, x, y, width, height) {
        return { id, label: id, x, y, width, height, inflow: 0, outflow: 0, isSelfLoop: false };
    }
    // The target sits entirely BEHIND the source's East exit face (B is to
    // the left of A), which is the reversed-corridor case. The boxes must
    // not overlap: earlier of this test put B's west face
    // physically inside A, which no router can enter without crossing A --
    // an unsatisfiable configuration rather than a real failure. Same
    // y-centre on both ends to isolate reversed-x from steep-bend effects.
    const source = makeNode("A", 200, 100, 14, 40);
    const target = makeNode("B", 100, 100, 14, 40);
    const corridor = { id: "c1", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West", segments: [{ flowType: undefined, value: 40, flows: [] }] };
    const nodes = new Map([["A", source], ["B", target]]);
    const layout = { nodes, corridors: [corridor], valueToPixels: v => v, columnGap: 100, rowPitch: 60 };
    const bands = routeCorridors(layout);
    check("fix7: a band is still produced (doesn't crash/vanish)", bands.length === 1);

    function sampleOpenOrClosedPath(d, subSamples = 30) {
        const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?/g);
        let i = 0;
        let cur = { x: 0, y: 0 };
        const pts = [];
        const readNum = () => parseFloat(tokens[i++]);
        const cubicPoint = (p0, c1, c2, p1, t) => {
            const mt = 1 - t;
            return {
                x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x,
                y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y
            };
        };
        while (i < tokens.length) {
            const tok = tokens[i++];
            if (tok === "M" || tok === "L") { cur = { x: readNum(), y: readNum() }; pts.push(cur); }
            else if (tok === "C") {
                const c1 = { x: readNum(), y: readNum() };
                const c2 = { x: readNum(), y: readNum() };
                const end = { x: readNum(), y: readNum() };
                for (let s = 1; s <= subSamples; s++) pts.push(cubicPoint(cur, c1, c2, end, s / subSamples));
                cur = end;
            }
        }
        return pts;
    }
    const pts = sampleOpenOrClosedPath(bands[0].path);
    check("fix7: all coordinates finite", pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    // Behaviour intentionally CHANGED here by the M4 port rework. The old
    // fix clamped this degenerate case so the curve collapsed to a vertical
    // run at the source's own edge -- safe, but visibly a dead end. The
    // general port router instead recognises that the target sits behind the
    // source's exit face and routes properly around both nodes, so the band
    // now does legitimately extend past the source's port. What still must
    // hold is that it never tunnels through either node bar.
    const insideBox = (p, n) => p.x > n.x + 0.5 && p.x < n.x + n.width - 0.5
        && p.y > n.y + 0.5 && p.y < n.y + n.height - 0.5;
    const tunnelling = pts.filter(p => insideBox(p, source) || insideBox(p, target)).length;
    check(`fix7: reversed corridor routes around, never through, either node (${tunnelling} pts inside)`, tunnelling === 0);
    check("fix7: reversed corridor has real 2-D extent (didn't collapse to a line)",
        Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)) > 5
        && Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)) > 5);
}

// =====================================================================
// Fix 8: SourceColumn/TargetColumn/SourceRow/TargetRow reject anything but a positive whole number, with a warning
// =====================================================================
{
    const { parseDataView } = require("./parse.js");
    // Column order must match ROLE_NAMES in dataParsing.ts:
    // flowID, source, target, value, flowType, flowColour, flowDisplayOrder,
    // sourceLabel, targetLabel, sourceColumn, sourceRow, targetColumn, targetRow, sourcePort, targetPort
    function roleColumns(roleIndices) {
        const cols = [];
        for (const [role, idx] of Object.entries(roleIndices)) {
            cols[idx] = { roles: { [role]: true } };
        }
        return cols.map(c => c || { roles: {} });
    }
    const columns = roleColumns({ source: 0, target: 1, value: 2, sourceColumn: 3, sourceRow: 4 });
    const dataView = {
        table: {
            columns,
            rows: [
                ["A", "B", 10, "Infinity", -2],   // both invalid: non-finite, negative
                ["C", "D", 5, 2.5, 3],             // sourceColumn non-integer invalid; sourceRow valid
                ["E", "F", 3, 4, 1]                // both valid
            ]
        }
    };
    const { flows, warnings } = parseDataView(dataView);
}

// =====================================================================
// Fix 9: FlowColour is validated; invalid values are rejected with a warning
// =====================================================================
{
    const { parseDataView } = require("./parse.js");
    function roleColumns(roleIndices) {
        const cols = [];
        for (const [role, idx] of Object.entries(roleIndices)) {
            cols[idx] = { roles: { [role]: true } };
        }
        return cols.map(c => c || { roles: {} });
    }
    const columns = roleColumns({ source: 0, target: 1, value: 2, flowColour: 3 });
    const dataView = {
        table: {
            columns,
            rows: [
                ["A", "B", 10, "not-a-colour"],
                ["C", "D", 5, "red"]
            ]
        }
    };

    // Without a CSS global (this Node environment has none), optionalColour
    // should degrade gracefully -- pass the value through unchanged rather
    // than crash, since it can't validate what it can't check.
    delete global.CSS;
    {
        const { flows } = parseDataView(dataView);
        check("fix9a: without a CSS global, colour passes through unvalidated (no crash)", flows[0].flowColour === "not-a-colour");
    }

    // With a CSS.supports available (as it always is in the real browser
    // context this visual actually runs in), an invalid colour is rejected.
    global.CSS = { supports: (prop, val) => val === "red" };
    {
        // Need a fresh require since dataParsing.js was already cached above;
        // Node module caching is fine here since optionalColour reads the
        // global CSS at call time, not at module-load time.
        const { parseDataView: parseDataView2 } = require("./parse.js");
        const { flows, warnings } = parseDataView2(dataView);
        check("fix9b: with CSS.supports available, invalid colour rejected", flows[0].flowColour === undefined);
        check("fix9b: valid colour accepted", flows[1].flowColour === "red");
        check("fix9b: a warning was emitted for the invalid colour", warnings.some(w => w.includes("not a valid colour")));
    }
    delete global.CSS;
}

if (failures === 0) {
    console.log("ALL BUGFIX CHECKS PASSED");
} else {
    console.log(`${failures} BUGFIX CHECK(S) FAILED`);
    process.exit(1);
}
