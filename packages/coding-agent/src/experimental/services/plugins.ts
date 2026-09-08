import { type Context, defineService, type JsonValue } from "@earendil-works/chord";

/** 呈现层可用的服务器构建插件代次。 */
export interface PresentationPlugins {
	prepareSession(
		request: { readonly sessionId: string; readonly packagePaths: readonly string[] | null },
		context: Context,
	): Promise<JsonValue>;
	reload(context: Context): Promise<JsonValue>;
}

export const PresentationPlugins = defineService<PresentationPlugins>("pi.presentation-plugins");

/** 托管在当前已连接 Session 工作进程中的插件切面。 */
export interface SessionPlugins {
	reload(context: Context): Promise<void>;
}

export const SessionPlugins = defineService<SessionPlugins>("pi.session-plugins");
