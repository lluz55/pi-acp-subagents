# ACP subagents for pi

Installed as a global pi extension. Run `/reload`, then `/acp list` or ask pi to delegate a task using `acp_subagent`. The usage skill is [acp-subagents](../../skills/acp-subagents/SKILL.md).

```text
/acp run codex Revise src/auth.ts sem editar e relate bugs com evidências
/acp run codex --timeout 1200 Execute suite completa de testes
/acp status
/acp timeout <id> [+300|600]
/acp extend <id> [segundos]
/acp cancel all
```

The model can use `acp_agents` to discover configured agents, then call:

```json
{"tasks":[{"agent":"mcode","task":"Explain the architecture of src/ without editing files.","timeoutSeconds":300}]}
```

Always use `tasks: [{agent, task, cwd?, timeoutSeconds?}, ...]`, even for one agent; up to four independent assignments run in parallel. Top-level `agent`, `task` and `cwd` are rejected before launching processes. This replaces the legacy single-agent shape; run `/reload` or start a new session after updating so the model receives the new schema. Panel streams live progress; tool returns IDs immediately, not final results. Expand tool results for plans and tool output. The complete stream is saved in `~/.pi/agent/acp-runs/<id>.jsonl`; bounded previews point to that file.

## Configuration

`~/.pi/agent/acp-agents.json` defines agents and optional harness overrides. Changes are read on the next call. [config.example.json](config.example.json) shows specialized agents for all four harnesses. `instructions` are prepended to the assignment, while `model`, `mode` and `config` select options advertised by the ACP server. Unsupported selections fail explicitly. Each run creates a fresh session.

Default commands: bundled local `codex-acp`, bundled local `claude-agent-acp`, `opencode acp`, `mcode acp`. Install the adapters with `npm ci` in this directory; native CLIs must be available on pi's PATH. Authentication belongs to each harness. The adapters use their compatible bundled Codex/Claude SDK; `CODEX_PATH` can override Codex. The [Codex adapter](https://github.com/agentclientprotocol/codex-acp), [Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp), [OpenCode ACP documentation](https://opencode.ai/docs/acp/) and installed `mcode acp --help` describe these entrypoints.

Environment overrides: `PI_CODING_AGENT_DIR`, `PI_ACP_CONFIG`, `PI_ACP_RUNS_DIR`. No project-local executable configuration is automatically loaded. No parent conversation is implicitly forwarded.

Permissions default to `ask` and use pi's selector; without UI, requests are refused. Explicit per-agent `deny` or `allow` policies answer ACP requests automatically. The harness owns its execution sandbox and may perform actions without asking the client. Default timeout is 600 seconds, configurable per agent. Cancellation, timeout, session switch and shutdown terminate the run's process group after cooperative ACP cancellation. Command and tool launches notify Pi and trigger follow-up turns.

Context/cost is displayed only when emitted as ACP `usage_update`. These counters are not invented, converted into billed token totals, or added to pi's main model usage. Full logs can contain task data, source, tool output and stderr. Files use mode 0600; logs persist until explicitly removed.

## Validation

```bash
npm test
PI_TEST_HOST_DIR=/path/to/@earendil-works/pi-coding-agent npm test
node tests/handshake.mjs
```

The first command exercises the protocol with local fixtures. Set `PI_TEST_HOST_DIR` to include real pi loader, UI rendering and lifecycle tests; set `PI_TEST_BINARY=pi` to also verify installed extension/skill discovery. `handshake.mjs` opens sessions on installed harnesses without prompting a model. The opt-in `node tests/live.mjs [codex opencode claude mcode]` sends a small real model prompt; it is excluded from the test suite. OpenCode live tests select `opencode/deepseek-v4.1-flash-free`; this does not change runtime defaults. `PI_ACP_SMOKE_MODELS` optionally overrides test models with a JSON object. Tests that exercise pipes/process groups require an environment that permits subprocess IPC.

The client implements [ACP v1 newline-delimited JSON-RPC](https://agentclientprotocol.com/protocol/v1/transports), initialization, session creation/configuration, streamed session updates, permission responses and cancellation. File/terminal client capabilities are deliberately not advertised: harnesses execute those operations themselves.

## Background control and defaults
Tool returns IDs immediately; original tool signal no longer owns detached work. Completion, errors, cancellation, timeout, permission requests and timeout warnings send messages with `triggerTurn: true`, `deliverAs: followUp`. Do not poll. Session shutdown cancels runs and suppresses old-session messages.

Pi can inspect with `acp_control({"action":"status","id":"<id-prefix>"})`, check for loops with `acp_control({"action":"check_loop","id":"<id-prefix>"})`, extend timeout with `acp_control({"action":"extend_timeout","id":"<id-prefix>","seconds":300})`, or stop with `acp_control({"action":"cancel","id":"<id-prefix-or-all>"})`. Before timing out, subagents emit a `timeout_warning` notification waking the parent model with automatic loop analysis. If the child is not stuck in a loop, the parent model extends the timeout so execution proceeds uninterrupted. User can use `/acp cancel <id|all>`, `/acp timeout <id> [+seg|seg]`, or `/acp extend <id> [seg]`.

`/acp model <agent>` shows default. `/acp model <agent> <model-id>` persists default atomically, preserving other settings; `/acp model <agent> --clear` restores harness default. Active runs unchanged. Model availability validated via ACP when run starts, not when saved.

Structured response requests currently mean ACP permissions, handled by existing user selector. Ordinary text questions arrive in output at completion: no heuristic detection, pause or reply channel to closed sessions. Headless requests remain denied. Control tool cannot grant permissions.

`tests/background.test.mjs` uses real ACP fixture subprocesses with substituted Pi UI/schema; requires existing jiti via `PI_TEST_JITI` or installed Pi packages. It does not prove live provider integration. Optional real-loader test remains separate.

## Structured interface

Live panel uses themed cards with status, ID, model, task, elapsed time and measured ACP stages (prepare, connect, session, configure, execute). Permission requests, retries and failures remain visible even with details collapsed. Plans are harness-reported, not invented progress percentages. Active runs have priority; panel shows up to four cards.

- `/acp panel`: cycle compact, expanded, hidden.
- `/acp panel compact|expanded|hidden`: set panel mode explicitly.
- `/acp toggle stages|plan|tools|output|diagnostics`: toggle one section; applies to panel cards. From expanded mode, collapses only selected section.
- `/acp status`: structured session summary in conversation.
- `/acp show <id>`: structured snapshot for one run, without waking model.
- Use Pi's native expand/collapse action on ACP tool results and notifications to reveal stages, plans, tools, output and diagnostics.

Preferences are session-local. Hiding panel never stops processes or suppresses notifications. Live details are bounded to avoid flooding editor; expanded conversation snapshots also have limits and point to full log. New completion messages contain agent output, errors and log path, not duplicated tool payloads. Older snapshots without stage data still render. No new permissions or provider calls are introduced.
