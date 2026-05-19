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
	let pendingMessages = false;
	let leafId = initialLeafId ?? entries.at(-1)?.id ?? null;
	const actions: string[] = [];
	const ctx = {
		actions,
		setIdle(value: boolean) {
			idle = value;
		},
		setPendingMessages(value: boolean) {
			pendingMessages = value;
		},
		isIdle() {
			return idle;
		},
		hasPendingMessages() {
			return pendingMessages;
		},
		abort() {
			actions.push("abort");
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
		},
	};
	return ctx;
}

function createHarness(
	maxIterations = 10,
	createResetCheckpoint?: (ctx: LoopCommandContextLike, prompt: string) => string | undefined,
	sendUserMessage?: (prompt: string, sentPrompts: string[]) => Promise<void> | void,
) {
	const sentPrompts: string[] = [];
	const scheduled: Array<() => Promise<void> | void> = [];
	const controller = new RalphLoopController({
		maxIterations,
		createResetCheckpoint,
		sendUserMessage(prompt: string) {
			if (sendUserMessage) {
				return sendUserMessage(prompt, sentPrompts);
			}
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
	assert.ok(ctx.actions.includes("status:ralph-loop:warning:Loop 1/10"));
});

test("updating maximum iterations affects subsequent loops", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	controller.setMaxIterations(2);
	await controller.handleCommand("bounded", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["bounded", "bounded"]);
	assert.equal(controller.getState().active, false);
	assert.equal(controller.getState().maxIterations, 2);
	assert.ok(ctx.actions.includes("status:ralph-loop:warning:Loop 1/2"));
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop reached the 2-iteration cap."));
});

test("updating maximum iterations does not change an active loop's cap", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("keep original cap", ctx);
	controller.setMaxIterations(1);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["keep original cap", "keep original cap"]);
	assert.equal(controller.getState().active, true);
	assert.equal(controller.getState().maxIterations, 10);
	assert.ok(ctx.actions.includes("status:ralph-loop:warning:Loop 2/10"));
});

test("interrupt stops the active loop and aborts the current agent run", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("stop on escape", ctx);
	ctx.actions.length = 0;

	assert.equal(controller.interrupt(ctx), true);
	controller.handleAgentEnd();

	assert.deepEqual(sentPrompts, ["stop on escape"]);
	assert.equal(controller.getState().active, false);
	assert.deepEqual(scheduled, []);
	assert.ok(ctx.actions.includes("abort"));
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop stopped."));
});

test("/loop without a prompt refuses to start when inactive", async () => {
	const { controller, sentPrompts } = createHarness();
	const ctx = createContext();

	await controller.handleCommand("   ", ctx);

	assert.deepEqual(sentPrompts, []);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:warning:Usage: /loop <prompt>"));
});

test("/loop without a prompt does not retain command context after refusing to start", async () => {
	const { controller } = createHarness();
	const ctx = createContext();

	await controller.handleCommand("   ", ctx);
	ctx.actions.length = 0;
	controller.shutdown();

	assert.deepEqual(ctx.actions, []);
});

test("/loop refuses to start while another message is queued", async () => {
	const { controller, sentPrompts } = createHarness();
	const ctx = createContext();
	ctx.setPendingMessages(true);

	await controller.handleCommand("do not race queued work", ctx);

	assert.deepEqual(sentPrompts, []);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:warning:Ralph Loop can only start when no messages are queued."));
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

test("calling /loop while active and already idle stops immediately with a single notification", async () => {
	const { controller, sentPrompts } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("keep going", ctx);
	ctx.actions.length = 0;
	await controller.handleCommand("", ctx);

	assert.equal(controller.getState().active, false);
	assert.deepEqual(sentPrompts, ["keep going"]);
	assert.deepEqual(
		ctx.actions.filter((action) => action.startsWith("notify:")),
		["notify:info:Ralph Loop stopped."],
	);
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

test("agent_end stops before resetting when another message is queued", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("do not interrupt queued work", ctx);
	ctx.setPendingMessages(true);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["do not interrupt queued work"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:warning:Ralph Loop stopped: another message is queued."));
	assert.ok(!ctx.actions.includes("waitForIdle"), "queued work should stop the loop before waiting for idle");
	assert.deepEqual(
		ctx.actions.filter((action) => action.startsWith("navigate:") || action.startsWith("editor:")),
		[],
	);
});

test("agent_end stops after resetting if another message is queued before the next iteration", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");
	ctx.navigateTree = async (targetId: string, options: { summarize?: boolean }) => {
		ctx.actions.push(`navigate:${targetId}:summarize=${String(options.summarize)}`);
		ctx.setPendingMessages(true);
		return { cancelled: false };
	};

	await controller.handleCommand("do not race after reset", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["do not race after reset"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:warning:Ralph Loop stopped: another message is queued."));
	assert.deepEqual(
		ctx.actions.filter((action) => action.startsWith("navigate:") || action.startsWith("editor:")),
		["navigate:root:summarize=false", "editor:"],
	);
});

test("agent_end honors a stop request made during reset before starting the next iteration", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");
	ctx.navigateTree = async (targetId: string, options: { summarize?: boolean }) => {
		ctx.actions.push(`navigate:${targetId}:summarize=${String(options.summarize)}`);
		ctx.setIdle(false);
		await controller.handleCommand("", ctx);
		return { cancelled: false };
	};

	await controller.handleCommand("stop during reset", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["stop during reset"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop stopped."));
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

test("/loop reports reset checkpoint creation failures without starting", async () => {
	const ctx = createContext();
	const { controller, sentPrompts } = createHarness(10, () => {
		throw new Error("session is read-only");
	});

	await controller.handleCommand("cannot checkpoint", ctx);

	assert.deepEqual(sentPrompts, []);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop could not start: reset checkpoint failed: session is read-only"));
});

test("/loop reports reset checkpoint failures even when the thrown value cannot be stringified", async () => {
	const ctx = createContext();
	const thrownValue = {
		toString() {
			throw new Error("toString failed");
		},
	};
	const { controller, sentPrompts } = createHarness(10, () => {
		throw thrownValue;
	});

	await assert.doesNotReject(() => controller.handleCommand("cannot checkpoint", ctx));

	assert.deepEqual(sentPrompts, []);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop could not start: reset checkpoint failed: Unknown error"));
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

test("a stopped loop releases its command context", async () => {
	const { controller, scheduled } = createHarness(1);
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("one shot", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);
	ctx.actions.length = 0;
	controller.shutdown();

	assert.deepEqual(ctx.actions, []);
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

test("a stop request stops cleanly without waiting for idle again", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");
	ctx.waitForIdle = async () => {
		ctx.actions.push("waitForIdle:throw");
		throw new Error("idle unavailable");
	};

	await controller.handleCommand("stop before waiting", ctx);
	ctx.setIdle(false);
	await controller.handleCommand("", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["stop before waiting"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop stopped."));
	assert.ok(!ctx.actions.includes("waitForIdle:throw"));
});

test("the iteration cap stops cleanly without waiting for idle again", async () => {
	const { controller, sentPrompts, scheduled } = createHarness(1);
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");
	ctx.waitForIdle = async () => {
		ctx.actions.push("waitForIdle:throw");
		throw new Error("idle unavailable");
	};

	await controller.handleCommand("one shot", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["one shot"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("notify:info:Ralph Loop reached the 1-iteration cap."));
	assert.ok(!ctx.actions.includes("waitForIdle:throw"));
});

test("the loop stops and notifies when waiting for idle fails before another iteration is needed", async () => {
	const { controller, sentPrompts, scheduled } = createHarness();
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");
	ctx.waitForIdle = async () => {
		ctx.actions.push("waitForIdle:throw");
		throw new Error("idle unavailable");
	};

	await controller.handleCommand("recover from idle failure", ctx);
	controller.handleAgentEnd();
	await runNextScheduled(scheduled);

	assert.deepEqual(sentPrompts, ["recover from idle failure"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop stopped: continuation failed: idle unavailable"));
});

test("the loop stops and notifies when scheduling a continuation fails", async () => {
	const sentPrompts: string[] = [];
	const controller = new RalphLoopController({
		sendUserMessage(prompt) {
			sentPrompts.push(prompt);
		},
		schedule() {
			throw new Error("scheduler unavailable");
		},
	});
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");

	await controller.handleCommand("recover from scheduler failure", ctx);
	assert.doesNotThrow(() => controller.handleAgentEnd());

	assert.deepEqual(sentPrompts, ["recover from scheduler failure"]);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop stopped: could not schedule continuation: scheduler unavailable"));
});

test("the loop stops and notifies when starting an iteration fails", async () => {
	const { controller, sentPrompts } = createHarness(10, undefined, () => {
		throw new Error("agent busy");
	});
	const ctx = createContext();

	await controller.handleCommand("cannot send", ctx);

	assert.deepEqual(sentPrompts, []);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop stopped: could not start iteration: agent busy"));
});

test("the loop stops and notifies when starting an iteration rejects asynchronously", async () => {
	const { controller, sentPrompts } = createHarness(10, undefined, () => {
		return Promise.reject(new Error("agent busy async"));
	});
	const ctx = createContext();

	await controller.handleCommand("cannot send async", ctx);

	assert.deepEqual(sentPrompts, []);
	assert.equal(controller.getState().active, false);
	assert.ok(ctx.actions.includes("status:ralph-loop:"));
	assert.ok(ctx.actions.includes("notify:error:Ralph Loop stopped: could not start iteration: agent busy async"));
});

test("inactive shutdown does not emit diagnostic events", () => {
	const debugEvents: string[] = [];
	const { controller } = createHarness();
	controller.setDebugLogger((event) => debugEvents.push(event.event));

	controller.shutdown();

	assert.deepEqual(debugEvents, []);
});

test("the controller emits diagnostic events for loop lifecycle decisions", async () => {
	const debugEvents: Array<{ event: string; stopReason?: string }> = [];
	const { controller, scheduled } = createHarness(1);
	const ctx = createContext([rootUserEntry("root"), assistantEntry("assistant", "root")], "root");
	controller.setDebugLogger((event) => debugEvents.push(event));

	await controller.handleCommand("diagnose me", ctx);
	controller.handleAgentEnd({
		messages: [
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "done" }],
			},
		],
	});
	await runNextScheduled(scheduled);

	assert.deepEqual(
		debugEvents.map((event) => event.event),
		[
			"loop_start",
			"iteration_send_start",
			"iteration_send_succeeded",
			"agent_end",
			"continuation_scheduled",
			"continuation_start",
			"loop_stop",
		],
	);
	assert.equal(debugEvents.find((event) => event.event === "agent_end")?.stopReason, "stop");
});
