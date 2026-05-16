import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	DEFAULT_MAX_ITERATIONS,
	LOOP_CHECKPOINT_CUSTOM_TYPE,
	LOOP_SETTINGS_CUSTOM_TYPE,
	RalphLoopController,
	type RalphLoopDebugEvent,
} from "./loop-controller.ts";

const MAX_ITERATIONS_SETTING_LABEL = "Maximum loop iterations";
const ESCAPE_KEY = "escape";
const DEBUG_LOG_FILE = join(".pi", "ralph-loop-debug.jsonl");

type LoopSettingsData = {
	maxIterations?: unknown;
};

type CustomEntryLike = {
	type: string;
	customType?: string;
	data?: unknown;
};

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseMaxIterations(input: string): number | undefined {
	const trimmed = input.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) {
		return undefined;
	}

	const value = Number(trimmed);
	return isPositiveInteger(value) ? value : undefined;
}

function writeDebugEvent(cwd: string, event: RalphLoopDebugEvent): void {
	try {
		const logPath = join(cwd, DEBUG_LOG_FILE);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
	} catch (error) {
		console.error("Ralph Loop debug logging failed:", error);
	}
}

function readStoredMaxIterations(ctx: ExtensionContext): number | undefined {
	let maxIterations: number | undefined;
	for (const entry of ctx.sessionManager.getBranch() as CustomEntryLike[]) {
		if (entry.type !== "custom" || entry.customType !== LOOP_SETTINGS_CUSTOM_TYPE) {
			continue;
		}

		const data = entry.data as LoopSettingsData | undefined;
		if (isPositiveInteger(data?.maxIterations)) {
			maxIterations = data.maxIterations;
		}
	}
	return maxIterations;
}

async function handleLoopSettingsCommand(
	ctx: ExtensionCommandContext,
	controller: RalphLoopController,
	persistMaxIterations: (maxIterations: number) => void,
): Promise<void> {
	const selected = await ctx.ui.select("Ralph Loop Settings", [MAX_ITERATIONS_SETTING_LABEL]);
	if (selected !== MAX_ITERATIONS_SETTING_LABEL) {
		return;
	}

	const input = await ctx.ui.input("Maximum loop iterations", String(controller.getMaxIterations()));
	if (input === undefined) {
		return;
	}

	const maxIterations = parseMaxIterations(input);
	if (maxIterations === undefined) {
		ctx.ui.notify("Maximum loop iterations must be a positive integer.", "warning");
		return;
	}

	controller.setMaxIterations(maxIterations);
	persistMaxIterations(maxIterations);
	ctx.ui.notify(`Ralph Loop maximum iterations set to ${maxIterations}.`, "info");
}

export default function registerRalphLoop(pi: ExtensionAPI): void {
	let unregisterEscapeInterrupt: (() => void) | undefined;
	let currentCwd = process.cwd();
	const rememberCwd = (ctx: ExtensionContext) => {
		currentCwd = ctx.cwd;
	};
	const controller = new RalphLoopController({
		maxIterations: DEFAULT_MAX_ITERATIONS,
		createResetCheckpoint(ctx, prompt, maxIterations) {
			const previousLeafId = ctx.sessionManager.getLeafId();
			pi.appendEntry(LOOP_CHECKPOINT_CUSTOM_TYPE, { maxIterations, prompt });
			const checkpointId = ctx.sessionManager.getLeafId();
			return checkpointId && checkpointId !== previousLeafId ? checkpointId : undefined;
		},
		sendUserMessage(prompt) {
			return pi.sendUserMessage(prompt) as unknown as Promise<void> | void;
		},
		schedule(task) {
			void Promise.resolve()
				.then(task)
				.catch((error) => {
					console.error("Ralph Loop continuation failed:", error);
				});
		},
		logDebug(event) {
			writeDebugEvent(currentCwd, event);
		},
	});

	const persistMaxIterations = (maxIterations: number) => {
		pi.appendEntry(LOOP_SETTINGS_CUSTOM_TYPE, { maxIterations });
	};

	const restoreSettings = (ctx: ExtensionContext) => {
		const maxIterations = readStoredMaxIterations(ctx);
		if (maxIterations !== undefined) {
			controller.setMaxIterations(maxIterations);
		}
	};

	const registerEscapeInterrupt = (ctx: ExtensionContext) => {
		unregisterEscapeInterrupt?.();
		unregisterEscapeInterrupt = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, ESCAPE_KEY)) {
				controller.interrupt(ctx);
			}
			return undefined;
		});
	};

	pi.registerCommand("loop", {
		description: "Repeat a prompt with fresh active context, up to the configured iteration cap",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			rememberCwd(ctx);
			await controller.handleCommand(args, ctx);
		},
	});

	pi.registerCommand("loop-settings", {
		description: "Configure Ralph Loop settings",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			rememberCwd(ctx);
			await handleLoopSettingsCommand(ctx, controller, persistMaxIterations);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		rememberCwd(ctx);
		restoreSettings(ctx);
		registerEscapeInterrupt(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		rememberCwd(ctx);
		controller.handleAgentEnd(event);
	});

	pi.on("session_shutdown", () => {
		unregisterEscapeInterrupt?.();
		unregisterEscapeInterrupt = undefined;
		controller.shutdown();
	});
}
