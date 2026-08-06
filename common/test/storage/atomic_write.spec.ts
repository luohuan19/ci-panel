import fs from "fs-extra";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// StorageSubsystem.DATA_PATH is derived from process.cwd() at module load, so the sandbox has
// to be in place before the import — hence the dynamic import in beforeAll rather than a
// top-level one. common's vitest config runs with threads: false, which is what makes chdir
// legal here; the afterAll puts the working directory back so the other spec files in this
// package are unaffected.
const REPO_CWD = process.cwd();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ci-panel-common-storage-"));

let storage: InstanceType<typeof import("../../src/system_storage").default>;
const configDir = path.join(sandbox, "data", "Config");
const globalJson = path.join(configDir, "global.json");

beforeAll(async () => {
  process.chdir(sandbox);
  const mod = await import("../../src/system_storage");
  storage = new mod.default();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.removeSync(path.join(sandbox, "data"));
});

afterAll(() => {
  process.chdir(REPO_CWD);
  fs.removeSync(sandbox);
});

/**
 * Stand in for a full disk — and the faithfulness of the stand-in is the entire point.
 *
 * On a real ENOSPC the kernel has already applied O_TRUNC by the time the write fails, so
 * whatever handle the caller opened is left empty. A mock that merely threw would never
 * empty anything, and the pre-fix code — which hands the live target path straight to
 * writeFileSync — would pass these assertions while still destroying the file in production.
 * Truncating here is what makes this spec fail against the unfixed implementation.
 */
function simulateFullDisk() {
  return vi.spyOn(fs, "writeFileSync").mockImplementation(((file: number | string) => {
    if (typeof file === "number") fs.ftruncateSync(file, 0);
    else fs.truncateSync(file, 0);
    const err: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device, write");
    err.code = "ENOSPC";
    throw err;
  }) as never);
}

describe("a failed store() must not destroy what is already on disk", () => {
  // This is the daemon's data/Config/global.json in miniature. That file carries the key the
  // panel authenticates with: once a full disk truncates it to zero bytes, the next restart
  // mints a fresh key and the node cannot be reached again without manual repair.
  it("leaves the previous content intact", () => {
    storage.store("Config", "global", { key: "ORIGINAL_KEY", port: 24444 });
    simulateFullDisk();

    expect(() => storage.store("Config", "global", { key: "NEW_KEY", port: 24444 })).toThrow(
      /ENOSPC/
    );

    vi.restoreAllMocks();
    const onDisk = fs.readFileSync(globalJson, "utf-8");
    expect(onDisk.length).toBeGreaterThan(0);
    expect(JSON.parse(onDisk)).toEqual({ key: "ORIGINAL_KEY", port: 24444 });
  });

  it("reports the failure to the caller instead of swallowing it", () => {
    // The daemon has to be able to answer the panel with a real error. A store() that
    // returned quietly would put us back to the panel waiting out its RPC timeout.
    storage.store("Config", "global", { key: "ORIGINAL_KEY" });
    simulateFullDisk();
    let code: string | undefined;
    try {
      storage.store("Config", "global", { key: "NEW_KEY" });
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    expect(code).toBe("ENOSPC");
  });

  // Guards the new mechanism rather than the old defect: the pre-fix code wrote no temp
  // files, so it passed this trivially. It has teeth going forward — a failure path that
  // forgot to unlink would litter every category directory.
  it("cleans up after itself so the directory holds only the real file", () => {
    storage.store("Config", "global", { key: "ORIGINAL_KEY" });
    simulateFullDisk();
    expect(() => storage.store("Config", "global", { key: "NEW_KEY" })).toThrow();

    vi.restoreAllMocks();
    expect(fs.readdirSync(configDir)).toEqual(["global.json"]);
  });

  it("applies the same protection to writeFile()", () => {
    // version_adapter rewrites config files through this path during an upgrade, which is
    // exactly when a half-written file is least likely to be noticed.
    fs.mkdirsSync(configDir);
    storage.writeFile(path.join("Config", "global.json"), '{"key":"ORIGINAL_KEY"}');
    simulateFullDisk();

    expect(() => storage.writeFile(path.join("Config", "global.json"), '{"key":"NEW"}')).toThrow(
      /ENOSPC/
    );

    vi.restoreAllMocks();
    expect(fs.readFileSync(globalJson, "utf-8")).toBe('{"key":"ORIGINAL_KEY"}');
  });
});

describe("permissions survive the rewrite", () => {
  // Also a guard on the new mechanism, not a replay of the old bug — writeFileSync kept the
  // mode for free. It is here because the fix is what puts it at risk.
  it("keeps the mode the target already had", () => {
    // Writing through a temp file plus rename means the file that ends up in place is a
    // different one, so its mode has to be carried over deliberately. Getting this wrong
    // would widen the daemon's key file — on the shared build hosts this runs on, that is
    // every other account on the machine.
    storage.store("Config", "global", { key: "ORIGINAL_KEY" });
    fs.chmodSync(globalJson, 0o600);

    storage.store("Config", "global", { key: "SECOND_KEY" });

    expect(fs.statSync(globalJson).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(globalJson, "utf-8")).key).toBe("SECOND_KEY");
  });
});

describe("a scratch file left by a crash is not mistaken for stored data", () => {
  // The temp file is a sibling of the target, because rename is only atomic within one
  // filesystem. That puts it inside a directory list() and readDir() enumerate, so a process
  // killed between open and rename would otherwise leave behind an identifier that resolves
  // to nothing. The literal suffix below is the on-disk format, not an implementation detail
  // the test happens to know: anything reading these directories has to agree on it.
  const leftover = "global.json.4242-1.cip-tmp";

  it("is absent from list()", () => {
    storage.store("Config", "global", { key: "ORIGINAL_KEY" });
    fs.writeFileSync(path.join(configDir, leftover), "half a fi");

    expect(storage.list("Config")).toEqual(["global"]);
  });

  it("is absent from readDir()", () => {
    storage.store("Config", "global", { key: "ORIGINAL_KEY" });
    fs.writeFileSync(path.join(configDir, leftover), "half a fi");

    expect(storage.readDir("Config")).toEqual([path.join("Config", "global.json")]);
  });
});

describe("the ordinary path still behaves", () => {
  class StoredConfig {
    public key = "";
    public port = 0;
  }

  it("round-trips an object through store() and load()", () => {
    storage.store("Config", "global", { key: "ROUNDTRIP", port: 24444 });
    const loaded = storage.load("Config", StoredConfig, "global");
    expect(loaded.key).toBe("ROUNDTRIP");
    expect(loaded.port).toBe(24444);
  });

  it("overwrites an existing record rather than appending to it", () => {
    storage.store("Config", "global", { key: "FIRST", port: 1 });
    storage.store("Config", "global", { key: "SECOND", port: 2 });
    expect(JSON.parse(fs.readFileSync(globalJson, "utf-8"))).toEqual({ key: "SECOND", port: 2 });
  });

  it("still rejects an identifier that would escape the category directory", () => {
    expect(() => storage.store("Config", "../escape", {})).toThrow(/specification/);
  });
});
