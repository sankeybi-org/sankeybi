# SankeyBI

Publication-quality, interactive energy and material flow (Sankey-style) diagrams for Power BI.

- Flows are drawn as bands whose width is proportional to the value, with nodes sized exactly to the flows they hold.
- Flow types stack inside each band, with a legend, textures and outlines.
- Four routing styles (Polyline, Octilinear, Orthogonal, Smooth), node arrows, shapes and icons.
- Hand placement: drag nodes and route handles, snap to a grid, lock the view, export the layout as text.
- Arrange nodes and Arrange flows buttons for an automatic starting point.
- Cross-filtering, cross-highlighting, tooltips and a context menu; high-contrast support.

## Data

| Field | Required | Meaning |
|---|---|---|
| Source | yes | The node a flow leaves |
| Target | yes | The node a flow arrives at |
| Value | yes | The flow's size (a measure) |
| Flow type | no | Splits a flow into typed stripes |
| Source port / Target port | no | North, South, East or West |
| Source order / Target order | no | Where a node sits among the others at its stage, or a group name |
| Flow display order, Flow colour | no | Stacking order and colour per flow type |
| Source icon / Target icon | no | A small SVG for a node's label |

Node names are the Source and Target values; colours, display names and icons can be edited in the visual's node editor.

## Format pane

Nine cards: Arrange, Flows, Nodes, Node labels, Flow labels, Values, Legend, Background image and Tooltips. See [SETTINGS.md](docs/settings-reference.md). The buttons in Arrange (Arrange nodes, Arrange flows, the resets, Show layout file) are toggle switches that the visual switches straight back off: the formatting model has no button control. In a reading view nothing can be persisted, so they do nothing there.

## Build

```bash
npm ci
npm start          # development server (Power BI Service, developer mode)
npm run typecheck
npm run lint
npm test           # synthetic checks, no test data needed
npm run package    # writes dist/*.pbiviz
```

`powerbi-visuals-tools` must be installed globally (`npm i -g powerbi-visuals-tools`). `pbiviz start` reads `capabilities.json` once at startup: restart it after changing the capabilities.

## Privacy and accessibility

The visual makes no network requests and writes nothing to the user's device; layouts and edits are saved inside the report file. It requests no privileges. The one browser storage it touches is a read of an opt-in debug switch in `localStorage` (`sankeybi.debug`), which it never writes. See [SECURITY.md](SECURITY.md). Elements carry ARIA labels and the visual follows high-contrast themes; keyboard navigation of the diagram is not supported.

## Languages

The interface is available in English (UK and US), German, French, Spanish, Italian, Dutch, Portuguese (Brazil and Portugal), Swedish, Danish and Norwegian (Bokmål), following the language of Power BI. The translations are machine-assisted; corrections are welcome. A language is one file in `stringResources/`, described in [CONTRIBUTING.md](CONTRIBUTING.md#translations), so adding one is a pull request.

## Example data

The `examples/` folder has the same fictional national energy flow, a loop included (combined heat and power feeding the grid), in two forms:

- [SankeyBI Example Sankey Diagram.pbix](examples/SankeyBI%20Example%20Sankey%20Diagram.pbix) is a ready-made report with the visual already bound. It works offline.
- [SankeyBI Example Sankey Diagram.xlsx](examples/SankeyBI%20Example%20Sankey%20Diagram.xlsx) is the data alone. Its Read me sheet says which columns to bind to which field.

The figures are invented.

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md) describes the pipeline and the modules. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to work on it.

## Licence

MIT. See [LICENSE](LICENSE).
