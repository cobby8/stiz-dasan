"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { recoverStaffInvitation } from "@/app/actions/staff-invite-recovery";

type RecoveryItem = {
  id: string;
  name: string;
  status: string;
  processingStartedAt: string | null;
  recoveryAuthUserId: string | null;
  recoveryError: string | null;
};

export default function StaffInviteRecoveryClient({ initialInvitations }: { initialInvitations: RecoveryItem[] }) {
  const [items, setItems] = useState(initialInvitations);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function recover(item: RecoveryItem) {
    if (!window.confirm(`${item.name}님의 중단된 가입 계정과 초대를 정리하시겠습니까?`)) return;
    setMessage("");
    startTransition(async () => {
      const result = await recoverStaffInvitation({ invitationId: item.id });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setMessage("초대를 안전하게 초기화했습니다. 새 인증번호를 요청할 수 있습니다.");
    });
  }

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <Link href="/admin/staff" className="text-sm font-bold text-[var(--color-academy-muted)]">← 직원 관리</Link>
        <h1 className="mt-3 text-2xl font-black">중단된 초대 복구</h1>
        <p className="mt-2 text-sm text-[var(--color-academy-muted)]">원장 계정만 실행할 수 있습니다. 10분 이상 중단된 가입 또는 복구 필요 상태만 초기화됩니다.</p>
      </div>
      {message && <p className="rounded-xl bg-[var(--color-academy-soft)] p-3 text-sm font-bold">{message}</p>}
      <div className="space-y-3">
        {items.map((item) => (
          <article key={item.id} className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-black">{item.name}</p>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">{item.status} · {item.processingStartedAt ? new Date(item.processingStartedAt).toLocaleString("ko-KR") : "시작 시각 없음"}</p>
                {item.recoveryError && <p className="mt-2 text-sm text-[var(--color-academy-danger)]">{item.recoveryError}</p>}
              </div>
              {/* «안전 복구»는 중단된 가입의 로그인 계정(Supabase 인증)을 «삭제»하고 초대를 처음으로 되돌린다 — 되돌릴 수 없어
                  꽉 찬 위험 버튼(danger-fill, 2026-11-09 위험색 역할 분리)을 유지한다. 누르면 확인창을 한 번 거친다. */}
              <button type="button" disabled={pending} onClick={() => recover(item)} className="min-h-11 rounded-xl bg-[var(--color-academy-danger-fill)] px-4 font-bold text-white hover:bg-[var(--color-academy-danger-fill-hover)] disabled:opacity-50">안전 복구</button>
            </div>
          </article>
        ))}
        {items.length === 0 && <p className="rounded-2xl border border-dashed p-8 text-center text-[var(--color-academy-muted)]">복구가 필요한 초대가 없습니다.</p>}
      </div>
    </main>
  );
}
