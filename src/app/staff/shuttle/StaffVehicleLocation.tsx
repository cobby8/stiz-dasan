"use client";

import { useState } from "react";
import DriverLocationPanel from "@/components/admin/DriverLocationPanel";

/**
 * 선생님 화면 «셔틀» 탭의 «차량 현재 위치»(2026-11-16 원장 지시) — 누르면 관리자 화면과 같은 위치 창이 뜬다
 * (30초마다 자동 갱신, 지도 열기). 위치 조회는 원장·부원장 권한으로만 된다(서버가 다시 확인).
 */
export default function StaffVehicleLocation() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="academy-button-secondary min-h-12! w-full">
        차량 현재 위치
      </button>
      {open && <DriverLocationPanel onClose={() => setOpen(false)} />}
    </>
  );
}
