/**
 * The textures a flow type can be filled with, as data.
 *
 * There are two families sharing one index space: six hatches (indices 0-5), which are also what
 * high contrast allocates, and eight graphic patterns (indices 6-13). A stored or resolved texture
 * is one index, so everything that picks, saves or draws a texture reads this module.
 *
 * Each tile is drawn in one ink over a paper colour. Six hatches is the most that stay
 * distinguishable at the widths bands are drawn at; the patterns are for diagrams that want a more
 * graphic look and cycle in the same way.
 */

/** One mark in a tile: a stroked outline, or a solid shape when `filled`. */
export interface TileMark {
    tag: "path" | "circle" | "rect";
    attrs: Record<string, string>;
    filled?: boolean;
}

/** A repeating tile: its size, its marks and the width of any stroked mark. */
export interface TileSpec {
    name: string;
    width: number;
    height: number;
    strokeWidth: number;
    marks: TileMark[];
}

const path = (d: string, filled = false): TileMark => ({ tag: "path", attrs: { d }, filled });

/** Hatches first: forward and back diagonals, vertical, horizontal, a cross, and a wide diagonal. */
const HATCHES: TileSpec[] = [
    { name: "Forward", width: 6, height: 6, strokeWidth: 1.2, marks: [path("M 0 6 L 6 0")] },
    { name: "Back", width: 6, height: 6, strokeWidth: 1.2, marks: [path("M 0 0 L 6 6")] },
    { name: "Vertical", width: 6, height: 6, strokeWidth: 1.2, marks: [path("M 3 0 L 3 6")] },
    { name: "Horizontal", width: 6, height: 6, strokeWidth: 1.2, marks: [path("M 0 3 L 6 3")] },
    { name: "Cross", width: 6, height: 6, strokeWidth: 1.2, marks: [path("M 0 3 L 6 3 M 3 0 L 3 6")] },
    {
        name: "Wide", width: 6, height: 6, strokeWidth: 1.2,
        marks: [path("M -1 1 L 1 -1 M 0 6 L 6 0 M 5 7 L 7 5")]
    }
];

/** Then the graphic patterns. */
const PATTERNS: TileSpec[] = [
    { name: "Waves", width: 10, height: 8, strokeWidth: 1.1, marks: [path("M0 4 Q2.5 0 5 4 T10 4")] },
    { name: "Lattice", width: 10, height: 10, strokeWidth: 1, marks: [path("M0 0 L10 10 M10 0 L0 10")] },
    {
        name: "Dots", width: 8, height: 8, strokeWidth: 1,
        marks: [{ tag: "circle", attrs: { cx: "4", cy: "4", r: "1.5" }, filled: true }]
    },
    {
        name: "Rings", width: 10, height: 10, strokeWidth: 1,
        marks: [{ tag: "circle", attrs: { cx: "5", cy: "5", r: "2.6" } }]
    },
    {
        name: "Squares", width: 9, height: 9, strokeWidth: 1,
        marks: [{ tag: "rect", attrs: { x: "2", y: "2", width: "5", height: "5" } }]
    },
    { name: "Diamonds", width: 10, height: 10, strokeWidth: 1, marks: [path("M5 1 L9 5 L5 9 L1 5 Z")] },
    { name: "Chevrons", width: 10, height: 8, strokeWidth: 1.1, marks: [path("M0 6 L5 2 L10 6")] },
    { name: "Scales", width: 10, height: 6, strokeWidth: 1, marks: [path("M0 6 A5 5 0 0 1 10 6")] }
];

/** Every texture, in index order. */
export const TEXTURES: readonly TileSpec[] = [...HATCHES, ...PATTERNS];

/** How many hatches there are: the textures high contrast allocates, and the first indices. */
export const HATCH_COUNT = HATCHES.length;

/** How many graphic patterns there are, following the hatches. */
export const PATTERN_COUNT = PATTERNS.length;

/** How many textures there are to choose from in all. */
export const TEXTURE_COUNT = TEXTURES.length;

/** What each texture is called in the editor's picker. */
export const TEXTURE_NAMES: readonly string[] = TEXTURES.map(tile => tile.name);

/** The automatic hatch for a flow type's legend rank. */
export function autoHatch(rank: number): number {
    return rank % HATCH_COUNT;
}

/** The automatic pattern for a flow type's legend rank. */
export function autoPattern(rank: number): number {
    return HATCH_COUNT + (rank % PATTERN_COUNT);
}

/** What the texture is drawn in: the flow type's colour, a contrasting shade, the theme's text, or a pick. */
export type TextureInkMode = "Type" | "Contrast" | "Auto" | "Custom";

/** What sits behind the texture: the report background, the flow type's colour, or a pick. */
export type TexturePaperMode = "Background" | "Type" | "Custom";

/** Everything that decides one flow type's texture colours. */
export interface TextureColourInputs {
    /** The flow type's resolved colour. */
    typeColour: string;
    /** The report theme's background and text colours. */
    reportBackground: string;
    themeForeground: string;
    /** The pane's choices. */
    inkMode: TextureInkMode;
    inkCustom?: string;
    paperMode: TexturePaperMode;
    paperCustom?: string;
    /** What the editor stored for this type, which beats the pane. */
    inkOverride?: string;
    paperOverride?: string;
}

/**
 * A shade that reads against `colour`: darker over a light colour, lighter over a dark one. A colour
 * that is not `#RRGGBB` is returned as it is.
 */
export function contrastOf(colour: string): string {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour.trim());
    if (!m) {
        return colour;
    }
    const rgb = [m[1], m[2], m[3]].map(c => parseInt(c, 16));
    const linear = rgb.map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const light = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] > 0.3;
    const target = light ? 0 : 255;
    const amount = light ? 0.4 : 0.5;
    const mixed = rgb.map(v => Math.round(v + (target - v) * amount));
    return "#" + mixed.map(v => v.toString(16).padStart(2, "0")).join("");
}

/**
 * The two colours a textured flow type is drawn in. The editor's choice beats the pane's, the pane's
 * beats the default, exactly as for the flow type's own colour. Where the texture would come out in
 * the colour it sits on (the flow type's colour over itself) it falls back to the contrasting shade,
 * so a texture is never invisible.
 */
export function textureColours(i: TextureColourInputs): { ink: string; paper: string } {
    const paper = i.paperOverride
        ?? (i.paperMode === "Type" ? i.typeColour
            : i.paperMode === "Custom" ? (i.paperCustom ?? i.reportBackground)
                : i.reportBackground);
    let ink = i.inkOverride
        ?? (i.inkMode === "Contrast" ? contrastOf(paper)
            : i.inkMode === "Auto" ? i.themeForeground
                : i.inkMode === "Custom" ? (i.inkCustom ?? i.themeForeground)
                    : i.typeColour);
    if (ink.toLowerCase() === paper.toLowerCase()) {
        ink = contrastOf(paper);
    }
    return { ink, paper };
}

/**
 * One texture tile as a standalone SVG image in a data URI, for a CSS background. The editor uses it
 * for the preview of the flow being edited; the diagram itself draws textures as SVG patterns.
 */
export function tileDataUri(index: number, ink: string, paper: string): string {
    const tile = TEXTURES[index];
    if (!tile) {
        return "";
    }
    const marks = tile.marks.map(mark => {
        const attrs = Object.keys(mark.attrs).map(name => `${name}="${mark.attrs[name]}"`).join(" ");
        const paint = mark.filled
            ? `fill="${ink}"`
            : `fill="none" stroke="${ink}" stroke-width="${tile.strokeWidth}"`;
        return `<${mark.tag} ${attrs} ${paint}/>`;
    }).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${tile.height}">`
        + `<rect width="${tile.width}" height="${tile.height}" fill="${paper}"/>${marks}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
