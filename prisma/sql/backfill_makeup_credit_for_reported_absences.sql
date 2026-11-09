-- 결석 신고 즉시 보강권(2026-11-10 원장 결정 k4) — 배포 «전»에 이미 접수된 앞으로의 결석 신고에 보강권 채우기(선택).
--
-- 왜: 새 코드는 신고하는 순간 보강권을 만든다. 배포 전에 들어와 있던 «오늘 이후» 신고분은 보강권이 없어서,
--     그 학부모만 «미리 보강 예약»을 못 한다(그날 출결이 결석으로 저장되면 그때 기존 규칙대로 발급되긴 한다).
-- 스키마 변경 없음 — 데이터 채우기만. 자동 마이그레이션 폴더(prisma/migrations)가 아니라서 배포 때 자동 실행되지 않는다.
--
-- 키·날짜 규칙은 코드와 같다(src/lib/makeup/absence-report-credit.ts):
--   sourceKey   = 'REGULAR:' || classId || ':' || 'YYYY-MM-DD'   (출결 기반 발급과 같은 키 → 나중에 출결이 결석이어도 한 장)
--   absenceDate = 결석일 KST 자정        — RegularAbsence.date 는 date 형이라 «한 번»만 KST 로 해석한다
--   expiresAt   = calcExpiry 와 같게: KST 자정의 UTC 시각에 2개월(말일 보정은 Postgres 월 더하기가 같은 방식으로 한다)
--
-- 순서: ① 사전 확인 SELECT → ② 적용 INSERT(트랜잭션) → ③ 사후 확인 → (필요 시) ④ 되돌리기

-- ① 사전 확인 — 채울 대상(학부모가 신고한 오늘 이후 결석, 보강권 없음, 이월 정산 아님)
SELECT ra.id, ra."studentId", ra."classId", to_char(ra.date,'YYYY-MM-DD') AS ymd, ra.status
  FROM "RegularAbsence" ra
  JOIN "Student" s ON s.id = ra."studentId" AND s."mergedIntoStudentId" IS NULL
 WHERE ra.status IN ('REPORTED','CONFIRMED')
   AND ra."reportedByUserId" IS NOT NULL
   AND ra."periodId" IS NULL
   AND ra.date >= (now() AT TIME ZONE 'Asia/Seoul')::date
   AND ra.date >= DATE '2026-10-05'
   AND NOT EXISTS (SELECT 1 FROM "BillingAbsenceResolution" r WHERE r."absenceId" = ra.id AND r.resolution = 'CARRY')
   AND NOT EXISTS (SELECT 1 FROM "MakeupCredit" mc
                    WHERE mc."studentId" = ra."studentId"
                      AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date,'YYYY-MM-DD'))
 ORDER BY ra.date;

-- ② 적용 — 이미 있는 키는 건드리지 않는다(ON CONFLICT DO NOTHING · 회수된 것도 되살리지 않음)
BEGIN;
INSERT INTO "MakeupCredit"
  ("studentId","sourceType","sourceKey","absenceDate","expiresAt","originClassId","originItemId","originSessionId","status","note")
SELECT ra."studentId", 'REGULAR',
       'REGULAR:' || ra."classId" || ':' || to_char(ra.date,'YYYY-MM-DD'),
       (ra.date::timestamp AT TIME ZONE 'Asia/Seoul'),
       (((ra.date::timestamp AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC') + interval '2 months') AT TIME ZONE 'UTC',
       ra."classId", NULL, NULL, 'AVAILABLE', '결석 신고 보강권 소급 채움(2026-11-10)'
  FROM "RegularAbsence" ra
  JOIN "Student" s ON s.id = ra."studentId" AND s."mergedIntoStudentId" IS NULL
 WHERE ra.status IN ('REPORTED','CONFIRMED')
   AND ra."reportedByUserId" IS NOT NULL
   AND ra."periodId" IS NULL
   AND ra.date >= (now() AT TIME ZONE 'Asia/Seoul')::date
   AND ra.date >= DATE '2026-10-05'
   AND NOT EXISTS (SELECT 1 FROM "BillingAbsenceResolution" r WHERE r."absenceId" = ra.id AND r.resolution = 'CARRY')
ON CONFLICT ("studentId","sourceKey") DO NOTHING
RETURNING id, "studentId", "sourceKey", "absenceDate", "expiresAt";
COMMIT;

-- ③ 사후 확인 — 결석일이 KST 로 신고 날짜와 같아야 한다(하루 밀림 없음)
SELECT mc."sourceKey", to_char(mc."absenceDate" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS absence_kst,
       to_char(mc."expiresAt" AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS expires_kst
  FROM "MakeupCredit" mc
 WHERE mc.note = '결석 신고 보강권 소급 채움(2026-11-10)'
 ORDER BY mc."absenceDate";

-- ④ 되돌리기(아직 예약에 안 쓴 것만 지운다)
-- DELETE FROM "MakeupCredit"
--  WHERE note = '결석 신고 보강권 소급 채움(2026-11-10)' AND status = 'AVAILABLE' AND "makeupSessionId" IS NULL;
