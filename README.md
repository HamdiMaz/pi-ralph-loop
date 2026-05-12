# Ralph Loop

Ralph Loop is a [Pi](https://pi.dev) extension that repeats a prompt from a clean session checkpoint. It is useful when you want several independent attempts at the same task without carrying forward each previous attempt's active branch context.

## Features

- Adds a `/loop <prompt>` command.
- Runs up to 10 total iterations per loop.
- Creates a hidden session checkpoint before the first iteration.
- After each agent run, navigates back to that checkpoint with `summarize: false`, clears the editor, and sends the prompt again.
- Calling `/loop` while a loop is active requests a graceful stop after the current run finishes.
- Refuses to start, or stops before the next reset/iteration, if Pi has queued messages that would otherwise race the loop.
- Stops automatically on session shutdown.

## Install

After publication:

```bash
pi install npm:ralph-loop
```

For local development from this checkout:

```bash
pi -e ./extensions/index.ts
```

Or create `.pi/settings.json` in this checkout for project-local loading:

```json
{
  "packages": [".."]
}
```

## Usage

```text
/loop Improve the current implementation and run tests
```

To stop an active loop, run `/loop` again. The extension will finish the current agent run, clear the Ralph Loop status, and stop without queuing another prompt.

## Behavior notes

- The 10-iteration cap is intentional to prevent accidental infinite loops.
- Each loop stores a `ralph-loop-checkpoint` custom session entry. Custom entries do not participate in LLM context, but they give the extension an exact tree navigation target.
- Ralph Loop uses Pi session tree navigation, so previous attempts remain available in session history even though the active context is reset between iterations.
- If checkpoint creation, scheduling, idle waiting, prompt sending, or context reset fails, Ralph Loop clears its status and reports the failure instead of leaving a stale active loop.

## Development

```bash
npm test
npm run lint
npm run typecheck
```
