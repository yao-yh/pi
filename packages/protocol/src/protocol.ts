import type { JsonValue } from "@earendil-works/chord";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

export const PROTOCOL_VERSION = 8 as const;

const IdSchema = Type.String({ minLength: 1 });
const OpaqueJsonValueSchema = Type.Unsafe<JsonValue>(Type.Unknown());
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const ServerIdSchema = Type.String({
	pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export type ServerId = Static<typeof ServerIdSchema>;

export function isServerId(value: unknown): value is ServerId {
	return Check(ServerIdSchema, value);
}

const ProtocolErrorSchema = StrictObject({
	code: IdSchema,
	message: Type.String(),
});
export type ProtocolErrorCode = string;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/** 必须作为客户端发送的第一帧。 */
const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

/** 服务器范围调用，限定到一个逻辑服务器。 */
const ServerTargetSchema = StrictObject({
	serverId: ServerIdSchema,
});
/** 会话调用，限定到一个逻辑服务器、持久会话和活动连接。 */
const SessionTargetSchema = StrictObject({
	serverId: ServerIdSchema,
	sessionId: IdSchema,
	attachmentId: IdSchema,
});
export type SessionTarget = Static<typeof SessionTargetSchema>;
const RpcTargetSchema = Type.Union([ServerTargetSchema, SessionTargetSchema]);
export type RpcTarget = Static<typeof RpcTargetSchema>;

const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	target: RpcTargetSchema,
	call: OpaqueJsonValueSchema,
});
const CancelEnvelopeSchema = StrictObject({
	type: Type.Literal("cancel"),
	id: IdSchema,
	target: RpcTargetSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export type CancelEnvelope = Static<typeof CancelEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, CancelEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	serverId: ServerIdSchema,
});
const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
const ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: Type.Optional(OpaqueJsonValueSchema),
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
const ServiceEventEnvelopeSchema = StrictObject({
	type: Type.Literal("service_update"),
	subscriptionId: IdSchema,
	update: OpaqueJsonValueSchema,
});
/** 对当前呈现层所选 Session 路由的带外更新。 */
const AttachmentEnvelopeSchema = StrictObject({
	type: Type.Literal("attachment"),
	attachment: Type.Union([SessionTargetSchema, Type.Null()]),
});
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	ServiceEventEnvelopeSchema,
	AttachmentEnvelopeSchema,
]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type ServiceEventEnvelope = Static<typeof ServiceEventEnvelopeSchema>;
export type AttachmentEnvelope = Static<typeof AttachmentEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;
