"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DRIVER_TOKEN_STORAGE_KEY,
  buildDriverRunPath,
} from "@/lib/shuttle/driverTokenStorage";

/**
 * 기사님 앱의 시작 화면.
 *
 * 홈 화면 아이콘은 토큰이 없는 이 주소를 연다. 마지막에 열었던 운행 링크가
 * 기억돼 있으면 곧바로 그 화면으로 넘긴다. 없으면 무엇을 해야 하는지 알려준다.
 */
export default function DriverHomeClient() {
  const router = useRouter();
  // 기억된 링크가 있으면 곧바로 넘어가므로, 그 사이에 안내문이 번쩍이지 않게 한다.
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(DRIVER_TOKEN_STORAGE_KEY);
    } catch {
      stored = null;
    }
    const path = buildDriverRunPath(stored);
    if (path) {
      // replace 를 쓰는 이유: 뒤로가기를 누르면 다시 이 화면으로 와 무한 왕복이 된다.
      router.replace(path);
      return;
    }
    setChecking(false);
  }, [router]);

  // 기사님 화면은 밝은 차 안에서 본다. 다른 운행 화면과 같이 밝은 테마로 고정한다.
  return (
    <div className="min-h-screen bg-white text-gray-900" style={{ colorScheme: "light" }}>
      <div className="mx-auto grid min-h-[80dvh] max-w-md place-items-center px-6 text-center">
        {checking ? (
          <p className="text-base text-gray-500" aria-live="polite">
            운행 명단을 여는 중...
          </p>
        ) : (
          <div>
            <p className="text-5xl" aria-hidden="true">
              🚌
            </p>
            <h1 className="mt-3 text-xl font-black text-gray-900">
              받으신 운행 링크를 한 번 열어주세요
            </h1>
            <p className="mt-2 text-base leading-7 text-gray-500">
              원장님께 받은 링크를 한 번만 열면, 다음부터는 이 아이콘만 눌러도
              그날 운행이 바로 열립니다.
            </p>
            {/* 링크를 받지 못했거나 잃어버린 기사님 — 원장님이 기사님 역할을 준 계정이 있으면 로그인만으로 연다. */}
            <a
              href={`/login?${new URLSearchParams({ redirect: "/staff/run" }).toString()}`}
              className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl border border-gray-300 px-5 text-base font-bold text-gray-700"
            >
              학원 계정으로 로그인해서 열기
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
