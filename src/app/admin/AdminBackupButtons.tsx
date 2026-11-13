"use client";
import { adminMessageText } from "@/components/admin/adminDisplayText";

import { useRef, useState } from "react";

// 행 모양(2026-11-13 UI 통일): 이모지 없이 글자만, 옆 메뉴와 같은 44px 행.
const ROW_IDLE = "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]";
// 복원은 지금 설정을 덮어쓰는 위험 작업 — 글자를 위험색으로 구분한다(확인 창은 그대로)
const ROW_DANGER = "text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]";

// sheetRetired: 구글 시트 원장 은퇴(2026-10~) 면 「시트 동기화」 버튼을 숨긴다(설정 백업·복원 버튼은 그대로).
export default function AdminBackupButtons({ sheetRetired = false }: { sheetRetired?: boolean } = {}) {
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [ok, setOk] = useState(true);
    const backupInFlight = useRef(false);

    function show(text: string, isOk: boolean) {
        setMsg(text);
        setOk(isOk);
    }

    async function handleRestore(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!confirm(`"${file.name}" 파일로 복원하시겠습니까?`)) {
            e.target.value = "";
            return;
        }

        setBusy(true);
        setMsg(null);

        try {
            // 보관용 업무 자료(archive)는 복원하지 않으므로 보내지 않는다 — 요청이 커져 서버 상한(4.5MB)에 걸리지 않게.
            const { archive: _archive, ...json } = JSON.parse(await file.text());
            void _archive;
            const res = await fetch("/api/admin/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(json),
            });
            const data = await res.json();
            data.success ? show("복원 완료", true) : show(adminMessageText(data.error, "복원하지 못했습니다. 백업 파일을 확인해 주세요."), false);
        } catch {
            show("백업 파일을 읽지 못했습니다.", false);
        } finally {
            setBusy(false);
            e.target.value = "";
        }
    }

    async function handleCloudRestore() {
        if (!confirm("가장 최근 자동 백업으로 복원하시겠습니까?")) return;

        setBusy(true);
        setMsg(null);

        try {
            const listRes = await fetch("/api/admin/cloud-backups");
            const { files } = await listRes.json();

            if (!files?.length) {
                show("클라우드 백업 없음", false);
                return;
            }

            const res = await fetch("/api/admin/cloud-backups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: files[0].filename }),
            });
            const data = await res.json();
            data.success
                ? show(`복원 완료 (${files[0].filename.slice(12, 27)})`, true)
                : show(adminMessageText(data.error, "복원하지 못했습니다. 잠시 후 다시 시도해 주세요."), false);
        } catch {
            show("복원 실패", false);
        } finally {
            setBusy(false);
        }
    }

    async function handleBackupNow() {
        if (backupInFlight.current || !confirm("학원 설정과 학생·수강·출결·청구·결제 등 업무 자료 전체를 클라우드에 백업하시겠습니까? 복원은 설정만 되고, 업무 자료는 보관용입니다.")) return;

        backupInFlight.current = true;
        setBusy(true);
        setMsg(null);

        try {
            const res = await fetch("/api/admin/backup-now", { method: "POST" });
            const data = await res.json();
            if (res.ok && data.success === true) {
                // 업무 자료가 몇 개 표·몇 줄 담겼는지 같이 보여 준다(정말 들어갔는지 원장이 바로 확인).
                const archive = data.archive ? ` · 업무 자료 표 ${data.archive.tables}개 ${Number(data.archive.rows).toLocaleString("ko-KR")}줄` : "";
                show(`백업 저장 완료 (${data.filename}${archive})`, true);
            } else if (data.backupSaved === true && data.stage === "ARCHIVE_INCOMPLETE") {
                // 업무 자료 파일 자체를 못 올린 경우와, 일부 표만 빠진 경우를 구분해 알린다.
                show(data.archive?.saved !== true
                    ? `설정은 저장됐지만 업무 자료 파일을 저장하지 못했습니다. 잠시 후 다시 저장해 주세요. 파일: ${data.filename}`
                    : `설정은 저장됐지만 업무 자료 일부(표 ${data.archive?.failedTables?.length ?? 0}개)를 담지 못했습니다. 잠시 후 다시 저장해 주세요. 파일: ${data.filename}`, false);
            } else if (data.backupSaved === true) {
                show(`백업은 저장됐지만 과거 파일 정리는 완료하지 못했습니다. 재저장하지 말고 확인해 주세요. 파일: ${data.filename}`, false);
            } else if (data.backupSaved === null) {
                show(`저장 여부 확인 필요. 다시 저장하기 전에 후보 파일을 확인해 주세요: ${data.filename}`, false);
            } else {
                show("백업을 완료하지 못했습니다. 권한과 백업 상태를 확인해 주세요.", false);
            }
        } catch {
            show("백업 응답을 확인하지 못했습니다. 저장됐을 수 있으니 다시 저장하기 전에 클라우드 백업을 확인해 주세요.", false);
        } finally {
            backupInFlight.current = false;
            setBusy(false);
        }
    }

    // 최신 업무 자료 파일(stiz-archive-*.json.gz) 내려받기 — 서버가 원장 권한을 확인하고 1분짜리 주소를 준다.
    async function handleArchiveDownload() {
        setBusy(true);
        setMsg(null);
        try {
            const listRes = await fetch("/api/admin/cloud-backups");
            const { archives } = await listRes.json();
            if (!archives?.length) {
                show("업무 자료 백업 파일이 아직 없습니다.", false);
                return;
            }
            const res = await fetch(`/api/admin/cloud-backups?archive=${encodeURIComponent(archives[0].filename)}`);
            const data = await res.json();
            if (!res.ok || !data.url) {
                show(adminMessageText(data.error, "업무 자료 파일을 준비하지 못했습니다."), false);
                return;
            }
            window.location.href = data.url;
            show(`업무 자료 내려받기 시작 (${archives[0].filename}) · 압축(.gz) 파일입니다`, true);
        } catch {
            show("업무 자료 파일을 준비하지 못했습니다.", false);
        } finally {
            setBusy(false);
        }
    }

    async function handleSyncSchedule() {
        setBusy(true);
        setMsg(null);

        try {
            const res = await fetch("/api/admin/sync-schedule", { method: "POST" });
            const data = await res.json();
            data.success
                ? show(`시트 동기화 완료 (수업 ${data.synced}개)`, true)
                : show(adminMessageText(data.error, "시트에서 시간표를 가져오지 못했습니다."), false);
        } catch {
            show("시트에서 시간표를 가져오지 못했습니다.", false);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-1 px-4 py-2">
            {!sheetRetired && (
            <button
                type="button"
                onClick={handleSyncSchedule}
                disabled={busy}
                className={`flex w-full min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-sm text-left transition-colors ${
                    busy ? "opacity-50" : ROW_IDLE
                }`}
            >
                <span>시트 동기화</span>
            </button>
            )}
            <a
                href="/api/admin/backup"
                className={`flex w-full min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-sm transition-colors ${ROW_IDLE}`}
            >
                <span>설정 백업 다운로드</span>
            </a>
            <button
                type="button"
                onClick={handleArchiveDownload}
                disabled={busy}
                className={`flex w-full min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-sm text-left transition-colors ${
                    busy ? "opacity-50" : ROW_IDLE
                }`}
            >
                <span>업무 자료 백업 내려받기</span>
            </button>
            <label
                className={`flex w-full cursor-pointer min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-sm transition-colors ${
                    busy ? "opacity-50" : ROW_DANGER
                }`}
            >
                <span>{busy ? "처리 중..." : "파일로 복원"}</span>
                <input type="file" accept=".json" className="hidden" onChange={handleRestore} disabled={busy} />
            </label>
            <button
                type="button"
                onClick={handleCloudRestore}
                disabled={busy}
                className={`flex w-full min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-sm text-left transition-colors ${
                    busy ? "opacity-50" : ROW_DANGER
                }`}
            >
                <span>최신 자동백업 복원</span>
            </button>
            <button
                type="button"
                onClick={handleBackupNow}
                disabled={busy}
                className={`flex w-full min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-sm text-left transition-colors ${
                    busy ? "opacity-50" : ROW_IDLE
                }`}
            >
                <span>전체 백업 지금 저장</span>
            </button>
            <a
                href="/api/admin/export-seed"
                download="seed-data.ts"
                className={`flex w-full min-h-11 items-center gap-3 rounded-lg px-4 py-2 text-sm transition-colors ${ROW_IDLE}`}
            >
                <span>seed 내보내기</span>
            </a>
            <p className="px-4 text-xs text-[var(--color-academy-faint)]">설정 + 학생·출결·청구·결제 등 업무 자료(별도 압축 파일) 백업 · 복원은 설정만(업무 자료는 보관용)</p>
            {msg && <p role="status" className={`break-all px-4 py-1 text-xs ${ok ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-warning)]"}`}>{msg}</p>}
        </div>
    );
}
