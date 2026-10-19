import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

// 실제 RSC 직렬화기를 서버 조건으로 실행하며 DB·인증은 합성 응답으로만 대체한다.
if (!process.execArgv.includes("--conditions=react-server")) {
    test("학부모 리포트 실제 RSC 서버 조건 검사", () => {
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ["--conditions=react-server", "--test", import.meta.filename], { encoding: "utf8", env });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /pass 9/);
    });
} else {
    const require = createRequire(import.meta.url);
    const ts = require("typescript");
    const React = require("react");
    const { renderToReadableStream, registerClientReference } = require("next/dist/compiled/react-server-dom-webpack/server.node");
    const clientId = "test/ReportPhoto";
    const Photo = registerClientReference(() => {}, clientId, "default");
    const manifest = { [clientId]: { id: "report-photo", chunks: [], name: "default" } };
    const missing = new Error("NOT_FOUND");

    function compile(file, mocks = {}) {
        const code = ts.transpileModule(readFileSync(file, "utf8"), {
            compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        }).outputText;
        const module = { exports: {} };
        const safeRequire = (name) => {
            if (Object.hasOwn(mocks, name)) return mocks[name];
            if (["react", "react/jsx-runtime"].includes(name)) return require(name);
            throw new Error(`검사에서 서버 의존성 접근 금지: ${name}`);
        };
        vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { filename: file })(safeRequire, module, module.exports);
        return module.exports;
    }
    const photos = compile("src/lib/sessionPhotoEntries.ts");
    const privatePhoto = { id: "photo-private", type: "image", url: "https://invalid.example/private-leak.jpg", storageBucket: "staff-session-private", storagePath: "class/session/photo.jpg", visibility: "PRIVATE" };

    async function render({ user = true, parentId = "parent-own", published = true, children = [{ id: "child-own", name: "합성 학생" }], attendances = [{ studentId: "child-own", student_name: "합성 학생", status: "PRESENT" }], media = "[]" } = {}) {
        const queries = [];
        const responses = [published ? [{ id: "session-fixture", date: "2026-10-19", class_name: "합성 반", topic: "합성 리포트", photosJSON: media }] : [], children, attendances, []];
        const Page = compile("src/app/mypage/reports/[sessionId]/page.tsx", {
            "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user ? { id: "auth-fixture" } : null } }) } }) },
            "@/lib/prisma": { prisma: { $queryRawUnsafe: async (...args) => { queries.push(args); return responses.shift(); } } },
            "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: parentId }) },
            "next/navigation": { notFound() { throw missing; } },
            "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoId" IS NULL` },
            "next/link": { default: ({ children, ...props }) => React.createElement("a", props, children), __esModule: true },
            "@/components/parent/ReportPhoto": { default: Photo, __esModule: true },
            "@/lib/sessionPhotoEntries": photos,
        }).default;
        let tree;
        try { tree = await Page({ params: Promise.resolve({ sessionId: "session-fixture" }) }); }
        catch (error) { if (error === missing) return { denied: true, queries }; throw error; }
        const errors = [];
        const stream = await renderToReadableStream(tree, manifest, { onError: (error) => { errors.push(error.message); } });
        const output = await new Response(stream).text();
        return { denied: false, output, errors, queries };
    }

    test("실제 RSC는 서버 img 이벤트 처리기를 거부한다 (기존 오류 재현)", async () => {
        const errors = [];
        const stream = await renderToReadableStream(React.createElement("img", { src: "/photo.jpg", onError() {} }), manifest, { onError: (error) => { errors.push(error.message); } });
        await new Response(stream).text();
        assert.ok(errors.some((message) => message.includes("Event handlers cannot be passed")));
    });
    test("문자열 사진 리포트가 실제 RSC 직렬화를 통과한다", async () => {
        const result = await render({ media: JSON.stringify(["/uploads/fixture.jpg"]) });
        assert.deepEqual(result.errors, []);
        assert.ok(result.output.includes("/uploads/fixture.jpg"));
    });
    test("객체·문자열 혼합 사진은 비공개 프록시만 노출한다", async () => {
        const result = await render({ media: JSON.stringify(["/uploads/legacy.jpg", privatePhoto]) });
        assert.deepEqual(result.errors, []);
        assert.ok(result.output.includes("/uploads/legacy.jpg"));
        assert.ok(result.output.includes("/api/staff/sessions/session-fixture/photos/photo-private"));
        assert.ok(!result.output.includes("private-leak"));
        assert.ok(!result.output.includes("storagePath"));
        assert.ok(!result.output.includes("[object Object]"));
    });
    test("깨진 JSON·객체·null은 리포트를 깨뜨리지 않는다", async () => {
        for (const media of ["{bad", "{}", null, JSON.stringify([null, {}, ""])]) {
            const result = await render({ media });
            assert.deepEqual(result.errors, []);
            assert.ok(!result.output.includes("수업 사진"));
        }
    });
    test("미로그인은 사진·DB 조회 없이 로그인 안내만 받는다", async () => {
        const result = await render({ user: false, media: JSON.stringify([privatePhoto]) });
        assert.equal(result.queries.length, 0);
        assert.ok(result.output.includes("로그인이 필요합니다"));
        assert.ok(!result.output.includes("photo-private"));
    });
    test("부모 ID 미확인은 조회 전에 거부한다", async () => {
        const result = await render({ parentId: null });
        assert.equal(result.denied, true);
        assert.equal(result.queries.length, 0);
    });
    test("미발행 리포트는 자녀·사진 조회 전에 거부한다", async () => {
        const result = await render({ published: false });
        assert.equal(result.denied, true);
        assert.equal(result.queries.length, 1);
        assert.match(result.queries[0][0], /se\.published = true/);
    });
    test("자녀 없음·해당 수업 출석 없음은 사진을 노출하지 않는다", async () => {
        for (const options of [{ children: [] }, { attendances: [] }]) {
            const result = await render({ ...options, media: JSON.stringify([privatePhoto]) });
            assert.equal(result.denied, true);
            assert.ok(result.queries.length <= 3);
        }
    });
    test("자녀 조회·출석·개별 노트의 부모와 학생 매개변수를 유지한다", async () => {
        const result = await render();
        assert.deepEqual(result.queries[1].slice(1), ["parent-own"]);
        assert.deepEqual(result.queries[2].slice(1), ["session-fixture", "child-own"]);
        assert.deepEqual(result.queries[3].slice(1), ["session-fixture", "child-own"]);
        assert.match(result.queries[1][0], /s\."parentId" = \$1/);
        assert.match(result.queries[2][0], /a\."studentId" IN \(\$2\)/);
    });
}
