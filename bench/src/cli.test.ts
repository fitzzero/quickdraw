import { describe, expect, it } from "vitest";
import { parseOptions } from "./cli";
import { SCENARIOS } from "./scenarios";

describe("options", () => {
  it("pick the target, the 4.1 app by default", () => {
    expect(parseOptions([]).target).toBe("v4");
    expect(parseOptions(["--", "--target", "v5"]).target).toBe("v5");
    expect(parseOptions(["--app", "v5"]).target).toBe("v5");
    expect(() => parseOptions(["--target", "v6"])).toThrow('unknown target "v6"');
    expect(() => parseOptions(["--target", "v5", "--app", "v4"])).toThrow("disagree");
  });

  it("make a quick run one repetition unless asked for more", () => {
    expect(parseOptions(["--target", "v5", "--scenario", "board-steady", "--quick"])).toMatchObject(
      {
        target: "v5",
        scenarios: ["board-steady"],
        quick: true,
        repetitions: 1,
      },
    );
    expect(parseOptions(["--quick", "--repetitions", "2"]).repetitions).toBe(2);
    expect(parseOptions([]).repetitions).toBe(3);
  });

  it("take a label and a profiling switch", () => {
    expect(parseOptions(["--label", "5.0.0", "--cpu-prof"])).toMatchObject({
      label: "5.0.0",
      cpuProf: true,
    });
    expect(parseOptions([]).label).toBeNull();
    expect(() => parseOptions(["--label", "../x"])).toThrow("--label");
  });
});

describe("quick runs", () => {
  it("shrink every scenario and change nothing about its shape", () => {
    for (const scenario of Object.values(SCENARIOS)) {
      const full = scenario.parameters(false);
      const quick = scenario.parameters(true);
      expect(Object.keys(quick)).toEqual(Object.keys(full));
      for (const [name, value] of Object.entries(quick)) {
        expect(value, `${scenario.name}.${name}`).toBeLessThanOrEqual(full[name] ?? Infinity);
      }
    }
  });
});
