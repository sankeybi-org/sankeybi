"use strict";
// Run the synthetic checks.
//
//   node checks/run.js                 every check
//   node checks/run.js routing         a named group (see GROUPS)
//   node checks/run.js fit-check pack-check
//   node checks/run.js --list          the groups and what is in them
//
// It rebuilds checks/lib first whenever a source file is newer than the
// compiled snapshot, because a stale .js silently tests old code.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const here = __dirname;
const root = path.join(here, "..");

const GROUPS = {
    smoke: ["driver", "full-pipeline-check", "bugfix-checks"],
    properties: ["properties-check"],
    layout: ["fit-check", "pack-check", "lane-check", "flowgap-check", "node-style-check",
        "layout-fit-check", "baseline-check", "justify-check"],
    routing: ["polyline-check", "s-lane-check", "routing-style-check", "selfloop-radius-check",
        "seam-check", "corner-check", "biarc-quarter-check", "crossing-check", "wrap-order-check",
        "straighten-check", "stubline-check", "routingmix-testdata-verify"],
    avoidance: ["avoidance-check", "waypoint-check"],
    arrows: ["arrow-check"],
    autofit: ["arrange-nodes-check", "spacing-check", "leadfloor-check", "parallel-check", "nodeorder-check"],
    render: ["render-labels-check", "hit-check", "channel-check", "crossing-site-check", "layer-check", "icon-check"],
    labels: ["text-measure-check", "labelwrap-check", "number-format-check", "flowlabel-check", "balance-check",
        "legend-order-check", "render-labels-check"],
    interaction: ["drag-check", "angle-snap-check", "positions-check", "selection-check",
        "tooltips-check", "hit-check"],
    panels: ["nodeedit-check", "pane-check", "background-check", "layoutfile-check",
        "flowcolour-check", "header-switch-check"],
    data: ["driver", "warnings-check", "port-routing-check", "nodeorder-check"],
    cache: ["geometry-cache-check"],
    orientation: ["transpose-check", "port-routing-check"],
    a11y: ["a11y-check"],
    testdata: ["routingmix-testdata-verify"
        ],
};

// Modules the checks share; they assert nothing themselves.
const HELPERS = ["run.js", "dataview.js", "parse.js", "placed.js", "routing-api.js", "render-api.js", "layout-api.js", "model-api.js", "sources.js"];

function allChecks() {
    return fs.readdirSync(here)
        .filter(f => f.endsWith(".js") && !HELPERS.includes(f))
        .map(f => f.replace(/\.js$/, ""))
        .sort();
}

function rebuildIfStale() {
    const libDir = path.join(here, "lib");
    let oldest = Infinity;
    if (!fs.existsSync(libDir)) {
        oldest = -Infinity;
    } else {
        for (const f of fs.readdirSync(libDir)) {
            oldest = Math.min(oldest, fs.statSync(path.join(libDir, f)).mtimeMs);
        }
    }
    let newest = 0;
    const srcDir = path.join(root, "src");
    for (const f of fs.readdirSync(srcDir)) {
        if (f.endsWith(".ts")) newest = Math.max(newest, fs.statSync(path.join(srcDir, f)).mtimeMs);
    }
    if (newest <= oldest) return;
    process.stdout.write("rebuilding checks/lib ... ");
    const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
    try {
        execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.checks.json")], { stdio: "pipe" });
        console.log("done");
    } catch (e) {
        console.log("FAILED");
        process.stdout.write(String(e.stdout || "") + String(e.stderr || ""));
        process.exit(1);
    }
}

const args = process.argv.slice(2);
if (args[0] === "--list") {
    for (const [g, names] of Object.entries(GROUPS)) console.log(`${g.padEnd(12)} ${names.join(" ")}`);
    console.log(`\nall          ${allChecks().length} checks`);
    process.exit(0);
}

const names = [];
for (const a of args) {
    // A group lists every check the project has; a clean checkout may hold only some of them.
    if (GROUPS[a]) names.push(...GROUPS[a].filter(n => fs.existsSync(path.join(here, n + ".js"))));
    else names.push(a.replace(/\.js$/, ""));
}
const wanted = [...new Set(names.length ? names : allChecks())];

const missing = wanted.filter(n => !fs.existsSync(path.join(here, n + ".js")));
if (missing.length) { console.log(`no such check: ${missing.join(" ")}`); process.exit(2); }

rebuildIfStale();

let failed = [];
const t0 = Date.now();
for (const n of wanted) {
    const t = Date.now();
    let ok = true, out = "";
    try { out = execFileSync(process.execPath, [path.join(here, n + ".js")], { stdio: "pipe" }).toString(); }
    catch (e) { ok = false; out = String(e.stdout || "") + String(e.stderr || ""); failed.push(n); }
    console.log(`${ok ? "ok  " : "FAIL"}  ${String(Date.now() - t).padStart(6)}ms  ${n}`);
    if (!ok) {
        const lines = out.split(/\r?\n/).filter(l => /FAIL|Error|error/.test(l));
        for (const l of lines.slice(0, 20)) console.log(`        ${l}`);
    }
}
console.log(`\n${wanted.length - failed.length}/${wanted.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) { console.log(`failed: ${failed.join(" ")}`); process.exit(1); }
