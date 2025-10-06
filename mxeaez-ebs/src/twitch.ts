import axios from "axios";

const TW_CLIENT_ID = process.env.TWITCH_CLIENT_ID!;
const TW_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET!;

// ---------- App token (cached) ----------
let appToken: { token: string; exp: number } | null = null;

async function getAppToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (appToken && appToken.exp > now + 60) return appToken.token;

  const r = await axios.post(
    "https://id.twitch.tv/oauth2/token",
    new URLSearchParams({
      client_id: TW_CLIENT_ID,
      client_secret: TW_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  appToken = { token: r.data.access_token, exp: now + (r.data.expires_in || 3600) };
  return appToken.token;
}

// ---------- Minimal Helix user type ----------
export type HelixUser = {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
};

// Small in-memory cache for /users lookups
type CacheEntry<T> = { value: T; exp: number };
const loginCache = new Map<string, CacheEntry<HelixUser | null>>();
const idLoginCache = new Map<string, CacheEntry<string>>(); // for getLoginFromUserId
const CACHE_TTL_SEC = 5 * 60; // 5 minutes

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const now = Math.floor(Date.now() / 1000);
  const hit = map.get(key);
  if (hit && hit.exp > now) return hit.value;
  if (hit) map.delete(key);
  return undefined;
}
function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T) {
  const now = Math.floor(Date.now() / 1000);
  map.set(key, { value, exp: now + CACHE_TTL_SEC });
}

// ---------- Low-level Helix GET ----------
async function helixGet<T = any>(path: string): Promise<T> {
  if (!TW_CLIENT_ID || !TW_CLIENT_SECRET) {
    throw new Error("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set");
  }
  const token = await getAppToken();
  const r = await axios.get<T>(`https://api.twitch.tv/helix${path}`, {
    headers: { "Client-ID": TW_CLIENT_ID, Authorization: `Bearer ${token}` },
  });
  return r.data;
}

// ---------- Existing helper (kept) ----------
export async function getLoginFromUserId(userId: string): Promise<string> {
  if (!TW_CLIENT_ID || !TW_CLIENT_SECRET) return "";
  // cache hit?
  const cached = getCached(idLoginCache, userId);
  if (typeof cached === "string") return cached;

  const data: any = await helixGet(`/users?id=${encodeURIComponent(userId)}`);
  const u = data?.data?.[0];
  const login = (u?.login || "").toLowerCase();

  if (login) setCached(idLoginCache, userId, login);
  return login;
}

// ---------- New helper: get full user by login ----------
export async function getUserByLogin(login: string): Promise<HelixUser | null> {
  const key = login.trim().toLowerCase();
  if (!key) return null;

  const cached = getCached(loginCache, key);
  if (cached !== undefined) return cached;

  const data: any = await helixGet(`/users?login=${encodeURIComponent(key)}`);
  const u = data?.data?.[0];
  if (!u) {
    setCached(loginCache, key, null);
    return null;
  }
  const user: HelixUser = {
    id: String(u.id),
    login: String(u.login || key).toLowerCase(),
    display_name: String(u.display_name || u.login || key),
    profile_image_url: String(u.profile_image_url || ""),
  };
  setCached(loginCache, key, user);
  return user;
}
