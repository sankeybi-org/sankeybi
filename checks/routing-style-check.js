"use strict";
const { routeCorridors } = require("./routing-api.js");

let failures = 0;
function check(label, cond) {
    if (!cond) { failures++; console.log(`FAIL: ${label}`); }
}

const PORTS = ["North", "South", "East", "West"];
const STYLES = ["Smooth", "Orthogonal", "Polyline"];

function makeNode(id, x, y, width, height) {
    return { id, label: id, x, y, width, height, inflow: 0, outflow: 0, isSelfLoop: false };
}
function corridorOf(source, target, sourcePort, targetPort, segments) {
    return {
        id: `${source}->${target}|${sourcePort}|${targetPort}`,
        source, target, value: segments.reduce((s, x) => s + x.value, 0),
        isSelfLoop: source === target, flows: [], segments, sourcePort, targetPort
    };
}
function route(nodes, corridor, options) {
    return routeCorridors({
        nodes: new Map(nodes.map(n => [n.id, n])), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 140, rowPitch: 100
    }, Object.assign({ portLeadInPercent: 15, curvaturePercent: 35, style: "Smooth" }, options));
}

/** All on-path points, following M/L/C. */
function samplePath(d, subSamples = 10) {
    const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?(e-?\d+)?/g);
    let i = 0, cur = { x: 0, y: 0 };
    const pts = [];
    const readNum = () => parseFloat(tokens[i++]);
    const cubic = (p0, c1, c2, p1, t) => {
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
            for (let s = 1; s <= subSamples; s++) pts.push(cubic(cur, c1, c2, end, s / subSamples));
            cur = end;
        }
    }
    return pts;
}
const allFinite = pts => pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
const insideBox = (p, n) => p.x > n.x + 0.5 && p.x < n.x + n.width - 0.5 && p.y > n.y + 0.5 && p.y < n.y + n.height - 0.5;

// ===================================================================
// 1. Every style survives every port pairing, on regular corridors and
//    self-loops, at both rounded and sharp curvature.
// ===================================================================
STYLES.forEach(style => {
    [35, 0].forEach(curve => {
        let bad = 0;
        PORTS.forEach(sp => PORTS.forEach(tp => {
            const a = makeNode("A", 100, 300, 14, 60);
            const b = makeNode("B", 600, 200, 14, 60);
            const regular = route([a, b], corridorOf("A", "B", sp, tp, [{ flowType: undefined, value: 40, flows: [] }]),
                { style, curvaturePercent: curve });
            const n = makeNode("N", 400, 300, 14, 60);
            const loop = route([n], corridorOf("N", "N", sp, tp, [{ flowType: undefined, value: 20, flows: [] }]),
                { style, curvaturePercent: curve });

            if (regular.length !== 1 || loop.length !== 1) { bad++; return; }
            const rp = samplePath(regular[0].path);
            const lp = samplePath(loop[0].path);
            if (!allFinite(rp) || !allFinite(lp)) { bad++; return; }
            if (rp.some(p => insideBox(p, a) || insideBox(p, b))) { bad++; return; }
            if (lp.some(p => insideBox(p, n))) { bad++; return; }
            // A self-loop must enclose real area in every style.
            const spanX = Math.max(...lp.map(p => p.x)) - Math.min(...lp.map(p => p.x));
            const spanY = Math.max(...lp.map(p => p.y)) - Math.min(...lp.map(p => p.y));
            if (spanX <= 5 || spanY <= 5) bad++;
        }));
        check(`${style} @ curvature ${curve}: all 16 pairings route cleanly (${bad} bad)`, bad === 0);
    });
});

// ===================================================================
// 2. A straight run stays straight in every style, at every curvature.
// ===================================================================
STYLES.forEach(style => {
    [0, 35, 100].forEach(curve => {
        const a = makeNode("A", 100, 300, 14, 40);
        const b = makeNode("B", 600, 300, 14, 40);
        const bands = route([a, b], corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]),
            { style, curvaturePercent: curve });
        const distinctY = Array.from(new Set(samplePath(bands[0].path).map(p => p.y.toFixed(3))));
        check(`${style} @ curvature ${curve}: an aligned run is dead straight (${distinctY.length} distinct y)`, distinctY.length === 2);
    });
});

// ===================================================================
// 3. Orthogonal squares off DIRECT routes; Smooth doesn't. (There was a
//    fourth style, an older "Smooth" that curved wrap routes too; it was
//    dropped and its name given to what used to be called Hybrid.)
// ===================================================================
{
    const a = makeNode("A", 100, 300, 14, 60);
    const b = makeNode("B", 600, 500, 14, 60); // different row => needs a bend
    const corridor = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]);

    const orth = route([a, b], corridor, { style: "Orthogonal", curvaturePercent: 0 });
    check("Orthogonal direct route emits no curve commands at curvature 0", !orth[0].path.includes("C "));

    // Every edge of the band should run along an axis (equal offsets at both
    // ends, so the taper can't slant them).
    const pts = samplePath(orth[0].path);
    let slanted = 0;
    for (let k = 1; k < pts.length; k++) {
        const dx = Math.abs(pts[k].x - pts[k - 1].x);
        const dy = Math.abs(pts[k].y - pts[k - 1].y);
        if (dx > 0.5 && dy > 0.5) slanted++;
    }
    check(`Orthogonal direct route is axis-aligned throughout (${slanted} slanted edges)`, slanted === 0);

    const smooth = route([a, b], corridor, { style: "Smooth", curvaturePercent: 0 });
    check("Smooth keeps a direct route curved", smooth[0].path.includes("C "));
    check("Orthogonal and Smooth genuinely differ on a direct route", orth[0].path !== smooth[0].path);

    // A WRAP route is squared off in every style, including Smooth: a curve
    // through the clearing lane cuts the node the lane exists to miss. This
    // is the one behaviour the dropped style had that nothing has now.
    const away = corridorOf("A", "B", "East", "East", [{ flowType: undefined, value: 40, flows: [] }]);
    const wrapped = route([a, b], away, { style: "Smooth", curvaturePercent: 0 });
    check("Smooth squares off a wrap route", !wrapped[0].path.includes("C "));
}

// ===================================================================
// 3b. Orthogonal's step stays BETWEEN the two stubs, and Orthogonal
//     offers that step as its only handle.
// ===================================================================
{
    const { routeDiagram, draggableHandles } = require("./routing-api.js");
    const a = makeNode("A", 100, 300, 14, 60);
    const b = makeNode("B", 900, 560, 14, 60);
    const corridor = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]);
    // Same layout shape the route() helper above builds, so the check can't
    // disagree with the rest of the file about what a layout is.
    const layout = {
        nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 140, rowPitch: 100
    };
    const geometry = { portLeadInPercent: 15, curvaturePercent: 0, style: "Orthogonal" };
    const go = ov => routeDiagram(layout, geometry, ov ? new Map([[corridor.id, ov]]) : new Map());

    const base = go();
    const h = base.handles.get(corridor.id);
    const stubOut = h.source.point.x, stubIn = h.target.point.x, step = h.middle.point.x;
    check("an Orthogonal route steps across between its two stubs",
        step >= stubOut - 0.001 && step <= stubIn + 0.001);

    // Dragged towards either stub, the step is held a band's WIDTH clear of
    // it. Beyond the stub the route doubles back on itself; closer than the
    // band's width, the mitres at the two corners overlap and the ribbon
    // folds -- measured, at half-width 80 the outline crossed itself for
    // every step within 80px of the stub.
    // Half the band's width plus a pixel: what the mitre at the step needs,
    // since its corner reaches back half a width along this run. It was a
    // FULL width until roundedPolyline stopped charging the collinear stub
    // for an arc it never draws, which had been halving the radius and so
    // doubling what the step had to stand clear of.
    const margin = corridor.value / 2 + 1; // valueToPixels here is the value itself
    const far = go({ middle: { x: stubIn + 5000, y: 0 } }).handles.get(corridor.id);
    check("dragged past the far stub, the step stops half a band clear of it",
        Math.abs(far.middle.point.x - (stubIn - margin)) < 0.001,
        `${far.middle.point.x.toFixed(1)} vs ${(stubIn - margin).toFixed(1)}`);
    const near = go({ middle: { x: stubOut - 5000, y: 0 } }).handles.get(corridor.id);
    check("dragged back past the near stub, it stops half a band clear too",
        Math.abs(near.middle.point.x - (stubOut + margin)) < 0.001,
        `${near.middle.point.x.toFixed(1)} vs ${(stubOut + margin).toFixed(1)}`);
    // The point of the whole exercise: from the node's face to the inside of
    // that corner is half the band plus a pixel, not a full band.
    const face = a.x + a.width;
    // The outline's x values past the face are: the stub (where the lead
    // ends, four times over -- both edges, out and back), then the inside of
    // the corner. Take the second distinct one.
    const past = Array.from(new Set([...go({ middle: { x: stubOut - 5000, y: 0 } }).bands[0].path
        .matchAll(/[ML] (-?\d+(?:\.\d+)?) /g)].map(m => Number(m[1]).toFixed(3))))
        .map(Number).filter(x => x > face + 0.01).sort((p, q) => p - q);
    const inner = past[1];
    // Half the band plus TWO pixels: the lead floor contributes one and the
    // step margin the other. It was half + 1 + a full band before.
    check("...so the inside of the corner sits half a band from the face, not a whole one",
        Math.abs((inner - face) - (corridor.value / 2 + 2)) < 0.001);
    check("...and the band doesn't fold at either extreme", (() => {
        const verts = d => [...d.matchAll(/[ML] (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(m => ({ x: +m[1], y: +m[2] }));
        const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
        const hits = P => {
            let n = 0;
            for (let i = 0; i < P.length - 1; i++) {
                for (let j = i + 2; j < P.length - 1; j++) {
                    if (i === 0 && j === P.length - 2) continue;
                    if (side(P[i], P[i + 1], P[j]) !== side(P[i], P[i + 1], P[j + 1]) &&
                        side(P[j], P[j + 1], P[i]) !== side(P[j], P[j + 1], P[i + 1])) n++;
                }
            }
            return n;
        };
        return [stubIn + 5000, stubOut - 5000, stubOut + 1, stubIn - 1]
            .every(x => hits(verts(go({ middle: { x, y: 0 } }).bands[0].path)) === 0);
    })());
    // Inside the pair it still follows the cursor exactly.
    const inside = stubOut + (stubIn - stubOut) * 0.25;
    check("between them it lands where it was dropped",
        Math.abs(go({ middle: { x: inside, y: 0 } }).handles.get(corridor.id).middle.point.x - inside) < 0.001);

    // What the author may touch: Orthogonal shows the step alone.
    const shown = draggableHandles(base.handles, "Orthogonal").get(corridor.id);
    check("Orthogonal draws no lead handles",
        shown.source === undefined && shown.target === undefined && shown.middle !== undefined);
    const smoothShown = draggableHandles(base.handles, "Smooth").get(corridor.id);
    check("...while the other styles keep theirs",
        smoothShown.source !== undefined && smoothShown.target !== undefined);
    // Routing itself must still HAVE both, or avoidance can't reshape a route.
    check("routing keeps both leads internally whatever is drawn",
        h.source !== undefined && h.target !== undefined);

    // A style that doesn't offer the lead handles must not honour leads moved
    // in another style either: the author could see neither the handle nor a
    // way to reset it, and Port lead-in appeared to do nothing.
    const stale = { source: { x: 600, y: 0 }, target: { x: 400, y: 0 } };
    const atLead = (style, lead, ov) => routeDiagram(layout,
        { portLeadInPercent: lead, curvaturePercent: 0, style },
        ov ? new Map([[corridor.id, ov]]) : new Map()).handles.get(corridor.id);

    check("Orthogonal ignores leads moved in another style",
        Math.abs(atLead("Orthogonal", 15, stale).source.point.x - atLead("Orthogonal", 15).source.point.x) < 0.001);
    check("...so Port lead-in reaches every corridor",
        atLead("Orthogonal", 15, stale).source.point.x < atLead("Orthogonal", 40, stale).source.point.x - 10 &&
        atLead("Orthogonal", 40, stale).source.point.x < atLead("Orthogonal", 80, stale).source.point.x - 10,
        [15, 40, 80].map(l => atLead("Orthogonal", l, stale).source.point.x.toFixed(1)).join(" -> "));
    // Below the floor the setting stops mattering, which is the floor doing
    // its job rather than an override sneaking back in: the stub sits at the
    // band's half-width plus a pixel, not on the node's face.
    const bottom = atLead("Orthogonal", 0, stale).source.point.x;
    check("...down to a floor of the band's half-width plus a pixel",
        Math.abs(bottom - (a.x + a.width + corridor.value / 2 + 1)) < 0.001,
        `${bottom.toFixed(1)} vs ${(a.x + a.width + corridor.value / 2 + 1).toFixed(1)}`);
    check("...while the step it DOES offer is still honoured",
        Math.abs(atLead("Orthogonal", 15, { ...stale, middle: { x: 300, y: 0 } }).middle.point.x - 300) < 0.001);
    check("...and the other styles still honour a moved lead",
        Math.abs(atLead("Smooth", 15, stale).source.point.x - atLead("Smooth", 15).source.point.x) > 10);
    check("...which is kept in the blob, so switching back finds it",
        Math.abs(atLead("Smooth", 0, stale).source.point.x - atLead("Smooth", 40, stale).source.point.x) < 0.001);

    // Orthogonal's lead has a per-corridor floor of the band's half-width + 1.
    // With the step dragged back onto the stub, the cross-run straddles it, so
    // a shorter lead puts the band across the node: measured, a half-width of
    // 80 overshot the face by exactly 80.
    const wide = (value, lead) => {
        const h = Math.max(4, value);
        const wa = makeNode("A", 100, 300, 14, h), wb = makeNode("B", 900, 560, 14, h);
        const wc = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value, flows: [] }]);
        const wl = {
            nodes: new Map([["A", wa], ["B", wb]]), corridors: [wc],
            valueToPixels: v => Math.max(4, v), columnGap: 140, rowPitch: 100
        };
        const r = routeDiagram(wl, { portLeadInPercent: lead, curvaturePercent: 0, style: "Orthogonal" },
            new Map([[wc.id, { middle: { x: -99999, y: 0 } }]]));
        const xs = [...r.bands[0].path.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
        return { face: wa.x + wa.width, half: h / 2, stub: r.handles.get(wc.id).source.point.x, minX: Math.min(...xs) };
    };
    [10, 40, 80, 160].forEach(value => {
        const r = wide(value, 0);
        check(`a corridor of half-width ${r.half} never reaches back past the node face`,
            r.minX >= r.face - 0.001, `face ${r.face.toFixed(1)}, band reaches ${r.minX.toFixed(1)}`);
        check("...its lead being floored at that half-width plus a pixel",
            Math.abs(r.stub - (r.face + r.half + 1)) < 0.001,
            `${r.stub.toFixed(1)} vs ${(r.face + r.half + 1).toFixed(1)}`);
    });
    // The pixel matters: at exactly the half-width the inner edge's
    // perpendicular run is zero-length, and a segment with no direction is
    // how a band pinches to nothing.
    check("the floor leaves a real perpendicular run, not a zero-length one",
        wide(80, 0).stub - wide(80, 0).face - wide(80, 0).half > 0.5);
}

// ===================================================================
// 3c. A same-axis direct route's leads are bounded by the SPAN between
//     its anchors, not by half a grid cell. The old ceiling bound
//     corridors spanning several columns where there was plainly room.
// ===================================================================
{
    const { routeDiagram } = require("./routing-api.js");
    const a = makeNode("A", 100, 300, 14, 40), b = makeNode("B", 1000, 420, 14, 40);
    const c = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]);
    const layout = {
        nodes: new Map([["A", a], ["B", b]]), corridors: [c],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
    const face = a.x + a.width;
    const span = b.x - face;
    const leadWhenAsked = (style, want) => {
        const r = routeDiagram(layout, { portLeadInPercent: 20, curvaturePercent: 35, style },
            new Map([[c.id, { source: { x: face + want, y: 0 } }]]));
        return r.handles.get(c.id).source.point.x - face;
    };

    // Half a column less the curve's room would have been ~80px here, on a
    // route with 886px of room.
    const oldCeiling = 0.5 * layout.columnGap - 0.35 * Math.min(layout.columnGap, layout.rowPitch);
    check("a Smooth lead goes far past the old half-a-cell ceiling",
        leadWhenAsked("Smooth", 600) > oldCeiling * 3);
    check("...landing exactly where it was dropped",
        Math.abs(leadWhenAsked("Smooth", 600) - 600) < 0.001);
    // The span bound itself now serves ORTHOGONAL alone: the
    // original Smooth, a single cubic that would double back if its stubs
    // crossed, was retired, and today's Smooth is Polyline's free diagonal
    // with arcs in it. Orthogonal ignores dragged leads, so the bound is
    // reached through the Port lead-in setting: however far that asks, the two
    // stubs meet at the span and never cross.
    const orthogonalLeads = pct => {
        const h = routeDiagram(layout, { portLeadInPercent: pct, curvaturePercent: 35, style: "Orthogonal" })
            .handles.get(c.id);
        return { out: h.source.point.x - face, in: b.x - h.target.point.x, crossed: h.source.point.x > h.target.point.x + 0.001 };
    };
    check("Orthogonal's leads stop where the two stubs meet",
        [100, 300, 1000].every(pct => !orthogonalLeads(pct).crossed),
        [100, 300, 1000].map(pct => orthogonalLeads(pct).out.toFixed(0) + "+" + orthogonalLeads(pct).in.toFixed(0)).join(", "));
    check("...using the whole span when asked for more than it",
        Math.abs(orthogonalLeads(1000).out + orthogonalLeads(1000).in - span) < 0.01);

    // Polyline keeps no ceiling at all: its stubs may meet, which is what
    // makes a right angle reachable by hand.
    check("Polyline is still free of any ceiling",
        Math.abs(leadWhenAsked("Polyline", 900) - 900) < 0.001);

    // A perpendicular pairing keeps the per-axis cap: its two leads run
    // along different axes, so "they must not pass each other" says nothing.
    const perp = corridorOf("A", "B", "East", "North", [{ flowType: undefined, value: 40, flows: [] }]);
    const perpLayout = { ...layout, corridors: [perp] };
    // (Smooth has none: its 90-degree corner is shaped by a corner handle,
    // the leads derived from the radius -- see biarc-quarter-check.)
    // Neither style lets the author drag these leads (Polyline hides them
    //), so the cap is reached through the Port lead-in
    // setting instead: however much it asks, the lead stays capped.
    ["Polyline", "Orthogonal"].forEach(style => {
        const perpLead = routeDiagram(perpLayout, { portLeadInPercent: 1000, curvaturePercent: 35, style })
            .handles.get(perp.id).source.point.x - face;
        check(style + ": a perpendicular route keeps its own per-axis cap", perpLead < span * 0.5,
            perpLead.toFixed(0) + " against half the span " + (span / 2).toFixed(0));
    });
}

// ===================================================================
// 3d. A straight run's EDGE stays straight, however long the run.
//     The band's edges are splines through sampled points, and a spline
//     takes its tangent from the points either side -- so a long run
//     sampled sparsely next to a densely-sampled arc used to lean into
//     the curve and bulge away from its own line.
// ===================================================================
{
    const { routeDiagram } = require("./routing-api.js");
    const wander = (lead, style, curvaturePercent) => {
        const a = makeNode("A", 100, 300, 14, 60), b = makeNode("B", 900, 520, 14, 60);
        const c = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 60, flows: [] }]);
        const layout = {
            nodes: new Map([["A", a], ["B", b]]), corridors: [c],
            valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        };
        const face = a.x + a.width;
        const band = routeDiagram(layout, { portLeadInPercent: 20, curvaturePercent, style },
            new Map([[c.id, { source: { x: face + lead, y: 0 } }]])).bands[0];
        const S = samplePath(band.path, 30);
        const y0 = S[0].y;
        // The edge that leaves the port, over the straight part of its lead
        // only -- the arc starts after that.
        const along = S.filter(q => q.x > face + 1 && q.x < face + lead * 0.85 && Math.abs(q.y - y0) < 25);
        return along.length ? Math.max(...along.map(q => Math.abs(q.y - y0))) : NaN;
    };

    // Before the shoulder samples: 6.1px at a 200px lead, 24.7px at 400+.
    // Measured over the lead the route actually GOT, since Smooth now caps a
    // dragged lead at whatever the curve can spare.
    [100, 200, 300].forEach(lead => {
        check(`a ${lead}px lead run stays straight in Smooth`, wander(lead, "Smooth", 35) < 0.5);
    });
}

// ===================================================================
// 4. Curvature 0 gives genuinely SHARP corners on a squared-off route,
//    and they're mitred rather than folded.
// ===================================================================
{
    const n = makeNode("N", 400, 300, 14, 60);
    const loop = corridorOf("N", "N", "East", "West", [{ flowType: undefined, value: 20, flows: [] }]);

    const sharp = route([n], loop, { style: "Smooth", curvaturePercent: 0 });
    const rounded = route([n], loop, { style: "Smooth", curvaturePercent: 35 });
    check("sharp corners emit a straight-line path (no curve commands)", !sharp[0].path.includes("C "));
    check("rounded corners still emit curves", rounded[0].path.includes("C "));

    // At least one genuine right-angle turn along the band outline.
    const pts = samplePath(sharp[0].path);
    let rightAngles = 0;
    for (let k = 1; k < pts.length - 1; k++) {
        const d1 = { x: pts[k].x - pts[k - 1].x, y: pts[k].y - pts[k - 1].y };
        const d2 = { x: pts[k + 1].x - pts[k].x, y: pts[k + 1].y - pts[k].y };
        const l1 = Math.hypot(d1.x, d1.y), l2 = Math.hypot(d2.x, d2.y);
        if (l1 < 0.5 || l2 < 0.5) continue;
        const cos = (d1.x * d2.x + d1.y * d2.y) / (l1 * l2);
        if (Math.abs(cos) < 0.05) rightAngles++;
    }
    check(`sharp path turns through real right angles (${rightAngles} found)`, rightAngles >= 4);

    // The fold the miter construction exists to prevent: the band's two edges
    // must keep a consistent width rather than crossing over each other.
    const half = Math.floor(pts.length / 2);
    const low = pts.slice(0, half);
    const high = pts.slice(half).reverse();
    let minWidth = Infinity, maxWidth = 0;
    for (let k = 0; k < Math.min(low.length, high.length); k++) {
        const w = Math.hypot(low[k].x - high[k].x, low[k].y - high[k].y);
        minWidth = Math.min(minWidth, w);
        maxWidth = Math.max(maxWidth, w);
    }
    check(`sharp band never collapses or folds (width ${minWidth.toFixed(1)}..${maxWidth.toFixed(1)})`,
        Number.isFinite(minWidth) && minWidth > 1);
}

// ===================================================================
// 5. Multi-segment corridors stay adjacent in every style, sharp or not.
// ===================================================================
STYLES.forEach(style => {
    [0, 35].forEach(curve => {
        const a = makeNode("A", 100, 300, 14, 60);
        const b = makeNode("B", 600, 500, 14, 60);
        const bands = route([a, b], corridorOf("A", "B", "East", "West", [
            { flowType: "x", value: 30, flows: [] },
            { flowType: "y", value: 20, flows: [] }
        ]), { style, curvaturePercent: curve });
        check(`${style} @ ${curve}: 2 segments produced`, bands.length === 2);
        if (bands.length !== 2) return;
        const first = samplePath(bands[0].path);
        const second = samplePath(bands[1].path);
        const gap = Math.min(...second.map(p => Math.min(...first.map(q => Math.hypot(p.x - q.x, p.y - q.y)))));
        check(`${style} @ ${curve}: segments stay adjacent (gap ${gap.toFixed(2)})`, gap < 1);
    });
});

// ===================================================================
// Polyline's 90-degree corner offers no lead handles.
// Its corner sits where the two port directions cross, which the nodes fix,
// and each lead's end lies partway along a straight run -- dragged -40 to
// +450px it never changed the route when rounded, and only nudged the band's
// taper by a few pixels at Curvature 0. Like Orthogonal, the hidden handles'
// stale overrides are ignored rather than left shaping the route unseen.
// ===================================================================
{
    const { routeDiagram, draggableHandles } = require("./routing-api.js");
    const n = (id, x, y, w, h) => ({ id, label: id, x, y, width: w, height: h, inflow: 0, outflow: 0, isSelfLoop: false });
    const PAIRS = [["North", "West"], ["North", "East"], ["South", "West"], ["South", "East"],
        ["East", "South"], ["East", "North"], ["West", "South"], ["West", "North"]];
    let corners = 0;
    [[n("A", 100, 400, 14, 40), n("B", 700, 150, 14, 90)], [n("A", 120, 200, 14, 60), n("B", 560, 520, 14, 60)]].forEach(([a, b]) => {
        PAIRS.forEach(([sp, tp]) => {
            [0, 35].forEach(curvature => {
                const c = {
                    id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
                    segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp
                };
                const layout = {
                    nodes: new Map([["A", a], ["B", b]]), corridors: [c],
                    valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
                };
                const opt = { portLeadInPercent: 20, curvaturePercent: curvature, style: "Polyline" };
                const base = routeDiagram(layout, opt);
                const all = base.handles.get("A->B");
                // Only a DIRECT corner, by routing's own wrap rule. A
                // perpendicular WRAP has no lane either, but its leads each
                // place one of its long runs, so they are real and stay --
                // screening wraps out by "has a lane" wrongly swept those in.
                const N = { North: { x: 0, y: -1 }, South: { x: 0, y: 1 }, East: { x: 1, y: 0 }, West: { x: -1, y: 0 } };
                const s0 = base.bands[0].start, e0 = base.bands[0].end;
                const wraps = (e0.x - s0.x) * N[sp].x + (e0.y - s0.y) * N[sp].y < 1e-6
                    || (s0.x - e0.x) * N[tp].x + (s0.y - e0.y) * N[tp].y < 1e-6;
                if (wraps) {
                    return;
                }
                corners++;
                const shown = draggableHandles(base.handles, "Polyline").get("A->B");
                check(sp + "->" + tp + " at Curvature " + curvature + ": no lead handles shown",
                    !shown.source && !shown.target);
                check(sp + "->" + tp + " at Curvature " + curvature + ": routing keeps both leads (avoidance reads them)",
                    all.source !== undefined && all.target !== undefined);
                const stale = routeDiagram(layout, opt,
                    new Map([["A->B", { source: { x: a.x + a.width + 90, y: a.y + 10 } }]]));
                check(sp + "->" + tp + " at Curvature " + curvature + ": a stale lead drag is ignored",
                    stale.bands[0].path === base.bands[0].path);
            });
        });
    });
    check("the Polyline 90-degree assertions actually ran (" + corners + " corners)", corners >= 8);
    // ...and a same-axis Polyline route keeps all three of its handles.
    const a = n("A", 100, 300, 14, 40), b = n("B", 900, 420, 14, 40);
    const straight = {
        id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
        segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "West"
    };
    const routed = routeDiagram({
        nodes: new Map([["A", a], ["B", b]]), corridors: [straight],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    }, { portLeadInPercent: 20, curvaturePercent: 35, style: "Polyline" });
    const shown = draggableHandles(routed.handles, "Polyline").get("A->B");
    check("a same-axis Polyline route still offers both leads and the bend",
        shown.source !== undefined && shown.target !== undefined && shown.middle !== undefined);
}

// ---------------------------------------------------------------------------
// partialPath: the stripe at a fraction of its width
//
// The sub-band an inbound PARTIAL highlight is drawn with. It exists in
// routing rather than render because a sub-band IS band geometry, and the
// invariant is that nothing downstream re-derives what routing hands out.
//
// The assertion that makes it provably the same geometry rather than a
// near-miss: **partialPath(1) is byte-identical to path**, on every style. A
// separate sweep over the real datasets (4 x 4 = 548 bands) confirmed it, and
// this is the version that runs every time.
{
    const nodes = [
        { id: "A", x: 0, y: 0, width: 20, height: 120 },
        { id: "B", x: 400, y: 160, width: 20, height: 120 }
    ];
    const corridor = {
        id: "A->B", source: "A", target: "B", sourcePort: "East", targetPort: "West",
        value: 40, segments: [{ flowType: "x", value: 25 }, { flowType: "y", value: 15 }]
    };
    ["Smooth", "Polyline", "Octilinear", "Orthogonal"].forEach(style => {
        // `route` wraps routeCorridors, which returns the bands themselves.
        const bands = route(nodes, corridor, { style });
        check(`${style}: every band offers a partialPath`,
            bands.length === 2 && bands.every(b => typeof b.partialPath === "function"));
        check(`${style}: partialPath(1) is byte-identical to path`,
            bands.every(b => b.partialPath(1) === b.path));
        check(`${style}: a fraction is clamped, so 99 is the whole band and -5 is 0`,
            bands.every(b => b.partialPath(99) === b.path
                && b.partialPath(-5) === b.partialPath(0)));
        // A sub-band must be strictly inside its parent: same start, shorter
        // across. Compared by the extent of the sampled path, which is what a
        // reader actually sees.
        bands.forEach(b => {
            const spanOf = d => {
                const pts = samplePath(d);
                const ys = pts.map(p => p.y);
                const xs = pts.map(p => p.x);
                return Math.max(Math.max(...ys) - Math.min(...ys), Math.max(...xs) - Math.min(...xs));
            };
            const half = spanOf(b.partialPath(0.5));
            const whole = spanOf(b.path);
            check(`${style}: a half sub-band is no bigger than the whole stripe`,
                half <= whole + 1e-6);
        });
    });
}

// ===================================================================
// N. The band OUTLINE is capped at an end no arrow continues, in every
//    style and in BOTH edge builders.
//
//    the code once dropped both caps, because a cap sits on a node face and an
//    arrow grows out of that face: a line across the join made a hatched band
//    and its arrow head read as two shapes. the code once makes it per-end, on
//    the author's "outline should close the start and end of flows if there are no
//    arrows" -- with the arrow off the flow really does end at the face.
//
//    Swept over styles AND over curvature, because there are two builders and
//    `closeBand` has always dispatched between them: a sharp route's edges are
//    polylines and only Curvature 0 on a squared-off style produces one, so a
//    cap added to the spline builder alone would be missing on exactly the
//    styles that mitre. The subpath count is what pins the MITRE: one cap has
//    to join both edges into a single run rather than butt against them as a
//    third subpath, which at a band's corner would leave a notch the width of
//    the stroke.
// ===================================================================
{
    const nodes = [makeNode("A", 0, 0, 20, 60), makeNode("B", 300, 0, 20, 60)];
    const corridor = corridorOf("A", "B", "East", "West",
        [{ flowType: "one", value: 30, flows: [] }, { flowType: "two", value: 10, flows: [] }]);
    const subpaths = d => (d.match(/M/g) || []).length;
    const closes = d => (d.match(/[Zz]/g) || []).length;
    let swept = 0;
    ["Smooth", "Orthogonal", "Polyline", "Octilinear"].forEach(style => {
        [0, 35].forEach(curvaturePercent => {
            const at = arrows => route(nodes, corridor,
                { style, curvaturePercent, arrows: { ...arrows, angleDegrees: 90, gapPercent: 8 } });
            const tag = `${style}@${curvaturePercent}`;
            const both = at({ heads: true, tails: true });
            const noneOn = at({ heads: false, tails: false });
            const headsOnly = at({ heads: true, tails: false });
            const tailsOnly = at({ heads: false, tails: true });
            swept += both.length;
            check(`${tag}: arrows on leaves both ends open -- two runs, no cap`,
                both.length === 2 && both.every(b =>
                    subpaths(b.edges) === 2 && closes(b.edges) === 0));
            check(`${tag}: no arrows caps both ends, as the band's own closed path`,
                noneOn.every(b => subpaths(b.edges) === 1 && closes(b.edges) === 1
                    && b.edges === b.path));
            check(`${tag}: heads only caps the source end, as ONE mitred run`,
                headsOnly.every(b => subpaths(b.edges) === 1 && closes(b.edges) === 0));
            check(`${tag}: tails only caps the target end, as ONE mitred run`,
                tailsOnly.every(b => subpaths(b.edges) === 1 && closes(b.edges) === 0));
            // The cap is a LINE between the two edges' ends, so a capped
            // outline visits every point an open one did and exactly two more
            // -- nothing is re-fitted, and the long edges cannot drift.
            check(`${tag}: capping re-fits neither edge`,
                headsOnly.every((b, i) => {
                    const open = both[i].edges.replace(/M/g, "L").trim();
                    const shut = headsOnly[i].edges.replace(/M/g, "L").trim();
                    return open.split("L").filter(s => s.trim()).every(p =>
                        shut.includes(p.trim()));
                }));
        });
    });
    // Both builders really were exercised: a squared-off style at Curvature 0
    // is the only thing that produces a sharp route, and `sharpOpenEdges` is
    // the only place that knows how to open one.
    check("the outline sweep covered every style at both curvatures",
        swept === 16);
}

if (failures === 0) {
    console.log("ALL ROUTING-STYLE CHECKS PASSED");
} else {
    console.log(`${failures} ROUTING-STYLE CHECK(S) FAILED`);
    process.exit(1);
}
