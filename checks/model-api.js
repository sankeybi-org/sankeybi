// The shared model is split over a few modules; the checks use it as one.
module.exports = Object.assign({},
    require("./lib/model.js"),
    require("./lib/flowAxis.js"),
    require("./lib/arrows.js"));
