"use strict";
// Node icons.
//
// 1. Reading a cell: SVG text, a base64 SVG data URL and a percent-encoded
//    one all come back as the same vetted base64 URL; non-SVG, oversized and
//    broken cells are refused; `isVettedIcon` passes only what was produced.
// 2. Data: the Source/Target icon roles reach the node, first non-blank wins,
//    a clash warns, a bad cell warns and is skipped.
// 3. Placement (labelLinesOf): above the text inside a shape and on North /
//    South, beside it (nearest the node) on East / West; icon-only centred.
// 4. The fit: an icon that doesn't fit takes the label OUTSIDE where the same
//    shape holds the text alone (control), and the fit's reach includes it.
// 5. Render: the image lands on its box; a recoloured icon floods its alpha.

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

class FakeElement {
    constructor(tag) { this.tag = tag; this.attributes = {}; this.childNodes = []; this._text = ""; this.style = {}; this.handlers = new Map(); }
    addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(fn); }
    setPointerCapture() { } releasePointerCapture() { } hasPointerCapture() { return false; }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return this.attributes[n]; }
    appendChild(c) { this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); return c; }
    insertBefore(c, before) { const i = this.childNodes.indexOf(before); this.childNodes.splice(i < 0 ? 0 : i, 0, c); return c; }
    get firstChild() { return this.childNodes[0] ?? null; }
    set textContent(v) { this._text = v; } get textContent() { return this._text; }
    all() { return this.childNodes.reduce((acc, c) => acc.concat(c.all()), [this]); }
    find(tag) { return this.all().filter(e => e.tag === tag); }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const bg = require("./lib/background.js");
const { parseDataView } = require("./parse.js");
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");
const { resolveFlowTypeColours } = require("./lib/colours.js");
const { computeLayout, labelLinesOf, textBoxOf } = require("./layout-api.js");
const { routeDiagram } = require("./routing-api.js");
const { render } = require("./render-api.js");

// the agreed wind turbine, as he sent it (viewBox 100 x 125, so not square).
const TURBINE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 125" xml:space="preserve"><path d="M21.5 48.7h.3l24-3.4q1.2-.15 2.1-1.2c.3-.3.5-.7.5-.5L45.8 90h-3.1c-.6 0-1 .4-1 1s.4 1 1 1h16.5c.6 0 1-.4 1-1s-.4-1-1-1h-3.1l-2.5-45.6c.2.4.5.7.9 1l19.9 13.8c.4.3.9.4 1.3.4.7 0 1.4-.3 1.9-.9.7-1 .6-2.4-.4-3.2L58.6 39.9c-.6-.5-1.4-.8-2.3-.8-.3 0-.6.1-.8.1-.1-.8-.4-1.5-.9-2.2.1 0 .2-.1.2-.1.7-.5 1.2-1.2 1.3-2l5.3-23.7c.3-1.2-.5-2.4-1.7-2.7s-2.4.3-2.8 1.5l-7.4 23c-.2.8-.2 1.6.2 2.4 0 .1.1.2.1.2-.5.2-1 .5-1.4.9-.7.6-1.1 1.4-1.3 2.3-.1 0-.1-.1-.2-.1-.7-.4-1.6-.5-2.4-.3L21 44.1c-1.2.3-2 1.5-1.7 2.7.2 1.1 1.1 1.9 2.2 1.9"/></svg>';
const HOUSE = '<svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8v10H3z"/></svg>';
const decode = url => new TextDecoder().decode(Uint8Array.from(atob(url.split(",")[1]), c => c.charCodeAt(0)));

// -------------------------------------------------------------- 1. a cell
const plain = bg.iconFromText(TURBINE);
check("SVG text reads, sized from its viewBox", plain.image && plain.image.width === 100 && plain.image.height === 125);
const b64 = bg.iconFromText("data:image/svg+xml;base64," + Buffer.from(TURBINE, "utf8").toString("base64"));
const pct = bg.iconFromText("data:image/svg+xml;charset=utf-8," + encodeURIComponent(TURBINE));
const utf = bg.iconFromText("data:image/svg+xml;utf8," + TURBINE);
check("a base64 data URL reads to the same icon", b64.image && b64.image.url === plain.image.url);
check("a percent-encoded data URL reads to the same icon", pct.image && pct.image.url === plain.image.url);
check("an unencoded ;utf8 data URL reads to the same icon", utf.image && utf.image.url === plain.image.url);
check("surrounding whitespace (a padded cell) is ignored", bg.iconFromText(`  ${TURBINE}\n`).image?.url === plain.image.url);
check("a PNG data URL is refused: icons are SVG", "error" in bg.iconFromText("data:image/png;base64,iVBORw0KGgo="));
check("a broken data URL is refused", "error" in bg.iconFromText("data:image/svg+xml;base64,%%%"));
check("text that isn't SVG is refused", "error" in bg.iconFromText("wind"));
const big = '<svg viewBox="0 0 1 1"><!--' + "x".repeat(bg.MAX_ICON_BYTES) + "--></svg>";
check("an icon over 20 KB is refused", "error" in bg.iconFromText(big));
check("the round trip keeps the SVG exactly", decode(plain.image.url) === TURBINE);
check("isVettedIcon passes what iconFromText made", bg.isVettedIcon(plain.image.url));
check("...and nothing else", [undefined, 3, "javascript:alert(1)", "data:image/png;base64,AAAA",
    "data:image/svg+xml,<svg onload=x>", "data:image/svg+xml;base64," + "A".repeat(40000)].every(u => !bg.isVettedIcon(u)));

// --------------------------------------------------------------- 2. data
const ROLES = ["flowID", "source", "target", "value", "sourceLabel", "targetLabel", "sourceIcon", "targetIcon"];
const dataViewOf = rows => ({ table: {
    columns: ROLES.map(r => ({ roles: { [r]: true } })),
    rows: rows.map(r => ROLES.map(role => (role in r ? r[role] : null)))
} });
{
    const { flows, warnings } = parseDataView(dataViewOf([
        { source: "Wind", target: "Grid", value: 10, sourceIcon: TURBINE },
        { source: "Wind", target: "Grid", value: 5, sourceIcon: "not an icon" },
        { source: "Grid", target: "Homes", value: 12, sourceIcon: "", targetIcon: HOUSE },
        { source: "Grid", target: "Loss", value: 3, sourceIcon: HOUSE }
    ]));
    check("a bad icon cell warns once and the row survives", flows.length === 4
        && warnings.filter(w => /SourceIcon skipped/.test(w)).length === 1, warnings.join(" | "));
    const { graph, warnings: gw } = buildGraph(flows);
    check("the icon reaches its node", graph.nodes.get("Wind").icon === plain.image.url);
    check("from either role", graph.nodes.get("Homes").icon === bg.iconFromText(HOUSE).image.url);
    check("no icon means none", graph.nodes.get("Loss").icon === undefined && graph.nodes.get("Grid").icon === bg.iconFromText(HOUSE).image.url);
    check("a blank cell is no icon, not a clash", !gw.some(w => /Grid.*Icon/.test(w)));
    const clash = buildGraph(parseDataView(dataViewOf([
        { source: "A", target: "B", value: 1, sourceIcon: TURBINE },
        { source: "A", target: "C", value: 1, sourceIcon: HOUSE }
    ])).flows);
    check("a clash keeps the first and warns", clash.graph.nodes.get("A").icon === plain.image.url
        && clash.warnings.some(w => /"A".*Icon/.test(w)));
}

// ----------------------------------------------------------- 3. placement
const ICON = plain.image.url;
const LABELS = { nodeTotals: true, basis: "Larger",
    units: "", decimalPlaces: 0, iconSize: 20 };
function node(over) {
    return Object.assign({ id: "N", label: "Wind", x: 100, y: 100, width: 20, height: 60, shapeWidth: 40, shapeHeight: 80,
        labelPort: "East", labelInside: false, inflow: 0, outflow: 50, column: 1, row: 1,
        columnIsOverride: false, rowIsOverride: false, isSelfLoop: false, icon: ICON }, over);
}
function blockOf(lines) {
    const boxes = lines.map(textBoxOf);
    return { left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)),
        top: Math.min(...boxes.map(b => b.top)), bottom: Math.max(...boxes.map(b => b.bottom)) };
}
let placements = 0;
{
    const without = labelLinesOf(node({ icon: undefined, labelInside: true }), LABELS, true);
    const withIt = labelLinesOf(node({ labelInside: true }), LABELS, true);
    const t = blockOf(withIt.lines), i = withIt.icon;
    placements++;
    check("inside: the icon sits above the text, centred on the node",
        i && i.y + i.size <= t.top + 1e-9 && Math.abs(i.x + i.size / 2 - 110) < 1e-9, `icon bottom ${i && i.y + i.size}, text top ${t.top}`);
    const mid = (i.y + t.bottom) / 2;
    const alone = blockOf(without.lines);
    check("inside: the pair is centred where the text alone was", Math.abs(mid - (alone.top + alone.bottom) / 2) < 1e-9,
        `pair ${mid.toFixed(3)}, text alone ${((alone.top + alone.bottom) / 2).toFixed(3)}`);

    const east = labelLinesOf(node({ labelPort: "East" }), LABELS, true);
    const eastPlain = labelLinesOf(node({ labelPort: "East", icon: undefined }), LABELS, true);
    placements++;
    check("East: the icon takes the text's place, nearest the node, and the text moves out",
        Math.abs(east.icon.x - eastPlain.lines[0].x) < 1e-9 && Math.abs(east.lines[0].x - (eastPlain.lines[0].x + 20 + 3)) < 1e-9);
    const eb = blockOf(east.lines);
    check("East: the icon is centred on the text block", Math.abs(east.icon.y + 10 - (eb.top + eb.bottom) / 2) < 1e-9);

    const west = labelLinesOf(node({ labelPort: "West" }), LABELS, true);
    const westPlain = labelLinesOf(node({ labelPort: "West", icon: undefined }), LABELS, true);
    placements++;
    check("West: the icon ends where the text did, and the text moves out",
        Math.abs(west.icon.x + 20 - westPlain.lines[0].x) < 1e-9 && Math.abs(west.lines[0].x - (westPlain.lines[0].x - 23)) < 1e-9);

    const north = labelLinesOf(node({ labelPort: "North" }), LABELS, true);
    const nb = blockOf(north.lines);
    placements++;
    check("North: the icon is above the text, and the text stays against the node",
        north.icon.y + north.icon.size <= nb.top + 1e-9
        && JSON.stringify(north.lines) === JSON.stringify(labelLinesOf(node({ labelPort: "North", icon: undefined }), LABELS, true).lines));

    const south = labelLinesOf(node({ labelPort: "South" }), LABELS, true);
    const southPlain = blockOf(labelLinesOf(node({ labelPort: "South", icon: undefined }), LABELS, true).lines);
    const sb = blockOf(south.lines);
    placements++;
    check("South: the icon takes the text's place under the node, and the text moves down",
        Math.abs(south.icon.y - southPlain.top) < 1e-9 && Math.abs(sb.top - (southPlain.top + 23)) < 1e-9);

    const only = labelLinesOf(node({ label: "", labelInside: true }), Object.assign({}, LABELS, { nodeTotals: false }), true);
    placements++;
    check("icon only (name suppressed, no total): the icon alone, centred on the node",
        only.lines.length === 0 && only.icon && Math.abs(only.icon.x + 10 - 110) < 1e-9 && Math.abs(only.icon.y + 10 - 130) < 1e-9);
    const nothing = labelLinesOf(node({ label: "", icon: undefined }), Object.assign({}, LABELS, { nodeTotals: false }), true);
    check("no name, no total, no icon: nothing", nothing.lines.length === 0 && !nothing.icon);
}
check("every placement assertion ran", placements === 6, `${placements}`);

// ---------------------------------------------------------------- 4. fit
function layoutOf(rows, over = {}) {
    const { flows } = parseDataView(dataViewOf(rows));
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows);
    const chrome = Object.assign({ legendVisible: false, legendPosition: "Bottom",
        nodeShape: "Rectangle", labels: Object.assign({}, LABELS, { nodeTotals: false, iconSize: 24 }) }, over);
    return { layout: computeLayout(graph, corridors, 1200, 700, chrome), graph, corridors, flows };
}
{
    const rows = icon => [{ source: "S", target: "T", value: 10, sourceIcon: icon, targetIcon: icon },
        { source: "T", target: "U", value: 10, targetIcon: icon }];
    let split = 0, bothIn = 0, tried = 0;
    [5, 10, 15, 20, 30, 40].forEach(w => [5, 10, 20, 40].forEach(h => {
        const over = { nodeMinWidthPercent: w, nodeMinHeightPercent: h };
        const a = layoutOf(rows(undefined), over).layout.nodes.get("T");
        const b = layoutOf(rows(HOUSE), over).layout.nodes.get("T");
        tried++;
        if (a.labelInside && !b.labelInside) split++;
        if (a.labelInside && b.labelInside) bothIn++;
    }));
    check("some shapes hold the name but not name + icon: the icon takes the label outside", split > 0, `${split} of ${tried}`);
    check("...and bigger shapes hold both", bothIn > 0, `${bothIn} of ${tried}`);

    // The fit counts the icon: an outside East label on the last column.
    const a = layoutOf(rows(undefined), { nodeMinWidthPercent: 3 }).layout;
    const b = layoutOf(rows(HOUSE), { nodeMinWidthPercent: 3 }).layout;
    const ua = a.nodes.get("U"), ub = b.nodes.get("U");
    check("(the last node's label is outside, East)", !ub.labelInside && ub.labelPort === "East");
    check("the fit's reach includes the icon", ub.drawnReach.right >= ua.drawnReach.right + 24 + 3 - 1e-9,
        `${ua.drawnReach.right.toFixed(1)} -> ${ub.drawnReach.right.toFixed(1)}`);
}

// -------------------------------------------------------------- 5. render
{
    const colour = v => ({ value: v });
    const palette = { isHighContrast: false, foreground: colour("#252423"), foregroundNeutralSecondary: colour("#605E5C"),
        background: colour("#ffffff"), getColor: key => colour(`#palette-${key}`) };
    const item = v => ({ value: { value: v } });
    const settingsOf = iconColour => ({
        nodeShapesCard: { shape: item("Rectangle"), fitLabel: { value: false }, fill: item("Node"), fillColour: { value: { value: "#FFFFFF" } },
            border: item("Node"), borderColour: { value: { value: "#605E5C" } }, borderWidth: { value: 2 } },
        corridorsCard: {},
        labelsCard: { showColumnHeaders: { value: false }, columnHeaderText: { value: "" }, showColumnTotals: { value: false },
            showNodeTotals: { value: false }, totalBasis: item("Larger"), units: { value: "" }, decimalPlaces: { value: 0 },
            iconSize: { value: 24 }, iconColour: item(iconColour) },
        positionsCard: { snap: { value: 4 }, showGrid: { value: false } },
        interactionCard: { tooltips: { value: true }, tooltipNodeTotals: { value: true }, tooltipNodeByFlowType: { value: false }, tooltipNodeByConnection: { value: false } },
        legendCard: { show: { value: false }, position: item("Bottom") }
    });
    const rows = [{ source: "S", target: "T", value: 10, sourceIcon: HOUSE }, { source: "T", target: "U", value: 10 }];
    const { layout, corridors } = layoutOf(rows, { nodeMinWidthPercent: 3 });
    const bands = routeDiagram(layout, { portLeadInPercent: 18, curvaturePercent: 35, style: "Polyline" }).bands;
    const drawn = mode => {
        const svg = new FakeElement("svg");
        render(svg, layout, bands, palette, settingsOf(mode), resolveFlowTypeColours(corridors, palette), 1200, 700);
        return svg;
    };
    const original = drawn("Original");
    const images = original.find("image");
    const expected = labelLinesOf(layout.nodes.get("S"), Object.assign({}, LABELS, { nodeTotals: false, iconSize: 24 }), true).icon;
    check("one icon drawn, for the one node that has one", images.length === 1);
    check("...on the box layout placed it in", images[0] && Number(images[0].attributes.x) === expected.x
        && Number(images[0].attributes.y) === expected.y && images[0].attributes.width === "24");
    check("...from the vetted URL, not a pointer target", images[0] && bg.isVettedIcon(images[0].attributes.href)
        && images[0].attributes["pointer-events"] === "none");
    check("Original: no filter", images[0] && images[0].attributes.filter === undefined && original.find("feFlood").length === 0);
    const inked = drawn("Ink");
    const flood = inked.find("feFlood")[0];
    const composite = inked.find("feComposite")[0];
    const image = inked.find("image")[0];
    const filter = inked.find("filter").find(f => f.find("feFlood").length > 0);
    check("Label colour: floods the icon's own shape", flood && composite && composite.attributes.in2 === "SourceAlpha"
        && composite.attributes.operator === "in" && image.attributes.filter === `url(#${filter.attributes.id})`);
    check("...in the theme foreground for an outside label", flood && flood.attributes["flood-color"] === "#252423");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
