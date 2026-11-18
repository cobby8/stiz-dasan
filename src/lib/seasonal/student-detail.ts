import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";

// 방학특강 수강생 상세(공통 모달용). 신청서(학생·보호자) + 수강 수업 + 셔틀 정보를 한 번에 정리해 반환한다.

export type StudentDetail = {
  applicationId: string;
  child: { name: string; grade: string | null; gender: string | null; school: string | null; birthDate: string | null; phone: string | null };
  parent: { name: string | null; relation: string | null; phone: string | null };
  application: {
    status: string | null; applicantType: string | null;
    /** 화면 한 줄 라벨 — 요일("월·수"), 기간이면 "월·수 · 앞 3주", 날짜 선택이면 "날짜 선택 3회 (12/22·12/24·12/29)" */
    weekdayLabel: string | null;
    createdAt: string | null;
    /** 날짜별 선택일 때 고른 날짜(KST 'YYYY-MM-DD'), 아니면 빈 배열(2026-11-18) */
    selectedDates: string[];
    /** 고른 기간 이름(없으면 null, 2026-11-18) */
    periodLabel: string | null;
  };
  classes: { title: string; classStart: string | null; classEnd: string | null; status: string | null }[];
  shuttle: {
    ride: boolean;
    pickupLocation: string | null; pickupPinned: boolean; pickupApprox: boolean; pickupLat: number | null; pickupLng: number | null;
    dropoffLocation: string | null; dropoffPinned: boolean; dropoffApprox: boolean; dropoffLat: number | null; dropoffLng: number | null;
    dropoffSameAsPickup: boolean; pickupTime: string | null;
  } | null;
};

const WD_KO: Record<string, string> = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };
function weekdayLabel(arr: unknown): string | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((k) => WD_KO[String(k)] ?? "").filter(Boolean).join("·") || null;
}
// 고른 날짜 목록 정리(null·빈 값 방어). 기존 신청서는 빈 배열.
function cleanDates(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}
// 'YYYY-MM-DD' → 'M/D' (문자열만 자른다 — Date 를 거치지 않아 시간대 영향이 없다)
function shortMonthDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${Number(m[2])}/${Number(m[3])}` : value;
}
/**
 * 신청 방식 라벨(2026-11-18).
 *   날짜 선택 → "날짜 선택 N회 (12/22·12/24)"
 *   기간      → "월·수 · 앞 3주" (요일이 없으면 기간 이름만)
 *   그 외     → 예전 요일 라벨 그대로
 */
export function applicationScheduleLabel(app: {
  selectedWeekdays?: unknown; selectedDates?: unknown; periodLabel?: unknown;
}): string | null {
  const dates = cleanDates(app.selectedDates);
  if (dates.length > 0) {
    const sorted = [...dates].sort();
    return `날짜 선택 ${dates.length}회 (${sorted.map(shortMonthDay).join("·")})`;
  }
  const weekdays = weekdayLabel(app.selectedWeekdays);
  const period = typeof app.periodLabel === "string" && app.periodLabel.trim() ? app.periodLabel.trim() : null;
  if (period) return weekdays ? `${weekdays} · ${period}` : period;
  return weekdays;
}
function pinned(s: unknown) { return s === "MAP_PIN" || s === "CURRENT_LOCATION"; }
function ymd(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

export async function getSeasonalStudentDetail(applicationId: string): Promise<StudentDetail | null> {
  await requireAdmin();
  if (!applicationId) return null;

  const apps = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "SpecialProgramApplication" WHERE id = $1 LIMIT 1`, applicationId,
  );
  const a = apps[0];
  if (!a) return null;

  const items = await prisma.$queryRawUnsafe<any[]>(
    `SELECT it.status,
            o.title AS "offeringTitle",
            (SELECT to_char(min(sd."startsAt") AT TIME ZONE 'Asia/Seoul','HH24:MI') FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = o.id) AS "classStart",
            (SELECT to_char(min(sd."endsAt")   AT TIME ZONE 'Asia/Seoul','HH24:MI') FROM "SpecialProgramSessionDate" sd WHERE sd."offeringId" = o.id) AS "classEnd"
       FROM "SpecialProgramApplicationItem" it
       LEFT JOIN "SpecialProgramOffering" o ON o.id = it."offeringId"
      WHERE it."applicationId" = $1
      ORDER BY o.title ASC`,
    applicationId,
  );

  const sh = await prisma.$queryRawUnsafe<any[]>(
    `SELECT r.status, r."pickupLocation", r."pickupTime", r."pickupLocationSource" AS "pSrc", r."pickupLatitude" AS "pLat", r."pickupLongitude" AS "pLng",
            r."dropoffLocation", r."dropoffLocationSource" AS "dSrc", r."dropoffLatitude" AS "dLat", r."dropoffLongitude" AS "dLng",
            COALESCE(r."dropoffSameAsPickup", false) AS "same"
       FROM "SpecialProgramShuttleRequest" r WHERE r."applicationId" = $1 LIMIT 1`,
    applicationId,
  );
  const s = sh[0];

  return {
    applicationId,
    child: {
      name: a.childName, grade: a.childGrade ?? null, gender: a.childGender ?? null,
      school: a.childSchool ?? null, birthDate: ymd(a.childBirthDate), phone: a.childPhone ?? null,
    },
    parent: { name: a.parentName ?? null, relation: a.parentRelation ?? null, phone: a.parentPhone ?? null },
    application: {
      status: a.status ?? null,
      applicantType: a.applicantType ?? null,
      // 요일 / 기간 / 날짜 선택을 한 줄 라벨로(기존 신청서는 예전 요일 라벨과 같다)
      weekdayLabel: applicationScheduleLabel(a),
      createdAt: a.createdAt ? String(a.createdAt).slice(0, 10) : null,
      selectedDates: [...cleanDates(a.selectedDates)].sort(),
      periodLabel: typeof a.periodLabel === "string" && a.periodLabel.trim() ? a.periodLabel.trim() : null,
    },
    classes: items.map((it) => ({ title: it.offeringTitle ?? "-", classStart: it.classStart ?? null, classEnd: it.classEnd ?? null, status: it.status ?? null })),
    shuttle: s ? {
      ride: s.status !== "CANCELLED",
      pickupLocation: s.pickupLocation ?? null, pickupPinned: pinned(s.pSrc), pickupApprox: s.pLat != null && s.pSrc === "SEARCH",
      pickupLat: s.pLat != null ? Number(s.pLat) : null, pickupLng: s.pLng != null ? Number(s.pLng) : null,
      dropoffLocation: s.dropoffLocation ?? null, dropoffPinned: pinned(s.dSrc), dropoffApprox: s.dLat != null && s.dSrc === "SEARCH",
      dropoffLat: s.dLat != null ? Number(s.dLat) : null, dropoffLng: s.dLng != null ? Number(s.dLng) : null,
      dropoffSameAsPickup: s.same === true, pickupTime: s.pickupTime ?? null,
    } : null,
  };
}
