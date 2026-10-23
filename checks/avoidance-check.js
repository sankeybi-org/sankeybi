"use strict";
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors } = require("./routing-api.js");

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
// Polyline replaces a duplicate "Smooth" left
// by the Hybrid rename.
const STYLES = ["Polyline", "Smooth", "Orthogonal"];

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
    return { corridors, layout: computeLayout(graph, corridors, viewport.w, viewport.h, CHROME) };
}

function route(layout, opts = {}) {
    return routeCorridors(layout, Object.assign(
        { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth", avoidNodes: true }, opts));
}

/**
 * Points along the rendered band outline, M/L/C aware.
 *
 * STRAIGHT segments are subdivided too, not just their endpoints. That
 * mattered: a long axis-aligned run passing clean through a node has neither
 * end inside it, so an endpoints-only sampler reported no intrusion at all
 * and the tunnelling checks below were passing for the wrong reason.
 */
function samplePath(d, sub = 12) {
    const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?(e-?\d+)?/g) || [];
    let i = 0, cur = { x: 0, y: 0 };
    const pts = [];
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
        const tok = tokens[i++];
        if (tok === "M") { cur = { x: num(), y: num() }; pts.push(cur); }
        else if (tok === "L") {
            const end = { x: num(), y: num() };
            for (let s = 1; s <= sub; s++) {
                const t = s / sub;
                pts.push({ x: cur.x + (end.x - cur.x) * t, y: cur.y + (end.y - cur.y) * t });
            }
            cur = end;
        }
        else if (tok === "C") {
            const c1 = { x: num(), y: num() }, c2 = { x: num(), y: num() }, e = { x: num(), y: num() };
            for (let s = 1; s <= sub; s++) {
                const t = s / sub, mt = 1 - t;
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
 * Which unrelated nodes each band's RENDERED OUTLINE passes through. Tested on
 * the drawn path rather than the centreline, so a band whose edges clip a node
 * its centreline missed still counts -- that distinction has been the source
 * of every geometry bug in this project.
 */
function intrusions(layout, bands, tolerance = 1) {
    const hits = [];
    bands.forEach(band => {
        const pts = samplePath(band.path);
        layout.nodes.forEach(n => {
            if (n.id === band.source || n.id === band.target) return;
            const inside = pts.some(p =>
                p.x > n.x + tolerance && p.x < n.x + n.width - tolerance &&
                p.y > n.y + tolerance && p.y < n.y + n.height - tolerance);
            if (inside) hits.push(`${band.source}->${band.target} through ${n.id}`);
        });
    });
    return Array.from(new Set(hits));
}

// ===============================================================
// 1. The reported case: a node parked in a corridor's path.
//    Grid -> Buildings runs straight over District Heating.
// ===============================================================
// A tall node parked across a horizontal run — the shape that turns up
// after dragging something into a corridor's path. Deliberately a BIG
// obstacle: a thin 14px bar is easy for a bowing curve to miss by luck, and
// a test that passes by luck proves nothing.
const OBSTRUCTED = [
    { source: "A", target: "Z", value: 60, sourceColumn: 1, sourceRow: 2, targetColumn: 5, targetRow: 2 },
    { source: "Big1", target: "Big2", value: 400, sourceColumn: 3, sourceRow: 2, targetColumn: 3, targetRow: 5 }
];
{
    const { layout } = pipeline(OBSTRUCTED);
    const before = intrusions(layout, route(layout, { avoidNodes: false }));
    const after = intrusions(layout, route(layout, { avoidNodes: true }));

    check("without avoidance the corridor cuts through the node in its path",
        before.length > 0, before.join(", ") || "none — test premise broken");
    check("with avoidance it doesn't", after.length === 0, after.join(", "));
}

// ===============================================================
// 2. It works in every routing style, and at sharp corners.
// ===============================================================
{
    const { layout } = pipeline(OBSTRUCTED);
    STYLES.forEach(style => {
        [35, 0].forEach(curvaturePercent => {
            const off = intrusions(layout, route(layout, { style, curvaturePercent, avoidNodes: false }));
            const on = intrusions(layout, route(layout, { style, curvaturePercent, avoidNodes: true }));
            check(`${style} @ curvature ${curvaturePercent}: obstructed without avoidance`,
                off.length > 0, "premise: nothing to avoid");
            check(`${style} @ curvature ${curvaturePercent}: clear with avoidance`,
                on.length === 0, on.join(", "));
            const bands = route(layout, { style, curvaturePercent, avoidNodes: true });
            check(`${style} @ curvature ${curvaturePercent}: geometry stays finite`,
                bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)));
        });
    });
}

// ===============================================================
// 3. A corridor with nothing in its way is BYTE-IDENTICAL to the
//    same corridor with avoidance switched off. The single
//    tangent-matched arc that makes an aligned run dead straight
//    must not be replaced by a waypoint chain for no reason.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 30, sourceRow: 1, targetRow: 1 },
        { source: "C", target: "D", value: 20, sourceRow: 3, targetRow: 3 }
    ];
    const { layout } = pipeline(rows);
    const off = route(layout, { avoidNodes: false });
    const on = route(layout, { avoidNodes: true });
    const same = off.every((b, i) => b.path === on[i].path);
    check("an unobstructed diagram is untouched by avoidance", same,
        same ? "" : off.map((b, i) => b.path === on[i].path ? "" : `${b.source}->${b.target}`).filter(Boolean).join(", "));

    // And still dead straight.
    // sub = 1 gives just the vertices: the end caps are vertical runs, and
    // subdividing those would contribute a spread of intermediate y values
    // that says nothing about whether the band is flat.
    const straight = on.find(b => b.source === "A");
    const ys = new Set(samplePath(straight.path, 1).map(p => p.y.toFixed(2)));
    check("an aligned corridor is still a flat straight band", ys.size === 2, `${ys.size} distinct y`);
}

// ===============================================================
// 4. Determinism, and no dependence on declaration order.
// ===============================================================
{
    const rows = [
        { source: "A", target: "Z", value: 100, sourceColumn: 1, sourceRow: 2, targetColumn: 4, targetRow: 2 },
        { source: "A", target: "M", value: 30, targetColumn: 2, targetRow: 2 },
        { source: "A", target: "N", value: 25, targetColumn: 3, targetRow: 2 }
    ];
    const { layout } = pipeline(rows);
    const a = route(layout).map(b => b.path).join("|");
    const b = route(layout).map(x => x.path).join("|");
    check("routing the same layout twice gives identical paths", a === b);

    // The obstacle list comes from iterating the nodes map, so its order is
    // an implementation detail that must not reach the output. Same layout,
    // same positions, nodes enumerated backwards.
    const { layout: obstructed } = pipeline(OBSTRUCTED);
    const reordered = Object.assign({}, obstructed, {
        nodes: new Map(Array.from(obstructed.nodes.entries()).reverse())
    });
    const forward = route(obstructed).map(x => `${x.source}->${x.target}:${x.path}`).sort().join("|");
    const backward = route(reordered).map(x => `${x.source}->${x.target}:${x.path}`).sort().join("|");
    check("the order nodes are enumerated in doesn't change the routes", forward === backward);
}

// ===============================================================
// 5. It degrades rather than contorts. A node boxed in on all sides
//    can't be routed around; the result must be the plain route, not
//    something wild, and must not hang.
// ===============================================================
{
    const rows = [{ source: "A", target: "Z", value: 100, sourceColumn: 1, sourceRow: 3, targetColumn: 8, targetRow: 3 }];
    // A dense wall of nodes straight across the corridor's path.
    for (let i = 0; i < 6; i++) {
        rows.push({ source: "A", target: `W${i}`, value: 5, targetColumn: 2 + i, targetRow: 3 });
    }
    const { layout } = pipeline(rows);
    const started = Date.now();
    const bands = route(layout);
    const elapsed = Date.now() - started;

    check("a dense wall still routes every corridor", bands.length >= 7, `${bands.length} bands`);
    check("all geometry finite", bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)));
    check("it doesn't take an unreasonable amount of time", elapsed < 2000, `${elapsed}ms`);

    // Bounded: no band should wander far outside the plot chasing a gap.
    const worst = Math.max(...bands.map(b => Math.max(
        -b.bounds.minX, -b.bounds.minY, b.bounds.maxX - 1200, b.bounds.maxY - 700)));
    check("no band flies off chasing an impossible detour", worst < 400, `worst overshoot ${worst.toFixed(0)}px`);
}

// ===============================================================
// 6. Self-loops and wraps still behave -- avoidance must not undo
//    the corner-hugging or the lane choice.
// ===============================================================
{
    const rows = [
        { source: "N", target: "N", value: 12, sourcePort: "East", targetPort: "South" },
        { source: "In", target: "N", value: 40 },
        { source: "N", target: "Out", value: 30 },
        { source: "Far", target: "N", value: 15, sourcePort: "East", targetPort: "West", sourceColumn: 3, targetColumn: 2 }
    ];
    const { layout, corridors } = pipeline(rows);
    const bands = route(layout);
    check("self-loop and wrap diagram routes fully", bands.length >= corridors.length,
        `${bands.length} bands, ${corridors.length} corridors`);
    check("all geometry finite", bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)));

    const loop = bands.find(b => b.isSelfLoop);
    const n = layout.nodes.get("N");
    const pts = samplePath(loop.path);
    check("the self-loop still doesn't cut through its own node",
        !pts.some(p => p.x > n.x + 1 && p.x < n.x + n.width - 1 && p.y > n.y + 1 && p.y < n.y + n.height - 1));
}

// ===============================================================
// 7. Avoidance accounts for the BAND's width, not just its
//    centreline. A fat band whose centre misses a node by a hair
//    would still paint over it.
// ===============================================================
{
    const rows = [
        { source: "A", target: "Z", value: 400, sourceColumn: 1, sourceRow: 2, targetColumn: 4, targetRow: 2 },
        { source: "A", target: "Thin", value: 4, targetColumn: 2, targetRow: 2.55 }
    ];
    const { layout } = pipeline(rows);
    // Zero tolerance: any part of the outline inside the node counts.
    const after = intrusions(layout, route(layout, { avoidNodes: true }), 0);
    check("a wide band clears a node its centreline would have skimmed",
        after.length === 0, after.join(", "));
}

// ===============================================================
// 8. In Orthogonal mode an avoided route must still be ORTHOGONAL.
//
//    It wasn't: the detour dropped two waypoints on a clear lane but
//    nothing to turn the corner into it, so the runs either side
//    changed both coordinates at once. Curved styles hid it; every
//    avoided corridor in Orthogonal had four diagonal runs.
// ===============================================================
/** Straight-line vertices of a sharp path (curvature 0 emits only M/L). */
let vertices, diagonals;
{
    vertices = d => {
        const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?(e-?\d+)?/g) || [];
        let i = 0;
        const pts = [];
        while (i < tokens.length) {
            const tok = tokens[i++];
            if (tok === "M" || tok === "L") pts.push({ x: parseFloat(tokens[i++]), y: parseFloat(tokens[i++]) });
            else if (tok === "C") { i += 6; pts.push(null); }
        }
        return pts;
    };
    diagonals = d => {
        const pts = vertices(d);
        let n = 0;
        for (let i = 1; i < pts.length; i++) {
            if (!pts[i] || !pts[i - 1]) continue;
            if (Math.abs(pts[i].x - pts[i - 1].x) > 0.5 && Math.abs(pts[i].y - pts[i - 1].y) > 0.5) n++;
        }
        return n;
    };

    const shapes = {
        "a tall node across a horizontal run": [
            { source: "A", target: "Z", value: 30, sourceColumn: 1, sourceRow: 2, targetColumn: 5, targetRow: 2 },
            { source: "Big1", target: "Big2", value: 400, sourceColumn: 3, sourceRow: 2, targetColumn: 3, targetRow: 5 }
        ],
        "a node across a stepped run": [
            { source: "A", target: "Z", value: 30, sourceColumn: 1, sourceRow: 1, targetColumn: 5, targetRow: 4 },
            { source: "Big1", target: "Big2", value: 400, sourceColumn: 3, sourceRow: 2, targetColumn: 3, targetRow: 5 }
        ],
        "a node in the way of a vertical run": [
            { source: "A", target: "Z", value: 30, sourcePort: "South", targetPort: "North", sourceColumn: 2, sourceRow: 1, targetColumn: 2, targetRow: 6 },
            { source: "W1", target: "W2", value: 400, sourceColumn: 2, sourceRow: 3, targetColumn: 5, targetRow: 3 }
        ]
    };

    Object.entries(shapes).forEach(([name, rows]) => {
        const { layout } = pipeline(rows);
        const on = route(layout, { style: "Orthogonal", curvaturePercent: 0, avoidNodes: true });
        const off = route(layout, { style: "Orthogonal", curvaturePercent: 0, avoidNodes: false });
        const band = on.find(b => b.source === "A");
        const plain = off.find(b => b.source === "A");

        check(`${name}: avoidance is doing something`, band.path !== plain.path);
        check(`${name}: every run stays axis-aligned`, diagonals(band.path) === 0,
            `${diagonals(band.path)} diagonal runs`);
        check(`${name}: and the node is actually cleared`,
            intrusions(layout, on).length === 0, intrusions(layout, on).join(", "));
    });
}

// ===============================================================
// 8b. Where the route can simply step across somewhere else, it
//     does — no detour bump.
//
//     A crossover is a free parameter the route already has, so
//     moving it costs no extra geometry: the corridor comes out as
//     clean as an unobstructed one. A bump is the sort of thing the
//     author then removes by hand, so it's the backstop, not the
//     answer.
// ===============================================================
{
    const corners = path => {
        const pts = samplePath(path);
        let n = 0;
        for (let i = 1; i < pts.length - 1; i++) {
            const d1 = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
            const d2 = { x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y };
            const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
            if (l1 < 0.5 || l2 < 0.5) continue;
            if (Math.abs((d1.x * d2.x + d1.y * d2.y) / (l1 * l2)) < 0.05) n++;
        }
        return n;
    };
    const sharp = { style: "Orthogonal", curvaturePercent: 0 };

    // The two ends are on DIFFERENT rows, so the Z has a real step to move.
    const stepped = [
        { source: "A", target: "Z", value: 30, sourceColumn: 1, sourceRow: 1, targetColumn: 5, targetRow: 4 },
        { source: "Big1", target: "Big2", value: 400, sourceColumn: 3, sourceRow: 2, targetColumn: 3, targetRow: 5 }
    ];
    const { layout } = pipeline(stepped);
    const clean = route(layout, Object.assign({ avoidNodes: false }, sharp)).find(b => b.source === "A");
    const avoided = route(layout, Object.assign({ avoidNodes: true }, sharp)).find(b => b.source === "A");

    // Negative tolerance = the node inflated a little, which is what routing
    // itself tests against: a band whose EDGE would graze a node counts as
    // blocked, and that's the condition this case has to be in for the check
    // below to mean anything. (Measured strictly-inside, it read as clear and
    // the whole case passed vacuously.)
    check("the route really is blocked to begin with",
        intrusions(layout, [clean], -3).length > 0, "premise");
    check("it's cleared", intrusions(layout, route(layout, Object.assign({ avoidNodes: true }, sharp))).length === 0);
    check("and cleared by MOVING the step, not by adding one",
        corners(avoided.path) === corners(clean.path),
        `${corners(clean.path)} corners unobstructed vs ${corners(avoided.path)} avoided`);
    check("the step really did move",
        avoided.path !== clean.path);

    // Where the two ends are level there is no step to move, so the bump is
    // the honest fallback rather than a failure.
    const level = [
        { source: "A", target: "Z", value: 30, sourceColumn: 1, sourceRow: 2, targetColumn: 5, targetRow: 2 },
        { source: "Big1", target: "Big2", value: 400, sourceColumn: 3, sourceRow: 2, targetColumn: 3, targetRow: 5 }
    ];
    const flat = pipeline(level);
    const flatAvoided = route(flat.layout, Object.assign({ avoidNodes: true }, sharp));
    check("a level corridor with a node dead ahead still gets round it",
        intrusions(flat.layout, flatAvoided).length === 0,
        intrusions(flat.layout, flatAvoided).join(", "));
    check("...by detouring, since it has no step to move",
        corners(flatAvoided.find(b => b.source === "A").path)
        > corners(route(flat.layout, Object.assign({ avoidNodes: false }, sharp)).find(b => b.source === "A").path));
}

// ===============================================================
// 9. A hand-placed crossover dropped inside a node is slid clear.
// ===============================================================
{
    // A and Z on DIFFERENT rows, so the Z has a real vertical step for the
    // crossover to move. (With both on one row the step is degenerate and
    // sliding the crossover can't clear anything -- which is exactly what
    // this check reported the first time it was written.)
    const rows = [
        { source: "A", target: "Z", value: 20, sourceColumn: 1, sourceRow: 1, targetColumn: 5, targetRow: 4 },
        { source: "Big1", target: "Big2", value: 400, sourceColumn: 3, sourceRow: 1, targetColumn: 3, targetRow: 4 }
    ];
    const { corridors, layout } = pipeline(rows);
    const id = corridors.find(c => c.source === "A").id;
    const { routeDiagram } = require("./routing-api.js");
    const opts = { portLeadInPercent: 18, curvaturePercent: 0, style: "Orthogonal", avoidNodes: true };

    const big = layout.nodes.get("Big1");
    // Drop the crossover squarely inside the obstacle.
    const inside = { x: big.x + big.width / 2, y: big.y + big.height / 2 };
    const held = routeDiagram(layout, opts, new Map([[id, { middle: inside }]]));
    const band = held.bands.find(b => b.corridorId === id);
    const handle = held.handles.get(id).middle;

    check("the crossover doesn't stay inside the node it was dropped in",
        Math.abs(handle.point.x - inside.x) > 1,
        `dropped at ${inside.x.toFixed(0)}, ended at ${handle.point.x.toFixed(0)}`);
    check("...it lands just clear of that node's edge",
        handle.point.x < big.x || handle.point.x > big.x + big.width,
        `${handle.point.x.toFixed(0)} vs node ${big.x.toFixed(0)}..${(big.x + big.width).toFixed(0)}`);
    check("...the route no longer runs through it",
        intrusions(layout, held.bands).length === 0, intrusions(layout, held.bands).join(", "));
    check("...and it's still orthogonal", diagonals(band.path) === 0, `${diagonals(band.path)}`);

    // A crossover dropped somewhere clear is left exactly where it was put.
    const clearSpot = { x: big.x - 120, y: big.y };
    const free = routeDiagram(layout, opts, new Map([[id, { middle: clearSpot }]]));
    check("a crossover dropped in the clear isn't moved",
        Math.abs(free.handles.get(id).middle.point.x - clearSpot.x) < 1e-9,
        `${free.handles.get(id).middle.point.x.toFixed(1)} vs ${clearSpot.x.toFixed(1)}`);
}

// ===============================================================
// 10. An avoided route can be CORRECTED: the detour lane handle.
//
// The defect: avoidance replaces a blocked route's middle with a detour, and
// handlesFor then read the middle handle off two of the DETOUR waypoints. So the
// handle was drawn part way up the detour's RISER, and it had lost the
// `gesture` flag that makes a diagonal's bend write the two leads -- which in
// Polyline and Octilinear left a control that moved nothing at all, and in
// Smooth and Orthogonal left one whose drag stood avoidance down and put the
// band back through the node it had just been routed around. A perpendicular
// pairing came back with NO handles whatsoever. Nothing on the route could move
// the detour, so the only way to correct one was to move the obstacle away,
// move the route, and move the obstacle back.
//
// Every assertion here is made against the SPINE and the drawn path, never
// against the handle's own arithmetic.
//
// `intrusions` above is the wrong instrument for this section: it samples the
// band's OUTLINE, and these bands are ~150px wide against a 13px node, so the
// node sits inside the ribbon with both edges clear of it and an outline test
// reports nothing at all (measured -- it found 0 blockers on a route that runs
// straight through one). The test used here is routing's own: the node's
// rectangle against the CENTRELINE, inflated by the band's half-width.
// ===============================================================
{
    const { routeDiagram, draggableHandles } = require("./routing-api.js");
    const ALL_STYLES = ["Polyline", "Octilinear", "Orthogonal", "Smooth"];
    const pathOf = (routed, id) =>
        routed.bands.filter(b => b.corridorId === id).map(b => b.path).join("|");

    /**
     * Half the band's width, read off its own path: the outline is the low edge
     * source-to-target then the high edge back, so the first and last points are
     * the two corners at the source end.
     */
    const halfWidthOf = band => {
        const pts = samplePath(band.path);
        const a = pts[0], b = pts[pts.length - 1];
        return Math.hypot(a.x - b.x, a.y - b.y) / 2;
    };
    const distanceToRect = (q, n) => {
        const dx = Math.max(n.x - q.x, 0, q.x - (n.x + n.width));
        const dy = Math.max(n.y - q.y, 0, q.y - (n.y + n.height));
        return Math.hypot(dx, dy);
    };
    /** Does a band of this half-width, on this centreline, cover the node? */
    const clipsNode = (spine, halfWidth, node) => {
        for (let k = 1; k < spine.length; k++) {
            const a = spine[k - 1], b = spine[k];
            const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
            for (let t = 0; t <= steps; t++) {
                const q = { x: a.x + (b.x - a.x) * t / steps, y: a.y + (b.y - a.y) * t / steps };
                if (distanceToRect(q, node) < halfWidth - 0.5) { return true; }
            }
        }
        return false;
    };
    /** Distance to the nearest spine segment, and that segment's extents. */
    const nearestSegment = (spine, point) => {
        let best = { distance: Infinity, dx: 0, dy: 0 };
        for (let k = 1; k < spine.length; k++) {
            const a = spine[k - 1], b = spine[k];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            const t = len2 === 0 ? 0 : Math.max(0, Math.min(1,
                ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2));
            const distance = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
            if (distance < best.distance) {
                best = { distance, dx: Math.abs(dx), dy: Math.abs(dy) };
            }
        }
        return best;
    };

    // A -> C spanning three columns with B parked in the middle one on the same
    // row, so the direct route runs straight through it; and a PERPENDICULAR
    // pairing (P East out, Q North in) blocked by M -- the shape that used to
    // come back with nothing to drag at all.
    const SHAPES = {
        "same-axis": [
            { source: "A", target: "C", value: 10, sourceColumn: 1, sourceRow: 2, targetColumn: 3, targetRow: 2 },
            { source: "X", target: "B", value: 4, sourceColumn: 1, sourceRow: 4, targetColumn: 2, targetRow: 2 },
            { source: "B", target: "Y", value: 4, sourceColumn: 2, sourceRow: 2, targetColumn: 3, targetRow: 4 }
        ],
        "perpendicular": [
            { source: "P", target: "Q", value: 10, sourceColumn: 1, sourceRow: 1, targetColumn: 3, targetRow: 4, targetPort: "North" },
            { source: "M", target: "N", value: 3, sourceColumn: 3, sourceRow: 1, targetColumn: 4, targetRow: 1 }
        ]
    };

    let detoured = 0, asserted = 0, tightened = 0, heldClear = 0, asPlaced = 0, escaped = 0;
    Object.entries(SHAPES).forEach(([shapeName, rows]) => {
        const { corridors, layout } = pipeline(rows);
        const corridor = corridors[0];
        const id = corridor.id;
        const others = Array.from(layout.nodes.values())
            .filter(n => n.id !== corridor.source && n.id !== corridor.target);
        ALL_STYLES.forEach(style => {
            const opts = { portLeadInPercent: 18, curvaturePercent: 35, style, avoidNodes: true };
            const on = routeDiagram(layout, opts, new Map());
            const off = routeDiagram(layout, { ...opts, avoidNodes: false }, new Map());
            const full = on.handles.get(id);
            const where = `${shapeName}/${style}`;
            const half = halfWidthOf(on.bands.find(b => b.corridorId === id));
            const clipped = routed => others.filter(n =>
                clipsNode(routed.spines.get(id), half, n)).map(n => n.id);

            if (!full.detour) {
                // The cheaper repairs (slide the crossover, reshape the leads)
                // add no detour waypoints and are controlled by their own
                // handles, so they need no lane. What must NOT happen is a route
                // that grew detour waypoints and got no lane to move them with.
                if (pathOf(on, id) !== pathOf(off, id)) {
                    check(`${where}: a repair with no lane added no detour waypoints`,
                        on.spines.get(id).length <= off.spines.get(id).length + 1,
                        `${off.spines.get(id).length} -> ${on.spines.get(id).length} spine points`);
                    asserted++;
                }
                return;
            }
            detoured++;

            const blockers = others.filter(n => clipsNode(off.spines.get(id), half, n));
            check(`${where}: the case really is blocked`, blockers.length > 0,
                blockers.map(n => n.id).join(", "));
            check(`${where}: ...and avoidance cleared it`, clipped(on).length === 0,
                clipped(on).join(", "));
            asserted += 2;
            if (blockers.length === 0) { return; }

            const axis = full.detour.axis;
            const across = full.detour.point[axis];
            const spine = on.spines.get(id);

            // (a) **The detour replaced the middle in the DRAWING, and the
            //     route keeps it for the LINE**. Before, the
            //     middle went outright, so on the real data not one of the four
            //     automatic detours kept the handle that places the line -- and
            //     the lane cannot remove a detour, only shape it. It now comes
            //     over from the undetoured construction, marked `asPlaced`.
            //     Where that construction has no middle either -- a 90-degree L,
            //     whose corner is fixed by the two nodes -- there is nothing to
            //     give back and nothing is claimed.
            const baseMiddle = off.handles.get(id).middle;
            check(`${where}: a detoured route keeps the middle of the line as placed`,
                (full.middle !== undefined) === (baseMiddle !== undefined),
                `middle ${full.middle ? "offered" : "absent"}, undetoured ${baseMiddle ? "has one" : "has none"}`);
            asserted++;
            if (baseMiddle && full.middle) {
                check(`${where}: ...at the undetoured construction's own point`,
                    Math.abs(full.middle.point.x - baseMiddle.point.x) < 1e-9
                    && Math.abs(full.middle.point.y - baseMiddle.point.y) < 1e-9
                    && full.middle.axis === baseMiddle.axis
                    && !!full.middle.gesture === !!baseMiddle.gesture);
                check(`${where}: ...and the route is marked as-placed, with a ghost to draw it on`,
                    full.asPlaced === true && !!on.ghosts && on.ghosts.has(id));
                asserted += 2;
                asPlaced++;
            }

            // (b) The handle sits ON a run of the drawn route that travels ALONG
            //     it -- the lane. The old handle sat midway up the riser, which
            //     runs across the route, so it fails both halves of this.
            const seg = nearestSegment(spine, full.detour.point);
            check(`${where}: the lane handle lies on the route`,
                seg.distance < 1e-6, `${seg.distance.toFixed(4)}px off`);
            check(`${where}: ...on a run that travels along it, not a riser`,
                (axis === "y" ? seg.dx > seg.dy : seg.dy > seg.dx),
                `segment dx=${seg.dx.toFixed(1)} dy=${seg.dy.toFixed(1)}, drag axis ${axis}`);
            asserted += 2;

            // (c) EVERY style shows it, Orthogonal included: the style that
            //     squares everything off is the one that most needs it, and it
            //     offers no lead handles to fall back on.
            check(`${where}: the lane handle is shown`,
                draggableHandles(on.handles, style).get(id).detour !== undefined);
            asserted++;

            // Which way is OUT: away from the obstacle the lane runs beside.
            const nearest = blockers.reduce((best, n) => {
                const centre = axis === "x" ? n.x + n.width / 2 : n.y + n.height / 2;
                return Math.abs(centre - across) < Math.abs(best - across) ? centre : best;
            }, Infinity);
            const outward = Math.sign(across - nearest) || 1;
            const dragTo = value => {
                const drop = { x: full.detour.point.x, y: full.detour.point.y };
                drop[axis] = value;
                return routeDiagram(layout, opts, new Map([[id, { detour: drop }]]));
            };

            // (d) Dragging it moves what is DRAWN. This is the assertion the old
            //     build fails outright: in Polyline the drag was a complete
            //     no-op, and in Smooth and Orthogonal it destroyed the detour.
            const base = pathOf(on, id);
            const pushed = dragTo(across + outward * 70);
            check(`${where}: dragging the lane moves the drawing`,
                pathOf(pushed, id) !== base);
            asserted++;

            // (e) It lands where it was dropped, so the handle follows the
            //     pointer instead of snapping back.
            check(`${where}: the lane lands where it was dropped`,
                Math.abs(pushed.handles.get(id).detour.point[axis] - (across + outward * 70)) < 1e-6,
                `wanted ${(across + outward * 70).toFixed(1)}, got ${pushed.handles.get(id).detour.point[axis].toFixed(1)}`);
            asserted++;

            // (f) A lane the author placed is still held clear of the obstacle,
            //     so a drop dead centre of a BLOCKING node cannot put the band
            //     through it. (A lane dropped inside some UNRELATED node is the
            //     author's business, exactly as a dragged lead is: the clamp
            //     knows only the nodes this route was blocked by.)
            blockers.forEach(node => {
                const centre = axis === "x" ? node.x + node.width / 2 : node.y + node.height / 2;
                const held = dragTo(centre);
                check(`${where}: a lane dropped inside ${node.id} is held clear of it`,
                    !clipped(held).includes(node.id), clipped(held).join(", "));
                asserted++;
                heldClear++;
            });

            // (g) Dragged far each way it reaches BOTH sides of the obstacle --
            //     the second thing one handle has to say about a detour, and the
            //     reason the clamp is to the nearer edge rather than absolute.
            const sides = [across - 600, across + 600]
                .map(v => dragTo(v).handles.get(id).detour.point[axis]);
            check(`${where}: the lane reaches both sides of the obstacle`,
                sides[0] < nearest && sides[1] > nearest,
                `${sides[0].toFixed(0)} .. ${sides[1].toFixed(0)} around ${nearest.toFixed(0)}`);
            asserted++;

            // (h) It can be brought IN as well as pushed out. The automatic lane
            //     sits a full avoidance margin clear, so clamping a drop to that
            //     same bound would leave the whole inward half of the handle's
            //     travel doing nothing. Swept inward: the tightest lane honoured
            //     exactly must be strictly inside the automatic one, and must
            //     still not put the band through the obstacle.
            let tightest;
            for (let step = 1; step <= 40; step++) {
                const want = across - outward * step * 4;
                const got = dragTo(want);
                if (Math.abs(got.handles.get(id).detour.point[axis] - want) > 1e-6) { break; }
                if (clipped(got).length > 0) { break; }
                tightest = want;
            }
            check(`${where}: a lane may be tightened inside the automatic margin`,
                tightest !== undefined && Math.abs(tightest - nearest) < Math.abs(across - nearest),
                tightest === undefined ? "none honoured"
                    : `automatic ${across.toFixed(1)} -> ${tightest.toFixed(1)}`);
            asserted++;
            if (tightest !== undefined) { tightened++; }

            // ===========================================================
            // (i)-(m): **the handles of the line as PLACED**.
            //
            // a route sent round a node loses the handle that put it
            // there, so an author who steers a line into a node cannot steer
            // it back out. Measured over +/-400px in 20px steps,
            // no lane drop clears a detour in any style (0 of 40) -- shaping
            // the way round is its job -- and in Orthogonal and on a
            // 90-degree corner the lane was the only handle there was.
            // ===========================================================
            if (!full.middle) { return; }

            // (i) The ghost IS the undetoured centreline, point for point, and
            //     not a reconstruction of it. The handle sits on that line, so
            //     if the two ever part company the dot floats off the dashes.
            const ghost = (on.ghosts && on.ghosts.get(id)) || [];
            const truth = off.spines.get(id) || [];
            check(`${where}: the ghost is the undetoured centreline`,
                ghost.length === truth.length && ghost.length > 1
                && ghost.every((p, k) => Math.abs(p.x - truth[k].x) < 1e-9
                    && Math.abs(p.y - truth[k].y) < 1e-9),
                `${ghost.length} points against ${truth.length}`);
            asserted++;

            // (j) The as-placed middle lies ON the ghost and OFF the drawn
            //     band, which is the whole reason the ghost is drawn. It is
            //     also what tells the two handles apart: the lane is on the
            //     route (asserted in (b)); this one is on the line.
            const onGhost = nearestSegment(ghost, full.middle.point);
            const onDrawn = nearestSegment(spine, full.middle.point);
            check(`${where}: the as-placed middle lies on the ghost line`,
                onGhost.distance < 1e-6, `${onGhost.distance.toFixed(4)}px off`);
            check(`${where}: ...and away from the band that is drawn`,
                onDrawn.distance > 1, `${onDrawn.distance.toFixed(1)}px from the route`);
            asserted += 2;

            // (k) **It gets the author out.** Written exactly as visual.ts
            //     writes it -- a gesture middle slides BOTH leads
            //     (`slideBend`), anything else is stored as given -- so this
            //     measures what a drag really does rather than what the blob
            //     could say. Orthogonal's step stands avoidance down and
            //     clears it from any position; a bend composes with avoidance
            //     instead, and clears it wherever the line genuinely comes off
            //     the node.
            const writeMiddle = drop => {
                if (!full.middle.gesture) { return { middle: drop }; }
                const a = full.middle.axis;
                const delta = drop[a] - full.middle.point[a];
                const slide = p => (a === "x"
                    ? { x: p.x + delta, y: p.y }
                    : { x: p.x, y: p.y + delta });
                return { source: slide(full.source.point), target: slide(full.target.point) };
            };
            const dropAt = d => {
                const drop = { x: full.middle.point.x, y: full.middle.point.y };
                drop[full.middle.axis] += d;
                return routeDiagram(layout, opts, new Map([[id, writeMiddle(drop)]]));
            };
            let cleared = 0, trials = 0, ghostMoved = 0;
            for (let d = -400; d <= 400; d += 20) {
                if (d === 0) { continue; }
                const moved = dropAt(d);
                trials++;
                if (moved.handles.get(id).detour === undefined) { cleared++; }
                // (l) The ghost answers EVERY drop, including the ones that
                //     leave the detour standing. That is what makes the handle
                //     legible: on a squared detour a lead cannot change the
                //     drawn band at all (byte-identical, measured in
                //     earlier), so without this the drag looks broken.
                const g = (moved.ghosts && moved.ghosts.get(id)) || moved.spines.get(id);
                if (g.some((p, k) => !ghost[k] || Math.abs(p.x - ghost[k].x) > 0.5
                    || Math.abs(p.y - ghost[k].y) > 0.5)) { ghostMoved++; }
            }
            check(`${where}: the as-placed middle can clear the detour`,
                cleared > 0, `${cleared} of ${trials} drops leave no detour`);
            check(`${where}: every drop of it moves the line under the pointer`,
                ghostMoved === trials, `${ghostMoved} of ${trials}`);
            asserted += 2;
            if (cleared > 0) { escaped++; }

            // (m) draggableHandles must not drop the flag on the way to being
            //     drawn: it rebuilds the object on two of its three paths, and
            //     Orthogonal -- the style where the step is the ONLY thing an
            //     author places -- is one of them.
            const shownRoute = draggableHandles(on.handles, style).get(id);
            check(`${where}: the flag and the middle survive draggableHandles`,
                shownRoute.asPlaced === true && shownRoute.middle !== undefined
                && shownRoute.detour !== undefined);
            asserted++;
        });
    });

    check("the as-placed cases are not vacuous", asPlaced >= 4 && escaped >= 4,
        `${asPlaced} routes carried a middle over, ${escaped} of them can clear the detour`);

    // An ordinary route claims none of this: no flag, no ghost. Otherwise
    // render would draw dashes across a diagram that never detoured at all.
    {
        const { corridors, layout } = pipeline([
            { source: "A", target: "C", value: 10, sourceColumn: 1, sourceRow: 2, targetColumn: 3, targetRow: 2 }
        ]);
        const id = corridors[0].id;
        ALL_STYLES.forEach(style => {
            const plain = routeDiagram(layout,
                { portLeadInPercent: 18, curvaturePercent: 35, style, avoidNodes: true }, new Map());
            check(`${style}: an unobstructed route is not marked as-placed and has no ghost`,
                plain.handles.get(id).asPlaced === undefined
                && (plain.ghosts ? plain.ghosts.size : 0) === 0);
        });
    }

    check("the detour cases are not vacuous: real detours were exercised",
        detoured >= 4 && tightened >= 4 && heldClear >= 4,
        `${detoured} detoured (shape, style) pairs, ${tightened} tightenable, `
        + `${heldClear} held clear, ${asserted} assertions`);

    // A stored lane on a corridor NOTHING blocks is simply ignored, and the
    // route is byte-identical to having stored nothing -- so an obstacle that
    // moves away cannot leave a stale lane bending a clear route, and the lane
    // means what it said again if the obstacle comes back.
    {
        const { corridors, layout } = pipeline([
            { source: "A", target: "C", value: 10, sourceColumn: 1, sourceRow: 2, targetColumn: 3, targetRow: 2 }
        ]);
        const id = corridors[0].id;
        ALL_STYLES.forEach(style => {
            const opts = { portLeadInPercent: 18, curvaturePercent: 35, style, avoidNodes: true };
            const plain = routeDiagram(layout, opts, new Map());
            const withLane = routeDiagram(layout, opts,
                new Map([[id, { detour: { x: 400, y: 40 } }]]));
            check(`${style}: a stored lane is ignored where nothing is in the way`,
                pathOf(plain, id) === pathOf(withLane, id)
                && withLane.handles.get(id).detour === undefined);
        });
    }
}

if (failures === 0) {
    console.log("\nALL AVOIDANCE CHECKS PASSED");
} else {
    console.log(`\n${failures} AVOIDANCE CHECK(S) FAILED`);
    process.exit(1);
}
