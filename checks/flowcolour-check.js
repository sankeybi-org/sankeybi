"use strict";
// Flow type colours chosen in the visual.
//
// it was asked for "a list of flow types with a colour selection for each" in the
// Flows card. It cannot be in the card: a per-value picker in the pane persists
// against a data identity, and this dataView has none at the grain of one flow
// type -- all eighteen grouping roles go into one `categories` bag, so
// `identity[i]` is the scope identity of the whole grouping TUPLE at that row
// (selection.ts). A picker keyed to that stores a colour against one ROW. So the
// colours are a hidden blob and a panel in the visual edits them, which is the
// answer the node positions and the node edits already reached.
//
// What is asserted, and why each one can fail:
//
//   1. PRECEDENCE: the panel beats the data beats the palette. One function
//      applies it, because the legend, the bands, the sub-bands and the hatch
//      order all read the map it returns.
//   2. **The palette SEQUENCE is unmoved by an override.** `getColor` hands
//      colours out in call sequence, so short-circuiting it for an overridden
//      type would shift every later type's automatic colour -- picking one
//      flow type's colour by hand would silently recolour the others. This is
//      the subtle one, and the first draft had the bug.
//   3. The cross-corridor FlowColour conflict warning goes QUIET for a type the
//      panel has settled, or it would name a colour that is not being drawn.
//   4. The blob parses TOTALLY: a bad entry is dropped on its own, and garbage
//      yields an empty map rather than throwing.
//   5. The colours are a **data-stage input**. `colours.ts` resolves them inside
//      `update`'s `dataChanged` branch, so a colour changed with nothing else
//      changing must still re-run those stages -- otherwise the pick does
//      nothing until the next data change. Asserted against visual.ts's source,
//      along with the matching rule that the persist leaves the cached raw
//      string STALE; setting it eagerly is the same bug from the other end, and
//      that draft was written too.
//   6. It is not a geometry input: a colour moves no geometry, so the key is
//      unmoved and a cosmetic update still skips the pipeline.

const fs = require("fs");
const path = require("path");

let failures = 0;
let assertions = 0;
function check(label, cond, detail) {
    assertions++;
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

const { resolveFlowTypeColours } = require("./lib/colours.js");
const { inferCorridors } = require("./lib/corridors.js");
const {
    parseFlowTypeColours, serialiseFlowTypeColours, withFlowTypeEdit,
    MAX_FLOW_TYPE_COLOURS, FLOW_PATTERN_COUNT, FLOW_PATTERN_NONE
} = require("./lib/flowTypeColours.js");

const ROOT = path.join(__dirname, "..");

/** A palette that records the sequence it was asked in -- assertion 2's point. */
function recordingPalette() {
    const asked = [];
    return { asked, getColor: key => { asked.push(key); return { value: `#auto-${asked.length}` }; } };
}

const ROWS = [
    { rowIndex: 0, flowID: "a", source: "A", target: "B", value: 10, flowType: "Bio" },
    { rowIndex: 1, flowID: "b", source: "A", target: "B", value: 10, flowType: "Coal" },
    { rowIndex: 2, flowID: "c", source: "B", target: "C", value: 10, flowType: "Heat" }
];

const resolve = (overrides, rows = ROWS) => {
    const { corridors } = inferCorridors(rows);
    return resolveFlowTypeColours(corridors, recordingPalette(), "en-US", overrides);
};

/** With the format pane's Texture / Outline asking for something. */
const resolveWith = (defaults, overrides, rows = ROWS) => {
    const { corridors } = inferCorridors(rows);
    return resolveFlowTypeColours(corridors, recordingPalette(), "en-US", overrides, defaults);
};

// ------------------------------------------------------------- 1. precedence
console.log("\n-- 1. the panel beats the data beats the palette --");
{
    const withData = [
        { ...ROWS[0], flowColour: "#111111" },
        ROWS[1],
        ROWS[2]
    ];
    const bare = resolve(undefined, withData);
    check("with nothing picked, the data's FlowColour wins",
        bare.colours.get("Bio") === "#111111", bare.colours.get("Bio"));
    check("...and a type with no FlowColour takes the palette's",
        /^#auto-/.test(bare.colours.get("Coal")), bare.colours.get("Coal"));

    const picked = resolve(new Map([["Bio", { colour: "#ff00ff" }], ["Coal", { colour: "#00ff00" }]]), withData);
    check("a picked colour beats the data's",
        picked.colours.get("Bio") === "#ff00ff", picked.colours.get("Bio"));
    check("...and beats the palette's",
        picked.colours.get("Coal") === "#00ff00", picked.colours.get("Coal"));
    check("...while an unpicked type is untouched",
        /^#auto-/.test(picked.colours.get("Heat")), picked.colours.get("Heat"));

    check("the data's own colours are reported separately, for the panel to show",
        bare.dataColours.get("Bio") === "#111111" && bare.dataColours.has("Coal") === false,
        `${bare.dataColours.get("Bio")} / ${bare.dataColours.size} entries`);
}

// -------------------------------------------- 2. the palette sequence is held
console.log("\n-- 2. overriding one type does not recolour the others --");
{
    const { corridors } = inferCorridors(ROWS);
    const before = recordingPalette();
    const plain = resolveFlowTypeColours(corridors, before, "en-US");
    const after = recordingPalette();
    const over = resolveFlowTypeColours(corridors, after, "en-US", new Map([["Bio", { colour: "#ff00ff" }]]));

    check("the palette is still asked for EVERY type, overridden or not",
        after.asked.length === before.asked.length
        && after.asked.join("|") === before.asked.join("|"),
        `${before.asked.join(",")} vs ${after.asked.join(",")}`);
    // The real statement: the types nobody touched keep the colour they had.
    const unmoved = ["Coal", "Heat"].every(t => plain.colours.get(t) === over.colours.get(t));
    check("...so a type nobody touched keeps its automatic colour",
        unmoved,
        ["Coal", "Heat"].map(t => `${t} ${plain.colours.get(t)}->${over.colours.get(t)}`).join(" "));
    // Non-vacuous: this is what it looks like when the sequence DOES shift.
    const shifted = ["Coal", "Heat"].map(t => plain.colours.get(t));
    check("the sweep had automatic colours to shift (non-vacuous)",
        shifted.every(c => /^#auto-\d+$/.test(c)), shifted.join(" "));
}

// ------------------------------------------------- 3. the warning goes quiet
console.log("\n-- 3. a settled conflict stops being warned about --");
{
    const conflicting = [
        { rowIndex: 0, flowID: "a", source: "A", target: "B", value: 10, flowType: "Bio", flowColour: "#111111" },
        { rowIndex: 1, flowID: "b", source: "B", target: "C", value: 10, flowType: "Bio", flowColour: "#222222" }
    ];
    const noisy = resolve(undefined, conflicting);
    check("a FlowColour disagreeing across corridors is warned about",
        noisy.warnings.some(w => /conflicting FlowColour/.test(w)),
        `${noisy.warnings.length} warnings`);
    const settled = resolve(new Map([["Bio", { colour: "#ff00ff" }]]), conflicting);
    check("...but not once the panel has settled it",
        settled.warnings.every(w => !/conflicting FlowColour/.test(w)),
        settled.warnings.join(" | ") || "no warnings");
    check("...and the panel's colour is what gets drawn",
        settled.colours.get("Bio") === "#ff00ff", settled.colours.get("Bio"));
}

// ------------------------------------------------------- 4. a total parse
console.log("\n-- 4. the blob parses totally, in both of its shapes --");
{
    check("garbage is an empty map, not a throw", parseFlowTypeColours("{oh dear").size === 0);
    check("so is a non-string", parseFlowTypeColours(undefined).size === 0
        && parseFlowTypeColours(42).size === 0);
    check("so is an array", parseFlowTypeColours("[1,2]").size === 0);

    const mixed = parseFlowTypeColours(
        '{"Bio":{"c":"#ff0000","l":"Solid biomass"},"Coal":{"c":"red"},"Heat":{"l":17},"":{"c":"#00ff00"}}');
    check("a bad field is dropped on its own and the good ones kept",
        mixed.size === 1 && mixed.get("Bio")?.colour === "#ff0000"
        && mixed.get("Bio")?.label === "Solid biomass",
        JSON.stringify([...mixed]));
    check("an entry left with nothing is dropped",
        mixed.has("Coal") === false && mixed.has("Heat") === false);
    check("a colour is normalised to lower case, so comparisons cannot differ by it",
        parseFlowTypeColours('{"Bio":{"c":"#AABBCC"}}').get("Bio")?.colour === "#aabbcc");
    check("a blank label is no label, not an empty one",
        parseFlowTypeColours('{"Bio":{"c":"#aabbcc","l":"   "}}').get("Bio")?.label === undefined);

    check("an empty map serialises to the empty string, not to {}",
        serialiseFlowTypeColours(new Map()) === "");
    const round = parseFlowTypeColours(serialiseFlowTypeColours(
        new Map([["Bio", { colour: "#ff0000", label: "Solid biomass" }]])));
    check("a round trip is lossless for both fields",
        round.get("Bio")?.colour === "#ff0000" && round.get("Bio")?.label === "Solid biomass",
        JSON.stringify([...round]));

    // The two fields move independently: setting one must not clear the other,
    // which is what a single "reset" callback per row would have done.
    let e = withFlowTypeEdit(new Map(), "Bio", { colour: "#ff0000" });
    check("withFlowTypeEdit sets a colour", e.get("Bio")?.colour === "#ff0000");
    e = withFlowTypeEdit(e, "Bio", { label: "Solid biomass" });
    check("...and a label beside it, leaving the colour alone",
        e.get("Bio")?.colour === "#ff0000" && e.get("Bio")?.label === "Solid biomass");
    const cleared = withFlowTypeEdit(e, "Bio", { colour: null });
    check("...clears one field without the other",
        cleared.get("Bio")?.colour === undefined && cleared.get("Bio")?.label === "Solid biomass");
    check("...and the entry goes once nothing is left",
        withFlowTypeEdit(cleared, "Bio", { label: null }).size === 0);
    check("an empty label clears rather than storing blankness",
        withFlowTypeEdit(e, "Bio", { label: "   " }).get("Bio")?.label === undefined);
    check("...and a colour that is not #rrggbb is refused",
        withFlowTypeEdit(new Map(), "Bio", { colour: "red" }).size === 0);
    check("...and the map returned is a new one",
        e !== withFlowTypeEdit(e, "Coal", { colour: "#00ff00" }) && e.size === 1);

    let capped = new Map();
    for (let i = 0; i < MAX_FLOW_TYPE_COLOURS + 10; i++) {
        capped = withFlowTypeEdit(capped, `t${i}`, { colour: "#ff0000" });
    }
    check("the cap holds, since the blob travels in the report",
        capped.size === MAX_FLOW_TYPE_COLOURS, String(capped.size));
}

// ------------------------------------------- 4b. what a flow type is CALLED
console.log("\n-- 4b. a label renames a flow type everywhere it is named --");
{
    const named = resolve(new Map([["Bio", { label: "Solid biomass" }]]));
    check("the label is reported for the legend and the tooltips",
        named.labels.get("Bio") === "Solid biomass", JSON.stringify([...named.labels]));
    check("...and a type with no label is absent rather than echoing its name",
        named.labels.has("Coal") === false, JSON.stringify([...named.labels]));
    check("...and the ORDER still keys on the type's own name",
        named.order.join(",") === "Bio,Coal,Heat", named.order.join(","));
    check("...as do the colours, so a rename cannot recolour anything",
        /^#auto-/.test(named.colours.get("Bio")), named.colours.get("Bio"));

    // One map, read by both, which is what stops the legend and a tooltip
    // disagreeing -- the same argument that keeps the colours in one place.
    const renderSrc2 = require("./sources.js").renderSource();
    const tooltipsSrc = fs.readFileSync(path.join(ROOT, "src", "tooltips.ts"), "utf8");
    check("the legend reads it through one helper",
        /function labelOfType\(type: string, flowTypeColours: FlowTypeColours\)/.test(renderSrc2)
        && (renderSrc2.match(/labelOfType\(type, flowTypeColours\)/g) || []).length === 2,
        `${(renderSrc2.match(/labelOfType\(type, flowTypeColours\)/g) || []).length} legend layouts`);
    check("...and the tooltips read the SAME labels off LabelOptions",
        (tooltipsSrc.match(/labels\.flowTypeLabels\?\.get\(/g) || []).length === 2,
        `${(tooltipsSrc.match(/labels\.flowTypeLabels\?\.get\(/g) || []).length} tooltip sites`);
    check("...and the legend measures the LABEL, not the type name",
        /labelOfType\(type, flowTypeColours\),/.test(renderSrc2));
}

// ------------------------------------------- 4c. a texture instead of a fill
console.log("\n-- 4c. a flow type can be filled with a texture --");
{
    const textured = resolve(new Map([["Bio", { pattern: 2 }]]));
    check("the texture is reported for the bands, the arrows and the legend",
        textured.patterns.get("Bio") === 2, JSON.stringify([...textured.patterns]));
    check("...and a type without one is absent, meaning a flat fill",
        textured.patterns.has("Coal") === false);
    check("...while its COLOUR is untouched, the texture being drawn in it",
        /^#auto-/.test(textured.colours.get("Bio")), textured.colours.get("Bio"));

    // **One number for one thing.** An author's texture is drawn by the same
    // generator high contrast uses, so the count offered must be the count
    // built -- and six is itself a measurement ("as many as stay
    // distinguishable at the widths bands are actually drawn at").
    const renderSrc3 = require("./sources.js").renderSource();
    const textures = require("./lib/textures.js");
    check("the textures offered are the textures built",
        textures.TEXTURES.length === FLOW_PATTERN_COUNT && textures.TEXTURE_NAMES.length === FLOW_PATTERN_COUNT
        && textures.HATCH_COUNT + textures.PATTERN_COUNT === FLOW_PATTERN_COUNT,
        `${textures.TEXTURES.length} built vs ${FLOW_PATTERN_COUNT} offered`);
    check("...and the generator takes an id prefix, or two sets would collide",
        /function hatchPatterns\([\s\S]{0,400}?idPrefix = "sankeybi-hatch"/.test(renderSrc3));

    // Out of range is dropped rather than clamped: a clamp would silently draw
    // a texture nobody chose. The floor is FLOW_PATTERN_NONE,
    // not 0 -- that one value is "flat, and I mean it", which is a choice and
    // not an index.
    check("a texture index outside the set is refused",
        withFlowTypeEdit(new Map(), "Bio", { pattern: FLOW_PATTERN_COUNT }).size === 0
        && withFlowTypeEdit(new Map(), "Bio", { pattern: FLOW_PATTERN_NONE - 1 }).size === 0);
    check("...while FLOW_PATTERN_NONE is kept, because it is a choice",
        withFlowTypeEdit(new Map(), "Bio", { pattern: FLOW_PATTERN_NONE })
            .get("Bio")?.pattern === FLOW_PATTERN_NONE,
        `stored ${JSON.stringify(withFlowTypeEdit(new Map(), "Bio", { pattern: FLOW_PATTERN_NONE }).get("Bio"))}`);
    check("...and it round-trips through the blob",
        parseFlowTypeColours(serialiseFlowTypeColours(
            new Map([["Bio", { pattern: FLOW_PATTERN_NONE }]]))).get("Bio")?.pattern
            === FLOW_PATTERN_NONE);
    check("...as does an outline of \"none\"",
        parseFlowTypeColours(serialiseFlowTypeColours(
            new Map([["Bio", { outline: "none" }]]))).get("Bio")?.outline === "none");
    check("...and a fractional one too",
        withFlowTypeEdit(new Map(), "Bio", { pattern: 1.5 }).size === 0);
    check("the blob round-trips a texture",
        parseFlowTypeColours(serialiseFlowTypeColours(
            new Map([["Bio", { pattern: 4 }]]))).get("Bio")?.pattern === 4);
    check("...and drops one out of range on read",
        parseFlowTypeColours('{"Bio":{"p":99}}').size === 0);

    // **High contrast wins.** There the mode assigns a hatch per type and takes
    // colour away, so an author's texture has nothing to act on -- and two
    // pattern sets would fight over which texture means which type, which is
    // the one thing the legend must be able to say.
    check("high contrast's hatch beats the author's texture",
        /const fill = hatches\s*\n\s*\? hatches\[hatchIndexOf/.test(renderSrc3)
        && /:\s*\(band\.flowType !== undefined \? typePatterns\.get\(band\.flowType\)/
            .test(renderSrc3));
    check("...and the author's set is not even built there",
        /if \(!hatching && authored !== undefined && authored\.size > 0\)/.test(renderSrc3));
    // An arrow is the continuation of its band, so it takes the band's fill --
    // the defect the code once fixed for high contrast, in its other form.
    check("an arrow stripe takes its band's texture",
        /typePatterns\.get\(stripe\.flowType\)/.test(renderSrc3));
    // And the swatch carries whatever the bands carry, or the legend stops
    // saying what the diagram means -- the objection that retired Gradient.
    check("the legend swatch carries it too, in both layouts",
        (renderSrc3.match(/: typePatterns\.get\(type\),/g) || []).length === 2,
        `${(renderSrc3.match(/: typePatterns\.get\(type\),/g) || []).length} layouts`);

    // Paint, not geometry: the key must not know about it, and the raw-blob
    // trigger must still bring the stages round so it reaches the diagram.
    const keySrc = fs.readFileSync(path.join(ROOT, "src", "geometryKey.ts"), "utf8");
    check("a texture is not a geometry input",
        !/pattern/i.test(keySrc));
    check("...but the raw blob still forces the stages that resolve it",
        /flowColoursChanged = flowColoursRaw !== this\.cachedFlowColoursRaw/
            .test(fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8")));
}

// --------------------------------------- 4d. an outline per flow type
console.log("\n-- 4d. a flow type can be outlined, solid or dashed --");
{
    const edged = resolve(new Map([["Bio", { outline: "dashed" }]]));
    check("the outline style is reported for the bands",
        edged.outlines.get("Bio") === "dashed", JSON.stringify([...edged.outlines]));
    check("...and a type without one is absent, meaning no edge",
        edged.outlines.has("Coal") === false);
    check("...while the colour and the texture are untouched",
        /^#auto-/.test(edged.colours.get("Bio")) && edged.patterns.has("Bio") === false);

    check("only the two styles are accepted",
        withFlowTypeEdit(new Map(), "Bio", { outline: "dotted" }).size === 0,
        "dotted refused");
    check("the blob round-trips an outline",
        parseFlowTypeColours(serialiseFlowTypeColours(
            new Map([["Bio", { outline: "solid" }]]))).get("Bio")?.outline === "solid");
    check("...and drops an unknown style on read",
        parseFlowTypeColours('{"Bio":{"o":"wavy"}}').size === 0);

    // All four fields are independent: this is the whole reason the patch takes
    // one field at a time rather than a whole edit.
    let all = withFlowTypeEdit(new Map(), "Bio", { colour: "#ff0000" });
    all = withFlowTypeEdit(all, "Bio", { label: "Solid biomass" });
    all = withFlowTypeEdit(all, "Bio", { pattern: 1 });
    all = withFlowTypeEdit(all, "Bio", { outline: "dashed" });
    check("all four fields coexist on one type",
        all.get("Bio")?.colour === "#ff0000" && all.get("Bio")?.label === "Solid biomass"
        && all.get("Bio")?.pattern === 1 && all.get("Bio")?.outline === "dashed",
        JSON.stringify(all.get("Bio")));
    const lessOne = withFlowTypeEdit(all, "Bio", { pattern: null });
    check("...and clearing one leaves the other three",
        lessOne.get("Bio")?.pattern === undefined
        && lessOne.get("Bio")?.colour === "#ff0000"
        && lessOne.get("Bio")?.label === "Solid biomass"
        && lessOne.get("Bio")?.outline === "dashed");
    check("...and the round trip survives all four",
        JSON.stringify(parseFlowTypeColours(serialiseFlowTypeColours(all)).get("Bio"))
            === JSON.stringify(all.get("Bio")),
        JSON.stringify(parseFlowTypeColours(serialiseFlowTypeColours(all)).get("Bio")));

    const renderSrc4 = require("./sources.js").renderSource();
    // **The same element as high contrast's**, on `band.edges` -- the two LONG
    // edges. An outline round the closed path would draw a line across the flow
    // at both node faces, which is the defect earlier exists to have fixed.
    check("it is drawn on the open edges, not round the closed band",
        /if \(hatches \|\| authorStyle !== undefined\) \{[\s\S]{0,200}?outline\.setAttribute\("d", band\.edges\)/
            .test(renderSrc4));
    check("...dashed in pixels, so a zoom does not change the line type",
        /stroke-dasharray", "4 3"/.test(renderSrc4));
    check("...and high contrast's ink wins where both apply",
        /hatches \? \(hatchInk as string\) : \(authorOutline\?\.ink/.test(renderSrc4));
    check("...with the author's style ignored in high contrast",
        (renderSrc4.match(/hatching \? undefined : \{\s*\n\s*styles: flowTypeColours\.outlines/g)
            || []).length === 2);

    // **And it reaches the ARROWS** . It did not: the stripe-outline block was gated on `hatching`
    // alone, so a dashed flow type got a dashed band edge and then nothing from
    // the node face inward -- the outline stopping exactly where the flow is
    // meant to continue. The same mistake as hatching, for the same
    // reason: `renderNodes` was not handed what the bands were.
    //
    // Asserted as ONE expression used twice rather than two conditions that
    // happen to agree, because a second copy is what drifts.
    const outlineArg = /hatching \? undefined : \{\s*\n\s*styles: flowTypeColours\.outlines,\s*\n\s*untyped: flowTypeColours\.paneOutline,\s*\n\s*ink: outlineInk\s*\n\s*\}/g;
    // **The ink is one value, and the pane may choose it** . Automatic is the theme foreground, so no report
    // moves; Custom is the picker. The same `outlineInk` is what both sites take.
    check("outlineInk is the custom colour only when Outline colour is Custom, else the foreground",
        /const outlineInk = String\(corridorsCard\.outlineColourMode\?\.value\?\.value\) === "Custom"\s*\n\s*\? \(corridorsCard\.outlineColour\?\.value\?\.value \?\? colorPalette\.foreground\.value\)\s*\n\s*: colorPalette\.foreground\.value;/.test(renderSrc4));
    check("the arrows are handed the SAME author outline the bands are",
        (renderSrc4.match(outlineArg) || []).length === 2,
        `${(renderSrc4.match(outlineArg) || []).length} call sites`);
    check("...and an arrow is outlined for the AUTHOR's style, not only hatching",
        /if \(\(hatching \|\| stripeStyle !== undefined\) && stripe\.outline !== ""\)/
            .test(renderSrc4));
    check("...dashed in the same pixels as its band, or the line type changes at the join",
        /if \(!hatching && stripeStyle === "dashed"\) \{[\s\S]{0,260}?stroke-dasharray", "4 3"/
            .test(renderSrc4));
    check("...and the style is read per STRIPE's own flow type",
        /const stripeStyle = stripe\.flowType !== undefined\s*\?\s*authorOutline\?\.styles\?\.get\(stripe\.flowType\)/
            .test(renderSrc4));
    const keySrc2 = fs.readFileSync(path.join(ROOT, "src", "geometryKey.ts"), "utf8");
    check("an outline is not a geometry input either",
        !/outline/i.test(keySrc2));
}

// ------------------- 4f. the PANE asks, the editor overrules
console.log("\n-- 4f. Flows > Colour > Texture and Outline, with the editor on top --");
{
    // .
    //
    // Precedence is the whole of it, and it is the same shape as the colour's:
    // the panel's own choice wins, the pane fills in the rest, and "off" in the
    // panel is a CHOICE that the pane must not fill back in. That last one is
    // why the stored values have `FLOW_PATTERN_NONE` and `outline: "none"` at
    // all -- without them an author could not hold one type flat while the
    // others follow Automatic, which is precisely what "custom in the editor"
    // has to mean.
    const NONE = { texture: "None", outline: "None" };
    const AUTO = { texture: "Hatching", outline: "None" };
    const AUTO_PATTERN = { texture: "Pattern", outline: "None" };

    // The shipped state is unchanged, which is what makes this safe to add: a
    // report that has never seen these settings draws exactly as it did.
    const off = resolveWith(NONE, new Map());
    check("with the pane at None nothing is textured or outlined",
        off.patterns.size === 0 && off.outlines.size === 0
        && off.paneOutline === undefined,
        `${off.patterns.size} textures, ${off.outlines.size} outlines`);
    check("...and that is the same as not passing the pane's settings at all",
        JSON.stringify([...resolve(new Map()).patterns]) === JSON.stringify([...off.patterns]));

    // ORDER matters: the index is the type's legend rank, which is exactly what
    // `hatchIndexOf` uses in high contrast -- so a type keeps its texture when
    // the viewer switches modes, and the allocation does not move when a slicer
    // changes which corridor comes first.
    const auto = resolveWith(AUTO, new Map());
    check("Texture Automatic gives every flow type a texture",
        auto.patterns.size === auto.order.length, `${auto.patterns.size} of ${auto.order.length}`);
    check("...allocated by LEGEND RANK, the index high contrast hatches by",
        auto.order.every((type, rank) => auto.patterns.get(type) === rank % 6),
        auto.order.map(t => `${t}=${auto.patterns.get(t)}`).join(" "));
    const autoPat = resolveWith(AUTO_PATTERN, new Map());
    check("Auto-pattern gives every type a graphic pattern, after the hatches in the index space",
        autoPat.order.every((type, rank) => autoPat.patterns.get(type) === 6 + (rank % 8)),
        autoPat.order.map(t => `${t}=${autoPat.patterns.get(t)}`).join(" "));
    check("...and it cycles rather than running out, past the sixth type",
        (() => {
            const many = [];
            for (let i = 0; i < 8; i++) {
                many.push({ rowIndex: i, flowID: `f${i}`, source: "A", target: "B",
                    value: 1, flowType: `T${i}` });
            }
            const wide = resolveWith(AUTO, new Map(), many);
            return wide.patterns.size === 8
                && wide.patterns.get(wide.order[6]) === 0
                && wide.patterns.get(wide.order[7]) === 1;
        })());

    // **The palette sequence is still unmoved** -- assertion 2's point, retested
    // because the pane default now runs inside the same loop. Asking for a
    // texture must not change which COLOUR a type gets.
    check("the pane's texture does not shift any automatic colour",
        JSON.stringify([...auto.colours]) === JSON.stringify([...off.colours]),
        [...auto.colours].map(([t, c]) => `${t}=${c}`).join(" "));

    // The editor on top, in both directions.
    const picked = resolveWith(AUTO, new Map([["Coal", { pattern: 4 }]]));
    check("a texture chosen in the editor beats the pane's allocation",
        picked.patterns.get("Coal") === 4, `Coal=${picked.patterns.get("Coal")}`);
    check("...and leaves the other types on the pane's",
        picked.patterns.get("Bio") === auto.patterns.get("Bio")
        && picked.patterns.get("Heat") === auto.patterns.get("Heat"));
    const held = resolveWith(AUTO, new Map([["Coal", { pattern: FLOW_PATTERN_NONE }]]));
    check("FLOW_PATTERN_NONE holds one type FLAT against the pane's Automatic",
        held.patterns.has("Coal") === false && held.patterns.size === auto.order.length - 1,
        `${held.patterns.size} textured, Coal ${held.patterns.has("Coal") ? "textured" : "flat"}`);

    // `autoPatterns` is what the editor's own `Auto` row is labelled from, so it
    // is filled for EVERY type, including the ones that override it.
    check("the pane's allocation is reported even where the editor overrides it",
        held.autoPatterns.get("Coal") === auto.patterns.get("Coal")
        && picked.autoPatterns.get("Coal") === auto.patterns.get("Coal"),
        `Coal auto=${held.autoPatterns.get("Coal")}`);
    check("...and is empty while the pane asks for no texture",
        off.autoPatterns.size === 0);

    // The outline, the same four ways.
    const edged = resolveWith({ texture: "None", outline: "Dashed" }, new Map());
    check("Outline Dashed outlines every flow type",
        edged.outlines.size === edged.order.length
        && edged.order.every(t => edged.outlines.get(t) === "dashed"));
    check("...and is reported for a flow with no TYPE at all, which no map can hold",
        edged.paneOutline === "dashed");
    const solid = resolveWith({ texture: "None", outline: "Solid" }, new Map());
    check("Outline Solid likewise",
        solid.paneOutline === "solid"
        && solid.order.every(t => solid.outlines.get(t) === "solid"));
    check("an outline chosen in the editor beats the pane's",
        resolveWith({ texture: "None", outline: "Dashed" },
            new Map([["Coal", { outline: "solid" }]])).outlines.get("Coal") === "solid");
    const unedged = resolveWith({ texture: "None", outline: "Dashed" },
        new Map([["Coal", { outline: "none" }]]));
    check("...and \"none\" holds one type UNEDGED against the pane's",
        unedged.outlines.has("Coal") === false
        && unedged.outlines.get("Bio") === "dashed",
        `Coal ${unedged.outlines.has("Coal") ? unedged.outlines.get("Coal") : "no edge"}`);
    // The untyped outline is the pane's, never an editor choice: there is no
    // type to have chosen one.
    check("the untyped outline follows the pane even where a type overrides it",
        unedged.paneOutline === "dashed");

    // An unknown value from the pane is read as off rather than thrown on: a
    // report saved by a future build, or a hand-edited theme file.
    const odd = resolveWith({ texture: "Wavy", outline: "Double" }, new Map());
    check("an unknown pane value reads as None rather than throwing",
        odd.patterns.size === 0 && odd.outlines.size === 0 && odd.paneOutline === undefined);

    // And the pane is NOT a geometry input, for the reason the editor's choices
    // are not: a texture and an outline move nothing.
    const keySrc3 = fs.readFileSync(path.join(ROOT, "src", "geometryKey.ts"), "utf8");
    check("neither pane setting is a geometry input",
        !/flowTexture/.test(keySrc3) && !/flowOutline/.test(keySrc3));
}

// ------------------------- 4e. an outline costs the flow no width
console.log("\n-- 4e. an outlined flow is still exactly as wide as its value --");
{
    //
    // It did. SVG has no stroke alignment -- a stroke is centred on its path --
    // so half of a 1px outline fell OUTSIDE the band. The painted extent grew
    // by 1px whatever the band carried: 1.7% on a 60px band and 50% on a 2px
    // one, which is the width-dependent distortion geometry.md exists to
    // prevent. On a face packed without Flow separation the outer half landed
    // on the NEIGHBOUR and overpainted it.
    //
    // The same defect `shapeElement` fixed for a node's border by insetting it.
    // A band's outline is its two long EDGES, which would have to be offset
    // inward as geometry, so the stroke is clipped to the filled shape and
    // DOUBLED instead: the inner half renders at a full pixel and nothing is
    // painted outside the band's own width.
    const renderSrc5 = require("./sources.js").renderSource();

    check("the outline is clipped to the band it belongs to",
        /outline\.setAttribute\("clip-path", insideOutline\(defs, band\.path\)\)/.test(renderSrc5));
    check("...and doubled, so the surviving inner half is a full pixel",
        /outline\.setAttribute\("stroke-width", String\(INSIDE_STROKE\)\)/.test(renderSrc5)
        && /const INSIDE_STROKE = 2;/.test(renderSrc5));
    check("...against the band's FILLED path, which is its true width",
        /function insideOutline\(defs: SVGElement, fillPath: string\)/.test(renderSrc5)
        && /shape\.setAttribute\("d", fillPath\)/.test(renderSrc5));
    check("...in userSpaceOnUse, or the clip would scale to each band's box",
        /clip\.setAttribute\("clipPathUnits", "userSpaceOnUse"\)/.test(renderSrc5));

    // The arrow has the same straddle, and an arrow wider than the band it
    // continues shows a step at the join -- the defect STRIPE_BLEED's own rule
    // exists to avoid.
    check("an arrow's outline is clipped to its stripe too",
        /edge\.setAttribute\("clip-path", insideOutline\(defs, stripe\.path\)\)/.test(renderSrc5));
    check("...and the SHAPE clip moves to a wrapper, an element taking only one",
        /holder\.setAttribute\("clip-path", clipRef\)/.test(renderSrc5));

    // Every clip needs its own id, or every outline after the first would be
    // clipped to the first band's shape and vanish.
    check("each clip gets its own id",
        /nextId\("edgeclip"\)/.test(renderSrc5));

    // And the rule the whole thing protects, stated where it can fail: nothing
    // may stroke the FILLED band path, which is what put the line outside.
    const bandBlock = /path\.setAttribute\("class", "sankeybi-band"\)[\s\S]{0,2600}?svg\.appendChild\(path\);/
        .exec(renderSrc5);
    check("the filled band itself is never stroked",
        bandBlock !== null && /path\.setAttribute\("stroke", "none"\)/.test(bandBlock[0])
        && !/path\.setAttribute\("stroke", (?!"none")/.test(bandBlock[0]),
        bandBlock ? "unstroked" : "band block not found");
}

// ---------------------------------------- 5. it reaches the diagram at all
console.log("\n-- 5. a colour change re-runs the stage that resolves it --");
{
    const visualSrc = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");
    check("the blob is read off metadata.objects by name",
        /\["corridors"\]\?\.\["flowTypeColours"\]/.test(visualSrc));
    check("a change to it is tracked by raw string, as the node edits are",
        /flowColoursChanged = flowColoursRaw !== this\.cachedFlowColoursRaw/.test(visualSrc));
    // THE assertion: without this the pick does nothing until the next data
    // change, because `colours.ts` runs only inside the dataChanged branch.
    check("...and that flag is one of the things that forces the data stages",
        /dataChanged =[\s\S]{0,400}?\|\|\s*flowColoursChanged\b/.test(visualSrc));
    check("the overrides are handed to the ONE function that decides a colour",
        /resolveFlowTypeColours\(\s*\n?\s*corridors, this\.colorPalette, this\.host\.locale, this\.flowTypeOverrides,\s*\n?\s*flowPaint\)/
            .test(visualSrc));

    // **The pane's Texture and Outline are data-stage inputs too**,
    // and for the identical reason: they are resolved by the same function,
    // inside the same branch. Tracked apart from the blob's raw string so a
    // pane change does not re-PARSE the blob -- it changes what is resolved
    // from it, not what it says.
    check("the pane's texture and outline are tracked as well",
        /flowPaintChanged = flowPaintRaw !== this\.cachedFlowPaintRaw/.test(visualSrc));
    check("...and force the data stages with the blob",
        /dataChanged =[\s\S]{0,500}?\|\|\s*flowPaintChanged\b/.test(visualSrc));
    check("...read from the Flows card, not from a second copy of the rule",
        /texture: String\(this\.formattingSettings\.corridorsCard\.flowTexture\.value\.value\)/
            .test(visualSrc)
        && /outline: String\(this\.formattingSettings\.corridorsCard\.flowOutline\.value\.value\)/
            .test(visualSrc));
    // And the editor's rows show what is STORED, never what is drawn: filled
    // from the resolved maps, every type would open looking set by hand and
    // `Auto` could not be offered at all.
    check("the editor's rows are filled from the STORED edits, not the resolved ones",
        /\.\.\.\(stored\?\.pattern !== undefined \? \{ pattern: stored\.pattern \} : \{\}\)/
            .test(visualSrc)
        && /\.\.\.\(stored\?\.outline !== undefined \? \{ outline: stored\.outline \} : \{\}\)/
            .test(visualSrc));
    // The other end of the same rule: the persist must leave the cached raw
    // string alone, or the update it triggers sees nothing changed.
    const persist = /private persistFlowColour\([\s\S]*?\n    \}/.exec(visualSrc);
    check("the persist leaves the cached raw string stale, so the update sees the change",
        persist !== null && !/cachedFlowColoursRaw\s*=/.test(persist[0]),
        persist ? "found" : "persistFlowColour not found");
    check("...and the reset clears the blob and its button together",
        /flowTypeColours: "", resetFlowColours: false/.test(visualSrc));
}

// -------------------------------------------------- 6. not a geometry input
console.log("\n-- 6. a colour moves no geometry --");
{
    const key = fs.readFileSync(path.join(ROOT, "src", "geometryKey.ts"), "utf8");
    check("the geometry key knows nothing about flow type colours",
        !/flowTypeColours|flowTypeOverrides/.test(key));
    const cap = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));
    check("the blob is declared, or it could not be persisted",
        cap.objects.corridors.properties.flowTypeColours !== undefined);
    check("...and so are the two buttons",
        cap.objects.corridors.properties.editFlowColours !== undefined
        && cap.objects.corridors.properties.resetFlowColours !== undefined);
    const settingsSrc = require("./sources.js").settingsSource();
    check("the blob has no slice, so a wall of JSON never appears in the pane",
        !/name: "flowTypeColours"/.test(settingsSrc));
}

// ------------------------------------- 7. the colour with no flow type
console.log("\n-- 7. the Flow colour picker, for flows with no type --");
{
    const renderSrc = require("./sources.js").renderSource();
    const visualSrc2 = fs.readFileSync(path.join(ROOT, "src", "visual.ts"), "utf8");
    const settingsSrc = require("./sources.js").settingsSource();
    const cap2 = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities.json"), "utf8"));

    check("it is a real pane picker, so it carries the theme's own swatches",
        /defaultFlowColour = new formattingSettings\.ColorPicker/.test(settingsSrc));
    check("...declared as a fill, or it could never be stored",
        cap2.objects.corridors.properties.defaultFlowColour?.type?.fill?.solid?.color === true);
    check("render takes the author's colour for a band with no type",
        /settings\.corridorsCard\?\.defaultFlowColour\?\.value\?\.value \?\? themeCorridor/
            .test(renderSrc));
    // The same trap as section 2, in its other place: the palette has to be
    // asked whether or not the author has set a colour, or every flow type's
    // automatic colour shifts by a slot.
    check("...but asks the palette regardless, so no flow type is recoloured",
        /const themeCorridor = colorPalette\.getColor\("sankeybi-corridor"\)\.value;/.test(renderSrc));
    // And the same again for the ORDER: this key must be asked for AFTER the
    // flow types, which is the order render has always asked in.
    check("...and asks for it after the flow types, holding the sequence",
        /note\(flowTypeColours\.warnings\);[\s\S]{0,300}?getColor\("sankeybi-corridor"\)/
            .test(visualSrc2));
    check("the pane shows the theme's colour until the author sets one",
        /\["corridors"\]\?\.\["defaultFlowColour"\] === undefined/.test(visualSrc2));

    // The buttons it was renamed: the group already says Colour, so the names
    // need not say flow colours again.
    check("the editor button is 'Show editor', in its own Per Flow Type group",
        /name: "editFlowColours",\s*\n\s*displayName: "Show editor"/.test(settingsSrc)
        && /group\("flowsPerType", "Per Flow Type",\s*\[this\.flowTexture, this\.textureColourMode, this\.textureColour,\s*this\.textureBackgroundMode, this\.textureBackground,\s*this\.editFlowColours, this\.resetFlowColours\]\)/
            .test(settingsSrc));
    check("the textures are in Per Flow Type, not Colour",
        (/group\("flowsColour", "Colour",\s*\[([^\]]*)\]/.exec(settingsSrc) || [, "flowTexture"])[1]
            .indexOf("flowTexture") === -1);
    check("Per Flow Type is DISABLED, with a reason, when no flow types exist",
        /onPreProcess\(\): void \{[\s\S]*?g\.name === "flowsPerType"[\s\S]*?perType\.disabled = this\.noFlowTypes;[\s\S]*?disabledReason/
            .test(settingsSrc));
    check("...and the visual sets that from the resolved flow types before building the pane",
        /corridorsCard\.noFlowTypes =\s*\(this\.cachedFlowTypeColours\?\.order\.length \?\? 0\) === 0/
            .test(visualSrc2));
    check("the reset is 'Reset colour edits'",
        /name: "resetFlowColours",\s*\n\s*displayName: "Reset colour edits"/.test(settingsSrc));
}

// --------------------------- 8. the swatches were tried and withdrawn
console.log("\n-- 8. the picker is the control, and the swatches are gone --");
{
    const panelSrc = fs.readFileSync(path.join(ROOT, "src", "flowColourPanel.ts"), "utf8");
    // the code once replaced each row's native picker with a row of theme swatches
    // and 266 put the picker back: the swatches could only ever offer colours
    // the diagram already had, so a type's colour could be swapped for another
    // type's but a new one could not be introduced at all . The constraint is permanent --
    // a theme's data colours cannot be enumerated without consuming palette
    // slots and recolouring the very types being edited -- so this asserts the
    // absence rather than leaving it to be rediscovered.
    check("a row carries a real colour picker",
        /picker\.type = "color";/.test(panelSrc));
    check("...and no swatch row", !/sankeybi-flowcolour-swatch/.test(panelSrc));
    check("...and still never asks the palette, which would shift the sequence",
        !/getColor\(/.test(panelSrc));
    const coloursSrc = fs.readFileSync(path.join(ROOT, "src", "colours.ts"), "utf8");
    check("the automatic colours the swatches needed are gone with them",
        !/autoColours/.test(coloursSrc));
    const lessSrc = fs.readFileSync(path.join(ROOT, "style", "visual.less"), "utf8");
    check("...and so are their styles",
        !/flowcolour-swatch|flowcolour-now/.test(lessSrc));
}

// ------------------------- 9. the editor's dropdowns are OURS
console.log("\n-- 9. the editor's dropdowns are our own elements --");
{
    //
    //
    // They were `<select>`s. A native select's list is NOT part of the page:
    // the browser draws its own popup and positions it from where it believes
    // the box is on SCREEN. A Power BI custom visual is a sandboxed iframe
    // inside a report canvas the host scrolls, scales and transforms, and the
    // popup landed wherever that arithmetic came out. Nothing inside the page
    // can fix it, because the thing in the wrong place is not in the page.
    //
    // So the list is an element we own (`panelMenu.ts`). What is asserted is
    // what the defect was: WHERE the list ends up, and whose coordinates it is
    // in. Everything else here is the wiring the `<select>`s used to do.
    class El {
        constructor(tag) {
            this.tag = tag; this.children = []; this.parent = null;
            this.handlers = new Map(); this.attributes = {};
            this.style = {}; this.className = ""; this.value = ""; this._text = "";
            this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
            this.clientWidth = 0; this.clientHeight = 0;
            this.offsetLeft = 0; this.offsetTop = 0;
        }
        // A menu's size is its content's, and `panelMenu` measures it AFTER
        // appending in order to decide whether it fits below its button. A fake
        // that reports 0 can never flip one, so the rule the real layout would
        // apply is stated here instead: a row is 20px and the box has 4px of
        // padding.
        get offsetHeight() {
            if (this._h !== undefined) { return this._h; }
            // The stylesheet caps a list at 220px and scrolls the rest.
            return this.className === "sankeybi-menu-list" ? Math.min(220, this.children.length * 20 + 4) : 0;
        }
        set offsetHeight(v) { this._h = v; }
        get offsetWidth() { return this.className === "sankeybi-menu-list" ? 92 : 0; }
        set offsetWidth(v) { this._w = v; }
        appendChild(c) { c.parent = this; this.children.push(c); return c; }
        removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; return c; }
        remove() { if (this.parent) { this.parent.removeChild(this); } }
        contains(n) { return n === this || this.children.some(c => c.contains(n)); }
        get firstChild() { return this.children[0] ?? null; }
        addEventListener(t, fn) {
            if (!this.handlers.has(t)) { this.handlers.set(t, []); }
            this.handlers.get(t).push(fn);
        }
        removeEventListener(t, fn) {
            this.handlers.set(t, (this.handlers.get(t) || []).filter(f => f !== fn));
        }
        fire(t, e = {}) {
            (this.handlers.get(t) || []).forEach(fn =>
                fn(Object.assign({ preventDefault() {}, stopPropagation() {}, target: this }, e)));
        }
        setAttribute(n, v) { this.attributes[n] = String(v); }
        getAttribute(n) { return this.attributes[n] ?? null; }
        getBoundingClientRect() { return this.rect; }
        focus() {}
        get tagName() { return this.tag.toUpperCase(); }
        setPointerCapture() {}
        releasePointerCapture() {}
        hasPointerCapture() { return false; }
        set textContent(v) { this._text = v; this.children = []; }
        get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
        all() { return this.children.reduce((a, c) => a.concat(c.all()), [this]); }
    }
    const docHandlers = new Map();
    global.document = {
        createElement: tag => new El(tag),
        addEventListener: (t, fn) => {
            if (!docHandlers.has(t)) { docHandlers.set(t, []); }
            docHandlers.get(t).push(fn);
        },
        removeEventListener: (t, fn) =>
            docHandlers.set(t, (docHandlers.get(t) || []).filter(f => f !== fn))
    };
    const fireDoc = (t, e) => (docHandlers.get(t) || []).slice().forEach(fn => fn(e));

    const { FlowColourPanel } = require("./lib/flowColourPanel.js");

    const root = new El("div");
    root.clientWidth = 400;
    root.clientHeight = 400;
    root.rect = { left: 30, top: 20, right: 430, bottom: 320, width: 400, height: 300 };
    const picks = [];
    const panel = new FlowColourPanel(root, (type, patch) => picks.push([type, patch]));
    panel.setModel([
        // Unset, so both of its controls read Auto.
        { type: "Bio", drawn: "#118811", shownAs: "Bio", autoPattern: 0, autoOutline: "dashed" },
        // Held OFF by hand against a pane that is asking for both.
        { type: "Coal", drawn: "#222222", shownAs: "Coal",
          pattern: FLOW_PATTERN_NONE, outline: "none", autoPattern: 1, autoOutline: "dashed" },
        // Set to something by hand.
        { type: "Heat", drawn: "#884400", shownAs: "Heat", pattern: 4, outline: "solid",
          autoPattern: 2, autoOutline: "dashed" }
    ], new Map([
        ["Coal", { pattern: FLOW_PATTERN_NONE, outline: "none" }],
        ["Heat", { pattern: 4, outline: "solid" }]
    ]));
    panel.open();

    const menuButtons = root.all().filter(e =>
        e.tag === "button" && e.className.includes("sankeybi-menu-button"));
    check("every row has two menu buttons, and no <select> is left",
        menuButtons.length === 6 && root.all().every(e => e.tag !== "select"),
        `${menuButtons.length} menu buttons, ${root.all().filter(e => e.tag === "select").length} selects`);

    // The button says what is CURRENT, and for an unset field that is Auto --
    // labelled with what Auto would do, so the author does not have to go and
    // read the pane to find out.
    // The BUTTON says "Auto" and the MENU says what Auto amounts to. The
    // button is one column of a row and holds a fixed width, so a label that
    // can read "Auto (Horizontal)" would ellipsise on exactly the rows the
    // author most needs to read -- and the detail belongs where the choice is
    // made. The title carries it too, for a reader who never opens the list.
    check("an unset texture reads as Auto on the button",
        menuButtons[0].textContent.trim().startsWith("Auto"), menuButtons[0].textContent);
    check("...and the full \"Auto (Forward)\" is in the menu and the tooltip",
        String(menuButtons[0].title).includes("gives this type Forward"),
        menuButtons[0].title);
    check("an unset outline likewise",
        menuButtons[1].textContent.trim().startsWith("Auto")
        && String(menuButtons[1].title).includes("which is dashed"),
        menuButtons[1].title);
    check("a type held flat by hand reads as Flat, not as Auto",
        menuButtons[2].textContent.includes("Flat"), menuButtons[2].textContent);
    check("...and one held unedged reads as No edge",
        menuButtons[3].textContent.includes("No edge"), menuButtons[3].textContent);
    check("a type SET by hand reads as what it is set to",
        menuButtons[4].textContent.includes("Cross")
        && menuButtons[5].textContent.includes("Solid"),
        `${menuButtons[4].textContent} / ${menuButtons[5].textContent}`);
    // Which is the whole point of filling the rows from what is STORED: all
    // three states are distinguishable in the control itself.
    check("...so Auto, off-by-hand and set-by-hand are three different labels",
        new Set([menuButtons[0].textContent, menuButtons[2].textContent,
            menuButtons[4].textContent]).size === 3);

    // **THE assertion.** The list is a child of the ROOT we were handed, in the
    // root's own coordinates -- not a child of the row, whose `overflow: auto`
    // would clip it, and not a popup the browser places for us.
    const lists = () => root.children.filter(e =>
        e.className === "sankeybi-menu-list");
    menuButtons[0].rect = { left: 120, top: 100, right: 200, bottom: 118, width: 80, height: 18 };
    menuButtons[0].offsetHeight = 18;
    menuButtons[0].fire("click");
    check("opening a menu puts the list in the ROOT, not in the scrolling row list",
        lists().length === 1 && lists()[0].parent === root);
    check("...placed in the root's own coordinates, under the button",
        lists()[0].style.left === "90px" && lists()[0].style.top === "100px",
        `${lists()[0].style.left} / ${lists()[0].style.top}`);

    // A second menu closes the first, as a native popup would, so nothing else
    // has to know a menu is open.
    menuButtons[1].rect = { left: 220, top: 100, right: 300, bottom: 118, width: 80, height: 18 };
    menuButtons[1].fire("click");
    check("a second menu closes the first", lists().length === 1);

    // Picking calls through with the patch the <select> used to send, including
    // the two states that are the point of earlier.
    const items = () => lists()[0].children.filter(e => e.tag === "button");
    const pick = label => {
        const row = items().find(e => e.textContent === label);
        check(`the menu offers "${label}"`, row !== undefined,
            items().map(e => e.textContent).join(" | "));
        row?.fire("click");
    };
    pick("Dashed");
    check("picking an outline sends it through",
        JSON.stringify(picks[picks.length - 1]) === JSON.stringify(["Bio", { outline: "dashed" }]),
        JSON.stringify(picks[picks.length - 1]));
    check("...and picking closes the list", lists().length === 0);

    menuButtons[1].fire("click");
    pick("Auto (dashed)");
    check("Auto clears the stored outline, which is follow-the-pane",
        JSON.stringify(picks[picks.length - 1]) === JSON.stringify(["Bio", { outline: null }]),
        JSON.stringify(picks[picks.length - 1]));

    menuButtons[1].fire("click");
    pick("No edge");
    check("No edge STORES \"none\", which the pane cannot fill back in",
        JSON.stringify(picks[picks.length - 1]) === JSON.stringify(["Bio", { outline: "none" }]),
        JSON.stringify(picks[picks.length - 1]));

    menuButtons[0].fire("click");
    pick("Flat");
    check("Flat stores FLOW_PATTERN_NONE, for the same reason",
        JSON.stringify(picks[picks.length - 1])
            === JSON.stringify(["Bio", { pattern: FLOW_PATTERN_NONE }]),
        JSON.stringify(picks[picks.length - 1]));
    menuButtons[0].fire("click");
    pick("Cross");
    check("...and a named texture stores its index",
        JSON.stringify(picks[picks.length - 1]) === JSON.stringify(["Bio", { pattern: 4 }]),
        JSON.stringify(picks[picks.length - 1]));

    // A click anywhere else closes it, and the handler is taken off the
    // document again -- a listener left behind would keep the row alive after
    // the list it closes has gone.
    menuButtons[0].fire("click");
    check("a menu is open to dismiss", lists().length === 1);
    fireDoc("pointerdown", { target: root });
    check("a click outside closes the menu", lists().length === 0);
    check("...and the document listener is removed with it",
        (docHandlers.get("pointerdown") || []).length === 0,
        `${(docHandlers.get("pointerdown") || []).length} left`);

    // Opening near the bottom flips the list ABOVE its button: clamping alone
    // would slide it up over the control that opened it.
    menuButtons[0].rect = { left: 120, top: 290, right: 200, bottom: 308, width: 80, height: 18 };
    menuButtons[0].fire("click");
    check("a menu near the bottom opens upwards", Number(lists()[0].style.top.replace("px", "")) < 270,
        `top ${lists()[0].style.top}, button bottom 288`);
    check("...and still inside the visual",
        Number(lists()[0].style.top.replace("px", "")) >= 8);

    // **Reset puts a row back to the defaults — all four of them** (the author,
    // ). It cleared the colour and the name, which was
    // the whole of a row when it was written; a row has had a texture since
    // earlier and an outline, so a reset row still did not
    // look like an untouched one.
    // A Reset is always laid out (so the texture and border
    // columns stay under their titles) and HIDDEN where there is nothing to
    // reset, so "offers a Reset" is "has a visible one".
    const resets = () => root.all().filter(e =>
        e.tag === "button" && e.textContent === "Reset" && e.style.visibility === "visible");
    check("a row with anything stored offers a Reset, and one with nothing does not",
        resets().length === 2, `${resets().length} resets for 3 rows`);
    // Specifically: offered for a type whose ONLY stored field is a texture,
    // which is the case the old two-field reset could not even be reached from
    //.
    const texOnly = new FlowColourPanel(root, () => undefined);
    texOnly.setModel(
        [{ type: "Bio", drawn: "#118811", shownAs: "Bio", pattern: 2, autoPattern: 0 }],
        new Map([["Bio", { pattern: 2 }]]));
    texOnly.open();
    check("...including one whose only stored field is a texture",
        root.all().filter(e => e.tag === "button" && e.textContent === "Reset"
            && e.style.visibility === "visible").length === 3);
    texOnly.setAvailable(false);

    picks.length = 0;
    resets()[0].fire("click");
    check("Reset clears every field, not just the colour and the name",
        JSON.stringify(picks[0]) === JSON.stringify(["Coal",
            { colour: null, label: null, pattern: null, ink: null, paper: null, outline: null }]),
        JSON.stringify(picks[0]));
    // And `null` is a removal, so the entry goes entirely: the type follows the
    // data's colour and the Flows card's texture and outline again, rather than
    // being frozen at whatever those happened to be today.
    check("...and clearing all four drops the stored entry altogether",
        withFlowTypeEdit(
            new Map([["Coal", { colour: "#ff0000", label: "C", pattern: 3, outline: "solid" }]]),
            "Coal", picks[0][1]).size === 0);

    // Closing the panel takes any open menu with it.
    panel.setAvailable(false);
    check("leaving edit mode closes the panel AND its menu", lists().length === 0);
}


console.log(`\n${assertions} assertions, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
