import test from "node:test";
import assert from "node:assert/strict";

import registerRalphLoop from "../extensions/index.ts";

type RegisteredCommand = {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

function createPiHarness() {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const sentPrompts: string[] = [];
	const pi = {
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on(eventName: string, handler: (event: unknown, ctx: unknown) => void) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
		sendUserMessage(prompt: string) {
			sentPrompts.push(prompt);
		},
	};
	return { pi, commands, handlers, sentPrompts };
}

test("registers the /loop command", () => {
	const { pi, commands } = createPiHarness();

	registerRalphLoop(pi as never);

	const command = commands.get("loop");
	assert.ok(command, "expected /loop to be registered");
	assert.equal(command.description, "Repeat a prompt with fresh active context, up to 10 iterations");
	assert.equal(typeof command.handler, "function");
});

test("registers lifecycle handlers for agent_end and session_shutdown", () => {
	const { pi, handlers } = createPiHarness();

	registerRalphLoop(pi as never);

	assert.equal(handlers.get("agent_end")?.length, 1);
	assert.equal(handlers.get("session_shutdown")?.length, 1);
});

test("/loop command sends the first prompt through Pi", async () => {
	const { pi, commands, sentPrompts } = createPiHarness();
	registerRalphLoop(pi as never);
	const command = commands.get("loop");
	assert.ok(command);

	await command.handler("ship it", {
		isIdle: () => true,
		waitForIdle: async () => {},
		sessionManager: { getEntries: () => [] },
		navigateTree: async () => ({ cancelled: false }),
		ui: {
			notify: () => {},
			setStatus: () => {},
			setEditorText: () => {},
		},
	});

	assert.deepEqual(sentPrompts, ["ship it"]);
});
