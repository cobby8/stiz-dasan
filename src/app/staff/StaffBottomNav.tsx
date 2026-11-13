"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isStoreApp } from "@/lib/storeApp";
import { DRIVER_ENTRY_PATH, shouldShowIosDriverNotice } from "@/lib/staff-session-rules";

const teachingItems = [
  { href: "/staff", label: "수업", exact: true },
  { href: "/staff/students", label: "학생", exact: false },
  { href: "/staff/billing", label: "청구", exact: false },
] as const;

const SHUTTLE_HREF = "/staff/shuttle";
// 셔틀 탭은 셔틀 화면·운행 화면(/staff/run)·기사님 첫 화면(/staff/driver) 어디서든 켜져 보인다.
const SHUTTLE_PATHS = [SHUTTLE_HREF, "/staff/run", DRIVER_ENTRY_PATH];
const seasonalItem = { href: "/staff/seasonal", label: "특강", exact: false } as const;

// 역할 하나가 아니라 «수업 메뉴·셔틀 메뉴를 각각 쓸 수 있는가»로 받는다.
// 역할 하나로 가르면 「선생님 + 기사님」이 셔틀 탭을 못 보거나 수업 탭을 못 본다(다중 역할, 2026-10-25).
//   기사님만 → 셔틀 / 선생님만 → 수업·학생·청구·특강 / 관리자·선생님+기사님 → 둘 다
export default function StaffBottomNav({ canTeach, canShuttle }: { canTeach: boolean; canShuttle: boolean }) {
  const pathname = usePathname();
  // 아이폰 스토어 앱은 지금 셔틀 화면으로 가는 길을 앱이 막는다(앱 다음 업데이트에서 열림, 2026-11-13 b7).
  // 그 경우 셔틀 탭은 «다음 업데이트에 열립니다» 안내 화면으로 보낸다(탭을 눌러도 아무 일 없는 것처럼 보이지 않게).
  const [shuttleHref, setShuttleHref] = useState(SHUTTLE_HREF);
  useEffect(() => {
    if (shouldShowIosDriverNotice(isStoreApp(), navigator.userAgent)) setShuttleHref(DRIVER_ENTRY_PATH);
  }, []);

  // 수업 진행 화면은 종료 버튼 등 수업 조작에 집중할 수 있도록 메뉴를 숨깁니다.
  if (pathname.startsWith("/staff/sessions/")) return null;

  const shuttleItem = { href: shuttleHref, label: "셔틀", exact: false } as const;
  const items = [
    ...(canTeach ? [...teachingItems, seasonalItem] : []),
    ...(canShuttle ? [shuttleItem] : []),
  ];
  const gridClass = items.length >= 5 ? "grid-cols-5" : items.length === 4 ? "grid-cols-4" : items.length === 1 ? "grid-cols-1" : "grid-cols-3";
  const isActive = (item: (typeof items)[number]) => {
    if (item === shuttleItem) return SHUTTLE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
    return item.exact ? pathname === item.href : pathname.startsWith(item.href);
  };

  // 공통 표면을 사용하되 현재 메뉴의 접근성·이동 규칙은 유지합니다.
  return <nav aria-label="교사용 주요 메뉴" className="academy-staff-nav fixed inset-x-0 bottom-0 z-30 border-t px-3 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur-xl">
    <div className={`mx-auto grid max-w-lg ${gridClass} gap-2`}>{items.map((item) => {
      const active = isActive(item);
      // 2026-11-13 UI 통일: 아이콘 없이 글자만. 지금 있는 탭 = 보조 색(하늘색) 글자 + 위쪽 띠 + 조금 굵게. 누르는 높이(56px)는 그대로.
      return <Link key={item.label} href={item.href} aria-current={active ? "page" : undefined} className={`flex min-h-14 items-center justify-center border-t-2 text-sm transition-colors ${active ? "border-[var(--color-academy-secondary-strong)] font-semibold text-[var(--color-academy-secondary-ink)]" : "border-transparent font-medium text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"}`}>{item.label}<span className="sr-only">{active ? "현재 메뉴" : "메뉴로 이동"}</span></Link>;
    })}</div>
  </nav>;
}
