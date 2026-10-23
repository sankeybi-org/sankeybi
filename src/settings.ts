import { FormattingSettingsModel } from "./settingsSupport";
import { PositionsCardSettings } from "./settingsArrange";
import { CorridorsCardSettings } from "./settingsFlows";
import { NodeShapesCardSettings } from "./settingsNodes";
import { FlowLabelsCardSettings, LabelsCardSettings, ValuesCardSettings } from "./settingsLabels";
import { LegendCardSettings } from "./settingsLegend";
import { BackgroundCardSettings } from "./settingsBackground";
import { InteractionCardSettings } from "./settingsInteraction";

/**
 * The format pane model: nine cards in the order the work happens. Shape the diagram, then the
 * flows, then the nodes, then the text, then the trimmings.
 *
 * The class property names (`positionsCard` for the Arrange card, `corridorsCard` for Flows,
 * `labelsCard` for Node labels) are the names every read site in `render.ts` and `visual.ts`
 * and every hand-built settings object in the checks uses; they are not what the author sees.
 */
export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    positionsCard = new PositionsCardSettings();
    corridorsCard = new CorridorsCardSettings();
    nodeShapesCard = new NodeShapesCardSettings();
    labelsCard = new LabelsCardSettings();
    flowLabelsCard = new FlowLabelsCardSettings();
    valuesCard = new ValuesCardSettings();
    legendCard = new LegendCardSettings();
    backgroundCard = new BackgroundCardSettings();
    interactionCard = new InteractionCardSettings();

    cards = [
        this.positionsCard, this.nodeShapesCard, this.corridorsCard,
        this.labelsCard, this.flowLabelsCard, this.valuesCard,
        this.legendCard, this.backgroundCard, this.interactionCard
    ];
}
