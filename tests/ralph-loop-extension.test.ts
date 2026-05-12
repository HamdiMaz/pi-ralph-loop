import test from "node:test";
import assert from "node:assert/strict";

import registerRalphLoop from "../extensions/index.ts";

type RegisteredCommand = {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

type TestEntry = {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
};

type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

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

function createCommandContext(
	options: {
		entries?: TestEntry[];
		getLeafId?: () => string | null;
		selectResult?: string;
		inputResult?: string;
		terminalInputHandlers?: TerminalInputHandler[];
	} = {},
) {
	const actions: string[] = [];
	let abortCount = 0;
	const entries = options.entries ?? [];
	return {
		actions,
		getAbortCount() {
			return abortCount;
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort() {
			abortCount++;
			actions.push("abort");
		},
		waitForIdle: async () => {},
		sessionManager: {
			getLeafId: () => options.getLeafId?.() ?? null,
			getEntries: () => entries,
			getBranch: () => entries,
		},
		navigateTree: async () => ({ cancelled: false }),
		ui: {
			theme: {
				fg(color: string, text: string) {
					return `${color}:${text}`;
				},
			},
			notify(message: string, type = "info") {
				actions.push(`notify:${type}:${message}`);
			},
			setStatus(key: string, text: string | undefined) {
				actions.push(`status:${key}:${text ?? ""}`);
			},
			setEditorText(text: string) {
				actions.push(`editor:${text}`);
			},
			select: async () => options.selectResult,
			input: async () => options.inputResult,
			onTerminalInput(handler: TerminalInputHandler) {
				options.terminalInputHandlers?.push(handler);
				actions.push("terminal-input:registered");
				return () => actions.push("terminal-input:unregistered");
			},
		},
	};
}

test("registers the /loop command", () => {
	const { pi, commands } = createPiHarness();

	registerRalphLoop(pi as never);

	const command = commands.get("loop");
	assert.ok(command, "expected /loop to be registered");
	assert.equal(command.description, "Repeat a prompt with fresh active context, up to the configured iteration cap");
	assert.equal(typeof command.handler, "function");
});

test("registers the /loop-settings command", () => {
	const { pi, commands } = createPiHarness();

	registerRalphLoop(pi as never);

	const command = commands.get("loop-settings");
	assert.ok(command, "expected /loop-settings to be registered");
	assert.equal(command.description, "Configure Ralph Loop settings");
	assert.equal(typeof command.handler, "function");
});

test("registers lifecycle handlers for session_start, agent_end, and session_shutdown", () => {
	const { pi, handlers } = createPiHarness();

	registerRalphLoop(pi as never);

	assert.equal(handlers.get("session_start")?.length, 1);
	assert.equal(handlers.get("agent_end")?.length, 1);
	assert.equal(handlers.get("session_shutdown")?.length, 1);
});

test("/loop command sends the first prompt through Pi", async () => {
	const { pi, commands, sentPrompts } = createPiHarness();
	registerRalphLoop(pi as never);
	const command = commands.get("loop");
	assert.ok(command);

	await command.handler("ship it", createCommandContext());

	assert.deepEqual(sentPrompts, ["ship it"]);
});

test("/loop command records a reset checkpoint before sending the first prompt", async () => {
	const entries: TestEntry[] = [{ type: "message", id: "root", parentId: null }];
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

	await command.handler("ship it", createCommandContext({ entries, getLeafId: () => leafId }));

	assert.deepEqual(sentPrompts, ["ship it"]);
	assert.deepEqual(events, ["append:ralph-loop-checkpoint", "send:ship it"]);
	assert.deepEqual(appendedEntries, [
		{ customType: "ralph-loop-checkpoint", data: { maxIterations: 10, prompt: "ship it" } },
	]);
	assert.equal(leafId, "entry-1");
});

test("/loop-settings updates the maximum iteration cap used by later loops", async () => {
	const entries: TestEntry[] = [{ type: "message", id: "root", parentId: null }];
	let leafId: string | null = "root";
	const { pi, appendedEntries, commands, events, sentPrompts } = createPiHarness({
		onAppendEntry(customType, data) {
			const id = `entry-${entries.length}`;
			entries.push({ type: "custom", customType, data, id, parentId: leafId });
			leafId = id;
		},
	});
	registerRalphLoop(pi as never);
	const settingsCommand = commands.get("loop-settings");
	const loopCommand = commands.get("loop");
	assert.ok(settingsCommand);
	assert.ok(loopCommand);
	const ctx = createCommandContext({
		entries,
		getLeafId: () => leafId,
		selectResult: "Maximum loop iterations",
		inputResult: "3",
	});

	await settingsCommand.handler("", ctx);
	await loopCommand.handler("ship it", ctx);

	assert.deepEqual(sentPrompts, ["ship it"]);
	assert.deepEqual(events, ["append:ralph-loop-settings", "append:ralph-loop-checkpoint", "send:ship it"]);
	assert.deepEqual(appendedEntries, [
		{ customType: "ralph-loop-settings", data: { maxIterations: 3 } },
		{ customType: "ralph-loop-checkpoint", data: { maxIterations: 3, prompt: "ship it" } },
	]);
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop maximum iterations set to 3."));
	assert.ok(ctx.actions.includes("status:ralph-loop:warning:Loop 1/3"));
});

test("/loop-settings rejects invalid maximum iteration values", async () => {
	const { pi, appendedEntries, commands } = createPiHarness();
	registerRalphLoop(pi as never);
	const settingsCommand = commands.get("loop-settings");
	assert.ok(settingsCommand);
	const ctx = createCommandContext({ selectResult: "Maximum loop iterations", inputResult: "0" });

	await settingsCommand.handler("", ctx);

	assert.deepEqual(appendedEntries, []);
	assert.ok(ctx.actions.includes("notify:warning:Maximum loop iterations must be a positive integer."));
});

test("Escape terminal input stops an active loop and aborts the agent", async () => {
	const terminalInputHandlers: TerminalInputHandler[] = [];
	const { pi, commands, handlers, sentPrompts } = createPiHarness();
	registerRalphLoop(pi as never);
	const ctx = createCommandContext({ terminalInputHandlers });
	const sessionStartHandler = handlers.get("session_start")?.[0];
	const loopCommand = commands.get("loop");
	assert.ok(sessionStartHandler);
	assert.ok(loopCommand);

	sessionStartHandler({}, ctx);
	await loopCommand.handler("ship it", ctx);
	ctx.actions.length = 0;
	terminalInputHandlers[0]?.("\x1b");
	handlers.get("agent_end")?.[0]?.({}, ctx);

	assert.deepEqual(sentPrompts, ["ship it"]);
	assert.equal(ctx.getAbortCount(), 1);
	assert.ok(ctx.actions.includes("abort"));
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop stopped."));
});

test("Kitty-protocol Escape terminal input stops an active loop and aborts the agent", async () => {
	const terminalInputHandlers: TerminalInputHandler[] = [];
	const { pi, commands, handlers, sentPrompts } = createPiHarness();
	registerRalphLoop(pi as never);
	const ctx = createCommandContext({ terminalInputHandlers });
	const sessionStartHandler = handlers.get("session_start")?.[0];
	const loopCommand = commands.get("loop");
	assert.ok(sessionStartHandler);
	assert.ok(loopCommand);

	sessionStartHandler({}, ctx);
	await loopCommand.handler("ship it", ctx);
	ctx.actions.length = 0;
	terminalInputHandlers[0]?.("\x1b[27u");
	handlers.get("agent_end")?.[0]?.({}, ctx);

	assert.deepEqual(sentPrompts, ["ship it"]);
	assert.equal(ctx.getAbortCount(), 1);
	assert.ok(ctx.actions.includes("abort"));
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop stopped."));
});
