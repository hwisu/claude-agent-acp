# ACP adapter for the Claude Agent SDK (hwisu fork)

[![npm](https://img.shields.io/npm/v/%40hwisu%2Fclaude-agent-acp)](https://www.npmjs.com/package/@hwisu/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) from [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev) and [Toad](https://github.com/batrachianai/toad).

> Fork of [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) (Apache-2.0, © Zed Industries). This fork follows upstream for the bulk of the protocol surface and layers on first-class **ACP terminal-capability routing** plus a deterministic versioning scheme tied to the underlying Claude Agent SDK.

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- **ACP terminal capability** — when the client advertises `clientCapabilities.terminal: true`, shell commands are routed through `terminal/create` / `terminal/output` / `terminal/wait_for_exit` / `terminal/release` instead of running locally inside the agent process. The client owns the PTY and renders the live terminal natively.
- **Background terminals** — model can set `run_in_background=true`, then poll with `mcp__acp_terminal__output` and stop with `mcp__acp_terminal__kill`.
- Custom [slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers
- Codex-acp `_meta.terminal_output` extension (kept as a fallback for clients that don't yet implement ACP `terminal/*`)

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## Design principles

These are the non-obvious rules this fork tries to hold:

1. **Spec first, `_meta` second.** When the ACP spec defines a capability natively (`terminal/*`, `fs/*`, request permission), prefer the native path. Fall back to `_meta` extensions only when the client lacks the official capability — never instead of it. The terminal routing is gated on `clientCapabilities.terminal === true`; clients that don't advertise it keep the existing SDK-internal Bash flow plus the optional `_meta.terminal_output` codex-acp extension.
2. **Don't fight the SDK; route around it.** The Claude Agent SDK's built-in `Bash` tool isn't pluggable (no PreToolUse-substitute, no canUseTool result injection). Rather than monkey-patching, we `disallowedTools: ["Bash", "BashOutput"]` and register a thin SDK MCP server (`acp_terminal`) whose `bash` / `output` / `kill` tools delegate to ACP `terminal/*`. The model only ever sees one shell-execution tool.
3. **Lossless exit info.** The MCP `CallToolResult` shape has no structured `exit_code` field, so the handler appends a parseable `<<<acp-terminal-meta exit_code=N signal=S timed_out=B>>>` trailer. `toolUpdateFromToolResult` parses and strips it, then emits structured numeric exit info via `_meta.terminal_exit` so clients don't have to regex the text. ACP-capable clients can also (independently) read it from `terminal/wait_for_exit`.
4. **Embed the terminal in the tool card.** When the MCP handler creates a terminal, it correlates the freshly-created `terminalId` with the in-flight tool call (via a per-session FIFO of approved `toolUseID`s populated by `canUseTool`) and emits a `tool_call_update` with `[{type:"terminal", terminalId}]`. The chat tool card embeds the live terminal; the client's terminal panel renders the same PTY. Single source of truth, two surfaces.
5. **Stay close to upstream.** Where this fork adds behaviour, it does so via additive code paths gated on capability flags. Files touched: `src/acp-agent.ts`, `src/tools.ts`. Existing call sites and tests are not refactored.
6. **Versions ride with the SDK.** This package's `version` is the resolved `@anthropic-ai/claude-agent-sdk` version, with an optional `-N` prerelease suffix for fork-only patches between SDK releases (see [Versioning](#versioning)).

## Versioning

This fork's version mirrors the underlying `@anthropic-ai/claude-agent-sdk` version. Knowing the package version tells you exactly which SDK is bundled.

| package version | meaning                                                 |
| --------------- | ------------------------------------------------------- |
| `0.2.132`       | wraps Claude Agent SDK `0.2.132`, no fork-only patches  |
| `0.2.132-1`     | wraps SDK `0.2.132`, first fork-only patch on top of it |
| `0.2.132-2`     | wraps SDK `0.2.132`, second fork-only patch             |
| `0.2.133`       | wraps SDK `0.2.133` (suffix resets on every SDK bump)   |

Two helper scripts enforce this:

```bash
aube install                          # install/refresh the SDK at its pinned version
aube run sync-sdk-version             # set package.version := SDK base (e.g. 0.2.132)
aube run sync-sdk-version -- --bump   # bump the -N suffix for a fork-only patch
aube run sync-sdk-version -- --check  # CI guard: fail if version drifts from SDK
```

`prepublishOnly` runs `sync-sdk-version` automatically before each publish.

## ACP terminal capability flow

```
            ┌─────────────┐                       ┌─────────────┐
  user ──►  │  ACP client │ ◄─────terminal/*───►  │   agent     │
            │  (Zed/Toad) │                       │   (this)    │
            └─────────────┘                       └─────────────┘
                  ▲                                      │
                  │  live PTY                            │  shell command
                  │  (rendered                           │  via SDK MCP tool
                  │   client-side)                       │  `acp_terminal/bash`
                  ▼                                      ▼
            ┌─────────────┐                       ┌─────────────┐
            │   terminal  │◄──────────────────────│  handler    │
            │   panel +   │   wait_for_exit()     │             │
            │   tool card │   currentOutput()     │             │
            └─────────────┘   release()           └─────────────┘
```

The agent never `exec`s the command itself. The client does. The agent waits for completion and surfaces the captured output (plus a structured `_meta.terminal_exit` trailer) to the model.

## Installation

```bash
aube install -g @hwisu/claude-agent-acp
claude-agent-acp
```

Or as a dev dependency:

```bash
aube add @hwisu/claude-agent-acp
```

The package is published as a regular npm tarball, so `npm install -g @hwisu/claude-agent-acp` / `pnpm add` / `yarn add` all work too — but **this repository itself uses [aube](https://aube.en.dev) as its package manager** (see `aube-lock.yaml` and the `packageManager` field). To work on the fork:

```bash
brew install endevco/tap/aube      # or: mise use -g aube
aube ci                            # frozen-lockfile install
aube run check && aube run build   # lint+format check, then tsc
aube run test:run                  # vitest --run
```

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).

## Credits

Forked from [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp). The original adapter and its protocol plumbing are © Zed Industries, released under Apache-2.0. All upstream commits are preserved; the fork's additions are additive and gated on client capability flags.
