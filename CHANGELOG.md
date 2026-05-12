# Changelog

## v.0.1.0

### Added
- Added public release metadata, README documentation, MIT license, and npm package file allowlist.
- Added tracked lint/typecheck configuration and package lock support for reproducible development verification.
- Added hidden `ralph-loop-checkpoint` session entries so loops can reset to an exact pre-loop checkpoint.
- Added tests covering checkpoint creation and empty-session loop resets.

### Changed
- Updated package keywords and description to match the Ralph Loop extension.

### Fixed
- Fixed empty-session loops so subsequent iterations reset before the first prompt instead of failing to find a reset target or retaining the first prompt in active context.
- Fixed unexpected session tree reset failures so Ralph Loop stops cleanly, clears its status, and notifies the user instead of leaving an active loop stuck.
- Fixed unexpected idle-wait and prompt-send failures so Ralph Loop clears its status and reports the error instead of leaving a stale active loop.
