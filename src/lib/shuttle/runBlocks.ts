// 운행표 «묶음(블록)» 나누기 — 순수 함수(prisma·React 의존성 금지, 브라우저·테스트 공용).
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가? (2026-11-09 원장 점검)
//   카드가 시각순 한 줄로만 이어져 «16시 수업 등원»이 어디서 끝나고 «16시 수업 하원»이 어디서 시작하는지
//   구분이 안 됐다. 같은 수업·같은 방향(= 같은 groupKey, 순서 편집 단위와 같다) 카드를 한 블록으로 묶어
//   블록마다 머리(«16:00~17:00 수업 · 등원»)를 단다.
//
// ⚠️ 순서는 절대 바꾸지 않는다 — 들어온 순서(이미 시각순 정렬된 목록) 그대로 «이어지는 같은 묶음»만 자른다.
//    다른 묶음 카드가 시각상 중간에 끼면 블록이 둘로 나뉘고 뒤 블록에 «이어서»가 붙는다(기사님 운행 순서 보존).

import type { UnifiedRow } from "./unifiedDriverRunLogic";

export type RunBlock = {
  /** React key — groupKey + 몇 번째 조각인지(같은 묶음이 끊겼다 이어질 수 있다). */
  key: string;
  groupKey: string;
  direction: UnifiedRow["direction"];
  kind: UnifiedRow["kind"];
  /** 블록 머리 글자(예: «16:00~17:00 수업 · 등원», «특강 · 하원 · 1호차»). */
  label: string;
  /** 같은 묶음의 두 번째 이후 조각이면 true(머리에 «이어서»). */
  continued: boolean;
  rows: UnifiedRow[];
};

/** 머리 글자 — 앞의 그림문자(🕒·🚐)를 떼고, 방향(등원/하원)이 없으면 붙인다. */
export function runBlockLabel(row: Pick<UnifiedRow, "kind" | "direction" | "groupLabel">): string {
  const dir = row.direction === "PICKUP" ? "등원" : "하원";
  // 그림문자·공백 같은 «글자 아닌 것»으로 시작하면 떼어 낸다(Material 아이콘을 따로 붙인다).
  const base = (row.groupLabel ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (row.kind === "SEASONAL") return base ? `특강 · ${dir} · ${base}` : `특강 · ${dir}`;
  if (!base) return `정규 · ${dir}`;
  return base.includes(dir) ? base : `${base} · ${dir}`;
}

/** 이미 정렬된 카드 목록을 «이어지는 같은 묶음» 단위로 자른다(안내 줄도 자기 묶음에 들어간다). */
export function groupRunBlocks(rows: readonly UnifiedRow[]): RunBlock[] {
  const blocks: RunBlock[] = [];
  const seen = new Map<string, number>(); // groupKey → 지금까지 나온 조각 수
  for (const row of rows) {
    const last = blocks[blocks.length - 1];
    if (last && last.groupKey === row.groupKey) { last.rows.push(row); continue; }
    const n = seen.get(row.groupKey) ?? 0;
    seen.set(row.groupKey, n + 1);
    blocks.push({
      key: `${row.groupKey}#${n}`,
      groupKey: row.groupKey,
      direction: row.direction,
      kind: row.kind,
      label: runBlockLabel(row),
      continued: n > 0,
      rows: [row],
    });
  }
  return blocks;
}

/** 관리자 편집용: 시각 미정 정차를 같은 수업·방향의 마지막 블록에 붙인다. */
export function placeUntimedRegularStops(
  rows: readonly UnifiedRow[],
  hasTime: (row: UnifiedRow) => boolean,
): UnifiedRow[] {
  const lastTimedStop = new Map<string, UnifiedRow>();
  const untimedStops = new Map<string, UnifiedRow[]>();
  for (const row of rows) {
    if (row.kind !== "REGULAR" || row.isTerminal) continue;
    if (hasTime(row)) {
      lastTimedStop.set(row.groupKey, row);
    } else {
      const group = untimedStops.get(row.groupKey) ?? [];
      group.push(row);
      untimedStops.set(row.groupKey, group);
    }
  }
  return rows.flatMap((row) => {
    const anchor = lastTimedStop.get(row.groupKey);
    if (row === anchor) return [row, ...(untimedStops.get(row.groupKey) ?? [])];
    if (anchor && row.kind === "REGULAR" && !row.isTerminal && !hasTime(row)) return [];
    return [row];
  });
}
