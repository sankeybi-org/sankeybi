import { Bounds, Point, PositionedNode } from "./model";
import { Arc, PathSegment } from "./routeTypes";

/** Signed area of the triangle p-q-r; its sign is the turn direction. */
function cross3(p: Point, q: Point, r: Point): number {
    return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

/**
 * Do the two segments properly cross? Strictly: segments that merely touch at an endpoint, or
 * lie along each other, do not count. Two corridors leaving the same node's edge have distinct
 * anchors, so they are not excluded by this; their crossing is exactly the one reordering
 * exists to fix.
 */
export function segmentsCross(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
    const d1 = cross3(b1, b2, a1);
    const d2 = cross3(b1, b2, a2);
    const d3 = cross3(a1, a2, b1);
    const d4 = cross3(a1, a2, b2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
        && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function dot(a: Point, b: Point): number {
    return a.x * b.x + a.y * b.y;
}

export function scale(v: Point, k: number): Point {
    return { x: v.x * k, y: v.y * k };
}

export function add(a: Point, b: Point): Point {
    return { x: a.x + b.x, y: a.y + b.y };
}

export function midpoint(a: Point, b: Point): Point {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function centreOf(node: PositionedNode): Point {
    return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

export function sub(a: Point, b: Point): Point {
    return { x: a.x - b.x, y: a.y - b.y };
}

export function length(v: Point): number {
    return Math.hypot(v.x, v.y);
}

export function unit(v: Point): Point {
    const len = length(v) || 1;
    return { x: v.x / len, y: v.y / len };
}

export function boundsOf(points: Point[]): Bounds {
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
    };
}

export function segmentLength(segment: PathSegment): number {
    return segment.kind === "line"
        ? length(sub(segment.b, segment.a))
        : length(sub(segment.arc.p3, segment.arc.p0));
}

/** Rough length of an arc's cubic pieces, for choosing between candidates. */
export function arcLength(arc: { segments: PathSegment[]; radius: number }): number {
    return arc.segments.reduce((total, segment) => total + segmentLength(segment), 0);
}

/** Reverses one cubic, so an arc built from its far end runs the right way. */
export function reverseCubic(segment: PathSegment): PathSegment {
    if (segment.kind !== "cubic") {
        return { kind: "line", a: segment.b, b: segment.a };
    }
    const { p0, p1, p2, p3 } = segment.arc;
    return { kind: "cubic", arc: { p0: p3, p1: p2, p2: p1, p3: p0 } };
}

export function cubicPoint(arc: Arc, t: number): Point {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return {
        x: a * arc.p0.x + b * arc.p1.x + c * arc.p2.x + d * arc.p3.x,
        y: a * arc.p0.y + b * arc.p1.y + c * arc.p2.y + d * arc.p3.y
    };
}

export function cubicTangent(arc: Arc, t: number): Point {
    const mt = 1 - t;
    const a = 3 * mt * mt;
    const b = 6 * mt * t;
    const c = 3 * t * t;
    return {
        x: a * (arc.p1.x - arc.p0.x) + b * (arc.p2.x - arc.p1.x) + c * (arc.p3.x - arc.p2.x),
        y: a * (arc.p1.y - arc.p0.y) + b * (arc.p2.y - arc.p1.y) + c * (arc.p3.y - arc.p2.y)
    };
}

/** Where two infinite lines cross, or undefined if they're parallel. */
export function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | undefined {
    const d1 = sub(p2, p1);
    const d2 = sub(p4, p3);
    const denominator = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denominator) < 1e-9) {
        return undefined;
    }
    const t = ((p3.x - p1.x) * d2.y - (p3.y - p1.y) * d2.x) / denominator;
    return add(p1, scale(d1, t));
}
