import { readFileSync } from "node:fs";
import { cpus, hostname, loadavg, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { BENCH_DIR } from "../paths";
import { textOf } from "./exec";

/** What the numbers were measured on. Recorded in every result file. */

export interface Machine {
  hostname: string;
  cpuModel: string;
  nproc: number;
  kernel: string;
  os: string;
  totalMemoryGb: number;
  cpuGovernor: string | null;
  cpuBoost: string | null;
}

export interface LoadAverage {
  one: number;
  five: number;
  fifteen: number;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** Expand a cpu list ("2,3", "6-9") into its cpu numbers. */
export function expandCpus(list: string): number[] {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .flatMap((part) => {
      const [from, to] = part.split("-").map(Number);
      if (from === undefined || Number.isNaN(from)) return [];
      if (to === undefined) return [from];
      return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
    });
}

/** Whether two cpu lists name the same cpus ("2,3" and "2-3" do). */
export function sameCpus(a: string, b: string): boolean {
  const left = [...new Set(expandCpus(a))].sort((x, y) => x - y);
  const right = [...new Set(expandCpus(b))].sort((x, y) => x - y);
  return left.length === right.length && left.every((cpu, index) => cpu === right[index]);
}

function osName(): string {
  const osRelease = readText("/etc/os-release") ?? "";
  const match = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(osRelease);
  return match?.[1] ?? process.platform;
}

export function describeMachine(serverCpus: string): Machine {
  const firstCpu = expandCpus(serverCpus)[0] ?? 0;
  const cpufreq = `/sys/devices/system/cpu/cpu${firstCpu}/cpufreq`;
  return {
    hostname: hostname(),
    cpuModel: cpus()[0]?.model.trim() ?? "unknown",
    // --all: plain `nproc` reports only the cpus this (already pinned) process may use.
    nproc: Number(textOf("nproc", ["--all"])) || cpus().length,
    kernel: release(),
    os: osName(),
    totalMemoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    cpuGovernor: readText(join(cpufreq, "scaling_governor")),
    cpuBoost: readText("/sys/devices/system/cpu/cpufreq/boost"),
  };
}

export function loadAverage(): LoadAverage {
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  const r = (value: number): number => Math.round(value * 100) / 100;
  return { one: r(one), five: r(five), fifteen: r(fifteen) };
}

/** The `Cpus_allowed_list` of a process, from /proc. */
export function cpusAllowed(pid: number | "self"): string | null {
  const status = readText(`/proc/${pid}/status`);
  const match = status ? /^Cpus_allowed_list:\s*(\S+)/m.exec(status) : null;
  return match?.[1] ?? null;
}

/** Pin this process (every thread) to the load-generator cpus. */
export function pinSelf(cpuList: string): void {
  if (textOf("taskset", ["-a", "-cp", cpuList, String(process.pid)]) === null) {
    throw new Error(`could not pin the load generator to cpus ${cpuList} with taskset`);
  }
}

function packageVersion(path: string): string | null {
  const text = readText(path);
  return text ? ((JSON.parse(text) as { version?: string }).version ?? null) : null;
}

export interface Runtime {
  node: string;
  bun: string | null;
  docker: string | null;
  socketIoClient: string | null;
}

export function runtimeVersions(): Runtime {
  return {
    node: process.version,
    bun: textOf("bun", ["--version"]),
    docker: textOf("docker", ["version", "--format", "{{.Server.Version}}"]),
    socketIoClient: packageVersion(
      join(BENCH_DIR, "node_modules", "socket.io-client", "package.json"),
    ),
  };
}

/**
 * The quickdraw-core version an app installs, as the app resolves it (the
 * published 4.1.0 for apps/v4, this workspace's package for apps/v5): the
 * label its results are filed under unless `--label` names another.
 */
export function appCoreVersion(appDirectory: string): string {
  // Node's lookup: the nearest node_modules up from the app (4.1.0 exports no package.json to resolve).
  for (let dir = appDirectory; ; dir = dirname(dir)) {
    const version = packageVersion(
      join(dir, "node_modules", "@fitzzero", "quickdraw-core", "package.json"),
    );
    if (version) return version;
    if (dirname(dir) === dir) break;
  }
  throw new Error(`cannot find @fitzzero/quickdraw-core from ${appDirectory}; run bun install`);
}
