// The routing code is split over several modules; the checks use it as one.
module.exports = Object.assign({},
    require("./lib/routing.js"),
    require("./lib/routingStyle.js"),
    require("./lib/routeConstants.js"),
    require("./lib/routeMath.js"),
    require("./lib/anchors.js"),
    require("./lib/curves.js"),
    require("./lib/bands.js"),
    require("./lib/waypoints.js"),
    require("./lib/avoidance.js"),
    require("./lib/handles.js"),
    require("./lib/infill.js"));
