import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { RalphLoopController } from "./loop-controller.ts";

const MAX_ITERATIONS = 10;

export default function registerRalphLoop(pi: ExtensionAPI): void {
	const controller = new RalphLoopController({
		maxIterations: MAX_ITERATIONS,
		sendUserMessage(prompt) {
			pi.sendUserMessage(prompt);
		},
		schedule(task) {
			void Promise.resolve()
				.then(task)
				.catch((error) => {
					console.error("Ralph Loop continuation failed:", error);
				});
		},
	});

	pi.registerCommand("loop", {
		description: "Repeat a prompt with fresh active context, up to 10 iterations",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await controller.handleCommand(args, ctx);
		},
	});

	pi.on("agent_end", () => {
		controller.handleAgentEnd();
	});

	pi.on("session_shutdown", () => {
		controller.shutdown();
	});
}
