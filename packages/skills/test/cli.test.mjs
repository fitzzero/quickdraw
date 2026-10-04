// Tests of `quickdraw-skills link` (run with `node --test`). Each test builds
// a throwaway repo with a copy of this package installed where a consumer's
// install puts it, `node_modules/@fitzzero/quickdraw-skills`, and runs the
// copy's CLI there, so a test can remove a rule or skill from "the package"
// without touching this one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = ["quickdraw-migrate-v5", "quickdraw-new-service"];
const RULES = [
  "quickdraw-access.md",
  "quickdraw-client.md",
  "quickdraw-services.md",
  "quickdraw-testing.md",
];
const INSTALLED = "../../node_modules/@fitzzero/quickdraw-skills";

const repos = [];
after(() => {
  for (const root of repos) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway repo with a copy of this package installed in its node_modules. */
function createRepo() {
  const root = mkdtempSync(join(tmpdir(), "quickdraw-skills-"));
  repos.push(root);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "package.json"), "{}\n");
  const installed = join(root, "node_modules", "@fitzzero", "quickdraw-skills");
  for (const part of ["bin", "skills", "rules", "package.json"]) {
    cpSync(join(packageDir, part), join(installed, part), { recursive: true });
  }
  return { root, installed, cli: join(installed, "bin", "cli.mjs") };
}

/** Runs a CLI (the repo's installed copy by default) in `cwd`. */
function run(repo, args, { cwd = repo.root, cli = repo.cli } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `[name, target]` for every link in `.claude/<kind>`. */
function linksIn(repo, kind) {
  const dir = join(repo.root, ".claude", kind);
  return readdirSync(dir)
    .filter((name) => isLink(join(dir, name)))
    .sort()
    .map((name) => [name, readlinkSync(join(dir, name))]);
}

describe("quickdraw-skills link", () => {
  it("ships the documented rules and skills", () => {
    assert.deepEqual(readdirSync(join(packageDir, "skills")).sort(), SKILLS);
    assert.deepEqual(readdirSync(join(packageDir, "rules")).sort(), RULES);
  });

  it("links every skill and rule as a relative link into the installed package", () => {
    const repo = createRepo();
    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      linksIn(repo, "skills"),
      SKILLS.map((name) => [name, `${INSTALLED}/skills/${name}`]),
    );
    assert.deepEqual(
      linksIn(repo, "rules"),
      RULES.map((name) => [name, `${INSTALLED}/rules/${name}`]),
    );
    for (const name of RULES) {
      assert.equal(
        readFileSync(join(repo.root, ".claude", "rules", name), "utf8"),
        readFileSync(join(packageDir, "rules", name), "utf8"),
      );
    }
    assert.ok(
      existsSync(join(repo.root, ".claude", "skills", "quickdraw-new-service", "SKILL.md")),
    );
    assert.match(result.stdout, /2 skills and 4 rules in \.claude \(6 updated, 0 pruned\)/);
  });

  it("changes nothing when run again", () => {
    const repo = createRepo();
    run(repo, ["link"]);
    const before = [linksIn(repo, "skills"), linksIn(repo, "rules")];
    const again = run(repo, ["link"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /\(0 updated, 0 pruned\)/);
    assert.doesNotMatch(again.stdout, /^linked /m);
    assert.deepEqual([linksIn(repo, "skills"), linksIn(repo, "rules")], before);
  });

  it("finds the repo root from a subdirectory", () => {
    const repo = createRepo();
    const nested = join(repo.root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    const result = run(repo, ["link"], { cwd: nested });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(linksIn(repo, "rules").length, RULES.length);
    assert.equal(existsSync(join(nested, ".claude")), false);
  });
});

describe("quickdraw-skills link, beside other entries", () => {
  it("leaves a real directory or file with a skill's or rule's name alone", () => {
    const repo = createRepo();
    const ownSkill = join(repo.root, ".claude", "skills", "quickdraw-new-service");
    const ownRule = join(repo.root, ".claude", "rules", "quickdraw-access.md");
    mkdirSync(ownSkill, { recursive: true });
    writeFileSync(join(ownSkill, "SKILL.md"), "our own\n");
    mkdirSync(dirname(ownRule), { recursive: true });
    writeFileSync(ownRule, "our own rule\n");

    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /quickdraw-new-service exists and is not a link: left alone/);
    assert.match(result.stderr, /quickdraw-access\.md exists and is not a link: left alone/);
    assert.equal(readFileSync(join(ownSkill, "SKILL.md"), "utf8"), "our own\n");
    assert.equal(readFileSync(ownRule, "utf8"), "our own rule\n");
    assert.equal(isLink(ownSkill) || isLink(ownRule), false);
    assert.equal(linksIn(repo, "skills").length, SKILLS.length - 1);
    assert.equal(linksIn(repo, "rules").length, RULES.length - 1);
    // An app's own version of a rule is a choice, not drift.
    assert.equal(run(repo, ["link", "--check"]).status, 0);
  });

  it("leaves other packages' links alone, even under one of its names", () => {
    const repo = createRepo();
    const skills = join(repo.root, ".claude", "skills");
    const rules = join(repo.root, ".claude", "rules");
    mkdirSync(skills, { recursive: true });
    mkdirSync(rules, { recursive: true });
    const conveyor = "../../node_modules/@rallycry/conveyor-skills/skills/conveyor-build";
    symlinkSync(conveyor, join(skills, "conveyor-build"));
    symlinkSync("../../docs/client-rules.md", join(rules, "quickdraw-client.md"));

    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /quickdraw-client\.md is a link owned by something else/);
    assert.equal(readlinkSync(join(skills, "conveyor-build")), conveyor);
    assert.equal(readlinkSync(join(rules, "quickdraw-client.md")), "../../docs/client-rules.md");
    assert.equal(run(repo, ["link", "--check"]).status, 0);
  });

  it("prunes the links of a skill and a rule the package no longer ships", () => {
    const repo = createRepo();
    run(repo, ["link"]);
    rmSync(join(repo.installed, "skills", "quickdraw-migrate-v5"), { recursive: true });
    rmSync(join(repo.installed, "rules", "quickdraw-testing.md"));

    const check = run(repo, ["link", "--check"]);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /\.claude\/skills\/quickdraw-migrate-v5 points to a skills entry/);
    assert.match(check.stderr, /\.claude\/rules\/quickdraw-testing\.md points to a rules entry/);

    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^pruned \.claude\/skills\/quickdraw-migrate-v5$/m);
    assert.match(result.stdout, /^pruned \.claude\/rules\/quickdraw-testing\.md$/m);
    assert.equal(isLink(join(repo.root, ".claude", "skills", "quickdraw-migrate-v5")), false);
    assert.equal(isLink(join(repo.root, ".claude", "rules", "quickdraw-testing.md")), false);
    assert.equal(run(repo, ["link", "--check"]).status, 0);
  });
});

describe("quickdraw-skills link, owning links", () => {
  it("owns only links naming @fitzzero/quickdraw-skills, not a package whose name ends the same", () => {
    // The review's linker case: `vendor/my-quickdraw-skills/skills/custom`
    // contains `quickdraw-skills/skills/` and was pruned as this package's.
    const repo = createRepo();
    const vendor = join(repo.root, "vendor", "my-quickdraw-skills", "skills", "custom");
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, "SKILL.md"), "# custom\n");
    const skills = join(repo.root, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    const custom = "../../vendor/my-quickdraw-skills/skills/custom";
    symlinkSync(custom, join(skills, "custom"));
    symlinkSync(
      "../../vendor/my-quickdraw-skills/skills/custom",
      join(skills, "quickdraw-new-service"),
    );

    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^pruned /m);
    assert.equal(readlinkSync(join(skills, "custom")), custom);
    assert.match(result.stderr, /quickdraw-new-service is a link owned by something else/);
    assert.equal(run(repo, ["link", "--check"]).status, 0);
  });

  it("owns a link that lands in the package through a symlink, and prunes it when stale", () => {
    const repo = createRepo();
    const alias = join(repo.root, "tools", "skills-pkg");
    mkdirSync(dirname(alias), { recursive: true });
    symlinkSync(repo.installed, alias);
    const skills = join(repo.root, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    symlinkSync("../../tools/skills-pkg/skills/quickdraw-new-service", join(skills, "renamed"));

    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^pruned \.claude\/skills\/renamed$/m);
  });
});

describe("quickdraw-skills link, through a symlinked .claude", () => {
  // The review's linker case: relative links written through a symlinked
  // directory land in the directory it points to and resolve against it.
  it("leaves a symlinked .claude/skills alone, writes nothing through it, and links the rules", () => {
    const repo = createRepo();
    const shared = mkdtempSync(join(tmpdir(), "quickdraw-skills-shared-"));
    repos.push(shared);
    mkdirSync(join(repo.root, ".claude"));
    symlinkSync(shared, join(repo.root, ".claude", "skills"));

    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\.claude\/skills is a symlink \(to .*\): left alone/);
    assert.deepEqual(readdirSync(shared), []);
    assert.equal(linksIn(repo, "rules").length, RULES.length);
    assert.match(
      result.stdout,
      /4 rules in \.claude \(4 updated, 0 pruned\); \.claude\/skills left alone/,
    );

    const check = run(repo, ["link", "--check"]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /4 rules linked and up to date; \.claude\/skills left alone/);
  });

  it("leaves both kinds alone when .claude itself is a symlink", () => {
    const repo = createRepo();
    const shared = mkdtempSync(join(tmpdir(), "quickdraw-skills-shared-"));
    repos.push(shared);
    symlinkSync(shared, join(repo.root, ".claude"));

    const result = run(repo, ["link"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\.claude is a symlink .*this package's skills/);
    assert.match(result.stderr, /\.claude is a symlink .*this package's rules/);
    assert.deepEqual(readdirSync(shared), []);
  });
});

describe("quickdraw-skills link --check", () => {
  it("passes when every link is current and changes nothing", () => {
    const repo = createRepo();
    run(repo, ["link"]);
    const result = run(repo, ["link", "--check"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 skills and 4 rules linked and up to date/);
  });

  it("reports missing links without creating them", () => {
    const repo = createRepo();
    const result = run(repo, ["link", "--check"]);
    assert.equal(result.status, 1);
    for (const name of [...SKILLS, ...RULES]) {
      assert.match(result.stderr, new RegExp(`${name.replace(".", "\\.")} is missing`));
    }
    assert.match(result.stderr, /6 link\(s\) out of date: run 'quickdraw-skills link'/);
    assert.equal(existsSync(join(repo.root, ".claude")), false);
  });

  it("reports a stale link, which link repoints", () => {
    const repo = createRepo();
    run(repo, ["link"]);
    const link = join(repo.root, ".claude", "skills", "quickdraw-new-service");
    rmSync(link);
    symlinkSync(`${INSTALLED}/skills/quickdraw-old-name`, link);

    const check = run(repo, ["link", "--check"]);
    assert.equal(check.status, 1);
    assert.match(check.stderr, /\.claude\/skills\/quickdraw-new-service is stale/);
    assert.equal(run(repo, ["link"]).status, 0);
    assert.equal(readlinkSync(link), `${INSTALLED}/skills/quickdraw-new-service`);
  });

  it("reports a dangling link", () => {
    // The installed copy lacks a skill the running CLI ships, so its link
    // names the right place and finds nothing there.
    const repo = createRepo();
    rmSync(join(repo.installed, "skills", "quickdraw-new-service"), { recursive: true });
    const cli = join(packageDir, "bin", "cli.mjs");
    run(repo, ["link"], { cli });

    const check = run(repo, ["link", "--check"], { cli });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /\.claude\/skills\/quickdraw-new-service is dangling/);
  });

  it("prints its usage, and refuses an unknown argument", () => {
    const repo = createRepo();
    const help = run(repo, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: quickdraw-skills link \[--check\]/);
    const unknown = run(repo, ["unlink"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown argument "unlink"/);
    assert.equal(existsSync(join(repo.root, ".claude")), false);
  });
});
