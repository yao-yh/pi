import type { JsonValue } from "../types.ts";

export type { JsonValue } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// chord/delta —— 对普通 JSON 进行刷新时变更跟踪。
//
// 不依赖执行框架中的其他组件。会话存储、运行时和切面宿主会使用它；
// 应始终保持这一依赖方向。
// ─────────────────────────────────────────────────────────────────────────────

export type Seg = string | number;
export type Path = readonly Seg[];
export type NonEmptyPath = readonly [Seg, ...Seg[]];

/** 内联路径，或编码器在第二次使用时分配的 ID。 */
export type PathRef<P extends Path = Path> = P | number;

/**
 * 元组是内存、线路和磁盘上的统一形式。
 *
 * `r` 是唯一替换整个值的操作。`s`/`d`/`a`/`t` 不能以根为目标，类型已禁止这种情况。
 * `p` 可以以根为目标，但仅因为被跟踪值本身可能是数组；如果 `p` 替换其整个目标，
 * 刷新时会将它规范化为 `r`/`s`，因此针对根的 `p` 始终是局部修改。
 *
 * `Op` 不感知路径字典。驻留、ID 引用和省略路径均属于 `WireOp`，
 * 仅存在于 `encode` 与 `decode` 之间。
 */
export type Op =
	| readonly ["r", JsonValue]
	| readonly ["s", NonEmptyPath, JsonValue]
	| readonly ["d", NonEmptyPath]
	| readonly ["a", NonEmptyPath, string]
	| readonly ["t", NonEmptyPath, number]
	| readonly ["p", Path, number, number, JsonValue[]];

/**
 * 跨边界传输的形式。只增加以下两种压缩：
 *
 *   ["#", id, path]    定义 ID，在路径第二次使用时发出
 *   数字 PathRef       引用此前定义的 ID
 *   缩短后的元组       复用前一个操作的路径，并通过元组长度消除歧义
 *
 * ["r", value] 不携带路径，因此编码后保持原样；这也是 isBase 可同时适用于两种词汇表的原因。
 */
export type WireOp =
	| readonly ["r", JsonValue]
	| readonly ["s", PathRef<NonEmptyPath>, JsonValue]
	| readonly ["s", JsonValue]
	| readonly ["d", PathRef<NonEmptyPath>]
	| readonly ["d"]
	| readonly ["a", PathRef<NonEmptyPath>, string]
	| readonly ["a", string]
	| readonly ["t", PathRef<NonEmptyPath>, number]
	| readonly ["t", number]
	| readonly ["p", PathRef, number, number, JsonValue[]]
	| readonly ["p", number, number, JsonValue[]]
	| readonly ["#", number, Path];

// ─── 分类 ────────────────────────────────────────────────────────────────────

export const isReplace = (op: Op | WireOp): boolean => op[0] === "r";

/**
 * 批次以替换操作开始。刷新过程保证 `r` 要么位于索引 0，要么不存在，
 * 因此这是精确判断，而非启发式判断。
 */
export const isBase = (ops: readonly (Op | WireOp)[]): boolean => ops.length > 0 && ops[0]![0] === "r";

// ─── 重叠 ────────────────────────────────────────────────────────────────────

/**
 * 查找 `a` 中同时为 `b` 前缀的最长后缀。使用 indexOf 探测并验证子串严格相等，
 * 因此热点循环由原生实现执行。手写 KMP 的渐近复杂度相同，但实际运行慢得多。
 *
 * 返回结果始终满足：a.slice(a.length - n) === b.slice(0, n)。
 */
export function overlap(a: string, b: string, scan: number, probe = 64, maxCandidates = 8): number {
	if (a.length === 0 || b.length === 0 || scan === 0) return 0;
	const tail = a.length > scan ? a.slice(a.length - scan) : a;

	// 长度为 h 的探针只能找到至少为 h 的重叠，因为头部必须确实出现在 `a` 中。
	// 因此先尝试较长头部（候选较少，也能捕获滚动窗口产生的大段重叠），
	// 再回退到单个字符，以更多候选为代价找出任意重叠。
	//
	// 候选数量受到限制，因为构建日志或单字符连续输出等重复内容，
	// 会让较长头部在数千个位置匹配。放弃时返回 0，从而发出 set：体积更大，但绝不会出错。
	for (const h of [Math.min(probe, b.length), 1]) {
		const head = b.slice(0, h);
		let tried = 0;
		for (let k = tail.indexOf(head); k !== -1; k = tail.indexOf(head, k + 1)) {
			if (++tried > maxCandidates) break;
			const n = tail.length - k;
			if (n <= b.length && tail.slice(k) === b.slice(0, n)) return n;
		}
		if (h === 1) break;
	}
	return 0;
}

// ─── 跟踪器 ──────────────────────────────────────────────────────────────────

export interface TrackerOptions {
	maxOverlapScan?: number;
}

export interface Tracker<T extends object> {
	/**
	 * 被跟踪的值。只能通过此代理修改和读取状态。插入其中的值会被接管：
	 * 调用方可以保留只读引用，但不得绕过此代理修改这些值。
	 */
	state: T;
	/** 未被跟踪的当前值。修改它会绕过变更跟踪。 */
	readonly target: T;
	flush(): Op[];
	/** 在不改变值的情况下，使下一次刷新产生完整的基础批次。 */
	rebase(): void;
	/** 在本地接受待处理变更，但不发出这些变更。 */
	discard(): void;
	readonly dirty: boolean;
}

const isObj = (value: unknown): value is object => value !== null && typeof value === "object";
const cloneJson = <T extends JsonValue>(value: T): T => {
	if (!isObj(value)) return value;
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
	const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
		string,
		JsonValue
	>;
	for (const [key, child] of Object.entries(value)) {
		Object.defineProperty(result, key, {
			value: cloneJson(child),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return result as T;
};

const INDEX = /^(?:0|[1-9]\d*)$/;
const norm = (target: object, key: string | symbol): Seg | symbol =>
	typeof key === "symbol" ? key : Array.isArray(target) && INDEX.test(key) ? Number(key) : key;
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);
const MISSING = Symbol("missing");
type MaybeJson = JsonValue | typeof MISSING;
type ArrayDirty = { kind: "append"; start: number } | { kind: "diff" } | { kind: "replace" };
type DirtyNode = { valueDirty?: true; array?: ArrayDirty; children: Map<Seg, DirtyNode> };

const dirtyNode = (): DirtyNode => ({ children: new Map() });

const spliceItems = (target: unknown[], index: number, remove: number, items: JsonValue[]): JsonValue[] => {
	const removed = Reflect.apply(Array.prototype.splice, target, [index, remove]) as JsonValue[];
	const chunkSize = 10_000;
	for (let offset = 0; offset < items.length; offset += chunkSize) {
		Reflect.apply(Array.prototype.splice, target, [index + offset, 0, ...items.slice(offset, offset + chunkSize)]);
	}
	return removed;
};

const jsonEqual = (left: JsonValue, right: JsonValue): boolean => {
	if (left === right) return true;
	if (!isObj(left) || !isObj(right) || Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (!jsonEqual(left[index]!, right[index]!)) return false;
		}
		return true;
	}
	const leftObject = left as Record<string, JsonValue>;
	const rightObject = right as Record<string, JsonValue>;
	const leftKeys = Object.keys(leftObject);
	const rightKeys = Object.keys(rightObject);
	if (leftKeys.length !== rightKeys.length) return false;
	for (const key of leftKeys) {
		if (!Object.hasOwn(rightObject, key) || !jsonEqual(leftObject[key]!, rightObject[key]!)) return false;
	}
	return true;
};

const ownValue = (value: JsonValue, segment: Seg): MaybeJson => {
	if (!isObj(value) || !Object.hasOwn(value, segment)) return MISSING;
	return (value as Record<Seg, JsonValue>)[segment]!;
};

const emitSet = (path: Path, value: JsonValue, out: Op[]): void => {
	const snapshot = cloneJson(value);
	if (path.length === 0) out.push(["r", snapshot]);
	else out.push(["s", [...path] as unknown as NonEmptyPath, snapshot]);
};

const emitDelete = (path: Path, out: Op[]): void => {
	if (path.length === 0) throw new TypeError("the tracked root cannot be deleted");
	out.push(["d", [...path] as unknown as NonEmptyPath]);
};

const diffString = (before: string, after: string, path: Path, scan: number, out: Op[]): void => {
	if (before === after) return;
	if (path.length === 0) {
		emitSet(path, after, out);
		return;
	}
	const at = [...path] as unknown as NonEmptyPath;
	// 不使用 `after.startsWith(before)`。`after` 通常是刚执行过 `s += chunk` 的拼接字符串，
	// V8 的 startsWith 会逐字符遍历该字符串，而 `slice(...) === before` 只展平一次并通过 memcmp 比较。
	// 实测 200 KB 字符串每次刷新增长 8 字节时：845 us -> 42 us。
	if (after.length > before.length && after.slice(0, before.length) === before) {
		out.push(["a", at, after.slice(before.length)]);
		return;
	}
	const shared = overlap(before, after, scan);
	if (shared === 0) {
		out.push(["s", at, after]);
		return;
	}
	out.push(["t", at, before.length - shared]);
	if (after.length > shared) out.push(["a", at, after.slice(shared)]);
};

const diffValue = (before: MaybeJson, after: MaybeJson, path: Path, scan: number, out: Op[]): void => {
	if (before === MISSING) {
		if (after !== MISSING) emitSet(path, after, out);
		return;
	}
	if (after === MISSING) {
		emitDelete(path, out);
		return;
	}
	if (before === after) return;
	if (typeof before === "string" && typeof after === "string") {
		diffString(before, after, path, scan, out);
		return;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		diffArray(before, after, path, scan, out);
		return;
	}
	if (isObj(before) && isObj(after) && !Array.isArray(before) && !Array.isArray(after)) {
		diffObject(before as Record<string, JsonValue>, after as Record<string, JsonValue>, path, scan, out);
		return;
	}
	emitSet(path, after, out);
};

function diffObject(
	before: Record<string, JsonValue>,
	after: Record<string, JsonValue>,
	path: Path,
	scan: number,
	out: Op[],
): void {
	if ([...Object.keys(before), ...Object.keys(after)].some((key) => RESERVED_SEGMENTS.has(key))) {
		emitSet(path, after, out);
		return;
	}
	for (const key of Object.keys(after)) {
		diffValue(Object.hasOwn(before, key) ? before[key]! : MISSING, after[key]!, [...path, key], scan, out);
	}
	for (const key of Object.keys(before)) {
		if (!Object.hasOwn(after, key)) emitDelete([...path, key], out);
	}
}

function diffArray(before: JsonValue[], after: JsonValue[], path: Path, scan: number, out: Op[]): void {
	if (before.length === after.length) {
		for (let index = 0; index < after.length; index++) {
			diffValue(before[index]!, after[index]!, [...path, index], scan, out);
		}
		return;
	}

	let prefix = 0;
	while (prefix < before.length && prefix < after.length && jsonEqual(before[prefix]!, after[prefix]!)) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		jsonEqual(before[before.length - 1 - suffix]!, after[after.length - 1 - suffix]!)
	) {
		suffix++;
	}
	const shorter = Math.min(before.length, after.length);
	if (prefix + suffix === shorter) {
		const remove = before.length - prefix - suffix;
		const items = after.slice(prefix, after.length - suffix);
		if (prefix === 0 && remove === before.length) emitSet(path, after, out);
		else out.push(["p", [...path], prefix, remove, cloneJson(items)]);
		return;
	}

	// 结构移动与保留索引编辑同时存在时没有唯一对齐方式。保留已有索引的增量，
	// 仅以结构方式表达尾部长度变化。范围可能大于生产方的原始意图，
	// 但绝不会把这些编辑降级为整个数组替换。
	for (let index = 0; index < shorter; index++) {
		diffValue(before[index]!, after[index]!, [...path, index], scan, out);
	}
	if (after.length > before.length) {
		out.push(["p", [...path], before.length, 0, cloneJson(after.slice(before.length))]);
	} else if (before.length > after.length) {
		if (after.length === 0) emitSet(path, after, out);
		else out.push(["p", [...path], after.length, before.length - after.length, []]);
	}
}

const walkDirty = (before: JsonValue, after: JsonValue, node: DirtyNode, path: Path, scan: number, out: Op[]): void => {
	if (node.valueDirty) {
		diffValue(before, after, path, scan, out);
		return;
	}
	if (node.array !== undefined) {
		if (node.array.kind === "replace") {
			if (!jsonEqual(before, after)) emitSet(path, after, out);
			return;
		}
		if (!Array.isArray(before) || !Array.isArray(after) || node.array.kind === "diff") {
			diffValue(before, after, path, scan, out);
			return;
		}
		const start = node.array.start;
		if (before.length !== start || after.length < start) {
			diffValue(before, after, path, scan, out);
			return;
		}
		for (const [segment, child] of node.children) {
			if (typeof segment !== "number" || segment >= start) continue;
			const previous = ownValue(before, segment);
			const current = ownValue(after, segment);
			if (previous === MISSING || current === MISSING || child.valueDirty) {
				diffValue(previous, current, [...path, segment], scan, out);
			} else if (isObj(previous) && isObj(current)) {
				walkDirty(previous as JsonValue, current as JsonValue, child, [...path, segment], scan, out);
			} else {
				diffValue(previous, current, [...path, segment], scan, out);
			}
		}
		const items = after.slice(start);
		if (items.length > 0) out.push(["p", [...path], start, 0, cloneJson(items)]);
		return;
	}
	for (const [segment, child] of node.children) {
		const previous = ownValue(before, segment);
		const current = ownValue(after, segment);
		if (previous === MISSING || current === MISSING || child.valueDirty) {
			diffValue(previous, current, [...path, segment], scan, out);
			continue;
		}
		if (!isObj(previous) || !isObj(current)) {
			diffValue(previous, current, [...path, segment], scan, out);
			continue;
		}
		walkDirty(previous as JsonValue, current as JsonValue, child, [...path, segment], scan, out);
	}
};

/**
 * 通过共享引用，沿脏路径将 `baseline` 同步到 `root`。
 * 如果任一脏节点是纯追加之外的数组变更，则不做任何修改并返回 false，
 * 以便调用方改为重放操作。此处克隆整个数组每次刷新需要 O(n)，而重放为 O(变更数)。
 *
 * 字符串不可变，因此可以直接共享 root 中的 `after`；这样下一次刷新会与平坦字符串比较，
 * 而不是与拼接字符串比较。对象则需要克隆，因为 root 会继续修改它们。
 */
const syncBaseline = (baseline: JsonValue, root: JsonValue, node: DirtyNode): boolean => {
	if (!canSync(node)) return false;
	syncInto(baseline, root, node);
	return true;
};

const canSync = (node: DirtyNode): boolean => {
	if (node.array !== undefined && node.array.kind !== "append") return false;
	for (const child of node.children.values()) if (!canSync(child)) return false;
	return true;
};

const syncInto = (baseline: JsonValue, root: JsonValue, node: DirtyNode): void => {
	const parent = baseline as Record<string | number, JsonValue>;
	if (node.array?.kind === "append" && Array.isArray(baseline) && Array.isArray(root)) {
		const start = node.array.start;
		for (const [index, child] of node.children) {
			if (typeof index === "number" && index < start) syncChild(parent, root, index, child);
		}
		for (let i = start; i < root.length; i++) {
			baseline.push(isObj(root[i]) ? cloneJson(root[i] as JsonValue) : (root[i] as JsonValue));
		}
		return;
	}
	for (const [segment, child] of node.children) syncChild(parent, root, segment, child);
};

const syncChild = (
	parent: Record<string | number, JsonValue>,
	root: JsonValue,
	segment: Seg,
	child: DirtyNode,
): void => {
	const current = ownValue(root, segment);
	const previous = ownValue(parent as JsonValue, segment);
	if (current === MISSING) {
		if (Array.isArray(parent)) parent.splice(segment as number, 1);
		else delete parent[segment];
		return;
	}
	if (child.valueDirty || !isObj(current) || !isObj(previous) || Array.isArray(current) !== Array.isArray(previous)) {
		parent[segment] = isObj(current) ? cloneJson(current as JsonValue) : (current as JsonValue);
		return;
	}
	syncInto(previous as JsonValue, current as JsonValue, child);
};

const cloneOp = (op: Op): Op => {
	switch (op[0]) {
		case "r":
			return ["r", cloneJson(op[1])];
		case "s":
			return ["s", op[1], cloneJson(op[2])];
		case "p":
			return ["p", op[1], op[2], op[3], cloneJson(op[4])];
		default:
			return op;
	}
};

export function track<T extends object>(root: T, options: TrackerOptions = {}): Tracker<T> {
	const scan = options.maxOverlapScan ?? 65_536;
	let pending = dirtyNode();
	let hasPending = false;
	let baseline: JsonValue | undefined;
	let forceBase = true;

	const clearPending = (): void => {
		pending = dirtyNode();
		hasPending = false;
	};

	const ensureNode = (path: Path): DirtyNode | undefined => {
		hasPending = true;
		let node = pending;
		for (const segment of path) {
			if (node.valueDirty || node.array?.kind === "diff" || node.array?.kind === "replace") return undefined;
			let child = node.children.get(segment);
			if (child === undefined) child = dirtyNode();
			else node.children.delete(segment);
			node.children.set(segment, child);
			node = child;
		}
		return node;
	};

	const findNode = (path: Path): DirtyNode | undefined => {
		let node = pending;
		for (const segment of path) {
			const child = node.children.get(segment);
			if (child === undefined) return undefined;
			node = child;
		}
		return node;
	};

	const markValue = (path: Path): void => {
		const node = ensureNode(path);
		if (node === undefined) return;
		node.valueDirty = true;
		node.array = undefined;
		node.children.clear();
	};

	const markArrayAppend = (path: Path, start: number): void => {
		const node = ensureNode(path);
		if (node === undefined || node.valueDirty || node.array?.kind === "diff" || node.array?.kind === "replace") {
			return;
		}
		if (node.array === undefined) node.array = { kind: "append", start };
	};

	const markArrayDiff = (path: Path): void => {
		const node = ensureNode(path);
		if (node === undefined || node.valueDirty || node.array?.kind === "replace") return;
		node.array = { kind: "diff" };
		node.children.clear();
	};

	const markArrayReplace = (path: Path): void => {
		const node = ensureNode(path);
		if (node === undefined || node.valueDirty) return;
		node.array = { kind: "replace" };
		node.children.clear();
	};

	const appendStart = (path: Path): number | undefined => {
		const array = findNode(path)?.array;
		return array?.kind === "append" ? array.start : undefined;
	};

	const guard = (segment: Seg | symbol): Seg => {
		if (typeof segment === "symbol") throw new UnsafePathError(String(segment));
		if (typeof segment === "string" && RESERVED_SEGMENTS.has(segment)) throw new UnsafePathError(segment);
		return segment;
	};

	const adoptItems = (values: readonly unknown[]): JsonValue[] => values as JsonValue[];

	const integer = (value: unknown): number => {
		const number = Number(value);
		if (Number.isNaN(number) || number === 0) return 0;
		return Number.isFinite(number) ? Math.trunc(number) : number;
	};

	const spliceRange = (length: number, args: readonly unknown[]): { index: number; remove: number } => {
		const rawStart = args.length === 0 ? 0 : integer(args[0]);
		const index = rawStart < 0 ? Math.max(0, length + rawStart) : Math.min(rawStart, length);
		const remove =
			args.length === 0
				? 0
				: args.length === 1
					? length - index
					: Math.max(0, Math.min(integer(args[1]), length - index));
		return { index, remove };
	};

	const wrap = <V extends object>(object: V, path: Path, blockedSegment?: Seg): V => {
		const childProxies = new Map<string | symbol, { target: object; proxy: object }>();
		const proxy = new Proxy(object, {
			get(target, key, receiver) {
				if (Array.isArray(target) && typeof key === "string" && MUTATORS.has(key)) {
					return (...args: unknown[]) => {
						if (blockedSegment !== undefined) throw new UnsafePathError(blockedSegment);
						const before = target.length;
						let result: unknown;
						switch (key) {
							case "push": {
								const items = adoptItems(args);
								if (items.length > 0) markArrayAppend(path, before);
								spliceItems(target, before, 0, items);
								result = target.length;
								break;
							}
							case "unshift": {
								const items = adoptItems(args);
								if (items.length > 0) markArrayDiff(path);
								spliceItems(target, 0, 0, items);
								result = target.length;
								break;
							}
							case "pop":
								if (before > 0) {
									const start = appendStart(path);
									if (start === undefined || before - 1 < start) markArrayDiff(path);
								}
								result = Reflect.apply(Array.prototype.pop, target, args);
								break;
							case "shift":
								if (before > 0) markArrayDiff(path);
								result = Reflect.apply(Array.prototype.shift, target, args);
								break;
							case "splice": {
								const items = adoptItems(args.slice(2));
								const { index, remove } = spliceRange(before, args);
								if (remove > 0 || items.length > 0) {
									const start = appendStart(path);
									if (index === 0 && remove === before) markArrayReplace(path);
									else if (start !== undefined && index >= start) {
										// 最终追加载荷已包含所有尾部编辑。
									} else if (index === before && remove === 0) markArrayAppend(path, before);
									else markArrayDiff(path);
								}
								result = spliceItems(target, index, remove, items);
								break;
							}
							default:
								markArrayDiff(path);
								result = Reflect.apply(Array.prototype[key as "sort"], target, args);
						}
						if (key === "pop") childProxies.delete(String(before - 1));
						else if (key !== "push") childProxies.clear();
						return key === "sort" || key === "reverse" || key === "fill" || key === "copyWithin" ? proxy : result;
					};
				}
				const value = Reflect.get(target, key, receiver);
				if (!isObj(value)) return value;
				const cached = childProxies.get(key);
				if (cached?.target === value) return cached.proxy;
				const rawSegment = norm(target, key);
				let segment: Seg;
				let childBlocked = blockedSegment;
				if (blockedSegment !== undefined) {
					if (typeof rawSegment === "symbol") throw new UnsafePathError(String(rawSegment));
					segment = rawSegment;
				} else if (
					typeof rawSegment === "string" &&
					RESERVED_SEGMENTS.has(rawSegment) &&
					Object.hasOwn(target, key)
				) {
					segment = rawSegment;
					childBlocked = rawSegment;
				} else segment = guard(rawSegment);
				const child = wrap(value, [...path, segment], childBlocked);
				childProxies.set(key, { target: value, proxy: child });
				return child;
			},

			set(target, key, value) {
				if (blockedSegment !== undefined) throw new UnsafePathError(blockedSegment);
				if (Array.isArray(target) && key === "length") {
					const before = target.length;
					const next = Number(value);
					if (!Number.isSafeInteger(next) || next < 0 || next > 4_294_967_295) {
						return Reflect.set(target, key, value);
					}
					if (next < before) {
						const start = appendStart(path);
						if (next === 0) markArrayReplace(path);
						else if (start === undefined || next < start) markArrayDiff(path);
						Reflect.set(target, key, next);
						childProxies.clear();
					} else if (next > before) {
						markArrayAppend(path, before);
						target.length = next;
						target.fill(null, before);
					}
					return true;
				}

				const segment = guard(norm(target, key));
				if (Array.isArray(target)) {
					if (typeof segment !== "number") throw new UnsafePathError(segment);
					if (segment > target.length) throw new UnsafePathError(segment);
				}
				const at = [...path, segment] as unknown as NonEmptyPath;

				if (value === undefined) {
					if (Array.isArray(target)) {
						throw new TypeError("undefined would create a sparse array; use splice instead");
					}
					markValue(at);
					childProxies.delete(key);
					return Reflect.deleteProperty(target, key);
				}

				const previous = (target as Record<string | symbol, unknown>)[key];
				if (previous === value) return true;
				const cached = childProxies.get(key);
				if (cached !== undefined && cached.target === previous && cached.proxy === value) return true;
				if (Array.isArray(target)) {
					const index = segment as number;
					if (index === target.length) markArrayAppend(path, target.length);
					else {
						const start = appendStart(path);
						if (start === undefined || index < start) markValue(at);
					}
				} else markValue(at);
				childProxies.delete(key);
				return Reflect.set(target, key, value);
			},

			deleteProperty(target, key) {
				if (blockedSegment !== undefined) throw new UnsafePathError(blockedSegment);
				const segment = guard(norm(target, key));
				if (Array.isArray(target)) {
					if (typeof segment !== "number") throw new UnsafePathError(segment);
					throw new TypeError("delete would create a sparse array; use splice instead");
				}
				markValue([...path, segment]);
				childProxies.delete(key);
				return Reflect.deleteProperty(target, key);
			},

			defineProperty() {
				throw new TypeError("defineProperty is not supported on tracked state; use assignment");
			},
			setPrototypeOf() {
				throw new TypeError("setPrototypeOf is not supported on tracked state");
			},
			preventExtensions() {
				throw new TypeError("preventExtensions is not supported on tracked state");
			},
		});

		return proxy as V;
	};

	let state = wrap(root, []);

	return {
		get state() {
			return state;
		},
		get target() {
			return root;
		},
		set state(next: T) {
			if (next === state) {
				clearPending();
				forceBase = true;
				return;
			}
			clearPending();
			root = next;
			state = wrap(root, []);
			baseline = undefined;
			forceBase = true;
		},
		rebase() {
			clearPending();
			forceBase = true;
		},
		get dirty() {
			return forceBase || hasPending;
		},
		discard() {
			baseline = cloneJson(root as unknown as JsonValue);
			clearPending();
		},
		flush() {
			if (forceBase) {
				const value = cloneJson(root as unknown as JsonValue);
				baseline = cloneJson(root as unknown as JsonValue);
				forceBase = false;
				clearPending();
				return [["r", value]];
			}
			if (!hasPending || baseline === undefined) return [];
			const out: Op[] = [];
			walkDirty(baseline, root as unknown as JsonValue, pending, [], scan, out);
			// 在成本低且结果精确的情况下，通过共享 root 的引用推进基线，
			// 包括标量、字符串和数组追加。重放操作会通过 slice + concat 重建每个受影响的字符串：
			// 每次刷新产生两次窗口大小的分配，并留下一个需要在下次刷新时展平的拼接字符串。
			// 对于同步无法低成本表达的情况（非追加型数组变更），则放弃同步并原样执行重放。
			if (!syncBaseline(baseline as JsonValue, root as unknown as JsonValue, pending)) {
				if (out.length > 0) baseline = apply(baseline, out.map(cloneOp));
			}
			clearPending();
			return out;
		},
	};
}

// ─── 路径安全 ────────────────────────────────────────────────────────────────

/**
 * 能够访问原型链的路径段。
 *
 * `JSON.parse` 本身是安全的，因为它会把 `__proto__` 创建为自有属性。
 * 不安全的是 `parent[key] = value`，而应用器恰好会这样做，且路径本身也是数据：
 * `["s", ["__proto__", "isAdmin"], true]` 会污染整个进程的 `Object.prototype`。
 *
 * 操作可能来自切面、插件隔离区，或详情中可能回显模型输出的工具，
 * 因此任何操作都不能视为可信输入。
 */
export const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export class UnsafePathError extends Error {
	// 不使用参数属性：Node 的 --experimental-strip-types 不接受该语法，
	// 而这些文件需要在该模式下直接运行。
	readonly segment: Seg;
	constructor(segment: Seg) {
		super(`unsafe path segment: ${String(segment)}`);
		this.segment = segment;
		this.name = "UnsafePathError";
	}
}

/**
 * **已解码**操作的动词、元组长度和载荷结构：路径内联，不含 `#`，也没有缩写形式。
 * `apply` 使用此格式。
 *
 * 按线路语法验证 `Op` 会比类型约束更宽松：两个元素的 `["s", value]` 会通过，
 * 随后 `apply` 会把 value 当作路径读取。每套词汇表都应使用与之匹配的验证器。
 */
export function assertValidOp(op: unknown): asserts op is Op {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	switch (op[0]) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length !== 3) throw new TypeError("s arity");
			assertPathArg(op[1], true);
			return;
		case "d":
			if (op.length !== 2) throw new TypeError("d arity");
			assertPathArg(op[1], true);
			return;
		case "a":
			if (op.length !== 3 || typeof op[2] !== "string") throw new TypeError("a shape");
			assertPathArg(op[1], true);
			return;
		case "t":
			if (op.length !== 3 || !Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("t shape");
			assertPathArg(op[1], true);
			return;
		case "p": {
			if (op.length !== 5) throw new TypeError("p arity");
			assertPathArg(op[1]);
			if (!Number.isInteger(op[2]) || op[2] < 0) throw new TypeError("p index");
			if (!Number.isInteger(op[3]) || op[3] < 0) throw new TypeError("p remove");
			if (!Array.isArray(op[4])) throw new TypeError("p items");
			return;
		}
		// 静默跳过未知动词会导致较新生产方发出的操作消失。
		default:
			throw new TypeError(`unknown op verb: ${String(op[0])}`);
	}
}

function assertPathArg(p: unknown, nonEmpty = false): void {
	if (!Array.isArray(p)) throw new TypeError("path is not an array");
	if (nonEmpty && p.length === 0) throw new TypeError("path is empty");
	assertSafePath(p as Path);
}

/** 对线路语法执行同类验证；此处允许 ID 和缩写形式。 */
export function assertValidWireOp(op: unknown): asserts op is WireOp {
	if (!Array.isArray(op) || op.length === 0) throw new TypeError("op is not a tuple");
	const [verb] = op as unknown[];
	const okRef = (r: unknown): void => {
		if (typeof r === "number") {
			if (!Number.isInteger(r) || r < 0) throw new TypeError("bad path id");
			return;
		}
		// 字符串不是路径。若不检查，`"a".slice(0, -1)` 会得到 `""`，
		// 从而解析到根并写入；这会错误接受一个并非路径的值。
		if (!Array.isArray(r)) throw new TypeError("path is not an array");
		assertSafePath(r as Path);
	};
	switch (verb) {
		case "r":
			if (op.length !== 2) throw new TypeError("r arity");
			return;
		case "s":
			if (op.length === 3) okRef(op[1]);
			else if (op.length !== 2) throw new TypeError("s arity");
			return;
		case "d":
			if (op.length === 2) okRef(op[1]);
			else if (op.length !== 1) throw new TypeError("d arity");
			return;
		case "a":
			if (op.length === 3) {
				okRef(op[1]);
				if (typeof op[2] !== "string") throw new TypeError("a value");
			} else if (op.length === 2) {
				if (typeof op[1] !== "string") throw new TypeError("a value");
			} else throw new TypeError("a arity");
			return;
		case "t":
			if (op.length === 3) {
				okRef(op[1]);
				if (!Number.isInteger(op[2]) || (op[2] as number) < 0) throw new TypeError("t count");
			} else if (op.length === 2) {
				if (!Number.isInteger(op[1]) || (op[1] as number) < 0) throw new TypeError("t count");
			} else throw new TypeError("t arity");
			return;
		case "p": {
			const [i, r, items] = op.length === 5 ? [op[2], op[3], op[4]] : op.length === 4 ? [op[1], op[2], op[3]] : [];
			if (items === undefined) throw new TypeError("p arity");
			if (op.length === 5) okRef(op[1]);
			if (!Number.isInteger(i) || (i as number) < 0) throw new TypeError("p index");
			if (!Number.isInteger(r) || (r as number) < 0) throw new TypeError("p remove");
			if (!Array.isArray(items)) throw new TypeError("p items");
			return;
		}
		case "#": {
			if (op.length !== 3 || !Number.isInteger(op[1]) || (op[1] as number) < 0 || !Array.isArray(op[2])) {
				throw new TypeError("# shape");
			}
			assertSafePath(op[2] as Path);
			return;
		}
		// 静默跳过未知动词会导致较新生产方发出的操作消失。
		default:
			throw new TypeError(`unknown op verb: ${String(verb)}`);
	}
}

export function assertSafePath(path: Path): void {
	for (const seg of path) {
		if (typeof seg === "string") {
			if (RESERVED_SEGMENTS.has(seg)) throw new UnsafePathError(seg);
		} else if (!Number.isInteger(seg) || seg < 0) {
			throw new UnsafePathError(seg);
		}
	}
}

/**
 * 索引可以指向现有元素，或恰好指向末尾后一位以执行追加。
 *
 * 这不是任意限制，而是确保值仍为 `JsonValue` 的必要条件。稀疏数组无法在 JSON 往返后保持原样：
 * 空洞会序列化为 `null`，并在返回时成为真实属性。因此在长度为 3 的数组上执行 `arr[7] = x`，
 * 已经会产生副本无法匹配的状态。拒绝该写入比静默产生分歧更合理。
 *
 * 这也消除了原本可能出现的拒绝服务风险：
 * `["s", ["xs", 4294967290], 1]` 会通过一个操作分配包含 42.9 亿项的数组。
 * 数组仍可扩展，且成本与增长量成正比；跟踪器已将 `arr.length = n` 表达为插入显式 null 的 splice，
 * 操作大小会随间隔增长，因此大幅扩展需要大型操作，而无法用小型操作触发。
 */
function assertIndexInRange(parent: readonly unknown[], index: number): void {
	if (index > parent.length) throw new UnsafePathError(index);
}

// ─── 应用器 ──────────────────────────────────────────────────────────────────

export class PathError extends Error {
	readonly path: Path | number;
	constructor(path: Path | number) {
		super(`unresolvable path: ${JSON.stringify(path)}`);
		this.path = path;
		this.name = "PathError";
	}
}

/**
 * 将操作应用到普通可变值。由于 `r` 会直接替换该值而无法原地执行，因此返回结果值。
 *
 * 此函数接收已解码操作。路径 ID 和省略路径属于线路层问题；
 * 如果操作来自边界，应先执行 `decode`。
 */
export function apply<T>(target: T | undefined, ops: readonly Op[]): T {
	return applyOps(target, ops);
}

function applyOps<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;

	for (const op of ops) {
		assertValidOp(op);
		if (op[0] === "r") {
			// 直接接管而不复制。消费方拥有交给它的批次。
			//
			// 因此在进程内将同一批次扇出给多个消费方，会使它们的副本相互别名。
			// 这是所有权规则而非缺陷：应在扇出点复制批次，或让每个消费方自行解码。
			// 跨越真实边界的批次已经彼此独立，因为序列化会生成全新对象。
			root = op[1];
			continue;
		}

		const path = op[1];
		assertSafePath(path);

		if (op[0] === "p") {
			const target_ = path.length === 0 ? root : resolve(root, path);
			if (!Array.isArray(target_)) throw new PathError(path);
			target_.splice(op[2], op[3]);
			const chunkSize = 10_000;
			for (let offset = 0; offset < op[4].length; offset += chunkSize) {
				target_.splice(op[2] + offset, 0, ...op[4].slice(offset, offset + chunkSize));
			}
			continue;
		}

		// s/d/a/t 永远不能以根为目标，类型已禁止这种情况。
		const parent = resolve(root, path.slice(0, -1)) as Record<Seg, JsonValue>;
		const key = path[path.length - 1]!;
		if (Array.isArray(parent)) {
			if (typeof key !== "number") throw new UnsafePathError(key);
			assertIndexInRange(parent, key);
		}
		// 使用 defineProperty 而非赋值，否则写入时可能触发从原型链继承的 setter。
		const write = (value: JsonValue) => {
			Object.defineProperty(parent, key, { value, writable: true, enumerable: true, configurable: true });
		};
		const read = (): unknown => (Object.hasOwn(parent, key) ? parent[key] : undefined);
		switch (op[0]) {
			case "s":
				write(op[2]);
				break;
			case "d":
				if (Array.isArray(parent)) {
					if (typeof key !== "number" || key >= parent.length) throw new PathError(path);
					(parent as unknown as JsonValue[]).splice(key, 1);
				} else delete parent[key];
				break;
			case "a": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(`${current}${op[2]}`);
				break;
			}
			case "t": {
				const current = read();
				if (typeof current !== "string") throw new PathError(path);
				write(current.slice(op[2]));
				break;
			}
		}
	}
	return root as unknown as T;
}

/** 在不修改前一个不可变值的情况下应用已解码操作。 */
export function applyImmutable<T>(target: T | undefined, ops: readonly Op[]): T {
	let root = target as unknown as JsonValue;
	for (const op of ops) {
		if (op[0] === "r") {
			assertValidOp(op);
			root = op[1];
			continue;
		}
		root = copyContainers(root, op[0] === "p" ? op[1] : op[1].slice(0, -1));
		root = applyOps(root, [op]);
	}
	return root as unknown as T;
}

function copyContainers(root: JsonValue, path: Path): JsonValue {
	const copy = (value: JsonValue): JsonValue[] | Record<string, JsonValue> => {
		if (Array.isArray(value)) return value.slice();
		if (!isObj(value)) throw new PathError(path);
		const result = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype) as Record<
			string,
			JsonValue
		>;
		for (const key of Object.keys(value)) {
			Object.defineProperty(result, key, {
				value: (value as Record<string, JsonValue>)[key],
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return result;
	};
	const copiedRoot = copy(root);
	let source = root;
	let destination = copiedRoot;
	for (const segment of path) {
		if (!isObj(source) || !Object.hasOwn(source, segment)) throw new PathError(path);
		if (Array.isArray(source) && typeof segment !== "number") throw new UnsafePathError(segment);
		const child = (source as Record<Seg, JsonValue>)[segment]!;
		const copiedChild = copy(child);
		Object.defineProperty(destination, segment, {
			value: copiedChild,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		source = child;
		destination = copiedChild;
	}
	return copiedRoot;
}

function resolveValue(root: JsonValue, path: Path): JsonValue {
	let node: JsonValue = root;
	for (const seg of path) {
		if (!isObj(node)) throw new PathError(path);
		if (Array.isArray(node) && typeof seg !== "number") throw new UnsafePathError(seg);
		// 仅访问自有属性：不得触发继承的 getter，遍历过程也不得从当前值逃逸到原型链。
		if (!Object.hasOwn(node, seg as PropertyKey)) throw new PathError(path);
		node = (node as Record<Seg, JsonValue>)[seg]!;
	}
	return node;
}

function resolve(root: JsonValue, path: Path): JsonValue {
	const node = resolveValue(root, path);
	if (!isObj(node)) throw new PathError(path);
	return node;
}

// ─── 编解码器 ────────────────────────────────────────────────────────────────
//
// 路径驻留和元组长度省略只存在于跟踪器与边界之间；`Op` 和 `apply` 不感知这些机制。
//
// 每个独立状态流使用一对编解码器。每个解码器必须严格接收其匹配编码器产生的批次，
// 并从该状态的基础批次开始。共享传输连接并不会让分别水合的状态成为同一个流。

const pathKey = (path: Path): string => JSON.stringify(path);

export interface Encoder {
	encode(ops: readonly Op[]): WireOp[];
}

/**
 * 在第二次使用时驻留。定义本身比它替换的路径成本更高，
 * 因此对大量只写入一次的路径在首次使用时驻留反而得不偿失。
 */
export function encoder(): Encoder {
	const seen = new Set<string>();
	const ids = new Map<string, number>();
	let nextId = 0;
	let previous: string | undefined; // 当前批次中的最后一个路径

	return {
		encode(ops) {
			// 元组长度省略只作用于一个批次。若跨批次延续，会让当前批次的首个操作依赖前一批次的末项，
			// 从而使跳过或重排批次的读取方解码到错误路径。ID 是唯一的跨批次状态，
			// 且字典会显式记录这些 ID。
			previous = undefined;
			const out: WireOp[] = [];
			for (const op of ops) {
				if (op[0] === "r") {
					out.push(op);
					// 基础批次是恢复点：读取方会使用全新解码器从最近的基础批次开始重放，
					// 因此其后的所有内容都必须自包含。若在替换后保留 ID，
					// 会发出对读取方从未见过的定义的引用，导致恢复因路径 ID 无法解析而失败。
					seen.clear();
					ids.clear();
					nextId = 0;
					previous = undefined;
					continue;
				}
				const path = op[1];
				const key = pathKey(path);

				// 与前一个操作路径相同：完全省略引用。
				if (key === previous) {
					switch (op[0]) {
						case "s":
							out.push(["s", op[2]]);
							break;
						case "d":
							out.push(["d"]);
							break;
						case "a":
							out.push(["a", op[2]]);
							break;
						case "t":
							out.push(["t", op[2]]);
							break;
						case "p":
							out.push(["p", op[2], op[3], op[4]]);
							break;
					}
					continue;
				}

				let ref: PathRef = path;
				const existing = ids.get(key);
				if (existing !== undefined) {
					ref = existing;
				} else if (seen.has(key)) {
					const id = nextId++;
					ids.set(key, id);
					out.push(["#", id, path]); // 第二次使用：先定义，再引用
					ref = id;
				} else {
					seen.add(key); // 第一次使用：内联
				}

				switch (op[0]) {
					case "s":
						out.push(["s", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "d":
						out.push(["d", ref as PathRef<NonEmptyPath>]);
						break;
					case "a":
						out.push(["a", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "t":
						out.push(["t", ref as PathRef<NonEmptyPath>, op[2]]);
						break;
					case "p":
						out.push(["p", ref, op[2], op[3], op[4]]);
						break;
				}
				previous = key;
			}
			return out;
		},
	};
}

export interface Decoder {
	decode(wire: readonly WireOp[]): Op[];
}

export function decoder(): Decoder {
	const paths = new Map<number, Path>();

	return {
		decode(wire) {
			let previous: Path | undefined; // 与 encode 相同，作用域限定于当前批次
			const out: Op[] = [];
			for (const op of wire) {
				assertValidWireOp(op);
				if (op[0] === "#") {
					assertSafePath(op[2]);
					paths.set(op[1], op[2]);
					continue;
				}
				if (op[0] === "r") {
					out.push(op);
					paths.clear();
					previous = undefined;
					continue;
				}

				// 元组长度表明是否存在引用：缩写形式会省略引用。
				const short =
					(op[0] === "d" && op.length === 1) ||
					(op[0] !== "d" && op[0] !== "p" && op.length === 2) ||
					(op[0] === "p" && op.length === 4);

				let path: Path;
				if (short) {
					if (previous === undefined) throw new PathError([]);
					path = previous;
				} else {
					const ref = op[1] as PathRef;
					if (typeof ref === "number") {
						const resolved = paths.get(ref);
						if (resolved === undefined) throw new PathError(ref);
						path = resolved;
					} else {
						path = ref;
					}
					previous = path;
				}

				if (op[0] !== "p" && path.length === 0) throw new PathError(path);
				switch (op[0]) {
					case "s":
						out.push(["s", path as NonEmptyPath, (short ? op[1] : op[2]) as JsonValue]);
						break;
					case "d":
						out.push(["d", path as NonEmptyPath]);
						break;
					case "a":
						out.push(["a", path as NonEmptyPath, (short ? op[1] : op[2]) as string]);
						break;
					case "t":
						out.push(["t", path as NonEmptyPath, (short ? op[1] : op[2]) as number]);
						break;
					case "p": {
						const [i, r, items] = short
							? [op[1] as number, op[2] as number, op[3] as JsonValue[]]
							: [op[2] as number, op[3] as number, op[4] as JsonValue[]];
						out.push(["p", path, i, r, items]);
						break;
					}
				}
			}
			return out;
		},
	};
}
