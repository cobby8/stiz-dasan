-- 랠리즈 피드 이관용 사이트 스냅숏(읽기 전용) — 결과 한 칸(snapshot)이 JSON 하나.
-- 쓰는 곳: import-posts.mjs·import-videos.mjs(원장 PC, DATABASE_URL) 또는 PM 이 Supabase MCP execute_sql 로 실행해 파일로 저장.
-- 2026 수업만(작년 말 하루 여유). 수업일은 KST 달력 날짜(무tz 컬럼이라 «두 번» 변환 — src/lib/feed/rules.ts sessionKstDateSql 과 같다).
-- ⚠️ 마이그레이션 20261116500000_rallyz_feed_import 적용 후에만 돈다(장부 표 RallyzFeedImport 를 읽는다).
SELECT json_build_object(
  'takenAt', NOW(),
  'todayKst', ((NOW() AT TIME ZONE 'Asia/Seoul')::date)::text,
  'classes', COALESCE((
    SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'dayOfWeek', c."dayOfWeek", 'startTime', c."startTime") ORDER BY c.name)
      FROM "Class" c
  ), '[]'::json),
  'sessions', COALESCE((
    SELECT json_agg(json_build_object(
             'id', se.id, 'classId', se."classId",
             'ymd', (((se.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date)::text,
             'sessionKey', se."sessionKey", 'status', se.status, 'published', COALESCE(se.published, false),
             'hasContent', (se.content IS NOT NULL AND btrim(se.content) <> ''),
             'photoCount', CASE WHEN se."photosJSON" IS NULL OR btrim(se."photosJSON") IN ('', '[]') THEN 0 ELSE 1 END,
             'seasonal', se."specialProgramSessionDateId" IS NOT NULL,
             'attendanceStudents', COALESCE((SELECT json_agg(DISTINCT a."studentId") FROM "Attendance" a WHERE a."sessionId" = se.id), '[]'::json)
           ))
      FROM "Session" se
     WHERE se.date >= '2025-12-31'::timestamp
  ), '[]'::json),
  -- 반별 «활성 수강 시작일» — 피드 공개 규칙(feedParticipantSql) ②: 시작일(없으면 등록일 KST) ≤ 수업일
  'enrollStarts', COALESCE((
    SELECT json_agg(json_build_object(
             'classId', e."classId", 'studentId', e."studentId",
             'startYmd', COALESCE(e."startsOn", ((e."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date)::text))
      FROM "Enrollment" e
      JOIN "Student" st ON st.id = e."studentId" AND st."mergedIntoStudentId" IS NULL
     WHERE e.status = 'ACTIVE'
  ), '[]'::json),
  -- 이미 옮긴 것(같은 글·같은 수업 영상을 두 번 넣지 않게)
  'imported', COALESCE((
    SELECT json_agg(json_build_object('kind', l.kind, 'sourceKey', l."sourceKey")) FROM "RallyzFeedImport" l
  ), '[]'::json)
) AS snapshot;
