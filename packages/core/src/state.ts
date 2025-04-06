import { type Operation, type Provide, ensure, resource } from "effection";
import { type Draft, type Patches, apply, create } from "mutative";
import { match } from "ts-pattern";
import { KVContext } from "./context";

type PatchOp = { op: string; path: string; value?: unknown };

const patchOptions = { pathAsArray: false } as const;

function useImmutableState<T>(
	initial: T,
	onStateFinalized: (
		ops: [
			state: T,
			patches: Patches<{ pathAsArray: false }>,
			inversePatches: Patches<{ pathAsArray: false }>,
		],
	) => void,
) {
	return resource(function* (provide: Provide<Draft<T>>) {
		const [draft, finalize] = create(initial, {
			enablePatches: patchOptions,
		});
		yield* ensure(() => onStateFinalized(finalize()));
		yield* provide(draft);
	});
}

export function* withState<S extends Record<string, unknown>>(
	state: S,
	stateChanged?: () => void,
) {
	return yield* useImmutableState<S>(state, function* ([newState, patches]) {
		const kv = yield* KVContext.get();
		if (!kv) {
			throw new Error("KV store not found");
		}
		const putEntries: Record<string, unknown> = {};
		const deleteKeys: string[] = [];

		for (const patch of patches) {
			match(patch as PatchOp)
				.with({ op: "add" }, ({ path, value }) => {
					putEntries[`:state:${path}`] = value;
				})
				.with({ op: "remove" }, ({ path }) => {
					deleteKeys.push(`:state:${path}`);
				})
				.with({ op: "replace" }, ({ path, value }) => {
					putEntries[`:state:${path}`] = value;
				});
		}

		let hasStateChanged = false;
		if (Object.keys(putEntries).length > 0) {
			yield* kv.putBatch(putEntries);
			hasStateChanged = true;
		}
		if (deleteKeys.length > 0) {
			yield* kv.deleteBatch(deleteKeys);
			hasStateChanged = true;
		}
		if (hasStateChanged && stateChanged) {
			stateChanged();
		}

		// Assign new state properties
		Object.assign(state, newState);
		// Remove keys that don't exist in newState
		for (const key of Object.keys(state)) {
			if (!(key in newState)) {
				delete state[key];
			}
		}
	});
}

export function* loadState<R extends Record<string, unknown>>(): Operation<R> {
	const kv = yield* KVContext.get();
	if (!kv) {
		throw new Error("KV store not found");
	}
	const entries = yield* kv.list({ prefix: ":state:" });
	const patches = [...entries].map(([path, value]) => ({
		op: "add" as const,
		path: path.replace(":state:", ""),
		value,
	}));
	const newState = apply({}, patches) as R;
	return newState;
}
