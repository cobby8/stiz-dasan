"use client";

// 학부모 마이페이지 "출결·수납 전체 히스토리" 화면 (표시/조회 전용, 쓰기 없음).
// getMyPageHistory가 반환한 자녀별 전체 기록을 자녀 선택 + 출결/수납 두 목록으로 보여준다.
import { useState } from "react";
import Link from "next/link";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { kstLabel } from "@/lib/datetime/kst";
// 출결 기록 달별 묶음 — KST 날짜로 바꿔 묶는 공용 함수(toISOString 은 하루 밀린다)
import { groupByKstMonth } from "@/components/admin/list/monthDateGroups";

// 출결 상태 — 기존 화면과 같은 판정(PRESENT/ABSENT 외에는 "지각"으로 표시)을 한 곳에 모은다.
// 칩 건수와 목록 행이 같은 기준으로 세어지도록 행 표시도 이 함수만 쓴다.
type AttendanceKey = "PRESENT" | "LATE" | "ABSENT";
const ATTENDANCE_STATUS: { value: AttendanceKey; label: string; color: string }[] = [
    { value: "PRESENT", label: "출석", color: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200" },
    { value: "LATE", label: "지각", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-200" },
    { value: "ABSENT", label: "결석", color: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200" },
];
function attendanceKeyOf(status: string): AttendanceKey {
    return status === "PRESENT" ? "PRESENT" : status === "ABSENT" ? "ABSENT" : "LATE";
}

// 결제 상태 배지 — 마이페이지 본 화면과 동일한 톤/토큰 사용(하드코딩 hex 없음)
const PAYMENT_STATUS: Record<string, { label: string; color: string }> = {
    PENDING: { label: "미납", color: "text-yellow-700 bg-yellow-100 dark:bg-yellow-950/40 dark:text-yellow-200" },
    PAID: { label: "납부완료", color: "text-green-700 bg-green-100 dark:bg-green-950/40 dark:text-green-200" },
    OVERDUE: { label: "연체", color: "text-red-700 bg-red-100 dark:bg-red-950/40 dark:text-red-200" },
    REFUNDED: { label: "환불", color: "text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900" },
    CANCELED: { label: "취소/이월", color: "text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900" },
};

const TYPE_LABELS: Record<string, string> = {
    MONTHLY: "수강료",
    SHUTTLE: "셔틀",
    UNIFORM: "유니폼",
    OTHER: "기타",
};

function toDateStr(d: Date | string | null): string {
    if (!d) return "-";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().split("T")[0];
}

function formatAmount(n: number): string {
    return n.toLocaleString("ko-KR") + "원";
}

// 페이지 서버 컴포넌트가 넘겨주는 데이터 형태
type HistoryChild = {
    id: string;
    name: string;
    attendance: {
        total: number;
        present: number;
        absent: number;
        late: number;
        rate: number | null;
        records: { status: string; date: Date | string; className: string | null }[];
    };
    payments: {
        id: string;
        amount: number;
        status: string;
        dueDate: Date | string;
        paidDate: Date | string | null;
        type?: string;
        description?: string | null;
        receiptUrl?: string | null;
        invoiceId?: string | null;
        canCheckout?: boolean;
        invoiceNo?: string | null;
    }[];
};

type Tab = "attendance" | "payments";

export default function HistoryClient({
    children,
    initialChildId,
}: {
    children: HistoryChild[];
    initialChildId?: string;
}) {
    // 진입 시 ?child= 로 넘어온 자녀를 우선 선택, 없으면 첫 번째 자녀
    const initialIdx = Math.max(
        0,
        children.findIndex((c) => c.id === initialChildId)
    );
    const [selectedIdx, setSelectedIdx] = useState(initialIdx);
    const [tab, setTab] = useState<Tab>("attendance");
    // 출결 상태 칩으로 고른 상태("ALL" = 전체)
    const [attendanceFilter, setAttendanceFilter] = useState("ALL");

    const child = children[selectedIdx];
    // 칩 건수와 목록은 같은 판정 함수로 센다(칩 숫자 = 보이는 행 수)
    const attendanceRecords = child?.attendance.records ?? [];
    const attendanceChips = ATTENDANCE_STATUS.map((item) => ({
        value: item.value,
        label: item.label,
        count: attendanceRecords.filter((r) => attendanceKeyOf(r.status) === item.value).length,
    }));
    const visibleAttendance = attendanceFilter === "ALL"
        ? attendanceRecords
        : attendanceRecords.filter((r) => attendanceKeyOf(r.status) === attendanceFilter);
    const attendanceGroups = groupByKstMonth(visibleAttendance, (r) => r.date);

    return (
        <div>
            {/* 뒤로가기 + 제목 (리포트 화면과 동일한 헤더 톤) */}
            <div className="mb-6">
                <Link
                    href="/mypage"
                    className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-200 flex items-center gap-1 mb-2"
                >
                    <span className="material-symbols-outlined text-sm">arrow_back</span>
                    마이페이지
                </Link>
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">출결·수납 히스토리</h1>
                <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">자녀의 전체 출결·수납 기록을 확인하세요.</p>
            </div>

            {/* 자녀 선택 — 자녀가 2명 이상일 때만 노출 */}
            {children.length > 1 && (
                <div className="mb-4">
                    <select
                        value={selectedIdx}
                        onChange={(e) => {
                            setSelectedIdx(Number(e.target.value));
                            // 자녀를 바꾸면 이전 자녀 기준 상태 칩 선택은 풀어 준다
                            setAttendanceFilter("ALL");
                        }}
                        className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                    >
                        {children.map((c, i) => (
                            <option key={c.id} value={i}>
                                {c.name}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {/* 자녀가 아예 없을 때 */}
            {!child ? (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">
                    등록된 자녀가 없습니다.
                </div>
            ) : (
                <>
                    {/* 탭 (출결 / 수납) */}
                    <div className="mb-4 flex gap-2">
                        <button
                            type="button"
                            onClick={() => setTab("attendance")}
                            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold transition ${
                                tab === "attendance"
                                    ? "bg-brand-orange-500 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                    : "bg-white text-gray-600 border border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700"
                            }`}
                        >
                            출결 ({child.attendance.total})
                        </button>
                        <button
                            type="button"
                            onClick={() => setTab("payments")}
                            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-bold transition ${
                                tab === "payments"
                                    ? "bg-brand-orange-500 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                    : "bg-white text-gray-600 border border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700"
                            }`}
                        >
                            수납 ({child.payments.length})
                        </button>
                    </div>

                    {/* 출결 탭 */}
                    {tab === "attendance" && (
                        <div>
                            {/* 누적 출석률 + 상태 칩 한 줄 (기록 있을 때만).
                                예전 4칸 요약판(약 80px)을 한 줄로 줄이고, 칩을 누르면 그 상태만 본다. */}
                            {child.attendance.total > 0 && (
                                <div className="mb-3 flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-bold text-[var(--color-academy-ink)] dark:text-white">
                                        출석률 <span className="tabular-nums">{child.attendance.rate}%</span>
                                    </p>
                                    <StatusCountChips
                                        items={attendanceChips}
                                        selected={attendanceFilter}
                                        onSelect={setAttendanceFilter}
                                        ariaLabel="출결 상태별 건수"
                                    />
                                </div>
                            )}

                            {child.attendance.records.length === 0 ? (
                                <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-800 p-12 text-center text-gray-400 shadow-sm">
                                    출결 기록이 없습니다.
                                </div>
                            ) : (
                                // 달별 묶음 — 각 묶음 제목에 그 달 건수를 오른쪽 숫자로
                                <div className="space-y-3">
                                    {attendanceGroups.map((group) => (
                                        <section key={group.month} aria-label={group.label} className="bg-white dark:bg-gray-800 border border-[var(--color-academy-line)] dark:border-gray-800 rounded-2xl overflow-hidden">
                                            <h3 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-bold text-[var(--color-academy-ink)] dark:bg-gray-900 dark:text-gray-100">
                                                <span>{group.label}</span>
                                                <span className="tabular-nums text-[var(--color-academy-muted)]">{group.items.length}</span>
                                            </h3>
                                            <ul className="divide-y divide-[var(--color-academy-line)] dark:divide-gray-700/50">
                                                {group.items.map(({ item: r, ymd }, i) => {
                                                    const status = ATTENDANCE_STATUS.find((item) => item.value === attendanceKeyOf(r.status))!;
                                                    return (
                                                        // 한 줄 행: 상태 칩 · 반 이름(줄바꿈 허용, 말줄임 없음) · 날짜(오른쪽, 숫자 폭 고정)
                                                        <li key={`${ymd}-${i}`} className="flex min-h-11 items-center gap-2 px-3 py-2">
                                                            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${status.color}`}>
                                                                {status.label}
                                                            </span>
                                                            <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-muted)] dark:text-gray-300">
                                                                {r.className ?? ""}
                                                            </span>
                                                            <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-ink)] dark:text-gray-200">
                                                                {kstLabel(ymd) || "-"}
                                                            </span>
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </section>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 수납 탭 */}
                    {tab === "payments" && (
                        <div>
                            {child.payments.length === 0 ? (
                                <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-800 p-12 text-center text-gray-400 shadow-sm">
                                    수납 기록이 없습니다.
                                </div>
                            ) : (
                                <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
                                    <div className="divide-y divide-gray-50 dark:divide-gray-700/50">
                                        {child.payments.map((p) => {
                                            const statusInfo = PAYMENT_STATUS[p.status] || PAYMENT_STATUS.PENDING;
                                            const canPay = p.canCheckout !== false && Boolean(p.invoiceId) && (p.status === "PENDING" || p.status === "OVERDUE");
                                            return (
                                                <div key={p.id} className="px-4 py-3">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div>
                                                            <p className="text-sm font-bold text-gray-900 dark:text-white">
                                                                {p.description || (p.type ? TYPE_LABELS[p.type] : null) || "수강료"}
                                                            </p>
                                                            <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">{formatAmount(p.amount)}</p>
                                                            <p className="text-xs text-gray-400">기한: {toDateStr(p.dueDate)}</p>
                                                            {p.invoiceNo && (
                                                                <p className="mt-1 text-[11px] font-bold text-brand-orange-500 dark:text-brand-neon-lime">
                                                                    {p.invoiceNo}
                                                                </p>
                                                            )}
                                                        </div>
                                                        <div className="shrink-0 text-right">
                                                            <span className={`whitespace-nowrap text-xs font-bold px-2.5 py-1 rounded-full ${statusInfo.color}`}>
                                                                {statusInfo.label}
                                                            </span>
                                                            {p.paidDate && (
                                                                <p className="text-xs text-gray-400 mt-1">{toDateStr(p.paidDate)} 납부</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                                                        {canPay && (
                                                            <Link
                                                                href={`/payments/${p.invoiceId}`}
                                                                className="rounded-full bg-brand-orange-500 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                                            >
                                                                납부하기
                                                            </Link>
                                                        )}
                                                        {p.invoiceId && p.canCheckout !== false && !canPay && (
                                                            <Link
                                                                href={`/payments/${p.invoiceId}`}
                                                                className="rounded-full border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                                                            >
                                                                청구서 보기
                                                            </Link>
                                                        )}
                                                        {p.invoiceId && p.canCheckout === false && <p className="w-full text-xs text-[var(--color-academy-muted)]">온라인 결제는 대표 보호자 계정에서 진행해 주세요.</p>}
                                                        {p.receiptUrl && p.canCheckout !== false && (
                                                            <a
                                                                href={p.receiptUrl}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="rounded-full border border-green-200 px-3 py-1.5 text-xs font-bold text-green-700 transition hover:bg-green-50 dark:border-green-500/30 dark:text-green-200 dark:hover:bg-green-500/10"
                                                            >
                                                                영수증
                                                            </a>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
