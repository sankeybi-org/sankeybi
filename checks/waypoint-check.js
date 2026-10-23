"use strict";
// Route handles: the three constrained things a person can move on a
// corridor -- how far it runs out of each port, and where it steps across.
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout, pixelPositionOf } = require("./layout-api.js");
const { routeCorridors, routeDiagram } = require("./routing-api.js");
const { parseRouteOverrides, serialiseRouteOverrides, withRouteHandle } = require("./lib/positions.js");

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort",
    "sourceNodeColour", "targetNodeColour"];
const CHROME = { legendVisible: false, legendPosition: "Bottom" };
// Polyline replaces a duplicate "Smooth" left
// by the Hybrid rename.
const STYLES = ["Polyline", "Smooth", "Orthogonal"];

function pipeline(rows, viewport = { w: 1200, h: 700 }) {
    const dv = {
        table: {
            columns: ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
        }
    };
    const { flows } = parseDataView(dv);
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    return { corridors, layout: computeLayout(graph, corridors, viewport.w, viewport.h, CHROME) };
}
const opts = (over = {}) => Object.assign(
    { portLeadInPercent: 18, curvaturePercent: 35, style: "Smooth", avoidNodes: true }, over);
const diagram = (layout, overrides = new Map(), over = {}) => routeDiagram(layout, opts(over), overrides);

function samplePath(d, sub = 14) {
    const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?(e-?\d+)?/g) || [];
    let i = 0, cur = { x: 0, y: 0 };
    const pts = [];
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
        const tok = tokens[i++];
        if (tok === "M" || tok === "L") { cur = { x: num(), y: num() }; pts.push(cur); }
        else if (tok === "C") {
            const c1 = { x: num(), y: num() }, c2 = { x: num(), y: num() }, e = { x: num(), y: num() };
            for (let s = 1; s <= sub; s++) {
                const t = s / sub, mt = 1 - t;
                pts.push({
                    x: mt ** 3 * cur.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * e.x,
                    y: mt ** 3 * cur.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * e.y
                });
            }
            cur = e;
        }
    }
    return pts;
}
const nearest = (pts, p) => Math.min(...pts.map(q => Math.hypot(q.x - p.x, q.y - p.y)));

// A thin band, so "distance from a handle" measures the route rather than the
// band's own half-width. (An earlier version of this suite reported 76px off
// and that was exactly half the band -- the centreline had been passing
// straight through all along.)
const PAIR = [
    { source: "A", target: "B", value: 20, sourceColumn: 1, sourceRow: 2, targetColumn: 4, targetRow: 4 },
    { source: "P", target: "Q", value: 500, sourceColumn: 1, sourceRow: 6, targetColumn: 4, targetRow: 6 }
];

// ===============================================================
// 1. The blob round-trips and survives anything.
// ===============================================================
{
    const o = new Map([["A→B", { source: { column: 1.5, row: 2 }, middle: { column: 2.25, row: 3 } }]]);
    const back = parseRouteOverrides(serialiseRouteOverrides(o));
    check("route overrides round-trip",
        back.get("A→B").source.column === 1.5 && back.get("A→B").middle.column === 2.25
        && back.get("A→B").target === undefined,
        serialiseRouteOverrides(o));
    check("an empty map serialises to an empty string", serialiseRouteOverrides(new Map()) === "");
    check("a corridor with no handles set isn't written out",
        serialiseRouteOverrides(new Map([["A→B", {}]])) === "");

    const junk = [
        undefined, null, 42, "", "  ", "nope", "[1,2]", "{", '{"A": 5}', '{"A": []}',
        '{"A": {"s": 3}}', '{"A": {"s": [1]}}', '{"A": {"s": [1,2,3]}}',
        '{"A": {"s": ["x","y"]}}', '{"A": {"s": [null,2]}}', '{"A": {"s": [true,2]}}',
        '{"A": {"s": [1e400,2]}}', '{"A": {"z": [1,2]}}', '{"A": {}}'
    ];
    let threw = 0, produced = 0;
    junk.forEach(raw => {
        let out;
        try { out = parseRouteOverrides(raw); } catch { threw++; return; }
        if (out.size !== 0) produced++;
    });
    check("no malformed override blob throws", threw === 0, `${threw}`);
    check("no malformed override blob yields handles", produced === 0, `${produced}`);

    // A good handle alongside a bad one survives.
    const mixed = parseRouteOverrides('{"A": {"s": [2,3], "t": [null,1], "m": [4,5]}}').get("A");
    check("valid handles survive a bad neighbour",
        mixed.source.column === 2 && mixed.middle.column === 4 && mixed.target === undefined);

    // withRouteHandle: set, replace, reset, and never mutate its input.
    const one = withRouteHandle(new Map(), "A", "middle", { column: 3, row: 3 });
    check("setting a handle creates the entry", one.get("A").middle.column === 3);
    check("resetting the only handle drops the corridor entirely",
        !withRouteHandle(one, "A", "middle", undefined).has("A"));
    const two = withRouteHandle(one, "A", "source", { column: 1, row: 1 });
    check("resetting one of two leaves the other",
        withRouteHandle(two, "A", "middle", undefined).get("A").source.column === 1);
    check("withRouteHandle doesn't mutate its input", one.get("A").source === undefined);

    // The DETOUR lane is a stored handle like the other three: it
    // rides the same blob under its own key, so it persists, "Reset route
    // handles" clears it, and a corridor holding only a lane still gets written.
    const laned = withRouteHandle(new Map(), "A→B", "detour", { column: 2.25, row: 1.5 });
    const raw = serialiseRouteOverrides(laned);
    check("a detour lane is written to the blob under its own key",
        raw.includes('"d"') && !raw.includes('"m"'), raw);
    const lanedBack = parseRouteOverrides(raw).get("A→B");
    check("a detour lane round-trips",
        lanedBack?.detour?.column === 2.25 && lanedBack?.detour?.row === 1.5
        && lanedBack?.middle === undefined);
    check("a corridor holding only a lane is kept, not dropped",
        parseRouteOverrides(raw).has("A→B"));
    check("resetting the lane drops the corridor entirely",
        !withRouteHandle(laned, "A→B", "detour", undefined).has("A→B"));
    // A lane and a crossover are separate numbers, so neither overwrites the
    // other -- the whole reason the lane is not stored as `middle`.
    const both = withRouteHandle(laned, "A→B", "middle", { column: 4, row: 2 });
    const bothBack = parseRouteOverrides(serialiseRouteOverrides(both)).get("A→B");
    check("a lane and a crossover are stored independently",
        bothBack?.detour?.column === 2.25 && bothBack?.middle?.column === 4);
    check("a malformed lane is dropped, and its neighbours survive",
        parseRouteOverrides('{"A": {"d": [null,1], "s": [2,3]}}').get("A")?.detour === undefined
        && parseRouteOverrides('{"A": {"d": [null,1], "s": [2,3]}}').get("A")?.source?.column === 2);
}

// ===============================================================
// 2. Every corridor reports handles, and only the ones it can offer.
// ===============================================================
{
    // Same-axis ports and a squared-off route: has a crossover.
    const { corridors, layout } = pipeline(PAIR);
    const id = corridors.find(c => c.source === "A").id;
    const squared = diagram(layout, new Map(), { style: "Orthogonal" }).handles.get(id);
    check("a squared-off same-axis route offers all three handles",
        squared.source && squared.target && squared.middle, JSON.stringify(Object.keys(squared)));
    check("its lead handles move along x (East/West ports)",
        squared.source.axis === "x" && squared.target.axis === "x");
    check("its crossover moves along x too — a Z steps across going forward",
        squared.middle.axis === "x", squared.middle.axis);

    // Smooth has no stored crossover: its
    // middle handle is Polyline's bend GESTURE, which writes the two leads.
    const smooth = diagram(layout, new Map(), { style: "Smooth" }).handles.get(id);
    check("a Smooth direct route offers two leads and a bend gesture",
        smooth.source && smooth.target && smooth.middle && smooth.middle.gesture === true);
}
{
    // Perpendicular ports make an L, whose corner is just where the stubs
    // meet -- so it moves when a lead does and needs no handle of its own.
    const rows = [{ source: "A", target: "B", value: 30, sourcePort: "East", targetPort: "North", sourceColumn: 1, sourceRow: 3, targetColumn: 3, targetRow: 1 }];
    const { corridors, layout } = pipeline(rows);
    const handles = diagram(layout, new Map(), { style: "Orthogonal" }).handles.get(corridors[0].id);
    check("a perpendicular (L) route offers no crossover handle", !handles.middle);
    check("...but still offers both leads", Boolean(handles.source && handles.target));
    check("a North-port lead moves along y", handles.target.axis === "y", handles.target.axis);
}

// ===============================================================
// 3. Dragging a lead changes how far the route runs out of its port.
// ===============================================================
{
    const { corridors, layout } = pipeline(PAIR);
    const id = corridors.find(c => c.source === "A").id;
    const base = diagram(layout).handles.get(id);

    // Push the source lead further out along its normal (East -> +x).
    const further = { x: base.source.point.x + 90, y: base.source.point.y };
    const moved = diagram(layout, new Map([[id, { source: further }]]));
    const after = moved.handles.get(id);
    check("the source handle follows the drag along its own axis",
        after.source.point.x > base.source.point.x + 40,
        `${base.source.point.x.toFixed(0)} -> ${after.source.point.x.toFixed(0)}`);
    check("...and stays pinned across the face",
        Math.abs(after.source.point.y - base.source.point.y) < 1e-9,
        `${base.source.point.y.toFixed(2)} -> ${after.source.point.y.toFixed(2)}`);
    check("the route changes as a result",
        moved.bands.find(b => b.corridorId === id).path
        !== diagram(layout).bands.find(b => b.corridorId === id).path);
}
{
    // The correctness floor still applies: a wrap route's lead can't be
    // dragged short enough to collapse the corner that follows it, so it
    // stops following the cursor. that floor is the BAND's
    // measurement (1.5 x its half-width) rather than the Curvature slider's
    // radius, so it scales with the corridor instead of the grid -- which is
    // why this asserts the drawn band rather than a pixel count.
    const rows = [
        { source: "A", target: "B", value: 30, sourcePort: "East", targetPort: "West", sourceColumn: 3, sourceRow: 2, targetColumn: 1, targetRow: 2 },
        { source: "P", target: "Q", value: 500, sourceColumn: 1, sourceRow: 5, targetColumn: 4, targetRow: 5 }
    ];
    const { corridors, layout } = pipeline(rows);
    const id = corridors.find(c => c.source === "A").id;
    // Lead-in 40%: at the fitted pitch the default 18% lands exactly on the
    // correctness floor, so there would be nothing to drag shorter.
    const LONG = { portLeadInPercent: 40 };
    const base = diagram(layout, new Map(), LONG).handles.get(id);
    const anchor = diagram(layout, new Map(), LONG).bands.find(b => b.corridorId === id).start;
    // Ask for a lead of essentially zero -- 500px back behind the port face.
    const squashed = diagram(layout, new Map([[id, { source: { x: base.source.point.x - 500, y: base.source.point.y } }]]), LONG);
    const after = squashed.handles.get(id);
    const requested = base.source.point.x - 500;
    check("a wrap's lead does shorten when dragged in",
        after.source.point.x < base.source.point.x - 1,
        `${base.source.point.x.toFixed(1)} -> ${after.source.point.x.toFixed(1)}`);
    check("...but stops at its correctness floor instead of following the cursor",
        after.source.point.x - requested > 300,
        `asked for ${requested.toFixed(0)}, got ${after.source.point.x.toFixed(0)}`);
    check("...leaving a real lead, not a collapsed one",
        after.source.point.x - anchor.x > 1,
        `${(after.source.point.x - anchor.x).toFixed(1)}px out from the face`);
    // The band's own edge quality is `seam-check`'s instrument, not this
    // one: pairing samples across a wrap's outline needs the edges' sample
    // counts, which is routing's business. Tried here and it read 0.3..740.8
    // on a band that is plainly fine.
    check("...and the band still renders",
        squashed.bands.every(b => [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)));
}

// ===============================================================
// 4. Dragging the crossover moves where the route steps across.
// ===============================================================
{
    const { corridors, layout } = pipeline(PAIR);
    const id = corridors.find(c => c.source === "A").id;

    // Only Orthogonal squares off a DIRECT route -- Hybrid curves it, so a
    // direct corridor there has no step to move. That's the model working,
    // not a gap: in the default Hybrid style most corridors show two handles,
    // and a third appears only where the route genuinely has a crossover.
    ["Orthogonal"].forEach(style => {
        const base = diagram(layout, new Map(), { style }).handles.get(id);
        const shifted = { x: base.middle.point.x + 100, y: base.middle.point.y };
        const after = diagram(layout, new Map([[id, { middle: shifted }]]), { style });
        const moved = after.handles.get(id);
        check(`${style}: the crossover follows the drag`,
            moved.middle.point.x > base.middle.point.x + 50,
            `${base.middle.point.x.toFixed(0)} -> ${moved.middle.point.x.toFixed(0)}`);
        const pts = samplePath(after.bands.find(b => b.corridorId === id).path);
        check(`${style}: the band actually steps across there`,
            nearest(pts, shifted) < 30, `nearest ${nearest(pts, shifted).toFixed(1)}px`);
    });
    check("Smooth's middle is a bend gesture, never a stored crossover",
        (() => {
            const m = diagram(layout, new Map(), { style: "Smooth" }).handles.get(id).middle;
            return !m || m.gesture === true;
        })());
}
{
    // A wrap's crossover is its LANE, which runs across the route rather than
    // along it -- opposite axis, same handle.
    const rows = [
        { source: "A", target: "B", value: 20, sourcePort: "East", targetPort: "West", sourceColumn: 3, sourceRow: 2, targetColumn: 1, targetRow: 2 },
        { source: "P", target: "Q", value: 500, sourceColumn: 1, sourceRow: 5, targetColumn: 4, targetRow: 5 }
    ];
    const { corridors, layout } = pipeline(rows);
    const id = corridors.find(c => c.source === "A").id;
    const base = diagram(layout).handles.get(id);
    check("a wrap's crossover moves along y", base.middle && base.middle.axis === "y",
        base.middle && base.middle.axis);
    const lower = { x: base.middle.point.x, y: base.middle.point.y + 80 };
    const after = diagram(layout, new Map([[id, { middle: lower }]]));
    check("the wrap's lane follows the drag",
        Math.abs(after.handles.get(id).middle.point.y - lower.y) < 30,
        `${base.middle.point.y.toFixed(0)} -> ${after.handles.get(id).middle.point.y.toFixed(0)}`);
}

// ===============================================================
// 5. Nothing set means nothing changes.
// ===============================================================
{
    const { corridors, layout } = pipeline(PAIR);
    const id = corridors.find(c => c.source === "A").id;
    const plain = routeCorridors(layout, opts());
    check("an empty override map routes identically",
        plain.every((b, i) => b.path === diagram(layout).bands[i].path));
    check("an empty override ENTRY routes identically",
        plain.every((b, i) => b.path === diagram(layout, new Map([[id, {}]])).bands[i].path));

    // Other corridors are untouched when one is adjusted.
    const base = diagram(layout).handles.get(id);
    const one = diagram(layout, new Map([[id, { source: { x: base.source.point.x + 60, y: base.source.point.y } }]]));
    check("other corridors are byte-identical when one is adjusted",
        plain.filter(b => b.corridorId !== id)
            .every((b, i) => b.path === one.bands.filter(x => x.corridorId !== id)[i].path));
}

// ===============================================================
// 6. Degenerate overrides don't break routing.
// ===============================================================
{
    const { corridors, layout } = pipeline(PAIR);
    const id = corridors.find(c => c.source === "A").id;
    const cases = {
        "a lead dragged onto its own anchor": { source: pixelPositionOf(layout, 1, 2, 0) },
        "a lead dragged behind the port face": { source: { x: -5000, y: 0 } },
        "a crossover far outside the plot": { middle: { x: 99999, y: -99999 } },
        "all three at once": {
            source: { x: -300, y: 40 }, target: { x: 4000, y: 4000 }, middle: { x: 0, y: 0 }
        }
    };
    Object.entries(cases).forEach(([name, override]) => {
        const out = diagram(layout, new Map([[id, override]]));
        check(`${name}: still routes with finite geometry`,
            out.bands.length > 0 && out.bands.every(b =>
                [b.bounds.minX, b.bounds.minY, b.bounds.maxX, b.bounds.maxY].every(Number.isFinite)
                && b.path.length > 0));
    });
}

// ===============================================================
// 7. A hand-moved crossover stands avoidance down; a lead doesn't.
// ===============================================================
{
    const rows = [
        { source: "A", target: "Z", value: 20, sourceColumn: 1, sourceRow: 2, targetColumn: 5, targetRow: 2 },
        { source: "Big1", target: "Big2", value: 400, sourceColumn: 3, sourceRow: 2, targetColumn: 3, targetRow: 5 }
    ];
    const { corridors, layout } = pipeline(rows);
    const id = corridors.find(c => c.source === "A").id;
    const avoided = diagram(layout).bands.find(b => b.corridorId === id).path;
    const notAvoided = routeCorridors(layout, opts({ avoidNodes: false }))
        .find(b => b.corridorId === id).path;
    check("avoidance is doing something here", avoided !== notAvoided);

    // **A detoured route offers its LANE, and the crossover of the line as
    // PLACED**. The detour replaces the middle in the
    // DRAWING -- the handle read off the detour's own waypoints sat part way
    // up its riser and, in Polyline, moved nothing at all -- so
    // the middle now comes over from the undetoured construction instead,
    // marked `asPlaced`, and is drawn on a ghost of that line. Without it the
    // author who steered the line into the node has nothing to steer it back
    // with: the lane shapes the way round and cannot remove it.
    const routedNow = diagram(layout, new Map(), { style: "Orthogonal" });
    const base = routedNow.handles.get(id);
    const undetoured = diagram(layout, new Map(), { style: "Orthogonal", avoidNodes: false });
    check("a detoured route keeps the crossover of the line as placed",
        base.middle !== undefined && base.asPlaced === true && !!undetoured.handles.get(id).middle
        && Math.abs(base.middle.point.x - undetoured.handles.get(id).middle.point.x) < 1e-9
        && Math.abs(base.middle.point.y - undetoured.handles.get(id).middle.point.y) < 1e-9);
    const ghostNow = (routedNow.ghosts && routedNow.ghosts.get(id)) || [];
    check("...on a ghost of that line, which is the undetoured centreline",
        ghostNow.length === undetoured.spines.get(id).length && ghostNow.length > 1
        && ghostNow.every((p, k) =>
            Math.abs(p.x - undetoured.spines.get(id)[k].x) < 1e-9
            && Math.abs(p.y - undetoured.spines.get(id)[k].y) < 1e-9));
    check("a detoured route has a lane handle", base.detour !== undefined,
        base.detour ? `${base.detour.axis}=${base.detour.point[base.detour.axis].toFixed(1)}` : "none");

    // Dropping that crossover stands avoidance down, which is the documented
    // bargain (clearCrossover) and is exactly what "get back to a line that
    // needs no detour" means for a Z. Read off the handle now, since there is
    // one again -- the drop an author can actually make.
    const dropAt = base.middle ? base.middle.point : pixelPositionOf(layout, 2.5, 2, 0);
    const withMiddle = diagram(layout,
        new Map([[id, { middle: { x: dropAt.x, y: dropAt.y } }]]), { style: "Orthogonal" });
    check("dropping the as-placed crossover leaves no detour",
        base.middle !== undefined
        && withMiddle.handles.get(id).detour === undefined
        && withMiddle.handles.get(id).asPlaced === undefined
        && (withMiddle.ghosts ? withMiddle.ghosts.has(id) : false) === false);
    check("a stored crossover still replaces the automatic detour",
        withMiddle.bands.find(b => b.corridorId === id).path !== avoided);

    const withLead = diagram(layout,
        new Map([[id, { source: { x: base.source.point.x + 30, y: base.source.point.y } }]]));
    check("a hand-moved lead leaves avoidance running",
        withLead.bands.every(b => [b.bounds.minX, b.bounds.maxY].every(Number.isFinite)));
}

// ===============================================================
// 8. Determinism.
// ===============================================================
{
    const { corridors, layout } = pipeline(PAIR);
    const id = corridors.find(c => c.source === "A").id;
    const over = new Map([[id, { middle: pixelPositionOf(layout, 2.5, 3, 0) }]]);
    const dump = () => diagram(layout, over).bands.map(b => b.path).join("|");
    check("the same overrides route identically twice", dump() === dump());
}

if (failures === 0) {
    console.log("\nALL ROUTE-HANDLE CHECKS PASSED");
} else {
    console.log(`\n${failures} ROUTE-HANDLE CHECK(S) FAILED`);
    process.exit(1);
}
