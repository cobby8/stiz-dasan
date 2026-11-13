import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import ApplyAdminClient from "@/app/admin/apply/ApplyAdminClient";

// 신청 설정 — 신청함 오른쪽 위 ⚙ 버튼(2026-11-10 원장 결정 k4).
// 옛 /admin/apply 의 «안내 설정» 탭과 «입학 점검» 링크를 여기로 모았다(같은 컴포넌트·같은 API).
// 2026-11-13: «유입 통계» 탭은 통계 화면 «유입·전환» 탭(/admin/stats?tab=funnel)으로 옮겼다.
export const dynamic = "force-dynamic";

export default async function InboxSettingsPage() {
  await requireAdmin();
  return (
    <div className="space-y-3">
      {/* 머리 한 줄: 신청함으로 돌아가기 + 제목 + 입학 점검 */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/admin/inbox" prefetch={false} aria-label="신청함으로 돌아가기" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
          <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>
        </Link>
        <h1 className="mr-auto text-xl font-black text-[var(--color-academy-ink)]">신청 설정</h1>
        <Link href="/admin/registration-readiness" prefetch={false} className="academy-button-secondary">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">checklist</span>
          입학 점검
        </Link>
      </div>
      <ApplyAdminClient mode="settings" />
    </div>
  );
}
