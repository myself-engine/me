# recall

`recall.search` indexes user and assistant text from me entities, Claude Code transcripts, and Codex sessions. The SQLite FTS5 database lives in this plugin's `ME_DATA_DIR`. Indexing is read-only; text is redacted before storage. Defaults cap source files at 200 MiB total and messages at 20,000 characters. Override `maxIndexBytes`, `maxMessageChars`, and `maxResults` under `pluginConfig.recall`.

Project facts are stored as `recall.fact` entities only after an explicit `recall.remember` call. `recall.remember {project, text}` defaults to `source: "user"` and `pinned: false`; callers may explicitly pass `source: "task"` or `pinned: true`. `recall.context {project, text}` returns up to 800 characters of matching pinned and recent facts. No facts are extracted automatically.

## Later head integration

A follow-up can have `gjc-head` call `plugin.invoke("recall", "recall.context", { project, text })` before summarizing a delegation, then pass the returned `text` as an optional context field in the summarize request. This plugin deliberately does not modify `gjc-head` or `summarize`.
