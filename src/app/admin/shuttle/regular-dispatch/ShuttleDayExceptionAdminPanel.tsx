"use client";

import { useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { kstLabel } from "@/lib/datetime/kst";
import { PARENT_CHANGE_CUTOFF_TEXT } from "@/lib/parent/changeDeadline";
import {
  SHUTTLE_DIRECTIONS,
  SHUTTLE_DIRECTION_LABEL,
  SHUTTLE_EXCEPTION_KINDS,
  SHUTTLE_EXCEPTION_KIND_LABEL,
  type ShuttleDirection,
  type ShuttleExceptionKind,
} from "@/lib/shuttle/dayExceptionRules";
import type { AdminShuttleExceptionBoard, AdminShuttleExceptionRow, AdminShuttleStudent } from "@/lib/shuttle/admin-shuttle-exception";
import {
  cancelShuttleExceptionByAdminAction,
  loadShuttleExceptionBoardAction,
  searchShuttleExceptionStudentsAction,
  submitShuttleExceptionByAdminAction,
} from "@/app/actions/shuttle-exception-admin";

// 관리자 «셔틀 당일 변경» — «당일 변경» 버튼 + 창(들어온 변경 목록: 학부모 입력분 + 학원 입력분, «당일 변경 입력»)(2026-11-15 원장 요청).
// 학부모는 수업 시작 1시간 전이 지나면 사이트에서 못 바꾼다. 그 뒤 전화로 온 요청을 원장·부원장이 여기서 대신 넣는다.
// 저장·취소는 서버 액션이 requireAdmin 으로 다시 확인한다 — 이 화면은 입력만 받는다.
// 화면 규칙: 글자만(아이콘 없음) · 한 줄 행 · 입력은 버튼 하나 + 모달 · 터치 44px · 색은 학원 테마 변수.
//
// 2026-11-17 원장 지시 「칸을 너무 많이 차지한다 — 기사 요청 옆에 버튼 하나로」:
//   이 부품은 이제 «당일 변경» 버튼 하나 + 누르면 뜨는 목록 창을 스스로 그린다.
//   운행표 머리줄(RegularRunEditor 의 headerExtra 자리 — «실시간 위치» 버튼 바로 뒤 — «기사 요청» 버튼은 2026-11-18 없앴다)에 놓인다.
//   창은 한 번에 하나만 띄운다: 입력 창·취소 확인 창이 떠 있는 동안에는 목록 창을 그리지 않고(listOpen 은 그대로),
//   그 창이 닫히면 목록 창이 다시 뜬다. AdminModal 은 창마다 Esc·스크롤 잠금·포커스를 따로 관리해서, 겹쳐 띄우면
//   Esc 한 번에 둘 다 닫히거나 «브라우저 뒤로» 때 스크롤 잠금이 남을 수 있다 — 겹치지 않으면 그런 일이 없다.
//   목록 창이 다시 뜰 때 AdminModal 이 첫 버튼에 포커스를 잡아 주므로, 줄이 사라져도 포커스가 창 밖으로 빠지지 않는다.

export default function ShuttleDayExceptionAdminPanel({ initial }: { initial: AdminShuttleExceptionBoard }) {
  const [board, setBoard] = useState(initial);
  const [pending, startTransition] = useTransition();
  // 목록 창(버튼을 누르면 열린다)
  const [listOpen, setListOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  // 입력 창
  const [formOpen, setFormOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<AdminShuttleStudent[] | null>(null);
  const [student, setStudent] = useState<AdminShuttleStudent | null>(null);
  const [serviceDate, setServiceDate] = useState(initial.today);
  const [direction, setDirection] = useState<ShuttleDirection>("PICKUP");
  const [kind, setKind] = useState<ShuttleExceptionKind>("SKIP");
  const [location, setLocation] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  // 취소 확인 창의 대상
  const [cancelTarget, setCancelTarget] = useState<AdminShuttleExceptionRow | null>(null);
  const [cancelError, setCancelError] = useState("");

  // 버튼 배지와 창 안 건수가 같은 값을 본다 — 저장·취소 뒤 reload 하면 둘이 함께 바뀐다
  const count = board.rows.length;

  // 저장·취소 뒤 목록을 서버에서 다시 읽는다(다른 관리자·학부모가 그 사이 넣은 것도 함께)
  async function reload() {
    const result = await loadShuttleExceptionBoardAction();
    if (result.ok) setBoard(result.board);
  }

  function openList() {
    setMessage(""); setError("");
    setListOpen(true);
  }

  function closeList() {
    setListOpen(false);
  }
  // 창은 한 번에 하나만 — 입력 창·취소 확인 창이 떠 있는 동안 목록 창은 잠시 그리지 않는다(닫히면 다시 뜬다)
  const showList = listOpen && !formOpen && !cancelTarget;

  function openForm() {
    setQuery(""); setFound(null); setStudent(null);
    setServiceDate(board.today); setDirection("PICKUP"); setKind("SKIP"); setLocation(""); setNote("");
    setFormError(""); setMessage(""); setError("");
    setFormOpen(true);
  }

  function search() {
    const q = query.trim();
    if (!q) return;
    setFormError("");
    startTransition(async () => {
      const result = await searchShuttleExceptionStudentsAction(q);
      if (!result.ok) { setFormError(result.message); return; }
      setFound(result.students);
    });
  }

  function save() {
    if (!student) { setFormError("학생을 선택해 주세요."); return; }
    setFormError("");
    startTransition(async () => {
      const result = await submitShuttleExceptionByAdminAction({
        studentId: student.id,
        serviceDate,
        direction,
        kind,
        location: kind === "LOCATION" ? location : undefined,
        note,
      });
      if (!result.ok) { setFormError(result.message); return; }
      setFormOpen(false);
      setMessage("noOp" in result && result.noOp
        ? `${student.name} 학생 — 같은 내용이 이미 저장돼 있습니다.`
        : `${student.name} 학생 ${kstLabel(serviceDate)} 셔틀 변경을 저장했습니다. 기사님 화면에 표시되고 알림이 나갑니다.`);
      await reload();
    });
  }

  function confirmCancel() {
    if (!cancelTarget) return;
    const target = cancelTarget;
    setCancelError("");
    startTransition(async () => {
      const result = await cancelShuttleExceptionByAdminAction(target.id);
      if (!result.ok) { setCancelError(result.message); await reload(); return; }
      setCancelTarget(null);
      setMessage(`${target.studentName} 학생 ${kstLabel(target.serviceDate)} 셔틀 변경을 취소했습니다.`);
      setError("");
      await reload();
    });
  }

  return (
    <>
      {/* 머리줄 버튼 — «실시간 위치»와 같은 모양. 배지는 위험색(빨강)이 아니라 안내색: «처리할 일»이 아니라 «들어온 알림»이다.
          색만으로 뜻을 전하지 않게 aria-label 에 건수를 글자로 넣는다. 0건이면 배지 없음. */}
      <button type="button" onClick={openList} aria-label={`당일 변경 ${count}건`} className="academy-button-secondary relative">
        당일 변경
        {count > 0 && <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-[var(--color-academy-info)] px-1 text-xs font-semibold tabular-nums text-[var(--color-academy-on-primary)]">{count}</span>}
      </button>

      {/* 목록 창 — 예전에 운행표 위에 있던 칸의 내용 전부. 줄 수 제한 없이 전부 보이고 목록만 세로로 스크롤된다 */}
      {showList && (
        <AdminModal titleId="shuttle-day-exception-title" onClose={closeList} panelClassName="max-w-2xl">
          {/* 창 머리: 제목 · 건수 · «당일 변경 입력» · «닫기» + 안내 한 줄 */}
          <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
            <h2 id="shuttle-day-exception-title" className="academy-section-title">셔틀 당일 변경</h2>
            <span className="mr-auto text-sm tabular-nums text-[var(--color-academy-muted)]">{count}건</span>
            <button type="button" onClick={openForm} className="academy-button-secondary shrink-0">
              당일 변경 입력
            </button>
            <button type="button" onClick={closeList} className="academy-button-text shrink-0">닫기</button>
          </div>
          <p className="break-keep px-4 pb-3 pt-1 text-xs text-[var(--color-academy-muted)]">
            학부모는 수업 시작 {PARENT_CHANGE_CUTOFF_TEXT} 전까지 직접 바꿉니다. 그 뒤 전화로 온 요청은 여기서 넣어 주세요.
          </p>

          {message && <p role="status" className="border-t border-[var(--color-academy-line)] bg-[var(--color-academy-success-soft)] px-4 py-2 text-sm text-[var(--color-academy-success)]">{message}</p>}
          {error && <p role="alert" className="border-t border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] px-4 py-2 text-sm text-[var(--color-academy-danger)]">{error}</p>}

          {count === 0 ? (
            <p className="border-t border-[var(--color-academy-line)] px-4 py-4 text-sm text-[var(--color-academy-muted)]">오늘부터 들어온 당일 변경이 없습니다.</p>
          ) : (
            // min-h-0 + flex-1 + overflow-y-auto: 창 머리는 그대로 두고 목록만 창 안에서 세로 스크롤
            <ul className="min-h-0 flex-1 divide-y divide-[var(--color-academy-line)] overflow-y-auto overscroll-contain border-t border-[var(--color-academy-line)] pb-2">
            {board.rows.map((row) => (
              // 한 줄 행: 날짜 · 학생 · 방향 · 변경(장소) · 누가 넣었나 · 취소
              <li key={row.id} className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5">
                <span className="w-20 shrink-0 text-sm tabular-nums text-[var(--color-academy-ink)]">{kstLabel(row.serviceDate)}</span>
                <span className="shrink-0 text-sm font-semibold text-[var(--color-academy-ink)]">{row.studentName}</span>
                <span className="rounded-full bg-[var(--color-academy-neutral-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-neutral)]">
                  {SHUTTLE_DIRECTION_LABEL[row.direction as ShuttleDirection] ?? row.direction}
                </span>
                <span className="rounded-full bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">
                  {row.kind === "SKIP" ? "안 탐" : "다른 곳에서 탐"}
                </span>
                <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-muted)]">
                  {[row.location, row.note].filter(Boolean).join(" · ")}
                </span>
                <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">{row.byAcademy ? "학원 입력" : "학부모"}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => { setCancelError(""); setCancelTarget(row); }}
                  aria-label={`${row.studentName} ${kstLabel(row.serviceDate)} 셔틀 변경 취소`}
                  className="academy-button-text shrink-0"
                >
                  취소
                </button>
              </li>
            ))}
            </ul>
          )}
        </AdminModal>
      )}

      {/* 입력 창 — 학생 → 날짜 → 방향 → 변경 → 메모 → 저장. 떠 있는 동안 목록 창은 그리지 않는다(닫히면 목록 창이 결과 안내와 함께 다시 뜬다) */}
      {formOpen && (
        <AdminModal titleId="shuttle-day-exception-form-title" onClose={() => { if (!pending) setFormOpen(false); }} busy={pending} panelClassName="max-w-lg p-5" closeOnBackdrop={false}>
          <h3 id="shuttle-day-exception-form-title" className="academy-section-title">셔틀 당일 변경 입력</h3>
          <p className="mt-1 break-keep text-sm text-[var(--color-academy-muted)]">
            수업은 오지만 셔틀만 바꿀 때 씁니다. 마감 시간이 지난 변경도 여기서는 저장됩니다(지난 날짜는 제외).
          </p>

          <div className="mt-3 space-y-4">
            {/* 학생 */}
            <div>
              <label htmlFor="shuttle-day-exception-student" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">학생</label>
              {student ? (
                <div className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg border border-[var(--color-academy-line)] px-3 py-1">
                  <span className="text-sm font-semibold text-[var(--color-academy-ink)]">{student.name}</span>
                  <span className="min-w-0 flex-1 break-keep text-xs text-[var(--color-academy-muted)]">{student.classNames}</span>
                  <button type="button" disabled={pending} onClick={() => setStudent(null)} className="academy-button-text shrink-0">다시 고르기</button>
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input
                      id="shuttle-day-exception-student"
                      data-admin-modal-initial-focus
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); search(); } }}
                      maxLength={30}
                      placeholder="학생 이름"
                      className="academy-input min-w-0 flex-1"
                    />
                    <button type="button" disabled={pending || !query.trim()} onClick={search} className="academy-button-secondary shrink-0">찾기</button>
                  </div>
                  {found && found.length === 0 && <p className="mt-1 text-xs text-[var(--color-academy-muted)]">찾는 학생이 없습니다. 이름을 다시 확인해 주세요.</p>}
                  {found && found.length > 0 && (
                    <ul className="mt-2 divide-y divide-[var(--color-academy-line)] overflow-hidden rounded-lg border border-[var(--color-academy-line)]">
                      {found.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => { setStudent(item); setFormError(""); }}
                            className="flex min-h-11 w-full flex-wrap items-center gap-2 px-3 py-1 text-left hover:bg-[var(--color-academy-soft)]"
                          >
                            <span className="text-sm font-medium text-[var(--color-academy-ink)]">{item.name}</span>
                            <span className="min-w-0 flex-1 break-keep text-xs text-[var(--color-academy-muted)]">{item.classNames}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>

            {/* 날짜 — 오늘부터 14일 */}
            <div>
              <label htmlFor="shuttle-day-exception-date" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">날짜</label>
              <input
                id="shuttle-day-exception-date"
                type="date"
                value={serviceDate}
                min={board.today}
                max={board.maxDate}
                onChange={(event) => setServiceDate(event.target.value)}
                className="academy-input"
              />
            </div>

            {/* 방향 */}
            <div>
              <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">등원·하원</p>
              <div className="grid grid-cols-3 gap-1.5">
                {SHUTTLE_DIRECTIONS.map((value) => (
                  <button key={value} type="button" aria-pressed={direction === value} onClick={() => setDirection(value)} className="academy-choice break-keep px-1!">
                    {SHUTTLE_DIRECTION_LABEL[value]}
                  </button>
                ))}
              </div>
            </div>

            {/* 변경 종류 — 학부모 화면과 같은 선택지 */}
            <div>
              <p className="mb-1 text-xs font-medium text-[var(--color-academy-muted)]">변경</p>
              <div className="grid grid-cols-2 gap-1.5">
                {SHUTTLE_EXCEPTION_KINDS.map((value) => (
                  <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)} className="academy-choice break-keep">
                    {SHUTTLE_EXCEPTION_KIND_LABEL[value]}
                  </button>
                ))}
              </div>
            </div>

            {kind === "LOCATION" && (
              <div>
                <label htmlFor="shuttle-day-exception-location" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">어디에서 타나요?</label>
                <input
                  id="shuttle-day-exception-location"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  maxLength={200}
                  placeholder="예: 다산초 정문 앞"
                  className="academy-input"
                />
              </div>
            )}

            <div>
              <label htmlFor="shuttle-day-exception-note" className="mb-1 block text-xs font-medium text-[var(--color-academy-muted)]">메모 (선택 · 기사님께 보입니다)</label>
              <textarea
                id="shuttle-day-exception-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={300}
                className="academy-input"
              />
            </div>
          </div>

          {formError && <p role="alert" className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm text-[var(--color-academy-danger)]">{formError}</p>}

          <div className="mt-4 flex items-center justify-between gap-2">
            <button type="button" disabled={pending} onClick={() => setFormOpen(false)} className="academy-button-text">닫기</button>
            <button
              type="button"
              disabled={pending || !student || !serviceDate || (kind === "LOCATION" && !location.trim())}
              onClick={save}
              className="academy-button-primary"
            >
              {pending ? "저장하는 중…" : "저장하고 알림 보내기"}
            </button>
          </div>
        </AdminModal>
      )}

      {/* 취소 확인 */}
      {cancelTarget && (
        <AdminConfirmDialog
          titleId="shuttle-day-exception-cancel-title"
          title={`${cancelTarget.studentName} 학생 ${kstLabel(cancelTarget.serviceDate)} 셔틀 변경 취소`}
          description={`${cancelTarget.byAcademy ? "학원에서 넣은" : "학부모가 넣은"} 변경입니다. 취소하면 원래 셔틀대로 타고, 기사님께 취소 알림이 갑니다.`}
          confirmLabel="변경 취소하기"
          onConfirm={confirmCancel}
          onCancel={() => { if (!pending) setCancelTarget(null); }}
          pending={pending}
          error={cancelError}
        />
      )}
    </>
  );
}
