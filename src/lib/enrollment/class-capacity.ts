/**
 * 정규반 «정원 초과» 소프트 경고 한 곳 (2026-11-09 원생 등록 재설계로 추출).
 *
 * ■ 왜 따로 두는가
 *   신청서 승인(approveEnrollApplication)에만 있던 정원 확인을 새 «원생 등록»(registerStudent)도 써야 한다.
 *   같은 규칙을 두 군데 복사하면 한쪽만 고쳐지는 사고가 나서(index 함정 «같은 규칙 두 경로») 이 파일로 옮기고
 *   승인 경로도 이 함수를 그대로 부른다. SQL·판정은 승인 경로에 있던 것과 글자까지 같다(테스트로 고정).
 *
 * ■ 규칙
 *   - 정원(capacity)과 «현재 ACTIVE 수강 인원(병합된 학생 제외)»을 반마다 센다.
 *   - 이미 정원을 채운(current >= capacity) 반에 한 명 더 넣으면 초과 → 경고 대상.
 *   - 하드 차단이 아니다. 화면이 재확인을 받고 force 로 다시 부르면 넘어간다(관리자 재량).
 *   - 읽기만 한다 — 부작용 0.
 *
 * ■ 이 파일은 prisma·next 를 import 하지 않는다 — db 를 인자로 받아 가짜 db 로 실행 검증한다.
 */
import { notMergedStudent } from "@/lib/studentVisibility";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

/** 정원을 이미 채운 반 한 줄 */
export type OverCapacityClass = { classId: string; name: string; current: number; capacity: number };

/** 정원·현재 인원 조회 SQL — 승인 경로에서 옮겨 온 원문 그대로 */
export const CLASS_CAPACITY_SQL = `SELECT c.name AS name, c.capacity AS capacity,
                        (SELECT COUNT(*) FROM "Enrollment" e
                         JOIN "Student" s ON s.id = e."studentId"
                         WHERE e."classId" = c.id AND e.status = 'ACTIVE' AND ${notMergedStudent("s")}
                        )::int AS current
                 FROM "Class" c WHERE c.id = $1 LIMIT 1`;

/** 정원·현재 인원 한 줄 → 초과면 경고 행, 아니면 null (순수 함수) */
export function overCapacityRow(classId: string, row: Record<string, unknown> | undefined): OverCapacityClass | null {
    if (!row) return null;
    // 드라이버에 따라 대문자 별칭으로 올 때가 있어 두 이름을 모두 읽는다(승인 경로와 같음)
    const capacity = Number(row.capacity ?? row.CAPACITY);
    const current = Number(row.current ?? row.CURRENT);
    if (Number.isFinite(capacity) && Number.isFinite(current) && current >= capacity) {
        return { classId, name: String(row.name ?? ""), current, capacity };
    }
    return null;
}

/** 고른 반들 중 정원을 이미 채운 반 목록(없으면 빈 배열). 읽기만 한다. */
export async function findOverCapacityClasses(db: Reader, classIds: string[]): Promise<OverCapacityClass[]> {
    const overCapacity: OverCapacityClass[] = [];
    for (const classId of classIds) {
        const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(CLASS_CAPACITY_SQL, classId);
        const over = overCapacityRow(classId, rows[0]);
        if (over) overCapacity.push(over);
    }
    return overCapacity;
}
