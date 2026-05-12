import test from "node:test";
import assert from "node:assert/strict";

import { RalphLoopController, type LoopCommandContextLike } from "../extensions/loop-controller.ts";

type TestEntry = {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: {
		role: string;
		content: Array<{ type: string; text: string }>;
	};
};

function userEntry(id: string, parentId: string | null, text = "root prompt"): TestEntry {
	return {
		type: "message",
		id,
		parentId,
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	};
}

function rootUserEntry(id: string, text = "root prompt"): TestEntry {
	return userEntry(id, null, text);
}

function assistantEntry(id: string, parentId: string): TestEntry {
	return {
		type: "message",
		id,
		parentId,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		},
	};
}

function modelChangeEntry(id: string): TestEntry {
	return {
		type: "model_change",
		id,
		parentId: null,
	};
}

function checkpointEntry(id: string, parentId: string | null, prompt: string): TestEntry {
	return {
		type: "custom",
		customType: "ralph-loop-checkpoint",
		data: { prompt },
		id,
		parentId,
	};
}

function createContext(entries: TestEntry[] = [rootUserEntry("root")], initialLeafId?: string | null) {
	let idle = true;
	let leafId = initialLeafId ?? entries.at(-1)?.id ?? null;
	const actions: string[] = [];
	const ctx = {
		actions,
		setIdle(value: boolean) {
			idle = value;
		},
		isIdle() {
			return idle;
		},
		async waitForIdle() {
			actions.push("waitForIdle");
		},
		sessionManager: {
			getLeafId() {
				return leafId;
			},
			getEntries() {
				return entries;
			},
		},
		async navigateTree(targetId: string, options: { summarize?: boolean }) {
			actions.push(`navigate:${targetId}:summarize=${String(options.summarize)}`);
			leafId = targetId;
			return { cancelled: false };
		},
		ui: {
			notify(message: string, type = "info") {
				actions.push(`notify:${type}:${message}`);
			},
			setStatus(key: string, text: string | undefined) {
				actions.push(`status:${key}:${text ?? ""}`);
			},
			setEditorText(text: string) {
				actions.push(`editor:${text}`);
			},
		},
	};
	return ctx;
}

function createHarness(
	maxIterations = 10,
	createResetCheckpoint?: (ctx: LoopCommandContextLike, prompt: string) => string | undefined,
) {
	const sentPrompts: string[] = [];
	const scheduled: Array<() => Promise<void> | void> = [];
	const controller = new RalphLoopController({
		maxIterations,
		createResetCheckpoint,
		sendUserMessage(prompt: string) {
			sentPrompts.push(prompt);
		},
		schedule(task: () => Promise<void> | void) {
			scheduled.push(task);
		},
	});
	return { controller, sentPrompts, scheduled };
}

async function runNextScheduled(scheduled: Array<() => Promise<void> | void>) {
	const task = scheduled.shift();
	assert.ok(task, "expected a scheduled continuation");
	await task();
}

test("/loop with a prompt starts the first iteration immediately", async () => {
	const { controller, sentPrompts } = createHarness();
	const ctx = createContext();

	await controller.handleCommand("build the thing", ctx);

	assert.deepEqual(sentPrompts, ["build the thing"]);
	assert.deepEqual(controller.getState(), {
		active: true,
		prompt: "build the thing",
		iterationsStarted: 1,
		maxIterations: 10,
		stopRequested: false,
	});
	assert.ok(ctx.actions.includes("status:ralph-loop:Loop 1/10"));
});

test("/loop without a prompt refuses to start when inactive", async () => {
	const { controller, sentPrompts } = createHarness();
	const ctx = createContext();

	await controller.handleCommand("   ", ctx);

	assert.deepEqual(sentPrompts, []);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:warning:Usage: /loop <prompt>"));
});

test("calling /loop while active requests a graceful stop and does not queue another prompt", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("keep going", ctx);
	ctx.setIdle(false);
	await controller.handleCommand("", ctx);

	assert.equal(controller.getState().stopRequested, true);
	assert.deepEqual(sentPrompts, ["keep going"]);
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop will stop after the current run finishes."));

	ctx.setIdle(true);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.equal(controller.getState().active, false);
	assert.deepEqual(sentPrompts, ["keep going"]);
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
});

test("agent_end resets active context with tree navigation before sending the next iteration", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("repeat me", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["repeat me", "repeat me"]);
	assert.deepEqual(
		ctx.actions.filter((action) => action.startsWith("navigate:") || action.startsWith("editor:")),
		["navigate:root:summarize=false", "editor:"],
	);
	assert.equal(controller.getState().iterationsStarted, 2);
});

test("agent_end prefers a custom reset checkpoint when one is created at loop start", async () => {
	const entries = [rootUserEntry("root"), assistantEntry("assistant", "root")];
	const ctx = createContext(entries, "assistant");
	const { controller, sentPrompts, scheduled } = createHarness(10, (_ctx, prompt) => {
		entries.push(checkpointEntry("checkpoint", "assistant", prompt));
		return "checkpoint";
	});

	await controller.handleCommand("repeat from checkpoint", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["repeat from checkpoint", "repeat from checkpoint"]);
	assert.deepEqual(
		ctx.actions.filter((action) => action.startsWith("navigate:") || action.startsWith("editor:")),
		["navigate:checkpoint:summarize=false", "editor:"],
	);
	assert.equal(controller.getState().iterationsStarted, 2);
});

test("a custom reset checkpoint lets an empty session reset before the first loop prompt", async () => {
	const entries: TestEntry[] = [];
	const ctx = createContext(entries, null);
	const { controller, sentPrompts, scheduled } = createHarness(10, (_ctx, prompt) => {
		entries.push(checkpointEntry("checkpoint", null, prompt));
		return "checkpoint";
	});

	await controller.handleCommand("fresh start", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["fresh start", "fresh start"]);
	assert.deepEqual(
		ctx.actions.filter((action) => action.startsWith("navigate:") || action.startsWith("editor:")),
		["navigate:checkpoint:summarize=false", "editor:"],
	);
	assert.equal(controller.getState().iterationsStarted, 2);
});

test("the iteration cap stops the loop after the configured number of total runs", async () => {
	const { controller, sentPrompts, scheduled } = createHarness(2);
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("bounded", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["bounded", "bounded"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop reached the 2-iteration cap."));
});

test("agent_end resets to the loop start checkpoint when the session starts with non-user entries", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext(
		[modelChangeEntry("model"), userEntry("loop-user", "model", "repeat from model"), assistantEntry("assistant", "loop-user")],
		"model",
	);
	ctx.actions.length = 0;

	await controller.handleCommand("repeat from model", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["repeat from model", "repeat from model"]);
	assert.deepEqual(
		ctx.actions.filter((action) => action.startsWith("navigate:") || action.startsWith("editor:")),
		["navigate:model:summarize=false", "editor:"],
	);
	assert.equal(controller.getState().iterationsStarted, 2);
});

test("the loop stops with an error if an empty-session reset cannot find the first loop prompt", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([], null);

	await controller.handleCommand("cannot reset", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["cannot reset"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop stopped: could not find the first loop prompt to reset context."));
});

test("the loop stops and notifies when context reset throws", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");
	ctx.navigateTree = async (targetId: string) => {
		ctx.actions.push(`navigate:${targetId}:throw`);
		throw new Error("tree unavailable");
	};

	await controller.handleCommand("recover cleanly", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["recover cleanly"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop stopped: context reset failed: tree unavailable"));
});
