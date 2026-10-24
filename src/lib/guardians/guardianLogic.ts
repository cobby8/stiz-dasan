/**
 * 학생 보호자(Guardian) 관리용 순수 로직 — DB·Next 의존 0.
 *
 * ■ 왜 따로 두는가
 *   학생 상세의 「보호자」 카드(추가·수정·삭제·주 보호자 지정)가 쓰는 입력 검증·전화 정규화·
 *   주 보호자 계산을 서버 액션에서 떼어내 `node --test` 로 실제 실행해 검증하기 위해서다.
 *
 * ■ 전화 저장 형식 = 숫자만(`01012345678`)
 *   학부모 계정의 90%(2026-09-18 실측)와 계절학기 승인 경로가 숫자만으로 저장한다.
 *   계절학기 승인은 Guardian.phone 을 "글자 그대로" 비교하는 곳도 있어서(COALESCE(phone,'') = 숫자),
 *   하이픈을 넣어 저장하면 같은 사람을 못 찾는다. 화면 표시는 formatGuardianPhone 으로 하이픈을 붙인다.
 */

/** 한 학생에게 등록할 수 있는 보호자 최대 수(오입력·남용 방지용 상한) */
export const MAX_GUARDIANS_PER_STUDENT = 6;
export const MAX_RELATION_LENGTH = 20;
export const MAX_NAME_LENGTH = 40;

export type GuardianRecord = {
  id: string;
  relation: string;
  name: string;
  phone: string | null;
  isPrimary: boolean;
  createdAt: string | Date;
};

export type GuardianInput = {
  relation: string;
  name: string;
  phone: string;
};

export type GuardianValidation =
  | { ok: true; value: { relation: string; name: string; phone: string } }
  | { ok: false; error: string };

/**
 * 전화번호를 저장 형식(숫자만)으로 바꾼다.
 * - 하이픈·공백·괄호 제거
 * - 국제번호 `+82 10-...` → `010...` (82 다음의 0 생략 관례를 되살린다)
 */
export function normalizeGuardianPhone(raw: unknown): string {
  let digits = String(raw ?? "").replace(/[^0-9]/g, "");
  // 82로 시작하고 길이가 국제 휴대폰 형태(11~13자리)면 국내 형식으로 되돌린다
  if (digits.startsWith("82") && digits.length >= 11 && digits.length <= 13) {
    digits = `0${digits.slice(2).replace(/^0/, "")}`;
  }
  return digits;
}

/** 저장할 수 있는 전화번호인가 — 0으로 시작하는 9~11자리, 같은 숫자 반복(자리채움)은 거부 */
export function isValidGuardianPhone(digits: string): boolean {
  if (!/^0[0-9]{8,10}$/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false; // 00000000000 같은 자리채움 번호
  return true;
}

/** 화면 표시용 하이픈 형식. 형식을 알 수 없으면 원문 그대로 돌려준다. */
export function formatGuardianPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = String(raw).replace(/[^0-9]/g, "");
  if (/^02\d{7,8}$/.test(d)) {
    // 서울 지역번호(02)
    return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : `02-${d.slice(2, 6)}-${d.slice(6)}`;
  }
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return String(raw);
}

/**
 * 추가·수정 입력 검증.
 * @param existing 같은 학생의 현재 보호자 목록(중복 번호 검사용)
 * @param editingId 수정 중이면 그 보호자 id(자기 자신과는 중복 검사하지 않는다)
 */
export function validateGuardianInput(
  input: Partial<GuardianInput> | null | undefined,
  existing: Pick<GuardianRecord, "id" | "phone">[],
  editingId: string | null = null,
): GuardianValidation {
  const relation = String(input?.relation ?? "").trim();
  const nameRaw = String(input?.name ?? "").trim();
  const phone = normalizeGuardianPhone(input?.phone);

  if (!relation) return { ok: false, error: "관계(예: 모, 조모)를 입력해 주세요." };
  if (relation.length > MAX_RELATION_LENGTH) return { ok: false, error: `관계는 ${MAX_RELATION_LENGTH}자 이내로 입력해 주세요.` };
  if (nameRaw.length > MAX_NAME_LENGTH) return { ok: false, error: `이름은 ${MAX_NAME_LENGTH}자 이내로 입력해 주세요.` };
  if (!phone) return { ok: false, error: "전화번호를 입력해 주세요." };
  if (!isValidGuardianPhone(phone)) return { ok: false, error: "전화번호 형식이 올바르지 않습니다. (예: 010-1234-5678)" };

  // 같은 학생 안에서 같은 번호가 두 번 등록되지 않게 막는다(기존 데이터는 하이픈 형식일 수도 있어 숫자로 비교)
  const duplicated = existing.some(
    (g) => g.id !== editingId && normalizeGuardianPhone(g.phone) === phone,
  );
  if (duplicated) return { ok: false, error: "이 학생에게 이미 등록된 전화번호입니다." };

  // 이름을 비우면 관계를 이름으로 쓴다 — 엑셀 업로드(insertGuardians)가 쓰던 관례와 같다(name 컬럼은 NOT NULL)
  return { ok: true, value: { relation, name: nameRaw || relation, phone } };
}

/** 추가 가능 여부(상한 검사) */
export function canAddGuardian(currentCount: number): boolean {
  return currentCount < MAX_GUARDIANS_PER_STUDENT;
}

/**
 * 새 보호자를 추가할 때 주 보호자로 넣을지 판단한다.
 * - 첫 보호자는 자동으로 주 보호자
 * - 관리자가 체크했으면 주 보호자(나머지는 서버가 false 로 내린다)
 */
export function shouldBePrimaryOnAdd(existingCount: number, requestedPrimary: boolean): boolean {
  return existingCount === 0 || requestedPrimary;
}

/** 목록 정렬: 주 보호자 먼저, 그다음 등록 순서 — 다른 화면들의 ORDER BY "isPrimary" DESC, "createdAt" ASC 와 같다 */
export function sortGuardians<T extends Pick<GuardianRecord, "isPrimary" | "createdAt">>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/**
 * 보호자를 삭제한 뒤 새로 주 보호자가 될 사람의 id.
 * - 지운 사람이 주 보호자가 아니었으면 null(바꿀 것 없음)
 * - 남은 사람 중 이미 주 보호자가 있으면 null
 * - 아니면 남은 사람 중 가장 먼저 등록된 사람 — 다른 화면이 "대표 번호"로 고르던 사람과 같다
 */
export function nextPrimaryAfterDelete(
  list: Pick<GuardianRecord, "id" | "isPrimary" | "createdAt">[],
  deletedId: string,
): string | null {
  const deleted = list.find((g) => g.id === deletedId);
  if (!deleted || !deleted.isPrimary) return null;
  const remaining = list.filter((g) => g.id !== deletedId);
  if (remaining.length === 0) return null;
  if (remaining.some((g) => g.isPrimary)) return null;
  return sortGuardians(remaining)[0].id;
}

/** 삭제 확인창 문구 — 마지막 1명이면 경고를 덧붙인다 */
export function deleteConfirmMessage(
  target: Pick<GuardianRecord, "relation" | "name">,
  totalCount: number,
): string {
  const label = target.name && target.name !== target.relation ? `${target.relation} ${target.name}` : target.relation;
  const base = `보호자 「${label}」을(를) 삭제할까요?`;
  if (totalCount <= 1) {
    return `${base}\n\n⚠️ 이 학생의 마지막 보호자입니다. 삭제하면 등록된 보호자 번호가 하나도 남지 않습니다.\n(로그인 계정 전화는 그대로 남습니다)`;
  }
  return base;
}
