"use client";

import { useState } from "react";

// ★ 라이트 모드 고정(기사님 화면 정책)

type RequestType = "REMOVE" | "LOCATION" | "ORDER" | "OTHER";

const TYPE_META: Record<RequestType, { label: string; desc: string }> = {
  REMOVE:   { label: "학생 제외",   desc: "이 학생을 오늘 명단에서 빼주세요" },
  LOCATION: { label: "주소 변경",   desc: "위치가 달라요, 수정 부탁드려요" },
  ORDER:    { label: "순서 고정",   desc: "지금 순서로 저장해주세요" },
  OTHER:    { label: "기타",        desc: "아래에 내용을 입력해주세요" },
};

export default function DriverRequestModal({
  token, serviceDate, targetId, targetName,
  defaultType, orderPayload,
  onClose, onSent,
}: {
  token: string;
  serviceDate: string;
  targetId?: string;
  targetName?: string;
  defaultType?: RequestType;
  orderPayload?: unknown;   // ORDER 타입일 때 새 순서 배열
  onClose: () => void;
  onSent?: () => void;
}) {
  const [type, setType] = useState<RequestType>(defaultType ?? "OTHER");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await fetch("/api/driver/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token, serviceDate, type, targetId, targetName,
          note: note.trim() || undefined,
          payload: type === "ORDER" ? orderPayload : undefined,
        }),
      });
      setDone(true);
      onSent?.();
      setTimeout(onClose, 1200);
    } catch {
      setBusy(false);
    }
  }

  return (
    /* 반투명 오버레이 — position:fixed 금지이므로 min-h 래퍼로 페이크 뷰포트 구현 */
    <div style={{ minHeight: 360, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={onClose}>
      <div className="w-full max-w-lg rounded-t-2xl bg-white p-5 pb-8"
        onClick={(e) => e.stopPropagation()}>

        {done ? (
          <p className="py-6 text-center text-lg font-semibold text-[var(--color-academy-success)]">요청이 전송되었습니다</p>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <p className="text-lg font-semibold text-[var(--color-academy-ink)]">
                관리자에게 요청{targetName ? ` — ${targetName}` : ""}
              </p>
              <button type="button" onClick={onClose} aria-label="닫기" className="grid h-11 w-11 place-items-center text-xl text-[var(--color-academy-muted)]">✕</button>
            </div>

            {/* 요청 종류 선택 */}
            <div className="mb-4 grid grid-cols-2 gap-2">
              {(Object.keys(TYPE_META) as RequestType[]).map((t) => (
                <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}
                  className={`rounded-xl border-2 py-3 text-[15px] font-medium transition-colors ${
                    type === t
                      ? "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)]"
                      : "border-[var(--color-academy-line)] text-[var(--color-academy-muted)]"
                  }`}>
                  {TYPE_META[t].label}
                  <span className="mt-0.5 block text-xs font-normal text-[var(--color-academy-muted)]">{TYPE_META[t].desc}</span>
                </button>
              ))}
            </div>

            {/* 메모 */}
            <textarea
              value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="추가로 전달할 내용을 입력해주세요 (선택)"
              className="mb-4 w-full rounded-xl border-2 border-[var(--color-academy-line)] p-3 text-[15px] text-[var(--color-academy-ink)] placeholder:text-[var(--color-academy-faint)] focus:border-[var(--color-academy-primary)] focus:outline-none"
              rows={3}
            />

            <button type="button" disabled={busy} onClick={submit}
              className="h-14 w-full rounded-2xl bg-[var(--color-academy-primary)] text-[17px] font-medium text-white disabled:opacity-60 active:bg-[var(--color-academy-primary-hover)]">
              {busy ? "전송 중…" : "요청 보내기"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
