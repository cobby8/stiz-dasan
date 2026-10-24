"use client";

import { useRef, useState } from "react";

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
            const json = JSON.parse(await file.text());
            const res = await fetch("/api/admin/backup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(json),
            });
            const data = await res.json();
            data.success ? show("복원 완료", true) : show(`오류: ${data.error}`, false);
        } catch {
            show("파일 해석 오류", false);
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
                : show(`오류: ${data.error}`, false);
        } catch {
            show("복원 실패", false);
        } finally {
            setBusy(false);
        }
    }

    async function handleBackupNow() {
        if (backupInFlight.current || !confirm("학원 설정·프로그램·코치·일부 차량 경로를 클라우드에 백업하시겠습니까? 학생·출결·청구·월 장부는 포함되지 않습니다.")) return;

        backupInFlight.current = true;
        setBusy(true);
        setMsg(null);

        try {
            const res = await fetch("/api/admin/backup-now", { method: "POST" });
            const data = await res.json();
            if (res.ok && data.success === true) {
                show(`설정 백업 저장 완료 (${data.filename})`, true);
            } else if (data.backupSaved === true) {
                show(`설정 백업은 저장됐지만 과거 파일 정리는 완료하지 못했습니다. 재저장하지 말고 확인해 주세요. 파일: ${data.filename}`, false);
            } else if (data.backupSaved === null) {
                show(`저장 여부 확인 필요. 다시 저장하기 전에 후보 파일을 확인해 주세요: ${data.filename}`, false);
            } else {
                show("설정 백업을 완료하지 못했습니다. 권한과 백업 상태를 확인해 주세요.", false);
            }
        } catch {
            show("백업 응답을 확인하지 못했습니다. 저장됐을 수 있으니 다시 저장하기 전에 클라우드 백업을 확인해 주세요.", false);
        } finally {
            backupInFlight.current = false;
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
                ? show(`시트 동기화 완료 (${data.synced}개 슬롯)`, true)
                : show(`오류: ${data.error}`, false);
        } catch {
            show("동기화 실패", false);
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
                className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors ${
                    busy ? "opacity-50" : "text-gray-300 hover:bg-white/10 hover:text-white"
                }`}
            >
                <span className="text-xl">🔄</span>
                <span>시트 동기화</span>
            </button>
            )}
            <a
                href="/api/admin/backup"
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
            >
                <span className="text-xl">💾</span>
                <span>설정 백업 다운로드</span>
            </a>
            <label
                className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-4 py-3 transition-colors ${
                    busy ? "opacity-50" : "text-gray-300 hover:bg-white/10 hover:text-white"
                }`}
            >
                <span className="text-xl">📂</span>
                <span>{busy ? "처리 중..." : "파일로 복원"}</span>
                <input type="file" accept=".json" className="hidden" onChange={handleRestore} disabled={busy} />
            </label>
            <button
                type="button"
                onClick={handleCloudRestore}
                disabled={busy}
                className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors ${
                    busy ? "opacity-50" : "text-gray-300 hover:bg-white/10 hover:text-white"
                }`}
            >
                <span className="text-xl">☁️</span>
                <span>최신 자동백업 복원</span>
            </button>
            <button
                type="button"
                onClick={handleBackupNow}
                disabled={busy}
                className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors ${
                    busy ? "opacity-50" : "text-gray-300 hover:bg-white/10 hover:text-white"
                }`}
            >
                <span className="text-xl">☁️</span>
                <span>설정 백업 지금 저장</span>
            </button>
            <a
                href="/api/admin/export-seed"
                download="seed-data.ts"
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
            >
                <span className="text-xl">📦</span>
                <span>seed 내보내기</span>
            </a>
            <p className="px-4 text-xs text-gray-300">학원 설정·프로그램·코치·일부 차량 경로 백업 · 학생·출결·청구·월 장부 제외</p>
            {msg && <p role="status" className={`break-all px-4 py-1 text-xs ${ok ? "text-green-400" : "text-yellow-400"}`}>{msg}</p>}
        </div>
    );
}
