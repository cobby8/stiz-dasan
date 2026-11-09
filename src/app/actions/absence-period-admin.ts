"use server";

// 관리자 «기간 결석»(부상·질병 — «11/6부터, 복귀 미정») 서버 액션. 2026-11-09 원장 결정.
// 실제 규칙·SQL 은 src/lib/regular/absence-period-service.ts(연결부)·absence-period-plan.ts(순수 계산)에 있다.
// 여기서는 관리자 확인(requireAdmin) → 트랜잭션 → 캐시 무효화만 한다. 학부모·코치·기사 알림은 보내지 않는다.
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import {
  cancelAbsencePeriodInTx,
  createAbsencePeriodInTx,
  endAbsencePeriodInTx,
  listAbsencePeriodsInDb,
  type AbsencePeriodView,
} from "@/lib/regular/absence-period-service";
import {
  ABSENCE_PERIOD_TX_OPTIONS,
  absencePeriodContext,
  extendOpenAbsencePeriods,
  revalidateAbsenceViews,
} from "@/lib/regular/absence-period-runner";

type ActionResult<T = object> = ({ ok: true; message: string } & T) | { ok: false; message: string };

function failure(error: unknown, fallback: string): { ok: false; message: string } {
  if (!(error instanceof Error)) console.error("[absence-period-admin]", error);
  return { ok: false, message: error instanceof Error && error.message ? error.message : fallback };
}

// ── 목록 ──
export async function listAbsencePeriods(studentId: string): Promise<
  { ok: true; available: boolean; periods: AbsencePeriodView[] } | { ok: false; message: string }
> {
  await requireAdmin();
  try {
    return { ok: true, ...(await listAbsencePeriodsInDb(prisma, String(studentId ?? "").trim())) };
  } catch (error) {
    return failure(error, "기간 결석 목록을 불러오지 못했습니다.");
  }
}

// ── 등록 ──
export async function createAbsencePeriod(input: {
  studentId: string;
  startDate: string;
  returnDate?: string | null;
  reason?: string | null;
  note?: string | null;
  classIds?: string[] | null;
}): Promise<ActionResult<{ periodId: string }>> {
  const admin = await requireAdmin();
  try {
    const ctx = await absencePeriodContext(admin.appUserId);
    const result = await prisma.$transaction((tx) => createAbsencePeriodInTx(tx, input, ctx), ABSENCE_PERIOD_TX_OPTIONS);
    revalidateAbsenceViews(result.studentId);
    return { ok: true, periodId: result.periodId, message: result.message };
  } catch (error) {
    return failure(error, "기간 결석을 등록하지 못했습니다.");
  }
}

// ── 복귀 처리 ──
export async function endAbsencePeriod(input: { periodId: string; returnDate: string }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const ctx = await absencePeriodContext(admin.appUserId);
    const result = await prisma.$transaction((tx) => endAbsencePeriodInTx(tx, input, ctx), ABSENCE_PERIOD_TX_OPTIONS);
    revalidateAbsenceViews(result.studentId);
    return { ok: true, message: result.message };
  } catch (error) {
    return failure(error, "복귀 처리를 하지 못했습니다.");
  }
}

// ── 등록 취소(잘못 등록) ──
export async function cancelAbsencePeriod(input: { periodId: string }): Promise<ActionResult> {
  const admin = await requireAdmin();
  try {
    const result = await prisma.$transaction(
      (tx) => cancelAbsencePeriodInTx(tx, input, { actorUserId: admin.appUserId }),
      ABSENCE_PERIOD_TX_OPTIONS,
    );
    revalidateAbsenceViews(result.studentId);
    return { ok: true, message: result.message };
  } catch (error) {
    return failure(error, "등록 취소를 하지 못했습니다.");
  }
}

// ── 연장(관리자가 바로 돌릴 때 — 크론이 하루 빠졌을 때 대비). 크론은 /api/cron/absence-periods ──
export async function extendAbsencePeriodsNow() {
  await requireAdmin();
  return extendOpenAbsencePeriods();
}
