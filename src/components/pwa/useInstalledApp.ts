"use client";

import { useEffect, useState } from "react";
import { isStoreApp } from "@/lib/storeApp";

type NavigatorWithStandalone = Navigator & { standalone?: boolean };

/**
 * 설치된 앱(홈 화면 아이콘)으로 열렸는지.
 *
 * 서버에서는 알 수 없다. 첫 그림은 항상 "브라우저"로 그린 뒤 확인해서 바꾼다.
 * 반대로 하면 브라우저에서 잠깐 링크가 사라졌다 나타난다.
 *
 * 왜 필요한가: 설치된 앱이 제 범위(manifest scope)를 벗어나면 주소표시줄이 뜨면서
 * 브라우저로 새어 나가고 돌아올 길이 없다. 브라우저로 들어온 사람에게는 같은
 * 링크가 정상적으로 필요하므로, 지우지 않고 앱에서만 막는다.
 */
export function useInstalledApp() {
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // 스토어 앱(통합 앱)은 사이트 전체가 앱 영역이라 「영역 밖으로 새는」 문제가 없다.
    // 그래서 설치된 앱이어도 영역 제한을 걸지 않는다(=false). 표식은 sessionStorage 라
    // 같은 휴대폰의 크롬·기존 설치 앱에는 번지지 않는다(@/lib/storeApp 설명 참고).
    if (isStoreApp()) {
      setInstalled(false);
      return;
    }
    setInstalled(
      window.matchMedia("(display-mode: standalone)").matches ||
        (window.navigator as NavigatorWithStandalone).standalone === true,
    );
  }, []);

  return installed;
}
