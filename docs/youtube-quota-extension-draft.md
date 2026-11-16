# 유튜브 하루 업로드 한도 늘리기 신청서 초안 (원장 제출용)

2026-11-16 원장 결정 v3. 원장이 **사이트에 유튜브를 연결한 그 구글 계정**(업턴랩스 계정)으로 직접 제출한다.

- 신청 양식: **YouTube API Services – Audit and Quota Extension Form**
  (구글 클라우드 콘솔 → API 및 서비스 → YouTube Data API v3 → 할당량 → «할당량 증가 신청», 또는 support.google.com/youtube/contact/yt_api_form)
- 이 양식 하나로 «API 심사(감사)»와 «할당량 늘리기»를 같이 받는다. 심사를 통과하면 API 로 올린 영상이 «비공개로 잠기는» 제한도 함께 풀린다(사이트 크론의 `PRIVATE_LOCKED` 상태가 바로 이것).
- 아래 `<…>` 칸은 원장이 채운다. 영어 칸은 양식에 그대로 붙여 넣는다(양식은 영어로 쓰는 것이 심사가 빠르다).
- 같이 준비할 것: ① 화면 녹화(2~3분) — 선생님이 수업 영상 올리기 → 관리자 유튜브 연결 화면 → 학부모 화면에서 재생되는 모습 ② 개인정보처리방침·이용약관 주소.

---

## 1. 신청자·조직 (Contact / Organization)

| 칸 | 한국어 | English |
|---|---|---|
| 이름 | `<원장 이름>` | `<Name>` |
| 이메일 | `<유튜브를 연결한 업턴랩스 구글 계정>` | `<Google account email that owns the project>` |
| 조직 | 업턴랩스 (STIZ 농구교실 다산2호점 운영) | Upturn Labs (operator of STIZ Basketball Academy, Dasan branch) |
| 웹사이트 | https://www.stiz-dasan.kr | https://www.stiz-dasan.kr |
| 개인정보처리방침 | https://www.stiz-dasan.kr/privacy | https://www.stiz-dasan.kr/privacy |
| 이용약관 | https://www.stiz-dasan.kr/terms | https://www.stiz-dasan.kr/terms |
| 구글 클라우드 프로젝트 번호·ID | `<콘솔 첫 화면의 프로젝트 번호>` / `<프로젝트 ID>` | same |
| OAuth 클라이언트 ID | `<Vercel YOUTUBE_OAUTH_CLIENT_ID 값>` | same |
| 연결 채널 | 스티즈농구교실 (`<채널 ID — /admin/youtube 화면에 표시>`) | STIZ Basketball (`<channel ID>`) |

## 2. API 사용 방식 (API client description)

**한국어(원장 확인용)**
STIZ 농구교실은 초·중등 농구 학원입니다. 자체 학원 관리 사이트(stiz-dasan.kr)에서 선생님이 수업이 끝나면 그 수업의 짧은 영상을 올립니다. 사이트 서버가 YouTube Data API v3 로 영상을 **학원 자체 채널 한 곳**에 **일부공개(unlisted)** 로 올리고, 그 수업에 출석했거나 수강 중인 학생의 **로그인한 보호자에게만** 사이트 안에서 youtube-nocookie 임베드로 보여 줍니다. 영상은 공개 검색·채널 목록에 노출하지 않으며, 보호자가 삭제를 요청하거나 선생님이 사이트에서 지우면 서버가 videos.delete 로 유튜브 사본도 지웁니다. 사용자는 학원 원장 1명(채널 소유자)뿐이고, 원장이 관리자 화면에서 OAuth 로 한 번 연결합니다. refresh token 은 AES-256-GCM 으로 암호화해 서버 DB 에만 둡니다.

**English (paste into the form)**
STIZ Basketball Academy is a youth basketball school in Namyangju, South Korea. We run our own academy-management website (https://www.stiz-dasan.kr). After each class, coaches upload a short class video on the website. Our server uses the YouTube Data API v3 to upload the video to **one channel owned by the academy** as **unlisted**, and shows it only inside the website, via youtube-nocookie embeds, to **signed-in parents of students who attended or are enrolled in that class**. Videos are never listed publicly or added to playlists. When a parent requests removal or a coach deletes the video on our website, our server deletes the YouTube copy with videos.delete. The only YouTube user is the academy owner, who connects the channel once through OAuth (scope youtube.force-ssl) from the admin page. The refresh token is stored only on our server, encrypted with AES-256-GCM, and can be revoked from the same admin page.

## 3. 쓰는 API 와 비용 (API methods & quota per call)

| Method | Units | 용도 / Purpose |
|---|---|---|
| videos.insert (resumable) | 1,600 | 수업 영상 일부공개 업로드 / upload class video as unlisted |
| videos.list (part=status) | 1 | 일부공개 유지 확인 / confirm privacy before removing our temporary copy |
| videos.update (status) | 50 | 심사 뒤 비공개→일부공개 전환 / switch locked uploads to unlisted after audit |
| videos.delete | 50 | 보호자 요청·선생님 삭제 / removal on parent request or coach deletion |
| channels.list (mine) | 1 | 연결 시 채널 확인 / confirm channel on connect |

## 4. 늘려 달라는 양과 이유 (Requested quota & justification)

**요청: 하루 100,000 units** (현재 기본 10,000)

> `<반 수·하루 영상 수는 원장이 실제 값으로 고친다 — 아래는 어림값>`

**한국어**
- 평상시: 반 약 30개 × 주 1~2회 수업 → 하루 수업 영상 약 10~20개 = 16,000~32,000 units.
- 한 번만: 이전 학부모 앱(랠리즈)에서 2026년 수업 영상 약 551개(수업마다 1개로 합친 것)를 같은 방식(일부공개·보호자만)으로 옮겨야 합니다. 551 × 1,600 = 881,600 units — 지금 한도(하루 약 5개)로는 4개월 이상 걸립니다.
- 100,000 units/일이면 평상시 업로드를 막지 않고 이전 작업을 약 2주 안에 끝낼 수 있습니다. 이전이 끝난 뒤에도 평상시 최대치(행사·대회 날 영상 증가)를 감당하려면 같은 한도가 필요합니다.
- 서버는 하루 업로드 수를 DB 계수기로 직접 제한하고, quotaExceeded 응답을 받으면 다음 날까지 자동으로 멈춥니다.

**English**
- Regular use: about 30 classes, each meeting 1–2 times a week → 10–20 class videos per day = 16,000–32,000 units/day.
- One-time migration: we are moving about 551 class videos from 2026 (one merged video per class session) from our previous parent-communication app into the same unlisted, parents-only flow. 551 × 1,600 = 881,600 units, which takes more than four months at the default quota (about 5 uploads/day after other calls).
- With 100,000 units/day we can finish the migration in about two weeks without blocking coaches' daily uploads, and keep headroom for event and tournament days afterwards.
- Our server enforces its own daily upload cap with a database counter and automatically pauses until the next day when it receives quotaExceeded.

## 5. 정책 준수 (Compliance answers)

| 질문 | 답(English) |
|---|---|
| Who are your users? | One internal user: the academy owner who owns the channel. Parents never authorize our app; they only watch embedded unlisted videos. |
| Do you store YouTube API data? | We store only the video ID, privacy status and upload time, to embed the video and delete it later. No other API data is stored. Data for deleted videos is removed. |
| How do users revoke access? | Admin page «YouTube 연결 해제» revokes the token at Google (oauth2/revoke) and deletes our encrypted copy. Also via Google Account permissions. |
| Made for kids? | The audience is parents, not children; videos are uploaded with selfDeclaredMadeForKids=false and unlisted. Parents can request removal at any time. `<촬영 동의를 어떻게 받는지 원장이 한 문장 추가 — ⚠️ 사이트의 촬영 동의 기록(StudentMediaConsent)은 현재 0건이라, 가입 신청서·안내문 등 실제 받는 방법을 적는다>` |
| Do you display ads / monetize? | No. |
| Do you modify or replace the YouTube player? | No. We use the standard youtube-nocookie embed player. |
| Screencast | `<화면 녹화 링크(구글 드라이브, 링크 있는 사용자 보기)>` |
| Test account (if requested) | `<심사용 관리자 계정 — 요청 오면 PM 이 만든다>` |

## 6. 제출 후

- 회신은 보통 몇 주 걸린다. 추가 질문 메일이 오면 그 메일을 PM 에게 넘긴다.
- 승인되면: Vercel `YOUTUBE_DAILY_UPLOAD_LIMIT` 를 새 한도에 맞게(예: 60), 이관 스크립트 `--total-limit 60 --per-run 20`, 심사 통과면 `import-videos.mjs --fix-locked` 와 관리자 «다시 시도»(사이트 영상의 비공개 잠김 풀기).
