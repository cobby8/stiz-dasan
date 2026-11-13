/**
 * ChatMessage — 개별 메시지 말풍선 컴포넌트
 *
 * 사용자 메시지는 오른쪽(파란색), 봇 메시지는 왼쪽(회색)에 표시된다.
 * 레고 블록 1개처럼, ChatPanel에서 여러 개를 쌓아서 대화를 만든다.
 */
"use client";

import Link from "next/link";

interface ChatMessageProps {
  role: "user" | "model"; // user: 학부모, model: 챗봇
  content: string;
  actions?: Array<{ label: string; url: string }>; // 체험수업/수강신청 이동 버튼
}

export default function ChatMessage({ role, content, actions }: ChatMessageProps) {
  // 사용자 메시지: 오른쪽 정렬, 파란 배경
  // 봇 메시지: 왼쪽 정렬, 회색 배경
  const isUser = role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div className="max-w-[80%]">
        <div
          className={`
            rounded-2xl px-4 py-3 text-sm leading-relaxed
            ${
              isUser
                ? "bg-[var(--color-public-accent)] text-white dark:text-[var(--color-public-dark)] rounded-br-md" // 사용자: 주 색(네이비), 우하단 모서리 각짐
                : "bg-[var(--color-public-tint)] text-[var(--color-public-ink)] rounded-bl-md" // 봇: 옅은 회색, 좌하단 모서리 각짐
            }
          `}
        >
          {/* 줄바꿈을 유지하기 위해 whitespace-pre-wrap 적용 */}
          <p className="whitespace-pre-wrap">{content}</p>
        </div>

        {/* 액션 버튼 영역: 봇 메시지이고 actions가 있을 때만 표시 */}
        {/* <a> 태그는 fixed+overflow-y-auto 컨테이너 내에서 클릭이 안 되는 경우가 있어
            button + window.location.href 방식으로 강제 이동 처리 */}
        {!isUser && actions && actions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2" style={{ position: "relative", zIndex: 9999 }}>
            {actions.map((action, i) => (
              <Link
                key={i}
                href={action.url}
                // 신청으로 가는 버튼 — 첫 버튼만 주 버튼(체험 주소는 테마가 주황으로 칠한다), 나머지는 테두리 버튼
                className={`${i === 0 ? "public-btn-primary" : "public-btn-secondary"} text-sm`}
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                {action.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
