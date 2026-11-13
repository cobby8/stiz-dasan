import Link from "next/link";
import { requireAdmin } from "@/lib/auth-guard";
import ApplyAdminClient from "@/app/admin/apply/ApplyAdminClient";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

// 신청 설정 — 신청함 오른쪽 위 ⚙ 버튼(2026-11-10 원장 결정 k4).
// 옛 /admin/apply 의 «유입 통계»·«안내 설정» 두 탭과 «입학 점검» 링크를 여기로 모았다(같은 컴포넌트·같은 API).
// 통계는 조회 범위를 바꿀 때마다 API 로 읽어 캐시할 게 없다.
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
        <AdminPageHeader
          className="min-w-0 flex-1"
          title="신청 설정"
          actions={<Link href="/admin/registration-readiness" prefetch={false} className="academy-button-secondary">입학 점검</Link>}
        />
      </div>
      <ApplyAdminClient mode="settings" />
    </div>
  );
}
