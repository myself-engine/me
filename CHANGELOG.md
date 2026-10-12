# CHANGELOG

## v0.9.3 (2026-10-12)

- config: run the head, summarize, and jev on OMP; fall back to GJC deepseek-v4.1-flash (249a247)
- head runner: choose GJC or OMP for the conversation head, summarize, and jev; harness-aware fallbacks (95af84e)

## v0.9.2 (2026-10-12)

- gjc-head: fall back to opencode-go/deepseek-v4.1-flash (9893139)

## v0.9.1 (2026-10-12)

- me release: patch bump by default, --minor to opt in (b42e80b)
- brgr trust: skip paths Codex already defines, never write unparseable TOML, keep file mode (947df52)
- brgr: Codex trust for worker worktrees, .worktreeinclude snapshots, setup line, and task revert (a00976e)
- schedule plugin: timed runs into their own conversation, with messenger notify delivery (4856c54)
- web: phone push notifications for approvals, task results, failures, and down checks (3a1a3a8)
- gjc-head: fall back to configured models on quota, auth, availability, or provider failures (1cd7ba3)

## v0.9.0 (2026-10-12)

- brgr verify: read worktree and base commit from the real status shape (e956700)
- brgr verify: run in the task worktree when present, install deps from the lockfile, env allowlist (23b18e1)
- brgr: verify gate before accept, per-project queue with global cap, budget check before start (4ba49e9)
- child env allowlist and secret redaction for journal, issue export, and messengers (38ef882)
- budget plugin: daily delegation caps and meter quota floors before each delegation (82bb517)

## v0.8.0 (2026-10-12)

- web: explain access modes inline; failed replies read 실패 with the fix; glued bold renders; sidebar shows a reply preview and clock times (f9c1aaf)
- web: settings closes back to the conversation; device checks in plain words; model pick is per conversation; plain labels in settings (9404d7a)

## v0.7.0 (2026-10-12)

- web: one sidebar and the conversation; settings in one modal; approvals in the composer slot; developer view (ef35436)
- access modes per conversation: read-only, project write (no approval to start), full (auto-apply) (8f92ba8)
- docs: DeepSeek Harness UX and structure reference (dddb228)

## v0.6.0 (2026-10-12)

- web: keep typed secrets out of the call journal; fix a CSS block that swallowed later rules (1cef5fa)
- harness settings screen: manage MCP servers per harness with preview and approval (36ac646)
- web: folder suggestions open the folder; typed ~ paths are stored expanded (f558597)
- web: pick projects from discovered repositories instead of typing paths (79a1793)

## v0.5.0 (2026-10-12)

- web: say what is blocked and how to fix it; add projects from the screen (a2a31fe)
- web: fewer choices by default — folded worker options, compact head chip, ★ favourites (773ba7e)
- cli: `me` alone starts me and opens it; `me help` lists everything (c18a80e)

## v0.4.1 (2026-10-12)

- ops: a failing command check shows all its output lines (b307be3)

## v0.4.0 (2026-10-12)

- config: write ${env:X} back as OpenCode's {env:X} instead of resolving it (#18) (857fc0f)
- config: import keeps plain values and moves secrets to 0600 files (#8) (8f9be00)
- Slack plugin, http/ACP bridges, skills/hooks config, ops actions (#13 #14 #15 #16) (0bd4f1a)
- marketplace: CodeAgora and connect-my-world recipes (#17) (496a111)
- web: result-first task detail, repo chips, a composer on the phone list (77e3430)
- autostart: start me in a Herdr pane at login (#10) (e98b1a2)
- cli: me release prints usage for --help and unknown flags (7e6d367)

## v0.3.0 (2026-10-12)

- web: three tabs (대화·작업·상태), one badge, user-words titles (7f5de8c)
- web: check the head picker in shots and a11y; fix dialog role (65bba7f)
- chat: pick the head's model and effort, and the worker's at approval (9ffca01)
- web: finish delegations inside the thread (exemplar) (5f97e2d)

## v0.2.0 (2026-10-10)

- ui: highlight.js core, contrast tokens, keyboard and focus, tablet and touch layout (#5, #6, #7) (1614992)
- perf: skip unchanged entity writes, coalesce stream deltas in the journal, journal retention (#3, #4) (cb100cc)

## v0.1.0 (2026-10-10)

- chore: agent rules, definition of done, e2e/shots/a11y checks, me release (#2) (54f4031)
- Record op state, streaming and the UI restructure (79d897a)
- Restructure the web UI after Orca: rail/tabs, tasks, review, timeline (e6247e7)
- Turn off reasoning for the head's direct replies (43fd621)
- Start the head's GJC before judging so replies stream sooner (917ba14)
- Report standard phases from the head (1d15b44)
- Track op state, phases, plugin health and traces in the kernel (a7ecf49)
- Record the server systemd setup (cbdb50e)
- Judge with Jev first; summarize only when delegating (b64817d)
- Use the real Jev decisions endpoint for simplicity judgements (fa0d5d0)
- Record the real-server connect test (9454ba6)
- Wrap ops card headers by item on narrow screens (24ad531)
- Collapse healthy ops checks into chips, keep problems as cards (b355e30)
- Support one ops instance per machine and me connect --id (3f37d0a)
- Make the head introduce itself as me (209d086)
- Apply Fable's visual review to the web UI (f80c002)
- Delay the first ops run and align the tailscale https port (1ab18f8)
- Keep the Discord plugin idle instead of crashing without setup (cbcd696)
- Add Discord window plugin on the messenger core (c57833d)
- Add harness-config: one source for MCP servers across harnesses (c5584eb)
- Add TCP connect-in for remote servers and me connect (9ce734c)
- Add read-only ops plugin and an overview status section (cf8656f)
- Add phone access over Tailscale serve with identity checks (73e931b)
- Add meter and ap marketplace recipes (58bc298)
- Complete me adapt: marketplace recipes, agent-written adapters, export (9a1a445)
- Add approval risk tiers: approval-policy plugin and work roles (3439f35)
- Add messenger reliability core (1c90044)
- Record wave-2 results (36be4a6)
- Add exec mode B: plugins that connect in over a Unix socket (0db1fb6)
- Add generic CLI bridge and me adapt cli (70596ce)
- Reject missing task ids in the brgr plugin (3b48ca5)
- Add me doctor and harden me adapt mcp (399aa53)
- Record wave-1 results and operational issues (0b5925b)
- Add JSON Schema protocol source and a cross-language conformance suite (4d409bd)
- Keep dirty-tree accepts retryable; show applied state and commit (5d95a76)
- Restructure brgr plugin as hexagonal; accept applies and commits (91e734d)
- Restructure gjc-head as hexagonal; add fast path, harness amend, criterion (e888fdb)
- Add MCP bridge and me adapt v0 (579362c)
- Let approvals carry amendments from the decider (90b3b2e)
- Update decisions: identity, rename to me, adapt stages, next order (1c1d53d)
- Make the me CLI a module so it typechecks (9f2e7bf)
- Rename myself-engine to me (cb2c17c)
- Record all design decisions to date (a769b2f)
- Label plugin states separately and document how to run (c987b31)
- Add localhost web plugin and run config (70f0606)
- Add brgr plugin for sealed-result delegation (37031d8)
- Add head pipeline: slang, summarize, jev, gjc-head (ac7c1da)
- Implement kernel core and plugin SDK (34bcfd3)
- Add plugin protocol v1 draft (9849312)
- Verify GJC headless modes for the head plugin (7e62218)
- Add initial design document (27005d8)
