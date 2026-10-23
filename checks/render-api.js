// The rendering code is split over several modules; the checks use it as one.
const api = Object.assign({},
    require("./lib/render.js"),
    require("./lib/renderBackground.js"),
    require("./lib/renderLabels.js"),
    require("./lib/renderBands.js"),
    require("./lib/renderNodes.js"),
    require("./lib/renderLegend.js"),
    require("./lib/renderHandles.js"));

// Most checks call render with the positional arguments it used to take; this
// adapts them to the input object.
const render = api.render;
api.render = (svg, layout, bands, colorPalette, settings, flowTypeColours, viewportWidth, viewportHeight,
    drag, routeHandles, corridors, selection, infill, background, paintOrder, routeGhosts, crossings,
    numbers, flowLabelInput) =>
    render(svg, {
        layout, bands, colorPalette, settings, flowTypeColours, viewportWidth, viewportHeight, drag,
        routeHandles, corridors, selection, infill, background, paintOrder, routeGhosts, crossings,
        numbers, flowLabelInput
    });

module.exports = api;
