import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";

// TRUST_PROXY=1 is what makes secure session cookies and per-visitor rate limits work behind Nginx.
// It must stay off by default so localhost behaviour never changes. Each case runs in its own process
// because the setting is read when the app module loads.
const trustProxySetting = value => new Promise((resolve, reject) => {
  const env = { ...process.env, SESSION_SECRET: "test-only-secret", NODE_ENV: "test" };
  delete env.TRUST_PROXY;
  if (value !== undefined) env.TRUST_PROXY = value;
  execFile(process.execPath, ["--input-type=module", "-e", `const { default: app } = await import("./index.js"); console.log(JSON.stringify(app.get("trust proxy"))); process.exit(0);`],
    { cwd: process.cwd(), env }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim().split(/\r?\n/).at(-1)));
});

test("trust proxy is off unless TRUST_PROXY=1", async () => {
  assert.equal(await trustProxySetting(undefined), "false");
  assert.equal(await trustProxySetting("0"), "false");
  assert.equal(await trustProxySetting("1"), "1");
});
