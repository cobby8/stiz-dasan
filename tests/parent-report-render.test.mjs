import { loadChildAccess } from "./_child-access-fixture.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

// 학부모 소식 상세(/mypage/reports/[sessionId]) — 2026-11-14 수업 피드 개편.
// 실제 RSC 직렬화기를 서버 조건으로 실행한다. 판정 모듈(@/lib/feed/server·rules)은 «실제 코드»를 돌리고,
// DB 는 SQL 내용을 보고 답하는 가짜(fakeDb)로만 바꾼다 — 볼 수 있는가(IDOR)·참여 기준·사진 거르기를 실행으로 확인.
if (!process.execArgv.includes("--conditions=react-server")) {
    test("학부모 리포트 실제 RSC 서버 조건 검사", () => {
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ["--conditions=react-server", "--test", import.meta.filename], { encoding: "utf8", env });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /pass 11/);
    });
} else {
    const require = createRequire(import.meta.url);
    const ts = require("typescript");
    const React = require("react");
    const { renderToReadableStream, registerClientReference } = require("next/dist/compiled/react-server-dom-webpack/server.node");
    const galleryId = "test/FeedPhotoGallery";
    const videoId = "test/SessionVideoList";
    const avatarId = "test/ProfileAvatar";
    const Gallery = registerClientReference(() => {}, galleryId, "default");
    const VideoList = registerClientReference(() => {}, videoId, "SessionVideoList");
    // 프로필 사진 동그라미(2026-11-14 연결)는 클라이언트 부품 — 서버 화면에서는 참조로만 넘긴다
    const Avatar = registerClientReference(() => {}, avatarId, "default");
    const manifest = {
        [galleryId]: { id: "feed-photo-gallery", chunks: [], name: "default" },
        [videoId]: { id: "session-video-list", chunks: [], name: "SessionVideoList" },
        [avatarId]: { id: "profile-avatar", chunks: [], name: "default" },
    };
    const missing = new Error("NOT_FOUND");

    function compile(file, mocks = {}) {
        const code = ts.transpileModule(readFileSync(file, "utf8"), {
            compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        }).outputText;
        const testModule = { exports: {} };
        const safeRequire = (name) => {
            if (Object.hasOwn(mocks, name)) return mocks[name];
            if (["react", "react/jsx-runtime"].includes(name)) return require(name);
            throw new Error(`검사에서 서버 의존성 접근 금지: ${name}`);
        };
        vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: file })(safeRequire, testModule, testModule.exports);
        return testModule.exports;
    }
    const kst = compile("src/lib/datetime/kst.ts");
    const photos = compile("src/lib/sessionPhotoEntries.ts");
    const profilePhotoRules = compile("src/lib/profilePhoto/rules.ts"); // 의존성 0 — 진짜 규칙
    const videoRules = compile("src/lib/sessionVideo/rules.ts", { "@/lib/datetime/kst": kst });
    const feedRules = compile("src/lib/feed/rules.ts", { "@/lib/datetime/kst": kst, "@/lib/sessionVideo/rules": videoRules });
    const photoStorage = compile("src/lib/sessionPhotoStorage.ts", { "@/lib/supabase/admin": { createAdminClient() { throw new Error("저장소 접근 금지"); } }, "@/lib/sessionPhotoEntries": photos });

    const SESSION = "session-fixture";
    const CLASS = "class-fixture";
    const privatePhoto = (id, session = SESSION) => ({ id, type: "image", url: "https://invalid.example/private-leak.jpg", storageBucket: "staff-session-private", storagePath: `staff-sessions/${CLASS}/${session}/${id}.jpg`, visibility: "PRIVATE" });

    /**
     * SQL 을 보고 답하는 가짜 DB. 참여(participants)는 «내 아이 중 이 수업 참여자»를 뜻한다 —
     * 실제 SQL 의 참여 조각(feedParticipantSql)이 들어 있는지도 함께 확인한다.
     */
    function fakeDb({ published = true, parentOwn = "parent-own", participants = [{ id: "child-own", name: "합성 학생" }], photosJSON = "[]", drafts = [], videos = 0, attendances = [{ studentId: "child-own", status: "PRESENT" }], notes = [] }) {
        const queries = [];
        const query = async (sql, ...params) => {
            queries.push([sql, ...params]);
            if (sql.includes('FROM "Session" se') && sql.includes("WHERE se.id = $1")) {
                assert.match(sql, /se\.status = 'COMPLETED' AND se\.published = true/);
                return published && params[0] === SESSION
                    ? [{ id: SESSION, classId: CLASS, ymd: "2026-10-19", topic: "합성 리포트", content: "드리블 연습", photosJSON, className: "합성 반", dayOfWeek: "Mon", startTime: "16:00", endTime: "17:00", programName: null, coachName: "합성 코치" }]
                    : [];
            }
            if (sql.includes('FROM "User" u') && sql.includes('JOIN "Session" se ON se.id = $2')) {
                // 학생은 로그인한 보호자 쪽에서만 찾는다 + 참여 조각(출결 또는 ACTIVE 수강)
                assert.match(sql, /EXISTS \(SELECT 1 FROM "Attendance" fa WHERE fa\."sessionId" = se\.id AND fa\."studentId" = st\.id\)/);
                assert.match(sql, /fe\.status = 'ACTIVE'/);
                assert.doesNotMatch(sql, /StudentMediaConsent/, "동의는 보지 않는다(원장 결정)");
                return params[0] === parentOwn && params[1] === SESSION ? participants : [];
            }
            if (sql.includes('FROM "SocialPostDraft"')) return drafts.filter((d) => params[0].includes(d.sessionId));
            if (sql.includes('FROM "SessionVideo"')) return videos ? [{ sessionId: SESSION, count: videos }] : [];
            if (sql.includes('FROM "Attendance" a')) return attendances.filter((a) => params[1].includes(a.studentId));
            if (sql.includes('FROM "StudentSessionNote"')) return notes.filter((n) => params[1].includes(n.studentId));
            throw new Error(`예상하지 못한 SQL: ${sql.slice(0, 80)}`);
        };
        return { queries, prisma: { $queryRawUnsafe: query } };
    }

    async function render({ user = true, parentId = "parent-own", ...db } = {}) {
        const fake = fakeDb(db);
        const feedServer = compile("src/lib/feed/server.ts", {
            "@/lib/prisma": { prisma: fake.prisma },
            "@/lib/account/child-access": loadChildAccess(),
            "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL` },
            "@/lib/sessionPhotoStorage": photoStorage,
            "@/lib/sessionPhotoEntries": photos,
            "@/lib/feed/rules": feedRules,
            "@/lib/profilePhoto/rules": profilePhotoRules,
        });
        const Page = compile("src/app/mypage/reports/[sessionId]/page.tsx", {
            "@/lib/ui/statusTones": compile("src/lib/ui/statusTones.ts"),
            "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user ? { id: "auth-fixture" } : null } }) } }) },
            "@/lib/prisma": { prisma: fake.prisma },
            // 실제 가드처럼 로그인이 없으면 오류를 던진다(2026-11-14: 화면이 getUser 대신 이 가드 결과로 로그인 여부를 판단)
            "@/lib/auth-guard": { requireVerifiedParent: async () => { if (!user) throw new Error("인증이 필요합니다."); return { appUserId: parentId }; } },
            "next/navigation": { notFound() { throw missing; } },
            "next/link": { default: ({ children, ...props }) => React.createElement("a", props, children), __esModule: true },
            "@/components/parent/FeedPhotoGallery": { default: Gallery, __esModule: true },
            "@/components/parent/SessionVideoPlayer": { SessionVideoList: VideoList },
            "@/lib/feed/server": feedServer,
            "@/lib/datetime/kst": kst,
            "@/components/common/ProfileAvatar": { default: Avatar, __esModule: true },
            "@/lib/profilePhoto/rules": profilePhotoRules,
        }).default;
        let tree;
        try { tree = await Page({ params: Promise.resolve({ sessionId: SESSION }) }); }
        catch (error) { if (error === missing) return { denied: true, queries: fake.queries }; throw error; }
        const errors = [];
        const stream = await renderToReadableStream(tree, manifest, { onError: (error) => { errors.push(error.message); } });
        const output = await new Response(stream).text();
        return { denied: false, output, errors, queries: fake.queries };
    }

    test("실제 RSC는 서버 img 이벤트 처리기를 거부한다 (기존 오류 재현 — 사진은 클라이언트 부품으로)", async () => {
        const errors = [];
        const stream = await renderToReadableStream(React.createElement("img", { src: "/photo.jpg", onError() {} }), manifest, { onError: (error) => { errors.push(error.message); } });
        await new Response(stream).text();
        assert.ok(errors.some((message) => message.includes("Event handlers cannot be passed")));
    });
    test("옛 문자열 사진은 그대로, 비공개 사진은 «사진 원장에 있는 것만» 프록시 주소로(헛요청 없음)", async () => {
        const photosJSON = JSON.stringify(["/uploads/legacy.jpg", privatePhoto("photo-ok"), `/api/staff/sessions/${SESSION}/photos/photo-gone`, `/api/staff/sessions/other-session/photos/photo-ok`]);
        const result = await render({ photosJSON, drafts: [{ sessionId: SESSION, mediaJSON: JSON.stringify([privatePhoto("photo-ok")]) }] });
        assert.deepEqual(result.errors, []);
        assert.ok(result.output.includes("/uploads/legacy.jpg"));
        assert.ok(result.output.includes(`/api/staff/sessions/${SESSION}/photos/photo-ok`));
        assert.ok(!result.output.includes("photo-gone"), "사진 원장에서 지워진 사진은 넘기지 않는다(404 헛요청 방지)");
        assert.ok(!result.output.includes("other-session"), "다른 수업 주소는 넘기지 않는다(403 헛요청 방지)");
        assert.ok(!result.output.includes("private-leak"));
        assert.ok(!result.output.includes("storagePath"));
        assert.match(result.output, /feed-photo-gallery/);
    });
    test("사진 없음 → 사진 칸 없음 / 깨진 JSON·null 도 화면을 깨뜨리지 않는다", async () => {
        for (const photosJSON of ["{bad", "{}", null, JSON.stringify([null, {}, ""])]) {
            const result = await render({ photosJSON });
            assert.deepEqual(result.errors, []);
            assert.ok(!result.output.includes("수업 사진"));
            assert.ok(result.output.includes("드리블 연습"), "본문은 그대로");
        }
    });
    test("영상만 있는 수업 → 영상 칸(개수) + 영상 목록 부품, 사진 칸 없음", async () => {
        const result = await render({ videos: 2 });
        assert.deepEqual(result.errors, []);
        assert.match(result.output, /수업 영상/);
        assert.match(result.output, /session-video-list/);
        assert.ok(!result.output.includes("수업 사진"));
    });
    test("사진·영상 둘 다 → 사진 칸이 영상 칸보다 위", async () => {
        const result = await render({ videos: 1, photosJSON: JSON.stringify(["/uploads/a.jpg"]) });
        assert.deepEqual(result.errors, []);
        assert.ok(result.output.indexOf("수업 사진") > 0 && result.output.indexOf("수업 사진") < result.output.indexOf("수업 영상"));
    });
    test("미로그인은 DB 조회 없이 로그인 안내만 받는다", async () => {
        const result = await render({ user: false, photosJSON: JSON.stringify([privatePhoto("photo-ok")]) });
        assert.equal(result.queries.length, 0);
        assert.ok(result.output.includes("로그인이 필요합니다"));
        assert.ok(!result.output.includes("photo-ok"));
    });
    test("부모 ID 미확인은 조회 전에 거부한다", async () => {
        const result = await render({ parentId: null });
        assert.equal(result.denied, true);
        assert.equal(result.queries.length, 0);
    });
    test("미발행·미완료 수업은 아이·사진 조회 전에 거부한다", async () => {
        const result = await render({ published: false });
        assert.equal(result.denied, true);
        assert.equal(result.queries.length, 1);
    });
    test("IDOR: 남의 수업(내 아이가 참여하지 않음)은 거부하고 사진·출결을 읽지 않는다", async () => {
        for (const options of [{ participants: [] }, { parentOwn: "someone-else" }]) {
            const result = await render({ ...options, photosJSON: JSON.stringify([privatePhoto("photo-ok")]) });
            assert.equal(result.denied, true);
            assert.ok(!result.queries.some(([sql]) => sql.includes("SocialPostDraft") || sql.includes('"Attendance" a')));
        }
        // 학생은 로그인한 보호자 id 로만 찾는다(주소의 sessionId 로 학생을 찾지 않는다)
        const ok = await render();
        const childQuery = ok.queries.find(([sql]) => sql.includes('FROM "User" u'));
        assert.deepEqual(childQuery.slice(1), ["parent-own", SESSION]);
    });
    test("동의 없이 «참여자»만: 출결이 아직 없어도 그 반 수강생 보호자는 보고, 상태는 «확인 중»", async () => {
        const result = await render({ attendances: [], photosJSON: JSON.stringify([privatePhoto("photo-ok")]), drafts: [{ sessionId: SESSION, mediaJSON: JSON.stringify([privatePhoto("photo-ok")]) }] });
        assert.equal(result.denied, false);
        assert.match(result.output, /확인 중/);
        assert.ok(result.output.includes(`/photos/photo-ok`));
    });
    test("출결·코멘트 조회는 참여한 내 아이 id 로만 한다", async () => {
        const result = await render({ notes: [{ studentId: "child-own", note: "합성 코멘트", rating: 4 }] });
        assert.match(result.output, /합성 코멘트/);
        const att = result.queries.find(([sql]) => sql.includes('FROM "Attendance" a'));
        assert.deepEqual(att.slice(1), [SESSION, ["child-own"]]);
    });
}
