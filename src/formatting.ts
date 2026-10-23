/**
 * Number formatting and text measurement.
 *
 * This is the one module that imports `powerbi-visuals-utils-formattingutils`.
 * Going through the library, rather than `toLocaleString`, makes the visual use the
 * model's own format string (a measure formatted `#,##0 "kr"` draws that way) and
 * the report's locale instead of the browser's.
 *
 * It is kept in its own file because the library is ESM-only with extensionless
 * internal imports, so Node cannot `require` it, and the checks are plain JS that
 * require the compiled `src` modules. No module the checks load may import it,
 * which is why the formatter is injected as a function on `LabelOptions` rather
 * than built where it is used. `visual.ts` and this file are the only places that
 * touch the library.
 *
 * The injected function is deliberately not what the geometry cache keys on:
 * `geometryKey` stringifies `chrome` whole and `JSON.stringify` drops functions,
 * so the data the formatter was built from (`valueFormat`, `locale`,
 * `displayUnits`, `autoDecimals`, `units`, `decimalPlaces`) rides in `LabelOptions`
 * as plain fields, and those are what the key sees.
 */

import { textMeasurementService, valueFormatter } from "powerbi-visuals-utils-formattingutils";

import { DisplayUnits, LabelOptions } from "./model";

/** What a display-units choice means as a reference value for the formatter. */
const UNIT_VALUES: Record<DisplayUnits, number | undefined> = {
    // Auto is decided from the diagram's own largest figure, below.
    Auto: undefined,
    None: undefined,
    Thousands: 1e3,
    Millions: 1e6,
    Billions: 1e9,
    Trillions: 1e12
};

/** What the formatter needs that the format pane cannot say. */
export interface NumberContext {
    /** The Value field's format string from the model, when it has one. */
    valueFormat?: string;
    /** The report's locale, from `IVisualHost.locale`. */
    locale?: string;
    /**
     * The largest figure the diagram will draw, so Auto display units pick one unit
     * for the whole diagram. Per-label units would put "1.2M" beside "840K".
     */
    largest?: number;
}

/**
 * Builds the function `formatTotal` calls, from the Values card and the context
 * above. One formatter is built per update and shared by the layout and every
 * tooltip, so a node drawn "255.0 TWh" cannot tooltip as "255".
 */
export function valueFormatterFor(
    labels: Pick<LabelOptions, "displayUnits" | "autoDecimals" | "decimalPlaces">,
    context: NumberContext
): (value: number) => string {
    const units = labels.displayUnits ?? "None";
    // Auto asks the formatter to choose, which it does from the reference value.
    const reference = units === "Auto" ? context.largest : UNIT_VALUES[units];
    const options: valueFormatter.ValueFormatterOptions = {
        cultureSelector: context.locale
    };
    if (context.valueFormat !== undefined && context.valueFormat !== "") {
        options.format = context.valueFormat;
    }
    if (reference !== undefined && reference !== 0) {
        options.value = reference;
    }
    // An absent precision lets the format string decide, which is what "Automatic"
    // decimals offers the author. Given a number, it overrides the format.
    if (!labels.autoDecimals) {
        options.precision = labels.decimalPlaces;
    }
    const formatter = valueFormatter.create(options);
    return (value: number) => formatter.format(value);
}

/**
 * Measures how wide a string will really be drawn, for one font family.
 *
 * The measurement is canvas-based and caches internally, but it is still never
 * called from inside the fit's bisection: layout measures each node's strings once
 * per layout and passes the numbers down.
 */
export function textMeasurerFor(
    /** Used where the caller names no family of its own. */
    fallbackFamily: string
): (text: string, fontSize: number, bold: boolean, family?: string) => number {
    return (text: string, fontSize: number, bold: boolean, family?: string) =>
        textMeasurementService.measureSvgTextWidth({
            text,
            // The family is per call: the author picks one per text element, and measuring
            // with a different family from the one the browser renders with would be worse
            // than not measuring.
            fontFamily: family || fallbackFamily,
            fontSize: `${fontSize}px`,
            fontWeight: bold ? "bold" : "normal"
        });
}
