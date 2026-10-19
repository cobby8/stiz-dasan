"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { GpsState, GpsTransmission } from "@/hooks/useGpsShare";
import GpsShareBar from "./GpsShareBar";
import styles from "./DriverGpsIndicator.module.css";

export type DriverGpsIndicatorProps = {
  gpsState: GpsState;
  lastSentAt: Date | null;
  accuracy: number | null;
  transmission?: GpsTransmission;
  onRetry?: () => void;
  mode?: "web" | "native";
  nativeMessage?: string | null;
};

// 위치 수집·전송은 그대로 두고, 기존 공유 상태만 헤더에서 요약한다.
export default function DriverGpsIndicator(props: DriverGpsIndicatorProps) {
  const { gpsState, lastSentAt, transmission, mode = "web", nativeMessage } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const stopping = transmission === "stopping" || transmission === "stopped" || transmission === "stop-unknown";
  const delayed = !stopping && gpsState !== "off" && lastSentAt !== null && clock - lastSentAt.getTime() > 30_000;
  const failed = transmission === "stop-unknown" || transmission === "error" || gpsState === "denied" || gpsState === "error";
  const waiting = !stopping && (gpsState === "requesting" || (gpsState === "active" && lastSentAt === null));
  const attention = failed || delayed || waiting;
  const title = transmission === "stop-unknown" ? "공유 중단 확인 필요" :
    transmission === "stopping" ? "위치 공유 중단 확인 중" :
    transmission === "stopped" ? "위치 공유 중단 완료" :
    transmission === "error" ? "위치 전송 실패 · 다음 전송에서 다시 시도합니다" :
    gpsState === "denied" ? "위치 권한을 허용해 주세요" :
    gpsState === "error" ? "기기 위치를 확인해 주세요" :
    delayed ? "위치 접수 지연 · 마지막 접수 후 30초 이상 지났습니다" :
    waiting ? (mode === "native" && nativeMessage?.trim() ? nativeMessage.trim() : "새 위치와 서버 접수를 기다리는 중") :
    gpsState === "active" ? "위치 공유 중" : "위치 공유 꺼짐";
  const shortLabel = transmission === "stop-unknown" ? "중단 확인" :
    transmission === "stopping" ? "중단 중" :
    transmission === "stopped" ? "" :
    transmission === "error" ? "전송 확인" :
    gpsState === "denied" ? "권한 확인" :
    gpsState === "error" ? "위치 확인" :
    delayed ? "위치 지연" : waiting ? "위치 대기" : "";
  const icon = failed ? "location_disabled" : stopping ? "location_off" : attention ? "location_searching" : gpsState === "active" ? "my_location" : "location_off";
  const tone = failed ? styles.error : attention ? styles.warning : gpsState === "active" && !stopping ? styles.active : styles.neutral;

  return (
    <div className={styles.root}>
      <button ref={trigger} type="button" className={`${styles.trigger} ${tone}`}
        aria-label={`${title} · 위치 공유 상세 보기`} aria-haspopup="dialog"
        title={title} onClick={() => dialog.current?.showModal()}>
        <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
        {shortLabel && <span>{shortLabel}</span>}
      </button>
      <span className={styles.srOnly} role={failed ? "alert" : "status"}>{title}</span>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}
        onClose={() => trigger.current?.focus()}>
        <header className={styles.header}>
          <h2 id={titleId}>위치 공유 상태</h2>
          <button type="button" autoFocus className={styles.close} aria-label="위치 공유 상세 닫기"
            onClick={() => dialog.current?.close()}>
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </header>
        <div className={styles.details}>
          <GpsShareBar {...props} />
        </div>
      </dialog>
    </div>
  );
}
