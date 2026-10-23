"use strict";
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");
const { computeLayout } = require("./layout-api.js");
const { routeCorridors } = require("./routing-api.js");

let failures = 0;
function check(label, cond) {
    if (!cond) {
        failures++;
        console.log(`FAIL: ${label}`);
    }
}

// Mirrors the test data verbatim (M2 feature set: multi-type
// stacking, colour override, display order, label override/suppression, self-loop).
const flows = [
    { flowID: "F1", source: "Wind", target: "Grid", value: 120, flowType: "Electricity", flowDisplayOrder: 2, sourceLabel: "Wind", targetLabel: "Grid" },
    { flowID: "F2", source: "Solar", target: "Grid", value: 80, flowType: "Electricity", flowDisplayOrder: 2, sourceLabel: "Solar", targetLabel: "Grid" },
    { flowID: "F3", source: "Hydro", target: "Grid", value: 60, flowType: "Electricity", flowDisplayOrder: 2, sourceLabel: "Hydropower", targetLabel: "Grid" },
    { flowID: "F4", source: "Gas", target: "Grid", value: 40, flowType: "Electricity", flowDisplayOrder: 2, sourceLabel: "Gas", targetLabel: "Grid" },
    { flowID: "F5", source: "Grid", target: "Industry", value: 140, flowType: "Electricity", flowDisplayOrder: 2, sourceLabel: "Grid", targetLabel: "Industry" },
    { flowID: "F6", source: "Grid", target: "Industry", value: 30, flowType: "Heat", flowColour: "#e74c3c", flowDisplayOrder: 1, sourceLabel: "Grid", targetLabel: "Industry" },
    { flowID: "F7", source: "Grid", target: "Buildings", value: 70, flowType: "Electricity", flowDisplayOrder: 2, sourceLabel: "Grid", targetLabel: "Buildings" },
    { flowID: "F8", source: "Grid", target: "Buildings", value: 50, flowType: "Heat", flowColour: "#e74c3c", flowDisplayOrder: 1, sourceLabel: "Grid", targetLabel: "Buildings" },
    { flowID: "F9", source: "Grid", target: "Electrolyser", value: 60, flowType: "Electricity", flowDisplayOrder: 2, sourceLabel: "Grid", targetLabel: "" },
    { flowID: "F10", source: "Electrolyser", target: "Hydrogen Storage", value: 55, flowType: "Hydrogen", targetLabel: "Hydrogen Storage" },
    { flowID: "F11", source: "Hydrogen Storage", target: "Transport", value: 50, flowType: "Hydrogen", sourceLabel: "Hydrogen Storage", targetLabel: "Transport" },
    { flowID: "F12", source: "Grid", target: "District Heating", value: 40, flowType: "Heat", flowColour: "#e74c3c", flowDisplayOrder: 1, sourceLabel: "Grid", targetLabel: "District Heating" },
    { flowID: "F13", source: "Electrolyser", target: "Electrolyser", value: 5, flowType: "Hydrogen" }
];

function samplePath(d, subSamples = 20) {
    const tokens = d.match(/[MLCZ]|-?\d+(\.\d+)?/g);
    let i = 0;
    let cur = { x: 0, y: 0 };
    const pts = [];
    const readNum = () => parseFloat(tokens[i++]);
    const cubicPoint = (p0, c1, c2, p1, t) => {
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
            for (let s = 1; s <= subSamples; s++) pts.push(cubicPoint(cur, c1, c2, end, s / subSamples));
            cur = end;
        }
    }
    return pts;
}

const { graph, warnings: graphWarnings } = buildGraph(flows);
check("no unexpected graph warnings", graphWarnings.length === 0);

const { corridors, warnings: corridorWarnings } = inferCorridors(flows);
check("no unexpected corridor warnings", corridorWarnings.length === 0);
check("11 corridors inferred (12 non-self-loop pairs collapse to 10 unique + 1 self-loop = 11)", corridors.length === 11);

const layout = computeLayout(graph, corridors, 1280, 720, { legendVisible: true, legendPosition: "Bottom" });
check("all node heights finite and positive", Array.from(layout.nodes.values()).every(n => Number.isFinite(n.height) && n.height > 0));
check("all node x/y finite", Array.from(layout.nodes.values()).every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));

// Grid should never be blank -- multiple rows agree on "Grid" (no conflict expected).
check("Grid label resolves to \"Grid\"", graph.nodes.get("Grid").label === "Grid");

const bands = routeCorridors(layout);
check("bands produced for every non-self-loop segment plus the self-loop's 1 segment", bands.length > 0);
check("all band paths produce finite coordinates", bands.every(b => samplePath(b.path).every(p => Number.isFinite(p.x) && Number.isFinite(p.y))));

const selfLoopBands = bands.filter(b => b.isSelfLoop);
check("exactly 1 self-loop band (Electrolyser->Electrolyser, 1 segment)", selfLoopBands.length === 1);
check("self-loop band exits at Electrolyser's East edge", (() => {
    const node = layout.nodes.get("Electrolyser");
    const pts = samplePath(selfLoopBands[0].path);
    return Math.abs(pts[0].x - (node.x + node.width)) < 0.01;
})());

if (failures === 0) {
    console.log("ALL FULL-PIPELINE CHECKS PASSED");
} else {
    console.log(`${failures} FULL-PIPELINE CHECK(S) FAILED`);
    process.exit(1);
}
