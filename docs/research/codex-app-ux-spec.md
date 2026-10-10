# Autoresearch spec: Codex app UX as a reference for me's web UI

autoresearch-mode: mixed

## Goal
Study how OpenAI's Codex app (now inside the ChatGPT desktop app at /Applications/ChatGPT.app, plus the Codex web app and official docs/changelogs/screenshots) designs the same jobs me's web UI does, and turn that into concrete, adoptable recommendations for me's approved preset "대화에서 끝내기" (docs/design/ux-easier-preset.md).

Jobs to compare:
1. starting work from a message (composer, project/repo selection, new thread)
2. a running agent task: progress, phases, live output, elapsed time
3. approvals / permission prompts before an agent acts
4. reviewing results: diff summary, per-file diff, apply / commit / create PR, reject, follow-up
5. task list / inbox: what needs me, running, done; badges
6. environment / status surfaces
7. vocabulary and microcopy (exact labels), empty states, mobile/phone behaviour

## Inputs
- me today: docs/design/ux-easier-discovery.md, ux-easier-preset.md (final, user-approved), ux-easier-preview-390.png, plugins/web/ui/*.tsx, AGENTS.md design rules
- Codex: official OpenAI docs and changelogs, OpenAI blog posts, public screenshots/videos, the installed app bundle (read-only: Info.plist, localized strings, bundled web assets if readable). Cite every claim with a URL or a file path.

## Constraints
- Read-only. The only files you may write are docs/research/codex-app-ux.md and your scratch notes under .gjc/.
- Never touch the running me (127.0.0.1:7420, ~/.me), never kill processes, never commit or push.
- Do not log in to anything or use the user's ChatGPT account/session; public sources and on-disk resources only.
- Do not copy proprietary assets (icons, images, code) into the repo; describe patterns in words.
- Keep me's visual system (tokens, dot + text label, color only for state, Korean UI). Recommend patterns, not a visual clone.

## Deliverable
docs/research/codex-app-ux.md, in Korean:
- per job (1-7): what Codex does (with sources) → what me's preset already matches → concrete recommended change for me (screen, component, label), each tagged adopt / adapt / skip with a reason
- a vocabulary table: Codex label → me label recommendation
- top 5 changes ranked by value for a single developer using me on a phone and a Mac
- things you could not verify
Finish when the deliverable is complete and every recommendation has a source; record a verdict receipt.
