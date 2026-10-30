"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveWithdrawalRequest,
  rejectWithdrawalRequest,
  type WithdrawalRequestRow,
} from "@/app/actions/account-withdrawal-admin";
import { kstLabel } from "@/lib/datetime/kst";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

export default function WithdrawalsClient({ rows }: { rows: WithdrawalRequestRow[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  // 되돌릴 수 없는 처리라 한 행씩 «확인» 단계를 둔다. 목록에서 바로 지워지면 오조작이 난다.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // 행 클릭 상세 패널 대상(회원 id)
  const [detailId, setDetailId] = useState<string | null>(null);

  function run(action: () => Promise<{ ok?: boolean; error?: string }>) {
    setError("");
    startTransition(async () => {
      const result = await action();
      if (result?.error) {
        setError(result.error);
        return;
      }
      setConfirming(null);
      router.refresh();
    });
  }

  // ⚡·상세 패널이 같이 쓰는 작업 — 예전 행의 «탈퇴 처리»(확인 단계 열기)·«신청 반려»를 같은 함수로 옮긴 것.
  // 업무·권한 이관 대기(administrativeHold)는 예전처럼 버튼을 주지 않는다.
  function buildActions(row: WithdrawalRequestRow): AdminQuickAction[] {
    if (row.administrativeHold) return [];
    const userId = row.userId; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
    return [
      { key: "approve", label: "탈퇴 처리", icon: "person_remove", tone: "danger", disabled: pending, onSelect: () => setConfirming(userId) },
      { key: "reject", label: "신청 반려", icon: "undo", disabled: pending, onSelect: () => run(() => rejectWithdrawalRequest(userId)) },
    ];
  }

  // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  const detail = detailId ? rows.find((row) => row.userId === detailId) ?? null : null;
  // 확인 창 대상 — 예전 행 안의 «정말 삭제 / 그만» 단계를 창으로 옮겼다(같은 approveWithdrawalRequest 호출)
  const confirmTarget = confirming ? rows.find((row) => confirming === row.userId) ?? null : null;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-black text-[var(--color-academy-ink)]">
          <span className="material-symbols-outlined text-[var(--color-academy-primary)]" aria-hidden="true">
            person_remove
          </span>
          회원 탈퇴 신청
        </h1>
        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
          수강 중인 자녀나 직원 역할이 있는 회원의 탈퇴 요청입니다. 담당 업무와 연락 관계를 정리한 뒤
          처리해 주세요. <b>처리하면 로그인 계정과 연락처가 삭제되고 되돌릴 수 없습니다.</b> 출결·납부
          기록은 그대로 남습니다.
        </p>
      </div>

      {error && !confirmTarget && (
        <p className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-danger)]">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-academy-line)] px-4 py-4 text-center text-sm text-[var(--color-academy-muted)]">
          처리할 탈퇴 신청이 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {/* admin-list-table: 글자 왼쪽·날짜/숫자 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
          <table className="admin-list-table w-full border-collapse text-sm">
            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
              <tr>
                <th className="admin-cell-num px-2 py-2">신청일</th>
                <th className="px-2 py-2">회원</th>
                <th className="px-2 py-2">자녀</th>
                <th className="admin-cell-num px-2 py-2">수강 중</th>
                <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">연락처</th>
                <th className="admin-cell-center px-2 py-2">처리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-academy-line)]">
              {rows.map((row) => {
                const actions = buildActions(row);
                return (
                  <tr
                    key={row.userId}
                    tabIndex={0}
                    aria-label={`${row.name} 탈퇴 신청 상세 보기`}
                    onClick={() => setDetailId(row.userId)}
                    onKeyDown={(event) => handleRowKeyDown(event, row.userId)}
                    className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                  >
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{kstLabel(row.requestedAt)}</td>
                    {/* 처리 메모(reviewMessage)는 줄이 늘어나지 않게 상세 패널에서 */}
                    <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{row.name}</td>
                    <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{row.childNames || "—"}</td>
                    <td className="admin-cell-num px-2 py-1.5">
                      {row.activeEnrollments > 0 ? (
                        // 수업이 남아 있는데 지우면 보호자 연락이 끊긴다 — 눈에 띄게 표시한다.
                        <span className="rounded-md bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-bold text-[var(--color-academy-warning)]">
                          {row.activeEnrollments}개 반
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--color-academy-muted)]">없음</span>
                      )}
                    </td>
                    <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{row.phone || "—"}</td>
                    {/* 처리: ⚡(탈퇴 처리·신청 반려). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                    <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                      {row.administrativeHold ? (
                        <span className="text-xs font-semibold text-[var(--color-academy-warning)]">업무·권한 이관 후 처리</span>
                      ) : (
                        <AdminQuickActionMenu label={`${row.name} 탈퇴 신청 빠른 작업`} actions={actions} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 행 클릭 상세 패널 — 이미 받아온 값만(새 조회 없음). 작업 버튼은 ⚡ 와 같은 목록 */}
      {detail && !confirmTarget && (
        <ListDetailPanel onClose={() => setDetailId(null)} titleId="withdrawal-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <div className="mb-4 flex items-center gap-2">
            <h3 id="withdrawal-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{detail.name}</h3>
            <button
              type="button"
              onClick={() => setDetailId(null)}
              aria-label="닫기"
              className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
            >
              <span className="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="font-bold text-[var(--color-academy-muted)]">신청일</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(detail.requestedAt)}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">자녀</dt>
            <dd className="break-keep text-[var(--color-academy-ink)]">{detail.childNames || "—"}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">수강 중</dt>
            <dd className="text-[var(--color-academy-ink)]">{detail.activeEnrollments > 0 ? `${detail.activeEnrollments}개 반` : "없음"}</dd>
            <dt className="font-bold text-[var(--color-academy-muted)]">연락처</dt>
            <dd className="tabular-nums text-[var(--color-academy-ink)]">{detail.phone || "—"}</dd>
            {detail.reviewMessage && (
              <>
                <dt className="font-bold text-[var(--color-academy-muted)]">메모</dt>
                <dd className="whitespace-pre-wrap break-keep text-[var(--color-academy-ink)]">{detail.reviewMessage}</dd>
              </>
            )}
          </dl>
          {detail.administrativeHold ? (
            <p className="mt-5 text-sm font-semibold text-[var(--color-academy-warning)]">업무·권한 이관 후 처리</p>
          ) : (
            <div className="mt-5 flex flex-wrap gap-2">
              {buildActions(detail).map((action) => (
                <button
                  key={action.key}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => { setDetailId(null); void action.onSelect(); }}
                  className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-4 text-sm font-bold disabled:opacity-50 ${
                    action.tone === "danger"
                      ? "border-[var(--color-academy-danger)] text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]"
                      : "border-[var(--color-academy-line)] text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
                  }`}
                >
                  <span className="material-symbols-outlined text-lg" aria-hidden="true">{action.icon}</span>
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </ListDetailPanel>
      )}

      {/* 되돌릴 수 없는 탈퇴 확인 창 — 예전 행 안의 «정말 삭제 / 그만» 과 같은 동작 */}
      {confirmTarget && (
        <AdminModal titleId="withdrawal-confirm-title" onClose={() => { if (!pending) setConfirming(null); }} closeOnBackdrop={false} panelClassName="max-w-md p-5">
          <h3 id="withdrawal-confirm-title" className="break-keep text-lg font-black text-[var(--color-academy-ink)]">
            {confirmTarget.name} 탈퇴 처리
          </h3>
          <p className="mt-2 text-sm text-[var(--color-academy-muted)]">
            로그인 계정과 연락처가 삭제되고 되돌릴 수 없습니다.
            {confirmTarget.activeEnrollments > 0 && <b className="text-[var(--color-academy-warning)]"> 수강 중인 반이 {confirmTarget.activeEnrollments}개 있습니다.</b>}
          </p>
          {error && (
            <p className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(null)}
              disabled={pending}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-[var(--color-academy-line)] px-3 text-sm font-bold text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] disabled:opacity-50"
            >
              그만
            </button>
            <button
              type="button"
              onClick={() => run(() => approveWithdrawalRequest(confirmTarget.userId))}
              disabled={pending}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-[var(--color-academy-danger)] px-3 text-sm font-black text-white disabled:opacity-50"
            >
              {pending ? "처리 중..." : "정말 삭제"}
            </button>
          </div>
        </AdminModal>
      )}
    </div>
  );
}
