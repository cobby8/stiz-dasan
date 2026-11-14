// 학부모 «아이 기록» 맨 위 «아이 정보» 칸 계산 — 순수 함수(DB·React·시계 없음).
// 실행 테스트: tests/parent-child-profile-shuttle.test.mjs
//
// 관리자 원생 상세(학년·학교 / 성별·나이 / 생년월일 / 등록일 / 재원 기간 / 보호자)를 참고하되
// 학부모에게 보여도 되는 것만 고른다. 빼는 칸은 PROFILE_HIDDEN_COLUMNS — 조회 SQL 이 이 칸을 고르지 않는지 테스트가 본다.
import { schoolGradeFromBirth, gradeLabelFromText } from "@/lib/stats/statsRules";
import { isKstYmd } from "@/lib/datetime/kst";
import { realBirthYmd } from "@/lib/makeup/student-grade";

/**
 * 학부모 화면에 내리지 않는 Student 칸(관리자 내부 기록·원본·동의 원문·대조 메모).
 * 주소·학생 전화는 2026-11-14 원장 결정(b4 «학부모가 바로 고친다»)으로 학부모에게 보인다 — 목록에서 뺐다.
 */
export const PROFILE_HIDDEN_COLUMNS = [
  "memo",
  "hopeNote",
  "basketballExp",
  "referralSource",
  "agreementsJSON",
  "uniformNote",
  "uniformSource",
  "sourceImportRowId",
  "branch",
] as const;

/** 성별 원본(«남자»·«남»·«MALE»·«여자»·«여» …) → «남»·«여». 모르면 null */
export function genderText(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return null;
  if (v.startsWith("남") || v === "MALE" || v === "M") return "남";
  if (v.startsWith("여") || v === "FEMALE" || v === "F") return "여";
  return null;
}

/** 만 나이(생일이 지났는지까지) — 잘못된 날짜는 null */
export function koreanAge(birthYmdRaw: string | null | undefined, today: string): number | null {
  // 임시 생일(2000-01-01)은 진짜 생일이 아니라 나이를 내지 않는다
  const birthYmd = realBirthYmd(birthYmdRaw);
  if (!birthYmd || !isKstYmd(birthYmd) || !isKstYmd(today) || birthYmd > today) return null;
  const age = Number(today.slice(0, 4)) - Number(birthYmd.slice(0, 4)) - (today.slice(5) < birthYmd.slice(5) ? 1 : 0);
  return age >= 0 && age < 120 ? age : null;
}

/**
 * 학년 한 줄 — 생년월일 기준(3월 학년도, 원장 확정 기준 schoolGradeFromBirth)이 주인공.
 * 적힌 학년(Student.grade)이 다른 학년을 뜻하면 «등록 학년 …»을 덧붙인다(값은 고치지 않는다).
 * 임시 생일(2000-01-01)은 계산에 쓰지 않는다 — 보강 판정과 같은 함수(realBirthYmd)로 거른다.
 */
export function gradeLine(birthYmd: string | null | undefined, written: string | null | undefined, today: string): string {
  const computed = schoolGradeFromBirth(realBirthYmd(birthYmd), today);
  const w = String(written ?? "").trim();
  if (computed === "미상") return w || "-";
  const writtenLabel = gradeLabelFromText(w);
  if (w && writtenLabel !== computed) return `${computed} · 등록 학년 ${w}`;
  return computed;
}

/** 생년월일 한 줄 «2015.3.2 · 만 11세» — 임시 생일·빈 값은 «-»(진짜 생일이 아니다) */
export function birthLine(birthYmd: string | null | undefined, today: string): string {
  const birth = realBirthYmd(birthYmd);
  if (!birth || !dotYmd(birth)) return "-";
  const age = koreanAge(birth, today);
  return age !== null ? `${dotYmd(birth)} · 만 ${age}세` : dotYmd(birth);
}

/** "2015-03-02" → "2015.3.2" */
export function dotYmd(ymd: string | null | undefined): string {
  if (!ymd || !isKstYmd(ymd)) return "";
  return `${ymd.slice(0, 4)}.${Number(ymd.slice(5, 7))}.${Number(ymd.slice(8, 10))}`;
}

export type GuardianInfo = {
  /** 대표 보호자 이름(학생 칸 parentId 계정) */
  representativeName: string | null;
  /** 지금 로그인한 사람이 대표 보호자인가 */
  meIsRepresentative: boolean;
  /** 로그인한 본인 계정 이름·전화(본인 것만 번호를 보인다) */
  me: { name: string | null; phone: string | null };
  /** 연결된 다른 가족 이름(번호는 보이지 않는다) */
  familyNames: string[];
};

/** 보호자 행 «라벨 : 값» — 다른 사람의 전화번호는 내리지 않는다 */
export function guardianRows(g: GuardianInfo): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: "대표 보호자", value: g.meIsRepresentative ? `${g.me.name || g.representativeName || "나"} (나)` : g.representativeName || "-" });
  rows.push({ label: "내 연락처", value: g.me.phone?.trim() || "등록 안 됨" });
  if (g.familyNames.length > 0) rows.push({ label: "연결 가족", value: g.familyNames.join(", ") });
  return rows;
}

/** 보강권 한 줄 «사용 가능 2장 · 12.31까지» / «예약 1장» / «없음» */
export function makeupLine(m: { available: number; reserved: number; nearestExpiryYmd: string | null }): string {
  const parts: string[] = [];
  if (m.available > 0) parts.push(`사용 가능 ${m.available}장${m.nearestExpiryYmd ? ` · ${dotYmd(m.nearestExpiryYmd).slice(5)}까지` : ""}`);
  if (m.reserved > 0) parts.push(`예약 ${m.reserved}장`);
  return parts.length > 0 ? parts.join(" · ") : "없음";
}

/** 수업 시간 «월 18:00~19:20» */
const DAY_KO: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
export function classTimeText(dayOfWeek: string, startTime: string, endTime: string): string {
  const day = DAY_KO[dayOfWeek] ?? dayOfWeek;
  return [day, [startTime, endTime].filter(Boolean).join("~")].filter(Boolean).join(" ");
}
