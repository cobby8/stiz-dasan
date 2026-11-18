"use client";

import { useInstalledApp } from "./useInstalledApp";

/**
 * 설치된 앱으로 열렸을 때는 감추고, 브라우저에서는 그대로 보여준다.
 *
 * 공개 홈페이지로 나가는 "길잡이"(전체보기·홈으로 같은 것)에 쓴다.
 * 내용 자체를 감추는 데는 쓰지 말 것 — 그건 기능을 없애는 것이다.
 */
export default function HideInInstalledApp({ children }: { children: React.ReactNode }) {
  const installed = useInstalledApp();
  if (installed) return null;
  return <>{children}</>;
}
