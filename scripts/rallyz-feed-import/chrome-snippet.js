/*
 * 랠리즈 수업 피드 뽑기 — 크롬 콘솔(F12 → Console)에 «통째로» 붙여넣고 Enter. (읽기만 합니다. 랠리즈에 쓰지 않습니다.)
 * 순서는 docs/rallyz-feed-import.md «1. 피드 JSON 뽑기».
 *
 * 1) rallyz.co.kr/v3/main 에 로그인한 탭에서 이 코드를 붙여넣는다 → «헤더 수집 시작»
 * 2) 화면에서 피드(소식) 메뉴를 한 번 눌러 목록이 뜨게 한다 → 콘솔에 «헤더 확보» 가 나오면 준비 끝
 * 3) 콘솔에 입력:  rzExport()                 ← 모든 반(서버가 classId 빈 값을 «전체»로 받는 경우)
 *    안 되면:     rzExport({ classIds: ["반id1", "반id2"] })   ← 반 id 는 rzSeenClassIds() 로 확인
 *    진행 상황:   rzProgress()
 * 4) 끝나면 «rallyz-feed-2026.json» 이 다운로드 폴더에 저장된다
 * 5) 영상 주소 틀: 피드에서 영상 하나를 재생한 뒤 rzHlsTemplate() → 출력된 한 줄을 복사해 둔다
 *
 * 주의: 헤더는 «한 벌»만 보낸다(같은 이름이 두 번 가면 랠리즈가 오류 007). 그래서 Headers.set 으로 덮어쓴다.
 */
(() => {
  const RZ = (window.__rz = window.__rz || { headers: {}, classIds: new Set(), progress: null, result: null });
  if (!window.__rzHooked) {
    const open = XMLHttpRequest.prototype.open;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__rzUrl = String(url || ""); return open.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (/api\.rallyz\.co\.kr/.test(this.__rzUrl)) {
        const had = Object.keys(RZ.headers).length;
        RZ.headers[k] = v; // 같은 이름은 마지막 값 하나만
        if (!had) console.log("[rz] 헤더 확보 — 이제 rzExport() 를 입력하세요.");
      }
      return setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      // 화면이 보내는 피드 요청에서 반 id 를 모아 둔다(rzSeenClassIds)
      try { if (/findFeed/.test(this.__rzUrl) && body) { const b = JSON.parse(body); if (b.classId) RZ.classIds.add(b.classId); } } catch { /* 무시 */ }
      return send.apply(this, arguments);
    };
    window.__rzHooked = true;
  }
  console.log("[rz] 헤더 수집 시작 — 화면에서 피드(소식) 메뉴를 한 번 눌러 주세요.");

  /** 응답 안에서 «글 목록» 배열 찾기(필드 이름이 바뀌어도) */
  function findList(json, depth = 0) {
    if (!json || depth > 5) return null;
    if (Array.isArray(json)) return json.length && typeof json[0] === "object" ? json : null;
    if (typeof json === "object") {
      for (const v of Object.values(json)) { const hit = findList(v, depth + 1); if (hit) return hit; }
    }
    return null;
  }
  const itemId = (x) => String(x.feedId ?? x.feedSeq ?? x.boardId ?? x.boardSeq ?? x.id ?? x.seq ?? JSON.stringify(x).slice(0, 80));

  async function fetchPage(classId, page) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(RZ.headers)) headers.set(k, v); // 한 벌만
    headers.set("Content-Type", "application/json");
    const res = await fetch("https://api.rallyz.co.kr/board/findFeed/all", {
      method: "POST", headers, body: JSON.stringify({ classId, page, currentPage: page, pageNo: page }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** 모든 페이지를 돈다 — 빈 페이지거나, 새 글이 하나도 없는 페이지(같은 페이지 반복)가 나오면 그 반은 끝 */
  window.rzExport = async function ({ classIds = [""], maxPages = 400, stopBeforeYear = 2026 } = {}) {
    if (!Object.keys(RZ.headers).length) { console.warn("[rz] 헤더가 아직 없습니다. 피드 메뉴를 한 번 눌러 주세요."); return; }
    const items = [];
    const seen = new Set();
    RZ.progress = { classIndex: 0, classTotal: classIds.length, page: 0, items: 0, done: false, error: null };
    try {
      for (let ci = 0; ci < classIds.length; ci += 1) {
        RZ.progress.classIndex = ci + 1;
        for (let page = 1; page <= maxPages; page += 1) {
          RZ.progress.page = page;
          const json = await fetchPage(classIds[ci], page);
          const list = findList(json) || [];
          let fresh = 0;
          let oldest = "9999";
          for (const x of list) {
            const id = itemId(x);
            const when = String(x.regDt ?? x.regDate ?? x.createDt ?? x.createdAt ?? x.insDt ?? "");
            if (when && when < oldest) oldest = when;
            if (seen.has(id)) continue;
            seen.add(id); items.push(x); fresh += 1;
          }
          RZ.progress.items = items.length;
          if (!list.length || !fresh) break;
          // 작년 글까지 내려왔으면 그 반은 끝(2026 년만 옮긴다)
          if (/^\d{4}/.test(oldest) && Number(oldest.slice(0, 4)) < stopBeforeYear) break;
          await new Promise((r) => setTimeout(r, 300)); // 서버 배려
        }
      }
      RZ.result = { source: "rallyz board/findFeed/all", exportedAt: new Date().toISOString(), classIds, count: items.length, items };
      const blob = new Blob([JSON.stringify(RZ.result)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "rallyz-feed-2026.json";
      a.click();
      RZ.progress.done = true;
      console.log(`[rz] 끝 — 글 ${items.length}개를 rallyz-feed-2026.json 으로 저장했습니다.`);
    } catch (e) {
      RZ.progress.error = String(e && e.message || e);
      console.error("[rz] 실패:", e, "— 헤더가 두 벌인지(오류 007), 로그인이 풀렸는지 확인하세요.");
    }
  };
  window.rzProgress = () => console.log(JSON.stringify(RZ.progress));
  window.rzSeenClassIds = () => console.log([...RZ.classIds]);
  /** 재생해 본 영상의 HLS 주소에서 «틀»을 만든다: 영상 id 자리를 {id} 로 */
  window.rzHlsTemplate = () => {
    const hit = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /feed_vod_bc\/.+\.m3u8/.test(n));
    if (!hit) { console.warn("[rz] 아직 재생한 영상이 없습니다. 피드에서 영상 하나를 재생한 뒤 다시 입력하세요."); return; }
    const template = hit.replace(/feed_vod_bc\/([A-Za-z0-9_-]+?)(_AVC_[A-Z]+)?\.mp4\/[^?]*\.m3u8/, "feed_vod_bc/{id}_AVC_HD.mp4/index.m3u8");
    console.log(template);
    return template;
  };
})();
