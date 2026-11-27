import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

export function pinnedVersion(): string {
  const text = fs.readFileSync(path.join(repoRoot, "tests/aoe-pin.toml"), "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) throw new Error("tests/aoe-pin.toml has no version");
  return match[1];
}

function assetName(): string {
  const osName = { darwin: "darwin", linux: "linux" }[process.platform as string];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch as string];
  if (!osName || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `aoe-${osName}-${arch}`;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Download, verify and extract the pinned aoe release. Returns the binary path. */
export async function ensureAoe(): Promise<string> {
  const version = pinnedVersion();
  const name = assetName();
  const cacheDir = path.join(os.tmpdir(), "aoe-parity-cache", version, name);
  const bin = path.join(cacheDir, "aoe");
  if (fs.existsSync(bin)) return bin;

  const base = `https://github.com/agent-of-empires/agent-of-empires/releases/download/v${version}/${name}.tar.gz`;
  const [tarball, sumFile] = await Promise.all([download(base), download(`${base}.sha256`)]);
  const expected = sumFile.toString("utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(tarball).digest("hex");
  if (actual !== expected) throw new Error(`sha256 mismatch for ${name}: ${actual} != ${expected}`);

  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${name}.tar.gz`);
  fs.writeFileSync(archive, tarball);
  execFileSync("tar", ["-xzf", archive, "-C", cacheDir]);
  // The tarball holds a top-level file named like the asset, not `aoe`.
  const extracted = path.join(cacheDir, name);
  fs.renameSync(extracted, bin);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Short path: the daemon's Unix socket path is length limited (os.tmpdir() is too long on macOS). */
export function makeThrowawayHome(): string {
  return fs.mkdtempSync("/tmp/aoe-");
}

/**
 * Copy the plugin source (tracked and untracked, not ignored) into a fresh dir.
 * The host rejects a plugin tree with symlinks, and node_modules/.bin has them.
 */
export function stageSource(dest: string): string {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const target = path.join(dest, "plugin");
  for (const file of files) {
    const from = path.join(repoRoot, file);
    if (!fs.existsSync(from)) continue; // deleted but still indexed
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(from, path.join(target, file));
  }
  return target;
}
