// CI Panel 扩展：读 runner 自带的 _diag 运行日志，给「看控制台」用。
//
// GitHub actions-runner 把自己的运行日志写在 <runner 目录>/_diag/ 下：
//   Runner_<时间>-utc.log  —— Listener 进程：连不连得上、领没领到 job、报什么错
//   Worker_<时间>-utc.log  —— 执行某个 job 时的进程日志
// 这些文件 runner 进程自己写、ci-runner 用户可读，所以不需要任何 sudo/journald 权限——
// systemd 托管的 runner 也能靠它在网页上看控制台，而不必去抓 journalctl。
//
// 支持增量跟随(tail -f 式)：客户端记住上次读到的字节偏移 nextOffset，下次带 offset 回来，
// 只回读新增的那一小段，前端追加到底部即可，既省流量又平滑。
//
// 全程只读。
import fs from "fs-extra";
import path from "path";

const DIAG_DIR = "_diag";
// 一次最多回读的字节数（从尾部倒读或增量读都受此限，避免一次吐几十 MB）
const MAX_TAIL_BYTES = 512 * 1024;
const DEFAULT_LINES = 400;
const MAX_LINES = 4000;

export interface DiagLogFile {
  name: string; // 文件名（仅 basename）
  size: number;
  mtime: number; // ms
}

export interface DiagLogResult {
  dir: string;
  files: DiagLogFile[]; // _diag 下所有 *.log，按修改时间倒序（最新在前）
  file: string; // 实际返回内容的文件名，空 = 没有日志
  content: string; // 这次返回的内容（初次=尾部；跟随=新增段）
  size: number; // 该文件当前总字节数
  nextOffset: number; // 下次跟随应从这里继续（= size）
  reset: boolean; // true = 文件被截断/轮转，客户端应清屏后用 content 重铺
  truncated: boolean; // 初次读时因超字节上限只取了尾部
}

export interface ReadDiagOptions {
  file?: string; // 指定文件；缺省挑最新 Runner_*.log
  lines?: number; // 初次读返回的行数
  offset?: number; // 增量跟随：从该字节偏移继续读
}

// 读文件某个字节区间
function readRange(file: string, start: number, len: number): string {
  if (len <= 0) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// 列出 _diag 下的日志文件，按修改时间倒序
function listDiagFiles(diagDir: string): DiagLogFile[] {
  const out: DiagLogFile[] = [];
  for (const name of fs.readdirSync(diagDir)) {
    if (!name.endsWith(".log")) continue;
    try {
      const st = fs.statSync(path.join(diagDir, name));
      if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* 文件可能刚被轮转掉，跳过 */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 读某个 runner 目录的 _diag 日志。
// file 缺省挑「最新的 Runner_*.log」；只接受 basename 且必须在文件列表里，防路径穿越。
export function readRunnerDiag(dirRaw: string, opts: ReadDiagOptions = {}): DiagLogResult {
  const dir = path.normalize(String(dirRaw || ""));
  if (!path.isAbsolute(dir) || dir === "/") throw new Error("目录必须是绝对路径且不能是 /");
  const diagDir = path.join(dir, DIAG_DIR);
  if (!fs.existsSync(diagDir) || !fs.statSync(diagDir).isDirectory())
    throw new Error("该 runner 还没有 _diag 日志（可能从未运行过）");

  const files = listDiagFiles(diagDir);
  const empty = { dir, files, file: "", content: "", size: 0, nextOffset: 0, reset: false, truncated: false };
  if (files.length === 0) return empty;

  // 选目标文件
  let target = "";
  const wanted = (opts.file || "").trim();
  if (wanted) {
    if (wanted.includes("/") || wanted.includes("\\") || wanted.includes(".."))
      throw new Error("非法的日志文件名");
    if (!files.some((f) => f.name === wanted)) throw new Error(`日志文件不存在: ${wanted}`);
    target = wanted;
  } else {
    target = files.find((f) => f.name.startsWith("Runner_"))?.name || files[0].name;
  }

  const targetPath = path.join(diagDir, target);
  const size = fs.statSync(targetPath).size;
  const offset = opts.offset;

  // 增量跟随：给了合法 offset 且指定了具体文件
  if (typeof offset === "number" && offset >= 0 && wanted) {
    if (offset > size) {
      // 文件被截断/轮转，重来：回尾部内容并让客户端清屏
      const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
      return {
        dir,
        files,
        file: target,
        content: readRange(targetPath, start, size - start),
        size,
        nextOffset: size,
        reset: true,
        truncated: start > 0
      };
    }
    // 只读 offset..EOF；若增量本身超上限，只取尾部那段
    const avail = size - offset;
    const len = Math.min(avail, MAX_TAIL_BYTES);
    const start = size - len;
    return {
      dir,
      files,
      file: target,
      content: readRange(targetPath, start, len),
      size,
      nextOffset: size,
      reset: start > offset, // 中间跳过了一段，等价于一次小 reset
      truncated: false
    };
  }

  // 初次读：返回尾部 N 行
  const n = Math.min(Math.max(1, Number(opts.lines) || DEFAULT_LINES), MAX_LINES);
  const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
  const text = readRange(targetPath, start, size - start);
  let allLines = text.split("\n");
  if (start > 0 && allLines.length > 1) allLines = allLines.slice(1); // 丢掉尾部截断的半截首行
  const content = allLines.slice(-n).join("\n");

  return { dir, files, file: target, content, size, nextOffset: size, reset: false, truncated: start > 0 };
}
