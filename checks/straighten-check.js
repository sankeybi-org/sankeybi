"use strict";
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors, computeAnchors, anchorKey } = require("./routing-api.js");
const { straightenNodes } = require("./lib/straighten.js");

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

// ---------------------------------------------------------------
// Helpers: drive the real pipeline from plain rows.
// ---------------------------------------------------------------
const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort"];

function dataViewOf(rows) {
    return {
        table: {
            columns: ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
        }
    };
}

function pipeline(rows, straighten, viewport = { w: 1400, h: 800 }) {
    const { flows, warnings } = parseDataView(dataViewOf(rows));
    const { graph, warnings: gw } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, viewport.w, viewport.h, { legendVisible: false, legendPosition: "Bottom" });
    const before = computeAnchors(layout);
    const beforePositions = new Map(Array.from(layout.nodes.values()).map(n => [n.id, { x: n.x, y: n.y }]));
    straightenNodes(layout, straighten);
    return {
        warnings: warnings.concat(gw), graph, corridors, layout,
        before, beforePositions, after: computeAnchors(layout)
    };
}

const misalignmentY = (anchors, id) => {
    const s = anchors.get(anchorKey(id, "source"));
    const t = anchors.get(anchorKey(id, "target"));
    return Math.abs(t.point.y - s.point.y);
};
const misalignmentX = (anchors, id) => {
    const s = anchors.get(anchorKey(id, "source"));
    const t = anchors.get(anchorKey(id, "target"));
    return Math.abs(t.point.x - s.point.x);
};

// ===============================================================
// 1. Decimal grid positions survive parsing and place continuously.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10, sourceColumn: 1, sourceRow: 1, targetColumn: 2.5, targetRow: 2 },
        { source: "A", target: "C", value: 10, targetColumn: 4, targetRow: 1 }
    ];
    const { warnings, graph, layout } = pipeline(rows, 0);
    check("no warnings for a decimal column", warnings.filter(w => w.includes("SourceColumn") || w.includes("TargetColumn")).length === 0,
        warnings.join(" | "));
    check("B keeps its decimal column", graph.nodes.get("B").column === 2.5, String(graph.nodes.get("B").column));

    // A at column 1, C at column 4, B at 2.5 -> exactly halfway between them.
    const a = layout.nodes.get("A"), b = layout.nodes.get("B"), c = layout.nodes.get("C");
    const halfway = (a.x + c.x) / 2;
    check("a node at column 2.5 lands exactly halfway between columns 1 and 4",
        Math.abs(b.x - halfway) < 0.001, `${b.x.toFixed(2)} vs ${halfway.toFixed(2)}`);
}

// A decimal row places continuously too.
{
    const rows = [
        { source: "A", target: "B", value: 10, sourceRow: 1, targetRow: 1 },
        { source: "A", target: "C", value: 10, targetRow: 3 },
        { source: "A", target: "D", value: 10, targetRow: 2 }
    ];
    const { layout } = pipeline(rows, 0);
    const rowsDec = [
        { source: "A", target: "B", value: 10, sourceRow: 1, targetRow: 1 },
        { source: "A", target: "C", value: 10, targetRow: 3 },
        { source: "A", target: "D", value: 10, targetRow: 2.5 }
    ];
    const dec = pipeline(rowsDec, 0).layout;
    const centre = n => n.y + n.height / 2;
    const b = centre(layout.nodes.get("B")), c = centre(layout.nodes.get("C"));
    const dWhole = centre(layout.nodes.get("D")), dHalf = centre(dec.nodes.get("D"));
    check("a decimal row moves the node partway toward the next row",
        dHalf > dWhole + 1 && dHalf < c - 1, `${dWhole.toFixed(1)} -> ${dHalf.toFixed(1)} (row 3 at ${c.toFixed(1)})`);
    void b;
}

// ===============================================================
// 3. A decimal column stays a LOCAL nudge: downstream auto columns
//    take the next whole column, not 3.5 -> 4.5 -> 5.5.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10, sourceColumn: 3.5 },
        { source: "B", target: "C", value: 10 }
    ];
    const { graph } = pipeline(rows, 0);
    check("successor of a node at column 3.5 lands on column 4", graph.nodes.get("B").column === 4,
        String(graph.nodes.get("B").column));
    check("and the one after it on column 5 (no drift)", graph.nodes.get("C").column === 5,
        String(graph.nodes.get("C").column));
}

// Whole-number layering is bit-for-bit unchanged.
{
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "B", target: "C", value: 10 },
        { source: "A", target: "C", value: 5 }
    ];
    const { graph } = pipeline(rows, 0);
    check("integer layering unchanged: A=1 B=2 C=3",
        graph.nodes.get("A").column === 1 && graph.nodes.get("B").column === 2 && graph.nodes.get("C").column === 3,
        `${graph.nodes.get("A").column}/${graph.nodes.get("B").column}/${graph.nodes.get("C").column}`);
}

// ===============================================================
// 4. A node at a decimal column takes its row from the NEAREST whole
//    column's queue, so it doesn't collide with whatever is at row 1.
// ===============================================================
{
    const rows = [
        { source: "S", target: "P", value: 10, targetColumn: 3 },
        { source: "S", target: "Q", value: 10, targetColumn: 2.6 },
        { source: "S", target: "R", value: 10, targetColumn: 3 }
    ];
    const { graph } = pipeline(rows, 0);
    check("P holds row 1 of column 3", graph.nodes.get("P").row === 1, String(graph.nodes.get("P").row));
    check("Q at column 2.6 buckets with column 3 and takes row 2", graph.nodes.get("Q").row === 2,
        String(graph.nodes.get("Q").row));
    check("R then takes row 3, not row 2", graph.nodes.get("R").row === 3, String(graph.nodes.get("R").row));
}

// ===============================================================
// 5. Straighten 0 changes absolutely nothing.
// ===============================================================
{
    const rows = [
        { source: "A", target: "G", value: 40 },
        { source: "B", target: "G", value: 10 },
        { source: "G", target: "C", value: 25 }
    ];
    const off = pipeline(rows, 0);
    let moved = 0;
    off.layout.nodes.forEach(n => {
        const p = off.beforePositions.get(n.id);
        if (Math.abs(n.x - p.x) > 1e-9 || Math.abs(n.y - p.y) > 1e-9) moved++;
    });
    check("Straighten 0 moves no node", moved === 0, `${moved} moved`);
}

// ===============================================================
// 6. The real case: a nearly-horizontal corridor snaps flat.
//    B is a leaf feeding a hub whose packing puts the anchor slightly
//    off B's own centre.
// ===============================================================
{
    const rows = [
        { source: "A", target: "G", value: 40, sourceRow: 1, targetRow: 2 },
        { source: "B", target: "G", value: 30, sourceRow: 2 },
        { source: "C", target: "G", value: 30, sourceRow: 3 },
        { source: "G", target: "D", value: 100 }
    ];
    const before = pipeline(rows, 0);
    const after = pipeline(rows, 60);

    const ids = before.corridors.map(c => c.id);
    let improved = 0, worsened = 0;
    ids.forEach(id => {
        const b = misalignmentY(before.after, id);
        const a = misalignmentY(after.after, id);
        if (a < b - 0.01) improved++;
        if (a > b + 0.01) worsened++;
    });
    check("straightening improves at least one corridor", improved > 0, `${improved} improved`);
    check("total value-weighted misalignment never increases",
        ids.reduce((s, id) => s + misalignmentY(after.after, id), 0) <=
        ids.reduce((s, id) => s + misalignmentY(before.after, id), 0) + 0.01);

    // Every corridor still routes cleanly after the nudge.
    const bands = routeCorridors(after.layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
    check("all corridors still route after nudging", bands.length >= ids.length, `${bands.length} bands`);
    check("all band geometry finite after nudging",
        bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)));
    void worsened;
}

// ===============================================================
// 7. A single-corridor pair snaps EXACTLY straight, and the band that
//    comes out really is flat.
// ===============================================================
{
    // Two independent pairs at different scales, so packing puts A->B's
    // anchors at different heights within their nodes.
    const rows = [
        { source: "A", target: "B", value: 30, sourceRow: 1, targetRow: 1 },
        { source: "A", target: "Z", value: 70, targetRow: 3 }
    ];
    const off = pipeline(rows, 0);
    const on = pipeline(rows, 80);
    const ab = off.corridors.find(c => c.source === "A" && c.target === "B").id;

    check("A->B starts misaligned", misalignmentY(off.after, ab) > 0.5,
        misalignmentY(off.after, ab).toFixed(2));
    check("A->B ends exactly aligned", misalignmentY(on.after, ab) < 0.01,
        misalignmentY(on.after, ab).toFixed(4));

    const bands = routeCorridors(on.layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
    const band = bands.find(b => b.corridorId === ab) ?? bands[0];
    const ys = (band.path.match(/-?\d+(\.\d+)?/g) || []).map(Number).filter((_, i) => i % 2 === 1);
    check("the routed A->B band is dead flat", new Set(ys.map(y => y.toFixed(2))).size === 2,
        `${new Set(ys.map(y => y.toFixed(2))).size} distinct y`);
}

// ===============================================================
// 8. Nudges stay within the tolerance the setting allows, and a bigger
//    setting never moves LESS than a smaller one is allowed to.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 30, sourceRow: 1, targetRow: 1 },
        { source: "A", target: "Z", value: 70, targetRow: 3 },
        { source: "C", target: "D", value: 12, sourceRow: 5, targetRow: 5 },
        { source: "C", target: "Z", value: 55 }
    ];
    [10, 25, 50, 100].forEach(setting => {
        const run = pipeline(rows, setting);
        const budget = (setting / 100) * 0.5 * run.layout.rowPitch;
        let worst = 0;
        run.layout.nodes.forEach(n => {
            const p = run.beforePositions.get(n.id);
            worst = Math.max(worst, Math.abs(n.y - p.y), Math.abs(n.x - p.x));
        });
        check(`Straighten ${setting}: no node moves past its tolerance`, worst <= budget + 0.01,
            `moved ${worst.toFixed(2)} of ${budget.toFixed(2)}`);
    });
}

// ===============================================================
// 9. Vertical corridors (North/South ports) straighten along x.
// ===============================================================
{
    // A's South edge carries TWO corridors, so the A->B slot packs off-centre
    // and its anchor no longer lines up with B's single, centred North slot.
    const rows = [
        { source: "A", target: "B", value: 20, sourcePort: "South", targetPort: "North", sourceRow: 1, targetRow: 3, sourceColumn: 1, targetColumn: 1 },
        { source: "A", target: "E", value: 45, sourcePort: "South", targetPort: "North", sourceRow: 1, targetRow: 5, targetColumn: 1 },
        { source: "A", target: "C", value: 60, targetColumn: 3 }
    ];
    const off = pipeline(rows, 0);
    const on = pipeline(rows, 80);
    const ae = off.corridors.find(c => c.source === "A" && c.target === "E").id;
    check("A->E (South->North) starts misaligned in x", misalignmentX(off.after, ae) > 0.5,
        misalignmentX(off.after, ae).toFixed(2));
    check("A->E ends aligned in x", misalignmentX(on.after, ae) < 0.01,
        misalignmentX(on.after, ae).toFixed(4));
}

// ===============================================================
// 10. Ineligible corridors are left alone: same-facing ports, and
//     perpendicular pairings, can never be straight lines.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 20, sourcePort: "East", targetPort: "East", sourceRow: 1, targetRow: 1 },
        { source: "C", target: "D", value: 20, sourcePort: "East", targetPort: "North", sourceRow: 3, targetRow: 3 }
    ];
    const run = pipeline(rows, 100);
    let moved = 0;
    run.layout.nodes.forEach(n => {
        const p = run.beforePositions.get(n.id);
        if (Math.abs(n.x - p.x) > 1e-9 || Math.abs(n.y - p.y) > 1e-9) moved++;
    });
    check("same-facing and perpendicular pairings are never nudged", moved === 0, `${moved} moved`);
}

// ===============================================================
// 11. Straightening never makes two nodes overlap.
// ===============================================================
{
    const rows = [];
    for (let i = 0; i < 8; i++) {
        rows.push({ source: `S${i}`, target: "HUB", value: 10 + i * 7 });
        rows.push({ source: "HUB", target: `T${i}`, value: 8 + i * 5 });
    }
    const run = pipeline(rows, 100, { w: 900, h: 500 });
    const list = Array.from(run.layout.nodes.values());
    let overlaps = 0;
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
                overlaps++;
            }
        }
    }
    check("no node overlaps another after straightening a crowded hub", overlaps === 0, `${overlaps} overlaps`);

    const bands = routeCorridors(run.layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
    check("crowded hub still routes cleanly", bands.length === run.corridors.length, `${bands.length} bands`);
}

// ===============================================================
// 12. Straightening is idempotent — running it again changes nothing.
// ===============================================================
{
    const rows = [
        { source: "A", target: "G", value: 40 },
        { source: "B", target: "G", value: 25 },
        { source: "G", target: "C", value: 65 }
    ];
    const run = pipeline(rows, 70);
    const snapshot = new Map(Array.from(run.layout.nodes.values()).map(n => [n.id, { x: n.x, y: n.y }]));
    straightenNodes(run.layout, 70);
    let drifted = 0;
    run.layout.nodes.forEach(n => {
        const p = snapshot.get(n.id);
        if (Math.abs(n.x - p.x) > 1e-9 || Math.abs(n.y - p.y) > 1e-9) drifted++;
    });
    check("a second straighten pass is a no-op", drifted === 0, `${drifted} drifted`);
}

// ===============================================================
// 13. The less-constrained end gives way: a busy hub stays put and its
//     single-corridor neighbours move to meet it.
// ===============================================================
{
    const rows = [
        { source: "H", target: "X", value: 40 },
        { source: "H", target: "Y", value: 30 },
        { source: "H", target: "Z", value: 20 },
        { source: "W", target: "H", value: 25 },
        { source: "V", target: "H", value: 15 }
    ];
    const movedIn = (run, id) => Math.abs(run.layout.nodes.get(id).y - run.beforePositions.get(id).y) > 1e-9;

    // The degree gate: at Straighten 10 only single-corridor nodes are even
    // considered, so the 5-corridor hub is off limits...
    check("the 5-corridor hub is not moved at Straighten 10", !movedIn(pipeline(rows, 10), "H"));
    // ...and at Straighten 100, where every node is eligible, it still holds
    // still because chooseMover always sacrifices the leaf instead.
    const full = pipeline(rows, 100);
    check("the hub still holds still at Straighten 100 (the leaf gives way)", !movedIn(full, "H"));
    const leavesMoved = ["X", "Y", "Z", "W", "V"].filter(id => movedIn(full, id)).length;
    check("its single-corridor neighbours are the ones that move", leavesMoved > 0, `${leavesMoved} of 5`);
}

if (failures === 0) {
    console.log("\nALL STRAIGHTEN CHECKS PASSED");
} else {
    console.log(`\n${failures} STRAIGHTEN CHECK(S) FAILED`);
    process.exit(1);
}
