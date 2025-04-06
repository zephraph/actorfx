import { DurableObject, env } from "cloudflare:workers";
import type {
	ActorDefinition,
	Actors,
	Alarm,
	App,
	AppConfig,
	Client,
	KVStore,
} from "@actorfx/core";
import { call, createChannel, run } from "effection";

const createKV = (ctx: DurableObjectState): KVStore => {
	return {
		get: (key) => call(() => ctx.storage.get(key)),
		put: (key, value) => call(() => ctx.storage.put(key, value)),
		putBatch: (entries) => call(() => ctx.storage.put(entries)),
		delete: (key) => call(() => ctx.storage.delete(key)),
		deleteBatch: (keys) => call(() => ctx.storage.delete(keys)),
		list: (options) => call(() => ctx.storage.list(options)),
	};
};

const createAlarm = (ctx: DurableObjectState): Alarm => {
	const alarm = createChannel<void>();
	return {
		get: () => call(() => ctx.storage.getAlarm()),
		set: (ms: number) => call(() => ctx.storage.setAlarm(ms)),
		clear: () => call(() => ctx.storage.deleteAlarm()),
		trigger: () => alarm.send(),
		subscribe: () => alarm,
	};
};

type DurableObjectActor = ReturnType<typeof createDurableObject>;
export function createDurableObject<
	Env,
	AA extends Actors,
	A extends AppConfig<AA>,
>(app: A) {
	return class DurableObjectActor extends DurableObject<Env> {
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		#actor?: ActorDefinition<any>;

		constructor(
			public ctx: DurableObjectState,
			public env: Env,
		) {
			super(ctx, env);
		}

		async init(type: keyof AA) {
			if (!this.#actor) {
				await run(
					function* (this: DurableObjectActor) {
						this.#actor = app.actors[type];
						return yield* this.#actor.createOrStart({
							kv: createKV(this.ctx),
							alarm: createAlarm(this.ctx),
						});
					}.bind(this),
				);
			}
		}

		// biome-ignore lint/suspicious/noExplicitAny: The `any` here is fine, users won't directly interface with this type
		async runAction(action: `${string}:${string}`, ...args: any[]) {
			const [actor, actionName] = action.split(":");
			if (!this.#actor) {
				await this.init(actor);
			}
			// biome-ignore lint/style/noNonNullAssertion: By this point we know the actor is initialized
			return await run(() => this.#actor!.runAction(actionName, ...args));
		}

		async alarm() {
			if (!this.#actor) {
				throw new Error("Actor not initialized");
			}
			// biome-ignore lint/style/noNonNullAssertion: By this point we know the actor is initialized
			await run(() => this.#actor!.triggerAlarm());
		}
	};
}

export function createClient<A extends App<AA>, AA extends Actors>(
	app: A,
): Client<A["actors"]> {
	const actors = Object.keys(app.actors);

	const handler = {
		get<Act extends keyof A["actors"]>(_: object, actor: Act) {
			if (!actors.includes(actor as string)) {
				return undefined;
			}

			return (name: string) => {
				return new Proxy(
					{},
					{
						get(_target, prop, _receiver) {
							// biome-ignore lint/suspicious/noExplicitAny: `env` here doesn't contain the ACTOR_DO, but consuming projects will
							const dO = (env as any).ACTOR_DO as DurableObjectNamespace<
								DurableObjectActor & Rpc.DurableObjectBranded
							>;
							const actions = app.actors[actor].actions;

							const id = dO.idFromName(`${actor as string}:${name}`);
							const stub = dO.get(id);
							if (actions.includes(prop as string)) {
								// biome-ignore lint/suspicious/noExplicitAny: This is an acceptable usage of `any`
								return (...args: any[]) =>
									// @ts-expect-error Types here are wrong. We know that `runAction` exists on the stub.
									stub.runAction(`${actor}:${prop}`, ...args);
							}
							return undefined;
						},
					},
				);
			};
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: TODO; fix this
	return new Proxy({}, handler as any) as Client<A["actors"]>;
}
