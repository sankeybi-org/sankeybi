import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { DEFAULT_FONT_FAMILY } from "./model";

/**
 * A font control for one text element. Power BI's own visuals put one on every card that draws
 * text, and an author expects to find it there; one family for the whole visual with
 * per-element sizes would be fewer slices and not what anybody looks for.
 *
 * The defaults are the visual's standard text sizes.
 */
export function fontControl(prefix: string, size: number, displayName: string): formattingSettings.FontControl {
    return new formattingSettings.FontControl({
        name: `${prefix}Font`,
        displayName,
        fontFamily: new formattingSettings.FontPicker({
            name: `${prefix}FontFamily`,
            displayName: "Font family",
            value: DEFAULT_FONT_FAMILY
        }),
        fontSize: new formattingSettings.NumUpDown({
            name: `${prefix}FontSize`,
            displayName: "Text size",
            value: size,
            options: {
                minValue: { value: 4, type: powerbi.visuals.ValidatorType.Min },
                maxValue: { value: 60, type: powerbi.visuals.ValidatorType.Max }
            }
        }),
        bold: new formattingSettings.ToggleSwitch({
            name: `${prefix}Bold`, displayName: "Bold", value: false
        }),
        italic: new formattingSettings.ToggleSwitch({
            name: `${prefix}Italic`, displayName: "Italic", value: false
        })
    });
}

export import IEnumMember = powerbi.IEnumMember;

export import FormattingSettingsCard = formattingSettings.SimpleCard;

export import FormattingSettingsSlice = formattingSettings.Slice;

export import FormattingSettingsModel = formattingSettings.Model;

export import FormattingSettingsCompositeCard = formattingSettings.CompositeCard;

export import FormattingSettingsGroup = formattingSettings.Group;

/**
 * A named group inside a card.
 *
 * A group costs nothing to introduce and nothing to rename: `FormattingSettingsService` reads
 * `objectName` off the card (`objectName = card.name`) and hands that same name to every
 * group's slices, so a group's own `name` only ever becomes a uid. Moving a slice between
 * groups of one card is therefore free, where moving it between cards changes the path the
 * report stores it under.
 *
 * `topLevelSlice` draws a slice in the card's or group's header instead of as a row.
 */
export function group(
    name: string,
    displayName: string,
    slices: Array<FormattingSettingsSlice>,
    topLevelSlice?: formattingSettings.SimpleSlice
): FormattingSettingsGroup {
    return new FormattingSettingsGroup({ name, displayName, slices, topLevelSlice });
}
