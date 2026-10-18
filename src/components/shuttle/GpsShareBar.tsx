"use client";

import { useEffect, useState } from "react";
import type { GpsState, GpsTransmission } from "@/hooks/useGpsShare";

// 기사님 화면 — GPS 공유 상태 표시 전용 (토글 없음, 운행 시작/종료 버튼이 제어).
// ★ 라이트 모드 고정(기사님 화면 정책) — dark: 클래스 사용 금지.

function elapsedLabel(date: Date, clock: number): string {
  const sec = Math.max(0, Math.round((clock - date.getTime()) / 1000));
  if (sec < 60) return `${sec}초 전`;
  return `${Math.floor(sec / 60)}분 전`;
}

export default function GpsShareBar({
  gpsState, lastSentAt, accuracy, transmission, onRetry,
}: {
  gpsState: GpsState;
  lastSentAt: Date | null;
  accuracy: number | null;
  transmission?: GpsTransmission;
  onRetry?: () => void;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  const delayed = lastSentAt && clock - lastSentAt.getTime() > 30_000;
  return (
    <div className="mb-2 rounded-xl border border-green-300 bg-green-50 px-4 py-2.5">
      <p className="text-[14px] font-bold text-green-800">
        📍{" "}
        {gpsState === "requesting" && "위치 권한 요청 중…"}
        {gpsState === "active" && !lastSentAt && "GPS 위치 획득 · 서버 접수 대기"}
        {gpsState === "active" && lastSentAt && `마지막 서버 접수 · ${elapsedLabel(lastSentAt, clock)}${accuracy != null ? ` · 정확도 ${Math.round(accuracy)}m` : ""}`}
        {gpsState === "denied" && "⚠️ 위치 권한 거부됨 — 브라우저 설정에서 허용해주세요"}
        {gpsState === "error"  && "⚠️ 위치를 가져오지 못했습니다"}
        {gpsState === "off"    && "위치 공유 꺼짐"}
      </p>
      {(gpsState === "denied" || gpsState === "error") && onRetry && <button type="button" className="text-[12px] font-bold underline" onClick={onRetry}>위치 연결 다시 시도</button>}
      <p role="status" className="mt-0.5 text-[12px] font-semibold text-amber-700">
        {transmission === "sending" && "위치 전송 중…"}
        {transmission === "error" && "위치 전송 확인 필요 · 다음 전송에서 재시도합니다"}
        {delayed && gpsState !== "off" && " · 마지막 서버 접수 이후 30초 이상 지났습니다"}
        {transmission === "stopping" && "기기 위치 수집 중단 · 서버 중단 접수 확인 중"}
        {transmission === "stopped" && "기기 위치 수집 중단 · 서버 중단 접수 완료"}
        {transmission === "stop-unknown" && "기기 위치 수집은 중단됨 · 서버 공유 중단은 확인 필요"}
      </p>
      {(gpsState === "active" || gpsState === "requesting") && (
        <p className="mt-0.5 text-[12px] font-semibold text-amber-700">
          ⚠️ 화면이 꺼지거나 다른 앱으로 이동하면 위치 공유가 중단됩니다
        </p>
      )}
    </div>
  );
}
