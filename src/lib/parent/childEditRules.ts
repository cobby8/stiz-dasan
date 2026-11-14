// 학부모 «아이 정보 수정» 입력 규칙 — 순수 함수(DB·React·시계 없음).
// 실행 테스트: tests/child-edit.test.mjs
//
// 2026-11-14 원장 결정(b4·b5):
//   · 바로 반영  = 학교 · 학생 전화 · 주소 · 건강 특이사항 (DIRECT_FIELDS)
//   · 변경 신청  = 이름 · 생년월일 (REQUEST_FIELDS — 수강료·반 배정에 영향, 원장·부원장이 승인)
//   · 학년은 직접 입력하지 않는다(생년월일 계산값을 보여 준다)
// 같은 검증을 «신청할 때»와 «승인할 때» 두 번 쓴다(승인 시점에 다시 확인).
import { isKstYmd } from "@/lib/datetime/kst";

/** 건강·알레르기·특이사항 글자 수 상한 — DB CHECK(Student_healthNote_length_check)와 같은 값 */
export const HEALTH_NOTE_MAX = 300;
export const SCHOOL_MAX = 40;
export const ADDRESS_MAX = 200;
export const CHILD_NAME_MAX = 30;
/** 생년월일로 받을 수 있는 가장 이른 날(오입력 방지) */
export const BIRTH_MIN_YMD = "1930-01-01";

/** 학부모가 바로 고치는 칸 — UPDATE 문이 이 목록의 칸만 건드리는지 테스트가 본다 */
export const DIRECT_FIELDS = ["school", "phone", "address", "healthNote"] as const;
/** 변경 신청으로만 바뀌는 칸 — DB CHECK(StudentProfileChangeRequest_field_check)와 같은 집합 */
export const REQUEST_FIELDS = ["name", "birthDate"] as const;
export type RequestField = (typeof REQUEST_FIELDS)[number];
export const REQUEST_FIELD_LABEL: Record<RequestField, string> = { name: "이름", birthDate: "생년월일" };

export function isRequestField(value: unknown): value is RequestField {
  return typeof value === "string" && (REQUEST_FIELDS as readonly string[]).includes(value);
}

/** 한 줄 글 정리 — 앞뒤 공백 제거, 줄바꿈·탭·제어문자는 공백으로, 연속 공백은 하나로 */
function oneLine(raw: unknown): string {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** 건강 특이사항 정리 — 줄바꿈은 살리되(최대 연속 1줄) 제어문자는 뺀다. 빈 값은 null. 300자 넘으면 오류 */
export function cleanHealthNote(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!text) return { ok: true, value: null };
  if ([...text].length > HEALTH_NOTE_MAX) return { ok: false, error: `건강 특이사항은 ${HEALTH_NOTE_MAX}자까지 쓸 수 있어요.` };
  return { ok: true, value: text };
}

export type ChildDirectValue = { school: string | null; phone: string | null; address: string | null; healthNote: string | null };

/** «바로 반영» 네 칸 검증. 전화는 숫자만 저장한다(비우면 null) */
export function cleanChildDirect(input: unknown): { ok: true; value: ChildDirectValue } | { ok: false; error: string } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const school = oneLine(src.school);
  if ([...school].length > SCHOOL_MAX) return { ok: false, error: `학교는 ${SCHOOL_MAX}자까지 쓸 수 있어요.` };
  const address = oneLine(src.address);
  if ([...address].length > ADDRESS_MAX) return { ok: false, error: `주소는 ${ADDRESS_MAX}자까지 쓸 수 있어요.` };
  const phoneDigits = String(src.phone ?? "").replace(/[^0-9]/g, "");
  // 학생 전화는 휴대폰 번호만(010…·011… 10~11자리). 비우면 «없음»
  if (phoneDigits && !/^01\d{8,9}$/.test(phoneDigits)) return { ok: false, error: "학생 전화는 휴대폰 번호로 입력해 주세요." };
  const health = cleanHealthNote(src.healthNote);
  if (!health.ok) return health;
  return { ok: true, value: { school: school || null, phone: phoneDigits || null, address: address || null, healthNote: health.value } };
}

/** 이름 검증 — 1~30자 */
export function cleanChildName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const name = oneLine(raw);
  if (!name) return { ok: false, error: "이름을 입력해 주세요." };
  if ([...name].length > CHILD_NAME_MAX) return { ok: false, error: `이름은 ${CHILD_NAME_MAX}자까지 쓸 수 있어요.` };
  return { ok: true, value: name };
}

/** 생년월일 검증 — 달력에 있는 날짜, 1930-01-01 ~ 오늘(KST) */
export function cleanBirthYmd(raw: unknown, todayYmd: string): { ok: true; value: string } | { ok: false; error: string } {
  const ymd = String(raw ?? "").trim();
  if (!isKstYmd(ymd)) return { ok: false, error: "생년월일을 확인해 주세요." };
  if (ymd < BIRTH_MIN_YMD || ymd > todayYmd) return { ok: false, error: "생년월일을 확인해 주세요." };
  return { ok: true, value: ymd };
}

/**
 * 변경 신청 한 건 검증 — 항목(name|birthDate)·새 값·지금 값.
 * 지금 값과 같으면 신청할 것이 없다.
 */
export function checkChangeRequest(
  field: unknown,
  newValue: unknown,
  current: { name: string; birthYmd: string | null },
  todayYmd: string,
): { ok: true; field: RequestField; oldValue: string | null; newValue: string } | { ok: false; error: string } {
  if (!isRequestField(field)) return { ok: false, error: "바꿀 항목을 확인해 주세요." };
  if (field === "name") {
    const name = cleanChildName(newValue);
    if (!name.ok) return name;
    if (name.value === oneLine(current.name)) return { ok: false, error: "지금 이름과 같아요." };
    return { ok: true, field, oldValue: current.name, newValue: name.value };
  }
  const birth = cleanBirthYmd(newValue, todayYmd);
  if (!birth.ok) return birth;
  if (birth.value === current.birthYmd) return { ok: false, error: "지금 생년월일과 같아요." };
  return { ok: true, field, oldValue: current.birthYmd, newValue: birth.value };
}

export type ChangeRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";
export const CHANGE_STATUS_LABEL: Record<ChangeRequestStatus, string> = {
  PENDING: "확인 중",
  APPROVED: "승인",
  REJECTED: "반려",
  CANCELED: "취소",
};

/** 화면에 보일 값 — 생년월일은 «2015.3.2», 이름은 그대로 */
export function changeValueText(field: string, value: string | null | undefined): string {
  const v = String(value ?? "").trim();
  if (!v) return "-";
  if (field === "birthDate" && isKstYmd(v)) return `${v.slice(0, 4)}.${Number(v.slice(5, 7))}.${Number(v.slice(8, 10))}`;
  return v;
}

/** 신청 한 줄 «이름 홍길동 → 홍길순» */
export function changeLine(row: { field: string; oldValue: string | null; newValue: string }): string {
  const label = isRequestField(row.field) ? REQUEST_FIELD_LABEL[row.field] : row.field;
  return `${label} ${changeValueText(row.field, row.oldValue)} → ${changeValueText(row.field, row.newValue)}`;
}
