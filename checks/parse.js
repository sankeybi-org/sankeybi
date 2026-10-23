"use strict";
// `parseDataView`, for checks that write their fixtures ROW-major.
//
// SankeyBI binds a CATEGORICAL dataViewMapping, so the host hands
// the data over column-major: one parallel array per bound field, the grouping
// fields under `categories` and the measure under `values`. Before that it was
// a table mapping, and 41 of these files build `{ table: { columns, rows } }`
// by hand -- which is a perfectly good way to WRITE a fixture (a table of rows
// is how a person reads test data) and no longer the shape the visual sees.
//
// So this adapts, in ONE place, rather than 41 files being rewritten into
// column-major literals. What is under test is still the real shape: the
// parser only ever receives `categorical`, built here to match what the live
// probe of earlier reported -- a column per BOUND field and none at all for
// an unbound one, which is why a column with empty `roles` is dropped rather
// than passed through.
//
// **A new check should prefer `checks/dataview.js`**, which builds the same
// shape directly from a role list and rows. This exists for the 41 that
// predate the mapping change, so that converting them could not quietly alter
// what they assert.

const { record } = require("./placed.js");
const { parseDataView: parseCategorical, valueFormatOf: valueFormatCategorical } =
    require("./lib/dataParsing.js");

/** Is this a row-major fixture rather than the shape the host sends? */
function isTableShaped(dataView) {
    return Boolean(dataView && dataView.table && !dataView.categorical);
}

/**
 * A row-major `{ table: { columns, rows } }` fixture as the host would deliver
 * it: column-major, split into categories and values by role.
 *
 * Column ORDER is preserved within each half, so a fixture that binds two
 * fields to one role still resolves the way it did (later wins).
 */
function toCategorical(dataView) {
    const table = dataView.table;
    const columns = table.columns || [];
    const rows = table.rows || [];
    const categories = [];
    const values = [];
    columns.forEach((col, index) => {
        const roles = col && col.roles;
        if (!roles || Object.keys(roles).length === 0) {
            // Not bound to any role: the host would not send a column at all.
            return;
        }
        const entry = {
            source: col,
            values: rows.map(r => (r ? r[index] : undefined))
        };
        if (roles["value"]) {
            values.push(entry);
        } else {
            // `identity` is what selection ids are built against. One opaque
            // object per row is enough for a check: nothing here inspects it,
            // and the host's own identities are opaque too.
            entry.identity = rows.map((_, i) => ({ row: i }));
            categories.push(entry);
        }
    });
    return { ...dataView, categorical: { categories, values } };
}

/**
 * **Where a table fixture's grid cells go now**. SourceColumn /
 * SourceRow / TargetColumn / TargetRow are no longer data roles, so the parser
 * drops those columns -- but a fixture written to exercise a PARTICULAR
 * arrangement still needs its nodes where it put them. They are recorded here
 * against the flows they were parsed from, and `checks/placed.js`'s
 * `buildGraph` hands them over as placed positions, which is the route a
 * dragged node takes in a report. See the head of that file.
 */
function recordPlacements(dataView, flows) {
    if (!isTableShaped(dataView)) {
        return flows;
    }
    const columns = (dataView.table && dataView.table.columns) || [];
    const indexOf = field => columns.findIndex(col => col && col.roles && col.roles[field]);
    return record(flows, (dataView.table && dataView.table.rows) || [], indexOf);
}

function parseDataView(dataView) {
    const parsed = parseCategorical(isTableShaped(dataView) ? toCategorical(dataView) : dataView);
    recordPlacements(dataView, parsed.flows);
    return parsed;
}

function valueFormatOf(dataView) {
    return valueFormatCategorical(isTableShaped(dataView) ? toCategorical(dataView) : dataView);
}

module.exports = { parseDataView, valueFormatOf, toCategorical };
