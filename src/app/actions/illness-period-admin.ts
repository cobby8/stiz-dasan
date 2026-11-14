"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { notifyParentsOfStudents } from "@/lib/notification";
import {
  approveIllnessPeriod,
  cancelIllnessPeriodApproval,
  readIllnessPeriodDetail,
  type IllnessPeriodDetail,
} from "@/lib/regular/illness-period-admin";
import { IllnessPeriodError, PERIOD_APPROVED_PARENT_NOTE, periodRangeText } from "@/lib/regular/illnessPeriodRules";

// 신청함 «부상 결석(기간)» — 원장이 기간 전체의 사유 글·증빙 사진을 보고 [부상 결석 승인]을 누른다(2026-11-15 원장 승인).
// 승인은 금액 없이 «인정»만 기록한다 — 돈이 움직이지 않아 청구 준비 저장 스위치와 무관하다. 금액은 복귀 뒤 한 번에 정산한다.
// 모두 requireAdmin(원장·부원장). 이 단계 화면에는 금액이 없다.
// 학부모에게는 앱 안 알림만 보낸다(문자·알림톡 없음). 사유 글(건강 정보)은 알림·로그에 싣지 않는다.

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  // 규칙이 알려 주는 사유(한국어)는 그대로 보인다. 그 밖의 오류는 이름만 기록한다
  if (error instanceof IllnessPeriodError) return { ok: false, message: error.message };
  console.error("[illness-period-admin]", error instanceof Error ? error.name : "");
  return { ok: false, message: fallback };
}

/** 학부모 앱 알림. 실패해도 던지지 않고 false — 이미 저장된 승인 결과를 뒤집지 않는다 */
async function notifyParentSafely(studentId: string, title: string, message: string): Promise<boolean> {
  try {
    await notifyParentsOfStudents([studentId], "ABSENCE", title, message, "/mypage/regular-absence");
    return true;
  } catch (error) {
    console.error("[illness-period-admin] 학부모 알림 실패:", error instanceof Error ? error.name : "");
    return false;
  }
}

/** 상세 칸을 열 때 — 기간·사유 글·사진 id·승인 가능 여부 */
export async function loadIllnessPeriodDetail(periodId: string): Promise<{ ok: true; detail: IllnessPeriodDetail } | { ok: false; message: string }> {
  await requireAdmin();
  try {
    const detail = await readIllnessPeriodDetail(prisma, String(periodId ?? "").trim());
    if (!detail) return { ok: false, message: "기간 결석을 찾을 수 없거나 질병·부상 기간이 아닙니다." };
    return { ok: true, detail };
  } catch (error) {
    return failure(error, "내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.");
  }
}

/** [부상 결석 승인] — 금액 없이 인정만. 7일 자동 보강권 전환이 멈추고 미사용 보강권은 거둬 둔다 */
export async function approveIllnessPeriodAction(input: { periodId: string; evidenceConfirmed: boolean }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const done = await approveIllnessPeriod(
      prisma,
      { periodId: String(input?.periodId ?? "").trim(), evidenceConfirmed: input?.evidenceConfirmed === true },
      admin.appUserId,
    );
    // 승인은 이미 저장됐다 — 알림이 실패해도 «승인 실패»로 보이면 원장이 다시 누르게 된다. 결과 글에만 알린다
    const notified = await notifyParentSafely(
      done.studentId, "부상 결석 인정",
      `${periodRangeText(done.startDate, done.returnDate)} 결석을 부상 결석으로 인정했어요. ${PERIOD_APPROVED_PARENT_NOTE}`,
    );
    revalidatePath("/admin/inbox");
    return { ok: true, message: `부상 결석으로 승인했습니다. 금액은 복귀한 뒤 한 번에 정산해요.${notified ? "" : " 승인됐지만 학부모 알림은 못 보냈어요."}` };
  } catch (error) {
    return failure(error, "승인하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}

/** [승인 취소] — 금액을 정하기 전에만. 날짜마다 다시 «검토 중»이 되고 사진 기한(7일)이 새로 시작한다 */
export async function cancelIllnessPeriodApprovalAction(input: { periodId: string }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    await cancelIllnessPeriodApproval(prisma, { periodId: String(input?.periodId ?? "").trim() }, admin.appUserId);
    revalidatePath("/admin/inbox");
    return { ok: true, message: "승인을 취소했습니다. 다시 «승인 대기»로 돌아갑니다." };
  } catch (error) {
    return failure(error, "승인을 취소하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}
