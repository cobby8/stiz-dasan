/**
 * 중복 학생 데이터 정리용 API
 *
 * GET  /api/admin/cleanup-duplicates — 중복 학생 목록 미리보기 (삭제 전 확인용)
 * POST /api/admin/cleanup-duplicates — ⛔ 막음(2026-10-02). 아래 POST 주석 참고
 *
 * 중복 판정 기준:
 * - 같은 이름(name)의 Student가 2명 이상
 * - 완전한 데이터: school이 있거나 grade가 '-'가 아닌 실제 값
 * - 불완전 데이터: school이 null/빈값이고 grade가 null/'-'
 * - 생년월일이 2000-01-01이면 특히 의심 (수동 등록 시 임시값)
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { notMergedStudent } from "@/lib/studentVisibility";

export const dynamic = "force-dynamic";

// 학생 데이터가 "불완전"한지 판별하는 함수
// school이 없고, grade가 없거나 '-'이면 불완전
function isIncomplete(student: {
  school: string | null;
  grade: string | null;
}): boolean {
  const noSchool = !student.school || student.school.trim() === "";
  const noGrade = !student.grade || student.grade.trim() === "" || student.grade.trim() === "-";
  return noSchool && noGrade;
}

// 생년월일이 2000-01-01인지 확인 (수동 등록 시 임시값으로 자주 사용됨)
function isSuspiciousBirthDate(birthDate: string): boolean {
  return birthDate.startsWith("2000-01-01");
}

/**
 * GET: 중복 학생 미리보기
 * 같은 이름이 2명 이상인 그룹에서 완전/불완전을 분류하고 삭제 대상 목록 반환
 */
export async function GET() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }

  try {
    // 1단계: 같은 이름이 2명 이상인 이름 목록 조회
    const duplicateNames = await prisma.$queryRawUnsafe<{ name: string; cnt: number }[]>(
      `SELECT name, COUNT(*)::int as cnt
       FROM "Student" s
       WHERE ${notMergedStudent("s")}
       GROUP BY name
       HAVING COUNT(*) >= 2
       ORDER BY name`
    );

    if (duplicateNames.length === 0) {
      return NextResponse.json({
        message: "중복 학생이 없습니다.",
        groups: [],
        totalToDelete: 0,
      });
    }

    // 2단계: 중복 이름에 해당하는 학생 전체 데이터 조회
    const nameList = duplicateNames.map((d) => d.name);
    // IN 절을 위한 파라미터 생성 ($1, $2, $3, ...)
    const placeholders = nameList.map((_, i) => `$${i + 1}`).join(", ");

    const allDuplicates = await prisma.$queryRawUnsafe<{
      id: string;
      name: string;
      birthDate: string;
      school: string | null;
      grade: string | null;
      parentId: string;
      phone: string | null;
      createdAt: string;
    }[]>(
      `SELECT id, name, "birthDate"::text, school, grade, "parentId", phone, "createdAt"::text
       FROM "Student" s
       WHERE ${notMergedStudent("s")} AND name IN (${placeholders})
       ORDER BY name, "createdAt" DESC`,
      ...nameList
    );

    // 3단계: 이름별로 그룹핑하고 완전/불완전 분류
    const groups: {
      name: string;
      complete: typeof allDuplicates;
      incomplete: typeof allDuplicates;
      toDelete: typeof allDuplicates;
    }[] = [];

    // 이름별 그룹핑
    const byName = new Map<string, typeof allDuplicates>();
    for (const s of allDuplicates) {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name)!.push(s);
    }

    let totalToDelete = 0;

    for (const [name, students] of byName) {
      const complete = students.filter((s) => !isIncomplete(s));
      const incomplete = students.filter((s) => isIncomplete(s));

      // 삭제 대상: 완전한 데이터가 1개 이상 있을 때만 불완전한 것을 삭제
      // 모두 불완전하면 삭제하지 않음 (수동 확인 필요)
      const toDelete = complete.length > 0 ? incomplete : [];
      totalToDelete += toDelete.length;

      groups.push({
        name,
        complete: complete.map((s) => ({
          ...s,
          _isSuspiciousBirth: isSuspiciousBirthDate(s.birthDate),
        })) as any,
        incomplete: incomplete.map((s) => ({
          ...s,
          _isSuspiciousBirth: isSuspiciousBirthDate(s.birthDate),
        })) as any,
        toDelete,
      });
    }

    return NextResponse.json({
      message: `중복 이름 ${groups.length}건 발견, 삭제 대상 ${totalToDelete}명`,
      groups,
      totalToDelete,
    });
  } catch (e) {
    console.error("cleanup-duplicates GET error:", e);
    return NextResponse.json({ error: "중복 조회 실패" }, { status: 500 });
  }
}

/**
 * POST: ⛔ 막음 (2026-10-02, Phase 0 정합성 점검)
 *
 * 예전에는 "같은 이름의 학생이 2명 이상이면, 학교·학년이 비어 있는 쪽"을 골라
 * 그 학생의 청구(Payment)·출석·수강 기록까지 **영구 삭제**했다. 위험한 이유:
 *  · 이름만으로 같은 사람이라고 판단한다 — **동명이인**이 지워진다.
 *  · 돈 기록(Payment)을 지운다 — 되돌릴 방법이 없다.
 *  · 2026-07-26 부터는 지우지 않고 합치는 병합 도구(src/lib/studentMerge/engine.ts)가 있다.
 * 화면에서 부르는 곳은 없었지만 관리자라면 누구나 호출할 수 있어 여기서 막는다.
 * 미리보기(GET)는 읽기만 하므로 남겨 둔다.
 */
export async function POST() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "인증 필요" }, { status: 401 });
  }
  return NextResponse.json(
    {
      error:
        "중복 학생 영구 삭제 기능은 막혔습니다. 동명이인이 지워지고 청구·출석 기록이 사라질 수 있어서입니다. " +
        "중복 학생은 병합 도구로 합쳐 주세요(기록을 지우지 않고 한쪽으로 모읍니다).",
    },
    { status: 410 },
  );
}
