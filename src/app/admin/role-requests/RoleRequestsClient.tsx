"use client";
import { adminMessageText } from "@/components/admin/adminDisplayText";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveRoleRequest,
  rejectRoleRequest,
  revokeRoleGrant,
  type RoleGrantAdminRow,
} from "@/app/actions/role-requests-admin";
import { kstLabel } from "@/lib/datetime/kst";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

const ROLE_LABEL: Record<RoleGrantAdminRow["role"], string> = { INSTRUCTOR: "선생님", DRIVER: "기사님" };
const PRIMARY_LABEL: Record<string, string> = {
  PARENT: "학부모", INSTRUCTOR: "선생님", DRIVER: "기사님", ADMIN: "원장", VICE_ADMIN: "부원장",
};
const SOURCE_LABEL: Record<string, string> = { REQUEST: "가입 신청", INVITE: "초대 링크", ADMIN: "원장 직접" };

export default function RoleRequestsClient({
  pending,
  active,
  canDecide,
}: {
  pending: RoleGrantAdminRow[];
  active: RoleGrantAdminRow[];
  canDecide: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  // 승인은 학생 개인정보를 여는 일이라, 회수는 되돌릴 수 없는 일이라 행마다 한 번 더 확인한다.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pendingAction, startTransition] = useTransition();
  // 행 클릭 상세 패널 대상(역할 id) — 대기·부여 목록 어느 쪽 행이든 같은 패널
  const [detailId, setDetailId] = useState<string | null>(null);

  function run(action: () => Promise<{ ok?: boolean; error?: string }>) {
    setError("");
    startTransition(async () => {
      const result = await action();
      if (result?.error) {
        setError(adminMessageText(result.error, "처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        return;
      }
      setConfirming(null);
      router.refresh();
    });
  }

  // ⚡·패널 작업 — 예전 행의 승인(확인 단계 열기)·반려 / 회수(확인 단계 열기)를 같은 함수로 옮긴 것.
  // 원장이 아니면(canDecide=false) 예전처럼 작업 없음.
  function buildActions(row: RoleGrantAdminRow, isPending: boolean): AdminQuickAction[] {
    if (!canDecide) return [];
    const id = row.id; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
    if (isPending) {
      return [
        { key: "approve", label: "승인", icon: "check", tone: "primary", disabled: pendingAction, onSelect: () => setConfirming(id) },
        { key: "reject", label: "반려", icon: "block", disabled: pendingAction, onSelect: () => run(() => rejectRoleRequest(id)) },
      ];
    }
    return [{ key: "revoke", label: "회수", icon: "remove_moderator", tone: "danger", disabled: pendingAction, onSelect: () => setConfirming(id) }];
  }

  // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
  function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setDetailId(id);
    }
  }

  const rowClass =
    "cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none";

  // 이름 | 기본 역할 | 연락처 | 자녀 — 예전엔 «이름 (학부모)» 를 한 칸에 붙였는데 칸을 나눴다
  const person = (row: RoleGrantAdminRow) => (
    <>
      <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{row.name}</td>
      <td className="hidden px-2 py-1.5 text-xs text-[var(--color-academy-muted)] sm:table-cell">{PRIMARY_LABEL[row.primaryRole] ?? row.primaryRole}</td>
      <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{row.phone || "—"}</td>
      <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{row.childNames || "—"}</td>
    </>
  );

  // 처리 칸: 원장이 아니면 예전 안내 문구, 원장이면 ⚡. 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단
  const actionCell = (row: RoleGrantAdminRow, isPending: boolean) => (
    <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
      {!canDecide ? (
        <span className="text-xs text-[var(--color-academy-muted)]">{isPending ? "원장님 확인 필요" : "—"}</span>
      ) : (
        <AdminQuickActionMenu label={`${row.name} ${ROLE_LABEL[row.role]} 역할 빠른 작업`} actions={buildActions(row, isPending)} />
      )}
    </td>
  );

  const headClass = "bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]";
  const pendingDetail = detailId ? pending.find((row) => row.id === detailId) ?? null : null;
  const detail = pendingDetail ?? (detailId ? active.find((row) => row.id === detailId) ?? null : null);
  // 확인 창 대상 — 대기 목록이면 «승인 확정», 부여 목록이면 «회수 확정»(예전 행 안의 확인 단계와 같은 함수)
  const confirmPending = confirming ? pending.find((row) => confirming === row.id) ?? null : null;
  const confirmActive = !confirmPending && confirming ? active.find((row) => confirming === row.id) ?? null : null;
  const confirmTarget = confirmPending ?? confirmActive;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-black text-[var(--color-academy-ink)]">
          <span className="material-symbols-outlined text-[var(--color-academy-primary)]" aria-hidden="true">badge</span>
          직원 역할 신청
        </h1>
        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
          가입할 때 선생님·기사님을 고른 사람이 여기로 모입니다. <b>승인하면 그 사람에게 학생 정보가 보이기 시작합니다</b> —
          학원에서 실제로 일하는 분인지 전화번호로 확인한 뒤 승인해 주세요. 회수하면 바로 막힙니다.
        </p>
        {!canDecide && (
          <p className="mt-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs font-semibold text-[var(--color-academy-warning)]">
            승인·반려·회수는 원장님만 할 수 있습니다. 목록 확인만 가능합니다.
          </p>
        )}
      </div>

      {error && !confirmTarget && (
        <p className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-danger)]">{error}</p>
      )}

      {/* 대기 중인 신청 */}
      <section>
        <h2 className="mb-2 text-sm font-black text-[var(--color-academy-ink)]">확인 대기 <span className="tabular-nums">{pending.length}</span>건</h2>
        {pending.length === 0 ? (
          <p className="rounded-xl border border-[var(--color-academy-line)] px-4 py-3 text-center text-sm text-[var(--color-academy-muted)]">
            확인할 신청이 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            <table className="admin-list-table w-full border-collapse text-sm">
              <thead className={headClass}>
                <tr>
                  <th className="admin-cell-num px-2 py-2">신청일</th><th className="px-2 py-2">신청 역할</th><th className="px-2 py-2">이름</th>
                  <th className="hidden px-2 py-2 sm:table-cell">기본 역할</th><th className="admin-cell-num hidden px-2 py-2 md:table-cell">연락처</th>
                  <th className="px-2 py-2">자녀</th><th className="admin-cell-center px-2 py-2">처리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-academy-line)]">
                {pending.map((row) => (
                  <tr key={row.id} tabIndex={0} aria-label={`${row.name} ${ROLE_LABEL[row.role]} 신청 상세 보기`} onClick={() => setDetailId(row.id)} onKeyDown={(event) => handleRowKeyDown(event, row.id)} className={rowClass}>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{kstLabel(row.requestedAt)}</td>
                    <td className="px-2 py-1.5">
                      <span className="rounded-md bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-bold text-[var(--color-academy-warning)]">
                        {ROLE_LABEL[row.role]}
                      </span>
                    </td>
                    {person(row)}
                    {actionCell(row, true)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 부여된 역할 — 회수할 수 있다 */}
      <section>
        <h2 className="mb-2 text-sm font-black text-[var(--color-academy-ink)]">부여된 추가 역할 <span className="tabular-nums">{active.length}</span>건</h2>
        {active.length === 0 ? (
          <p className="rounded-xl border border-[var(--color-academy-line)] px-4 py-3 text-center text-sm text-[var(--color-academy-muted)]">
            부여된 추가 역할이 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            <table className="admin-list-table w-full border-collapse text-sm">
              <thead className={headClass}>
                <tr>
                  <th className="admin-cell-num px-2 py-2">부여일</th><th className="px-2 py-2">역할</th><th className="px-2 py-2">이름</th>
                  <th className="hidden px-2 py-2 sm:table-cell">기본 역할</th><th className="admin-cell-num hidden px-2 py-2 md:table-cell">연락처</th>
                  <th className="px-2 py-2">자녀</th><th className="hidden px-2 py-2 sm:table-cell">경로</th><th className="admin-cell-center px-2 py-2">처리</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-academy-line)]">
                {active.map((row) => (
                  <tr key={row.id} tabIndex={0} aria-label={`${row.name} ${ROLE_LABEL[row.role]} 역할 상세 보기`} onClick={() => setDetailId(row.id)} onKeyDown={(event) => handleRowKeyDown(event, row.id)} className={rowClass}>
                    <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{row.decidedAt ? kstLabel(row.decidedAt) : "—"}</td>
                    <td className="px-2 py-1.5 text-xs font-bold text-[var(--color-academy-ink)]">{ROLE_LABEL[row.role]}</td>
                    {person(row)}
                    <td className="hidden px-2 py-1.5 text-xs text-[var(--color-academy-muted)] sm:table-cell">{SOURCE_LABEL[row.source] ?? row.source}</td>
                    {actionCell(row, false)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 행 클릭 상세 패널 — 이미 받아온 값만(새 조회 없음). 작업 버튼은 ⚡ 와 같은 목록 */}
      {detail && !confirmTarget && (() => {
        const d = detail;
        const isPending = Boolean(pendingDetail);
        const actions = buildActions(d, isPending);
        return (
          <ListDetailPanel onClose={() => setDetailId(null)} titleId="role-request-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="mb-4 flex items-center gap-2">
              <h3 id="role-request-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">
                {d.name} · {ROLE_LABEL[d.role]}
              </h3>
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
              <dt className="font-bold text-[var(--color-academy-muted)]">상태</dt>
              <dd className="text-[var(--color-academy-ink)]">{isPending ? "확인 대기" : "부여됨"}</dd>
              <dt className="font-bold text-[var(--color-academy-muted)]">{isPending ? "신청일" : "부여일"}</dt>
              <dd className="tabular-nums text-[var(--color-academy-ink)]">{isPending ? kstLabel(d.requestedAt) : d.decidedAt ? kstLabel(d.decidedAt) : "—"}</dd>
              <dt className="font-bold text-[var(--color-academy-muted)]">기본 역할</dt>
              <dd className="text-[var(--color-academy-ink)]">{PRIMARY_LABEL[d.primaryRole] ?? d.primaryRole}</dd>
              <dt className="font-bold text-[var(--color-academy-muted)]">연락처</dt>
              <dd className="tabular-nums text-[var(--color-academy-ink)]">{d.phone || "—"}</dd>
              <dt className="font-bold text-[var(--color-academy-muted)]">자녀</dt>
              <dd className="break-keep text-[var(--color-academy-ink)]">{d.childNames || "—"}</dd>
              {!isPending && (
                <>
                  <dt className="font-bold text-[var(--color-academy-muted)]">경로</dt>
                  <dd className="text-[var(--color-academy-ink)]">{SOURCE_LABEL[d.source] ?? d.source}</dd>
                </>
              )}
            </dl>
            {actions.length === 0 ? (
              <p className="mt-5 text-sm text-[var(--color-academy-muted)]">승인·반려·회수는 원장님만 할 수 있습니다.</p>
            ) : (
              <div className="mt-5 flex flex-wrap gap-2">
                {actions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    disabled={action.disabled}
                    onClick={() => { setDetailId(null); void action.onSelect(); }}
                    className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-4 text-sm font-bold disabled:opacity-50 ${
                      action.tone === "danger"
                        ? "border-[var(--color-academy-danger)] text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]"
                        : action.tone === "primary"
                          ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]"
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
        );
      })()}

      {/* 승인·회수 확인 창 — 예전 행 안의 «승인 확정 / 회수 확정 / 그만» 과 같은 동작 */}
      {confirmTarget && (
        <AdminModal titleId="role-request-confirm-title" onClose={() => { if (!pendingAction) setConfirming(null); }} closeOnBackdrop={false} panelClassName="max-w-md p-5">
          <h3 id="role-request-confirm-title" className="break-keep text-lg font-black text-[var(--color-academy-ink)]">
            {confirmTarget.name} {ROLE_LABEL[confirmTarget.role]} 역할 {confirmPending ? "승인" : "회수"}
          </h3>
          <p className="mt-2 text-sm text-[var(--color-academy-muted)]">
            {confirmPending
              ? "승인하면 이 사람에게 학생 정보가 보이기 시작합니다. 학원에서 실제로 일하는 분인지 확인하셨나요?"
              : "회수하면 바로 막힙니다."}
          </p>
          {error && (
            <p className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-bold text-[var(--color-academy-danger)]">{error}</p>
          )}
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={pendingAction} onClick={() => setConfirming(null)}
              className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-[var(--color-academy-line)] px-3 text-sm font-bold text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] disabled:opacity-50">
              그만
            </button>
            {confirmPending ? (
              <button type="button" disabled={pendingAction} onClick={() => run(() => approveRoleRequest(confirmPending.id))}
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-[var(--color-academy-success)] px-3 text-sm font-black text-white disabled:opacity-50">
                {pendingAction ? "처리 중..." : "승인 확정"}
              </button>
            ) : (
              <button type="button" disabled={pendingAction} onClick={() => run(() => revokeRoleGrant(confirmTarget.id))}
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg bg-[var(--color-academy-danger)] px-3 text-sm font-black text-white disabled:opacity-50">
                {pendingAction ? "처리 중..." : "회수 확정"}
              </button>
            )}
          </div>
        </AdminModal>
      )}
    </div>
  );
}
