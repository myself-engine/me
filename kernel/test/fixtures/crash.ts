// Initializes successfully, then crashes shortly after.
import { definePlugin } from "@me/sdk";

setTimeout(() => process.exit(1), 30);
await definePlugin({}).run();
