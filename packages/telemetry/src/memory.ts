import type {
	AttributeValue,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "./index.ts";
import { NOOP_TELEMETRY_CONTEXT } from "./noop.ts";

export interface RecordedTelemetryEvent {
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
}

export interface RecordedTelemetrySpan {
	readonly id: number;
	readonly parentId: number | null;
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly events: readonly RecordedTelemetryEvent[];
	readonly status: SpanStatus;
	readonly settled: boolean;
	readonly endSequence?: number;
}

interface MutableRecordedTelemetryEvent {
	name: string;
	attributes: SpanAttributes;
}

interface MutableRecordedTelemetrySpan {
	id: number;
	parentId: number | null;
	name: string;
	attributes: SpanAttributes;
	events: MutableRecordedTelemetryEvent[];
	status: SpanStatus;
	explicitStatus: boolean;
	settled: boolean;
	endSequence?: number;
}

interface InMemoryTelemetryState {
	spans: MutableRecordedTelemetrySpan[];
	nextSpanId: number;
	nextEndSequence: number;
}

function copyAttributeValue(value: AttributeValue): AttributeValue {
	return Array.isArray(value) ? ([...value] as AttributeValue) : value;
}

function copyAttributes(attributes?: SpanAttributes): SpanAttributes {
	const copy: SpanAttributes = {};
	if (!attributes) return copy;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) copy[name] = copyAttributeValue(value);
	}
	return copy;
}

function mergeAttributes(current: SpanAttributes, attributes: SpanAttributes): SpanAttributes {
	const merged = copyAttributes(current);
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) merged[name] = copyAttributeValue(value);
	}
	return merged;
}

function copyStatus(status: SpanStatus): SpanStatus {
	if (status.status === "ok") return { status: "ok" };
	return status.error
		? { status: "error", error: { name: status.error.name, message: status.error.message } }
		: { status: "error" };
}

function automaticErrorStatus(error: unknown): SpanStatus {
	try {
		if (error instanceof Error) {
			return { status: "error", error: { name: error.name, message: error.message } };
		}
	} catch {
		// 错误检查是被动操作；失败时回退到不含详情的错误状态。
	}
	return { status: "error" };
}

function settleSpan(
	state: InMemoryTelemetryState,
	span: MutableRecordedTelemetrySpan,
	failed: boolean,
	error?: unknown,
): void {
	if (span.settled) return;
	if (failed && !span.explicitStatus) span.status = automaticErrorStatus(error);
	span.settled = true;
	span.endSequence = state.nextEndSequence++;
}

function createSpan(
	state: InMemoryTelemetryState,
	parent: MutableRecordedTelemetrySpan | undefined,
	options: SpanOptions,
): MutableRecordedTelemetrySpan {
	const name = options.name;
	const attributes = copyAttributes(options.attributes);
	return {
		id: state.nextSpanId++,
		parentId: parent?.id ?? null,
		name,
		attributes,
		events: [],
		status: { status: "ok" },
		explicitStatus: false,
		settled: false,
	};
}

function startInMemorySpan<T>(
	state: InMemoryTelemetryState,
	parent: MutableRecordedTelemetrySpan | undefined,
	options: SpanOptions,
	callback: (span: TelemetrySpan) => T | Promise<T>,
): Promise<T> {
	if (parent?.settled) return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);

	let recordedSpan: MutableRecordedTelemetrySpan;
	try {
		recordedSpan = createSpan(state, parent, options);
		state.spans.push(recordedSpan);
	} catch {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, callback);
	}

	const span: TelemetrySpan = {
		startSpan: <Result>(
			childOptions: SpanOptions,
			childCallback: (child: TelemetrySpan) => Result | Promise<Result>,
		) => startInMemorySpan(state, recordedSpan, childOptions, childCallback),
		addEvent(name, attributes) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.events.push({ name, attributes: copyAttributes(attributes) });
			} catch {
				// 记录是被动操作；忽略格式错误或无法读取的遥测载荷。
			}
		},
		setAttributes(attributes) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.attributes = mergeAttributes(recordedSpan.attributes, attributes);
			} catch {
				// 记录是被动操作；忽略格式错误或无法读取的遥测载荷。
			}
		},
		setStatus(status) {
			if (recordedSpan.settled) return;
			try {
				recordedSpan.status = copyStatus(status);
				recordedSpan.explicitStatus = true;
			} catch {
				// 记录是被动操作；忽略格式错误或无法读取的遥测载荷。
			}
		},
	};

	let result: T | Promise<T>;
	try {
		result = callback(span);
	} catch (error) {
		settleSpan(state, recordedSpan, true, error);
		return Promise.reject(error);
	}

	return Promise.resolve(result).then(
		(value) => {
			settleSpan(state, recordedSpan, false);
			return value;
		},
		(error: unknown) => {
			settleSpan(state, recordedSpan, true, error);
			throw error;
		},
	);
}

/**
 * 在进程内存中记录 span 的后端无关参考实现。
 * 创建新实例可隔离测试或独立记录作用域。
 */
export class InMemoryTelemetryContext implements TelemetryContext {
	private readonly state: InMemoryTelemetryState = {
		spans: [],
		nextSpanId: 1,
		nextEndSequence: 1,
	};

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return startInMemorySpan(this.state, undefined, options, callback);
	}

	/** 按 span 开始顺序返回彼此分离的快照。 */
	getSpans(): readonly RecordedTelemetrySpan[] {
		return this.state.spans.map((span) => ({
			id: span.id,
			parentId: span.parentId,
			name: span.name,
			attributes: copyAttributes(span.attributes),
			events: span.events.map((event) => ({
				name: event.name,
				attributes: copyAttributes(event.attributes),
			})),
			status: copyStatus(span.status),
			settled: span.settled,
			...(span.endSequence === undefined ? {} : { endSequence: span.endSequence }),
		}));
	}
}
