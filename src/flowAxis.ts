import { Corridor, DEFAULT_PORTS, FlowAxis, FlowDirection, FlowSense, Port, PORT_NORMALS } from "./model";

/**
 * East/West ports pack their corridors along the node's height; North/South along its width.
 */
export function portAxis(port: Port): "vertical" | "horizontal" {
    return port === "East" || port === "West" ? "vertical" : "horizontal";
}

/**
 * Maps a stored Flow direction onto a current one. A hand-edited report can carry anything,
 * and anything unrecognised reads as Left to right.
 */
export function normaliseFlowDirection(value: unknown): FlowDirection {
    const name = String(value);
    if (name === "RightToLeft" || name === "TopToBottom" || name === "BottomToTop") {
        return name;
    }
    return "LeftToRight";
}

/**
 * The axis the Flow direction setting asks for, which is a different question from
 * `axisOf`'s.
 *
 * `axisOf` reads the ports the corridors actually use, so that the automatic grid can never
 * disagree with them. That is right for geometry and wrong for anything the author's own
 * stored work is measured against: a slicer that drops the last row carrying a port would move
 * `axisOf` and take the stored work with it, which is the hazard `fitSignatureOf` refuses to
 * run. So the two callers that judge stored work, `withoutStaleHandles` and the fit
 * signature, ask the setting instead, and the setting is controlled only by the author.
 *
 * It is derived through `DEFAULT_PORTS` and `portAxis` rather than listing the four
 * directions again, so it cannot drift from the port table: `portAxis` names the axis a port
 * packs along, and the travel is the other one.
 */
export function axisOfDirection(direction: FlowDirection): FlowAxis {
    return portAxis(DEFAULT_PORTS[direction].out) === "vertical" ? "horizontal" : "vertical";
}

/**
 * The axis the diagram flows along, from the ports its corridors actually use.
 *
 * Counted per corridor end rather than per corridor, so a corridor that leaves East and
 * arrives North votes for both: it belongs to neither reading, and the majority of the honest
 * votes should decide. Ties go horizontal.
 */
export function axisOf(corridors: Corridor[]): FlowAxis {
    let horizontal = 0;
    let vertical = 0;
    corridors.forEach(corridor => {
        if (corridor.isSelfLoop) {
            return;
        }
        ([corridor.sourcePort, corridor.targetPort] as Port[]).forEach(port => {
            // `portAxis` names the axis a port packs along; the direction of travel is the other one.
            if (portAxis(port) === "vertical") {
                horizontal++;
            } else {
                vertical++;
            }
        });
    });
    return vertical > horizontal ? "vertical" : "horizontal";
}

export function senseOf(corridors: Corridor[], axis: FlowAxis = axisOf(corridors)): FlowSense {
    let along = 0;
    corridors.forEach(corridor => {
        if (corridor.isSelfLoop) {
            return;
        }
        const leaves = PORT_NORMALS[corridor.sourcePort];
        const arrives = PORT_NORMALS[corridor.targetPort];
        along += axis === "horizontal" ? leaves.x - arrives.x : leaves.y - arrives.y;
    });
    return along < 0 ? -1 : 1;
}
