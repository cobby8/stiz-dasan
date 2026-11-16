# STIZ 농구교실 관리 시스템 — 개발 가이드

## 프로젝트 개요

Next.js 16 + Supabase + Prisma 기반 학원 관리 및 홈페이지 시스템.

- **DB**: Supabase PostgreSQL (PgBouncer 트랜잭션 모드)
- **ORM**: Prisma 5 (`$queryRawUnsafe` / `$executeRawUnsafe` — prepared statement 우회)
- **인증**: Supabase Auth (미들웨어에서 `/admin/*` 보호)
- **배포**: Vercel (ISR + Cron)
- **시간표 데이터**: Google Sheets CSV 파싱

## 개발서버
- 포트: **4000** (`npm run dev` → localhost:4000)
- 다른 프로젝트와 포트 충돌 방지를 위해 4000번대 사용

---

## 핵심 아키텍처 결정사항

### 왜 `$queryRawUnsafe`를 쓰는가?
Supabase는 PgBouncer **트랜잭션 모드**를 사용한다. 이 모드에서는 Prisma ORM의 일반 쿼리가 사용하는 `extended query protocol`(prepared statement)이 차단된다. 때문에 `$queryRawUnsafe` / `$executeRawUnsafe`로 `simple query protocol`을 사용한다.

**절대 Prisma ORM 기본 메서드(`findMany`, `create`, `upsert` 등)로 교체하지 말 것.**

### 캐싱 전략
| 위치 | 캐시 정책 | 이유 |
|------|-----------|------|
| `/schedule` (공개) | `revalidate: 300` (5분 ISR) | 사용자 트래픽 많음 |
| `/admin/schedule` | `revalidate: 30` (30초 ISR) | Server Action이 즉시 무효화 |
| `/admin/*` 나머지 | `force-dynamic` | 실시간 데이터 필요 |
| Google Sheets (공개) | `{ next: { revalidate: 300 } }` | 5분 캐시 |
| Google Sheets (관리자) | `{ next: { revalidate: 30 } }` | 30초 캐시 |

**관리자 시간표 변경 시**: `revalidatePath('/schedule')` + `revalidatePath('/admin/schedule')`가 자동 호출되어 캐시가 즉시 무효화된다.

---

## 위험 명령어 목록 (반드시 백업 후 실행)

다음 명령어는 **데이터 소실 위험**이 있다. 실행 전 반드시 `/admin` → "지금 클라우드에 저장" 또는 "백업 다운로드"를 먼저 실행할 것.

```bash
# ⚠️ 절대 주의 — 실행 전 백업 필수
npx prisma migrate reset        # DB 전체 초기화 + 재생성
npx prisma db push --force-reset # 스키마 강제 동기화 (데이터 삭제)
npx prisma db push               # 마이그레이션 없이 스키마 적용 (주의)

# ✅ 안전한 명령어
npx prisma migrate dev --name <이름>   # 마이그레이션 파일 생성
npx prisma migrate deploy              # 마이그레이션 적용 (프로덕션)
npx prisma generate                    # Prisma 클라이언트 재생성
```

### DB 스키마 변경 절차
1. `prisma/schema.prisma` 수정
2. `npx prisma migrate dev --name <변경내용>` 실행 (로컬)
3. 마이그레이션 파일 커밋
4. Vercel 자동 배포 시 `npx prisma migrate deploy` 실행됨
5. (할 일 없음) 핵심 데이터 스냅샷은 매일 자동 백업이 Storage 에 저장한다 — "seed 내보내기"·`seed-data.ts` 커밋은 필요 없다

---

## 데이터 보호 체계

### 자동 백업
- **Vercel Cron**: 매일 KST 자정 (UTC 15:00) → Supabase Storage "backups/" 버킷
- **보관 기간**: 30일 (자동 삭제)
- **모니터링**: `/admin` 대시보드 "시스템 상태" 카드에서 마지막 백업 시간 확인

### 수동 복구 방법 (긴급 시)

**방법 1**: 최신 클라우드 백업으로 복원
```
관리자 사이드바 → "최신 자동백업 복원"
```

**방법 2**: 로컬 백업 파일로 복원
```
관리자 사이드바 → "백업 다운로드" (먼저 저장)
→ 사이드바 → "파일로 복원"
```

**방법 3**: 핵심 데이터(seed) 스냅샷으로 복구
```bash
# 프로그램·수업 칸 설정·이용약관만 되살린다(지우지 않고 덮어쓰기만)
curl -X POST https://<your-domain>/api/admin/seed
```
> 복구는 Storage `backups/seed/seed-latest.json`(매일 자동 저장)을 먼저 쓰고, 없거나 읽기 실패·모양 이상·프로그램 0줄일 때만 `prisma/seed-data.ts` 로 넘어간다.
> 응답의 `source`·`snapshotDate` 로 어느 자료를 썼는지 확인한다. 프로그램을 하나도 못 되살리면 `success: false`.
> 코치는 스냅샷에 없다 — DB 가 통째로 비었으면 «최신 자동백업 복원 → 방법 3» 순서로 한다.

### 핵심 데이터(seed) 자동 저장 (2026-11-16)
- 매일 KST 자정 백업 cron 과 "지금 클라우드에 저장"이 같은 실행에서 저장한다: `seed/seed-latest.json` 덮어쓰기 + `seed/seed-<날짜>.json` 30일 보관. **사람이 할 일 없음.**
- 직전 최신본보다 프로그램 수가 절반 미만으로 줄면 최신본을 덮어쓰지 않는다(날짜별 사본만 저장·로그). 실제로 그렇게 줄인 경우엔 `seed-latest.json` 을 손으로 바꾼다.
- 마지막 저장 시각은 `/admin` 대시보드 "시스템 상태" → "핵심 데이터 자동 저장"에서 본다(이틀 넘게 없으면 경고).
- "seed 내보내기" 버튼은 파일로 받아 두고 싶을 때만 쓴다.

---

## 환경변수 목록

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=          # Supabase 프로젝트 URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=     # 공개 anon 키 (RLS 적용)
SUPABASE_SERVICE_ROLE_KEY=         # 서비스 롤 키 (RLS 우회, 서버 전용)

# 데이터베이스 (Prisma)
DATABASE_URL=                      # PgBouncer 풀링 URL (포트 6543)
DIRECT_URL=                        # 직접 연결 URL (포트 5432, migrate용)

# 선택사항
GOOGLE_CALENDAR_API_KEY=           # Google Calendar API v3 (없으면 ICS fallback)
CRON_SECRET=                       # Vercel Cron 인증 토큰 (설정 권장)
```

> **중요**: `DIRECT_URL`이 없으면 `prisma migrate deploy`가 실패한다. Supabase 대시보드 → Settings → Database → Connection String → Direct에서 확인.

---

## 파일 구조 요약

```
src/
├── app/
│   ├── admin/
│   │   ├── layout.tsx          ← 사이드바 + 백업 버튼 (Client Component)
│   │   ├── page.tsx            ← 대시보드 + 시스템 상태 카드
│   │   └── schedule/page.tsx   ← revalidate: 30 (force-dynamic 아님)
│   ├── api/admin/
│   │   ├── backup/             ← GET(다운로드) / POST(복원)
│   │   ├── backup-now/         ← POST(즉시 클라우드 저장)
│   │   ├── cloud-backups/      ← GET(목록) / POST(복원) / DELETE
│   │   ├── export-seed/        ← GET(seed 스냅샷을 파일로 내려받기 — 선택)
│   │   └── seed/               ← POST(Storage 최신 seed 스냅샷으로 복구, 없으면 seed-data.ts)
│   └── api/cron/backup/        ← GET(자동 백업, Vercel Cron)
├── lib/
│   ├── queries.ts              ← react.cache() 감싼 DB 조회 함수
│   ├── googleSheetsSchedule.ts ← Google Sheets CSV 파싱
│   └── supabase/middleware.ts  ← 인증 미들웨어 (주의: src/middleware.ts 없음)
prisma/
├── schema.prisma               ← 데이터 모델 (@@index 포함)
└── seed-data.ts                ← 핵심 데이터 대비용 파일(평소엔 Storage 자동 스냅샷을 쓴다)
```

> **미들웨어 주의**: `src/middleware.ts`가 없다. `src/lib/supabase/middleware.ts`만 있다. 미들웨어를 활성화하려면 `src/middleware.ts`를 만들고 `updateSession`을 export해야 한다. (현재 `/admin` 인증 보호가 어떻게 동작하는지 먼저 확인 필요)

---

## 자주 발생하는 문제

### 관리자 시간표가 느리다
→ 이미 해결됨: `revalidate: 30`으로 설정되어 있음. `force-dynamic`으로 되돌리지 말 것.

### Google Sheets 데이터가 안 나온다
1. `AcademySettings.googleSheetsScheduleUrl` 설정 확인 (`/admin/settings`)
2. 구글 시트가 "링크 있는 모든 사용자" 공개 상태인지 확인
3. URL에 `gid=` 파라미터가 올바른지 확인 (탭 ID)

### DB 쿼리가 실패한다
- `PgBouncer` 관련 에러: `$queryRawUnsafe` 사용 중인지 확인
- `DIRECT_URL` 환경변수 확인
- Supabase free tier 일시 중지 여부 확인 (7일 미접속 시 중지)

### 배포 후 스키마 불일치
```bash
# 로컬에서
npx prisma migrate dev --name fix-schema

# 이미 프로덕션과 불일치한 경우
npx prisma migrate resolve --applied <migration-name>
```

---

## 작업 습관 규칙

- **하루 마무리 시 자동 푸시**: 사용자가 "마무리", "오늘 끝", "내일 이어서" 등 하루 작업 종료를 알리면, 미푸시 커밋이 있을 경우 자동으로 `git push`를 실행한다. 별도 확인 없이 바로 푸시할 것.
- **기존 기능 무조건 보존**: 디자인 개편이나 리팩토링 시에도 기존의 프로젝트 기능(로직)은 모두 보존한다.
- **UX 흐름 동일 유지**: 기존 사용자가 겪던 UX 단계 및 흐름은 동일하게 유지해야 한다.
- **변경 전 동의 필수**: 구조적, 시각적 변경이 필요한 부분은 반드시 사전 기획을 통해 사용자에게 동의를 구한 후 작업을 진행한다.
