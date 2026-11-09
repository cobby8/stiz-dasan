"use server";

/**
 * 상담 신청 서버 액션 (2026-11-10 원장 승인 k1·m4)
 *  - 공개(로그인 없음): submitConsultRequest — 홈페이지 /apply/consult · 챗봇 버튼(?from=chatbot)
 *  - 학부모(requireVerifiedParent): submitParentConsultRequest — 앱 «형제·자매 상담 신청»
 *  - 관리자(requireAdmin): updateConsultRequest — 신청함 상세 칸의 [연락함]·[완료]·[취소]·메모
 *
 * 규칙은 src/lib/consult/consult-rules.ts, 저장은 consult-service.ts(db 인자) 한 곳.
 * 접수되면 관리자 벨 + 웹푸시(notifyAdmins)만 — 문자는 보내지 않는다. 신청자에게는 «접수됐어요» 화면만.
 */
import { createHash } from "node:crypto";
import { after } from "next/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin, requireVerifiedParent } from "@/lib/auth-guard";
import { notifyAdmins } from "@/lib/notification";
import {
  consultAdminAlertText,
  publicConsultSource,
  type ConsultInput,
  type ConsultSource,
  type ConsultStatus,
} from "@/lib/consult/consult-rules";
import {
  CONSULT_INBOX_HREF,
  createConsultRequest,
  transitionConsultRequest,
  type CreateConsultResult,
} from "@/lib/consult/consult-service";

export type ConsultSubmitResult = { ok: true; duplicate: boolean } | { ok: false; message: string };

const SAVE_FAILED = "신청을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";

/** 접속 주소 지문 — 원문 IP 는 저장하지 않는다(체육관 대관과 같은 방식, 소금만 다르다) */
async function clientIpHash(): Promise<string | null> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "";
  if (!ip) return null;
  return createHash("sha256").update(`consult:${ip}`).digest("hex");
}

/** 저장 + 관리자 알림(응답을 먼저 돌려주고 알림은 뒤에서) */
async function saveAndNotify(input: ConsultInput, source: ConsultSource, requestedByUserId: string | null): Promise<ConsultSubmitResult> {
  const ipHash = await clientIpHash();
  const result: CreateConsultResult = await prisma.$transaction((tx) =>
    createConsultRequest(tx, input, { source, requestedByUserId, clientIpHash: ipHash }));
  if (!result.ok) return result;
  if (!result.duplicate) {
    const { id, value } = result;
    after(async () => {
      try {
        // 벨 + 웹푸시만(notifyCoaches:false · 문자 틀 없음). 본문에 연락처는 넣지 않는다(잠금 화면 노출 방지)
        await notifyAdmins("CONSULT_REQUEST", "상담 신청", consultAdminAlertText(value, source), CONSULT_INBOX_HREF, {
          notifyCoaches: false,
          eventId: id,
        });
      } catch (error) {
        console.error("[consult] 관리자 알림 실패:", (error as Error).message);
      }
    });
    revalidatePath("/admin/inbox");
    revalidatePath("/admin");
  }
  return { ok: true, duplicate: result.duplicate };
}

/** 공개 상담 신청 — 경로는 PUBLIC_WEB/CHATBOT 만(앱 신청인 척 못 한다). 계정 id 는 받지 않는다 */
export async function submitConsultRequest(input: ConsultInput & { honeypot?: string; source?: string }): Promise<ConsultSubmitResult> {
  // 스팸 방지: 숨김 칸에 값이 있으면 자동 입력으로 보고 저장하지 않는다(기존 공개 폼과 같은 방식)
  if (input?.honeypot) return { ok: false, message: SAVE_FAILED };
  try {
    return await saveAndNotify(input, publicConsultSource(input?.source), null);
  } catch (error) {
    console.error("[consult] 공개 신청 실패:", (error as Error).message);
    return { ok: false, message: SAVE_FAILED };
  }
}

/** 학부모 앱 상담 신청(형제·자매 등록 상담) — 로그인 학부모만, 신청 계정은 서버가 정한다 */
export async function submitParentConsultRequest(input: ConsultInput): Promise<ConsultSubmitResult> {
  let parentUserId: string;
  try {
    parentUserId = (await requireVerifiedParent()).appUserId;
  } catch {
    return { ok: false, message: "로그인이 풀렸어요. 다시 로그인한 뒤 신청해 주세요." };
  }
  try {
    return await saveAndNotify(input, "PARENT_APP", parentUserId);
  } catch (error) {
    console.error("[consult] 앱 신청 실패:", (error as Error).message);
    return { ok: false, message: SAVE_FAILED };
  }
}

export type ConsultUpdateResult = { ok: true; status: ConsultStatus } | { ok: false; message: string };

/**
 * 관리자 처리 — action: "CONTACTED"(연락함) | "DONE"(완료) | "CANCELED"(취소) | "NOTE"(메모만).
 * note 를 넘기면 메모도 함께 저장(빈 글자 = 메모 지움), 넘기지 않으면 메모는 그대로.
 */
export async function updateConsultRequest(id: string, action: string, note?: string | null): Promise<ConsultUpdateResult> {
  const admin = await requireAdmin(); // 권한이 없으면 여기서 오류(화면에 처리 결과를 주지 않는다)
  try {
    const result = await transitionConsultRequest(prisma, id, action, note === null ? "" : note, admin.appUserId);
    if (result.ok) {
      revalidatePath("/admin/inbox");
      revalidatePath("/admin");
    }
    return result;
  } catch (error) {
    console.error("[consult] 처리 실패:", (error as Error).message);
    return { ok: false, message: "처리하지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}
