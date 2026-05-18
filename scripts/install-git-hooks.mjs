import { execSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const hookScript = join(root, "scripts", "pre-commit-security.sh");
const gitHook = join(root, ".githooks", "pre-commit");

for (const p of [hookScript, gitHook]) {
  if (existsSync(p)) chmodSync(p, 0o755);
}

execSync("git config core.hooksPath .githooks", { cwd: root, stdio: "inherit" });
console.log("Git hooks installed: core.hooksPath=.githooks");
