"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { prisma } from "@/lib/prisma";
import { notifyParentsOfStudents } from "@/lib/notification";
import { parentNoticeSentRecently, readStudentName } from "@/lib/regular/illness-period-admin";
import { IllnessPeriodError, periodRefundDoneParentText, periodRefundReviewParentText } from "@/lib/regular/illnessPeriodRules";
import {
  cancelIllnessPeriodRefundReview, markIllnessPeriodRefundDone, previewIllnessPeriodRefund, readIllnessPeriodWithdrawal, readRefundIllnessPeriod,
  sendIllnessPeriodToRefundReview,
} from "@/lib/regular/illness-period-refund";
import { buildRefundView, type IllnessPeriodRefundView } from "@/lib/regular/illnessPeriodRefundView";
import { settlementContext, settlementWritesEnabled } from "@/lib/regular/illness-period-settlement-runner";

// 신청함 «부상 결석(기간)» — 퇴원 정산 = 환불 검토(4단계, 2026-11-15 원장 결정).
// 부상 결석 중에 복귀하지 않고 퇴원하면 복귀 정산과 같은 계산으로 표를 만들어 «환불 검토 ○원»으로 올린다.
// ★ 여기 액션은 돈을 움직이지 않는다 — 환불은 원장이 수납 관리의 «환불»로 직접 하고, 끝나면 «환불 처리함»(메모)으로 닫는다.
// 미리보기는 원장·부원장이 열 수 있지만 금액·지문은 원장에게만 내려보낸다(buildRefundView 한 곳).
// 넘기기·환불 처리함·환불 검토 취소는 원장만(requireOwner). 학부모에게는 앱 안 알림만 보낸다(새 연락 수단을 만들지 않는다).

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  // 규칙이 알려 주는 사유(한국어)는 그대로 보인다. 그 밖의 오류는 이름만 기록한다
  if (error instanceof IllnessPeriodError) return { ok: false, message: error.message };
  if (error instanceof Error && error.name === "WorkbenchError") return { ok: false, message: error.message };
  console.error("[illness-period-refund]", error instanceof Error ? error.name : "");
  return { ok: false, message: fallback };
}

/**
 * 학부모 앱 알림 — 같은 학부모에게 같은 제목·같은 본문을 최근 24시간 안에 보냈으면 다시 보내지 않는다(기존 중복 방지 함수 그대로).
 * 넘기기 → 취소 → 다시 넘기기를 되풀이해도 알림이 쌓이지 않는다. 알림 함수는 실패해도 던지지 않는다.
 */
async function notifyParentOnce(studentId: string, title: string, message: string): Promise<void> {
  const already = await parentNoticeSentRecently(prisma, { studentId, title, message }).catch(() => false);
  if (already) return;
  await notifyParentsOfStudents([studentId], "ABSENCE", title, message, "/mypage/regular-absence");
}

/** 알림 본문 앞에 붙일 «아이 이름 · » — 형제가 같은 금액이어도 본문이 달라 아이마다 알림이 간다 */
async function childPrefix(studentId: string): Promise<string> {
  const name = await readStudentName(prisma, studentId).catch(() => "");
  return name ? `${name} · ` : "";
}

/** 환불 검토·환불 처리 뒤 다시 그릴 화면 — 신청함·수납 관리·학생 상세·결석 관리·학부모 화면 */
function revalidateRefundViews(): void {
  revalidatePath("/admin/inbox");
  revalidatePath("/admin/finance");
  revalidatePath("/admin/students/[id]", "page");
  revalidatePath("/admin/absence");
  revalidatePath("/mypage");
}

/** 신청함 기간 상세가 «퇴원 정산» 길로 갈지 정한다 — 대상 반이 모두 수강 종료됐는가 · 다른 반은 아직 다니는가. 금액 없음 */
export async function loadIllnessPeriodWithdrawal(periodId: string): Promise<{ ok: true; withdrawn: boolean; stillEnrolled: boolean } | { ok: false; message: string }> {
  await requireAdmin();
  try {
    const id = String(periodId ?? "").trim();
    if (!id || id.length > 200) return { ok: false, message: "기간 결석을 찾을 수 없습니다." };
    return { ok: true, ...(await readIllnessPeriodWithdrawal(prisma, id)) };
  } catch (error) {
    return failure(error, "수강 상태를 확인하지 못했습니다. 잠시 뒤 다시 열어 주세요.");
  }
}

/**
 * 퇴원 정산 칸을 열 때 — 넘기기 전이면 미리보기(오늘까지 빠진 수업 기준), 넘긴 뒤면 그때의 표 사본.
 * 금액 칸과 지문은 금액을 볼 수 있는 역할(원장)에게만 채운다 — 부원장 응답에는 없다.
 */
export async function loadIllnessPeriodRefund(input: {
  periodId: string; omitAbsenceIds?: string[];
}): Promise<{ ok: true; settlement: IllnessPeriodRefundView } | { ok: false; message: string }> {
  const admin = await requireAdmin();
  const money = canSeeAllMoney(admin.appUserRole);
  const periodId = String(input?.periodId ?? "").trim();
  try {
    const stored = await readRefundIllnessPeriod(prisma, periodId);
    if (stored) {
      return { ok: true, settlement: buildRefundView({
        stage: stored.carryState === "REFUND_DONE" ? "DONE" : "REVIEW", money, writesEnabled: settlementWritesEnabled(), studentId: stored.studentId,
        rows: stored.rows, total: stored.refundTotal, unpaidGuides: stored.unpaidGuides,
        fingerprint: null, countUntil: null, storedReturnDate: null, blockers: [], needsHold: false, memo: stored.memo,
      }) };
    }
    const preview = await previewIllnessPeriodRefund(
      prisma,
      { periodId, omitAbsenceIds: Array.isArray(input?.omitAbsenceIds) ? input.omitAbsenceIds.map(String) : [] },
      await settlementContext(admin.appUserId),
    );
    return { ok: true, settlement: buildRefundView({
      stage: "PREVIEW", money, writesEnabled: settlementWritesEnabled(), studentId: preview.studentId,
      rows: preview.plan.rows, total: preview.plan.carryTotal, unpaidGuides: preview.plan.unpaidGuides,
      fingerprint: preview.fingerprint, countUntil: preview.returnDate, storedReturnDate: preview.storedReturnDate,
      blockers: preview.blockers, needsHold: preview.plan.problems.some((problem) => problem.code === "OPEN_BILL"), memo: null,
    }) };
  } catch (error) {
    return failure(error, "정산 내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.");
  }
}

/**
 * [환불 검토로 넘기기] — 원장만. 화면에서 본 표의 지문을 함께 받아, 잠근 뒤 다시 계산한 표와 다르면 실행하지 않는다.
 * 금액은 서버가 다시 계산한다(화면이 보낸 금액을 받지 않는다). 환불은 실행되지 않는다.
 * 학부모에게는 앱 안 알림 1회(24시간 중복 방지).
 */
export async function sendIllnessPeriodRefundReviewAction(input: {
  periodId: string; omitAbsenceIds?: string[]; expectedFingerprint: string;
}): Promise<ActionResult> {
  // 원장 확인 — 부원장·그 밖은 여기서 끝난다(화면에서 버튼을 숨기는 것과 별개로 서버가 막는다)
  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try { owner = await requireOwner(); } catch { return { ok: false, message: "환불 검토로 넘기기는 원장만 할 수 있습니다." }; }
  try {
    const done = await sendIllnessPeriodToRefundReview(
      prisma,
      {
        periodId: String(input?.periodId ?? "").trim(),
        omitAbsenceIds: Array.isArray(input?.omitAbsenceIds) ? input.omitAbsenceIds.map(String) : [],
        expectedFingerprint: String(input?.expectedFingerprint ?? ""),
      },
      owner.appUserId, settlementWritesEnabled(),
      // 넘기기 직전에는 공식 일정을 새로 읽는다(복귀 정산 확정과 같다)
      await settlementContext(owner.appUserId, true),
    );
    await notifyParentOnce(done.studentId, "부상 결석 환불 검토", `${await childPrefix(done.studentId)}${periodRefundReviewParentText(done.refundTotal)}`);
    revalidateRefundViews();
    return {
      ok: true,
      message: `환불 검토 ${done.refundTotal.toLocaleString("ko-KR")}원으로 넘겼습니다(결석 ${done.refundAbsences}회). 수납 관리에서 환불한 뒤 ‹환불 처리함›을 눌러 주세요.`,
    };
  } catch (error) {
    return failure(error, "환불 검토로 넘기지 못했습니다. 표를 다시 확인한 뒤 눌러 주세요.");
  }
}

/**
 * [환불 처리함] — 원장만. 수납 관리에서 환불을 마친 뒤 메모와 함께 닫는다. 여기서 환불이 실행되지 않는다(기록만).
 * 학부모에게는 앱 안 알림 1회(24시간 중복 방지).
 */
export async function markIllnessPeriodRefundDoneAction(input: { periodId: string; memo: string }): Promise<ActionResult> {
  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try { owner = await requireOwner(); } catch { return { ok: false, message: "환불 처리함은 원장만 할 수 있습니다." }; }
  try {
    const done = await markIllnessPeriodRefundDone(
      prisma, { periodId: String(input?.periodId ?? "").trim(), memo: String(input?.memo ?? "") }, owner.appUserId,
    );
    await notifyParentOnce(done.studentId, "부상 결석 환불 처리", `${await childPrefix(done.studentId)}${periodRefundDoneParentText(done.refundTotal)}`);
    revalidateRefundViews();
    return { ok: true, message: "환불 처리함으로 닫았습니다." };
  } catch (error) {
    return failure(error, "환불 처리함으로 닫지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}

/** [환불 검토 취소] — 원장만. 넘기기 직전(정산 필요 · 퇴원)으로 되돌린다. 환불 처리함까지 간 기간은 되돌리지 않는다. 알림은 보내지 않는다 */
export async function cancelIllnessPeriodRefundReviewAction(input: { periodId: string }): Promise<ActionResult> {
  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try { owner = await requireOwner(); } catch { return { ok: false, message: "환불 검토 취소는 원장만 할 수 있습니다." }; }
  try {
    await cancelIllnessPeriodRefundReview(prisma, { periodId: String(input?.periodId ?? "").trim() }, owner.appUserId, settlementWritesEnabled());
    revalidateRefundViews();
    return { ok: true, message: "환불 검토를 취소했습니다. 다시 «정산 필요 · 퇴원»으로 돌아갑니다." };
  } catch (error) {
    return failure(error, "환불 검토를 취소하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}
