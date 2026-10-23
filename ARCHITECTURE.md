# Architecture

SankeyBI turns a Power BI categorical data view into an SVG Sankey-style diagram. Each
update runs a pipeline of small stages; the early stages are skipped on viewport-only
updates and the geometry stages are skipped when only paint-level settings changed.

## Pipeline

`visual.ts` `update()` runs: **parse -> transpose -> graph -> node edits -> corridors ->
colours -> layout -> justify -> straighten -> route -> render**, then wires interaction
and selection. Layout fits the view to the outermost drawn thing; unless Lock grid is on,
flow passes re-lay-out with the routed flows counted as content, and an overflow pass
reserves anything still spilling and routes once more.

| Module | Job |
|---|---|
| `model.ts`, `flowAxis.ts`, `arrows.ts` | Shared types (FlowRow -> Corridor -> LayoutResult -> RoutedBand), port normals, the flow axis and sense, arrow geometry |
| `dataParsing.ts` | Categorical data view -> `FlowRow[]`, with validation warnings |
| `transpose.ts` | The quarter turn for vertical flow directions: a transpose, applied to the parsed rows and to stored hand placement |
| `graph.ts` | Nodes, stages (memoised DFS, cycle-safe) and the order within a stage |
| `corridors.ts` | Flows -> corridors per (source, target) -> per-flow-type segments; ports resolved per corridor |
| `textures.ts` | The hatches and graphic patterns a flow type can be filled with, as tile data in one index space |
| `colours.ts`, `flowTypeColours.ts` | Flow-type colours, one resolver for bands, arrows, legend and tooltips |
| `layout*.ts` | Grid -> pixels: node sizing, the single value->pixels scale, the view fit, Lock grid |
| `justify.ts`, `straighten.ts` | Even whitespace on the end columns; nudging near-straight corridors straight |
| `routing.ts` and `anchors`, `waypoints`, `avoidance`, `curves`, `bands`, `handles`, `infill`, `route*` | Ports, anchor packing, route construction per style, avoidance, band geometry, node arrows |
| `layers.ts` | Which corridor is painted over which where two cross |
| `arrangeNodes.ts`, `layeredModel.ts` | Arrange nodes: layered model, ordering, placement |
| `arrangeFlows.ts`, `parallel.ts` | Arrange flows: search route handles to part flows that run along each other |
| `render*.ts` | SVG painting only; no geometry decisions |
| `interaction.ts`, `selection.ts`, `tooltips.ts` | Drag, selection, cross-filter, cross-highlight, tooltips |
| `positions.ts`, `layoutFile.ts`, `nodeEdits.ts` | Hand placement and edits persisted as hidden blobs; the layout file |
| `*Panel.ts`, `panelMenu.ts`, `background.ts` | The visual's own edit panels |
| `settings*.ts`, `headerSwitch.ts` | The format pane model |
| `geometryKey.ts` | The cache key for a laid-out, routed diagram |
| `formatting.ts` | The only module importing the formatting-utils library (injected elsewhere) |

## Invariants that cause a wrong picture

- **A new geometry input goes in `LayoutChrome` or `RoutingOptions`**, or in `geometryKey` by hand. The key hashes those two objects whole; an input reaching layout or routing any other way is invisible to it and the picture goes stale until something else moves.
- **One value->pixels scale per diagram**, from the pitch the nodes pack across. Per-axis scales taper every L-shaped band. Routing geometry is fractions of a pitch, never raw pixels.
- **A node is exactly as big as the bands it holds**, measured at the widths they are drawn at, not `valueToPixels` of their total.
- **Nothing downstream re-derives what routing hands out** (`spine`, `handles`, `runEnds`, `silhouettes`). When something needs band geometry it lacks, routing hands out the capability (`partialPath(fraction)`), not the ingredients.

## Glossary

Corridor: all flows between one source and one target. Segment: one flow type's share of a corridor. Face: one side (North/South/East/West) of a node. Stub: the straight run out of a port. Lead: the stub's length, draggable. Pitch: the grid spacing along one axis. Stage: a node's step along the flow.

## Constraints of the host

`pbiviz start` reads `capabilities.json` once; a property declared there must also exist in `settings*.ts`. `capabilities.json` must not use a `conditions` block (it silently blocks field drops). `powerbi-visuals-utils-formattingutils` is pinned to 6.x (7.0.0 breaks `pbiviz package`). Several files are checked with `npm run typecheck` (strict) while the build uses the non-strict `tsconfig.json`.

## Design goal: keep the engine host-independent

The engine (transpose, graph, corridors, layout, justify, straighten, routing, arranging and the SVG renderers) does not depend on Power BI. Its inputs are plain rows and option objects, and its output is geometry and SVG path strings. `dataParsing.ts` is the one place the host's data view shape is read, and `colours.ts` and `tooltips.ts` import host types only (the colour palette and tooltip item), so they are the first places to look when separating the engine. Everything specific to the host lives at the edges: `visual.ts`, the `settings*.ts` model, selection and tooltips, the edit panels, persistence, and the data view mapping in `capabilities.json`.

Text measurement and number formatting are injected (`measureText`, `formatValue`) rather than imported, which is what lets the checks run in Node with no DOM. Keeping this boundary intact leaves the door open to using the same engine in other environments later, and it keeps the engine testable on its own. A layout file holds the canonical frame with no orientation of its own, so it is portable between environments too.
