// 셔틀 명단 한 행(RegularShuttleStop)의 공용 타입.
// 2026-10-02 구글 시트 가져오기 종료로 시트 CSV 파서(parseCsvRows·parseRegularShuttleSheet)는 삭제했다.
// 파일 이름은 여러 곳이 이 경로에서 타입을 가져오므로 그대로 둔다.
// 각 행 = 하루 타임라인의 정차 하나. 학원(2호점) 경유 행은 반 교대 지점.

export type RegularShuttleStop = {
  id?: string;              // DB 행 id(조회 시 채워짐). 순서·시각 저장에 쓴다.
  serviceMonth?: string;    // 'YYYY-MM'. 월별 차량표 스냅샷
  weekday: number;          // 0=일 … 6=토 (월=1)
  weekdayLabel: string;     // '월'…'금'
  classTime: string | null; // '17:00~18:00' 등(2호점 경유 행은 없을 수 있음)
  arriveTime: string | null;// 'HH:MM' 정차 시각
  stopName: string;         // 목적지(정차 위치 이름)
  direction: "BOARD" | "ALIGHT" | "PIVOT" | "RETURN"; // 승차/하차/(하차·승차 동시=학원 경유)/복귀
  studentName: string | null;
  studentId?: string | null;  // 사이트에서 확정한 안정적인 학생 식별값(DB 조회 시 채움)
  studentPhone: string | null;
  parentPhone: string | null;
  note: string | null;
  sortOrder: number;        // 요일 안에서 도착시간·행순 정렬용
  latitude?: number | null; // 정류장 좌표(지오코딩 후 채워짐)
  longitude?: number | null;
};
