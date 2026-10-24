import { createHmac } from "crypto";
import type { GenerationConfig } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";
import { GEMINI_CHAT_MODEL, getGeminiClient } from "@/lib/gemini-client";
import {
  POLICY_DOCUMENT_MAX,
  buildFallbackPolicyDocument,
  isPolicyQuotaAvailable,
  type KakaoReply,
  type PolicyQuotaCounts,
  type PolicyFlowDeps,
  type PolicyGenerate,
  type PolicyQaLogInput,
} from "@/lib/kakao-policy-qa";

// ── 카카오 정책 답변: DB·Gemini·콜백 전송 연결부(서버 전용) ─────────────
// 판단 로직은 순수 모듈(@/lib/kakao-policy-qa)에 있고, 여기서는 실제 부품만 끼운다.

/** 정책 답변을 막는 환경 사유. null 이면 DB 설정(켜짐/꺼짐)을 따른다. */
export function policyQaEnvBlock(): "ENV_DISABLED" | "NO_GEMINI_KEY" | null {
  // 긴급 정지: Vercel 환경변수 KAKAO_POLICY_QA_DISABLED=1 이면 DB 설정과 무관하게 꺼진다
  if (process.env.KAKAO_POLICY_QA_DISABLED?.trim() === "1") return "ENV_DISABLED";
  if (!getGeminiClient()) return "NO_GEMINI_KEY";
  return null;
}

/** 정책 문서가 비었을 때 대체 문서(이용약관 + 공개 FAQ) */
export async function loadFallbackPolicyDocument(): Promise<string> {
  const [settings, faqs] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ termsOfService: string | null }>>(
      `SELECT "termsOfService" FROM "AcademySettings" WHERE id = 'singleton' LIMIT 1`,
    ),
    prisma.$queryRawUnsafe<Array<{ question: string; answer: string }>>(
      `SELECT question, answer FROM "Faq" WHERE "isPublic" = true ORDER BY "order" ASC LIMIT 100`,
    ),
  ]);
  return buildFallbackPolicyDocument(settings[0]?.termsOfService ?? null, faqs);
}

/**
 * 켜져 있으면 프롬프트에 넣을 문서를, 꺼져 있으면 null.
 * 테이블이 아직 없거나(마이그레이션 전) 어떤 오류든 나면 "꺼짐"으로 본다 — 기존 동작이 가장 안전하다.
 */
export async function loadActivePolicyRuntime(): Promise<{ document: string } | null> {
  if (policyQaEnvBlock()) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ enabled: boolean; content: string | null }>>(
      `SELECT s.enabled,
              (SELECT v.content FROM "KakaoPolicyDocumentVersion" v ORDER BY v."createdAt" DESC LIMIT 1) AS content
         FROM "KakaoPolicyQaSetting" s WHERE s.id = 'default' LIMIT 1`,
    );
    if (rows[0]?.enabled !== true) return null;
    const content = rows[0].content?.trim();
    return { document: content ? content.slice(0, POLICY_DOCUMENT_MAX) : await loadFallbackPolicyDocument() };
  } catch (error) {
    console.error("[kakao policy qa] runtime load failed:", error instanceof Error ? error.message : "UNKNOWN");
    return null;
  }
}

/** Gemini 생성 함수. thinking 을 꺼서(thinkingBudget 0) 지연을 줄인다. 키가 없으면 null. */
export function geminiPolicyGenerate(): PolicyGenerate | null {
  const client = getGeminiClient();
  if (!client) return null;
  return async ({ systemPrompt, userPrompt, signal }) => {
    // SDK 0.24.1 타입에는 thinkingConfig 가 없지만 generationConfig 는 요청 본문에 그대로 실린다(REST API 는 지원).
    const generationConfig = {
      temperature: 0.2,
      maxOutputTokens: 512,
      thinkingConfig: { thinkingBudget: 0 },
    } as GenerationConfig;
    const model = client.getGenerativeModel({ model: GEMINI_CHAT_MODEL, systemInstruction: systemPrompt, generationConfig });
    const result = await model.generateContent(
      { contents: [{ role: "user", parts: [{ text: userPrompt }] }] },
      { signal },
    );
    return result.response.text();
  };
}

/** 기록용 사용자키 해시. 연결 식별용 해시와 섞이지 않게 용도 문자열을 붙여 따로 만든다(원문 저장 금지). */
export function hashPolicyUserKey(botId: string, userKey: string): string {
  const secret = process.env.KAKAO_CHATBOT_IDENTITY_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("KAKAO_CHATBOT_IDENTITY_SECRET_MISSING");
  return createHmac("sha256", secret).update(`kakao-policy-log:v1:${botId}:${userKey}`).digest("hex");
}

export async function recordPolicyQaLog(log: PolicyQaLogInput): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "KakaoPolicyQaLog" (question, answer, outcome, mode, linked, "latencyMs", "userKeyHash", "callbackOk")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [...log.question].slice(0, 500).join(""), log.answer, log.outcome, log.mode, log.linked,
      Math.min(2_147_483_647, Math.max(0, Math.round(log.latencyMs))), log.userKeyHash, log.callbackOk,
    );
  } catch (error) {
    console.error("[kakao policy qa] log failed:", error instanceof Error ? error.message : "UNKNOWN");
  }
}

/**
 * 비용 남용 한도에서 쓸 수를 센다(기준 = KakaoPolicyQaLog).
 * - 같은 사용자: 최근 1분 / 최근 24시간
 * - 전체: KST 오늘 0시부터. "createdAt" 은 timestamptz 라 시간대 변환은 한 번만 건다 —
 *   now() 를 KST 벽시계로 바꿔 0시로 자른 뒤, 그 KST 0시를 다시 timestamptz 로 되돌려 컬럼과 그대로 비교한다
 *   (컬럼 쪽은 변환하지 않아 인덱스를 탄다).
 */
export const POLICY_QUOTA_SQL = `
  SELECT
    count(*) FILTER (WHERE "userKeyHash" = $1 AND "createdAt" > now() - interval '1 minute')::int AS "userLastMinute",
    count(*) FILTER (WHERE "userKeyHash" = $1 AND "createdAt" > now() - interval '24 hours')::int AS "userLast24h",
    count(*) FILTER (WHERE "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'))::int AS "globalKstToday"
  FROM "KakaoPolicyQaLog"
  WHERE "createdAt" >= LEAST(now() - interval '24 hours', date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;

/** 한도 안이면 true. 셀 수 없으면(테이블 없음·오류) false — 정책 답변을 건너뛰고 기존 흐름으로 간다. */
export async function checkPolicyQuota(userKeyHash: string): Promise<boolean> {
  try {
    const rows = await prisma.$queryRawUnsafe<PolicyQuotaCounts[]>(POLICY_QUOTA_SQL, userKeyHash);
    const row = rows[0];
    return Boolean(row) && isPolicyQuotaAvailable({
      userLastMinute: Number(row.userLastMinute), userLast24h: Number(row.userLast24h), globalKstToday: Number(row.globalKstToday),
    });
  } catch (error) {
    console.error("[kakao policy qa] quota check failed:", error instanceof Error ? error.message : "UNKNOWN");
    return false;
  }
}

/** 카카오 callbackUrl 로 최종 응답을 보낸다(10초 제한). 성공 여부만 돌려준다. */
export async function postKakaoCallback(url: string, body: KakaoReply): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 다른 주소로 넘겨도(리다이렉트) 따라가지 않는다 — 허용한 카카오 주소에만 보낸다
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch (error) {
    console.error("[kakao policy qa] callback failed:", error instanceof Error ? error.message : "UNKNOWN");
    return false;
  }
}

/** 실제 부품을 끼운 흐름 의존성. schedule 은 라우트에서 Next.js after() 를 넣는다. */
export function realPolicyFlowDeps(schedule: PolicyFlowDeps["schedule"]): PolicyFlowDeps {
  return {
    loadRuntime: loadActivePolicyRuntime,
    checkQuota: checkPolicyQuota,
    generate: geminiPolicyGenerate(),
    record: recordPolicyQaLog,
    postCallback: postKakaoCallback,
    schedule,
  };
}

// ── 관리자 화면용 ──────────────────────────────────────────────────
export type PolicyDocumentVersionRow = { id: string; content: string; editorName: string | null; createdAt: Date };
export type PolicyQaLogRow = PolicyQaLogInput & { id: string; createdAt: Date };

export async function loadPolicyAdminState() {
  const [settingRows, versions, logs] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ enabled: boolean; updatedByName: string | null; updatedAt: Date }>>(
      `SELECT enabled, "updatedByName", "updatedAt" FROM "KakaoPolicyQaSetting" WHERE id = 'default' LIMIT 1`,
    ),
    prisma.$queryRawUnsafe<PolicyDocumentVersionRow[]>(
      `SELECT id, content, "editorName", "createdAt" FROM "KakaoPolicyDocumentVersion" ORDER BY "createdAt" DESC LIMIT 20`,
    ),
    prisma.$queryRawUnsafe<PolicyQaLogRow[]>(
      `SELECT id, question, answer, outcome, mode, linked, "latencyMs", "userKeyHash", "callbackOk", "createdAt"
         FROM "KakaoPolicyQaLog" ORDER BY "createdAt" DESC LIMIT 100`,
    ),
  ]);
  return { setting: settingRows[0] ?? null, versions, logs };
}
