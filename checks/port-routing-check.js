"use strict";
const { routeCorridors, routeDiagram, draggableHandles } = require("./routing-api.js");

let failures = 0;
function check(label, cond) {
    if (!cond) {
        failures++;
        console.log(`FAIL: ${label}`);
    }
}

const PORTS = ["North", "South", "East", "West"];

function makeNode(id, x, y, width, height) {
    return { id, label: id, x, y, width, height, inflow: 0, outflow: 0, isSelfLoop: false };
}

function samplePath(d, subSamples = 12) {
    const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?(e-?\d+)?/g);
    let i = 0;
    let cur = { x: 0, y: 0 };
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

function insideBox(p, node, inset) {
    return p.x > node.x + inset && p.x < node.x + node.width - inset
        && p.y > node.y + inset && p.y < node.y + node.height - inset;
}

function routeOne(nodes, corridor, columnGap = 120, rowPitch = 80) {
    const layout = {
        nodes: new Map(nodes.map(n => [n.id, n])),
        corridors: [corridor],
        valueToPixels: v => Math.max(4, v),
        columnGap,
        rowPitch
    };
    return routeCorridors(layout);
}

function corridorOf(source, target, sourcePort, targetPort, segments) {
    const value = segments.reduce((s, seg) => s + seg.value, 0);
    return {
        id: `${source}->${target}|${sourcePort}|${targetPort}`,
        source, target, value,
        isSelfLoop: source === target,
        flows: [], segments, sourcePort, targetPort
    };
}

// ===================================================================
// 1. All 16 pairings, regular corridor (two distinct nodes)
// ===================================================================
console.log("--- regular corridors, all 16 port pairings ---");
for (const sp of PORTS) {
    for (const tp of PORTS) {
        const a = makeNode("A", 100, 300, 14, 60);
        const b = makeNode("B", 500, 200, 14, 60);
        const corridor = corridorOf("A", "B", sp, tp, [{ flowType: undefined, value: 40, flows: [] }]);
        const bands = routeOne([a, b], corridor);
        const label = `${sp}->${tp}`;
        check(`regular ${label}: produced a band`, bands.length === 1);
        if (bands.length !== 1) continue;
        const pts = samplePath(bands[0].path);
        check(`regular ${label}: all finite`, allFinite(pts));
        // Nothing should tunnel through the middle of either node bar.
        const through = pts.filter(p => insideBox(p, a, 1) || insideBox(p, b, 1)).length;
        check(`regular ${label}: does not tunnel through a node (${through} pts inside)`, through === 0);
    }
}

// ===================================================================
// 2. All 16 pairings, SELF-LOOP (same node both ends)
// ===================================================================
console.log("--- self-loops, all 16 port pairings ---");
for (const sp of PORTS) {
    for (const tp of PORTS) {
        const n = makeNode("N", 300, 300, 14, 60);
        const corridor = corridorOf("N", "N", sp, tp, [{ flowType: undefined, value: 20, flows: [] }]);
        const bands = routeOne([n], corridor);
        const label = `${sp}->${tp}`;
        check(`selfloop ${label}: produced a band`, bands.length === 1);
        if (bands.length !== 1) continue;
        const pts = samplePath(bands[0].path);
        check(`selfloop ${label}: all finite`, allFinite(pts));
        // The flat-wobble degeneracy shows up precisely as the route lying
        // along a line straight through the node, so this is the detector.
        const through = pts.filter(p => insideBox(p, n, 1)).length;
        check(`selfloop ${label}: does not pass through the node (${through} pts inside)`, through === 0);
        // A loop must actually enclose some area -- a degenerate flat route
        // would have near-zero extent on one axis.
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const spanX = Math.max(...xs) - Math.min(...xs);
        const spanY = Math.max(...ys) - Math.min(...ys);
        check(`selfloop ${label}: has real 2-D extent (${spanX.toFixed(0)}x${spanY.toFixed(0)})`, spanX > 5 && spanY > 5);
    }
}

// ===================================================================
// 3. the author's requirement: a plain East->West run at equal heights must be
//    a genuinely straight line, not a bowed curve.
// ===================================================================
console.log("--- straight-line preservation ---");
{
    const a = makeNode("A", 100, 300, 14, 40);
    const b = makeNode("B", 500, 300, 14, 40); // identical y and height => anchors line up
    const corridor = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]);
    const bands = routeOne([a, b], corridor);
    const pts = samplePath(bands[0].path);
    const ys = pts.map(p => p.y);
    const distinct = Array.from(new Set(ys.map(y => y.toFixed(3))));
    // Exactly two y values expected: the band's two parallel edges.
    check(`straight E->W: band edges are perfectly flat (found ${distinct.length} distinct y values)`, distinct.length === 2);
}
{
    // And the vertical equivalent: South -> North, nodes stacked, same x.
    const a = makeNode("A", 300, 100, 14, 40);
    const b = makeNode("B", 300, 500, 14, 40);
    const corridor = corridorOf("A", "B", "South", "North", [{ flowType: undefined, value: 40, flows: [] }]);
    const bands = routeOne([a, b], corridor);
    const pts = samplePath(bands[0].path);
    const distinct = Array.from(new Set(pts.map(p => p.x.toFixed(3))));
    check(`straight S->N: band edges are perfectly flat (found ${distinct.length} distinct x values)`, distinct.length === 2);
}

// ===================================================================
// 4. Multi-segment corridors stay parallel and never twist, for every pairing
// ===================================================================
console.log("--- multi-segment parallelism (no twist, no gaps) ---");
for (const sp of PORTS) {
    for (const tp of PORTS) {
        const a = makeNode("A", 100, 300, 14, 60);
        const b = makeNode("B", 500, 200, 14, 60);
        const corridor = corridorOf("A", "B", sp, tp, [
            { flowType: "x", value: 30, flows: [] },
            { flowType: "y", value: 20, flows: [] },
            { flowType: "z", value: 10, flows: [] }
        ]);
        const bands = routeOne([a, b], corridor);
        const label = `${sp}->${tp}`;
        check(`multiseg ${label}: 3 bands`, bands.length === 3);
        if (bands.length !== 3) continue;
        check(`multiseg ${label}: all finite`, bands.every(bnd => allFinite(samplePath(bnd.path))));

        // Adjacent segments share a boundary: segment k's HIGH edge is
        // segment k+1's LOW edge, so the two paths must contain a matching
        // run of points. Compare the raw edge geometry via path prefixes.
        for (let k = 0; k < bands.length - 1; k++) {
            const kPts = samplePath(bands[k].path);
            const nextPts = samplePath(bands[k + 1].path);
            // Every point of band k+1's low edge should lie on or between
            // band k's extremes -- a twist would put them wildly apart.
            const gap = Math.min(...nextPts.map(p =>
                Math.min(...kPts.map(q => Math.hypot(p.x - q.x, p.y - q.y)))
            ));
            check(`multiseg ${label}: segments ${k}/${k + 1} are adjacent (min gap ${gap.toFixed(2)})`, gap < 1);
        }
    }
}

// ===================================================================
// 5. Ports group per EDGE: a node with corridors leaving AND arriving on
//    the same port must pack them together without overlapping.
// ===================================================================
console.log("--- shared-edge packing ---");
{
    const hub = makeNode("Hub", 300, 300, 14, 60);
    const left = makeNode("L", 100, 300, 14, 60);
    const right = makeNode("R", 500, 300, 14, 60);
    // Both corridors use Hub's EAST edge: one leaving it, one arriving at it.
    const out = corridorOf("Hub", "R", "East", "West", [{ flowType: undefined, value: 30, flows: [] }]);
    const inc = corridorOf("L", "Hub", "East", "East", [{ flowType: undefined, value: 30, flows: [] }]);
    const layout = {
        nodes: new Map([["Hub", hub], ["L", left], ["R", right]]),
        corridors: [out, inc],
        valueToPixels: v => Math.max(4, v),
        columnGap: 120,
        rowPitch: 80
    };
    const bands = routeCorridors(layout);
    check("shared edge: both corridors routed", bands.length === 2);

    // Their anchors on Hub's east edge must occupy different, non-overlapping
    // spans -- if packing had kept outgoing/incoming separate they'd sit on
    // top of each other at the same centre.
    const eastX = hub.x + hub.width;
    const anchorYs = bands.map(bnd => {
        const pts = samplePath(bnd.path).filter(p => Math.abs(p.x - eastX) < 0.5);
        return pts.length ? pts.reduce((s, p) => s + p.y, 0) / pts.length : NaN;
    });
    check("shared edge: both bands touch Hub's east edge", anchorYs.every(y => Number.isFinite(y)));
    check(`shared edge: their anchors are packed apart (${anchorYs.map(y => y.toFixed(1)).join(" vs ")})`,
        Math.abs(anchorYs[0] - anchorYs[1]) > 1);
}

// ===================================================================
// 6. The Curvature / Port lead-in settings actually change the geometry,
//    and a straight run stays straight whatever they're set to.
// ===================================================================
console.log("--- format settings ---");
{
    const n = makeNode("N", 300, 300, 14, 60);
    const corridor = corridorOf("N", "N", "East", "West", [{ flowType: undefined, value: 20, flows: [] }]);
    const layoutOf = () => ({
        nodes: new Map([["N", n]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 120, rowPitch: 80
    });
    const tight = routeCorridors(layoutOf(), { portLeadInPercent: 18, curvaturePercent: 5 });
    const round = routeCorridors(layoutOf(), { portLeadInPercent: 18, curvaturePercent: 90 });
    check("curvature changes the rendered path", tight[0].path !== round[0].path);

    // A larger radius needs more room to turn in, so the loop grows rather
    // than shrinks -- which is also why Curvature governs how long the
    // straight runs are, not just how soft the corners look. Both settings
    // must still produce sane, non-degenerate geometry.
    const extentOf = bands => {
        const pts = samplePath(bands[0].path);
        return Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x));
    };
    check(`a larger radius needs more room (tight ${extentOf(tight).toFixed(0)} vs round ${extentOf(round).toFixed(0)})`,
        extentOf(round) >= extentOf(tight));
    [tight, round].forEach((bands, i) => {
        const pts = samplePath(bands[0].path);
        check(`curvature variant ${i} stays finite and non-degenerate`,
            pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) && extentOf(bands) > 5);
    });

    const longLead = routeCorridors(layoutOf(), { portLeadInPercent: 60, curvaturePercent: 35 });
    const shortLead = routeCorridors(layoutOf(), { portLeadInPercent: 5, curvaturePercent: 35 });
    check("port lead-in changes the rendered path", longLead[0].path !== shortLead[0].path);
}
{
    // A DIRECT corridor's two lead-ins plus the bend have to fit inside one
    // grid space, so each end is capped at half of it less the curve's room.
    // Without that cap a high setting runs the two lead-ins past each other
    // and the "curve" between them doubles back on itself.
    const a = makeNode("A", 100, 300, 14, 40);
    const b = makeNode("B", 220, 380, 14, 40); // adjacent column, one row down
    const corridor = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]);
    const routeAt = leadPercent => routeCorridors({
        nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
        valueToPixels: v => Math.max(4, v), columnGap: 120, rowPitch: 80
    }, { portLeadInPercent: leadPercent, curvaturePercent: 35 });

    check("direct route: lead-in still responds to the setting", routeAt(5)[0].path !== routeAt(30)[0].path);

    [30, 60, 100].forEach(leadPercent => {
        const pts = samplePath(routeAt(leadPercent)[0].path);
        // Walk the low edge only (up to the L cap) and confirm x never
        // reverses -- a doubling-back curve shows up as a backwards step.
        let maxBackstep = 0;
        for (let k = 1; k < pts.length / 2; k++) {
            maxBackstep = Math.max(maxBackstep, pts[k - 1].x - pts[k].x);
        }
        check(`direct route at lead=${leadPercent}: lead-ins never overrun each other (max backstep ${maxBackstep.toFixed(2)})`,
            maxBackstep < 1);
    });
}
{
    // Whatever the settings, an aligned East->West run must stay dead straight.
    const a = makeNode("A", 100, 300, 14, 40);
    const b = makeNode("B", 500, 300, 14, 40);
    const corridor = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]);
    [{ portLeadInPercent: 0, curvaturePercent: 0 },
     { portLeadInPercent: 50, curvaturePercent: 100 },
     { portLeadInPercent: 100, curvaturePercent: 50 }].forEach(opts => {
        const bands = routeCorridors({
            nodes: new Map([["A", a], ["B", b]]), corridors: [corridor],
            valueToPixels: v => Math.max(4, v), columnGap: 120, rowPitch: 80
        }, opts);
        const distinctY = Array.from(new Set(samplePath(bands[0].path).map(p => p.y.toFixed(3))));
        check(`straight run stays straight at lead=${opts.portLeadInPercent} curve=${opts.curvaturePercent}`, distinctY.length === 2);
     });
}

// ===================================================================
// 7. High curvature must not pinch the ribbon. At large radii the straight
//    run between two corners vanishes; a zero-length segment has no
//    direction, so its normal came out as (0,0) and the band collapsed to
//    nothing right there -- visible as a gap across the band.
// ===================================================================
console.log("--- no pinching at high curvature ---");
{
    // Splits a closed band path into its two edges: the single L separates
    // the low edge from the (reversed) high edge.
    function bandEdges(d, subSamples = 10) {
        const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?(e-?\d+)?/g);
        let i = 0, cur = { x: 0, y: 0 }, seenCap = false;
        const low = [], high = [];
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
            if (tok === "M") { cur = { x: readNum(), y: readNum() }; low.push(cur); }
            else if (tok === "L") { cur = { x: readNum(), y: readNum() }; seenCap = true; high.push(cur); }
            else if (tok === "C") {
                const c1 = { x: readNum(), y: readNum() };
                const c2 = { x: readNum(), y: readNum() };
                const end = { x: readNum(), y: readNum() };
                for (let s = 1; s <= subSamples; s++) (seenCap ? high : low).push(cubic(cur, c1, c2, end, s / subSamples));
                cur = end;
            }
        }
        return { low, high: high.reverse() };
    }

    const scenarios = [
        ["self-loop East->West", corridorOf("N", "N", "East", "West", [{ flowType: undefined, value: 20, flows: [] }]), [makeNode("N", 300, 300, 14, 60)]],
        ["self-loop East->South", corridorOf("N", "N", "East", "South", [{ flowType: undefined, value: 20, flows: [] }]), [makeNode("N", 300, 300, 14, 60)]],
        ["wrap East->East", corridorOf("A", "B", "East", "East", [{ flowType: undefined, value: 40, flows: [] }]), [makeNode("A", 100, 300, 14, 60), makeNode("B", 500, 300, 14, 60)]]
    ];

    [35, 60, 72, 100].forEach(curve => {
        scenarios.forEach(([label, corridor, nodeSet]) => {
            const bands = routeCorridors({
                nodes: new Map(nodeSet.map(n => [n.id, n])), corridors: [corridor],
                valueToPixels: v => Math.max(4, v), columnGap: 120, rowPitch: 80
            }, { portLeadInPercent: 15, curvaturePercent: curve });
            const { low, high } = bandEdges(bands[0].path);
            const pairs = Math.min(low.length, high.length);
            let minWidth = Infinity, maxWidth = 0;
            for (let k = 0; k < pairs; k++) {
                const w = Math.hypot(low[k].x - high[k].x, low[k].y - high[k].y);
                minWidth = Math.min(minWidth, w);
                maxWidth = Math.max(maxWidth, w);
            }
            // Guard against a vacuous pass: if the edge parse yielded nothing,
            // minWidth would stay Infinity and the width assertion would
            // trivially succeed without measuring anything.
            check(`curve=${curve} ${label}: edges actually parsed (${pairs} sample pairs)`, pairs > 10);
            check(`curve=${curve} ${label}: band never pinches (min ${minWidth.toFixed(1)} vs max ${maxWidth.toFixed(1)})`,
                pairs > 10 && minWidth > maxWidth * 0.25);
            if (curve === 100) {
                console.log(`      ${label}: width ${minWidth.toFixed(1)}..${maxWidth.toFixed(1)} over ${pairs} pairs`);
            }
        });
    });
}

// =====================================================================
console.log("\n--- Flow direction: the default when the data says nothing ---");
/**
 * **Positions card -> Flow direction**. The port roles are
 * optional, and with none of them bound every corridor used to leave East and
 * arrive West. The setting offers the other reading, as a FALLBACK only, and
 * carries the automatic grid with it -- a diagram whose ports point South laid
 * its stages out in COLUMNS, at right angles to its own flow, and only looked
 * right once Auto-fit nodes had been pressed.
 */
{
    // This file's `check` is silent on success, so the section counts its
    // own assertions and asserts the count: a section that silently stopped
    // running would otherwise read exactly like one that passed.
    let ran = 0;
    const ok = (label, cond, detail) => { ran++; check(`${label}${detail ? ` (${detail})` : ""}`, cond); };
    // The expected pairs are written out here rather than imported from
    // model.js: a check that asks the code under test what the answer is
    // cannot fail when the answer is wrong.
    // `signs` is [columnSign, rowSign]: which way each axis's grid coordinate
    // runs on screen. Only the stage axis ever reverses. Written out here
    // rather than asked of the code, like everything else in this table.
    const WANT = {
        LeftToRight: { out: "East", in: "West", axis: "horizontal", sense: 1, signs: [1, 1] },
        RightToLeft: { out: "West", in: "East", axis: "horizontal", sense: -1, signs: [-1, 1] },
        TopToBottom: { out: "South", in: "North", axis: "vertical", sense: 1, signs: [1, 1] },
        BottomToTop: { out: "North", in: "South", axis: "vertical", sense: -1, signs: [1, -1] }
    };
    const { axisOf, senseOf } = require("./model-api.js");
    const { computeLayout } = require("./layout-api.js");
    const LAYOUT_CHROME = {
        legendVisible: false, legendPosition: "Bottom", nodeShape: "Rectangle",
        nodeMinWidthPercent: 3, nodeMinHeightPercent: 3
    };
    const { buildGraph } = require("./placed.js");
    const { inferCorridors } = require("./lib/corridors.js");
    const { parseDataView } = require("./parse.js");
    const { geometryKey } = require("./lib/geometryKey.js");

    const ROLES = ["flowID", "source", "target", "value", "sourcePort", "targetPort"];
    const parse = rows => {
        const dv = {
            table: {
                columns: ROLES.map(r => ({ roles: { [r]: true } })),
                rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
            }
        };
        return parseDataView(dv).flows;
    };
    // A plain chain with no ports bound anywhere: exactly the case the
    // setting exists for.
    const CHAIN = [
        { flowID: "a", source: "A", target: "B", value: 10 },
        { flowID: "b", source: "B", target: "C", value: 10 },
        { flowID: "c", source: "A", target: "C", value: 4 }
    ];
    const flows = parse(CHAIN);

    Object.keys(WANT).forEach(direction => {
        const { corridors } = inferCorridors(flows, undefined, direction);
        const want = WANT[direction];
        ok(`${direction}: every corridor falls back to ${want.out}/${want.in}`,
            corridors.length === 3
            && corridors.every(c => c.sourcePort === want.out && c.targetPort === want.in),
            corridors.map(c => `${c.sourcePort}->${c.targetPort}`).join(" "));
        ok(`${direction}: the diagram reads the way the setting says`,
            axisOf(corridors) === want.axis, axisOf(corridors));
        // **Which way along that axis**, which is what the two reversed
        // readings added. Read off the resolved ports, so it
        // cannot disagree with them.
        ok(`${direction}: the sense is ${want.sense}`,
            senseOf(corridors, axisOf(corridors)) === want.sense,
            String(senseOf(corridors, axisOf(corridors))));

        // **And the automatic grid follows -- in FLOW ORDER, always.** The
        // stage is the coordinate the flow travels along: the column
        // left-to-right, the row top-to-bottom. Stage 1 is the FIRST stage in
        // every direction, including the reversed ones, because a reversed
        // diagram is reversed by the grid->pixel mapping and not by the
        // numbering (`flip-check`). Numbering it backwards as well was tried
        // and double-flips against the mapping.
        const axis = axisOf(corridors);
        const graph = buildGraph(flows, new Map(), axis).graph;
        const stageOf = id => (want.axis === "vertical"
            ? graph.nodes.get(id).row
            : graph.nodes.get(id).column);
        const orderOf = id => (want.axis === "vertical"
            ? graph.nodes.get(id).column
            : graph.nodes.get(id).row);
        ok(`${direction}: the stages run along the flow in flow order (A,B,C = 1,2,3)`,
            stageOf("A") === 1 && stageOf("B") === 2 && stageOf("C") === 3,
            `${stageOf("A")}, ${stageOf("B")}, ${stageOf("C")}`);
        ok(`${direction}: each stage holds one node, at place 1`,
            orderOf("A") === 1 && orderOf("B") === 1 && orderOf("C") === 1,
            `${orderOf("A")}, ${orderOf("B")}, ${orderOf("C")}`);
        // **And the MAPPING is what reverses.** This is the end-to-end half:
        // the card picks the ports, the ports give the sense, and the sense
        // decides which end of the screen stage 1 is drawn at. Without it a
        // right-to-left diagram draws every corridor leaving a West face to
        // reach a node on its right -- a diagram of nothing but wraps.
        const layout = computeLayout(graph, corridors, 1400, 800, LAYOUT_CHROME);
        ok(`${direction}: the layout is flipped ${JSON.stringify(want.signs)}`,
            layout.columnSign === want.signs[0] && layout.rowSign === want.signs[1],
            `(${layout.columnSign}, ${layout.rowSign})`);
        // The property behind the numbers, so it holds whatever the chain's
        // depth is: every corridor's target is drawn on the side its own
        // source port points to.
        const centreOf = id => {
            const n = layout.nodes.get(id);
            return want.axis === "horizontal" ? n.x + n.width / 2 : n.y + n.height / 2;
        };
        const normal = require("./model-api.js").PORT_NORMALS[want.out];
        const alongScreen = want.axis === "horizontal" ? normal.x : normal.y;
        const forwards = (from, to) => alongScreen * (centreOf(to) - centreOf(from)) > 0;
        ok(`${direction}: every target is DRAWN on the side its source port points`,
            forwards("A", "B") && forwards("B", "C") && forwards("A", "C"));
    });

    // **An authored stage is never shifted to make the automatic ones start at
    // 1.** A reversed pass counts outward from the sources, so its automatic
    // stages come out at or below zero and are shifted up -- but only where
    // NOTHING is overridden. Where the author named a coordinate it anchors
    // the diagram, and an automatic node placed before it is the same thing a
    // forward pass does when it puts an automatic successor at 6 beside an
    // authored 5.
    {
        const ROLES2 = ["flowID", "source", "target", "value", "sourceColumn"];
        const dv = {
            table: {
                columns: ROLES2.map(r => ({ roles: { [r]: true } })),
                rows: [
                    ["a", "A", "B", 10, 5],
                    ["b", "B", "C", 10, null]
                ]
            }
        };
        const anchored = parseDataView(dv).flows;
        const { corridors } = inferCorridors(anchored, undefined, "RightToLeft");
        const graph = buildGraph(anchored, new Map(), "horizontal").graph;
        const col = id => graph.nodes.get(id).column;
        ok("an authored stage is left exactly where the author put it",
            col("A") === 5, String(col("A")));
        // Forwards from the anchor, exactly as Left to right does it -- the
        // author's coordinates mean the same thing in every direction and it is
        // the mapping that decides which way they are read out.
        ok("...and the automatic stages follow it in flow order",
            col("B") === 6 && col("C") === 7, `B=${col("B")}, C=${col("C")}`);
        // And nothing about a reversed diagram makes a drag move anything else:
        // the stages do not depend on which nodes are overridden, because they
        // are numbered forwards from the sources whatever the direction. (A
        // base derived from the diagram's depth was needed for the numbering
        // design and is not needed for this one.)
        const loose = buildGraph(anchored, new Map(), "horizontal").graph;
        const dragged = buildGraph(anchored, new Map([["C", { column: 7, row: 1 }]]), "horizontal").graph;
        ok("dragging one node leaves every other stage exactly alone",
            ["A", "B", "C"].every(id =>
                loose.nodes.get(id).column === dragged.nodes.get(id).column),
            ["A", "B", "C"].map(id =>
                `${id} ${loose.nodes.get(id).column}->${dragged.nodes.get(id).column}`).join(" "));
    }

    // **The data still wins**, which is the whole point of calling it a
    // default. One flow binds its ports against the direction; it keeps them.
    {
        const bound = parse([
            { flowID: "a", source: "A", target: "B", value: 10, sourcePort: "East", targetPort: "West" },
            { flowID: "b", source: "B", target: "C", value: 10 }
        ]);
        const { corridors } = inferCorridors(bound, undefined, "TopToBottom");
        const ab = corridors.find(c => c.source === "A");
        const bc = corridors.find(c => c.source === "B");
        ok("a port bound in the data beats the direction",
            ab.sourcePort === "East" && ab.targetPort === "West",
            `${ab.sourcePort}->${ab.targetPort}`);
        ok("...while the corridor that said nothing takes the direction",
            bc.sourcePort === "South" && bc.targetPort === "North",
            `${bc.sourcePort}->${bc.targetPort}`);
    }

    // **And the node editor's per-node default sits between them.**
    {
        const editDefaults = { out: id => (id === "A" ? "North" : undefined), in: () => undefined };
        const { corridors } = inferCorridors(flows, editDefaults, "TopToBottom");
        const ab = corridors.find(c => c.source === "A" && c.target === "B");
        ok("a node edit beats the direction and loses to the data",
            ab.sourcePort === "North" && ab.targetPort === "North",
            `${ab.sourcePort}->${ab.targetPort}`);
    }

    // **The geometry cache can see it.** A direction that changed the ports
    // but not the key would draw the old picture until something else moved
    // -- the "that setting does nothing until I resize" trap in the design notes.
    {
        const INPUTS = {
            width: 1400, height: 800,
            chrome: { legendVisible: false, legendPosition: "Bottom", nodeShape: "Rectangle",
                nodeMinWidthPercent: 3, nodeMinHeightPercent: 3 },
            routing: { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline", avoidNodes: true,
                arrows: { heads: false, tails: false, angleDegrees: 90 } },
            straighten: 50, locked: null, positionsRaw: ""
        };
        const keyFor = direction => {
            const { corridors } = inferCorridors(flows, undefined, direction);
            const graph = buildGraph(flows, new Map(), axisOf(corridors)).graph;
            return geometryKey(graph, corridors, INPUTS);
        };
        // Nothing new is needed in the key for the mapping flip: it is derived
        // from the resolved ports, and  already carries both.
        ok("the geometry key moves with the direction",
            keyFor("LeftToRight") !== keyFor("TopToBottom"));
        // And between a direction and its REVERSE, which swaps the ports
        // rather than turning the diagram: the pair a corridor falls back to
        // is different, so `corridorPart` must see it.
        ok("the geometry key moves when the direction is reversed",
            keyFor("LeftToRight") !== keyFor("RightToLeft")
            && keyFor("TopToBottom") !== keyFor("BottomToTop"));
    }

    ok("the flow-direction section ran every assertion", ran === 36, String(ran));

    // Not vacuous: a bad value must fall back rather than throw or blank the
    // ports, since a hand-edited report can carry anything.
    {
        const { corridors } = inferCorridors(flows, undefined, "sideways");
        ok("an unknown direction falls back to left-to-right",
            corridors.every(c => c.sourcePort === "East" && c.targetPort === "West"),
            corridors.map(c => `${c.sourcePort}->${c.targetPort}`).join(" "));
    }
}

// --- Section: the roles a measure may be bound to (capabilities wiring) ---
//
// Flow colour and Flow display order accept a MEASURE as well as a column, so
// a DAX measure can follow a slicer and one slicer can drive the flow type and
// its colour together. Nothing in src reads the role KIND -- dataParsing takes
// whatever the dataView carries -- so the declaration IS the feature, and a
// revert of it would be silent. Fails and earlier.
{
    const fsMod = require("fs");
    const pathMod = require("path");
    const capsPath = pathMod.join(__dirname, "..", "capabilities.json");
    const caps = JSON.parse(fsMod.readFileSync(capsPath, "utf8"));
    const kindOf = name => {
        const role = caps.dataRoles.find(r => r.name === name);
        return role ? role.kind : "(role missing)";
    };

    check("flowColour accepts a measure (got " + kindOf("flowColour") + ")",
        kindOf("flowColour") === "GroupingOrMeasure");
    check("flowDisplayOrder accepts a measure (got " + kindOf("flowDisplayOrder") + ")",
        kindOf("flowDisplayOrder") === "GroupingOrMeasure");

    // Not vacuous: the file really was read and the other kinds are untouched,
    // so a blanket rewrite of every role would fail here rather than pass.
    check("value is still a Measure (got " + kindOf("value") + ")",
        kindOf("value") === "Measure");
    check("flowType is still a Grouping (got " + kindOf("flowType") + ")",
        kindOf("flowType") === "Grouping");
    check("source is still a Grouping (got " + kindOf("source") + ")",
        kindOf("source") === "Grouping");
    check("the capabilities file really has the roles (12 expected, got "
        + caps.dataRoles.length + ")", caps.dataRoles.length === 12);

    // The two added. A node's order is what the diagram LOOKS
    // like, so it is a Grouping: the standing rule is that what a flow IS may
    // follow a slicer and what the diagram looks like may not, which is why
    // flowColour and flowDisplayOrder above are the only two exceptions.
    check("sourceOrder is a Grouping (got " + kindOf("sourceOrder") + ")",
        kindOf("sourceOrder") === "Grouping");
    check("targetOrder is a Grouping (got " + kindOf("targetOrder") + ")",
        kindOf("targetOrder") === "Grouping");
}

// ===================================================================
// 7. A perpendicular wrap only clears what is ACTUALLY in the way
//. Both leads used to be floored at a lane past the
//    bounding box of BOTH nodes whether anything was in the way or not,
//    which sent an E->N wrap out past the far side of the target and back.
//    Nothing else in this file notices: the route stayed finite and
//    tunnelled no node, so a revert would be silent.
// ===================================================================
console.log("--- perpendicular wrap: no clearing where nothing is in the way ---");
{
    // A's East face looks straight at B, whose North face is level with it.
    // The source lead places the VERTICAL run; B's x-span is nowhere near it,
    // so that run has nothing to clear and belongs beside A, not past B.
    const a = makeNode("A", 100, 300, 14, 60);
    const b = makeNode("B", 300, 330, 60, 14);
    const corridor = corridorOf("A", "B", "East", "North", [{ flowType: undefined, value: 40, flows: [] }]);
    const bands = routeOne([a, b], corridor);
    check("perpendicular wrap: produced a band", bands.length === 1);
    if (bands.length === 1) {
        const pts = samplePath(bands[0].path);
        const maxX = Math.max(...pts.map(q => q.x));
        // Half the band's width (20) past B's right edge is all the ribbon
        // itself can need. The old code put the run a full clearance beyond
        // that, so this is the assertion that fails.
        const bound = b.x + b.width + 20;
        check(`perpendicular wrap: does not swing past the far node (maxX ${maxX.toFixed(1)} <= ${bound})`,
            maxX <= bound);
        // Not vacuous the other way: the route really does reach B.
        check(`perpendicular wrap: still reaches the target (maxX ${maxX.toFixed(1)} >= ${b.x})`,
            maxX >= b.x);
    }

    // A 90-degree SELF-LOOP is deliberately NOT part of this: both its runs
    // travel alongside the one node, so the clearing is what gives the hook
    // its size. It keeps leadClearing, and the loop keeps a real 2-D extent.
    const n = makeNode("N", 300, 300, 14, 60);
    const loop = corridorOf("N", "N", "East", "South", [{ flowType: undefined, value: 20, flows: [] }]);
    const loopBands = routeOne([n], loop);
    if (loopBands.length === 1) {
        const pts = samplePath(loopBands[0].path);
        const spanX = Math.max(...pts.map(q => q.x)) - Math.min(...pts.map(q => q.x));
        const spanY = Math.max(...pts.map(q => q.y)) - Math.min(...pts.map(q => q.y));
        check(`90-degree self-loop keeps its hook (${spanX.toFixed(0)}x${spanY.toFixed(0)})`,
            spanX > n.width && spanY > 5);
    }
}

// ===================================================================
// 8. A WRAP's lead handles are drawn on the MIDDLE of the run each one
//    places (the author having seen both: "midpoints makes more
//    sense"). Drawn at its stub a handle sits at the END of its run, which
//    reads as belonging to the next one. Pure placement -- the route is
//    identical either way -- so nothing else here would notice a revert.
// ===================================================================
console.log("--- a wrap's leads sit on their run's midpoint ---");
{
    // Where along the spine a point lies: which run, and how far down it.
    const place = (pt, spine) => {
        for (let k = 1; k < spine.length; k++) {
            const p0 = spine[k - 1], p1 = spine[k];
            const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            if (L < 1e-6) continue;
            const t = ((pt.x - p0.x) * (p1.x - p0.x) + (pt.y - p0.y) * (p1.y - p0.y)) / (L * L);
            const near = Math.hypot(pt.x - (p0.x + t * (p1.x - p0.x)), pt.y - (p0.y + t * (p1.y - p0.y)));
            if (t >= -1e-6 && t <= 1 + 1e-6 && near < 0.01) return t;
        }
        return undefined;
    };
    [["question mark E->N", makeNode("A", 300, 300, 14, 60), makeNode("B", 150, 420, 60, 14), "East", "North"],
     ["C loop E->W", makeNode("A", 300, 300, 14, 60), makeNode("B", 100, 380, 14, 60), "East", "West"],
     ["wrap N->S", makeNode("A", 100, 300, 60, 14), makeNode("B", 260, 380, 60, 14), "North", "South"]
    ].forEach(([label, a, b, sp, tp]) => {
        const corridor = corridorOf("A", "B", sp, tp, [{ flowType: undefined, value: 40, flows: [] }]);
        const routed = routeDiagram({
            nodes: new Map([["A", a], ["B", b]]),
            corridors: [corridor],
            valueToPixels: v => Math.max(4, v),
            columnGap: 120,
            rowPitch: 80
        }, undefined, new Map());
        const spine = routed.spines.get(corridor.id);
        const h = routed.handles.get(corridor.id);
        ["source", "target"].forEach(kind => {
            const handle = h[kind];
            const side = handle && handle.side;
            check(`${label}: ${kind} has a drawn side`, !!side);
            if (!side) return;
            const t = place(side.drawn, spine);
            check(`${label}: ${kind} drawn ON the route`, t !== undefined);
            check(`${label}: ${kind} half way along its run (t ${t === undefined ? "off" : t.toFixed(3)})`,
                t !== undefined && Math.abs(t - 0.5) < 0.01);
            // The STUB is still what is stored -- avoidance reads it off the
            // handle, so a side that lost the round trip breaks more than the
            // drawing.
            const back = side.toStub(side.drawn);
            check(`${label}: ${kind} still stores the stub`,
                Math.hypot(handle.point.x - back.x, handle.point.y - back.y) < 0.01);
        });
    });
}

// ===================================================================
// 9. ORTHOGONAL keeps a WRAP's lead handles. The strip is for
//    the direct Z, whose leads this style derives; applied to the whole
//    style it left a same-axis wrap with the lane alone and a
//    perpendicular one -- which has no lane -- with nothing at all.
//    `draggableHandles` and `routeCorridor` must agree, so both halves are
//    asserted: the handle is SHOWN, and dragging it MOVES the route.
// ===================================================================
console.log("--- Orthogonal: a wrap keeps its leads ---");
{
    const opt = { portLeadInPercent: 18, curvaturePercent: 35, style: "Orthogonal", avoidNodes: true };
    const NORMAL = { North: { x: 0, y: -1 }, South: { x: 0, y: 1 }, East: { x: 1, y: 0 }, West: { x: -1, y: 0 } };
    const square = spine => spine.every((q, i) => i === 0
        || Math.abs(q.x - spine[i - 1].x) < 1e-6 || Math.abs(q.y - spine[i - 1].y) < 1e-6);

    // Two nodes placed so EVERY pairing wraps: the target sits behind the
    // source's face and the source behind the target's.
    let shown = 0, movable = 0, diagonal = 0;
    for (const sp of PORTS) {
        for (const tp of PORTS) {
            const a = makeNode("A", 300, 300, 14, 60);
            const b = makeNode("B", 150, 420, 14, 60);
            const corridor = corridorOf("A", "B", sp, tp, [{ flowType: undefined, value: 40, flows: [] }]);
            const layout = {
                nodes: new Map([["A", a], ["B", b]]),
                corridors: [corridor],
                valueToPixels: v => Math.max(4, v),
                columnGap: 120,
                rowPitch: 80
            };
            const base = routeDiagram(layout, opt, new Map());
            const built = base.handles.get(corridor.id);
            if (!built || !built.wrap) continue;   // a direct route keeps the step-only Z
            // An ARCH has no lead handles at all: both ends reach one level,
            // so a lead would be a second name for the lane.
            if (built.hideLeads) continue;
            const visible = draggableHandles(base.handles, "Orthogonal").get(corridor.id) || {};
            ["source", "target"].forEach(kind => {
                const hd = visible[kind];
                check(`Orthogonal wrap ${sp}->${tp}: ${kind} lead is shown`, !!hd);
                if (!hd) return;
                shown++;
                const n = NORMAL[kind === "source" ? sp : tp];
                const want = { x: hd.point.x + n.x * 45, y: hd.point.y + n.y * 45 };
                const after = routeDiagram(layout, opt, new Map([[corridor.id, { [kind]: want }]]));
                const sa = base.spines.get(corridor.id), sb = after.spines.get(corridor.id);
                if (JSON.stringify(sa) !== JSON.stringify(sb)) movable++;
                if (!square(sb)) diagonal++;
                check(`Orthogonal wrap ${sp}->${tp}: dragging ${kind} moves the route`,
                    JSON.stringify(sa) !== JSON.stringify(sb));
                // The whole point of the style: no drag may produce a diagonal.
                check(`Orthogonal wrap ${sp}->${tp}: ${kind} drag stays square`, square(sb));
            });
        }
    }
    check(`Orthogonal: wrap leads were actually exercised (${shown} shown, ${movable} movable, ${diagonal} diagonal)`,
        shown >= 16 && movable === shown && diagonal === 0);

    // Not vacuous the other way: a DIRECT same-axis route still gets the Z's
    // step alone, which is the decision this narrows rather than reverses.
    const a = makeNode("A", 100, 300, 14, 60);
    const b = makeNode("B", 400, 300, 14, 60);
    const direct = corridorOf("A", "B", "East", "West", [{ flowType: undefined, value: 40, flows: [] }]);
    const layout = {
        nodes: new Map([["A", a], ["B", b]]),
        corridors: [direct],
        valueToPixels: v => Math.max(4, v),
        columnGap: 120,
        rowPitch: 80
    };
    const built = routeDiagram(layout, opt, new Map());
    const visible = draggableHandles(built.handles, "Orthogonal").get(direct.id) || {};
    check("Orthogonal direct E->W: still the step alone (no source lead)", !visible.source);
    check("Orthogonal direct E->W: still the step alone (no target lead)", !visible.target);
    check("Orthogonal direct E->W: and it does have a step", !!visible.middle);
}

// ===================================================================
// 10. A SMOOTH wrap carries a corner handle -- the question
//     mark and the C loop, which could only take their roundness from the
//     Curvature slider before. Smooth only, and it follows
//     the SQUARED radius rule, not the direct 90-degree L's: genuinely
//     sharp at Curvature 0, and each corner still takes what its own two
//     edges allow, so the handle is bounded by ITS corner, not the path.
// ===================================================================
console.log("--- Smooth wrap: the corner handle ---");
{
    const shapes = [
        ["question mark E->N", makeNode("A", 300, 300, 14, 60), makeNode("B", 150, 420, 60, 14), "East", "North"],
        ["C loop E->W", makeNode("A", 300, 300, 14, 60), makeNode("B", 100, 380, 14, 60), "East", "West"],
        // The degenerate same-port wrap: level nodes send its lane out past
        // both of them and straight back, so its middle vertex DOUBLES BACK.
        // `spread` is 1/sin(0) there and the handle used to come out at
        // infinity, which renders as cx="Infinity".
        ["C loop N->N (doubles back)", makeNode("A", 100, 300, 60, 14), makeNode("B", 260, 300, 60, 14), "North", "North"]
    ];
    shapes.forEach(([label, a, b, sp, tp]) => {
        const corridor = corridorOf("A", "B", sp, tp, [{ flowType: undefined, value: 40, flows: [] }]);
        const layout = {
            nodes: new Map([["A", a], ["B", b]]),
            corridors: [corridor],
            valueToPixels: v => Math.max(4, v),
            columnGap: 120,
            rowPitch: 80
        };
        const opt = c => ({ portLeadInPercent: 18, curvaturePercent: c, style: "Smooth", avoidNodes: true });

        // Smooth only.
        ["Polyline", "Octilinear", "Orthogonal"].forEach(style => {
            const other = routeDiagram(layout, { portLeadInPercent: 18, curvaturePercent: 35, style, avoidNodes: true });
            const shown = draggableHandles(other.handles, style).get(corridor.id) || {};
            check(`${label}: no corner handle in ${style}`, !shown.corner);
        });

        const base = routeDiagram(layout, opt(35), new Map());
        const k = base.handles.get(corridor.id).corner;
        check(`${label}: has a corner handle in Smooth`, !!k);
        if (!k) return;
        check(`${label}: every number finite (point ${k.point.x}, ${k.point.y}; r ${k.radius}; max ${k.maxRadius}; spread ${k.spread})`,
            [k.point.x, k.point.y, k.radius, k.maxRadius, k.minRadius, k.spread, k.pitch].every(Number.isFinite));
        check(`${label}: the drawn radius is within its own corner's cap (${k.radius.toFixed(1)} <= ${k.maxRadius.toFixed(1)})`,
            k.radius <= k.maxRadius + 1e-9 && k.radius >= -1e-9);

        // Curvature 0 is genuinely sharp on a squared route -- the rule the
        // direct 90-degree L does NOT follow (it floors at the half-width).
        const sharp = routeDiagram(layout, opt(0), new Map()).handles.get(corridor.id).corner;
        check(`${label}: Curvature 0 is sharp (r ${sharp ? sharp.radius.toFixed(2) : "no handle"})`,
            !sharp || sharp.radius < 1e-9);

        // A hand-set radius moves the drawing, and the handle follows it onto
        // the new arc. Asked for in the stored unit: a fraction of the pitch.
        const path0 = base.bands.find(x => x.corridorId === corridor.id).path;
        let moved = 0;
        [0.05, 0.3, 0.9].forEach(frac => {
            const after = routeDiagram(layout, opt(35), new Map([[corridor.id, { radius: frac }]]));
            const got = after.handles.get(corridor.id).corner;
            check(`${label}: radius ${frac} keeps every number finite`,
                !!got && [got.point.x, got.point.y, got.radius].every(Number.isFinite));
            if (!got) return;
            if (after.bands.find(x => x.corridorId === corridor.id).path !== path0) moved++;
            check(`${label}: radius ${frac} is honoured up to the cap (r ${got.radius.toFixed(1)}, cap ${got.maxRadius.toFixed(1)})`,
                Math.abs(got.radius - Math.min(Math.max(frac * got.pitch, got.minRadius), got.maxRadius)) < 0.01);
        });
        check(`${label}: a hand-set radius changes what is drawn (${moved} of 3)`, moved >= 2);
    });
}

// ===================================================================
// 11. The question mark is an L of four SQUARE runs in every style
//. 246 let its middle line tilt, free in Polyline and
//     Smooth and fitted to 45 degrees in Octilinear; it was saw it live --
//     "it really doesn't look good to have a non 90 degree middle line" --
//     and it was reverted. Smooth's per-corridor corner radius stayed.
// ===================================================================
console.log("--- question mark: four square runs ---");
{
    const a = makeNode("A", 300, 300, 14, 60);
    const b = makeNode("B", 150, 420, 60, 14);
    const corridor = corridorOf("A", "B", "East", "North", [{ flowType: undefined, value: 40, flows: [] }]);
    const layout = {
        nodes: new Map([["A", a], ["B", b]]),
        corridors: [corridor],
        valueToPixels: v => Math.max(4, v),
        columnGap: 120,
        rowPitch: 80
    };
    const opt = style => ({ portLeadInPercent: 18, curvaturePercent: 35, style, avoidNodes: true });
    const square = spine => spine.every((q, i) => i === 0
        || Math.abs(q.x - spine[i - 1].x) < 1e-6 || Math.abs(q.y - spine[i - 1].y) < 1e-6);

    ["Polyline", "Octilinear", "Orthogonal", "Smooth"].forEach(style => {
        const base = routeDiagram(layout, opt(style), new Map());
        const spine = base.spines.get(corridor.id);
        check(`${style}: four runs`, spine.length === 5);
        check(`${style}: every run is square`, square(spine));
        check(`${style}: no gesture on the middle line`, !base.handles.get(corridor.id).middle);
        check(`${style}: its leads are its controls`,
            !!base.handles.get(corridor.id).source && !!base.handles.get(corridor.id).target);

        // The source lead places the run out of the port; it stays square.
        const h = base.handles.get(corridor.id).source;
        const out = routeDiagram(layout, opt(style), new Map([[corridor.id,
            { source: { x: h.point.x + 40, y: h.point.y } }]]));
        check(`${style}: dragging the source lead moves the run out of the port`,
            Math.abs(out.spines.get(corridor.id)[1].x - (spine[1].x + 40)) < 0.01);
        check(`${style}: and the route stays square`, square(out.spines.get(corridor.id)));
    });
}

// ===================================================================
// 12. A same-PORT wrap goes round as an ARCH. Both ends leave
//     the same face the same way, so the lane belongs ALONG the port's
//     normal, not across it. Across it, the route ran out past both nodes
//     and straight back along its own line -- 98px out and 98px back on
//     N->N side by side, drawn over itself, with a zero-radius 180-degree
//     turn at the end of it.
// ===================================================================
console.log("--- same-port wrap: the arch ---");
{
    const build = (a, b, sp, tp, style) => {
        const corridor = corridorOf("A", "B", sp, tp, [{ flowType: undefined, value: 40, flows: [] }]);
        const id = corridor.id;
        return Object.assign({ id }, routeDiagram({
            nodes: new Map([["A", a], ["B", b]]),
            corridors: [corridor],
            valueToPixels: v => Math.max(4, v),
            columnGap: 120,
            rowPitch: 80
        }, { portLeadInPercent: 18, curvaturePercent: 35, style: style || "Polyline", avoidNodes: true }, new Map()));
    };
    // Does any pair of consecutive runs reverse? That IS the defect.
    const doublesBack = spine => {
        for (let k = 2; k < spine.length; k++) {
            const d1 = { x: spine[k - 1].x - spine[k - 2].x, y: spine[k - 1].y - spine[k - 2].y };
            const d2 = { x: spine[k].x - spine[k - 1].x, y: spine[k].y - spine[k - 1].y };
            if (d1.x * d2.x + d1.y * d2.y < -1) return true;
        }
        return false;
    };
    const repeats = spine => spine.some((q, k) =>
        k > 0 && Math.hypot(q.x - spine[k - 1].x, q.y - spine[k - 1].y) < 1e-6);
    const len = spine => { let L = 0; for (let k = 1; k < spine.length; k++)
        L += Math.hypot(spine[k].x - spine[k - 1].x, spine[k].y - spine[k - 1].y); return L; };

    [["North", makeNode("A", 100, 300, 60, 14), makeNode("B", 260, 300, 60, 14)],
     ["South", makeNode("A", 100, 300, 60, 14), makeNode("B", 260, 300, 60, 14)],
     ["East", makeNode("A", 100, 300, 14, 60), makeNode("B", 100, 420, 14, 60)],
     ["West", makeNode("A", 100, 300, 14, 60), makeNode("B", 100, 420, 14, 60)]].forEach(([port, a, b]) => {
        const out = build(a, b, port, port);
        const spine = out.spines.get(out.id);
        check(`${port}->${port}: no run doubles back (${spine.length} points)`, !doublesBack(spine));
        check(`${port}->${port}: no repeated vertex`, !repeats(spine));
        // An arch is four runs at most: out, along, in -- plus a stub where
        // the two leads differ. The side lane needed five.
        check(`${port}->${port}: ${spine.length} points, at most 5`, spine.length <= 5);
        // Its lane handle runs ALONG the normal, not across it.
        const mid = out.handles.get(out.id).middle;
        const alongX = port === "East" || port === "West";
        check(`${port}->${port}: the lane handle moves along the port (axis ${mid && mid.axis})`,
            !!mid && mid.axis === (alongX ? "x" : "y"));
        // **Its lane is its ONLY handle** . Both ends reach one level, so a lead
        // would be a second name for the lane.
        // In EVERY style: `hideLeads` is routing's answer to "may an author
        // move these", and Orthogonal's branch used to keep a wrap's leads
        // without asking.
        ["Polyline", "Octilinear", "Orthogonal", "Smooth"].forEach(style => {
            const shown = draggableHandles(build(a, b, port, port, style).handles, style).get(out.id) || {};
            check(`${port}->${port}: the lane is the only position handle in ${style}`,
                !!shown.middle && !shown.source && !shown.target);
        });
        // Hidden, never removed: avoidance reads the stubs off them.
        check(`${port}->${port}: the leads still exist for avoidance`,
            !!out.handles.get(out.id).source && !!out.handles.get(out.id).target);
        // And a stored lead is IGNORED, not left shaping it unseen.
        const c3 = corridorOf("A", "B", port, port, [{ flowType: undefined, value: 40, flows: [] }]);
        const forced = routeDiagram({
            nodes: new Map([["A", a], ["B", b]]), corridors: [c3],
            valueToPixels: v => Math.max(4, v), columnGap: 120, rowPitch: 80
        }, { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline", avoidNodes: true },
            new Map([[c3.id, { source: { x: a.x - 90, y: a.y - 90 } }]]));
        check(`${port}->${port}: a stored lead is ignored`,
            JSON.stringify(forced.spines.get(c3.id)) === JSON.stringify(spine));
        if (mid) {
            // And it moves the route, both ways.
            const n = { North: { x: 0, y: -1 }, South: { x: 0, y: 1 },
                East: { x: 1, y: 0 }, West: { x: -1, y: 0 } }[port];
            const c2 = corridorOf("A", "B", port, port, [{ flowType: undefined, value: 40, flows: [] }]);
            const outward = routeDiagram({
                nodes: new Map([["A", a], ["B", b]]), corridors: [c2],
                valueToPixels: v => Math.max(4, v), columnGap: 120, rowPitch: 80
            }, { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline", avoidNodes: true },
                new Map([[c2.id, { middle: { x: mid.point.x + n.x * 50, y: mid.point.y + n.y * 50 } }]]));
            check(`${port}->${port}: dragging the lane out moves the route`,
                JSON.stringify(outward.spines.get(c2.id)) !== JSON.stringify(spine));
        }
    });

    // The SQUEEZE: one node across the other's way, so the arch's descent
    // would cut it. The side lane is then the right shape after all.
    {
        const a = makeNode("A", 100, 300, 60, 14);
        const b = makeNode("B", 100, 420, 60, 14);   // directly below, same x
        const r = build(a, b, "North", "North"); const spine = r.spines.get(r.id);
        check(`N->N stacked: squeezes past on a side lane (${spine.length} points)`, spine.length === 6);
        check(`N->N stacked: and still does not double back`, !doublesBack(spine));
    }

    // Opposite ports on the same axis keep the side lane: those two ends
    // leave in opposite directions and have to be brought round.
    {
        const a = makeNode("A", 100, 300, 60, 14);
        const b = makeNode("B", 260, 380, 60, 14);
        const r = build(a, b, "North", "South"); const spine = r.spines.get(r.id);
        check(`N->S keeps its side lane (${spine.length} points)`, spine.length === 6);
    }

    // Identical in every style: a wrap is squared off the same way in all four.
    {
        const a = makeNode("A", 100, 300, 60, 14), b = makeNode("B", 260, 300, 60, 14);
        const paths = ["Polyline", "Octilinear", "Orthogonal", "Smooth"]
            .map(st => { const r = build(a, b, "North", "North", st); return JSON.stringify(r.spines.get(r.id)); });
        check("the arch is the same spine in all four styles", new Set(paths).size === 1);
        const shorter = len(JSON.parse(paths[0]));
        check(`and it is shorter than the side lane it replaces (${shorter.toFixed(0)}px)`, shorter < 300);
    }

    // A SELF-LOOP never arches: both ends are the same node, and loops are
    // designed once and shared by all four styles.
    {
        const n = makeNode("N", 300, 300, 14, 60);
        const loop = corridorOf("N", "N", "East", "East", [{ flowType: undefined, value: 20, flows: [] }]);
        const built = routeDiagram({
            nodes: new Map([["N", n]]), corridors: [loop],
            valueToPixels: v => Math.max(4, v), columnGap: 120, rowPitch: 80
        }, { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline", avoidNodes: true }, new Map());
        const sp = built.spines.get(loop.id);
        check(`a 0-degree self-loop still has real 2-D extent`,
            Math.max(...sp.map(q => q.x)) - Math.min(...sp.map(q => q.x)) > 5
            && Math.max(...sp.map(q => q.y)) - Math.min(...sp.map(q => q.y)) > 5);
    }
}

// ===================================================================
// 13. A HAND-MOVED lead may come out the NEAR side of an obstacle
//. The run has to miss the node; which side it misses it
//     on is the author's business -- the same two answers `loopSide`
//     already gives a self-loop's lane. Untouched leads still go out the
//     far side, so nothing nobody has touched moves.
// ===================================================================
console.log("--- a dragged lead steps over its obstacle ---");
{
    // A's East lead places the vertical run; B sits across it, so a plain
    // lead is pushed out past B's far edge.
    const a = makeNode("A", 100, 300, 14, 60);
    const b = makeNode("B", 220, 300, 60, 14);
    const corridor = corridorOf("A", "B", "East", "North", [{ flowType: undefined, value: 40, flows: [] }]);
    const layout = {
        nodes: new Map([["A", a], ["B", b]]),
        corridors: [corridor],
        valueToPixels: v => Math.max(4, v),
        columnGap: 120,
        rowPitch: 80
    };
    const opt = { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline", avoidNodes: true };
    const at = drop => routeDiagram(layout, opt, new Map([[corridor.id, { source: drop }]]))
        .spines.get(corridor.id)[1].x;
    const base = routeDiagram(layout, opt, new Map());
    const e = base.handles.get(corridor.id).source;
    check("the obstructed pairing has a lead to drag", !!e);
    if (e) {
        const reached = new Set();
        [20, 40, 80, 120, 160, 220, 260].forEach(d => reached.add(at({ x: e.point.x + d, y: e.point.y }).toFixed(1)));
        // Before this, every inward drop stopped at one coordinate: the far
        // edge. Now the near side is reachable too, so the dragged run can
        // sit on either side of B.
        check(`a dragged lead reaches more than one coordinate (${reached.size} of 7 drops distinct)`,
            reached.size >= 3);
        const near = at({ x: e.point.x + 40, y: e.point.y });
        const far = at({ x: e.point.x + 220, y: e.point.y });
        check(`and the two sides are on opposite sides of the obstacle (${near.toFixed(0)} vs ${far.toFixed(0)})`,
            near < b.x && far > b.x + b.width);
    }
}

// ===================================================================
// 14. A HORSESHOE can be flipped to the other side. Routing
//     always drew the flipped shape, but the lane could not be dragged
//     there: part way across it ran THROUGH both nodes, and a drop is
//     clamped to the viewport, so a pair against the bottom edge had
//     nowhere below to drop it. Held clear of the pair, the drag passes
//     their far face and lands just beyond it.
// ===================================================================
console.log("--- the horseshoe flips ---");
{
    const a = makeNode("A", 150, 400, 14, 60);
    const b = makeNode("B", 400, 400, 14, 60);
    const corridor = corridorOf("A", "B", "West", "East", [{ flowType: undefined, value: 40, flows: [] }]);
    const layout = {
        nodes: new Map([["A", a], ["B", b]]),
        corridors: [corridor],
        valueToPixels: v => Math.max(4, v),
        columnGap: 120,
        rowPitch: 80
    };
    const opt = { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline", avoidNodes: true };
    const base = routeDiagram(layout, opt, new Map());
    const mid = base.handles.get(corridor.id).middle;
    check("the horseshoe has a lane handle", !!mid);
    if (mid) {
        const laneAt = y => routeDiagram(layout, opt,
            new Map([[corridor.id, { middle: { x: mid.point.x, y } }]])).spines.get(corridor.id)[2].y;
        const low = a.y, high = a.y + a.height;
        check(`a drop above the pair stays above (${laneAt(300).toFixed(0)})`, laneAt(300) < low);
        // The defect: a drop INSIDE the pair used to put the band straight
        // through both nodes. Avoidance does not rescue it -- its slide
        // ignores a corridor's own two nodes.
        [low + 5, (low + high) / 2, high - 5].forEach(y => {
            const got = laneAt(y);
            check(`a drop inside the pair (${y.toFixed(0)}) is held clear (${got.toFixed(0)})`,
                got < low || got > high);
        });
        // And past their far face it flips, with no room needed on screen.
        const flipped = laneAt(high + 10);
        check(`a drop past the far face flips it below (${flipped.toFixed(0)} > ${high})`, flipped > high);
        check(`and further out still follows (${laneAt(800).toFixed(0)})`, laneAt(800) > flipped);

        // The flipped route is a real horseshoe: it misses both nodes.
        const out = routeDiagram(layout, opt,
            new Map([[corridor.id, { middle: { x: mid.point.x, y: high + 10 } }]]));
        const pts = samplePath(out.bands[0].path);
        const inside = (p, n) => p.x > n.x + 1 && p.x < n.x + n.width - 1
            && p.y > n.y + 1 && p.y < n.y + n.height - 1;
        check("the flipped horseshoe misses both nodes",
            !pts.some(p => inside(p, a) || inside(p, b)));
    }
}

if (failures === 0) {
    console.log("\nALL PORT-ROUTING CHECKS PASSED");
} else {

console.log(`\n${failures} PORT-ROUTING CHECK(S) FAILED`);
    process.exit(1);
}
