"use strict";
/**
 * Octilinear: Polyline with every diagonal at 45 degrees.
 * Built first as a 15/45-degree snap setting on Polyline; 15 did
 * not look good, so it became its own style: diagonals are FITTED to 45 (or a
 * 90-degree step where 45 won't fit) whenever the style is on, and a lead
 * snaps as it is dragged. The pure maths still takes any step.
 *
 * Pinned end to end: the snap maths (\`snapLeadToAngle\`) and real routes --
 * the handle routing publishes, a drop snapped as interaction.ts does it,
 * stored, routed again, and the drawn diagonal's angle measured off the two
 * lead ends routing actually used. That last step is what proves routing
 * accepts a snapped drop as-is rather than flooring or moving it.
 */
const R = require("./routing-api.js");
const I = require("./lib/interaction.js");

let failures = 0;
function check(name, ok, detail) {
    if (!ok) {
        failures++;
        console.log("  FAIL " + name + (detail ? "  " + detail : ""));
    }
}
const node = (id, x, y, w, h) => ({ id, label: id, x, y, width: w, height: h, inflow: 0, outflow: 0, isSelfLoop: false });
const NORM = { North: { x: 0, y: -1 }, South: { x: 0, y: 1 }, East: { x: 1, y: 0 }, West: { x: -1, y: 0 } };

/** The diagonal's angle, in degrees from the route's own direction, between two lead ends. */
function diagonalAngle(stubOut, stubIn, exitNormal) {
    const v = { x: stubIn.x - stubOut.x, y: stubIn.y - stubOut.y };
    const along = v.x * exitNormal.x + v.y * exitNormal.y;
    const across = Math.hypot(v.x - exitNormal.x * along, v.y - exitNormal.y * along);
    return Math.atan2(across, along) * 180 / Math.PI;
}
const onStep = (angle, step) => Math.abs(angle / step - Math.round(angle / step)) * step < 0.05;

// --- 1. The maths on its own -------------------------------------------------
(() => {
    // Anchor at the origin facing +x; the other end 300 along and 120 across.
    const snap = { other: { x: 300, y: 120 }, anchor: { x: 0, y: 0 }, normal: { x: 1, y: 0 }, minLead: 21 };
    let ran = 0;
    [15, 45].forEach(step => {
        for (let lead = -50; lead <= 600; lead += 7) {
            const p = I.snapLeadToAngle({ x: lead, y: 999 }, snap, step);
            const angle = diagonalAngle(p, snap.other, snap.normal);
            ran++;
            check("step " + step + ", pointer at lead " + lead + ": the angle is on a step",
                onStep(angle, step), angle.toFixed(3) + " degrees");
            check("step " + step + ", pointer at lead " + lead + ": the lead respects the minimum",
                p.x >= snap.minLead - 1e-6, "lead " + p.x.toFixed(2));
            check("step " + step + ": the point stays on the port's direction", Math.abs(p.y) < 1e-9);
        }
    });
    // Free is a plain drag, floored.
    check("Free leaves the lead where it was dropped",
        Math.abs(I.snapLeadToAngle({ x: 137, y: 0 }, snap, 0).x - 137) < 1e-9);
    check("Free still floors the lead", Math.abs(I.snapLeadToAngle({ x: 5, y: 0 }, snap, 0).x - 21) < 1e-9);
    // The nearest allowed angle wins: a pointer asking for ~40 degrees at a
    // 45 step gets 45, not 90.
    const lead40 = 300 - 120 / Math.tan(40 * Math.PI / 180);
    const got = I.snapLeadToAngle({ x: lead40, y: 0 }, snap, 45);
    check("a pointer asking for 40 degrees gets 45 at a 45 step",
        Math.abs(diagonalAngle(got, snap.other, snap.normal) - 45) < 0.01);
    // Aligned ends have no angle to snap.
    const aligned = { ...snap, other: { x: 300, y: 0 } };
    check("aligned ends move freely", Math.abs(I.snapLeadToAngle({ x: 137, y: 0 }, aligned, 45).x - 137) < 1e-9);
    check("the maths assertions actually ran", ran > 150, "ran " + ran);
})();

// --- 2. Real routes: routing publishes the geometry and accepts the result ---
let routed = 0;
[["East", "West"], ["West", "East"], ["South", "North"], ["North", "South"]].forEach(([sp, tp]) => {
    const across = (sp === "East" || sp === "West");
    const a = across ? node("A", 100, 300, 14, 40) : node("A", 300, 100, 40, 14);
    [60, 140, 260].forEach(offset => {
        const b = across ? node("B", 900, 300 + offset, 14, 40) : node("B", 300 + offset, 700, 40, 14);
        // For West->East and North->South the source sits on the right/bottom.
        const flip = sp === "West" || sp === "North";
        const src = flip ? b : a, dst = flip ? a : b;
        const corridor = {
            id: "S->T", source: "S", target: "T", value: 40, isSelfLoop: false, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp
        };
        const layout = {
            nodes: new Map([["S", { ...src, id: "S", label: "S" }], ["T", { ...dst, id: "T", label: "T" }]]),
            corridors: [corridor], valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
        };
        const opt = { portLeadInPercent: 20, curvaturePercent: 35, style: "Octilinear" };
        const base = R.routeDiagram(layout, opt);
        const h0 = base.handles.get("S->T");
        const label0 = sp + "->" + tp + " offset " + offset;
        check(label0 + ": both leads carry angle-snap geometry",
            h0.source.angleSnap !== undefined && h0.target.angleSnap !== undefined);
        if (!h0.source.angleSnap) {
            return;
        }
        [45].forEach(step => ["source", "target"].forEach(kind => {
            const snap = h0[kind].angleSnap;
            const normal = NORM[kind === "source" ? sp : tp];
            [-80, -20, 30, 110, 260].forEach(delta => {
                const pointer = { x: h0[kind].point.x + normal.x * delta, y: h0[kind].point.y + normal.y * delta };
                const drop = I.snapLeadToAngle(pointer, snap, step);
                // Exactly what visual.ts commits: the dragged lead, plus the
                // OTHER lead pinned where it is -- the drag held it still,
                // and left unstored it would fall back to its default and the
                // 45-degree fit would move both (measured: 60px off).
                const other = kind === "source" ? "target" : "source";
                const after = R.routeDiagram(layout, opt, new Map([["S->T", { [kind]: drop, [other]: h0[other].point }]]));
                const h = after.handles.get("S->T");
                const angle = diagonalAngle(h.source.point, h.target.point, NORM[sp]);
                const label = label0 + ", " + kind + " dragged " + delta + " at " + step + "-degree steps";
                routed++;
                check(label + ": the drawn diagonal is on a step", onStep(angle, step), angle.toFixed(3) + " degrees");
                check(label + ": routing used the snapped drop exactly",
                    Math.hypot(h[kind].point.x - drop.x, h[kind].point.y - drop.y) < 0.01);
            });
        }));
        // Parallel: two leads dragged to 45 degrees on corridors with DIFFERENT
        // offsets end up with the same angle -- which is the point.
    });
});
check("the route assertions actually ran", routed >= 100, "ran " + routed);

// --- 2b. Why the other lead is pinned ---------------------------------------
(() => {
    const c = { id: "S->T", source: "S", target: "T", value: 40, isSelfLoop: false, flows: [],
        segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "West" };
    const L = { nodes: new Map([["S", node("S", 100, 300, 14, 40)], ["T", node("T", 900, 440, 14, 40)]]),
        corridors: [c], valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200 };
    const o = { portLeadInPercent: 20, curvaturePercent: 35, style: "Octilinear" };
    const h0 = R.routeDiagram(L, o).handles.get("S->T");
    const drop = I.snapLeadToAngle({ x: h0.source.point.x + 110, y: 0 }, h0.source.angleSnap, 45);
    const alone = R.routeDiagram(L, o, new Map([["S->T", { source: drop }]])).handles.get("S->T");
    const pinned = R.routeDiagram(L, o, new Map([["S->T", { source: drop, target: h0.target.point }]])).handles.get("S->T");
    check("storing the dragged lead alone would move the drop (why the other is pinned)",
        Math.abs(alone.source.point.x - drop.x) > 1, "moved " + (alone.source.point.x - drop.x).toFixed(1) + "px");
    check("with the other lead pinned the drop lands exactly", Math.abs(pinned.source.point.x - drop.x) < 0.01);
})();

// --- 3. The bend keeps a snapped angle ---------------------------------------
(() => {
    const a = node("S", 100, 300, 14, 40), b = node("T", 900, 440, 14, 40);
    const corridor = {
        id: "S->T", source: "S", target: "T", value: 40, isSelfLoop: false, flows: [],
        segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "West"
    };
    const layout = { nodes: new Map([["S", a], ["T", b]]), corridors: [corridor], valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200 };
    const opt = { portLeadInPercent: 20, curvaturePercent: 35, style: "Octilinear" };
    const h0 = R.routeDiagram(layout, opt).handles.get("S->T");
    const drop = I.snapLeadToAngle({ x: h0.source.point.x + 150, y: 0 }, h0.source.angleSnap, 45);
    const snapped = R.routeDiagram(layout, opt, new Map([["S->T", { source: drop, target: h0.target.point }]])).handles.get("S->T");
    // Exactly what visual.ts's slideBend writes: both leads moved by one
    // delta. Kept within the far lead's range (it sits at 60px, minimum 21):
    // slid past that minimum the angle is DOCUMENTED to open up -- the agreed call,
    // the only way to get a Z reaching out beyond the node -- which is not
    // what this is testing.
    // In Octilinear the untouched diagonal is already fitted to 45 degrees,
    // so the drop above lands on the next step (a 90-degree step). The bend
    // must hold WHATEVER angle it starts at, 45 or 90.
    const slideFrom = (h, delta) => R.routeDiagram(layout, opt, new Map([["S->T", {
        source: { x: h.source.point.x + delta, y: h.source.point.y },
        target: { x: h.target.point.x + delta, y: h.target.point.y }
    }]])).handles.get("S->T");
    [[h0, "the fitted 45-degree default"], [snapped, "a dropped 90-degree step"]].forEach(([from, name]) => {
        const before = diagonalAngle(from.source.point, from.target.point, NORM.East);
        const after = slideFrom(from, 30);
        check("sliding the bend holds " + name,
            Math.abs(diagonalAngle(after.source.point, after.target.point, NORM.East) - before) < 0.05,
            before.toFixed(2) + " -> " + diagonalAngle(after.source.point, after.target.point, NORM.East).toFixed(2));
    });
})();

// --- 4. Only Polyline's diagonals --------------------------------------------
(() => {
    const a = node("S", 100, 300, 14, 40), b = node("T", 900, 440, 14, 40);
    const make = (sp, tp) => ({
        nodes: new Map([["S", a], ["T", b]]),
        corridors: [{ id: "S->T", source: "S", target: "T", value: 40, isSelfLoop: false, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp }],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    });
    ["Polyline", "Smooth", "Orthogonal"].forEach(style => {
        const h = R.routeDiagram(make("East", "West"), { portLeadInPercent: 20, curvaturePercent: 35, style }).handles.get("S->T");
        check("no angle snap in " + style, (!h.source || !h.source.angleSnap) && (!h.target || !h.target.angleSnap));
    });
    const loop = {
        nodes: new Map([["S", a]]),
        corridors: [{ id: "S->S", source: "S", target: "S", value: 40, isSelfLoop: true, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: "East", targetPort: "West" }],
        valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200
    };
    const hl = R.routeDiagram(loop, { portLeadInPercent: 20, curvaturePercent: 35, style: "Octilinear" }).handles.get("S->S");
    check("no angle snap on a self-loop", !hl.source.angleSnap && !hl.target.angleSnap);
})();

// --- 5. Octilinear FITS every diagonal, untouched ones included -------------
// switching to the style should push the existing leads to fit 45. Every
// same-axis diagonal comes out on 45 (or a 90-degree step where 45 won't
// fit), its midpoint where Polyline would have put it, its leads never below
// the minimum -- and everything that is not a diagonal identical to Polyline.
let fitted = 0;
(() => {
    const PORTS = ["North", "South", "East", "West"];
    const layouts = [[node("A", 100, 400, 14, 40), node("B", 700, 150, 14, 90)], [node("A", 100, 300, 14, 40), node("B", 900, 320, 14, 40)],
        [node("A", 100, 300, 14, 40), node("B", 700, 520, 14, 40)], [node("A", 300, 100, 40, 14), node("B", 480, 700, 40, 14)],
        [node("A", 100, 300, 14, 40), node("B", 380, 700, 14, 40)]];
    layouts.forEach(([a, b]) => PORTS.forEach(sp => PORTS.forEach(tp => [0, 35, 100].forEach(cv => {
        const c = { id: "A->B", source: "A", target: "B", value: 40, isSelfLoop: false, flows: [],
            segments: [{ flowType: undefined, value: 40, flows: [] }], sourcePort: sp, targetPort: tp };
        const L = { nodes: new Map([["A", a], ["B", b]]), corridors: [c], valueToPixels: v => Math.max(4, v), columnGap: 300, rowPitch: 200 };
        const oct = R.routeDiagram(L, { portLeadInPercent: 20, curvaturePercent: cv, style: "Octilinear" });
        const poly = R.routeDiagram(L, { portLeadInPercent: 20, curvaturePercent: cv, style: "Polyline" });
        const ho = oct.handles.get("A->B"), hp = poly.handles.get("A->B");
        const label = sp + "->" + tp + " at Curvature " + cv;
        // `gesture` means "not stored; the drag writes other handles", which
        // is true of a DIAGONAL's bend and,, of a question
        // mark's middle line as well. The elbow is what tells them apart, and
        // it comes from routing rather than being guessed from the style --
        // the same lesson as telling a bend from a lane.
        if (!(ho.middle && ho.middle.gesture) || ho.elbow) {
            check(label + ": off the diagonal, Octilinear is Polyline", oct.bands[0].path === poly.bands[0].path);
            return;
        }
        fitted++;
        const angle = diagonalAngle(ho.source.point, ho.target.point, NORM[sp]);
        const aligned = Math.abs(angle) < 0.05;
        check(label + ": the untouched diagonal is fitted to 45 or a 90-degree step",
            aligned || Math.abs(angle - 45) < 0.05 || Math.abs(angle - 90) < 0.05, angle.toFixed(3));
        const mid = h => ({ x: (h.source.point.x + h.target.point.x) / 2, y: (h.source.point.y + h.target.point.y) / 2 });
        check(label + ": its midpoint is where Polyline put it",
            Math.hypot(mid(ho).x - mid(hp).x, mid(ho).y - mid(hp).y) < 0.01);
        const lead = (h, kind, anchor, port) => (h[kind].point.x - anchor.x) * NORM[port].x + (h[kind].point.y - anchor.y) * NORM[port].y;
        const minimum = ho.source.angleSnap.minLead;
        check(label + ": neither lead goes below the minimum",
            lead(ho, "source", oct.bands[0].start, sp) >= minimum - 0.01 && lead(ho, "target", oct.bands[0].end, tp) >= minimum - 0.01);
    }))));
})();
check("the fit assertions actually ran", fitted >= 20, "ran " + fitted);

console.log((failures === 0 ? "PASS" : "FAIL") + " angle-snap-check: " + routed + " routed drops, " + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
