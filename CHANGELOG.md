# Changelog

## v.0.1.0

### Added
- Added `/loop-settings` for changing the maximum Ralph Loop iteration count.
- Added public release metadata, README documentation, MIT license, and npm package file allowlist.
- Added tracked lint/typecheck configuration and package lock support for reproducible development verification.
- Added hidden `ralph-loop-checkpoint` session entries so loops can reset to an exact pre-loop checkpoint.
- Added tests covering checkpoint creation and empty-session loop resets.
- Added release metadata tests and a `prepack` verification hook so package packing/publishing runs test, lint, and typecheck first.

### Changed
- Colored the active loop status text with Pi's warning color.
- Updated package keywords and description to match the Ralph Loop extension.
- Simplified loop continuation guard logic and reused the controller's shared default iteration cap in extension wiring.
- Documented public-package safety notes for automatic prompt replay.

### Fixed
- Fixed Escape handling during active loops so standard and Kitty-protocol Escape input aborts the agent and stops Ralph Loop immediately.
- Fixed stale command context retention after refused or stopped loops so later shutdowns do not update an old UI context.
- Fixed queued-message race handling so Ralph Loop stops before waiting for idle when another message is already queued.
- Fixed a post-reset race so queued messages or stop requests that arrive during context reset prevent the next iteration from being sent.
- Fixed empty-session loops so subsequent iterations reset before the first prompt instead of failing to find a reset target or retaining the first prompt in active context.
- Fixed unexpected session tree reset failures so Ralph Loop stops cleanly, clears its status, and notifies the user instead of leaving an active loop stuck.
- Fixed unexpected idle-wait and prompt-send failures so Ralph Loop clears its status and reports the error instead of leaving a stale active loop.
- Fixed non-stringifiable thrown values in loop startup/continuation failures so error handling still clears loop state and reports a safe fallback message.
- Fixed idle stop requests so `/loop` stops immediately with a single notification instead of first reporting a pending graceful stop.
- Fixed stop requests and completed iteration caps so they finish cleanly without performing an unnecessary idle wait before stopping.
