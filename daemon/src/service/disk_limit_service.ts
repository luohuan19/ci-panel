import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "util";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import { checkFilePath } from "../tools/filepath";
import { ConsumerQueue } from "../utils/queue";
import { sleep } from "../utils/sleep";

const execFileAsync = promisify(execFile);

interface IDiskLimitItem {
  instance: Instance;
  workspace: string;
  maxSpace: number;
}

// du -s --block-size=1M /docker-volumes/app1-logs | cut -f1
class DiskLimitService {
  private readonly queue = new ConsumerQueue<IDiskLimitItem>(2048);
  private task: NodeJS.Timeout | null = null;
  private checking: boolean = false;
  private concurrent = 2;

  constructor() {
    this.task = setInterval(() => {
      this.#startCheck();
    }, 1000 * 10);
  }

  async checkInstanceDiskSize(instance: Instance) {
    const workspace = instance.absoluteCwdPath();
    const maxSpace = Number(instance.config.docker.maxSpace);
    this.queue.push({
      key: instance.instanceUuid,
      item: {
        instance,
        workspace,
        maxSpace
      }
    });
    this.#startCheck();
  }

  async #startCheck() {
    if (this.checking) return;
    this.checking = true;
    try {
      const promises = [];
      for (let i = 0; i < this.concurrent; i++) {
        const item = this.queue.pop();
        if (item) {
          promises.push(this.checkDiskNow(item));
        }
      }
      await Promise.all(promises);
    } finally {
      this.checking = false;
    }
  }

  async #stopInstance(instance: Instance) {
    if (instance.status() === Instance.STATUS_RUNNING) {
      const startCount = instance.startCount;
      instance.execPreset("stop");
      await sleep(1000 * 10);
      if (instance.status() !== Instance.STATUS_STOP && startCount === instance.startCount) {
        instance.println("ERROR", $t("TXT_CODE_8418e7fe"));
        instance
          .execPreset("kill")
          .then(() => {})
          .catch((err) => {});
      }
    }
  }

  private getCheckDefaultValue(instance: Instance, maxSpace = 0) {
    instance.info.storageUsage = 0;
    instance.info.storageLimit = maxSpace;
    return {
      isFull: false,
      storageLimit: maxSpace,
      storageUsage: 0
    };
  }

  public async checkDiskNow(item: IDiskLimitItem, autoStop: boolean = true) {
    const { instance, workspace, maxSpace } = item;

    // global instance is not limited by disk space
    if (instance.isGlobalInstance() || workspace === "/" || workspace === "\\") {
      return this.getCheckDefaultValue(instance, maxSpace);
    }

    // Disk limit is not supported on Windows
    if (os.platform() === "win32") {
      return this.getCheckDefaultValue(instance, maxSpace);
    }

    // There was already an initial check on the working directory when saving,
    // but we double-check here.
    if (!checkFilePath(workspace) || !fs.existsSync(workspace)) {
      return this.getCheckDefaultValue(instance, maxSpace);
    }

    // execFile + 数组传参,不起 shell。此前是 `du -s --block-size=1M "${workspace}"` 走
    // exec:路径确实在双引号里,而 checkFilePath 又拦掉了 " $ ` —— 恰好就是能突破双引号的
    // 那几个,所以当时并不可利用。但那是「双引号」和「黑名单」两个条件同时成立才成立的结论,
    // 任意一方改动都会破防(比如有人为了支持带空格的路径去掉引号)。argv 形式不依赖任何一方。
    const { stdout } = await execFileAsync("du", ["-s", "--block-size=1M", workspace]);

    const diskUsageSizeMb = Number(String(stdout.split("/")[0]).replaceAll("\t", "").trim());

    if (isNaN(Number(diskUsageSizeMb))) {
      instance.info.storageUsage = 0;
      instance.info.storageLimit = convertGBToBytes(maxSpace); // GB to bytes
    } else {
      instance.info.storageUsage = diskUsageSizeMb * 1024 * 1024; // MB to bytes
      instance.info.storageLimit = convertGBToBytes(maxSpace); // GB to bytes
    }

    const storageLimit = instance.info.storageLimit;
    const storageUsage = instance.info.storageUsage;

    if (autoStop) {
      if (storageUsage >= storageLimit && storageLimit > 0) {
        for (let i = 0; i < 3; i++) {
          instance.println(
            "WARNING",
            $t("TXT_CODE_f94734d8", {
              storageLimit: convertBytesToGB(storageLimit),
              storageUsage: convertBytesToGB(storageUsage)
            })
          );
          instance.println("WARNING", $t("TXT_CODE_d448d98d"));
          await sleep(200);
        }
        this.#stopInstance(instance);
      }
    }

    return {
      isFull: storageUsage >= storageLimit && storageLimit > 0,
      storageLimit: convertBytesToGB(storageLimit),
      storageUsage: convertBytesToGB(storageUsage)
    };
  }
}

export function convertBytesToGB(bytes: number) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

export function convertGBToBytes(gb: number) {
  return Number((gb * 1024 * 1024 * 1024).toFixed(2));
}

export default new DiskLimitService();
