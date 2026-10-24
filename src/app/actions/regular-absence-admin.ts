"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { assertAbsenceCompensationEditable, lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { getRegularAbsences, type RegularAbsenceRow } from "@/lib/regular/admin-regular-absence";
import {
  bookMakeupSession,
  cancelMakeupSession,
  updateMakeupStatus,
} from "@/app/actions/admin";

// 정규 수업 사전 결석 — 관리자 확정 서버 액션(#3 Step B).
// 모두 requireAdmin 게이트. $executeRawUnsafe (PgBouncer 트랜잭션 모드 호환).
// MVP 범위: 크레딧/보강 없음. 상태(REPORTED/CONFIRMED/CANCELLED)만 관리한다.

function revalidateViews() {
  revalidatePath("/admin/absence");
}

// ── 0) 목록 재조회(필터) ────────────────────────────────────────────────
export async function loadRegularAbsences(input?: {
  date?: string;
  classId?: string;
}): Promise<{ ok: true; rows: RegularAbsenceRow[] }> {
  await requireAdmin();
  const rows = await getRegularAbsences({
    date: input?.date?.trim() || undefined,
    classId: input?.classId?.trim() || undefined,
  });
  return { ok: true, rows };
}

// ── 1) 확정 (REPORTED → CONFIRMED) ─────────────────────────────────────
// 확정하면 학부모 취소가 자동으로 잠긴다(학부모 cancel 은 REPORTED 만 허용).
export async function confirmRegularAbsence(input: { id: string }) {
  const admin = await requireAdmin();
  const id = input?.id?.trim();
  if (!id) throw new Error("결석 신고를 찾을 수 없습니다.");

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE "RegularAbsence"
        SET status = 'CONFIRMED',
            "resolvedByUserId" = $2,
            "updatedAt" = now()
      WHERE id = $1 AND status = 'REPORTED'`,
    id, admin.appUserId,
  );
  if (Number(affected) === 0) throw new Error("확정할 수 없는 상태입니다.");

  revalidateViews();
  return { ok: true };
}

// ── 2) 확정 취소 (CONFIRMED → REPORTED) ────────────────────────────────
export async function revertRegularAbsence(input: { id: string }) {
  const admin = await requireAdmin();
  const id = input?.id?.trim();
  if (!id) throw new Error("결석 신고를 찾을 수 없습니다.");

  const affected = await prisma.$transaction(async tx => {
    await lockCompensation(tx);
    await assertAbsenceCompensationEditable(tx, id);
    return tx.$executeRawUnsafe(
    `UPDATE "RegularAbsence"
        SET status = 'REPORTED',
            "resolvedByUserId" = $2,
            "updatedAt" = now()
      WHERE id = $1 AND status = 'CONFIRMED'`,
    id, admin.appUserId,
    );
  });
  if (Number(affected) === 0) throw new Error("확정 상태인 신고만 되돌릴 수 있습니다.");

  revalidateViews();
  return { ok: true };
}

// ── 3) 관리자용 취소 (→ CANCELLED) ─────────────────────────────────────
// 신고 자체를 무효 처리. REPORTED/CONFIRMED 어느 상태든 관리자는 취소 가능.
export async function cancelRegularAbsenceByAdmin(input: { id: string }) {
  const admin = await requireAdmin();
  const id = input?.id?.trim();
  if (!id) throw new Error("결석 신고를 찾을 수 없습니다.");

  const affected = await prisma.$transaction(async tx => {
    await lockCompensation(tx);
    await assertAbsenceCompensationEditable(tx, id);
    return tx.$executeRawUnsafe(
    `UPDATE "RegularAbsence"
        SET status = 'CANCELLED',
            "resolvedByUserId" = $2,
            "updatedAt" = now()
      WHERE id = $1 AND status <> 'CANCELLED'`,
    id, admin.appUserId,
    );
  });
  if (Number(affected) === 0) throw new Error("취소할 수 없는 상태입니다.");

  revalidateViews();
  return { ok: true };
}

// ── 4) 보강 지정 (결석 → MakeupSession 생성) ─────────────────────────────
// 왜 MakeupSession 재사용?: 레거시지만 정규반 보강용 컬럼(원래반·결석일·보강반·보강일)이
//   그대로 맞아, 새 테이블/컬럼 없이 결석(RegularAbsence)과 보강을 자연키로 잇는다.
// 결석 1건 ↔ 보강 1건: 이미 활성 보강이 있으면 거부(먼저 취소 후 재지정).
export async function scheduleMakeupForAbsence(input: {
  absenceId: string;
  makeupClassId: string;
  makeupDate: string; // YYYY-MM-DD
}) {
  await requireAdmin();
  const absenceId = input?.absenceId?.trim();
  const makeupClassId = input?.makeupClassId?.trim();
  const makeupDate = input?.makeupDate?.trim();
  if (!absenceId) throw new Error("결석 신고를 찾을 수 없습니다.");
  if (!makeupClassId) throw new Error("보강 반을 선택해 주세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(makeupDate || "")) throw new Error("보강 날짜를 선택해 주세요.");

  // 결석 원본 조회(취소된 건은 보강 지정 불가). 학생·원래반·결석일을 서버에서 확정.
  const rows = await prisma.$queryRawUnsafe<Array<{ studentId: string; classId: string; date: string }>>(
    `SELECT ra."studentId" AS "studentId",
            ra."classId" AS "classId",
            to_char(ra.date, 'YYYY-MM-DD') AS "date"
       FROM "RegularAbsence" ra
      WHERE ra.id = $1 AND ra.status <> 'CANCELLED'
      LIMIT 1`,
    absenceId,
  );
  const ab = rows[0];
  if (!ab) throw new Error("결석 신고를 찾을 수 없거나 취소된 상태입니다.");

  // 중복 방지: 같은 자연키(학생·원래반·결석일)에 활성 보강이 이미 있으면 거부.
  //   (MakeupSession 테이블이 없으면 아직 아무 보강도 없다는 뜻 → 통과)
  try {
    const dup = await prisma.$queryRawUnsafe<Array<{ found: number }>>(
      `SELECT 1 FROM "MakeupSession"
        WHERE "studentId" = $1 AND "originalClassId" = $2
          AND "originalDate"::date = $3::date AND status <> 'CANCELLED'
        LIMIT 1`,
      ab.studentId, ab.classId, ab.date,
    );
    if (dup[0]) throw new Error("이미 지정된 보강이 있습니다. 먼저 기존 보강을 취소해 주세요.");
  } catch (e) {
    // 위에서 던진 중복 에러는 그대로 전파, 테이블 부재 등 조회 에러는 무시(신규 예약 진행).
    if (e instanceof Error && e.message.startsWith("이미 지정된")) throw e;
  }

  // MakeupSession 생성(레거시 예약 액션 재사용 — ensureMakeupSessionTable 포함).
  // 정원 초과 검증도 bookMakeupSession 안에서 수행된다(assertMakeupSeatAvailable).
  //   → 보강 예약 모달 경로와 이 결석→보강 지정 경로가 동일한 기준으로 막힌다.
  await bookMakeupSession({
    studentId: ab.studentId,
    originalClassId: ab.classId,
    originalDate: ab.date,
    makeupClassId,
    makeupDate,
  });

  revalidateViews();
  return { ok: true };
}

// ── 5) 보강 취소 (MakeupSession → CANCELLED) ───────────────────────────
export async function cancelMakeupForAbsence(input: { makeupId: string }) {
  await requireAdmin();
  const makeupId = input?.makeupId?.trim();
  if (!makeupId) throw new Error("보강을 찾을 수 없습니다.");
  await cancelMakeupSession(makeupId); // 레거시 액션 재사용(requireAdmin 내장)
  revalidateViews();
  return { ok: true };
}

// ── 6) 보강 상태 변경 (BOOKED → ATTENDED / NO_SHOW / CANCELLED) ──────────
export async function updateMakeupStatusForAbsence(input: {
  makeupId: string;
  status: string;
}) {
  await requireAdmin();
  const makeupId = input?.makeupId?.trim();
  if (!makeupId) throw new Error("보강을 찾을 수 없습니다.");
  await updateMakeupStatus(makeupId, input?.status); // 화이트리스트 검증 내장
  revalidateViews();
  return { ok: true };
}
