import Link from "next/link";

/** 자녀 연결 여부와 관계없이 계정 관리로 돌아갈 수 있는 공통 경로. */
export default function AccountLinks() {
  return (
    <nav aria-label="계정 관리" className="mt-6 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-academy-line)] pt-3 text-xs text-[var(--color-academy-muted)]">
      <Link className="inline-flex min-h-11 items-center hover:underline" href="/account">내 계정</Link>
      <Link className="inline-flex min-h-11 items-center hover:underline" href="/mypage/children">자녀·가족 연결</Link>
      <Link className="inline-flex min-h-11 items-center hover:underline" href="/mypage/login-methods">간편로그인 연결</Link>
      <Link className="inline-flex min-h-11 items-center hover:underline" href="/mypage/roles">역할 추가 신청</Link>
      <Link className="inline-flex min-h-11 items-center hover:underline" href="/mypage/withdraw">회원 탈퇴</Link>
    </nav>
  );
}
