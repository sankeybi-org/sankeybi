"use strict";
// Stage 14. What CAN be proved without a host: the row identity that every
// selection id is built from, and the click/hover state machine.
//
// What can't: whether Power BI accepts the ids we build. That needs a live
// report, same posture as dragging (see the design notes).
const { parseDataView } = require("./parse.js");
const { dataView } = require("./dataview.js");
const { inferCorridors } = require("./lib/corridors.js");
const { buildRowIndex, bandKey, nodeKey, SelectionController } = require("./lib/selection.js");

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const ROLES = ["flowID", "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder", "sourceLabel", "targetLabel", "sourceColumn", "sourceRow",
    "targetColumn", "targetRow", "sourcePort", "targetPort",
    "sourceNodeColour", "targetNodeColour"];

// The shape the host sends: column-major categories plus one
// values column. Built directly rather than through `parse.js`'s adapter,
// because the SelectionController reads the dataView itself -- it is what
// `withCategory` is handed -- so a table-shaped fixture would test nothing.
const toDataView = rows => dataView(ROLES, rows.map(r => ROLES.map(k => (k in r ? r[k] : null))));

// ===============================================================
// 1. rowIndex survives parsing, and indexes the TABLE not the flows.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10 },
        { source: "", target: "B", value: 10 },          // skipped: no Source
        { source: "A", target: "C", value: 20 },
        { source: "A", target: "D", value: -5 },         // skipped: negative
        { source: "B", target: "C", value: 30 }
    ];
    const { flows } = parseDataView(toDataView(rows));
    check("invalid rows are still skipped", flows.length === 3, `${flows.length}`);
    // The whole point: a selection id is built with withCategory(categories, rowIndex),
    // so an index that counted surviving flows would address the wrong row of
    // the user's data -- and would do it silently, filtering the report to
    // something the user didn't click.
    check("rowIndex addresses the DATAVIEW row, not the flow's position",
        flows.map(f => f.rowIndex).join(",") === "0,2,4",
        flows.map(f => f.rowIndex).join(","));
}

// ===============================================================
// 2. buildRowIndex: which rows are behind each selectable thing.
// ===============================================================
{
    const rows = [
        { source: "A", target: "B", value: 10, flowType: "Gas" },
        { source: "A", target: "B", value: 5, flowType: "Power" },
        { source: "A", target: "B", value: 2, flowType: "Gas" },
        { source: "B", target: "C", value: 8 },
        { source: "C", target: "C", value: 3 }
    ];
    const { flows } = parseDataView(toDataView(rows));
    const { corridors } = inferCorridors(flows);
    const index = buildRowIndex(corridors);
    const ab = corridors.find(c => c.source === "A" && c.target === "B");

    // A band's key is its CORRIDOR's, not its stripe's. At a
    // 1px corridor floor a stripe cannot be aimed at, and the halo that makes
    // a thin band hittable at all is wider than the stripes under it, so the
    // per-stripe choice was never really on offer. The breakdown moved to the
    // tooltip instead (`corridorTooltipRows`).
    check("a corridor's rows are ALL of its flows, whatever their type",
        (index.get(bandKey(ab.id)) || []).join(",") === "0,1,2",
        (index.get(bandKey(ab.id)) || []).join(","));
    // A->B carries two flow types. Exactly one band key exists for it, so
    // there is no per-stripe key left for anything to select.
    const bandKeys = Array.from(index.keys()).filter(k => k.startsWith('["band"'));
    check("...so a two-stripe corridor has exactly ONE key, not one per stripe",
        bandKeys.length === corridors.length && ab.segments.length === 2,
        `${bandKeys.length} band keys for ${corridors.length} corridors, A→B has ${ab.segments.length} stripes`);

    // A node has no row of its own; it's every row naming it at either end.
    check("a node's rows are every row naming it, as source OR target",
        (index.get(nodeKey("B")) || []).join(",") === "0,1,2,3",
        (index.get(nodeKey("B")) || []).join(","));
    check("a source-only node picks up only its own",
        (index.get(nodeKey("A")) || []).join(",") === "0,1,2");
    // A self-loop names the same node at both ends; counting it twice would
    // hand the host a duplicate id.
    check("a self-loop contributes its row once, not twice",
        (index.get(nodeKey("C")) || []).join(",") === "3,4",
        (index.get(nodeKey("C")) || []).join(","));

    const untyped = corridors.find(c => c.source === "B");
    check("an untyped corridor still gets a band key",
        (index.get(bandKey(untyped.id)) || []).join(",") === "3");
}

// ===============================================================
// 3. Keys can't collide, however hostile the data.
// ===============================================================
{
    // The lesson from the corridor grouping keys: a separator-joined key
    // merges two unrelated things when the data contains the separator.
    check("a node named like a band key doesn't collide with one",
        nodeKey('["band","X"]') !== bandKey("X"));
    check("two corridors are never the same key",
        bandKey("X") !== bandKey("Y"));
    check("a corridor id containing the separator is still distinct",
        bandKey('A","B') !== bandKey('A"),"B'));
    check("a node id containing the separator is still distinct",
        nodeKey('A","B') !== nodeKey('A"),"B'));
}

// ===============================================================
// 4. The click/hover state machine, against a fake host.
// ===============================================================
{
    const selected = [];       // what the host was actually told
    let contextMenuAt;
    let contextMenuId;
    const shown = [];
    const fakeId = row => ({ row, equals(o) { return o && o.row === this.row; } });

    const host = {
        createSelectionManager: () => ({
            select: (ids) => { selected.push(ids.map(i => i.row).join(",")); return Promise.resolve([]); },
            clear: () => { selected.push("CLEAR"); return Promise.resolve({}); },
            showContextMenu: (id, pos) => { contextMenuAt = pos; contextMenuId = id; return Promise.resolve({}); },
            hasSelection: () => false,
            getSelectionIds: () => [],
            registerOnSelectCallback: () => undefined
        }),
        createSelectionIdBuilder: () => {
            let r = -1;
            const b = { withCategory: (_c, i) => { r = i; return b; }, createSelectionId: () => fakeId(r) };
            return b;
        },
        tooltipService: { enabled: () => false, show: () => undefined, move: () => undefined, hide: () => undefined }
    };

    // A minimal element: attribute bag plus listener registry.
    const makeEl = () => {
        const attrs = {}, handlers = {};
        return {
            attrs, handlers,
            setAttribute: (k, v) => { attrs[k] = v; },
            getAttribute: k => attrs[k],
            addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
            fire(type, event = {}) {
                (handlers[type] || []).forEach(fn => fn(Object.assign(
                    { currentTarget: this, stopPropagation() {}, preventDefault() {} }, event)));
            }
        };
    };

    const rows = [
        { source: "A", target: "B", value: 10, flowType: "Gas" },
        { source: "A", target: "B", value: 5, flowType: "Power" },
        { source: "B", target: "C", value: 8 }
    ];
    const { flows } = parseDataView(toDataView(rows));
    const { corridors } = inferCorridors(flows);
    const dv = toDataView(rows);
    const ab = corridors.find(c => c.source === "A" && c.target === "B");
    const bc = corridors.find(c => c.source === "B" && c.target === "C");

    // A fresh controller per scenario. Selection deliberately SURVIVES a
    // re-render (a resize must not clear what the user clicked), so scenarios
    // sharing one controller would inherit each other's state -- which is
    // exactly what six confusing failures turned out to be the first time.
    const opacity = e => e.getAttribute("opacity");
    const scenario = (behaviour) => {
        const controller = new SelectionController(host);
        controller.beginFrame(dv, corridors, behaviour);
        // gas and power are the two STRIPES of A->B and now share one key, so
        // they light and dim together; bc is a second corridor, which is what
        // "the rest of the diagram" has to be made of for replace/add to mean
        // anything.
        const els = { gas: makeEl(), power: makeEl(), bc: makeEl(), nodeB: makeEl(), labelB: makeEl(),
            abHandle: makeEl(), abLane: makeEl(), bcHandle: makeEl() };
        controller.registerBand(els.gas, ab.id, []);
        controller.registerBand(els.power, ab.id, []);
        controller.registerBand(els.bc, bc.id, []);
        controller.registerNode(els.nodeB, "B", []);
        controller.registerDecoration(els.labelB, nodeKey("B"));
        // Two handles on A->B, because a corridor has several (leads, middle,
        // detour lane, corner) and they must all answer to the same corridor.
        // Optional-called on purpose: a build with no handle registration at all
        // must report each assertion below as a FAILURE rather than throwing here,
        // so what regressed is readable.
        controller.registerHandle?.(els.abHandle, ab.id);
        controller.registerHandle?.(els.abLane, ab.id);
        controller.registerHandle?.(els.bcHandle, bc.id);
        controller.applyVisualState();
        return { controller, ...els };
    };
    const DEFAULT = { tooltips: false };

    let { gas, power, bc: bcEl, nodeB, labelB } = scenario(DEFAULT);
    check("nothing selected: everything is at full opacity",
        [gas, power, bcEl, nodeB, labelB].every(e => opacity(e) === "1"));

    gas.fire("click");
    check("clicking a stripe lights its WHOLE corridor and dims the rest",
        opacity(gas) === "1" && opacity(power) === "1"
        && opacity(bcEl) === "0.25" && opacity(nodeB) === "0.25");
    // Gas is row 0, Power row 1 -- both of A->B; B->C is row 2.
    check("...and the host was told every row of that corridor",
        selected[selected.length - 1] === "0,1", selected[selected.length - 1]);

    // Plain click replaces; ctrl-click adds. Anything else and a user building
    // up a selection loses it on the second click.
    bcEl.fire("click");
    check("a plain click REPLACES the selection",
        opacity(bcEl) === "1" && opacity(gas) === "0.25" && opacity(power) === "0.25");
    gas.fire("click", { ctrlKey: true });
    check("ctrl-click ADDS to it",
        opacity(bcEl) === "1" && opacity(gas) === "1" && opacity(nodeB) === "0.25");
    check("...and the host got the union", selected[selected.length - 1] === "2,0,1",
        selected[selected.length - 1]);
    gas.fire("click", { ctrlKey: true });
    check("ctrl-clicking a selected thing removes it", opacity(gas) === "0.25");

    // There must always be a way out that doesn't need empty background --
    // on a dense diagram there may not be any. At this point B->C is the
    // only thing selected, so one more click on it must clear.
    bcEl.fire("click");
    check("clicking the only selected thing clears the selection",
        [gas, power, bcEl, nodeB].every(e => opacity(e) === "1"));
    check("...and the host was cleared, not sent an empty set",
        selected[selected.length - 1] === "CLEAR");

    // A node's label dims with it, so a dimmed node isn't left with a bright
    // caption floating over the diagram. Its foil is a CORRIDOR selection,
    // because a node selection now lights its own neighbourhood (below) and
    // every corridor in this fixture touches B.
    ({ gas, power, nodeB, labelB } = scenario(DEFAULT));
    nodeB.fire("click");
    check("a node's label lights with the node",
        opacity(nodeB) === "1" && opacity(labelB) === "1");
    ({ gas, power, nodeB, labelB } = scenario(DEFAULT));
    gas.fire("click");
    check("...and dims with it when something else is selected",
        opacity(nodeB) === "0.25" && opacity(labelB) === "0.25");

    // **A selected NODE lights its ONE HOP**: the corridors
    // touching it and the nodes at their far ends. Clicking a node already
    // cross-filters the report on every row it touches, so dimming those same
    // flows had the diagram contradict the report it had just filtered.
    //
    // The scope, stated from the other side: selecting a CORRIDOR still lights
    // exactly itself, which the assertion above is now also pinning -- node B
    // is an END of the corridor clicked there and dims all the same.
    {
        const h = scenario(DEFAULT);
        h.nodeB.fire("click");
        check("a selected node lights the corridors touching it",
            opacity(h.gas) === "1" && opacity(h.power) === "1" && opacity(h.bc) === "1");
        // A->B and B->C are all there is here, so B's one hop is the whole
        // diagram -- which is the hub case, true rather than a weak fixture.
        const far = makeEl();
        h.controller.registerNode(far, "C", []);
        h.controller.applyVisualState();
        check("...and the node at each far end, so no lit band runs into a dimmed node",
            opacity(far) === "1");
    }

    // Hover highlighting was built and then removed: dimming the diagram as
    // the pointer crossed it was more distracting than informative. Hover is
    // now for the tooltip ONLY, and must not repaint anything.
    ({ gas, power, bc: bcEl, nodeB, labelB } = scenario(DEFAULT));
    nodeB.fire("pointerenter");
    check("hovering with nothing selected changes nothing",
        [gas, power, bcEl, nodeB].every(e => opacity(e) === "1"));
    nodeB.fire("pointerleave");

    gas.fire("click");
    nodeB.fire("pointerenter");
    check("hovering does not disturb an existing selection",
        opacity(gas) === "1" && opacity(nodeB) === "0.25" && opacity(bcEl) === "0.25");
    nodeB.fire("pointerleave");
    check("...and leaving it changes nothing either",
        opacity(gas) === "1" && opacity(nodeB) === "0.25");

    // Selection has to survive a re-render: a resize, a format change and a
    // drag all re-enter render(), and clearing there would make the diagram
    // feel like it keeps forgetting.
    {
        const s = scenario(DEFAULT);
        s.gas.fire("click");
        s.controller.beginFrame(dv, corridors, DEFAULT);
        const again = makeEl(), other = makeEl();
        s.controller.registerBand(again, ab.id, []);
        s.controller.registerBand(other, bc.id, []);
        s.controller.applyVisualState();
        check("a selection survives the next render",
            opacity(again) === "1" && opacity(other) === "0.25");
    }

    // **Only the selected corridor's route handles are on screen** (the author,
    // ). Hidden rather than dimmed, because a
    // faint dot over a corridor the author is not working on is still clutter
    // and still in the way of the one they are.
    //
    // Asserted on `visibility`, which is the whole mechanism: a hidden SVG
    // element is not a pointer target either, so "visible" and "clickable" are
    // one attribute. The fake DOM does no hit-testing, so the attribute IS what
    // there is to check -- and it is what the browser acts on.
    {
        const vis = e => e.getAttribute("visibility");
        const s = scenario(DEFAULT);

        check("nothing selected: every handle is visible",
            [s.abHandle, s.abLane, s.bcHandle].every(e => vis(e) === "visible"));

        s.gas.fire("click");
        check("selecting a corridor keeps ALL of its own handles",
            vis(s.abHandle) === "visible" && vis(s.abLane) === "visible");
        // "hidden" is the whole mechanism, and the reason it is `visibility`
        // rather than opacity: a hidden SVG element is not a pointer target, so
        // it cannot be clicked or dragged either. There is nothing further to
        // assert here -- the fake DOM does no hit-testing, and inventing a
        // second check over the same attribute would only look like one.
        check("...and hides every other corridor's", vis(s.bcHandle) === "hidden");
        // Dimming and hiding are separate passes over separate attributes, so
        // neither can overwrite the other.
        check("...and a handle's opacity is left alone by the dimming pass",
            s.bcHandle.getAttribute("opacity") === undefined
            && s.abHandle.getAttribute("opacity") === undefined);
        check("...while the BANDS still dim rather than vanish",
            opacity(s.bc) === "0.25" && vis(s.bc) === undefined);

        s.bcHandle.fire("click");
        check("clicking a handle does not change the selection",
            vis(s.abHandle) === "visible" && vis(s.bcHandle) === "hidden");

        s.bcEl = s.bc;
        s.bc.fire("click", { ctrlKey: true });
        check("ctrl-click shows both selected corridors' handles",
            vis(s.abHandle) === "visible" && vis(s.bcHandle) === "visible");

        // **A selected NODE reveals the handles of the corridors TOUCHING it**
        //. Until then a node hid every handle in the diagram, since
        // no handle's key was ever in a node selection's scope. Asserted on a
        // node that touches ONE of the two corridors, because node B touches
        // both and so cannot tell "touching" from "all of them".
        const n = scenario(DEFAULT);
        const nodeA = makeEl();
        n.controller.registerNode(nodeA, "A", []);
        nodeA.fire("click");
        check("selecting a NODE reveals the handles of the corridors touching it",
            vis(n.abHandle) === "visible" && vis(n.abLane) === "visible");
        check("...and reveals no others", vis(n.bcHandle) === "hidden");
        // B->C does not touch A, so it is outside the hop and stays dim --
        // handles and lighting answer to the same neighbourhood.
        check("...while a corridor outside the hop stays dim, and handle-less",
            opacity(n.bc) === "0.25");

        // A hub touches everything around it, and all of it comes back.
        const hub = scenario(DEFAULT);
        hub.nodeB.fire("click");
        check("a node between two corridors reveals both",
            [hub.abHandle, hub.abLane, hub.bcHandle].every(e => vis(e) === "visible"));

        // Clearing puts them all back, so there is always a way back to the
        // whole diagram's handles.
        n.nodeB.fire("click");
        check("clearing the selection restores every handle",
            [n.abHandle, n.abLane, n.bcHandle].every(e => vis(e) === "visible"));

        // A drag persists and re-renders, so the visibility has to be re-applied
        // from the restored selection or the handle the author is holding
        // vanishes underneath them.
        const r = scenario(DEFAULT);
        r.gas.fire("click");
        r.controller.beginFrame(dv, corridors, DEFAULT);
        const againHandle = makeEl(), otherHandle = makeEl();
        r.controller.registerHandle?.(againHandle, ab.id);
        r.controller.registerHandle?.(otherHandle, bc.id);
        r.controller.applyVisualState();
        check("handle visibility survives the next render",
            vis(againHandle) === "visible" && vis(otherHandle) === "hidden");
    }

    // Cross-filtering is not a setting: it's what a Power BI visual does when
    // you click it. Nothing in the behaviour object may switch it off.
    {
        const s = scenario({ tooltips: false });
        const before = selected.length;
        s.gas.fire("click");
        check("a click always reaches the host — cross-filter isn't optional",
            selected.length === before + 1, `${selected.length - before} calls`);
    }

    // Always on, whatever the Interaction card says (the design).
    {
        const s = scenario({ tooltips: false });
        s.gas.fire("contextmenu", { clientX: 42, clientY: 7 });
        check("right-click opens the context menu",
            contextMenuAt && contextMenuAt.x === 42 && contextMenuAt.y === 7);
    }

    // **Both context-menu modes** (AppSource: "all visuals must support both
    // ContextMenu modes, empty space and data point"). A shape passes ITS
    // selection id; the diagram's own background passes an empty object, which
    // is the documented way to ask for the report-level menu with no data
    // point behind it.
    {
        const s = scenario({ tooltips: false });
        contextMenuId = undefined;
        s.gas.fire("contextmenu", { clientX: 5, clientY: 6 });
        check("data point: right-click on a flow passes that flow's selection id",
            contextMenuId !== undefined && contextMenuId.row !== undefined,
            JSON.stringify(contextMenuId));
        const svg = makeEl();
        s.controller.attachBackground(svg);
        contextMenuId = undefined;
        contextMenuAt = undefined;
        svg.fire("contextmenu", { clientX: 77, clientY: 88 });
        check("empty space: right-click on the background asks for the menu with no data point",
            contextMenuId !== undefined && contextMenuId.row === undefined
            && Object.keys(contextMenuId).length === 0,
            JSON.stringify(contextMenuId));
        check("...at the pointer", contextMenuAt && contextMenuAt.x === 77 && contextMenuAt.y === 88);
    }

    // Every registered element is a click target with a pointer cursor, except
    // decorations, which would make a thin node bar hard to hit.
    check("clickable things advertise themselves", gas.getAttribute("cursor") === "pointer");
    check("a decoration is not a click target",
        labelB.getAttribute("cursor") === undefined && !labelB.handlers["click"]);
}

// ===============================================================
// 5. beginFrame drops the previous render's elements.
// ===============================================================
{
    const host = {
        createSelectionManager: () => ({
            select: () => Promise.resolve([]), clear: () => Promise.resolve({}),
            showContextMenu: () => Promise.resolve({}), hasSelection: () => false,
            getSelectionIds: () => [], registerOnSelectCallback: () => undefined
        }),
        createSelectionIdBuilder: () => {
            const b = { withCategory: () => b, createSelectionId: () => ({ equals: () => false }) };
            return b;
        },
        tooltipService: undefined
    };
    const makeEl = () => {
        const attrs = {};
        return {
            setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k],
            addEventListener: () => undefined
        };
    };
    const rows = [{ source: "A", target: "B", value: 1 }];
    const { flows } = parseDataView(toDataView(rows));
    const { corridors } = inferCorridors(flows);
    const dv = toDataView(rows);

    const c = new SelectionController(host);
    const behaviour = { tooltips: false };
    c.beginFrame(dv, corridors, behaviour);
    const stale = makeEl();
    c.registerNode(stale, "A", []);
    c.applyVisualState();
    stale.setAttribute("opacity", "SENTINEL");

    // render() empties the SVG each frame, so holding on to last frame's
    // elements would dim detached ghosts and leak a render's worth of DOM
    // on every update.
    c.beginFrame(dv, corridors, behaviour);
    const fresh = makeEl();
    c.registerNode(fresh, "A", []);
    c.applyVisualState();
    check("a new frame forgets the previous render's elements",
        stale.getAttribute("opacity") === "SENTINEL" && fresh.getAttribute("opacity") === "1",
        stale.getAttribute("opacity"));

    check("a missing tooltip service doesn't throw", true);
}

// ===============================================================
// 8. The hover delay, and never two tooltips at once.
//    the agreed call: a tooltip that appears the instant the pointer touches
//    something pops up constantly while you're just reading the diagram.
// ===============================================================
{
    // A controllable clock, so the check doesn't sleep for real.
    const timers = [];
    const realSet = global.setTimeout, realClear = global.clearTimeout;
    global.setTimeout = (fn, ms) => { const t = { fn, ms, dead: false }; timers.push(t); return t; };
    global.clearTimeout = t => { if (t) { t.dead = true; } };
    const tick = () => { timers.splice(0).filter(t => !t.dead).forEach(t => t.fn()); };

    const shown = [], moved = [];
    let hidden = 0;
    const host = {
        createSelectionManager: () => ({
            select: () => Promise.resolve([]), clear: () => Promise.resolve({}),
            showContextMenu: () => Promise.resolve({}), hasSelection: () => false,
            getSelectionIds: () => [], registerOnSelectCallback: () => undefined
        }),
        createSelectionIdBuilder: () => {
            const b = { withCategory: () => b, createSelectionId: () => ({ equals: () => false }) };
            return b;
        },
        tooltipService: {
            enabled: () => true,
            show: args => shown.push(args),
            move: args => moved.push(args),
            hide: () => { hidden++; }
        }
    };

    // An element that can hold a <title>, the way render.ts builds it.
    const makeShape = () => {
        const handlers = {}, attrs = {}, children = [];
        return {
            children, attrs,
            setAttribute: (k, v) => { attrs[k] = v; },
            getAttribute: k => attrs[k],
            appendChild: c => { children.push(c); return c; },
            removeChild: c => { const i = children.indexOf(c); if (i >= 0) { children.splice(i, 1); } return c; },
            querySelector: sel => children.find(c => c.tag === sel) || null,
            addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
            fire(type, event = {}) {
                (handlers[type] || []).forEach(fn => fn(Object.assign(
                    { currentTarget: this, stopPropagation() {}, preventDefault() {} }, event)));
            }
        };
    };
    const withTitle = () => { const el = makeShape(); el.appendChild({ tag: "title", textContent: "x" }); return el; };
    const pointerAt = (x, y) => ({ clientX: x, clientY: y, pointerType: "mouse" });

    const rows = [{ source: "A", target: "B", value: 1 }];
    const { flows } = parseDataView(toDataView(rows));
    const { corridors } = inferCorridors(flows);
    const dv = toDataView(rows);
    const items = [{ displayName: "", value: "A to B: 1" }];

    const controller = new SelectionController(host);
    controller.beginFrame(dv, corridors, { tooltips: true });

    const shape = withTitle();
    controller.registerNode(shape, "A", items);
    check("the native <title> is removed when the host tooltip will show instead",
        shape.querySelector("title") === null);

    shape.fire("pointerenter", pointerAt(10, 20));
    check("nothing is shown the instant the pointer arrives", shown.length === 0);
    shape.fire("pointermove", pointerAt(30, 40));
    check("...nor while it moves before the delay elapses", shown.length === 0);
    tick();
    check("the tooltip appears once the delay elapses", shown.length === 1, String(shown.length));
    check("...at the pointer's LATEST position, not where it entered",
        JSON.stringify(shown[0].coordinates) === "[30,40]", JSON.stringify(shown[0].coordinates));
    check("...carrying the items it was registered with", shown[0].dataItems === items);

    shape.fire("pointermove", pointerAt(50, 60));
    check("once shown, moving tracks the pointer", moved.length === 1);
    shape.fire("pointerleave");
    check("leaving hides it", hidden > 0);

    // A drag begins with a pointerdown and then holds the pointer roughly
    // still, which is exactly what the delay is waiting for -- so pressing
    // must cancel it, or the tooltip fires a second into the drag and rides
    // along with the node.
    shown.length = 0;
    const dragged = makeShape();
    controller.registerNode(dragged, "A", items);
    dragged.fire("pointerenter", pointerAt(10, 10));
    dragged.fire("pointerdown", pointerAt(10, 10));
    dragged.fire("pointermove", pointerAt(60, 70));
    tick();
    check("pressing on a shape cancels the pending tooltip", shown.length === 0);
    dragged.fire("pointermove", pointerAt(90, 90));
    tick();
    check("...and moving on through the drag doesn't re-arm it", shown.length === 0);

    // A hover that leaves before the delay elapses must never show at all --
    // otherwise a tooltip pops up over a diagram the pointer has left.
    shown.length = 0;
    const brief = makeShape();
    controller.registerNode(brief, "B", items);
    brief.fire("pointerenter", pointerAt(1, 2));
    brief.fire("pointerleave");
    tick();
    check("a hover cut short before the delay never shows", shown.length === 0);

    // Same for a re-render: those elements are about to be detached, so
    // their pointerleave will never arrive.
    shown.length = 0;
    const doomed = makeShape();
    controller.registerNode(doomed, "A", items);
    doomed.fire("pointerenter", pointerAt(3, 4));
    controller.beginFrame(dv, corridors, { tooltips: true });
    tick();
    check("a pending hover is dropped when the diagram re-renders", shown.length === 0);

    // Off means NO tooltip at all (the agreed call, after seeing the browser's own
    // box still appear with the card's toggle off), so the <title> goes too.
    controller.beginFrame(dv, corridors, { tooltips: false });
    const off = withTitle();
    controller.registerNode(off, "A", items);
    check("with tooltips off the native <title> is removed as well",
        off.querySelector("title") === null);
    shown.length = 0;
    off.fire("pointerenter", pointerAt(5, 6));
    tick();
    check("...and the host tooltip stays quiet", shown.length === 0);

    // The one case the <title> still exists for: tooltips on, but no service
    // to show them -- any host that isn't Power BI.
    const hostless = new SelectionController(Object.assign({}, host, { tooltipService: undefined }));
    hostless.beginFrame(dv, corridors, { tooltips: true });
    const fallback = withTitle();
    hostless.registerNode(fallback, "A", items);
    check("with no tooltip service the native <title> is kept as the fallback",
        fallback.querySelector("title") !== null);

    global.setTimeout = realSet;
    global.clearTimeout = realClear;
}

// ===============================================================
// 7. Inbound highlighting.
// ===============================================================
//
// Another visual set to Highlight sends the FULL values array plus a parallel
// `highlights` array, null wherever a row is out of scope. Unavailable until
// the mapping became categorical -- `DataViewTable` has no field
// for it, established from the typings, Microsoft's docs and a live probe
// (the design notes).
//
// The two decisions asserted here are the ones a reader would notice:
//   - ABSENT means nothing dims. That is how "nothing is highlighted" arrives,
//     and it has to be the earlier behaviour rather than everything
//     dimmed.
//   - A LOCAL CLICK beats an inbound highlight, because the click is what this
//     visual cross-filters out -- showing the old highlight while filtering on
//     the new click would have the diagram disagree with the report.
{
    const { highlightedRowsOf, litKeysFrom, buildRowIndex: rowIndexOf } = require("./lib/selection.js");
    const { withHighlights } = require("./dataview.js");

    // Section 4's harness is scoped to its own block, so the pieces this one
    // needs are built again here rather than hoisted -- a controller shared
    // between sections inherits the other's state, which is what six confusing
    // failures turned out to be the first time (see section 4's note).
    const opacity = e => e.getAttribute("opacity");
    const makeEl = () => {
        const attrs = {}, handlers = {};
        return {
            setAttribute: (k, v) => { attrs[k] = v; },
            getAttribute: k => attrs[k],
            addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
            fire(type, event = {}) {
                (handlers[type] || []).forEach(fn => fn(Object.assign(
                    { currentTarget: this, stopPropagation() {}, preventDefault() {} }, event)));
            }
        };
    };
    const host = {
        createSelectionManager: () => ({
            select: () => Promise.resolve([]),
            clear: () => Promise.resolve({}),
            showContextMenu: () => Promise.resolve({}),
            hasSelection: () => false,
            getSelectionIds: () => [],
            registerOnSelectCallback: () => undefined
        }),
        createSelectionIdBuilder: () => {
            const b = { withCategory: () => b, createSelectionId: () => ({ equals: () => false }) };
            return b;
        },
        tooltipService: { enabled: () => false, show: () => undefined, move: () => undefined, hide: () => undefined }
    };

    const rows = [
        { source: "A", target: "B", value: 10, flowType: "Gas" },
        { source: "A", target: "B", value: 5, flowType: "Power" },
        { source: "B", target: "C", value: 8 }
    ];
    const base = toDataView(rows);
    const { flows } = parseDataView(base);
    const { corridors } = inferCorridors(flows);
    const index = rowIndexOf(corridors);
    const ab = corridors.find(c => c.source === "A" && c.target === "B");
    const bc = corridors.find(c => c.source === "B" && c.target === "C");

    // --- the pure half -------------------------------------------------
    check("no highlights array at all reads as 'nothing highlighted'",
        highlightedRowsOf(base) === undefined);
    check("...and so does a dataView with no categorical at all",
        highlightedRowsOf(undefined) === undefined && highlightedRowsOf({}) === undefined);

    const oneRow = highlightedRowsOf(withHighlights(base, [10, null, null]));
    check("a highlights array reads the non-null rows",
        oneRow && oneRow.size === 1 && oneRow.has(0), oneRow ? [...oneRow].join(",") : "none");
    // A PARTIAL highlight: smaller than the value, which is what the host sends
    // when only some of the rows behind one aggregated row are in scope.
    const partial = highlightedRowsOf(withHighlights(base, [4, null, 8]));
    check("a PARTIAL highlight still counts as in scope -- the dimming is binary",
        partial && partial.size === 2 && partial.has(0) && partial.has(2),
        partial ? [...partial].join(",") : "none");
    const none = highlightedRowsOf(withHighlights(base, [null, null, null]));
    check("an all-null array is 'highlighted, nothing matched' -- a set, not undefined",
        none !== undefined && none.size === 0);

    // Row 0 is one of A->B's two flows; lighting it must light the whole
    // corridor, or a highlight would dim a flow the other visual is pointing at.
    const lit = litKeysFrom(new Set([0]), index);
    check("ANY row of a corridor lights the whole corridor",
        lit.has(bandKey(ab.id)) && !lit.has(bandKey(bc.id)),
        [...lit].length + " keys lit");
    check("...and the nodes it touches", lit.has(nodeKey("A")) && lit.has(nodeKey("B")));
    check("...but not a node it does not", !lit.has(nodeKey("C")));
    check("nothing highlighted lights nothing", litKeysFrom(new Set(), index).size === 0);

    // --- the wiring, which is the half that can silently not happen ----
    const litScenario = highlights => {
        const controller = new SelectionController(host);
        controller.beginFrame(highlights ? withHighlights(base, highlights) : base,
            corridors, { tooltips: false });
        const els = { gas: makeEl(), bc: makeEl(), nodeC: makeEl() };
        controller.registerBand(els.gas, ab.id, []);
        controller.registerBand(els.bc, bc.id, []);
        controller.registerNode(els.nodeC, "C", []);
        controller.applyVisualState();
        return { controller, ...els };
    };

    const off = litScenario(undefined);
    check("WIRING: no highlights -> nothing dims",
        opacity(off.gas) === "1" && opacity(off.bc) === "1" && opacity(off.nodeC) === "1");
    check("...and the controller reports no lit set at all", off.controller.litKeys === undefined);

    const on = litScenario([10, null, null]);
    check("WIRING: highlighting row 0 lights A→B and dims B→C",
        opacity(on.gas) === "1" && opacity(on.bc) === "0.25", `A→B ${opacity(on.gas)}, B→C ${opacity(on.bc)}`);
    check("...and dims a node the highlight does not reach",
        opacity(on.nodeC) === "0.25");
    check("...and the lit set is reported for the checks", on.controller.litKeys !== undefined);

    // A local click must take over from the inbound highlight.
    const both = litScenario([null, null, 8]);   // B->C highlighted
    check("highlighting row 2 lights B→C and dims A→B",
        opacity(both.bc) === "1" && opacity(both.gas) === "0.25");
    both.gas.fire("click");
    check("A LOCAL CLICK beats the inbound highlight",
        opacity(both.gas) === "1" && opacity(both.bc) === "0.25",
        `A→B ${opacity(both.gas)}, B→C ${opacity(both.bc)}`);
    check("...and the lit set is still there underneath, not destroyed by the click",
        both.controller.litKeys !== undefined);

    // The declaration: without it the host never sends highlights at all.
    const cap = JSON.parse(require("fs").readFileSync(
        require("path").join(__dirname, "..", "capabilities.json"), "utf8"));
    check("capabilities.json declares supportsHighlight", cap.supportsHighlight === true);
    check("...on a categorical mapping, the only shape it works with",
        cap.dataViewMappings[0].categorical !== undefined && cap.dataViewMappings[0].table === undefined);

    // --- 7b. STRIPE grain ----------------------------------
    //
    // A highlight naming one flow type must dim the others beside it, not
    // light the whole corridor. earlier keyed a band's SELECTION to its
    // corridor because a 1px stripe cannot be aimed at -- that is about hit
    // targets, and an inbound highlight has none, so the dimming can be finer
    // than the clicking. Both keys exist; which one answers depends on which
    // kind of dimming is in force.
    const { stripeKey, buildDimIndex } = require("./lib/selection.js");

    const dim = buildDimIndex(corridors);
    check("the dim index holds a key per STRIPE as well as per corridor",
        dim.has(stripeKey(ab.id, "Gas")) && dim.has(stripeKey(ab.id, "Power"))
        && dim.has(bandKey(ab.id)),
        `${dim.size} keys vs ${index.size} for selection`);
    check("...and the selection index does NOT, so it is untouched",
        !index.has(stripeKey(ab.id, "Gas")));
    check("an UNTYPED corridor still gets a stripe key, keyed on the empty type",
        dim.has(stripeKey(bc.id, undefined)));
    check("a stripe's rows are its OWN flows, not its corridor's",
        dim.get(stripeKey(ab.id, "Gas")).join(",") === "0"
        && dim.get(stripeKey(ab.id, "Power")).join(",") === "1",
        `Gas ${dim.get(stripeKey(ab.id, "Gas")).join(",")}, Power ${dim.get(stripeKey(ab.id, "Power")).join(",")}`);

    // Row 0 is the Gas stripe of A->B. At stripe grain that lights Gas and
    // leaves Power dimmed -- the whole point of the change.
    const stripeScenario = highlights => {
        const controller = new SelectionController(host);
        controller.beginFrame(withHighlights(base, highlights), corridors, { tooltips: false });
        const els = { gas: makeEl(), power: makeEl(), bc: makeEl() };
        // As render does: the corridor's key for clicking, the stripe's for dimming.
        controller.registerBand(els.gas, ab.id, [], stripeKey(ab.id, "Gas"));
        controller.registerBand(els.power, ab.id, [], stripeKey(ab.id, "Power"));
        controller.registerBand(els.bc, bc.id, [], stripeKey(bc.id, undefined));
        controller.applyVisualState();
        return { controller, ...els };
    };

    const gasOnly = stripeScenario([10, null, null]);
    check("STRIPE GRAIN: highlighting Gas lights Gas and DIMS Power beside it",
        opacity(gasOnly.gas) === "1" && opacity(gasOnly.power) === "0.25",
        `Gas ${opacity(gasOnly.gas)}, Power ${opacity(gasOnly.power)}`);
    check("...and dims the other corridor too", opacity(gasOnly.bc) === "0.25");

    const powerOnly = stripeScenario([null, 5, null]);
    check("...and the other way round", opacity(powerOnly.power) === "1"
        && opacity(powerOnly.gas) === "0.25");

    const bothStripes = stripeScenario([10, 5, null]);
    check("highlighting both stripes lights both",
        opacity(bothStripes.gas) === "1" && opacity(bothStripes.power) === "1"
        && opacity(bothStripes.bc) === "0.25");

    // A CLICK stays corridor-grain: clicking a stripe lights its whole
    // corridor, which is whdecided and what a pointer can reach.
    const clicked = stripeScenario([null, null, 8]);   // B->C highlighted
    check("before the click, stripe grain is in force",
        opacity(clicked.gas) === "0.25" && opacity(clicked.bc) === "1");
    clicked.gas.fire("click");
    check("A CLICK is still CORRIDOR grain -- both stripes light, not just the one hit",
        opacity(clicked.gas) === "1" && opacity(clicked.power) === "1"
        && opacity(clicked.bc) === "0.25",
        `Gas ${opacity(clicked.gas)}, Power ${opacity(clicked.power)}, B→C ${opacity(clicked.bc)}`);

    // An element with no stripe key of its own (a node, the hit halo) falls
    // back to its corridor/node key, so nothing is left un-dimmable.
    const mixed = (() => {
        const controller = new SelectionController(host);
        controller.beginFrame(withHighlights(base, [10, null, null]), corridors, { tooltips: false });
        const plain = makeEl();
        const nodeA = makeEl();
        controller.registerBand(plain, ab.id, []);          // no dim key
        controller.registerNode(nodeA, "A", []);
        controller.applyVisualState();
        return { plain, nodeA };
    })();
    check("an element with no stripe key falls back to its corridor's",
        opacity(mixed.plain) === "1");
    check("...and a node still answers at node grain", opacity(mixed.nodeA) === "1");

    // --- 7c. PARTIAL highlights: the fraction, not just the fact
    //
    // Another visual highlighting at a FINER grain than the Sankey sends each
    // row's share. Measured on the author's report: a bar chart on FlowType+Scenario
    // against a Sankey on FlowType alone gave 20/20/24/25% on four rows -- the
    // fractions DIFFER per row, which is what makes a proportional reading
    // both possible and correct.
    const { highlightFractionsOf, keyFractionsFrom } = require("./lib/selection.js");

    const f = highlightFractionsOf(withHighlights(base, [2, 5, null]));
    check("a partial highlight reads as its FRACTION of the row",
        f !== undefined && Math.abs(f.get(0) - 0.2) < 1e-9 && Math.abs(f.get(1) - 1) < 1e-9,
        f ? `row0=${f.get(0)} row1=${f.get(1)}` : "none");
    check("...a null row is 0, not absent", f.get(2) === 0);
    check("no highlights at all gives no fractions",
        highlightFractionsOf(base) === undefined);
    // Values off the model are floats; a fraction must not escape [0,1].
    const clamped = highlightFractionsOf(withHighlights(base, [1e9, -4, 8]));
    check("a fraction is clamped into [0,1] whatever the host sends",
        clamped.get(0) === 1 && clamped.get(1) === 0,
        `${clamped.get(0)}, ${clamped.get(1)}`);
    // A zero-valued row cannot be partly anything.
    const zeroRow = highlightFractionsOf({ categorical: { values: [{ values: [0], highlights: [0] }] } });
    check("a zero-valued row with a non-null highlight is wholly in scope, not 0/0",
        zeroRow.get(0) === 1);

    // A key over several rows takes the LARGEST share, so a wholly-highlighted
    // stripe is never reported as half lit because of a sibling row.
    const keyF = keyFractionsFrom(new Map([[0, 0.2], [1, 1], [2, 0]]), dim);
    check("a key's fraction is the largest of its rows', not their mean",
        Math.abs(keyF.get(bandKey(ab.id)) - 1) < 1e-9,
        `A→B corridor = ${keyF.get(bandKey(ab.id))}`);
    check("...while each stripe keeps its own",
        Math.abs(keyF.get(stripeKey(ab.id, "Gas")) - 0.2) < 1e-9
        && Math.abs(keyF.get(stripeKey(ab.id, "Power")) - 1) < 1e-9);

    // The WIRING. A stripe with a sub-band over it goes dim so the sub-band
    // reads; one WITHOUT (too thin to draw) is drawn part way instead, so the
    // information is not simply lost.
    const partialScenario = (highlights, drawSubBand) => {
        const controller = new SelectionController(host);
        controller.beginFrame(withHighlights(base, highlights), corridors, { tooltips: false });
        const gas = makeEl();
        const subBand = makeEl();
        const gasKey = stripeKey(ab.id, "Gas");
        controller.registerBand(gas, ab.id, [], gasKey);
        if (drawSubBand) { controller.registerSubBand(subBand, ab.id, gasKey); }
        controller.applyVisualState();
        return { controller, gas, subBand, gasKey };
    };

    const withSub = partialScenario([2, null, null], true);
    check("the controller reports the fraction render needs",
        Math.abs(withSub.controller.highlightFractionOf(withSub.gasKey) - 0.2) < 1e-9,
        String(withSub.controller.highlightFractionOf(withSub.gasKey)));
    check("WITH a sub-band: the stripe goes DIM so the portion reads against it",
        opacity(withSub.gas) === "0.25", opacity(withSub.gas));
    check("...and the sub-band itself is fully lit", opacity(withSub.subBand) === "1");

    // A part-way opacity for stripes with no sub-band was tried and removed
    //: every partly-highlighted stripe gets a sub-band now,
    // however thin, so the second rule had nothing left to cover. A stripe is
    // dimmed because it CARRIES a dim key and is partly in scope -- one rule.
    const noSub = partialScenario([2, null, null], false);
    check("a partly-highlighted stripe is dimmed outright, not drawn part way",
        opacity(noSub.gas) === "0.25", opacity(noSub.gas));
    check("...so opacity is only ever dimmed or lit, never in between",
        [opacity(noSub.gas), opacity(withSub.gas), opacity(withSub.subBand)]
            .every(o => o === "0.25" || o === "1"));

    // A fully highlighted stripe needs no sub-band and is simply lit.
    const whole = partialScenario([10, null, null], false);
    check("a WHOLLY highlighted stripe is lit outright, no part-way opacity",
        opacity(whole.gas) === "1", opacity(whole.gas));

    // A node on a partly-highlighted flow is LIT, not dimmed: it has no dim
    // key, so it falls through to the plain rule, and the path is what the
    // other visual is pointing at.
    const nodeOnPartial = (() => {
        const controller = new SelectionController(host);
        controller.beginFrame(withHighlights(base, [2, null, null]), corridors, { tooltips: false });
        const nodeA = makeEl();
        const nodeC = makeEl();
        controller.registerNode(nodeA, "A", []);
        controller.registerNode(nodeC, "C", []);
        controller.applyVisualState();
        return { nodeA, nodeC };
    })();
    check("a node on a partly-highlighted flow is LIT", opacity(nodeOnPartial.nodeA) === "1",
        opacity(nodeOnPartial.nodeA));
    check("...and one the highlight never reaches is dimmed",
        opacity(nodeOnPartial.nodeC) === "0.25", opacity(nodeOnPartial.nodeC));

    // And a click still overrides all of it at corridor grain.
    const clickedPartial = partialScenario([2, null, null], true);
    clickedPartial.gas.fire("click");
    check("a CLICK overrides the partial reading entirely",
        opacity(clickedPartial.gas) === "1" && opacity(clickedPartial.subBand) === "1",
        `stripe ${opacity(clickedPartial.gas)}, sub ${opacity(clickedPartial.subBand)}`);
}

console.log(failures === 0 ? "\nAll selection checks passed." : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
