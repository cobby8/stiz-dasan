"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { groupOperationalDeliveries, operationalDeliveryView } from "@/lib/admin-delivery-status";

type Delivery = {
  id: string;
  stableEventKey?: string | null;
  recipientUserId?: string | null;
  eventType: string;
  trigger: string | null;
  channel: string;
  status: string;
  attemptCount: number;
  errorMessage: string | null;
  studentName: string | null;
  recipientName: string | null;
  recipientRole: string | null;
  updatedAt: string;
  sentAt?: string | null;
  failedAt?: string | null;
  nextAttemptAt?: string | null;
  partialRetry?: boolean;
};

const STATUS_OPTIONS = [
  ["all", "전체"], ["attention", "확인 필요"], ["processing", "처리 중"], ["success", "성공"],
] as const;
const CHANNEL_OPTIONS = [["all", "전체 채널"], ["in_app", "사이트 알림"], ["push", "휴대폰 푸시"]] as const;

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "원장", VICE_ADMIN: "부원장", INSTRUCTOR: "담당 코치", DRIVER: "담당 기사",
};
const EVENT_LABEL: Record<string, string> = {
  REGULAR_ABSENCE_REPORTED: "정규수업 결석 접수",
  REGULAR_ABSENCE_CANCELED: "정규수업 결석 취소",
  SHUTTLE_DAY_EXCEPTION_SUBMITTED: "당일 셔틀 변경",
  SHUTTLE_DAY_EXCEPTION_CANCELED: "당일 셔틀 변경 취소",
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export default function OperationalDeliveryClient() {
  const [status, setStatus] = useState("all");
  const [channel, setChannel] = useState("all");
  const [rows, setRows] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);

  const load = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/operational-deliveries?status=${status}&channel=${channel}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "전달 장부를 불러오지 못했습니다.");
      if (current !== version.current) return;
      if (!Array.isArray(data.deliveries)) throw new Error("전달 장부 응답을 확인하지 못했습니다.");
      setRows(data.deliveries ?? []);
    } catch (caught) {
      if (current !== version.current) return;
      setError(caught instanceof Error ? caught.message : "전달 장부를 불러오지 못했습니다.");
    } finally {
      if (current === version.current) setLoading(false);
    }
  }, [channel, status]);

  const invalidate = useCallback(() => { version.current++; }, []);
  useEffect(() => { void load(); return invalidate; }, [load, invalidate]);

  return (
    <main className="space-y-5">
      <div>
        <p className="text-sm font-bold text-blue-600">운영 알림</p>
        <h1 className="mt-1 text-2xl font-black text-gray-950 dark:text-white">담당자 전달 장부</h1>
        <p className="mt-2 text-sm text-gray-500">결석·셔틀 요청의 담당자별 사이트 알림 등록과 푸시 접수를 확인합니다. 알림 접수는 담당자의 열람·업무 확인을 뜻하지 않습니다.</p>
      </div>

      <section className="space-y-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap gap-2" aria-label="전달 상태 필터">
          {STATUS_OPTIONS.map(([value, label]) => <button key={value} type="button" onClick={() => setStatus(value)} className={`min-h-10 rounded-xl px-4 text-sm font-black ${status === value ? "bg-brand-navy-900 text-white" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-200"}`}>{label}</button>)}
        </div>
        <div className="flex flex-wrap gap-2" aria-label="채널 필터">
          {CHANNEL_OPTIONS.map(([value, label]) => <button key={value} type="button" onClick={() => setChannel(value)} className={`min-h-10 rounded-xl px-4 text-sm font-bold ${channel === value ? "bg-blue-600 text-white" : "border border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-200"}`}>{label}</button>)}
        </div>
      </section>

      {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">{error}<button type="button" onClick={() => void load()} className="ml-3 underline">다시 불러오기</button></div>}
      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
        {loading ? <p className="p-10 text-center text-sm text-gray-500">전달 상태를 불러오는 중입니다.</p> : error ? <p className="p-5 text-sm text-gray-500">조회 결과를 확인할 수 없습니다. 기록이 없다는 뜻이 아닙니다.</p> : rows.length === 0 ? <p className="p-10 text-center text-sm text-gray-500">선택한 조건의 전달 기록이 없습니다.</p> : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {groupOperationalDeliveries(rows).map((group) => <section key={group[0].id} aria-label="같은 요청의 담당자별 채널 기록">{group.map((row) => {
              const view = operationalDeliveryView(row);
              return <article key={row.id} className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-black ${view.className}`}>{view.label}</span>
                  <strong className="text-sm text-gray-950 dark:text-white">{EVENT_LABEL[row.eventType] ?? row.eventType}</strong>
                  <time className="ml-auto text-xs text-gray-400">갱신 {formatTime(row.updatedAt)}</time>
                </div>
                <div className="mt-3 grid gap-1 text-sm text-gray-700 dark:text-gray-200 sm:grid-cols-2">
                  <p>학생: <strong>{row.studentName ?? "학생 정보 없음"}</strong></p>
                  <p>수신: <strong>{ROLE_LABEL[row.recipientRole ?? ""] ?? "담당자"} {row.recipientName ?? "미확인"}</strong></p>
                  <p>채널: <strong>{row.channel === "IN_APP" ? "사이트 알림" : "휴대폰 푸시"}</strong></p>
                  <p>시도: <strong>{row.attemptCount}회</strong></p>
                  {row.sentAt && <p>등록·접수 시각: <time>{formatTime(row.sentAt)}</time></p>}
                  {row.failedAt && <p>최근 실패 시각: <time>{formatTime(row.failedAt)}</time></p>}
                  {row.nextAttemptAt && <p>다음 자동 재시도: <time>{formatTime(row.nextAttemptAt)}</time></p>}
                </div>
                {row.errorMessage && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{row.errorMessage}</p>}
              </article>;
            })}</section>)}
          </div>
        )}
      </section>
      <p className="text-xs leading-5 text-gray-500">최근 최대 200건을 표시합니다. 필터나 조회 한도로 보이지 않는 채널은 상태를 추측하지 않습니다. 푸시는 기존 정책에 따라 최대 5회 자동 재시도됩니다. 푸시 미등록이어도 사이트 알림 등록 결과를 별도로 확인해 주세요.</p>
    </main>
  );
}
