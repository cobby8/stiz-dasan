import { requireAdmin } from "@/lib/auth-guard";
import { loadFallbackPolicyDocument, loadPolicyAdminState, policyQaEnvBlock } from "@/lib/kakao-policy-qa-service";
import KakaoPolicyClient, { type PolicyLogView, type PolicyVersionView } from "./KakaoPolicyClient";

export const dynamic = "force-dynamic";

/**
 * 카카오 정책 답변 관리 — 원장 전용.
 * 탭 1) 정책 문서: 챗봇이 답할 때 보는 문서를 고친다(저장할 때마다 이력이 쌓인다) + 켜기/끄기
 * 탭 2) 답변 기록: 최근 질문·답·결과
 */

function isSchemaNotReady(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return ["42P01", "42703"].includes(code) || /KakaoPolicy\w*.*(?:does not exist|존재하지)/i.test(message);
}

export default async function KakaoPolicyPage({ searchParams }: { searchParams?: Promise<{ tab?: string }> }) {
  await requireAdmin();
  const tab = (await searchParams)?.tab === "logs" ? "logs" : "document";
  let schemaReady = true;
  let enabled = false;
  let settingUpdatedBy: string | null = null;
  let settingUpdatedAt: string | null = null;
  let versions: PolicyVersionView[] = [];
  let logs: PolicyLogView[] = [];
  try {
    const state = await loadPolicyAdminState();
    enabled = state.setting?.enabled === true;
    settingUpdatedBy = state.setting?.updatedByName ?? null;
    settingUpdatedAt = state.setting?.updatedByName ? state.setting.updatedAt.toISOString() : null;
    versions = state.versions.map((row) => ({ id: row.id, content: row.content, editorName: row.editorName, createdAt: row.createdAt.toISOString() }));
    logs = state.logs.map((row) => ({
      id: row.id, question: row.question, answer: row.answer, outcome: row.outcome, mode: row.mode,
      linked: row.linked, latencyMs: row.latencyMs, callbackOk: row.callbackOk, createdAt: row.createdAt.toISOString(),
    }));
  } catch (error) {
    if (!isSchemaNotReady(error)) throw error;
    schemaReady = false;
  }
  // 문서가 비어 있을 때 챗봇이 대신 쓰는 내용(이용약관 + 공개 FAQ)을 미리 보여준다
  const fallbackPreview = schemaReady && !versions[0]?.content.trim() ? await loadFallbackPolicyDocument().catch(() => "") : "";

  return (
    <KakaoPolicyClient
      tab={tab}
      schemaReady={schemaReady}
      enabled={enabled}
      settingUpdatedBy={settingUpdatedBy}
      settingUpdatedAt={settingUpdatedAt}
      envBlock={policyQaEnvBlock()}
      versions={versions}
      logs={logs}
      fallbackPreview={fallbackPreview}
    />
  );
}
