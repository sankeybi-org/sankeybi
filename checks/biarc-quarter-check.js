"use strict";
/**
 * Biarc's 90-degree join is ONE quarter circle, and its two handles move
 * together to keep it that way .
 *
 * A single arc is tangent to both ports only when the two stubs sit the same
 * distance from the corner where the port rays cross, so that equality is the
 * property everything here is built on.
 *
 * **On measuring the drawn band rather than the tangent lengths.** A
 * perpendicular pairing joins a port that packs along its node's WIDTH to one
 * that packs along its HEIGHT, so the two anchors are generally different
 * widths and the band tapers between them -- its two edges are then arcs of
 * two different radii by construction, and comparing them to each other says
 * nothing about whether the join is circular. So the shape of the drawn band
 * is asserted on square nodes, where both ports pack to the same width and the
 * edges really are concentric; everything else is asserted everywhere.
 */
const R = require("./routing-api.js");

const NORM = {
    North: { x: 0, y: -1 }, South: { x: 0, y: 1 },
    East: { x: 1, y: 0 }, West: { x: -1, y: 0 }
};
let failures = 0;
function check(name, ok, detail) {
    if (!ok) {
        failures++;
        console.log("  FAIL " + name + (detail ? "  " + detail : ""));
    }
}

function node(id, x, y, w, h) {
    return { id, label: id, x, y, width: w, height: h, inflow: 0, outflow: 0, isSelfLoop: false };
}

/** Sample a path's real curve -- control points do not lie on it. */
function samplePath(d, per) {
    const pts = [];
    let cur = null;
    const re = /([MLCZ])([^MLCZ]*)/g;
    let m;
    while ((m = re.exec(d))) {
        const nums = (m[2].match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
        if (m[1] === "M") {
            cur = { x: nums[0], y: nums[1] };
            pts.push(cur);
        } else if (m[1] === "L") {
            for (let i = 0; i + 1 < nums.length; i += 2) {
                const p = { x: nums[i], y: nums[i + 1] };
                for (let k = 1; k <= per; k++) {
                    pts.push({
                        x: cur.x + (p.x - cur.x) * k / per,
                        y: cur.y + (p.y - cur.y) * k / per
                    });
                }
                cur = p;
            }
        } else if (m[1] === "C") {
            for (let i = 0; i + 5 < nums.length; i += 6) {
                const p0 = cur;
                const p1 = { x: nums[i], y: nums[i + 1] };
                const p2 = { x: nums[i + 2], y: nums[i + 3] };
                const p3 = { x: nums[i + 4], y: nums[i + 5] };
                for (let k = 1; k <= per; k++) {
                    const t = k / per, u = 1 - t;
                    pts.push({
                        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
                        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
                    });
                }
                cur = p3;
            }
        }
    }
    return pts;
}

const PAIRS = [
    ["North", "West"], ["North", "East"], ["South", "West"], ["South", "East"],
    ["East", "South"], ["East", "North"], ["West", "South"], ["West", "North"]
];
const OPTIONS = { portLeadInPercent: 20, curvaturePercent: 100, style: "Smooth" };
const DRAGS = [0, 40, 120, 260, 480, 900];

/** Every perpendicular pairing, across three layouts and two band widths. */
function scenarios() {
    const out = [];
    const layouts = [
        ["far", node("A", 100, 400, 14, 40), node("B", 700, 150, 14, 90), false],
        ["near", node("A", 120, 200, 14, 60), node("B", 560, 520, 14, 60), false],
        // Square nodes: both faces pack to the same width, so the band keeps
        // one width and its edges are concentric with the join's arc.
        ["square", node("A", 120, 200, 80, 80), node("B", 560, 520, 80, 80), true]
    ];
    layouts.forEach(([lname, a, b, square]) => {
        PAIRS.forEach(([sp, tp]) => {
            [40, 200].forEach(value => {
                const corridor = {
                    id: "A->B", source: "A", target: "B", value, isSelfLoop: false, flows: [],
                    segments: [{ flowType: undefined, value, flows: [] }],
                    sourcePort: sp, targetPort: tp
                };
                out.push({
                    name: lname + " " + sp + "->" + tp + " v" + value,
                    sp, tp, square,
                    layout: {
                        nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
                        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
                    }
                });
            });
        });
    });
    return out;
}

let coupled = 0, declined = 0, arcsMeasured = 0;
scenarios().forEach(scenario => {
    const base = R.routeDiagram(scenario.layout, OPTIONS);
    const handles = base.handles.get("A->B");
    if (!handles || !handles.source || !handles.target) {
        return;
    }
    const band0 = base.bands[0];
    const nOut = NORM[scenario.sp], nIn = NORM[scenario.tp];
    const corner = nOut.x !== 0
        ? { x: band0.end.x, y: band0.start.y }
        : { x: band0.start.x, y: band0.end.y };
    const reachOut = (corner.x - band0.start.x) * nOut.x + (corner.y - band0.start.y) * nOut.y;
    const reachIn = (corner.x - band0.end.x) * nIn.x + (corner.y - band0.end.y) * nIn.y;
    // Behind either port there is no quarter circle to make, and the route is
    // deliberately left exactly as it was.
    if (!(reachOut > 0 && reachIn > 0)) {
        declined++;
        return;
    }
    coupled++;

    const travel = [];
    DRAGS.forEach(extra => {
        const from = handles.source.point;
        const dragged = { x: from.x + nOut.x * extra, y: from.y + nOut.y * extra };
        const routed = R.routeDiagram(scenario.layout, OPTIONS, new Map([["A->B", { source: dragged }]]));
        const h = routed.handles.get("A->B");
        const band = routed.bands[0];
        const leadOut = (h.source.point.x - band.start.x) * nOut.x
            + (h.source.point.y - band.start.y) * nOut.y;
        const leadIn = (h.target.point.x - band.end.x) * nIn.x
            + (h.target.point.y - band.end.y) * nIn.y;
        const tanOut = reachOut - leadOut;
        const tanIn = reachIn - leadIn;
        const label = scenario.name + " drag+" + extra;
        travel.push({ extra, leadOut, leadIn });

        // The coupling itself: both stubs the same distance from the corner,
        // which is exactly the condition for one arc to be tangent to both.
        check(label + " tangents equal", Math.abs(tanOut - tanIn) < 0.02,
            tanOut.toFixed(2) + " vs " + tanIn.toFixed(2));
        // Neither stub runs past the corner.
        check(label + " leads in range",
            leadOut >= -0.01 && leadOut <= reachOut + 0.01
            && leadIn >= -0.01 && leadIn <= reachIn + 0.01,
            leadOut.toFixed(1) + "/" + leadIn.toFixed(1));

        // The centre sits a tangent length back along BOTH rays: back along
        // the source's normal puts it level with the source stub, back along
        // the target's puts it level with the target stub.
        const centre = {
            x: corner.x - (nOut.x + nIn.x) * tanOut,
            y: corner.y - (nOut.y + nIn.y) * tanOut
        };
        const inJoin = samplePath(band.path, 16).filter(p => {
            const u = (p.x - band.start.x) * nOut.x + (p.y - band.start.y) * nOut.y;
            const v = (p.x - band.end.x) * nIn.x + (p.y - band.end.y) * nIn.y;
            return u > leadOut + 2 && v > leadIn + 2;
        });
        if (inJoin.length < 8 || tanOut <= 2) {
            return;
        }
        const offsets = inJoin.map(p => Math.hypot(p.x - centre.x, p.y - centre.y) - tanOut);
        const inner = Math.min.apply(null, offsets);
        const outer = Math.max.apply(null, offsets);

        // Whatever the taper does, no part of the ribbon may reach the arc's
        // centre: crossing it is the inner edge turning inside out.
        check(label + " inner edge not inverted", tanOut + inner > 0,
            "radius " + tanOut.toFixed(1) + ", inner edge at " + (tanOut + inner).toFixed(2));

        if (!scenario.square) {
            return;
        }
        // The band's half-width, read off the outline's first point, which
        // sits square across the source anchor. Reliable on this layout
        // precisely because there is no taper.
        const first = samplePath(band.path, 1)[0];
        const half = Math.hypot(first.x - band.start.x, first.y - band.start.y);
        // Dragged right out, the radius floors just above the half-width and
        // the inner edge shrinks to a nub at the corner -- tight, but the
        // ribbon is intact, which the inversion check above is what pins.
        // The shape of the arc is asserted where it has room to be one.
        if (tanOut <= 1.5 * half) {
            return;
        }
        arcsMeasured++;
        // No taper here, so both edges are circles about the join's centre and
        // sit a half-width either side of it -- the quarter circle and the
        // band's evenness across it, measured together. The tolerance scales
        // with the band because what is being caught is a warped join, not the
        // last percent of a spline fit.
        check(label + " join is one circular arc",
            Math.abs(inner + outer) < Math.max(1.5, 0.06 * half),
            "inner " + inner.toFixed(2) + " outer " + outer.toFixed(2)
            + " radius " + tanOut.toFixed(2) + " half " + half.toFixed(2));
    });

    // The leads are HIDDEN on this corner and its radius comes
    // from Curvature or the corner handle, so a stale drag of
    // either lead -- from the earlier coupled handles -- changes nothing.
    // (This loop used to pin that coupling: drag one, both move.)
    for (let i = 1; i < travel.length; i++) {
        const dOut = travel[i].leadOut - travel[i - 1].leadOut;
        const dIn = travel[i].leadIn - travel[i - 1].leadIn;
        check(scenario.name + " a stale lead drag to +" + travel[i].extra + " moves nothing",
            Math.abs(dOut) < 0.01 && Math.abs(dIn) < 0.01,
            "source moved " + dOut.toFixed(2) + ", target moved " + dIn.toFixed(2));
    }
});

// A same-axis Biarc route must be untouched by any of this.
(() => {
    const a = node("A", 100, 400, 14, 40), b = node("B", 900, 700, 14, 40);
    const corridor = {
        id: "A->B", source: "A", target: "B", value: 110, isSelfLoop: false, flows: [],
        segments: [{ flowType: undefined, value: 110, flows: [] }],
        sourcePort: "East", targetPort: "West"
    };
    const layout = {
        nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
    [0, 40, 100, 300].forEach(lead => {
        const routed = R.routeDiagram(layout,
            { portLeadInPercent: lead, curvaturePercent: 100, style: "Smooth" });
        check("same-axis untouched at lead " + lead,
            routed.bands[0].path.length > 0 && /C/.test(routed.bands[0].path));
    });
})();

// --- The corner handle -----------------------------------------
// the same interaction as the self-loops. A direct 90-degree corner has
// one real parameter -- its runs lie on the port rays, which the nodes fix --
// so it is shaped by one corner handle on its arc, and the two lead handles
// (which were carrying that one number twice) are hidden for display.
let cornerShapes = 0, cornerDrags = 0;
scenarios().forEach(scenario => {
    const base = R.routeDiagram(scenario.layout, OPTIONS);
    const handles = base.handles.get("A->B");
    if (!handles || !handles.source || !handles.target) {
        return;
    }
    const band0 = base.bands[0];
    const nOut = NORM[scenario.sp], nIn = NORM[scenario.tp];
    const corner = nOut.x !== 0 ? { x: band0.end.x, y: band0.start.y } : { x: band0.start.x, y: band0.end.y };
    const reachOut = (corner.x - band0.start.x) * nOut.x + (corner.y - band0.start.y) * nOut.y;
    const reachIn = (corner.x - band0.end.x) * nIn.x + (corner.y - band0.end.y) * nIn.y;
    const quarter = reachOut > 0 && reachIn > 0;
    // a Smooth WRAP carries one too -- the question mark and
    // the C loop, which had no way to set their roundness short of the
    // Curvature slider. Asked of routing's own `wrap` marker rather than
    // re-derived here, so the two cannot drift. Still a biconditional: a
    // Smooth route that is neither must have NO corner handle.
    const wrapping = handles.wrap === true;
    check(scenario.name + ": a corner handle exactly where the quarter circle applies, or it wraps",
        (handles.corner !== undefined) === (quarter || wrapping),
        "corner handle " + (handles.corner ? "present" : "absent")
        + ", quarter case " + quarter + ", wraps " + wrapping);
    if (!quarter || !handles.corner) {
        return;
    }
    cornerShapes++;
    const k0 = handles.corner;
    const tangentsOf = h => ({
        out: reachOut - ((h.source.point.x - band0.start.x) * nOut.x + (h.source.point.y - band0.start.y) * nOut.y),
        in: reachIn - ((h.target.point.x - band0.end.x) * nIn.x + (h.target.point.y - band0.end.y) * nIn.y)
    });

    // Untouched, the handle reports the arc the leads actually make.
    const t0 = tangentsOf(handles);
    check(scenario.name + ": untouched, the handle's radius is the drawn arc's",
        Math.abs(k0.radius - t0.out) < 0.02 && Math.abs(k0.radius - t0.in) < 0.02,
        "handle " + k0.radius.toFixed(2) + ", tangents " + t0.out.toFixed(2) + "/" + t0.in.toFixed(2));
    check(scenario.name + ": it stands in for the leads", k0.replacesLeads === true);

    // Shown: no lead handles, the corner handle kept. Routing's own handles
    // keep both leads -- avoidance reads their stubs.
    const shown = R.draggableHandles(base.handles, "Smooth").get("A->B");
    check(scenario.name + ": lead handles hidden, corner shown",
        !shown.source && !shown.target && shown.corner !== undefined);

    [10, 40, 120, 400, 5000].forEach(asked => {
        const routed = R.routeDiagram(scenario.layout, OPTIONS,
            new Map([["A->B", { radius: asked / k0.pitch }]]));
        const h = routed.handles.get("A->B");
        const k = h.corner;
        const t = tangentsOf(h);
        const expected = Math.max(k.minRadius, Math.min(asked, k.maxRadius));
        const label = scenario.name + " with the corner at " + asked + "px";
        cornerDrags++;
        check(label + ": the arc takes it, between the floor and the nodes",
            Math.abs(k.radius - expected) < 0.02,
            k.radius.toFixed(2) + " against " + expected.toFixed(2));
        check(label + ": still ONE quarter circle (tangents equal)",
            Math.abs(t.out - t.in) < 0.02 && Math.abs(t.out - k.radius) < 0.02,
            t.out.toFixed(2) + "/" + t.in.toFixed(2) + " against " + k.radius.toFixed(2));
        const on = { x: k.apex.x + k.direction.x * k.radius * k.spread, y: k.apex.y + k.direction.y * k.radius * k.spread };
        check(label + ": the handle sits on the arc's midpoint",
            Math.hypot(on.x - k.point.x, on.y - k.point.y) < 0.01);
    });

    // Untouched, the corner follows the Curvature slider --
    // which a stale lead from the old coupled handles no longer overrides.
    const stale = { source: { x: band0.start.x + nOut.x * 30, y: band0.start.y + nOut.y * 30 } };
    check(scenario.name + ": a stale lead drag no longer shapes the corner",
        R.routeDiagram(scenario.layout, OPTIONS, new Map([["A->B", stale]])).bands[0].path === base.bands[0].path);
    const beaten = R.routeDiagram(scenario.layout, OPTIONS,
        new Map([["A->B", Object.assign({ radius: 60 / k0.pitch }, stale)]])).handles.get("A->B");
    check(scenario.name + ": a set radius beats stale leads",
        Math.abs(beaten.corner.radius - Math.max(beaten.corner.minRadius, Math.min(60, beaten.corner.maxRadius))) < 0.02);
});
check("the corner-handle assertions actually ran", cornerShapes >= 8 && cornerDrags >= 40,
    cornerShapes + " shapes, " + cornerDrags + " drags");

// --- Curvature drives the corner, and it is ONE arc at every setting ---------
// the corner should follow the Curvature slider like every
// other route. It used to be a true quarter circle only at 100; below that the
// join put a straight between two smaller arcs and the corner handle sat up to
// 16px off the band's centre. Measured on square nodes, where the band keeps
// one width, so "on the centre line" means exactly a half-width from the edge.
let sweepRan = 0;
scenarios().filter(sc => sc.square).forEach(scenario => {
    [0, 20, 35, 70, 100].forEach(curvature => {
        const opt = { portLeadInPercent: 20, curvaturePercent: curvature, style: "Smooth" };
        const routed = R.routeDiagram(scenario.layout, opt);
        const built = routed.handles.get("A->B");
        const k = built.corner;
        // A Smooth WRAP has a corner handle too, but its
        // radius follows the SQUARED rule -- `geometry.radius`, genuinely
        // sharp at Curvature 0 -- not the quarter circle's. Measured here it
        // reads as a failure of a rule it was never under (0 against a 101px
        // floor at Curvature 0). Its own radius is asserted in
        // port-routing-check 10; this sweep stays on its subject.
        if (!k || built.wrap) {
            return;
        }
        sweepRan++;
        const band = routed.bands[0];
        const first = samplePath(band.path, 1)[0];
        const half = Math.hypot(first.x - band.start.x, first.y - band.start.y);
        const label = scenario.name + " at Curvature " + curvature;
        // The slider's radius -- the same pitch-relative one a squared corner
        // takes -- clamped to what this corner can hold.
        const asked = (curvature / 100) * k.pitch;
        const expected = Math.max(k.minRadius, Math.min(Math.max(asked, k.minRadius), k.maxRadius));
        check(label + ": untouched, the radius follows the slider",
            Math.abs(k.radius - expected) < 0.02, k.radius.toFixed(2) + " against " + expected.toFixed(2));
        // Measured against the OUTER edge. At the tightest radius -- the
        // band's half-width plus a pixel -- the inner edge shrinks to a 1px
        // curl that the fitted outline cuts across, so the nearest point
        // overall says nothing; the outer edge stays a clean arc a half-width
        // beyond the centre line at every radius. The arc's centre sits one
        // radius further along the handle's own diagonal.
        const centre = { x: k.point.x + k.direction.x * k.radius, y: k.point.y + k.direction.y * k.radius };
        const outer = samplePath(band.path, 24)
            .filter(q => Math.hypot(q.x - centre.x, q.y - centre.y) > k.radius);
        const nearest = outer.map(q => Math.hypot(q.x - k.point.x, q.y - k.point.y)).sort((x, y) => x - y)[0];
        check(label + ": the corner handle sits on the band's centre line",
            Math.abs(nearest - half) < 1, "outer edge " + nearest.toFixed(2) + "px away, half-width " + half.toFixed(2));
    });
    // The slider moving changes the corner -- the whole point.
    const at = cv => R.routeDiagram(scenario.layout,
        { portLeadInPercent: 20, curvaturePercent: cv, style: "Smooth" }).handles.get("A->B").corner;
    if (at(20) && at(70)) {
        check(scenario.name + ": moving the slider moves the corner", at(70).radius > at(20).radius + 1,
            at(20).radius.toFixed(1) + " -> " + at(70).radius.toFixed(1));
    }
});
check("the Curvature sweep actually ran", sweepRan >= 10, "ran " + sweepRan + " times");
// Only the quarter-circle case: an ordinary same-axis Biarc corridor has none.
(() => {
    const a = node("A", 100, 400, 14, 40), b = node("B", 900, 700, 14, 40);
    const corridor = {
        id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
        segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "West"
    };
    const h = R.routeDiagram({
        nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    }, OPTIONS).handles.get("A->B");
    check("no corner handle on a same-axis corridor", !h.corner);
    const shown = R.draggableHandles(new Map([["A->B", h]]), "Smooth").get("A->B");
    check("a same-axis corridor keeps its lead handles", shown.source !== undefined && shown.target !== undefined);
})();

console.log((failures === 0 ? "PASS" : "FAIL") + " biarc-quarter-check: "
    + coupled + " coupled shapes, " + declined + " declined (corner behind a port), "
    + arcsMeasured + " arcs measured on square nodes, "
    + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
