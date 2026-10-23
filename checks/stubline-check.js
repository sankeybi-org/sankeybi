"use strict";
// The packing order follows a dragged handle.
//
// This file exists because that rule had NO check of its own: nothing in the
// suite failed if it stopped working, and it is ~200 lines deciding which
// corridor sits where on every face an author has touched. The three things
// the design notes asked for are sections 1-3 here.
//
// The order is read back from the ROUTED output -- which corridor ends up at
// which anchor along a face -- rather than by calling the ordering directly,
// so a change that produces the right list and draws the wrong picture still
// fails.
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeDiagram } = require("./routing-api.js");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort",
    "sourceNodeColour", "targetNodeColour"];

function pipeline(rows, w = 1200, h = 700) {
    const dv = {
        table: {
            columns: ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
        }
    };
    const { flows } = parseDataView(dv);
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    return {
        layout: computeLayout(graph, corridors, w, h, { legendVisible: false, legendPosition: "Bottom" }),
        corridors
    };
}

const opts = style => ({ portLeadInPercent: 18, curvaturePercent: 35, style, avoidNodes: true });

/**
 * Which ends sit on one face, in the order they are packed along it -- read
 * off the drawn anchors, which is what the author sees.
 */
function faceOrder(routing, corridors, nodeId, port) {
    const vertical = port === "East" || port === "West";
    const ends = [];
    corridors.forEach(c => {
        const spine = routing.spines.get(c.id);
        if (!spine) { return; }
        if (c.source === nodeId && c.sourcePort === port) {
            ends.push([`${c.id}/source`, spine[0]]);
        }
        if (c.target === nodeId && c.targetPort === port) {
            ends.push([`${c.id}/target`, spine[spine.length - 1]]);
        }
    });
    return ends
        .sort((a, b) => (vertical ? a[1].y - b[1].y : a[1].x - b[1].x))
        .map(([key]) => key);
}

/** Where one end sits along its face, in pixels. */
function slotOf(routing, corridors, id, role, port) {
    const spine = routing.spines.get(id);
    if (!spine) { return undefined; }
    const at = role === "source" ? spine[0] : spine[spine.length - 1];
    return (port === "East" || port === "West") ? at.y : at.x;
}

/**
 * **A hub with four ends on ONE face, and a second hub that nothing touches.**
 * Targets above, level with and below the hub, so the three stub-line segments
 * leave in different directions -- which is what Orthogonal's grouping is for.
 * The self-loop is `extremeKeys`' business and must keep its slot whatever the
 * rule decides about the rest.
 */
const HUB = [
    { flowID: "F1", source: "H", target: "T1", value: 30, sourceColumn: 1, sourceRow: 3, targetColumn: 3, targetRow: 1 },
    { flowID: "F2", source: "H", target: "T2", value: 30, sourceColumn: 1, sourceRow: 3, targetColumn: 3, targetRow: 3 },
    { flowID: "F3", source: "H", target: "T3", value: 30, sourceColumn: 1, sourceRow: 3, targetColumn: 3, targetRow: 5 },
    { flowID: "L", source: "H", target: "H", value: 10, sourceColumn: 1, sourceRow: 3, sourcePort: "East", targetPort: "West" },
    // A second hub, far away, whose face must be left alone entirely.
    { flowID: "G1", source: "K", target: "U1", value: 30, sourceColumn: 1, sourceRow: 8, targetColumn: 3, targetRow: 7 },
    { flowID: "G2", source: "K", target: "U2", value: 30, sourceColumn: 1, sourceRow: 8, targetColumn: 3, targetRow: 9 },
    { flowID: "G3", source: "K", target: "U3", value: 30, sourceColumn: 1, sourceRow: 8, targetColumn: 3, targetRow: 11 }
];

const { layout, corridors } = pipeline(HUB);
const idOf = name => {
    const found = corridors.find(c => c.id === name);
    return found && found.id;
};
// **The MIDDLE corridor of the fan, not the top one**. Dragging
// a handle moves it along the port normal, which swings that end's key 1 --
// and H->T1 is already the most negative angle on this face, so pushing it
// further out only makes it more negative and it can never cross a
// neighbour. H->T2 sits between T1 and T3 and shares a cluster with T3, so
// its key 2 decides against a real rival. This passed for a
// reason that had nothing to do with the drag: the baseline came from the
// crossing sweep, and merely switching the stub-line rule ON reordered the
// face. With the rule now deciding every face, base and dragged are both its
// answer, so a drag has to earn the change.
const LOOP = idOf("H→H");

// A drag that is known to move each style's order: Orthogonal answers its
// STEP, Octilinear its LEAD. Both on the same face, each on the corridor
// that style's own handle can actually move.
//
// **Octilinear drags T3 OUT rather than T2 in**: a lead has a minimum
// length, so dragging one inward clamps before it travels far enough to
// cross a neighbour's key 2. Pushing the corridor BELOW it further out
// produces the same swap with a drag nothing clamps.
const DRAGS = {
    Orthogonal: ["H→T2", "middle", -400],
    // 200 and not more: past that T3's lead swings its angle out of the
    // 45-degree cluster it shares with T2, so key 2 stops comparing them
    // and the face settles back. A narrow window, but a real one.
    Octilinear: ["H→T3", "source", 200]
};
const draggedId = style => idOf(DRAGS[style][0]);

function draggedOverrides(style, base) {
    const [, kind, delta] = DRAGS[style];
    const handle = base.handles.get(draggedId(style))[kind];
    if (!handle) { return undefined; }
    const point = handle.axis === "x"
        ? { x: handle.point.x + delta, y: handle.point.y }
        : { x: handle.point.x, y: handle.point.y + delta };
    return new Map([[draggedId(style), { [kind]: point }]]);
}

// ===================================================================
// 1. A dragged face reorders -- and a face with nothing dragged on it
//    does not. **The second half used to be a GATE** (`stubLineOrder`
//    repacked only faces carrying a dragged end) and it is
//    a consequence instead: the rule runs on every face, but it is a
//    function of the routes, and a face whose routes did not move gets the
//    same answer. Worth keeping either way -- it is the property an author
//    notices, and it would now catch the rule going non-deterministic.
// ===================================================================
console.log("--- a dragged face reorders, an untouched one does not ---");
let reordered = 0;
["Orthogonal", "Octilinear"].forEach(style => {
    const base = routeDiagram(layout, opts(style), new Map());
    const overrides = draggedOverrides(style, base);
    check(`${style}: the corridor being dragged has that handle`, !!overrides);
    if (!overrides) { return; }
    const after = routeDiagram(layout, opts(style), overrides);

    const before = faceOrder(base, corridors, "H", "East");
    const now = faceOrder(after, corridors, "H", "East");
    check(`${style}: the dragged face has several ends to order (${before.length})`, before.length >= 3);
    if (before.join("|") !== now.join("|")) { reordered++; }
    check(`${style}: the dragged face is repacked`, before.join("|") !== now.join("|"),
        `${before.join(" ")}  ->  ${now.join(" ")}`);

    // The far hub carries no dragged end, so its face must be untouched --
    // not merely similar, identical.
    const farBefore = faceOrder(base, corridors, "K", "East");
    const farNow = faceOrder(after, corridors, "K", "East");
    check(`${style}: the far face has ends of its own (${farBefore.length})`, farBefore.length >= 3);
    check(`${style}: a face with nothing dragged on it is left alone`,
        farBefore.join("|") === farNow.join("|"), farNow.join(" "));
    // And identical to the digit, not just in order.
    const farSame = farBefore.every((key, i) => {
        const [id, role] = key.split("/");
        return Math.abs(slotOf(base, corridors, id, role, "East")
            - slotOf(after, corridors, id, role, "East")) < 1e-9;
    });
    check(`${style}: and its anchors have not moved at all`, farSame);
});
check(`the repack was actually exercised (${reordered} of 2 styles reordered)`, reordered === 2);

// ===================================================================
// 2. Orthogonal takes its own path. Its leads come from the Port lead-in
//    setting and cannot be dragged, so key 1 never answers the author and
//    the STEP is the only thing they can say -- where every other style
//    reads the lead. Grouping by direction rather than by a 5-degree
//    cluster is the other half of that, and making Octilinear follow it
//    took its crossings from 390 to 902 (the design notes).
// ===================================================================
console.log("--- Orthogonal answers the step, the others answer the lead ---");
{
    // The LOOP is left out of this comparison. it is ordered
    // by its first corner like everything else, and the live set is per FACE
    // -- so any drag on this face re-slots it, whether or not the style read
    // the handle that was dragged. Including it here answered "did anything
    // move" when the question is "did the style READ this handle".
    const speaks = (style, kind) => {
        const others = keys => keys.filter(k => !k.startsWith(`${LOOP}/`));
        const base = routeDiagram(layout, opts(style), new Map());
        const id = draggedId(style);
        const handle = base.handles.get(id)[kind];
        if (!handle) { return false; }
        const before = others(faceOrder(base, corridors, "H", "East")).join("|");
        // Both ways along this style's own known-good magnitude, so a drag
        // that happens to land on the same order is not read as silence.
        const step = DRAGS[style][2];
        return [step, -step].some(delta => {
            const point = handle.axis === "x"
                ? { x: handle.point.x + delta, y: handle.point.y }
                : { x: handle.point.x, y: handle.point.y + delta };
            const after = routeDiagram(layout, opts(style), new Map([[id, { [kind]: point }]]));
            return others(faceOrder(after, corridors, "H", "East")).join("|") !== before;
        });
    };
    check("Orthogonal: the STEP reorders its face", speaks("Orthogonal", "middle"));
    check("Orthogonal: its leads do not, because it does not offer them",
        !speaks("Orthogonal", "source") && !speaks("Orthogonal", "target"));
    check("Octilinear: the LEAD reorders its face", speaks("Octilinear", "source"));
    check("Octilinear: its middle does not, being a bend rather than a stored step",
        !speaks("Octilinear", "middle"));
}

// ===================================================================
// 2b. ...and Octilinear does NOT group by direction (measured,
//     and the opposite of what was expected: its 45-degree snap already
//     pulls near-square segments to the same angle, so its clusters are
//     meaningful and its angle key is the most accurate of the four.
//     Making it follow Orthogonal took its crossings from 390 to 902).
//
//     The observable difference, on a face of eight ends at a spread of
//     angles: clustering by 5-degree proximity RELOCATES the dragged end
//     and leaves the rest in their relative order, because only the
//     cluster it joins is re-sorted. Grouping by direction re-sorts the
//     whole same-sign group -- measured on this exact drag, 7 of the 8
//     ends move. A fixture chosen because the two disagree here: over the
//     sweep that found it, 266 drags separate them.
// ===================================================================
console.log("--- Octilinear clusters by angle, not by direction ---");
{
    const FAN = [1, 2, 3, 5, 6, 7, 9, 11].map((row, i) => ({
        flowID: `N${i}`, source: "H", target: `T${i}`, value: 20,
        sourceColumn: 1, sourceRow: 6, targetColumn: 4, targetRow: row
    }));
    const fan = pipeline(FAN);
    const style = "Octilinear";
    const base = routeDiagram(fan.layout, opts(style), new Map());
    const before = faceOrder(base, fan.corridors, "H", "East");
    check(`the fan has eight ends on one face (${before.length})`, before.length === 8);

    const dragged = fan.corridors.find(c => c.id === "H→T0").id;
    const lead = base.handles.get(dragged).source;
    check("the fan's dragged corridor has a lead", !!lead);
    if (lead) {
        const after = routeDiagram(fan.layout, opts(style),
            new Map([[dragged, { source: { x: lead.point.x - 150, y: lead.point.y } }]]));
        const now = faceOrder(after, fan.corridors, "H", "East");
        const key = `${dragged}/source`;
        check("the drag moved the end that was dragged",
            before.indexOf(key) !== now.indexOf(key),
            `${before.indexOf(key)} -> ${now.indexOf(key)}`);
        // Everything else keeps its relative order: only the cluster the
        // dragged segment joined is re-sorted.
        const without = list => list.filter(k => k !== key).join("|");
        check("and left every other end in its relative order",
            without(before) === without(now),
            `${without(now)}`);
    }
}


// ===================================================================
// **Section 3 went**: "pinned ends keep their slots", which
// asserted that a self-loop and a wrap were placed by `extremeKeys` and
// left alone here. There are no pinned ends any more -- a loop is ordered
// by its first corner on the same terms as everything else, and the
// property that it sits at an extreme of its face is not one the model
// promises.
//
// 4. The order is a permutation: repacking a face may not lose, duplicate
//    or invent an end, and may not leave two ends on the same slot.
// ===================================================================
console.log("--- the repacked face is still a packing ---");
["Orthogonal", "Octilinear"].forEach(style => {
    const base = routeDiagram(layout, opts(style), new Map());
    const overrides = draggedOverrides(style, base);
    if (!overrides) { return; }
    const after = routeDiagram(layout, opts(style), overrides);
    const before = faceOrder(base, corridors, "H", "East");
    const now = faceOrder(after, corridors, "H", "East");
    check(`${style}: the same ends, rearranged`,
        before.length === now.length && before.every(k => now.includes(k))
        && new Set(now).size === now.length);
    // Every end keeps a slot that some end held before: the face packs into
    // the same places, it just assigns them differently.
    const slots = before.map(k => {
        const [id, role] = k.split("/");
        return slotOf(base, corridors, id, role, "East");
    }).sort((a, b) => a - b);
    const nowSlots = now.map(k => {
        const [id, role] = k.split("/");
        return slotOf(after, corridors, id, role, "East");
    }).sort((a, b) => a - b);
    check(`${style}: and into the same slots`,
        slots.length === nowSlots.length
        && slots.every((v, i) => Math.abs(v - nowSlots[i]) < 1e-6),
        `${slots.map(v => v.toFixed(0)).join(",")} vs ${nowSlots.map(v => v.toFixed(0)).join(",")}`);
});

check(`enough assertions ran (${assertions})`, assertions >= 25);

if (failures === 0) {
    console.log("\nALL STUB-LINE ORDER CHECKS PASSED");
} else {
    console.log(`\n${failures} STUB-LINE ORDER CHECK(S) FAILED`);
    process.exit(1);
}
