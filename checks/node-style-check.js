"use strict";
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors, routeDiagram } = require("./routing-api.js");

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
const chrome = (nodeMinPercent = 3, shape = undefined) => ({
    legendVisible: false, legendPosition: "Bottom",
    nodeMinWidthPercent: nodeMinPercent, nodeMinHeightPercent: nodeMinPercent,
    ...(shape ?? {})
});

function pipeline(rows, nodeMinPercent = 3, viewport = { w: 1400, h: 800 }, shape = undefined) {
    const { flows, warnings } = parseDataView(dataViewOf(rows));
    const { graph, warnings: gw } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const layout = computeLayout(graph, corridors, viewport.w, viewport.h, chrome(nodeMinPercent, shape));
    return { warnings, graphWarnings: gw, graph, corridors, layout };
}

// ===============================================================
// 2. Arrow direction: the busiest OUTGOING port.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10 },              // A: East out
        { source: "H", target: "N", value: 5, sourcePort: "North", targetPort: "South" },
        { source: "H", target: "S", value: 40, sourcePort: "South", targetPort: "North" }
    ];
    const { layout } = pipeline(rows);
    check("a plain source points East", layout.nodes.get("A").flowDirection === "East",
        layout.nodes.get("A").flowDirection);
    check("a node whose biggest outflow leaves South points South",
        layout.nodes.get("H").flowDirection === "South", layout.nodes.get("H").flowDirection);
}
{
    // A sink has no outflow at all -- it points ONWARD, away from its supply,
    // not back down the corridor that fed it.
    const rows = [
        { source: "A", target: "Z", value: 10, sourcePort: "East", targetPort: "West" },
        { source: "B", target: "Y", value: 10, sourcePort: "South", targetPort: "North" }
    ];
    const { layout } = pipeline(rows);
    check("a sink entered from its West face points East",
        layout.nodes.get("Z").flowDirection === "East", layout.nodes.get("Z").flowDirection);
    check("a sink entered from its North face points South",
        layout.nodes.get("Y").flowDirection === "South", layout.nodes.get("Y").flowDirection);
}
{
    // Outgoing beats incoming even when the incoming side is much busier --
    // the arrow shows where flow is HEADING, not where most of it sits.
    const rows = [
        { source: "A", target: "M", value: 500, sourcePort: "East", targetPort: "West" },
        { source: "M", target: "B", value: 3, sourcePort: "North", targetPort: "South" }
    ];
    check("a hub points along its (much smaller) outflow, not its inflow",
        pipeline(rows).layout.nodes.get("M").flowDirection === "North");
}
{
    // An isolated node with no flow either way still has to answer.
    const rows = [{ source: "A", target: "B", value: 0 }];
    const { layout } = pipeline(rows);
    check("a zero-flow node falls back to East",
        layout.nodes.get("A").flowDirection === "East" && layout.nodes.get("B").flowDirection === "East");
}
{
    // Every node in every dataset must get a direction -- the field is not
    // optional, and a missing one would render an arrow pointing nowhere.
    const rows = [];
    for (let i = 0; i < 6; i++) {
        rows.push({ source: `S${i}`, target: "HUB", value: 10 + i });
        rows.push({ source: "HUB", target: `T${i}`, value: 5 + i, sourcePort: i % 2 ? "North" : "East" });
    }
    rows.push({ source: "HUB", target: "HUB", value: 4, sourcePort: "East", targetPort: "South" });
    const { layout } = pipeline(rows);
    const PORTS = ["North", "South", "East", "West"];
    const bad = Array.from(layout.nodes.values()).filter(n => !PORTS.includes(n.flowDirection));
    check("every node has a valid flow direction", bad.length === 0, `${bad.length} bad`);
}

// ===============================================================
// 3. Node width reaches layout as a fraction of the column gap.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "B", target: "C", value: 10 }
    ];
    const wide = pipeline(rows, 10).layout;
    const thin = pipeline(rows, 1).layout;
    const zero = pipeline(rows, 0).layout;

    let ran = 0;
    wide.nodes.forEach(n => {
        ran++;
        check(`${n.id}: width is 10% of the column gap`,
            Math.abs(n.width - wide.columnGap * 0.10) < 0.01,
            `${n.width.toFixed(2)} vs ${(wide.columnGap * 0.10).toFixed(2)}`);
    });
    check("the per-node width assertion actually ran", ran === 3, String(ran));
    check("1% is thinner than 10%", thin.nodes.get("B").width < wide.nodes.get("B").width,
        `${thin.nodes.get("B").width.toFixed(2)} vs ${wide.nodes.get("B").width.toFixed(2)}`);
    check("0% collapses the node to nothing", zero.nodes.get("B").width === 0,
        String(zero.nodes.get("B").width));

    // The closed form: the column gap absorbs the node's own thickness, so
    // however fat a node gets the diagram still ends on the right margin.
    // Without it, a fat node would push the last column off the viewport.
    const rightEdge = l => {
        let m = 0;
        l.nodes.forEach(n => { m = Math.max(m, n.x + n.width); });
        return m;
    };
    // The fit leaves a quarter of a gap past the rightmost node, and the
    // gap differs between the two, so compare where that margin ENDS.
    const drawnEnd = l => rightEdge(l) + 0.25 * l.columnGap;
    check("a fat node doesn't push the diagram past the right margin",
        Math.abs(drawnEnd(wide) - drawnEnd(zero)) < 0.01,
        `${drawnEnd(wide).toFixed(2)} vs ${drawnEnd(zero).toFixed(2)}`);
}
{
    // Zero width is only safe because the thickness is never the packing
    // extent on an axis that actually carries demand -- a node with
    // North/South flow takes its width from that flow instead.
    const rows = [
        { source: "A", target: "B", value: 100, sourcePort: "South", targetPort: "North" },
        { source: "C", target: "D", value: 100 }
    ];
    const zero = pipeline(rows, 0).layout;
    check("at 0%, a North/South node still has width for its ports to pack into",
        zero.nodes.get("A").width > 1, String(zero.nodes.get("A").width));
    check("at 0%, an East/West node still has height for its ports to pack into",
        zero.nodes.get("C").height > 1, String(zero.nodes.get("C").height));
    check("at 0%, the East/West node has collapsed across its flow",
        zero.nodes.get("C").width === 0, String(zero.nodes.get("C").width));
    check("at 0%, the North/South node has collapsed across its flow",
        zero.nodes.get("A").height === 0, String(zero.nodes.get("A").height));
}
{
    // A single-column diagram has no column gap for the fraction to be OF,
    // so it falls back to the row pitch instead of collapsing every node.
    const rows = [{ source: "A", target: "A", value: 10, sourcePort: "East", targetPort: "West" }];
    const one = pipeline(rows, 10).layout;
    check("a single-column diagram has no column gap", one.columnGap === 0, String(one.columnGap));
    check("...so node width falls back to the row pitch",
        Math.abs(one.nodes.get("A").width - one.rowPitch * 0.10) < 0.01,
        `${one.nodes.get("A").width.toFixed(2)} vs ${(one.rowPitch * 0.10).toFixed(2)}`);
    check("...which is not zero", one.nodes.get("A").width > 1, String(one.nodes.get("A").width));
}


{
    // The two floors are INDEPENDENT, one per axis. That independence is
    // what replaced "Node width" -- a single thickness ACROSS the flow,
    // which had to guess which axis it belonged on. Guessing it from the
    // dominant flow caused both bugs this block used to cover: a South-fed
    // node coming out a perfect square, and a junction stuck at 4px.
    const rows = [
        { source: "A", target: "B", value: 100 },
        { source: "S", target: "T", value: 100, sourcePort: "South", targetPort: "North" }
    ];
    const wideOnly = pipeline(rows, 3, { w: 1400, h: 800 },
        { nodeMinWidthPercent: 20, nodeMinHeightPercent: 0 }).layout;
    const tallOnly = pipeline(rows, 3, { w: 1400, h: 800 },
        { nodeMinWidthPercent: 0, nodeMinHeightPercent: 20 }).layout;
    const widthFloor = wideOnly.columnGap * 0.20;
    const heightFloor = tallOnly.rowPitch * 0.20;

    // A is East/West: its height is its flow, its width only the floor.
    check("a width floor lifts the width",
        Math.abs(wideOnly.nodes.get("A").width - widthFloor) < 0.01,
        `${wideOnly.nodes.get("A").width.toFixed(2)} vs ${widthFloor.toFixed(2)}`);
    check("...and leaves the height to the flow",
        Math.abs(wideOnly.nodes.get("A").height - wideOnly.valueToPixels(100)) < 0.01,
        `${wideOnly.nodes.get("A").height.toFixed(2)} vs ${wideOnly.valueToPixels(100).toFixed(2)}`);

    // S is North/South: the mirror image, which the old single thickness
    // had to infer and this simply states.
    check("a height floor lifts the height",
        Math.abs(tallOnly.nodes.get("S").height - heightFloor) < 0.01,
        `${tallOnly.nodes.get("S").height.toFixed(2)} vs ${heightFloor.toFixed(2)}`);
    check("...and leaves the width to the flow",
        Math.abs(tallOnly.nodes.get("S").width - tallOnly.valueToPixels(100)) < 0.01,
        `${tallOnly.nodes.get("S").width.toFixed(2)} vs ${tallOnly.valueToPixels(100).toFixed(2)}`);
    // The floors are absolute, so a height floor lifts an East/West node
    // too once it exceeds that node's flow -- it is not "the axis across
    // the flow", it is that axis.
    check("...and a height floor reaches an East/West node as well",
        tallOnly.nodes.get("A").height >= heightFloor - 0.01,
        `${tallOnly.nodes.get("A").height.toFixed(2)} vs ${heightFloor.toFixed(2)}`);
    check("...so neither node is square unless both floors ask for it",
        Math.abs(wideOnly.nodes.get("A").width - wideOnly.nodes.get("A").height) > 1
        && Math.abs(tallOnly.nodes.get("S").width - tallOnly.nodes.get("S").height) > 1);
}
{
    // A junction -- East/West flow plus a small South self-loop -- is sized
    // on each axis by the flow that packs along it, and lifted by the
    // floors. It used to come out 4px wide (the "75" node on the biarc
    // data) when neither axis was floored.
    const rows = [
        { source: "A", target: "J", value: 100 },
        { source: "J", target: "B", value: 90 },
        { source: "J", target: "J", value: 5, sourcePort: "East", targetPort: "South" }
    ];
    const lay = pipeline(rows, 3, { w: 1400, h: 800 },
        { nodeMinWidthPercent: 20, nodeMinHeightPercent: 0 }).layout;
    const j = lay.nodes.get("J");
    const floor = lay.columnGap * 0.20;

    check("a junction is lifted to the width floor, not left at its thin South flow",
        Math.abs(j.width - floor) < 0.01,
        `${j.width.toFixed(2)} vs floor ${floor.toFixed(2)}, South flow ${lay.valueToPixels(5).toFixed(2)}`);
    check("...with its height still from its East/West flow",
        Math.abs(j.height - lay.valueToPixels(100)) < 0.01,
        `${j.height.toFixed(2)} vs ${lay.valueToPixels(100).toFixed(2)}`);
    check("...so the junction is not square either",
        Math.abs(j.width - j.height) > 1,
        `${j.width.toFixed(1)} x ${j.height.toFixed(1)}`);
}

// ===============================================================
// 3c. Node shapes: size, aspect, floor, and fit to label.
// ===============================================================
const VIEW = { w: 1400, h: 800 };
const shapeOf = (rows, shape) => pipeline(rows, 3, VIEW, shape).layout;
{
    // A shape is sized from its NODE, with the two minimums as the only way
    // to make it bigger -- one control for how big a node is, two for the
    // proportions a shape keeps. Measured on a node small enough that the
    // minimums, not the node, decide.
    const rows = [
        { source: "Big", target: "Huge", value: 1000 },
        { source: "A", target: "B", value: 10 }
    ];
    const lay = shapeOf(rows, {
        nodeShape: "Rectangle", nodeMinWidthPercent: 10, nodeMinHeightPercent: 6
    });
    const a = lay.nodes.get("A");
    const minWidth = lay.columnGap * 0.10;
    const minHeight = lay.rowPitch * 0.06;

    // The minimums size the NODE, and the shape inherits them because it
    // is sized from the node. Applied only to the shape, the node stayed
    // small underneath it and the two drifted apart.
    check("a node honours its minimum width",
        Math.abs(a.width - minWidth) < 0.01,
        `${a.width.toFixed(2)} vs ${minWidth.toFixed(2)}`);
    check("...and its minimum height",
        Math.abs(a.height - minHeight) < 0.01,
        `${a.height.toFixed(2)} vs ${minHeight.toFixed(2)}`);
    check("...and its shape inherits both",
        Math.abs(a.shapeWidth - minWidth) < 0.01 && Math.abs(a.shapeHeight - minHeight) < 0.01,
        `${a.shapeWidth.toFixed(2)} x ${a.shapeHeight.toFixed(2)}`);
    check("...so the two together set the proportions",
        a.shapeWidth > a.shapeHeight + 1,
        `${a.shapeWidth.toFixed(1)} x ${a.shapeHeight.toFixed(1)}`);

    // With no minimums at all it is exactly the node, which is the whole
    // point of tying the two together.
    const bare = shapeOf(rows, {
        nodeShape: "Rectangle", nodeMinWidthPercent: 0, nodeMinHeightPercent: 0
    }).nodes.get("A");
    check("with no minimums a shape is exactly its node",
        Math.abs(bare.shapeWidth - bare.width) < 0.01
        && Math.abs(bare.shapeHeight - bare.height) < 0.01,
        `${bare.shapeWidth.toFixed(1)}x${bare.shapeHeight.toFixed(1)} vs node ${bare.width.toFixed(1)}x${bare.height.toFixed(1)}`);
}
{
    // The floor covers the node PER AXIS. Flooring both axes by the longer
    // side turned a 34x263 bar into a 263x263 block.
    const lay = shapeOf([{ source: "A", target: "B", value: 10 }],
        { nodeShape: "Rectangle", nodeMinWidthPercent: 0, nodeMinHeightPercent: 0 });
    const a = lay.nodes.get("A");

    check("a shape always covers its node, so no band pokes out",
        a.shapeWidth >= a.width - 0.001 && a.shapeHeight >= a.height - 0.001,
        `shape ${a.shapeWidth.toFixed(1)}x${a.shapeHeight.toFixed(1)}, node ${a.width.toFixed(1)}x${a.height.toFixed(1)}`);
    check("...without squaring off a tall thin node",
        Math.abs(a.shapeWidth - a.shapeHeight) > 1,
        `${a.shapeWidth.toFixed(1)} x ${a.shapeHeight.toFixed(1)}`);
    check("...taking each axis from the node it has to cover",
        Math.abs(a.shapeWidth - a.width) < 0.01 && Math.abs(a.shapeHeight - a.height) < 0.01);
}
{
    // A circle is the exception: it takes the node's DIAGONAL, or its
    // corners -- where corridors really are anchored -- fall outside it.
    // Both axes non-zero, or the "diagonal" degenerates to the one side
    // that exists and the comparison below says nothing.
    const lay = shapeOf([{ source: "A", target: "B", value: 10 }],
        { nodeShape: "Circle", nodeMinWidthPercent: 5, nodeMinHeightPercent: 0 });
    const a = lay.nodes.get("A");

    check("a circle is round", Math.abs(a.shapeWidth - a.shapeHeight) < 0.001,
        `${a.shapeWidth.toFixed(1)} x ${a.shapeHeight.toFixed(1)}`);
    check("...sized by the node's diagonal",
        Math.abs(a.shapeWidth - Math.hypot(a.width, a.height)) < 0.01,
        `${a.shapeWidth.toFixed(2)} vs ${Math.hypot(a.width, a.height).toFixed(2)}`);
    check("...which is strictly bigger than its longer side",
        a.shapeWidth > Math.max(a.width, a.height) + 0.001);
}
{
    // Fit to label widens a shape rather than pushing the label out.
    const id = "Considerably Longer Name";
    const rows = [{ source: "A", target: id, value: 10 }];
    const small = { nodeShape: "Rectangle", nodeMinWidthPercent: 0, nodeMinHeightPercent: 0 };
    const off = shapeOf(rows, small).nodes.get(id);
    const on = shapeOf(rows, { ...small, nodeShapeFitLabel: true }).nodes.get(id);

    check("a long label overflows a small shape and goes outside",
        off.labelInside === false, String(off.labelInside));
    check("...and Fit to label widens the shape instead",
        on.shapeWidth > off.shapeWidth + 1,
        `${on.shapeWidth.toFixed(1)} vs ${off.shapeWidth.toFixed(1)}`);
    check("...bringing the label inside", on.labelInside === true, String(on.labelInside));
    check("...and leaves the height alone",
        Math.abs(on.shapeHeight - off.shapeHeight) < 0.001,
        `${on.shapeHeight.toFixed(2)} vs ${off.shapeHeight.toFixed(2)}`);
    check("no shape means no shape geometry at all",
        pipeline(rows).layout.nodes.get(id).shapeWidth === 0);
}

{
    // A rounded corner must not bite through the node rectangle. The
    // outermost corridor on a face is anchored exactly at the node's
    // corner, so a curve cutting across there leaves it outside the card
    // that is standing in for its node.
    //
    // Swept over a sparse and a dense shape at three sizes, because the
    // radius is a fraction of the shorter side -- which side that is, and
    // therefore whether growing an axis also grows the radius, changes with
    // the setting.
    const CORNER = 0.18;
    const routingOf = corridors => {
        const faces = {};
        corridors.forEach(c => {
            (faces[c.source] = faces[c.source] || new Set()).add(c.sourcePort);
            (faces[c.target] = faces[c.target] || new Set()).add(c.targetPort);
        });
        return faces;
    };
    const cases = [
        ["East/West routing", [{ source: "A", target: "B", value: 10 }]],
        ["North/South routing", [{ source: "A", target: "B", value: 10, sourcePort: "South", targetPort: "North" }]],
        ["both axes", [
            { source: "A", target: "B", value: 100 },
            { source: "B", target: "C", value: 90 },
            { source: "B", target: "B", value: 5, sourcePort: "East", targetPort: "South" }
        ]]
    ];

    let ran = 0;
    let failed = 0;
    cases.forEach(([what, rows]) => {
        [1, 8, 40].forEach(size => {
            const run = pipeline(rows, 3, VIEW, { nodeShape: "Rounded", nodeMinWidthPercent: size, nodeMinHeightPercent: size / 2 });
            const faces = routingOf(run.corridors);
            run.layout.nodes.forEach(n => {
                const f = faces[n.id] || new Set();
                const routesWide = f.has("East") || f.has("West");
                const routesTall = f.has("North") || f.has("South");
                const r = CORNER * Math.min(n.shapeWidth, n.shapeHeight);
                const wideOk = n.shapeWidth - 2 * r >= n.width - 0.001;
                const tallOk = n.shapeHeight - 2 * r >= n.height - 0.001;
                ran++;
                // The direction follows the node's own ROUTING, so every
                // shape in a diagram grows the same way for the same reason
                // -- not whichever axis happened to be cheapest per node.
                if ((routesWide && !wideOk) || (routesTall && !tallOk)) {
                    failed++;
                    console.log(`      ${what} at ${size}%: ${n.id} routes ${routesWide ? "wide" : ""}${routesTall ? "+tall" : ""}, node ${n.width.toFixed(1)}x${n.height.toFixed(1)}, shape ${n.shapeWidth.toFixed(1)}x${n.shapeHeight.toFixed(1)}`);
                }
            });
        });
    });
    check("every rounded shape clears its node in the direction it routes",
        failed === 0, `${failed} of ${ran} failed`);
    // Guards the sweep itself: an empty layout would pass the line above.
    check("the corner-clearance sweep actually ran", ran >= 18, `${ran} assertions`);

    // Pin the DIRECTION, not only the clearance. Growing the other axis
    // would still clear the corner, and that is exactly what was rejected:
    // it made neighbouring shapes grow different ways.
    const ew = shapeOf([{ source: "A", target: "B", value: 10 }],
        { nodeShape: "Rounded", nodeMinWidthPercent: 0, nodeMinHeightPercent: 0 }).nodes.get("A");
    check("an East/West-routed node is grown WIDE",
        ew.shapeWidth > ew.width + 1,
        `${ew.shapeWidth.toFixed(1)} vs node ${ew.width.toFixed(1)}`);
    check("...and keeps its node's own height",
        Math.abs(ew.shapeHeight - ew.height) < 0.01,
        `${ew.shapeHeight.toFixed(1)} vs ${ew.height.toFixed(1)}`);

    const ns = shapeOf([{ source: "A", target: "B", value: 10, sourcePort: "South", targetPort: "North" }],
        { nodeShape: "Rounded", nodeMinWidthPercent: 0, nodeMinHeightPercent: 0 }).nodes.get("A");
    check("a North/South-routed node is grown TALL",
        ns.shapeHeight > ns.height + 1,
        `${ns.shapeHeight.toFixed(1)} vs node ${ns.height.toFixed(1)}`);
    check("...and keeps its node's own width",
        Math.abs(ns.shapeWidth - ns.width) < 0.01,
        `${ns.shapeWidth.toFixed(1)} vs ${ns.width.toFixed(1)}`);

    // A plain Rectangle has square corners and must NOT be inflated for it.
    const plain = shapeOf([{ source: "A", target: "B", value: 10 }],
        { nodeShape: "Rectangle", nodeMinWidthPercent: 0, nodeMinHeightPercent: 0 }).nodes.get("A");
    check("a square-cornered Rectangle is left at the node's own size",
        Math.abs(plain.shapeWidth - plain.width) < 0.01
        && Math.abs(plain.shapeHeight - plain.height) < 0.01,
        `${plain.shapeWidth.toFixed(1)}x${plain.shapeHeight.toFixed(1)} vs node ${plain.width.toFixed(1)}x${plain.height.toFixed(1)}`);
    // ...and the rounded one at the same setting IS inflated, or the check
    // above would pass for the wrong reason.
    const round = shapeOf([{ source: "A", target: "B", value: 10 }],
        { nodeShape: "Rounded", nodeMinWidthPercent: 0, nodeMinHeightPercent: 0 }).nodes.get("A");
    check("...while the rounded one at the same setting is grown to clear",
        round.shapeWidth > plain.shapeWidth + 0.01 || round.shapeHeight > plain.shapeHeight + 0.01,
        `${round.shapeWidth.toFixed(1)}x${round.shapeHeight.toFixed(1)}`);
}

{
    // The inside-fit must budget for the NODE TOTAL, not just the name: the
    // total is a second line, and "1,234.5 TWh" is far wider than the name
    // "A" above it. Measuring the name alone put text inside a shape too
    // small to hold it, and it spilled out of the bottom.
    const labelsOf = over => Object.assign({
        nodeTotals: true, basis: "Larger", units: "TWh", decimalPlaces: 1
    }, over || {});
    // "Big" dominates the scale, so A is small enough for the setting -- not
    // its own flow -- to decide the shape.
    const rows = [
        { source: "Big", target: "Huge", value: 10000 },
        { source: "A", target: "B", value: 1234.5 }
    ];
    const base = { nodeShape: "Rectangle", nodeMinWidthPercent: 3, nodeMinHeightPercent: 2 };

    const on = shapeOf(rows, Object.assign({}, base, { labels: labelsOf() }));
    const off = shapeOf(rows, Object.assign({}, base, { labels: labelsOf({ nodeTotals: false }) }));

    check("a name that fits alone is drawn inside",
        off.nodes.get("A").labelInside === true, String(off.nodes.get("A").labelInside));
    check("...and is pushed outside once its total is shown too",
        on.nodes.get("A").labelInside === false, String(on.nodes.get("A").labelInside));

    // Adding a line can never make the block easier to fit.
    let ran = 0;
    let wrong = 0;
    on.nodes.forEach(n => {
        ran++;
        if (n.labelInside && !off.nodes.get(n.id).labelInside) { wrong++; }
    });
    check("showing totals never makes a label EASIER to fit inside",
        wrong === 0, `${wrong} of ${ran}`);
    check("the totals-fit comparison actually ran", ran === 4, String(ran));

    const fitted = shapeOf(rows,
        Object.assign({}, base, { nodeShapeFitLabel: true, labels: labelsOf() })).nodes.get("A");
    check("Fit to label brings the pair inside", fitted.labelInside === true,
        String(fitted.labelInside));
    check("...making room for BOTH lines, not just the wider one",
        fitted.shapeHeight >= 26, fitted.shapeHeight.toFixed(1));
    check("...and for the TOTAL's own width, which beats the name's",
        fitted.shapeWidth >= "1,234.5 TWh".length * 5.1,
        fitted.shapeWidth.toFixed(1));
}
{
    // The fit is tested on BOTH axes. This is the case that tells that apart
    // from testing the width alone: a one-character name and a
    // one-character total are narrow enough for the shape, but two stacked
    // lines are still taller than it. Sized deliberately into that window --
    // a shape wide enough and, at 16:9, too short.
    const labels = {
        nodeTotals: true, basis: "Larger", units: "", decimalPlaces: 0
    };
    const rows = [
        { source: "Big", target: "Huge", value: 10000 },
        { source: "A", target: "B", value: 5 }
    ];
    // The block is max(name 6.2, total 5.1) + 20 padding = 26.2 wide and
    // 14 + 12 = 26 tall. A 36px-wide shape is 20.25 tall at 16:9.
    const gap = shapeOf(rows, { nodeShape: "Rectangle", nodeMinWidthPercent: 10, nodeMinHeightPercent: 6 }).columnGap;
    const tight = shapeOf(rows, {
        nodeShape: "Rectangle", nodeMinWidthPercent: (36 / gap) * 100, nodeMinHeightPercent: 0, labels
    }).nodes.get("A");

    check("the tight shape is wide enough for the label block",
        tight.shapeWidth >= 26.2, tight.shapeWidth.toFixed(2));
    check("...but too short for its two lines",
        tight.shapeHeight < 26, tight.shapeHeight.toFixed(2));
    check("...so the label goes outside on HEIGHT alone",
        tight.labelInside === false, String(tight.labelInside));
}

// ===============================================================
// 3b. Labels go against the node's emptiest face.
// ===============================================================
{
    // One anchored face puts the label OPPOSITE it wherever the node sits.
    // Only the outermost columns used to do this, so an interior source node
    // had its label sent North purely because North sorted first.
    const rows = [
        { source: "Wind", target: "Grid", value: 120, sourceColumn: 1, targetColumn: 3 },
        { source: "Gas", target: "Grid", value: 100, sourceColumn: 2 },
        { source: "Grid", target: "Drop", value: 20, sourcePort: "East", targetPort: "South" }
    ];
    const { layout } = pipeline(rows);
    check("a source node in an INTERIOR column labels West, like the outer ones",
        layout.nodes.get("Gas").labelPort === "West", layout.nodes.get("Gas").labelPort);
    check("...and the outermost one still does too",
        layout.nodes.get("Wind").labelPort === "West", layout.nodes.get("Wind").labelPort);
    check("a node anchored only on its South face labels North",
        layout.nodes.get("Drop").labelPort === "North", layout.nodes.get("Drop").labelPort);
    check("a node anchored on two faces still falls through to the emptiest",
        layout.nodes.get("Grid").labelPort === "North", layout.nodes.get("Grid").labelPort);
}
{
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "B", target: "C", value: 10 }
    ];
    const { layout } = pipeline(rows);
    check("a source node on the leftmost column labels West",
        layout.nodes.get("A").labelPort === "West", layout.nodes.get("A").labelPort);
    check("a sink node on the rightmost column labels East",
        layout.nodes.get("C").labelPort === "East", layout.nodes.get("C").labelPort);
    check("a mid-chain node, busy East and West, labels North",
        layout.nodes.get("B").labelPort === "North", layout.nodes.get("B").labelPort);
}
{
    // Busy on all four faces: demand decides, and it must BEAT the tie-break
    // order rather than the order quietly winning.
    const rows = [
        { source: "A", target: "B", value: 100 },
        { source: "B", target: "C", value: 100 },
        { source: "N", target: "B", value: 50, targetPort: "North" },
        { source: "B", target: "S", value: 1, sourcePort: "South" }
    ];
    const { layout } = pipeline(rows);
    check("a node busy on all four faces labels against its quietest",
        layout.nodes.get("B").labelPort === "South", layout.nodes.get("B").labelPort);
}
{
    // Outside labels are part of what the fit measures: a West label pushes
    // its node in from the left edge by the label's width, and a node that
    // labels elsewhere does not pay for it. (This used to be a fixed 90px
    // reserve, held back only when some leftmost node labelled West.)
    const plain = pipeline([{ source: "A", target: "B", value: 10 }]).layout;
    const busyWest = pipeline([
        { source: "A", target: "B", value: 10 },
        { source: "B", target: "A", value: 5, sourcePort: "West", targetPort: "West" }
    ]).layout;
    check("a leftmost node with a free West face labels there",
        plain.nodes.get("A").labelPort === "West", plain.nodes.get("A").labelPort);
    check("...and one with a busy West face labels elsewhere",
        busyWest.nodes.get("A").labelPort !== "West", busyWest.nodes.get("A").labelPort);
    // How far the leftmost node RECTANGLE sits in from where the fit's margin
    // ends: its West label's width when it has one, nothing when it has not.
    const inset = l => Math.min(...Array.from(l.nodes.values()).map(n => n.x)) - l.contentLeft - 0.25 * l.columnGap;
    check("a West label pushes its node in from the left edge by the label's width",
        Math.abs(inset(plain) - (6 + 6.2)) < 1e-6, `${inset(plain).toFixed(1)}px for "A": 6px gap + one 6.2px character`);
    check("dropping the West label frees that room",
        Math.abs(inset(busyWest)) < 1e-6, `${inset(busyWest).toFixed(2)}px`);
}

// ===============================================================
// 4. Changing the node width must not break routing.
// ===============================================================
[0, 3, 25].forEach(nodeMinPercent => {
    const rows = [
        { source: "Wind", target: "Grid", value: 120 },
        { source: "Solar", target: "Grid", value: 80 },
        { source: "Gas", target: "Grid", value: 60, sourcePort: "North", targetPort: "South" },
        { source: "Grid", target: "Industry", value: 140, flowType: "Electricity" },
        { source: "Grid", target: "Industry", value: 30, flowType: "Heat" },
        { source: "Grid", target: "Grid", value: 8, sourcePort: "East", targetPort: "South" }
    ];
    const { layout, corridors } = pipeline(rows, nodeMinPercent);
    const bands = routeCorridors(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth" });
    check(`${nodeMinPercent}%: every corridor still routes`, bands.length >= corridors.length,
        `${bands.length} bands, ${corridors.length} corridors`);
    check(`${nodeMinPercent}%: all band geometry finite`,
        bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)));
    // A zero extent ACROSS the flow is the intended outcome at 0%, not a
    // fault -- this was "width > 0 && height > 0", which quietly assumed the
    // old 14px floor. What must still hold is that nothing is NaN or
    // negative and no node collapses to a point on both axes at once. The
    // stronger invariant (an axis that carries demand always has extent for
    // its ports to pack into) is asserted directly in section 3.
    check(`${nodeMinPercent}%: no node has a non-finite or collapsed box`,
        Array.from(layout.nodes.values()).every(n =>
            [n.x, n.y, n.width, n.height].every(Number.isFinite)
            && n.width >= 0 && n.height >= 0
            && (n.width > 0 || n.height > 0)),
        Array.from(layout.nodes.values())
            .filter(n => !([n.x, n.y, n.width, n.height].every(Number.isFinite)
                && n.width >= 0 && n.height >= 0 && (n.width > 0 || n.height > 0)))
            .map(n => `${n.id} ${n.width}x${n.height}`).join(", "));

    let overlaps = 0;
    const list = Array.from(layout.nodes.values());
    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i], b = list[j];
            if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlaps++;
        }
    }
    check(`${nodeMinPercent}%: no two nodes overlap`, overlaps === 0, `${overlaps} overlaps`);
});

// =====================================================================
// Shape padding: the shape hangs this far outside the node, and the node
// is untouched.
//
// The want: "shapes that are approximately proportional to their
// flow size but can be bigger than the flows. Just now you have to
// increase the minimum floor size of all shapes to get them to hang
// outside of the flows" -- a floor levels every node to one size, where
// this leaves each one as big as its own flow and simply sits proud of it.
// =====================================================================
console.log("\n--- Shape padding ---");
{
    const PAD_ROWS = [
        // Two nodes carrying very different flows, so "proportional" can be
        // told apart from "all the same size".
        { source: "A", target: "B", value: 10, flowType: "one", sourcePort: "East", targetPort: "West" },
        { source: "B", target: "C", value: 10, flowType: "one", sourcePort: "East", targetPort: "West" },
        { source: "P", target: "Q", value: 200, flowType: "one", sourcePort: "East", targetPort: "West" },
        { source: "Q", target: "R", value: 200, flowType: "one", sourcePort: "East", targetPort: "West" },
        // ...and one the flow passes through vertically, which must get the
        // same padding in pixels.
        { source: "S", target: "T", value: 60, flowType: "one", sourcePort: "South", targetPort: "North" },
        { source: "T", target: "U", value: 60, flowType: "one", sourcePort: "South", targetPort: "North" }
    ];
    // `locked` holds the PITCH still. Without it the two layouts cannot be
    // compared to the pixel: a padded shape is more content, so the fit gives
    // the diagram a smaller pitch, and the corner solve's own `+1` does not
    // scale with it -- which read as a 0.77px error that was the measurement,
    // not the drawing.
    const layoutAt = (nodeShape, paddingPercent, extra, locked) => {
        const { flows } = parseDataView(dataViewOf(PAD_ROWS));
        const { corridors } = inferCorridors(flows);
        const { graph } = buildGraph(flows, undefined, undefined, corridors);
        return computeLayout(graph, corridors, 1400, 800, Object.assign({
            legendVisible: false, legendPosition: "Bottom", nodeMinWidthPercent: 3, nodeMinHeightPercent: 3,
            nodeShape, nodeShapePaddingPercent: paddingPercent
        }, extra || {}), undefined, locked);
    };

    ["Rectangle", "Rounded", "Circle"].forEach(nodeShape => {
        const held = layoutAt(nodeShape, 0).frame;
        const none = layoutAt(nodeShape, 0, undefined, held);
        const some = layoutAt(nodeShape, 12, undefined, held);
        const pad = some.packingPitch * 0.12;
        let grown = 0, wrong = 0, worst = 0, nodesMoved = 0, counted = 0;
        some.nodes.forEach(n => {
            const was = none.nodes.get(n.id);
            counted++;
            // The NODE is untouched -- only the shape over it grows. (Its
            // pixel position and size do move a little, because a bigger
            // shape is more content for the fit to squeeze in; measured in
            // GRID units, which the fit does not change.)
            if (Math.abs(was.column - n.column) > 1e-9 || Math.abs(was.row - n.row) > 1e-9) {
                nodesMoved++;
            }
            const wantW = was.shapeWidth + 2 * pad;
            const wantH = was.shapeHeight + 2 * pad;
            const offW = Math.abs(n.shapeWidth - wantW);
            const offH = Math.abs(n.shapeHeight - wantH);
            worst = Math.max(worst, offW, offH);
            if (offW > 0.5 || offH > 0.5) { wrong++; }
            if (n.shapeWidth > was.shapeWidth + 1) { grown++; }
        });
        check(`${nodeShape}: padding grows every shape by exactly twice itself, both axes`,
            wrong === 0, `${wrong} of ${counted} wrong, worst ${worst.toFixed(2)}px`);
        check(`${nodeShape}: ...and it really did grow them`, grown === counted,
            `${grown} of ${counted}`);
        check(`${nodeShape}: ...without moving a node off its grid position`,
            nodesMoved === 0, `${nodesMoved} of ${counted} moved`);
    });

    // The point of the setting: the shapes stay in proportion to their flows
    // rather than being levelled to one size, which is what a minimum floor
    // does. B carries a twentieth of Q's flow.
    {
        const padded = layoutAt("Rectangle", 12);
        const floored = layoutAt("Rectangle", 0, { nodeMinHeightPercent: 40 });
        const ratio = l => l.nodes.get("Q").shapeHeight / l.nodes.get("B").shapeHeight;
        const plain = layoutAt("Rectangle", 0);
        // Both compress the ratio, since both add a constant -- that is
        // inherent, and it was asked for "approximately proportional". What
        // matters is that padding keeps far more of the proportion than the
        // floor an author has to reach for today, at a comparable size.
        check("padding keeps shapes in proportion far better than a floor does",
            ratio(padded) > ratio(floored) * 1.5 && ratio(floored) < ratio(plain),
            `unpadded ${ratio(plain).toFixed(1)}x, padded ${ratio(padded).toFixed(1)}x, ` +
            `floored ${ratio(floored).toFixed(1)}x`);
    }

    // Same number of pixels whichever way the flow runs: it is measured
    // against the one pitch the diagram is scaled by, as the arrow gap is.
    {
        const held = layoutAt("Rectangle", 0).frame;
        const none = layoutAt("Rectangle", 0, undefined, held);
        const some = layoutAt("Rectangle", 12, undefined, held);
        const growth = id => {
            const a = none.nodes.get(id), b = some.nodes.get(id);
            return { w: b.shapeWidth - a.shapeWidth, h: b.shapeHeight - a.shapeHeight };
        };
        const across = growth("B"), down = growth("T");
        check("the same padding in pixels on a horizontal and a vertical node",
            Math.abs(across.w - down.w) < 0.5 && Math.abs(across.h - down.h) < 0.5,
            `${across.w.toFixed(2)}/${across.h.toFixed(2)} vs ${down.w.toFixed(2)}/${down.h.toFixed(2)}`);
    }

    // Shape None has no shape to pad.
    {
        const none = layoutAt("None", 0), some = layoutAt("None", 40);
        let any = 0;
        some.nodes.forEach(n => { if (n.shapeWidth !== 0 || n.shapeHeight !== 0) { any++; } });
        check("Shape None is left alone, however much padding is set",
            any === 0 && none.nodes.get("B").shapeWidth === 0, `${any} shapes appeared`);
    }

    // The arrow gap does not move when the shape is padded: a bigger
    // container is absorbed by the arrows' stems, which is the whole of why
    // a shape stopped setting the gap.
    {
        const arrows = { heads: true, tails: true, angleDegrees: 120,
            gapPercent: 8 };
        const withPad = pct => {
            const { flows } = parseDataView(dataViewOf(PAD_ROWS));
            const { corridors } = inferCorridors(flows);
            const { graph } = buildGraph(flows, undefined, undefined, corridors);
            const layout = computeLayout(graph, corridors, 1400, 800, {
                legendVisible: false, legendPosition: "Bottom", nodeMinWidthPercent: 3, nodeMinHeightPercent: 3,
                nodeShape: "Rectangle", nodeShapePaddingPercent: pct, arrows
            });
            const routed = routeDiagram(layout, {
                portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline", arrows
            });
            // The empty stretch along B's centre line, as a fraction of the
            // pitch -- the fit changes the pitch when shapes grow, so the
            // comparison has to be scale-free.
            const node = layout.nodes.get("B");
            const cy = node.y + node.height / 2;
            const w = node.shapeWidth > 0 ? node.shapeWidth : node.width;
            const cx = node.x + node.width / 2;
            const pieces = routed.infill.filter(p => p.nodeId === "B");
            const covers = (x, y) => pieces.some(p => p.path.split("Z").filter(s => s.trim())
                .some(sub2 => {
                    const nums = (sub2.match(/-?\d+(\.\d+)?(e-?\d+)?/g) || []).map(Number);
                    const poly = [];
                    for (let i = 0; i + 1 < nums.length; i += 2) { poly.push({ x: nums[i], y: nums[i + 1] }); }
                    let inside = false;
                    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                        const a2 = poly[i], b2 = poly[j];
                        if ((a2.y > y) !== (b2.y > y)
                            && x < a2.x + (b2.x - a2.x) * (y - a2.y) / (b2.y - a2.y)) { inside = !inside; }
                    }
                    return inside;
                }));
            let first = null, last = null;
            for (let x = cx - w / 2; x <= cx + w / 2; x += 0.05) {
                if (!covers(x, cy)) { if (first === null) { first = x; } last = x; }
            }
            return first === null ? 0 : (last - first) / layout.packingPitch;
        };
        const plainGap = withPad(0), paddedGap = withPad(12);
        check("the arrow gap is untouched by shape padding",
            Math.abs(plainGap - paddedGap) < 0.005 && plainGap > 0.05,
            `${(100 * plainGap).toFixed(2)}% vs ${(100 * paddedGap).toFixed(2)}% of the pitch`);
    }

    // A rounded shape still covers the node rectangle it is laid over -- the
    // property `shape-clearance` asserts, re-asserted with padding on, since
    // padding is applied BEFORE that solve and could have skipped it.
    {
        const some = layoutAt("Rounded", 12);
        let short = 0, counted = 0;
        some.nodes.forEach(n => {
            counted++;
            if (n.shapeWidth < n.width - 1e-6 || n.shapeHeight < n.height - 1e-6) { short++; }
        });
        check("a padded rounded shape still covers its node", short === 0,
            `${short} of ${counted} short`);
    }
}

if (failures === 0) {
    console.log("\nALL NODE-STYLE CHECKS PASSED");
} else {
    console.log(`\n${failures} NODE-STYLE CHECK(S) FAILED`);
    process.exit(1);
}
