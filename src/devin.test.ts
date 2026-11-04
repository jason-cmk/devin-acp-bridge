import { describe, expect, test } from "bun:test";
import { devinEnv } from "./devin";

describe("devinEnv", () => {
  test("drops BUN_BE_BUN so Bun-compiled CLIs that Devin runs act as themselves", () => {
    expect(devinEnv({ BUN_BE_BUN: "1", PATH: "/bin", HOME: "/home/u" })).toEqual({ PATH: "/bin", HOME: "/home/u" });
  });

  test("does not change the environment it is given", () => {
    const env = { BUN_BE_BUN: "1" };
    devinEnv(env);
    expect(env).toEqual({ BUN_BE_BUN: "1" });
  });
});
