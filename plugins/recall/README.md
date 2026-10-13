# recall

`recall.search` reads the current SQLite FTS5 index of user and assistant text from me entities, Claude Code transcripts, and Codex sessions. The database lives in this plugin's `ME_DATA_DIR`. Transcript indexing starts in the background at plugin startup, then runs every 10 minutes by default. JSONL is streamed line by line; files are selected newest-first and work yields between small batches. The 200 MiB default budget counts redacted message text stored in the index, not source file size. Messages are capped at 20,000 characters. Override `maxIndexBytes`, `maxMessageChars`, `maxResults`, `indexIntervalMinutes`, and `batchSize` under `pluginConfig.recall`.

`recall.status` returns per-source message counts, indexed bytes, files done/total for the latest run, the last run time, and whether indexing is running. Search never starts or waits for indexing.

Project facts are stored as `recall.fact` entities only after an explicit `recall.remember` call. `recall.remember {project, text}` defaults to `source: "user"` and `pinned: false`; callers may explicitly pass `source: "task"` or `pinned: true`. `recall.context {project, text}` returns up to 800 characters of matching pinned and recent facts. No facts are extracted automatically.

Before writing a delegation brief, `gjc-head` asks `recall.context` for project notes and passes up to 800 characters to `summarize`. Missing recall or a failed context call is ignored.
