# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.6] - 2026-02-27

### Added
- Configurable tab size setting for code and diff display
- Codex scanner diagnostics for troubleshooting session discovery

### Fixed
- Fix Windows session discovery
- Fix Gemini session discovery for newer CLI versions
- Fix Codex/Gemini session discovery when ~/.claude/projects is missing

### Changed
- Update Gemini model list for v0.30.0 CLI
- Optimize Gemini session loading with generalized session index
- Extract shared JSONL/BOM utilities to reduce duplication

## [0.4.5] - 2026-02-25

### Added
- Session cloning support for Codex sessions
- Show session creation date in Session Info panel

### Fixed
- Fix Codex sessions failing with 'minimal' reasoning effort
- Fix broken image paths in README

## [0.4.4] - 2026-02-25

### Added
- 3-way thinking toggle: off / auto / on (model decides when to think in auto mode)

### Fixed
- Fix thinking "on" mode for Opus 4.6+ and wait for CLI exit on abort
- Reconnect session stream after thinking-mode process restart
- Fix context usage percentage being too low after compaction
- Fix DAG not bridging across compaction boundaries with broken logicalParentUuid
- Fix source control page issues

## [0.4.3] - 2026-02-23

### Added
- Source Control page with git working tree status
- File diff viewer: click any file to see syntax-highlighted diff with full context toggle and markdown preview
- Session sharing via Cloudflare Worker + R2

### Fixed
- Fix denied subagent showing spinner instead of error state
- Fix remote client redirect loop on git-status page
- Fix DAG selecting stale pre-compaction branch over post-compaction one

## [0.4.2] - 2026-02-22

### Added
- HTTPS self-signed cert support (`--https-self-signed` flag and `HTTPS_SELF_SIGNED` env var)
- Codex shell tool rendering for grep/read workflows

### Fixed
- Fix HTTP LAN access: randomUUID fallback for insecure contexts and non-secure cookie handling
- Lazy-load tssrp6a to fix crash on HTTP LAN access (insecure context)
- Auth disable now clears credentials and simplifies enable flow

### Changed
- File logging and SDK message logging default to off (opt-in)
- Replace `LOG_TO_CONSOLE` with `LOG_PRETTY` for clearer semantics

## [0.4.1] - 2026-02-22

### Added
- Session cache with phased optimizations: cached scanner results, batched stats, cached stats endpoint with invalidation
- Cross-process locking and atomic writes for session index files
- Improved pending tool render and settings copy

### Fixed
- Fix localhost websocket auth policy when remote access is enabled
- Fix send racing ahead of in-flight file uploads

## [0.4.0] - 2026-02-22

### Security
- Harden markdown rendering against XSS
- Harden SSH host handling for remote executors
- Harden auth enable flow and add secure recovery path
- Patch vulnerable dependencies (bn.js)
- Enforce 0600 permissions on sensitive data files
- Add SRP handshake rate limiting and timeout guards
- Harden session resume replay defenses for untrusted relays
- Harden relay replay protection for SRP sessions

### Added
- Tauri 2 desktop app scaffold with setup wizard
- Tauri 2 mobile app scaffold with Android support
- Global agent instructions setting for cross-project context
- Permission rules for session bash command filtering
- Legacy relay protocol compatibility for old servers

### Fixed
- Guard SecureConnection send when WebSocket global is unavailable
- Stop reconnect loop on intentional remote disconnect
- Fix stale reconnect race and reduce reconnect noise
- Fix localhost cookie-auth websocket regression
- Fix WebSocket SRP auth-state coupling and regressions
- Fix server crash when spawning sessions with foreign project paths
- Fix streamed Codex Edit patch augmentation parity
- Fix Linux AppImage builds (patchelf corruption, native deps, signing)

### Changed
- Default remote sessions to memory with dev persistence toggle
- Refactor websocket transport into auth, routing, and handler modules
- Improve server update modal copy and layout
- Remove browser control module

## [0.3.2] - 2025-02-18

### Changed
- Update README with current Codex support status (full diffs, approvals, streaming)

## [0.3.1] - 2025-02-18

### Fixed
- Fix Codex provider labeling (CLI, not Desktop)

## [0.3.0] - 2025-02-18

### Added
- Codex CLI integration with app-server approvals and protocol workflow
- Codex session launch metadata, originator override, and steering improvements
- Focused session-watch subscriptions for session pages
- Server-side highlighted diff HTML for parsed raw patches
- Browser control module for headless browser automation

### Fixed
- Relay navigation dropping machine name from URL
- Codex Bash error inference for exit code output
- Codex persisted apply_patch diff rendering
- Codex session context and stream reliability

### Changed
- Collapse injected session setup prompts in transcript
- Normalize update_plan and write_stdin tool events
- Improve Codex persisted session rendering parity
- Show Codex provider errors in session UI

## [0.2.9] - 2025-02-15

### Fixed
- `--open` flag now opens the Windows browser when running under WSL

## [0.2.8] - 2025-02-15

### Added
- `--open` CLI flag to open the dashboard in the default browser on startup

## [0.2.7] - 2025-02-13

### Fixed
- Fix relay connect URL dropping username query parameter during redirect

## [0.2.6] - 2025-02-09

### Fixed
- Fix page crash on LAN IPs due to eager tssrp6a loading
- Fall back to any project for new sessions; replace postinstall symlink with import rewriting

## [0.2.5] - 2025-02-09

### Fixed
- Windows support: fix project directory detection for Windows drive-letter encoded paths (e.g. `c--Users-kaa-project`)
- Windows support: fix session index path encoding for backslash separators

## [0.2.4] - 2025-02-09

### Fixed
- Windows support: replace Unix `which` with `where` for CLI detection
- Windows support: accept Windows absolute paths (e.g. `C:\Users\...`) in project validation
- Windows support: fix path traversal guard and project directory encoding for backslash paths
- Windows support: use `os.homedir()` instead of `process.env.HOME` for tilde expansion
- Windows support: fix path separator handling in codex/gemini directory resolution
- Windows support: show PowerShell install command instead of curl/bash

## [0.2.2] - 2025-02-03

### Added
- Relay connection status bar
- Website release process with tag-based deployment

### Fixed
- Sibling tool branches in conversation tree

### Changed
- Simplify Claude, Codex, and Gemini auth to CLI detection only
- Update claude-agent-sdk to 0.2.29

## [0.2.1] - 2025-01-31

### Added
- CLI setup commands for headless auth configuration
- Relay `/online/:username` endpoint for status checks
- Multi-host support for remote access
- Switch host button to sidebar
- WebSocket keepalive ping/pong to RelayClientService
- Host offline modal and tool approval click protection
- Error boundary for graceful error handling
- Terminate option to session menu

### Fixed
- Host picker navigation and relay routes session resumption
- Relay login to set currentHostId before connecting
- DAG branch selection to prefer conversation over progress messages
- Session status event field name and auto-retry on dead process
- Sidebar overlay auto-close logic
- SRP auth hanging on unexpected messages
- Relay reconnection error messages for unreachable server
- Mobile reconnection showing stale session status
- Dual sidebar rendering on viewport resize
- Skip API calls on login page to prevent 401 popups
- Various relay host routing and disconnect handling fixes

### Changed
- Update claude-agent-sdk to 0.2.19
- Rename session status to ownership and clarify agent activity

## [0.1.10] - 2025-01-23

### Fixed
- Handle 401 auth errors in SSE connections
- Fix session stream reconnection on mobile wake
- Fix relay reconnection to actually reconnect WebSocket

### Added
- Connection diagnostics and detailed reconnect logging
- Show event stream connection status in session info modal
