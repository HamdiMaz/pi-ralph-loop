export const DEFAULT_MAX_ITERATIONS = 10;
export const STATUS_KEY = "ralph-loop";

type NotifyType = "info" | "warning" | "error";

type LoopEntry = {
	type: string;
	id: string;
	parentId: string | null;
	message?: {
		role?: string;
		content?: string | Array<{ type: string; text?: string }>;
	};
};

type ResetTarget =
	| { kind: "entry"; id: string }
	| { kind: "firstLoopPrompt"; prompt: string };

export type LoopCommandContextLike = {
	isIdle(): boolean;
	waitForIdle(): Promise<void>;
	sessionManager: {
		getLeafId(): string | null;
		getEntries(): LoopEntry[];
	};
	navigateTree(targetId: string, options: { summarize: boolean }): Promise<{ cancelled: boolean }>;
	ui: {
		notify(message: string, type?: NotifyType): void;
		setStatus(key: string, text: string | undefined): void;
		setEditorText(text: string): void;
	};
};

export type RalphLoopControllerOptions = {
	maxIterations?: number;
	sendUserMessage(prompt: string): void;
	schedule(task: () => Promise<void> | void): void;
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

export class RalphLoopController {
	private readonly maxIterations: number;
	private readonly sendUserMessage: (prompt: string) => void;
	private readonly schedule: (task: () => Promise<void> | void) => void;
	private context: LoopCommandContextLike | undefined;
	private continuationScheduled = false;
	private resetTarget: ResetTarget | undefined;
	private entryIdsAtStart = new Set<string>();
	private state: RalphLoopState;

	constructor(options: RalphLoopControllerOptions) {
		this.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		this.sendUserMessage = options.sendUserMessage;
		this.schedule = options.schedule;
		this.state = this.createInactiveState();
	}

	getState(): RalphLoopState {
		return { ...this.state };
	}

	async handleCommand(args: string, ctx: LoopCommandContextLike): Promise<void> {
		this.context = ctx;

		if (this.state.active) {
			this.state.stopRequested = true;
			ctx.ui.notify("Ralph Loop will stop after the current run finishes.", "info");
			if (ctx.isIdle() && !this.continuationScheduled) {
				this.stop("Ralph Loop stopped.", "info");
			}
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

		const entriesAtStart = ctx.sessionManager.getEntries();
		this.entryIdsAtStart = new Set(entriesAtStart.map((entry) => entry.id));
		const startLeafId = ctx.sessionManager.getLeafId();
		this.resetTarget = startLeafId ? { kind: "entry", id: startLeafId } : { kind: "firstLoopPrompt", prompt };

		this.state = {
			active: true,
			prompt,
			iterationsStarted: 0,
			maxIterations: this.maxIterations,
			stopRequested: false,
		};
		this.startNextIteration(ctx);
	}

	handleAgentEnd(): void {
		if (!this.state.active || this.continuationScheduled) {
			return;
		}

		this.continuationScheduled = true;
		this.schedule(async () => {
			this.continuationScheduled = false;
			await this.continueAfterAgentEnd();
		});
	}

	shutdown(): void {
		this.stop(undefined, "info");
		this.context = undefined;
	}

	private async continueAfterAgentEnd(): Promise<void> {
		const ctx = this.context;
		if (!this.state.active || !ctx) {
			return;
		}

		await ctx.waitForIdle();

		if (this.state.stopRequested) {
			this.stop("Ralph Loop stopped.", "info");
			return;
		}

		if (this.state.iterationsStarted >= this.maxIterations) {
			this.stop(`Ralph Loop reached the ${this.maxIterations}-iteration cap.`, "info");
			return;
		}

		const resetSucceeded = await this.resetActiveContext(ctx);
		if (!resetSucceeded) {
			return;
		}

		this.startNextIteration(ctx);
	}

	private async resetActiveContext(ctx: LoopCommandContextLike): Promise<boolean> {
		const resetTargetId = this.resolveResetTargetId(ctx);
		if (!resetTargetId) {
			return false;
		}

		const result = await ctx.navigateTree(resetTargetId, { summarize: false });
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

	private startNextIteration(ctx: LoopCommandContextLike): void {
		if (!this.state.active) {
			return;
		}

		this.state.iterationsStarted += 1;
		ctx.ui.setStatus(STATUS_KEY, `Loop ${this.state.iterationsStarted}/${this.maxIterations}`);
		this.sendUserMessage(this.state.prompt);
	}

	private stop(message: string | undefined, type: NotifyType): void {
		const ctx = this.context;
		this.state = this.createInactiveState();
		this.continuationScheduled = false;
		this.resetTarget = undefined;
		this.entryIdsAtStart = new Set<string>();
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
}
