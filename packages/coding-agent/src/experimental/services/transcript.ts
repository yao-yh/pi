import { defineService, type ReplicatedState } from "@earendil-works/chord";
import type { LaneTranscriptSnapshot, LaneWatchEvent } from "@earendil-works/pi-agent-core";

export interface TranscriptState {
	snapshot: LaneTranscriptSnapshot | null;
	/** 保留源事件用于呈现层副作用；水合不会重放该事件。 */
	event: LaneWatchEvent | null;
}

/** 通过 Chord 操作流复制的一致主通道状态。 */
export interface Transcript {
	readonly state: ReplicatedState<TranscriptState>;
}

export const Transcript = defineService<Transcript>("pi.transcript");
