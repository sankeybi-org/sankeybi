# Settings reference

Every setting in the format pane, by card, with its help text. Generated from `src/settings*.ts`.
The Arrange, Flows and Nodes cards also hold buttons: toggle switches the visual switches straight back off.

## Arrange

| Setting | Help |
|---|---|
| Flow direction | Which way the diagram reads. Hand-placed nodes and ports turn with it. |
| Snap to grid | Steps per grid cell: 2 for halves, 3 for thirds, up to 100. 0 places freely. |
| Show grid | Draws the snap grid behind the diagram while editing. Never shown when reading. |
| Show route handles | Shows or hides the route handles. Nodes stay draggable either way. |
| Lock positions | Makes the diagram static: nothing can be dragged and no route handles show. |
| Lock grid | Holds the grid and visible area so moving a node never rescales the diagram. |
| Arrange flows | Separates flows that run along each other. Routes you dragged stay where you put them. |
| Arrange nodes | Rearranges nodes by where their flows say they belong. Nodes you dragged stay put. |
| Reset node positions | Clears hand-placed nodes and arranges them automatically. Route handles are kept. |
| Reset route handles | Clears hand-moved route handles so all flows route automatically. Nodes are kept. |
| Show layout file | Shows the layout as text to copy, back up, or paste to restore. Edit mode only. |

## Flows

| Setting | Help |
|---|---|
| Flow width | Flow thickness as a % of default. Nodes scale with it; busy nodes touch past about 150%. |
| Default flow colour | Colour of flows with no flow type. Typed flows use their type's colour. |
| Flow type textures | Fills each flow type with a texture instead of a flat colour, in legend order. |
| Texture colour | Follow flow type uses each type's colour. Monotone uses one colour, so only patterns differ. |
| Custom texture colour | Used when Texture colour is Custom. |
| Texture background | What sits behind a texture: report background, flow type colour or a custom colour. |
| Custom texture background | Used when Texture background is Custom. |
| Border | Draws a border inside every flow without changing its width. Dashed suggests estimated. |
| Border colour | Automatic uses the theme's text colour. Custom uses one colour for all borders. |
| Custom border colour | Used when Border colour is Custom. |
| Show editor | Opens the flow type editor for colours, names, textures and borders. Edit mode only. |
| Reset colour edits | Clears all flow type editor changes so types follow the data again. |
| Between flows | Gap between side-by-side flows and between bands, as a % of diagram spacing. |
| Where flows cross | Gap erased in the lower flow where one flow crosses over another, in pixels. |
| Fixed flow baseline | Measures flows against a value you set, so widths match across slicer selections. |
| Current | The busiest node's throughput at the current selection, in Value units. |
| Baseline value | Throughput one full node thickness represents. Set at or above your busiest node. |
| Routing style | Polyline: straight runs, one diagonal. Octilinear: 45° diagonals. Orthogonal: right angles. Smooth: arcs. |
| Curvature | Corner radius as a % of diagram spacing; 0 is sharp. Resets any hand-set corners. |
| Straighten | Nudges nodes so nearly straight routes become straight. 0 leaves nodes on the grid. |
| Route around nodes | Steers a flow around any node it would otherwise pass through. |

## Nodes

| Setting | Help |
|---|---|
| Minimum width | Least node width as a % of the diagram spacing between columns. Flows size nodes otherwise. |
| Minimum height | Least node height as a % of the diagram spacing between rows. Flows size nodes otherwise. |
| Show shapes | Draws node shapes. Off leaves only the flows. |
| Shape | Decorative shape over the node's centre. It never moves or resizes a route. |
| Overhang flows | How far a node extends past its flows, as a % of diagram spacing. |
| Overhang to fit label | Widens a node so an overflowing label fits inside. Needs a shape. |
| Fill | Node shape fill: node colour, custom, none or theme background. |
| Fill colour | Used when Fill is Custom. |
| Border | Node shape border: node colour, custom, none or theme background. |
| Border colour | Used when Border is Custom. |
| Border width | Thickness of the node border, in pixels. |
| Show editor | Opens the node editor for labels, names, icons and faces. Edits beat the data. Edit mode only. |
| Reset node edits | Clears all node editor changes so nodes follow the data again. |
| Show arrows | Turns arrow heads and tails on or off together. |
| Arrow heads | Continues each face's incoming flows into the node as an arrow head. |
| Arrow tails | Notches the back of each face's outgoing flows so the node reads as an arrow tail. |
| Arrow angle | Angle at the arrow tip in degrees. Lower is sharper; 90 gives a 45° taper. |
| Arrow gap | Break from a head's tip to a tail's notch, as a % of diagram spacing. |

## Node labels

| Setting | Help |
|---|---|
| Text colour | Automatic picks black or white to suit the node fill. Custom sets one colour. |
| Custom colour | Used when Text colour is Custom. |
| Just terminal nodes | Labels only nodes where flows start or end. |
| Show | Draws node names and totals. Off gives their space back to the diagram. |
| Show node totals | Draws each node's total under its name. |
| Totals from | Which figure totals report. Larger of in/out matches the tooltip. |
| Total text size | Size of the total under a node's name. |
| Total bold | Draws node totals in bold. |
| Icon size | Icon edge length in pixels. Icons come from the Source icon and Target icon fields. |
| Icon colour | Original keeps each icon as drawn; Label colour or Node colour recolours it. |
| Flag unbalanced nodes | Marks nodes whose in and out differ by more than the tolerance. Edit mode only. |
| Balance tolerance (%) | How far in and out may differ before a node is flagged, as a % of throughput. |

## Flow labels

| Setting | Help |
|---|---|
| Show | Draws a figure mid-flow. Flows too thin or steep to hold one stay unlabelled. |
| Label shows | What each label reports: the value, a % of all flows or a % of its source node. |
| Label flows that don't fit | Draws labels for thin or steep flows just outside, with a line back to the flow. |
| Colour | Automatic picks black or white to suit the flow underneath. Custom sets one colour. |
| Custom colour | Used when Colour is Custom. |

## Values

| Setting | Help |
|---|---|
| Display units | Auto scales every figure by one unit, chosen from the largest value. |
| Automatic decimals | Follows the Value field's format. Off lets you set decimal places. |
| Units | Unit of measure added to every total, e.g. TWh. |
| Decimal places | Decimal places shown on every figure. Hidden while Automatic decimals is on. |

## Legend

| Setting | Help |
|---|---|
| Text colour | Automatic uses the theme's text colour. Custom sets one colour. |
| Custom colour | Used when Text colour is Custom. |
| Show legend | Shows a legend of flow types. Needs a Flow type field. |
| Position | Which side of the diagram the legend sits on. |
| Title | Bold title before the first entry. Entries follow Flow display order. |

## Background image

| Setting | Help |
|---|---|
| Show | Shows or hides the background picture without removing it. |
| Image | Whether a background image is set, and how to set one. |
| Transparency | 0% shows the picture as is; higher fades it behind the flows. |
| Colour | Original, Greyscale, Tint (one colour) or Duotone (a dark and a light colour). |
| Dark parts | Colour for the picture's dark parts. For Tint, the tint colour. |
| Light parts | Colour for the picture's light parts. |
| Import image | Choose, drop or paste an SVG, PNG or JPEG up to 500 KB. Edit mode only. |
| Remove image | Removes the picture from the report. |

## Tooltips

| Setting | Help |
|---|---|
| Tooltips | Shows a tooltip on hover with the flow or node's values. |
| Node total | Shows a node's total in and out. |
| Node total by flow type | Breaks a node's totals down by flow type, in legend order. |
| Node total by source and target | Breaks a node's totals down by the node at the other end. |

