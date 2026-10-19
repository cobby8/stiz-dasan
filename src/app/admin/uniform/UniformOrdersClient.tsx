"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { retryUniformOrderDispatch } from "@/app/actions/uniform";
import type { UniformOrderAdminView } from "./page";

type SyncTone = {
  label: string;
  className: string;
  icon: string;
};

const SYNC_STATUS: Record<string, SyncTone> = {
  PENDING: {
    label: "전송 대기",
    icon: "schedule",
    className: "bg-blue-50 text-blue-700 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-200 dark:ring-blue-800",
  },
  SENDING: {
    label: "전송 중",
    icon: "progress_activity",
    className: "bg-blue-50 text-blue-700 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-200 dark:ring-blue-800",
  },
  SENT: {
    label: "본사 접수",
    icon: "check_circle",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800",
  },
  DUPLICATE: {
    label: "중복 확인",
    icon: "task_alt",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800",
  },
  RETRY_WAIT: {
    label: "재시도 대기",
    icon: "restart_alt",
    className: "bg-amber-50 text-amber-800 ring-amber-100 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-800",
  },
  NEEDS_REVIEW: {
    label: "확인 필요",
    icon: "error",
    className: "bg-red-50 text-red-700 ring-red-100 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-800",
  },
  SETUP_REQUIRED: {
    label: "키 설정 필요",
    icon: "vpn_key",
    className: "bg-red-50 text-red-700 ring-red-100 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-800",
  },
};

const FILTERS = [
  { value: "ALL", label: "전체" },
  { value: "ACTION", label: "처리 필요" },
  { value: "SENT", label: "본사 접수" },
  { value: "WAITING", label: "전송 대기" },
];

function formatDateTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function summarizeItems(order: UniformOrderAdminView) {
  return order.items
    .map((item) => {
      const sizes = [item.topSize ? `상의 ${item.topSize}` : "", item.bottomSize ? `하의 ${item.bottomSize}` : ""]
        .filter(Boolean)
        .join(" · ");
      const number = item.backNumber ? `#${item.backNumber}` : "등번호 없음";
      const details = [
        item.design,
        item.initials ? `이니셜 ${item.initials}` : "",
        number,
        sizes,
      ].filter(Boolean).join(" · ");
      return `${item.studentName} (${details})`;
    })
    .join(" / ");
}

function getSyncStatus(status: string) {
  return SYNC_STATUS[status] || {
    label: status,
    icon: "help",
    className: "bg-gray-100 text-gray-700 ring-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:ring-gray-700",
  };
}

function canRetry(order: UniformOrderAdminView) {
  return ["PENDING", "RETRY_WAIT", "NEEDS_REVIEW", "SETUP_REQUIRED"].includes(order.stizSyncStatus);
}

export default function UniformOrdersClient({
  initialOrders,
  loadError,
}: {
  initialOrders: UniformOrderAdminView[];
  loadError: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState("ALL");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const visibleOrders = useMemo(() => {
    if (filter === "SENT") {
      return initialOrders.filter((order) => order.stizSyncStatus === "SENT" || order.stizSyncStatus === "DUPLICATE");
    }
    if (filter === "WAITING") {
      return initialOrders.filter((order) => order.stizSyncStatus === "PENDING" || order.stizSyncStatus === "RETRY_WAIT");
    }
    if (filter === "ACTION") {
      return initialOrders.filter((order) => order.stizSyncStatus === "NEEDS_REVIEW" || order.stizSyncStatus === "SETUP_REQUIRED");
    }
    return initialOrders;
  }, [filter, initialOrders]);

  const counts = useMemo(() => ({
    total: initialOrders.length,
    action: initialOrders.filter((order) => order.stizSyncStatus === "NEEDS_REVIEW" || order.stizSyncStatus === "SETUP_REQUIRED").length,
    sent: initialOrders.filter((order) => order.stizSyncStatus === "SENT" || order.stizSyncStatus === "DUPLICATE").length,
    waiting: initialOrders.filter((order) => order.stizSyncStatus === "PENDING" || order.stizSyncStatus === "RETRY_WAIT").length,
  }), [initialOrders]);

  function handleRetry(order: UniformOrderAdminView) {
    if (!confirm(`${order.parentName} 보호자의 유니폼 신청을 STIZ 본사로 다시 전송할까요?\n본사 접수에 성공하면 학부모 문자 안내가 발송될 수 있습니다.`)) {
      return;
    }
    setBusyId(order.id);
    setFeedback(null);
    startTransition(async () => {
      try {
        const result = await retryUniformOrderDispatch(order.id);
        const done = result.syncStatus === "SENT" || result.syncStatus === "DUPLICATE";
        setFeedback({
          type: done ? "success" : "error",
          message: done ? "본사 접수가 완료되었습니다." : "전송 상태를 확인해 주세요. 설정 또는 응답 오류가 남아 있습니다.",
        });
        router.refresh();
      } catch (error) {
        setFeedback({
          type: "error",
          message: error instanceof Error ? error.message : "재전송 중 문제가 발생했습니다.",
        });
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <main className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase text-[var(--brand-accent)]">UNIFORM</p>
          <h1 className="mt-1 text-2xl font-black text-gray-900 dark:text-white">유니폼 주문 관리</h1>
        </div>
        <Link
          href="/apply/uniform"
          target="_blank"
          className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand-orange-500 px-4 text-sm font-black text-white hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
        >
          <span className="material-symbols-outlined text-base">open_in_new</span>
          신청 페이지 열기
        </Link>
      </div>

      {loadError && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          {loadError}
          <p className="mt-1 text-xs font-medium">계속 불러오지 못하면 담당자에게 문의해 주세요.</p>
        </div>
      )}

      {feedback && (
        <div className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
          feedback.type === "success"
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
            : "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
        }`}>
          {feedback.message}
        </div>
      )}

      <section className="flex flex-wrap gap-2 rounded-2xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        {FILTERS.map((item) => {
          const count = item.value === "ALL" ? counts.total : item.value === "ACTION" ? counts.action : item.value === "SENT" ? counts.sent : counts.waiting;
          const active = filter === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={`inline-flex min-h-9 items-center rounded-full px-4 text-sm font-black ${
                active
                  ? "bg-brand-navy-900 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {item.label} {count}
            </button>
          );
        })}
      </section>

      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-left text-sm">
            <thead className="bg-gray-50 text-xs font-black text-gray-500 dark:bg-gray-800 dark:text-gray-300">
              <tr>
                <th className="w-[128px] px-4 py-3">상태</th>
                <th className="w-[112px] px-4 py-3">접수일</th>
                <th className="w-[180px] px-4 py-3">학부모</th>
                <th className="px-4 py-3">학생/사이즈</th>
                <th className="w-[170px] px-4 py-3">본사 접수번호</th>
                <th className="w-[120px] px-4 py-3 text-center">시도</th>
                <th className="w-[140px] px-4 py-3 text-right">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {visibleOrders.map((order) => {
                const sync = getSyncStatus(order.stizSyncStatus);
                return (
                  <tr key={order.id} className="align-middle">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-black ring-1 ${sync.className}`}>
                        <span className={`material-symbols-outlined text-sm ${order.stizSyncStatus === "SENDING" ? "animate-spin" : ""}`}>{sync.icon}</span>
                        {sync.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-bold text-gray-700 dark:text-gray-200">{formatDateTime(order.createdAt)}</td>
                    <td className="px-4 py-3">
                      <p className="font-black text-gray-900 dark:text-white">{order.parentName}</p>
                      <p className="text-xs font-bold text-gray-500 dark:text-gray-400">{order.parentPhone}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-bold text-gray-900 dark:text-white">{summarizeItems(order)}</p>
                      {order.customerMemo && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{order.customerMemo}</p>}
                      {order.lastError && <p className="mt-1 text-xs font-bold text-red-600 dark:text-red-300">{order.lastError}</p>}
                    </td>
                    <td className="px-4 py-3 font-bold text-gray-700 dark:text-gray-200">
                      {order.stizOrderNumber || "-"}
                    </td>
                    <td className="px-4 py-3 text-center text-xs font-bold text-gray-500 dark:text-gray-400">
                      {order.sendAttempts}회
                      {order.nextRetryAt && <span className="block">다음 {formatDateTime(order.nextRetryAt)}</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canRetry(order) ? (
                        <button
                          type="button"
                          onClick={() => handleRetry(order)}
                          disabled={isPending || busyId === order.id}
                          className="inline-flex min-h-9 items-center justify-center gap-1 rounded-xl border border-gray-200 bg-white px-3 text-xs font-black text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
                        >
                          <span className={`material-symbols-outlined text-sm ${busyId === order.id ? "animate-spin" : ""}`}>
                            {busyId === order.id ? "progress_activity" : "send"}
                          </span>
                          재전송
                        </button>
                      ) : (
                        <span className="text-xs font-bold text-gray-400">완료</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleOrders.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm font-bold text-gray-500 dark:text-gray-400">
                    표시할 유니폼 신청이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
