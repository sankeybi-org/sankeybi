"use strict";
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors, computeAnchors, anchorKey } = require("./routing-api.js");

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort",
    "sourceNodeColour", "targetNodeColour"];

function dataViewOf(rows) {
    return {
        table: {
            columns: ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
        }
    };
}
const CHROME = {
    legendVisible: false, legendPosition: "Bottom"
};

function pipeline(rows, viewport = { w: 1400, h: 800 }) {
    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, viewport.w, viewport.h, CHROME);
    return { graph, corridors, layout, anchors: computeAnchors(layout) };
}

// --- an independent crossing counter, written from the geometry rather
//     than shared with routing.ts, so a bug in one doesn't hide in both ---
function turn(p, q, r) {
    return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}
function crosses(a1, a2, b1, b2) {
    const d1 = turn(b1, b2, a1), d2 = turn(b1, b2, a2);
    const d3 = turn(a1, a2, b1), d4 = turn(a1, a2, b2);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
        && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}
function crossingCount(anchors, corridors) {
    const chords = corridors
        .filter(c => !c.isSelfLoop)
        .map(c => ({
            s: anchors.get(anchorKey(c.id, "source")),
            t: anchors.get(anchorKey(c.id, "target")),
            id: c.id
        }))
        .filter(c => c.s && c.t);
    const pairs = [];
    for (let i = 0; i < chords.length; i++) {
        for (let j = i + 1; j < chords.length; j++) {
            if (crosses(chords[i].s.point, chords[i].t.point, chords[j].s.point, chords[j].t.point)) {
                pairs.push(`${chords[i].id} x ${chords[j].id}`);
            }
        }
    }
    return pairs;
}

/**
 * The behaviour the ordering pass replaced: one pass, each edge keyed on the
 * other NODE's centre. Rebuilt here rather than kept behind a flag in
 * routing.ts, so the comparison can't drift as the real code changes.
 */
function firstPassAnchors(layout, corridors) {
    const nodes = layout.nodes;
    const groups = new Map();
    corridors.forEach(c => {
        [["source", c.source, c.sourcePort], ["target", c.target, c.targetPort]].forEach(([role, id, port]) => {
            const key = `${id}|${port}`;
            if (!groups.has(key)) groups.set(key, { id, port, ends: [] });
            groups.get(key).ends.push({ c, role });
        });
    });
    const anchors = new Map();
    groups.forEach(g => {
        const node = nodes.get(g.id);
        if (!node) return;
        const vertical = g.port === "East" || g.port === "West";
        const packable = g.ends.filter(e => e.c.value > 0);
        if (!packable.length) return;
        const key = e => {
            const other = nodes.get(e.role === "source" ? e.c.target : e.c.source);
            if (!other) return 0;
            return vertical ? other.y + other.height / 2 : other.x + other.width / 2;
        };
        const ordered = [...packable].sort((a, b) => key(a) - key(b));
        const extent = vertical ? node.height : node.width;
        const origin = vertical ? node.y : node.x;
        // Exactly packPort's widths -- no scaling to fit, since a node is
        // sized from this same stack. The ONE thing this baseline does
        // differently from production is the ORDER, which is the whole point:
        // any other difference would be a second variable in the comparison.
        const widths = ordered.map(e => layout.valueToPixels(e.c.value));
        const packed = widths.reduce((s, w) => s + w, 0);
        let cursor = origin + (extent - packed) / 2;
        ordered.forEach((e, i) => {
            const centre = cursor + widths[i] / 2;
            cursor += widths[i];
            const point = g.port === "East" ? { x: node.x + node.width, y: centre }
                : g.port === "West" ? { x: node.x, y: centre }
                : g.port === "North" ? { x: centre, y: node.y }
                : { x: centre, y: node.y + node.height };
            anchors.set(anchorKey(e.c.id, e.role), { point });
        });
    });
    return anchors;
}
const firstPassCrossings = (layout, corridors) =>
    crossingCount(firstPassAnchors(layout, corridors), corridors);

/** Slot order along a port edge, top-to-bottom (or left-to-right). */
function orderAt(anchors, corridors, nodeId, port) {
    const vertical = port === "East" || port === "West";
    return corridors
        .flatMap(c => [
            { c, role: "source", node: c.source, port: c.sourcePort },
            { c, role: "target", node: c.target, port: c.targetPort }
        ])
        .filter(e => e.node === nodeId && e.port === port)
        .map(e => ({ id: e.c.id, a: anchors.get(anchorKey(e.c.id, e.role)) }))
        .filter(e => e.a)
        .sort((p, q) => (vertical ? p.a.point.y - q.a.point.y : p.a.point.x - q.a.point.x))
        .map(e => e.id);
}

// ===============================================================
// 1. The canonical crossing: two parallel corridors whose targets
//    are in the opposite row order to their sources.
// ===============================================================
{
    // A (row 1) -> Q (row 2), B (row 2) -> P (row 1). Packed naively by
    // insertion order these chords cross; ordered by the other end they don't.
    const rows = [
        { source: "A", target: "Q", value: 50, sourceColumn: 1, sourceRow: 1, targetColumn: 2, targetRow: 2 },
        { source: "B", target: "P", value: 50, sourceColumn: 1, sourceRow: 2, targetColumn: 2, targetRow: 1 }
    ];
    const { anchors, corridors } = pipeline(rows);
    check("two corridors between distinct node pairs cross when the data says so",
        crossingCount(anchors, corridors).length === 1, crossingCount(anchors, corridors).join(", "));
}
{
    // The case reordering CAN fix: one node fanning out to targets declared
    // in the reverse of their row order. Ordering the source's edge by target
    // row is what removes the crossing -- there is no competing source whose
    // own row order could reintroduce one.
    const rows = [
        { source: "H", target: "Low", value: 50, sourceColumn: 1, sourceRow: 2, targetColumn: 2, targetRow: 3 },
        { source: "H", target: "High", value: 50, sourceColumn: 1, sourceRow: 2, targetColumn: 2, targetRow: 1 },
        { source: "H", target: "Mid", value: 20, sourceColumn: 1, sourceRow: 2, targetColumn: 2, targetRow: 2 }
    ];
    const { anchors, corridors } = pipeline(rows);
    const found = crossingCount(anchors, corridors);
    check("a fan-out declared in reverse row order ends up uncrossed", found.length === 0, found.join(", "));

    // And the slot order on H's East edge really is top-to-bottom by target row.
    const order = orderAt(anchors, corridors, "H", "East");
    check("H's East edge packs High, Mid, Low in that order",
        order.length === 3 && order[0].includes("High") && order[1].includes("Mid") && order[2].includes("Low"),
        order.join(" | "));
}

// ===============================================================
// 2. A dense bipartite fan -- the sweep should leave few crossings
//    and must never leave MORE than the plain first-pass heuristic.
// ===============================================================
{
    const rows = [];
    const sources = ["S1", "S2", "S3", "S4"];
    const targets = ["T1", "T2", "T3", "T4"];
    // Deliberately declared in an order unrelated to the row layout.
    sources.forEach((s, i) => {
        targets.forEach((t, j) => {
            if ((i + j) % 2 === 0) {
                rows.push({
                    source: s, target: t, value: 10 + i * 3 + j,
                    sourceColumn: 1, sourceRow: sources.length - i,
                    targetColumn: 2, targetRow: j + 1
                });
            }
        });
    });
    const { anchors, corridors, layout } = pipeline(rows);
    const found = crossingCount(anchors, corridors);
    const before = firstPassCrossings(layout, corridors);
    console.log(`      dense fan: ${corridors.length} corridors, ${before.length} -> ${found.length} crossings`);
    check("a dense fan still routes every corridor",
        routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" }).length >= corridors.length);
    // No absolute target: most crossings in a dense fan come from the NODES'
    // row order, which anchor reordering cannot touch. The only honest
    // assertion is that reordering doesn't make it worse.
    check("a dense fan is never made worse by reordering", found.length <= before.length,
        `${before.length} -> ${found.length}`);
}

// ===============================================================
// 2b. Regression: a shape the sweep measurably improves. Found by
//     randomised search (a one-off probe, since deleted) -- without a case like this
//     the whole pass could silently become a no-op and every other
//     check here would still pass.
//
//     Re-derived, when MIN_CORRIDOR_WIDTH went 4px -> 2px. The
//     old spec was found under the 4px floor, where it saved 4 crossings;
//     with fewer corridors sitting on the floor the anchors pack differently
//     and the same shape saved only 3, which is not a margin worth asserting
//     on. The replacement saves 22 of 34 -- a far better guard, and enough
//     headroom that a future geometry change won't make it brittle.
// ===============================================================
{
    const spec = [
        ["S0", "T1", 81, 2, 2], ["S0", "T2", 56, 1, 2], ["S0", "T3", 29, 3, 2], ["S1", "T0", 64, 2, 2],
        ["S1", "T1", 7, 3, 3], ["S1", "T2", 32, 3, 1], ["S1", "T3", 34, 2, 4], ["S2", "T0", 9, 2, 4],
        ["S2", "T1", 45, 2, 4], ["S2", "T2", 9, 2, 4], ["S2", "T3", 51, 2, 2]
    ];
    const rows = spec.map(([source, target, value, sourceRow, targetRow]) => ({
        source, target, value, sourceColumn: 1, sourceRow, targetColumn: 2, targetRow
    }));
    const { anchors, corridors, layout } = pipeline(rows, { w: 1200, h: 700 });
    const before = firstPassCrossings(layout, corridors).length;
    const after = crossingCount(anchors, corridors).length;
    check("the known-improvable shape is measurably better than the old heuristic",
        after < before, `${before} -> ${after}`);
    check("...and improves by a worthwhile margin, not by one", before - after >= 10,
        `saved ${before - after}`);
}

// ===============================================================
// 2c. The sweep only moves what it can measure.
//
//     Crossings are scored on the straight chord between a corridor's
//     anchors, which is only honest for a route that follows it. A wrap
//     route exits away from its destination and comes back round the far
//     side; a self-loop's chord is a stub across one node. Reordering
//     either optimises a number that doesn't describe them -- a real
//     defect, found live: a West->North heat return was moved to the top
//     of its node's West edge on a chord score while the diagram got
//     visibly worse.
// ===============================================================
{
    // Built on the shape from 2b, which the sweep is known to reorder, so
    // the pinning below is tested somewhere the sweep is actually active.
    const rows = [
        ["S0", "T0", 78, 2, 1], ["S0", "T1", 16, 2, 4], ["S0", "T2", 44, 3, 2], ["S0", "T3", 5, 3, 2],
        ["S1", "T2", 77, 1, 3], ["S1", "T3", 38, 1, 3], ["S2", "T0", 14, 1, 1], ["S2", "T1", 80, 3, 2],
        ["S2", "T2", 15, 3, 2], ["S2", "T3", 65, 1, 4]
    ].map(([source, target, value, sourceRow, targetRow]) => ({
        source, target, value, sourceColumn: 1, sourceRow, targetColumn: 2, targetRow
    }));
    // A wrap: leaves East but its target is to the WEST, so the band has to
    // double back and its chord says nothing about where it goes.
    rows.push({ source: "T0", target: "S0", value: 20, sourcePort: "East", targetPort: "West" });
    // And a self-loop sharing an edge with real corridors.
    rows.push({ source: "S0", target: "S0", value: 10, sourcePort: "East", targetPort: "South" });

    const { anchors, corridors, layout } = pipeline(rows, { w: 1200, h: 700 });
    const first = firstPassAnchors(layout, corridors);
    const coordOf = (map, id, role, port) => {
        const a = map.get(anchorKey(id, role));
        if (!a) return undefined;
        return (port === "East" || port === "West") ? a.point.y : a.point.x;
    };
    const movedIn = (cs, keep) => {
        let n = 0;
        cs.filter(keep).forEach(c => {
            [["source", c.sourcePort], ["target", c.targetPort]].forEach(([role, port]) => {
                const now = coordOf(anchors, c.id, role, port);
                const was = coordOf(first, c.id, role, port);
                if (now !== undefined && was !== undefined && Math.abs(now - was) > 0.01) n++;
            });
        });
        return n;
    };
    // The sweep must actually be active here, or everything below passes for
    // the wrong reason.
    const isPinned = c => c.isSelfLoop || (c.source === "T0" && c.target === "S0");
    check("the sweep reorders direct corridors in this diagram", movedIn(corridors, c => !isPinned(c)) > 0,
        `${movedIn(corridors, c => !isPinned(c))} ends moved`);

    // Note what is NOT asserted here: that a pinned corridor's anchor sits at
    // the same pixel. It can't — slots pack sequentially along an edge, so
    // when a scoreable neighbour legitimately reorders, everything on that
    // edge repacks around it. What's pinned is the pinned corridor's SORT KEY,
    // and the observable consequence of that is the next case.
}
{
    // **This used to assert that a diagram with nothing scoreable in it came
    // out exactly as the first pass left it** -- true while `extremeKeys`
    // placed every wrap and self-loop by sentinel key and the sweep then left
    // them alone. there are no sentinels and `stubLineOrder`
    // orders every face from the drawn routes, so an all-wrap diagram IS
    // reordered, deliberately. What is still true is that the result is a
    // packing: every end gets its own slot, and the thing routes.
    const rows = [
        { source: "A", target: "B", value: 30, sourcePort: "East", targetPort: "West", sourceColumn: 2, sourceRow: 1, targetColumn: 1, targetRow: 1 },
        { source: "A", target: "C", value: 20, sourcePort: "East", targetPort: "West", sourceColumn: 2, sourceRow: 1, targetColumn: 1, targetRow: 2 },
        { source: "A", target: "D", value: 25, sourcePort: "East", targetPort: "West", sourceColumn: 2, sourceRow: 1, targetColumn: 1, targetRow: 3 },
        { source: "A", target: "A", value: 10, sourcePort: "North", targetPort: "South" },
        { source: "B", target: "B", value: 8, sourcePort: "East", targetPort: "South" }
    ];
    const { anchors, corridors, layout } = pipeline(rows);

    const seen = new Map();
    let clashes = [];
    anchors.forEach((a, key) => {
        const at = `${a.point.x.toFixed(3)},${a.point.y.toFixed(3)}`;
        if (seen.has(at)) { clashes.push(`${key} on ${seen.get(at)}`); }
        seen.set(at, key);
    });
    check("an all-wrap diagram still packs every end into its own slot",
        clashes.length === 0, clashes.join(", "));
    check("...and it had anchors to place", anchors.size >= 6, `${anchors.size} anchors`);

    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
    check("an all-wrap diagram still routes", bands.length >= corridors.length,
        `${bands.length} bands, ${corridors.length} corridors`);
}

// ===============================================================
// 2d. Corridors of very different LENGTH leaving one face.
//
//     found in use. Ordering by the other end's position is only
//     right when corridors run roughly parallel. Here a near, low
//     target and a far, lower one leave in one order and arrive in
//     the same order -- yet cross in the middle, because the near one
//     has to dive steeply while the far one descends gently. Sorting
//     by DEPARTURE ANGLE is what keeps them apart.
// ===============================================================
{
    const rows = [
        { source: "In", target: "Grid", value: 200, sourceColumn: 1, sourceRow: 1, targetColumn: 2, targetRow: 1 },
        // Near and low: a steep dive.
        { source: "Grid", target: "Heating", value: 40, targetColumn: 3, targetRow: 5 },
        // Far and lower still: a gentle slope.
        { source: "Grid", target: "Buildings", value: 120, targetColumn: 6, targetRow: 6 }
    ];
    const { anchors, corridors, layout } = pipeline(rows);
    const found = crossingCount(anchors, corridors);
    check("a steep short corridor and a shallow long one don't cross", found.length === 0,
        found.join(", "));

    // The steep one takes the LOWER slot even though its node is higher --
    // that inversion is the whole point, so state it explicitly.
    const order = orderAt(anchors, corridors, "Grid", "East");
    const heating = layout.nodes.get("Heating");
    const buildings = layout.nodes.get("Buildings");
    check("...and the steep one is the lower of the two at the face",
        order[order.length - 1].includes("Heating"), order.join(" > "));
    check("...even though its node sits above the other's",
        heating.y + heating.height / 2 < buildings.y + buildings.height / 2,
        `Heating ${(heating.y + heating.height / 2).toFixed(0)} vs Buildings ${(buildings.y + buildings.height / 2).toFixed(0)}`);
}
{
    // The ordinary case must be unaffected: similar distances, so the angle
    // ordering and the position ordering agree.
    const rows = [
        { source: "In", target: "Grid", value: 200, sourceColumn: 1, sourceRow: 1, targetColumn: 2, targetRow: 3 },
        { source: "Grid", target: "Top", value: 40, targetColumn: 4, targetRow: 1 },
        { source: "Grid", target: "Middle", value: 40, targetColumn: 4, targetRow: 3 },
        { source: "Grid", target: "Bottom", value: 40, targetColumn: 4, targetRow: 5 }
    ];
    const { anchors, corridors } = pipeline(rows);
    const order = orderAt(anchors, corridors, "Grid", "East");
    check("equidistant targets still stack by their own row order",
        order[0].includes("Top") && order[1].includes("Middle") && order[2].includes("Bottom"),
        order.join(" > "));
    check("...and none of them cross", crossingCount(anchors, corridors).length === 0);
}

// ===============================================================
// 3. Determinism: identical input gives byte-identical anchors, and
//    the corridor DECLARATION order must not change the outcome.
// ===============================================================
{
    const rows = [
        { source: "A", target: "X", value: 30, sourceRow: 1, targetRow: 3 },
        { source: "A", target: "Y", value: 20, sourceRow: 1, targetRow: 1 },
        { source: "B", target: "X", value: 25, sourceRow: 2, targetRow: 3 },
        { source: "B", target: "Y", value: 15, sourceRow: 2, targetRow: 1 }
    ];
    const first = pipeline(rows);
    const second = pipeline(rows);
    const dump = r => Array.from(r.anchors.entries())
        .map(([k, a]) => `${k}:${a.point.x.toFixed(4)},${a.point.y.toFixed(4)}`)
        .sort().join("|");
    check("the same input twice gives identical anchors", dump(first) === dump(second));

    // Reversing the rows changes corridor insertion order but not the layout;
    // the ordering pass must reach the same slot assignment either way.
    const reversed = pipeline([...rows].reverse());
    const slots = r => orderAt(r.anchors, r.corridors, "A", "East").map(id => id.replace(/\s/g, "")).join(">");
    check("row order in the data doesn't change A's slot order",
        slots(first) === slots(reversed), `${slots(first)} vs ${slots(reversed)}`);
}

// ===============================================================
// 4. The guard: the sweep never accepts a worse ordering. Checked
//    across a spread of shapes, comparing against the FIRST-pass
//    heuristic the pass replaced.
// ===============================================================
{
    const shapes = {
        "reverse fan": [
            { source: "H", target: "A", value: 40, sourceRow: 1, targetRow: 4 },
            { source: "H", target: "B", value: 30, sourceRow: 1, targetRow: 3 },
            { source: "H", target: "C", value: 20, sourceRow: 1, targetRow: 2 },
            { source: "H", target: "D", value: 10, sourceRow: 1, targetRow: 1 }
        ],
        "bipartite mesh": [
            { source: "S1", target: "T1", value: 20, sourceRow: 1, targetRow: 3 },
            { source: "S1", target: "T2", value: 15, sourceRow: 1, targetRow: 1 },
            { source: "S2", target: "T1", value: 25, sourceRow: 2, targetRow: 3 },
            { source: "S2", target: "T2", value: 10, sourceRow: 2, targetRow: 1 },
            { source: "S3", target: "T1", value: 5, sourceRow: 3, targetRow: 3 },
            { source: "S3", target: "T2", value: 30, sourceRow: 3, targetRow: 1 }
        ],
        "three layers": [
            { source: "A", target: "M", value: 30, sourceRow: 1 },
            { source: "B", target: "M", value: 20, sourceRow: 2 },
            { source: "C", target: "N", value: 25, sourceRow: 3 },
            { source: "M", target: "Y", value: 50, targetRow: 2 },
            { source: "M", target: "X", value: 10, targetRow: 1 },
            { source: "N", target: "X", value: 25, targetRow: 1 }
        ],
        "mixed ports": [
            { source: "A", target: "G", value: 40, sourceRow: 1 },
            { source: "B", target: "G", value: 20, sourceRow: 2 },
            { source: "V", target: "G", value: 30, sourcePort: "South", targetPort: "North", sourceRow: 1, sourceColumn: 2 },
            { source: "G", target: "P", value: 45, targetRow: 1 },
            { source: "G", target: "Q", value: 45, targetRow: 3 },
            { source: "G", target: "G", value: 5, sourcePort: "East", targetPort: "South" }
        ]
    };

    Object.entries(shapes).forEach(([name, rows]) => {
        const { anchors, corridors, layout } = pipeline(rows);
        const after = crossingCount(anchors, corridors).length;
        const before = firstPassCrossings(layout, corridors).length;
        check(`${name}: never worse than the old single-pass heuristic`, after <= before,
            `${before} -> ${after}`);
        const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
        check(`${name}: all geometry still finite`,
            bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)));
    });
}

// ===============================================================
// 5. Packing invariants the sweep must not break: slots stay inside
//    the node, contiguous, and non-overlapping.
// ===============================================================
{
    const rows = [];
    for (let i = 0; i < 7; i++) {
        rows.push({ source: `S${i}`, target: "HUB", value: 5 + i * 11, sourceRow: 7 - i });
        rows.push({ source: "HUB", target: `T${i}`, value: 3 + i * 7, targetRow: i + 1 });
    }
    const { anchors, corridors, layout } = pipeline(rows);
    const hub = layout.nodes.get("HUB");

    ["West", "East"].forEach(port => {
        const ends = corridors
            .flatMap(c => [
                { c, role: "source", node: c.source, port: c.sourcePort },
                { c, role: "target", node: c.target, port: c.targetPort }
            ])
            .filter(e => e.node === "HUB" && e.port === port)
            .map(e => anchors.get(anchorKey(e.c.id, e.role)))
            .filter(Boolean)
            .sort((a, b) => a.point.y - b.point.y);

        const inside = ends.every(a =>
            a.point.y - a.halfExtent >= hub.y - 0.001 && a.point.y + a.halfExtent <= hub.y + hub.height + 0.001);
        check(`HUB ${port}: every slot stays inside the node`, inside, `${ends.length} slots`);

        let gaps = 0;
        for (let i = 1; i < ends.length; i++) {
            const prevEdge = ends[i - 1].point.y + ends[i - 1].halfExtent;
            const thisEdge = ends[i].point.y - ends[i].halfExtent;
            if (Math.abs(thisEdge - prevEdge) > 0.001) gaps++;
        }
        check(`HUB ${port}: slots are contiguous with no gaps or overlaps`, gaps === 0, `${gaps} discontinuities`);
    });

    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
    check("busy hub still routes every corridor", bands.length >= corridors.length,
        `${bands.length} bands, ${corridors.length} corridors`);
}

if (failures === 0) {
    console.log("\nALL CROSSING CHECKS PASSED");
} else {
    console.log(`\n${failures} CROSSING CHECK(S) FAILED`);
    process.exit(1);
}
