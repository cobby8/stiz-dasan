"use client";

import { useSyncExternalStore } from "react";
import { isStoreApp } from "@/lib/storeApp";

// 스토어 앱(구글플레이·앱스토어 통합 앱)으로 열렸는지 — 화면용 훅(2026-11-13 원장 결정 a1).
//
// 왜 필요한가: 앱 안에서 카카오·구글·네이버·Apple 간편로그인을 누르면 앱 밖 브라우저로 나갔다가
// 로그인 결과가 앱으로 돌아오지 않는다. 앱에서는 간편로그인 버튼을 숨기고 아이디·비밀번호로 안내한다.
//
// 반환값: null = 아직 모름(서버 그림·첫 하이드레이션), true = 스토어 앱, false = 브라우저.
// useSyncExternalStore 를 쓰는 이유 — 서버 그림(null)과 첫 하이드레이션 값을 같게 맞춰 불일치 경고가 없고,
// 화면 이동(클라이언트 전환)으로 들어오면 처음부터 실제 값으로 그려 버튼이 «보였다 사라지는» 깜빡임이 없다.
// 표식은 sessionStorage 라 실행 중 바뀌지 않는다 → 구독할 것이 없다.

function subscribe() {
  return () => undefined;
}

export function useStoreApp(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, isStoreApp, () => null);
}

/** 앱에서 간편로그인 대신 보이는 한 줄 안내 */
export const STORE_APP_PASSWORD_LOGIN_NOTICE = "앱에서는 아이디·비밀번호로 로그인해 주세요.";
