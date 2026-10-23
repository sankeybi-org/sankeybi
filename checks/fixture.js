"use strict";
// Synthetic diagrams for the checks, built in code.
//
// Each fixture is a list of flows in the same row-major form the host sends:
// [source, target, value, flowType, sourcePort, targetPort]. `diagram` pushes
// one through the data stages (parse, graph, corridors) and hands back what
// layout and routing need.

const { dataView } = require("./dataview.js");
const { parseDataView } = require("./lib/dataParsing.js");
const { buildGraph } = require("./placed.js");
const { inferCorridors } = require("./lib/corridors.js");

const ROLES = ["source", "target", "value", "flowType", "sourcePort", "targetPort"];

/** A small energy system: sources into a grid, the grid out to users, a storage chain and one self-loop. */
function energy() {
    return [
        ["Wind", "Grid", 120, "Electricity"],
        ["Solar", "Grid", 80, "Electricity"],
        ["Hydro", "Grid", 60, "Electricity"],
        ["Gas", "Grid", 40, "Electricity"],
        ["Grid", "Industry", 140, "Electricity"],
        ["Grid", "Industry", 30, "Heat"],
        ["Grid", "Buildings", 70, "Electricity"],
        ["Grid", "Buildings", 50, "Heat"],
        ["Grid", "Electrolyser", 60, "Electricity"],
        ["Electrolyser", "Hydrogen Storage", 55, "Hydrogen"],
        ["Hydrogen Storage", "Transport", 50, "Hydrogen"],
        ["Grid", "District Heating", 40, "Heat"],
        ["Electrolyser", "Electrolyser", 5, "Hydrogen"]
    ];
}

/**
 * A layered network: `shape` nodes per column, every node feeding one to three nodes in
 * the next column. Values and targets come from a fixed linear congruential sequence, so the
 * diagram is the same on every run and every machine.
 */
function layered(shape = [6, 5, 4, 3], seed = 7) {
    let state = seed;
    const next = limit => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state % limit;
    };
    const name = (column, index) => `C${column + 1}N${index + 1}`;
    const rows = [];
    for (let column = 0; column + 1 < shape.length; column++) {
        for (let index = 0; index < shape[column]; index++) {
            const fanOut = 1 + next(3);
            const used = new Set();
            for (let k = 0; k < fanOut; k++) {
                const target = next(shape[column + 1]);
                if (used.has(target)) { continue; }
                used.add(target);
                rows.push([name(column, index), name(column + 1, target), 10 + next(90), next(2) ? "A" : "B"]);
            }
        }
    }
    return rows;
}

/** Corridors that run backwards, a flow with a tiny value among large ones, and two self-loops. */
function awkward() {
    return [
        ["Source", "Hub", 1000, "A"],
        ["Hub", "Out1", 1, "A"], ["Hub", "Out2", 1, "A"], ["Hub", "Out3", 2, "B"], ["Hub", "Out4", 3, "B"],
        ["Hub", "Back", 400, "A"],
        ["Back", "Source", 50, "B"],
        ["Hub", "Hub", 8, "A"],
        ["Out1", "Out1", 1, "B"]
    ];
}

/** The same flows with every one leaving South and arriving North. */
function vertical(rows) {
    return rows.map(row => [row[0], row[1], row[2], row[3], "South", "North"]);
}

/** Parses, builds the graph and infers the corridors. `direction` is the Flow direction setting. */
function diagram(rows, direction = "LeftToRight") {
    const dv = dataView(ROLES, rows.map(row => ROLES.map((_, i) => (row[i] === undefined ? null : row[i]))));
    const { flows, warnings } = parseDataView(dv);
    const { graph } = buildGraph(flows);
    const { corridors } = inferCorridors(flows, undefined, direction);
    return { flows, graph, corridors, warnings };
}

module.exports = { energy, layered, awkward, vertical, diagram };
