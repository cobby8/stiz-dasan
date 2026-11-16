"use client";

// 관리자 대시보드 «오늘 수업 처리 현황»(2026-11-17) — 예전 «오늘의 수업»(시간표 게시판) 자리.
// 오늘 열리는 반마다 «시작 전 · 미시작 · 진행 중 · 종료 지연 · 완료 · 출결만 입력 · 휴강»을 한 줄로 보인다.
//
// - 자료를 props 로 받지 않고 스스로 /api/admin/class-day-board 를 읽는다(대시보드 첫 화면 조회에 얹지 않고, 60초마다 스스로 새로 읽기 위해).
// - 상태 판정은 서버가 순수 규칙(lib/class-nudge/rules)으로 해서 보낸다. 여기서는 글자·색만 고른다.
// - 아이콘 없이 글자, 색은 토큰만. 색만으로 뜻을 전하지 않게 상태 글자가 항상 같이 나간다.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { clearClassDayCancel, setClassDayCancel } from "@/app/actions/class-day-cancel";
import { askConfirm, showNotice } from "@/components/ui/feedback";
import type { ClassDayBoard, ClassDayBoardRow } from "@/lib/class-nudge/board";
import {
    cancelConfirmMessage,
    classDayStatusText,
    classDayTone,
    isClassDayOpen,
    type ClassDayTone,
} from "@/lib/class-nudge/rules";

const BOARD_URL = "/api/admin/class-day-board";
/** 탭이 보일 때만 이 간격으로 다시 읽는다 */
const REFRESH_MS = 60_000;

// 상태색 — 미처리 빨강 · 주의 노랑 · 진행 중 하늘색(«지금 있는 곳» 보조 색) · 완료 초록 · 그 밖 회색
const TONE_CLASS: Record<ClassDayTone, string> = {
    danger: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]",
    warning: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
    progress: "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)]",
    success: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
    neutral: "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]",
};

function timeText(row: ClassDayBoardRow): string {
    if (!row.startTime) return "시간 미정";
    return row.endTime ? `${row.startTime}–${row.endTime}` : row.startTime;
}

function assigneeText(row: ClassDayBoardRow): string {
    if (row.assignees.length === 0) return "담당 미지정";
    return row.assignees
        .map((a) => `${a.substitute ? "대타 " : ""}${a.name}${a.linked ? "" : "(앱 미연결)"}`)
        .join(" · ");
}

/** 시작 시각이 지났지만 아직 유예 안인 줄은 «미시작» 대신 덜 센 말로 */
function statusText(row: ClassDayBoardRow): string {
    if (row.status.state === "NOT_STARTED" && !isClassDayOpen(row.status)) return "시작 시각 지남";
    return classDayStatusText(row.status, row.rosterCount);
}

/** «휴강» 버튼을 보일 줄 — 아직 아무 출결도 없는 시작 전·미시작·시간 미정 수업만(서버도 같은 조건으로 다시 확인한다) */
function canMarkCancel(row: ClassDayBoardRow): boolean {
    const state = row.status.state;
    if (state !== "UPCOMING" && state !== "NOT_STARTED" && state !== "TIME_UNKNOWN") return false;
    return row.status.unmarkedCount >= row.rosterCount;
}

function summaryParts(board: ClassDayBoard): Array<{ label: string; count: number; danger: boolean }> {
    const s = board.summary;
    return [
        { label: "미처리", count: s.open, danger: true },
        { label: "진행 중", count: s.inProgress, danger: false },
        { label: "완료", count: s.done, danger: false },
        { label: "시작 전", count: s.upcoming, danger: false },
    ].filter((part) => part.count > 0); // 0 인 항목은 뺀다
}

export default function ClassDayBoardCard() {
    const [board, setBoard] = useState<ClassDayBoard | null>(null);
    const [failed, setFailed] = useState(false);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    // 늦게 온 응답이 새 응답을 덮지 않게 요청 번호를 센다
    const requestRef = useRef(0);

    const load = useCallback(async () => {
        const request = ++requestRef.current;
        try {
            // no-store: «지금 시각» 기준 판정이라 받아 둔 응답을 다시 쓰지 않는다
            const res = await fetch(BOARD_URL, { cache: "no-store" });
            if (!res.ok) throw new Error("class day board request failed");
            const next = (await res.json()) as ClassDayBoard;
            if (request !== requestRef.current) return;
            setBoard(next);
            setFailed(false);
        } catch {
            if (request !== requestRef.current) return;
            // 직전 자료는 그대로 두고 실패만 알린다
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        void load();
        // 탭이 보일 때만 60초마다, 다른 탭에서 돌아오면 바로 한 번
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") void load();
        }, REFRESH_MS);
        const onVisible = () => {
            if (document.visibilityState === "visible") void load();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [load]);

    const toggleCancel = useCallback(async (row: ClassDayBoardRow, dateYmd: string, mark: boolean) => {
        const question = mark
            ? cancelConfirmMessage(row.name)
            : `${row.name} 휴강 표시를 취소할까요?\n다시 미처리 확인 대상이 돼요.`;
        if (!(await askConfirm(question, { tone: "primary" }))) return;
        setBusyKey(row.key);
        try {
            const target = { date: dateYmd, classId: row.classId, kind: row.kind, startTime: row.kind === "SEASONAL" ? row.startTime ?? "" : "" };
            const result = mark ? await setClassDayCancel(target) : await clearClassDayCancel(target);
            if (!result.ok) await showNotice(result.message);
        } catch {
            await showNotice("저장하지 못했습니다. 잠시 후 다시 눌러 주세요.");
        } finally {
            setBusyKey(null);
            void load();
        }
    }, [load]);

    const parts = board ? summaryParts(board) : [];

    return (
        <section className="academy-panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--color-academy-line)] px-4 py-3">
                <h2 className="academy-section-title">오늘 수업 처리 현황</h2>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-academy-muted)]">
                    {parts.map((part) => (
                        <span key={part.label} className={part.danger ? "font-medium text-[var(--color-academy-danger)]" : ""}>
                            {part.label} <span className="tabular-nums">{part.count}</span>
                        </span>
                    ))}
                    {board && <span>{board.todayLabel}</span>}
                </p>
            </div>

            {!board && !failed && (
                <div className="space-y-2 px-4 py-3 animate-pulse" role="status" aria-label="수업 현황 불러오는 중">
                    {[0, 1, 2].map((item) => (
                        <div key={item} className="h-8 rounded bg-[var(--color-academy-soft)]" />
                    ))}
                </div>
            )}

            {!board && failed && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <p className="text-sm text-[var(--color-academy-muted)]">수업 현황을 불러오지 못했습니다.</p>
                    <button type="button" onClick={() => void load()} className="academy-button-secondary academy-button-sm">다시 불러오기</button>
                </div>
            )}

            {board && (
                <>
                    {failed && <p className="px-4 pt-2 text-xs text-[var(--color-academy-warning)]">방금 새로고침 실패 — 직전 내용을 보이고 있어요.</p>}
                    {!board.holidayKnown && (
                        <p className="px-4 pt-2 text-xs text-[var(--color-academy-muted)]">연간일정을 읽지 못해 휴무 판정 없이 표시합니다.</p>
                    )}
                    {board.holiday && (
                        <p className="px-4 py-3 text-sm text-[var(--color-academy-muted)]">오늘은 휴무입니다({board.holiday.title}).</p>
                    )}
                    {!board.holiday && board.rows.length === 0 && (
                        <p className="px-4 py-3 text-sm text-[var(--color-academy-muted)]">오늘은 수업이 없습니다.</p>
                    )}
                    {board.rows.length > 0 && (
                        <ul className="divide-y divide-[var(--color-academy-line)]">
                            {board.rows.map((row) => {
                                const busy = busyKey === row.key;
                                return (
                                    <li key={row.key} className="flex min-h-12 flex-wrap items-center gap-x-2 px-4">
                                        {/* 줄 = 출결 화면 링크. «휴강» 버튼은 링크 밖에 둔다(버튼을 눌러도 화면이 넘어가지 않게) */}
                                        <Link
                                            href={row.href}
                                            prefetch={false}
                                            className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5 py-1 transition hover:bg-[var(--color-academy-soft)]"
                                        >
                                            <span className="shrink-0 text-sm tabular-nums text-[var(--color-academy-muted)]">{timeText(row)}</span>
                                            <span className="min-w-0 break-words text-sm text-[var(--color-academy-ink)]">{row.name}</span>
                                            {row.kind === "SEASONAL" && (
                                                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${TONE_CLASS.neutral}`}>특강</span>
                                            )}
                                            <span className="min-w-0 break-words text-xs text-[var(--color-academy-muted)]">{assigneeText(row)}</span>
                                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[classDayTone(row.status)]}`}>
                                                {statusText(row)}
                                            </span>
                                            <span className="shrink-0 text-xs tabular-nums text-[var(--color-academy-muted)]">
                                                {row.capacity !== null ? `${row.rosterCount}/${row.capacity}명` : `${row.rosterCount}명`}
                                            </span>
                                        </Link>
                                        {row.status.state === "CANCELLED" ? (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void toggleCancel(row, board.dateYmd, false)}
                                                className="academy-button-secondary academy-button-sm shrink-0"
                                            >
                                                {busy ? "저장 중" : "휴강 취소"}
                                            </button>
                                        ) : canMarkCancel(row) ? (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void toggleCancel(row, board.dateYmd, true)}
                                                className="academy-button-secondary academy-button-sm shrink-0"
                                            >
                                                {busy ? "저장 중" : "휴강"}
                                            </button>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}
        </section>
    );
}
