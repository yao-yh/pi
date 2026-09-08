/**
 * 会话 worker：每个会话对应一个进程。
 *
 * 它持有所有活动对象——存储、harness、lane 和模型运行时——并且只将其发布为 `Lane` 和
 * `Models` 服务。它通过 stdio 管道与生成它的服务器交换 JSON，也可以通过同一个 peer
 * 调用服务器服务（`Sessions`）。
 */

import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	type Context,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { findInitialModel } from "../../../core/model-resolver.ts";
import { ModelRuntime } from "../../../core/model-runtime.ts";
import { Lane, Models, Worker } from "../shared/protocol.ts";
import { createPeer } from "../shared/rpc.ts";
import { parentConnection } from "../shared/transport.ts";
import { LaneService } from "./lane-service.ts";
import { ModelsService } from "./models-service.ts";

function systemPrompt(cwd: string): string {
	return [
		"You are a coding agent working in a terminal.",
		`Working directory: ${cwd}`,
		"Use the read, write, edit, and bash tools to inspect and change files.",
		"Keep answers short and technical.",
	].join("\n");
}

async function openSession(
	repo: JsonlSessionRepo,
	sessionId: string | undefined,
	cwd: string,
	context: Context,
): Promise<Session<JsonlSessionMetadata>> {
	if (sessionId === undefined) return repo.create({ cwd }, context);
	const metadata = (await repo.list(undefined, context)).find((candidate) => candidate.id === sessionId);
	if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
	return repo.open(metadata, context);
}

/** 运行一个会话 worker 直至其 stdio 关闭。`sessionId` 为 undefined 时创建新会话。 */
export async function runSessionWorker(options: {
	sessionsRoot: string;
	sessionId?: string;
	cwd: string;
}): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const { cwd } = options;
	const modelRuntime = await ModelRuntime.create();
	const { model, thinkingLevel } = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime });
	if (!model) throw new Error("No model available. Configure credentials with `pi` first.");

	const executionEnv = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: options.sessionsRoot });
	const session = await openSession(repo, options.sessionId, cwd, context);
	const { harness, open } = await AgentHarness.create(
		{
			session,
			models: modelRuntime,
			model,
			thinkingLevel,
			tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
			toolContext: { env: executionEnv },
			systemPrompt: systemPrompt(cwd),
		},
		context,
	);
	const lane = await harness.lane("main", context);
	const connection = parentConnection();
	const peer = createPeer(connection);

	const models = new ModelsService(modelRuntime, (event) => peer.emit(Models, event));
	const laneService = new LaneService({
		lane,
		models: modelRuntime,
		context,
		session: { id: session.metadata.id, cwd, path: session.metadata.path },
		modelsState: () => models.state,
		publish: (subscriptionId, to, event) => peer.emitTo(Lane, { subscriptionId, event }, to),
	});
	peer.provide(Lane, laneService);
	peer.provide(Models, models);
	peer.provide(Worker, { describe: async () => ({ sessionId: session.metadata.id }) });

	// 创建过程会恢复持久操作状态，但不会启动副作用。服务可访问后，
	// 为上一 worker 遗留的每个未结束操作安装新的进程本地驱动器。
	const recoveries = open.map(async (operation) => {
		try {
			const restoredLane = operation.lane === lane.name ? lane : await harness.lane(operation.lane, context);
			const result = await restoredLane.resume(context);
			if (!result.ok) throw result.error;
		} catch (error) {
			console.error(`Failed to resume ${operation.lane}/${operation.operationId}:`, error);
		}
	});

	await new Promise<void>((resolve) => connection.onClose(resolve));
	laneService.close();
	await harness.close(context).catch(() => {});
	await Promise.all(recoveries);
	await repo.close(context).catch(() => {});
	await executionEnv.cleanup(context).catch(() => {});
}
