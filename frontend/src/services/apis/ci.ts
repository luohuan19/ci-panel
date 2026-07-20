// CI Job 看板接口（自研补充，对应 panel 的 /api/ci 路由）
import { useDefineApi } from "@/stores/useDefineApi";

export interface CiRun {
  id: number;
  name: string;
  branch: string;
  event: string;
  status: string; // queued / in_progress / completed
  conclusion: string | null; // success / failure / cancelled ...
  run_number: number;
  html_url: string;
  created_at: string;
}

export const ciRepos = useDefineApi<any, string[]>({
  url: "/api/ci/repos",
  method: "GET"
});

export const ciRuns = useDefineApi<{ params?: { repo?: string } }, CiRun[]>({
  url: "/api/ci/runs",
  method: "GET"
});

export const ciDispatch = useDefineApi<
  { data: { repo: string; workflow: string; ref?: string } },
  { ok: boolean }
>({
  url: "/api/ci/dispatch",
  method: "POST"
});
