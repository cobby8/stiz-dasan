import Link from "next/link";
import ScopeBackLink from "@/components/navigation/ScopeBackLink";
import { requireAdmin } from "@/lib/auth-guard";
import ApplyAdminClient from "@/app/admin/apply/ApplyAdminClient";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

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
        {/* 보던 신청함 탭으로 돌아간다(한 칸 뒤로). 고정 주소로 가면 탭이 «건수 있는 첫 탭»으로 바뀌었다(2026-11-17). 기록이 없을 때만 신청함 첫 화면 */}
        <ScopeBackLink fallbackHref="/admin/inbox" prefetch={false} ariaLabel="신청함으로 돌아가기" className="academy-button-text academy-button-sm shrink-0 whitespace-nowrap">
          ← 신청함
        </ScopeBackLink>
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
