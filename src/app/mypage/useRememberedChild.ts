"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { pickChildId, REMEMBERED_CHILD_KEY } from "@/lib/mypage/parentNav";

// 아이 칩 «마지막 선택» 유지 (2026-11-10 원장 점검 — 다른 화면 갔다 뒤로 오면 첫째로 돌아가던 문제).
// 두 곳에 적어 둔다:
//   - 주소 ?child=<id> : 뒤로 가기가 그 주소로 돌아오므로 그 아이가 다시 보인다
//   - 기기 기억(localStorage) : 탭 버튼으로 새로 들어와도 마지막 아이로
// 어떤 값이든 «서버가 준 내 자녀 목록» 안에서만 고른다(pickChildId). 저장 실패(사생활 모드 등)는 조용히 넘긴다.

export function readRememberedChild(): string | null {
  try {
    return window.localStorage.getItem(REMEMBERED_CHILD_KEY);
  } catch {
    return null;
  }
}

export function rememberChild(id: string) {
  try {
    window.localStorage.setItem(REMEMBERED_CHILD_KEY, id);
  } catch {
    // 저장이 막힌 기기 — 주소(?child=)만으로도 뒤로 가기는 유지된다
  }
}

/** 지금 주소의 ?child= 값(없으면 null) */
function urlChild(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("child");
  } catch {
    return null;
  }
}

/** 주소의 ?child= 만 바꾼다(다른 값·#해시는 그대로). 새 기록을 쌓지 않고 지금 칸을 고친다 */
function replaceUrlChild(id: string) {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("child") === id) return;
    url.searchParams.set("child", id);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // 주소를 못 바꿔도 화면 선택은 그대로 쓴다
  }
}

/**
 * 화면 안에서 아이를 바꾸는 화면(홈·수업 탭)용.
 * 처음 그릴 때는 서버 기본값(initialId) → 화면이 뜬 뒤 주소·기기 기억으로 맞춘다.
 */
export function useRememberedChild(childIds: readonly string[], initialId: string): [string, (id: string) => void] {
  const [childId, setChildId] = useState(initialId);
  const idsKey = childIds.join(",");

  useEffect(() => {
    const next = pickChildId(childIds, urlChild(), readRememberedChild(), initialId);
    setChildId(next);
    rememberChild(next);
    // 아이가 둘 이상일 때만 주소에 남긴다(한 명이면 고를 일이 없다)
    if (childIds.length > 1) replaceUrlChild(next);
    // 목록이 바뀔 때만 다시 맞춘다(같은 목록이면 사용자가 고른 값 유지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const select = (id: string) => {
    if (!childIds.includes(id)) return;
    setChildId(id);
    rememberChild(id);
    replaceUrlChild(id);
  };
  return [childId, select];
}

/**
 * 서버가 주소(?child=)로 아이를 고르는 화면(일정 달력)용 — 그리지 않는 부품.
 * 주소에 child 가 없고 기기 기억이 다른 내 자녀면 그 아이 주소로 바꿔 다시 그린다. 있으면 그 값을 기억한다.
 */
export function RememberChildSync({ childIds, selectedId }: { childIds: string[]; selectedId: string }) {
  const router = useRouter();
  const idsKey = childIds.join(",");
  useEffect(() => {
    if (childIds.length < 2) return;
    if (!urlChild()) {
      const stored = readRememberedChild();
      if (stored && stored !== selectedId && childIds.includes(stored)) {
        const url = new URL(window.location.href);
        url.searchParams.set("child", stored);
        router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
        return;
      }
    }
    rememberChild(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, selectedId]);
  return null;
}
