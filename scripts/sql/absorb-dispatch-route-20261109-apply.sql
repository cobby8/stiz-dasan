-- 저장 노선 → 셔틀 명단 흡수 «적용» SQL (드라이런 20261109 생성 · 실행 전 원장 확인 필수)
-- ⚠️ 초안 — 실행하지 않았다. `node scripts/ops-dryrun-absorb-dispatch-route.mjs --also-month 2026-12` 출력 그대로.
--    범위: 2026-11 목 등원 15행 + 2026-12 목 등원 거울 15행 = 30행(정렬·시각·정류장 이름 1건 · 좌표는 0.1m 이상 다를 때만).
--    적용 직전에 드라이런을 다시 돌려 이 파일과 같은지 본다. 사이에 명단이 바뀌면 2) 사전 검증이 전체를 중단시킨다.
--    노선에만 있는 학생 2명(목 6교시 퇴원·휴원, 명단 행 없음)은 여기서 아무것도 하지 않는다 → 읽기 끊기 배포 후 화면에서 빠진다.
-- 🔒 행 id 유지 UPDATE 만(탑승 체크 키 보존). INSERT/DELETE 없음. RegularDispatchRoute 는 건드리지 않는다.
-- 이 시점엔 기사님 화면이 아직 저장 노선을 우선 읽으므로 적용해도 화면 변화 없음(읽기 끊기 배포 후 동일해야 정상).
BEGIN;

-- 1) 백업 표(이미 있으면 실패 → 같은 날 두 번 적용 방지)
CREATE TABLE "_bak_20261109_regular_dispatch_route" AS SELECT * FROM "RegularDispatchRoute";
CREATE TABLE "_bak_20261109_regular_shuttle_stop" AS
  SELECT * FROM "RegularShuttleStop" WHERE "serviceMonth" IN ('2026-11', '2026-12');

-- 2) 사전 검증: 바꿀 행이 모두 있고, 드라이런 때 값 그대로인지(그 사이 누가 고쳤으면 0행 → 아래 검사에서 중단)
CREATE TEMP TABLE _absorb_plan ("id" text PRIMARY KEY, "sortOrder" int, "arriveTime" text, "stopName" text, "latitude" double precision, "longitude" double precision) ON COMMIT DROP;
INSERT INTO _absorb_plan VALUES
    ('9c2866c6-40ac-406d-b6e7-6ad004d38b80', 0, '14:36', '1호점 앞 버스정류장', 37.6193496838458::double precision, 127.157895707868::double precision),
    ('e332cca4-0f86-4cad-b116-6a7f66524d96', 1, '14:36', '1호점 앞 버스정류장', 37.6193496838458::double precision, 127.157895707868::double precision),
    ('80756ab3-956e-4971-95c6-b0503c33b2a2', 2, '14:42', '다산별빛초등학교 후문', 37.6174773682489::double precision, 127.164860512677::double precision),
    ('6ed22b3e-41fa-4c02-9a99-adc892cd0295', 3, '14:42', '다산별빛초등학교 후문', 37.6174773682489::double precision, 127.164860512677::double precision),
    ('d2429b2b-2dfe-475a-bc9c-26630f91f58b', 4, '14:48', '금교초 앞', 37.6136385627543::double precision, 127.162040324158::double precision),
    ('3e8af941-8aaa-4db4-82e8-599c3961bc80', 5, '14:48', '금교초 앞', 37.6136385627543::double precision, 127.162040324158::double precision),
    ('aa7c6b90-026e-4d5f-aa3e-9764e4e2b34d', 6, '14:49', '플루리움 214동', 37.6128810459977::double precision, 127.159235489921::double precision),
    ('52385e1c-8a4d-42a8-aae9-be6722a8c673', 18, '17:24', '1호점 앞 버스정류장', 37.6193496838458::double precision, 127.157895707868::double precision),
    ('18a38c8f-ee2a-4dac-9bb6-4b384098aed3', 20, '17:28', '유승한내들센트럴 정문 맘스테이션', 37.6209231772186::double precision, 127.15351822435::double precision),
    ('cbd5f207-4954-4b80-90ae-a842f566e178', 21, '17:36', '다산롯데캐슬 후문', 37.627071880731::double precision, 127.155640742597::double precision),
    ('c7de6098-0007-4301-8c88-64bc346d2784', 22, '17:36', '다산롯데캐슬 후문', 37.627071880731::double precision, 127.155640742597::double precision),
    ('045d9b16-956e-4660-a2bb-2f1bf54a952b', 25, '17:46', '힐스테이트 황금산 CU 앞', 37.6088537027674::double precision, 127.164113818605::double precision),
    ('f7d74fe6-0bc1-4537-8361-bc338ed566d4', 23, '19:00', '다산이편한세상자이 후문', 37.62095020675::double precision, 127.153518279931::double precision),
    ('f2965f3d-0997-4e2a-85c6-27c3d1d90d8b', 24, '19:02', '다산이편한세상자이 후문', 37.6203894470746::double precision, 127.153437836727::double precision),
    ('dd4fba74-de35-46e3-ab48-cd29f6db92d6', 28, '19:10', '롯데캐슬 정문 맞은편 다이소 앞', 37.6259968944108::double precision, 127.154352771632::double precision),
    ('af1e99e1-2215-40d1-956b-3272bc8db7ac', 0, '14:36', '1호점 앞 버스정류장', 37.6193496838458::double precision, 127.157895707868::double precision),
    ('f0c48e1c-c514-4ce4-b81a-f14e33abc412', 1, '14:36', '1호점 앞 버스정류장', 37.6193496838458::double precision, 127.157895707868::double precision),
    ('f21d7c44-6f27-45a9-99e5-a08cdd913bf1', 2, '14:42', '다산별빛초등학교 후문', 37.6174773682489::double precision, 127.164860512677::double precision),
    ('3cd776b0-d116-426a-b441-74595ebd3fee', 3, '14:42', '다산별빛초등학교 후문', 37.6174773682489::double precision, 127.164860512677::double precision),
    ('dccea3df-4c36-47da-ae5c-59d78debc570', 4, '14:48', '금교초 앞', 37.6136385627543::double precision, 127.162040324158::double precision),
    ('d08bf4bb-e792-4fd6-ac38-0016adec355e', 5, '14:48', '금교초 앞', 37.6136385627543::double precision, 127.162040324158::double precision),
    ('13944a7b-788b-472b-b1b1-a109716e661f', 6, '14:49', '플루리움 214동', 37.6128810459977::double precision, 127.159235489921::double precision),
    ('d7fc2e35-8aae-4f24-88e7-83afcda96d7f', 18, '17:24', '1호점 앞 버스정류장', 37.6193496838458::double precision, 127.157895707868::double precision),
    ('6578251d-968f-4f50-a798-21aaa881b782', 20, '17:28', '유승한내들센트럴 정문 맘스테이션', 37.6209231772186::double precision, 127.15351822435::double precision),
    ('a8e23094-fb80-4153-aee7-9f9ab6d1581c', 21, '17:36', '다산롯데캐슬 후문', 37.627071880731::double precision, 127.155640742597::double precision),
    ('7c9eb8bc-9581-415e-8af2-1fd6925c8d4e', 22, '17:36', '다산롯데캐슬 후문', 37.627071880731::double precision, 127.155640742597::double precision),
    ('64671d2b-5510-4849-95c5-dd6bd017f740', 25, '17:46', '힐스테이트 황금산 CU 앞', 37.6088537027674::double precision, 127.164113818605::double precision),
    ('e91882c3-1bcd-45f3-8d13-74f8b9443981', 23, '19:00', '다산이편한세상자이 후문', 37.62095020675::double precision, 127.153518279931::double precision),
    ('a2790cd1-2260-45c1-b5bc-f81134b591f4', 24, '19:02', '다산이편한세상자이 후문', 37.6203894470746::double precision, 127.153437836727::double precision),
    ('34834c4e-628c-47f7-8fbb-4c729dedf30d', 28, '19:10', '롯데캐슬 정문 맞은편 다이소 앞', 37.6259968944108::double precision, 127.154352771632::double precision)
;
CREATE TEMP TABLE _absorb_before ("id" text PRIMARY KEY, "sortOrder" int, "arriveTime" text, "stopName" text) ON COMMIT DROP;
INSERT INTO _absorb_before VALUES
    ('9c2866c6-40ac-406d-b6e7-6ad004d38b80', 5, '14:55', '1호점 앞 버스정류장'),
    ('e332cca4-0f86-4cad-b116-6a7f66524d96', 6, '14:55', '1호점 앞 버스정류장'),
    ('80756ab3-956e-4971-95c6-b0503c33b2a2', 0, '14:40', '다산별빛초등학교 후문'),
    ('6ed22b3e-41fa-4c02-9a99-adc892cd0295', 1, '14:40', '다산별빛초등학교 후문'),
    ('d2429b2b-2dfe-475a-bc9c-26630f91f58b', 3, '14:50', '금교초 앞'),
    ('3e8af941-8aaa-4db4-82e8-599c3961bc80', 4, '14:50', '금교초 앞'),
    ('aa7c6b90-026e-4d5f-aa3e-9764e4e2b34d', 2, '14:45', '플루리움 214동'),
    ('52385e1c-8a4d-42a8-aae9-be6722a8c673', 25, '17:55', '1호점 앞 버스정류장'),
    ('18a38c8f-ee2a-4dac-9bb6-4b384098aed3', 22, '17:45', '유승한내들센트럴 정문 맘스테이션'),
    ('cbd5f207-4954-4b80-90ae-a842f566e178', 20, '17:40', '다산롯데캐슬 후문'),
    ('c7de6098-0007-4301-8c88-64bc346d2784', 21, '17:40', '다산롯데캐슬 후문'),
    ('045d9b16-956e-4660-a2bb-2f1bf54a952b', 18, '17:30', '힐스테이트 황금산 CU 앞'),
    ('f7d74fe6-0bc1-4537-8361-bc338ed566d4', 23, '19:05', '유승한내들센트럴 정문 맘스테이션'),
    ('f2965f3d-0997-4e2a-85c6-27c3d1d90d8b', 23, '19:05', '다산이편한세상자이 후문'),
    ('dd4fba74-de35-46e3-ab48-cd29f6db92d6', 28, '19:05', '롯데캐슬 정문 맞은편 다이소 앞'),
    ('af1e99e1-2215-40d1-956b-3272bc8db7ac', 5, '14:55', '1호점 앞 버스정류장'),
    ('f0c48e1c-c514-4ce4-b81a-f14e33abc412', 6, '14:55', '1호점 앞 버스정류장'),
    ('f21d7c44-6f27-45a9-99e5-a08cdd913bf1', 0, '14:40', '다산별빛초등학교 후문'),
    ('3cd776b0-d116-426a-b441-74595ebd3fee', 1, '14:40', '다산별빛초등학교 후문'),
    ('dccea3df-4c36-47da-ae5c-59d78debc570', 3, '14:50', '금교초 앞'),
    ('d08bf4bb-e792-4fd6-ac38-0016adec355e', 4, '14:50', '금교초 앞'),
    ('13944a7b-788b-472b-b1b1-a109716e661f', 2, '14:45', '플루리움 214동'),
    ('d7fc2e35-8aae-4f24-88e7-83afcda96d7f', 25, '17:55', '1호점 앞 버스정류장'),
    ('6578251d-968f-4f50-a798-21aaa881b782', 22, '17:45', '유승한내들센트럴 정문 맘스테이션'),
    ('a8e23094-fb80-4153-aee7-9f9ab6d1581c', 20, '17:40', '다산롯데캐슬 후문'),
    ('7c9eb8bc-9581-415e-8af2-1fd6925c8d4e', 21, '17:40', '다산롯데캐슬 후문'),
    ('64671d2b-5510-4849-95c5-dd6bd017f740', 18, '17:30', '힐스테이트 황금산 CU 앞'),
    ('e91882c3-1bcd-45f3-8d13-74f8b9443981', 23, '19:05', '유승한내들센트럴 정문 맘스테이션'),
    ('a2790cd1-2260-45c1-b5bc-f81134b591f4', 23, '19:05', '다산이편한세상자이 후문'),
    ('34834c4e-628c-47f7-8fbb-4c729dedf30d', 28, '19:05', '롯데캐슬 정문 맞은편 다이소 앞')
;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "RegularShuttleStop" s JOIN _absorb_before b ON b."id" = s."id"
   WHERE s."sortOrder" = b."sortOrder" AND s."arriveTime" IS NOT DISTINCT FROM b."arriveTime" AND s."stopName" = b."stopName";
  IF n <> 30 THEN RAISE EXCEPTION '드라이런 이후 명단이 바뀌었습니다(일치 % / 예상 30). 드라이런을 다시 돌리세요.', n; END IF;
END $$;

-- 3) 적용(행 id 유지)
UPDATE "RegularShuttleStop" s
   SET "sortOrder" = p."sortOrder", "arriveTime" = p."arriveTime", "stopName" = p."stopName",
       "latitude" = p."latitude", "longitude" = p."longitude"
  FROM _absorb_plan p
 WHERE s."id" = p."id";

-- 4) 사후 검증: 정확히 30행이 계획값과 같아야 한다
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "RegularShuttleStop" s JOIN _absorb_plan p ON p."id" = s."id"
   WHERE s."sortOrder" = p."sortOrder" AND s."arriveTime" IS NOT DISTINCT FROM p."arriveTime" AND s."stopName" = p."stopName";
  IF n <> 30 THEN RAISE EXCEPTION '적용 결과 불일치(% / 30) — 롤백', n; END IF;
END $$;

COMMIT;
