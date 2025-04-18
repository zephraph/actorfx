import { createClient, createDurableObject } from "@actorfx/cloudflare";
import { actor, setup } from "@actorfx/core";

const chatroom = actor({
	state: {
		messages: [] as string[],
	},
	actions: {
		sendMessage(ctx, message: string) {
			ctx.state.messages.push(message);
			console.log("setting message", message);
			// ctx.broadcast("message", message);
		},
		getMessages(ctx) {
			console.log("getMessages is called");
			return ctx.state.messages;
		},
	},
});

const app = setup({
	actors: { chatroom },
});

export const ActorDurableObject = createDurableObject(app);

export default {
	async fetch() {
		const c = createClient(app);
		// await c.chatroom('test').sendMessage('Hello, world!');
		// await c.chatroom('test').sendMessage('Goodbye, world!');
		await c.chatroom("test").getMessages();
		// console.log(msg)
		return new Response("ok");
	},
};
