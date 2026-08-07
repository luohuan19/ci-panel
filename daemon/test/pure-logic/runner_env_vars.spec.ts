import fs from "fs-extra";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { SCAN_ROOT } from "../setup";
import {
  formatEnvLines,
  MAX_VALUE_LEN,
  MAX_VARS,
  sanitizeEnvVars,
  writeDotEnvFile
} from "../../src/service/runner_env_vars";

// These are the checks standing between a browser form and two files that are read as
// configuration: a root-owned systemd drop-in (`Environment=`) and `<dir>/.env`. Both are
// line-oriented, so a value carrying a newline is not a bad value — it is an extra directive.
// That is the case worth pinning; the rest guard against writing a file nobody can parse back.

describe("sanitizeEnvVars", () => {
  it("keeps a well-formed list as-is", () => {
    const vars = [
      { key: "HTTPS_PROXY", value: "http://127.0.0.1:7892" },
      { key: "http_proxy", value: "http://127.0.0.1:7892" }, // 小写放行：既有 .env 里就有
      { key: "_UNDERSCORE1", value: "" }
    ];
    expect(sanitizeEnvVars(vars)).toEqual(vars);
  });

  it("lets a later entry win and keeps the first position", () => {
    expect(
      sanitizeEnvVars([
        { key: "A", value: "1" },
        { key: "B", value: "2" },
        { key: "A", value: "3" }
      ])
    ).toEqual([
      { key: "A", value: "3" },
      { key: "B", value: "2" }
    ]);
  });

  it("drops entries with an empty key but keeps entries with an empty value", () => {
    expect(sanitizeEnvVars([{ key: "  ", value: "x" }, { key: "K", value: "" }])).toEqual([
      { key: "K", value: "" }
    ]);
  });

  it.each([
    ["1LEADING_DIGIT", "非法环境变量名"],
    ["HAS-DASH", "非法环境变量名"],
    ["HAS SPACE", "非法环境变量名"],
    ["HAS=EQ", "非法环境变量名"],
    ["中文", "非法环境变量名"]
  ])("rejects the key %j", (key, needle) => {
    expect(() => sanitizeEnvVars([{ key, value: "v" }])).toThrow(needle);
  });

  it.each([
    ["a\nEnvironment=EVIL=1", "\\n"],
    ["a\rb", "\\r"]
  ])("rejects a value carrying %s — one line, one variable", (value) => {
    // 放行的话，一个值就能在 override.conf 里多写一条 Environment=，或在 .env 里多写一行
    expect(() => sanitizeEnvVars([{ key: "K", value }])).toThrow("不能含换行");
  });

  it("rejects an over-long value", () => {
    expect(() => sanitizeEnvVars([{ key: "K", value: "x".repeat(MAX_VALUE_LEN + 1) }])).toThrow(
      "过长"
    );
    expect(() => sanitizeEnvVars([{ key: "K", value: "x".repeat(MAX_VALUE_LEN) }])).not.toThrow();
  });

  it("rejects more than the cap after de-duplication", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `K${i}`, value: "v" }));
    expect(() => sanitizeEnvVars(many(MAX_VARS))).not.toThrow();
    expect(() => sanitizeEnvVars(many(MAX_VARS + 1))).toThrow("条数过多");
  });

  it("tolerates nullish members instead of throwing a TypeError at the caller", () => {
    expect(sanitizeEnvVars([undefined as never, { key: "K" } as never])).toEqual([
      { key: "K", value: "" }
    ]);
  });
});

describe("formatEnvLines", () => {
  it("writes one KEY=VALUE per line with no trailing newline", () => {
    expect(
      formatEnvLines([
        { key: "A", value: "1" },
        { key: "B", value: "x=y" }
      ])
    ).toBe("A=1\nB=x=y");
  });

  it("is empty for an empty list", () => {
    expect(formatEnvLines([])).toBe("");
  });
});

describe("writeDotEnvFile", () => {
  const dir = path.join(SCAN_ROOT, "dotenv-target");
  const file = path.join(dir, ".env");

  beforeEach(() => {
    fs.removeSync(dir);
    fs.mkdirsSync(dir);
  });

  it("writes the list and terminates the last line", () => {
    writeDotEnvFile(dir, [
      { key: "A", value: "1" },
      { key: "B", value: "2" }
    ]);
    expect(fs.readFileSync(file, "utf8")).toBe("A=1\nB=2\n");
  });

  it("creates the file 0600 — .env can hold proxy credentials", () => {
    writeDotEnvFile(dir, [{ key: "A", value: "1" }]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the permissions an operator set by hand", () => {
    fs.writeFileSync(file, "OLD=1\n", { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    writeDotEnvFile(dir, [{ key: "A", value: "1" }]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it("removes the file for an empty list rather than leaving an empty one", () => {
    fs.writeFileSync(file, "OLD=1\n");
    writeDotEnvFile(dir, []);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves no temp file behind", () => {
    writeDotEnvFile(dir, [{ key: "A", value: "1" }]);
    expect(fs.readdirSync(dir)).toEqual([".env"]);
  });
});
