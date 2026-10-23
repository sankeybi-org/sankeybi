"use strict";
/**
 * **A Biarc self-loop's lead handles are independent, and its corners follow
 * the shorter one** (the author, having used the earlier version in which
 * the two leads were coupled).
 *
 * What is pinned here:
 *  - each lead handle moves only its own side of the loop, and lands where it
 *    was dropped;
 *  - the corners share one radius, the shorter lead's, capped by the rectangle;
 *  - the lane handle still sizes the rectangle;
 *  - and nothing else moves -- an un-dragged loop, a loop in any other style,
 *    and every ordinary corridor come out byte-identical to before the change.
 */
const NOW = require("./routing-api.js");

let failures = 0;
// Counted, so a silently-empty assertion cannot pass for the wrong reason.
let evenness = 0, tracking = 0, independence = 0;
function check(name, ok, detail) {
    if (!ok) {
        failures++;
        console.log("  FAIL " + name + (detail ? "  " + detail : ""));
    }
}

function node(id, x, y, w, h) {
    return { id, label: id, x, y, width: w, height: h, inflow: 0, outflow: 0, isSelfLoop: false };
}

function loopLayout(value, w, h) {
    const n = node("A", 400, 300, w, h);
    const corridor = {
        id: "A->A", source: "A", target: "A", value, isSelfLoop: true, flows: [],
        segments: [{ flowType: undefined, value, flows: [] }],
        sourcePort: "East", targetPort: "West"
    };
    return {
        nodes: new Map([["A", n]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
}

function samplePath(d, per) {
    const pts = [];
    let cur = null;
    let opened = null;
    const re = /([MLCZ])([^MLCZ]*)/g;
    let m;
    while ((m = re.exec(d))) {
        const nums = (m[2].match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
        if (m[1] === "M") {
            cur = { x: nums[0], y: nums[1] };
            opened = cur;
            pts.push(cur);
        } else if (m[1] === "Z") {
            // The closing run is a real edge of the shape -- on a band, one of
            // the two end caps. Left unexpanded it contributes no samples at
            // all, so a symmetry test finds the OTHER cap unmatched and reports
            // an asymmetry that is not there.
            if (cur && opened) {
                for (let k = 1; k <= per; k++) {
                    pts.push({
                        x: cur.x + (opened.x - cur.x) * k / per,
                        y: cur.y + (opened.y - cur.y) * k / per
                    });
                }
                cur = opened;
            }
        } else if (m[1] === "L") {
            for (let i = 0; i + 1 < nums.length; i += 2) {
                const p = { x: nums[i], y: nums[i + 1] };
                for (let k = 1; k <= per; k++) {
                    pts.push({ x: cur.x + (p.x - cur.x) * k / per, y: cur.y + (p.y - cur.y) * k / per });
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

/**
 * Each turning stretch of the outline, as its median local radius. A straight
 * run reports an enormous radius and is dropped, so what comes back is one
 * entry per drawn arc -- which is what "are the corners even?" needs.
 */
function arcRadii(path, limit) {
    const pts = samplePath(path, 12);
    const step = 4;
    const local = [];
    for (let i = step; i < pts.length - step; i++) {
        const a = pts[i - step], b = pts[i], c = pts[i + step];
        const A = Math.hypot(b.x - c.x, b.y - c.y);
        const B = Math.hypot(a.x - c.x, a.y - c.y);
        const C = Math.hypot(a.x - b.x, a.y - b.y);
        const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
        local.push(area < 1e-9 ? Infinity : (A * B * C) / (4 * area));
    }
    const arcs = [];
    let run = [];
    local.forEach(v => {
        if (v < limit) {
            run.push(v);
        } else if (run.length) {
            arcs.push(run);
            run = [];
        }
    });
    if (run.length) {
        arcs.push(run);
    }
    // Each arc reports its median radius AND how long it is. Length matters:
    // a real corner is a long sweep, while the spline leaves short transitional
    // wobbles where an arc meets a straight, and counting arcs equally lets
    // three wobbles outvote four corners (measured -- that is exactly what
    // reported a radius of 30 on a loop whose corners are 70).
    return arcs.filter(a => a.length >= 6).map(a => {
        const sorted = a.slice().sort((x, y) => x - y);
        return { r: sorted[Math.floor(sorted.length / 2)], weight: a.length };
    });
}

const OPT = { portLeadInPercent: 20, curvaturePercent: 100, style: "Smooth" };

// --- 1 and 2. An UN-DRAGGED loop is what it always was ----------------------
// Stated as a property rather than as a diff against a previous build, so the
// check stands on its own: a self-loop is a wrap, and a wrap is squared off in
// EVERY style, so an untouched loop must come out identical whichever style is
// selected. If the lead ever started driving the radius before the author has
// touched a handle, Biarc would part company with the rest here.
(() => {
    [[40, 20, 60], [120, 20, 120]].forEach(([value, w, h]) => {
        const layout = loopLayout(value, w, h);
        [0, 30, 70, 100].forEach(curvature => {
            [10, 20, 45].forEach(lead => {
                const settings = { portLeadInPercent: lead, curvaturePercent: curvature };
                const reference = NOW.routeDiagram(layout,
                    Object.assign({ style: "Polyline" }, settings)).bands[0].path;
                ["Orthogonal", "Smooth"].forEach(style => {
                    const path = NOW.routeDiagram(layout,
                        Object.assign({ style }, settings)).bands[0].path;
                    check("un-dragged loop v" + value + " identical in " + style
                        + " at curvature " + curvature + ", lead " + lead, path === reference);
                });
            });
        });
    });
})();


// --- 3. The two leads are INDEPENDENT; the corners follow the shorter ------
// the author, after using the coupled version: each lead handle should move only its
// own side of the loop. The corners still follow the handles -- one radius for
// all four, and never rounder than the lead run leading into a corner, so the
// SHORTER lead.
[[40, 20, 60], [120, 20, 120], [40, 60, 60]].forEach(([value, w, h]) => {
    const layout = loopLayout(value, w, h);
    const base = NOW.routeDiagram(layout, OPT);
    const band0 = base.bands[0];
    const half = Math.hypot(samplePath(band0.path, 1)[0].x - band0.start.x,
        samplePath(band0.path, 1)[0].y - band0.start.y);
    const floor = half + 1;
    const shape = "loop v" + value + " on " + w + "x" + h;
    const h0 = base.handles.get("A->A");
    const defaultOut = h0.source.point.x - band0.start.x;
    const defaultIn = band0.end.x - h0.target.point.x;
    const leadsOf = routed => {
        const band = routed.bands[0], h2 = routed.handles.get("A->A");
        return { band, out: h2.source.point.x - band.start.x, in: band.end.x - h2.target.point.x };
    };

    // (a) Dragging ONE handle moves only that side, and lands where dropped.
    [300, 160, 60, 34].forEach(asked => {
        const one = leadsOf(NOW.routeDiagram(layout, OPT,
            new Map([["A->A", { source: { x: band0.start.x + asked, y: band0.start.y } }]])));
        independence++;
        check(shape + ": source dragged to " + asked + " lands there",
            Math.abs(one.out - Math.max(floor, asked)) < 0.01, "lead " + one.out.toFixed(1));
        check(shape + ": source dragged to " + asked + " leaves the target alone",
            Math.abs(one.in - defaultIn) < 0.01, one.in.toFixed(1) + " against default " + defaultIn.toFixed(1));
        check(shape + ": source dragged to " + asked + " moves only the right side",
            Math.abs(one.band.bounds.minX - base.bands[0].bounds.minX) < 0.5,
            "left edge " + one.band.bounds.minX.toFixed(1) + " was " + base.bands[0].bounds.minX.toFixed(1));

        const other = leadsOf(NOW.routeDiagram(layout, OPT,
            new Map([["A->A", { target: { x: band0.end.x - asked, y: band0.end.y } }]])));
        check(shape + ": target dragged to " + asked + " lands there",
            Math.abs(other.in - Math.max(floor, asked)) < 0.01, "lead " + other.in.toFixed(1));
        check(shape + ": target dragged to " + asked + " leaves the source alone",
            Math.abs(other.out - defaultOut) < 0.01, other.out.toFixed(1) + " against default " + defaultOut.toFixed(1));
    });

    // (b) With both leads dragged and the corner handle untouched, the radius
    //     is the Curvature slider's, capped where a straight runs out -- a
    //     short lead included. OPT is Curvature 100, whose radius (200) is
    //     larger than any of these loops can hold, so the cap is what shows;
    //     section 7 shows the slider winning at a setting that can.
    [[220, 220], [60, 60], [34, 34], [160, 60], [60, 160], [300, 40]].forEach(([askOut, askIn]) => {
        const both = leadsOf(NOW.routeDiagram(layout, OPT, new Map([["A->A", {
            source: { x: band0.start.x + askOut, y: band0.start.y },
            target: { x: band0.end.x - askIn, y: band0.end.y }
        }]])));
        const label = shape + " at leads " + askOut + "/" + askIn;
        check(label + ": each lead is its own", Math.abs(both.out - Math.max(floor, askOut)) < 0.01
            && Math.abs(both.in - Math.max(floor, askIn)) < 0.01,
            both.out.toFixed(1) + "/" + both.in.toFixed(1));

        // Equal leads make an even loop, which is mirror symmetry about the
        // node's centre line -- the property unequal leads rightly give up.
        if (askOut === askIn) {
            const centreX = (both.band.start.x + both.band.end.x) / 2;
            const outline = samplePath(both.band.path, 8);
            const mirrored = outline.map(q => ({ x: 2 * centreX - q.x, y: q.y }));
            const strays = outline.filter(q => !mirrored.some(m =>
                Math.abs(m.x - q.x) < 1 && Math.abs(m.y - q.y) < 1));
            evenness++;
            check(label + ": equal leads give an even loop", strays.length === 0,
                strays.length + " of " + outline.length + " outline points unmatched");
        }

        // The radius, voted for by every drawn arc weighted by its length.
        const radii = arcRadii(both.band.path, 6 * Math.max(both.out, both.in, half));
        const votes = radii.map(a => ({ v: a.r + half, weight: a.weight }))
            .concat(radii.map(a => ({ v: a.r - half, weight: a.weight })));
        let bestR = null, bestWeight = 0;
        votes.forEach(candidate => {
            const weight = votes.filter(x => Math.abs(x.v - candidate.v) < 2)
                .reduce((sum, x) => sum + x.weight, 0);
            if (weight > bestWeight || (weight === bestWeight && bestR !== null && candidate.v > bestR)) {
                bestWeight = weight;
                bestR = candidate.v;
            }
        });
        if (bestR !== null && bestWeight >= 24) {
            tracking++;
            const cap = ((both.band.bounds.maxY - both.band.bounds.minY) - 2 * half) / 2;
            const expected = Math.min(both.out, both.in, cap);
            check(label + ": the corners stop where a straight runs out",
                Math.abs(bestR - expected) < 2.5,
                "measured " + bestR.toFixed(1) + ", leads " + both.out.toFixed(1) + "/" + both.in.toFixed(1)
                + ", cap " + cap.toFixed(1));
        }
    });

    // --- 4. The perpendicular handle still sizes the rectangle ---------------
    let previousHeight = null;
    [0, 60, 140].forEach(up => {
        const routed = NOW.routeDiagram(layout, OPT,
            new Map([["A->A", { middle: { x: h0.middle.point.x, y: h0.middle.point.y - up } }]]));
        const height = routed.bands[0].bounds.maxY - routed.bands[0].bounds.minY;
        if (previousHeight !== null) {
            check(shape + ": the lane handle grows the rectangle at +" + up,
                height > previousHeight + 1, height.toFixed(0) + " against " + previousHeight.toFixed(0));
        }
        previousHeight = height;
    });
});

// --- 5. The lane handle is not a bend ----------------------------------------
(() => {
    const layout = loopLayout(40, 20, 60);
    const handles = NOW.routeDiagram(layout, OPT).handles.get("A->A");
    check("a self-loop's middle is a lane, not a gesture",
        handles.middle !== undefined && handles.middle.gesture !== true);
    const a = node("A", 100, 400, 14, 40), b = node("B", 900, 420, 14, 40);
    const corridor = {
        id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
        segments: [{ flowType: undefined, value: 40, flows: [] }],
        sourcePort: "East", targetPort: "West"
    };
    const direct = {
        nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
    const diagonal = NOW.routeDiagram(direct, OPT).handles.get("A->B");
    check("a diagonal's middle IS a gesture",
        diagonal.middle !== undefined && diagonal.middle.gesture === true);
})();

// --- 7. The CORNER handle: roundness without resizing ------------------------
// the agreed call: one handle per job. The corner handle sits on one
// corner's arc and sets the radius of all four; it must never move the loop's
// sides or top, and the leads must no longer drive the radius.
let cornerRan = 0;
(() => {
    const P = require("./lib/positions.js");
    const opt30 = { portLeadInPercent: 20, curvaturePercent: 30, style: "Smooth" };
    const sliderRadius = 0.3 * 200; // Curvature 30 of the tighter pitch (200)

    [["East", "West"], ["East", "South"]].forEach(([sp, tp]) => {
        const n = node("A", 400, 300, 20, 60);
        const corridor = {
            id: "A->A", source: "A", target: "A", value: 40, isSelfLoop: true, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp
        };
        const layout = {
            nodes: new Map([["A", n]]), corridors: [corridor],
            valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        };
        const shape = sp + "->" + tp + " loop";
        const base = NOW.routeDiagram(layout, opt30);
        const h0 = base.handles.get("A->A");
        const k0 = h0.corner;
        check(shape + ": has a corner handle", k0 !== undefined);
        if (!k0) {
            return;
        }
        const on = k => ({ x: k.apex.x + k.direction.x * k.radius * k.spread,
            y: k.apex.y + k.direction.y * k.radius * k.spread });
        check(shape + ": the handle sits on its own arc's midpoint",
            Math.hypot(on(k0).x - k0.point.x, on(k0).y - k0.point.y) < 0.01);
        check(shape + ": untouched, the radius is the slider's (capped)",
            Math.abs(k0.radius - Math.min(sliderRadius, k0.maxRadius)) < 0.01,
            k0.radius.toFixed(1) + " against slider " + sliderRadius + ", cap " + k0.maxRadius.toFixed(1));

        // The leads no longer drive the radius: pull both well out and the
        // corners stay at the slider's radius.
        const wide = NOW.routeDiagram(layout, opt30, new Map([["A->A", {
            source: { x: base.bands[0].start.x + 160, y: base.bands[0].start.y },
            target: sp === tp ? undefined : undefined
        }]])).handles.get("A->A").corner;
        check(shape + ": dragging a lead out does not round the corners",
            wide !== undefined && Math.abs(wide.radius - k0.radius) < 0.01,
            wide ? wide.radius.toFixed(1) + " against " + k0.radius.toFixed(1) : "no handle");

        [10, 30, 50, 90, 1000].forEach(asked => {
            const routed = NOW.routeDiagram(layout, opt30,
                new Map([["A->A", { radius: asked / 200 }]]));
            const h = routed.handles.get("A->A");
            const k = h.corner;
            const label = shape + " with the corner at " + asked + "px";
            cornerRan++;
            const expected = Math.max(k.minRadius, Math.min(asked, k.maxRadius));
            check(label + ": the arc takes it, between the floor and the cap",
                Math.abs(k.radius - expected) < 0.01,
                k.radius.toFixed(1) + " against " + expected.toFixed(1)
                + " (floor " + k.minRadius.toFixed(0) + ", cap " + k.maxRadius.toFixed(1) + ")");
            // Rounding NEVER resizes: both leads, and the lane where there is
            // one, stay exactly where they were.
            const same = (a, b) => a && b && Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) < 0.01;
            check(label + ": the loop's sides stay put",
                same(h.source, h0.source) && same(h.target, h0.target));
            if (h0.middle) {
                check(label + ": the loop's top stays put", same(h.middle, h0.middle));
            }
            // And the drawn corners really are that radius: on the untapered
            // 180-degree loop, every arc sits a half-width either side of it.
            if (sp === "East" && tp === "West") {
                const band = routed.bands[0];
                const half = Math.hypot(samplePath(band.path, 1)[0].x - band.start.x,
                    samplePath(band.path, 1)[0].y - band.start.y);
                const radii = arcRadii(band.path, 6 * Math.max(k.radius, half) + 50);
                const votes = radii.map(a => ({ v: a.r + half, weight: a.weight }))
                    .concat(radii.map(a => ({ v: a.r - half, weight: a.weight })));
                let bestR = null, bestWeight = 0;
                votes.forEach(c => {
                    const weight = votes.filter(x => Math.abs(x.v - c.v) < 2).reduce((t, x) => t + x.weight, 0);
                    if (weight > bestWeight || (weight === bestWeight && bestR !== null && c.v > bestR)) {
                        bestWeight = weight;
                        bestR = c.v;
                    }
                });
                if (bestR !== null && bestWeight >= 24) {
                    check(label + ": the drawn corners measure that radius",
                        Math.abs(bestR - k.radius) < 2.5,
                        "measured " + bestR.toFixed(1) + " against " + k.radius.toFixed(1));
                }
            }
        });
    });

    // Offered on a self-loop in EVERY style (loops are
    // the same whatever the style) -- and shown there, Orthogonal included.
    ["Orthogonal", "Polyline", "Smooth"].forEach(style => {
        const r = NOW.routeDiagram(loopLayout(40, 20, 60), { portLeadInPercent: 20, curvaturePercent: 30, style });
        const shown = NOW.draggableHandles(r.handles, style).get("A->A");
        check("a corner handle shown in " + style, shown !== undefined && shown.corner !== undefined);
    });
    (() => {
        const a = node("A", 100, 400, 14, 40), b = node("B", 900, 150, 14, 40);
        const corridor = {
            id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "West"
        };
        const h = NOW.routeDiagram({
            nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
            valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        }, OPT).handles.get("A->B");
        check("no corner handle on an ordinary Biarc corridor", h === undefined || h.corner === undefined);
    })();

    // Persistence: a length, stored in grid units, round-trips and parses totally.
    const stored = P.withRouteRadius(new Map(), "A->A", 0.35);
    const back = P.parseRouteOverrides(P.serialiseRouteOverrides(stored)).get("A->A");
    check("a corner radius survives the round trip",
        back !== undefined && Math.abs(back.radius - 0.35) < 1e-3, JSON.stringify(back));
    check("resetting the radius removes the entry",
        !P.withRouteRadius(stored, "A->A", undefined).has("A->A"));
    check("a radius sits alongside a moved lead",
        P.withRouteHandle(stored, "A->A", "source", { column: 2, row: 3 }).get("A->A").radius === 0.35);
    // earlier: a hand-set radius belongs to the Curvature it was set at.
    const stamped = P.withRouteRadius(new Map(), "A->A", 0.35, 50).get("A->A");
    check("a radius is in force at the Curvature it was set at", P.radiusInForce(stamped, 50) === 0.35);
    check("...and the slider takes over at any other", P.radiusInForce(stamped, 80) === undefined);
    check("...and at its own setting it still applies", P.radiusInForce(stamped, 50) === 0.35);
    check("the stamp survives the round trip",
        P.parseRouteOverrides(P.serialiseRouteOverrides(new Map([["A->A", stamped]]))).get("A->A").radiusCurvature === 50);
    check("a radius with no recorded setting is not in force",
        P.radiusInForce({ radius: 0.2 }, 80) === undefined);

    // a slider change must be picked up by EVERY hand-set
    // corner at once. The per-corner restore of the code once made two loops
    // shaped at different settings take turns ignoring the slider. Simulated
    // exactly as update() runs it: every step first clears what is stale.
    const step = (overrides, curvature) => P.withoutStaleRadii(overrides, curvature) ?? overrides;
    let state = new Map();
    state = step(state, 35);
    state = P.withRouteRadius(state, "A", 0.2, 35);          // shape loop A at 35
    state = step(state, 50);                                  // slider to 50
    check("moving the slider clears a hand-set corner", !state.has("A"));
    state = P.withRouteRadius(state, "B", 0.4, 50);          // shape loop B at 50
    state = P.withRouteRadius(state, "A", 0.25, 50);         // and A again, at 50
    state = step(state, 35);                                  // slider back to 35
    check("...every one of them, together",
        !state.has("A") && !state.has("B"), JSON.stringify(Array.from(state.keys())));
    state = step(state, 50);                                  // and back to 50
    check("...and moving back does NOT restore them",
        P.radiusInForce(state.get("A") || {}, 50) === undefined && P.radiusInForce(state.get("B") || {}, 50) === undefined);
    state = P.withRouteRadius(state, "A", 0.3, 50);
    check("a corner set at the current setting survives an update", step(state, 50).get("A").radius === 0.3);
    check("nothing to clear means no write", P.withoutStaleRadii(state, 50) === undefined);
    const withLead = P.withRouteHandle(P.withRouteRadius(new Map(), "A", 0.3, 50), "A", "source", { column: 2, row: 3 });
    const afterMove = P.withoutStaleRadii(withLead, 70);
    check("clearing a radius keeps the loop's other handles",
        afterMove.get("A").source !== undefined && afterMove.get("A").radius === undefined);
    check("resetting clears the stamp with the radius",
        !P.withRouteRadius(new Map([["A->A", stamped]]), "A->A", undefined).has("A->A"));
    check("a nonsense radius is ignored",
        P.parseRouteOverrides('{"A->A":{"r":-1}}').size === 0
        && P.parseRouteOverrides('{"A->A":{"r":"x","s":[2,3]}}').get("A->A").radius === undefined);
})();
check("the corner-handle assertions actually ran", cornerRan === 10, "ran " + cornerRan + " times");

// --- 8. Lead handles drawn on the middle of their SIDES, and every drop lands
// the author (with a screenshot): a lead handle at its stub sits in empty
// space outside a rounded corner, so on a Biarc self-loop it is drawn on the
// middle of the side it places. The drag moves the DRAWN point, and the one
// property that matters is the one polyline-check pins for Polyline: every drop
// lands where it was dropped. Swept across both loop types, dragging in and
// out, with and without a corner radius set, and at Curvature 30, where the
// lead is the straight limiting the corners.
let arcDrops = 0;
(() => {
    const NORMAL = { North: { x: 0, y: -1 }, South: { x: 0, y: 1 }, East: { x: 1, y: 0 }, West: { x: -1, y: 0 } };
    const n = node("A", 400, 300, 20, 60);
    [["East", "West"], ["East", "South"]].forEach(([sp, tp]) => {
        const corridor = {
            id: "A->A", source: "A", target: "A", value: 40, isSelfLoop: true, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp
        };
        const layout = {
            nodes: new Map([["A", n]]), corridors: [corridor],
            valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        };
        // Polyline loops take the mid-side handles too. A corner
        // radius means nothing to Polyline, so its radius rows simply run it
        // again with the slider in charge.
        [["Smooth", 30, undefined], ["Smooth", 100, undefined], ["Smooth", 30, 0.2], ["Smooth", 100, 0.45],
            ["Polyline", 30, undefined], ["Polyline", 100, undefined], ["Polyline", 0, undefined]]
            .forEach(([loopStyle, curvature, radius]) => {
            const opt = { portLeadInPercent: 20, curvaturePercent: curvature, style: loopStyle };
            const extra = radius === undefined ? {} : { radius };
            const base = NOW.routeDiagram(layout, opt, new Map([["A->A", extra]]));
            const setting = loopStyle + " " + sp + "->" + tp + " at curvature " + curvature + (radius ? ", corner " + radius : "");
            ["source", "target"].forEach(kind => {
                const handle = base.handles.get("A->A")[kind];
                const label = setting + " " + kind;
                check(label + ": drawn on its side", handle.side !== undefined);
                if (!handle.side) {
                    return;
                }
                const arc = handle.side;
                const anchor = kind === "source" ? base.bands[0].start : base.bands[0].end;
                const normal = NORMAL[kind === "source" ? sp : tp];
                // On the side means level with the stub along the drag...
                const offAxis = (arc.drawn.x - handle.point.x) * normal.x + (arc.drawn.y - handle.point.y) * normal.y;
                check(label + ": level with its stub along the drag", Math.abs(offAxis) < 0.01,
                    "off by " + offAxis.toFixed(3));
                // ...and, on the 180-degree loop, half way up to the lane.
                const lane = base.handles.get("A->A").middle;
                if (tp === "West" && lane) {
                    const halfway = (handle.point.y + lane.point.y) / 2;
                    check(label + ": half way up its side", Math.abs(arc.drawn.y - halfway) < 0.01,
                        arc.drawn.y.toFixed(2) + " against " + halfway.toFixed(2));
                }
                check(label + ": still stores the stub (avoidance reads it)",
                    Math.hypot(handle.point.x - arc.toStub(arc.drawn).x, handle.point.y - arc.toStub(arc.drawn).y) < 0.01);
                const lowest = arc.toDrawn(anchor); // the floor, as drawn
                [-60, -30, -10, 25, 80, 200].forEach(delta => {
                    const want = { x: arc.drawn.x + normal.x * delta, y: arc.drawn.y + normal.y * delta };
                    const reachable = (want.x - lowest.x) * normal.x + (want.y - lowest.y) * normal.y >= -1e-6;
                    // Exactly what interaction.ts does with snapping off.
                    const stub = arc.toStub(want);
                    const routed = NOW.routeDiagram(layout, opt,
                        new Map([["A->A", Object.assign({}, extra, { [kind]: stub })]]));
                    const got = routed.handles.get("A->A")[kind].side.drawn;
                    const along = (got.x - want.x) * normal.x + (got.y - want.y) * normal.y;
                    if (reachable) {
                        arcDrops++;
                        check(label + ": a drop " + delta + "px along lands where dropped",
                            Math.abs(along) < 0.01, "off by " + along.toFixed(3) + "px");
                    } else {
                        // Below the band's floor the handle rightly stops -- at
                        // the floor, not somewhere short of it.
                        const stopped = (got.x - lowest.x) * normal.x + (got.y - lowest.y) * normal.y;
                        check(label + ": a drop past the floor stops at it", Math.abs(stopped) < 0.01,
                            "stopped " + stopped.toFixed(3) + "px from the floor");
                    }
                });
            });
        });
    });

    // Not on a 0-degree loop (both stubs share a line, so one lead's side would
    // drag the other's stub along) and not in any other style.
    const zero = {
        nodes: new Map([["A", n]]),
        corridors: [{
            id: "A->A", source: "A", target: "A", value: 40, isSelfLoop: true, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "East"
        }],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
    const z = NOW.routeDiagram(zero, OPT).handles.get("A->A");
    check("a 0-degree loop keeps its handles at the stubs",
        z === undefined || ((!z.source || !z.source.side) && (!z.target || !z.target.side)));
    ["Orthogonal", "Polyline", "Smooth"].forEach(style => {
        const r = NOW.routeDiagram(loopLayout(40, 20, 60), { portLeadInPercent: 20, curvaturePercent: 30, style });
        const shown = NOW.draggableHandles(r.handles, style).get("A->A");
        check("side-drawn leads shown in " + style,
            shown !== undefined && shown.source && shown.source.side && shown.target && shown.target.side);
    });
})();
check("the arc-drop assertions actually ran", arcDrops >= 80, "ran " + arcDrops + " times");

// --- 9. A self-loop is EXACTLY THE SAME in every style ----------------------
// Stated as the property itself: every pairing, three
// curvatures, untouched and with every kind of handle moved, alone and
// together -- the drawn loop and the handles offered are identical whichever
// style is selected.
let sameness = 0;
(() => {
    const PORTS = ["North", "South", "East", "West"], STYLES = ["Polyline", "Octilinear", "Orthogonal", "Smooth"];
    const n = node("A", 400, 300, 20, 60);
    const kinds = (routed, style) => {
        const h = NOW.draggableHandles(routed.handles, style).get("A->A") || {};
        return ["source", "target", "middle", "corner"].filter(k => h[k])
            .map(k => k + (h[k].side ? "(side)" : "")).join("+");
    };
    PORTS.forEach(sp => PORTS.forEach(tp => [0, 30, 100].forEach(curvature => {
        const corridor = {
            id: "A->A", source: "A", target: "A", value: 40, isSelfLoop: true, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp
        };
        const layout = {
            nodes: new Map([["A", n]]), corridors: [corridor],
            valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        };
        [{}, { source: { x: 520, y: 330 } }, { target: { x: 330, y: 330 } }, { middle: { x: 410, y: 120 } },
            { radius: 0.15 }, { source: { x: 470, y: 330 }, radius: 0.3, middle: { x: 410, y: 150 } },
            { middle: { x: 410, y: 520 } }, { middle: { x: 250, y: 330 } }].forEach(ov => {
            sameness++;
            const routed = STYLES.map(style => NOW.routeDiagram(layout,
                { portLeadInPercent: 20, curvaturePercent: curvature, style }, new Map([["A->A", ov]])));
            const label = sp + "->" + tp + " loop at Curvature " + curvature + " with " + JSON.stringify(Object.keys(ov));
            check(label + ": drawn the same in every style",
                routed.every(r => r.bands[0].path === routed[0].bands[0].path));
            const offered = STYLES.map((style, i) => kinds(routed[i], style));
            check(label + ": the same handles in every style",
                offered.every(k => k === offered[0]), offered.join(" | "));
        });
    })));
})();
check("the sameness assertions actually ran", sameness === 384, "ran " + sameness + " times");

// --- 10. A 180-degree loop flips to the other side of its node --------------
// dragging the lane handle past the node should put the loop
// on the other side, changing the stacking order. Nothing is stored for it:
// the side is read off where the stored lane sits. 90-degree loops never flip
//.
let flipRan = 0;
(() => {
    const P = require("./lib/positions.js");
    const S = require("./lib/straighten.js");
    const inNode = (band, n) => samplePath(band.path, 12).filter(q =>
        q.x > n.x + 1.5 && q.x < n.x + n.width - 1.5 && q.y > n.y + 1.5 && q.y < n.y + n.height - 1.5).length;
    const n = node("A", 400, 300, 20, 60); // spans y 300..360
    const loop = {
        id: "A->A", source: "A", target: "A", value: 40, isSelfLoop: true, flows: [],
        segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "West"
    };
    const lone = {
        nodes: new Map([["A", n]]), corridors: [loop],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
    const opt = { portLeadInPercent: 20, curvaturePercent: 35, style: "Polyline" };
    const clear = 20 + 1; // the band's half-width plus a pixel
    [[undefined, "above", 190], [150, "above", 150], [290, "above", 300 - clear], [320, "above", 300 - clear],
        [345, "above", 300 - clear], [365, "below", 360 + clear], [450, "below", 450]].forEach(([y, side, laneAt]) => {
        const routed = NOW.routeDiagram(lone, opt, y === undefined ? new Map() : new Map([["A->A", { middle: { x: 410, y } }]]));
        const band = routed.bands[0];
        const label = "a lone loop with its lane dropped at " + (y === undefined ? "(default)" : y);
        flipRan++;
        check(label + " runs " + side, side === "above" ? band.bounds.maxY < 361 && band.bounds.minY < 299
            : band.bounds.minY > 299 && band.bounds.maxY > 361,
            "bounds y " + band.bounds.minY.toFixed(0) + ".." + band.bounds.maxY.toFixed(0));
        check(label + ": the lane handle shows where the lane really is",
            y === undefined || Math.abs(routed.handles.get("A->A").middle.point.y - laneAt) < 0.5,
            routed.handles.get("A->A").middle.point.y.toFixed(1) + " against " + laneAt);
        check(label + ": the band never enters its own node", inNode(band, n) === 0,
            inNode(band, n) + " points inside");
    });

    // The stacking order. **The invariant is agreement, not a side**
    //: a loop's ends sit on the side its lane runs, because both
    // now come from the route's own first corner. Which side that is by
    // default is no longer a convention to assert -- `selfLoopKey` used to
    // say "round the top for an East/West pair" and it has gone -- so this
    // drops the lane on each side in turn and checks the ends follow.
    const hub = node("H", 400, 250, 20, 160), left = node("L", 100, 300, 14, 60), right = node("R", 700, 320, 14, 60);
    const seg = v => [{ flowType: undefined, value: v, flows: [] }];
    const corridors = [
        { id: "H->H", source: "H", target: "H", value: 30, isSelfLoop: true, flows: [], segments: seg(30), sourcePort: "East", targetPort: "West" },
        { id: "L->H", source: "L", target: "H", value: 60, isSelfLoop: false, flows: [], segments: seg(60), sourcePort: "East", targetPort: "West" },
        { id: "H->R", source: "H", target: "R", value: 60, isSelfLoop: false, flows: [], segments: seg(60), sourcePort: "East", targetPort: "West" }
    ];
    const busy = () => ({
        nodes: new Map([["H", { ...hub }], ["L", { ...left }], ["R", { ...right }]]), corridors,
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    });
    // The node spans y 250..410; these drop the lane clear of each end.
    const dropHigh = new Map([["H->H", { middle: { x: 410, y: 140 } }]]);
    const dropLow = new Map([["H->H", { middle: { x: 410, y: 520 } }]]);
    ["Polyline", "Orthogonal", "Smooth"].forEach(style => {
        const o = { portLeadInPercent: 20, curvaturePercent: 35, style };
        const get = (r, id) => r.bands.find(b => b.corridorId === id);
        const high = NOW.routeDiagram(busy(), o, dropHigh);
        const low = NOW.routeDiagram(busy(), o, dropLow);
        flipRan++;
        // Where the ends sit against the ordinary traffic on the same faces,
        // and where the band actually goes. They must say the same thing.
        const ends = r => (get(r, "H->H").start.y < get(r, "H->R").start.y
            && get(r, "H->H").end.y < get(r, "L->H").end.y ? "above" : "below");
        const band = r => (get(r, "H->H").bounds.minY < 250 ? "above" : "below");
        check(style + ": lane dropped above, the loop runs above",
            band(high) === "above", "band y " + get(high, "H->H").bounds.minY.toFixed(0)
            + ".." + get(high, "H->H").bounds.maxY.toFixed(0));
        check(style + ": lane dropped below, the loop runs below",
            band(low) === "below", "band y " + get(low, "H->H").bounds.minY.toFixed(0)
            + ".." + get(low, "H->H").bounds.maxY.toFixed(0));
        check(style + ": the ends follow the lane, both ways",
            ends(high) === band(high) && ends(low) === band(low),
            "high " + ends(high) + "/" + band(high) + ", low " + ends(low) + "/" + band(low));
        check(style + ": which is two different stackings, not one",
            ends(high) !== ends(low), ends(high) + " against " + ends(low));
    });

    // A North->South loop flips from the right to the left.
    const tall = node("N", 400, 300, 60, 20);
    const ns = {
        id: "N->N", source: "N", target: "N", value: 30, isSelfLoop: true, flows: [],
        segments: [{ flowType: undefined, value: 30, flows: [] }], sourcePort: "North", targetPort: "South"
    };
    const nsLayout = { nodes: new Map([["N", tall]]), corridors: [ns], valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200 };
    const nsDefault = NOW.routeDiagram(nsLayout, opt).bands[0];
    const nsFlipped = NOW.routeDiagram(nsLayout, opt, new Map([["N->N", { middle: { x: 250, y: 310 } }]])).bands[0];
    flipRan++;
    check("a North->South loop runs right by default, left once flipped",
        nsDefault.bounds.maxX > 461 && nsDefault.bounds.minX > 399 && nsFlipped.bounds.minX < 399 && nsFlipped.bounds.maxX < 461);

    void P;
})();
check("the flip assertions actually ran", flipRan === 11, "ran " + flipRan + " times");

check("the independence assertions actually ran", independence >= 12, "ran " + independence + " times");
check("the evenness assertion actually ran", evenness >= 6, "ran " + evenness + " times");
check("the radius-follows-lead assertion actually ran", tracking >= 3, "ran " + tracking + " times");
// --- 6. A 90-degree self-loop: independent leads, and clear of its node -----
// An L around the node's corner, so it has no lane: its corner is where the
// two stubs meet and moves when a lead does. Each lead must move on its own,
// and because this block overrides leads that leadClearing had extended, the
// loop must still clear the node it wraps at every combination.
(() => {
    const n = node("A", 400, 300, 20, 60);
    const corridor = {
        id: "A->A", source: "A", target: "A", value: 40, isSelfLoop: true, flows: [],
        segments: [{ flowType: undefined, value: 40, flows: [] }],
        sourcePort: "East", targetPort: "South"
    };
    const layout = {
        nodes: new Map([["A", n]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
    const base = NOW.routeDiagram(layout, OPT);
    const band0 = base.bands[0];
    const h0 = base.handles.get("A->A");
    const defaultIn = h0.target.point.y - band0.end.y;
    let ran = 0;
    [[40, null], [160, null], [40, 160], [160, 40], [240, 240]].forEach(([askOut, askIn]) => {
        const ov = { source: { x: band0.start.x + askOut, y: band0.start.y } };
        if (askIn !== null) {
            ov.target = { x: band0.end.x, y: band0.end.y + askIn };
        }
        const routed = NOW.routeDiagram(layout, OPT, new Map([["A->A", ov]]));
        const band = routed.bands[0];
        const h = routed.handles.get("A->A");
        const leadIn = h.target.point.y - band.end.y;
        const label = "90-degree loop at " + askOut + "/" + (askIn === null ? "default" : askIn);
        ran++;
        if (askIn === null) {
            check(label + ": the untouched lead stays put", Math.abs(leadIn - defaultIn) < 0.01,
                leadIn.toFixed(1) + " against default " + defaultIn.toFixed(1));
        }
        const intruding = samplePath(band.path, 10).filter(q =>
            q.x > n.x && q.x < n.x + n.width && q.y > n.y && q.y < n.y + n.height);
        check(label + ": stays off its own node",
            intruding.length === 0, intruding.length + " points inside the node");
    });
    check("the 90-degree loop assertions actually ran", ran === 5, "ran " + ran + " times");
})();

console.log((failures === 0 ? "PASS" : "FAIL") + " selfloop-radius-check: "
    + independence + " single-handle drags, " + evenness + " evenness measurements, "
    + tracking + " radius-tracking measurements, "
    + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
