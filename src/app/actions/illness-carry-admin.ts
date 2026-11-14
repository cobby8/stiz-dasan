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

const NOTIFY_FAILED_NOTE = " 승인됐지만 학부모 알림은 못 보냈어요.";

/** 학부모 앱 알림(문자·알림톡 없음). 실패해도 던지지 않고 false — 이미 저장된 승인 결과를 뒤집지 않는다 */
async function notifyParentSafely(studentId: string, title: string, message: string): Promise<boolean> {
  try {
    await notifyParentsOfStudents([studentId], "ABSENCE", title, message, "/mypage/regular-absence");
    return true;
  } catch (error) {
    console.error("[illness-carry-admin] 학부모 알림 실패:", error instanceof Error ? error.name : "");
    return false;
  }
}

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
    // 승인은 이미 저장됐다 — 알림이 실패해도 «승인 실패»로 보이면 원장이 다시 누르게 된다. 결과 글에만 알린다
    const notified = await notifyParentSafely(
      done.studentId, "결석 이월 승인",
      `${done.absenceYmd} 결석을 이월로 승인했어요. 다음 달 수강료에서 1회분을 빼 드려요.`,
    );
    revalidatePath("/admin/inbox");
    return { ok: true, message: `이월을 승인했습니다. 다음 달 청구에 «이월»로 차감됩니다.${notified ? "" : NOTIFY_FAILED_NOTE}` };
  } catch (error) {
    return failure(error, "이월을 승인하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}

/**
 * [같은 기간 n건 함께 승인] — 학부모가 «여러 날»로 알린 질병·부상 결석 중 결석일이 지난 것들을 한 번에 이월 승인한다.
 * 건마다 [이월 승인]과 같은 함수·같은 거래로 처리한다(한 건이 조건에 안 맞아도 나머지는 승인). 대상은 서버가 다시 고른다.
 * 학부모 앱 알림은 묶어서 1회.
 */
export async function approveIllnessCarryPeriodAction(input: { absenceId: string; evidenceConfirmed: boolean }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const absenceId = String(input?.absenceId ?? "").trim();
    if (input?.evidenceConfirmed !== true) return { ok: false, message: "증빙을 확인했는지 체크해 주세요." };
    const detail = await readIllnessCarryDetail(prisma, absenceId, writesEnabled());
    if (!detail) return { ok: false, message: "결석을 찾을 수 없거나 질병·부상 결석이 아닙니다." };
    // 화면이 보낸 목록을 믿지 않고 서버가 읽은 «같은 기간·결석일 지남·결정 전» 목록으로 처리한다(지금 연 결석 포함)
    const targets = [...(detail.status === "PENDING" && !detail.blocker ? [absenceId] : []), ...detail.periodPeerIds];
    if (targets.length === 0) return { ok: false, message: detail.blocker ?? "함께 승인할 결석이 없습니다." };
    const calendar = await loadWorkbenchCalendar(true);
    const done: Array<{ studentId: string; absenceYmd: string }> = [];
    const failed: string[] = [];
    for (const id of targets) {
      try {
        // 보강 예약이 있는 결석은 함께 취소 확인이 필요해 여기서 넘기지 않는다 — 그 건은 실패 사유로 남아 따로 승인한다
        done.push(await approveIllnessCarry(prisma, { absenceId: id, evidenceConfirmed: true }, admin.appUserId, writesEnabled(), calendar));
      } catch (error) {
        failed.push(failure(error, "승인하지 못했습니다.").message);
      }
    }
    let notified = true;
    if (done.length > 0) {
      const days = done.map((item) => item.absenceYmd).sort();
      notified = await notifyParentSafely(
        done[0].studentId, "결석 이월 승인",
        days.length === 1
          ? `${days[0]} 결석을 이월로 승인했어요. 다음 달 수강료에서 1회분을 빼 드려요.`
          : `${days[0]}~${days[days.length - 1]} 결석 ${days.length}회를 이월로 승인했어요. 다음 달 수강료에서 ${days.length}회분을 빼 드려요.`,
      );
    }
    revalidatePath("/admin/inbox");
    if (done.length === 0) return { ok: false, message: failed[0] ?? "승인하지 못했습니다." };
    return {
      ok: true,
      message: failed.length
        ? `${done.length}건 이월 승인 · ${failed.length}건은 승인하지 못했습니다(${failed[0]})${notified ? "" : NOTIFY_FAILED_NOTE}`
        : `${done.length}건을 이월 승인했습니다. 다음 달 청구에 «이월»로 차감됩니다.${notified ? "" : NOTIFY_FAILED_NOTE}`,
    };
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
        ATTENDED: "그날 출석(지각)으로 기록돼 있어 보강권을 줄 수 없습니다. 출결을 확인하거나 결석 신고를 취소해 주세요.",
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
