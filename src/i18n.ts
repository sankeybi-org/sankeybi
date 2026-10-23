/**
 * Translated text.
 *
 * English lives in the source, next to the thing it names, and is the fallback for every lookup. A
 * translation is a `stringResources/<locale>/resources.resjson` file mapping the same keys to text;
 * the host picks the file for the report's language and `t` asks it. A key with no translation
 * reads as its English, so a partly translated language still works.
 *
 * Keys are derived rather than written out, so the pane cannot drift from them:
 *   card              `<card>`                        e.g. `corridors`
 *   group             `<card>.<group>`                e.g. `corridors.flowsRoute`
 *   slice             `<card>.<slice>` and `.desc`    e.g. `corridors.flowWidth`, `corridors.flowWidth.desc`
 *   dropdown choice   `<card>.<slice>.<value>`        e.g. `corridors.routingStyle.Polyline`
 * (card, group and slice names are the ones in the settings classes). Text the visual draws itself
 * uses explicit keys under `ui.`. `checks/i18n-check.js` keeps the English resource file, these
 * keys and every other language file in step.
 */

type Lookup = (key: string) => string | undefined;

let lookup: Lookup | undefined;

/** Called once by the visual with the host's localisation manager. Without one, everything is English. */
export function setLocalizer(manager: powerbi.extensibility.ILocalizationManager | undefined): void {
    lookup = manager ? (key: string) => manager.getDisplayName(key) : undefined;
}

/** The translation of `key`, or `english` when there is none (or no localiser at all). */
export function t(key: string, english: string): string {
    if (!lookup) {
        return english;
    }
    let found: string | undefined;
    try {
        found = lookup(key);
    } catch {
        found = undefined;
    }
    return found && found !== key ? found : english;
}

/** `t` for a string with `{0}`, `{1}` placeholders. */
export function tf(key: string, english: string, ...args: Array<string | number>): string {
    return t(key, english).replace(/\{(\d+)\}/g, (whole, i) => {
        const value = args[Number(i)];
        return value === undefined ? whole : String(value);
    });
}

interface Named {
    name?: string;
    displayName?: string;
    description?: string;
}

interface Choice {
    value: string | number | boolean;
    displayName: string;
}

/** What each text said in English, so a rebuild with another language translates from the source text. */
const english = new WeakMap<object, { displayName?: string; description?: string }>();

function say(item: Named, key: string, withDescription: boolean): void {
    let original = english.get(item);
    if (!original) {
        original = { displayName: item.displayName, description: item.description };
        english.set(item, original);
    }
    if (original.displayName !== undefined) {
        item.displayName = t(key, original.displayName);
    }
    if (withDescription && original.description !== undefined) {
        item.description = t(`${key}.desc`, original.description);
    }
}

function sliceOf(card: string, slice: Named & { items?: Choice[] }): void {
    if (!slice.name) {
        return;
    }
    const key = `${card}.${slice.name}`;
    say(slice, key, true);
    if (Array.isArray(slice.items)) {
        for (const choice of slice.items) {
            say(choice as unknown as Named, `${key}.${String(choice.value)}`, false);
        }
    }
    // A font control is a slice holding four more: family, size, bold, italic.
    const sub = slice as unknown as Record<string, Named | undefined>;
    for (const part of ["fontFamily", "fontSize", "bold", "italic", "fontColor"]) {
        const inner = sub[part];
        if (inner && typeof inner === "object" && inner.name) {
            say(inner, `${card}.${inner.name}`, false);
        }
    }
}

interface Card extends Named {
    slices?: Array<Named>;
    groups?: Array<Named & { slices?: Array<Named>; topLevelSlice?: Named }>;
    topLevelSlice?: Named;
}

/**
 * Puts the current language's text on every card, group and slice of the format pane, ahead of the
 * host building the pane from them. A no-op in English.
 */
export function localiseModel(model: { cards: Card[] }): void {
    for (const card of model.cards) {
        const cardName = card.name ?? "";
        say(card, cardName, false);
        if (card.topLevelSlice) {
            sliceOf(cardName, card.topLevelSlice);
        }
        for (const slice of card.slices ?? []) {
            sliceOf(cardName, slice);
        }
        for (const group of card.groups ?? []) {
            say(group, `${cardName}.${group.name ?? ""}`, false);
            if (group.topLevelSlice) {
                sliceOf(cardName, group.topLevelSlice);
            }
            for (const slice of group.slices ?? []) {
                sliceOf(cardName, slice);
            }
        }
    }
}
