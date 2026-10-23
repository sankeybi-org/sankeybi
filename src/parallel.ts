/**
 * Which flows lie along each other.
 *
 * Two flows that run along each other for a stretch cannot be told apart by eye,
 * and that is the thing Arrange flows exists to fix. This module answers "which
 * pairs do" geometrically, on the routed centrelines, without rasterising.
 *
 * Orthogonal, Octilinear and Polyline centrelines are a handful of straight
 * segments, so two flows lie together exactly where two near-parallel segments are
 * closer than their half-widths plus `GAP_PX`. That is a few arithmetic operations
 * per segment pair, and a candidate route can be scored against the rest in
 * microseconds.
 *
 * - The distance that counts as together is `(widthA + widthB) / 2 + GAP_PX`, so
 *   flows that touch, or sit within a pixel of each other, are sharing.
 * - Both end leads are skipped when a route has three or more segments: flows
 *   leaving one face are stacked side by side by design and no handle can change
 *   that. A two-segment L has no lead to skip.
 * - A pair is parallel when the length they lie together is at least
 *   `max(MIN_LENGTH_PITCHES x pitch, LENGTH_WIDTHS x the wider band)`, which keeps
 *   a 90 degree crossing out whatever the widths, or when it is a large share of
 *   the shorter flow's whole run (`PARALLEL_THRESHOLD`).
 *
 * Pure: it reads routed spines and bands only.
 */

import { LayoutResult, Point, RoutedBand } from "./model";

const GAP_PX = 1;

/** A pair is parallel when the length together is this share of the shorter flow. */
export const PARALLEL_THRESHOLD = 0.4;

/**
 * What counts toward a candidate's score: pairs sharing at least this share.
 * Below it the pair is a crossing.
 */
export const PARALLEL_FLOOR = 0.2;

/** ...or when they lie together for this many pitches, and... */
const MIN_LENGTH_PITCHES = 0.5;
/**
 * ...this many times the wider band's width: 90 degrees is 1x, 45 degrees is
 * 1.4x, 30 degrees is 2x.
 */
const LENGTH_WIDTHS = 2;

/** Two segments are parallel within this angle. */
const ANGLE_TOLERANCE = Math.sin((5 * Math.PI) / 180);

interface Seg {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    /** Unit direction and length. */
    ux: number;
    uy: number;
    len: number;
}

interface Shape {
    /** The segments that count (leads dropped), and the whole run's length. */
    segs: Seg[];
    run: number;
    width: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function shapeOf(spine: Point[], width: number): Shape {
    // Drop repeated points and collinear interior points so a straight run is one
    // segment.
    const pts: Point[] = [];
    spine.forEach(p => {
        const n = pts.length;
        if (n > 0 && Math.abs(pts[n - 1].x - p.x) < 1e-9 && Math.abs(pts[n - 1].y - p.y) < 1e-9) {
            return;
        }
        if (n >= 2) {
            const a = pts[n - 2];
            const b = pts[n - 1];
            const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
            const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
            if (Math.abs(cross) < 1e-6 && dot > 0) {
                pts[n - 1] = p;
                return;
            }
        }
        pts.push(p);
    });
    const all: Seg[] = [];
    let run = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pts.length; i++) {
        minX = Math.min(minX, pts[i].x);
        maxX = Math.max(maxX, pts[i].x);
        minY = Math.min(minY, pts[i].y);
        maxY = Math.max(maxY, pts[i].y);
        if (i + 1 < pts.length) {
            const dx = pts[i + 1].x - pts[i].x;
            const dy = pts[i + 1].y - pts[i].y;
            const len = Math.hypot(dx, dy);
            run += len;
            if (len > 0.5) {
                all.push({ ax: pts[i].x, ay: pts[i].y, bx: pts[i + 1].x, by: pts[i + 1].y, ux: dx / len, uy: dy / len, len });
            }
        }
    }
    // The leads are there by design; a route of two segments is an L with none.
    const segs = all.length >= 3 ? all.slice(1, all.length - 1) : all;
    return { segs, run, width, minX, minY, maxX, maxY };
}

/** How far two shapes lie together: the length of near-parallel segment overlap within reach. */
function together(a: Shape, b: Shape): number {
    const reach = (a.width + b.width) / 2 + GAP_PX;
    if (a.maxX + reach < b.minX || b.maxX + reach < a.minX
        || a.maxY + reach < b.minY || b.maxY + reach < a.minY) {
        return 0;
    }
    let length = 0;
    a.segs.forEach(s => {
        b.segs.forEach(t => {
            if (Math.abs(s.ux * t.uy - s.uy * t.ux) > ANGLE_TOLERANCE) {
                return;
            }
            // Perpendicular distance of the other segment's start from this line.
            const d = Math.abs((t.ax - s.ax) * s.uy - (t.ay - s.ay) * s.ux);
            if (d > reach) {
                return;
            }
            const p0 = (t.ax - s.ax) * s.ux + (t.ay - s.ay) * s.uy;
            const p1 = (t.bx - s.ax) * s.ux + (t.by - s.ay) * s.uy;
            const overlap = Math.min(s.len, Math.max(p0, p1)) - Math.max(0, Math.min(p0, p1));
            if (overlap > 0) {
                length += overlap;
            }
        });
    });
    return length;
}

export class ParallelField {
    private readonly ids: string[];
    private readonly indexOf = new Map<string, number>();
    private readonly shapes: (Shape | undefined)[];
    private readonly widths: number[];
    private readonly pitch: number;

    constructor(layout: LayoutResult, routing: { bands: RoutedBand[]; spines: Map<string, Point[]> }) {
        this.ids = layout.corridors.map(c => c.id);
        this.ids.forEach((id, i) => this.indexOf.set(id, i));
        this.pitch = Math.max(1, Math.min(layout.columnGap || 0, layout.rowPitch || 0));
        this.widths = this.ids.map(() => 0);
        routing.bands.forEach(band => {
            const index = this.indexOf.get(band.corridorId);
            if (index !== undefined) {
                this.widths[index] += band.width;
            }
        });
        this.shapes = this.ids.map((id, i) => {
            const spine = routing.spines.get(id);
            return spine && spine.length >= 2 ? shapeOf(spine, this.widths[i]) : undefined;
        });
    }

    private qualifies(length: number, a: Shape, b: Shape, floor: number): boolean {
        if (length <= 0) {
            return false;
        }
        const wider = Math.max(a.width, b.width, 1);
        if (length >= Math.max(MIN_LENGTH_PITCHES * this.pitch, LENGTH_WIDTHS * wider)) {
            return true;
        }
        const shorter = Math.min(a.run, b.run);
        return shorter > 0 && length / shorter >= floor;
    }

    /** Every other corridor lying together with `id` enough to count, with the length. */
    partnersOf(id: string, floor: number = PARALLEL_THRESHOLD, spine?: Point[]):
        { other: string; length: number; fraction: number }[] {
        const self = this.indexOf.get(id);
        if (self === undefined) {
            return [];
        }
        const mine = spine ? shapeOf(spine, this.widths[self]) : this.shapes[self];
        if (!mine) {
            return [];
        }
        const out: { other: string; length: number; fraction: number }[] = [];
        this.shapes.forEach((theirs, other) => {
            if (other === self || !theirs) {
                return;
            }
            const length = together(mine, theirs);
            if (this.qualifies(length, mine, theirs, floor)) {
                const shorter = Math.min(mine.run, theirs.run);
                out.push({ other: this.ids[other], length, fraction: shorter > 0 ? length / shorter : 0 });
            }
        });
        return out;
    }

    /** The corridors in at least one parallel pair, and the number of pairs. */
    parallel(threshold: number = PARALLEL_THRESHOLD): { ids: Set<string>; pairs: number } {
        const ids = new Set<string>();
        let twice = 0;
        this.ids.forEach(id => {
            const partners = this.partnersOf(id, threshold);
            if (partners.length > 0) {
                ids.add(id);
                twice += partners.length;
            }
        });
        return { ids, pairs: twice / 2 };
    }

    /**
     * What a corridor costs by running along others, in pixels of length
     * together. `spine` may be a trial's, in which case the other corridors
     * are as this field holds them.
     */
    score(id: string, spine?: Point[], floor: number = PARALLEL_FLOOR): number {
        let total = 0;
        this.partnersOf(id, floor, spine).forEach(p => {
            total += p.length;
        });
        return total;
    }

    /** Puts a trial's centreline in place of the corridor's own, in this field. */
    replace(id: string, spine: Point[]): void {
        const index = this.indexOf.get(id);
        if (index !== undefined && spine.length >= 2) {
            this.shapes[index] = shapeOf(spine, this.widths[index]);
        }
    }

    /** The whole diagram's score: each pair once. */
    total(floor: number = PARALLEL_FLOOR): number {
        let sum = 0;
        this.ids.forEach(id => {
            sum += this.score(id, undefined, floor);
        });
        return sum / 2;
    }
}
