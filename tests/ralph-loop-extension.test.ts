import test from "node:test";
import assert from "node:assert/strict";

import registerRalphLoop from "../extensions/index.ts";

type RegisteredCommand = {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

function createPiHarness(options: { onAppendEntry?: (customType: string, data: unknown) => void } = {}) {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	const events: string[] = [];
	const sentPrompts: string[] = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			events.push(`append:${customType}`);
			appendedEntries.push({ customType, data });
			options.onAppendEntry?.(customType, data);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on(eventName: string, handler: (event: unknown, ctx: unknown) => void) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
		sendUserMessage(prompt: string) {
			events.push(`send:${prompt}`);
			sentPrompts.push(prompt);
		},
	};
	return { pi, appendedEntries, commands, events, handlers, sentPrompts };
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
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		sessionManager: { getLeafId: () => null, getEntries: () => [] },
		navigateTree: async () => ({ cancelled: false }),
		ui: {
			notify: () => {},
			setStatus: () => {},
			setEditorText: () => {},
		},
	});

	assert.deepEqual(sentPrompts, ["ship it"]);
});

test("/loop command records a reset checkpoint before sending the first prompt", async () => {
	const entries: Array<{ type: string; id: string; parentId: string | null; customType?: string; data?: unknown }> = [
		{ type: "message", id: "root", parentId: null },
	];
	let leafId: string | null = "root";
	const { pi, appendedEntries, commands, events, sentPrompts } = createPiHarness({
		onAppendEntry(customType, data) {
			const id = `entry-${entries.length}`;
			entries.push({ type: "custom", customType, data, id, parentId: leafId });
			leafId = id;
		},
	});
	registerRalphLoop(pi as never);
	const command = commands.get("loop");
	assert.ok(command);

	await command.handler("ship it", {
		isIdle: () => true,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		sessionManager: {
			getLeafId: () => leafId,
			getEntries: () => entries,
		},
		navigateTree: async () => ({ cancelled: false }),
		ui: {
			notify: () => {},
			setStatus: () => {},
			setEditorText: () => {},
		},
	});

	assert.deepEqual(sentPrompts, ["ship it"]);
	assert.deepEqual(events, ["append:ralph-loop-checkpoint", "send:ship it"]);
	assert.deepEqual(appendedEntries, [
		{ customType: "ralph-loop-checkpoint", data: { maxIterations: 10, prompt: "ship it" } },
	]);
	assert.equal(leafId, "entry-1");
});
