"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";
import { tmapNavigationCoordinateUrl } from "@/lib/maps/coordinate-links";
import styles from "../DriverWorkspace.module.css";
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

export type RunBoardMode = "driver" | "admin";

export default function RunBoard({
  rows, mode, editing, dragKey, onDragKeyChange, onDropOn, onMove, displayTime, onTimeChange, upcoming, renderStopMeta, renderRider, focusKey,
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
  // 다른 카드의 onPointerEnter 가 오지 않는다. 그래서 손가락 아래 카드를 elementFromPoint 로 직접 찾는다.
  // 카드 전체가 아니라 손잡이만 끌기용(touch-none)이라, 카드 위에서는 화면 스크롤이 그대로 된다.
  // 기사님 화면(mode="driver")은 아래 원래 방식 그대로 — 이 손잡이 코드를 쓰지 않는다.
  const lastOverKey = useRef<string | null>(null);
  function startHandleDrag(event: PointerEvent<HTMLButtonElement>, row: UnifiedRow) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    lastOverKey.current = row.key;
    onDragKeyChange(row.key);
  }
  function moveHandleDrag(event: PointerEvent<HTMLButtonElement>, row: UnifiedRow) {
    if (dragKey !== row.key) return;
    // 화면 위·아래 끝 가까이 끌면 조금씩 스크롤(긴 목록에서 멀리 옮길 때).
    if (event.clientY < 70) window.scrollBy(0, -14);
    else if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-run-key]")?.getAttribute("data-run-key") ?? null;
    // 같은 카드 위에서는 한 번만 옮긴다(옮긴 뒤 카드가 흔들리며 왕복하지 않게).
    if (!over || over === lastOverKey.current) return;
    lastOverKey.current = over;
    if (over === row.key) return;
    const target = rows.find((r) => r.key === over);
    if (target) onDropOn(target);
  }
  function endHandleDrag() {
    lastOverKey.current = null;
    onDragKeyChange(null);
  }

  // 안내 줄(차고지 출발 등)을 뺀 정차 번호(1, 2, 3 …).
  let seq = 0;

  return (
    <ol className="space-y-2.5">
      {rows.map((row) => {
        // 차고지 출발·학원 도착 같은 안내 줄 — 얇은 회색 한 줄(탑승 체크 없음).
        if (row.isTerminal) {
          return (
            <li key={row.key} className="flex items-center gap-2 rounded-xl bg-gray-100 px-4 py-2.5 text-[15px] font-bold text-gray-700">
              <span className="shrink-0 text-[15px] font-black text-gray-500">{row.time}</span>
              <span className="min-w-0 flex-1">{row.label}</span>
              {row.subLabel && <span className="shrink-0 text-[13px] font-semibold text-gray-400">{row.subLabel}</span>}
            </li>
          );
        }
        seq += 1;
        const isPickup = row.direction === "PICKUP";
        // 길안내(T맵)는 운전하는 기사님 화면에만 둔다.
        const url = mode === "driver" ? tmapNavigationCoordinateUrl({ latitude: row.lat, longitude: row.lng, name: row.label }) : null;
        const editable = editing && row.kind === "REGULAR";
        const isUpcoming = mode === "driver" && !editing && upcoming != null && upcoming.nextKey === row.key;
        // 관리자 편집 카드 = 손잡이(⠿)로 끌기 · 시각 칸은 이름 옆 한 줄 · ▲▼ 는 보조 줄 끝.
        if (mode === "admin" && editable) {
          return (
            <li key={row.key} data-run-key={row.key}
              className={`${styles.stop} academy-driver-stop rounded-2xl border border-orange-300 bg-orange-50 p-3 ${dragKey === row.key ? "opacity-60 ring-2 ring-[var(--color-academy-primary)]" : ""}`}>
              <div className={styles.stopHeading}>
                <button type="button" aria-label={`${row.label} 끌어서 순서 옮기기`} title="끌어서 순서 옮기기"
                  onPointerDown={(event) => startHandleDrag(event, row)}
                  onPointerMove={(event) => moveHandleDrag(event, row)}
                  onPointerUp={endHandleDrag}
                  onPointerCancel={endHandleDrag}
                  className="grid h-11 w-11 shrink-0 touch-none cursor-grab place-items-center rounded-lg border border-gray-300 bg-white text-gray-500 active:cursor-grabbing">
                  <span aria-hidden="true" className="material-symbols-outlined text-[24px]">drag_indicator</span>
                </button>
                <div className={`${styles.stopName} ${row.label.length > 18 ? styles.longStopName : ""} ${/\s/.test(row.label) ? styles.spacedStopName : ""}`}><span>{row.label}</span></div>
                <input
                  type="time"
                  value={displayTime(row) ?? ""}
                  onChange={(event) => onTimeChange(row, event.target.value)}
                  style={{ flexBasis: "auto" }}
                  className="ml-auto h-11 w-[8.5rem] shrink-0 rounded-xl border-2 border-blue-200 bg-white px-2 text-[19px] font-black text-blue-700"
                  aria-label={`${row.label} 정차 시간`}
                />
                <div className={styles.stopMeta}>
                  <span className="font-bold text-[var(--color-academy-primary)]">정규 · {isPickup ? "등원" : "하원"}</span>
                  {row.groupLabel && <span>{row.groupLabel}</span>}
                  {row.subLabel && row.subLabel !== row.groupLabel && <span>{row.subLabel}</span>}
                  {renderStopMeta?.(row)}
                  <span className="ml-auto flex gap-1">
                    <button type="button" onClick={() => onMove(row, -1)} aria-label={`${row.label} 순서 위로`} className="h-11 w-11 rounded-lg border border-gray-300 bg-white text-[15px] font-black text-gray-600">▲</button>
                    <button type="button" onClick={() => onMove(row, 1)} aria-label={`${row.label} 순서 아래로`} className="h-11 w-11 rounded-lg border border-gray-300 bg-white text-[15px] font-black text-gray-600">▼</button>
                  </span>
                </div>
              </div>
              {row.riders.length > 0 && (
                <div className={`${styles.riders} space-y-1`}>
                  {row.riders.map((rider) => renderRider(row, rider))}
                </div>
              )}
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
            editing ? "border-orange-300 bg-orange-50" : row.warn ? "border-amber-300 bg-amber-50" : row.isHub ? "border-green-300 bg-green-50" : "border-gray-200 bg-white"
          }`}>
            <div className={styles.stopHeading}>
              {editable ? (
                <div className="flex shrink-0 flex-col gap-0.5" aria-label="순서 변경">
                  <button type="button" onClick={() => onMove(row, -1)}
                    aria-label={`${row.label} 순서 위로`} className="h-11 w-11 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600">▲</button>
                  <button type="button" onClick={() => onMove(row, 1)}
                    aria-label={`${row.label} 순서 아래로`} className="h-11 w-11 rounded-lg border border-gray-300 text-[16px] font-black text-gray-600">▼</button>
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
                  className="col-span-3 mt-2 h-12 w-full min-w-0 rounded-xl border-2 border-blue-200 bg-white px-3 text-[22px] font-black text-blue-700"
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
                <span className="font-bold text-[var(--color-academy-primary)]">{row.kind === "SEASONAL" ? "특강" : "정규"} · {isPickup ? "등원" : "하원"}</span>
                {row.groupLabel && <span>{row.groupLabel}</span>}
                {row.subLabel && row.subLabel !== row.groupLabel && <span>{row.subLabel}</span>}
                {renderStopMeta?.(row)}
                {row.isHub && <span className="font-bold text-green-700">무료 거점</span>}
                {row.pending && <span className="font-bold text-amber-700">순서 확인 필요</span>}
                {row.warn && <span className="font-bold text-amber-700">노선 밖 승객 · 정차 확인 필요</span>}
                {isUpcoming && upcoming && <span className={styles.upcomingBadge}>{upcoming.remainingMinutes != null && upcoming.remainingMinutes <= 5 ? upcoming.remainingMinutes === 0 ? "곧 도착 · 예정 시각" : `곧 도착 · ${upcoming.remainingMinutes}분 후` : `다음 정류장 · ${upcoming.remainingMinutes}분 후`}</span>}
              </div>
            </div>

            {row.isHub && row.riders.length === 0 && <p className="mt-1.5 text-[15px] font-bold text-green-700">무료 거점(워크인, 정원 별도)</p>}

            {row.riders.length > 0 && (
              <div className={`${styles.riders} space-y-1`}>
                {row.riders.map((rider) => renderRider(row, rider))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
