/**
 * 신청 화면 «미리 고르기» — 수업 탭 반 카드 버튼이 ?studentId=&enrollmentId=(&kind=) 를 붙여 기존 신청 화면을 연다.
 * 순수 함수(DB·React 없음).
 *
 * ⚠️ 보안: 이 값은 «화면에서 먼저 보여 줄 것»을 고르는 힌트일 뿐이다. 목록은 이미 서버가 그 부모의 자녀만 골라 왔고,
 *    여기서는 그 목록 안에서 순서·선택만 바꾼다. 목록에 없는 id 면 아무 일도 없다(남의 학생 id 를 넣어도 무시).
 */

export type RequestPreset = { studentId: string | null; enrollmentId: string | null; kind: string | null };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KIND_RE = /^[A-Z_]{1,32}$/;

/** 주소 값 정리 — 문자열 하나·id 모양일 때만 받는다(배열·이상한 글자는 버림) */
export function parseRequestPreset(params: Record<string, string | string[] | undefined> | null | undefined): RequestPreset {
  const one = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  return {
    studentId: one(params?.studentId, ID_RE),
    enrollmentId: one(params?.enrollmentId, ID_RE),
    kind: one(params?.kind, KIND_RE),
  };
}

/** 목록에서 미리 고를 칸 번호. 수강 등록 id 가 맞는 칸 → 같은 아이의 첫 칸 → 0 */
export function presetIndex<T>(
  list: readonly T[],
  preset: RequestPreset,
  pick: (item: T) => { studentId: string; enrollmentId?: string | null },
): number {
  if (preset.enrollmentId) {
    const i = list.findIndex((item) => pick(item).enrollmentId === preset.enrollmentId);
    if (i >= 0) return i;
  }
  if (preset.studentId) {
    const i = list.findIndex((item) => pick(item).studentId === preset.studentId);
    if (i >= 0) return i;
  }
  return 0;
}

/** 고른 아이의 항목을 앞으로(나머지 순서는 그대로). 아이가 목록에 없으면 원래 순서. */
export function presetFirst<T>(list: readonly T[], studentId: string | null, getStudentId: (item: T) => string): T[] {
  if (!studentId) return [...list];
  return [...list.filter((item) => getStudentId(item) === studentId), ...list.filter((item) => getStudentId(item) !== studentId)];
}
