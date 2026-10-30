import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOwnAccount } from "@/lib/account/own-account";
import { getAccountViewAccess } from "@/lib/account-view-access";
import OwnAccountFrame from "@/components/account/OwnAccountFrame";

export const dynamic = "force-dynamic";
export const metadata = { title: "내 계정 | 스티즈 농구교실" };
const roleNames: Record<string, string> = {
  ADMIN: "관리자",
  VICE_ADMIN: "부관리자",
  INSTRUCTOR: "선생님",
  DRIVER: "기사님",
  PARENT: "학부모",
};
export default async function AccountPage() {
  const account = await requireOwnAccount().catch(() =>
    redirect("/login?redirect=/account"),
  );
  const { views } = await getAccountViewAccess();
  return (
    <OwnAccountFrame views={views}>
      <section className="mx-auto max-w-2xl px-4 py-6 text-[var(--color-academy-ink)]">
        <h1 className="text-xl font-black">내 계정</h1>
        <p className="mt-2 text-sm text-[var(--color-academy-muted)]">
          {account.appUserName} · {roleNames[account.appUserRole] || "회원"}
        </p>
        <nav
          aria-label="내 계정 관리"
          className="mt-5 divide-y divide-[var(--color-academy-line)] rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]"
        >
          <Link
            href="/account/children"
            className="flex min-h-14 items-center justify-between gap-3 px-4 text-sm font-bold"
          >
            <span>자녀·가족 연결</span>
            <span className="material-symbols-outlined" aria-hidden="true">
              chevron_right
            </span>
          </Link>
          {account.appUserRole === "PARENT" && (
            <Link
              href="/mypage/login-methods"
              className="flex min-h-14 items-center justify-between gap-3 px-4 text-sm font-bold"
            >
              <span>간편로그인 연결</span>
              <span className="material-symbols-outlined" aria-hidden="true">
                chevron_right
              </span>
            </Link>
          )}
        </nav>
        {/* 근접성(M-01): 되돌릴 수 없는 «회원 탈퇴»는 묶음 밖 구분선 아래 별도 칸·위험색 글자 */}
        <div className="mt-6 border-t border-[var(--color-academy-line)] pt-4">
          <Link
            href="/account/withdraw"
            className="flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 text-sm font-bold text-[var(--color-academy-danger)]"
          >
            <span>회원 탈퇴</span>
            <span className="material-symbols-outlined" aria-hidden="true">
              chevron_right
            </span>
          </Link>
        </div>
        <p className="mt-4 text-xs leading-5 text-[var(--color-academy-muted)]">
          계정 관리는 로그인한 본인에게만 적용됩니다. 수업·운행 중에는 기록을
          저장한 뒤 이동해 주세요.
        </p>
      </section>
    </OwnAccountFrame>
  );
}
