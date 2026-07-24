// 原 MCSManager 的“快速开始/模板市场”流程已移除。
// 这里仅保留创建实例仍在使用的方式枚举（CreateInstanceForm / CreateInstanceOptions 引用）。

export enum QUICKSTART_METHOD {
  FAST = "FAST",
  FILE = "FILE",
  IMPORT = "IMPORT",
  SELECT = "SELECT",
  EXIST = "EXIST",
  DOCKER = "DOCKER"
}
