"use strict";
// Keyboard reach, screen-reader labels, and high contrast.
//
// Before this there was no `tabindex`, no `role` and no `aria-*` anywhere in
// the visual, so a keyboard user could not reach a node or a flow at all and a
// screen reader had nothing to read. High contrast was handled in exactly two
// incidental places -- the snap grid and the default node colour -- while the
// bands went on painting palette colours, which is the one thing the mode
// forbids.
//
// What is asserted:
//
//   1. Every selectable is focusable, has a role, and carries a label built
//      from the SAME tooltip rows a sighted reader is shown -- so the two
//      cannot drift.
//   2. The label survives tooltips being switched OFF: turning tooltips off
//      must not turn accessibility off with them.
//   3. Enter and Space select exactly what a click selects, Escape clears, and
//      both go through ONE `select` so a keyboard user and a mouse user do the
//      same thing to the report.
//   4. A decoration and a route handle are NOT focusable: tabbing through a
//      diagram must not stop on every label and dot.
//   5. High contrast carries the flow type by HATCH rather than colour, the
//      legend uses the same hatch so it still matches, hatched bands are
//      outlined, and nodes become background-filled and foreground-outlined.
//   6. An ordinary render adds no pattern and no extra <defs> at all.

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
    constructor(tag) {
        this.tag = tag; this.attributes = {}; this.childNodes = []; this.style = {};
        this.listeners = {};
    }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null; }
    removeAttribute(n) { delete this.attributes[n]; }
    appendChild(c) { this.childNodes.push(c); return c; }
    // The real DOM has it, and renderBands uses it to put its <defs> first.
    // It was never reached here gave every outlined band a
    // clip, which is what first made that <defs> non-empty in high contrast --
    // the fake was simply incomplete, not the code wrong.
    insertBefore(c, before) {
        const at = this.childNodes.indexOf(before);
        if (at < 0) { this.childNodes.push(c); } else { this.childNodes.splice(at, 0, c); }
        return c;
    }
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); return c; }
    get firstChild() { return this.childNodes[0]; }
    querySelector() { return null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    fire(type, event) { (this.listeners[type] || []).forEach(fn => fn(event)); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = v; }
}
global.document = { createElementNS: (ns, tag) => new FakeElement(tag) };

const selectionModule = require("./lib/selection.js");
const { SelectionController, ariaLabelOf, bandKey, nodeKey } = selectionModule;
const { buildGraph } = require("./lib/graph.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeDiagram } = require("./routing-api.js");
const render = require("./render-api.js");

const ROOT = path.join(__dirname, "..");

// ------------------------------------------------------- 1-2. the aria label
console.log("\n-- 1-2. what a screen reader is told --");
{
    const rows = [
        { displayName: "Kärnbränsle → Kärnkraft", value: "" },
        { displayName: "Kärnkraft", value: "255.0 TWh" },
        // The shape toTooltipItems emits: the rule is in the
        // label column. Read aloud, either column being a rule must be silent.
        { displayName: "────────────", value: "" },
        { displayName: "Total", value: "255.0 TWh" }
    ];
    const label = ariaLabelOf(rows, bandKey("A->B"));
    check("the label is built from the tooltip's own rows",
        label.includes("Kärnkraft: 255.0 TWh") && label.includes("Total: 255.0 TWh"), label);
    check("a heading-only row reads as just its text",
        label.startsWith("Kärnbränsle → Kärnkraft,"), label.slice(0, 40));
    check("the drawn rule between blocks is not read aloud",
        !label.includes("─"), label);

    // Tooltips off: there are no rows, and the label must still say what it is.
    // The id is built with the ARROW character in corridors.ts, and this
    // fixture used "->" -- so it agreed with the bug instead of catching it.
    // The separator is taken from a REAL corridor id below, not written out.
    check("a flow with no rows still names itself from its corridor id",
        ariaLabelOf([], bandKey("Kärnbränsle\u2192Kärnkraft"))
        === "Flow Kärnbränsle to Kärnkraft",
        ariaLabelOf([], bandKey("Kärnbränsle\u2192Kärnkraft")));
    check("...and a node from its own id",
        ariaLabelOf([], nodeKey("Elnät")) === "Node Elnät",
        ariaLabelOf([], nodeKey("Elnät")));
    check("a malformed key degrades rather than throwing",
        ariaLabelOf([], "not json") === "Diagram element");

    // **The separator is read off a real corridor**, not written out here. The
    // first version of this section spelled it "->" (as the design notes's prose did),
    // which is not what corridors.ts builds -- so the assertion agreed with the
    // bug and passed. faults-testdata-verify caught it.
    const realId = inferCorridors([
        { rowIndex: 0, flowID: "f", source: "Kärnkraft", target: "Elnät", value: 1 }
    ]).corridors[0].id;
    check("...and a real corridor id is read back with its ends named",
        ariaLabelOf([], bandKey(realId)) === "Flow Kärnkraft to Elnät",
        `${realId} -> ${ariaLabelOf([], bandKey(realId))}`);
}

// ------------------------------------- 3. nothing claims keyboard support
console.log("\n-- 3. the keyboard model is gone, and must stay gone --");
{
    // **Keyboard navigation was tried four ways over earlier** -- every
    // flow in the tab order, the root as a tab stop, roving focus with arrow
    // keys, and finally the `supportsKeyboardFocus` capability the host needs
    // before it routes focus in at all -- and an author still could not reach a
    // flow from the keyboard in Power BI. the agreed call: remove it.
    //
    // This section is the inverse of what used to be here. A `tabindex` with
    // nothing behind it is worse than none: it claims a capability the visual
    // does not have, and it brings back the browser's own focus ring on every
    // click, which is the "black box" it was reported twice.
    const controller = new SelectionController({
        createSelectionManager: () => ({
            select: () => Promise.resolve([]), clear: () => Promise.resolve(),
            showContextMenu: () => Promise.resolve(), registerOnSelectCallback: () => undefined,
            hasSelection: () => false
        }),
        createSelectionIdBuilder: () => ({
            withTable: () => ({ createSelectionId: () => ({ key: "id" }) })
        }),
        tooltipService: { enabled: () => false, show: () => undefined, hide: () => undefined,
            move: () => undefined },
        eventService: {}, locale: "en-GB"
    });
    const root = new FakeElement("svg");
    controller.attachBackground(root);
    controller.beginFrame({ table: { rows: [] } }, [
        { id: "A\u2192B", source: "A", target: "B", value: 1, segments: [], sourcePort: "East",
            targetPort: "West", isSelfLoop: false, flows: [{ rowIndex: 0 }] }
    ], { tooltips: false });
    const band = new FakeElement("path");
    controller.registerBand(band, "A\u2192B", []);
    const node = new FakeElement("rect");
    controller.registerNode(node, "B", []);

    check("a flow is not focusable", band.getAttribute("tabindex") === null,
        String(band.getAttribute("tabindex")));
    check("a node is not focusable", node.getAttribute("tabindex") === null,
        String(node.getAttribute("tabindex")));
    check("nor is the diagram itself", root.getAttribute("tabindex") === null,
        String(root.getAttribute("tabindex")));

    // ...but what a screen reader reads is UNAFFECTED, because browse mode
    // reaches a labelled element without it being in any tab order. This is the
    // half that works, and the whole reason the removal is not a loss.
    check("a flow still describes itself to a screen reader",
        band.getAttribute("role") === "img"
        && (band.getAttribute("aria-label") || "").length > 0,
        `${band.getAttribute("role")} / ${band.getAttribute("aria-label")}`);
    check("a node too",
        node.getAttribute("role") === "img"
        && (node.getAttribute("aria-label") || "").length > 0,
        `${node.getAttribute("role")} / ${node.getAttribute("aria-label")}`);
    check("and the diagram summarises itself",
        root.getAttribute("aria-label") === "Sankey diagram, 1 flows between 2 nodes",
        root.getAttribute("aria-label"));
    // **The root must have NO role.** `role="img"` on a container makes
    // assistive technology treat the whole thing as one image and ignore its
    // descendants -- which would hide every label asserted above.
    check("...with no ROLE, or its labelled children become unreachable",
        root.getAttribute("role") === null, String(root.getAttribute("role")));

    // The stylesheet and the capabilities must not claim it either.
    const less = fs.readFileSync(path.join(ROOT, "style", "visual.less"), "utf8");
    // Comments stripped first: the stylesheet now explains WHY it has no focus
    // rule, and the words would otherwise read as code -- the same trap the
    // hardcoded-colour sweep in section 4 has. A comment cannot style
    // anything, so this weakens nothing.
    const lessCode = less.replace(/\/\/[^\n]*/g, "");
    check("the stylesheet has no focus rules left",
        !/:focus/.test(lessCode) && !/sankeybi-focus/.test(lessCode));
    const caps = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
    check("capabilities does not declare supportsKeyboardFocus",
        caps.supportsKeyboardFocus === undefined, String(caps.supportsKeyboardFocus));
    const ssrc = fs.readFileSync(path.join(ROOT, "src", "selection.ts"), "utf8");
    check("selection.ts listens for no keys at all",
        !/addEventListener\("keydown"/.test(ssrc));
    check("...and holds no focus machinery",
        !/onNavigate|restoreFocus|focusedKey|focusables/.test(ssrc));
    const vsrc = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");
    check("visual.ts no longer restores focus",
        !/restoreFocus/.test(vsrc));
    const rsrc = require("./sources.js").renderSource();
    check("render.ts publishes no focus colours",
        !/sankeybi-focus/.test(rsrc));
}

// ------------------------------------------------------ 5-6. high contrast
console.log("\n-- 5-6. high contrast carries the flow type by texture --");
{
    const flows = [
        { rowIndex: 0, flowID: "f", source: "A", target: "B", value: 100, flowType: "Bio" },
        { rowIndex: 1, flowID: "g", source: "A", target: "B", value: 100, flowType: "Fossil" },
        { rowIndex: 2, flowID: "h", source: "B", target: "C", value: 200, flowType: "Bio" }
    ];
    const { corridors } = inferCorridors(flows);
    const { graph } = buildGraph(flows, undefined, undefined, corridors);
    const colours = {
        colours: new Map([["Bio", "#2E7D32"], ["Fossil", "#6D4C41"]]),
        order: ["Bio", "Fossil"], warnings: []
    };
    const sink = {
        registerBand: () => undefined, registerNode: () => undefined,
        registerDecoration: () => undefined, registerHandle: () => undefined,
        nativeTitles: false
    };
    const draw = (highContrast, arrowsOn = { heads: true, tails: true },
        paint = colours) => {
        const svg = new FakeElement("svg");
        const palette = {
            getColor: () => ({ value: "#888888" }),
            background: { value: highContrast ? "#000000" : "#ffffff" },
            foreground: { value: highContrast ? "#ffffff" : "#000000" },
            foregroundNeutralSecondary: { value: "#605E5C" },
            isHighContrast: highContrast
        };
        const chrome = {
            legendVisible: true, legendPosition: "Bottom", nodeShape: "Rectangle",
            nodeMinWidthPercent: 10, nodeMinHeightPercent: 3,
            labels: { nodeTotals: false, basis: "Larger", units: "", decimalPlaces: 0 }
        };
        // **Arrows ON.** No scenario in this file turned them on, which is
        // exactly why high contrast went on painting the arrow heads and tails
        // in palette colours while the bands they continue were hatched
        //. A check that never draws a thing cannot defend it.
        const arrows = { ...arrowsOn, angleDegrees: 120, gapPercent: 8 };
        const layout = computeLayout(graph, corridors, 1000, 600, { ...chrome, arrows });
        const routed = routeDiagram(layout, {
            style: "Polyline", curvaturePercent: 35, portLeadInPercent: 18, avoidNodes: true,
            arrows
        });
        const settings = {
            labelsCard: { showNodeTotals: { value: false }, totalBasis: { value: { value: "Larger" } },
                units: { value: "" }, decimalPlaces: { value: 0 } },
            legendCard: { show: { value: true }, position: { value: { value: "Bottom" } },
                titleText: { value: "" } },
            corridorsCard: { crossingSeparation: { value: 0 } },
            flowLabelsCard: { show: { value: false }, content: { value: { value: "Value" } },
                colourMode: { value: { value: "Auto" } }, colour: { value: { value: "#fff" } },
                font: {} },
            interactionCard: { tooltips: { value: false }, tooltipNodeTotals: { value: false },
                tooltipNodeByFlowType: { value: false }, tooltipNodeByConnection: { value: false } },
            nodeShapesCard: { shape: { value: { value: "Rectangle" } },
                fill: { value: { value: "Node" } }, fillColour: { value: { value: "#123456" } },
                border: { value: { value: "None" } }, borderColour: { value: { value: "#654321" } },
                borderWidth: { value: 1 } },
            positionsCard: { showGrid: { value: false }, snap: { value: 4 },
                showHandles: { value: true }, showUnbalanced: { value: false },
                balanceTolerance: { value: 0.5 } }
        };
        // `infill` is the THIRTEENTH argument. It was given a `new Map()`
        // here, which has a `forEach` and so drew nothing without complaining
        // -- the other half of why the hatching defect survived.
        render.render(svg, layout, routed.bands, palette, settings, paint, 1000, 600,
            undefined, routed.handles, corridors, sink, routed.infill, undefined,
            [], new Map(), undefined, undefined);
        const all = [];
        const walk = (el) => { all.push(el); (el.childNodes || []).forEach(walk); };
        walk(svg);
        return all;
    };

    const plain = draw(false);
    const hc = draw(true);

    const patternsIn = (els) => els.filter(e => e.tag === "pattern");
    check("an ordinary render adds no pattern at all",
        patternsIn(plain).length === 0, `${patternsIn(plain).length} patterns`);
    check("high contrast defines a hatch per flow type, up to six",
        patternsIn(hc).length === 6, `${patternsIn(hc).length} patterns`);

    // **High contrast ignores the author's texture and outline** (
    // for the editor's, earlier for the pane's `Flows > Colour > Texture` and
    // `Outline`). It assigns its own hatch per type and outlines every band in
    // the foreground already, so an author's choice there can only fight the
    // mode over which texture means which type -- the one thing the legend has
    // to be able to say.
    //
    // A scenario of its own rather than a change to the shared one: the
    // assertions above and below are about a plain-coloured ordinary render,
    // and painting the shared colours would have quietly rewritten four of
    // them.
    const painted = {
        ...colours,
        patterns: new Map([["Bio", 3], ["Fossil", 5]]),
        outlines: new Map([["Bio", "dashed"], ["Fossil", "solid"]]),
        paneOutline: "dashed"
    };
    const ARROWS = { heads: true, tails: true };
    const hcPainted = draw(true, ARROWS, painted);
    const plainPainted = draw(false, ARROWS, painted);
    check("in high contrast the author's texture is ignored -- only the mode's set",
        patternsIn(hcPainted).length === 6
        && patternsIn(hcPainted).every(p => /^sankeybi-hatch-\d$/.test(p.getAttribute("id") || "")),
        `${patternsIn(hcPainted).length}: `
        + `${[...new Set(patternsIn(hcPainted).map(p => p.getAttribute("id")))].join(" ")}`);
    // The control for that: the SAME request IS honoured in ordinary mode, so
    // the assertion above cannot be passing because nothing was asked for. Two
    // sets of six, because the generator makes one set per COLOUR -- types
    // sharing a colour share the patterns.
    check("...while an ordinary render builds it, one set of every texture per colour",
        patternsIn(plainPainted).length === 28
        && patternsIn(plainPainted).every(p =>
            /^sankeybi-pattern-[01]-\d+$/.test(p.getAttribute("id") || "")),
        `${patternsIn(plainPainted).length} patterns`);
    // And the outline: in high contrast every band is edged in the FOREGROUND,
    // whatever the author asked for, and never dashed -- a dash would say
    // "projected" about a band that is merely hatched.
    const paintedEdges = (els) => els.filter(e =>
        e.tag === "path" && e.getAttribute("class") === "sankeybi-band-edge");
    check("in high contrast every band edge is the foreground, and solid",
        paintedEdges(hcPainted).length > 0
        && paintedEdges(hcPainted).every(p => p.getAttribute("stroke") === "#ffffff"
            && p.getAttribute("stroke-dasharray") === null),
        `${paintedEdges(hcPainted).length} edges, `
        + `${paintedEdges(hcPainted).filter(p => p.getAttribute("stroke-dasharray")).length} dashed`);
    check("...while an ordinary render draws the author's dash",
        paintedEdges(plainPainted).some(p => p.getAttribute("stroke-dasharray") === "4 3"),
        `${paintedEdges(plainPainted).filter(p => p.getAttribute("stroke-dasharray") === "4 3").length} dashed`);

    // The bands: hatched, outlined, and NOT painting a palette colour.
    // By CLASS, not by "has a fill-opacity": that attribute was only ever
    // present because Flow transparency existed, so removing that setting in
    // the code once made this find 0 bands for a reason nothing to do with a11y.
    const bandPaths = (els) => els.filter(e =>
        e.tag === "path" && e.getAttribute("class") === "sankeybi-band");
    check("the sweep found bands to judge (non-vacuous)",
        bandPaths(plain).length >= 3, `${bandPaths(plain).length} bands`);
    check("in ordinary mode a band is filled with its flow type's colour",
        bandPaths(plain).every(p => /^#/.test(p.getAttribute("fill"))),
        [...new Set(bandPaths(plain).map(p => p.getAttribute("fill")))].join(" "));
    check("in high contrast a band is filled with a hatch, never a colour",
        bandPaths(hc).length === bandPaths(plain).length
        && bandPaths(hc).every(p => /^url\(#sankeybi-hatch-\d\)$/.test(p.getAttribute("fill"))),
        [...new Set(bandPaths(hc).map(p => p.getAttribute("fill")))].join(" "));
    check("...where an ordinary band is deliberately not stroked at all",
        bandPaths(plain).every(p => p.getAttribute("stroke") === "none"));

    // Two different flow types must get two different hatches, or the mode has
    // made the diagram unreadable in a new way.
    const fills = new Set(bandPaths(hc).map(p => p.getAttribute("fill")));
    check("two flow types get two different hatches",
        fills.size === 2, [...fills].join(" "));

    // The ARROWS, which are the continuation of a band and were the one place
    // high contrast went on painting a palette colour. An
    // arrow stripe has no class of its own, so it is found as a path carrying a
    // hatch that is NOT one of the bands.
    const bandSet = new Set(bandPaths(hc));
    const arrowPaths = (els) => els.filter(e => e.tag === "path"
        && !bandSet.has(e)
        && /^url\(#sankeybi-hatch-\d\)$/.test(e.getAttribute("fill") || ""));
    const colouredArrows = (els) => els.filter(e => e.tag === "path"
        && !bandSet.has(e)
        && /^#[0-9a-f]{6}$/i.test(e.getAttribute("fill") || "")
        && e.getAttribute("pointer-events") === "none");
    check("the sweep drew arrows at all (non-vacuous)",
        arrowPaths(hc).length >= 2, `${arrowPaths(hc).length} hatched arrow stripes`);
    check("in high contrast an arrow is hatched, never a palette colour",
        colouredArrows(hc).length === 0,
        [...new Set(colouredArrows(hc).map(p => p.getAttribute("fill")))].join(" ") || "none");
    // The invariant that matters: a head and the band it grows out of cannot
    // carry different textures, because both take `hatchIndexOf(flowType)`.
    const bandFills = new Set(bandPaths(hc).map(p => p.getAttribute("fill")));
    check("...and every arrow's hatch is one a band is also using",
        arrowPaths(hc).every(p => bandFills.has(p.getAttribute("fill"))),
        `${bandFills.size} band hatches, ${new Set(arrowPaths(hc).map(p => p.getAttribute("fill"))).size} arrow hatches`);
    // In ORDINARY mode they stay coloured, or this would have fixed one mode by
    // breaking the other.
    check("in ordinary mode an arrow still takes its flow type's colour",
        colouredArrows(plain).length >= 2 && arrowPaths(plain).length === 0,
        `${colouredArrows(plain).length} coloured, ${arrowPaths(plain).length} hatched`);

    // **The outline is its own element, and it is OPEN**. It used
    // to be a stroke on the filled path, which outlined the closed polygon --
    // and a band's two closing moves are its end caps, sitting on a node face.
    // So a line was drawn across the flow at each node, and a hatched band with
    // an arrow head continuing it read as two shapes rather than one. The
    // `Z` test is the one that pins it: a closing move IS an end cap.
    const edgesOf = (els, cls) => els.filter(e =>
        e.tag === "path" && e.getAttribute("class") === cls);
    const bandEdges = edgesOf(hc, "sankeybi-band-edge");
    const arrowEdges = edgesOf(hc, "sankeybi-arrow-edge");

    check("each hatched band has an outline element (non-vacuous)",
        bandEdges.length === bandPaths(hc).length,
        `${bandEdges.length} outlines for ${bandPaths(hc).length} bands`);
    check("...stroked in the foreground, or the texture would have no edge",
        bandEdges.every(p => p.getAttribute("stroke") === "#ffffff"
            && p.getAttribute("fill") === "none"),
        [...new Set(bandEdges.map(p => p.getAttribute("stroke")))].join(" "));
    check("...and OPEN: no closing move, so no line across either node face",
        bandEdges.every(p => !/[Zz]/.test(p.getAttribute("d") || "")),
        `${bandEdges.filter(p => /[Zz]/.test(p.getAttribute("d") || "")).length} closed`);

    // **...but only where an arrow continues the flow** (
    // "outline should close the start and end of flows if there are no
    // arrows"). What an open end buys is continuity into the arrow growing out
    // of that face; with that arrow switched off the flow really does end
    // there, and an outline that just stops leaves it hanging open. A source
    // end is drawn as a tail and a target end as a head, so each toggle
    // answers its own end -- and the subpath count is what pins it, because
    // one cap has to MITRE into both edges rather than butt against them as a
    // third subpath.
    const edgeDs = els => edgesOf(els, "sankeybi-band-edge")
        .map(p => p.getAttribute("d") || "");
    const subpaths = d => (d.match(/M/g) || []).length;
    const closes = d => (d.match(/[Zz]/g) || []).length;
    const bothOn = edgeDs(hc);
    const headsOnly = edgeDs(draw(true, { heads: true, tails: false }));
    const tailsOnly = edgeDs(draw(true, { heads: false, tails: true }));
    const noArrows = edgeDs(draw(true, { heads: false, tails: false }));
    check("the per-end sweep found outlines in all four states (non-vacuous)",
        bothOn.length > 0 && headsOnly.length === bothOn.length
        && tailsOnly.length === bothOn.length && noArrows.length === bothOn.length,
        `${bothOn.length}/${headsOnly.length}/${tailsOnly.length}/${noArrows.length} outlines`);
    check("both arrows on: two runs, no cap -- the two long edges and nothing else",
        bothOn.every(d => subpaths(d) === 2 && closes(d) === 0));
    check("heads only: the SOURCE end is capped, and as ONE mitred run",
        headsOnly.every(d => subpaths(d) === 1 && closes(d) === 0));
    check("tails only: the TARGET end is capped, and as ONE mitred run",
        tailsOnly.every(d => subpaths(d) === 1 && closes(d) === 0));
    check("no arrows: both ends capped, which is one closed loop",
        noArrows.every(d => subpaths(d) === 1 && closes(d) === 1));
    // And the strongest form of that last one: with nothing to continue it,
    // the outline IS the band's own filled path. Not a near-miss rebuild of
    // it -- the same string, which is what makes the cap provably the band's
    // own end rather than a line near it.
    const noArrowBands = bandPaths(draw(true, { heads: false, tails: false }))
        .map(p => p.getAttribute("d") || "").sort();
    check("...and that loop is the band's own closed path, character for character",
        noArrows.length === noArrowBands.length
        && noArrows.slice().sort().every((d, i) => d === noArrowBands[i]),
        `${noArrows.length} outlines against ${noArrowBands.length} bands`);
    check("...while the filled band itself is no longer stroked at all",
        bandPaths(hc).every(p => p.getAttribute("stroke") === "none"),
        [...new Set(bandPaths(hc).map(p => p.getAttribute("stroke")))].join(" "));

    check("each arrow stripe has an outline too (non-vacuous)",
        arrowEdges.length >= 2, `${arrowEdges.length} arrow outlines`);
    check("...stroked in the foreground",
        arrowEdges.every(p => p.getAttribute("stroke") === "#ffffff"
            && p.getAttribute("fill") === "none"));
    check("...and OPEN, so the arrow grows out of its band with no line between",
        arrowEdges.every(p => !/[Zz]/.test(p.getAttribute("d") || "")),
        `${arrowEdges.filter(p => /[Zz]/.test(p.getAttribute("d") || "")).length} closed`);
    check("...while the filled stripe is not stroked",
        arrowPaths(hc).every(p => p.getAttribute("stroke") === "none"));

    // The legend has to carry the same textures, or it stops matching.
    const swatches = (els) => els.filter(e => e.tag === "rect"
        && e.getAttribute("width") === "10" && e.getAttribute("height") === "10");
    check("the legend has swatches (non-vacuous)", swatches(hc).length === 2,
        `${swatches(hc).length} swatches`);
    check("a legend swatch carries the same hatch its bands do",
        swatches(hc).every(s => /^url\(#sankeybi-hatch-\d\)$/.test(s.getAttribute("fill")))
        && new Set(swatches(hc).map(s => s.getAttribute("fill"))).size === 2,
        [...new Set(swatches(hc).map(s => s.getAttribute("fill")))].join(" "));
    const bioBand = bandPaths(hc).find(p => true);
    check("...and specifically: Bio's swatch and Bio's band agree",
        swatches(hc)[0].getAttribute("fill") === "url(#sankeybi-hatch-0)"
        && bandPaths(hc).some(p => p.getAttribute("fill") === "url(#sankeybi-hatch-0)"),
        swatches(hc)[0].getAttribute("fill"));
    check("an ordinary legend swatch is still a plain colour",
        swatches(plain).every(s => /^#/.test(s.getAttribute("fill"))),
        [...new Set(swatches(plain).map(s => s.getAttribute("fill")))].join(" "));

    // Nodes: background filled, foreground stroked -- never the data's colour.
    const shapeRects = (els) => els.filter(e => e.tag === "rect"
        && e.getAttribute("stroke-width") !== null && e.getAttribute("width") !== "10");
    check("the sweep found node shapes (non-vacuous)",
        shapeRects(hc).length > 0, `${shapeRects(hc).length} shapes`);
    check("a node is background-filled in high contrast, not the data's colour",
        shapeRects(hc).every(s => s.getAttribute("fill") === "#000000"),
        [...new Set(shapeRects(hc).map(s => s.getAttribute("fill")))].join(" "));
    check("...and foreground-outlined",
        shapeRects(hc).every(s => s.getAttribute("stroke") === "#ffffff"),
        [...new Set(shapeRects(hc).map(s => s.getAttribute("stroke")))].join(" "));
}

// ----------------------------------------- 7. every text has an explicit fill
console.log("\n-- 7. no text falls back to SVG's default black --");
{
    // **The bug it was found through high contrast**, which was never about high
    // contrast: a node label outside its shape, a legend entry and the legend
    // title all set NO fill, so they fell back to SVG's own default black --
    // fine on a light report by luck, invisible on a dark one. `inkOn` only ever
    // ran for the inside-a-shape case.
    //
    // Measured on a DARK theme, so a black fill is a failure rather than a
    // coincidence, and every text element in the tree is checked rather than a
    // chosen few.
    const svg = new FakeElement("svg");
    svg.querySelector = () => null;
    const flows = [
        { rowIndex: 0, flowID: "f", source: "Kärnbränsle", target: "Kärnkraft", value: 100,
            flowType: "Bio" },
        { rowIndex: 1, flowID: "g", source: "Kärnkraft", target: "Elnät", value: 100,
            flowType: "Bio" }
    ];
    const { corridors } = inferCorridors(flows);
    const { graph } = buildGraph(flows, undefined, undefined, corridors);
    const DARK = {
        getColor: () => ({ value: "#4FC3F7" }), background: { value: "#1B1B1B" },
        foreground: { value: "#F3F2F1" }, foregroundNeutralSecondary: { value: "#C8C6C4" },
        isHighContrast: false
    };
    // Node totals ON and the shape set to None, so the labels are drawn OUTSIDE
    // -- which is the path that had no fill at all.
    const chrome = {
        legendVisible: true, legendPosition: "Bottom", nodeShape: "None",
        nodeMinWidthPercent: 3, nodeMinHeightPercent: 3,
        labels: { nodeTotals: true, basis: "Larger", units: "TWh", decimalPlaces: 0 }
    };
    const layout = computeLayout(graph, corridors, 1000, 600, chrome);
    const routed = routeDiagram(layout, {
        style: "Polyline", curvaturePercent: 35, portLeadInPercent: 18, avoidNodes: true
    });
    const settings = {
        labelsCard: { showNodeTotals: { value: true }, totalBasis: { value: { value: "Larger" } } },
        valuesCard: { units: { value: "TWh" }, decimalPlaces: { value: 0 } },
        legendCard: { show: { value: true }, position: { value: { value: "Bottom" } },
            titleText: { value: "Flow type" } },
        corridorsCard: { crossingSeparation: { value: 0 } },
        flowLabelsCard: { show: { value: true }, content: { value: { value: "Value" } },
            colourMode: { value: { value: "Auto" } }, colour: { value: { value: "#fff" } }, font: {} },
        interactionCard: { tooltips: { value: false }, tooltipNodeTotals: { value: false },
            tooltipNodeByFlowType: { value: false }, tooltipNodeByConnection: { value: false } },
        nodeShapesCard: { shape: { value: { value: "None" } }, fill: { value: { value: "None" } },
            fillColour: { value: { value: "#ffffff" } }, border: { value: { value: "None" } },
            borderColour: { value: { value: "#000000" } }, borderWidth: { value: 1 } },
        positionsCard: { showGrid: { value: false }, snap: { value: 4 }, showHandles: { value: true },
            showUnbalanced: { value: false }, balanceTolerance: { value: 0.5 } }
    };
    const thickness = new Map();
    routed.bands.forEach(b =>
        thickness.set(b.corridorId, (thickness.get(b.corridorId) ?? 0) + b.width));
    render.render(svg, layout, routed.bands, DARK, settings,
        { colours: new Map([["Bio", "#4FC3F7"]]), order: ["Bio"], warnings: [] },
        1000, 600, undefined, routed.handles, corridors, {
            registerBand: () => undefined, registerNode: () => undefined,
            registerDecoration: () => undefined, registerHandle: () => undefined,
            nativeTitles: false
        }, new Map(), undefined, [], new Map(), undefined, undefined,
        corridors.map(c => ({ id: c.id, value: c.value, source: c.source,
            spine: routed.spines.get(c.id), thickness: thickness.get(c.id), colour: undefined })));

    const texts = [];
    const walk = (el) => {
        if (el.tag === "text") { texts.push(el); }
        (el.childNodes || []).forEach(walk);
    };
    walk(svg);
    check("the sweep found text of every kind (non-vacuous)",
        texts.length >= 5, `${texts.length} text elements`);
    const unfilled = texts.filter(t => t.getAttribute("fill") === null);
    check("EVERY text element sets a fill explicitly",
        unfilled.length === 0,
        unfilled.map(t => t.textContent).join(" | ") || "none unfilled");
    // And none of them is black, on a theme whose ink is light.
    const black = texts.filter(t => {
        const f = (t.getAttribute("fill") || "").toLowerCase();
        return f === "#000" || f === "#000000" || f === "black";
    });
    check("...and none is black on a dark theme",
        black.length === 0, black.map(t => t.textContent).join(" | ") || "none black");
    // A muted total is held back with opacity, never with a fixed grey.
    const grey = texts.filter(t => (t.getAttribute("fill") || "").toLowerCase() === "#666666");
    check("a muted total uses opacity, not a hardcoded grey",
        grey.length === 0, grey.map(t => t.textContent).join(" | ") || "none grey");
    // Specifically the three that were wrong.
    const said = (needle) => texts.find(t => (t.textContent || "").includes(needle));
    check("the legend's entry is drawn in the theme's ink",
        said("Bio") && said("Bio").getAttribute("fill") === "#F3F2F1",
        said("Bio") ? said("Bio").getAttribute("fill") : "entry not found");
    check("the legend's title too",
        said("Flow type") && said("Flow type").getAttribute("fill") === "#F3F2F1",
        said("Flow type") ? said("Flow type").getAttribute("fill") : "title not found");
    check("an outside node label too",
        said("Kärnbränsle") && said("Kärnbränsle").getAttribute("fill") === "#F3F2F1",
        said("Kärnbränsle") ? said("Kärnbränsle").getAttribute("fill") : "label not found");
}

// ------------------------------------------- 8. a custom text colour wins
console.log("\n-- 8. the author's own text colour --");
{
    // `inkOn` can only pick ink where the text sits on something the VISUAL
    // painted. For text on the report page there is nothing to measure -- the
    // host tells a visual neither the page's nor its own background -- so a
    // custom colour is the only fix, and it has to win outright. Including
    // INSIDE a shape, where inkOn would otherwise have had an opinion: explicit
    // beats automatic, and a setting that loses to a luminance test is a
    // setting that does nothing.
    const PINK = "#FF00AA";
    const draw = (over, palette) => {
        const svg = new FakeElement("svg");
        svg.querySelector = () => null;
        const flows = [
            { rowIndex: 0, flowID: "f", source: "Kärnbränsle", target: "Kärnkraft", value: 100,
                flowType: "Bio" },
            { rowIndex: 1, flowID: "g", source: "Kärnkraft", target: "Elnät", value: 100,
                flowType: "Bio" }
        ];
        const { corridors } = inferCorridors(flows);
        const { graph } = buildGraph(flows, undefined, undefined, corridors);
        // A SHAPE, so some labels are inside it and some outside -- both paths
        // have to honour the colour.
        const chrome = {
            legendVisible: true, legendPosition: "Bottom", nodeShape: "Rectangle",
            nodeMinWidthPercent: 25, nodeMinHeightPercent: 3,
            labels: { nodeTotals: true, basis: "Larger", units: "TWh", decimalPlaces: 0,
                colour: over.labels }
        };
        const layout = computeLayout(graph, corridors, 1000, 600, chrome);
        const routed = routeDiagram(layout, {
            style: "Polyline", curvaturePercent: 35, portLeadInPercent: 18, avoidNodes: true
        });
        const mode = (value) => ({ colourMode: { value: { value: value ? "Custom" : "Auto" } },
            colour: { value: { value: PINK } } });
        const settings = {
            labelsCard: Object.assign({
                showNodeTotals: { value: true }, totalBasis: { value: { value: "Larger" } },
                font: {}
            }, mode(over.labels !== undefined)),
            valuesCard: { units: { value: "TWh" }, decimalPlaces: { value: 0 } },
            legendCard: Object.assign({
                show: { value: true }, position: { value: { value: "Bottom" } },
                titleText: { value: "Flow type" }, font: {}
            }, mode(over.legend)),
            corridorsCard: { crossingSeparation: { value: 0 } },
            flowLabelsCard: { show: { value: false }, content: { value: { value: "Value" } },
                colourMode: { value: { value: "Auto" } }, colour: { value: { value: "#fff" } },
                font: {} },
            interactionCard: { tooltips: { value: false }, tooltipNodeTotals: { value: false },
                tooltipNodeByFlowType: { value: false }, tooltipNodeByConnection: { value: false } },
            nodeShapesCard: { shape: { value: { value: "Rectangle" } },
                fill: { value: { value: "Custom" } }, fillColour: { value: { value: "#111111" } },
                border: { value: { value: "None" } }, borderColour: { value: { value: "#000000" } },
                borderWidth: { value: 1 } },
            positionsCard: { showGrid: { value: false }, snap: { value: 4 },
                showHandles: { value: true }, showUnbalanced: { value: false },
                balanceTolerance: { value: 0.5 } }
        };
        render.render(svg, layout, routed.bands, palette, settings,
            { colours: new Map([["Bio", "#4FC3F7"]]), order: ["Bio"], warnings: [] },
            1000, 600, undefined, routed.handles, corridors, {
                registerBand: () => undefined, registerNode: () => undefined,
                registerDecoration: () => undefined, registerHandle: () => undefined,
                nativeTitles: false
            }, new Map(), undefined, [], new Map(), undefined, undefined, undefined);
        const texts = [];
        const walk = (el) => {
            if (el.tag === "text") { texts.push(el); }
            (el.childNodes || []).forEach(walk);
        };
        walk(svg);
        return texts;
    };
    const LIGHT = {
        getColor: () => ({ value: "#4FC3F7" }), background: { value: "#FFFFFF" },
        foreground: { value: "#252423" }, foregroundNeutralSecondary: { value: "#605E5C" },
        isHighContrast: false
    };
    const HC = {
        getColor: () => ({ value: "#888888" }), background: { value: "#000000" },
        foreground: { value: "#FFFFFF" }, foregroundNeutralSecondary: { value: "#FFFFFF" },
        isHighContrast: true
    };

    const auto = draw({}, LIGHT);
    const custom = draw({ labels: PINK, legend: true }, LIGHT);
    const said = (list, needle) => list.find(t => (t.textContent || "").includes(needle));

    check("automatic is unchanged: nothing is pink", auto.length > 0
        && auto.every(t => (t.getAttribute("fill") || "").toUpperCase() !== PINK),
        [...new Set(auto.map(t => t.getAttribute("fill")))].join(" "));
    check("a node label takes the custom colour",
        said(custom, "Kärnbränsle")
        && said(custom, "Kärnbränsle").getAttribute("fill") === PINK,
        said(custom, "Kärnbränsle") ? said(custom, "Kärnbränsle").getAttribute("fill") : "not found");
    check("...a node TOTAL too",
        said(custom, "TWh") && said(custom, "TWh").getAttribute("fill") === PINK,
        said(custom, "TWh") ? said(custom, "TWh").getAttribute("fill") : "not found");
    check("the legend's entry and its title too",
        said(custom, "Bio") && said(custom, "Bio").getAttribute("fill") === PINK
        && said(custom, "Flow type") && said(custom, "Flow type").getAttribute("fill") === PINK,
        said(custom, "Bio") ? said(custom, "Bio").getAttribute("fill") : "not found");
    // Inside a shape, where inkOn would have had an opinion of its own.
    const inside = custom.filter(t => t.getAttribute("fill") === PINK);
    check("every custom-coloured text really took it (non-vacuous)",
        inside.length >= 5, `${inside.length} of ${custom.length} texts are pink`);

    // High contrast is the one place a picker must NOT win: there the theme's
    // foreground is the only ink the mode allows.
    const hc = draw({ legend: true }, HC);
    check("high contrast overrides a custom legend colour",
        said(hc, "Bio") && said(hc, "Bio").getAttribute("fill") === "#FFFFFF",
        said(hc, "Bio") ? said(hc, "Bio").getAttribute("fill") : "not found");
}

// =====================================================================
// 4. The visual's own PANELS answer high contrast too.
//
// The diagram had answered the mode; its UI never
// had. `isHighContrast` was read in four places, all in render.ts, and
// style/visual.less carried seventeen hardcoded colours with no high-contrast
// handling -- so the node editor, the flow colour editor and the background
// import panel stayed white-on-grey inside a black-on-white diagram.
//
// Every colour is now `var(--name, <the literal it always was>)`, set by
// `visual.ts` only in high contrast and cleared otherwise. The ordinary render
// is byte-identical by construction: unset variable, old literal.
// =====================================================================
console.log("\n-- 4. the panels follow the palette in high contrast --");
{
    const lessSrc = fs.readFileSync(path.join(ROOT, "style", "visual.less"), "utf8");
    const visualSrc = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");

    // A bare colour is one NOT inside a var() fallback. Comments are stripped
    // first, or the commentary about the old literals would read as code.
    const code = lessSrc.replace(/\/\/[^\n]*/g, "");
    const bare = (code.match(/#[0-9a-fA-F]{6}/g) || []).filter(hex => {
        const at = code.indexOf(hex);
        const before = code.slice(Math.max(0, at - 60), at);
        return !/var\(--sankeybi-[a-z-]+,\s*$/.test(before);
    });
    check("no colour in the stylesheet is hardcoded outside a var() fallback",
        bare.length === 0, bare.join(" ") || "none");

    // THE assertion: a variable the stylesheet reads but `visual.ts` never sets
    // falls back to its light literal for ever, and looks perfect in an
    // ordinary report -- so nothing but this would catch a renamed one.
    const used = new Set((lessSrc.match(/var\((--sankeybi-[a-z-]+)/g) || [])
        .map(m => m.replace("var(", "")));
    const set = new Set((visualSrc.match(/"(--sankeybi-[a-z-]+)"/g) || [])
        .map(m => m.replace(/"/g, "")));
    const unset = [...used].filter(v => !set.has(v));
    const unused = [...set].filter(v => !used.has(v));
    check("every variable the stylesheet reads is one visual.ts sets",
        unset.length === 0, unset.join(" ") || `${used.size} variables`);
    check("...and every variable it sets is one the stylesheet reads",
        unused.length === 0, unused.join(" ") || `${set.size} variables`);
    check("the sweep found variables to compare (non-vacuous)",
        used.size >= 8, `${used.size} used, ${set.size} set`);

    // Set only in high contrast, and REMOVED otherwise -- not set to the light
    // values, which would make the fallbacks dead and the ordinary render
    // depend on this code path.
    check("they are set only in high contrast",
        /if \(this\.colorPalette\.isHighContrast\) \{\s*\n\s*style\.setProperty/.test(visualSrc));
    check("...and removed, not overwritten, outside it",
        /\} else \{\s*\n\s*style\.removeProperty\(name\);/.test(visualSrc));
    check("...on the host element, so all three panels inherit them",
        /const style = this\.target\.style;/.test(visualSrc));

    // High contrast has two colours. A neutral grey for muted text would fail
    // the contrast it exists to guarantee.
    check("muted text, rules and borders all take the FOREGROUND there",
        /"--sankeybi-muted": this\.colorPalette\.foreground\.value/.test(visualSrc)
        && /"--sankeybi-rule": this\.colorPalette\.foreground\.value/.test(visualSrc)
        && /"--sankeybi-line": this\.colorPalette\.foreground\.value/.test(visualSrc));
    // **Form controls do not inherit `color`.** A <button>, <input> or <select>
    // takes the UA's own -- black -- whatever the panel says, so the node
    // editor's row headers (buttons) stayed black in high contrast while the
    // spans around them followed. Nothing in the variable check above could see
    // it: every variable was set and read correctly, and the text was still
    // black. This is the assertion that would have caught it.
    check("form controls are told to inherit the panel's colour",
        /button, input, select, textarea \{ color: inherit; \}/.test(lessSrc));
    check("...and text inputs take the panel's background, not the UA's white",
        /input\[type="text"\][\s\S]{0,80}?background: var\(--sankeybi-bg/.test(lessSrc));
    // Scoped to unclassed buttons so the classed ones keep their own look, and
    // `revert` so an ordinary report keeps native button chrome exactly.
    check("...and an unclassed button takes the panel's colours only in high contrast",
        /button:not\(\[class\]\) \{[\s\S]{0,160}?var\(--sankeybi-bg, revert\)/.test(lessSrc)
        && /var\(--sankeybi-control-border, revert\)/.test(lessSrc));

    check("...and the drop shadow, which is a colour the mode has not got, goes",
        /"--sankeybi-shadow": "none"/.test(visualSrc));
}

console.log(`\n${assertions} assertions, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
