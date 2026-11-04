// Turns the gate (qa-gate.mjs) on or off for the current session. Run it from
// the folder the work is in: the main checkout or a task worktree.
//   node ~/Projects/claude-harness/gate/until-ready.mjs on "the goal, in the owner's words"
//   node ~/Projects/claude-harness/gate/until-ready.mjs off
//   node ~/Projects/claude-harness/gate/until-ready.mjs status

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const sid = process.env.CLAUDE_CODE_SESSION_ID;
if (!sid) {
  console.error("No CLAUDE_CODE_SESSION_ID: run this from a Claude Code session.");
  process.exit(2);
}
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const dir = git("rev-parse", "--show-toplevel");
const main = dirname(resolve(dir, git("rev-parse", "--path-format=absolute", "--git-common-dir")));
const loop = join(main, ".claude", "loop");
const file = join(loop, `${sid}.json`);
const [cmd, ...goal] = process.argv.slice(2);

if (cmd === "on") {
  const configFile = join(dir, ".claude", "gate.json");
  if (!existsSync(configFile)) {
    console.error(`No .claude/gate.json in ${dir}: this project has no gate yet. Draft one as the until-ready skill says ("No gate yet").`);
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  mkdirSync(loop, { recursive: true });
  writeFileSync(file, JSON.stringify({ goal: goal.join(" ") || "(no goal given)", dir, attempts: 0, started: new Date().toISOString() }, null, 2));
  const checks = [...(config.steps || []).map((s) => s.run), ...(config.qa ? [config.qa] : [])];
  console.log(`Gate on for this session, checking ${dir}. You can't stop until these pass:`);
  for (const c of checks) console.log(`  ${c}`);
  if (config.rules?.length) {
    console.log("Project rules:");
    for (const r of config.rules) console.log(`- ${r}`);
  }
} else if (cmd === "off") {
  rmSync(file, { force: true });
  console.log("Gate off for this session.");
} else {
  console.log(existsSync(file) ? readFileSync(file, "utf8") : "Gate off for this session.");
}
