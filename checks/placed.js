"use strict";
// **Where a fixture's nodes stand**, now that the data cannot say.
//
// SourceColumn/SourceRow/TargetColumn/TargetRow left the data roles in
// earlier . A report places a node by DRAGGING it, which
// reaches `buildGraph` as a pinned position -- and that is what a fixture
// wants too: most of these checks exist to measure the geometry of a
// particular arrangement, and the authored columns were only ever the most
// convenient way to write one down.
//
// So the fixture keeps writing `sourceColumn: 2, sourceRow: 3` exactly as it
// did, `record` collects those cells while the dataView is built, and the
// `buildGraph` wrapper below hands them over as placed positions. The same
// first-non-blank-wins rule the roles had, and `buildGraph` honours one axis
// at a time, so a row naming only a column still leaves the row automatic.
//
// What this does NOT do is pretend the roles still exist: nothing here goes
// through the parser, and a check that wants to prove the PARSER's behaviour
// cannot use it.

const { buildGraph: realBuildGraph } = require("./lib/graph.js");

/** Positions recorded against the flows array they were parsed from. */
const byFlows = new WeakMap();

const FIELDS = [
    ["source", "sourceColumn", "sourceRow"],
    ["target", "targetColumn", "targetRow"]
];

/**
 * Collect the grid cells out of a row-major fixture.
 *
 * `rows` are the fixture's own row objects or arrays; `indexOf` maps a field
 * name to its column index for the array form, and is omitted for objects.
 */
function collect(rows, indexOf) {
    const placed = new Map();
    const read = (row, field) => {
        if (!field) {
            return undefined;
        }
        const value = indexOf ? row[indexOf(field)] : row[field];
        if (value === undefined || value === null || value === "") {
            return undefined;
        }
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
    };
    rows.forEach(row => {
        FIELDS.forEach(([idField, columnField, rowField]) => {
            const id = indexOf ? row[indexOf(idField)] : row[idField];
            if (id === undefined || id === null || id === "") {
                return;
            }
            const column = read(row, columnField);
            const rowAt = read(row, rowField);
            if (column === undefined && rowAt === undefined) {
                return;
            }
            const at = placed.get(String(id)) || {};
            // First non-blank wins, per axis, exactly as the roles did.
            if (column !== undefined && at.column === undefined) {
                at.column = column;
            }
            if (rowAt !== undefined && at.row === undefined) {
                at.row = rowAt;
            }
            placed.set(String(id), at);
        });
    });
    return placed;
}

/** Remember a fixture's placements against the flows they came from. */
function record(flows, rows, indexOf) {
    if (!Array.isArray(flows) || !Array.isArray(rows)) {
        return flows;
    }
    const placed = collect(rows, indexOf);
    if (placed.size > 0) {
        byFlows.set(flows, placed);
    }
    return flows;
}

/** What was recorded for these flows, if anything. */
function placementsOf(flows) {
    return byFlows.get(flows);
}

/**
 * `buildGraph`, with the fixture's own placements applied.
 *
 * A caller's own `pinned` entry wins: a check that places a node explicitly is
 * saying something the fixture's cells should not overrule.
 */
function buildGraph(flows, pinned, roles, corridors) {
    // Either the fixture went through `parse.js`, which recorded its cells, or
    // it hand-writes its flows as literals -- in which case the cells are
    // still right there on the objects, since nothing stops a fixture
    // carrying a field `FlowRow` no longer declares.
    const placed = placementsOf(flows) || collect(flows);
    if (!placed || placed.size === 0) {
        return realBuildGraph(flows, pinned, roles, corridors);
    }
    const merged = new Map(placed);
    if (pinned) {
        pinned.forEach((position, id) => merged.set(id, position));
    }
    return realBuildGraph(flows, merged, roles, corridors);
}

module.exports = { buildGraph, record, placementsOf };
