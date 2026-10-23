"use strict";
// The dataView the host actually hands over, for every check that needs one.
//
// SankeyBI binds a CATEGORICAL dataViewMapping, so the data arrives
// COLUMN-major: one parallel array per bound field, the grouping fields under
// `categories` and the measure under `values`. Before that it was a table
// mapping and 41 of these files built `{ table: { columns, rows } }` by hand.
//
// They build it through here instead, for the reason the visual has one
// `formatting.ts`: the shape is a fact about the host, and 41 hand-written
// copies of a fact is 41 chances for the checks to agree with each other and
// disagree with Power BI.
//
// **Faithful to the probe**, which is where the shape was read off a live
// dataView: a field that is not bound has NO column at all, rather
// than a column with empty roles — so passing `undefined` for a header's role
// omits it, exactly as dropping the field from the well does.

/** The role a `value` cell belongs to; it rides in `values`, not `categories`. */
const VALUE_ROLE = "value";

/**
 * A categorical dataView from a role-per-column list and row-major rows.
 *
 * `roles` is one entry per column of `rows`, naming that column's data role,
 * or a falsy value for a column that is not bound to one. `rows` is the usual
 * array of row arrays, so a check that already had `rows` keeps it unchanged
 * and only its `columns` expression moves in here.
 *
 * `format` optionally gives a role its column's format string, which is what
 * `valueFormatOf` reads.
 */
function dataView(roles, rows, format) {
    const columns = [];
    roles.forEach((role, index) => {
        if (!role) {
            return;
        }
        const source = { roles: { [role]: true } };
        if (format && format[role] !== undefined) {
            source.format = format[role];
        }
        columns.push({ role, source, values: rows.map(r => r[index]) });
    });
    const categories = columns.filter(c => c.role !== VALUE_ROLE)
        .map(c => ({ source: c.source, values: c.values, identity: rows.map((_, i) => ({ i })) }));
    const values = columns.filter(c => c.role === VALUE_ROLE)
        .map(c => ({ source: c.source, values: c.values }));
    return { categorical: { categories, values } };
}

/**
 * The same, from a CSV header row: the header names are mapped to roles
 * through `roleOf` and anything unmapped is dropped. This is the shape 16 of
 * the checks used, reading a file out of the test data.
 */
function dataViewFromHeader(header, rows, roleOf, format) {
    return dataView(header.map(h => roleOf[h]), rows, format);
}

/**
 * A highlights array alongside the values, as `supportsHighlight` delivers it:
 * same length as the values, `null` wherever a row is not in scope. Used by
 * the inbound-highlighting checks.
 */
function withHighlights(dv, highlights) {
    const values = (dv.categorical.values ?? []).map((v, i) =>
        (i === 0 ? { ...v, highlights } : v));
    return { categorical: { ...dv.categorical, values } };
}

module.exports = { dataView, dataViewFromHeader, withHighlights };
