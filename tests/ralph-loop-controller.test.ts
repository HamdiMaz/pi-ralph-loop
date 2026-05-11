import test from "node:test";
import assert from "node:assert/strict";

import { RalphLoopController } from "../extensions/ralph-loop/loop-controller.ts";

function rootUserEntry(id: string, text = "root prompt") {
	return {
		type: "message",
		id,
		parentId: null,
		message: {
			role: "user",
			content: [{ type: "text", text }],
		},
	};
}

function assistantEntry(id: string, parentId: string) {
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

function createContext(entries = [rootUserEntry("root")]) {
	let idle = true;
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
			getEntries() {
				return entries;
			},
		},
		async navigateTree(targetId: string, options: { summarize?: boolean }) {
			actions.push(`navigate:${targetId}:summarize=${String(options.summarize)}`);
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

function createHarness(maxIterations = 10) {
	const sentPrompts: string[] = [];
	const scheduled: Array<() => Promise<void> | void> = [];
	const controller = new RalphLoopController({
		maxIterations,
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
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")]);

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
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")]);

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

test("the iteration cap stops the loop after the configured number of total runs", async () => {
	const { controller, sentPrompts, scheduled } = createHarness(2);
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")]);

	await controller.handleCommand("bounded", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["bounded", "bounded"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop reached the 2-iteration cap."));
});

test("the loop stops with an error if no root user entry exists for context reset", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([]);

	await controller.handleCommand("cannot reset", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["cannot reset"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop stopped: could not find a root user message to reset context."));
});
