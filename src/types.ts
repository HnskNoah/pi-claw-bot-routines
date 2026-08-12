/**
 * @file types.ts — pi-claw bot 运行时类型模型(自研重构版)。
 *
 * 精简为 GitHub 轮询这一个用例:Routine 只携带 github triggers,
 * 无 pulse/cron/oneoff/hook/api 触发、无 run 历史、无 guard/format 等
 * 上游遗产。结构兼容现有 state.json(schemaVersion 3),迁移零成本。
 */

/** GitHub 轮询触发。cursor 是唯一持久化状态(事件游标)。 */
export interface GithubTrigger {
	kind: "github";
	/** 'owner/name'。通过本地 gh CLI(installation token)轮询。 */
	repo: string;
	/** GitHub 事件:issues.opened / issues.closed / issue.comment / discussion.comment / ... */
	event: string;
	/** 轮询间隔 ms,低于 MIN_GITHUB_POLL_MS 会被钳到最小值。 */
	pollIntervalMs: number;
	/** 上次成功轮询的游标(最新事件 id)。undefined = 尚未 seed,首轮只记录不触发。 */
	cursor?: string;
	/** push 分支过滤时的独立游标(按分支)。 */
	branchCursors?: Record<string, string>;
	/** 事件过滤(mergedOnly / labels / branches)。 */
	filter?: { labels?: string[]; branches?: string[]; mergedOnly?: boolean };
}

/** 一个 routine:名字 + 消息模板 + 一组 github 触发。 */
export interface Routine {
	id: string;
	name: string;
	/** 注入 pi 时的消息模板,支持 {githubMessage} {state} {cwd} {date} {time} {tickCount} 占位符。 */
	prompt: string;
	triggers: GithubTrigger[];
	/** 注入消息头部附带的上下文说明。 */
	context?: string;
	/** quiet:无变化时回复 [~],由 suppressor 折叠。 */
	quiet?: boolean;
	maxTicks?: number;
	maxRunsPerDay?: number;
	paused?: boolean;
	createdAt: number;
}

/** 每 routine 的滚动状态;userState 由注入轮次自己通过 RoutineSetState 刷新。 */
export interface RoutineTickState {
	tickCount: number;
	lastFiredAt?: number;
	lastFiredDateLocal?: string;
	/** LLM 可写状态({summary} 等),上限 MAX_USER_STATE_BYTES。 */
	userState: Record<string, unknown>;
}

/** 持久化根(schemaVersion 3,与既有 state.json 一致)。 */
export interface RoutineStore {
	schemaVersion: number;
	routines: Record<string, Routine>;
	tickState: Record<string, RoutineTickState>;
}

/** 运行时句柄:内存 store + 每 routine 的 timer 数组。 */
export interface RoutineRuntime {
	store: RoutineStore;
	timers: Map<string, Array<ReturnType<typeof setTimeout> | null>>;
}

export const SCHEMA_VERSION = 3;
/** 轮询下限:低于 10s 无意义且烧配额。 */
export const MIN_GITHUB_POLL_MS = 10_000;
/** 连续失败后的退避上限。 */
export const MAX_GITHUB_BACKOFF_MS = 60_000;
/** RoutineSetState 的 userState 序列化上限。 */
export const MAX_USER_STATE_BYTES = 2048;
