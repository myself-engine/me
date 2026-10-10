import { definePlugin } from "@me/sdk";

await definePlugin({
  methods: { echo: (p) => ({ said: p.text, pid: process.pid }) },
}).run();
