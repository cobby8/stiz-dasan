"use server";

/**
 * 학생 보호자(Guardian) 관리 Server Action — 학생 상세 「보호자」 카드 전용.
 *
 * ■ 안전 규칙
 *   - 모든 함수 첫 줄 requireAdmin() (관리자·부원장만)
 *   - IDOR 방지: 수정·삭제·주 보호자 지정은 항상 `id = 보호자 AND "studentId" = 학생` 두 조건으로만 건드린다.
 *     다른 학생의 보호자 id 를 넘겨도 0건이 되어 에러로 끝난다.
 *   - PgBouncer 트랜잭션 모드라 $queryRawUnsafe/$executeRawUnsafe + 파라미터 바인딩만 쓴다.
 *
 * ■ 주 보호자 ↔ 로그인 계정(User) 은 동기화하지 않는다
 *   Student.parentId → User.phone 은 로그인·알림톡 대상이다. 여기서 주 보호자를 바꿔도 계정 전화는 그대로 둔다.
 *   (계정 전화 변경은 기존 「연락처 · 프로필」 편집이 담당한다)
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import {
  canAddGuardian,
  MAX_GUARDIANS_PER_STUDENT,
  nextPrimaryAfterDelete,
  shouldBePrimaryOnAdd,
  sortGuardians,
  validateGuardianInput,
  type GuardianInput,
} from "@/lib/guardians/guardianLogic";

export type StudentGuardian = {
  id: string;
  relation: string;
  name: string;
  phone: string | null;
  isPrimary: boolean;
  createdAt: string;
};

type Executor = Pick<typeof prisma, "$queryRawUnsafe" | "$executeRawUnsafe">;

/** id 형식 최소 검사 — 빈 값·비정상 길이를 SQL 까지 보내지 않는다 */
function assertId(value: unknown, label: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 64) throw new Error(`${label} 정보가 올바르지 않습니다.`);
  return id;
}

/** 학생이 실제로 있는지 확인(병합으로 흡수된 학생은 편집 대상이 아니다)
 *  lock=true(쓰기 트랜잭션)면 학생 행을 잠가, 관리자 둘이 동시에 고쳐도 6명 상한·주 보호자 1명이 깨지지 않게 한다. */
async function assertStudent(db: Executor, studentId: string, lock = false) {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "Student" WHERE id = $1 AND "mergedIntoStudentId" IS NULL LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    studentId,
  );
  if (!rows[0]) throw new Error("학생을 찾을 수 없습니다.");
}

/** 한 학생의 보호자 목록(주 보호자 먼저 → 등록순) */
async function loadGuardians(db: Executor, studentId: string): Promise<StudentGuardian[]> {
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT id, relation, name, phone, "isPrimary", "createdAt"
     FROM "Guardian"
     WHERE "studentId" = $1
     ORDER BY "isPrimary" DESC, "createdAt" ASC`,
    studentId,
  );
  return sortGuardians(
    rows.map((r) => ({
      id: String(r.id),
      relation: String(r.relation ?? ""),
      name: String(r.name ?? ""),
      phone: r.phone ?? null,
      isPrimary: Boolean(r.isPrimary ?? r.isprimary),
      createdAt: new Date(r.createdAt ?? r.createdat).toISOString(),
    })),
  );
}

function revalidateStudent(studentId: string) {
  revalidatePath(`/admin/students/${studentId}`);
}

/** 보호자 목록 조회 */
export async function listStudentGuardians(studentIdRaw: string): Promise<StudentGuardian[]> {
  await requireAdmin();
  const studentId = assertId(studentIdRaw, "학생");
  await assertStudent(prisma, studentId);
  return loadGuardians(prisma, studentId);
}

/** 보호자 추가 — 첫 보호자거나 makePrimary 면 주 보호자(나머지는 false) */
export async function addStudentGuardian(
  studentIdRaw: string,
  input: GuardianInput & { makePrimary?: boolean },
): Promise<StudentGuardian[]> {
  await requireAdmin();
  const studentId = assertId(studentIdRaw, "학생");

  await prisma.$transaction(async (tx) => {
    await assertStudent(tx, studentId, true);
    const existing = await loadGuardians(tx, studentId);
    if (!canAddGuardian(existing.length)) {
      throw new Error(`보호자는 학생당 최대 ${MAX_GUARDIANS_PER_STUDENT}명까지 등록할 수 있습니다.`);
    }
    const checked = validateGuardianInput(input, existing);
    if (!checked.ok) throw new Error(checked.error);

    const primary = shouldBePrimaryOnAdd(existing.length, Boolean(input?.makePrimary));
    // 주 보호자는 학생당 1명 — 새 사람을 주 보호자로 넣기 전에 나머지를 먼저 내린다
    if (primary) {
      await tx.$executeRawUnsafe(
        `UPDATE "Guardian" SET "isPrimary" = false, "updatedAt" = NOW() WHERE "studentId" = $1 AND "isPrimary" = true`,
        studentId,
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "Guardian" (id, "studentId", relation, name, phone, "isPrimary", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, NOW(), NOW())`,
      studentId,
      checked.value.relation,
      checked.value.name,
      checked.value.phone,
      primary,
    );
  });

  revalidateStudent(studentId);
  return loadGuardians(prisma, studentId);
}

/** 보호자 수정(관계·이름·전화) — 주 보호자 여부는 setPrimaryGuardian 이 담당 */
export async function updateStudentGuardian(
  studentIdRaw: string,
  guardianIdRaw: string,
  input: GuardianInput,
): Promise<StudentGuardian[]> {
  await requireAdmin();
  const studentId = assertId(studentIdRaw, "학생");
  const guardianId = assertId(guardianIdRaw, "보호자");

  await prisma.$transaction(async (tx) => {
    await assertStudent(tx, studentId, true);
    const existing = await loadGuardians(tx, studentId);
    // 소속 검증: 이 학생의 보호자 목록에 없으면 거부(다른 학생 보호자 id 차단)
    if (!existing.some((g) => g.id === guardianId)) throw new Error("이 학생의 보호자가 아닙니다.");
    const checked = validateGuardianInput(input, existing, guardianId);
    if (!checked.ok) throw new Error(checked.error);

    const count = await tx.$executeRawUnsafe(
      `UPDATE "Guardian" SET relation = $1, name = $2, phone = $3, "updatedAt" = NOW()
       WHERE id = $4 AND "studentId" = $5`,
      checked.value.relation,
      checked.value.name,
      checked.value.phone,
      guardianId,
      studentId,
    );
    if (count !== 1) throw new Error("보호자 정보를 수정하지 못했습니다.");
  });

  revalidateStudent(studentId);
  return loadGuardians(prisma, studentId);
}

/** 보호자 삭제 — 마지막 1명도 허용(화면이 경고). 주 보호자를 지우면 가장 먼저 등록된 사람이 이어받는다 */
export async function deleteStudentGuardian(studentIdRaw: string, guardianIdRaw: string): Promise<StudentGuardian[]> {
  await requireAdmin();
  const studentId = assertId(studentIdRaw, "학생");
  const guardianId = assertId(guardianIdRaw, "보호자");

  await prisma.$transaction(async (tx) => {
    await assertStudent(tx, studentId, true);
    const existing = await loadGuardians(tx, studentId);
    if (!existing.some((g) => g.id === guardianId)) throw new Error("이 학생의 보호자가 아닙니다.");

    const count = await tx.$executeRawUnsafe(
      `DELETE FROM "Guardian" WHERE id = $1 AND "studentId" = $2`,
      guardianId,
      studentId,
    );
    if (count !== 1) throw new Error("보호자를 삭제하지 못했습니다.");

    const nextPrimaryId = nextPrimaryAfterDelete(existing, guardianId);
    if (nextPrimaryId) {
      await tx.$executeRawUnsafe(
        `UPDATE "Guardian" SET "isPrimary" = true, "updatedAt" = NOW() WHERE id = $1 AND "studentId" = $2`,
        nextPrimaryId,
        studentId,
      );
    }
  });

  revalidateStudent(studentId);
  return loadGuardians(prisma, studentId);
}

/** 주 보호자 지정 — 이 사람만 true, 같은 학생의 나머지는 false (한 트랜잭션) */
export async function setPrimaryGuardian(studentIdRaw: string, guardianIdRaw: string): Promise<StudentGuardian[]> {
  await requireAdmin();
  const studentId = assertId(studentIdRaw, "학생");
  const guardianId = assertId(guardianIdRaw, "보호자");

  await prisma.$transaction(async (tx) => {
    await assertStudent(tx, studentId, true);
    const owned = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "Guardian" WHERE id = $1 AND "studentId" = $2 LIMIT 1`,
      guardianId,
      studentId,
    );
    if (!owned[0]) throw new Error("이 학생의 보호자가 아닙니다.");

    // 한 문장으로 "이 사람만 true, 나머지 false" — 중간 상태(0명·2명)가 생기지 않는다
    await tx.$executeRawUnsafe(
      `UPDATE "Guardian" SET "isPrimary" = (id = $1), "updatedAt" = NOW()
       WHERE "studentId" = $2 AND "isPrimary" IS DISTINCT FROM (id = $1)`,
      guardianId,
      studentId,
    );
  });

  revalidateStudent(studentId);
  return loadGuardians(prisma, studentId);
}
