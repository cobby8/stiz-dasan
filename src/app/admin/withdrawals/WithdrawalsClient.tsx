"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveWithdrawalRequest,
  rejectWithdrawalRequest,
  type WithdrawalRequestRow,
} from "@/app/actions/account-withdrawal-admin";
import { kstLabel } from "@/lib/datetime/kst";

export default function WithdrawalsClient({ rows }: { rows: WithdrawalRequestRow[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  // 되돌릴 수 없는 처리라 한 행씩 «확인» 단계를 둔다. 목록에서 바로 지워지면 오조작이 난다.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-black text-gray-900 dark:text-white">
          <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">
            person_remove
          </span>
          회원 탈퇴 신청
        </h1>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          수강 중인 자녀나 직원 역할이 있는 회원의 탈퇴 요청입니다. 담당 업무와 연락 관계를 정리한 뒤
          처리해 주세요. <b>처리하면 로그인 계정과 연락처가 삭제되고 되돌릴 수 없습니다.</b> 출결·납부
          기록은 그대로 남습니다.
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-gray-200 px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
          처리할 탈퇴 신청이 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs font-bold text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">신청일</th>
                <th className="px-3 py-2">회원</th>
                <th className="px-3 py-2">자녀</th>
                <th className="px-3 py-2">수강 중</th>
                <th className="px-3 py-2">연락처</th>
                <th className="px-3 py-2">처리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                    {kstLabel(row.requestedAt)}
                  </td>
                  <td className="px-3 py-2 font-bold text-gray-900 dark:text-white">{row.name}{row.reviewMessage && <p className="mt-1 max-w-64 text-xs font-normal text-gray-500">{row.reviewMessage}</p>}</td>
                  <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{row.childNames || "—"}</td>
                  <td className="px-3 py-2">
                    {row.activeEnrollments > 0 ? (
                      // 수업이 남아 있는데 지우면 보호자 연락이 끊긴다 — 눈에 띄게 표시한다.
                      <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        {row.activeEnrollments}개 반
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">없음</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{row.phone || "—"}</td>
                  <td className="px-3 py-2">
                    {row.administrativeHold ? <span className="text-xs font-semibold text-amber-700">업무·권한 이관 후 처리</span> : confirming === row.userId ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => run(() => approveWithdrawalRequest(row.userId))}
                          disabled={pending}
                          className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                        >
                          {pending ? "처리 중..." : "정말 삭제"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          disabled={pending}
                          className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300"
                        >
                          그만
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirming(row.userId)}
                          disabled={pending}
                          className="rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
                        >
                          탈퇴 처리
                        </button>
                        <button
                          type="button"
                          onClick={() => run(() => rejectWithdrawalRequest(row.userId))}
                          disabled={pending}
                          className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs font-bold text-gray-600 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300"
                        >
                          신청 반려
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
    </div>
  );
}
