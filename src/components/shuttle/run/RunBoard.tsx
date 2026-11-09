"use client";

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { tmapNavigationCoordinateUrl } from "@/lib/maps/coordinate-links";
import styles from "../DriverWorkspace.module.css";
import { groupRunBlocks, type RunBlock } from "@/lib/shuttle/runBlocks";
import type { UnifiedRider, UnifiedRow } from "@/lib/shuttle/unifiedDriverRunLogic";

// 운행표 카드 목록 부품(레고 블록 하나) — 정류장 1곳 = 카드 1장.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 따로 떼는가?
//   기사님 화면과 관리자 운행표(다음 단계)가 **같은 카드 모양·같은 순서**를 그려야 한다.
//   카드 틀(번호·정류장 이름·정차 시각·묶음 라벨·순서 손잡이)은 여기 한 곳에 두고,
//   탑승 체크 버튼처럼 화면마다 다른 부분은 바깥에서 끼워 넣는다(renderRider · renderStopMeta).
//
// ⚠️ 1단계 = 기사님 화면 리팩터. 기사님 화면(UnifiedDriverClient)에서 옮겨 온 마크업은 글자 그대로다.
//    정렬·편집 상태(순서 덮어쓰기·시각 덮어쓰기·끌기)는 바깥(UnifiedDriverClient)이 들고, 여기는 그리기만 한다.
//
// 2026-11-09 원장 점검(2차):
//   · 묶음 머리 — 같은 수업·같은 방향 카드를 블록으로 묶고 «16:00~17:00 수업 · 등원» 머리를 단다(기사님·관리자 공통).
//     카드 순서는 그대로다(runBlocks.groupRunBlocks 가 이어지는 같은 묶음만 자른다).
//   · 관리자 편집 카드 = 한 줄(손잡이·순번·정류장·시각·학생·정류장 수정·▲▼) — PC 공간 낭비 줄이기.
//   · 관리자 끌기 피드백 — 끄는 카드가 손가락/마우스를 따라 떠다니고(그림자), 제자리는 흐린 자리표시,
//     놓일 자리에 삽입선, 놓으면 짧게 미끄러지는 이동 애니메이션. 기사님 끌기(카드 전체)는 예전 그대로.

export type RunBoardMode = "driver" | "admin";

/** 끄는 동안 떠다니는 카드(관리자 손잡이 끌기 전용). top 은 손가락을 따라 ref 로 직접 바꾼다. */
type Ghost = { row: UnifiedRow; left: number; width: number; top: number };

export default function RunBoard({
  rows, mode, editing, dragKey, onDragKeyChange, onDropOn, onMove, displayTime, onTimeChange, upcoming, renderStopMeta, renderRider, focusKey,
  selectedGroupKey, onSelectBlock,
}: {
  /** 이미 화면 순서로 정렬된 카드 목록(정렬은 바깥이 한다 — 편집 중 덮어쓰기 포함). */
  rows: UnifiedRow[];
  /** driver = 기사님(길안내·다가오는 정차 강조). admin = 관리자 운행표(다음 단계에서 편집 손잡이를 끼운다). */
  mode: RunBoardMode;
  /** 순서·시각 편집 중인가(정규 카드에만 손잡이가 붙는다). */
  editing: boolean;
  /** 끌고 있는 카드 키(없으면 null). */
  dragKey: string | null;
  onDragKeyChange: (key: string | null) => void;
  /** 끌던 카드를 이 카드 자리로 옮긴다. */
  onDropOn: (target: UnifiedRow) => void;
  /** ▲(-1)/▼(1) 한 칸 옮기기. */
  onMove: (row: UnifiedRow, dir: -1 | 1) => void;
  /** 화면에 보일 정차 시각(편집 중 덮어쓰기 반영). */
  displayTime: (row: UnifiedRow) => string | null;
  onTimeChange: (row: UnifiedRow, value: string) => void;
  /** 다가오는 정차(기사님 휴대폰 시계 기준). 없으면 강조하지 않는다. */
  upcoming?: { nextKey: string | null; remainingMinutes: number | null };
  /** 카드 머리 보조 정보 줄에 끼워 넣을 것(기사님 = 체크 개수·결석 N명). 묶음 라벨 뒤, 무료 거점 앞에 놓인다. */
  renderStopMeta?: (row: UnifiedRow) => ReactNode;
  /** 학생 한 명 줄(기사님 = 탑승/미탑승 버튼). 반환 요소에 key 를 달아야 한다. */
  renderRider: (row: UnifiedRow, rider: UnifiedRider) => ReactNode;
  /**
   * 바로 보여 줄 카드(알림 «노선 확인하기» → 바뀐 등원/하원 묶음). 그 카드에만 id="run-focus" 를 달아
   * 바깥 화면이 그 자리로 스크롤한다. 없으면 아무것도 달지 않는다(평소 화면 HTML 그대로).
   */
  focusKey?: string | null;
  /** (관리자) 지도에 보이는 묶음 — 그 블록에 강조 테두리. */
  selectedGroupKey?: string | null;
  /** (관리자) 블록 머리를 누르면 그 묶음을 지도에 띄운다. 없으면 머리는 글자만(기사님). */
  onSelectBlock?: (groupKey: string) => void;
}) {
  // 카드를 손가락으로 눌러 끌기 시작 — 정규 카드·편집 중에만. 버튼·입력칸·링크를 누른 건 끌기가 아니다.
  function startCardDrag(event: PointerEvent, row: UnifiedRow) {
    if (!editing || row.kind !== "REGULAR" || row.isTerminal) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button,input,a")) return;
    onDragKeyChange(row.key);
  }

  // ── 관리자 끌기(손잡이 ⠿ 전용) ──
  // 왜 기사님과 다르게? 휴대폰에서 손가락으로 끌면 브라우저가 «누른 요소»에 포인터를 붙잡아 두어
  // 다른 카드의 onPointerEnter 가 오지 않는다. 그래서 손가락 위치와 카드 위치(getBoundingClientRect)를 직접 비교한다.
  // 카드 전체가 아니라 손잡이만 끌기용(touch-none)이라, 카드 위에서는 화면 스크롤이 그대로 된다.
  // 끄는 동안에는 순서를 바꾸지 않고(카드가 흔들리지 않게) «놓일 자리 삽입선»만 보여 주고, 놓을 때 한 번 옮긴다.
  // 기사님 화면(mode="driver")은 아래 원래 방식 그대로 — 이 손잡이 코드를 쓰지 않는다.
  const listRef = useRef<HTMLDivElement>(null);
  // 가장자리 자동 스크롤 — 손가락이 멈춰 있어도 계속 내려가게 requestAnimationFrame 으로 돈다.
  // 마지막 손가락 위치·끌던 카드를 ref 에 두고, 매 프레임 삽입 자리를 다시 계산한다(스크롤로 카드 위치가 바뀌므로).
  const pointerAt = useRef<{ x: number; y: number; row: UnifiedRow } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  // 매 프레임에서 최신 rows·onDropOn 을 쓰도록 ref 로 들고 있는다(옛 클로저 방지).
  const latest = useRef({ rows, onDropOn, onMove });
  latest.current = { rows, onDropOn, onMove };
  // 삽입 자리 = 같은 묶음 카드 사이 «틈» 번호(0 = 첫 카드 위, n = 마지막 카드 아래). null 이면 표시 안 함.
  const gapRef = useRef<number | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  // 누른 점이 카드 위쪽에서 몇 px 아래였는지 — 떠다니는 카드가 손가락에 «붙어» 따라오게.
  const ghostOffset = useRef<number | null>(null);

  // 같은 묶음(끌기가 허용되는 범위) 카드 요소들 — 화면 순서대로.
  function groupCards(groupKey: string): HTMLElement[] {
    const all = listRef.current?.querySelectorAll<HTMLElement>("[data-run-group]") ?? [];
    return [...all].filter((el) => el.dataset.runGroup === groupKey);
  }
  function placeUnderFinger() {
    const at = pointerAt.current;
    if (!at) return;
    // 떠다니는 카드를 손가락 높이로(다시 그리지 않고 바로 옮긴다 — 부드럽게).
    if (ghostRef.current) ghostRef.current.style.top = `${at.y - (ghostOffset.current ?? 0)}px`;
    // 손가락이 어느 카드의 위쪽 절반 위에 있으면 그 카드 «앞» 틈, 모두 지나면 맨 뒤 틈.
    const cards = groupCards(at.row.groupKey);
    let next = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (at.y < r.top + r.height / 2) { next = i; break; }
    }
    // 제자리(자기 바로 위·아래 틈)면 옮길 게 없으니 선을 숨긴다.
    const from = cards.findIndex((el) => el.dataset.runKey === at.row.key);
    const shown = next === from || next === from + 1 ? null : next;
    if (shown !== gapRef.current) { gapRef.current = shown; setGap(shown); }
  }
  function stopAutoScroll() {
    if (scrollFrame.current != null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  }
  function autoScrollStep() {
    const at = pointerAt.current;
    if (!at) { scrollFrame.current = null; return; }
    // 위·아래 70px 안쪽이면 가장자리에 가까울수록 빠르게(최대 프레임당 16px).
    const edge = 70;
    const dy = at.y < edge ? -Math.ceil(((edge - at.y) / edge) * 16) : at.y > window.innerHeight - edge ? Math.ceil(((at.y - (window.innerHeight - edge)) / edge) * 16) : 0;
    if (dy === 0) { scrollFrame.current = null; return; }
    window.scrollBy(0, dy);
    placeUnderFinger();
    scrollFrame.current = requestAnimationFrame(autoScrollStep);
  }
  // 화면을 떠나면(언마운트) 돌던 스크롤을 멈춘다.
  useEffect(() => stopAutoScroll, []);

  // ── 놓은 뒤 «미끄러지는» 이동 애니메이션(FLIP: 옮기기 전 위치를 기억 → 새 위치에서 거꾸로 출발해 제자리로) ──
  const flipFrom = useRef<Map<string, number> | null>(null);
  function rememberPositions() {
    const map = new Map<string, number>();
    for (const el of listRef.current?.querySelectorAll<HTMLElement>("[data-run-key]") ?? []) map.set(el.dataset.runKey!, el.getBoundingClientRect().top);
    flipFrom.current = map;
  }
  useLayoutEffect(() => {
    const before = flipFrom.current;
    if (!before) return;
    flipFrom.current = null;
    // 움직임 줄이기 설정을 켠 사람에게는 애니메이션 없이 바로 옮긴다.
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const el of listRef.current?.querySelectorAll<HTMLElement>("[data-run-key]") ?? []) {
      const old = before.get(el.dataset.runKey!);
      if (old == null) continue;
      const dy = old - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      el.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }, [rows]);
  // ▲▼ 도 같은 애니메이션으로 옮긴다.
  function moveWithAnimation(row: UnifiedRow, dir: -1 | 1) {
    rememberPositions();
    onMove(row, dir);
  }

  function startHandleDrag(event: PointerEvent<HTMLButtonElement>, row: UnifiedRow) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointerAt.current = { x: event.clientX, y: event.clientY, row };
    gapRef.current = null; setGap(null);
    // 떠다니는 카드 = 누른 카드와 같은 폭·같은 높이 자리에서 출발한다.
    const card = event.currentTarget.closest("li")?.getBoundingClientRect();
    if (card) {
      ghostOffset.current = event.clientY - card.top;
      // 오른쪽으로 28px 비켜 띄운다 — 손가락 아래 삽입선의 왼쪽 끝(동그라미)이 가려지지 않게.
      setGhost({ row, left: card.left + 28, width: Math.max(200, card.width - 28), top: card.top });
    }
    onDragKeyChange(row.key);
  }
  function moveHandleDrag(event: PointerEvent<HTMLButtonElement>, row: UnifiedRow) {
    if (dragKey !== row.key || !pointerAt.current) return;
    pointerAt.current = { x: event.clientX, y: event.clientY, row };
    placeUnderFinger();
    // 가장자리에 들어오면 루프 시작(이미 돌고 있으면 그대로).
    if (scrollFrame.current == null) autoScrollStep();
  }
  function endHandleDrag() {
    const at = pointerAt.current;
    pointerAt.current = null;
    stopAutoScroll();
    // 삽입선이 있던 자리로 한 번 옮긴다 — 틈 번호를 «그 자리에 오게 될 카드»로 바꿔 기존 onDropOn 규칙(같은 묶음 안 splice)에 맡긴다.
    const target = gapRef.current;
    if (at && target != null) {
      const same = latest.current.rows.filter((r) => r.groupKey === at.row.groupKey && !r.isTerminal);
      const from = same.findIndex((r) => r.key === at.row.key);
      const to = target > from ? target - 1 : target;
      if (from >= 0 && same[to] && to !== from) { rememberPositions(); latest.current.onDropOn(same[to]); }
    }
    cancelHandleDrag();
  }
  // 끌기 취소(전화 수신·시스템 제스처 등) — 순서는 그대로 두고 떠다니는 카드·삽입선만 지운다.
  function cancelHandleDrag() {
    pointerAt.current = null;
    stopAutoScroll();
    gapRef.current = null; setGap(null);
    ghostOffset.current = null; setGhost(null);
    onDragKeyChange(null);
  }

  // 안내 줄(차고지 출발 등)을 뺀 정차 번호(1, 2, 3 …). 묶음이 나뉘어도 처음부터 이어서 센다(기사님 화면 그대로).
  let seq = 0;
  const blocks = groupRunBlocks(rows);
  // 끄는 카드 묶음의 카드 순번(삽입선을 어느 카드 앞/뒤에 그릴지).
  const dragGroup = ghost?.row.groupKey ?? null;
  let dragGroupIndex = 0;

  function renderRow(row: UnifiedRow) {
    // 차고지 출발·학원 도착 같은 안내 줄 — 얇은 회색 한 줄(탑승 체크 없음).
    if (row.isTerminal) {
      return (
        <li key={row.key} className="flex items-center gap-2 rounded-xl bg-[var(--color-academy-soft)] px-4 py-2.5 text-[15px] font-bold text-[var(--color-academy-ink)]">
          <span className="shrink-0 text-[15px] font-black text-[var(--color-academy-muted)]">{row.time}</span>
          <span className="min-w-0 flex-1">{row.label}</span>
          {row.subLabel && <span className="shrink-0 text-[13px] font-semibold text-[var(--color-academy-faint)]">{row.subLabel}</span>}
        </li>
      );
    }
    seq += 1;
    const isPickup = row.direction === "PICKUP";
    // 길안내(T맵)는 운전하는 기사님 화면에만 둔다.
    const url = mode === "driver" ? tmapNavigationCoordinateUrl({ latitude: row.lat, longitude: row.lng, name: row.label }) : null;
    const editable = editing && row.kind === "REGULAR";
    const isUpcoming = mode === "driver" && !editing && upcoming != null && upcoming.nextKey === row.key;
    // 관리자 편집 카드 = 한 줄(손잡이 · 순번 · 정류장 · 시각 · 학생들 · 정류장 수정 · ▲▼). 좁은 화면에서는 줄바꿈된다.
    if (mode === "admin" && editable) {
      const indexInGroup = row.groupKey === dragGroup ? dragGroupIndex++ : -1;
      const lineBefore = gap != null && indexInGroup === gap;
      const lineAfter = gap != null && indexInGroup >= 0 && gap === indexInGroup + 1 && !rows.some((r, i) => i > rows.indexOf(row) && r.groupKey === row.groupKey && !r.isTerminal);
      const dragging = dragKey === row.key;
      return (
        <li key={row.key} data-run-key={row.key} data-run-group={row.groupKey}
          className={`relative flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border px-2 py-1.5 lg:flex-nowrap ${dragging ? "border-dashed border-[var(--color-academy-line-input)] bg-[var(--color-academy-soft)] opacity-50" : "border-[var(--color-academy-info)] bg-[var(--color-academy-info-soft)]"}`}>
          {/* 놓일 자리 삽입선 — 카드 사이 틈(8px) 한가운데에 굵은 선 */}
          {lineBefore && <span aria-hidden="true" data-drop-line className="pointer-events-none absolute inset-x-0 -top-[6px] h-[4px] rounded-full bg-[var(--color-academy-info)] before:absolute before:-left-1 before:-top-[4px] before:h-3 before:w-3 before:rounded-full before:bg-[var(--color-academy-info)]" />}
          {lineAfter && <span aria-hidden="true" data-drop-line className="pointer-events-none absolute inset-x-0 -bottom-[6px] h-[4px] rounded-full bg-[var(--color-academy-info)] before:absolute before:-left-1 before:-top-[4px] before:h-3 before:w-3 before:rounded-full before:bg-[var(--color-academy-info)]" />}
          <button type="button" aria-label={`${row.label} 끌어서 순서 옮기기`} title="끌어서 순서 옮기기"
            onPointerDown={(event) => startHandleDrag(event, row)}
            onPointerMove={(event) => moveHandleDrag(event, row)}
            onPointerUp={endHandleDrag}
            onPointerCancel={cancelHandleDrag}
            // ⚠️ touch-none 클래스만으로는 안 된다 — academy-theme.css 의 `.academy-app :is(button, a) { touch-action: manipulation }`
            //    (레이어 밖 규칙)이 Tailwind 유틸리티를 이겨, 휴대폰에서 손가락을 움직이면 브라우저가 끌기를 취소(pointercancel)했다.
            //    인라인 style 은 그 규칙보다 우선한다.
            style={{ touchAction: "none" }}
            className="grid h-11 w-11 shrink-0 touch-none cursor-grab place-items-center rounded-lg border border-[var(--color-academy-line-input)] bg-white text-[var(--color-academy-muted)] active:cursor-grabbing">
            <span aria-hidden="true" className="material-symbols-outlined text-[24px]">drag_indicator</span>
          </button>
          <span className={`${styles.sequence} shrink-0`}>{seq}</span>
          <span className="min-w-0 flex-1 text-[15px] font-black leading-tight text-[var(--color-academy-ink)] lg:w-36 lg:flex-none">{row.label}</span>
          {/* 시각 칸 — «오후 03:40» 이 잘리지 않는 폭(글자 16px·숫자 고정폭). 24시간/12시간 표기는 기기 설정을 따른다. */}
          <input
            type="time"
            value={displayTime(row) ?? ""}
            onChange={(event) => onTimeChange(row, event.target.value)}
            className="h-11 w-[8.75rem] shrink-0 rounded-lg border-2 border-[var(--color-academy-line-input)] bg-white px-1.5 text-[15px] font-black tabular-nums text-[var(--color-academy-ink)]"
            aria-label={`${row.label} 정차 시간`}
          />
          {/* 학생 이름들 — 한 줄에 칩으로(넘치면 칸 안에서 줄바꿈) */}
          <div className="flex min-w-0 basis-full flex-wrap items-center gap-1 lg:basis-auto lg:flex-1">
            {row.riders.map((rider) => renderRider(row, rider))}
          </div>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {renderStopMeta?.(row)}
            <button type="button" onClick={() => moveWithAnimation(row, -1)} aria-label={`${row.label} 순서 위로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] bg-white text-[15px] font-black text-[var(--color-academy-muted)]">▲</button>
            <button type="button" onClick={() => moveWithAnimation(row, 1)} aria-label={`${row.label} 순서 아래로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] bg-white text-[15px] font-black text-[var(--color-academy-muted)]">▼</button>
          </span>
        </li>
      );
    }
    return (
      <li
        key={row.key}
        draggable={editable}
        onDragStart={() => editable && onDragKeyChange(row.key)}
        onDragOver={(event) => {
          if (editable) event.preventDefault();
        }}
        onDrop={() => editable && onDropOn(row)}
        onDragEnd={() => onDragKeyChange(null)}
        onPointerDown={(event) => startCardDrag(event, row)}
        onPointerEnter={() => editable && dragKey && onDropOn(row)}
        onPointerUp={() => onDragKeyChange(null)}
        onPointerCancel={() => onDragKeyChange(null)}
        id={focusKey && focusKey === row.key ? "run-focus" : undefined}
        data-upcoming={isUpcoming || undefined}
        aria-current={isUpcoming ? "step" : undefined}
        className={`${styles.stop} ${isUpcoming ? styles.upcoming : ""} academy-driver-stop rounded-2xl border p-3 ${editable ? "touch-none cursor-grab active:cursor-grabbing" : ""} ${dragKey === row.key ? "opacity-60" : ""} ${
        editing ? "border-[var(--color-academy-info)] bg-[var(--color-academy-info-soft)]" : row.warn ? "border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)]" : row.isHub ? "border-[var(--color-academy-success)] bg-[var(--color-academy-success-soft)]" : "border-[var(--color-academy-line)] bg-white"
      }`}>
        <div className={styles.stopHeading}>
          {editable ? (
            <div className="flex shrink-0 flex-col gap-0.5" aria-label="순서 변경">
              <button type="button" onClick={() => onMove(row, -1)}
                aria-label={`${row.label} 순서 위로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] text-[16px] font-black text-[var(--color-academy-muted)]">▲</button>
              <button type="button" onClick={() => onMove(row, 1)}
                aria-label={`${row.label} 순서 아래로`} className="h-11 w-11 rounded-lg border border-[var(--color-academy-line-input)] text-[16px] font-black text-[var(--color-academy-muted)]">▼</button>
            </div>
          ) : (
            <span className={styles.sequence}>
              {seq}
            </span>
          )}
          <div className={`${styles.stopName} ${row.label.length > 18 ? styles.longStopName : ""} ${/\s/.test(row.label) ? styles.spacedStopName : ""}`}><span>{row.label}</span></div>
          {editable ? (
            <input
              type="time"
              value={displayTime(row) ?? ""}
              onChange={(event) => onTimeChange(row, event.target.value)}
              className="col-span-3 mt-2 h-12 w-full min-w-0 rounded-xl border-2 border-[var(--color-academy-line-input)] bg-white px-3 text-[22px] font-black text-[var(--color-academy-ink)]"
              aria-label={`${row.label} 정차 시간`}
            />
          ) : (
            <div className={styles.timeNavigation}>
              <span className={displayTime(row) ? styles.time : styles.unknownTime}>{displayTime(row) ?? "시간 미정"}</span>
              {url && (
                <a href={url} className={styles.navigation}>
                  <span aria-hidden="true" className="material-symbols-outlined text-[17px]">near_me</span> 길안내
                </a>
              )}
            </div>
          )}
          <div className={styles.stopMeta}>
            <span className="font-bold text-[var(--color-academy-ink)]">{row.kind === "SEASONAL" ? "특강" : "정규"} · {isPickup ? "등원" : "하원"}</span>
            {row.groupLabel && <span>{row.groupLabel}</span>}
            {row.subLabel && row.subLabel !== row.groupLabel && <span>{row.subLabel}</span>}
            {renderStopMeta?.(row)}
            {row.isHub && <span className="font-bold text-[var(--color-academy-success)]">무료 거점</span>}
            {row.pending && <span className="font-bold text-[var(--color-academy-warning)]">순서 확인 필요</span>}
            {row.warn && <span className="font-bold text-[var(--color-academy-warning)]">노선 밖 승객 · 정차 확인 필요</span>}
            {isUpcoming && upcoming && <span className={styles.upcomingBadge}>{upcoming.remainingMinutes != null && upcoming.remainingMinutes <= 5 ? upcoming.remainingMinutes === 0 ? "곧 도착 · 예정 시각" : `곧 도착 · ${upcoming.remainingMinutes}분 후` : `다음 정류장 · ${upcoming.remainingMinutes}분 후`}</span>}
          </div>
        </div>

        {row.isHub && row.riders.length === 0 && <p className="mt-1.5 text-[15px] font-bold text-[var(--color-academy-success)]">무료 거점(워크인, 정원 별도)</p>}

        {row.riders.length > 0 && (
          <div className={`${styles.riders} space-y-1`}>
            {row.riders.map((rider) => renderRider(row, rider))}
          </div>
        )}
      </li>
    );
  }

  // 블록 머리 — 아이콘(등원/하원) + «16:00~17:00 수업 · 등원» + 정류장·학생 수·시각 범위.
  // 색이 아니라 글자·아이콘으로 방향을 구분한다(색 규칙). 관리자는 머리를 눌러 그 묶음을 지도에 띄운다.
  function renderBlockHead(block: RunBlock) {
    const stopsInBlock = block.rows.filter((r) => !r.isTerminal);
    const riderCount = new Set(stopsInBlock.flatMap((r) => r.riders.map((x) => x.key))).size;
    const times = stopsInBlock.map((r) => displayTime(r)).filter((t): t is string => Boolean(t));
    const range = times.length > 0 ? (times[0] === times[times.length - 1] ? times[0] : `${times[0]}~${times[times.length - 1]}`) : null;
    const selected = selectedGroupKey != null && selectedGroupKey === block.groupKey;
    const content = (
      <>
        <span aria-hidden="true" className="material-symbols-outlined text-[20px] text-[var(--color-academy-muted)]">{block.direction === "PICKUP" ? "login" : "logout"}</span>
        <span className="text-[16px] font-black text-[var(--color-academy-ink)]">{block.label}{block.continued && <span className="ml-1 text-[13px] font-bold text-[var(--color-academy-muted)]">(이어서)</span>}</span>
        <span className="text-[13px] font-semibold text-[var(--color-academy-muted)]">
          정류장 {stopsInBlock.length}곳 · 학생 {riderCount}명{range ? ` · ${range}` : ""}
        </span>
        {onSelectBlock && <span className={`ml-auto hidden items-center gap-0.5 text-[13px] font-bold lg:inline-flex ${selected ? "text-[var(--color-academy-info)]" : "text-[var(--color-academy-muted)]"}`}>
          <span aria-hidden="true" className="material-symbols-outlined text-[16px]">map</span>{selected ? "지도에 표시 중" : "지도 보기"}
        </span>}
      </>
    );
    return onSelectBlock ? (
      <button type="button" onClick={() => onSelectBlock(block.groupKey)} aria-pressed={selected}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-2 text-left">
        {content}
      </button>
    ) : (
      <h3 className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 px-1">{content}</h3>
    );
  }

  return (
    <div ref={listRef} className="space-y-4">
      {blocks.map((block) => (
        // 블록 = 같은 수업·같은 방향. 머리와 카드를 가깝게(근접성), 블록끼리는 16px 띄운다.
        <section key={block.key} aria-label={block.label} data-run-block={block.groupKey}
          className={`rounded-2xl ${selectedGroupKey != null && selectedGroupKey === block.groupKey ? "bg-[var(--color-academy-info-soft)] p-1.5 ring-2 ring-[var(--color-academy-info)]" : ""}`}>
          {renderBlockHead(block)}
          <ol className={mode === "admin" && editing ? "mt-1 space-y-2" : "mt-1 space-y-2.5"}>
            {block.rows.map(renderRow)}
          </ol>
        </section>
      ))}
      {/* 끄는 동안 손가락/마우스를 따라 떠다니는 카드(그림자·살짝 확대). 누를 수 없고 화면 읽기에서도 숨긴다. */}
      {ghost && (
        <div ref={ghostRef} aria-hidden="true"
          style={{ position: "fixed", left: ghost.left, top: ghost.top, width: ghost.width, zIndex: 60 }}
          className="pointer-events-none flex scale-[1.02] items-center gap-2 rounded-xl border-2 opacity-95 border-[var(--color-academy-info)] bg-[var(--color-academy-surface)] px-2 py-1.5 shadow-2xl">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--color-academy-line-input)] text-[var(--color-academy-muted)]">
            <span className="material-symbols-outlined text-[24px]">drag_indicator</span>
          </span>
          <span className="min-w-0 flex-1 text-[16px] font-black text-[var(--color-academy-ink)]">{ghost.row.label}</span>
          <span className="shrink-0 text-[16px] font-black tabular-nums text-[var(--color-academy-ink)]">{displayTime(ghost.row) ?? "시간 미정"}</span>
          <span className="hidden min-w-0 flex-1 text-[14px] font-bold text-[var(--color-academy-muted)] sm:block">{ghost.row.riders.map((r) => r.name).join(" · ")}</span>
        </div>
      )}
    </div>
  );
}
