"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  createParentOperationsRequestLink,
  getActiveParentOperationsRequestLinks,
  revokeParentOperationsRequestLink,
  type ActiveParentOperationsLink,
} from "@/app/actions/parent-operations-request";

export default function ParentRequestLinkPanel({ studentId, studentName }: { studentId: string; studentName: string }) {
  const [activeLinks, setActiveLinks] = useState<ActiveParentOperationsLink[]>([]);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const refreshLinks = useCallback(async () => {
    const links = await getActiveParentOperationsRequestLinks(studentId);
    setActiveLinks(links);
  }, [studentId]);

  useEffect(() => {
    void refreshLinks().catch(() => setMessage("활성 링크를 불러오지 못했습니다."));
  }, [refreshLinks]);

  function createLink() {
    startTransition(async () => {
      try {
        const result = await createParentOperationsRequestLink(studentId);
        const url = `${window.location.origin}/request/${result.token}`;
        setCreatedUrl(url);
        setMessage("7일 동안 사용할 수 있는 요청 링크를 만들었습니다.");
        await refreshLinks();
      } catch (error) {
        setMessage(adminErrorText(error, "요청 링크를 만들지 못했습니다."));
      }
    });
  }

  async function copyLink() {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setMessage("링크를 복사했습니다.");
    } catch {
      setMessage("자동 복사가 막혔습니다. 링크를 직접 선택해 복사해 주세요.");
    }
  }

  function revokeLink(linkId: string) {
    startTransition(async () => {
      try {
        await revokeParentOperationsRequestLink(linkId);
        setActiveLinks((links) => links.filter((link) => link.id !== linkId));
        setMessage("요청 링크를 취소했습니다.");
      } catch (error) {
        setMessage(adminErrorText(error, "링크를 취소하지 못했습니다."));
      }
    });
  }

  return (
    // 2026-11-09 정리: 설명 두 줄 → 한 줄(제목 옆 작은 글씨). 학생 상세 «개요» 탭 맨 아래에 놓인다.
    // 2차 정리: «관리자가 승인해야 반영됩니다» 설명 줄도 ⓘ(마우스 올리기·화면 읽기 도구)로 옮겼다.
    <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white px-5 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="academy-section-title flex min-w-0 items-center gap-1">
          학부모 요청 링크
          <span role="img" title="학부모가 이 링크로 보낸 요청은 관리자가 승인해야 반영됩니다" aria-label="학부모가 이 링크로 보낸 요청은 관리자가 승인해야 반영됩니다" className="cursor-help text-xs font-normal text-[var(--color-academy-faint)] underline decoration-dotted underline-offset-2">안내</span>
        </h3>
        <button type="button" disabled={isPending} onClick={createLink} className="academy-button-secondary academy-button-sm shrink-0">
          {isPending ? "처리 중…" : "링크 생성"}
        </button>
      </div>

      {createdUrl && <div className="mt-3 flex gap-2">
        <input readOnly aria-label="학부모 요청 링크" value={createdUrl} className="academy-input min-w-0 flex-1" />
        <button type="button" onClick={() => void copyLink()} className="academy-button-secondary shrink-0">복사</button>
      </div>}

      {activeLinks.length > 0 && <ul className="mt-3 space-y-2 border-t border-[var(--color-academy-line)] pt-3">
        {activeLinks.map((link) => <li key={link.id} className="flex items-center justify-between gap-2 text-xs">
          <span className="text-[var(--color-academy-muted)]">{new Date(link.expiresAt).toLocaleString("ko-KR")} 만료</span>
          <button type="button" disabled={isPending} onClick={() => revokeLink(link.id)} className="academy-button-danger academy-button-sm">취소</button>
        </li>)}
      </ul>}
      {/* 결과 안내 — 글이 없을 땐 화면에서 숨겨 빈 줄이 자리만 차지하지 않게(알림 영역은 유지) */}
      <p role="status" className={message ? "mt-2 text-xs font-medium text-[var(--color-academy-muted)]" : "sr-only"}>{message}</p>
    </div>
  );
}
