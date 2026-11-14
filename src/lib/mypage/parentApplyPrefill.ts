/**
 * 학부모 앱 안 방학특강 신청서 «미리 채움» 값 (2026-11-14 원장 결정표 c9) — 순수 함수.
 *
 * - 보호자 이름·연락처: 로그인한 학부모 계정 값.
 * - 아이 이름·생년월일: 아이가 «한 명»일 때만. 형제면 누구 신청인지 모르므로 비워 둔다(틀린 아이가 채워지는 것보다 낫다).
 * - 임시 생일(2000-01-01 — 생일을 모를 때 넣어 둔 값)은 채우지 않는다(보강 학년 판정과 같은 함수).
 * 날짜는 KST 달력 날짜 "YYYY-MM-DD" 로만 넘긴다.
 */
import { isKstYmd, toKstYmd } from "@/lib/datetime/kst";
import { formatPhoneInput } from "@/lib/application-display-format";
import { realBirthYmd } from "@/lib/makeup/student-grade";

type PrefillSource = {
  parent?: { name?: string | null; phone?: string | null } | null;
  children?: readonly { name?: string | null; birthDate?: Date | string | null }[] | null;
} | null | undefined;

export type SeasonalApplyPrefillValue = { parentName?: string; parentPhone?: string; childName?: string; childBirthDate?: string };

export function seasonalApplyPrefill(source: PrefillSource): SeasonalApplyPrefillValue {
  const out: SeasonalApplyPrefillValue = {};
  const parentName = String(source?.parent?.name ?? "").trim();
  if (parentName) out.parentName = parentName;
  const phone = formatPhoneInput(String(source?.parent?.phone ?? ""));
  if (phone) out.parentPhone = phone;

  const children = source?.children ?? [];
  if (children.length === 1) {
    const childName = String(children[0].name ?? "").trim();
    if (childName) out.childName = childName;
    const raw = children[0].birthDate;
    const ymd = raw ? toKstYmd(raw) : "";
    const birth = isKstYmd(ymd) ? realBirthYmd(ymd) : null;
    if (birth) out.childBirthDate = birth;
  }
  return out;
}
