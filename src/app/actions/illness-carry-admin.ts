"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { WorkbenchError } from "@/lib/billing/workbench";
import { loadWorkbenchCalendar } from "@/lib/billing/workbench-calendar";
import { isMakeupCreditIssuableYmd } from "@/lib/makeup/credit-service";
import { notifyParentsOfStudents } from "@/lib/notification";
import {
  approveIllnessCarry,
  convertIllnessToMakeupByAdmin,
  readIllnessCarryDetail,
  type IllnessCarryDetail,
} from "@/lib/regular/illness-carry-admin";

// 신청함 «질병·부상 결석» — 원장이 사유 글·증빙 사진을 보고 [이월 승인] / [보강권으로]를 고른다(2026-11-14 원장 결정 a3).
// 모두 requireAdmin(원장·부원장). 이월 적립은 기존 청구 준비 규칙(resolveWorkbenchAbsence)을 그대로 쓴다.
// 학부모에게는 앱 안 알림만 보낸다(문자·알림톡 없음). 사유 글(건강 정보)은 알림·로그에 싣지 않는다.

// 청구 준비 화면과 같은 스위치 — 꺼져 있으면 이월을 적립하지 않는다
const writesEnabled = () => process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  // 기존 이월 규칙이 알려 주는 사유(한국어)는 그대로 보인다. 그 밖의 오류는 이름만 기록한다
  if (error instanceof WorkbenchError) return { ok: false, message: error.message };
  console.error("[illness-carry-admin]", error instanceof Error ? error.name : "");
  return { ok: false, message: fallback };
}

/** 상세 칸을 열 때 — 사유 글·사진 id·승인 가능 여부 */
export async function loadIllnessCarryDetail(absenceId: string): Promise<{ ok: true; detail: IllnessCarryDetail } | { ok: false; message: string }> {
  await requireAdmin();
  try {
    const detail = await readIllnessCarryDetail(prisma, String(absenceId ?? "").trim(), writesEnabled());
    if (!detail) return { ok: false, message: "결석을 찾을 수 없거나 질병·부상 결석이 아닙니다." };
    return { ok: true, detail };
  } catch (error) {
    return failure(error, "내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.");
  }
}

/** [이월 승인] — 다음 달 수강료에서 1회분 차감(이월 적립). 이미 나간 보강권은 회수된다 */
export async function approveIllnessCarryAction(input: {
  absenceId: string; evidenceConfirmed: boolean; cancelReservation?: boolean;
}): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const calendar = await loadWorkbenchCalendar(true);
    const done = await approveIllnessCarry(
      prisma,
      { absenceId: String(input?.absenceId ?? "").trim(), evidenceConfirmed: input?.evidenceConfirmed === true, cancelReservation: input?.cancelReservation === true },
      admin.appUserId, writesEnabled(), calendar,
    );
    await notifyParentsOfStudents(
      [done.studentId], "ABSENCE", "결석 이월 승인",
      `${done.absenceYmd} 결석을 이월로 승인했어요. 다음 달 수강료에서 1회분을 빼 드려요.`,
      "/mypage/regular-absence",
    );
    revalidatePath("/admin/inbox");
    return { ok: true, message: "이월을 승인했습니다. 다음 달 청구에 «이월»로 차감됩니다." };
  } catch (error) {
    return failure(error, "이월을 승인하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}

/** [보강권으로] — 이월 대신 보강권 1장 */
export async function convertIllnessCarryAction(input: { absenceId: string }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const outcome = await convertIllnessToMakeupByAdmin(
      prisma, { absenceId: String(input?.absenceId ?? "").trim() }, admin.appUserId, isMakeupCreditIssuableYmd,
    );
    if (!outcome.converted) {
      const why: Record<string, string> = {
        NOT_FOUND: "결석을 찾을 수 없거나 취소된 결석입니다.",
        NOT_ILLNESS: "질병·부상 결석이 아닙니다.",
        DECIDED: "이미 처리가 끝난 결석입니다.",
        CARRY: "이미 이월로 정산된 결석입니다.",
      };
      return { ok: false, message: why[outcome.reason] ?? "보강권으로 바꾸지 못했습니다." };
    }
    await notifyParentsOfStudents(
      [outcome.studentId], "ABSENCE", "결석 보강권 안내",
      outcome.creditIssued
        ? `${outcome.absenceYmd} 결석은 보강권 1장으로 처리했어요. 보강을 예약할 수 있어요.`
        : `${outcome.absenceYmd} 결석은 보강권으로 처리했어요.`,
      "/mypage/makeup",
    );
    revalidatePath("/admin/inbox");
    return { ok: true, message: outcome.creditIssued ? "보강권 1장으로 바꿨습니다." : "보강권으로 처리했습니다(보강권은 이미 있거나 발급 대상이 아닙니다)." };
  } catch (error) {
    return failure(error, "보강권으로 바꾸지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}
