"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { isStoreApp } from "@/lib/storeApp";
import { DRIVER_APP_RUN_PATH, driverEntryTarget, shouldShowIosDriverNotice } from "@/lib/staff-session-rules";

// 기사님 첫 화면의 화면 쪽 판정 — 아이폰 스토어 앱이면 안내, 아니면 다른 화면으로 넘긴다.
// startRun = 셔틀 명단의 «운행 시작»을 눌러 왔나. 맞으면 운행 화면(위치 전송 가능)으로, 아니면(로그인 직후 등) 셔틀 명단으로(2026-11-18 원장 결정 F).
export default function DriverEntryClient({ canTeach, startRun = false }: { canTeach: boolean; startRun?: boolean }) {
  const router = useRouter();
  // null = 아직 판정 전(스토어 앱 표식은 브라우저에서만 읽을 수 있다)
  const [iosNotice, setIosNotice] = useState<boolean | null>(null);

  useEffect(() => {
    const show = shouldShowIosDriverNotice(isStoreApp(), navigator.userAgent);
    if (show) {
      setIosNotice(true);
      return;
    }
    // 뒤로 가기로 이 중간 화면에 다시 머물지 않게 replace 로 넘긴다.
    // 안드로이드 앱은 위치 공유가 켜지는 운행 링크 화면으로(로그인만으로 운행 시작, 2026-11-16), 브라우저는 기존 운행표로.
    // 로그인 직후처럼 «그냥» 들어왔으면 셔틀 명단이 첫 화면이다 — 운행 화면엔 아래 메뉴·이름 메뉴가 없다
    const target = driverEntryTarget(startRun, isStoreApp(), navigator.userAgent);
    // 앱 길은 «페이지 통째 이동» — 앱은 지금 화면 주소(/driver/열쇠)에서 운행 열쇠를 읽으므로 서버 이동까지 확실히 반영되게 한다.
    if (target === DRIVER_APP_RUN_PATH) window.location.replace(target);
    else router.replace(target);
  }, [router, startRun]);

  if (!iosNotice) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10 text-center" aria-busy="true">
        <p className="text-sm text-[var(--color-academy-muted)]">{startRun ? "운행 화면을 여는 중…" : "셔틀 명단을 여는 중…"}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <section role="status" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-5 text-center">
        <h1 className="text-lg font-bold text-[var(--color-academy-ink)]">아이폰 앱의 운행 기능은 다음 업데이트에 열립니다</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">
          문자로 받은 운행 링크를 이용해 주세요. 링크를 열면 승하차 체크와 위치 전송을 그대로 쓸 수 있습니다.
        </p>
        {canTeach && (
          <Link href="/staff" className="academy-button-secondary mt-4">
            수업 화면으로
          </Link>
        )}
      </section>
    </main>
  );
}
