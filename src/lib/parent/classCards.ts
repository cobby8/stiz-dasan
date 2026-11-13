/**
 * 학부모 «수업» 탭 반 카드 계산 — 순수 함수(DB·React·시계 없음).
 *
 * 왜 따로 두나: 반 카드 한 장에 «상태 칩·다음 수업·최근 출결 4칸·셔틀·누를 버튼»이 모인다.
 * 이 판정을 화면 안에 섞으면 실행 테스트를 못 붙인다(날짜·휴원 예정 경계는 눈으로 못 잡는다).
 * 그래서 계산은 여기, 화면(ClassesClient)은 그리기만 한다.
 *
 * 날짜는 전부 "YYYY-MM-DD" 문자열. 변환은 공용 KST 모듈만 쓴다.
 */
import { kstHm, toKstYmd } from "@/lib/datetime/kst";
import { buildClassStatusLine, shortMd, type ClassStatusInput } from "@/lib/enrollment/parentChangeStatus";
import type { StatusTone } from "@/lib/ui/statusTones";

/** 반 카드 상태 칩 — 색 뜻은 statusTones 의 다섯 가지만 쓴다(색 클래스는 화면이 TONE_BADGE_CLASS 로) */
export type ClassChip = { text: string; tone: StatusTone };

/**
 * 상태 칩. 홈 «반 상태 한 줄»과 같은 함수(buildClassStatusLine)를 그대로 쓴다 — 두 화면이 같은 말을 해야 한다.
 * 보여 줄 게 없으면(그냥 다니는 중) «수강 중».
 */
export function classStatusChip(input: ClassStatusInput): ClassChip {
  const line = buildClassStatusLine(input);
  if (!line) return { text: "수강 중", tone: "success" };
  // parentChangeStatus 의 tone(info/warning/muted) → statusTones 이름. muted(휴원 중)는 «중립».
  const tone: StatusTone = line.tone === "muted" ? "neutral" : line.tone;
  return { text: line.text, tone };
}

/**
 * 다음 수업일 — 오늘 포함 이후 가장 이른 수업일.
 * stopFrom: 승인된 휴원·퇴원 적용일. 그날부터는 수업이 없으니 그 전 날짜만 «다음 수업»이다.
 * 휴원 중(PAUSED)이면 다음 수업이 없다(null).
 * resumeFrom(2026-11-14 복귀 예정): 휴원 중이어도 복귀가 승인됐으면 복귀일 이후 첫 수업이 «다음 수업»이다.
 */
export function nextClassDate(input: {
  dates: string[];
  today: string;
  paused: boolean;
  stopFrom?: string | null;
  resumeFrom?: string | null;
}): string | null {
  if (input.paused && !input.resumeFrom) return null;
  const sorted = [...input.dates].sort();
  for (const d of sorted) {
    if (d < input.today) continue;
    // 복귀일 전 수업은 아직 휴원이라 건너뛴다
    if (input.paused && input.resumeFrom && d < input.resumeFrom) continue;
    if (input.stopFrom && d >= input.stopFrom) return null;
    return d;
  }
  return null;
}

/** label = 칸 밑에 적는 짧은 날짜 «11/3» */
export type AttendanceCell = { ymd: string; label: string; status: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED" | "OTHER" };

const ATT_STATUS = new Set(["PRESENT", "LATE", "ABSENT", "EXCUSED"]);

/**
 * 최근 출결 4칸(오래된 것 → 최근 순으로 왼쪽부터). 날짜는 어떤 형식이든 KST 달력 날짜로 바꾼다.
 * 같은 날 기록이 둘이면 더 늦은 기록 하나만.
 */
export function recentAttendanceCells(records: { status: string; date: Date | string }[], max = 4): AttendanceCell[] {
  const seen = new Set<string>();
  const cells: AttendanceCell[] = [];
  // 실제 시각 기준 최근 순(같은 날 두 기록이면 늦은 기록이 먼저 와서 남는다)
  const sorted = records
    .map((r) => ({ status: r.status, ymd: toKstYmd(r.date), ms: new Date(r.date).getTime() }))
    .filter((r) => r.ymd)
    .sort((a, b) => b.ms - a.ms);
  for (const r of sorted) {
    if (seen.has(r.ymd)) continue;
    seen.add(r.ymd);
    cells.push({ ymd: r.ymd, label: shortMd(r.ymd), status: (ATT_STATUS.has(r.status) ? r.status : "OTHER") as AttendanceCell["status"] });
    if (cells.length >= max) break;
  }
  return cells.reverse();
}

/** 출결 칸 이름(모양과 함께 보이는 한 글자 — 색만으로 구분하지 않는다) */
export const ATTENDANCE_CELL_LABEL: Record<AttendanceCell["status"], string> = {
  PRESENT: "출석",
  LATE: "지각",
  ABSENT: "결석",
  EXCUSED: "결석", // 사전 신고한 결석(인정 결석)도 학부모에겐 «결석»
  OTHER: "기록",
};

/** 셔틀 항목에서 반 카드가 쓰는 칸만(ParentShuttleOverviewItem 의 부분집합 — 순수 모듈이라 타입을 따로 둔다) */
export type ShuttleItemLike = {
  studentId: string;
  sourceType: string;
  classId?: string | null;
  title: string;
  direction: "PICKUP" | "DROPOFF" | null;
  status: string;
  serviceDate: string | null;
  stopName: string | null;
  plannedAt: string | null;
  pickupEtaLabel?: string | null;
  dropoffEtaLabel?: string | null;
};

export type ClassShuttleLine = { direction: "PICKUP" | "DROPOFF"; text: string };

/**
 * 반 카드의 셔틀 한 줄(등원·하원 각각). 이 아이·이 반의 정규 셔틀만 고른다.
 * - 반 연결은 classId 로(없는 옛 자료는 반 이름으로 보조 매칭).
 * - 오늘 이후 가장 가까운 운행을, 없으면 가장 최근 운행을 쓴다.
 * - 배차 준비 중(정류장 없음)이면 «배차 준비 중».
 * 시각은 KST «HH:MM» (확정 시각 라벨이 있으면 그것을 우선).
 */
export function classShuttleLines(
  items: ShuttleItemLike[],
  card: { studentId: string; classId: string; className: string },
  today: string,
): ClassShuttleLine[] {
  const mine = items.filter(
    (it) =>
      it.sourceType === "REGULAR_CLASS" &&
      it.studentId === card.studentId &&
      (it.classId ? it.classId === card.classId : it.title === card.className),
  );
  const out: ClassShuttleLine[] = [];
  for (const direction of ["PICKUP", "DROPOFF"] as const) {
    const list = mine.filter((it) => it.direction === direction);
    if (list.length === 0) continue;
    const upcoming = list
      .filter((it) => it.serviceDate && it.serviceDate >= today)
      .sort((a, b) => String(a.serviceDate).localeCompare(String(b.serviceDate)));
    const past = list
      .filter((it) => !it.serviceDate || it.serviceDate < today)
      .sort((a, b) => String(b.serviceDate ?? "").localeCompare(String(a.serviceDate ?? "")));
    const pick = upcoming[0] ?? past[0];
    const name = direction === "PICKUP" ? "등원" : "하원";
    if (!pick.stopName) {
      out.push({ direction, text: `${name} 배차 준비 중` });
      continue;
    }
    const eta = direction === "PICKUP" ? pick.pickupEtaLabel : pick.dropoffEtaLabel;
    // 확정 라벨은 «08:53 승차» 꼴이라 시각만 떼어 쓴다. 없으면 정류장 예정 시각(KST).
    const time = (eta && /^\d{1,2}:\d{2}/.exec(eta)?.[0]) || (pick.plannedAt ? kstHm(pick.plannedAt) : "");
    out.push({ direction, text: [name, pick.stopName, time].filter(Boolean).join(" · ") });
  }
  return out;
}

export type ClassCardAction =
  | { key: "absence" | "makeup" | "shuttle" | "resume"; label: string; href: string }
  | { key: "change"; label: string; items: { key: string; label: string; href: string }[] };

/** 신청 화면 주소 + 미리 고를 값(기존 화면이 ?studentId=&enrollmentId= 를 읽어 그 아이·그 반을 먼저 보인다) */
export function presetHref(path: string, params: { studentId: string; enrollmentId?: string; kind?: string }): string {
  const q = new URLSearchParams();
  q.set("studentId", params.studentId);
  if (params.enrollmentId) q.set("enrollmentId", params.enrollmentId);
  if (params.kind) q.set("kind", params.kind);
  return `${path}?${q.toString()}`;
}

/**
 * 반 카드 버튼. 다니는 중 = [결석][보강][셔틀][변경 ▾](반 변경·휴원·퇴원), 휴원 중 = [복귀 신청] 하나.
 * 2026-11-10 원장 점검: 휴대폰 375px 에서 한 줄에 들어가게 짧은 이름으로(«셔틀 변경»→«셔틀», «반 변경·휴원»→«변경»).
 * 휴원 중인 반은 신청 화면이 «복귀»만 받으므로(반 변경·퇴원·결석 불가) 복귀 버튼 하나를 유지한다.
 * 버튼은 «새 신청 화면»이 아니라 기존 신청 화면으로 간다(원장 결정 d7 — 같은 화면을 두 벌 만들지 않는다).
 * 복귀 예정(2026-11-14): 복귀가 승인된 휴원 반(resumeFrom 있음)은 일반 반처럼 [결석][보강][셔틀]을 준다
 *   (복귀일 이후 수업만 받는 것은 각 신청 화면·서버가 지킨다). [변경 ▾]은 뺀다 — 수강이 아직 휴원이라
 *   반 변경·휴원·퇴원 신청은 서버가 받지 않는다(복귀가 반영된 뒤 생긴다).
 */
export function classCardActions(card: { studentId: string; enrollmentId: string; paused: boolean; resumeFrom?: string | null }): ClassCardAction[] {
  const base = { studentId: card.studentId, enrollmentId: card.enrollmentId };
  const requests: ClassCardAction[] = [
    { key: "absence", label: "결석", href: presetHref("/mypage/regular-absence", base) },
    { key: "makeup", label: "보강", href: presetHref("/mypage/makeup", { studentId: card.studentId }) },
    { key: "shuttle", label: "셔틀", href: presetHref("/mypage/shuttle", { studentId: card.studentId }) },
  ];
  if (card.paused) {
    if (card.resumeFrom) return requests;
    return [{ key: "resume", label: "복귀 신청", href: presetHref("/mypage/enrollment-change", base) }];
  }
  return [
    ...requests,
    {
      key: "change",
      label: "변경",
      items: [
        { key: "CLASS_CHANGE", label: "반 변경", href: presetHref("/mypage/enrollment-change", { ...base, kind: "CLASS_CHANGE" }) },
        { key: "PAUSE", label: "휴원", href: presetHref("/mypage/enrollment-change", { ...base, kind: "PAUSE" }) },
        { key: "WITHDRAW", label: "퇴원", href: presetHref("/mypage/enrollment-change", { ...base, kind: "WITHDRAW" }) },
      ],
    },
  ];
}

const DAY_KO: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };

/** "Mon" → "월". 모르는 값은 그대로. */
export function dayKo(dayOfWeek: string): string {
  return DAY_KO[dayOfWeek] ?? dayOfWeek;
}
