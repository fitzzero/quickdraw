import { readFileSync } from "node:fs";

/**
 * How much other work shared the machine during a measurement window, read
 * from /proc (Linux). The load average at the start of a run mostly shows the
 * benchmark's own previous run; these numbers show what else ran while this
 * one was measured.
 */

export interface MachineNoise {
  /** Time other processes spent on the server's pinned cpus, as a share of those cpus' capacity. */
  otherWorkOnServerCpusPct: number;
  /** Interrupt time on the server's cpus (mostly the benchmark's own network traffic). */
  interruptsOnServerCpusPct: number;
  /** How busy the cpus outside the server, load generator and Postgres sets were. */
  restOfMachineBusyPct: number;
}

interface CpuTicks {
  /** user + nice + system + steal */
  work: number;
  /** irq + softirq */
  interrupts: number;
}

/** USER_HZ: /proc reports cpu time in ticks of 1/100 s on Linux. */
const TICKS_PER_SECOND = 100;

function readCpuTicks(): Map<number, CpuTicks> {
  const ticks = new Map<number, CpuTicks>();
  for (const line of readFileSync("/proc/stat", "utf8").split("\n")) {
    const match = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const [user = 0, nice = 0, system = 0, , , irq = 0, softirq = 0, steal = 0] = match[2]
      .split(/\s+/)
      .map(Number);
    ticks.set(Number(match[1]), { work: user + nice + system + steal, interrupts: irq + softirq });
  }
  return ticks;
}

/** utime + stime of a whole process (every thread), in ticks. */
function processTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[11] ?? 0) + Number(fields[12] ?? 0);
}

function sum(ticks: Map<number, CpuTicks>, cpus: readonly number[], key: keyof CpuTicks): number {
  return cpus.reduce((total, cpu) => total + (ticks.get(cpu)?.[key] ?? 0), 0);
}

export interface NoiseWatch {
  stop(): MachineNoise | null;
}

/** Start watching; `stop()` returns null when /proc is unavailable (not Linux). */
export function watchNoise(
  serverPid: number,
  serverCpus: number[],
  benchCpus: number[],
): NoiseWatch {
  try {
    const startedAt = performance.now();
    const before = readCpuTicks();
    const serverBefore = processTicks(serverPid);
    return {
      stop: () => {
        try {
          const seconds = (performance.now() - startedAt) / 1_000;
          const after = readCpuTicks();
          const serverTicks = processTicks(serverPid) - serverBefore;
          const rest = [...after.keys()].filter((cpu) => !benchCpus.includes(cpu));
          const delta = (cpus: number[], key: keyof CpuTicks): number =>
            (sum(after, cpus, key) - sum(before, cpus, key)) / TICKS_PER_SECOND;
          const share = (value: number, cpus: number): number =>
            cpus === 0 ? 0 : Math.max(0, (value / (seconds * cpus)) * 100);
          const other = delta(serverCpus, "work") - serverTicks / TICKS_PER_SECOND;
          return {
            otherWorkOnServerCpusPct: share(other, serverCpus.length),
            interruptsOnServerCpusPct: share(delta(serverCpus, "interrupts"), serverCpus.length),
            restOfMachineBusyPct: share(
              delta(rest, "work") + delta(rest, "interrupts"),
              rest.length,
            ),
          };
        } catch {
          return null;
        }
      },
    };
  } catch {
    return { stop: () => null };
  }
}
