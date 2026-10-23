"use strict";
/**
 * **No faint line along a tightly curved band's edge** (the author, a 90-degree bend
 * at 400%: a hairline the colour of the page along the inside of the curve).
 *
 * Both edges of a band get the same number of samples, but a tight arc's inner
 * edge is far shorter, so its points packed together -- 80 of 93 under half a
 * pixel on a Curvature-10 self-loop, the edge doubling back on itself -- and the
 * Catmull-Rom fit through them wobbled. routing.ts now respaces each edge
 * (thinEdge) and breaks the spline at a collapsed arc (splineWithCorners).
 *
 * What is pinned here, as properties of the drawing:
 *  1. on EVERY edge, no two consecutive on-curve points are closer than 0.5px
 *     and the edge never doubles back -- swept over all four styles, several
 *     curvatures and widths, on self-loops, 90-degree corners and a striped
 *     band, and counted per edge;
 *  2. straights stay straight: the legs of a 90-degree corner sit exactly where
 *     the anchors put them. Thinning alone bowed them 3.7px inward, because the
 *     spline took its tangent at a collapsed corner from both sides of it;
 *  3. an untouched self-loop stays mirror-symmetric. A thin that walks from one
 *     end is not symmetric, and broke this before the chain-respacing rule.
 *
 * Fails on the code before the fix: (1) reports hundreds of short steps.
 */
const R = require("./routing-api.js");

let failures = 0;
let edgesMeasured = 0, straightProbes = 0, mirrorProbes = 0;
function check(name, ok, detail) {
    if (!ok) {
        failures++;
        console.log("  FAIL " + name + (detail ? "  " + detail : ""));
    }
}

const STYLES = ["Polyline", "Octilinear", "Orthogonal", "Smooth"];
const CURVATURES = [0, 10, 35, 70, 100];

function node(id, x, y, w, h) {
    return { id, label: id, x, y, width: w, height: h, inflow: 0, outflow: 0, isSelfLoop: false };
}
function segmentsOf(values) {
    return values.map((value, i) => ({ flowType: "T" + i, value, flows: [] }));
}
function loopLayout(values) {
    const value = values.reduce((a, b) => a + b, 0);
    return {
        nodes: new Map([["A", node("A", 400, 300, 20, 60)]]),
        corridors: [{ id: "A->A", source: "A", target: "A", value, isSelfLoop: true, flows: [],
            segments: segmentsOf(values), sourcePort: "East", targetPort: "West" }],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
}
// A leaves East from x=120 (rows 300..360); B takes it North at y=500 (x 400..460).
function cornerLayout(values) {
    const value = values.reduce((a, b) => a + b, 0);
    return {
        nodes: new Map([["A", node("A", 100, 300, 20, 60)], ["B", node("B", 400, 500, 60, 20)]]),
        corridors: [{ id: "A->B", source: "A", target: "B", value, isSelfLoop: false, flows: [],
            segments: segmentsOf(values), sourcePort: "East", targetPort: "North" }],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
}

/** The on-curve points of each edge: M, then each C's end; the first L starts the second edge. */
function edgesOf(d) {
    const out = [[], []];
    let e = 0;
    for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
        const n = (m[2].match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
        if (m[1] === "M") out[0].push({ x: n[0], y: n[1] });
        else if (m[1] === "L") { e = 1; out[1].push({ x: n[0], y: n[1] }); }
        else if (m[1] === "C") for (let i = 0; i + 5 < n.length; i += 6) out[e].push({ x: n[i + 4], y: n[i + 5] });
    }
    return out;
}

/** The real outline: cubics sampled, straight runs (and the closing Z) subdivided. */
function samplePath(d, per) {
    const pts = [];
    let cur, open;
    const line = p => {
        for (let k = 1; k <= per; k++) pts.push({ x: cur.x + (p.x - cur.x) * k / per, y: cur.y + (p.y - cur.y) * k / per });
        cur = p;
    };
    for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
        const n = (m[2].match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
        if (m[1] === "M") { cur = open = { x: n[0], y: n[1] }; pts.push(cur); }
        else if (m[1] === "L") line({ x: n[0], y: n[1] });
        else if (m[1] === "Z") line(open);
        else for (let i = 0; i + 5 < n.length; i += 6) {
            const p0 = cur, c1 = { x: n[i], y: n[i + 1] }, c2 = { x: n[i + 2], y: n[i + 3] }, p3 = { x: n[i + 4], y: n[i + 5] };
            for (let k = 1; k <= per; k++) {
                const t = k / per, u = 1 - t;
                pts.push({
                    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
                    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y
                });
            }
            cur = p3;
        }
    }
    return pts;
}

// --- 1. No crowded or folded edge, anywhere ---------------------------------
let totalShort = 0;
STYLES.forEach(style => CURVATURES.forEach(curvature => [[10], [40], [80], [10, 20, 30]].forEach(values => {
    [["loop", loopLayout], ["corner", cornerLayout]].forEach(([shape, build]) => {
        const routed = R.routeDiagram(build(values), { portLeadInPercent: 20, curvaturePercent: curvature, style, avoidNodes: true });
        routed.bands.forEach(band => {
            if (!band.path.includes("C")) return; // a mitred (sharp) band has no spline fit
            edgesOf(band.path).forEach((edge, side) => {
                let short = 0, folds = 0;
                for (let i = 1; i < edge.length; i++) {
                    const ax = edge[i].x - edge[i - 1].x, ay = edge[i].y - edge[i - 1].y;
                    if (Math.hypot(ax, ay) < 0.5 - 1e-9) short++;
                    if (i >= 2) {
                        const bx = edge[i - 1].x - edge[i - 2].x, by = edge[i - 1].y - edge[i - 2].y;
                        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
                        if (la > 1e-9 && lb > 1e-9 && (ax * bx + ay * by) / (la * lb) < -0.5) folds++;
                    }
                }
                edgesMeasured++;
                totalShort += short;
                check(`${shape} ${style} c${curvature} [${values}] ${band.flowType} edge ${side}: no crowded or folded points`,
                    short === 0 && folds === 0, `${short} steps under 0.5px, ${folds} fold-backs of ${edge.length}`);
            });
        });
    });
})));

// --- 2. A corner's legs stay straight ---------------------------------------
// The band is 40 wide, centred on each face: it leaves A between y 310 and 350
// and enters B between x 410 and 450. Nothing on either leg may bow past that.
// Tight curvatures only: that is where an inner arc collapses to a corner (and
// where the bow appeared); from about 70 the arc itself starts inside these
// probe windows, so a point there is on the curve, not a bowed straight.
STYLES.forEach(style => CURVATURES.filter(c => c <= 35).forEach(curvature => {
    const band = R.routeDiagram(cornerLayout([40]), { portLeadInPercent: 20, curvaturePercent: curvature, style, avoidNodes: true }).bands[0];
    const pts = samplePath(band.path, 16);
    const leaving = pts.filter(p => p.x > 121 && p.x < 300);
    const arriving = pts.filter(p => p.y > 400 && p.y < 499);
    straightProbes += leaving.length + arriving.length;
    // ON one of the two edge lines, not merely between them: the bow went
    // INWARD, into the band, so a between-the-lines test cannot see it.
    const off = (v, a, b) => Math.min(Math.abs(v - a), Math.abs(v - b)) > 0.05;
    const badLeave = leaving.filter(p => off(p.y, 310, 350));
    const badArrive = arriving.filter(p => off(p.x, 410, 450));
    check(`corner ${style} c${curvature}: the leg leaving A stays straight`, leaving.length > 20 && badLeave.length === 0,
        `${badLeave.length} of ${leaving.length} off the line, worst y ${badLeave.map(p => p.y.toFixed(2)).slice(0, 3)}`);
    check(`corner ${style} c${curvature}: the leg arriving at B stays straight`, arriving.length > 20 && badArrive.length === 0,
        `${badArrive.length} of ${arriving.length} off the line, worst x ${badArrive.map(p => p.x.toFixed(2)).slice(0, 3)}`);
}));

// The same on a self-loop's straights, which is where the bow was measured
// (3.7px): the middle of the top run and of each side, where no corner reaches
// at these curvatures. The band is 40 wide, so each run's outline is two lines
// 40 apart, placed from the band's own bounds.
STYLES.forEach(style => [0, 10].forEach(curvature => {
    const band = R.routeDiagram(loopLayout([40]), { portLeadInPercent: 20, curvaturePercent: curvature, style, avoidNodes: true }).bands[0];
    const { minX, maxX, minY, maxY } = band.bounds;
    const pts = samplePath(band.path, 16);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const off = (v, a, b) => Math.min(Math.abs(v - a), Math.abs(v - b)) > 0.05;
    const runs = [
        ["top", pts.filter(p => Math.abs(p.x - cx) < 15 && p.y < cy), p => off(p.y, minY, minY + 40)],
        ["left side", pts.filter(p => Math.abs(p.y - cy) < 15 && p.x < cx), p => off(p.x, minX, minX + 40)],
        ["right side", pts.filter(p => Math.abs(p.y - cy) < 15 && p.x > cx), p => off(p.x, maxX, maxX - 40)]
    ];
    runs.forEach(([name, run, isOff]) => {
        const bad = run.filter(isOff);
        straightProbes += run.length;
        check(`loop ${style} c${curvature}: the ${name} stays straight`, run.length > 4 && bad.length === 0,
            `${bad.length} of ${run.length} off the line`);
    });
}));

// --- 3. An untouched loop is mirror-symmetric --------------------------------
STYLES.forEach(style => CURVATURES.forEach(curvature => [10, 40, 80].forEach(value => {
    const band = R.routeDiagram(loopLayout([value]), { portLeadInPercent: 20, curvaturePercent: curvature, style, avoidNodes: true }).bands[0];
    const centre = (band.start.x + band.end.x) / 2;
    const outline = samplePath(band.path, 8);
    const strays = outline.filter(q => !outline.some(m => Math.abs(2 * centre - m.x - q.x) < 0.5 && Math.abs(m.y - q.y) < 0.5));
    mirrorProbes++;
    check(`loop ${style} c${curvature} v${value}: mirror-symmetric`, strays.length === 0, `${strays.length} of ${outline.length} unmatched`);
})));

// The case that actually broke symmetry: a wide loop with both leads dragged to
// their floor, so the inner corner is about a pixel round and its samples all
// collapse together. Mirrors selfloop-radius-check's even-loop fixture.
STYLES.forEach(style => [30, 100].forEach(curvature => {
    const layout = loopLayout([120]);
    layout.nodes.get("A").height = 120;
    const opt = { portLeadInPercent: 20, curvaturePercent: curvature, style, avoidNodes: true };
    const base = R.routeDiagram(layout, opt).bands[0];
    const band = R.routeDiagram(layout, opt, new Map([["A->A", {
        source: { x: base.start.x + 34, y: base.start.y },
        target: { x: base.end.x - 34, y: base.end.y }
    }]])).bands[0];
    const centre = (band.start.x + band.end.x) / 2;
    const outline = samplePath(band.path, 8);
    const strays = outline.filter(q => !outline.some(m => Math.abs(2 * centre - m.x - q.x) < 1 && Math.abs(m.y - q.y) < 1));
    mirrorProbes++;
    check(`floored-lead loop ${style} c${curvature}: mirror-symmetric`, strays.length === 0, `${strays.length} of ${outline.length} unmatched`);
}));

// --- 4. No drawn cubic overshoots ---------------------------------------------
// the author's second report (a tight Smooth corner, handle pulled in): hairlines
// running from the inner corner INTO the band along both edge lines. The
// on-curve points were clean; a CONTROL arm was not -- 45.7px on a 0.5px
// segment, so the drawn edge ran 19.9px out along the straight and back.
// Property: no cubic strays from its own chord by more than half the chord
// (+0.25px). A well-sampled arc strays a sliver of it; a spike, many chords.
// Swept over styles, curvatures, corner-handle radii, loops and corners.
let cubics = 0, overshooting = 0;
function worstStray(d) {
    let cur, worst = 0;
    for (const m of d.matchAll(/([MLCZ])([^MLCZ]*)/g)) {
        const n = (m[2].match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
        if (m[1] === "M" || m[1] === "L") { cur = { x: n[0], y: n[1] }; continue; }
        if (m[1] !== "C") continue;
        for (let i = 0; i + 5 < n.length; i += 6) {
            const p0 = cur, c1 = { x: n[i], y: n[i + 1] }, c2 = { x: n[i + 2], y: n[i + 3] }, p3 = { x: n[i + 4], y: n[i + 5] };
            const cx = p3.x - p0.x, cy = p3.y - p0.y, L2 = cx * cx + cy * cy;
            let far = 0;
            for (let k = 1; k < 32; k++) {
                const t = k / 32, u = 1 - t;
                const x = u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x;
                const y = u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y;
                const s = L2 > 0 ? Math.max(0, Math.min(1, ((x - p0.x) * cx + (y - p0.y) * cy) / L2)) : 0;
                far = Math.max(far, Math.hypot(x - (p0.x + s * cx), y - (p0.y + s * cy)));
            }
            cubics++;
            const excess = far - (0.5 * Math.sqrt(L2) + 0.25);
            if (excess > 0) overshooting++;
            worst = Math.max(worst, excess);
            cur = p3;
        }
    }
    return worst;
}
STYLES.forEach(style => CURVATURES.forEach(curvature => [undefined, 0, 0.05, 0.1, 0.2].forEach(radius => {
    [["loop", loopLayout], ["corner", cornerLayout]].forEach(([shape, build]) => [[10], [40], [10, 20, 30]].forEach(values => {
        const layout = build(values);
        const id = layout.corridors[0].id;
        const overrides = radius === undefined ? new Map() : new Map([[id, { radius }]]);
        R.routeDiagram(layout, { portLeadInPercent: 20, curvaturePercent: curvature, style, avoidNodes: true }, overrides)
            .bands.forEach(band => {
                if (!band.path.includes("C")) return;
                const worst = worstStray(band.path);
                check(`${shape} ${style} c${curvature} r=${radius} [${values}] ${band.flowType}: no cubic overshoots its chord`,
                    worst <= 0, `strays ${worst.toFixed(2)}px past half its chord`);
            });
    }));
})));
check("cubics were measured for overshoot", cubics > 10000, `${cubics}`);

const expectEdges = STYLES.length * CURVATURES.length * 2 * 2 * (3 + 3); // edges x bands (3 single + 3 striped)
check("every edge was measured", edgesMeasured >= expectEdges * 0.5, `${edgesMeasured} edges`);
check("the straight legs were probed", straightProbes > 500, `${straightProbes} points`);
check("every loop was mirrored", mirrorProbes === STYLES.length * (CURVATURES.length * 3 + 2), `${mirrorProbes}`);

console.log(`${failures ? "FAIL" : "PASS"} seam-check: ${edgesMeasured} edges, ${totalShort} short steps, `
    + `${straightProbes} straight-leg points, ${mirrorProbes} loops mirrored, `
    + `${cubics} cubics (${overshooting} overshooting), ${failures} failures`);
process.exit(failures ? 1 : 0);
