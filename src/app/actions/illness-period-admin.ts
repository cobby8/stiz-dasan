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
import { IllnessPeriodError, PERIOD_APPROVED_PARENT_NOTE, billingHoldParentText, periodRangeText, periodSettledParentText } from "@/lib/regular/illnessPeriodRules";
import {
  cancelIllnessPeriodSettlement, previewIllnessPeriodSettlement, readSettledIllnessPeriod, settleIllnessPeriod,
} from "@/lib/regular/illness-period-settlement";
import { settlementContext, settlementWritesEnabled } from "@/lib/regular/illness-period-settlement-runner";
import { unpaidGuideAdminText, type SettlementRow, type UnpaidGuide } from "@/lib/regular/illnessPeriodSettlementPlan";

// 신청함 «부상 결석(기간)» — 원장이 기간 전체의 사유 글·증빙 사진을 보고 [부상 결석 승인] 또는 [보강권으로 전환]을 고른다(2026-11-15 원장 승인).
// 승인은 금액 없이 «인정»만 기록한다 — 돈이 움직이지 않아 청구 준비 저장 스위치와 무관하다. 금액은 복귀 뒤 한 번에 정산한다.
// 모두 requireAdmin(원장·부원장). 이 단계 화면에는 금액이 없다.
// 학부모에게는 앱 안 알림만 보낸다(문자·알림톡 없음). 사유 글(건강 정보)은 알림·로그에 싣지 않는다.

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  // 규칙이 알려 주는 사유(한국어)는 그대로 보인다. 그 밖의 오류는 이름만 기록한다
  if (error instanceof IllnessPeriodError) return { ok: false, message: error.message };
  // 이월 근거·공식 일정 쪽 규칙(청구 준비와 같은 함수)이 알려 주는 사유도 한국어 그대로 보인다
  if (error instanceof Error && error.name === "WorkbenchError") return { ok: false, message: error.message };
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

// ── 복귀 정산(3단계) ────────────────────────────────────────────────────────────────────
// 금액은 복귀가 확정됐을 때 한 번 계산한다. 미리보기는 원장·부원장이 열 수 있지만 금액은 원장에게만 내려보낸다
// (부원장 응답에서는 금액 칸을 뺀다 — 화면만 가리면 개발자도구로 보인다). [이월 확정]·[확정 취소]는 원장만.

export type IllnessPeriodSettlementView = {
  /** ESTIMATE = 복귀일 미정(지금까지 예상) · READY = 복귀일이 정해져 확정할 수 있는 표 · SETTLED = 확정됨(그때의 표 사본) */
  state: "ESTIMATE" | "READY" | "SETTLED";
  /** 금액을 볼 수 있는 역할인가(원장) — 아니면 아래 금액 칸은 모두 null */
  canSeeMoney: boolean;
  /** [이월 확정]·[확정 취소]를 누를 수 있는 역할인가(원장) */
  canSettle: boolean;
  /** 청구 준비 저장 스위치가 켜져 있는가(꺼져 있으면 확정·취소 불가) */
  writesEnabled: boolean;
  returnDate: string | null;
  storedReturnDate: string | null;
  /** 진행 중인 학원 등록 기간 — 복귀일을 여기서 받아 함께 복귀 처리한다 */
  canSetReturnDate: boolean;
  /** 이월을 쓸 수 있게 되는 달 */
  availableMonth: string | null;
  fingerprint: string | null;
  rows: Array<{
    key: string; month: string; className: string; evidence: string; sessions: number;
    tuition: number | null; unit: number | null; subtotal: number | null;
    dates: Array<{ absenceId: string; date: string }>;
    excluded: Array<{ absenceId: string; date: string; code: string; why: string }>;
    warnings: string[]; blockedReason: string | null;
  }>;
  carryTotal: number | null;
  /** 낸 돈이 없는 달 안내(금액 없음) */
  unpaid: string[];
  /** 지금 [이월 확정]을 누를 수 없는 이유 */
  blockers: string[];
  /** 낸 돈이 없는 달에 미납 청구가 그대로 있다 — 먼저 위 보류 칸의 «발행 보류로 돌리기»를 해야 한다 */
  needsHold: boolean;
  /** 확정된 기간: 이월이 이미 청구에서 차감됐는가(차감됐으면 확정 취소 불가) */
  used: boolean;
};

function settlementRows(rows: SettlementRow[], money: boolean): IllnessPeriodSettlementView["rows"] {
  return rows.map((row) => {
    const paid = row.evidence === "WORKBENCH_ISSUED" || row.evidence === "PAID_PAYMENT";
    return {
      key: `${row.classId}|${row.month}`, month: row.month, className: row.className, evidence: row.evidence, sessions: row.sessions,
      // 금액은 서버 응답에서 뺀다(부원장)
      tuition: money && paid ? row.tuition : null, unit: money && paid ? row.unitDisplay : null, subtotal: money && paid ? row.subtotal : null,
      dates: row.dates.map((date, index) => ({ absenceId: row.absenceIds[index], date })),
      excluded: row.excluded.map((item) => ({ absenceId: item.absenceId, date: item.date, code: item.code, why: item.why })),
      warnings: row.warnings ?? [], blockedReason: row.blockedReason ?? null,
    };
  });
}

/**
 * 정산 칸을 열 때 — 승인된 기간은 미리보기(복귀일 미정이면 «지금까지 예상»), 확정된 기간은 그때의 표 사본.
 * omitAbsenceIds = 원장이 뺀 날, returnDate = 진행 중인 기간에서 원장이 넣은 복귀일.
 */
export async function loadIllnessPeriodSettlement(input: {
  periodId: string; omitAbsenceIds?: string[]; returnDate?: string | null;
}): Promise<{ ok: true; settlement: IllnessPeriodSettlementView } | { ok: false; message: string }> {
  const admin = await requireAdmin();
  const money = canSeeAllMoney(admin.appUserRole);
  const periodId = String(input?.periodId ?? "").trim();
  try {
    const settled = await readSettledIllnessPeriod(prisma, periodId);
    if (settled) {
      return { ok: true, settlement: {
        state: "SETTLED", canSeeMoney: money, canSettle: money, writesEnabled: settlementWritesEnabled(),
        returnDate: settled.returnDate, storedReturnDate: settled.returnDate, canSetReturnDate: false, availableMonth: settled.availableMonth,
        fingerprint: null, rows: settlementRows(settled.rows, money), carryTotal: money ? settled.carryTotal : null,
        unpaid: settled.unpaidGuides.map((guide: UnpaidGuide) => unpaidGuideAdminText(guide)), blockers: [], needsHold: false, used: settled.used,
      } };
    }
    const preview = await previewIllnessPeriodSettlement(
      prisma,
      {
        periodId,
        omitAbsenceIds: Array.isArray(input?.omitAbsenceIds) ? input.omitAbsenceIds.map(String) : [],
        returnDate: input?.returnDate ? String(input.returnDate) : null,
      },
      await settlementContext(admin.appUserId),
    );
    return { ok: true, settlement: {
      state: preview.returnDate ? "READY" : "ESTIMATE", canSeeMoney: money, canSettle: money, writesEnabled: settlementWritesEnabled(),
      returnDate: preview.returnDate, storedReturnDate: preview.storedReturnDate, canSetReturnDate: preview.canSetReturnDate,
      // 지문은 금액을 넣어 만든 해시다 — 금액을 못 보는 역할에는 내려보내지 않는다(대입으로 금액을 맞힐 수 있다). 확정은 원장만 하므로 부원장에게는 쓸 곳도 없다
      availableMonth: preview.availableMonth, fingerprint: money ? preview.fingerprint : null,
      rows: settlementRows(preview.plan.rows, money), carryTotal: money ? preview.plan.carryTotal : null,
      unpaid: preview.plan.unpaidGuides.map((guide) => unpaidGuideAdminText(guide)), blockers: preview.blockers,
      needsHold: preview.plan.problems.some((problem) => problem.code === "OPEN_BILL"), used: false,
    } };
  } catch (error) {
    return failure(error, "정산 내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.");
  }
}

/**
 * [이월 확정] — 원장만. 화면에서 본 표의 지문을 함께 받아, 잠근 뒤 다시 계산한 표와 다르면 실행하지 않는다.
 * 금액은 서버가 다시 계산한다(화면이 보낸 금액을 받지 않는다). 학부모에게는 앱 안 알림 1회(문자·알림톡 없음, 24시간 중복 방지).
 */
export async function settleIllnessPeriodAction(input: {
  periodId: string; omitAbsenceIds?: string[]; expectedFingerprint: string; returnDate?: string | null;
}): Promise<ActionResult> {
  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try { owner = await requireOwner(); } catch { return { ok: false, message: "이월 확정은 원장만 할 수 있습니다." }; }
  try {
    const done = await settleIllnessPeriod(
      prisma,
      {
        periodId: String(input?.periodId ?? "").trim(),
        omitAbsenceIds: Array.isArray(input?.omitAbsenceIds) ? input.omitAbsenceIds.map(String) : [],
        expectedFingerprint: String(input?.expectedFingerprint ?? ""),
        returnDate: input?.returnDate ? String(input.returnDate) : null,
      },
      owner.appUserId, settlementWritesEnabled(),
      // 확정 직전에는 공식 일정을 새로 읽는다(청구 준비의 저장·발행과 같다)
      await settlementContext(owner.appUserId, true),
    );
    await notifyParentOnce(
      done.studentId, "부상 결석 이월 확정",
      `${await childPrefix(done.studentId)}${periodRangeText(done.startDate, done.returnDate)} 결석 · ${periodSettledParentText(done.carryTotal)}`,
      "/mypage/regular-absence",
    );
    // 이월·청구 보류 상태가 바뀌었다 — 신청함·청구 준비·학생 상세·학부모 화면을 다시 그린다
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/finance");
    revalidatePath("/admin/students/[id]", "page");
    revalidatePath("/admin/absence");
    revalidatePath("/mypage");
    return {
      ok: true,
      message: `이월 ${done.carryTotal.toLocaleString("ko-KR")}원을 확정했습니다(결석 ${done.credited}회). ${Number(done.availableMonth.slice(5, 7))}월 청구부터 차감이 제안돼요.${done.unpaidMonths > 0 ? ` 낸 돈이 없는 달 ${done.unpaidMonths}건은 청구 준비에서 다닌 만큼만 발행해 주세요.` : ""}`,
    };
  } catch (error) {
    return failure(error, "이월을 확정하지 못했습니다. 표를 다시 확인한 뒤 눌러 주세요.");
  }
}

/** [확정 취소] — 원장만. 이월이 한 번도 쓰이지 않았을 때만 확정 직전(인정 · 금액 미정)으로 되돌린다. 알림은 보내지 않는다 */
export async function cancelIllnessPeriodSettlementAction(input: { periodId: string }): Promise<ActionResult> {
  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try { owner = await requireOwner(); } catch { return { ok: false, message: "확정 취소는 원장만 할 수 있습니다." }; }
  try {
    const done = await cancelIllnessPeriodSettlement(prisma, { periodId: String(input?.periodId ?? "").trim() }, owner.appUserId, settlementWritesEnabled());
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/finance");
    revalidatePath("/admin/students/[id]", "page");
    revalidatePath("/admin/absence");
    revalidatePath("/mypage");
    return { ok: true, message: `이월 확정을 취소했습니다(이월 ${done.creditsRemoved}건 삭제). 다시 «정산 필요»로 돌아가고, 청구 발행은 보류됩니다.` };
  } catch (error) {
    return failure(error, "확정을 취소하지 못했습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.");
  }
}
