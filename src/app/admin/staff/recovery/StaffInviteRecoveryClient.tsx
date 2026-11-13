"use client";

import Link from "next/link";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { useState, useTransition } from "react";
import { recoverStaffInvitation } from "@/app/actions/staff-invite-recovery";
import { kstHm, kstLabel } from "@/lib/datetime/kst";

// 영문 상태값 대신 한국어(2026-11-12 점검 — 화면에 «RECOVERY_REQUIRED»가 그대로 보였다)
const STATUS_LABEL: Record<string, string> = {
  PROCESSING: "가입 처리 중 멈춤",
  RECOVERY_REQUIRED: "복구 필요",
  RECOVERING: "복구 중 멈춤",
};

type RecoveryItem = {
  id: string;
  name: string;
  status: string;
  processingStartedAt: string | null;
  recoveryAuthUserId: string | null;
  recoveryError: string | null;
  /** 기존 직원 기록을 향한 초대 — 정리 뒤 대기로 되돌리지 않고 취소로 끝난다 */
  targetUserId?: string | null;
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
      // 기존 직원 기록을 향한 초대(전환·재설정·재입사)는 대기로 되돌리지 않고 취소로 끝난다
      setMessage(result.cancelled
        ? "가입 계정을 정리하고 이 초대는 취소했습니다. 필요하면 다시 초대해 주세요."
        : "초대를 안전하게 초기화했습니다. 새 인증번호를 요청할 수 있습니다.");
    });
  }

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <Link href="/admin/staff" className="text-sm font-medium text-[var(--color-academy-muted)]">← 스태프 관리</Link>
        <AdminPageHeader title="중단된 초대 복구" className="mt-3" />
        <p className="mt-2 text-sm text-[var(--color-academy-muted)]">원장 계정만 실행할 수 있습니다. 10분 이상 중단된 가입 또는 복구 필요 상태만 초기화됩니다.</p>
      </div>
      {message && <p className="rounded-xl bg-[var(--color-academy-soft)] p-3 text-sm font-medium">{message}</p>}
      <div className="space-y-3">
        {items.map((item) => (
          <article key={item.id} className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-semibold">{item.name}</p>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">{STATUS_LABEL[item.status] ?? item.status} · {item.processingStartedAt ? `${kstLabel(item.processingStartedAt)} ${kstHm(item.processingStartedAt)} 시작` : "시작 시각 없음"}{item.targetUserId ? " · 정리 후 취소" : ""}</p>
                {item.recoveryError && <p className="mt-2 text-sm text-[var(--color-academy-danger)]">{item.recoveryError}</p>}
              </div>
              {/* «안전 복구»는 중단된 가입의 로그인 계정(Supabase 인증)을 «삭제»하고 초대를 처음으로 되돌린다 — 되돌릴 수 없어
                  꽉 찬 위험 버튼(academy-button-danger-solid = danger-fill, 2026-11-09 위험색 역할 분리)을 유지한다. 누르면 확인창을 한 번 거친다. */}
              <button type="button" disabled={pending} onClick={() => recover(item)} className="academy-button-danger-solid shrink-0">안전 복구</button>
            </div>
          </article>
        ))}
        {items.length === 0 && <p className="rounded-2xl border border-dashed p-8 text-center text-[var(--color-academy-muted)]">복구가 필요한 초대가 없습니다.</p>}
      </div>
    </main>
  );
}
