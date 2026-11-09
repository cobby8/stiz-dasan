// 셔틀 「기존 정류장 추천」 — 장소명 일치 우선 규칙 한 곳(순수 함수, DB·next 의존 0).
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가(2026-11-09 원장 승인):
//   추천이 좌표 거리만 봐서 틀린 정류장을 골랐다. 학부모 장소명은 «다산e편한세상자이아파트 후문»인데
//   좌표는 아파트 대표 주소(단지 한가운데)라, «다산이편한세상자이 정문» 88m 가 «… 후문» 169m 보다 가까워 정문이 추천됐다.
//   → 장소명에 출입구 단어(정문·후문…)가 있으면, 반경 안에서 «같은 단지 + 같은 출입구» 정류장을 거리와 상관없이 1순위로.
//     없으면 예전처럼 가장 가까운 곳.
// 쓰는 곳 — 관리자 학생 추가 추천(regularRosterPlacementLogic.suggestPlacement ②),
//   기사님 새 학생 배정·관리자 정규 배차 신규 배차 칸(driverAssignLogic.planLeg 후보 추천).
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다. 이 파일은 아무것도 import 하지 않는다.

/** 이름 일치를 인정하는 반경(미터) — 합류 반경(JOIN_RADIUS_METERS)과 같은 300m. 밖이면 같은 이름이어도 다른 곳으로 본다. */
export const NAME_MATCH_RADIUS_METERS = 300;

/**
 * 출입구 단어 — 긴 것부터(«버스정류장»이 «정류장»보다 먼저 잡히게).
 * 장소명에 이 단어가 있으면 «어느 문 앞에서 타는지»를 학부모가 직접 적은 것이다.
 */
export const GATE_WORDS = ["맘스테이션", "버스정류장", "정류장", "정문", "후문", "남문", "북문", "동문", "서문", "쪽문"] as const;

/**
 * 비교용 이름 — 공백 제거·소문자, 표기 통일(e편한/이편한), 꼬리말(아파트·단지·apt) 제거.
 * 예: «다산e편한세상자이아파트 후문» → «다산이편한세상자이후문».
 */
export function normalizePlaceName(v: string | null | undefined): string {
  return (v ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/e-?편한/g, "이편한") // e편한세상 = 이편한세상
    .replace(/아파트|apt|단지/g, "") // 같은 단지인데 붙였다 뺐다 하는 꼬리말
    .replace(/[()[\]·.,_\-]/g, ""); // 괄호·구분 기호
}

/** 출입구 단어 뒤에 붙어도 되는 말(없어도 됨). */
const GATE_TAIL = /^(앞|쪽|입구|출입구|근처|방향|옆|건너편|맞은편)?$/;

/** 이름을 «단지(앞부분)» + «출입구 단어»로 나눈다. 출입구 단어가 없으면 gate = null. */
export function splitGate(v: string | null | undefined): { base: string; gate: string | null } {
  const n = normalizePlaceName(v);
  for (const g of GATE_WORDS) {
    const at = n.lastIndexOf(g);
    // 출입구 단어 앞에 단지 이름이 있어야 한다(«정문»만 적은 건 어느 단지인지 몰라 이름 일치로 쓰지 않는다).
    if (at <= 0) continue;
    // 출입구 단어는 끝에 오거나 «앞·쪽» 같은 짧은 말만 뒤따라야 한다 — «다산동문화센터»의 «동문»을 출입구로 잘못 읽지 않게.
    if (!GATE_TAIL.test(n.slice(at + g.length))) continue;
    return { base: n.slice(0, at), gate: g };
  }
  return { base: n, gate: null };
}

/** 앞부분(단지) 이름이 같은 단지로 볼 만큼 비슷한가 — 한쪽이 다른 쪽을 품거나, 앞 4글자 이상이 같으면. */
export function sameComplex(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 2;
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k >= 4;
}

export type StopCandidate = { label: string; distanceMeters: number | null };

export type StopPick = {
  /** 후보 배열 안 자리. */
  index: number;
  by: "NAME" | "NEAREST";
  distanceMeters: number;
  /** 화면에 짧게 보여 줄 추천 이유 — «이름 일치: 후문» / «가장 가까움 88m». */
  reason: string;
};

/**
 * 반경 안 기존 정류장 중 추천 하나 — ① 이름 일치(출입구 단어까지 같은 단지 정류장, 가까운 것) ② 가장 가까운 곳.
 * 반경 안 후보가 없거나(거리 모름 포함) 후보가 비면 null.
 */
export function pickNearbyStop(placeName: string | null | undefined, cands: readonly StopCandidate[], radiusMeters: number = NAME_MATCH_RADIUS_METERS): StopPick | null {
  const inRange = cands
    .map((c, index) => ({ index, label: c.label, d: c.distanceMeters }))
    .filter((c): c is { index: number; label: string; d: number } => c.d != null && Number.isFinite(c.d) && c.d >= 0 && c.d <= radiusMeters);
  if (inRange.length === 0) return null;
  const closest = <T extends { d: number }>(list: T[]): T => list.reduce((a, b) => (b.d < a.d - 1e-6 ? b : a));

  // ① 이름 일치 — 장소명에 출입구 단어가 있을 때만.
  const want = splitGate(placeName);
  if (want.gate) {
    const named = inRange.filter((c) => {
      const s = splitGate(c.label);
      return s.gate === want.gate && sameComplex(s.base, want.base);
    });
    if (named.length > 0) {
      const c = closest(named);
      return { index: c.index, by: "NAME", distanceMeters: c.d, reason: `이름 일치: ${want.gate}` };
    }
  }

  // ② 가장 가까운 곳(예전 규칙).
  const c = closest(inRange);
  return { index: c.index, by: "NEAREST", distanceMeters: c.d, reason: `가장 가까움 ${Math.round(c.d)}m` };
}
