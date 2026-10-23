"use strict";
// Polyline routing style: Orthogonal, but a same-axis DIRECT route joins its
// two lead-ins with one diagonal instead of stepping across at a right angle.
// Wraps stay squared off (their clearance maths assumes axis-aligned runs).

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors, routeDiagram } = require("./routing-api.js");

const ROLES = ["source", "target", "value", "sourcePort", "targetPort", "sourceRow", "targetRow",
    "sourceColumn", "targetColumn"];
const dataViewOf = rows => ({
    table: {
        columns: ROLES.map(r => ({ roles: { [r]: true } })),
        rows: rows.map(r => ROLES.map(k => (k in r ? r[k] : null)))
    }
});
const CHROME = {
    legendVisible: false, legendPosition: "Bottom"
};

function route(rows, style, over = {}) {
    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1400, 800, CHROME);
    const bands = routeCorridors(layout, {
        portLeadInPercent: 18, curvaturePercent: over.curvature ?? 35, style, ...over.options
    }, over.positions);
    return { bands, layout, corridors };
}

/** A path's raw vertices: M/L/C endpoints, no subdivision. */
function vertices(d) {
    const out = [];
    const re = /([MLC])([^MLCZ]*)/g;
    let m;
    while ((m = re.exec(d)) !== null) {
        const n = m[2].trim().split(/[\s,]+/).filter(x => x.length).map(Number);
        if (m[1] === "C") { out.push({ x: n[4], y: n[5] }); }
        else { out.push({ x: n[0], y: n[1] }); }
    }
    return out;
}

/** The runs of a band's centreline, as {dx, dy} steps between vertices. */
function runs(d) {
    const v = vertices(d);
    const out = [];
    for (let i = 1; i < v.length; i++) {
        const dx = v[i].x - v[i - 1].x, dy = v[i].y - v[i - 1].y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { out.push({ dx, dy }); }
    }
    return out;
}

const AXIS_TOL = 0.5;
const isDiagonal = r => Math.abs(r.dx) > 2 && Math.abs(r.dy) > 2;
const isAxisAligned = r => Math.abs(r.dx) <= AXIS_TOL || Math.abs(r.dy) <= AXIS_TOL;

// A plain A->B with the two nodes on different rows: the case the whole
// feature is about.
const OFFSET = [
    { source: "A", target: "B", value: 10, sourceRow: 1, targetRow: 3 },
    { source: "C", target: "D", value: 10, sourceRow: 5, targetRow: 5 }
];

// ===============================================================
// 1. A same-axis direct route is out, diagonal, in -- three runs.
// ===============================================================
{
    const sharp = route(OFFSET, "Polyline", { curvature: 0 });
    const ab = sharp.bands.find(b => b.source === "A" && b.target === "B");
    const r = runs(ab.path);

    // The band outline is a closed loop (out along one edge, back along the
    // other), so the centreline's runs appear twice.
    const diagonals = r.filter(isDiagonal);
    check("a polyline route contains diagonal runs", diagonals.length > 0, `${diagonals.length} of ${r.length}`);
    check("...and its other runs are axis-aligned",
        r.filter(x => !isDiagonal(x)).every(isAxisAligned),
        JSON.stringify(r.filter(x => !isDiagonal(x) && !isAxisAligned(x))));

    // Orthogonal on the same data has a step, not a slope.
    const ortho = route(OFFSET, "Orthogonal", { curvature: 0 });
    const orthoAb = ortho.bands.find(b => b.source === "A" && b.target === "B");
    check("Orthogonal has no diagonal run at all",
        runs(orthoAb.path).filter(isDiagonal).length === 0,
        JSON.stringify(runs(orthoAb.path).filter(isDiagonal)));
    check("...and it has MORE runs than the polyline, being a Z not a slope",
        runs(orthoAb.path).length > r.length, `${runs(orthoAb.path).length} vs ${r.length}`);
}

// ===============================================================
// 2. Aligned anchors still render dead straight -- the property that
//    makes an ordinary corridor look right.
// ===============================================================
{
    const sharp = route(OFFSET, "Polyline", { curvature: 0 });
    const cd = sharp.bands.find(b => b.source === "C" && b.target === "D");
    check("an aligned corridor has no diagonal", runs(cd.path).filter(isDiagonal).length === 0);
    // The outline is two edges; each must hold ONE y for its whole length.
    // (The gap between them is the band's own thickness, which is the flow.)
    const ys = vertices(cd.path).map(v => Number(v.y.toFixed(2)));
    check("...and each of its edges stays flat across the whole length",
        new Set(ys).size === 2, JSON.stringify(Array.from(new Set(ys))));
}

// ===============================================================
// 3. Curvature rounds the two knees; 0 keeps them sharp.
// ===============================================================
{
    const sharp = route(OFFSET, "Polyline", { curvature: 0 });
    const curved = route(OFFSET, "Polyline", { curvature: 60 });
    const sharpAb = sharp.bands.find(b => b.source === "A" && b.target === "B");
    const curvedAb = curved.bands.find(b => b.source === "A" && b.target === "B");

    check("Curvature 0 emits no curve commands", !sharpAb.path.includes("C"), sharpAb.path.slice(0, 60));
    check("Curvature > 0 does", curvedAb.path.includes("C"));
    check("...and still gets from the same source to the same target",
        Math.hypot(curvedAb.start.x - sharpAb.start.x, curvedAb.start.y - sharpAb.start.y) < 0.001 &&
        Math.hypot(curvedAb.end.x - sharpAb.end.x, curvedAb.end.y - sharpAb.end.y) < 0.001);
    check("every coordinate is finite at both settings",
        [sharpAb, curvedAb].every(b => vertices(b.path).every(v => Number.isFinite(v.x) && Number.isFinite(v.y))));
}

// ===============================================================
// 4. Wraps stay squared off -- the agreed call, and their clearance maths
//    assumes axis-aligned runs.
// ===============================================================
{
    // East->East: the target's port faces away from the source, so the route
    // has to come round the far side.
    const wrapRows = [
        { source: "A", target: "B", value: 10, sourcePort: "East", targetPort: "East", sourceRow: 1, targetRow: 3 }
    ];
    const poly = route(wrapRows, "Polyline", { curvature: 0 });
    const band = poly.bands[0];
    const r = runs(band.path);
    check("a wrap route has no diagonal runs under Polyline",
        r.filter(isDiagonal).length === 0, JSON.stringify(r.filter(isDiagonal)));
    check("...and is identical to the Orthogonal one",
        band.path === route(wrapRows, "Orthogonal", { curvature: 0 }).bands[0].path);
}

// ===============================================================
// 5. Perpendicular ports stay a single L -- there are no two parallel
//    runs for a diagonal to join.
// ===============================================================
{
    const perp = [{ source: "A", target: "B", value: 10, sourcePort: "East", targetPort: "North", sourceRow: 1, targetRow: 3 }];
    const poly = route(perp, "Polyline", { curvature: 0 }).bands[0];
    check("a perpendicular direct route has no diagonal",
        runs(poly.path).filter(isDiagonal).length === 0, JSON.stringify(runs(poly.path).filter(isDiagonal)));
    // The same SHAPE as Orthogonal's L, though no longer byte-identical:
    // Orthogonal floors its leads at the band's half-width (its own leads not
    // being draggable), and Polyline deliberately doesn't.
    const orthoPerp = route(perp, "Orthogonal", { curvature: 0 }).bands[0];
    check("...and is an L, exactly as Orthogonal draws one",
        runs(orthoPerp.path).filter(isDiagonal).length === 0 &&
        runs(poly.path).length === runs(orthoPerp.path).length,
        `${runs(poly.path).length} runs vs ${runs(orthoPerp.path).length}`);
}

// ===============================================================
// 6. The two lead handles: FREE and INDEPENDENT. The only rule left is
//    the perpendicular one -- each stub stays on its port's normal.
//    Mirrored leads and a third (middle) handle were both tried and
//    withdrawn: they coupled the controls, and the coupling is what
//    made a handle stop following the cursor.
// ===============================================================
{
    const { flows } = parseDataView(dataViewOf(OFFSET));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1400, 800, CHROME);
    const geometry = { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline" };
    const ab = corridors.find(c => c.source === "A" && c.target === "B");
    const at = ov => {
        const r = routeDiagram(layout, geometry, new Map([[ab.id, ov]]));
        const h = r.handles.get(ab.id);
        const band = r.bands.find(b => b.source === "A");
        return { src: h.source.point.x, tgt: h.target.point.x, middle: h.middle, band };
    };

    const f = at({});
    check("a diagonal offers a bend handle, on the diagonal itself",
        f.middle !== undefined &&
        Math.abs(f.middle.point.x - (f.src + f.tgt) / 2) < 0.001, JSON.stringify(f.middle));
    check("...which slides ALONG the route", f.middle.axis === "x");
    check("the two leads start equal",
        Math.abs((f.src - f.band.start.x) - (f.band.end.x - f.tgt)) < 0.001);

    // Independent: dragging one must leave the other exactly where it was.
    const movedOut = at({ source: { x: f.src + 250, y: 0 } });
    check("dragging stubOut lands it where dropped",
        Math.abs(movedOut.src - (f.src + 250)) < 0.001, `${(f.src + 250).toFixed(1)} -> ${movedOut.src.toFixed(1)}`);
    check("...and leaves stubIn untouched",
        Math.abs(movedOut.tgt - f.tgt) < 0.001, `${f.tgt.toFixed(1)} -> ${movedOut.tgt.toFixed(1)}`);

    const movedIn = at({ target: { x: f.tgt - 300, y: 0 } });
    check("dragging stubIn lands it where dropped",
        Math.abs(movedIn.tgt - (f.tgt - 300)) < 0.001);
    check("...and leaves stubOut untouched", Math.abs(movedIn.src - f.src) < 0.001);

    // Both at once, each still its own.
    const both = at({ source: { x: f.src + 120, y: 0 }, target: { x: f.tgt - 40, y: 0 } });
    check("both can be placed independently",
        Math.abs(both.src - (f.src + 120)) < 0.001 && Math.abs(both.tgt - (f.tgt - 40)) < 0.001,
        `${both.src.toFixed(1)}, ${both.tgt.toFixed(1)}`);

    // No ceiling: a lead may run the whole span, so the stubs can MEET --
    // which is a right angle. This is what the old cap made unreachable.
    const meeting = (f.band.start.x + f.band.end.x) / 2;
    const squared = at({ source: { x: meeting, y: 0 }, target: { x: meeting, y: 0 } });
    check("the stubs can be brought together -- a right angle",
        Math.abs(squared.src - meeting) < 0.001 && Math.abs(squared.tgt - meeting) < 0.001);
    const sharpSquared = routeDiagram(layout, { ...geometry, curvaturePercent: 0 },
        new Map([[ab.id, { source: { x: meeting, y: 0 }, target: { x: meeting, y: 0 } }]]))
        .bands.find(b => b.source === "A");
    check("...and it really is square, not a steep slope",
        runs(sharpSquared.path).filter(isDiagonal).length === 0 && runs(sharpSquared.path).every(isAxisAligned),
        JSON.stringify(runs(sharpSquared.path).filter(r => !isAxisAligned(r))));

    // There IS one floor, shared with Orthogonal: half the band's width plus
    // a pixel. Below it the diagonal reaches back across the node it just
    // left, and no placement makes that correct.
    const floorAt = at({ source: { x: f.band.start.x, y: 0 } }).src;
    check("a lead is floored rather than taken to zero", floorAt > f.band.start.x + 1,
        `${floorAt.toFixed(1)} vs face ${f.band.start.x.toFixed(1)}`);
    check("...leaving a real perpendicular run at the face",
        floorAt - f.band.start.x > 1, (floorAt - f.band.start.x).toFixed(1));
    check("...without breaking the path",
        vertices(at({ source: { x: f.band.start.x, y: 0 } }).band.path)
            .every(v => Number.isFinite(v.x) && Number.isFinite(v.y)));

    // Dragged behind its own node face it lands on the floor, not the face:
    // the stub has to sit on the port's OUTWARD normal, far enough out that
    // the band doesn't straddle the node.
    const behind = at({ source: { x: f.band.start.x - 400, y: 0 } });
    check("a lead dragged behind its own node face is held at the floor",
        Math.abs(behind.src - floorAt) < 0.001, `${behind.src.toFixed(1)} vs ${floorAt.toFixed(1)}`);
    check("...and the band never reaches back past the face",
        Math.min(...vertices(behind.band.path).map(v => v.x)) >= f.band.start.x - 0.001,
        `${Math.min(...vertices(behind.band.path).map(v => v.x)).toFixed(1)} vs ${f.band.start.x.toFixed(1)}`);

    // Every drop lands on itself, across the range -- the symptom the author hit was
    // two different drops resolving to the same place.
    // All above the floor: below it a drop is clamped, which is tested above.
    const drops = [-80, 60, 240, 480].map(d => {
        const drop = f.src + d;
        return { drop, landed: at({ source: { x: drop, y: 0 } }).src };
    });
    check("every drop lands where it was dropped",
        drops.every(r => Math.abs(r.landed - r.drop) < 0.001),
        drops.map(r => `${r.drop.toFixed(0)}->${r.landed.toFixed(0)}`).join(", "));
    check("...so no two drops resolve to the same place",
        new Set(drops.map(r => r.landed.toFixed(3))).size === drops.length);
    check("...and each stays finite",
        drops.every(r => vertices(at({ source: { x: r.drop, y: 0 } }).band.path)
            .every(v => Number.isFinite(v.x) && Number.isFinite(v.y))));

    // A stale middle value from another style must not reach into the
    // geometry: the bend lives in the two leads, and nothing here reads it.
    const stale = at({ source: { x: f.src + 250, y: 0 }, middle: { x: 300, y: 200 } });
    check("a stale middle value from another style changes nothing",
        Math.abs(stale.src - movedOut.src) < 0.001 && Math.abs(stale.tgt - movedOut.tgt) < 0.001,
        `${stale.src.toFixed(1)} vs ${movedOut.src.toFixed(1)}`);

    // The bend gesture, as visual.ts writes it: BOTH leads shift by the same
    // amount in opposite directions. That has to hold the angle exactly --
    // holding an angle you matched by hand is the whole point of the handle.
    const slopeOf = band => {
        const d = runs(band.path).filter(isDiagonal)[0];
        return d ? d.dy / d.dx : NaN;
    };
    const steep = { source: { x: f.src + 300, y: 0 }, target: { x: f.tgt - 120, y: 0 } };
    const before = at(steep);
    [80, -150].forEach(delta => {
        const after = at({
            source: { x: steep.source.x + delta, y: 0 },
            target: { x: steep.target.x + delta, y: 0 }
        });
        check(`sliding the bend by ${delta} moves both stubs by exactly that`,
            Math.abs((after.src - before.src) - delta) < 0.001 &&
            Math.abs((after.tgt - before.tgt) - delta) < 0.001,
            `src +${(after.src - before.src).toFixed(1)}, tgt +${(after.tgt - before.tgt).toFixed(1)}`);
        check("...and holds the angle exactly",
            Math.abs(slopeOf(after.band) - slopeOf(before.band)) < 1e-9,
            `${slopeOf(before.band).toFixed(6)} -> ${slopeOf(after.band).toFixed(6)}`);
        check("...so the bend handle itself lands where it was dropped",
            Math.abs(after.middle.point.x - (before.middle.point.x + delta)) < 0.001,
            `${before.middle.point.x.toFixed(1)} + ${delta} -> ${after.middle.point.x.toFixed(1)}`);
    });
}

// ===============================================================
// 7. Multi-type corridors stay parallel across the diagonal -- the
//    property M3 exists to protect.
// ===============================================================
{
    const stacked = [
        { source: "A", target: "B", value: 30, sourceRow: 1, targetRow: 3 },
        { source: "A", target: "B", value: 20, sourceRow: 1, targetRow: 3 }
    ];
    const withTypes = stacked.map((r, i) => ({ ...r, flowType: i === 0 ? "x" : "y" }));
    const ROLES2 = ROLES.concat("flowType");
    const dv = {
        table: {
            columns: ROLES2.map(r => ({ roles: { [r]: true } })),
            rows: withTypes.map(r => ROLES2.map(k => (k in r ? r[k] : null)))
        }
    };
    const { flows } = parseDataView(dv);
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1400, 800, CHROME);
    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 0, style: "Polyline" });

    check("both stripes of a multi-type corridor are drawn", bands.length === 2);
    const slopes = bands.map(b => {
        const diag = runs(b.path).filter(isDiagonal)[0];
        return diag ? diag.dy / diag.dx : NaN;
    });
    check("...and their diagonals are parallel",
        Number.isFinite(slopes[0]) && Math.abs(slopes[0] - slopes[1]) < 0.05, slopes.map(s => s.toFixed(3)).join(" vs "));
}

// ===============================================================
// 8. Smooth shares Polyline's handles and their freedoms.
//
// This section was Supersmooth's (Polyline with its diagonal drawn as a
// single cubic), retired with the original Smooth; the name
// Smooth now belongs to the arc-based style section 9 covers. Its curve and
// 14-of-16 assertions are section 9's for the arcs; what carries over is that
// the curved style offers Polyline's handles, with Polyline's freedoms.
// ===============================================================
{
    const { routeDiagram } = require("./routing-api.js");
    const { flows } = parseDataView(dataViewOf(OFFSET));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, 1400, 800, CHROME);
    const ab = corridors.find(c => c.source === "A" && c.target === "B");
    const go = (style, ov) => routeDiagram(layout, { portLeadInPercent: 18, curvaturePercent: 35, style },
        ov ? new Map([[ab.id, ov]]) : new Map());

    const poly = go("Polyline").bands.find(b => b.source === "A");
    const smooth = go("Smooth").bands.find(b => b.source === "A");
    check("Smooth starts and ends at the same anchors as Polyline",
        Math.abs(poly.start.x - smooth.start.x) < 0.001 && Math.abs(poly.end.y - smooth.end.y) < 0.001);

    const h = go("Smooth").handles.get(ab.id);
    check("it offers the same three handles as Polyline",
        h.source !== undefined && h.target !== undefined && h.middle !== undefined,
        Object.keys(h).join("+"));
    check("...with the bend handle on the run between the stubs, as a gesture",
        Math.abs(h.middle.point.x - (h.source.point.x + h.target.point.x) / 2) < 0.001 && h.middle.gesture === true);
    check("...and the leads free and independent",
        (() => {
            const moved = go("Smooth", { source: { x: h.source.point.x + 200, y: 0 } }).handles.get(ab.id);
            return Math.abs(moved.source.point.x - (h.source.point.x + 200)) < 0.001 &&
                Math.abs(moved.target.point.x - h.target.point.x) < 0.001;
        })());
}

// ===============================================================
// 9. Biarc: the middle run is two circular arcs, so its radius is a
//    property that can be read rather than one that falls out of
//    where the stubs happen to sit -- and it cannot collapse below
//    the band's own width the way a single cubic's does.
// ===============================================================
{
    const { routeDiagram } = require("./routing-api.js");
    const nd = (id, x, y, w, h) => ({ id, label: id, x, y, width: w, height: h, inflow: 0, outflow: 0, isSelfLoop: false });
    const a = nd("Grid", 100, 300, 14, 110), b = nd("DH", 1000, 700, 14, 110);
    const c = {
        id: "G->D", source: "Grid", target: "DH", value: 110, isSelfLoop: false, flows: [],
        segments: [{ flowType: undefined, value: 110, flows: [] }], sourcePort: "East", targetPort: "West"
    };
    const layout = {
        nodes: new Map([["Grid", a], ["DH", b]]), corridors: [c],
        valueToPixels: v => Math.max(4, v), columnGap: 400, rowPitch: 250
    };
    const face = a.x + a.width;
    const band = (style, lead) => routeDiagram(layout, { portLeadInPercent: 20, curvaturePercent: 35, style },
        new Map([[c.id, { source: { x: face + lead, y: 0 }, target: { x: b.x - lead, y: 0 } }]])).bands[0];
    const pts = d => {
        const out = [];
        let cur = null;
        for (const seg of [...d.matchAll(/([MLC])([^MLCZ]*)/g)]) {
            const v = seg[2].trim().split(/[\s,]+/).filter(x => x).map(Number);
            if (seg[1] === "M" || seg[1] === "L") { cur = { x: v[0], y: v[1] }; out.push(cur); }
            else {
                const p0 = cur, p1 = { x: v[0], y: v[1] }, p2 = { x: v[2], y: v[3] }, p3 = { x: v[4], y: v[5] };
                for (let i = 1; i <= 14; i++) {
                    const t = i / 14, u = 1 - t;
                    out.push({
                        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
                        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
                    });
                }
                cur = p3;
            }
        }
        return out;
    };
    const narrowest = d => {
        const P = pts(d), half = Math.floor(P.length / 2);
        const A = P.slice(3, half - 3), Bh = P.slice(half + 3, P.length - 3);
        let m = Infinity;
        for (const x of A) { for (const y of Bh) { m = Math.min(m, Math.hypot(x.x - y.x, x.y - y.y)); } }
        return m;
    };

    // Curvature now sizes the arcs (it sets how much of the chord stays
    // straight), so the width claims below belong at the top of the slider,
    // where the join is all arc. At the bottom the arcs are small and turn
    // tightly, and a fat band pinches -- the trade-off in the author's definition.
    const wide = (style, lead, curvaturePercent = 100) => routeDiagram(layout,
        { portLeadInPercent: 20, curvaturePercent, style },
        new Map([[c.id, { source: { x: face + lead, y: 0 }, target: { x: b.x - lead, y: 0 } }]])).bands[0];
    // (Measured against the retired Supersmooth when this was written: the
    // cubic pinched this band to 74.7px of its 110.)
    check("a Smooth band keeps nearly its full width at long leads",
        narrowest(wide("Smooth", 400).path) > 100, narrowest(wide("Smooth", 400).path).toFixed(1));
    [60, 200, 400].forEach(lead => {
        check(`...and holds it at ${lead}px leads`, narrowest(wide("Smooth", lead).path) > 100);
    });
    // This used to record a COST: at the bottom of the slider the band came out
    // pinched. That pinch was the spline fit, not the geometry -- plain
    // Catmull-Rom arms overshot where the long lead met the short arc steps,
    // and the edge cut across the band. With the arms capped the
    // edges are exact offsets of one centreline, so the band keeps its width
    // at low curvature too. Asserted at both ends so the pinch cannot return.
    [25, 100].forEach(curvature => {
        const w = narrowest(wide("Smooth", 400, curvature).path);
        check(`a fat Smooth band keeps its full width at curvature ${curvature}`, w > 109, w.toFixed(1));
    });
    check("every coordinate stays finite",
        pts(band("Smooth", 400).path).every(q => Number.isFinite(q.x) && Number.isFinite(q.y)));

    // Like the other two, it is Polyline everywhere but the same-axis middle.
    const ports = ["North", "South", "East", "West"];
    let identical = 0;
    ports.forEach(sp => ports.forEach(tp => {
        const c2 = {
            id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp
        };
        const na = nd("A", 100, 300, 14, 40), nb = nd("B", 700, 480, 14, 40);
        const l2 = {
            nodes: new Map([["A", na], ["B", nb]]), corridors: [c2],
            valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        };
        const path = style => routeDiagram(l2, { portLeadInPercent: 20, curvaturePercent: 35, style }).bands[0].path;
        if (path("Polyline") === path("Smooth")) { identical++; }
    }));
    // The rule since 90-degree turns joined in: Biarc differs from Polyline on
    // every DIRECT pairing and matches it on every WRAP. A wrap's waypoints are
    // what carry it round the outside of a node, and a biarc knows nothing
    // about that -- measured, a 90-degree self-loop's arcs sweep back through
    // the node and a 180-degree one has no positive tangent length at all.
    const { routeWraps, anchorKey, computeAnchors } = require("./routing-api.js");
    let wrapsMatched = 0, wrapsSeen = 0, directDiffered = 0, directSeen = 0;
    ports.forEach(sp => ports.forEach(tp => {
        const c2 = {
            id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp
        };
        const na = nd("A", 100, 300, 14, 40), nb = nd("B", 700, 480, 14, 40);
        const l2 = {
            nodes: new Map([["A", na], ["B", nb]]), corridors: [c2],
            valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        };
        const anchors = computeAnchors(l2);
        const wrap = routeWraps(anchors.get(anchorKey(c2.id, "source")), anchors.get(anchorKey(c2.id, "target")));
        const path = style => routeDiagram(l2, { portLeadInPercent: 20, curvaturePercent: 35, style }).bands[0].path;
        const same = path("Polyline") === path("Smooth");
        if (wrap) { wrapsSeen++; if (same) { wrapsMatched++; } }
        else { directSeen++; if (!same) { directDiffered++; } }
    }));
    check("Biarc draws arcs on every DIRECT pairing", directDiffered === directSeen,
        `${directDiffered}/${directSeen}`);
    check("...and leaves every WRAP to Polyline's chain", wrapsMatched === wrapsSeen,
        `${wrapsMatched}/${wrapsSeen}`);

    // Biarc IS Polyline with the join replaced, so where there is no run left
    // to bend it doesn't switch to something else -- it just is Polyline. An
    // earlier version dropped to a cubic there and started looking like
    // Supersmooth; a later one put a straight segment through the
    // smooth path instead, which pinched the ribbon to 10px of its 110.
    const same = (x, y, lead) => band(x, lead).path === band(y, lead).path;
    // With the leads dragged right out the stubs meet ACROSS the route but
    // are still far apart along it, so the join keeps its room and its arcs.
    // What guards the ribbon there is the radius test, not a switch back.
    // Curvature sets how much of the join stays straight, so whether a route
    // gets arcs at all depends on it -- and on whether those arcs would be
    // wider than the ribbon. At the top of the slider they always fit.
    check("at full curvature a join with room keeps its arcs",
        wide("Smooth", 600, 100).path !== band("Polyline", 600).path);
    check("...and the ribbon never goes below the band's half-width",
        narrowest(wide("Smooth", 600, 25).path) >= 55,
        narrowest(wide("Smooth", 600, 25).path).toFixed(1));
    // Curvature 0 leaves the whole chord straight, so the join IS the diagonal
    // -- Polyline's shape, with the knees sharp rather than rounded.
    const bow = (style, curvaturePercent) => {
        const r = routeDiagram(layout, { portLeadInPercent: 20, curvaturePercent, style },
            new Map([[c.id, { source: { x: face + 200, y: 0 }, target: { x: b.x - 200, y: 0 } }]]));
        const h2 = r.handles.get(c.id);
        const span = Math.hypot(h2.target.point.x - h2.source.point.x, h2.target.point.y - h2.source.point.y);
        const ux = (h2.target.point.x - h2.source.point.x) / span, uy = (h2.target.point.y - h2.source.point.y) / span;
        const P = pts(r.bands[0].path).filter(q => {
            const t = (q.x - h2.source.point.x) * ux + (q.y - h2.source.point.y) * uy;
            return t > 5 && t < span - 5;
        });
        return Math.max(...P.map(q => Math.abs((q.x - h2.source.point.x) * uy - (q.y - h2.source.point.y) * ux)));
    };
    // The slider is remapped onto the useful part of its range, so 0 is the
    // roundest-but-one rather than straight -- a straight diagonal is what
    // Polyline is for. Every position still gives a distinct shape.
    check("every slider position bows the join",
        bow("Smooth", 0) > 0 && bow("Smooth", 100) > bow("Smooth", 0),
        `${bow("Smooth", 0).toFixed(1)} -> ${bow("Smooth", 100).toFixed(1)}`);
    check("...rising monotonically across the slider",
        [0, 25, 50, 75, 100].every((cv, i, all) => i === 0 || bow("Smooth", cv) > bow("Smooth", all[i - 1])),
        [0, 25, 50, 75, 100].map(cv => bow("Smooth", cv).toFixed(0)).join(" -> "));
    check("...rising with the setting in between",
        bow("Smooth", 25) < bow("Smooth", 50) && bow("Smooth", 50) < bow("Smooth", 75),
        [0, 25, 50, 75, 100].map(cv => bow("Smooth", cv).toFixed(0)).join(" -> "));
    check("...and a route with room is not Polyline's",
        wide("Smooth", 200, 100).path !== band("Polyline", 200).path);
    check("the ribbon holds its width right up to that point",
        [60, 200, 400, 442, 443].every(l => narrowest(wide("Smooth", l).path) > 100),
        [60, 200, 400, 442, 443].map(l => narrowest(wide("Smooth", l).path).toFixed(0)).join(", "));

    // And where there are no arcs to draw -- the stubs having met -- it
    // degrades into Polyline rather than into a cubic. Falling back to the
    // cubic is what made it "switch and look like Supersmooth".
    // A join SHORTER than the band is thick has no room to bend at all, and
    // Polyline's straight build holds it where arcs would pinch it.
    // Curvature 0 leaves the whole chord straight, so there are no arcs and
    // the join is Polyline's own. The arcs then appear as the setting rises,
    // sooner on a thin band than a fat one, since the guard is the ribbon's
    // own half-width.
    const arcsAt = cv => wide("Smooth", 200, cv).path !== routeDiagram(layout,
        { portLeadInPercent: 20, curvaturePercent: cv, style: "Polyline" },
        new Map([[c.id, { source: { x: face + 200, y: 0 }, target: { x: b.x - 200, y: 0 } }]])).bands[0].path;
    // With the slider remapped, and an arc allowed to sweep most of the way
    // round, every position draws arcs -- the fallbacks left are structural
    // (a wrap, or a join shorter than the band is thick), not the setting.
    check("every slider position draws arcs",
        [0, 10, 25, 35, 50, 75, 100].every(arcsAt),
        [0, 10, 25, 35, 50, 75, 100].map(cv => (arcsAt(cv) ? "arc" : "no")).join(" "));
    check("...while a route with room is not Polyline's",
        wide("Smooth", 200, 100).path !== band("Polyline", 200).path);
}

// ===============================================================
// 10. Self-loops keep the chain, and that was measured rather than
//     assumed.
// ===============================================================
{
    const { routeDiagram } = require("./routing-api.js");
    const nd2 = (id, x, y, w, h) => ({ id, label: id, x, y, width: w, height: h, inflow: 0, outflow: 0, isSelfLoop: false });
    const node = nd2("N", 400, 300, 14, 60);
    const loop = (sp, tp) => {
        const c = {
            id: "N->N", source: "N", target: "N", value: 30, isSelfLoop: true, flows: [],
            segments: [{ flowType: undefined, value: 30, flows: [] }], sourcePort: sp, targetPort: tp
        };
        const l = {
            nodes: new Map([["N", node]]), corridors: [c],
            valueToPixels: v => Math.max(4, v), columnGap: 200, rowPitch: 150
        };
        const path = style => routeDiagram(l, { portLeadInPercent: 20, curvaturePercent: 35, style }).bands[0].path;
        return { biarc: path("Smooth"), polyline: path("Polyline") };
    };
    [["East", "West"], ["East", "North"], ["East", "South"], ["North", "South"]].forEach(([sp, tp]) => {
        const r = loop(sp, tp);
        check(`a ${sp}->${tp} self-loop keeps Polyline's chain under Biarc`, r.biarc === r.polyline);
        check("...and stays finite", !/NaN|Infinity/.test(r.biarc));
    });
}

if (failures === 0) {
    console.log("\nALL POLYLINE CHECKS PASSED");
} else {
    console.log(`\n${failures} POLYLINE CHECK(S) FAILED`);
    process.exit(1);
}
