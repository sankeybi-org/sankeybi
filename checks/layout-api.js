// The layout code is split over several modules; the checks use it as one.
module.exports = Object.assign({},
    require("./lib/layout.js"),
    require("./lib/layoutConstants.js"),
    require("./lib/layoutText.js"),
    require("./lib/layoutView.js"));
