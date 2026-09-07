import type {
	Context as AiContext,
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import { type Context, getTelemetryContext } from "../context.ts";
import type { SettledAssistantMessage } from "../session/types.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import { AbortRequested } from "./effect-gate.ts";

/** 在使用提供方响应正文前捕获的 HTTP 响应元数据。 */
export interface AssistantResponseMetadata {
	status?: number;
	headers?: Record<string, string>;
}

/** 单个助手流在当前进程内使用的生命周期观察器。 */
export interface AssistantStreamObserver {
	start(
		message: AssistantMessage,
		event: Extract<AssistantMessageEvent, { type: "start" }>,
		context: Context,
	): void | Promise<void>;
	update(message: AssistantMessage, event: AssistantMessageEvent, context: Context): void | Promise<void>;
	end(message: SettledAssistantMessage, context: Context): void | Promise<void>;
}

/** 一次已经获准执行的助手提供方请求所需的输入。 */
export interface HarnessAssistantStreamConfig {
	model: Model<Api>;
	systemPrompt: string;
	tools?: Tool[];
	thinkingLevel: ThinkingLevel;
	streamOptions: AgentHarnessStreamOptions;
	transformContext?: (
		requestContext: { messages: AgentMessage[]; systemPrompt: string },
		context: Context,
	) => Promise<{ messages: AgentMessage[]; systemPrompt: string }>;
	toProviderMessages: (messages: AgentMessage[], context: Context) => Message[] | Promise<Message[]>;
	beforePayload?: (
		payload: unknown,
		model: Model<Api>,
		context: Context,
	) => unknown | undefined | Promise<unknown | undefined>;
	afterResponse?: (
		message: SettledAssistantMessage,
		metadata: AssistantResponseMetadata,
		context: Context,
	) => Promise<SettledAssistantMessage>;
	request(
		aiContext: AiContext,
		options: SimpleStreamOptions,
		context: Context,
	): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	observer: AssistantStreamObserver;
}

/**
 * 根据助手流配置构建提供方请求选项。
 *
 * 该方法会把当前中止信号和遥测上下文绑定到请求，并在响应正文被读取前捕获状态码和响应头。
 */
function createRequestOptions(
	config: HarnessAssistantStreamConfig,
	captureMetadata: (metadata: AssistantResponseMetadata) => void,
	context: Context,
): SimpleStreamOptions {
	const options = config.streamOptions;
	return {
		transport: options.transport,
		timeoutMs: options.timeoutMs,
		maxRetries: options.maxRetries,
		maxRetryDelayMs: options.maxRetryDelayMs,
		headers: options.headers,
		metadata: options.metadata,
		cacheRetention: options.cacheRetention,
		deferred: options.deferred,
		...(config.thinkingLevel === "off" ? {} : { reasoning: config.thinkingLevel }),
		signal: context.abortSignal,
		telemetryContext: getTelemetryContext(context),
		onPayload:
			config.beforePayload === undefined
				? undefined
				: (payload, model) => config.beforePayload?.(payload, model, context),
		onResponse: (response) => {
			captureMetadata({ status: response.status, headers: response.headers });
		},
	};
}

function isUpdateEvent(
	event: AssistantMessageEvent,
): event is Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }> {
	return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

/**
 * 消费助手事件流，校验事件顺序，并返回完成后的助手消息。
 *
 * `afterResponse` 可以在观察器收到结束事件前替换最终消息；取消请求会等待其取消流程完成。
 */
export async function consumeAssistantStream(
	stream: AssistantMessageEventStream,
	observer: AssistantStreamObserver,
	afterResponse:
		| ((message: SettledAssistantMessage, context: Context) => Promise<SettledAssistantMessage>)
		| undefined,
	context: Context,
): Promise<SettledAssistantMessage> {
	let started = false;
	for await (const event of stream) {
		if (event.type === "start") {
			if (started) throw new Error("Assistant message stream emitted more than one start event");
			started = true;
			await observer.start({ ...event.partial }, event, context);
		} else if (isUpdateEvent(event)) {
			if (!started) throw new Error(`Assistant message stream emitted ${event.type} before start`);
			await observer.update({ ...event.partial }, event, context);
		} else if (event.type === "done" && !started) {
			throw new Error("Assistant message stream emitted done before start");
		}
	}

	const settled = (await stream.result()) as SettledAssistantMessage;
	let finalMessage = settled;
	if (afterResponse !== undefined) {
		try {
			finalMessage = await afterResponse(settled, context);
		} catch (error) {
			if (!(error instanceof AbortRequested)) throw error;
			await error.cancellation;
		}
	}
	await observer.end(finalMessage, context);
	return finalMessage;
}
/** 在不修改调用方消息列表的前提下，流式生成一次助手响应。 */
export async function streamHarnessAssistant(
	messages: AgentMessage[],
	config: HarnessAssistantStreamConfig,
	context: Context,
): Promise<SettledAssistantMessage> {
	let requestContext = { messages: messages.slice(), systemPrompt: config.systemPrompt };
	if (config.transformContext) {
		requestContext = await config.transformContext(requestContext, context);
	}

	const providerMessages = await config.toProviderMessages(requestContext.messages, context);
	const aiContext: AiContext = {
		systemPrompt: requestContext.systemPrompt,
		messages: providerMessages,
		tools: config.tools,
	};

	let metadata: AssistantResponseMetadata = {};
	const stream = await config.request(
		aiContext,
		createRequestOptions(
			config,
			(nextMetadata) => {
				metadata = nextMetadata;
			},
			context,
		),
		context,
	);

	const afterResponse = config.afterResponse;
	return consumeAssistantStream(
		stream,
		config.observer,
		afterResponse === undefined
			? undefined
			: (message, afterContext) => afterResponse(message, metadata, afterContext),
		context,
	);
}
