"use strict";
// Drives the real drag handler through a fake DOM. Pointer events can't be
// proved live-free, but everything between "pointer moved to here" and "commit
// this logical position" can be -- which is where the conversion, snapping,
// clamping and threshold logic all live.

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const VIEW = { w: 1400, h: 800 };

class FakeElement {
    constructor(tag) {
        this.tag = tag;
        this.attributes = {};
        this.childNodes = [];
        this.style = {};
        this.handlers = new Map();
        this.captured = new Set();
    }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return this.attributes[n]; }
    appendChild(c) { this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); return c; }
    addEventListener(type, fn) {
        if (!this.handlers.has(type)) this.handlers.set(type, []);
        this.handlers.get(type).push(fn);
    }
    fire(type, event) { (this.handlers.get(type) || []).forEach(fn => fn(event)); }
    setPointerCapture(id) { this.captured.add(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    // Deliberately NO getScreenCTM/createSVGPoint: this exercises the
    // bounding-rect fallback, mapped 1:1 so a client pixel is a user pixel.
    getBoundingClientRect() { return { left: 0, top: 0, width: VIEW.w, height: VIEW.h }; }
    find(tag) {
        return this.childNodes.reduce((acc, c) => acc.concat(c.find(tag)), this.tag === tag ? [this] : []);
    }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout, gridPositionOf } = require("./layout-api.js");
const { makeNodeDraggable } = require("./lib/interaction.js");

const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort",
    "sourceNodeColour", "targetNodeColour"];
const CHROME = { legendVisible: false, legendPosition: "Bottom" };

function buildLayout(rows) {
    const dv = {
        table: {
            columns: ROLES.map(r => ({ roles: { [r]: true } })),
            rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
        }
    };
    const { flows } = parseDataView(dv);
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    return computeLayout(graph, corridors, VIEW.w, VIEW.h, CHROME);
}

const ROWS = [
    { source: "A", target: "B", value: 30 },
    { source: "A", target: "C", value: 20 },
    { source: "B", target: "D", value: 25 },
    { source: "C", target: "D", value: 15 }
];

/** Sets up one draggable node and returns a harness for driving it. */
function harness(snapStep, nodeId = "A") {
    const layout = buildLayout(ROWS);
    const node = layout.nodes.get(nodeId);
    const svg = new FakeElement("svg");
    svg.setAttribute("width", VIEW.w);
    svg.setAttribute("height", VIEW.h);
    const shape = new FakeElement("rect");
    svg.appendChild(shape);

    const commits = [];
    makeNodeDraggable(shape, node, svg, {
        layout,
        snapStep,
        viewport: { width: VIEW.w, height: VIEW.h },
        onCommit: (id, position) => commits.push({ id, ...position })
    });

    let pointerId = 1;
    return {
        layout, node, svg, shape, commits,
        ghosts: () => svg.childNodes.filter(c => c.getAttribute("class") === "sankeybi-drag-ghost"),
        down(x, y, button = 0) { shape.fire("pointerdown", { button, pointerId, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }); },
        move(x, y) { shape.fire("pointermove", { pointerId, clientX: x, clientY: y }); },
        up(x, y) { shape.fire("pointerup", { pointerId, clientX: x, clientY: y }); },
        cancel() { shape.fire("pointercancel", { pointerId }); }
    };
}

// ===============================================================
// 1. A real drag commits the logical position it was dropped at.
// ===============================================================
{
    const h = harness(0);
    const start = { x: h.node.x + 5, y: h.node.y + 5 };
    // Move a whole column right and most of a row down.
    const dx = h.layout.columnGap;
    const dy = h.layout.rowPitch * 0.5;

    h.down(start.x, start.y);
    h.move(start.x + dx, start.y + dy);
    h.up(start.x + dx, start.y + dy);

    check("one drag produces exactly one commit", h.commits.length === 1, `${h.commits.length}`);
    const c = h.commits[0];
    check("the commit names the dragged node", c && c.id === "A", c && c.id);
    check("moving one column right adds exactly 1 to the column",
        Math.abs(c.column - (h.node.column + 1)) < 1e-9, `${c.column} vs ${h.node.column + 1}`);
    check("moving half a row down adds exactly 0.5 to the row",
        Math.abs(c.row - (h.node.row + 0.5)) < 1e-9, `${c.row} vs ${h.node.row + 0.5}`);
    check("the ghost is cleaned up on release", h.ghosts().length === 0);
}

// ===============================================================
// 2. Snapping applies, and the ghost shows the SNAPPED destination
//    rather than the raw pointer -- so what you see is where it lands.
// ===============================================================
{
    const h = harness(0.25);
    const start = { x: h.node.x + 5, y: h.node.y + 5 };
    // A deliberately awkward offset: 0.37 of a column, 0.31 of a row.
    const dx = h.layout.columnGap * 0.37;
    const dy = h.layout.rowPitch * 0.31;

    h.down(start.x, start.y);
    h.move(start.x + dx, start.y + dy);

    const ghost = h.ghosts()[0];
    check("a ghost appears during the drag", Boolean(ghost));

    h.up(start.x + dx, start.y + dy);
    const c = h.commits[0];
    check("the column snaps to a quarter", Math.abs((c.column * 4) - Math.round(c.column * 4)) < 1e-9,
        String(c.column));
    check("the row snaps to a quarter", Math.abs((c.row * 4) - Math.round(c.row * 4)) < 1e-9,
        String(c.row));
    check("it snaps to the NEAREST quarter, not the floor",
        Math.abs(c.column - (h.node.column + 0.25)) < 1e-9, `${c.column} vs ${h.node.column + 0.25}`);

    // The ghost's own position, read back through the same inverse, is the
    // position that was committed.
    const ghostGrid = gridPositionOf(h.layout, Number(ghost.getAttribute("x")),
        Number(ghost.getAttribute("y")) + h.node.height / 2);
    check("the ghost sat exactly where the node was committed",
        Math.abs(ghostGrid.column - c.column) < 1e-9 && Math.abs(ghostGrid.row - c.row) < 1e-9,
        `ghost ${ghostGrid.column.toFixed(3)},${ghostGrid.row.toFixed(3)} vs commit ${c.column},${c.row}`);
}

// ===============================================================
// 3. A click is not a drag.
// ===============================================================
{
    const h = harness(0);
    h.down(h.node.x + 5, h.node.y + 5);
    h.move(h.node.x + 6, h.node.y + 6);   // 1.4px -- under the threshold
    h.up(h.node.x + 6, h.node.y + 6);
    check("a click below the movement threshold commits nothing", h.commits.length === 0,
        `${h.commits.length} commits`);
    check("...and leaves no ghost behind", h.ghosts().length === 0);
}
{
    const h = harness(0);
    h.down(h.node.x + 5, h.node.y + 5);
    h.up(h.node.x + 5, h.node.y + 5);     // no movement at all
    check("a bare click commits nothing", h.commits.length === 0);
}
{
    // A right-click belongs to the context menu, not to dragging.
    const h = harness(0);
    h.down(h.node.x + 5, h.node.y + 5, 2);
    h.move(h.node.x + 200, h.node.y + 100);
    h.up(h.node.x + 200, h.node.y + 100);
    check("a right-button drag is ignored", h.commits.length === 0 && h.ghosts().length === 0);
}

// ===============================================================
// 4. A cancelled drag tidies up and commits nothing.
// ===============================================================
{
    const h = harness(0);
    h.down(h.node.x + 5, h.node.y + 5);
    h.move(h.node.x + 200, h.node.y + 100);
    check("the ghost is present mid-drag", h.ghosts().length === 1);
    h.cancel();
    check("a cancelled drag commits nothing", h.commits.length === 0);
    check("...and removes the ghost", h.ghosts().length === 0, `${h.ghosts().length} left`);

    // A stray move after the cancel must not resurrect anything.
    h.move(h.node.x + 300, h.node.y + 150);
    check("a move after cancelling is ignored", h.ghosts().length === 0 && h.commits.length === 0);
}

// ===============================================================
// 5. Dragging beyond the grid extends it -- but only as far as the
//    visual itself. Pointer capture keeps events coming after the
//    pointer leaves the visual, and a drop resolved from those would
//    stretch the grid to somewhere nobody can see.
// ===============================================================
{
    const h = harness(0);
    h.down(h.node.x + 5, h.node.y + 5);
    h.move(-5000, -5000);
    h.up(-5000, -5000);
    const c = h.commits[0];
    // A's own column is 1, so left of that is a genuine extension...
    check("dragging off the top-left goes below the grid's start", c && c.column < 1,
        c && String(c.column));
    // ...but bounded: the far left of the VISUAL, not of the report canvas.
    const atLeftEdge = gridPositionOf(h.layout, 0, h.node.height / 2);
    check("the column stops at the visual's left edge",
        c && Math.abs(c.column - atLeftEdge.column) < 1e-9,
        `${c && c.column.toFixed(3)} vs ${atLeftEdge.column.toFixed(3)}`);
    check("the row stops at the visual's top edge",
        c && Math.abs(c.row - atLeftEdge.row) < 1e-9,
        `${c && c.row.toFixed(3)} vs ${atLeftEdge.row.toFixed(3)}`);
    check("the drop stays well inside a sane range, not tens of columns out",
        c && c.column > -3 && c.row > -3, c && `${c.column.toFixed(2)}, ${c.row.toFixed(2)}`);
}
{
    // Same at the other corner: bounded so the node stays fully visible.
    const h = harness(0);
    h.down(h.node.x + 5, h.node.y + 5);
    h.move(99999, 99999);
    h.up(99999, 99999);
    const c = h.commits[0];
    const atRightEdge = gridPositionOf(h.layout,
        VIEW.w - h.node.width, VIEW.h - h.node.height + h.node.height / 2);
    check("dragging off the bottom-right stops at the visual's far corner",
        c && Math.abs(c.column - atRightEdge.column) < 1e-9 && Math.abs(c.row - atRightEdge.row) < 1e-9,
        c && `${c.column.toFixed(3)},${c.row.toFixed(3)} vs ${atRightEdge.column.toFixed(3)},${atRightEdge.row.toFixed(3)}`);
}

// ===============================================================
// 6. Two drags in a row each commit once, and the second is measured
//    from the node's ORIGINAL position -- the layout handed to the
//    drag layer hasn't been rebuilt yet at that point.
// ===============================================================
{
    const h = harness(0);
    const start = { x: h.node.x + 5, y: h.node.y + 5 };
    h.down(start.x, start.y);
    h.move(start.x + h.layout.columnGap, start.y);
    h.up(start.x + h.layout.columnGap, start.y);
    h.down(start.x, start.y);
    h.move(start.x + 2 * h.layout.columnGap, start.y);
    h.up(start.x + 2 * h.layout.columnGap, start.y);

    check("two drags produce two commits", h.commits.length === 2, `${h.commits.length}`);
    check("each is measured from the node's laid-out position",
        Math.abs(h.commits[0].column - (h.node.column + 1)) < 1e-9
        && Math.abs(h.commits[1].column - (h.node.column + 2)) < 1e-9,
        h.commits.map(c => c.column.toFixed(3)).join(" then "));
}

// ===============================================================
// 7. The cursor affordance is set, so a node looks draggable.
// ===============================================================
{
    const h = harness(0);
    check("a draggable node shows the move cursor", h.shape.style.cursor === "move", h.shape.style.cursor);
}

// ===============================================================
// 8. Route handles are CONSTRAINED to one axis. That constraint is
//    the whole point: free waypoints let a corridor be tied in a
//    knot, which is why they were replaced.
// ===============================================================
const { makeHandleDraggable } = require("./lib/interaction.js");

function handleHarness(snapStep, axis) {
    const layout = buildLayout(ROWS);
    const svg = new FakeElement("svg");
    svg.setAttribute("width", VIEW.w);
    svg.setAttribute("height", VIEW.h);
    const dot = new FakeElement("circle");
    svg.appendChild(dot);

    const events = [];
    const origin = { x: 400, y: 300 };
    makeHandleDraggable(dot, "A→B", "middle", axis, origin, svg, {
        layout,
        snapStep,
        viewport: { width: VIEW.w, height: VIEW.h },
        onCommit: () => events.push({ kind: "node" }),
        onMoveHandle: (corridorId, kind, position) => events.push({ kind: "move", corridorId, handle: kind, ...position }),
        onResetHandle: (corridorId, kind) => events.push({ kind: "reset", corridorId, handle: kind })
    });

    return {
        layout, svg, dot, events, origin,
        ghosts: () => svg.childNodes.filter(c => c.getAttribute("class") === "sankeybi-drag-ghost"),
        down: (x, y, button = 0) => dot.fire("pointerdown", { button, pointerId: 1, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }),
        move: (x, y) => dot.fire("pointermove", { pointerId: 1, clientX: x, clientY: y }),
        up: (x, y) => dot.fire("pointerup", { pointerId: 1, clientX: x, clientY: y }),
        cancel: () => dot.fire("pointercancel", { pointerId: 1 }),
        dblclick: () => dot.fire("dblclick", { preventDefault() {}, stopPropagation() {} })
    };
}

{
    // An x-constrained handle dragged diagonally must move in x only.
    const h = handleHarness(0, "x");
    h.down(400, 300);
    h.move(700, 650);
    h.up(700, 650);
    check("an x-handle commits one move", h.events.length === 1 && h.events[0].kind === "move");
    const expected = gridPositionOf(h.layout, 700, h.origin.y);
    check("it follows the pointer in x",
        Math.abs(h.events[0].column - expected.column) < 1e-9,
        `${h.events[0].column.toFixed(3)} vs ${expected.column.toFixed(3)}`);
    check("it ignores the pointer in y",
        Math.abs(h.events[0].row - expected.row) < 1e-9,
        `${h.events[0].row.toFixed(3)} vs ${expected.row.toFixed(3)}`);
    check("the handle names itself", h.events[0].handle === "middle", h.events[0].handle);
}
{
    // ...and the mirror image.
    const h = handleHarness(0, "y");
    h.down(400, 300);
    h.move(950, 620);
    h.up(950, 620);
    const expected = gridPositionOf(h.layout, h.origin.x, 620);
    check("a y-handle follows the pointer in y and ignores x",
        Math.abs(h.events[0].row - expected.row) < 1e-9
        && Math.abs(h.events[0].column - expected.column) < 1e-9,
        `${h.events[0].column.toFixed(3)},${h.events[0].row.toFixed(3)}`);
}
{
    const h = handleHarness(0.25, "x");
    h.down(400, 300);
    h.move(733, 300);
    h.up(733, 300);
    check("a handle snaps to the grid step",
        Math.abs(h.events[0].column * 4 - Math.round(h.events[0].column * 4)) < 1e-9,
        String(h.events[0].column));
}
{
    const h = handleHarness(0, "x");
    h.dblclick();
    check("double-clicking a handle resets it",
        h.events.length === 1 && h.events[0].kind === "reset" && h.events[0].handle === "middle",
        JSON.stringify(h.events));
}
{
    const h = handleHarness(0, "x");
    h.down(400, 300);
    h.move(700, 300);
    check("a ghost follows a handle drag", h.ghosts().length === 1);
    h.cancel();
    check("a cancelled handle drag commits nothing", h.events.length === 0);
    check("...and leaves no ghost", h.ghosts().length === 0);
}
{
    const h = handleHarness(0, "x");
    h.down(400, 300);
    h.move(402, 301);
    h.up(402, 301);
    check("a click on a handle commits nothing", h.events.length === 0, JSON.stringify(h.events));
}
{
    const h = handleHarness(0, "x");
    check("an x-constrained handle shows the horizontal resize cursor",
        h.dot.style.cursor === "ew-resize", h.dot.style.cursor);
    check("a y-constrained one shows the vertical cursor",
        handleHarness(0, "y").dot.style.cursor === "ns-resize");
}

// ===============================================================
// N. A drag and a click share one gesture until the threshold.
// ===============================================================
{
    const { consumedByDrag } = require("./lib/interaction.js");

    // The browser synthesises a click at the end of ANY pointerdown/up pair.
    // Without the marker, dragging a node across the diagram would also select
    // it on release -- the author repositions something and the whole report
    // cross-filters behind them.
    const dragged = harness(0);
    dragged.down(100, 100);
    dragged.move(220, 180);
    dragged.up(220, 180);
    check("after a real drag, the synthesised click is swallowed",
        consumedByDrag(dragged.shape) === true);
    check("...and only once -- a later genuine click still selects",
        consumedByDrag(dragged.shape) === false);

    // Below the threshold the gesture was a click all along, and must select.
    const tapped = harness(0);
    tapped.down(100, 100);
    tapped.move(101, 100);
    tapped.up(101, 100);
    check("a click that merely twitched is NOT swallowed",
        consumedByDrag(tapped.shape) === false);
    check("...and it committed no position either", tapped.commits.length === 0);

    // An abandoned drag moved the pointer but changed nothing; the click that
    // follows shouldn't act on a gesture the user cancelled.
    const cancelled = harness(0);
    cancelled.down(100, 100);
    cancelled.move(220, 180);
    cancelled.cancel();
    check("an escaped drag is swallowed too, not turned into a click",
        consumedByDrag(cancelled.shape) === true);

    check("a shape that was never dragged is unaffected",
        consumedByDrag(new FakeElement("rect")) === false);
    check("a null target doesn't throw", consumedByDrag(null) === false);
}

if (failures === 0) {
    console.log("\nALL DRAG CHECKS PASSED");
} else {
    console.log(`\n${failures} DRAG CHECK(S) FAILED`);
    process.exit(1);
}
