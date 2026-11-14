import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { getAcademySettings } from "@/lib/queries";
import ConsultForm from "@/components/consult/ConsultForm";

// 학부모 앱 «형제·자매 상담 신청» (2026-11-10 상담 신청 신설 · 원장 승인 k1·m4).
// 이미 다니는 집에서 동생·언니를 보내고 싶을 때 — 보호자 이름·번호는 로그인 계정에서 미리 채운다(고칠 수 있다).
// 접수 경로는 PARENT_APP, 신청 계정은 서버 액션이 로그인으로 다시 정한다(화면 값을 믿지 않는다).
export const dynamic = "force-dynamic";

export default async function ParentConsultPage() {
    const parent = await requireVerifiedParent().catch(() => null);
    // bounced=1 로 목적지를 지운다 — 여기로 되돌려보내면 거절 → 판별 → 거절이 무한 반복된다.
    if (!parent) redirect("/mypage/continue?bounced=1");

    const [rows, settings] = await Promise.all([
        prisma.$queryRawUnsafe<Array<{ name: string | null; phone: string | null }>>(
            `SELECT name, phone FROM "User" WHERE id = $1 LIMIT 1`,
            parent.appUserId,
        ),
        getAcademySettings(),
    ]);
    const me = rows[0];
    const phone = (settings as { contactPhone?: string | null } | null)?.contactPhone || undefined;

    return (
        <div className="mx-auto w-full max-w-2xl space-y-3 px-4 py-4">
            <div>
                {/* 제목 아래 안내는 없앴다(2026-11-14 문구 정리) — 폼의 보내기 버튼 아래 «확인 후 전화로 연락드려요»가 같은 말을 한다 */}
                <h1 className="academy-heading">형제·자매 상담 신청</h1>
            </div>
            <ConsultForm
                mode="parent"
                initialGuardianName={me?.name ?? parent.appUserName ?? ""}
                initialGuardianPhone={me?.phone ?? ""}
                contactPhone={phone}
                homeHref="/mypage"
            />
        </div>
    );
}
