/**
 * Types shared by the routing modules: slots, spine samples, routes, handles, routing
 * options and what a routed diagram hands back.
 */

import { ArrowOptions, Corridor, Point, Port, PositionedNode, RoutedBand } from "./model";
import { RoutingStyle } from "./routingStyle";

export type EndRole = "source" | "target";

export interface PortEnd {
    corridor: Corridor;
    role: EndRole;
}

export interface PortGroup {
    node: PositionedNode;
    port: Port;
    ends: PortEnd[];
}

/** A packed slot, expressed along its port's own packing axis. */
export interface Slot {
    centre: number;
    halfExtent: number;
}

export interface Anchor {
    point: Point;
    port: Port;
    halfExtent: number;
}

export interface SpineSample {
    x: number;
    y: number;
    /** Unit normal (left of travel) at this sample. */
    nx: number;
    ny: number;
    /** 0 at the source anchor, 1 at the target anchor; drives the offset taper. */
    weight: number;
}

export interface Arc {
    p0: Point;
    p1: Point;
    p2: Point;
    p3: Point;
}

export type PathSegment =
    | { kind: "line"; a: Point; b: Point }
    | { kind: "cubic"; arc: Arc };

/**
 * A built route, in whichever form its band needs.
 *
 * `sampled` is the general case: points with local normals, offset sideways per sample.
 * `sharp` keeps the raw polyline instead, because a sharp corner cannot be produced by
 * sweeping a normal (see `offsetPolyline`); its band edges come from mitring the corners.
 */
export type Route =
    | { kind: "sampled"; samples: SpineSample[] }
    | { kind: "sharp"; vertices: Point[]; weights: number[] };

/**
 * A corridor's draggable handles, in pixels, and the one axis each may move along. Every one
 * of them is optional, because which of them a route actually has is a property of how it was
 * drawn:
 *
 *  - `middle` is absent for a route with no crossover to move: a smooth direct curve, or an L,
 *    whose corner is simply where its two stubs meet and which therefore moves when a lead
 *    does.
 *  - `source`/`target` are absent in Orthogonal, which offers the step alone. The lead-ins
 *    there come from the style's defaults and stay uniform across the diagram, which is most
 *    of what makes a squared-off diagram look deliberate rather than hand-tweaked.
 */
export interface RouteHandles {
    source?: { point: Point; axis: "x" | "y"; side?: LeadSide; angleSnap?: AngleSnap };
    target?: { point: Point; axis: "x" | "y"; side?: LeadSide; angleSnap?: AngleSnap };
    /**
     * True where the leads exist for routing (avoidance reads their stubs) but are not the
     * author's to move: a Polyline 90-degree corner. Hidden for display in `draggableHandles`,
     * never removed here.
     */
    hideLeads?: boolean;
    /**
     * A self-loop's handles. Marked so `draggableHandles` can show them in every style (Orthogonal
     * otherwise offers the step alone), because a loop is designed the same whatever the style.
     */
    loop?: boolean;
    /**
     * A wrap between two nodes. Marked for the same reason `loop` is: it tells `draggableHandles`
     * to keep this route's leads in Orthogonal, where a direct route's are stripped. A wrap is
     * squared off identically in every style, so its leads place real axis-aligned runs there, and
     * hiding them would leave half of the port pairings with no handle at all. `routeCorridor`
     * must agree: a style that hides a handle has to ignore its stored override, and a style that
     * shows one has to read it.
     */
    wrap?: boolean;
    /**
     * `gesture` marks a middle that is a bend rather than a stored crossover. A diagonal's bend
     * slides the two leads and stores no third number, where a Z's or a lane's middle is a value
     * in its own right, and only routing knows which of the two it just built. Telling them apart
     * by routing style would be wrong for every wrap: a self-loop in Smooth has a lane, and
     * treating it as a bend would write the drag into two lead overrides that the lane never
     * reads.
     */
    middle?: { point: Point; axis: "x" | "y"; gesture?: boolean };
    /**
     * The lane an avoided route passes its obstacle along, present only where avoidance actually
     * added a detour.
     *
     * It is drawn on the middle of the lane run, and constrained to the one axis across the
     * direction the route travels, so one drag says both of the things an author wants to say
     * about a detour: how far out it goes, and (past the obstacle's other edge) which side it
     * passes on.
     *
     * It exists because nothing else on a detoured route can move it. The leads and the bend place
     * the two stubs, and a squared detour's first waypoint takes the stub's own cross coordinate,
     * so the run from the anchor through the stub into the detour is straight and moving the stub
     * along it changes nothing that is drawn. Without this handle the only way to correct an
     * avoided route would be to move the obstacle away, move the route, and move the obstacle
     * back.
     */
    detour?: { point: Point; axis: "x" | "y" };
    /**
     * This route's shape handles describe the line as the author placed it, not the band that is
     * drawn.
     *
     * Set only where avoidance added a detour. `detour` shapes the way round; the leads and the
     * middle beside it are the undetoured route's, carried over from the base construction, and
     * they are what the author moves to get back to a line that needs no detour at all.
     *
     * Without this, a detour would take the middle away outright (`handlesFor` gates it on
     * `detours.length === 0`) and the leads that survived are ones a squared detour cannot respond
     * to, so in Orthogonal and on a 90-degree corner the lane would be the only control there is.
     * Dropping the lane elsewhere never clears a detour: it shapes the way round, which is its
     * job, and nothing else said the other thing.
     *
     * render.ts draws these solid and dark against the hollow position handles (the same
     * distinction the corner handle already makes) over a ghost of `ghost`, so what they move is
     * visible rather than implied. arrangeFlows.ts refuses to search a middle marked this way:
     * it would otherwise store one, and a stored middle stands avoidance down (`usesCrossover`),
     * which is an author's decision and not a search's.
     */
    asPlaced?: boolean;
    /** A Smooth self-loop's roundness: see `CornerHandle`. */
    corner?: CornerHandle;
}

/**
 * What an Octilinear lead needs to snap its diagonal's angle as it is dragged. A same-axis
 * corridor between two nodes is out, one diagonal, in; with the other lead held where it is,
 * the dragged lead alone sets the diagonal's angle.
 *
 * The maths lives in interaction.ts (`snapLeadToAngle`); this is the geometry it needs: the
 * other end's stub, this end's anchor and outward normal, and the shortest lead routing allows
 * (the band's half-width + 1px), so a snapped drop never lands somewhere routing would refuse.
 */
export interface AngleSnap {
    other: Point;
    anchor: Point;
    normal: Point;
    minLead: number;
    /** The angle step, in degrees (45 for Octilinear). */
    step: number;
}

/**
 * Where a Smooth self-loop's lead handle is drawn: the middle of its side. A lead places one
 * of the loop's sides (the run from its stub to the next corner), so the handle sits in the
 * middle of that run, and dragging it along the port's direction moves the side it is on. At
 * the stub it would sit at the corner's apex, which on a rounded loop is empty space outside
 * the curve. On the side it needs no solving: every point of the side shares the stub's
 * coordinate along the drag, so a drop lands where it was dropped by construction.
 *
 * `point` on the handle stays the stub, deliberately: avoidance reads the leads' stubs off
 * these handles to span its detours, and the stored override is a stub too, so switching style
 * reads it exactly as before.
 */
export interface LeadSide {
    /** Where the handle is drawn: the middle of the side this lead places. */
    drawn: Point;
    /** The drawn point a given stub position would produce. */
    toDrawn: (stub: Point) => Point;
    /** The stub position that puts the side under `drawn`. */
    toStub: (drawn: Point) => Point;
}

/**
 * A Smooth self-loop's corner handle: roundness, not position. The loop's other three handles
 * each place something: the two leads place its vertical sides and the lane its top. This one
 * sits on the middle of one corner's arc and slides only along that corner's diagonal:
 * towards the inside for rounder, towards the corner for sharper. There is one handle rather
 * than four because the corners share one radius; a loop is read all at once, so unequal
 * corners make a stadium rather than a rounded rectangle.
 *
 * It carries what the drag needs to turn a pointer into a radius without asking routing again:
 * the corner's `apex` (the vertex being rounded), `direction` (the unit diagonal pointing
 * inside), `spread` (how far along that diagonal the arc's midpoint sits per pixel of radius:
 * sqrt(2) - 1 for a right angle) and the radius bounds. `pitch` converts a radius in pixels to
 * the stored unit, a fraction of the tighter grid pitch.
 */
export interface CornerHandle {
    point: Point;
    apex: Point;
    direction: Point;
    spread: number;
    /** Radius, in pixels, that the arc actually has. */
    radius: number;
    /** Tighter than this and the band's inner edge turns inside out. */
    minRadius: number;
    /** Rounder than this and a straight runs out: the corners stop. */
    maxRadius: number;
    pitch: number;
    /**
     * True where this handle is the route's only shape control, so the lead handles are not shown:
     * a direct 90-degree Smooth corner, whose leads are both derived from its radius (see
     * `buildSpine`). Hidden for display in `draggableHandles`, never removed at the source:
     * avoidance reads the leads' stubs off these handles to span its detours.
     */
    replacesLeads?: boolean;
}

/** Handles of a route that was actually built: both lead handles always exist. */
export interface BuiltHandles extends RouteHandles {
    source: NonNullable<RouteHandles["source"]>;
    target: NonNullable<RouteHandles["target"]>;
}

/** What `buildSpine` hands back: the route, its handles, and how it was drawn. */
export interface Built {
    route: Route;
    handles: BuiltHandles;
    /** True when the route was squared off, which decides the detour shape. */
    squared: boolean;
    /**
     * The centreline polyline this route was built from, before its corners were rounded:
     * `anchor -> stub -> [waypoints] -> stub -> anchor`.
     *
     * Handed back so layers.ts can ask which way a corridor is travelling at a given point without
     * re-deriving it from the drawn path. Deriving it a second time elsewhere is the drift hazard
     * `handles` is returned from here to avoid: the band outline can be paired back into a
     * midline, but only by knowing how many samples each edge got and where the end cap falls,
     * which is routing's business and nobody else's.
     */
    spine: Point[];
    /**
     * Where each end's straight run stops: the start of the corner arc on a 90-degree L, and
     * undefined for every other route shape. See `runEndsOf`: the packing rule reads this as the
     * end's lead-in, because on an L the port stub is not where the route departs from.
     */
    runEnds?: { source: Point; target: Point };
    /**
     * The centreline this route would have had with nothing in its way, present only where
     * avoidance added a detour.
     *
     * It is the line the `asPlaced` handles sit on, and render draws it faint so a handle that is
     * off the drawn band still has something under it. It is taken from the base build rather than
     * reconstructed, for the reason `spine` itself is returned from here: a second derivation is a
     * second thing to drift.
     */
    ghost?: Point[];
}

/** Hand-moved handle positions for one corridor, in pixels. */
export interface RouteOverridePoints {
    source?: Point;
    target?: Point;
    middle?: Point;
    /**
     * Where an avoided route passes its obstacle: a point whose coordinate across the route is
     * the lane. Projected rather than used whole, exactly as `middle` is; see
     * `RouteHandleOverrides.detour`.
     */
    detour?: Point;
    /**
     * A Smooth self-loop's corner radius, as a fraction of the tighter grid pitch (not a point:
     * the one scalar that rides along with them).
     */
    radius?: number;
}

/** Per-corridor routing lengths, all resolved from the grid pitch and the band's own width. */
export interface RouteGeometry {
    /** Port lead-in for an East/West port (measured along x). */
    leadX: number;
    /** Port lead-in for a North/South port (measured along y). */
    leadY: number;
    /**
     * Ceilings on the lead-ins for a direct route, so the two ends cannot between them eat the
     * grid space the curve needs; see `buildSpine`.
     */
    maxLeadX: number;
    maxLeadY: number;
    /** How far outside the nodes a wrap route's lane runs. */
    clearance: number;
    /** Uniform quarter-turn radius for squared-off routes; 0 means mitred sharp corners. */
    radius: number;
    /**
     * The Curvature setting as a fraction. A squared-off route spends it on corner radii; a Smooth
     * one has no corners, and spends it on how much of the span is reserved for the curve itself.
     */
    curvature: number;
    /** Half the band's width at its widest end: how far its edges reach from the centreline. */
    bandReach: number;
    /** The tighter grid pitch: the unit a stored corner radius is measured in. */
    pitch: number;
    style: RoutingStyle;
}

/** Format-pane routing lengths, as percentages of the grid spacing (see settings.ts). */
export interface RoutingOptions {
    /**
     * An explicit lead-in for every corridor, as a percentage of the grid spacing. The visual does
     * not set it; left undefined, each style uses `DEFAULT_LEAD_FRACTION`. The checks set it to
     * hold a lead fixed while they measure something else.
     */
    portLeadInPercent?: number;
    curvaturePercent: number;
    style: RoutingStyle;
    /** Route corridors around nodes they would otherwise pass through. */
    avoidNodes?: boolean;
    /** Arrow heads and tails drawn inside each node. */
    arrows?: ArrowOptions;
}

/**
 * A packed order handed to `computeAnchors` from outside: for each face
 * (`${nodeId}|${port}`), the order its ends sit in (`anchorKey`s).
 */
export type PackingOrder = Map<string, string[]>;

/** One end of one corridor, as the stub-line rule sees it. */
export interface StubLineEnd {
    key: string;
    /** Where this end sits on its face right now, along the packing axis. */
    at: number;
    /** Unused: nothing is placed by rule any more. */
    pinned: boolean;
    /** Key 1: the departure direction, +-90 for an L or a loop. */
    angle: number;
    /** Key 2's input: the crossing run, in this face's own frame. */
    via: { forward: number; across: number };
    /** How far this end's lead-in reaches out from the face. */
    stubForward: number;
    /**
     * Where this corridor heads, in this face's frame: the far lead-in, or a loop's first corner.
     * `pairFits`' end of the chord.
     */
    far: { forward: number; across: number };
}

/**
 * What a routed diagram hands back.
 *
 * `reroute` exists for Arrange flows, which tries a great many candidate handle positions on
 * one corridor and needs to know what each would draw. Routing the whole diagram per candidate
 * is far too slow to be interactive; re-routing the single corridor against the anchors and
 * lanes this pass already settled is a small fraction of the work.
 *
 * It is deliberately an approximation of a full re-route: port packing and the lane stagger
 * are decided across the whole diagram, so a candidate that would flip a self-loop or crowd a
 * lane is scored as if it had not. That is fine for choosing between candidates, and Arrange
 * flows re-routes the diagram properly before it keeps one, so nothing is ever kept on the
 * strength of this alone.
 */
export interface DiagramRouting {
    bands: RoutedBand[];
    handles: Map<string, RouteHandles>;
    /**
     * Each corridor's centreline polyline, keyed by corridor id.
     *
     * layers.ts decides the paint order from which way a corridor is travelling where it crosses
     * another, and that question is about the route rather than the drawn outline.
     */
    spines: Map<string, Point[]>;
    /**
     * Each corridor's drawn centreline, keyed by corridor id.
     *
     * `spines` is the route's control polyline, with sharp corners; the band follows the rounded
     * (or arc-fitted) version of it, and the two part by up to a corner radius. Where two
     * corridors cross is a question about what is drawn, so the crossing channels and the paint
     * order read this. `spines` stays for what was tuned against it (the port packing order).
     */
    centrelines: Map<string, Point[]>;
    /**
     * Where each end's straight run stops, for the routes that have a corner to stop at: a
     * 90-degree L. Keyed by corridor id; absent for every other shape. `stubLineOrder` uses it as
     * the end's lead-in.
     */
    runEnds: Map<string, { source: Point; target: Point }>;
    /**
     * The undetoured centreline of each corridor avoidance sent round something: the line its
     * `asPlaced` handles sit on.
     *
     * Only detoured corridors appear, so an ordinary diagram's map is empty and render draws
     * nothing extra.
     */
    ghosts: Map<string, Point[]>;
    /**
     * Each corridor's own outline as one closed path, keyed by corridor id.
     *
     * render.ts erases a channel around a crossing corridor with it (Crossing separation). It is
     * built in routing from the same edge function the stripes were, rather than recovered from a
     * band path by render, which would have to know how many samples each edge got and where the
     * end cap falls.
     */
    silhouettes: Map<string, string>;
    infill: NodeInfill[];
    reroute(corridorId: string, override: RouteOverridePoints):
        { bands: RoutedBand[]; handles: RouteHandles; spine: Point[] } | undefined;
}

/** One stripe of one face's arrow, ready to paint. */
export interface NodeInfill {
    nodeId: string;
    port: Port;
    corridorId: string;
    flowType: string | undefined;
    value: number;
    /** Whether this stripe belongs to an arrow head (inbound) or a tail (outbound). */
    kind: "head" | "tail";
    path: string;
    /**
     * The outline to stroke, with the base edge dropped. Empty where nothing survives. Stroke
     * this, never `path`: see `stripeOutlineRuns`.
     */
    outline: string;
}

/** A half-plane `a*t + b*y + c <= 0` in a face's local (inward, along-face) frame. */
export interface HalfPlane {
    a: number;
    b: number;
    c: number;
}

/** One end packed onto a face, with where it sits along that face. */
export interface FaceEnd {
    corridor: Corridor;
    role: EndRole;
    anchor: Anchor;
    centre: number;
}
