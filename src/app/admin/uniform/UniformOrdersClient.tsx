"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { retryUniformOrderDispatch } from "@/app/actions/uniform";
import type { UniformOrderAdminView } from "./page";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { formatKstDate } from "@/lib/datetime/kst";
import { isFreeUniformOrderMemo } from "@/lib/uniform-free-grant-rules";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

type SyncTone = {
  label: string;
  className: string;
};

const SYNC_STATUS: Record<string, SyncTone> = {
  PENDING: {
    label: "전송 대기",
    className: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] ring-[var(--color-academy-line)]",
  },
  SENDING: {
    label: "전송 중",
    className: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] ring-[var(--color-academy-line)]",
  },
  SENT: {
    label: "본사 접수",
    className: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)] ring-[var(--color-academy-success)]",
  },
  DUPLICATE: {
    label: "중복 확인",
    className: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)] ring-[var(--color-academy-success)]",
  },
  RETRY_WAIT: {
    label: "재시도 대기",
    className: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)] ring-[var(--color-academy-warning)]",
  },
  NEEDS_REVIEW: {
    label: "확인 필요",
    className: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)] ring-[var(--color-academy-danger)]",
  },
  SETUP_REQUIRED: {
    label: "키 설정 필요",
    className: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)] ring-[var(--color-academy-danger)]",
  },
};

// 접수·다음 시도 시각 — 기기 시간대와 무관하게 한국 시각으로(KST 공용 모듈)
function formatDateTime(value: string | null) {
  if (!value) return "-";
  return formatKstDate(value, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }, "-");
}

function getSyncStatus(status: string) {
  return SYNC_STATUS[status] || {
    label: status,
    className: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] ring-[var(--color-academy-line)]",
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
  // 행 클릭 상세 패널 대상
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);

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
          message: adminErrorText(error, "재전송 중 문제가 발생했습니다."),
        });
      } finally {
        setBusyId(null);
      }
    });
  }

  // 상태 칩 — 기존 필터 버튼과 같은 filter 값(ACTION·WAITING·SENT)을 공유, 다시 누르면 전체(ALL)
  const chipItems = [
    { value: "ACTION", label: "처리 필요", count: counts.action },
    { value: "WAITING", label: "전송 대기", count: counts.waiting },
    { value: "SENT", label: "본사 접수", count: counts.sent },
  ];
  // id 로 찾아서, 새로고침 뒤에도 최신 값으로 보이고 사라지면 패널도 닫힌다
  const detailOrder = detailOrderId ? initialOrders.find((order) => order.id === detailOrderId) ?? null : null;

  // 행 키보드: 안쪽 버튼에서 누른 Enter/Space 는 가로채지 않는다
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailOrderId(id);
    }
  }

  // 재전송 버튼(행·패널 공용) — 함수·확인창·막힘 조건은 기존 그대로
  function renderRetryButton(order: UniformOrderAdminView) {
    if (!canRetry(order)) {
      return <span className="text-xs text-[var(--color-academy-muted)]">완료</span>;
    }
    return (
      <button
        type="button"
        onClick={() => handleRetry(order)}
        disabled={isPending || busyId === order.id}
        className="academy-button-tonal academy-button-sm"
      >
        {/* 돌아가는 아이콘 대신 글자로 진행 중임을 알린다 */}
        {busyId === order.id ? "전송 중…" : "재전송"}
      </button>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-3">
      <AdminPageHeader
        title="유니폼 주문 관리"
        description={<>전체 <span className="tabular-nums">{counts.total}</span>건</>}
        actions={
          // 다른 사이트로 나가는 보조 이동이라 테두리 버튼(이 화면에 꽉 찬 주 버튼은 두지 않는다)
          <Link
            href="https://stiz.kr/product/detail.html?product_no=4095&from=dasan"
            target="_blank"
            className="academy-button-secondary"
          >
            신청 페이지 열기
          </Link>
        }
      />

      {loadError && (
        <div className="rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm font-medium text-[var(--color-academy-danger)]">
          {loadError}
          <p className="mt-1 text-xs font-normal">계속 불러오지 못하면 담당자에게 문의해 주세요.</p>
        </div>
      )}

      {feedback && (
        <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${
          feedback.type === "success"
            ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
            : "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
        }`}>
          {feedback.message}
        </div>
      )}

      {/* 상태 칩 — 바꾸면 열린 상세 패널은 닫는다 */}
      <StatusCountChips
        ariaLabel="유니폼 주문 상태별 건수"
        items={chipItems}
        selected={filter}
        onSelect={(value) => { setFilter(value); setDetailOrderId(null); }}
        allValue="ALL"
      />

      <section className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
        <div className="overflow-x-auto">
          {/* 한 줄 행: 상태 | 접수일 | 학부모 | 연락처 | 학생 | 수량 | 접수번호 | 시도 | 관리. 사이즈·메모·오류·다음 시도는 상세 패널 */}
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-medium text-[var(--color-academy-muted)]">
              <tr>
                <th className="px-2 py-2">상태</th>
                <th className="admin-cell-num px-2 py-2">접수일</th>
                <th className="px-2 py-2">학부모</th>
                <th className="admin-cell-num hidden px-2 py-2 md:table-cell">연락처</th>
                <th className="px-2 py-2">학생</th>
                <th className="admin-cell-num hidden px-2 py-2 md:table-cell">수량</th>
                <th className="hidden px-2 py-2 lg:table-cell">본사 접수번호</th>
                <th className="admin-cell-num hidden px-2 py-2 md:table-cell">시도</th>
                <th className="admin-cell-center px-2 py-2">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-academy-line)]">
              {visibleOrders.map((order) => {
                const sync = getSyncStatus(order.stizSyncStatus);
                const totalQuantity = order.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
                return (
                  <tr
                    key={order.id}
                    tabIndex={0}
                    aria-label={`${order.parentName} 유니폼 신청 상세 보기`}
                    onClick={() => setDetailOrderId(order.id)}
                    onKeyDown={(event) => handleRowKeyDown(event, order.id)}
                    className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                  >
                    <td className="px-2 py-1.5"><SyncBadge order={order} sync={sync} /></td>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{formatDateTime(order.createdAt)}</td>
                    <td className="px-2 py-1.5 font-semibold text-[var(--color-academy-ink)]">{order.parentName}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{order.parentPhone}</td>
                    {/* 학생: 1명이면 이름, 여러 명이면 «첫 이름 외 N명» — 전체 이름·사이즈는 상세 패널 */}
                    <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">
                      {order.items.length === 0 ? "-" : order.items.length === 1
                        ? order.items[0].studentName
                        : <>{order.items[0].studentName} 외 <span className="tabular-nums">{order.items.length - 1}</span>명</>}
                    </td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{totalQuantity}벌</td>
                    <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] lg:table-cell">{order.stizOrderNumber || "-"}</td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{order.sendAttempts}회</td>
                    {/* 관리: 재전송(행 클릭=상세 패널과 겹치지 않게 전파 차단) */}
                    <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                      {renderRetryButton(order)}
                    </td>
                  </tr>
                );
              })}
              {visibleOrders.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-4 text-center text-sm text-[var(--color-academy-muted)]">
                    표시할 유니폼 신청이 없습니다.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 행 클릭 상세 패널 — 이미 받아온 값만(새 조회 없음). 학생별 디자인·이니셜·등번호·사이즈, 메모, 오류, 다음 시도 */}
      {detailOrder && (() => {
        const d = detailOrder;
        const sync = getSyncStatus(d.stizSyncStatus);
        const rows: { label: string; value: React.ReactNode }[] = [
          { label: "접수일", value: <span className="tabular-nums">{formatDateTime(d.createdAt)}</span> },
          { label: "연락처", value: <span className="tabular-nums">{d.parentPhone}</span> },
          { label: "접수번호", value: d.stizOrderNumber },
          { label: "시도", value: <span className="tabular-nums">{d.sendAttempts}회</span> },
          { label: "다음 시도", value: d.nextRetryAt ? <span className="tabular-nums">{formatDateTime(d.nextRetryAt)}</span> : null },
          { label: "메모", value: d.customerMemo },
          { label: "오류", value: d.lastError ? <span className="font-medium text-[var(--color-academy-danger)]">{d.lastError}</span> : null },
        ].filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
        return (
          <ListDetailPanel onClose={() => setDetailOrderId(null)} titleId="uniform-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-4 flex items-center gap-2">
              <h3 id="uniform-detail-panel-title" className="min-w-0 break-keep text-lg font-bold text-[var(--color-academy-ink)]">{d.parentName}</h3>
              <SyncBadge order={d} sync={sync} />
              <button
                type="button"
                onClick={() => setDetailOrderId(null)}
                aria-label="닫기"
                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
              >
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="font-medium text-[var(--color-academy-muted)]">{row.label}</dt>
                  <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{row.value}</dd>
                </div>
              ))}
            </dl>
            {/* 학생별 주문 — 기존 목록의 «·» 묶음을 칸별 줄로 */}
            <ul className="mt-4 divide-y divide-[var(--color-academy-line)] rounded-lg border border-[var(--color-academy-line)] text-sm">
              {d.items.map((item) => (
                <li key={item.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 p-3">
                  <span className="font-medium text-[var(--color-academy-ink)]">{item.studentName}</span>
                  <span className="text-[var(--color-academy-ink)]">
                    {item.design || "디자인 미지정"} · <span className="tabular-nums">{item.quantity}</span>벌
                  </span>
                  <span className="text-xs text-[var(--color-academy-muted)]">등번호</span>
                  <span className="tabular-nums">{item.backNumber ? `#${item.backNumber}` : "등번호 없음"}</span>
                  {item.initials && (
                    <>
                      <span className="text-xs text-[var(--color-academy-muted)]">이니셜</span>
                      <span>{item.initials}</span>
                    </>
                  )}
                  <span className="text-xs text-[var(--color-academy-muted)]">사이즈</span>
                  <span>{[item.topSize ? `상의 ${item.topSize}` : "", item.bottomSize ? `하의 ${item.bottomSize}` : ""].filter(Boolean).join(", ") || "-"}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-wrap gap-2">{renderRetryButton(d)}</div>
          </ListDetailPanel>
        );
      })()}
    </main>
  );
}

// 전송 상태 배지(목록 행·상세 패널 공용) — 색은 기존 SYNC_STATUS 표 그대로
function SyncBadge({ order, sync }: { order: UniformOrderAdminView; sync: SyncTone }) {
  // 3년 재원 무료 증정 주문은 «무료 증정» 배지를 같이 단다 — 본사 자동 발송 없이 «확인 필요» 로 들어오므로
  // 원장이 내용을 보고 «재전송» 을 눌러 본사로 보낸다(표시는 주문 메모 앞머리로 판정)
  const isFree = isFreeUniformOrderMemo(order.customerMemo);
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs ring-1 ${sync.className}`}>
        {sync.label}
      </span>
      {isFree && (
        // 주 색(네이비)은 누르는 버튼 전용 — 표시용 배지는 «정보» 토큰
        <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">
          무료 증정
        </span>
      )}
    </span>
  );
}
