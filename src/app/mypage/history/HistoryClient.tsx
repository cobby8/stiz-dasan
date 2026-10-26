"use client";

// 학부모 마이페이지 "출결·수납 전체 히스토리" 화면 (표시/조회 전용, 쓰기 없음).
// getMyPageHistory가 반환한 자녀별 전체 기록을 자녀 선택 + 출결/수납 두 목록으로 보여준다.
import { useState } from "react";
import Link from "next/link";

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

    const child = children[selectedIdx];

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
                        onChange={(e) => setSelectedIdx(Number(e.target.value))}
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
                            {/* 누적 출석률 요약 (기록 있을 때만) */}
                            {child.attendance.total > 0 && (
                                <div className="mb-4 grid grid-cols-4 gap-2 rounded-2xl bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 p-4 shadow-sm text-center">
                                    <div>
                                        <p className="text-xs text-gray-400">출석률</p>
                                        <p className="text-lg font-extrabold text-brand-navy-900 dark:text-white">
                                            {child.attendance.rate}%
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-400">출석</p>
                                        <p className="text-lg font-extrabold text-green-600 dark:text-green-300">{child.attendance.present}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-400">지각</p>
                                        <p className="text-lg font-extrabold text-yellow-600 dark:text-yellow-300">{child.attendance.late}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-400">결석</p>
                                        <p className="text-lg font-extrabold text-red-600 dark:text-red-300">{child.attendance.absent}</p>
                                    </div>
                                </div>
                            )}

                            {child.attendance.records.length === 0 ? (
                                <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-800 p-12 text-center text-gray-400 shadow-sm">
                                    출결 기록이 없습니다.
                                </div>
                            ) : (
                                <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
                                    <div className="divide-y divide-gray-50 dark:divide-gray-700/50">
                                        {child.attendance.records.map((r, i) => (
                                            <div key={i} className="flex items-center justify-between px-4 py-3">
                                                <div>
                                                    <span className="text-sm text-gray-700 dark:text-gray-200">{toDateStr(r.date)}</span>
                                                    {r.className && (
                                                        <span className="ml-2 text-xs text-gray-400">{r.className}</span>
                                                    )}
                                                </div>
                                                <span
                                                    className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                                                        r.status === "PRESENT"
                                                            ? "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200"
                                                            : r.status === "ABSENT"
                                                            ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200"
                                                            : "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-200"
                                                    }`}
                                                >
                                                    {r.status === "PRESENT" ? "출석" : r.status === "ABSENT" ? "결석" : "지각"}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
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
