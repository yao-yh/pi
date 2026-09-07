/**
 * 一个地址上当前状态的最终处理方式：
 * - copy：将当前值写入目标会话；
 * - exclude：不写入目标会话；
 * - reconstruct：不复制该行，由分支通道处理逻辑写入一致的替代状态。
 */
export type ForkDisposition = "copy" | "exclude" | "reconstruct";

/** 决定一个当前标量或列表地址在派生时的最终处理方式。 */
export function classifyForkAddress(
	address: { readonly namespace: string; readonly key: string },
	scope: "branch" | "tree",
	isEntryCopied: (entryId: string) => boolean,
): ForkDisposition {
	switch (address.namespace) {
		case "pi.session.name":
			return "copy";
		case "pi.entry.label":
			return isEntryCopied(address.key) ? "copy" : "exclude";
		case "pi.branch.tip":
		case "pi.lane.config":
		case "pi.lane.state":
			return "reconstruct";
		case "pi.result":
			return "exclude";
	}
	if (address.namespace.startsWith("pi.op.") || address.namespace.startsWith("pi.pending.")) return "exclude";
	if (address.namespace === "pi" || address.namespace.startsWith("pi.")) {
		throw new Error(`Unknown reserved fork namespace: ${address.namespace}`);
	}
	return scope === "tree" ? "copy" : "exclude";
}
