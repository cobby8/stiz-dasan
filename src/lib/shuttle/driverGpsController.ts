export type GpsState = "off" | "requesting" | "active" | "denied" | "error";
export type GpsTransmission = "idle" | "sending" | "sent" | "error" | "stopping" | "stopped" | "stop-unknown";
export type GpsSnapshot = { state: GpsState; transmission: GpsTransmission; lastSentAt: Date | null; accuracy: number | null; lastLocationAt: Date | null };

/** 위치 획득과 서버 접수는 별개다. 테스트에서는 위치·통신·시계를 가짜로 주입한다. */
export function createDriverGpsController(options: {
  geolocation: Geolocation | undefined;
  publish: (snapshot: GpsSnapshot) => void;
  credentials: () => { token: string; label?: string };
  request?: typeof fetch;
  now?: () => number;
  every?: typeof setInterval;
  clear?: typeof clearInterval;
}) {
  const request = options.request ?? fetch;
  const now = options.now ?? Date.now;
  let snapshot: GpsSnapshot = { state: "off", transmission: "idle", lastSentAt: null, accuracy: null, lastLocationAt: null };
  let generation = 0, watching = false, disposed = false, stopping = false;
  let watchId: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let position: GeolocationPosition | null = null;
  let pending: Promise<boolean> | null = null;
  const publish = (update: Partial<GpsSnapshot>) => {
    snapshot = { ...snapshot, ...update };
    if (!disposed) options.publish(snapshot);
  };
  const clearDevice = () => {
    if (watchId !== null) options.geolocation?.clearWatch(watchId);
    if (timer !== null) (options.clear ?? clearInterval)(timer);
    watchId = null; timer = null; watching = false;
  };
  async function post(pos: GeolocationPosition, sharing: boolean) {
    const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
    try {
      const response = await request("/api/driver/location", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...options.credentials(), lat, lng, accuracy, speed, heading, sharing }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = await response.json();
      return response.ok && data?.ok === true;
    } catch { return false; }
  }
  function send() {
    if (!watching || !position || pending) return;
    const pos = position, current = generation;
    publish({ transmission: "sending" });
    const task = post(pos, true);
    pending = task;
    void task.then((ok) => {
      if (generation !== current || !watching || disposed) return;
      publish(ok ? { transmission: "sent", lastSentAt: new Date(now()), accuracy: pos.coords.accuracy } : { transmission: "error" });
    }).finally(() => { if (pending === task) pending = null; });
  }
  return {
    start() {
      if (stopping || disposed) return;
      if (watching && snapshot.state !== "error" && snapshot.state !== "denied") return;
      clearDevice();
      if (!options.geolocation) { publish({ state: "error" }); return; }
      generation++; watching = true; position = null;
      const current = generation;
      publish({ state: "requesting", transmission: "idle", lastSentAt: null, lastLocationAt: null, accuracy: null });
      try {
      watchId = options.geolocation.watchPosition((pos) => {
        if (!watching || generation !== current) return;
        const first = position === null;
        position = pos;
        publish({ state: "active", lastLocationAt: new Date(now()) });
        if (first) send();
      }, (error) => {
        if (!watching || generation !== current) return;
        if (error.code === 1) { generation++; clearDevice(); }
        publish({ state: error.code === 1 ? "denied" : "error" });
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
      } catch {
        generation++; clearDevice(); publish({ state: "error", transmission: "error" }); return;
      }
      if (!watching) { clearDevice(); return; }
      timer = (options.every ?? setInterval)(() => {
        if (snapshot.lastLocationAt && now() - snapshot.lastLocationAt.getTime() > 30_000) {
          publish({ state: "error", transmission: "error" });
          return;
        }
        send();
      }, 10_000);
    },
    async stop() {
      if (stopping || disposed) return false;
      stopping = true; generation++; clearDevice();
      publish({ state: "off", transmission: "stopping" });
      const inFlightOk = pending ? await pending : true;
      // 위치를 얻지 못해 서버에 요청하지 않았다면 서버 중단 접수도 증명할 수 없다.
      const ok = position ? await post(position, false) : false;
      position = null; stopping = false;
      publish({ state: "off", transmission: ok && inFlightOk ? "stopped" : "stop-unknown" });
      return ok && inFlightOk;
    },
    dispose() { disposed = true; generation++; clearDevice(); },
  };
}
