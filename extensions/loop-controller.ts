export const DEFAULT_MAX_ITERATIONS = 10;
export const LOOP_CHECKPOINT_CUSTOM_TYPE = "ralph-loop-checkpoint";
export const LOOP_SETTINGS_CUSTOM_TYPE = "ralph-loop-settings";
export const STATUS_KEY = "ralph-loop";

type NotifyType = "info" | "warning" | "error";
type LoopTheme = {
	fg(color: "warning", text: string): string;
};

type LoopContentPart = { type: string; text?: string };

type LoopEntry = {
	type: string;
	id: string;
	parentId: string | null;
	message?: {
		role?: string;
		content?: string | LoopContentPart[];
	};
};

type LoopAgentMessage = {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: string | LoopContentPart[];
};

export type LoopAgentEndEventLike = {
	messages?: LoopAgentMessage[];
};

export type RalphLoopDebugEvent = {
	timestamp: string;
	event: string;
	active: boolean;
	prompt: string;
	iterationsStarted: number;
	maxIterations: number;
	stopRequested: boolean;
	message?: string;
	notifyType?: NotifyType;
	errorMessage?: string;
	stopReason?: string;
	assistantPreview?: string;
	toolCallCount?: number;
	toolResultCount?: number;
};

type ResetTarget =
	| { kind: "entry"; id: string }
	| { kind: "firstLoopPrompt"; prompt: string };

export type LoopCommandContextLike = {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	waitForIdle(): Promise<void>;
	sessionManager: {
		getLeafId(): string | null;
		getEntries(): LoopEntry[];
	};
	navigateTree(targetId: string, options: { summarize: boolean }): Promise<{ cancelled: boolean }>;
	ui: {
		theme: LoopTheme;
		notify(message: string, type?: NotifyType): void;
		setStatus(key: string, text: string | undefined): void;
		setEditorText(text: string): void;
	};
};

export type LoopInterruptContextLike = {
	abort(): void;
};

export type RalphLoopControllerOptions = {
	maxIterations?: number;
	createResetCheckpoint?(ctx: LoopCommandContextLike, prompt: string, maxIterations: number): string | undefined;
	sendUserMessage(prompt: string): Promise<void> | void;
	schedule(task: () => Promise<void> | void): void;
	logDebug?(event: RalphLoopDebugEvent): void;
};

export type RalphLoopState = {
	active: boolean;
	prompt: string;
	iterationsStarted: number;
	maxIterations: number;
	stopRequested: boolean;
};

function isUserEntry(entry: LoopEntry): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

function contentToText(content: NonNullable<LoopEntry["message"]>["content"] | undefined): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("");
}

function errorToMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message || error.name || "Error";
	}
	try {
		return String(error) || "Unknown error";
	} catch {
		return "Unknown error";
	}
}

export class RalphLoopController {
	private maxIterations: number;
	private readonly createResetCheckpoint: RalphLoopControllerOptions["createResetCheckpoint"];
	private readonly sendUserMessage: (prompt: string) => Promise<void> | void;
	private readonly schedule: (task: () => Promise<void> | void) => void;
	private debugLogger: ((event: RalphLoopDebugEvent) => void) | undefined;
	private context: LoopCommandContextLike | undefined;
	private continuationScheduled = false;
	private resetTarget: ResetTarget | undefined;
	private entryIdsAtStart = new Set<string>();
	private state: RalphLoopState;

	constructor(options: RalphLoopControllerOptions) {
		this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		this.createResetCheckpoint = options.createResetCheckpoint;
		this.sendUserMessage = options.sendUserMessage;
		this.schedule = options.schedule;
		this.debugLogger = options.logDebug;
		this.state = this.createInactiveState();
	}

	setDebugLogger(logger: ((event: RalphLoopDebugEvent) => void) | undefined): void {
		this.debugLogger = logger;
	}

	getState(): RalphLoopState {
		return { ...this.state };
	}

	getMaxIterations(): number {
		return this.maxIterations;
	}

	setMaxIterations(maxIterations: number): void {
		this.maxIterations = maxIterations;
		if (!this.state.active) {
			this.state = this.createInactiveState();
		}
	}

	interrupt(ctx: LoopInterruptContextLike): boolean {
		if (!this.state.active) {
			return false;
		}

		try {
			ctx.abort();
		} finally {
			this.stop("Ralph Loop stopped.", "info");
		}
		return true;
	}

	async handleCommand(args: string, ctx: LoopCommandContextLike): Promise<void> {
		if (this.state.active) {
			this.context = ctx;
			this.state.stopRequested = true;
			if (ctx.isIdle() && !this.continuationScheduled) {
				this.stop("Ralph Loop stopped.", "info");
				return;
			}
			ctx.ui.notify("Ralph Loop will stop after the current run finishes.", "info");
			return;
		}

		const prompt = args.trim();
		if (!prompt) {
			ctx.ui.notify("Usage: /loop <prompt>", "warning");
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify("Ralph Loop can only start while the agent is idle.", "warning");
			return;
		}

		if (ctx.hasPendingMessages()) {
			ctx.ui.notify("Ralph Loop can only start when no messages are queued.", "warning");
			return;
		}

		this.context = ctx;
		const entriesAtStart = ctx.sessionManager.getEntries();
		this.entryIdsAtStart = new Set(entriesAtStart.map((entry) => entry.id));
		const startLeafId = ctx.sessionManager.getLeafId();
		let checkpointId: string | undefined;
		try {
			checkpointId = this.createResetCheckpoint?.(ctx, prompt, this.maxIterations);
		} catch (error) {
			this.stop(`Ralph Loop could not start: reset checkpoint failed: ${errorToMessage(error)}`, "error");
			return;
		}
		this.resetTarget = checkpointId
			? { kind: "entry", id: checkpointId }
			: startLeafId
				? { kind: "entry", id: startLeafId }
				: { kind: "firstLoopPrompt", prompt };

		this.state = {
			active: true,
			prompt,
			iterationsStarted: 0,
			maxIterations: this.maxIterations,
			stopRequested: false,
		};
		this.emitDebug({ event: "loop_start" });
		await this.startNextIteration(ctx);
	}

	handleAgentEnd(event?: LoopAgentEndEventLike): void {
		if (!this.state.active || this.continuationScheduled) {
			return;
		}

		this.emitAgentEndDebug(event);
		this.continuationScheduled = true;
		this.emitDebug({ event: "continuation_scheduled" });
		try {
			this.schedule(async () => {
				this.continuationScheduled = false;
				try {
					await this.continueAfterAgentEnd();
				} catch (error) {
					this.stop(`Ralph Loop stopped: continuation failed: ${errorToMessage(error)}`, "error");
				}
			});
		} catch (error) {
			this.stop(`Ralph Loop stopped: could not schedule continuation: ${errorToMessage(error)}`, "error");
		}
	}

	shutdown(): void {
		this.stop(undefined, "info");
	}

	private async continueAfterAgentEnd(): Promise<void> {
		const ctx = this.context;
		if (!this.state.active || !ctx) {
			return;
		}

		this.emitDebug({ event: "continuation_start" });
		if (this.stopIfCannotContinue(ctx)) {
			return;
		}

		await ctx.waitForIdle();

		if (!this.state.active || this.stopIfCannotContinue(ctx)) {
			return;
		}

		const resetSucceeded = await this.resetActiveContext(ctx);
		if (!resetSucceeded) {
			return;
		}

		if (this.stopIfCannotContinue(ctx)) {
			return;
		}

		await this.startNextIteration(ctx);
	}

	private stopIfCannotContinue(ctx: LoopCommandContextLike): boolean {
		return this.stopIfNoFurtherIterationsNeeded() || this.stopIfQueuedMessages(ctx);
	}

	private stopIfNoFurtherIterationsNeeded(): boolean {
		if (this.state.stopRequested) {
			this.stop("Ralph Loop stopped.", "info");
			return true;
		}

		if (this.state.iterationsStarted >= this.state.maxIterations) {
			this.stop(`Ralph Loop reached the ${this.state.maxIterations}-iteration cap.`, "info");
			return true;
		}

		return false;
	}

	private stopIfQueuedMessages(ctx: LoopCommandContextLike): boolean {
		if (!ctx.hasPendingMessages()) {
			return false;
		}

		this.stop("Ralph Loop stopped: another message is queued.", "warning");
		return true;
	}

	private async resetActiveContext(ctx: LoopCommandContextLike): Promise<boolean> {
		const resetTargetId = this.resolveResetTargetId(ctx);
		if (!resetTargetId) {
			return false;
		}

		let result: { cancelled: boolean };
		try {
			result = await ctx.navigateTree(resetTargetId, { summarize: false });
		} catch (error) {
			this.stop(`Ralph Loop stopped: context reset failed: ${errorToMessage(error)}`, "error");
			return false;
		}

		if (result.cancelled) {
			this.stop("Ralph Loop stopped: context reset was cancelled.", "warning");
			return false;
		}

		ctx.ui.setEditorText("");
		return true;
	}

	private resolveResetTargetId(ctx: LoopCommandContextLike): string | undefined {
		const entries = ctx.sessionManager.getEntries();
		const resetTarget = this.resetTarget;
		if (!resetTarget) {
			this.stop("Ralph Loop stopped: could not find the loop start checkpoint.", "error");
			return undefined;
		}

		if (resetTarget.kind === "entry") {
			if (entries.some((entry) => entry.id === resetTarget.id)) {
				return resetTarget.id;
			}
			this.stop("Ralph Loop stopped: could not find the loop start checkpoint.", "error");
			return undefined;
		}

		const firstLoopPrompt = entries.find(
			(entry) =>
				!this.entryIdsAtStart.has(entry.id) &&
				isUserEntry(entry) &&
				contentToText(entry.message?.content).trim() === resetTarget.prompt,
		);
		if (!firstLoopPrompt) {
			this.stop("Ralph Loop stopped: could not find the first loop prompt to reset context.", "error");
			return undefined;
		}
		return firstLoopPrompt.id;
	}

	private async startNextIteration(ctx: LoopCommandContextLike): Promise<void> {
		if (!this.state.active) {
			return;
		}

		this.state.iterationsStarted += 1;
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("warning", `Loop ${this.state.iterationsStarted}/${this.state.maxIterations}`),
		);
		this.emitDebug({ event: "iteration_send_start" });
		try {
			await this.sendUserMessage(this.state.prompt);
			this.emitDebug({ event: "iteration_send_succeeded" });
		} catch (error) {
			this.emitDebug({ event: "iteration_send_failed", errorMessage: errorToMessage(error) });
			this.stop(`Ralph Loop stopped: could not start iteration: ${errorToMessage(error)}`, "error");
		}
	}

	private stop(message: string | undefined, type: NotifyType): void {
		const ctx = this.context;
		this.emitDebug({ event: "loop_stop", message, notifyType: type });
		this.state = this.createInactiveState();
		this.continuationScheduled = false;
		this.resetTarget = undefined;
		this.entryIdsAtStart = new Set<string>();
		this.context = undefined;
		if (ctx) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (message) {
				ctx.ui.notify(message, type);
			}
		}
	}

	private createInactiveState(): RalphLoopState {
		return {
			active: false,
			prompt: "",
			iterationsStarted: 0,
			maxIterations: this.maxIterations,
			stopRequested: false,
		};
	}

	private emitDebug(details: Omit<RalphLoopDebugEvent, keyof RalphLoopState | "timestamp">): void {
		if (!this.debugLogger) {
			return;
		}

		try {
			this.debugLogger({
				timestamp: new Date().toISOString(),
				active: this.state.active,
				prompt: this.state.prompt,
				iterationsStarted: this.state.iterationsStarted,
				maxIterations: this.state.maxIterations,
				stopRequested: this.state.stopRequested,
				...details,
			});
		} catch {
			// Diagnostic logging must not affect loop control flow.
		}
	}

	private emitAgentEndDebug(event: LoopAgentEndEventLike | undefined): void {
		const messages = event?.messages ?? [];
		const assistant = [...messages].reverse().find((message) => message.role === "assistant");
		const content = assistant?.content;
		const contentParts = Array.isArray(content) ? content : [];
		this.emitDebug({
			event: "agent_end",
			stopReason: assistant?.stopReason ?? "stop",
			errorMessage: assistant?.errorMessage,
			assistantPreview: contentToText(content).trim().slice(0, 500),
			toolCallCount: contentParts.filter((part) => part.type === "toolCall").length,
			toolResultCount: messages.filter((message) => message.role === "toolResult").length,
		});
	}
}
