"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { parentAuthEntryHref } from "@/lib/auth-entry-navigation";

/**
 * 가입 화면 아래의 «이미 계정이 있나요?» 줄.
 * 앱 간편로그인에서 넘어온 가입 화면(fromApp=1)은 앱 밖 브라우저 창이다 — 여기서 로그인하면 앱이 아니라 이 창에서
 * 학부모 화면이 열리고 앱은 로그인 안 된 채 남는다(2026-11-17 전수 점검). 그때는 링크 대신 창을 닫으라고 안내한다.
 */
export default function ParentLoginLink() {
  const search = useSearchParams();
  if (search.get("fromApp") === "1") {
    return <span>이 창을 닫고 앱 로그인 화면에서 아이디로 로그인해 주세요.</span>;
  }
  return <>이미 계정이 있나요? <Link href={parentAuthEntryHref("login", search)} className="font-bold text-brand-orange-500">로그인</Link></>;
}
