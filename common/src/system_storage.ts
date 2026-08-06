import { randomBytes } from "crypto";
import fs from "fs-extra";
import path from "path";

export default class StorageSubsystem {
  public static readonly DATA_PATH = path.normalize(path.join(process.cwd(), "data"));
  public static readonly INDEX_PATH = path.normalize(path.join(process.cwd(), "data", "index"));

  // Marks the scratch file atomicWriteFileSync renames into place. Every directory listing
  // below has to skip it: a crash between open and rename leaves one behind, and list()
  // would otherwise hand its caller an identifier that never existed. Such a leftover is
  // never reclaimed — it is one config-sized file per hard kill, and sweeping the category
  // directory on every write would cost a readdir on a hot path to collect litter that in
  // practice does not accumulate.
  private static readonly TMP_SUFFIX = ".cip-tmp";

  private checkFileName(name: string) {
    if (!name) return false;
    const blackList = ["\\", "/", ".."];
    for (const ch of blackList) {
      if (name.includes(ch)) return false;
    }
    return true;
  }

  /**
   * Write a file such that a reader never observes a truncated or empty result.
   *
   * fs.writeFileSync truncates the target before it writes, so a failure part-way through
   * leaves a zero-byte file. That is not hypothetical: a full disk did exactly this to a
   * daemon's data/Config/global.json, and that file holds the key the panel authenticates
   * with — once it is empty, the next restart mints a fresh key and the node can no longer
   * be reached. Writing to a sibling and renaming leaves the target as either the old
   * content or the new one, never nothing.
   */
  private atomicWriteFileSync(targetPath: string, data: string) {
    // Sibling, not os.tmpdir(): rename is only atomic within a single filesystem.
    // The name is random rather than pid-derived. A pid plus a per-process counter looks
    // unique but is not across restarts: a leftover from a crash would collide once the OS
    // recycled that pid, and "wx" would then fail every write to that target — turning the
    // litter into exactly the unwritable-config outcome this method exists to prevent.
    const tmpPath = `${targetPath}.${randomBytes(6).toString("hex")}${
      StorageSubsystem.TMP_SUFFIX
    }`;

    // Reproduce writeFileSync's mode semantics exactly. An existing target keeps its own
    // permissions, so the temp file starts at 0o600 and is widened only after the content
    // is down — a key file is never briefly readable by other users on a shared machine.
    // A target that does not exist yet gets 0o666 masked by the umask, which is what
    // open() does with that mode and what writeFileSync would have produced.
    //
    // statSync follows symlinks but renameSync replaces the link itself, so a target that
    // is a symlink to a file stops being one after the first write. Deployments symlink
    // the whole shared/ directory (see DEPLOY.md), not individual config files, so nothing
    // relies on the old write-through behaviour — but do not start.
    let existingMode: number | null = null;
    try {
      existingMode = fs.statSync(targetPath).mode & 0o777;
    } catch {
      // No target yet — nothing to preserve.
    }

    let fd: number | null = null;
    try {
      fd = fs.openSync(tmpPath, "wx", existingMode === null ? 0o666 : 0o600);
      fs.writeFileSync(fd, data, { encoding: "utf-8" });
      // Flush before renaming. Without it the directory entry can reach the disk ahead of
      // the contents, so a power loss exposes precisely the empty file this avoids.
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      if (existingMode !== null) fs.chmodSync(tmpPath, existingMode);
      fs.renameSync(tmpPath, targetPath);
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // The write failure is the one worth reporting; rethrown below.
        }
      }
      try {
        fs.removeSync(tmpPath);
      } catch {
        // Best effort. A leftover is skipped by readDir()/list() rather than surfaced.
      }
      throw error;
    }
  }

  public writeFile(name: string, data: string) {
    const targetPath = path.normalize(path.join(StorageSubsystem.DATA_PATH, name));
    this.atomicWriteFileSync(targetPath, data);
  }

  public readFile(name: string) {
    const targetPath = path.normalize(path.join(StorageSubsystem.DATA_PATH, name));
    return fs.readFileSync(targetPath, { encoding: "utf-8" });
  }

  public readDir(dirName: string) {
    const targetPath = path.normalize(path.join(StorageSubsystem.DATA_PATH, dirName));
    if (!fs.existsSync(targetPath)) return [];
    const files = fs
      .readdirSync(targetPath)
      .filter((v) => !v.endsWith(StorageSubsystem.TMP_SUFFIX))
      .map((v) => path.normalize(path.join(dirName, v)));
    return files;
  }

  public deleteFile(name: string) {
    const targetPath = path.normalize(path.join(StorageSubsystem.DATA_PATH, name));
    fs.removeSync(targetPath);
  }

  public fileExists(name: string) {
    const targetPath = path.normalize(path.join(StorageSubsystem.DATA_PATH, name));
    return fs.existsSync(targetPath);
  }

  // Stored in local file based on class definition and identifier
  public store(category: string, uuid: string, object: any) {
    const dirPath = path.join(StorageSubsystem.DATA_PATH, category);
    if (!fs.existsSync(dirPath)) fs.mkdirsSync(dirPath);
    if (!this.checkFileName(uuid))
      throw new Error(`UUID ${uuid} does not conform to specification`);
    const filePath = path.join(dirPath, `${uuid}.json`);
    const data = JSON.stringify(object, null, 4);
    this.atomicWriteFileSync(filePath, data);
  }

  // deep copy of the primitive type with the copy target as the prototype
  protected defineAttr(target: any, object: any): any {
    for (const v of Object.keys(target)) {
      const objectValue = object[v];
      if (objectValue === undefined) continue;
      if (objectValue instanceof Array) {
        target[v] = objectValue;
        continue;
      }
      if (objectValue instanceof Object && typeof objectValue === "object") {
        this.defineAttr(target[v], objectValue);
        continue;
      }
      target[v] = objectValue;
    }
    return target;
  }

  /**
   * Instantiate an object based on the class definition and identifier
   */
  public load(category: string, classz: any, uuid: string) {
    const dirPath = path.join(StorageSubsystem.DATA_PATH, category);
    if (!fs.existsSync(dirPath)) fs.mkdirsSync(dirPath);
    if (!this.checkFileName(uuid))
      throw new Error(`UUID ${uuid} does not conform to specification`);
    const filePath = path.join(dirPath, `${uuid}.json`);
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath, { encoding: "utf-8" });
    const dataObject = JSON.parse(data);
    const target = new classz();
    // for (const v of Object. keys(target)) {
    // if (dataObject[v] !== undefined) target[v] = dataObject[v];
    // }
    // deep object copy
    return this.defineAttr(target, dataObject);
  }

  /**
   * Return all identifiers related to this class through the class definition
   */
  public list(category: string) {
    const dirPath = path.join(StorageSubsystem.DATA_PATH, category);
    if (!fs.existsSync(dirPath)) fs.mkdirsSync(dirPath);
    const files = fs.readdirSync(dirPath);
    const result = new Array<string>();
    files.forEach((name) => {
      if (name.endsWith(StorageSubsystem.TMP_SUFFIX)) return;
      result.push(name.replace(path.extname(name), ""));
    });
    return result;
  }

  /**
   * Delete an identifier instance of the specified type through the class definition
   */
  public delete(category: string, uuid: string) {
    const filePath = path.join(StorageSubsystem.DATA_PATH, category, `${uuid}.json`);
    if (!fs.existsSync(filePath)) return;
    fs.removeSync(filePath);
  }
}
