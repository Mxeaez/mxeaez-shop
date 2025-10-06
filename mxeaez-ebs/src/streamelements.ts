import axios from "axios";

const SE_BASE = "https://api.streamelements.com/kappa/v2";
const SE_JWT = process.env.SE_JWT!;
const SE_CHANNEL_ID = process.env.SE_CHANNEL_ID;
const SE_CHANNEL_LOGIN = process.env.SE_CHANNEL_LOGIN;

if (!SE_JWT) {
  console.warn("[EBS] WARNING: SE_JWT not set; coins will be 0.");
}

let cachedSeChannelId: string | null = SE_CHANNEL_ID || null;

async function getSeChannelId(): Promise<string> {
  if (cachedSeChannelId) return cachedSeChannelId;
  if (!SE_CHANNEL_LOGIN) throw new Error("Set SE_CHANNEL_ID or SE_CHANNEL_LOGIN");
  const r = await axios.get(`${SE_BASE}/channels/${SE_CHANNEL_LOGIN}`);
  cachedSeChannelId = r.data?._id;
  if (!cachedSeChannelId) throw new Error("Unable to resolve StreamElements channel id");
  return cachedSeChannelId;
}

// 30s in-memory cache for points to reduce API calls
const pointsCache = new Map<string, { v: number; t: number }>();
const POINTS_TTL_MS = 30_000;

export async function getSePoints(twitchLogin: string): Promise<number> {
  if (!SE_JWT) return 0;
  const ch = await getSeChannelId();
  const key = `${ch}:${twitchLogin}`;
  const now = Date.now();
  const hit = pointsCache.get(key);
  if (hit && now - hit.t < POINTS_TTL_MS) return hit.v;

  const r = await axios.get(`${SE_BASE}/points/${ch}/${twitchLogin}`, {
    headers: { Authorization: `Bearer ${SE_JWT}` },
  });
  const pts = r.data?.points ?? 0;
  pointsCache.set(key, { v: pts, t: now });
  return pts;
}

export async function setSePoints(twitchLogin: string, newValue: number): Promise<void> {
  if (!SE_JWT) return;
  const ch = await getSeChannelId();
  const val = Math.max(0, Math.floor(newValue));
  await axios.put(
    `${SE_BASE}/points/${ch}/${twitchLogin}/${val}`,
    {},
    { headers: { Authorization: `Bearer ${SE_JWT}` } }
  );
  pointsCache.set(`${ch}:${twitchLogin}`, { v: val, t: Date.now() });
}

export async function addUserPointsDelta(
  login: string,
  delta: number,
  currentKnown?: number
): Promise<number> {
  if (!SE_JWT) return currentKnown ?? 0;
  const ch = await getSeChannelId();
  const amount = Math.trunc(delta);

  await axios.put(
    `${SE_BASE}/points/${ch}/${login}/${amount}`,
    {},
    { headers: { Authorization: `Bearer ${SE_JWT}` } }
  );

  // keep cache in sync
  const key = `${ch}:${login}`;
  const base = typeof currentKnown === "number" ? currentKnown : await getSePoints(login);
  const next = base + amount;
  pointsCache.set(key, { v: next, t: Date.now() });
  return next;
}