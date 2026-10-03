#!/usr/bin/env node
// quickdraw-skills: links this package's agent rules and skills into a
// consumer repo's `.claude/` as relative symlinks, the way
// `@rallycry/conveyor-skills` links its skills:
//
//   .claude/skills/<name>     -> node_modules/@fitzzero/quickdraw-skills/skills/<name>
//   .claude/rules/<name>.md   -> node_modules/@fitzzero/quickdraw-skills/rules/<name>.md
//
// Claude Code follows symlinks there and skips broken ones, so the links are
// safe to commit: they are dead on a fresh clone and come alive at the first
// install, and their content always matches the installed version.
//
// Usage:
//   quickdraw-skills link           create or refresh the links, prune stale ones (the default)
//   quickdraw-skills link --check   change nothing; exit 1 when a link is missing, stale or dangling
//
// Only links this package owns (their target has the path segments
// `@fitzzero/quickdraw-skills/skills/` or `@fitzzero/quickdraw-skills/rules/`,
// or lands in this package's directory) are ever replaced or pruned. A real
// file or directory, and another package's link, are left alone with a
// warning, even when they take the name of one of this package's rules or
// skills: that is how an app keeps its own version of one.
//
// Links are only written into real directories of the repo: when `.claude`
// or `.claude/<kind>` is a symlink, or resolves outside the repo, that kind is
// left alone with a warning, since relative links written through it would
// land elsewhere (a shared or global directory) and resolve against it.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE = "@fitzzero/quickdraw-skills";

const USAGE = `Usage: quickdraw-skills link [--check]

  link            link this package's rules into .claude/rules and its skills
                  into .claude/skills of the repo around the working directory,
                  and prune links to rules or skills it no longer ships
  link --check    change nothing; exit 1 when a link is missing, stale or dangling
`;

/** The two kinds of entry this package links: skill directories and rule files. */
const KINDS = [
  { name: "skills", isEntry: (entry) => entry.isDirectory() },
  { name: "rules", isEntry: (entry) => entry.isFile() && entry.name.endsWith(".md") },
];

function warn(message) {
  process.stderr.write(`quickdraw-skills: warning: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`quickdraw-skills: ${message}\n`);
  process.exit(1);
}

/** The nearest directory above `start` that holds `.git`, else the nearest that holds `package.json`. */
function findRepoRoot(start) {
  for (const marker of [".git", "package.json"]) {
    let dir = start;
    for (;;) {
      if (existsSync(join(dir, marker))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return undefined;
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `path` exists without following a symlink: a file, a directory, or a link. */
function occupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The target of the symlink at `path`, with the platform's separator. */
function targetOf(path) {
  return readlinkSync(path).split("/").join(sep);
}

function parseArgs(args) {
  const known = new Set(["link", "--check", "--help", "-h"]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown !== undefined) {
    process.stderr.write(`quickdraw-skills: unknown argument "${unknown}"\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  return { check: args.includes("--check") };
}

const { check } = parseArgs(process.argv.slice(2));

// This package's own directory, through any install symlink (bun and pnpm may
// install it as a link into their store).
const packageDir = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = findRepoRoot(process.cwd());
if (repoRoot === undefined) {
  fail("found no repo root (a .git or package.json) above the working directory");
}

/**
 * What one kind links: its entries, where the links go, and the directory
 * they point into. Links prefer the stable `node_modules/@fitzzero/quickdraw-skills`
 * path, so committed links never embed a package store's hashed path; without
 * it (the package not installed at the repo root) they point at the package
 * where it is.
 */
function planKind(kind) {
  const sourceDir = join(packageDir, kind.name);
  if (!existsSync(sourceDir)) {
    fail(`no ${kind.name} directory at ${sourceDir} (a broken install?)`);
  }
  const stableDir = join(repoRoot, "node_modules", ...PACKAGE.split("/"), kind.name);
  const names = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => kind.isEntry(entry))
    .map((entry) => entry.name)
    .sort();
  return {
    kind: kind.name,
    names,
    sourceDir,
    linkDir: join(repoRoot, ".claude", kind.name),
    targetDir: existsSync(stableDir) ? stableDir : sourceDir,
  };
}

/** True when the path `target` has the segments `@fitzzero/quickdraw-skills/<kind>/` in it. */
function namesPackage(target, kind) {
  const segments = target.split(sep);
  const [scope, name] = PACKAGE.split("/");
  return segments.some(
    (segment, index) =>
      segment === scope &&
      segments[index + 1] === name &&
      segments[index + 2] === kind &&
      index + 3 < segments.length,
  );
}

/** True when `path` lies inside `dir`. */
function inside(path, dir) {
  return path.startsWith(`${dir}${sep}`);
}

/**
 * True when the symlink at `linkPath` belongs to this package: its target
 * names the installed package, or it lands in this package's directory (as
 * written, or through any symlink on the way).
 */
function ownedBy(plan, linkPath) {
  const target = targetOf(linkPath);
  if (namesPackage(target, plan.kind)) {
    return true;
  }
  const landing = resolve(dirname(linkPath), target);
  if (inside(landing, plan.sourceDir)) {
    return true;
  }
  try {
    return inside(realpathSync(landing), plan.sourceDir);
  } catch {
    return false;
  }
}

/**
 * Why this package's links cannot go into `.claude/<kind>`, or `undefined`:
 * `.claude` or `.claude/<kind>` is a symlink, or resolves outside the repo.
 * A directory that does not exist yet is created inside the repo.
 */
function refusal(plan) {
  const realRoot = realpathSync(repoRoot);
  for (const [dir, shown] of [
    [dirname(plan.linkDir), ".claude"],
    [plan.linkDir, `.claude/${plan.kind}`],
  ]) {
    if (!occupied(dir)) {
      return undefined;
    }
    if (isSymlink(dir)) {
      return `${shown} is a symlink (to ${targetOf(dir)})`;
    }
    const real = realpathSync(dir);
    if (!inside(real, realRoot)) {
      return `${shown} resolves outside the repo (to ${real})`;
    }
  }
  return undefined;
}

/** What `--check` and `link` found and did, for the summary. */
const tally = { problems: 0, linked: 0, pruned: 0 };

function problem(message) {
  warn(message);
  tally.problems += 1;
}

/** Leaves a real file or another package's link at `linkPath` alone, with a warning. */
function leaveAlone(plan, name, linkPath) {
  const shown = `.claude/${plan.kind}/${name}`;
  if (isSymlink(linkPath)) {
    warn(`${shown} is a link owned by something else (${targetOf(linkPath)}): left alone`);
  } else {
    warn(`${shown} exists and is not a link: left alone, so this package's ${name} is not linked`);
  }
}

function linkOne(plan, name) {
  const linkPath = join(plan.linkDir, name);
  const desired = relative(plan.linkDir, join(plan.targetDir, name));
  const isLink = isSymlink(linkPath);
  if (isLink && targetOf(linkPath) === desired) {
    if (!existsSync(linkPath)) {
      problem(`link .claude/${plan.kind}/${name} is dangling (${desired})`);
    }
    return;
  }
  if (occupied(linkPath) && (!isLink || !ownedBy(plan, linkPath))) {
    leaveAlone(plan, name, linkPath);
    return;
  }
  if (check) {
    problem(`link .claude/${plan.kind}/${name} is ${isLink ? "stale" : "missing"}`);
    return;
  }
  try {
    rmSync(linkPath, { force: true });
    symlinkSync(desired, linkPath);
    tally.linked += 1;
    process.stdout.write(`linked .claude/${plan.kind}/${name} -> ${desired}\n`);
  } catch (error) {
    // A filesystem without symlinks (Windows without developer mode) gets a
    // warning, not a failed install.
    warn(`could not link ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Removes (or, with `--check`, reports) this package's links to entries it no longer ships. */
function pruneKind(plan) {
  if (!existsSync(plan.linkDir)) {
    return;
  }
  for (const entry of readdirSync(plan.linkDir)) {
    const linkPath = join(plan.linkDir, entry);
    if (plan.names.includes(entry) || !isSymlink(linkPath) || !ownedBy(plan, linkPath)) {
      continue;
    }
    if (check) {
      problem(
        `link .claude/${plan.kind}/${entry} points to a ${plan.kind} entry this package no longer ships`,
      );
      continue;
    }
    try {
      rmSync(linkPath);
      tally.pruned += 1;
      process.stdout.write(`pruned .claude/${plan.kind}/${entry}\n`);
    } catch (error) {
      warn(`could not prune ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const plans = [];
const leftAlone = [];
for (const plan of KINDS.map(planKind)) {
  const refused = refusal(plan);
  if (refused !== undefined) {
    warn(
      `${refused}: left alone, since links written through it would not resolve in this repo; make it a real directory to link this package's ${plan.kind}`,
    );
    leftAlone.push(`.claude/${plan.kind}`);
    continue;
  }
  plans.push(plan);
  if (!check) {
    mkdirSync(plan.linkDir, { recursive: true });
  }
  for (const name of plan.names) {
    linkOne(plan, name);
  }
  pruneKind(plan);
}

const counts = plans.map((plan) => `${plan.names.length} ${plan.kind}`).join(" and ") || "nothing";
const aside = leftAlone.length === 0 ? "" : `; ${leftAlone.join(" and ")} left alone`;
if (check) {
  if (tally.problems > 0) {
    fail(`${tally.problems} link(s) out of date: run 'quickdraw-skills link'`);
  }
  process.stdout.write(`quickdraw-skills: ${counts} linked and up to date${aside}\n`);
} else {
  process.stdout.write(
    `quickdraw-skills: ${counts} in .claude (${tally.linked} updated, ${tally.pruned} pruned)${aside}\n`,
  );
}
