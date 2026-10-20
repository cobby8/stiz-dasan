/**
 * ChatPanel — 채팅 UI 본체
 *
 * 대화 화면 전체를 담당한다. 메시지 목록, 입력창, 전송 버튼이 포함된다.
 * - 데스크톱: 우하단 고정 팝업 (w-96, h-[500px])
 * - 모바일: 화면 전체를 차지
 * - 패널이 열릴 때 봇의 인사 메시지가 자동 표시됨 (API 호출 없이)
 */
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ChatMessage from "./ChatMessage";
import FontFreeIcon from "../ui/FontFreeIcon";

interface ChatPanelProps {
  onClose: () => void; // 닫기 버튼 클릭 시 부모(ChatBotButton)에 알림
}

// 봇의 첫 인사 메시지 (하드코딩 — API 호출 불필요)
const WELCOME_MESSAGE = {
  role: "model" as const,
  content:
    "안녕하세요! STIZ 농구교실입니다.\n수업에 대해 궁금한 점을 편하게 물어보세요.",
};

function SymbolIcon({
  name,
  size = 18,
}: {
  name: "close" | "send";
  size?: number;
}) {
  return <FontFreeIcon name={name} size={size} />;
}

export default function ChatPanel({ onClose }: ChatPanelProps) {
  // 대화 히스토리 (인사 메시지로 시작)
  // actions: 체험수업/수강신청 버튼 데이터 (API 응답에 포함될 수 있음)
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "model"; content: string; actions?: Array<{ label: string; url: string }> }>
  >([WELCOME_MESSAGE]);

  // 입력 중인 텍스트
  const [input, setInput] = useState("");

  // API 호출 중 여부 (전송 버튼 비활성화 + 로딩 표시용)
  const [isLoading, setIsLoading] = useState(false);

  // 메시지 영역 끝으로 자동 스크롤하기 위한 ref
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 입력 필드 ref (전송 후 포커스 복귀용)
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 새 메시지가 추가될 때마다 맨 아래로 스크롤
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 패널이 처음 열릴 때 입력창에 자동 포커스
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // isLoading이 false로 바뀌면 입력창에 포커스 복귀
  // useEffect는 React가 DOM 업데이트(disabled 해제)를 완료한 뒤 실행되므로 확실하게 동작한다.
  // 모바일(iOS Safari 등)에서는 사용자 인터랙션 없이 focus()가 차단될 수 있으나,
  // 이 경우 원래 사용자가 전송 버튼을 누른 인터랙션 체인 내이므로 대부분 허용된다.
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    // 로딩 중 → 로딩 완료로 전환된 순간에만 focus
    if (prevLoadingRef.current && !isLoading) {
      inputRef.current?.focus();
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading]);

  // 메시지 전송 함수
  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    // 사용자 메시지를 즉시 화면에 추가
    const userMessage = { role: "user" as const, content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setIsLoading(true);

    try {
      // API에 대화 히스토리 전체를 전송 (맥락 유지를 위해)
      // 인사 메시지(model)는 제외하고 실제 대화만 전송
      const apiMessages = updatedMessages.slice(1); // 첫 인사 메시지 제외
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      });

      const data = await res.json();

      if (res.ok && data.reply) {
        // 봇 응답을 대화에 추가 (actions가 있으면 함께 저장)
        setMessages((prev) => [
          ...prev,
          { role: "model", content: data.reply, actions: data.actions },
        ]);
      } else {
        // API 에러 시 사용자에게 안내
        setMessages((prev) => [
          ...prev,
          {
            role: "model",
            content:
              data.error ||
              "죄송합니다, 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
          },
        ]);
      }
    } catch {
      // 네트워크 에러 등
      setMessages((prev) => [
        ...prev,
        {
          role: "model",
          content:
            "네트워크 연결에 문제가 있습니다. 인터넷 연결을 확인해주세요.",
        },
      ]);
    } finally {
      setIsLoading(false);
      // 포커스 복귀는 useEffect([isLoading])에서 처리 — DOM 업데이트 완료 후 확실하게 동작
    }
  }, [input, isLoading, messages]);

  // Enter 키로 전송 (Shift+Enter는 줄바꿈)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      {/* 데스크톱: 우하단 고정 팝업 / 모바일: 전체 화면 */}
      <div
        className="
          fixed z-50
          inset-0 sm:inset-auto
          sm:bottom-6 sm:right-6
          sm:w-96 sm:h-[500px]
          bg-white dark:bg-gray-800 sm:rounded-2xl shadow-2xl
          flex flex-col overflow-hidden
          border border-gray-200 dark:border-gray-700
        "
      >
        {/* 상단 헤더: 제목 + 닫기 버튼 */}
        <div className="flex items-center justify-between px-4 py-3 bg-orange-500 text-white flex-shrink-0">
          <h3 className="font-bold text-base">STIZ 상담</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-orange-600 rounded-full transition-colors"
            aria-label="채팅 닫기"
          >
            <SymbolIcon name="close" size={20} />
          </button>
        </div>

        {/* 중간 메시지 영역: 스크롤 가능 */}
        <div className="flex-1 overflow-y-auto p-4">
          {messages.map((msg, i) => (
            <ChatMessage key={i} role={msg.role} content={msg.content} actions={msg.actions} />
          ))}

          {/* API 호출 중일 때 "답변 작성 중..." 표시 */}
          {isLoading && (
            <div className="flex justify-start mb-3">
              <div className="bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-2xl rounded-bl-md px-4 py-3 text-sm">
                <span className="animate-pulse">답변 작성 중...</span>
              </div>
            </div>
          )}

          {/* 자동 스크롤 앵커 */}
          <div ref={messagesEndRef} />
        </div>

        {/* 하단 입력 영역 */}
        <div className="border-t border-gray-200 dark:border-gray-700 p-3 flex-shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="메시지를 입력하세요..."
              rows={1}
              className="
                flex-1 resize-none rounded-xl border border-gray-300
                px-3 py-2 text-sm
                focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent
                max-h-24
              "
              disabled={isLoading}
            />
            {/* 전송 버튼 */}
            <button
              onClick={sendMessage}
              disabled={isLoading || !input.trim()}
              className="
                p-2 rounded-xl bg-orange-500 text-white
                hover:bg-orange-600 transition-colors
                disabled:opacity-40 disabled:cursor-not-allowed
                flex-shrink-0
              "
              aria-label="메시지 전송"
            >
              <SymbolIcon name="send" size={18} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
