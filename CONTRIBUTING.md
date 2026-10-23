# Contributing

1. `npm ci`, then `npm run typecheck`, `npm run lint` and `npm test` must all pass.
2. Read ARCHITECTURE.md first: the invariants there cause silently wrong pictures.
3. Keep comments to what the code does and why. No history, names or issue numbers in the source.
4. A change to a geometry input needs a case in `checks/properties-check.js` (the geometry key).
5. Line endings are LF; see `.gitattributes` and `.editorconfig`.

`npm test` runs every check in `checks/`; `npm test -- routing` runs a group (`--list` shows them). The checks use synthetic fixtures built in code (`checks/fixture.js`) and need no data files.

## Keep the engine host-independent

Engine modules (everything except `visual.ts`, `settings*.ts`, `selection.ts`, `*Panel.ts`, `formatting.ts`, `background.ts`, `dataParsing.ts`, `colours.ts` and `tooltips.ts`) must not import `powerbi-visuals-api` or any library that needs a DOM or the Power BI host. If an engine module needs text widths, number formatting or any other service from the host, pass it in as an argument or an option field, as `measureText` and `formatValue` are. See "Design goal" in ARCHITECTURE.md.

## Translations

All text the author sees is in English in the source and is looked up by key (`src/i18n.ts`), so a language is one file: `stringResources/<locale>/resources.resjson`, a flat JSON map from key to text. The format pane (cards, groups, settings, hover texts, dropdown choices), the data field names, the visual's own panels and its tooltips are covered. Data warnings are not translated yet.

To add a language:

1. Copy `stringResources/en-GB/resources.resjson` (the source English; `en-US` is the same text in American spelling, generated from it) to `stringResources/<locale>/resources.resjson` (for example `de-DE`) and translate the values. Keep the keys, and keep every `{0}`, `{1}` placeholder in each text.
2. Add the file to `stringResources` in `pbiviz.json`.
3. Run `node checks/i18n-check.js`. It requires the same keys and placeholders as en-GB, and hover texts of 160 characters or fewer.

A hover text must stay short: Power BI truncates long ones. Keep one translation per term throughout (route, port, face, band, flow type, diagram spacing); a glossary agreed first saves rewrites.

When you change English text in the source, run `node checks/i18n-check.js --write` to regenerate en-GB and en-US, then update the other languages. New text the visual draws itself goes through `t("ui.area.name", "English")` or `tf(...)` for text with `{0}` placeholders; pane text needs nothing, because its keys come from the setting's own name.
