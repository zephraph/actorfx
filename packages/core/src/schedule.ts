import type { Operation } from "effection";
import type { Tagged } from "type-fest";
import type { Actions } from "./actor";
import type { Alarm, KVStore } from "./context";

export type ScheduledActionId = Tagged<string, "scheduled-event-id">;
export interface ScheduledAction<A extends Actions, K extends keyof A> {
	id: ScheduledActionId;
	createdAt: number;
	triggerAt: number;
	action: K;
	args: Parameters<A[K]>;
}

export interface Scheduler<A extends Actions> {
	at: <K extends keyof A>(
		triggerAt: number,
		action: K,
		...args: Parameters<A[K]>
	) => Operation<ScheduledActionId>;
	after: <K extends keyof A>(
		ms: number,
		action: K,
		...args: Parameters<A[K]>
	) => Operation<ScheduledActionId>;
	get: (eventId: ScheduledActionId) => Operation<ScheduledAction<A, keyof A>>;
	list: () => Operation<ScheduledAction<A, keyof A>[]>;
	cancel: (eventId: ScheduledActionId) => Operation<void>;
}

export interface PrivateScheduler {
	_deleteEvents: (eventIds: ScheduledActionId[]) => Operation<void>;
}

export function createScheduler<A extends Actions>({
	alarm,
	kv,
}: { alarm: Alarm; kv: KVStore }): Scheduler<A> & PrivateScheduler {
	return {
		*at<K extends keyof A>(
			triggerAt: number,
			action: K,
			...args: Parameters<A[K]>
		): Operation<ScheduledActionId> {
			if (triggerAt < Date.now()) {
				throw new Error("Cannot schedule actions in the past");
			}
			const nextAlarm = yield* alarm.get();
			const scheduleAction: ScheduledAction<A, K> = {
				id: crypto.randomUUID() as ScheduledActionId,
				createdAt: Date.now(),
				triggerAt,
				action,
				args,
			};
			yield* kv.put(`scheduled-actions:${scheduleAction.id}`, scheduleAction);

			if (!nextAlarm || nextAlarm > triggerAt) {
				alarm.set(triggerAt);
			}

			return scheduleAction.id;
		},
		*after<K extends keyof A>(
			ms: number,
			action: K,
			...args: Parameters<A[K]>
		): Operation<ScheduledActionId> {
			const triggerAt = Date.now() + ms;
			return yield* this.at(triggerAt, action, ...args);
		},
		*get(eventId: ScheduledActionId): Operation<ScheduledAction<A, keyof A>> {
			const storedAction = yield* kv.get(`scheduled-actions:${eventId}`);
			if (!storedAction) {
				throw new Error(`No scheduled action found with id ${eventId}`);
			}
			return storedAction as ScheduledAction<A, keyof A>;
		},
		*list(): Operation<ScheduledAction<A, keyof A>[]> {
			const actions = yield* kv.list({ prefix: "scheduled-actions:" });
			return Object.values(actions) as ScheduledAction<A, keyof A>[];
		},
		*cancel(eventId: ScheduledActionId): Operation<void> {
			// Delete the action from KV store
			yield* kv.delete(`scheduled-actions:${eventId}`);

			// Check if we need to update the alarm
			const nextAlarm = yield* alarm.get();
			if (nextAlarm) {
				// Get the action we just deleted to see if it was the next scheduled one
				const actions = yield* this.list();
				if (actions.length === 0) {
					// No more actions, delete the alarm
					alarm.clear();
				} else {
					// Find the next earliest action
					const nextTrigger = Math.min(
						...actions.map((a: ScheduledAction<A, keyof A>) => a.triggerAt),
					);
					if (nextTrigger !== nextAlarm) {
						alarm.set(nextTrigger);
					}
				}
			}
		},
		*_deleteEvents(eventIds: ScheduledActionId[]): Operation<void> {
			yield* kv.deleteBatch(eventIds.map((id) => `scheduled-actions:${id}`));
		},
	};
}
