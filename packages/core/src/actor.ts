import {
	type Future,
	type Operation,
	type Scope,
	call,
	createScope,
	each,
} from "effection";
import { current, isDraft } from "mutative";
import { type Alarm, AlarmContext, KVContext, type KVStore } from "./context";
import {
	type PrivateScheduler,
	type Scheduler,
	createScheduler,
} from "./schedule";
import { loadState, withState } from "./state";

// biome-ignore lint/suspicious/noExplicitAny: Any is OK in this case
export type ActionLike = (...args: any[]) => Operation<unknown> | unknown;
type ObjLike = Record<string, unknown>;

export type Actions = Record<string, ActionLike>;

type ExtendedActions<S extends State, V extends Vars, A extends Actions> = {
	[actionName in keyof A]: (
		ctx: ActorContext<S, V, A>,
		...args: Parameters<A[actionName]>
	) => Operation<ReturnType<A[actionName]>> | ReturnType<A[actionName]>;
};

/**
 * The interface exposed via the client
 */
export type ActorInstance<A extends Actions> = {
	[K in keyof A]: (
		...args: Parameters<A[K]>
	) => ReturnType<A[K]> extends Operation<infer R>
		? Promise<R>
		: Promise<ReturnType<A[K]>>;
};

type ActorContext<S extends State, V extends Vars, A extends Actions> = {
	state: S;
	vars: V;
	schedule: Scheduler<A>;
	// events
	broadcast: (event: string, data: unknown) => void;
	send: (event: string, connId: string, data: unknown) => void;
};

// These are just for legibility
type Vars = ObjLike;
type State = ObjLike;

type VarConfig<V extends Vars> =
	| { vars: V; createVars?: never }
	| { vars?: never; createVars: () => Operation<V> }
	| { vars?: never; createVars?: never };
type StateConfig<S extends State> =
	| { state: S; createState?: never }
	| { state?: never; createState: () => Operation<S> }
	| { state?: never; createState?: never };
// type Conn = { connState: ObjLike } | { createConnState: (ctx: ActorContext) => Operation<ObjLike> } | {}

type ActorConfig<
	S extends State,
	V extends Vars,
	A extends Actions,
> = VarConfig<V> &
	StateConfig<S> & { actions: ExtendedActions<S, V, A> } & {
		// lifecycle hooks
		onCreate?: (ctx: ActorContext<S, V, A>) => Operation<void>;
		onStart?: (ctx: ActorContext<S, V, A>) => Operation<void>;
		onStateChange?: (
			ctx: ActorContext<S, V, A>,
			oldState: S,
			newState: S,
		) => Operation<void>;
		onShutdown?: (ctx: ActorContext<S, V, A>) => Operation<void>;
		// TODO connection hooks
		// onBeforeConnect?: (ctx: ActorContext) => Operation<void>;
		// onConnect?: (ctx: ActorContext) => Operation<void>;
		// onDisconnect?: (ctx: ActorContext) => Operation<void>;
	};

function assertScope(scope: Scope | undefined): asserts scope is Scope {
	if (!scope) {
		throw new Error("Actor not running");
	}
}

export interface ActorDefinition<A extends Actions> {
	createOrStart: (options: { kv: KVStore; alarm: Alarm }) => Operation<void>;
	shutdown: () => Operation<void>;
	triggerAlarm: () => Operation<void>;
	runAction: <K extends keyof A>(
		action: K,
		...args: Parameters<A[K]>
	) => Operation<ReturnType<A[K]>>;
	actions: (keyof A)[];
}

export function actor<S extends State, V extends Vars, A extends Actions>(
	config: ActorConfig<S, V, A>,
): ActorDefinition<A> {
	let scope: Scope | undefined;
	let destroyScope: () => Future<void>;

	const ctx: ActorContext<S, V, A> = {
		state: {} as S,
		vars: {} as V,
		schedule: {} as Scheduler<A>,
		broadcast: () => {},
		send: () => {},
	};

	function* createOrStart({
		kv: kvInit,
		alarm: alarmInit,
	}: { kv: KVStore; alarm: Alarm }) {
		if (!scope) {
			[scope, destroyScope] = createScope();
		}
		const kv = scope.set(KVContext, kvInit);
		scope.set(AlarmContext, alarmInit);

		if (yield* kv.get("::actor:created")) {
			yield* scope.run(function* () {
				ctx.state = yield* loadState<S>();
			});
			yield* start();
		} else {
			yield* create();
			yield* kv.put("::actor:created", true);
			yield* start();
		}
	}

	function* create() {
		if (!scope) {
			[scope, destroyScope] = createScope();
		}
		if ("onCreate" in config && config.onCreate) {
			yield* scope.spawn(function* () {
				// biome-ignore lint/style/noNonNullAssertion: Type narrowing fails due to closure
				yield* config.onCreate!(ctx);
			});
		}
		if ("createState" in config || "state" in config) {
			ctx.state = yield* scope.run(function* () {
				const state = yield* withState(ctx.state);
				// biome-ignore lint/style/noNonNullAssertion: Type narrowing fails due to closure
				Object.assign(state, config.state ?? (yield* config.createState!()));
				return current(state);
			});
		}
	}

	function* start() {
		if (!scope) {
			[scope, destroyScope] = createScope();
		}
		const alarm = scope.expect(AlarmContext);
		const kv = scope.expect(KVContext);
		const scheduler = createScheduler({ alarm, kv });
		ctx.schedule = scheduler;
		if ("onStart" in config && config.onStart) {
			// biome-ignore lint/style/noNonNullAssertion: Type narrowing fails due to closure
			yield* scope.spawn(() => config.onStart!(ctx));
		}
		yield* scope.spawn(function* () {
			const alarmStream = alarm.subscribe();
			for (const _ of yield* each(alarmStream)) {
				// Get all scheduled actions
				const scheduledActions = yield* ctx.schedule.list();
				const now = Date.now();

				// Find actions that need to be executed now
				const expiredActions = scheduledActions.filter(
					(action) => action.triggerAt <= now,
				);

				// Execute expired actions
				for (const action of expiredActions) {
					yield* runAction(action.action, ...action.args);
				}

				// Delete all expired actions
				if (expiredActions.length > 0) {
					yield* (scheduler as PrivateScheduler)._deleteEvents(
						expiredActions.map((a) => a.id),
					);
				}

				// Find next action to schedule
				const remainingActions = scheduledActions.filter(
					(action) => action.triggerAt > now,
				);
				if (remainingActions.length > 0) {
					const nextTrigger = Math.min(
						...remainingActions.map((a) => a.triggerAt),
					);
					alarm.set(nextTrigger);
				} else {
					alarm.clear();
				}

				yield* each.next();
			}
		});
	}

	function* shutdown() {
		assertScope(scope);
		if ("onStop" in config && config.onShutdown) {
			// biome-ignore lint/style/noNonNullAssertion: Type narrowing fails due to closure
			yield* scope.spawn(() => config.onShutdown!(ctx));
		}
		yield* destroyScope();
		scope = undefined;
	}

	function* runAction<K extends keyof A>(
		action: K,
		...args: Parameters<A[K]>
	): Operation<ReturnType<A[K]>> {
		assertScope(scope);
		return yield* scope.run(function* () {
			const state = yield* withState(ctx.state);
			const result = yield* call(() =>
				config.actions[action]({ ...ctx, state: state as S }, ...args),
			);
			return (
				isDraft(result) ? current(result as object) : result
			) as ReturnType<A[K]>;
		});
	}

	function* triggerAlarm() {
		assertScope(scope);
		yield* scope.spawn(function* () {
			const alarm = yield* AlarmContext.expect();
			yield* alarm.trigger();
		});
	}

	return {
		createOrStart,
		shutdown,
		runAction,
		triggerAlarm,
		actions: Object.keys(config.actions) as (keyof A)[],
	};
}
