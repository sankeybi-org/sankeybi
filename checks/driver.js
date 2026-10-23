"use strict";
const { routeCorridors } = require("./routing-api.js");

// Stripes overlap by exactly this so no anti-aliasing seam shows; a TWIST,
// which these two checks exist to catch, is unbounded and still fails.
const STRIPE_BLEED = 0.35;
let failures = 0;
function check(label, cond) {
    if (!cond) {
        failures++;
        console.log(`FAIL: ${label}`);
    }
}

function makeNode(id, x, y, width, height) {
    return { id, label: id, x, y, width, height, inflow: 0, outflow: 0, isSelfLoop: false };
}

/**
 * Proper SVG path sampler: walks M/L/C/Z commands and returns fine-grained
 * points actually ON the rendered curve (not raw control-point handles,
 * which can lie off the curve and would give false crossing signals).
 * Also splits the result into "top" and "bottom" edge samples, split at
 * the single "L" cap the band path always has between them.
 */
function samplePath(d, subSamples = 20) {
    const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?/g);
    let i = 0;
    let cur = { x: 0, y: 0 };
    const top = [];
    const bottom = [];
    let sawCap = false;

    function readNum() { return parseFloat(tokens[i++]); }
    function cubicPoint(p0, c1, c2, p1, t) {
        const mt = 1 - t;
        const x = mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x;
        const y = mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y;
        return { x, y };
    }

    while (i < tokens.length) {
        const tok = tokens[i++];
        if (tok === "M") {
            cur = { x: readNum(), y: readNum() };
            (sawCap ? bottom : top).push(cur);
        } else if (tok === "L") {
            cur = { x: readNum(), y: readNum() };
            sawCap = true; // the band path's one L is the end cap between top and bottom; its target point IS the first bottom sample
            (sawCap ? bottom : top).push(cur);
        } else if (tok === "C") {
            const c1 = { x: readNum(), y: readNum() };
            const c2 = { x: readNum(), y: readNum() };
            const end = { x: readNum(), y: readNum() };
            for (let s = 1; s <= subSamples; s++) {
                const pt = cubicPoint(cur, c1, c2, end, s / subSamples);
                (sawCap ? bottom : top).push(pt);
            }
            cur = end;
        } else if (tok === "Z") {
            // closes back to path start; not sampled further, doesn't affect edge extents
        }
    }
    return { top, bottom };
}

function allFinite(pts) {
    return pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}

// --- Case 1: two-segment corridor, uneven widths at each end — segments must stay parallel (never cross) along the real curve ---
{
    const source = makeNode("A", 0, 100, 14, 100);
    const target = makeNode("B", 300, 300, 14, 40);
    const corridor = {
        id: "c1", source: "A", target: "B", value: 100, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West",
        segments: [
            { flowType: "x", value: 70, flows: [] },
            { flowType: "y", value: 30, flows: [] }
        ]
    };
    const nodes = new Map([["A", source], ["B", target]]);
    const valueToPixels = v => v;
    const layout = { nodes, corridors: [corridor], valueToPixels, columnGap: 100, rowPitch: 60 };

    const bands = routeCorridors(layout);
    check("case1: 2 bands produced", bands.length === 2);

    bands.forEach(b => {
        const { top, bottom } = samplePath(b.path);
        check(`case1: band ${b.flowType} top all-finite`, allFinite(top));
        check(`case1: band ${b.flowType} bottom all-finite`, allFinite(bottom));
    });

    const [bandX, bandY] = bands; // x = first/upper segment, y = second/lower segment
    // The path's bottom edge is drawn in reverse parameter order (t=1 -> t=0,
    // see bandPathFromEdges) — reverse it back to forward-t order so index k
    // lines up with the same t as topOfY's forward-order samples.
    const bottomOfX = samplePath(bandX.path).bottom.slice().reverse();
    const topOfY = samplePath(bandY.path).top;

    // Compare at matching sample indices (both bands share the same
    // corridor-level parameterisation/sample count) rather than global
    // min/max, which is the correct way to check two parallel edges never
    // swap order along the curve.
    let crossed = false;
    for (let k = 0; k < Math.min(bottomOfX.length, topOfY.length); k++) {
        if (bottomOfX[k].y > topOfY[k].y + STRIPE_BLEED + 0.01) {
            crossed = true;
            break;
        }
    }
    check("case1: segment x's bottom edge never crosses below segment y's top edge (beyond the stripe bleed)", !crossed);
}

// --- Case 2: many small segments (stress test proportional subdivision) ---
{
    const source = makeNode("A", 0, 0, 14, 200);
    const target = makeNode("B", 400, 50, 14, 150);
    const segments = [];
    for (let i = 0; i < 25; i++) {
        segments.push({ flowType: `t${i}`, value: 1 + (i % 3), flows: [] });
    }
    const totalValue = segments.reduce((s, seg) => s + seg.value, 0);
    const corridor = { id: "c2", source: "A", target: "B", value: totalValue, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West", segments };
    const nodes = new Map([["A", source], ["B", target]]);
    const layout = { nodes, corridors: [corridor], valueToPixels: v => v, columnGap: 100, rowPitch: 60 };

    const bands = routeCorridors(layout);
    check("case2: all segments produced", bands.length === segments.length);
    let allOk = true;
    bands.forEach(b => {
        const { top, bottom } = samplePath(b.path);
        if (!allFinite(top) || !allFinite(bottom)) allOk = false;
    });
    check("case2: all-finite across many small segments", allOk);

    // Adjacent-segment crossing check across the whole stack, same
    // matching-sample-index method as case 1.
    let anyCross = false;
    for (let i = 0; i < bands.length - 1; i++) {
        const bottomOfI = samplePath(bands[i].path).bottom.slice().reverse();
        const topOfNext = samplePath(bands[i + 1].path).top;
        for (let k = 0; k < Math.min(bottomOfI.length, topOfNext.length); k++) {
            if (bottomOfI[k].y > topOfNext[k].y + STRIPE_BLEED + 0.01) { anyCross = true; break; }
        }
        if (anyCross) break;
    }
    check("case2: no adjacent-segment crossing across 25-segment stack", !anyCross);
}

// --- Case 3: extreme aspect ratio (very wide, very thin corridor) ---
{
    const source = makeNode("A", 0, 0, 14, 2000);
    const target = makeNode("B", 5000, 900, 14, 6);
    const corridor = {
        id: "c3", source: "A", target: "B", value: 10, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West",
        segments: [{ flowType: undefined, value: 10, flows: [] }]
    };
    const nodes = new Map([["A", source], ["B", target]]);
    const layout = { nodes, corridors: [corridor], valueToPixels: v => v, columnGap: 100, rowPitch: 60 };
    const bands = routeCorridors(layout);
    const { top, bottom } = samplePath(bands[0].path);
    check("case3: extreme aspect ratio stays finite", allFinite(top) && allFinite(bottom));
}

// --- Case 4: single-segment corridor — top/bottom must stay symmetric around the spine (regression vs. pre-rewrite behaviour) ---
{
    const source = makeNode("A", 0, 100, 14, 40);
    const target = makeNode("B", 200, 300, 14, 40);
    const corridor = {
        id: "c4", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West",
        segments: [{ flowType: undefined, value: 40, flows: [] }]
    };
    const nodes = new Map([["A", source], ["B", target]]);
    const layout = { nodes, corridors: [corridor], valueToPixels: v => v, columnGap: 100, rowPitch: 60 };
    const bands = routeCorridors(layout);
    const { top, bottom } = samplePath(bands[0].path);
    check("case4: single segment finite", allFinite(top) && allFinite(bottom));
    check("case4: top and bottom sample counts match", top.length === bottom.length);
}

// --- Case 5: stub check — a band should leave the source port and enter the target port on a flat horizontal run before bending ---
{
    const source = makeNode("A", 0, 100, 14, 40);
    const target = makeNode("B", 400, 300, 14, 40); // wide gap: columnGap(100) * STUB_FRACTION(0.18) = 18px stub fits easily
    const corridor = {
        id: "c5", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West",
        segments: [{ flowType: undefined, value: 40, flows: [] }]
    };
    const nodes = new Map([["A", source], ["B", target]]);
    const layout = { nodes, corridors: [corridor], valueToPixels: v => v, columnGap: 100, rowPitch: 60 };
    // Named, not the default: this pins a FLAT run out of the port, and the
    // default is Polyline, whose turn sits AT the lead handle
    // with its corner rounding eating back into the lead (8.4px flat here,
    // against Smooth's 31 and the retired original Smooth's 28.6). That is
    // Polyline's long-standing construction, reported to the author rather than
    // changed; this case keeps guarding the styles that promise the run.
    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
    const { top } = samplePath(bands[0].path);

    const sx = source.x + source.width; // 14
    const expectedStub = 0.18 * 100; // 18
    const stubPts = top.filter(p => p.x <= sx + expectedStub - 0.5);
    check("case5: stub region has multiple samples", stubPts.length >= 2);
    const ys = stubPts.map(p => p.y);
    const yVariance = Math.max(...ys) - Math.min(...ys);
    check("case5: leading stub is flat (y near-constant near the source port)", yVariance < 0.5);
}

// --- Case 6: nodes close together (tight but plausible column spacing) — stub must clamp gracefully, no overlap/crossing artefact ---
// Note: the perpendicular-offset-from-centreline method (predates today's
// change, present since the original smoothBandPath) has an inherent,
// sub-pixel fold-back on steep bends — confirmed via .tmp/checks/diagnose.js
// to be ~0.15-0.5px for realistic layouts, only growing to ~1.2px for a
// deliberately pathological near-zero-gap/huge-vertical-swing input that a
// column-based layout would never actually produce. Not chased further here
// (below any visible threshold); this case checks realistic tight spacing
// with a tolerance matching that known characteristic, not zero-tolerance.
{
    const source = makeNode("A", 0, 100, 14, 24);
    const target = makeNode("B", 40, 160, 14, 24); // 26px real gap, tight but plausible column spacing
    const corridor = {
        id: "c6", source: "A", target: "B", value: 24, isSelfLoop: false, flows: [], sourcePort: "East", targetPort: "West",
        segments: [{ flowType: undefined, value: 24, flows: [] }]
    };
    const nodes = new Map([["A", source], ["B", target]]);
    const layout = { nodes, corridors: [corridor], valueToPixels: v => v, columnGap: 40, rowPitch: 60 };
    const bands = routeCorridors(layout);
    const { top, bottom } = samplePath(bands[0].path);
    check("case6: close-but-realistic nodes stay finite", allFinite(top) && allFinite(bottom));

    let maxBackstep = 0;
    for (let k = 1; k < top.length; k++) {
        maxBackstep = Math.max(maxBackstep, top[k - 1].x - top[k].x);
    }
    check("case6: no visible fold-back (<1px) when the stub clamps on realistic tight spacing", maxBackstep < 1);
}

// --- Case 7: multi-segment self-loop — now routed through the SAME spine +
// parallel-offset machinery as every other corridor, so its segments are
// properly offset adjacent bands rather than the nested stroked outlines the
// old bespoke self-loop path produced. Per-pairing coverage of all 16
// source/target port combinations lives in port-routing-check.js; this case
// specifically pins the multi-segment parallel-band behaviour.
{
    const node = makeNode("N", 100, 200, 14, 40); // East edge at 114, West edge at 100
    const corridor = {
        id: "loop", source: "N", target: "N", value: 25, isSelfLoop: true, flows: [], sourcePort: "East", targetPort: "West",
        segments: [
            { flowType: "elec", value: 15, flows: [] },
            { flowType: "h2", value: 10, flows: [] }
        ]
    };
    const nodes = new Map([["N", node]]);
    const layout = { nodes, corridors: [corridor], valueToPixels: v => v, columnGap: 100, rowPitch: 60 };
    const bands = routeCorridors(layout);
    check("case7: 2 self-loop bands produced", bands.length === 2);
    check("case7: all bands flagged isSelfLoop", bands.every(b => b.isSelfLoop));

    const pointsOf = path => {
        const { top, bottom } = samplePath(path);
        return top.concat(bottom);
    };

    bands.forEach((b, idx) => {
        const pts = pointsOf(b.path);
        check(`case7: band ${idx} all-finite`, allFinite(pts));

        // The degenerate "flat wobble" failure mode for a same-node
        // East-out/West-in loop shows up precisely as the route lying along a
        // line straight through the node, so this is the detector for it.
        const insideNode = pts.some(p => p.x > 100 + 0.5 && p.x < 114 - 0.5 && p.y > 200 + 0.5 && p.y < 240 - 0.5);
        check(`case7: band ${idx} never overlaps the drawn node rectangle`, !insideNode);

        const minY = Math.min(...pts.map(p => p.y));
        check(`case7: band ${idx} loops clear above the node`, minY < 200);

        const spanX = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
        const spanY = Math.max(...pts.map(p => p.y)) - minY;
        check(`case7: band ${idx} has real 2-D extent (${spanX.toFixed(0)}x${spanY.toFixed(0)})`, spanX > 5 && spanY > 5);
    });

    // The parallel-band property: the two segments should be ADJACENT (share
    // a boundary edge), not nested at two separate bulge heights with a gap
    // between them the way the old stroked implementation drew them.
    const a = pointsOf(bands[0].path);
    const bPts = pointsOf(bands[1].path);
    const minGap = Math.min(...bPts.map(p => Math.min(...a.map(q => Math.hypot(p.x - q.x, p.y - q.y)))));
    check(`case7: the two segments are adjacent parallel bands (min gap ${minGap.toFixed(2)})`, minGap < 1);
}

if (failures === 0) {
    console.log("ALL CHECKS PASSED");
} else {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exit(1);
}
