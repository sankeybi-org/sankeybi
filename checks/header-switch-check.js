"use strict";
// The Arrows group's header switch.
//
// "Show arrows" used to be a button that set heads and tails and wrote itself
// back off. It is the group's header switch now: it READS as heads-or-tails and
// flipping it drives both. The one case a pure function of the three stored
// values cannot get right is why `headerSwitch.ts` takes the header's last
// consistent value as well, and is what this pins:
//
//   "both just went off" and "the header was just flipped on" store the same
//   thing (heads false, tails false, show true). Without `last` the first
//   would turn the arrows straight back on.

const fs = require("fs");
const path = require("path");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const { reconcileArrowSwitch, reconcileShapeSwitch } = require("./lib/headerSwitch.js");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const s = (show, heads, tails) => ({ show, heads, tails });

// Consistent states write nothing and are remembered.
[[false, false, false], [true, true, true], [true, true, false], [true, false, true]].forEach(([a, b, c]) => {
    const r = reconcileArrowSwitch(undefined, s(a, b, c));
    check(`consistent ${a}/${b}/${c} writes nothing and is remembered`, r.write === null && r.last === a);
});

// Flipping the header from a consistent state drives both.
let r = reconcileArrowSwitch(false, s(true, false, false));
check("header flipped ON drives heads and tails on", same(r.write, { heads: true, tails: true }));
r = reconcileArrowSwitch(true, s(false, true, true));
check("header flipped OFF drives heads and tails off", same(r.write, { heads: false, tails: false }));
r = reconcileArrowSwitch(true, s(false, true, false));
check("header flipped OFF with only heads on turns heads off", same(r.write, { heads: false, tails: false }));

// Moving heads or tails makes the header follow.
r = reconcileArrowSwitch(true, s(true, false, false));
check("both inside went off: the header follows and does NOT turn them back on",
    same(r.write, { showArrows: false }), JSON.stringify(r.write));
r = reconcileArrowSwitch(false, s(false, true, false));
check("one inside came on: the header follows", r.write === null ? false : same(r.write, { showArrows: true }));

// The two lookalikes are told apart by `last` alone.
const lookalike = s(true, false, false);
check("same stored values, different `last`, opposite writes",
    same(reconcileArrowSwitch(true, lookalike).write, { showArrows: false })
    && same(reconcileArrowSwitch(false, lookalike).write, { heads: true, tails: true }));

// First sight of an old report: it stored show=false beside heads/tails=true.
r = reconcileArrowSwitch(undefined, s(false, true, true));
check("an old report (show stored off, arrows on) is repaired, not switched off",
    same(r.write, { showArrows: true }) && r.last === undefined);

// An update that lands before the persist has must repeat the same write, and
// `last` must not have moved, or the second update would undo the first.
const first = reconcileArrowSwitch(false, s(true, false, false));
const again = reconcileArrowSwitch(first.last, s(true, false, false));
check("a stale update repeats the write instead of undoing it", same(first.write, again.write) && first.last === false);
const landed = reconcileArrowSwitch(again.last, s(true, true, true));
check("once the persist lands the switch settles", landed.write === null && landed.last === true);

// ---- Shapes: the header reads as "shape is not None" -----------
const sh = (show, shape) => ({ show, shape });

r = reconcileShapeSwitch(true, undefined, sh(false, "Rectangle"));
check("shapes header flipped OFF sets the shape to None", same(r.write, { shape: "None" }), JSON.stringify(r.write));
r = reconcileShapeSwitch(true, "Circle", sh(false, "Circle"));
check("...and remembers the shape it took away", r.restore === "Circle");

// The remembered shape is what comes back, not a fixed one.
const circle = reconcileShapeSwitch(undefined, undefined, sh(true, "Circle"));
const off = reconcileShapeSwitch(circle.last, circle.restore, sh(true, "None"));
check("dropdown set to None: the header follows", same(off.write, { showShapes: false }));
const flippedOn = reconcileShapeSwitch(false, off.restore, sh(true, "None"));
check("header flipped back ON restores Circle, not Rectangle",
    same(flippedOn.write, { shape: "Circle" }), JSON.stringify(flippedOn.write));
check("with nothing remembered it restores the default Rectangle",
    same(reconcileShapeSwitch(false, undefined, sh(true, "None")).write, { shape: "Rectangle" }));

// Picking a shape from the dropdown while shapes are off turns the header on.
r = reconcileShapeSwitch(false, undefined, sh(false, "Rounded"));
check("choosing a shape while off turns the header on", same(r.write, { showShapes: true }));
check("a consistent state writes nothing",
    reconcileShapeSwitch(undefined, undefined, sh(true, "Rounded")).write === null
    && reconcileShapeSwitch(undefined, undefined, sh(false, "None")).write === null);
// A stale update before the persist lands repeats the write.
const f1 = reconcileShapeSwitch(true, "Circle", sh(false, "Circle"));
const f2 = reconcileShapeSwitch(f1.last, f1.restore, sh(false, "Circle"));
check("a stale update repeats the shape write", same(f1.write, f2.write) && f2.last === true);

// Wiring: the switch is the group's header, and nothing still treats it as a
// button that writes itself back off.
const settings = require("./sources.js").settingsSource();
check("the Arrows group takes showArrows as its header slice",
    /group\("nodesArrows",\s*"Arrows",\s*\[this\.heads, this\.tails, this\.angle, this\.gapPercent\],\s*this\.showArrows\)/.test(settings));
const visual = fs.readFileSync(path.join(__dirname, "..", "src", "visual.ts"), "latin1");
check("the Shapes group takes showShapes as its header slice",
    /group\("nodesShapes",\s*"Shapes",[^;]*?this\.showShapes\)/.test(settings));
check("visual.ts reconciles through headerSwitch and no longer resets showArrows itself",
    visual.includes("reconcileArrowSwitch(") && !/showArrows:\s*false/.test(visual));

console.log(`\n${assertions} assertions, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
