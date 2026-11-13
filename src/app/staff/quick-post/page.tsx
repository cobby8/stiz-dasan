import Link from "next/link";
import { requireStaff } from "@/lib/auth-guard";
import QuickPostClient from "./QuickPostClient";

export const dynamic = "force-dynamic";
// 2026-11-14 검수: 이 화면의 «게시» 서버 액션이 인스타를 부른다. 실행 시간 제한을 명시한다(vercel.json 기본값과 같은 60초).
export const maxDuration = 60;

export default async function StaffQuickPostPage() {
  try {
    const staff = await requireStaff();
    if (!staff.roles.teacher) {
      return (
        <main className="min-h-screen bg-surface-warm px-4 py-10">
          <div className="mx-auto max-w-md rounded-lg border border-[var(--color-academy-line)] bg-white p-6 shadow-sm">
            <h1 className="text-xl font-bold text-[var(--color-academy-ink)]">사진 업로드는 선생님 전용입니다</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">
              셔틀 기사 계정은 운행 화면에서 노선과 탑승 정보를 확인하도록 분리했습니다.
            </p>
            <Link
              href="/staff/shuttle"
              className="academy-button-primary mt-5 w-full"
            >
              셔틀 화면으로 이동
            </Link>
          </div>
        </main>
      );
    }
    return (
      <QuickPostClient
        currentUser={{
          name: staff.appUserName,
          role: staff.appUserRole,
        }}
        // 2026-11-14 사진·인스타 점검: 게시 권한을 서버에서 계산해 내려 준다(서버 액션의 검사와 같은 기준).
        // 갤러리 = 관리자(원장·부원장) · 인스타 = 원장. 관리자 권한은 추가 역할로 줄 수 없어 주 역할만 본다.
        permissions={{
          canPublishGallery: staff.appUserRole === "ADMIN" || staff.appUserRole === "VICE_ADMIN",
          canPublishInstagram: staff.appUserRole === "ADMIN",
        }}
      />
    );
  } catch {
    return (
      <main className="min-h-screen bg-surface-warm px-4 py-10">
        <div className="mx-auto max-w-md rounded-lg border border-[var(--color-academy-line)] bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-[var(--color-academy-ink)]">스태프 로그인이 필요합니다</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">
            사진 초안 업로드는 등록된 선생님, 부관리자, 관리자만 사용할 수 있습니다.
          </p>
          <Link
            href="/login?redirect=/staff/quick-post"
            className="academy-button-primary mt-5 w-full"
          >
            로그인하기
          </Link>
        </div>
      </main>
    );
  }
}
