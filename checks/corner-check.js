"use strict";
// A DIRECT route between perpendicular ports is an L: it should turn once.
// In Orthogonal mode it was turning three times -- a staircase -- because the
// corner was placed where the two STUBS' coordinates pair up rather than
// where the two ports' normal rays actually cross.
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors, computeAnchors, anchorKey, routeWraps } = require("./routing-api.js");

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort",
    "sourceNodeColour", "targetNodeColour"];
const CHROME = { legendVisible: false, legendPosition: "Bottom" };

function pipeline(rows, viewport = { w: 1200, h: 700 }) {
    const dv = {
        table: {
            columns: ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
        }
    };
    const { flows } = parseDataView(dv);
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, viewport.w, viewport.h, CHROME);
    return { corridors, layout, anchors: computeAnchors(layout) };
}

function samplePath(d) {
    const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?(e-?\d+)?/g) || [];
    let i = 0, cur = { x: 0, y: 0 };
    const pts = [];
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
        const tok = tokens[i++];
        if (tok === "M" || tok === "L") { cur = { x: num(), y: num() }; pts.push(cur); }
        else if (tok === "C") {
            const c1 = { x: num(), y: num() }, c2 = { x: num(), y: num() }, e = { x: num(), y: num() };
            for (let s = 1; s <= 10; s++) {
                const t = s / 10, mt = 1 - t;
                pts.push({
                    x: mt ** 3 * cur.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * e.x,
                    y: mt ** 3 * cur.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * e.y
                });
            }
            cur = e;
        }
    }
    return pts;
}

/**
 * Right-angle turns around the whole band outline. A single-corner L gives
 * four: one on each of the two long edges, plus the two end caps. Every extra
 * step in a staircase adds two more.
 */
function rightAngles(path) {
    const pts = samplePath(path);
    let count = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const d1 = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
        const d2 = { x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y };
        const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
        if (l1 < 0.5 || l2 < 0.5) continue;
        if (Math.abs((d1.x * d2.x + d1.y * d2.y) / (l1 * l2)) < 0.05) count++;
    }
    return count;
}

const PERPENDICULAR = [
    ["North", "West"], ["North", "East"], ["South", "West"], ["South", "East"],
    ["East", "North"], ["East", "South"], ["West", "North"], ["West", "South"]
];

// ===============================================================
// 1. Every perpendicular DIRECT pairing turns exactly once.
// ===============================================================
PERPENDICULAR.forEach(([sp, tp]) => {
    // Placed so the target is in front of both faces -- a direct L, not a wrap.
    const towardsX = sp === "East" || tp === "West" ? 4 : (sp === "West" || tp === "East" ? 1 : 3);
    const rows = [
        { source: "A", target: "B", value: 30, sourcePort: sp, targetPort: tp,
            sourceColumn: sp === "West" || tp === "East" ? 4 : 1, sourceRow: sp === "North" || tp === "South" ? 4 : 1,
            targetColumn: towardsX, targetRow: sp === "North" || tp === "South" ? 1 : 4 },
        { source: "P", target: "Q", value: 300, sourceColumn: 1, sourceRow: 6, targetColumn: 5, targetRow: 6 }
    ];
    const run = pipeline(rows);
    const id = run.corridors.find(c => c.source === "A").id;
    const s = run.anchors.get(anchorKey(id, "source"));
    const t = run.anchors.get(anchorKey(id, "target"));
    if (!s || !t || routeWraps(s, t)) {
        return; // this placement wrapped; the wrap construction is a different shape
    }

    const band = routeCorridors(run.layout,
        { portLeadInPercent: 18, curvaturePercent: 0, style: "Orthogonal", avoidNodes: false })
        .find(b => b.corridorId === id);
    const turns = rightAngles(band.path);
    // Four is the whole outline of a single-corner L. The bug produced eight.
    check(`${sp}->${tp}: turns once, not in steps`, turns <= 5, `${turns} right angles`);
});

// ===============================================================
// 2. Same-axis DIRECT routes still square off into a Z, which
//    genuinely has two corners -- the fix must not flatten those.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 30, sourceColumn: 1, sourceRow: 1, targetColumn: 4, targetRow: 4 },
        { source: "P", target: "Q", value: 300, sourceColumn: 1, sourceRow: 6, targetColumn: 5, targetRow: 6 }
    ];
    const run = pipeline(rows);
    const id = run.corridors.find(c => c.source === "A").id;
    const band = routeCorridors(run.layout,
        { portLeadInPercent: 18, curvaturePercent: 0, style: "Orthogonal", avoidNodes: false })
        .find(b => b.corridorId === id);
    check("an East->West Z still steps across", rightAngles(band.path) >= 6,
        `${rightAngles(band.path)} right angles`);
}

// ===============================================================
// 3. The clean corner sits where the two normal rays cross, so the
//    route never leaves the box its two anchors span.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 30, sourcePort: "North", targetPort: "West",
            sourceColumn: 1, sourceRow: 4, targetColumn: 3, targetRow: 1 },
        { source: "P", target: "Q", value: 300, sourceColumn: 1, sourceRow: 6, targetColumn: 5, targetRow: 6 }
    ];
    const run = pipeline(rows);
    const id = run.corridors.find(c => c.source === "A").id;
    const s = run.anchors.get(anchorKey(id, "source"));
    const t = run.anchors.get(anchorKey(id, "target"));
    const band = routeCorridors(run.layout,
        { portLeadInPercent: 18, curvaturePercent: 0, style: "Orthogonal", avoidNodes: false })
        .find(b => b.corridorId === id);
    const reach = Math.max(s.halfExtent, t.halfExtent) + 1;
    const box = {
        minX: Math.min(s.point.x, t.point.x) - reach, maxX: Math.max(s.point.x, t.point.x) + reach,
        minY: Math.min(s.point.y, t.point.y) - reach, maxY: Math.max(s.point.y, t.point.y) + reach
    };
    check("a North->West L stays inside its anchors' own box",
        band.bounds.minX >= box.minX && band.bounds.maxX <= box.maxX
        && band.bounds.minY >= box.minY && band.bounds.maxY <= box.maxY,
        `band x ${band.bounds.minX.toFixed(0)}..${band.bounds.maxX.toFixed(0)} ` +
        `y ${band.bounds.minY.toFixed(0)}..${band.bounds.maxY.toFixed(0)} ` +
        `vs box x ${box.minX.toFixed(0)}..${box.maxX.toFixed(0)} y ${box.minY.toFixed(0)}..${box.maxY.toFixed(0)}`);
}

// ===============================================================
// 4. Every style and curvature still routes cleanly.
// ===============================================================
{
    // Polyline replaces a duplicate "Smooth".
    ["Polyline", "Smooth", "Orthogonal"].forEach(style => {
        [0, 35].forEach(curvaturePercent => {
            let bad = 0;
            PERPENDICULAR.forEach(([sp, tp]) => {
                const rows = [
                    { source: "A", target: "B", value: 30, sourcePort: sp, targetPort: tp,
                        sourceColumn: 1, sourceRow: 3, targetColumn: 3, targetRow: 1 },
                    { source: "P", target: "Q", value: 300, sourceColumn: 1, sourceRow: 6, targetColumn: 5, targetRow: 6 }
                ];
                const run = pipeline(rows);
                const bands = routeCorridors(run.layout,
                    { portLeadInPercent: 18, curvaturePercent, style, avoidNodes: true });
                if (bands.length < run.corridors.length) { bad++; return; }
                if (!bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite))) bad++;
            });
            check(`${style} @ curvature ${curvaturePercent}: all 8 perpendicular pairings route`, bad === 0, `${bad} bad`);
        });
    });
}

if (failures === 0) {
    console.log("\nALL CORNER CHECKS PASSED");
} else {
    console.log(`\n${failures} CORNER CHECK(S) FAILED`);
    process.exit(1);
}
