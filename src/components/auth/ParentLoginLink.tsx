"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { parentAuthEntryHref } from "@/lib/auth-entry-navigation";

export default function ParentLoginLink() {
  const search = useSearchParams();
  return <Link href={parentAuthEntryHref("login", search)} className="font-bold text-brand-orange-500">로그인</Link>;
}
