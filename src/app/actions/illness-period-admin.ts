"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
import { prisma } from "@/lib/prisma";
import { isMakeupCreditIssuableYmd } from "@/lib/makeup/credit-service";
import { notifyParentsOfStudents } from "@/lib/notification";
import {
  approveIllnessPeriod,
  cancelIllnessPeriodApproval,
  convertIllnessPeriodToMakeup,
  holdIssuedBillsForPeriod,
  parentNoticeSentRecently,
  readIllnessPeriodBillingHold,
  readIllnessPeriodDetail,
  readStudentName,
  type IllnessPeriodDetail,
} from "@/lib/regular/illness-period-admin";
import { IllnessPeriodError, PERIOD_APPROVED_PARENT_NOTE, billingHoldParentText, periodRangeText } from "@/lib/regular/illnessPeriodRules";

// 신청함 «부상 결석(기간)» — 원장이 기간 전체의 사유 글·증빙 사진을 보고 [부상 결석 승인] 또는 [보강권으로 전환]을 고른다(2026-11-15 원장 승인).
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

/**
 * 학부모 앱 알림 — 같은 학부모에게 같은 제목·같은 본문을 최근 24시간 안에 보냈으면 다시 보내지 않는다
 * (승인 → 승인 취소 → 다시 승인을 되풀이해도 알림이 쌓이지 않게. 본문에 기간 날짜가 들어 있어 기간마다 다르다).
 * 알림 함수는 실패해도 던지지 않는다 — 이미 저장된 처리 결과를 뒤집지 않는다.
 */
async function notifyParentOnce(studentId: string, title: string, message: string, linkUrl: string): Promise<void> {
  const already = await parentNoticeSentRecently(prisma, { studentId, title, message }).catch(() => false);
  if (already) return;
  await notifyParentsOfStudents([studentId], "ABSENCE", title, message, linkUrl);
}

/** 알림 본문 앞에 붙일 «아이 이름 · » — 형제가 같은 기간이어도 본문이 달라 아이마다 알림이 간다. 이름을 못 읽으면 붙이지 않는다 */
async function childPrefix(studentId: string): Promise<string> {
  const name = await readStudentName(prisma, studentId).catch(() => "");
  return name ? `${name} · ` : "";
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
    await notifyParentOnce(
      done.studentId, "부상 결석 인정",
      `${await childPrefix(done.studentId)}${periodRangeText(done.startDate, done.returnDate)} 결석을 부상 결석으로 인정했어요. ${PERIOD_APPROVED_PARENT_NOTE}`,
      "/mypage/regular-absence",
    );
    revalidatePath("/admin/inbox");
    return { ok: true, message: "부상 결석으로 승인했습니다. 금액은 복귀한 뒤 한 번에 정산해요." };
  } catch (error) {
    return failure(error, "승인하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}

/** [승인 취소] — 금액을 정하기 전에만. 거둔 보강권을 돌려주고, 날짜마다 다시 «검토 중»이 된다(사진 기한 7일 새로 시작) */
export async function cancelIllnessPeriodApprovalAction(input: { periodId: string }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const done = await cancelIllnessPeriodApproval(prisma, { periodId: String(input?.periodId ?? "").trim() }, admin.appUserId);
    revalidatePath("/admin/inbox");
    // 보류가 풀린다 — 학부모 결제 화면의 보류 안내 한 줄도 다시 그린다
    revalidatePath("/mypage");
    return {
      ok: true,
      // 보류로 돌린 청구는 되살리지 않는다 — 청구 준비에 «확인 필요»로 다시 나오니 원장이 다시 발행한다
      message: `승인을 취소했습니다. 다시 «승인 대기»로 돌아갑니다.${done.creditsRestored > 0 ? ` 보강권 ${done.creditsRestored}장을 돌려줬어요.` : ""}${done.heldBills > 0 ? ` 보류로 돌린 청구 ${done.heldBills}건은 청구 준비에서 다시 발행해야 합니다.` : ""}`,
    };
  } catch (error) {
    return failure(error, "승인을 취소하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}

/** [보강권으로 전환] — 이 기간을 부상 결석으로 인정하지 않고, 결정 전인 날마다 보강권 1장으로 처리한다 */
export async function convertIllnessPeriodToMakeupAction(input: { periodId: string }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const done = await convertIllnessPeriodToMakeup(
      prisma, { periodId: String(input?.periodId ?? "").trim() }, admin.appUserId, isMakeupCreditIssuableYmd,
    );
    if (done.converted > 0) {
      await notifyParentOnce(
        done.studentId, "결석 보강권 안내",
        `${await childPrefix(done.studentId)}${periodRangeText(done.startDate, done.returnDate)} 결석 ${done.converted}회는 보강권으로 처리했어요.${done.creditsIssued > 0 ? " 보강을 예약할 수 있어요." : ""}`,
        "/mypage/makeup",
      );
    }
    revalidatePath("/admin/inbox");
    return {
      ok: true,
      message: `${done.converted}회를 보강권으로 돌렸어요.${done.attendedClosed > 0 ? ` 그날 출석으로 기록된 ${done.attendedClosed}회는 보강권 없이 닫았어요.` : ""}`,
    };
  } catch (error) {
    return failure(error, "보강권으로 돌리지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}

// ── 청구 발행 보류(2단계) ────────────────────────────────────────────────────────────────
// 승인된 기간의 아이는 새 청구가 발행되지 않는다(청구 준비가 막는다). 여기는 «승인 전에 이미 발행된 미납 청구»를
// 원장이 대상·금액을 보고 보류로 돌리는 칸이다. 실행은 원장만(기존 «미납 청구 취소»와 같은 권한) — 부원장에게는 건수만 보인다.

export type IllnessPeriodHoldView = {
  /** 이 기간이 지금 발행 보류를 만들고 있는가 */
  holdActive: boolean;
  /** [발행 보류로 돌리기]를 누를 수 있는 역할인가(원장) */
  canHold: boolean;
  /** 이미 발행된 미납 청구 — amount 는 원장에게만(그 밖에는 null) */
  bills: Array<{ paymentId: string; label: string; amount: number | null; skipText: string | null }>;
  /** 이미 보류로 돌려 둔 청구 수 */
  heldCount: number;
  /** 미납 셔틀비 청구가 있는가 — «셔틀비 청구는 그대로예요» 한 줄을 보일지 */
  unpaidShuttle: boolean;
};

/** 신청함 기간 상세의 보류 칸 — 승인 뒤에만 내용이 있다 */
export async function loadIllnessPeriodHold(periodId: string): Promise<{ ok: true; hold: IllnessPeriodHoldView } | { ok: false; message: string }> {
  const admin = await requireAdmin();
  try {
    const hold = await readIllnessPeriodBillingHold(prisma, String(periodId ?? "").trim());
    if (!hold) return { ok: false, message: "기간 결석을 찾을 수 없습니다." };
    const owner = canSeeAllMoney(admin.appUserRole);
    return {
      ok: true,
      hold: {
        holdActive: hold.holdActive,
        canHold: owner,
        bills: hold.bills.map((bill) => ({
          paymentId: bill.paymentId,
          label: `${bill.month}월 ${bill.className ?? "수강료"}`,
          // 금액은 서버 응답에서 뺀다(화면만 가리면 개발자도구로 보인다)
          amount: owner ? bill.amount : null,
          skipText: bill.skipText,
        })),
        heldCount: hold.heldBills.length,
        unpaidShuttle: hold.unpaidShuttle,
      },
    };
  } catch (error) {
    return failure(error, "청구 내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.");
  }
}

/**
 * [발행 보류로 돌리기] — 원장만. 화면에서 본 «돌릴 청구» id 목록을 함께 받아, 그 사이 목록이 바뀌었으면 실행하지 않는다.
 * 학부모에게는 앱 안 알림 1회(문자·알림톡 없음, 24시간 중복 방지).
 */
export async function holdIllnessPeriodBillsAction(input: { periodId: string; expectedPaymentIds: string[] }): Promise<ActionResult> {
  // 원장 확인 — 부원장·그 밖은 여기서 끝난다(화면에서 버튼을 숨기는 것과 별개로 서버가 막는다)
  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try { owner = await requireOwner(); } catch { return { ok: false, message: "발행 보류로 돌리기는 원장만 할 수 있습니다." }; }
  try {
    const done = await holdIssuedBillsForPeriod(
      prisma,
      {
        periodId: String(input?.periodId ?? "").trim(),
        expectedPaymentIds: Array.isArray(input?.expectedPaymentIds) ? input.expectedPaymentIds.map(String) : [],
      },
      owner.appUserId,
    );
    const name = await readStudentName(prisma, done.studentId).catch(() => "");
    if (done.held.length > 0 && name) {
      // 문구는 보류 범위 그대로 — 대상 반이 정해진 기간이면 그 반 이름을 넣는다
      await notifyParentOnce(done.studentId, "수강료 청구 안내", billingHoldParentText(name, done.scopeClassNames), "/mypage/payments");
    }
    // 청구 상태가 바뀌었다 — 신청함·수납 관리·학생 상세·학부모 화면을 다시 그린다(기존 «미납 청구 취소»와 같은 범위)
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/finance");
    revalidatePath("/admin/stats");
    revalidatePath("/admin/students/[id]", "page");
    revalidateTag("admin-finance", { expire: 0 });
    revalidateTag("admin-stats", { expire: 0 });
    revalidatePath("/mypage");
    const total = done.held.reduce((sum, bill) => sum + bill.amount, 0);
    return {
      ok: true,
      message: `미납 청구 ${done.held.length}건(${total.toLocaleString("ko-KR")}원)을 발행 보류로 돌렸습니다.${done.skipped.length > 0 ? ` ${done.skipped.length}건은 건너뛰었어요.` : ""} 복귀 뒤 청구 준비에서 다시 발행해 주세요.`,
    };
  } catch (error) {
    return failure(error, "발행 보류로 돌리지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}
