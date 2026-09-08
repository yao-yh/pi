import { type Context, defineService } from "@earendil-works/chord";

export interface PresentationSelectItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** 呈现层切面可用的受限进程本地 UI 能力。 */
export interface PresentationUI {
	select(
		title: string,
		items: readonly PresentationSelectItem[],
		selectedValue: string | undefined,
		context: Context,
	): Promise<string | undefined>;
	showStatus(message: string, context: Context): void;
}

export const PresentationUI = defineService<PresentationUI>("pi.local.presentation-ui", { local: true });
