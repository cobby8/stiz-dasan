/**
 * 통계 규칙 한 곳(순수 함수) — 2026-11-13 대시보드·통계 개편(원장 결정표 6칸 «추천대로» 승인).
 *
 * 왜 따로 두나:
 *   학년·성별·지점·유니폼 묶음·비율은 대시보드 카드와 통계 탭 5개가 같은 답을 내야 한다.
 *   SQL·화면마다 따로 계산하면 «대시보드 62%, 통계 60%» 같은 어긋남이 생긴다.
 *   그래서 판정은 이 파일 하나에 두고, 쿼리(statsQueries.ts)는 원본 값만 읽어 여기에 넘긴다.
 *
 * ■ 원장 확정 기준(2026-11-13)
 *   - 학년 = 생년월일로 계산. 학년도는 KST 3월 기준(1·2월은 전년도).
 *     학년 = 학년도 − 출생연도 − 6 → 1~6 초, 7~9 중, 10~12 고, 0 이하 «7세 이하».
 *     13 이상은 «성인»(운영 DB 에 성인반 22명이 있어 «미상»에 섞지 않는다), 생일을 못 읽으면 «미상».
 *   - Student.grade 글과 다르면 «확인 필요 N명»으로만 알린다(값을 고치지 않는다).
 *   - 출석률 = (출석 + 지각) ÷ (출석 + 지각 + 결석 + 사유결석) — 기존 출결 화면과 같은 «기록 전체» 분모.
 *   - 유니폼 보유율 분모 = 재원생 전체(확인 필요·해당없음 포함).
 *
 * ⚠️ 이 파일은 prisma·next 를 import 하지 않는다 — `node --test` 로 실제 실행해 검증한다
 *    (tests/admin-stats-rules.test.mjs). 날짜는 "YYYY-MM-DD" 문자열로만 받는다.
 */
import { addMonthsYm, isKstYmd } from "@/lib/datetime/kst";

// ── 학년 ────────────────────────────────────────────────────────────────

/** 화면에 그리는 학년 순서(막대 순서) */
export const GRADE_LABELS = [
    "7세 이하",
    "초1", "초2", "초3", "초4", "초5", "초6",
    "중1", "중2", "중3",
    "고1", "고2", "고3",
    "성인", "미상",
] as const;
export type GradeLabel = (typeof GRADE_LABELS)[number];

/** 학년 묶음(성비 막대 줄) — 초·중·고·기타 */
export const GRADE_BANDS = ["7세 이하", "초등", "중등", "고등", "성인", "미상"] as const;
export type GradeBand = (typeof GRADE_BANDS)[number];

/** 학년도 — 3월 1일에 바뀐다. 1·2월은 전년도. (KST 날짜 문자열로만 판단) */
export function schoolYearOf(todayYmd: string): number | null {
    if (!isKstYmd(todayYmd)) return null;
    const year = Number(todayYmd.slice(0, 4));
    const month = Number(todayYmd.slice(5, 7));
    return month >= 3 ? year : year - 1;
}

/** 생년월일 → 학년 숫자(초1=1 … 고3=12). 0 이하 = 미취학, 못 읽으면 null */
export function schoolGradeNumber(birthYmd: string | null | undefined, todayYmd: string): number | null {
    const schoolYear = schoolYearOf(todayYmd);
    if (schoolYear === null || !birthYmd || !isKstYmd(birthYmd)) return null;
    const birthYear = Number(birthYmd.slice(0, 4));
    // 미래 생일·지나치게 오래된 값은 오입력으로 본다
    if (birthYmd > todayYmd || schoolYear - birthYear > 100) return null;
    return schoolYear - birthYear - 6;
}

/** 학년 숫자 → 화면 이름 */
export function gradeLabelOfNumber(n: number | null): GradeLabel {
    if (n === null || !Number.isFinite(n)) return "미상";
    if (n <= 0) return "7세 이하";
    if (n <= 6) return `초${n}` as GradeLabel;
    if (n <= 9) return `중${n - 6}` as GradeLabel;
    if (n <= 12) return `고${n - 9}` as GradeLabel;
    return "성인";
}

/** 생년월일 → 학년 이름(원장 확정 기준) */
export function schoolGradeFromBirth(birthYmd: string | null | undefined, todayYmd: string): GradeLabel {
    return gradeLabelOfNumber(schoolGradeNumber(birthYmd, todayYmd));
}

/** 학년 이름 → 묶음 */
export function gradeBandOf(label: GradeLabel): GradeBand {
    if (label.startsWith("초")) return "초등";
    if (label.startsWith("중")) return "중등";
    if (label.startsWith("고")) return "고등";
    return label as GradeBand;
}

/**
 * Student.grade 글(«초6»·«2026년 초등 5학년»·«4학년»·«7세»·«성인») → 학년 이름. 못 읽으면 null.
 * «4학년»처럼 학교급이 없으면 초등으로 본다(옛 시트 관례).
 */
export function gradeLabelFromText(text: string | null | undefined): GradeLabel | null {
    const raw = String(text ?? "").replace(/\s+/g, "");
    if (!raw) return null;
    if (raw.includes("성인")) return "성인";
    const age = /(\d+)세/.exec(raw);
    if (age && !/학년/.test(raw)) return Number(age[1]) <= 7 ? "7세 이하" : null;
    if (/유치|미취학/.test(raw)) return "7세 이하";
    const m = /(초|초등|중|중등|고|고등)?(?:학교)?(\d{1,2})(?:학년)?$/.exec(raw.replace(/^\d{4}년/, ""));
    if (!m) return null;
    const level = m[1] ?? "초";
    const n = Number(m[2]);
    if (level.startsWith("초") && n >= 1 && n <= 6) return `초${n}` as GradeLabel;
    if (level.startsWith("중") && n >= 1 && n <= 3) return `중${n}` as GradeLabel;
    if (level.startsWith("고") && n >= 1 && n <= 3) return `고${n}` as GradeLabel;
    return null;
}

/** 계산한 학년과 적힌 학년 글이 다른가 — 둘 다 읽을 수 있을 때만 비교한다(빈 글은 «다름» 아님) */
export function gradeNeedsCheck(computed: GradeLabel, gradeText: string | null | undefined): boolean {
    const written = gradeLabelFromText(gradeText);
    if (!written || computed === "미상") return false;
    return written !== computed;
}

// ── 성별 ────────────────────────────────────────────────────────────────

export const GENDER_LABELS = ["남", "여", "미입력"] as const;
export type GenderLabel = (typeof GENDER_LABELS)[number];

/** «남자»·«남»·MALE·M → 남, «여자»·«여»·FEMALE·F → 여, 그 밖 → 미입력(운영 DB 에 다섯 가지 표기가 섞여 있다) */
export function normalizeGender(value: string | null | undefined): GenderLabel {
    const raw = String(value ?? "").trim().toUpperCase();
    if (!raw) return "미입력";
    if (raw.startsWith("남") || raw === "M" || raw === "MALE" || raw === "BOY") return "남";
    if (raw.startsWith("여") || raw === "F" || raw === "FEMALE" || raw === "GIRL") return "여";
    return "미입력";
}

// ── 지점 ────────────────────────────────────────────────────────────────

/** 필터에 쓰는 지점 열쇠 — 전체·다산2·평내호평·미지정(원장 결정표) */
export const STATS_BRANCHES = [
    { key: "all", label: "전체" },
    { key: "dasan2", label: "다산2호점" },
    { key: "pyeongnae", label: "평내호평점" },
    { key: "none", label: "미지정" },
] as const;
export type StatsBranchKey = (typeof STATS_BRANCHES)[number]["key"];

export function isStatsBranchKey(value: unknown): value is StatsBranchKey {
    return STATS_BRANCHES.some((b) => b.key === value);
}

/**
 * 지점 화면 이름(branchLabel 결과, 비면 "") → 묶음 이름·열쇠.
 * 다산1호점(2026-02-28 폐점)처럼 필터에 없는 지점은 이름은 그대로 두고 열쇠는 "other"(전체에서만 보인다).
 */
export function branchGroup(label: string | null | undefined): { key: StatsBranchKey | "other"; label: string } {
    const text = String(label ?? "").trim();
    if (!text) return { key: "none", label: "미지정" };
    if (text === "다산2호점") return { key: "dasan2", label: text };
    if (text === "평내호평점") return { key: "pyeongnae", label: text };
    return { key: "other", label: text };
}

// ── 유니폼 ──────────────────────────────────────────────────────────────

/** 유니폼 4묶음 + 해당없음 — 상태값 9종(UNIFORM_STATUS_VALUES)을 원장 결정표대로 나눈다 */
export const UNIFORM_GROUPS = ["보유", "진행 중", "없음", "확인 필요", "해당없음"] as const;
export type UniformGroup = (typeof UNIFORM_GROUPS)[number];

export function uniformGroup(status: string | null | undefined): UniformGroup {
    const s = String(status ?? "").trim();
    if (s === "보유" || s === "수령완료") return "보유";
    if (s === "신청" || s === "주문" || s === "미수령") return "진행 중";
    if (s === "미보유" || s === "미신청") return "없음";
    if (s === "해당없음") return "해당없음";
    // 확인보류·빈값·모르는 값
    return "확인 필요";
}

// ── 숫자 ────────────────────────────────────────────────────────────────

/** 비율(정수 %) — 분모 0 이면 null(화면은 «–») */
export function rate(n: number, d: number): number | null {
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return Math.round((n / d) * 100);
}

/** 두 비율의 차이(%p) — 어느 한쪽이 null 이면 null */
export function diffPoint(current: number | null, previous: number | null): number | null {
    if (current === null || previous === null) return null;
    return current - previous;
}

/** 값 목록 → [{label,count}] (정해진 순서 + 그 밖 값은 많은 순 뒤에) */
export function countBy<T extends string>(values: readonly T[], order: readonly string[] = []): { label: string; count: number }[] {
    const map = new Map<string, number>();
    for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
    const fixed = order.filter((k) => map.has(k)).map((k) => ({ label: k, count: map.get(k) ?? 0 }));
    const rest = [...map.entries()]
        .filter(([k]) => !order.includes(k))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))
        .map(([label, count]) => ({ label, count }));
    return [...fixed, ...rest];
}

/** "YYYY-MM" 부터 count 개월(과거 → 현재 순). 시간대 개입 없이 달 숫자만 센다 */
export function monthSeries(fromYm: string, count: number): string[] {
    if (!/^\d{4}-\d{2}$/.test(fromYm) || !Number.isInteger(count) || count <= 0) return [];
    return Array.from({ length: count }, (_, i) => addMonthsYm(fromYm, i)).filter(Boolean);
}

/** 이번 달 "YYYY-MM" 에서 거슬러 n 개월(이번 달 포함) */
export function lastMonths(currentYm: string, count: number): string[] {
    return monthSeries(addMonthsYm(currentYm, -(count - 1)), count);
}

/** "2026-03" → "3월", 1월은 연도를 붙여 해가 바뀐 걸 보이게 «'27.1월» */
export function monthShortLabel(ym: string): string {
    const m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) return ym;
    const month = Number(m[2]);
    return month === 1 ? `'${m[1].slice(2)}.1월` : `${month}월`;
}

/** 금액 표기 — 1만원 이상 «42.5만원», 그 밖 «9,000원»(기존 formatKRW 와 같은 규칙) */
export function formatKRW(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}만원`;
    return n.toLocaleString("ko-KR") + "원";
}

/** 비율 표기 — null 이면 «–» */
export function formatRate(value: number | null): string {
    return value === null ? "–" : `${value}%`;
}

/** %p 표기 — +3%p / −2%p / 0%p, null 이면 «–» */
export function formatPoint(value: number | null): string {
    if (value === null) return "–";
    if (value > 0) return `+${value}%p`;
    if (value < 0) return `−${Math.abs(value)}%p`;
    return "0%p";
}

// ── 통계 탭·기간 ────────────────────────────────────────────────────────

export const STATS_TABS = [
    { key: "students", label: "원생", icon: "groups" },
    { key: "funnel", label: "유입·전환", icon: "conversion_path" },
    { key: "attendance", label: "수업·출결", icon: "fact_check" },
    { key: "billing", label: "수납", icon: "payments" },
    { key: "uniform", label: "유니폼", icon: "checkroom" },
] as const;
export type StatsTabKey = (typeof STATS_TABS)[number]["key"];

export function isStatsTabKey(value: unknown): value is StatsTabKey {
    return STATS_TABS.some((t) => t.key === value);
}

/** 탭마다 뜻이 있는 기간만 고른다. 첫 값이 기본값. 유니폼은 «지금 상태»라 기간이 없다 */
export const STATS_PERIODS: Record<StatsTabKey, readonly { key: string; label: string }[]> = {
    students: [{ key: "12m", label: "최근 12개월" }, { key: "6m", label: "최근 6개월" }, { key: "24m", label: "최근 24개월" }],
    funnel: [{ key: "30d", label: "최근 30일" }, { key: "month", label: "이번 달" }, { key: "all", label: "전체 기간" }],
    attendance: [{ key: "12m", label: "최근 12개월" }, { key: "6m", label: "최근 6개월" }],
    billing: [{ key: "12m", label: "최근 12개월" }, { key: "6m", label: "최근 6개월" }],
    uniform: [],
};

/** 주소의 기간 값 → 그 탭에서 쓸 수 있는 값(모르면 기본값, 기간 없는 탭은 "") */
export function normalizeStatsPeriod(tab: StatsTabKey, value: unknown): string {
    const list = STATS_PERIODS[tab];
    if (list.length === 0) return "";
    return list.some((p) => p.key === value) ? String(value) : list[0].key;
}

/** "12m" → 12 */
export function periodMonths(period: string): number {
    const m = /^(\d+)m$/.exec(period);
    return m ? Number(m[1]) : 12;
}
