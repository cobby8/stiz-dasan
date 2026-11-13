/**
 * 대시보드 카드·통계 탭이 주고받는 자료 모양 — 2026-11-13 대시보드·통계 개편.
 * 화면(클라이언트)이 서버 전용 쿼리 파일(prisma)을 끌어오지 않도록 모양만 따로 둔다.
 * ⚠️ 재원생 수·명단이 들어 있다 → 관리자 전용 payload 에서만 쓴다(공개 쿼리·캐시 키와 섞지 않는다).
 */
import type { StatsBranchKey, StatsTabKey } from "./statsRules";

export type LabelCount = { label: string; count: number };
export type MonthFlow = { ym: string; label: string; newCount: number; leftCount: number };
export type MonthRate = { ym: string; label: string; rate: number | null; total: number };
export type MonthAmount = { ym: string; label: string; amount: number; count: number };

/** 대시보드 맨 위 카드 6개 */
export type DashboardSummary = {
    currentYm: string;
    students: { active: number; byBranch: LabelCount[] };
    billing: { rateAmount: number | null; paidAmount: number; billedAmount: number; unpaidCount: number; unpaidAmount: number };
    attendance: { rate: number | null; prevRate: number | null; diff: number | null; series: MonthRate[] };
    flow: { newCount: number; leftCount: number; series: MonthFlow[] };
    funnel: { inquiries: number; attended: number; converted: number; rate: number | null };
    uniform: { rate: number | null; owned: number; total: number; needsCheck: number; segments: LabelCount[] };
};

export type StatsStudentsTab = {
    tab: "students";
    active: number;
    newThisMonth: number;
    leftThisMonth: number;
    gradeNeedsCheck: number;
    grades: LabelCount[];
    genderTotal: { male: number; female: number; unknown: number };
    genderByBand: { band: string; male: number; female: number; unknown: number }[];
    branches: LabelCount[];
    flow: MonthFlow[];
    /** 사이트에 남은 가장 이른 수강 기록 달 — «사이트 기록 시작 이후» 안내에 쓴다 */
    flowSince: string | null;
    programs: LabelCount[];
    recent: { id: string; name: string; parentName: string | null; createdLabel: string }[];
};

export type SourceStatsRow = {
    source: string;
    total: number;
    trialTotal: number;
    trialScheduled: number;
    trialAttended: number;
    trialConverted: number;
    enrollTotal: number;
    enrollPending: number;
    enrollApproved: number;
    enrollClosed: number;
    conversionRate: number;
    trialAttendRate: number;
    enrollApproveRate: number;
    latestAt: string | Date | null;
};

export type StatsFunnelTab = {
    tab: "funnel";
    inquiries: number;
    attended: number;
    converted: number;
    conversionRate: number | null;
    applications: number;
    approved: number;
    trialStatus: { NEW: number; CONTACTED: number; SCHEDULED: number; ATTENDED: number; CONVERTED: number; LOST: number; CANCELLED: number };
    sources: SourceStatsRow[];
    referral: LabelCount[];
    referralTotal: number;
};

export type StatsAttendanceTab = {
    tab: "attendance";
    rate: number | null;
    prevRate: number | null;
    diff: number | null;
    present: number;
    late: number;
    absent: number;
    excused: number;
    total: number;
    waiting: number;
    series: MonthRate[];
    classes: { id: string; name: string; dayOfWeek: string; startTime: string; capacity: number; enrolled: number; waiting: number }[];
    coaches: { id: string; name: string; classCount: number; studentCount: number }[];
    scale: { programs: number; classes: number; coaches: number };
};

export type StatsBillingTab = {
    tab: "billing";
    ym: string;
    billedCount: number;
    paidCount: number;
    billedAmount: number;
    paidAmount: number;
    unpaidCount: number;
    unpaidAmount: number;
    rateCount: number | null;
    rateAmount: number | null;
    revenue: number;
    prevRevenue: number;
    revenueDiffPct: number | null;
    revenueSeries: MonthAmount[];
    overdue: { count: number; amount: number };
    topUnpaid: { studentId: string; name: string; count: number; amount: number }[];
};

export type StatsUniformTab = {
    tab: "uniform";
    total: number;
    owned: number;
    rate: number | null;
    segments: LabelCount[];
    byBranch: { label: string; owned: number; total: number; rate: number | null }[];
    byGrade: { label: string; owned: number; total: number; rate: number | null }[];
    grants: { issued: number; used: number; revoked: number };
    list: { id: string; name: string; classes: string; branch: string; status: string; group: string; receivedYmd: string | null }[];
    sizes: { top: LabelCount[]; bottom: LabelCount[]; matchedStudents: number };
};

export type StatsTabPayload = StatsStudentsTab | StatsFunnelTab | StatsAttendanceTab | StatsBillingTab | StatsUniformTab;

export type StatsPageData = {
    tab: StatsTabKey;
    branch: StatsBranchKey;
    period: string;
    data: StatsTabPayload | null;
};
