"use strict";
// What the format pane says about itself.
//
// Nothing here changes a drawing. It guards the things an author has to be able
// to work out from the pane alone, each of which was a real complaint:
//
//   1. The two Auto-fit buttons are toggles the visual flips straight back off,
//      so a press left NOTHING on screen to say it happened -- and Auto-fit
//      nodes overwrites hand placement. Both now have a status line.
//   2. The decimal-places box is hidden while Automatic decimals is on, so the
//      pane never shows a number that is being ignored.
//   3. The two minimum sliders say which pitch they are a percentage OF. They
//      are the same number meaning different pixels per axis, which is
//      deliberate and indistinguishable from a bug until the control says so.
//   4. Flow separation and Crossing separation each say what the other is for,
//      in the FIRST few words.
//   5. Curvature admits it clears hand-set corner radii.
//   6. A legend title is drawn, and is measured so the first swatch clears it.
//
// 1, 2, 5 and 6's wiring are asserted against the source: the pane model is
// built by the formatting service from a live dataView, which there is no fake
// small enough to drive. 6's DRAWING is asserted properly, through render.

const fs = require("fs");
const path = require("path");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

class FakeElement {
    constructor(tag) { this.tag = tag; this.attributes = {}; this.childNodes = []; this.style = {}; }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
    removeAttribute(n) { delete this.attributes[n]; }
    appendChild(c) { this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); return c; }
    get firstChild() { return this.childNodes[0]; }
    addEventListener() { /* nothing dispatches here */ }
    get textContent() { return this._text; }
    set textContent(v) { this._text = v; }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeDiagram } = require("./routing-api.js");
const render = require("./render-api.js");

const ROOT = path.join(__dirname, "..");
const settingsSrc = require("./sources.js").settingsSource();
const visualSrc = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");
const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));

// ------------------------------------------------- 1. no Auto-fit statuses
console.log("\n-- 1. the Auto-fit buttons carry no status line --");
{
    // the code once gave both Auto-fit buttons a ReadOnlyText saying what the last
    // run did. it was did not want them, so the assertion is now the
    // inverse: nothing may bring them back, and the sweep for what a removal
    // leaves behind has to stay done.
    check("neither status slice exists",
        !/autoFitNodesStatus/.test(settingsSrc) && !/autoFitRoutesStatus/.test(settingsSrc));
    check("...nor is either declared in capabilities",
        cap.objects.positions.properties.autoFitNodesStatus === undefined
        && cap.objects.positions.properties.autoFitRoutesStatus === undefined);
    check("...nor does visual.ts still write one",
        !/fitNodesStatus|fitRoutesStatus|NOT_RUN|FIT_FAILED/.test(visualSrc));
    check("the Positions card has no read-only text at all",
        !/ReadOnlyText/.test(settingsSrc.slice(
            settingsSrc.indexOf("class PositionsCardSettings"),
            settingsSrc.indexOf("class", settingsSrc.indexOf("class PositionsCardSettings") + 10))));
    // earlier: Auto-fit nodes was removed and Auto-fit routes renamed.
    check("Auto-fit nodes is gone from the pane, the settings and the capabilities",
        !/autoFitNodes/.test(settingsSrc) && cap.objects.positions.properties.autoFitNodes === undefined);
    check("...and visual.ts no longer reads or writes it",
        !/autoFitNodes|fitNodes\b/.test(visualSrc));
    check("the route fit is the toggle `arrangeFlows`, shown as 'Arrange flows'",
        /arrangeFlows = new formattingSettings\.ToggleSwitch\(\{\s*name: "arrangeFlows",\s*displayName: "Arrange flows"/
            .test(settingsSrc));
    check("Arrange nodes is still there",
        /arrangeNodes = new formattingSettings\.ToggleSwitch/.test(settingsSrc));
    check("Curvature defaults to 50",
        /name: "curvature",[\s\S]{0,700}?value: 50,/.test(settingsSrc));
    check("...and the radius stamp is simply the slider's value",
        !/LEGACY_CURVATURE|curvatureStamp|curvatureIsStored/.test(visualSrc));
    check("the routing style defaults to Polyline (Octilinear was tried and put back)",
        /value: ROUTING_STYLE_OPTIONS\[0\] \/\/ Polyline/.test(settingsSrc));
    check("the Flows card's groups read Route, Width, Gaps, Colour, Per Flow Type",
        (() => {
            const order = ["flowsRoute", "flowsWidth", "flowsGaps", "flowsColour", "flowsPerType"]
                .map(name => settingsSrc.indexOf(`group("${name}"`));
            return order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]));
        })());
}

// ------------------------------------------- 2. the ignored decimal box
console.log("\n-- 2. nothing shown that is being ignored --");
check("the decimal-places box is hidden while Automatic decimals is on",
    /decimalPlaces\.visible =\s*\n?\s*!this\.formattingSettings\.valuesCard\.autoDecimals\.value/
        .test(visualSrc));

// --------------------------------------------- 3. the sliders name their basis
console.log("\n-- 3. the minimum sliders say which pitch they measure --");
// **The basis moved from the display name into the description**.
// These were the only slices in the pane carrying their units in the name, and
// the name was a mouthful for a control whose real difficulty is something
// else: that a node is sized by its flows at all. So the name is short, the
// description opens with what the slider is FOR, and the pitch is still named
// -- in capitals, because two sliders being the same number against different
// pitches is the thing that reads as a bug until the control says so. That is
// the property this section has always been about, asserted where it now lives.
// Regex LITERALS, not `new RegExp` off a template: inside a template literal
// `\s` is just "s", so the character class silently stopped matching newlines
// and both descriptions read as absent.
const widthDesc = /name: "minWidth",[\s\S]{0,160}?description: "([^"]*)"/.exec(settingsSrc);
const heightDesc = /name: "minHeight",[\s\S]{0,160}?description: "([^"]*)"/.exec(settingsSrc);
check("Minimum width is named plainly", /displayName: "Minimum width"/.test(settingsSrc));
check("...and its description names the spacing between COLUMNS",
    widthDesc !== null && /between columns/.test(widthDesc[1]),
    widthDesc ? widthDesc[1].slice(0, 70) : "no description");
check("Minimum height is named plainly", /displayName: "Minimum height"/.test(settingsSrc));
check("...and its description names the spacing between ROWS -- a different axis, deliberately",
    heightDesc !== null && /between rows/.test(heightDesc[1]),
    heightDesc ? heightDesc[1].slice(0, 70) : "no description");
check("...and both say the flows size the node, which is what made them puzzling",
    widthDesc !== null && heightDesc !== null
    && /Flows size nodes otherwise/.test(widthDesc[1])
    && /Flows size nodes otherwise/.test(heightDesc[1]));

// ------------------------------------------ 4. the two separations
console.log("\n-- 4. the two separations distinguish themselves --");
const flowDesc = /name: "flowSeparation",[\s\S]{0,200}?description: "([^"]*)"/.exec(settingsSrc);
const crossDesc = /name: "crossingSeparation",[\s\S]{0,200}?description: "([^"]*)"/.exec(settingsSrc);
// Renamed and gathered into a **Gaps** group, which is what the
// two long descriptions were compensating for. They still name each other,
// because "which of these two do I want" is the first question either raises
// and a group heading does not answer it.
check("both still carry a name of their own",
    /displayName: "Between flows"/.test(settingsSrc)
    && /displayName: "Where flows cross"/.test(settingsSrc));
check("Between flows says side-by-side in its first ten words",
    flowDesc !== null && /side-by-side/.test(flowDesc[1].split(/\s+/).slice(0, 10).join(" ")),
    flowDesc ? flowDesc[1].slice(0, 70) : "no description");
check("...and Where flows cross says where one flow crosses over another",
    crossDesc !== null && /crosses over another/.test(crossDesc[1]),
    crossDesc ? crossDesc[1].slice(0, 70) : "no description");

// ------------------------------------------------- 5. Curvature's side effect
console.log("\n-- 5. Curvature admits what it clears --");
const curveDesc = /name: "curvature",[\s\S]{0,200}?description: "([^"]*)"/.exec(settingsSrc);
check("the description says a change clears hand-set corner radii",
    curveDesc !== null && /Resets any hand-set corners/.test(curveDesc[1]),
    curveDesc ? curveDesc[1].slice(-80) : "no description");
// And the rule it is describing is real, or the description would be a lie.
check("...and `withoutStaleRadii` is what actually does it",
    /withoutStaleRadii/.test(visualSrc)
    && /withoutStaleRadii/.test(fs.readFileSync(path.join(ROOT, "src", "positions.ts"), "utf8")));

// --------------------------------------------------- 6. the legend title
console.log("\n-- 6. the legend title is drawn, and measured --");
{
    check("declared in capabilities", cap.objects.legend.properties.titleText !== undefined);

    const flows = [
        { rowIndex: 0, flowID: "f", source: "A", target: "B", value: 1, flowType: "Bio" },
        { rowIndex: 1, flowID: "g", source: "A", target: "B", value: 1, flowType: "Fossil" }
    ];
    const { corridors } = inferCorridors(flows);
    const { graph } = buildGraph(flows, undefined, undefined, corridors);
    const colours = {
        colours: new Map([["Bio", "#111111"], ["Fossil", "#222222"]]),
        order: ["Bio", "Fossil"], warnings: []
    };
    const palette = {
        getColor: () => ({ value: "#888888" }), background: { value: "#ffffff" },
        foreground: { value: "#000000" }, foregroundNeutralSecondary: { value: "#605E5C" },
        isHighContrast: false
    };
    const draw = (title, position, measure) => {
        const svg = new FakeElement("svg");
        svg.querySelector = () => null;
        const chrome = {
            legendVisible: true, legendPosition: position, nodeShape: "Rectangle",
            nodeMinWidthPercent: 3, nodeMinHeightPercent: 3,
            labels: { nodeTotals: false, basis: "Larger", units: "", decimalPlaces: 0 }
        };
        const layout = computeLayout(graph, corridors, 900, 500, chrome);
        const routed = routeDiagram(layout, {
            style: "Polyline", curvaturePercent: 35, portLeadInPercent: 18, avoidNodes: true
        });
        const settings = {
            labelsCard: { showNodeTotals: { value: false }, totalBasis: { value: { value: "Larger" } },
                units: { value: "" }, decimalPlaces: { value: 0 } },
            legendCard: { show: { value: true }, position: { value: { value: position } },
                titleText: { value: title } },
            corridorsCard: { crossingSeparation: { value: 0 } },
            interactionCard: { tooltips: { value: false }, tooltipNodeTotals: { value: false },
                tooltipNodeByFlowType: { value: false }, tooltipNodeByConnection: { value: false } },
            nodeShapesCard: { shape: { value: { value: "Rectangle" } }, fill: { value: { value: "Node" } },
                fillColour: { value: { value: "#ffffff" } }, border: { value: { value: "None" } },
                borderColour: { value: { value: "#000000" } }, borderWidth: { value: 1 } },
            positionsCard: { showGrid: { value: false }, snap: { value: 4 }, showHandles: { value: true } }
        };
        render.render(svg, layout, routed.bands, palette, settings, colours, 900, 500,
            undefined, routed.handles, corridors, undefined, new Map(), undefined,
            [], new Map(), undefined, measure ? { measureText: measure } : undefined);
        let legend;
        const find = (el) => {
            if (el.attributes && el.attributes["class"] === "sankeybi-legend") { legend = el; }
            (el.childNodes || []).forEach(find);
        };
        find(svg);
        const texts = [];
        const walk = (el) => {
            if (el.tag === "text") { texts.push({ text: el.textContent, x: Number(el.attributes.x),
                y: Number(el.attributes.y), weight: el.attributes["font-weight"] }); }
            (el.childNodes || []).forEach(walk);
        };
        if (legend) { walk(legend); }
        return texts;
    };

    const none = draw("", "Bottom");
    const titled = draw("Flow type", "Bottom");
    check("a blank title draws no extra text, so an existing report is unchanged",
        none.length === 2 && titled.length === 3,
        `${none.length} without, ${titled.length} with`);
    check("the title is drawn first and in bold",
        titled[0].text === "Flow type" && titled[0].weight === "bold",
        `${titled[0].text} / ${titled[0].weight}`);
    check("the entries move right to make room for it",
        titled[1].x > none[0].x, `${none[0].x} -> ${titled[1].x}`);
    const wide = draw("Flow type", "Bottom", (t) => t.length * 20);
    const narrow = draw("Flow type", "Bottom", (t) => t.length * 4);
    check("...by an amount that is MEASURED, not assumed",
        wide[1].x > narrow[1].x + 50, `${narrow[1].x} -> ${wide[1].x}`);
    const side = draw("Flow type", "Right");
    // The title starts at the band's own x; an entry's TEXT is indented past
    // its swatch, so the two x values are deliberately not equal.
    check("on a Left/Right legend the title takes a row instead of width",
        side[0].text === "Flow type" && side[1].y > side[0].y && side[0].x <= side[1].x,
        `title (${side[0].x}, ${side[0].y}) then entry (${side[1].x}, ${side[1].y})`);
}

// ------------------------------------------------------ 7. the cards
console.log("\n-- 7. the pane's cards --");
{
    check("no card is declared for the objects that no longer have one",
        !/name: string = "layout";/.test(settingsSrc)
        && !/name: string = "nodeArrows";/.test(settingsSrc));
    check("...and the cards are the nine, in task order",
        (settingsSrc.match(/^    name: string = "/gm) || []).length === 9,
        String((settingsSrc.match(/^    name: string = "/gm) || []).length));
    check("capabilities.json declares neither retired object",
        cap.objects.layout === undefined && cap.objects.nodeArrows === undefined);
}

// ------------------------------- 9. the pane survives being asked for early
console.log("\n-- 9. the pane can be asked for before the first update --");
{
    // A host re-instantiates a visual when the report theme changes (switching
    // Windows into high contrast is one) and queries the format pane before any
    // data arrives. The library's `buildFormattingModel` reads
    // `formattingSettingsModel.cards` with no guard, and `getFormattingModel`
    // is not inside update()'s try/catch, so a missing model would make the host
    // drop the whole Visual section of the pane until a full reload.
    //
    // Asserted against the source because the pane model cannot be built in
    // this harness: `checks/lib/settings.js` is unloadable, the formatting-model
    // package being ESM. That is also why sections 1-6 above read `settingsSrc`
    // rather than instantiating anything.
    const model = /public getFormattingModel\(\)[\s\S]*?\n    \}/.exec(visualSrc);
    check("getFormattingModel exists to be checked", model !== null);
    check("the settings model exists from construction, populated with defaults",
        /private formattingSettings: VisualFormattingSettingsModel =\s*this\.formattingSettingsService\.populateFormattingSettingsModel\(VisualFormattingSettingsModel, NO_DATA_VIEW\)/
            .test(visualSrc));
    check("...and getFormattingModel still returns a built model",
        model !== null
        && /return this\.formattingSettingsService\.buildFormattingModel\(this\.formattingSettings\);/
            .test(model[0]));
    // The library really does read `.cards` with no guard, which is why the
    // model must exist before the first update.
    const lib = fs.readFileSync(path.join(ROOT, "node_modules",
        "powerbi-visuals-utils-formattingmodel", "lib", "FormattingSettingsService.js"), "utf8");
    check("...because the library dereferences `.cards` unguarded",
        /buildFormattingModel\(formattingSettingsModel\) \{[\s\S]{0,200}?formattingSettingsModel\.cards\s*\n?\s*\.filter/
            .test(lib));
}

console.log(`\n${assertions} assertions, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
