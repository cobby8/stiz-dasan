"use client";

import { useEffect, useState } from "react";

const EMPTY = new URLSearchParams();

/**
 * 주소의 ?쿼리 를 «화면이 뜬 뒤»에 읽는다(2026-11-18 속도 조치).
 *
 * next/navigation 의 useSearchParams 를 미리 만들어 두는(정적) 화면에서 쓰면, 그 부품 아래가 통째로
 * «브라우저에서만 그리기»로 밀린다 — 서버가 보내는 화면이 비어 있고, 스크립트를 다 받아 실행한 뒤에야 내용이 나온다
 * (로그인 화면이 휴대폰에서 약 4초 동안 빈 화면이었다).
 * 이 훅은 처음엔 빈 값을 돌려주고(서버 그림과 같음) 뜬 직후 실제 주소 값으로 바꾼다.
 * 쿼리가 «첫 그림»을 바꾸지 않는 화면(링크 주소·안내 문구만 달라지는 화면)에서만 쓴다.
 */
export function useMountedSearchParams(): URLSearchParams {
    const [params, setParams] = useState<URLSearchParams>(EMPTY);
    useEffect(() => {
        setParams(new URLSearchParams(window.location.search));
    }, []);
    return params;
}
