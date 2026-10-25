"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveRoleRequest,
  rejectRoleRequest,
  revokeRoleGrant,
  type RoleGrantAdminRow,
} from "@/app/actions/role-requests-admin";
import { kstLabel } from "@/lib/datetime/kst";

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

  const person = (row: RoleGrantAdminRow) => (
    <>
      <td className="px-3 py-2 font-bold text-gray-900 dark:text-white">
        {row.name}
        <span className="ml-1 text-xs font-medium text-gray-400">({PRIMARY_LABEL[row.primaryRole] ?? row.primaryRole})</span>
      </td>
      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{row.phone || "—"}</td>
      <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">{row.childNames || "—"}</td>
    </>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-black text-gray-900 dark:text-white">
          <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">badge</span>
          직원 역할 신청
        </h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          가입할 때 선생님·기사님을 고른 사람이 여기로 모입니다. <b>승인하면 그 사람에게 학생 정보가 보이기 시작합니다</b> —
          학원에서 실제로 일하는 분인지 전화번호로 확인한 뒤 승인해 주세요. 회수하면 바로 막힙니다.
        </p>
        {!canDecide && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            승인·반려·회수는 원장님만 할 수 있습니다. 목록 확인만 가능합니다.
          </p>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-200">{error}</p>
      )}

      {/* 대기 중인 신청 */}
      <section>
        <h2 className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">확인 대기 {pending.length}건</h2>
        {pending.length === 0 ? (
          <p className="rounded-xl border border-gray-200 px-4 py-5 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
            확인할 신청이 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs font-bold text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2">신청일</th><th className="px-3 py-2">신청 역할</th><th className="px-3 py-2">이름</th>
                  <th className="px-3 py-2">연락처</th><th className="px-3 py-2">자녀</th><th className="px-3 py-2">처리</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{kstLabel(row.requestedAt)}</td>
                    <td className="px-3 py-2">
                      <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        {ROLE_LABEL[row.role]}
                      </span>
                    </td>
                    {person(row)}
                    <td className="px-3 py-2">
                      {!canDecide ? (
                        <span className="text-xs text-gray-400">원장님 확인 필요</span>
                      ) : confirming === row.id ? (
                        <div className="flex items-center gap-1.5">
                          <button type="button" disabled={pendingAction} onClick={() => run(() => approveRoleRequest(row.id))}
                            className="rounded-lg bg-green-600 px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                            {pendingAction ? "처리 중..." : "승인 확정"}
                          </button>
                          <button type="button" disabled={pendingAction} onClick={() => setConfirming(null)}
                            className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300">
                            그만
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <button type="button" disabled={pendingAction} onClick={() => setConfirming(row.id)}
                            className="rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">
                            승인
                          </button>
                          <button type="button" disabled={pendingAction} onClick={() => run(() => rejectRoleRequest(row.id))}
                            className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300">
                            반려
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 부여된 역할 — 회수할 수 있다 */}
      <section>
        <h2 className="mb-2 text-sm font-black text-gray-700 dark:text-gray-200">부여된 추가 역할 {active.length}건</h2>
        {active.length === 0 ? (
          <p className="rounded-xl border border-gray-200 px-4 py-5 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
            부여된 추가 역할이 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs font-bold text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2">부여일</th><th className="px-3 py-2">역할</th><th className="px-3 py-2">이름</th>
                  <th className="px-3 py-2">연락처</th><th className="px-3 py-2">자녀</th><th className="px-3 py-2">경로</th><th className="px-3 py-2">처리</th>
                </tr>
              </thead>
              <tbody>
                {active.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{row.decidedAt ? kstLabel(row.decidedAt) : "—"}</td>
                    <td className="px-3 py-2 text-xs font-bold text-gray-800 dark:text-gray-100">{ROLE_LABEL[row.role]}</td>
                    {person(row)}
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{SOURCE_LABEL[row.source] ?? row.source}</td>
                    <td className="px-3 py-2">
                      {!canDecide ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : confirming === row.id ? (
                        <div className="flex items-center gap-1.5">
                          <button type="button" disabled={pendingAction} onClick={() => run(() => revokeRoleGrant(row.id))}
                            className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                            {pendingAction ? "처리 중..." : "회수 확정"}
                          </button>
                          <button type="button" disabled={pendingAction} onClick={() => setConfirming(null)}
                            className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300">
                            그만
                          </button>
                        </div>
                      ) : (
                        <button type="button" disabled={pendingAction} onClick={() => setConfirming(row.id)}
                          className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300">
                          회수
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
