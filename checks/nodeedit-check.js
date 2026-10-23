"use strict";
// The node editor.
//
// 1. The blob: round trip; parse is total field by field; the icon budget.
// 2. withNodeEdit: undefined goes back to the data; an empty node disappears.
// 3. Precedence for label / name / icon: the EDIT beats the data, each
//    asserted against the data-only control.
// 4. Ports: the DATA wins per flow; an edit only fills blank ends; no edit
//    falls back to East/West.
// 5. The panel never rebuilds under the author's hand: saving an edit and the
//    update it causes leave every element in place; an outside change (Reset)
//    or a change of nodes rebuilds. It follows the diagram (focusNode), and
//    edits colour.

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

// A fake HTML DOM, enough for the panel.
class El {
    constructor(tag) {
        this.tag = tag; this.children = []; this.parent = null; this.handlers = new Map(); this.attributes = {};
        this.style = {}; this.className = ""; this.value = ""; this.checked = false; this._text = "";
        const cls = new Set();
        this.classList = { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) };
    }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; return c; }
    get firstChild() { return this.children[0] ?? null; }
    addEventListener(t, fn) { if (!this.handlers.has(t)) this.handlers.set(t, []); this.handlers.get(t).push(fn); }
    fire(t, e = {}) { (this.handlers.get(t) || []).forEach(fn => fn(Object.assign({ preventDefault() {} }, e))); }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    focus() { }
    get tagName() { return this.tag.toUpperCase(); }
    setPointerCapture(id) { this.captured = id; }
    releasePointerCapture() { this.captured = undefined; }
    hasPointerCapture(id) { return this.captured === id; }
    set textContent(v) { this._text = v; this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
    all() { return this.children.reduce((a, c) => a.concat(c.all()), [this]); }
}
global.document = {
    createElement: tag => new El(tag),
    createTextNode: text => { const t = new El("#text"); t._text = text; return t; }
};

const bg = require("./lib/background.js");
const ne = require("./lib/nodeEdits.js");
const { NodeEditorPanel, clampPanel } = require("./lib/nodeEditorPanel.js");
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");

const HOUSE = bg.iconFromText('<svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8v10H3z"/></svg>').image.url;
const SUN = bg.iconFromText('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>').image.url;

// --------------------------------------------------------------- 1. blob
{
    const edits = new Map([
        ["Wind", { label: "Wind power", hideName: false, icon: HOUSE, outPort: "South", colour: "#12ab34" }],
        ["Grid", { hideName: true, icon: "", inPort: "North" }]
    ]);
    const back = ne.parseNodeEdits(ne.serialiseNodeEdits(edits));
    check("round trip", JSON.stringify([...back]) === JSON.stringify([...edits]));
    check("nothing edited serialises to empty", ne.serialiseNodeEdits(new Map()) === "" && ne.parseNodeEdits("").size === 0);
    const messy = JSON.stringify({
        A: { l: 5, h: 2, i: "javascript:alert(1)", o: "Up", n: "West", c: "red" },
        B: { l: "x".repeat(500) },
        C: "not an object", D: [1, 2], E: {}
    });
    const m = ne.parseNodeEdits(messy);
    check("a bad field is dropped on its own, the good one kept", m.get("A") && JSON.stringify(m.get("A")) === JSON.stringify({ inPort: "West" }));
    check("a long label is cut to the limit", m.get("B").label.length === ne.MAX_EDIT_LABEL);
    check("non-objects and empty edits are dropped", !m.has("C") && !m.has("D") && !m.has("E"));
    check("unparseable is nothing", ne.parseNodeEdits("{oops").size === 0 && ne.parseNodeEdits(42).size === 0 && ne.parseNodeEdits("[]").size === 0);
    // The budget: icons past 300 KB of stored characters are dropped, in order.
    const big = bg.iconFromText('<svg viewBox="0 0 1 1"><!--' + "x".repeat(19000) + "--></svg>").image.url;
    const many = {};
    for (let i = 0; i < 20; i++) many[`N${String(i).padStart(2, "0")}`] = { i: big, l: "kept" };
    const budgeted = ne.parseNodeEdits(JSON.stringify(many));
    const withIcon = [...budgeted.values()].filter(e => e.icon).length;
    check("icons past the total budget are dropped, the rest of the edit kept",
        withIcon === Math.floor(ne.MAX_EDIT_ICONS_TOTAL / big.length) && budgeted.size === 20 && ne.iconBudgetUsed(budgeted) <= ne.MAX_EDIT_ICONS_TOTAL,
        `${withIcon} of 20 icons kept, ${big.length} chars each`);
}

// -------------------------------------------------------- 2. withNodeEdit
{
    let e = ne.withNodeEdit(new Map(), "A", { label: "x", outPort: "North" });
    e = ne.withNodeEdit(e, "A", { label: undefined });
    check("undefined goes back to the data", JSON.stringify(e.get("A")) === JSON.stringify({ outPort: "North" }));
    e = ne.withNodeEdit(e, "A", { outPort: undefined });
    check("a node with nothing edited disappears", !e.has("A"));
}

// ----------------------------------------------------------- 3. precedence
const ROLES = ["flowID", "source", "target", "value", "sourcePort", "targetPort", "sourceIcon", "targetIcon"];
const dvOf = rows => ({ table: { columns: ROLES.map(r => ({ roles: { [r]: true } })),
    rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null))) } });
const ROWS = [
    { source: "Wind", target: "Grid", value: 10, sourceIcon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg>' },
    { source: "Grid", target: "Homes", value: 6, sourcePort: "North" },
    { source: "Grid", target: "Loss", value: 4 }
];
function graphWith(edits) {
    const { flows } = parseDataView(dvOf(ROWS));
    const graph = buildGraph(flows).graph;
    const facts = ne.applyNodeEdits(graph, edits);
    return { graph, facts, flows };
}
{
    const plain = graphWith(new Map()).graph;
    // **The data's label is the node's ID** took the label
    // roles out: what an edit overrides is the name the model programmed in.
    check("(control) the id is the label, and the data's icon is there",
        plain.nodes.get("Wind").label === "Wind" && plain.nodes.get("Homes").label === "Homes"
        && plain.nodes.get("Wind").icon === SUN);
    const { graph, facts } = graphWith(new Map([
        ["Wind", { label: "Wind power", icon: HOUSE }],
        ["Homes", { label: "Households" }],
        ["Grid", { hideName: true }],
        ["Loss", { icon: "" }]
    ]));
    check("an edited label beats the data's", graph.nodes.get("Wind").label === "Wind power");
    check("...for a node the data never named", graph.nodes.get("Homes").label === "Households");
    check("hide beats a name", graph.nodes.get("Grid").label === "");
    check("an edited icon beats the data's", graph.nodes.get("Wind").icon === HOUSE);
    const coloured = graphWith(new Map([["Grid", { colour: "#aa0000" }]]));
    check("(control) no colour in the data", graphWith(new Map()).graph.nodes.get("Grid").colour === undefined);
    check("an edited colour sets the node's", coloured.graph.nodes.get("Grid").colour === "#aa0000");
    const { flows: cf } = parseDataView(dvOf([{ source: "P", target: "Q", value: 1 }]));
    const cg = buildGraph(cf).graph;
    const cfacts = ne.applyNodeEdits(cg, new Map([["P", { colour: "#00ff00" }]]));
    // The editor is the only source of a node colour now, so the facts -- what
    // the node was before any edit -- have none to report.
    check("an edited colour is the node's, and the facts say it had none",
        cg.nodes.get("P").colour === "#00ff00" && cfacts.find(f => f.id === "P").colour === undefined);
    const shown = graphWith(new Map([["Homes", { hideName: false }], ["Wind", { icon: "" }], ["Loss", { label: "   " }]])).graph;
    check("show keeps the id as the name", shown.nodes.get("Homes").label === "Homes");
    check("an explicit no-icon removes the data's", shown.nodes.get("Wind").icon === undefined);
    check("a blank edited label is no edit", shown.nodes.get("Loss").label === "Loss");
    const wind = facts.find(f => f.id === "Wind");
    check("the facts are what the node was before any edit", wind.label === "Wind" && wind.icon === SUN
        && facts.find(f => f.id === "Homes").label === "Homes");
}

// ---------------------------------------------------------------- 4. ports
{
    const { flows } = graphWith(new Map());
    const portsOf = edits => {
        const { corridors } = inferCorridors(flows, edits ? ne.portDefaultsOf(edits) : undefined);
        return Object.fromEntries(corridors.map(c => [c.id, `${c.sourcePort}>${c.targetPort}`]));
    };
    const plain = portsOf();
    check("(control) no edits: East/West, and the data's North", plain["Wind→Grid"] === "East>West"
        && plain["Grid→Homes"] === "North>West" && plain["Grid→Loss"] === "East>West");
    const edited = portsOf(new Map([["Grid", { outPort: "South", inPort: "North" }]]));
    check("an edit fills a blank end", edited["Grid→Loss"] === "South>West" && edited["Wind→Grid"] === "East>North");
    check("the data's port for a flow beats the edit", edited["Grid→Homes"] === "North>West");
    const mixed = parseDataView(dvOf([
        { source: "A", target: "B", value: 1 },
        { source: "A", target: "B", value: 1, sourcePort: "West" }
    ])).flows;
    const mc = inferCorridors(mixed, ne.portDefaultsOf(new Map([["A", { outPort: "South" }]]))).corridors[0];
    check("a corridor where any flow sets the port is the data's", mc.sourcePort === "West");
}

// ---------------------------------------------------------------- 5. panel
{
    const host = new El("div");
    const saved = [];
    const panel = new NodeEditorPanel(host, edits => saved.push(edits));
    const { facts } = graphWith(new Map());
    panel.setModel(facts, new Map());
    panel.open();
    const root = host.children[0];
    const list = root.all().find(e => e.className === "sankeybi-node-list");
    check("one row per node", list.children.length === facts.length, `${list.children.length}`);
    const rowOf = name => list.children.find(r => r.children[0].textContent.includes(name));
    rowOf("Wind").children[0].fire("click");
    const row = rowOf("Wind");
    const header = row.children[0];
    const textBox = row.all().find(e => e.tag === "input" && e.type === "text");
    const checkbox = row.all().find(e => e.tag === "input" && e.type === "checkbox");
    const selects = row.all().filter(e => e.tag === "select");
    check("expanding shows label, hide, icon and both ports", textBox && checkbox && selects.length === 2);

    textBox.value = "Wind power";
    textBox.fire("change");
    check("a label change is saved at once", saved.length === 1 && saved[0].get("Wind").label === "Wind power");
    const before = row.all();
    // What visual.ts does next: the update, with the edits it just saved.
    panel.setModel(facts, saved[saved.length - 1]);
    const after = rowOf("Wind power");
    const now = row.all();
    check("the update after a save rebuilds nothing: the same row and elements", after === row
        && before.filter(e => e.tag !== "span" && e.tag !== "#text").every(e => now.includes(e)),
        `${before.length} elements`);
    check("...and the checkbox the author is reaching for is still attached", list.all().includes(checkbox));
    check("the header shows the new name and the edited tag", header.textContent.includes("Wind power") && header.textContent.includes("edited"));

    selects[0].value = "South";
    selects[0].fire("change");
    check("a port pick is saved", saved[saved.length - 1].get("Wind").outPort === "South");
    checkbox.checked = true;
    checkbox.fire("change");
    check("hide is stored where it differs from the data", saved[saved.length - 1].get("Wind").hideName === true);
    checkbox.checked = false;
    checkbox.fire("change");
    check("...and forgotten where it matches the data", saved[saved.length - 1].get("Wind").hideName === undefined);

    // Nothing in the data can hide a name, so an unedited
    // node shows as shown -- and hiding it is the editor's job alone.
    const homes = rowOf("Homes");
    homes.children[0].fire("click");
    const homesBox = rowOf("Homes").all().find(e => e.tag === "input" && e.type === "checkbox");
    check("an unedited name shows as shown", homesBox.checked === false);

    // An outside change: Reset node edits.
    panel.setModel(facts, new Map());
    const rebuilt = rowOf("Wind");
    check("an outside change (Reset) rebuilds the list", rebuilt && rebuilt !== row && !list.children.includes(row));
    // A change of nodes.
    const fewer = facts.filter(f => f.id !== "Loss");
    panel.setModel(fewer, new Map());
    check("a change of nodes rebuilds the list", list.children.length === fewer.length);

    check("there is no search box any more", !root.all().some(e => e.tag === "input" && e.type === "search"));

    // Following the diagram: the clicked node opens, the others close.
    rowOf("Grid").children[0].fire("click");
    rowOf("Wind").children[0].fire("click");
    const openRows = () => list.children.filter(r => r.all().some(e => e.className === "sankeybi-node-details"));
    check("(two rows open by hand)", openRows().length === 2);
    panel.focusNode("Homes");
    check("focusNode opens the clicked node and closes the rest",
        openRows().length === 1 && openRows()[0] === rowOf("Homes"));
    const homesRow = rowOf("Homes");
    const homesInputs = homesRow.all();
    panel.focusNode("Homes");
    check("focusing the node already open changes nothing", rowOf("Homes") === homesRow && homesRow.all().every(e => homesInputs.includes(e)));
    panel.focusNode("Nowhere");
    check("an unknown node is ignored", openRows().length === 1);

    // Colour, through the panel.
    const picker = rowOf("Homes").all().find(e => e.tag === "input" && e.type === "color");
    check("a colour picker, starting on the default grey where the data has none", picker && picker.value === "#605e5c");
    picker.value = "#336699";
    picker.fire("change");
    check("a picked colour is saved", saved[saved.length - 1].get("Homes").colour === "#336699");
    const back = rowOf("Homes").all().find(e => e.tag === "button" && e.textContent === "Use default");
    check("...with a way back to the default", back !== undefined);
    back.fire("click");
    check("...which forgets it", !saved[saved.length - 1].get("Homes") || saved[saved.length - 1].get("Homes").colour === undefined);

    // Closed, the panel ignores clicks in the diagram.
    root.all().find(e => e.tag === "button" && e.textContent === "Done").fire("click");
    panel.focusNode("Grid");
    check("closed, focusNode does nothing", !panel.isOpen() && openRows().length === 1 && openRows()[0] === rowOf("Homes"));
}

// ------------------------------------------------------------ 6. placement
{
    const box = { width: 800, height: 600 }, size = { width: 340, height: 400 };
    check("clampPanel leaves a position inside alone", JSON.stringify(clampPanel(100, 50, size, box)) === JSON.stringify({ x: 100, y: 50 }));
    check("...holds one past the far edges inside, inset 8", JSON.stringify(clampPanel(900, 900, size, box)) === JSON.stringify({ x: 452, y: 192 }));
    check("...and past the near edges", JSON.stringify(clampPanel(-50, -50, size, box)) === JSON.stringify({ x: 8, y: 8 }));
    check("...and pins a panel bigger than the visual to the top-left", JSON.stringify(clampPanel(40, 40, { width: 900, height: 700 }, box)) === JSON.stringify({ x: 8, y: 8 }));

    const host = new El("div");
    host.clientWidth = 800;
    host.clientHeight = 600;
    const panel = new NodeEditorPanel(host, () => undefined);
    panel.setModel(graphWith(new Map()).facts, new Map());
    const root = host.children[0];
    root.offsetWidth = 340;
    root.offsetHeight = 400;
    panel.open();
    const done = root.all().find(e => e.tag === "button" && e.textContent === "Done");
    const head = root.all().find(e => e.className === "sankeybi-node-head");
    check("it starts bottom-left", root.style.left === "8px" && root.style.bottom === "8px" && root.style.top === "auto");
    check("there is no top/bottom button any more", !root.all().some(e => e.className === "sankeybi-node-dock"));

    // Drag by the title bar: from where it is (offsets as the browser reports them).
    root.offsetLeft = 8;
    root.offsetTop = 192;
    head.fire("pointerdown", { target: head, button: 0, clientX: 100, clientY: 300, pointerId: 7 });
    check("(the drag captures the pointer)", head.captured === 7);
    head.fire("pointermove", { clientX: 150, clientY: 260, pointerId: 7 });
    check("dragging moves it by the pointer's travel", root.style.left === "58px" && root.style.top === "152px" && root.style.bottom === "auto");
    head.fire("pointermove", { clientX: 2000, clientY: -500, pointerId: 7 });
    check("...held inside the visual", root.style.left === "452px" && root.style.top === "8px");
    head.fire("pointerup", { pointerId: 7 });
    head.fire("pointermove", { clientX: 100, clientY: 100, pointerId: 7 });
    check("released, it stays put", root.style.left === "452px" && head.captured === undefined);
    head.fire("pointerdown", { target: done, button: 0, clientX: 0, clientY: 0, pointerId: 8 });
    check("a press on Done is Done's, not a drag", head.captured === undefined);
    // The visual shrinks: a dragged panel is pulled back inside on the next update.
    host.clientWidth = 500;
    panel.setModel(graphWith(new Map()).facts, new Map());
    check("a resize pulls a dragged panel back inside", root.style.left === "152px", root.style.left);
}

// ------------------------------------- 6. Just terminal nodes
// Node labels > Content > Just terminal nodes blanks the NAME of every node that
// something flows through, so only the ends are named. A terminal node has no
// flow in or none out, wherever its stage is.
{
    const fs = require("fs");
    const path = require("path");
    // Wind -> Grid -> Homes / Loss, plus a pure source entering at Grid's
    // stage (Import) and an isolated self-loop (Pump).
    const rows = [
        { source: "Wind", target: "Grid", value: 10 },
        { source: "Import", target: "Grid", value: 3 },
        { source: "Grid", target: "Homes", value: 6 },
        { source: "Grid", target: "Loss", value: 4 },
        { source: "Pump", target: "Pump", value: 2 }
    ];
    const { flows } = parseDataView(dvOf(rows));
    const { corridors } = inferCorridors(flows);
    const build = edits => {
        const graph = buildGraph(flows).graph;
        const facts = ne.applyNodeEdits(graph, edits);
        ne.hideInteriorLabels(graph, corridors, edits);
        return { graph, facts };
    };
    const label = (g, id) => g.nodes.get(id).label;

    const off = graphWith(new Map()).graph;
    check("(control) off, every node keeps its name",
        ["Wind", "Grid", "Homes", "Loss"].every(id => off.nodes.get(id).label === id));

    const { graph, facts } = build(new Map());
    check("only the node with flow both in and out loses its name",
        label(graph, "Grid") === "");
    check("...the ends keep theirs: pure sources and pure sinks",
        label(graph, "Wind") === "Wind" && label(graph, "Import") === "Import"
        && label(graph, "Homes") === "Homes" && label(graph, "Loss") === "Loss");
    check("...a self-loop is neither in nor out, so its node is an end",
        label(graph, "Pump") === "Pump");
    check("...and takes a middle node's TOTAL with its name; the ends keep theirs",
        graph.nodes.get("Grid").hideTotal === true
        && ["Wind", "Import", "Homes", "Loss", "Pump"].every(id => graph.nodes.get(id).hideTotal !== true));
    check("...unless the editor said Show name, which keeps the total too",
        build(new Map([["Grid", { hideName: false }]])).graph.nodes.get("Grid").hideTotal !== true);
    check("the editor's facts still say what the data named it",
        facts.find(f => f.id === "Grid").label === "Grid");

    // The editor has the last word, in both directions.
    check("an explicit Show name keeps a middle node's name",
        label(build(new Map([["Grid", { hideName: false }]])).graph, "Grid") === "Grid");
    check("...but a label edit alone does not say 'show this one'",
        label(build(new Map([["Grid", { label: "Hub" }]])).graph, "Grid") === "");
    check("an end the editor hid stays hidden",
        label(build(new Map([["Wind", { hideName: true }]])).graph, "Wind") === "");

    // Wiring.
    const visual = fs.readFileSync(path.join(__dirname, "..", "src", "visual.ts"), "latin1");
    const settings = require("./sources.js").settingsSource();
    const caps = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "capabilities.json"), "utf8"));
    check("it is off by default, in a Content group of the Node labels card",
        /terminalLabelsOnly = new formattingSettings\.ToggleSwitch\(\{\s*name: "terminalLabelsOnly",\s*displayName: "Just terminal nodes",[\s\S]*?value: false/
            .test(settings)
        && /group\("labelsContent", "Content",\s*\[this\.terminalLabelsOnly\b/.test(settings)
        && caps.objects.labels.properties.terminalLabelsOnly !== undefined);
    check("it is a data-stage input: tracked, and one of the things that force the stages",
        /labelScopeChanged = labelScopeRaw !== this\.cachedLabelScope/.test(visual)
        && /dataChanged =[\s\S]{0,600}?\|\|\s*labelScopeChanged;/.test(visual));
    check("applied after the edits, in the graph the layout is built from, and in the trial layouts",
        (visual.match(/applyLabelScope\(graph, corridors,/g) || []).length === 2);

    // earlier: the card's own switch, over the same mechanism.
    const scoped = (edits, scope) => {
        const g = buildGraph(flows).graph;
        ne.applyNodeEdits(g, edits);
        ne.applyLabelScope(g, corridors, edits, scope);
        return g;
    };
    const ALL = ["Wind", "Import", "Grid", "Homes", "Loss", "Pump"];
    check("(control) switch on, terminal-only off: nothing is blanked",
        ALL.every(id => label(scoped(new Map(), { shown: true, terminalOnly: false }), id) === id));
    check("the switch OFF blanks every name, ends included",
        ALL.every(id => label(scoped(new Map(), { shown: false, terminalOnly: true }), id) === ""));
    check("...and Show name in the editor still brings one back",
        label(scoped(new Map([["Wind", { hideName: false }]]), { shown: false, terminalOnly: false }), "Wind") === "Wind");
    check("switch on + terminal-only is exactly hideInteriorLabels",
        label(scoped(new Map(), { shown: true, terminalOnly: true }), "Grid") === ""
        && label(scoped(new Map(), { shown: true, terminalOnly: true }), "Wind") === "Wind");
    check("the card's switch is in its header, off the Totals group that was folded into Content",
        /topLevelSlice = this\.showLabels;/.test(settings)
        && !/group\("labelsTotals"/.test(settings)
        && /group\("labelsContent", "Content",\s*\[this\.terminalLabelsOnly, this\.showNodeTotals, this\.totalBasis,\s*this\.totalFontSize, this\.totalBold\]\)/
            .test(settings)
        && /showLabels = new formattingSettings\.ToggleSwitch\(\{[\s\S]*?value: true/.test(settings)
        && caps.objects.labels.properties.showLabels !== undefined);
    check("the totals go off with the switch",
        /nodeTotals: \(settings\.labelsCard\.showLabels\?\.value \?\? true\)\s*&& settings\.labelsCard\.showNodeTotals\.value/
            .test(require("./sources.js").renderSource()));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
