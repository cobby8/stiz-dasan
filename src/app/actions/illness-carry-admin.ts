"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { canSeeAllMoney } from "@/lib/auth/moneyAccess";
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
import { maskUnpaidReduceView, parseApprovalExpectation, type ApprovalExpectation } from "@/lib/regular/illnessUnpaidReduceRules";

// 신청함 «질병·부상 결석» — 원장이 사유 글·증빙 사진을 보고 [이월 승인] / [보강권으로]를 고른다(2026-11-14 원장 결정 a3).
// 모두 requireAdmin(원장·부원장). 이월 적립은 기존 청구 준비 규칙(resolveWorkbenchAbsence)을 그대로 쓴다.
// 학부모에게는 앱 안 알림만 보낸다(문자·알림톡 없음). 사유 글(건강 정보)은 알림·로그에 싣지 않는다.
// 그 달 수강료가 «미납»이면 이월 대신 그 미납 청구에서 1회분을 뺀다(2026-11-16 원장 결정) — 어느 쪽인지는 서버가 가르고,
// 화면이 본 방식·금액(expected)과 다르면 승인하지 않는다. 알림에는 금액을 넣지 않는다.

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

type ApprovedDay = { studentId: string; absenceYmd: string; mode: "CARRY" | "REDUCE" };

/**
 * 승인한 결석들의 학부모 알림 글(금액 없음). 이월 = 다음 달 수강료에서, 청구에서 뺌 = 그 달 수강료에서.
 * 한 번에 여러 날을 승인했는데 방식이 섞였으면 한 문장으로 묶는다.
 */
function approvalNotice(done: ApprovedDay[]): { title: string; message: string } {
  const days = done.map((item) => item.absenceYmd).sort();
  const span = days.length === 1 ? `${days[0]} 결석` : `${days[0]}~${days[days.length - 1]} 결석 ${days.length}회`;
  const count = days.length === 1 ? "1회분" : `${days.length}회분`;
  const reduced = done.filter((item) => item.mode === "REDUCE").length;
  if (reduced === 0) return { title: "결석 이월 승인", message: `${span}${days.length === 1 ? "을" : "를"} 이월로 승인했어요. 다음 달 수강료에서 ${count}을 빼 드려요.` };
  if (reduced === done.length) return { title: "결석 인정", message: `${span}${days.length === 1 ? "을" : "를"} 인정했어요. 그 달 수강료에서 ${count}을 뺐어요.` };
  return { title: "결석 인정", message: `${span}를 인정했어요. 낸 달은 다음 달 수강료에서, 아직 안 낸 달은 그 달 수강료에서 빼요.` };
}

/** 상세(서버가 방금 읽은 것)에서 «화면이 본 것»을 만든다 — 같은 기간 함께 승인이 건마다 쓴다 */
function expectationOf(detail: IllnessCarryDetail): ApprovalExpectation {
  return detail.reduce ? { mode: "REDUCE", reduceBy: detail.reduce.reduceBy, after: detail.reduce.after } : { mode: "CARRY" };
}

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  // 기존 이월 규칙이 알려 주는 사유(한국어)는 그대로 보인다. 그 밖의 오류는 이름만 기록한다
  if (error instanceof WorkbenchError) return { ok: false, message: error.message };
  console.error("[illness-carry-admin]", error instanceof Error ? error.name : "");
  return { ok: false, message: fallback };
}

/** 상세 칸을 열 때 — 사유 글·사진 id·승인 가능 여부 */
export async function loadIllnessCarryDetail(absenceId: string): Promise<{ ok: true; detail: IllnessCarryDetail } | { ok: false; message: string }> {
  const admin = await requireAdmin();
  try {
    // 근거 미리보기의 수업 횟수는 승인 때와 같은 공식 일정으로 센다. 일정을 못 읽으면(null) 미리보기·거절 사유를 내지 않는다(승인 때 서버가 판정).
    const calendar = await loadWorkbenchCalendar().catch(() => null);
    const detail = await readIllnessCarryDetail(prisma, String(absenceId ?? "").trim(), writesEnabled(), calendar);
    if (!detail) return { ok: false, message: "결석을 찾을 수 없거나 질병·부상 결석이 아닙니다." };
    // 금액은 원장만 — 화면만 가리지 않고 서버 응답에서 지운다(부원장 금액 숨김 규칙). 횟수·경고 글은 그대로 보인다.
    if (detail.evidence && !canSeeAllMoney(admin.appUserRole)) detail.evidence = { ...detail.evidence, tuition: null, unit: null };
    // 미납 청구에서 빼는 금액(수강료·1회 값·청구 금액·남는 금액)도 같은 규칙으로 지운다
    if (detail.reduce && !canSeeAllMoney(admin.appUserRole)) detail.reduce = maskUnpaidReduceView(detail.reduce);
    return { ok: true, detail };
  } catch (error) {
    return failure(error, "내용을 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.");
  }
}

/**
 * [이월 승인] / [결석 인정 · 청구에서 빼기] — 납부된 달은 다음 달 수강료에서 1회분 차감(이월 적립), 미납인 달은 그 미납 청구에서 1회분을 뺀다.
 * 이미 나간 보강권은 회수된다. expected = 화면이 본 방식·금액(서버가 다시 읽은 것과 다르면 «다시 확인» 오류).
 */
export async function approveIllnessCarryAction(input: {
  absenceId: string; evidenceConfirmed: boolean; cancelReservation?: boolean; expected?: ApprovalExpectation | null;
}): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const calendar = await loadWorkbenchCalendar(true);
    const done = await approveIllnessCarry(
      prisma,
      {
        absenceId: String(input?.absenceId ?? "").trim(), evidenceConfirmed: input?.evidenceConfirmed === true, cancelReservation: input?.cancelReservation === true,
        expected: parseApprovalExpectation(input?.expected),
      },
      admin.appUserId, writesEnabled(), calendar,
    );
    // 승인은 이미 저장됐다 — 알림이 실패해도 «승인 실패»로 보이면 원장이 다시 누르게 된다. 결과 글에만 알린다
    const notice = approvalNotice([done]);
    const notified = await notifyParentSafely(done.studentId, notice.title, notice.message);
    revalidatePath("/admin/inbox");
    // 청구 금액이 바뀌었으니 납부 화면도 새로 읽게 한다
    if (done.mode === "REDUCE") revalidatePath("/admin/finance");
    return {
      ok: true,
      message: done.mode === "REDUCE"
        ? `결석을 인정하고 그 달 미납 청구에서 1회분을 뺐습니다.${notified ? "" : NOTIFY_FAILED_NOTE}`
        : `이월을 승인했습니다. 다음 달 청구에 «이월»로 차감됩니다.${notified ? "" : NOTIFY_FAILED_NOTE}`,
    };
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
    // 승인과 같은 공식 일정으로 «지금 승인할 수 있는가»를 판정한다(일정이 다르면 수업 횟수·사유가 달라진다)
    const calendar = await loadWorkbenchCalendar(true);
    const detail = await readIllnessCarryDetail(prisma, absenceId, writesEnabled(), calendar);
    if (!detail) return { ok: false, message: "결석을 찾을 수 없거나 질병·부상 결석이 아닙니다." };
    // 화면이 보낸 목록을 믿지 않고 서버가 읽은 «같은 기간·결석일 지남·결정 전» 목록으로 처리한다(지금 연 결석 포함)
    const targets = [...(detail.status === "PENDING" && !detail.blocker ? [absenceId] : []), ...detail.periodPeerIds];
    if (targets.length === 0) return { ok: false, message: detail.blocker ?? "함께 승인할 결석이 없습니다." };
    const done: ApprovedDay[] = [];
    const failed: string[] = [];
    for (const id of targets) {
      try {
        // 건마다 «이월인가 · 미납 청구에서 빼는가»가 다를 수 있다(달이 다르거나, 앞 건이 같은 청구를 방금 줄였다).
        // 그래서 승인 직전에 서버가 그 건의 상세를 다시 읽어 «본 것»으로 넘긴다 — 승인 함수가 다시 견준다.
        const current = id === absenceId && done.length === 0 ? detail : await readIllnessCarryDetail(prisma, id, writesEnabled(), calendar);
        if (!current || current.status !== "PENDING") { failed.push("이미 처리가 끝난 결석입니다."); continue; }
        if (current.blocker) { failed.push(current.blocker); continue; }
        // 보강 예약이 있는 결석은 함께 취소 확인이 필요해 여기서 넘기지 않는다 — 그 건은 실패 사유로 남아 따로 승인한다
        done.push(await approveIllnessCarry(prisma, { absenceId: id, evidenceConfirmed: true, expected: expectationOf(current) }, admin.appUserId, writesEnabled(), calendar));
      } catch (error) {
        failed.push(failure(error, "승인하지 못했습니다.").message);
      }
    }
    let notified = true;
    if (done.length > 0) {
      const notice = approvalNotice(done);
      notified = await notifyParentSafely(done[0].studentId, notice.title, notice.message);
    }
    revalidatePath("/admin/inbox");
    if (done.length === 0) return { ok: false, message: failed[0] ?? "승인하지 못했습니다." };
    const reduced = done.filter((item) => item.mode === "REDUCE").length;
    if (reduced > 0) revalidatePath("/admin/finance");
    // 결과 글: 전부 이월이면 예전 글 그대로, 청구에서 뺀 건이 있으면 몇 건인지 함께 알린다
    const summary = reduced === 0 ? `${done.length}건 이월 승인`
      : reduced === done.length ? `${done.length}건 결석 인정(미납 청구에서 뺌)`
      : `${done.length}건 승인(이월 ${done.length - reduced}건 · 미납 청구에서 뺌 ${reduced}건)`;
    return {
      ok: true,
      message: failed.length
        ? `${summary} · ${failed.length}건은 승인하지 못했습니다(${failed[0]})${notified ? "" : NOTIFY_FAILED_NOTE}`
        : reduced === 0
          ? `${done.length}건을 이월 승인했습니다. 다음 달 청구에 «이월»로 차감됩니다.${notified ? "" : NOTIFY_FAILED_NOTE}`
          : `${summary}했습니다.${notified ? "" : NOTIFY_FAILED_NOTE}`,
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
