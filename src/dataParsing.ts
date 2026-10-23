/**
 * Data parsing: reads the single denormalised flow table and converts each row into
 * a `FlowRow`, validating as it goes.
 *
 * The data mapping is categorical. Power BI groups by every bound grouping column
 * and aggregates the measure, so thousands of raw rows still arrive as the few
 * hundred distinct combinations they describe. The host hands the data over
 * column-major (one parallel array per bound field), and a categorical mapping is
 * the only one for which Power BI delivers `highlights`, which inbound
 * cross-highlighting needs.
 */

import powerbi from "powerbi-visuals-api";
import DataView = powerbi.DataView;
import DataViewCategorical = powerbi.DataViewCategorical;
import PrimitiveValue = powerbi.PrimitiveValue;

import { FlowRow, ParseResult, Port, PORTS } from "./model";
import { iconFromText } from "./background";

const ROLE_NAMES = [
    "source", "target", "value", "flowType", "flowColour",
    "flowDisplayOrder",
    "sourceOrder", "targetOrder",
    "sourcePort", "targetPort",
    "sourceIcon", "targetIcon"
] as const;

type RoleName = typeof ROLE_NAMES[number];

/**
 * Each bound role's own column of values, parallel to every other. That is how a
 * categorical data view arrives, so nothing is copied.
 *
 * A role that is not bound is simply absent, and `col.x?.[i]` then yields
 * undefined, so the parse loop reads an unbound role the same way as a blank cell.
 */
type RoleColumns = Partial<Record<RoleName, readonly PrimitiveValue[]>>;

/**
 * The Value field's own format string, so a measure formatted `#,##0 "kr"` in the
 * model draws that way rather than as a bare number.
 *
 * It lives here rather than in visual.ts because finding which column carries which
 * role is this file's job, and reading the format off the wrong column would draw
 * plausible nonsense.
 */
export function valueFormatOf(dataView: powerbi.DataView | undefined): string | undefined {
    const cat = dataView?.categorical;
    if (!cat) {
        return undefined;
    }
    // The measure lives in `values`; its format string is on that column's own source.
    // It is looked up by role rather than position, because a second measure in another
    // role would otherwise lend its format to the value.
    const value = (cat.values ?? []).find(v => v.source?.roles && v.source.roles["value"]);
    return value?.source?.format;
}

/**
 * Role to its column of values, over both halves of a categorical data view.
 *
 * `categories` carries the grouping fields and `values` the measure, and a role can
 * only be in one of them, so one pass over each is enough. Later bindings win when
 * two fields are dropped into the same role.
 */
function findRoleColumns(categorical: DataViewCategorical): RoleColumns {
    const columns: RoleColumns = {};
    const take = (roles: powerbi.DataViewMetadataColumn["roles"], values: PrimitiveValue[]): void => {
        if (!roles) {
            return;
        }
        ROLE_NAMES.forEach(role => {
            if (roles[role]) {
                columns[role] = values;
            }
        });
    };
    (categorical.categories ?? []).forEach(c => take(c.source?.roles, c.values));
    (categorical.values ?? []).forEach(v => take(v.source?.roles, v.values));
    return columns;
}

/**
 * How many rows the data view describes. Every column is parallel, so any one of
 * them answers it, but an unbound role has no column, so this asks the ones that
 * must be there rather than assuming a position.
 */
function rowCountOf(categorical: DataViewCategorical): number {
    const first = (categorical.categories ?? [])[0]?.values
        ?? (categorical.values ?? [])[0]?.values;
    return first ? first.length : 0;
}

/** Not bound, or bound but blank: undefined (the caller applies its default). */
function optionalString(value: PrimitiveValue | undefined): string | undefined {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }
    return String(value);
}

/**
 * An icon cell: SVG text or an SVG data URL, re-encoded and vetted (`iconFromText`).
 * Blank means no icon; anything unusable warns and is skipped rather than breaking
 * the row. `cache` holds each distinct cell's answer, since an icon repeats on every
 * row its node appears in.
 */
function optionalIcon(
    value: PrimitiveValue | undefined,
    warnings: string[],
    rowIndex: number,
    field: string,
    cache: Map<string, string | undefined>
): string | undefined {
    if (value === null || value === undefined || String(value).trim() === "") {
        return undefined;
    }
    const raw = String(value);
    if (cache.has(raw)) {
        return cache.get(raw);
    }
    const result = iconFromText(raw);
    const url = "image" in result ? result.image.url : undefined;
    if ("error" in result) {
        warnings.push(`Row ${rowIndex}: ${field} skipped — ${result.error}`);
    }
    cache.set(raw, url);
    return url;
}

function optionalNumber(value: PrimitiveValue | undefined): number | undefined {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }
    const n = Number(value);
    return isNaN(n) ? undefined : n;
}

/**
 * SourceOrder and TargetOrder are not grid positions and take two kinds of value.
 *
 * An order says only what comes before what, so there is no floor to enforce: -1
 * legitimately means "above everything numbered", and 2.5 means "between 2 and 3".
 * A number ranks. Anything else is a category, a group of nodes that belong together
 * without a preference for where the group sits. One field carries both. Only an
 * infinity is rejected: it would sort but could never be compared against its own
 * group.
 */
function optionalOrder(
    value: PrimitiveValue | undefined,
    warnings: string[],
    rowIndex: number,
    fieldName: string
): number | string | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    const text = String(value).trim();
    if (text === "") {
        return undefined;
    }
    const n = Number(text);
    if (!isNaN(n)) {
        if (!Number.isFinite(n)) {
            warnings.push(`Row ${rowIndex}: ${fieldName} must be a number that can be ordered, or a category name — ignored (got ${value}).`);
            return undefined;
        }
        return n;
    }
    // Trimmed and lowercased here rather than at every comparison. Nothing downstream
    // shows this value, so the only thing its spelling can do is split a group that was
    // meant to be one, as a stray capital must not make a second group. The same reason
    // ports are matched case-insensitively.
    return text.toLowerCase();
}

/**
 * FlowColour and the node colours are written straight into an SVG fill or stroke
 * attribute (render.ts) with no other validation in the pipeline. An invalid value
 * does not throw: the browser silently falls back to black, which is
 * indistinguishable from a legitimately black flow type and gives nothing pointing at
 * the cause. Validating here, where Value is validated, reports it with an explicit
 * warning. `CSS.supports` is a standard DOM API, safe to assume since this visual
 * always runs inside a browser.
 */
function optionalColour(
    value: PrimitiveValue | undefined,
    warnings: string[],
    rowIndex: number,
    fieldName: string
): string | undefined {
    const s = optionalString(value);
    if (s === undefined) {
        return undefined;
    }
    if (typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("color", s)) {
        warnings.push(`Row ${rowIndex}: ${fieldName} "${s}" is not a valid colour — ignored.`);
        return undefined;
    }
    return s;
}

/**
 * SourcePort and TargetPort name one of the node's four connection surfaces. They
 * are accepted case-insensitively and normalised to the canonical `Port` spelling,
 * since a report author typing "east" into a data column should not silently get
 * nothing. Anything else is ignored with a warning rather than guessed at, falling back
 * to the automatic default (outgoing East, incoming West).
 */
function optionalPort(
    value: PrimitiveValue | undefined,
    warnings: string[],
    rowIndex: number,
    fieldName: string
): Port | undefined {
    const s = optionalString(value);
    if (s === undefined) {
        return undefined;
    }
    const match = PORTS.find(p => p.toLowerCase() === s.trim().toLowerCase());
    if (!match) {
        warnings.push(`Row ${rowIndex}: ${fieldName} "${s}" is not one of North/South/East/West — ignored.`);
        return undefined;
    }
    return match;
}

export function parseDataView(dataView: DataView | undefined): ParseResult {
    const warnings: string[] = [];
    const flows: FlowRow[] = [];
    const icons = new Map<string, string | undefined>();

    if (!dataView || !dataView.categorical) {
        return { flows, warnings };
    }

    const col = findRoleColumns(dataView.categorical);
    const rowCount = rowCountOf(dataView.categorical);

    if (col.source === undefined || col.target === undefined || col.value === undefined) {
        warnings.push("Source, Target, and Value must all be bound before SankeyBI can draw anything.");
        return { flows, warnings };
    }

    const sourceCol = col.source;
    const targetCol = col.target;
    const valueCol = col.value;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        const sourceRaw = sourceCol[rowIndex];
        const targetRaw = targetCol[rowIndex];
        const valueRaw = valueCol[rowIndex];

        if (sourceRaw === null || sourceRaw === undefined || sourceRaw === "") {
            warnings.push(`Row ${rowIndex}: missing Source — skipped.`);
            continue;
        }
        if (targetRaw === null || targetRaw === undefined || targetRaw === "") {
            warnings.push(`Row ${rowIndex}: missing Target — skipped.`);
            continue;
        }

        const value = Number(valueRaw);
        if (valueRaw === null || valueRaw === undefined || isNaN(value)) {
            warnings.push(`Row ${rowIndex}: non-numeric Value — skipped.`);
            continue;
        }
        if (value < 0) {
            warnings.push(`Row ${rowIndex}: negative Value — skipped.`);
            continue;
        }

        const flow: FlowRow = {
            rowIndex,
            source: String(sourceRaw),
            target: String(targetRaw),
            value,
            flowType: col.flowType !== undefined ? optionalString(col.flowType[rowIndex]) : undefined,
            flowColour: col.flowColour !== undefined ? optionalColour(col.flowColour[rowIndex], warnings, rowIndex, "FlowColour") : undefined,
            flowDisplayOrder: col.flowDisplayOrder !== undefined ? optionalNumber(col.flowDisplayOrder[rowIndex]) : undefined,
            sourceOrder: col.sourceOrder !== undefined ? optionalOrder(col.sourceOrder[rowIndex], warnings, rowIndex, "SourceOrder") : undefined,
            targetOrder: col.targetOrder !== undefined ? optionalOrder(col.targetOrder[rowIndex], warnings, rowIndex, "TargetOrder") : undefined,
            sourcePort: col.sourcePort !== undefined ? optionalPort(col.sourcePort[rowIndex], warnings, rowIndex, "SourcePort") : undefined,
            targetPort: col.targetPort !== undefined ? optionalPort(col.targetPort[rowIndex], warnings, rowIndex, "TargetPort") : undefined,
            sourceIcon: col.sourceIcon !== undefined ? optionalIcon(col.sourceIcon[rowIndex], warnings, rowIndex, "SourceIcon", icons) : undefined,
            targetIcon: col.targetIcon !== undefined ? optionalIcon(col.targetIcon[rowIndex], warnings, rowIndex, "TargetIcon", icons) : undefined,
        };

        flows.push(flow);
    }

    return { flows, warnings };
}
