# Ralph Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. User instruction for this task: write files only, do not commit.

**Goal:** Build a project-local Pi extension that repeats a prompt up to 10 total iterations, resetting active context between runs with tree navigation and stopping gracefully when `/loop` is invoked again.

**Architecture:** The repo is a Pi package/extension repo using Pi's conventional `extensions/` resource directory. Root `package.json` declares `pi.extensions: ["./extensions/index.ts"]`. The extension registers `/loop`, stores one controller instance, and reacts to `agent_end` to schedule the next iteration. The controller is testable without Pi by injecting `sendUserMessage` and a scheduler; context reset uses `ctx.navigateTree(rootUserEntryId, { summarize: false })` and clears the editor.

**Tech Stack:** Pi package manifest, Pi extension API, TypeScript with Node 25 type stripping, Node built-in test runner.

---

## File Structure

- Create `extensions/loop-controller.ts`: pure controller with injected Pi-like context, hard cap, stop behavior, and tree reset.
- Create `extensions/index.ts`: Pi extension entrypoint that registers `/loop`, `agent_end`, and `session_shutdown` handlers.
- Create `tests/ralph-loop-controller.test.ts`: Node tests for controller behavior.
- Create `tests/ralph-loop-extension.test.ts`: Node tests for extension registration and event wiring.
- Create `package.json`: Pi package manifest, peer dependency declaration, and test script.

## Tasks

### Task 1: Controller behavior

**Files:**
- Create: `tests/ralph-loop-controller.test.ts`
- Create: `extensions/loop-controller.ts`

- [ ] Step 1: Write failing controller tests covering start, stop request, 10-iteration cap, and root tree reset.
- [ ] Step 2: Run `node --test tests/ralph-loop-controller.test.ts`; expected failure is module not found or missing controller exports.
- [ ] Step 3: Implement `RalphLoopController` with `handleCommand()`, `handleAgentEnd()`, `shutdown()`, and status notifications.
- [ ] Step 4: Run `node --test tests/ralph-loop-controller.test.ts`; expected pass.

### Task 2: Extension wiring

**Files:**
- Create: `tests/ralph-loop-extension.test.ts`
- Create: `extensions/index.ts`

- [ ] Step 1: Write failing extension wiring tests that verify `/loop`, `agent_end`, and `session_shutdown` are registered.
- [ ] Step 2: Run `node --test tests/ralph-loop-extension.test.ts`; expected failure is missing extension module.
- [ ] Step 3: Implement `index.ts` to instantiate the controller and wire Pi APIs.
- [ ] Step 4: Run `node --test tests/ralph-loop-extension.test.ts`; expected pass.

### Task 3: Project test script and full verification

**Files:**
- Create: `package.json`

- [ ] Step 1: Add `npm test` script using Node's built-in test runner and a Pi package manifest with `pi.extensions: ["./extensions/index.ts"]`.
- [ ] Step 2: Run `npm test`; expected all tests pass.
- [ ] Step 3: Run `git status --short`; expected only uncommitted created files, no commits.
