"use strict";
// Translations stay in step with the source.
//
//   1. stringResources/en-GB/resources.resjson holds exactly the English the source holds: every
//      format pane card, group, setting, hover text and dropdown choice (keys derived by
//      src/i18n.ts), every data role in capabilities.json, and every t("key", "English") call.
//      stringResources/en-US/resources.resjson is the same text in American spelling, made by a
//      fixed word list below, so neither English can drift from the other.
//   2. Every other language file has exactly the keys of en-GB, and the same {0}-style
//      placeholders in each text, so a language can be added by copying en-GB and translating it.
//   3. pbiviz.json lists every language file and no file that is missing.
//
// `node checks/i18n-check.js --write` regenerates en-GB and en-US from the source. Run it after changing any
// English text, then bring the other languages up to date.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const SRC = path.join(root, "src");
const RES = path.join(root, "stringResources");
const write = process.argv.includes("--write");

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log(`ok:   ${label}${detail ? ` (${detail})` : ""}`); }
    else { failures++; console.log(`FAIL: ${label}${detail ? ` (${detail})` : ""}`); }
}

// ---------------------------------------------------------------- reading the source

const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const CONCAT = new RegExp(`${STR}(?:\\s*\\+\\s*${STR})*`);
const joined = literal => [...literal.matchAll(new RegExp(STR, "g"))].map(m => JSON.parse(m[0])).join("");

const entries = new Map();
const add = (key, english) => {
    if (entries.has(key) && entries.get(key) !== english) {
        throw new Error(`key ${key} has two different English texts`);
    }
    entries.set(key, english);
};

const cards = [
    ["settingsArrange", "PositionsCardSettings"], ["settingsFlows", "CorridorsCardSettings"],
    ["settingsNodes", "NodeShapesCardSettings"], ["settingsLabels", "LabelsCardSettings"],
    ["settingsLabels", "FlowLabelsCardSettings"], ["settingsLabels", "ValuesCardSettings"],
    ["settingsLegend", "LegendCardSettings"], ["settingsBackground", "BackgroundCardSettings"],
    ["settingsInteraction", "InteractionCardSettings"]
];

/** Every `const NAME: IEnumMember[] = [ {value, displayName}, ... ]` in a file. */
function choiceLists(src) {
    const lists = {};
    const re = /const (\w+): IEnumMember\[\] = \[([\s\S]*?)\n\];/g;
    let m;
    while ((m = re.exec(src))) {
        lists[m[1]] = [...m[2].matchAll(/value: "([^"]*)", displayName: "([^"]*)"/g)].map(x => [x[1], x[2]]);
    }
    return lists;
}

for (const [file, cls] of cards) {
    const whole = fs.readFileSync(path.join(SRC, `${file}.ts`), "utf8");
    const start = whole.indexOf(`export class ${cls}`);
    const next = whole.indexOf("\nexport class", start + 10);
    const body = whole.slice(start, next < 0 ? undefined : next);
    const lists = choiceLists(whole);
    const cardName = /\bname: string = "(\w+)"/.exec(body)[1];
    add(cardName, /\bdisplayName: string = "([^"]+)"/.exec(body)[1]);

    const sliceRe = new RegExp(
        `name: "(\\w+)",\\s*\\n\\s*displayName: "([^"]+)",(?:\\s*\\n\\s*(?://[^\\n]*\\n\\s*)*description: (${CONCAT.source}),)?(?:[\\s\\S]{0,160}?items: (\\w+))?`, "g");
    let m;
    while ((m = sliceRe.exec(body))) {
        const [, name, display, desc, items] = m;
        // `items` is only this slice's own when it appears before the next `name:`
        const between = body.slice(m.index + m[0].length - (items ? items.length + 8 : 0));
        add(`${cardName}.${name}`, display);
        if (desc) { add(`${cardName}.${name}.desc`, joined(desc)); }
        if (items && lists[items]) {
            const limit = body.indexOf('name: "', m.index + 10);
            const at = body.indexOf(`items: ${items}`, m.index);
            if (limit < 0 || at < limit) {
                for (const [value, text] of lists[items]) { add(`${cardName}.${name}.${value}`, text); }
            }
        }
        void between;
    }
    const fontRe = /fontControl\("(\w+)",\s*[\w.]+,\s*"([^"]+)"\)/g;
    while ((m = fontRe.exec(body))) {
        const [, prefix, display] = m;
        add(`${cardName}.${prefix}Font`, display);
        add(`${cardName}.${prefix}FontFamily`, "Font family");
        add(`${cardName}.${prefix}FontSize`, "Text size");
        add(`${cardName}.${prefix}Bold`, "Bold");
        add(`${cardName}.${prefix}Italic`, "Italic");
    }
    const groupRe = /group\("(\w+)",\s*"([^"]+)"/g;
    while ((m = groupRe.exec(body))) { add(`${cardName}.${m[1]}`, m[2]); }
}

const capabilities = JSON.parse(fs.readFileSync(path.join(root, "capabilities.json"), "utf8"));
for (const role of capabilities.dataRoles) {
    add(`role.${role.name}`, role.displayName);
    if (role.description) { add(`role.${role.name}.desc`, role.description); }
}

// each texture's name, which the flow type editor lists
const textures = fs.readFileSync(path.join(SRC, "textures.ts"), "utf8");
for (const m of textures.matchAll(/\bname: "([^"]+)"/g)) { add(`texture.${m[1]}`, m[1]); }

// t("key", "English") and tf("key", "English", ...) in the files that draw their own text
const callRe = new RegExp(`\\btf?\\(\\s*"([\\w.]+)",\\s*(${CONCAT.source})`, "g");
for (const file of fs.readdirSync(SRC).filter(f => f.endsWith(".ts") && f !== "i18n.ts")) {
    const text = fs.readFileSync(path.join(SRC, file), "utf8");
    let m;
    while ((m = callRe.exec(text))) { add(m[1], joined(m[2])); }
}

const english = Object.fromEntries(entries);

// ---------------------------------------------------------------- 1. en-GB and en-US

/** American spelling of the source English. Add a pair here when new text needs one. */
const AMERICAN = [[/colour/g, "color"], [/Colour/g, "Color"], [/grey/g, "gray"], [/Grey/g, "Gray"],
    [/centre/g, "center"], [/Centre/g, "Center"], [/labelled/g, "labeled"], [/behaviour/g, "behavior"]];
const american = text => AMERICAN.reduce((out, [from, to]) => out.replace(from, to), text);
const englishUS = Object.fromEntries(Object.entries(english).map(([k, v]) => [k, american(v)]));

const enPath = path.join(RES, "en-GB", "resources.resjson");
const usPath = path.join(RES, "en-US", "resources.resjson");
if (write) {
    for (const [file, table] of [[enPath, english], [usPath, englishUS]]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(table, null, 2) + "\n");
        console.log(`wrote ${Object.keys(table).length} strings to ${path.relative(root, file)}`);
    }
}
const stored = fs.existsSync(enPath) ? JSON.parse(fs.readFileSync(enPath, "utf8")) : {};
const missing = Object.keys(english).filter(k => !(k in stored));
const stale = Object.keys(stored).filter(k => !(k in english));
const changed = Object.keys(english).filter(k => k in stored && stored[k] !== english[k]);
check("en-GB has every string the source has", missing.length === 0, missing.slice(0, 3).join(", "));
check("en-GB has nothing the source no longer has", stale.length === 0, stale.slice(0, 3).join(", "));
check("en-GB text equals the source's English", changed.length === 0, changed.slice(0, 3).join(", "));
check("there are strings at all", entries.size > 200, `${entries.size} strings`);

// ---------------------------------------------------------------- 2. other languages

const placeholders = text => (String(text).match(/\{\d+\}/g) || []).sort().join(",");
const locales = fs.existsSync(RES) ? fs.readdirSync(RES).filter(d => d !== "en-GB") : [];
for (const locale of locales) {
    const file = path.join(RES, locale, "resources.resjson");
    if (!fs.existsSync(file)) { check(`${locale} has a resources.resjson`, false); continue; }
    const other = JSON.parse(fs.readFileSync(file, "utf8"));
    const lacking = Object.keys(english).filter(k => !(k in other));
    const extra = Object.keys(other).filter(k => !(k in english));
    const broken = Object.keys(other).filter(k => k in english && placeholders(other[k]) !== placeholders(english[k]));
    const long = Object.keys(other).filter(k => k.endsWith(".desc") && !k.startsWith("role.") && String(other[k]).length > 160);
    check(`${locale} has every key`, lacking.length === 0, lacking.slice(0, 3).join(", "));
    check(`${locale} has no unknown key`, extra.length === 0, extra.slice(0, 3).join(", "));
    check(`${locale} keeps every {n} placeholder`, broken.length === 0, broken.slice(0, 3).join(", "));
    check(`${locale} keeps hover texts short enough to read`, long.length === 0, long.slice(0, 3).join(", "));
}

const us = fs.existsSync(usPath) ? JSON.parse(fs.readFileSync(usPath, "utf8")) : {};
const usOff = Object.keys(englishUS).filter(k => us[k] !== englishUS[k]);
check("en-US is the source English in American spelling", usOff.length === 0, usOff.slice(0, 3).join(", "));
check("no British spelling is left in en-US", !Object.values(us).some(v => /colour|grey|centre|labelled|behaviour/i.test(v)));

// ---------------------------------------------------------------- 3. pbiviz.json

const pbiviz = JSON.parse(fs.readFileSync(path.join(root, "pbiviz.json"), "utf8"));
const listed = pbiviz.stringResources || [];
const onDisk = ["en-GB", ...locales].map(l => `stringResources/${l}/resources.resjson`);
check("pbiviz.json lists every language file", onDisk.every(f => listed.includes(f)),
    onDisk.filter(f => !listed.includes(f)).join(", "));
check("pbiviz.json lists no missing file", listed.every(f => fs.existsSync(path.join(root, f))),
    listed.filter(f => !fs.existsSync(path.join(root, f))).join(", "));

// ---------------------------------------------------------------- 4. the data roles are keyed

check("every data role names its translation keys",
    capabilities.dataRoles.every(r => r.displayNameKey === `role.${r.name}`
        && (!r.description || r.descriptionKey === `role.${r.name}.desc`)));

// ---------------------------------------------------------------- 5. the runtime

const { setLocalizer, t, tf, localiseModel } = require("./lib/i18n.js");
const manager = table => ({ getDisplayName: key => table[key] });

check("without a localiser the English comes back", t("ui.done", "Done") === "Done");
setLocalizer(manager({ "ui.done": "Fertig" }));
check("a translated key is used", t("ui.done", "Done") === "Fertig");
check("a key with no translation reads as its English", t("ui.cancel", "Cancel") === "Cancel");
setLocalizer(manager({ "ui.cancel": "ui.cancel" }));
check("a host that answers with the key itself reads as English", t("ui.cancel", "Cancel") === "Cancel");
setLocalizer({ getDisplayName: () => { throw new Error("no resources"); } });
check("a host that throws reads as English", t("ui.done", "Done") === "Done");
setLocalizer(manager({ "ui.x": "{1} von {0}" }));
check("placeholders are filled in the translated order", tf("ui.x", "{0} of {1}", "a", "b") === "b von a");

const model = {
    cards: [{
        name: "flows", displayName: "Flows",
        groups: [{
            name: "route", displayName: "Route",
            slices: [{
                name: "style", displayName: "Routing style", description: "How routes bend.",
                items: [{ value: "Smooth", displayName: "Smooth" }]
            }, {
                name: "legendFont", displayName: "Font",
                fontFamily: { name: "legendFontFamily", displayName: "Font family" }
            }]
        }]
    }]
};
setLocalizer(manager({
    "flows": "Flüsse", "flows.route": "Verlauf", "flows.style": "Verlaufsart", "flows.style.desc": "Wie Verläufe biegen.",
    "flows.style.Smooth": "Rund", "flows.legendFontFamily": "Schriftart"
}));
localiseModel(model);
const slice = model.cards[0].groups[0].slices[0];
check("a card, group, setting, hover text and choice are all translated",
    model.cards[0].displayName === "Flüsse" && model.cards[0].groups[0].displayName === "Verlauf"
    && slice.displayName === "Verlaufsart" && slice.description === "Wie Verläufe biegen."
    && slice.items[0].displayName === "Rund");
check("a font control's parts are translated", model.cards[0].groups[0].slices[1].fontFamily.displayName === "Schriftart");
check("an untranslated name stays English", model.cards[0].groups[0].slices[1].displayName === "Font");
setLocalizer(undefined);
localiseModel(model);
check("rebuilding in English restores the source text", model.cards[0].displayName === "Flows"
    && slice.displayName === "Routing style" && slice.items[0].displayName === "Smooth");

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
