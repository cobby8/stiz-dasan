-- 저장 노선(RegularDispatchRoute) → 셔틀 명단(RegularShuttleStop) 흡수 «차이 목록» (SELECT 만 · 읽기 전용)
-- 용도: 로컬에서 scripts/ops-dryrun-absorb-dispatch-route.mjs 를 못 돌릴 때 PM 이 Supabase MCP execute_sql 로 같은 차이를 본다.
-- 한계: 스크립트는 기사님 화면 함수(buildSavedDriverSections)를 그대로 써서 «같은 학생 여러 행»·이름 매칭까지 처리한다.
--       이 SQL 은 명단 studentId(없으면 이름 공백무시)로만 잇는 단순판이다. 결과가 스크립트와 다르면 스크립트 쪽이 정답.
-- 바꿀 대상: 아래 params 의 달·요일·방향.

-- ① 저장 노선 전체 목록(12월 자동 생성이 노선을 복사했는지 확인)
SELECT "serviceMonth", "dayOfWeek", "direction",
       jsonb_array_length(COALESCE("payload"->'vehicles', '[]'::jsonb)) AS vehicles,
       (SELECT count(*) FROM jsonb_array_elements(COALESCE("payload"->'vehicles', '[]'::jsonb)) v,
                             jsonb_array_elements(COALESCE(v->'stops', '[]'::jsonb)) s,
                             jsonb_array_elements(COALESCE(s->'students', '[]'::jsonb)) st) AS students,
       "updatedAt"
  FROM "RegularDispatchRoute"
 ORDER BY 1, 2, 3;

-- ② 노선 순서대로 학생 → 명단 행 짝 + 바뀌는 값
WITH params AS (SELECT '2026-11'::text AS m, 'Thu'::text AS dow, 4 AS wd, 'PICKUP'::text AS dir, 'BOARD'::text AS stop_dir),
route_students AS (
  SELECT v.ord AS vi, s.ord AS si, st.ord AS ti,
         COALESCE(NULLIF(btrim(s.val->>'label'), ''), '(위치 미지정)') AS label,
         -- savedStopTimeLabel 과 같은 규칙: etaLabel 의 HH:MM → etaManual → etaMinutes
         COALESCE(
           (SELECT lpad(mm[1], 2, '0') || ':' || mm[2] FROM regexp_match(s.val->>'etaLabel', '(\d{1,2}):(\d{2})') mm),
           (SELECT to_char(make_interval(mins => (((round(x)::int % 1440) + 1440) % 1440)), 'HH24:MI')
              FROM (SELECT COALESCE((s.val->>'etaManual')::numeric, (s.val->>'etaMinutes')::numeric) AS x) z WHERE x IS NOT NULL)
         ) AS route_time,
         st.val->>'requestId' AS student_key,
         st.val->>'name' AS route_name
    FROM "RegularDispatchRoute" r, params p,
         jsonb_array_elements(r."payload"->'vehicles') WITH ORDINALITY v(val, ord),
         jsonb_array_elements(v.val->'stops') WITH ORDINALITY s(val, ord),
         jsonb_array_elements(COALESCE(s.val->'students', '[]'::jsonb)) WITH ORDINALITY st(val, ord)
   WHERE r."serviceMonth" = p.m AND r."dayOfWeek" = p.dow AND r."direction" = p.dir
)
SELECT rs.vi, rs.si, rs.ti, rs.route_name, rs.label AS route_stop, rs.route_time,
       rss."id" AS row_id, rss."classTime", rss."sortOrder" AS cur_sort,
       rss."arriveTime" AS cur_time, rss."stopName" AS cur_stop,
       CASE WHEN rss."id" IS NULL THEN '명단 행 없음(흡수 후 화면에서 사라짐)'
            WHEN regexp_replace(rss."stopName", '\s', '', 'g') <> regexp_replace(rs.label, '\s', '', 'g') THEN '정류장 이름 다름'
            WHEN rss."arriveTime" IS DISTINCT FROM rs.route_time THEN '시각 다름'
            ELSE '' END AS note
  FROM route_students rs
  CROSS JOIN params p
  LEFT JOIN "RegularShuttleStop" rss
    ON rss."serviceMonth" = p.m AND rss."weekday" = p.wd AND rss."direction" = p.stop_dir
   AND (rss."studentId" = rs.student_key
        OR (rss."studentId" IS NULL AND regexp_replace(lower(rss."studentName"), '\s', '', 'g') = regexp_replace(lower(rs.route_name), '\s', '', 'g')))
 ORDER BY rs.vi, rs.si, rs.ti;

-- ③ 명단엔 있는데 노선에 없는 행(흡수 후에도 그대로 남지만 순서는 원래 명단 순서)
WITH params AS (SELECT '2026-11'::text AS m, 'Thu'::text AS dow, 4 AS wd, 'PICKUP'::text AS dir, 'BOARD'::text AS stop_dir),
keys AS (
  SELECT st.val->>'requestId' AS k, st.val->>'name' AS n
    FROM "RegularDispatchRoute" r, params p,
         jsonb_array_elements(r."payload"->'vehicles') v, jsonb_array_elements(v->'stops') s,
         jsonb_array_elements(COALESCE(s->'students', '[]'::jsonb)) st(val)
   WHERE r."serviceMonth" = p.m AND r."dayOfWeek" = p.dow AND r."direction" = p.dir
)
SELECT rss."id", rss."studentName", rss."classTime", rss."sortOrder", rss."arriveTime", rss."stopName"
  FROM "RegularShuttleStop" rss, params p
 WHERE rss."serviceMonth" = p.m AND rss."weekday" = p.wd AND rss."direction" = p.stop_dir
   AND rss."studentName" IS NOT NULL AND btrim(rss."studentName") <> ''
   AND NOT EXISTS (SELECT 1 FROM keys WHERE keys.k = rss."studentId"
                    OR regexp_replace(lower(keys.n), '\s', '', 'g') = regexp_replace(lower(rss."studentName"), '\s', '', 'g'))
 ORDER BY rss."sortOrder";

-- ④ 같은 요일 sortOrder 중복(흡수 후 같은 칸 안 순서가 id 순으로 정해지는 원인)
SELECT "serviceMonth", "sortOrder", count(*) AS n, string_agg(COALESCE("studentName", '(경유)') || '/' || "direction", ', ') AS rows
  FROM "RegularShuttleStop"
 WHERE "serviceMonth" IN ('2026-11', '2026-12') AND "weekday" = 4
 GROUP BY 1, 2 HAVING count(*) > 1
 ORDER BY 1, 2;
