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

export type LoopCommandContextLike = {
	isIdle(): boolean;
	waitForIdle(): Promise<void>;
	sessionManager: {
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

function isRootUserEntry(entry: LoopEntry): boolean {
	return entry.type === "message" && entry.parentId === null && entry.message?.role === "user";
}

function findRootUserEntry(entries: LoopEntry[]): LoopEntry | undefined {
	return entries.find(isRootUserEntry);
}

export class RalphLoopController {
	private readonly maxIterations: number;
	private readonly sendUserMessage: (prompt: string) => void;
	private readonly schedule: (task: () => Promise<void> | void) => void;
	private context: LoopCommandContextLike | undefined;
	private continuationScheduled = false;
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
		const rootUserEntry = findRootUserEntry(ctx.sessionManager.getEntries());
		if (!rootUserEntry) {
			this.stop("Ralph Loop stopped: could not find a root user message to reset context.", "error");
			return false;
		}

		const result = await ctx.navigateTree(rootUserEntry.id, { summarize: false });
		if (result.cancelled) {
			this.stop("Ralph Loop stopped: context reset was cancelled.", "warning");
			return false;
		}

		ctx.ui.setEditorText("");
		return true;
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
