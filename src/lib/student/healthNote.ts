// 건강·알레르기·특이사항(Student.healthNote) 읽기·쓰기 한 곳 (2026-11-14 원장 결정 b5).
// 실행 테스트: tests/child-edit.test.mjs
//
// ★ 건강 정보다 — 지켜야 할 것
//   1) 보는 사람: 그 아이의 보호자 · 관리자 · 선생님(자기 반 명단) · 기사님(자기 운행표)뿐.
//      이 모듈은 권한을 보지 않는다 — «이미 권한을 확인한 학생 id»만 넘겨받는다(부르는 쪽 조회 범위 그대로).
//   2) 알림 본문·로그(console)·공개 화면에 내용을 쓰지 않는다(가드 테스트가 본다).
//   3) 칸이 아직 없는 환경(마이그레이션 20261114140000 적용 전)에서도 화면이 죽지 않는다:
//      읽기는 따로 한 번 더 묻고 실패하면 «없음», 쓰기는 false 를 돌려준다.
import { cleanHealthNote } from "@/lib/parent/childEditRules";
import { notMergedStudent } from "@/lib/studentVisibility";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };
type Writer = { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> };

/** 학생 id → 건강 특이사항(값이 있는 학생만). 칸이 없거나 조회가 실패하면 빈 객체 */
export async function loadHealthNotes(db: Reader, studentIds: readonly string[]): Promise<Record<string, string>> {
  const ids = [...new Set(studentIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return {};
  try {
    const rows = await db.$queryRawUnsafe<Array<{ id: string; healthNote: string | null }>>(
      `SELECT s.id, s."healthNote" FROM "Student" s
        WHERE s.id = ANY($1::text[]) AND ${notMergedStudent("s")} AND NULLIF(btrim(s."healthNote"), '') IS NOT NULL`,
      ids,
    );
    const out: Record<string, string> = {};
    for (const row of rows) if (row.healthNote) out[String(row.id)] = String(row.healthNote);
    return out;
  } catch {
    // 내용·원문 SQL 은 남기지 않는다
    return {};
  }
}

/**
 * 관리자 저장 — 권한은 부르는 쪽(requireAdmin)이 확인한다.
 * 결과: "saved" | "invalid"(300자 초과) | "unavailable"(칸 없음·학생 없음)
 */
export async function saveHealthNoteAsAdmin(db: Writer, studentId: string, raw: unknown): Promise<{ status: "saved" } | { status: "invalid"; error: string } | { status: "unavailable" }> {
  const clean = cleanHealthNote(raw);
  if (!clean.ok) return { status: "invalid", error: clean.error };
  try {
    const count = await db.$executeRawUnsafe(
      `UPDATE "Student" SET "healthNote" = $1, "updatedAt" = NOW() WHERE id = $2 AND "mergedIntoStudentId" IS NULL`,
      clean.value,
      studentId,
    );
    return count === 1 ? { status: "saved" } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
