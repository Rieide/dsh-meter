// Plain-JS build: copy src/*.js into lib/*.js (no bundler/TypeScript step needed).
import { cp, mkdir } from "node:fs/promises";

const files = ["index.js", "client.js"];
await mkdir("lib", { recursive: true });
for (const f of files) {
  await cp(`src/${f}`, `lib/${f}`);
  console.log(`lib/${f} <- src/${f}`);
}
console.log("build done");
