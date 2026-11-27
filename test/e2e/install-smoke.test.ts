// Install smoke: the pinned aoe core accepts a `--dev` install of this checkout.
//
// Ran green on macOS arm64 against aoe 1.26.0. The macOS daemon-startup failure
// seen under a throwaway HOME did not reproduce here, but it may be flaky; the
// CI Linux job is the first run on that platform. The plugin is installed from
// a staged copy because the host rejects symlinks (node_modules/.bin).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAoe, makeThrowawayHome, stageSource } from "./aoe";

describe("aoe plugin install --dev", () => {
  let aoe = "";
  let home = "";

  const run = (args: string[]) =>
    spawnSync(aoe, args, {
      cwd: home,
      encoding: "utf8",
      // Throwaway HOME so the real config and daemon are never touched.
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", XDG_DATA_HOME: "", XDG_STATE_HOME: "" },
      timeout: 240_000,
    });

  beforeAll(async () => {
    aoe = await ensureAoe();
    home = makeThrowawayHome();
  });

  afterAll(() => {
    if (aoe && home) {
      // Stop the daemon the install may have started, then drop the HOME.
      run(["serve", "--stop"]);
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it("installs this checkout and lists it", () => {
    // Absolute path: the daemon resolves the source, not this process.
    const install = run(["plugin", "install", "--dev", "--yes", stageSource(home)]);
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);

    const list = run(["plugin", "list"]);
    expect(list.status, `${list.stdout}\n${list.stderr}`).toBe(0);
    expect(list.stdout).toContain("agent-of-empires.claude");
  });
});
