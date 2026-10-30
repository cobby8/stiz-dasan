/**
 * ChatBotButton — 우하단 플로팅 말풍선 버튼
 *
 * 모든 공개 페이지에 표시되는 둥근 원형 버튼.
 * 클릭하면 ChatPanel(채팅 패널)이 열리고, 다시 클릭하면 닫힌다.
 * fixed 포지션이라 스크롤해도 항상 화면 우하단에 고정된다.
 */
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import FontFreeIcon from "../ui/FontFreeIcon";
import { usePublicOverlayOpen } from "../public-floating";

const ChatPanel = dynamic(() => import("./ChatPanel"), {
  ssr: false,
  loading: () => null,
});

export default function ChatBotButton() {
  // 채팅 패널의 열림/닫힘 상태
  const [isOpen, setIsOpen] = useState(false);
  // 채팅 패널이 열린 동안 옆의 입학 가이드 버튼도 숨긴다(패널 위에 겹쳐 보이지 않게)
  usePublicOverlayOpen(isOpen);

  return (
    <>
      {/* 채팅 패널이 열려 있으면 표시 */}
      {isOpen && <ChatPanel onClose={() => setIsOpen(false)} />}

      {/* 플로팅 말풍선 버튼 — 패널이 닫혀 있을 때만 표시.
          위치(bottom)는 public-sport.css 의 public-floating-btn 이 정한다(하단 고정 바 높이만큼 위로). */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="
            public-floating-btn public-floating-btn--chat
            fixed right-6 z-50
            w-14 h-14 rounded-full
            bg-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white dark:text-black
            shadow-lg hover:bg-orange-600 dark:hover:bg-lime-400
            transition-all duration-200 hover:scale-105
            flex items-center justify-center
          "
          aria-label="상담 챗봇 열기"
        >
          <FontFreeIcon name="chat_bubble" size={28} />
        </button>
      )}
    </>
  );
}
