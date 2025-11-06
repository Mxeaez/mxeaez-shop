import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";
import { WebSocketServer, WebSocket } from "ws";
import admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { ITEMS, GRANT_ONLY_IDS } from "./items";
import { verifyTwitchToken } from "./auth";
import { getSePoints, addUserPointsDelta } from "./streamelements";
import { getLoginFromUserId, getUserByLogin, getUserById } from "./twitch";
import path = require("path");

// ---- Firebase Admins
try {
  admin.app();
} catch {
  admin.initializeApp();
}
const db = admin.firestore();

const ALLOW_ORIGINS = [
  /^https:\/\/extensions\.twitch\.tv$/, // some panels render from here
  /^https:\/\/localhost\.twitch\.tv$/, // Hosted Test
  /^https:\/\/([a-z0-9-]+\.)*ext-twitch\.tv$/, // your panel CDN subdomain
  /^https:\/\/([a-z0-9-]+\.)*twitch\.tv$/, // twitch site (broad, safe)
  /^http:\/\/localhost(:\d+)?$/, // local dev
  /^http:\/\/127\.0\.0\.1(:\d+)?$/, // local dev
];

// ---- Express
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = ALLOW_ORIGINS.some((re) => re.test(origin));

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    // Echo back whatever the browser asked to send
    const acrh = req.headers["access-control-request-headers"];
    res.setHeader(
      "Access-Control-Allow-Headers",
      (typeof acrh === "string" && acrh) || "authorization, content-type, x-requested-with"
    );
    const acrm = req.headers["access-control-request-method"];
    res.setHeader(
      "Access-Control-Allow-Methods",
      (typeof acrm === "string" && acrm) || "GET, POST, OPTIONS"
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(allowed ? 204 : 403);
  }
  next();
});
app.use(express.static(path.join(process.cwd(), "public")));

// Paths
const userDoc = (channelId: string, opaqueUserId: string) =>
  db.doc(`channels/${channelId}/users/${opaqueUserId}`);
const invCol = (channelId: string, opaqueUserId: string) =>
  userDoc(channelId, opaqueUserId).collection("inventory");
const redemptionsCol = (channelId: string) =>
  db.collection(`channels/${channelId}/redemptions`);

const KC_DELTAS: Record<string, number> = {
  kc_1000: 1000,
  kc_5000: 5000,
  kc_25000: 25000,
  kc_50000: 50000,
};

type Rarity = "Common" | "Rare" | "Unique" | "Legendary";

// Odds as you requested
const BOX_ODDS = {
  Legendary: 1 / 5000,
  Unique: 1 / 25,
  Rare: 1 / 5,
} as const;

function chooseRarity(): Rarity {
  const r = Math.random();
  const pL = BOX_ODDS.Legendary;
  const pU = BOX_ODDS.Unique;
  const pR = BOX_ODDS.Rare;
  if (r < pL) return "Legendary";
  if (r < pL + pU) return "Unique";
  if (r < pL + pU + pR) return "Rare";
  return "Common";
}

function pickMysteryPrize() {
  // If you *do* want to exclude some specific ids, add them to this set.
  const EXCLUDE = new Set<string>(["mystery_box"]);

  // Pool now contains all items except the box itself (grant-only items included)
  const pool = ITEMS.filter((i) => !EXCLUDE.has(i.id));

  const want = chooseRarity();
  const order: Rarity[] =
    want === "Legendary"
      ? ["Legendary", "Unique", "Rare", "Common"]
      : want === "Unique"
      ? ["Unique", "Rare", "Common"]
      : want === "Rare"
      ? ["Rare", "Common"]
      : ["Common"];

  for (const r of order) {
    const bucket = pool.filter((i) => i.rarity === r);
    if (bucket.length) {
      return bucket[Math.floor(Math.random() * bucket.length)];
    }
  }

  // Absolute fallback (shouldn’t happen): anything except the box itself
  const any = ITEMS.filter((i) => i.id !== "mystery_box");
  return any[Math.floor(Math.random() * any.length)];
}

const ADMIN_CHANNEL_ID = (process.env.ADMIN_CHANNEL_ID || "").trim();
const ADMIN_KEY_RAW = (process.env.ADMIN_KEY || "").trim();
const ADMIN_USERS_RAW = (process.env.ADMIN_USERS || "").trim();

const ADMIN_USERS = ADMIN_USERS_RAW.split(/[;,]/)
  .map((s) => s.replace(/\\,/g, ",").trim().toLowerCase())
  .filter(Boolean);

// --- API: catalog
app.get("/catalog", (_req, res) => {
  const sellable = ITEMS.filter((i) => !GRANT_ONLY_IDS.includes(i.id));
  res.json(sellable);
});

app.get("/items-index", (_req, res) => {
  // Optionally strip fields you don't want to expose
  res.json(ITEMS);
});

// --- API: me (coins + inventory list)
app.get("/me", async (req, res) => {
  try {
    const claims = verifyTwitchToken(req.headers.authorization || "");
    const channelId = claims.channel_id;
    const opaqueUserId = claims.opaque_user_id;
    const twitchUserId: string | undefined = (claims as any).user_id;
    let login: string | undefined;

    let coins = 0;
    let needsIdShare = true;

    if (twitchUserId) {
      needsIdShare = false;
      login = await getLoginFromUserId(twitchUserId); // from twitch.ts
      console.log("[/me] user_id:", twitchUserId);
      console.log("[/me] login:", login);
      if (login) coins = await getSePoints(login); // from streamelements.ts
    }

    // keep a simple profile/presence doc we can query later
    await db
      .collection("channels")
      .doc(claims.channel_id)
      .collection("users")
      .doc(claims.opaque_user_id)
      .set(
        {
          opaqueUserId: claims.opaque_user_id,
          userId: (claims as any).user_id || null,
          login: login || null,
          lastSeen: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    // Inventory unchanged
    const invSnap = await db
      .collection("channels")
      .doc(channelId)
      .collection("users")
      .doc(opaqueUserId)
      .collection("inventory")
      .get();

    const allowed = new Set<string>(ITEMS.map((i) => i.id));

    const inventory = invSnap.docs
      .map((d) => ({
        id: d.get("itemId") as string,
        acquiredAt: d.get("acquiredAt")?.toMillis?.() ?? Date.now(),
      }))
      .filter((e) => allowed.has(e.id));

    res.json({ coins, inventory, needsIdShare });
  } catch (e) {
    console.error("[/me]", e);
    res.status(200).json({ coins: 0, inventory: [], needsIdShare: false });
  }
});

// -------- ADMIN API --------
app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "admin.html"));
});

// List latest redemptions (with joined names/icons where we can)
app.get("/admin/redemptions", requireAdmin, async (req, res) => {
  try {
    const channelId = getChannelId(req);
    if (!channelId)
      return res.status(400).json({ error: "channel_id not configured" });
    const limit = Math.min(Number(req.query.limit || 50), 200);
    if (!channelId)
      return res.status(400).json({ error: "channel_id required" });

    const snap = await redemptionsCol(channelId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const rows = await Promise.all(
      snap.docs.map(async (d) => {
        const r = d.data() || {};
        const v = r.viewer || {};

        let login = v.login || r.login || null;
        let displayName = v.displayName || null;
        let avatar = v.avatar || null;

        return {
          id: d.id,
          itemId: r.itemId,
          itemName: r.itemName || r.itemId,
          createdAt: r.createdAt?.toMillis?.() || Date.now(),
          awardedPoints: r.awardedPoints || 0,
          target: r.target || null,
          text: r.text || null,
          viewer: {
            login,
            displayName,
            avatar,
            userId: v.userId || r.userId || null,
            opaqueUserId: v.opaqueUserId || r.opaqueUserId || null,
          },
        };
      })
    );

    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/ping", requireAdmin, (req, res) => {
  res.json({ ok: true, who: (req as any).adminUser });
});

// Refund a redemption: give item back + reverse SE points if present
app.post("/admin/refund", requireAdmin, async (req, res) => {
  try {
    const channelId = getChannelId(req);
    if (!channelId)
      return res.status(400).json({ error: "channel_id not configured" });
    const redemptionId = String(req.body.redemption_id || "");
    if (!channelId || !redemptionId)
      return res
        .status(400)
        .json({ error: "channel_id and redemption_id required" });

    const doc = await redemptionsCol(channelId).doc(redemptionId).get();
    if (!doc.exists)
      return res.status(404).json({ error: "redemption not found" });
    const r = doc.data()!;

    const opaque = r.opaqueUserId || r.viewer?.opaqueUserId;
    if (!opaque)
      return res.status(400).json({ error: "no opaqueUserId on redemption" });

    // Give item back
    await invCol(channelId, opaque).add({
      itemId: r.itemId,
      acquiredAt: FieldValue.serverTimestamp(),
    });

    // Reverse SE points if any
    const login = r.viewer?.login || null;
    const delta = Number(r.awardedPoints || 0);
    if (login && delta > 0) {
      await addUserPointsDelta(login, -delta);
    }

    // Optional: mark redemption as refunded
    await redemptionsCol(channelId)
      .doc(redemptionId)
      .set({ refundedAt: FieldValue.serverTimestamp() }, { merge: true });

    // Optional: notify overlay
    broadcastToChannel(channelId, {
      type: "refund",
      itemId: r.itemId,
      viewer: r.viewer || null,
      at: Date.now(),
    });

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Search user by login (resolve to our known profile)
app.get("/admin/users/search", requireAdmin, async (req, res) => {
  try {
    const channelId = getChannelId(req);
    if (!channelId)
      return res.status(400).json({ error: "channel_id not configured" });
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();
    if (!channelId || !q)
      return res.status(400).json({ error: "channel_id and q required" });

    // Try Helix by login, then map to a recent presence with same userId (if any)
    const u = await getUserByLogin(q);
    if (!u) return res.json([]);
    const userId = u.id;

    // Look for any opaque with this userId in our presence docs
    const snap = await db
      .collection("channels")
      .doc(channelId)
      .collection("users")
      .where("userId", "==", userId)
      .limit(5)
      .get();

    const rows = snap.docs.map((d) => {
      const x = d.data();
      return {
        login: u.login,
        display_name: u.display_name || u.login,
        avatar: u.profile_image_url || null,
        userId: userId,
        opaqueUserId: x?.opaqueUserId || d.id,
        lastSeen: x?.lastSeen?.toMillis?.() || null,
      };
    });

    // If none found, still return Helix user so you can grant SE coins at least
    if (!rows.length) {
      rows.push({
        login: u.login,
        display_name: u.display_name || u.login,
        avatar: u.profile_image_url || null,
        userId: userId,
        opaqueUserId: null,
        lastSeen: null,
      });
    }

    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Grant items to a specific user (by opaque if we have it, else reject)
app.post("/admin/grant-item", requireAdmin, async (req, res) => {
  try {
    const channelId = getChannelId(req);
    if (!channelId)
      return res.status(400).json({ error: "channel_id not configured" });
    const itemId = String(req.body.itemId || "");
    const qty = Math.max(1, Number(req.body.qty || 1));
    const opaque = String(req.body.opaqueUserId || "");
    if (!channelId || !itemId || !opaque)
      return res
        .status(400)
        .json({ error: "channel_id, itemId, opaqueUserId required" });

    const item = ITEMS.find((i) => i.id === itemId);
    if (!item) return res.status(400).json({ error: "unknown itemId" });

    const batch = db.batch();
    const col = invCol(channelId, opaque);
    for (let i = 0; i < qty; i++) {
      batch.set(col.doc(), {
        itemId,
        acquiredAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    // notify the specific viewer's panel to refresh
    broadcastToChannel(channelId, {
      type: "grant",
      itemId,
      qty,
      targetOpaque: opaque, // so only that viewer refreshes (panel will check)
      at: Date.now(),
    });

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Grant item to all active viewers (last N minutes)
app.post("/admin/grant-item-all", requireAdmin, async (req, res) => {
  try {
    const channelId = getChannelId(req);
    if (!channelId)
      return res.status(400).json({ error: "channel_id not configured" });
    const itemId = String(req.body.itemId || "");
    const qty = Math.max(1, Number(req.body.qty || 1));
    const minutes = Math.max(
      1,
      Math.min(120, Number(req.body.sinceMinutes || 5))
    );
    if (!channelId || !itemId)
      return res.status(400).json({ error: "channel_id and itemId required" });

    const item = ITEMS.find((i) => i.id === itemId);
    if (!item) return res.status(400).json({ error: "unknown itemId" });

    const since = new Date(Date.now() - minutes * 60_000);
    const snap = await db
      .collection("channels")
      .doc(channelId)
      .collection("users")
      .where("lastSeen", ">=", since)
      .get();

    const writeBatchLimit = 400; // conservative (Firestore 500)
    let count = 0;
    let batch = db.batch();
    for (const d of snap.docs) {
      const opaque = d.id;
      const col = invCol(channelId, opaque);
      for (let i = 0; i < qty; i++) {
        batch.set(col.doc(), {
          itemId,
          acquiredAt: FieldValue.serverTimestamp(),
        });
        count++;
        if (count % writeBatchLimit === 0) {
          await batch.commit();
          batch = db.batch();
        }
      }
    }
    await batch.commit();
    // ping all panels to refresh (we can't target just the subset easily here)
    broadcastToChannel(channelId, {
      type: "grant_all",
      itemId,
      qty,
      at: Date.now(),
    });

    res.json({ ok: true, granted: count, viewers: snap.size, minutes });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Give SE coins to a specific user (by login)
app.post("/admin/grant-coins", requireAdmin, async (req, res) => {
  try {
    const login = String(req.body.login || "").toLowerCase();
    const amount = Number(req.body.amount || 0);
    if (!login || !amount)
      return res.status(400).json({ error: "login and amount required" });

    await addUserPointsDelta(login, amount);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Give SE coins to all active viewers (by presence -> login)
app.post("/admin/grant-coins-all", requireAdmin, async (req, res) => {
  try {
    const channelId = getChannelId(req);
    if (!channelId)
      return res.status(400).json({ error: "channel_id not configured" });
    const amount = Number(req.body.amount || 0);
    const minutes = Math.max(
      1,
      Math.min(120, Number(req.body.sinceMinutes || 5))
    );
    if (!channelId || !amount)
      return res.status(400).json({ error: "channel_id and amount required" });

    const since = new Date(Date.now() - minutes * 60_000);
    const snap = await db
      .collection("channels")
      .doc(channelId)
      .collection("users")
      .where("lastSeen", ">=", since)
      .get();

    let granted = 0;
    for (const d of snap.docs) {
      const u = d.data();
      const login = u?.login;
      if (!login) continue; // can only grant SE coins by login
      await addUserPointsDelta(login, amount);
      granted++;
    }
    res.json({ ok: true, granted, viewers: snap.size, minutes });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/items", requireAdmin, (req, res) => {
  // send everything; the admin UI can show labels
  res.json({
    items: ITEMS,
    grantOnlyIds: GRANT_ONLY_IDS,
  });
});

// --- API: buy
app.post("/buy", async (req, res) => {
  try {
    const claims = verifyTwitchToken(req.headers.authorization || "");
    const { itemId } = req.body as { itemId: string };
    const channelId = claims.channel_id;
    const opaqueUserId = claims.opaque_user_id;
    const twitchUserId: string | undefined = (claims as any).user_id;

    const item = ITEMS.find((i: any) => i.id === itemId); // however you store catalog
    if (GRANT_ONLY_IDS.includes(item.id)) {
      return res
        .status(403)
        .json({ ok: false, error: "This item is not sold in the shop." });
    }
    if (!item)
      return res.status(400).json({ ok: false, error: "Unknown item" });

    if (!twitchUserId) {
      return res
        .status(403)
        .json({ ok: false, error: "Sign in to spend points" });
    }
    const login = await getLoginFromUserId(twitchUserId);
    if (!login)
      return res
        .status(403)
        .json({ ok: false, error: "Twitch login not found" });

    const current = await getSePoints(login);
    if (current < item.cost) {
      return res.status(400).json({ ok: false, error: "Not enough points" });
    }

    // Deduct in StreamElements
    await addUserPointsDelta(login, -item.cost, current);

    // Grant item in Firestore (unchanged)
    await db
      .collection("channels")
      .doc(channelId)
      .collection("users")
      .doc(opaqueUserId)
      .collection("inventory")
      .add({
        itemId,
        acquiredAt: FieldValue.serverTimestamp(),
      });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[/buy]", e);
    return res.status(500).json({ ok: false, error: "Purchase failed" });
  }
});

// --- API: redeem
app.post("/redeem", async (req, res) => {
  try {
    const claims = verifyTwitchToken(req.headers.authorization || "");
    const itemId = String(req.body.itemId || "");
    const target = (req.body && req.body.target) || null; // e.g., timeout target
    const text = (req.body && req.body.text) || null; // e.g., TTS text
    if (!itemId) return res.status(400).json({ error: "itemId required" });

    // ✅ Define the item FIRST (prevents "Cannot access 'item' before initialization")
    const item = ITEMS.find((i) => i.id === itemId);
    if (!item) return res.status(400).json({ error: "Unknown itemId" });

    const channelId = claims.channel_id;
    const opaque = claims.opaque_user_id;
    const twitchUserId: string | null = (claims as any).user_id || null;

    // Build rich viewer meta before any transaction
    const viewer = {
      opaqueUserId: opaque || null,
      userId: twitchUserId,
      login: null as string | null,
      displayName: null as string | null,
      avatar: null as string | null,
    };

    if (twitchUserId) {
      try {
        const u = await getUserById(twitchUserId);
        if (u) {
          viewer.login = u.login || null;
          viewer.displayName = u.displayName || u.login || null;
          viewer.avatar = u.profileImageUrl || null;
        }
      } catch (e) {
        console.warn("[redeem] getUserById failed:", (e as any)?.message);
      }
    }

    // If we still don't have a login but we have presence, try presence doc (optional)
    if (!viewer.login && opaque) {
      try {
        const pres = await db
          .collection("channels")
          .doc(channelId)
          .collection("users")
          .doc(opaque)
          .get();
        viewer.login = pres.data()?.login || viewer.login;
      } catch {}
    }

    // Find and delete the latest inventory doc for this item
    const col = db
      .collection("channels")
      .doc(channelId)
      .collection("users")
      .doc(opaque)
      .collection("inventory");
    const q = await col
      .where("itemId", "==", itemId)
      .orderBy("acquiredAt", "desc")
      .limit(1)
      .get();

    if (q.empty)
      return res.status(400).json({ error: "No such item in inventory" });

    const invDocRef = q.docs[0].ref;

    // Write the redemption row (rich viewer + keep legacy fields)
    await db.runTransaction(async (tx) => {
      tx.delete(invDocRef);
      tx.set(
        db
          .collection("channels")
          .doc(channelId)
          .collection("redemptions")
          .doc(),
        {
          itemId,
          itemName: item.name,
          target: target || null,
          text: text || null,
          createdAt: FieldValue.serverTimestamp(),

          // rich nested viewer (future-proof)
          viewer,

          // legacy top-level fields (keep old code working)
          opaqueUserId: viewer.opaqueUserId,
          userId: viewer.userId,
          login: viewer.login,
        }
      );
    });

    // ---- KC award (optional; only if it’s one of the KC items)
    let awardedPoints = 0;

    const grant = KC_DELTAS[itemId] ?? 0; // <-- define grant here
    if (grant > 0 && twitchUserId) {
      try {
        if (viewer.login) {
          await addUserPointsDelta(viewer.login, grant); // positive delta adds points
          awardedPoints = grant;
        }
      } catch (e) {
        console.error("[redeem] KC grant failed", e);
      }
    }

    // Optional: Mystery Box prize after the transaction
    let prizeId: string | undefined;
    if (itemId === "mystery_box") {
      const prize = pickMysteryPrize();
      prizeId = prize.id;

      await db
        .collection("channels")
        .doc(claims.channel_id)
        .collection("users")
        .doc(claims.opaque_user_id)
        .collection("inventory")
        .add({ itemId: prize.id, acquiredAt: FieldValue.serverTimestamp() });

      broadcastToChannel(claims.channel_id, {
        type: "mystery",
        prizeId: prize.id,
        prizeName: prize.name,
        rarity: prize.rarity,
        at: Date.now(),
      });
    }
    // Notify bridges/overlay/admin listeners
    broadcastToChannel(channelId, {
      type: "redeem",
      channelId,
      itemId,
      itemName: item.name,
      viewer, // includes login/displayName/avatar now
      target: target || null,
      text: text || null,
      at: Date.now(),
    });

    return res.json({ ok: true, prizeId });
  } catch (e: any) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/sell", async (req, res) => {
  try {
    const claims = verifyTwitchToken(req.headers.authorization || "");
    const channelId = claims.channel_id;
    const opaqueUserId = claims.opaque_user_id;
    const twitchUserId: string | undefined = (claims as any).user_id;

    const { itemId } = req.body as { itemId: string };
    const item = ITEMS.find((i) => i.id === itemId);
    if (!item)
      return res.status(400).json({ ok: false, error: "Unknown item" });

    // Require identity so we can credit points
    if (!twitchUserId) {
      return res
        .status(403)
        .json({ ok: false, error: "Share identity to sell items" });
    }

    // Find newest matching inventory doc and delete it
    const invCol = db
      .collection("channels")
      .doc(channelId)
      .collection("users")
      .doc(opaqueUserId)
      .collection("inventory");

    const snap = await invCol
      .where("itemId", "==", itemId)
      .orderBy("acquiredAt", "desc")
      .limit(1)
      .get();

    if (snap.empty)
      return res.status(400).json({ ok: false, error: "No item to sell" });

    await db.runTransaction(async (tx) => {
      tx.delete(snap.docs[0].ref);
    });

    // Credit the user StreamElements points equal to the item’s cost
    const login = await getLoginFromUserId(twitchUserId);
    if (!login)
      return res
        .status(403)
        .json({ ok: false, error: "Could not resolve Twitch login" });

    const current = await getSePoints(login);
    const awardedPoints = item.cost;
    await addUserPointsDelta(login, awardedPoints, current);

    // Notify bridge (optional)
    broadcastToChannel?.(channelId, {
      type: "sell",
      itemId,
      itemName: item.name,
      awardedPoints,
      viewer: { opaqueUserId, userId: twitchUserId, login },
      at: Date.now(),
    });

    return res.json({ ok: true, awardedPoints });
  } catch (e) {
    console.error("[/sell]", e);
    return res.status(500).json({ ok: false, error: "Sell failed" });
  }
});

function getChannelId(req: any): string {
  // Allow override for multi-channel future, but default to env
  return String(
    req.body?.channel_id || req.query?.channel_id || ADMIN_CHANNEL_ID
  ).trim();
}

// --- WebSocket for local bridge

const wss = new WebSocketServer({ noServer: true });

// channel_id -> set of sockets (allow multiple listeners/tools)
const channelSockets = new Map<string, Set<WebSocket>>();

function registerChannelSocket(channelId: string, ws: WebSocket) {
  let set = channelSockets.get(channelId);
  if (!set) {
    set = new Set<WebSocket>();
    channelSockets.set(channelId, set);
  }
  set.add(ws);

  ws.on("close", () => {
    const s = channelSockets.get(channelId);
    if (s) {
      s.delete(ws);
      if (s.size === 0) channelSockets.delete(channelId);
    }
  });
}

function broadcastToChannel(channelId: string, payload: any) {
  const set = channelSockets.get(channelId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}

// --- ADMIN AUTH MIDDLEWARE ---
function requireAdmin(req: any, res: any, next: any) {
  const user = String(req.get("x-admin-user") || "")
    .trim()
    .toLowerCase();
  const key = String(req.get("x-admin-key") || "").trim();

  if (!ADMIN_KEY_RAW || !ADMIN_USERS.length || !ADMIN_CHANNEL_ID) {
    return res.status(500).json({ error: "Admin not configured" });
  }
  if (key !== ADMIN_KEY_RAW) {
    // optional: console.warn("[admin] bad key from", user);
    return res.status(401).json({ error: "Invalid admin key" });
  }
  if (!ADMIN_USERS.includes(user)) {
    // optional: console.warn("[admin] not whitelisted:", user);
    return res.status(403).json({ error: "User not whitelisted" });
  }
  (req as any).adminUser = user;
  next();
}

// ---- heartbeat (keeps connections from being reaped)
const HEARTBEAT_MS = 25_000;
function heartbeat(this: any) {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  (ws as any).isAlive = true;
  ws.on("pong", heartbeat);
});

setInterval(() => {
  for (const ws of wss.clients) {
    const s: any = ws;
    if (s.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      continue;
    }
    s.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, HEARTBEAT_MS);

// ---- attach to HTTP server
const server = app.listen(process.env.PORT || 8080, () => {
  console.log("EBS listening on", server.address());
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "", `https://${req.headers.host}`);
    if (url.pathname !== "/bridge") return socket.destroy();
    const channelId = url.searchParams.get("channel_id");
    if (!channelId) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any).channelId = channelId;
      registerChannelSocket(channelId, ws);
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});