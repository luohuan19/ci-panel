// 原 MCSManager 的“快速开始/模板市场”流程已移除。
// 这里仅保留两个创建实例仍在使用的枚举（CreateInstanceForm / CreateInstanceOptions /
// CmdAssistantDialog 引用），流程逻辑 useQuickStartFlow() 已随 QuickStartFlow.vue 一起删除。

export enum QUICKSTART_ACTION_TYPE {
  Minecraft = "minecraft",
  Bedrock = "bedrock",
  Hytale = "hytale",
  Terraria = "terraria",
  SteamGameServer = "steam",
  Docker = "docker",
  AnyApp = "universal"
}

export enum QUICKSTART_METHOD {
  FAST = "FAST",
  FILE = "FILE",
  IMPORT = "IMPORT",
  SELECT = "SELECT",
  EXIST = "EXIST",
  DOCKER = "DOCKER"
}
