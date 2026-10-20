"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import FontFreeIcon from "./ui/FontFreeIcon";

const ChatPanel = dynamic(() => import("./chat/ChatPanel"), { ssr: false });

/** 상담과 둘러보기를 한 입구에 모으고, 요청할 때만 무거운 화면을 불러옵니다. */
export default function PublicHelp() {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState(false);
  const [guide, setGuide] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [open]);
  const close = () => { setOpen(false); setGuide(false); trigger.current?.focus(); };
  return <>
    {chat && <ChatPanel onClose={() => { setChat(false); trigger.current?.focus(); }} />}
    {!chat && <div className="public-help" onKeyDown={e => { if (e.key === "Escape") close(); }}>
      {open && <div ref={panel} className="public-help-panel public-card" role="region" aria-label="상담과 이용 안내">
        <strong>{guide ? "처음 오셨다면 이 순서로 살펴보세요" : "무엇을 도와드릴까요?"}</strong>
        {guide ? <>
          <Link href="/programs" className="public-button-secondary" onClick={close}>1. 우리 아이에게 맞는 수업 보기</Link>
          <Link href="/schedule" className="public-button-secondary" onClick={close}>2. 가능한 요일과 시간 확인</Link>
          <Link href="/apply/trial" className="public-button" onClick={close}>3. 체험 수업 신청</Link>
          <button type="button" className="public-link min-h-11" onClick={() => setGuide(false)}>다른 도움 보기</button>
        </> : <>
        <button type="button" className="public-button" onClick={() => { setChat(true); setOpen(false); }}>상담 챗봇</button>
        <Link href="/faq" className="public-button-secondary" onClick={close}>자주 묻는 질문</Link>
        <button type="button" className="public-button-secondary" onClick={() => setGuide(true)}>학원 둘러보기</button>
        </>}
        <button type="button" className="public-link min-h-11" onClick={close}>닫기</button>
      </div>}
      <button ref={trigger} type="button" className="public-help-button" aria-expanded={open} aria-label={open ? "상담·안내 닫기" : "상담·안내 열기"} onClick={() => setOpen(value => !value)}><FontFreeIcon name={open ? "close" : "chat_bubble"} size={24} /></button>
    </div>}
  </>;
}
