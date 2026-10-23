/**
 * Unique element ids for the clip paths, masks and icon definitions a render
 * writes into the SVG.
 *
 * Ids are scoped to the SVG being drawn, so two SankeyBI visuals in one
 * document never share an id (a `url(#id)` reference resolves document-wide),
 * and the numbering restarts on every render because each render empties the
 * SVG first.
 */

const scopeOf = new WeakMap<SVGSVGElement, number>();
let scopesIssued = 0;
let scope = 0;
const counters = new Map<string, number>();

/** Starts a render of `svg`: its ids are scoped to it and numbered from zero. */
export function beginIds(svg: SVGSVGElement): void {
    let id = scopeOf.get(svg);
    if (id === undefined) {
        id = ++scopesIssued;
        scopeOf.set(svg, id);
    }
    scope = id;
    counters.clear();
}

/** The next unused id of this kind, such as `sankeybi-1-nodeclip-0`. */
export function nextId(kind: string): string {
    const n = counters.get(kind) ?? 0;
    counters.set(kind, n + 1);
    return `sankeybi-${scope}-${kind}-${n}`;
}
