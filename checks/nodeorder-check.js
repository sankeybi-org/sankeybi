"use strict";
/**
 * nodeorder-check -- SourceOrder/TargetOrder: the author's node
 * order as a CONSTRAINT on the arrangement rather than a coordinate.
 *
 * The feature is a chain of three claims, and each section below takes one:
 *
 *  1. the role parses like every other node-level field (first non-blank wins,
 *     a clash warns) and, unlike a Column or a Row, has no floor at 1;
 *  2. the bare grid hands out places 1..n in the author's order, blanks after,
 *     and is byte-identical to the old pass where nothing is numbered;
 *  3. `holdAuthoredOrder` keeps that order through both arrangers -- groups
 *     contiguous, groups in the author's order, and everything the author did
 *     NOT say left to the objective: where each blank goes, and which member
 *     of a group comes first.
 *
 * **Section 4 is where the teeth are.** An assertion that "the order came out
 * as asked" passes trivially if the arranger would have produced it anyway, so
 * each integration case is run twice -- once with the role bound and once with
 * it stripped -- and the check asserts that the unconstrained run DISAGREES.
 * That is the practical form of "prove the check fails on the old code": the
 * old code is the same pass with nothing authored.
 */
const { dataView } = require("./dataview.js");
const { parseDataView } = require("./lib/dataParsing.js");
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");
const { holdAuthoredOrder } = require("./lib/layeredModel.js");
const { arrangeNodes } = require("./lib/arrangeNodes.js");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const ROLES = ["flowID", "source", "target", "value", "sourceOrder", "targetOrder"];

/** Rows as {flowID, source, target, value, sourceOrder, targetOrder} objects. */
function parse(rows, { withOrder = true } = {}) {
    const table = rows.map(r => ROLES.map(role => {
        if (!withOrder && (role === "sourceOrder" || role === "targetOrder")) {
            return null;
        }
        return role in r ? r[role] : null;
    }));
    // A role bound but empty is not the same thing as a role never bound, so
    // the stripped control drops the COLUMNS rather than blanking them.
    const roles = withOrder ? ROLES : ROLES.filter(r => r !== "sourceOrder" && r !== "targetOrder");
    const trimmed = withOrder ? table : table.map(row => row.slice(0, roles.length));
    return parseDataView(dataView(roles, trimmed));
}

function graphOf(rows, options) {
    const { flows, warnings } = parse(rows, options);
    const built = buildGraph(flows);
    return {
        flows,
        graph: built.graph,
        warnings: warnings.concat(built.warnings),
        corridors: inferCorridors(flows).corridors
    };
}

const inputFor = (graph, corridors, extra) => Object.assign({
    graph, corridors, pinned: new Map(), snapStep: 0
}, extra || {});

/** The ids of one stage, in the order they are actually drawn along the rows. */
function rowOrderAt(positions, graph, column) {
    return Array.from(positions.entries())
        .filter(([id]) => graph.nodes.has(id))
        .filter(([, place]) => Math.round(place.column) === column)
        .sort((a, b) => a[1].row - b[1].row)
        .map(([id]) => id);
}

/** The same off the graph itself, which is what the bare grid writes. */
function gridOrderAt(graph, column) {
    return Array.from(graph.nodes.values())
        .filter(node => Math.round(node.column) === column)
        .sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
        .map(node => node.id);
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Are these ids next to each other, in any internal order? */
function contiguous(list, ids) {
    const at = ids.map(id => list.indexOf(id)).sort((a, b) => a - b);
    return at[0] >= 0 && at[at.length - 1] - at[0] === ids.length - 1;
}

// =====================================================================
// 1. The parse
// =====================================================================
console.log("\n--- 1. the role parses like a node-level field ---");

{
    const one = parse([{ flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: 3 }]);
    check("a bound order reaches the flow", one.flows[0].sourceOrder === 3, `${one.flows[0].sourceOrder}`);
    check("an unbound order is undefined", one.flows[0].targetOrder === undefined);
    check("no warning for a clean value", one.warnings.length === 0, `${one.warnings.length}`);

    // An order is relative, so nothing is out of range -- the one thing a
    // Column or Row rejects (below 1) is meaningful here.
    const loose = parse([
        { flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: -2 },
        { flowID: "f2", source: "B", target: "T", value: 1, sourceOrder: 2.5 },
        { flowID: "f3", source: "C", target: "T", value: 1, sourceOrder: 0 }
    ]);
    check("a negative order is kept", loose.flows[0].sourceOrder === -2, `${loose.flows[0].sourceOrder}`);
    check("a decimal order is kept", loose.flows[1].sourceOrder === 2.5, `${loose.flows[1].sourceOrder}`);
    check("zero is kept", loose.flows[2].sourceOrder === 0, `${loose.flows[2].sourceOrder}`);
    check("none of them warned", loose.warnings.length === 0, loose.warnings.join("; "));

    // **Text is a CATEGORY**, where it used to be dropped
    // silently: a group with no preference about where it sits.
    const text = parse([{ flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: "Electricity" }]);
    check("text is kept as a category", text.flows[0].sourceOrder === "electricity",
        `${text.flows[0].sourceOrder}`);
    check("and warns about nothing", text.warnings.length === 0, text.warnings.join("; "));

    const shouty = parse([{ flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: "  ELECTRICITY " }]);
    check("trimmed and lowercased, so a stray capital cannot split a group",
        shouty.flows[0].sourceOrder === text.flows[0].sourceOrder,
        `${shouty.flows[0].sourceOrder}`);

    const digits = parse([{ flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: "3" }]);
    check("a numeric string still RANKS rather than grouping", digits.flows[0].sourceOrder === 3,
        `${typeof digits.flows[0].sourceOrder} ${digits.flows[0].sourceOrder}`);

    // The one value still rejected: a number that cannot be compared against
    // its own group.
    const huge = parse([{ flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: "Infinity" }]);
    check("an infinite order is ignored", huge.flows[0].sourceOrder === undefined);
    check("and that one says so", huge.warnings.some(w => /SourceOrder must be a number that can be ordered/.test(w)),
        huge.warnings.join("; "));

    // A category clash is a clash like any other, because the parse has
    // already folded the case.
    const twoGroups = graphOf([
        { flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: "Electricity" },
        { flowID: "f2", source: "A", target: "U", value: 1, sourceOrder: "Heat" }
    ]);
    check("two different categories on one node warn",
        twoGroups.warnings.some(w => /conflicting SourceOrder\/TargetOrder/.test(w)),
        twoGroups.warnings.join("; "));
    const oneGroup = graphOf([
        { flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: "Electricity" },
        { flowID: "f2", source: "A", target: "U", value: 1, sourceOrder: "electricity " }
    ]);
    check("the same category spelled differently does not", oneGroup.warnings.length === 0,
        oneGroup.warnings.join("; "));

    // Node-level, so one node reached from two rows holds ONE place.
    const agree = graphOf([
        { flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: 5 },
        { flowID: "f2", source: "A", target: "U", value: 1, sourceOrder: 5 }
    ]);
    check("the same value twice is not a clash", agree.warnings.length === 0, agree.warnings.join("; "));
    check("and lands on the node", agree.graph.nodes.get("A").authoredOrder === 5);

    const clash = graphOf([
        { flowID: "f1", source: "A", target: "T", value: 1, sourceOrder: 5 },
        { flowID: "f2", source: "A", target: "U", value: 1, sourceOrder: 7 }
    ]);
    check("two different values warn", clash.warnings.some(w => /conflicting SourceOrder\/TargetOrder/.test(w)),
        clash.warnings.join("; "));
    check("and the first one wins", clash.graph.nodes.get("A").authoredOrder === 5,
        `${clash.graph.nodes.get("A").authoredOrder}`);

    // The order must NOT make the node look hand-placed: an override would
    // stop both the grid and the arrangers choosing a coordinate for it.
    const node = clash.graph.nodes.get("A");
    check("an order sets neither override flag", node.rowIsOverride === false && node.columnIsOverride === false,
        `row=${node.rowIsOverride} column=${node.columnIsOverride}`);

    // A target-side order reaches the target's node, not the source's.
    const far = graphOf([{ flowID: "f1", source: "A", target: "T", value: 1, targetOrder: 9 }]);
    check("TargetOrder lands on the target", far.graph.nodes.get("T").authoredOrder === 9);
    check("and not on the source", far.graph.nodes.get("A").authoredOrder === undefined);
}

// =====================================================================
// 2. The bare grid (graph.ts assignOrder)
// =====================================================================
console.log("\n--- 2. the bare grid hands out places in the author's order ---");

// Four sources into one target: one stage of four, whose places are the only
// thing an order can change. Appearance order is A, B, C, D.
const FAN = [
    { flowID: "f1", source: "A", target: "T", value: 1 },
    { flowID: "f2", source: "B", target: "T", value: 1 },
    { flowID: "f3", source: "C", target: "T", value: 1 },
    { flowID: "f4", source: "D", target: "T", value: 1 }
];

{
    const plain = graphOf(FAN);
    check("with nothing numbered it is appearance order",
        same(gridOrderAt(plain.graph, 1), ["A", "B", "C", "D"]), gridOrderAt(plain.graph, 1).join(","));

    const numbered = FAN.map(r => Object.assign({}, r,
        r.source === "D" ? { sourceOrder: 1 } : r.source === "A" ? { sourceOrder: 2 } : {}));
    const some = graphOf(numbered);
    const order = gridOrderAt(some.graph, 1);
    check("numbered nodes come first, in value order", same(order.slice(0, 2), ["D", "A"]), order.join(","));
    check("blanks follow in appearance order", same(order.slice(2), ["B", "C"]), order.join(","));

    // Relative, not a coordinate: the places are still 1..n with no gaps, so
    // 10/20/30 draws exactly like 1/2/3.
    const sparse = graphOf(FAN.map(r => Object.assign({}, r,
        { sourceOrder: { A: 30, B: 20, C: 10, D: 40 }[r.source] })));
    const places = Array.from(sparse.graph.nodes.values())
        .filter(n => Math.round(n.column) === 1)
        .map(n => n.row)
        .sort((a, b) => a - b);
    check("sparse numbers still give 1..n", same(places, [1, 2, 3, 4]), places.join(","));
    check("in the author's order", same(gridOrderAt(sparse.graph, 1), ["C", "B", "A", "D"]),
        gridOrderAt(sparse.graph, 1).join(","));

    // A CATEGORY is not promoted to the front of the queue the way a rank is:
    // it says only "these belong together", so on a grid with no opinion of
    // its own the group stands where its first member stood. Appearance order
    // is A, B, C, D, so grouping B and D collects D up to B.
    const category = graphOf(FAN.map(r => Object.assign({}, r,
        (r.source === "B" || r.source === "D") ? { sourceOrder: "Electricity" } : {})));
    const collected = gridOrderAt(category.graph, 1);
    check("a category's members are collected together", contiguous(collected, ["B", "D"]),
        collected.join(","));
    check("at the first of them, not at the front", same(collected, ["A", "B", "D", "C"]),
        collected.join(","));

    // Ranked and categorised together: the rank goes first, the category stays
    // where it stood.
    const both = graphOf(FAN.map(r => Object.assign({}, r,
        r.source === "C" ? { sourceOrder: 1 }
            : (r.source === "B" || r.source === "D") ? { sourceOrder: "Electricity" } : {})));
    const mixed = gridOrderAt(both.graph, 1);
    check("a rank is still handed the first place", mixed[0] === "C", mixed.join(","));
    check("and the category is still one run", contiguous(mixed, ["B", "D"]), mixed.join(","));

    // The property that matters most: a diagram that does not use the role is
    // drawn exactly as it was before the role existed.
    const bound = graphOf(FAN, { withOrder: true });
    const unbound = graphOf(FAN, { withOrder: false });
    const boundRows = Array.from(bound.graph.nodes.values()).map(n => `${n.id}@${n.column},${n.row}`).sort();
    const unboundRows = Array.from(unbound.graph.nodes.values()).map(n => `${n.id}@${n.column},${n.row}`).sort();
    check("an empty role changes no place", same(boundRows, unboundRows), boundRows.join(" "));
}

// =====================================================================
// 3. holdAuthoredOrder, directly
// =====================================================================
console.log("\n--- 3. the projection itself ---");

/** A layer of fake vertices: a name, an authored order, a pin, an end rule. */
function layer(spec) {
    return spec.map(s => ({
        id: s.id,
        node: { id: s.id, authoredOrder: s.order },
        extent: 1,
        pinned: Boolean(s.pinned),
        edge: s.edge,
        anchor: s.anchor
    }));
}
const ids = list => list.map(v => v.id);

{
    const blank = layer([{ id: "a" }, { id: "b" }, { id: "c" }]);
    check("nothing authored is a no-op", same(ids(holdAuthoredOrder(blank)), ["a", "b", "c"]),
        ids(holdAuthoredOrder(blank)).join(","));

    // Two groups the pass left the wrong way round: the author's values decide.
    const swapped = layer([{ id: "late", order: 2 }, { id: "early", order: 1 }]);
    check("groups come out in the author's order",
        same(ids(holdAuthoredOrder(swapped)), ["early", "late"]), ids(holdAuthoredOrder(swapped)).join(","));

    // A group of three with a blank sitting in the middle of it: the blank is
    // pushed out, because nothing may split a group.
    const split = layer([
        { id: "g1", order: 10 }, { id: "blank" }, { id: "g2", order: 10 }, { id: "g3", order: 10 }
    ]);
    const closed = ids(holdAuthoredOrder(split));
    check("a blank cannot split a group", contiguous(closed, ["g1", "g2", "g3"]), closed.join(","));

    // ...and where the blank goes is the pass's business, not the author's.
    // Its slot (1) is below the group's rank (mean of 0, 2, 3 = 1.67), so it
    // comes out above the group; moved down the list, it comes out below.
    const above = ids(holdAuthoredOrder(layer([
        { id: "blank" }, { id: "g1", order: 10 }, { id: "g2", order: 10 }
    ])));
    const below = ids(holdAuthoredOrder(layer([
        { id: "g1", order: 10 }, { id: "g2", order: 10 }, { id: "blank" }
    ])));
    check("a blank above the group stays above", above[0] === "blank", above.join(","));
    check("a blank below the group stays below", below[2] === "blank", below.join(","));

    // Between two groups, which is the case that needs the ranks to be
    // ordered at all.
    const between = ids(holdAuthoredOrder(layer([
        { id: "top", order: 1 }, { id: "blank" }, { id: "bottom", order: 2 }
    ])));
    check("a blank between two groups stays between", same(between, ["top", "blank", "bottom"]),
        between.join(","));

    // The arrangement decides a group's INTERNAL order: the members are
    // emitted in the order the pass left them, not in the order they were
    // declared or the order the list happens to hold them.
    const inside = ids(holdAuthoredOrder(layer([
        { id: "second", order: 10 }, { id: "first", order: 10 }
    ])));
    check("a group keeps the pass's internal order", same(inside, ["second", "first"]), inside.join(","));

    // Pinned and end-held vertices keep their slots -- the agreed precedence.
    const pinned = ids(holdAuthoredOrder(layer([
        { id: "wall", pinned: true }, { id: "g1", order: 10 }, { id: "g2", order: 10 }
    ])));
    check("a pinned vertex holds its slot", pinned[0] === "wall", pinned.join(","));
    const ruled = ids(holdAuthoredOrder(layer([
        { id: "end", edge: "min" }, { id: "g1", order: 10 }, { id: "g2", order: 10 }
    ])));
    check("an end-held vertex holds its slot", ruled[0] === "end", ruled.join(","));

    // A group broken by a wall standing inside it: the wall wins, which is
    // what the terminal rule asks for.
    const broken = ids(holdAuthoredOrder(layer([
        { id: "g1", order: 10 }, { id: "wall", pinned: true }, { id: "g2", order: 10 }
    ])));
    check("a wall inside a group is not moved", broken[1] === "wall", broken.join(","));

    // Idempotence is what lets this run after every pass of the sweep.
    const messy = layer([
        { id: "a", order: 2 }, { id: "x" }, { id: "b", order: 1 }, { id: "y" },
        { id: "c", order: 1 }, { id: "z", pinned: true }
    ]);
    const once = holdAuthoredOrder(messy);
    const twice = holdAuthoredOrder(once);
    check("the projection is idempotent", same(ids(once), ids(twice)),
        `${ids(once).join(",")} -> ${ids(twice).join(",")}`);

    // --- categories: a group that asked for no position ---
    // It floats exactly as a lone blank does, which is the whole point: the
    // slots the pass left its members in decide where the run goes.
    const floatsDown = ids(holdAuthoredOrder(layer([
        { id: "x" }, { id: "y" }, { id: "g1", order: "el" }, { id: "g2", order: "el" }
    ])));
    check("a category below everything stays below", same(floatsDown, ["x", "y", "g1", "g2"]),
        floatsDown.join(","));
    const floatsUp = ids(holdAuthoredOrder(layer([
        { id: "g1", order: "el" }, { id: "g2", order: "el" }, { id: "x" }, { id: "y" }
    ])));
    check("a category above everything stays above", same(floatsUp, ["g1", "g2", "x", "y"]),
        floatsUp.join(","));
    const splitByBlank = ids(holdAuthoredOrder(layer([
        { id: "g1", order: "el" }, { id: "x" }, { id: "g2", order: "el" }
    ])));
    check("and nothing may sit inside it", contiguous(splitByBlank, ["g1", "g2"]),
        splitByBlank.join(","));

    // Two categories are two groups, and neither merges into the other.
    const twoRuns = ids(holdAuthoredOrder(layer([
        { id: "e1", order: "el" }, { id: "h1", order: "heat" },
        { id: "e2", order: "el" }, { id: "h2", order: "heat" }
    ])));
    check("two categories are two runs",
        contiguous(twoRuns, ["e1", "e2"]) && contiguous(twoRuns, ["h1", "h2"]), twoRuns.join(","));

    // A category of ONE is indistinguishable from a blank, which is what
    // keeps "tag a few nodes" from quietly reordering the rest.
    const lonely = ids(holdAuthoredOrder(layer([
        { id: "a" }, { id: "only", order: "el" }, { id: "b" }
    ])));
    check("a category of one changes nothing", same(lonely, ["a", "only", "b"]), lonely.join(","));

    // **A rank is relative to the OTHER ranks, never an absolute slot**, so a
    // lone ranked group floats on its own mean exactly as a category does --
    // which is why the two ways of asking place a single group identically
    // (section 4). What a rank buys is order between ranked groups: here the
    // pass left rank 2 above rank 1 and they come back the author's way up,
    // while the category floats above both on its own mean.
    const ranked = ids(holdAuthoredOrder(layer([
        { id: "r2", order: 2 }, { id: "c1", order: "el" }, { id: "c2", order: "el" }, { id: "r1", order: 1 }
    ])));
    check("ranked groups come out in the author's order", ranked.indexOf("r1") < ranked.indexOf("r2"),
        ranked.join(","));
    check("and a category floats past them on its own mean", same(ranked, ["c1", "c2", "r1", "r2"]),
        ranked.join(","));

    const messyCategories = layer([
        { id: "a", order: "el" }, { id: "x" }, { id: "b", order: "heat" },
        { id: "c", order: "el" }, { id: "y" }, { id: "d", order: "heat" }
    ]);
    const onceMore = holdAuthoredOrder(messyCategories);
    check("still idempotent with categories",
        same(ids(onceMore), ids(holdAuthoredOrder(onceMore))),
        ids(onceMore).join(","));

    // --- anchored by a banished terminal ---
    // A group whose member hangs a terminal at one end takes THAT END's slot
    // instead of the mean, so the pull the terminal earned is not averaged
    // away by members that are tied to nothing.
    const spread = [{ id: "g1", order: "el" }, { id: "x" }, { id: "y" }, { id: "z" },
        { id: "w" }, { id: "v" }, { id: "g2", order: "el" }];
    const unanchored = ids(holdAuthoredOrder(layer(spread)));
    // Unanchored it keys on the mean of slots 0 and 6, so it lands in the
    // middle -- at index 2 rather than 3, because a group goes before a blank
    // that asked for the same slot.
    check("unanchored, the group takes the mean of its members",
        unanchored.indexOf("g1") === 2 && unanchored[6] !== "g2", unanchored.join(","));

    const toMin = spread.map(s => (s.id === "g1" ? Object.assign({}, s, { anchor: "min" }) : s));
    const minned = ids(holdAuthoredOrder(layer(toMin)));
    check("anchored min, it takes its topmost member's slot", minned.indexOf("g1") === 0,
        minned.join(","));
    const toMax = spread.map(s => (s.id === "g1" ? Object.assign({}, s, { anchor: "max" }) : s));
    const maxed = ids(holdAuthoredOrder(layer(toMax)));
    check("anchored max, its bottom member's", maxed.indexOf("g2") === 6, maxed.join(","));

    // **Opposite ends cancel** -- the agreed rule, and `biasOf`'s: where two say
    // different things, neither is believed and the mean stands.
    const both = spread.map(s => (s.id === "g1" ? Object.assign({}, s, { anchor: "min" })
        : s.id === "g2" ? Object.assign({}, s, { anchor: "max" }) : s));
    check("a min and a max in one group cancel", same(ids(holdAuthoredOrder(layer(both))), unanchored),
        ids(holdAuthoredOrder(layer(both))).join(","));
    // Two anchors AGREEING are not a disagreement.
    const agreeing = spread.map(s => (s.id === "g1" || s.id === "g2"
        ? Object.assign({}, s, { anchor: "min" }) : s));
    check("two anchors agreeing still anchor", ids(holdAuthoredOrder(layer(agreeing)))[0] === "g1",
        ids(holdAuthoredOrder(layer(agreeing))).join(","));

    // It reaches only inside a group: a lone anchored vertex keeps the slot
    // the pass gave it, which is what leaves ordinary placement alone.
    const lone = ids(holdAuthoredOrder(layer([
        { id: "a" }, { id: "anchored", anchor: "min" }, { id: "g1", order: "el" }, { id: "g2", order: "el" }
    ])));
    check("an anchored vertex outside a group is not moved", lone.indexOf("anchored") === 1,
        lone.join(","));
    // ...and a group of one is its own slot either way.
    const single = ids(holdAuthoredOrder(layer([
        { id: "a" }, { id: "only", order: "el", anchor: "min" }, { id: "b" }
    ])));
    check("an anchored group of one changes nothing", same(single, ["a", "only", "b"]),
        single.join(","));

    // --- more than one node tied to a terminal ---
    // **An anchor is not "go to the top of the column"**: it keys the group on
    // its EXTREME member instead of the average, so vertices that asked for a
    // slot above it keep them.
    const twoTied = ids(holdAuthoredOrder(layer([
        { id: "x" }, { id: "y" }, { id: "g1", order: "el", anchor: "min" },
        { id: "z" }, { id: "g2", order: "el", anchor: "min" }
    ])));
    check("two members tied to the same terminal agree", same(twoTied, ["x", "y", "g1", "g2", "z"]),
        twoTied.join(","));
    check("and vertices above the group keep their slots", twoTied.slice(0, 2).join() === "x,y",
        twoTied.join(","));

    // The extreme member need not be the anchored one: the anchor turns the
    // rule on, the group's own topmost slot supplies the position.
    const belowOne = ids(holdAuthoredOrder(layer([
        { id: "g1", order: "el" }, { id: "x" }, { id: "y" },
        { id: "g2", order: "el", anchor: "min" }, { id: "z" }
    ])));
    check("an anchored member below an unanchored one still anchors the group",
        same(belowOne, ["g1", "g2", "x", "y", "z"]), belowOne.join(","));

    // Two groups anchored the same way do not fight: each keys on its own
    // topmost member and they stack in that order.
    const bothMin = ids(holdAuthoredOrder(layer([
        { id: "a1", order: "el" }, { id: "b1", order: "heat", anchor: "min" },
        { id: "a2", order: "el", anchor: "min" }, { id: "b2", order: "heat" }, { id: "x" }
    ])));
    check("two groups anchored min stack by their topmost members",
        same(bothMin, ["a1", "a2", "b1", "b2", "x"]), bothMin.join(","));

    const opposite = ids(holdAuthoredOrder(layer([
        { id: "a1", order: "el", anchor: "min" }, { id: "x" },
        { id: "b1", order: "heat", anchor: "max" }, { id: "a2", order: "el" },
        { id: "b2", order: "heat" }
    ])));
    check("one group to each end, blanks between",
        same(opposite, ["a1", "a2", "x", "b1", "b2"]), opposite.join(","));

    // **There is no vote**: two anchors one way and one the other still cancel.
    const majority = ids(holdAuthoredOrder(layer([
        { id: "g1", order: "el", anchor: "min" }, { id: "x" }, { id: "g2", order: "el", anchor: "min" },
        { id: "y" }, { id: "g3", order: "el", anchor: "max" }
    ])));
    check("two min and one max still cancel to the mean",
        same(majority, ["x", "g1", "g2", "g3", "y"]), majority.join(","));

    const multi = holdAuthoredOrder(layer([
        { id: "a1", order: "el", anchor: "min" }, { id: "b1", order: "heat", anchor: "max" },
        { id: "a2", order: "el" }, { id: "b2", order: "heat" }
    ]));
    check("multi-anchor layers are idempotent too",
        same(ids(multi), ids(holdAuthoredOrder(multi))), ids(multi).join(","));

    // A lane has no node of its own and must not be mistaken for a blank with
    // an opinion.
    const withLane = holdAuthoredOrder([
        { id: " lane@2", extent: 1, pinned: false },
        { id: "g1", node: { id: "g1", authoredOrder: 1 }, extent: 1, pinned: false }
    ]);
    check("a lane is treated as unnumbered", ids(withLane).length === 2, ids(withLane).join(","));
}

// =====================================================================
// 4. Through both arrangers, against the unconstrained run
// =====================================================================
console.log("\n--- 4. the order survives the arrangers ---");

// Three stages, with the crossing objective holding a strong opinion about
// stage 1: S1, S3, S5 feed M1 and S2, S4 feed M2, so the uncrossed
// arrangement groups them that way. Numbering S1 and S4 as one group asks for
// exactly what the objective does NOT want -- left alone, both passes put
// those two four slots apart -- which is what gives the assertions teeth.
const LADDER = [
    { flowID: "f1", source: "S1", target: "M1", value: 10 },
    { flowID: "f2", source: "S2", target: "M2", value: 10 },
    { flowID: "f3", source: "S3", target: "M1", value: 10 },
    { flowID: "f4", source: "S4", target: "M2", value: 10 },
    { flowID: "f5", source: "S5", target: "M1", value: 10 },
    { flowID: "f6", source: "M1", target: "T", value: 30 },
    { flowID: "f7", source: "M2", target: "T", value: 20 }
];
const GROUP = ["S1", "S4"];
const GROUPED = LADDER.map(r => Object.assign({}, r,
    GROUP.includes(r.source) ? { sourceOrder: 10 } : {}));
// The same group asked for the other way. With one group and no
// other ranked node the two must come out IDENTICAL: a lone rank's key is the
// running maximum of its own mean, which is its mean, and a category's key is
// its mean.
const CATEGORISED = LADDER.map(r => Object.assign({}, r,
    GROUP.includes(r.source) ? { sourceOrder: "Electricity" } : {}));
// A second case: the same ladder with three distinct numbers, which fix an
// order without closing a group, so blanks may still interleave. S3, S1, S5 is
// an order neither pass produces on its own.
const SEQUENCE = { S3: 1, S1: 2, S5: 3 };
const SEQUENCED = LADDER.map(r => Object.assign({}, r,
    SEQUENCE[r.source] !== undefined ? { sourceOrder: SEQUENCE[r.source] } : {}));

[
    { name: "Arrange nodes", run: (g, c) => arrangeNodes(inputFor(g, c)) }
].forEach(pass => {
    // --- a closed group ---
    const grouped = graphOf(GROUPED);
    const free = graphOf(LADDER);
    const held = rowOrderAt(pass.run(grouped.graph, grouped.corridors).positions, grouped.graph, 1);
    const loose = rowOrderAt(pass.run(free.graph, free.corridors).positions, free.graph, 1);

    check(`${pass.name}: the group is contiguous`, contiguous(held, GROUP), held.join(","));
    check(`${pass.name}: the assertion has teeth`, !contiguous(loose, GROUP),
        `unconstrained ${loose.join(",")}`);
    check(`${pass.name}: every node still placed`, held.length === 5, held.join(","));

    // **The data order does not decide a group's internal order.** The exact
    // rule -- members emitted in the slots the pass left them in -- is pinned
    // on the projection itself in section 3; what is checkable out here is
    // that the objective got the choice, and on this fixture both passes take
    // it the other way up from the rows. An implementation that kept ties in
    // appearance order (which is what the bare grid does, deliberately) fails
    // this. Note it cannot be compared against the UNCONSTRAINED run: closing
    // the group moves it inside its layer, so the means the pass reads around
    // it are not the same question.
    const got = held.filter(id => GROUP.includes(id));
    check(`${pass.name}: the data order did not pick the group's internal order`, !same(got, GROUP),
        `${got.join(",")} where the rows say ${GROUP.join(",")}`);

    // --- the same group as a CATEGORY ---
    const categorised = graphOf(CATEGORISED);
    const byCategory = pass.run(categorised.graph, categorised.corridors).positions;
    const tagged = rowOrderAt(byCategory, categorised.graph, 1);
    check(`${pass.name}: a category holds the group together too`, contiguous(tagged, GROUP),
        tagged.join(","));
    // The claim worth having: the two ways of asking place EVERY node the
    // same, so a category is not a second behaviour to reason about.
    const asRank = JSON.stringify(Array.from(pass.run(grouped.graph, grouped.corridors).positions.entries()).sort());
    const asCategory = JSON.stringify(Array.from(byCategory.entries()).sort());
    check(`${pass.name}: a rank and a category place every node identically`, asRank === asCategory);

    // --- distinct numbers: an order without a group ---
    const sequenced = graphOf(SEQUENCED);
    const run = rowOrderAt(pass.run(sequenced.graph, sequenced.corridors).positions, sequenced.graph, 1);
    const declared = Object.keys(SEQUENCE).sort((a, b) => SEQUENCE[a] - SEQUENCE[b]);
    const inOrder = list => declared.every((id, i) => i === 0 || list.indexOf(declared[i - 1]) < list.indexOf(id));
    check(`${pass.name}: declared order is respected`, inOrder(run), `${run.join(",")} for ${declared.join("<")}`);
    check(`${pass.name}: and that is not what it would have chosen`, !inOrder(loose),
        `unconstrained ${loose.join(",")}`);

    // --- nothing authored: byte-identical to the pass as it was ---
    const a = JSON.stringify(Array.from(pass.run(free.graph, free.corridors).positions.entries()).sort());
    const stripped = graphOf(LADDER, { withOrder: false });
    const b = JSON.stringify(Array.from(pass.run(stripped.graph, stripped.corridors).positions.entries()).sort());
    check(`${pass.name}: an unused role moves nothing`, a === b);
});

// A hand placement still beats the data, which is the standing precedence.
{
    const grouped = graphOf(GROUPED);
    const pinned = new Map([[GROUP[1], { column: 1, row: 1 }]]);
    const result = arrangeNodes(inputFor(grouped.graph, grouped.corridors, { pinned }));
    const held = rowOrderAt(result.positions, grouped.graph, 1);
    check("a pinned member holds its slot against its group", held[0] === GROUP[1], held.join(","));
}

// =====================================================================
console.log(`\n${assertions - failures}/${assertions} assertions passed`);
check("enough assertions ran", assertions > 40, `${assertions}`);
if (failures > 0) {
    console.log(`FAILURES: ${failures}`);
    process.exit(1);
}
