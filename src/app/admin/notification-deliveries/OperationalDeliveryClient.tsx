"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { groupOperationalDeliveries, operationalDeliveryView } from "@/lib/admin-delivery-status";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

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

// 상태 배지 색 — 문구는 operationalDeliveryView 그대로 쓰고, 색만 화면 토큰으로 맞춘다
function statusTone(status: string) {
  if (status === "SENT") return "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]";
  if (status === "PENDING") return "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]";
  if (status === "FAILED") return "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]";
  return "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]";
}

const channelLabel = (channel: string) => (channel === "IN_APP" ? "사이트 알림" : "휴대폰 푸시");

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

  // 행 클릭 상세 패널 대상(전달 기록 id) — 시각·오류 문구 같은 긴 값은 패널에서
  const [detailId, setDetailId] = useState<string | null>(null);

  // 필터를 바꾸면 목록이 다시 읽히므로 열린 패널은 닫는다
  function changeStatus(value: string) { setDetailId(null); setStatus(value); }
  function changeChannel(value: string) { setDetailId(null); setChannel(value); }

  // 행 키보드(Enter·Space) = 상세 패널. 행 자신에서 누른 키만 받는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  const filterClass = (selected: boolean) =>
    `min-h-11 rounded-full border px-3 text-sm font-bold ${
      selected
        ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"
        : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)]"
    }`;

  const detail = detailId ? rows.find((row) => row.id === detailId) ?? null : null;

  return (
    <main className="space-y-3">
      <div>
        <h1 className="flex flex-wrap items-baseline gap-x-2 text-lg font-black text-[var(--color-academy-ink)]">
          담당자 전달 장부
          <span className="text-xs font-bold text-[var(--color-academy-primary)]">운영 알림</span>
        </h1>
        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">결석·셔틀 요청의 담당자별 사이트 알림 등록과 푸시 접수를 확인합니다. 알림 접수는 담당자의 열람·업무 확인을 뜻하지 않습니다.</p>
      </div>

      {/* 상태·채널 필터 — 예전 두 줄 상자를 한 줄로(서버가 조건별로 읽어 주므로 건수 칩은 쓰지 않는다) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="전달 상태 필터">
          {STATUS_OPTIONS.map(([value, label]) => <button key={value} type="button" aria-pressed={status === value} onClick={() => changeStatus(value)} className={filterClass(status === value)}>{label}</button>)}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="채널 필터">
          {CHANNEL_OPTIONS.map(([value, label]) => <button key={value} type="button" aria-pressed={channel === value} onClick={() => changeChannel(value)} className={filterClass(channel === value)}>{label}</button>)}
        </div>
      </div>

      {error && <div role="alert" className="rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm font-bold text-[var(--color-academy-danger)]">{error}<button type="button" onClick={() => void load()} className="ml-3 min-h-11 underline">다시 불러오기</button></div>}
      <section className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
        {loading ? <p className="p-6 text-center text-sm text-[var(--color-academy-muted)]">전달 상태를 불러오는 중입니다.</p> : error ? <p className="p-4 text-sm text-[var(--color-academy-muted)]">조회 결과를 확인할 수 없습니다. 기록이 없다는 뜻이 아닙니다.</p> : rows.length === 0 ? <p className="p-6 text-center text-sm text-[var(--color-academy-muted)]">선택한 조건의 전달 기록이 없습니다.</p> : (
          <div className="overflow-x-auto">
            {/* 한 줄 행: 상태 | 요청 | 학생 | 수신 역할 | 수신자 | 채널 | 시도 | 갱신 | 오류. 같은 요청·담당자 묶음은 tbody 하나 */}
            <table className="admin-list-table w-full border-collapse text-sm">
              <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                <tr>
                  <th className="px-2 py-2">상태</th>
                  <th className="px-2 py-2">요청</th>
                  <th className="px-2 py-2">학생</th>
                  <th className="hidden px-2 py-2 sm:table-cell">수신 역할</th>
                  <th className="px-2 py-2">수신자</th>
                  <th className="px-2 py-2">채널</th>
                  <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">시도</th>
                  <th className="admin-cell-num px-2 py-2">갱신</th>
                  <th className="admin-cell-center hidden px-2 py-2 md:table-cell">오류</th>
                </tr>
              </thead>
              {groupOperationalDeliveries(rows).map((group) => <tbody key={group[0].id} aria-label="같은 요청의 담당자별 채널 기록" className="border-t-2 border-[var(--color-academy-line)] divide-y divide-[var(--color-academy-line)]">{group.map((row) => {
                const view = operationalDeliveryView(row);
                return <tr
                  key={row.id}
                  tabIndex={0}
                  aria-label={`${row.studentName ?? "학생 정보 없음"} ${EVENT_LABEL[row.eventType] ?? row.eventType} 전달 상세 보기`}
                  onClick={() => setDetailId(row.id)}
                  onKeyDown={(event) => handleRowKeyDown(event, row.id)}
                  className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                >
                  <td className="px-2 py-1.5"><span className={`rounded-full px-2 py-0.5 text-xs font-black ${statusTone(row.status)}`}>{view.label}</span></td>
                  <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{EVENT_LABEL[row.eventType] ?? row.eventType}</td>
                  <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{row.studentName ?? "학생 정보 없음"}</td>
                  <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{ROLE_LABEL[row.recipientRole ?? ""] ?? "담당자"}</td>
                  <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{row.recipientName ?? "미확인"}</td>
                  <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{channelLabel(row.channel)}</td>
                  <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-ink)] sm:table-cell">{row.attemptCount}회</td>
                  <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]"><time>{formatTime(row.updatedAt)}</time></td>
                  {/* 오류 문구는 길어서 표시만, 내용은 상세 패널 */}
                  <td className="admin-cell-center hidden px-2 py-1.5 md:table-cell">{row.errorMessage ? <span className="material-symbols-outlined text-base text-[var(--color-academy-warning)]" aria-label="오류 문구 있음">warning</span> : <span className="text-xs text-[var(--color-academy-muted)]">-</span>}</td>
                </tr>;
              })}</tbody>)}
            </table>
          </div>
        )}
      </section>
      <p className="text-xs leading-5 text-[var(--color-academy-muted)]">최근 최대 200건을 표시합니다. 필터나 조회 한도로 보이지 않는 채널은 상태를 추측하지 않습니다. 푸시는 기존 정책에 따라 최대 5회 자동 재시도됩니다. 푸시 미등록이어도 사이트 알림 등록 결과를 별도로 확인해 주세요.</p>

      {/* 행 클릭 상세 패널 — 예전 카드의 전체 내용(시각 3종·오류 문구). 작업 버튼은 없다(조회 전용) */}
      {detail && (() => {
        const row = detail;
        const view = operationalDeliveryView(row);
        const panelRows: { label: string; value: React.ReactNode }[] = [
          { label: "요청", value: EVENT_LABEL[row.eventType] ?? row.eventType },
          { label: "학생", value: row.studentName ?? "학생 정보 없음" },
          { label: "수신", value: `${ROLE_LABEL[row.recipientRole ?? ""] ?? "담당자"} ${row.recipientName ?? "미확인"}` },
          { label: "채널", value: channelLabel(row.channel) },
          { label: "시도", value: <span className="tabular-nums">{row.attemptCount}회</span> },
          { label: "갱신", value: <time className="tabular-nums">{formatTime(row.updatedAt)}</time> },
          { label: "등록·접수", value: row.sentAt ? <time className="tabular-nums">{formatTime(row.sentAt)}</time> : null },
          { label: "최근 실패", value: row.failedAt ? <time className="tabular-nums">{formatTime(row.failedAt)}</time> : null },
          { label: "다음 재시도", value: row.nextAttemptAt ? <time className="tabular-nums">{formatTime(row.nextAttemptAt)}</time> : null },
        ].filter((item) => item.value !== null);
        return (
          <ListDetailPanel onClose={() => setDetailId(null)} titleId="operational-delivery-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-4 flex items-center gap-2">
              <h3 id="operational-delivery-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{row.studentName ?? "학생 정보 없음"}</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-black ${statusTone(row.status)}`}>{view.label}</span>
              <button
                type="button"
                onClick={() => setDetailId(null)}
                aria-label="닫기"
                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
              >
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              {panelRows.map((item) => (
                <div key={item.label} className="contents">
                  <dt className="font-bold text-[var(--color-academy-muted)]">{item.label}</dt>
                  <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">{item.value}</dd>
                </div>
              ))}
            </dl>
            {row.errorMessage && <p className="mt-4 rounded-lg bg-[var(--color-academy-warning-soft)] p-3 text-sm font-bold text-[var(--color-academy-warning)]">{row.errorMessage}</p>}
          </ListDetailPanel>
        );
      })()}
    </main>
  );
}
