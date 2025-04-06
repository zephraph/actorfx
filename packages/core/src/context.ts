import type { Channel, Operation } from "effection";
import { createContext } from "effection";

//#region KVStore
export interface KVStore {
	get(key: string): Operation<unknown>;
	put(key: string, value: unknown): Operation<void>;
	putBatch(entries: Record<string, unknown>): Operation<void>;
	delete(key: string): Operation<boolean>;
	deleteBatch(keys: string[]): Operation<number>;
	list(options: { prefix?: string }): Operation<Map<string, unknown>>;
}

export const KVContext = createContext<KVStore>("kv-store");
//#endregion

//#region Alarm
export interface Alarm {
	get(): Operation<number | null>;
	set(ms: number): Operation<void>;
	clear(): Operation<void>;
	subscribe(): Channel<void, void>;
	trigger(): Operation<void>;
}
export const AlarmContext = createContext<Alarm>("alarm");
//#endregion
