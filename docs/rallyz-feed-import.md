# 랠리즈 2026 수업 피드 → 사이트 수업 피드 이관

2026-11-16 원장 결정표 v1~v5 승인. **랠리즈에는 쓰지 않는다(읽기·내려받기만). 학부모 알림은 보내지 않는다.**

| 결정 | 내용 | 어디서 지키나 |
|---|---|---|
| v1 | 글·사진 먼저 한 번에. 최신 내용이 위로 | 사이트 피드가 «수업일 내림차순»(`src/lib/feed/reportFeedServer.ts`). 이관은 글을 **정확한 수업일**에 붙인다. 한 수업 안의 여러 글은 쓴 시각 순으로 덧붙인다 |
| v2 | 영상은 수업(반·날짜)마다 1개로 묶어 유튜브 일부공개(약 551개) | `import-videos.mjs` — ffmpeg 로 합치고, 사이트와 같은 채널·같은 하루 한도 계수기 |
| v3 | 유튜브 하루 업로드 한도 늘리기 신청 | `docs/youtube-quota-extension-draft.md` (원장이 구글 계정으로 제출) |
| v4 | 공개 범위 = 지금 사이트와 같음 | 사이트 규칙 그대로(그 수업 출결 기록 학생 + 그날 활성 수강 학생의 보호자만). 퇴원생 요청 시 사진·영상 삭제 = 기존 삭제 기능 |
| v5 | 다산2호점만 | `classInfo.instNm` 에 «다산2호점»이 있는 글만(다산점·평내호평점·슈퍼맥스 제외) |

## 0. 무엇이 어떻게 들어가나

- **글**: 그 반·그날 수업 기록(Session)의 «수업 내용» 뒤에 **덧붙인다**(기존 내용은 그대로). 수업 기록이 없으면 `--create-missing` 일 때만 새로 만든다(상태 «완료», 학부모 미발행).
- **사진**: 랠리즈 1000px 축소본을 내려받아 선생님 업로드와 **같은 규칙**(위치정보 제거·최대 1600px JPEG)으로 비공개 버킷 `staff-session-private` 에 올린다. 사진 원장(`SocialPostDraft`)은 상태 `DRAFT` 로 넣어 **SNS 검토 목록·인스타 게시 대기열에 뜨지 않는다.** 선생님·원장 사진 삭제 버튼으로 지울 수 있다.
- **영상**: 수업마다 1개 mp4 → 유튜브 일부공개 → `SessionVideo` 에 «사이트 사본 없이 유튜브만»으로 기록(학부모 화면은 쿠키 없는 유튜브 재생).
- **이관 표시**: `Session."importSource" = 'RALLYZ_FEED'`. 이 표시가 있으면 관리자·선생님 «발행» 버튼을 눌러도 **학부모 알림이 나가지 않는다.**
- **장부**: `RallyzFeedImport` 한 줄 = 랠리즈 글 1개 또는 수업 영상 1개. 같은 것을 두 번 넣지 않고(몇 번 다시 돌려도 안전), 되돌릴 때 «덧붙인 것만» 정확히 뺀다.
- **기본은 미발행**(published=false). 원장이 관리자 «수업 피드»(`/admin/attendance/feed`, 보낸 상태 «안 보냄»)에서 확인한 뒤 `publish.mjs` 로 알림 없이 발행한다.

## 1. 피드 JSON 뽑기(원장 크롬, 5분)

1. 크롬에서 `rallyz.co.kr/v3/main`(www 없음) 로그인 → 학원관리(다산2호점).
2. F12 → Console 탭 → `scripts/rallyz-feed-import/chrome-snippet.js` 내용을 통째로 붙여넣고 Enter → «헤더 수집 시작».
3. 화면에서 **피드(소식)** 메뉴를 한 번 눌러 목록이 뜨게 한다 → 콘솔에 «헤더 확보».
4. 콘솔에 `rzExport()` 입력 → 끝나면 다운로드 폴더에 `rallyz-feed-2026.json`.
   - 진행 상황: `rzProgress()` · 반별로만 받아지면 `rzSeenClassIds()` 로 반 id 를 보고 `rzExport({ classIds: [...] })`.
   - 오류 007 = 헤더가 두 벌. 새로고침 후 다시 2번부터(스니펫은 한 벌만 보낸다).
5. 영상용: 피드에서 영상 하나를 재생 → 콘솔에 `rzHlsTemplate()` → 나온 한 줄(`…/feed_vod_bc/{id}_AVC_HD.mp4/index.m3u8`)을 복사해 둔다.
   주소 속 «경로 토큰»이 시간이 지나면 바뀔 수 있다 — 영상 내려받기가 403 이면 이 단계만 다시.
6. 파일을 프로젝트 `.tmp/rallyz-feed-import/` 에 둔다(깃에 안 올라간다).

> 기대 건수(2026 다산2호점): 글 748 · 사진 475 · 영상 2,339. 계획 출력의 숫자가 크게 다르면 멈추고 PM 에게.

## 2. 마이그레이션(PM — 한 번만)

`prisma/migrations/20261116500000_rallyz_feed_import/migration.sql` 을 Supabase MCP `apply_migration` 으로 적용(칸 1개 + 새 표 1개, 기존 행 변화 없음). 코드 배포는 그 뒤(코드는 칸이 없어도 동작한다).

## 3. 계획 보기(아무것도 안 씀)

```bash
node scripts/rallyz-feed-import/import-posts.mjs --feed .tmp/rallyz-feed-import/rallyz-feed-2026.json --month 2026-11
```

- 수업마다 «글·사진 수 · 기존/새 기록 · 볼 학생 수»가 **최신 수업부터** 나온다.
- `⚠️ 볼 학생 0명` = 그 수업에 출결 기록도, 그날 활성 수강도 없음 → 발행해도 아무 학부모도 못 본다(사이트 공개 규칙 그대로). 출결을 사이트로 옮기기 전(1~8월)일수록 많을 수 있다.
- 반 이름이 안 맞는 글은 `.tmp/rallyz-feed-import/skipped.json`. 매핑 파일로 해결: `--class-map map.json` (`{ "랠리즈 반 이름": "사이트 반 이름 또는 id" }`).
- 스냅숏(사이트 상태)은 원장 PC 의 `.env.local` DB 로 **읽기 전용** 조회한다. DB 비밀값이 없는 곳에서는 PM 이 `scripts/rallyz-feed-import/snapshot.sql` 을 MCP `execute_sql` 로 돌려 결과를 파일로 저장하고 `--snapshot 파일` 을 붙인다.

## 4. 표본 시험(한 반 · 한 달 — 운영)

```bash
# ① 계획
node scripts/rallyz-feed-import/import-posts.mjs --feed <피드.json> --month 2026-11 --class "월4"
# ② 사진 올리고 SQL 파일 만들기(DB 는 아직 안 바뀜)
node scripts/rallyz-feed-import/import-posts.mjs --feed <피드.json> --month 2026-11 --class "월4" --batch rz-sample-1 --emit-sql .tmp/rallyz-feed-import/sample.sql
# ③ PM: sample.sql 을 MCP execute_sql 로 적용(또는 원장 PC 에서 같은 명령에 --apply)
# ④ 확인: 관리자 «수업 피드» → 반 «월4» · 보낸 상태 «안 보냄» → 글·사진 모양
# ⑤ 학부모 모양까지 보려면: node scripts/rallyz-feed-import/publish.mjs --batch rz-sample-1   (SQL 파일 → MCP 적용)
#    그 반 학부모 계정으로 /mypage/reports/feed — 날짜 순서(최신 위) 확인
# ⑥ 되돌리기: node scripts/rallyz-feed-import/rollback.mjs --batch rz-sample-1   (SQL 파일 → MCP 적용)
```

**백업·되돌림**: 이관은 «덧붙이기 + 장부»라 별도 백업 표가 필요 없다 — `rollback.mjs` 가 장부를 보고 덧붙인 글·사진 항목만 빼고, 이전 상태(예정/완료·미발행)를 돌려놓고, 이관이 만든 수업 기록(출결 없는 것)을 지우고, 사진 파일은 삭제 대기열로, 영상은 «지움» 표시(유튜브 사본은 사이트 크론이 지움). 1회용 로컬 Postgres 에서 «이관 → 재실행 → 발행 → 되돌림 = 원래 그대로»를 확인했다(2026-11-16).
그래도 운영 표본 전에 한 번 더 안전하게 하려면 적용 직전에 MCP 로:
```sql
CREATE TABLE "_bak_20261116_rz_sample_session" AS SELECT * FROM "Session" WHERE "classId" = '<반 id>' AND date >= '2026-11-01' AND date < '2026-12-01';
```

## 5. 전체 글·사진(원장 확인 뒤)

```bash
node scripts/rallyz-feed-import/import-posts.mjs --feed <피드.json> --from 2026-01-01 --to 2026-11-30 --create-missing
node scripts/rallyz-feed-import/import-posts.mjs --feed <피드.json> --from 2026-01-01 --to 2026-11-30 --create-missing --batch rz-feed-all --apply
node scripts/rallyz-feed-import/publish.mjs --batch rz-feed-all --apply     # 원장 확인 뒤, 알림 없이 발행
```

- 중간에 끊기면 **같은 `--batch`** 로 다시 실행 — 올린 사진은 진행 파일(`posts-state-<batch>.json`)로, 넣은 글은 장부로 건너뛴다.
- 이미 학부모에게 보낸 수업(11/3 이후 사이트에서 발행한 수업)은 기본으로 건너뛴다. 덧붙이려면 `--allow-published`(바로 학부모에게 보인다).
- `--no-photos`(글만)는 사진 있는 글을 건너뛴다(장부에 남으면 나중에 사진을 못 넣으므로).

## 6. 영상(v2 — 한도 늘리기 승인 전후)

준비(원장 PC 한 번): `winget install Gyan.FFmpeg` · 프로젝트 루트에 `.env.rallyz-import` 파일(깃 제외)을 만들고 Vercel 의 값 3개를 넣는다:
```
YOUTUBE_OAUTH_CLIENT_ID=...
YOUTUBE_OAUTH_CLIENT_SECRET=...
YOUTUBE_TOKEN_ENCRYPTION_KEY=...
RALLYZ_HLS_TEMPLATE=https://…/feed_vod_bc/{id}_AVC_HD.mp4/index.m3u8
```
사이트에 연결된 채널(«스티즈농구교실»)의 토큰을 DB 암호문에서 풀어 쓴다 — 새 구글 로그인이 필요 없다. **작업이 끝나면 이 파일을 지운다.**

```bash
node scripts/rallyz-feed-import/import-videos.mjs --feed <피드.json>                 # 계획(최신 수업부터)
node scripts/rallyz-feed-import/import-videos.mjs --feed <피드.json> --download 20    # 미리 20개 합쳐 두기(한도와 무관)
node scripts/rallyz-feed-import/import-videos.mjs --feed <피드.json> --upload        # 하루 한도 안에서 1개(--per-run N)
node scripts/rallyz-feed-import/import-videos.mjs --feed <피드.json> --fix-locked    # 유튜브 심사 통과 뒤: 비공개로 잠긴 이관 영상을 일부공개로
```

- **하루 한도**: 사이트 크론과 같은 계수기(`YouTubeConnection.quotaUsed`, KST 날짜)를 나눠 쓴다. `--total-limit`(기본 5 = 사이트 크론과 같음)을 넘지 않는다. 할당량 초과 응답이면 다음 KST 자정까지 사이트·스크립트 모두 멈춘다. **선생님 영상이 밀리지 않게 밤에 돌리는 것을 권한다.** 한도 증설 승인 뒤 `--total-limit`·`--per-run` 을 올린다(사이트 `YOUTUBE_DAILY_UPLOAD_LIMIT` 도 함께).
- 첫 업로드가 «비공개로 잠김»(API 심사 전 프로젝트)이면 바로 멈춘다 — 사이트 사본이 없어 학부모가 못 보기 때문. 심사 통과 뒤 `--fix-locked`.
- 끊기면 그냥 다시 실행: 유튜브 이어 올리기 주소·올린 영상 id 를 `videos-state.json` 에 남긴다(같은 영상을 두 번 올리지 않는다). 올린 mp4 는 지운다.
- 합치기는 재인코딩 없이(`-c copy`), 실패하면 그 수업만 한 번 다시 인코딩.

## 7. 퇴원생·삭제 요청(v4)

- 사진: 선생님·원장 수업 화면의 사진 삭제(이관 사진도 같은 버튼). 
- 영상: 수업 화면의 영상 삭제 → 사이트 크론이 유튜브 사본도 지운다.
- 이관 전체 취소: `rollback.mjs --batch <batch>`.

## 8. 예상 소요

| 단계 | 시간 |
|---|---|
| 피드 JSON 뽑기(원장) | 5~10분 |
| 표본(한 반·한 달) | 10분 + 원장 확인 |
| 글·사진 전체(748글·475장) | 사진 내려받기·올리기 15~30분 + 확인 |
| 영상 내려받기·합치기(약 25GB) | 인터넷 속도에 따라 1~3시간(나눠서 가능) |
| 영상 올리기(약 551개) | **한도가 좌우**: 지금(하루 최대 5개, 사이트와 공유) ≈ 4~6개월 / 증설 승인(예: 하루 60개) ≈ 10일 |

## 9. 파일

- `scripts/rallyz-feed-import/lib.mjs` — 순수 규칙(반 매칭·KST 날짜·수업일 보정·지점 거르기·정렬·묶음·SQL) · 테스트 `tests/rallyz-feed-import.test.mjs`
- `import-posts.mjs` · `import-videos.mjs` · `publish.mjs` · `rollback.mjs` · `snapshot.sql` · `chrome-snippet.js` · `common.mjs`
- 사이트: `src/lib/feed/importedSession.ts`(이관 수업 = 발행 알림 없음), `src/app/actions/admin.ts` `publishSessionReport` · `src/app/actions/staff-sessions.ts` `publishStaffSessionReport`
