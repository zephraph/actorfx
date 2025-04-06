import type { Actions, ActorDefinition, ActorInstance } from "./actor";

export type Actors<
	Act extends Actions = Actions,
	Actor extends ActorDefinition<Act> = ActorDefinition<Act>,
> = Record<string, Actor>;

// biome-ignore lint/suspicious/noExplicitAny: The any is okay here because we're trying to infer the type
export type ActorActions<A extends ActorDefinition<any>> =
	A extends ActorDefinition<infer Act> ? Act : never;

// export interface App<A extends Actors> {
//   actors: A,
//   createOrStartActor: <K extends keyof A>(type: K, id: string) => ActorInstance<A[K]["actions"]>;
// }

export interface AppConfig<A extends Actors> {
	actors: A;
}

// Right now this is just a straight copy of app config, but I'm going to add more stuff to it eventually
export type App<A extends Actors> = AppConfig<A>;

export type Client<A extends Actors> = {
	[K in keyof A]: (name: string) => ActorInstance<ActorActions<A[K]>>;
};

export function setup<A extends Actors>(appConfig: AppConfig<A>): App<A> {
	// it's silly, I know.
	return appConfig;
}
