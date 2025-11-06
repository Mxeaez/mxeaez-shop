// bridge.js
// Node 18+ recommended. Run with:  node bridge.js
// deps: npm i ws obs-websocket-js

require("dotenv").config({ path: __dirname + "/.env" });
const WebSocket = require("ws");
const { OBSWebSocket } = require("obs-websocket-js");
const { spawn } = require("child_process");
const path = require("path");

// ===================== CONFIG ======================
const CHANNEL_ID = process.env.CHANNEL_ID || "45264995";
const EBS_WS = process.env.EBS_WS;
if (!EBS_WS) log("EBS_WS not set; bridge will not connect to cloud");

// OBS (v5) defaults
const OBS_URL = process.env.OBS_URL || "ws://127.0.0.1:4455";
const OBS_PASSWORD = process.env.OBS_PASSWORD || "";

// Tell the bridge the source names you use in OBS
const WEBCAM_SOURCE = process.env.WEBCAM_SOURCE || "Webcam"; // your camera source name
const MIC_SOURCE = process.env.MIC_SOURCE || "Mic/Aux"; // your mic input name
const FAKE_DC_SOURCE = process.env.FAKE_DC_SOURCE || "Fake DC"; // a source (image) you toggle
const SFX_INPUT_NAME = process.env.SFX_INPUT_NAME || "SFX";
const CAM_SCENE = process.env.WEBCAM_SCENE || "";

// Optional: if you have a dedicated "FullCam" scene, set it; otherwise we'll temp-scale the webcam
const FULLCAM_SCENE = process.env.FULLCAM_SCENE || "";

// Local HTTP hooks (Streamer.bot, Hue, VoiceMod, your own daemon)
// Example: point this to Streamer.bot's HTTP server or a small local server you control.
const LOCAL_HOOK_BASE = process.env.LOCAL_HOOK_BASE || "http://127.0.0.1:18080";

const SB_HTTP = process.env.SB_HTTP || "http://127.0.0.1:7474";

// Where your audio files live (WAV recommended: best cross-platform)
const SND_DIR = process.env.SND_DIR || `${__dirname}/sounds`;

// ===================== UTILITIES =====================
function log(...args) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[bridge ${ts}]`, ...args);
}

// ---- queue + sleep
let _queue = Promise.resolve();
function enqueue(task) {
  _queue = _queue
    .then(() => task())
    .catch((e) => console.error("[queue error]", e));
  return _queue;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long each effect runs (ms). While "held", later redeems wait in the queue.
const EFFECT_DURATIONS_MS = {
  dramatic_zoom: 5000, // zoom restores after ~5s
  camera_flip: 5000, // flip restores after ~10s
  tiny_cam: 5000, // tiny restores after ~15s
  fullscreen_cam: 5000, // 5s
  mute_streamer: 10000, // 30s
  voice_changer: 10000, // 10s
  rave_party: 10000, // 10s (your light/sfx routine)
  // instant/short actions keep 0 so they don't artificially block
  spongebob_stfu: 3000,
  titanic_flute: 30000,
  tts_message: 0, // let TTS queue fast
  timeout_anyone: 0, // don't block others while timing out
  fake_dc: 5000, // if you show overlay for 3s
  // add others as needed...
};

async function obsPlaySfx(fileBase) {
  const o = await ensureObs();
  const wav = path.resolve(SND_DIR, `${fileBase}.wav`);

  // (optional) helpful check so you get a friendly error
  try {
    const { inputs } = await o.call("GetInputList");
    if (!inputs.some((i) => i.inputName === SFX_INPUT_NAME)) {
      console.error(
        `[bridge] SFX input '${SFX_INPUT_NAME}' not found. Available:`,
        inputs.map((i) => i.inputName).join(", ")
      );
      return;
    }
  } catch {}

  // Always target the single SFX input — never the file name
  await o.call("SetInputSettings", {
    inputName: SFX_INPUT_NAME,
    inputSettings: {
      input: "ffmpeg_source", // harmless; OBS ignores here but OK to keep
      local_file: wav,
      is_local_file: true,
      close_when_inactive: false,
      loop: false,
    },
    overlay: true, // apply without nuking filters/volumes
  });

  await o.call("TriggerMediaInputAction", {
    inputName: SFX_INPUT_NAME,
    mediaAction: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
  });
}

function playSound(fileBase) {
  const wav = `${SND_DIR}/${fileBase}.wav`;
  switch (process.platform) {
    case "win32":
      return spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(New-Object Media.SoundPlayer '${wav}').PlaySync()`,
        ],
        { stdio: "ignore" }
      );
    case "darwin":
      return spawn("afplay", [wav], { stdio: "ignore" });
    default:
      return spawn("aplay", [wav], { stdio: "ignore" });
  }
}

async function hit(path, payload) {
  try {
    await fetch(`${LOCAL_HOOK_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    log("hook error", e.message);
  }
}

async function sbDoAction(actionNameOrObj, args = {}) {
  const action =
    typeof actionNameOrObj === "string"
      ? { name: actionNameOrObj }
      : actionNameOrObj;
  await fetch(`${SB_HTTP}/DoAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, args }),
  });
}

// ===================== OBS HELPERS ====================
let obs;
async function ensureObs(opts = { optional: false }) {
  if (obs) return obs;
  const client = new OBSWebSocket();
  try {
    await client.connect(OBS_URL, OBS_PASSWORD);
    obs = client;
    log("OBS connected");
    return obs;
  } catch (e) {
    if (opts.optional) return null; // caller decides to retry later
    throw e;
  }
}

async function getCurrentSceneName() {
  const o = await ensureObs();
  const { currentProgramSceneName } = await o.call("GetCurrentProgramScene");
  return currentProgramSceneName;
}

async function getSceneItemId(sceneName, sourceName) {
  const o = await ensureObs();
  const { sceneItems } = await o.call("GetSceneItemList", { sceneName });
  const found = sceneItems.find((it) => it.sourceName === sourceName);
  return found ? found.sceneItemId : null;
}

async function withSceneItem(prefSceneName, sourceName, fn) {
  const o = await ensureObs();

  const { scenes } = await o.call("GetSceneList");
  const { currentProgramSceneName } = await o.call("GetCurrentProgramScene");

  const order = [];
  if (prefSceneName) order.push(prefSceneName);
  if (!order.includes(currentProgramSceneName))
    order.push(currentProgramSceneName);
  for (const s of scenes.map((s) => s.sceneName)) {
    if (!order.includes(s)) order.push(s);
  }

  for (const sceneName of order) {
    try {
      const { sceneItemId } = await o.call("GetSceneItemId", {
        sceneName,
        sourceName,
        searchOffset: 0,
      });
      if (sceneItemId) {
        if (process.env.DEBUG_OBS) {
          console.log("[obs] target", { sceneName, sourceName, sceneItemId });
        }
        // Unlock if necessary (OBS v5 name is SetSceneItemLocked)
        try {
          await o.call("SetSceneItemLocked", {
            sceneName,
            sceneItemId,
            sceneItemLocked: false,
          });
        } catch {}
        return fn(o, sceneName, sceneItemId);
      }
    } catch {}
  }

  throw new Error(
    `Scene item not found: ${sourceName} in scenes: ${order.join(", ")}`
  );
}

async function toggleSourceEnabled(
  sourceName,
  ms = 5000,
  sceneName = CAM_SCENE
) {
  return withSceneItem(sceneName, sourceName, async (o, s, id) => {
    await o.call("SetSceneItemEnabled", {
      sceneName: s,
      sceneItemId: id,
      sceneItemEnabled: true,
    });
    setTimeout(
      () =>
        o
          .call("SetSceneItemEnabled", {
            sceneName: s,
            sceneItemId: id,
            sceneItemEnabled: false,
          })
          .catch(() => {}),
      ms
    );
  });
}

const _transformCache = new Map();

function clampTransform(t) {
  // build a minimal, valid payload (OBS v5 expects these keys)
  const safe = {
    positionX: Number(t.positionX ?? 0),
    positionY: Number(t.positionY ?? 0),
    rotation: Number(t.rotation ?? 0),
    scaleX: Number(t.scaleX ?? 1) || 1,
    scaleY: Number(t.scaleY ?? 1) || 1,
    alignment: Number.isInteger(t.alignment) ? t.alignment : 0,

    // Bounds: either NONE or width/height >= 1
    boundsType:
      t.boundsType && t.boundsType !== "OBS_BOUNDS_NONE"
        ? t.boundsType
        : "OBS_BOUNDS_NONE",
    boundsAlignment: Number.isInteger(t.boundsAlignment)
      ? t.boundsAlignment
      : 0,
    boundsWidth: Math.max(1, Number(t.boundsWidth || 0) || 1),
    boundsHeight: Math.max(1, Number(t.boundsHeight || 0) || 1),

    // Crops (integers)
    cropLeft: Number.isInteger(t.cropLeft) ? t.cropLeft : 0,
    cropRight: Number.isInteger(t.cropRight) ? t.cropRight : 0,
    cropTop: Number.isInteger(t.cropTop) ? t.cropTop : 0,
    cropBottom: Number.isInteger(t.cropBottom) ? t.cropBottom : 0,
  };

  // If bounds is NONE, OBS ignores width/height but we keep them valid anyway
  if (safe.boundsType === "OBS_BOUNDS_NONE") {
    safe.boundsWidth = 1;
    safe.boundsHeight = 1;
  }

  return safe;
}

async function captureTransform(o, sceneName, sceneItemId) {
  const key = `${sceneName}:${sceneItemId}`;
  const { sceneItemTransform } = await o.call("GetSceneItemTransform", {
    sceneName,
    sceneItemId,
  });
  _transformCache.set(key, sceneItemTransform);
  return sceneItemTransform;
}

async function restoreTransform(o, sceneName, sceneItemId) {
  const key = `${sceneName}:${sceneItemId}`;
  const orig = _transformCache.get(key);
  if (!orig) return;
  const safe = clampTransform(orig);
  await o.call("SetSceneItemTransform", {
    sceneName,
    sceneItemId,
    sceneItemTransform: safe,
  });
  _transformCache.delete(key);
}

// Zooms "in place": keep the on-canvas size similar by pairing scale with symmetric crop.
// factor > 1 zooms in (e.g., 1.5 or 2). ms is the duration before restore.
// Zooms "in place": pair scale with crop so on-canvas size stays similar.
// factor > 1 zooms in. Use opts.biasX / opts.biasY in [-1..1] to lean crop left/right or top/bottom.
// If bias values are omitted, we nudge based on current alignment.
async function zoomInPlaceTemporarily(
  sourceName,
  factor = 1.5,
  ms = 5000,
  sceneName = "",
  opts = {}
) {
  if (!(factor > 1)) factor = 1.2;

  // small util
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  return withSceneItem(sceneName, sourceName, async (o, s, id) => {
    // full restore later
    await captureTransform(o, s, id);
    const r = await o.call("GetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
    });
    const t = r.sceneItemTransform || {};

    const srcW = Number(t.sourceWidth || 0);
    const srcH = Number(t.sourceHeight || 0);

    // No source dimensions? fallback to simple scale so you still get a zoom
    if (!srcW || !srcH) {
      await o.call("SetSceneItemTransform", {
        sceneName: s,
        sceneItemId: id,
        sceneItemTransform: {
          scaleX: Math.abs(t.scaleX || 1) * factor,
          scaleY: Math.abs(t.scaleY || 1) * factor,
        },
      });
      setTimeout(() => restoreTransform(o, s, id).catch(() => {}), ms);
      return;
    }

    // Current crop (defaults 0)
    const cL = Number.isFinite(t.cropLeft) ? t.cropLeft : 0;
    const cR = Number.isFinite(t.cropRight) ? t.cropRight : 0;
    const cT = Number.isFinite(t.cropTop) ? t.cropTop : 0;
    const cB = Number.isFinite(t.cropBottom) ? t.cropBottom : 0;

    // Visible dims after current crop
    const visW = Math.max(1, srcW - cL - cR);
    const visH = Math.max(1, srcH - cT - cB);

    // Extra crop needed to keep on-canvas size ~constant when scaling by factor
    const extraW = Math.max(0, Math.round(visW * (1 - 1 / factor)));
    const extraH = Math.max(0, Math.round(visH * (1 - 1 / factor)));

    // --- Horizontal bias (left/right)
    let biasX =
      opts.biasX !== undefined ? clamp(Number(opts.biasX) || 0, -1, 1) : 0;
    if (opts.biasX === undefined) {
      const align = Number(t.alignment) || 0; // 0..8 grid
      const xAlign = align % 3; // 0 left, 1 center, 2 right
      if (xAlign === 0) biasX = +0.15; // anchored left → crop a bit more left
      if (xAlign === 2) biasX = -0.15; // anchored right → crop a bit more right
    }
    const leftRatio = 0.5 + biasX * 0.5;

    let addL = Math.round(extraW * leftRatio);
    let addR = extraW - addL;

    // Proposed totals (before fitting)
    let newL = cL + addL;
    let newR = cR + addR;

    // Fit without favoring right
    const maxTotalCropW = srcW - 2; // leave ≥2px
    let totalW = newL + newR;
    if (totalW > maxTotalCropW) {
      const overflow = totalW - maxTotalCropW;
      const denom = Math.max(1, addL + addR);
      const reduceL = Math.min(addL, Math.round(overflow * (addL / denom)));
      const reduceR = Math.min(addR, overflow - reduceL);
      newL -= reduceL;
      newR -= reduceR;
    }
    newL = clamp(newL, 0, maxTotalCropW);
    newR = clamp(newR, 0, maxTotalCropW - newL);

    // --- Vertical bias (top/bottom)
    let biasY =
      opts.biasY !== undefined ? clamp(Number(opts.biasY) || 0, -1, 1) : 0;
    if (opts.biasY === undefined) {
      const align = Number(t.alignment) || 0; // 0..8
      const yAlign = Math.floor(align / 3); // 0 top, 1 center, 2 bottom
      if (yAlign === 0) biasY = +0.15; // anchored top → crop a bit more top
      if (yAlign === 2) biasY = -0.15; // anchored bottom → crop a bit more bottom
    }
    const topRatio = 0.5 + biasY * 0.5;

    let addT = Math.round(extraH * topRatio);
    let addB = extraH - addT;

    let newT = cT + addT;
    let newB = cB + addB;

    const maxTotalCropH = srcH - 2;
    let totalH = newT + newB;
    if (totalH > maxTotalCropH) {
      const overflowH = totalH - maxTotalCropH;
      const denomH = Math.max(1, addT + addB);
      const reduceT = Math.min(addT, Math.round(overflowH * (addT / denomH)));
      const reduceB = Math.min(addB, overflowH - reduceT);
      newT -= reduceT;
      newB -= reduceB;
    }
    newT = clamp(newT, 0, maxTotalCropH);
    newB = clamp(newB, 0, maxTotalCropH - newT);

    // Apply crop + scale
    await o.call("SetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
      sceneItemTransform: {
        cropLeft: newL,
        cropRight: newR,
        cropTop: newT,
        cropBottom: newB,
        scaleX: Math.abs(t.scaleX || 1) * factor,
        scaleY: Math.abs(t.scaleY || 1) * factor,
      },
    });

    // Restore original exactly
    setTimeout(() => restoreTransform(o, s, id).catch(() => {}), ms);
  });
}

function alignmentToFrac(alignment) {
  const idx = Number.isInteger(alignment) ? alignment : 0;
  const ax = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1][idx] || 0;
  const ay = [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1][idx] || 0;
  return { ax, ay };
}

/**
 * Flip vertically around visual center and stay in place.
 * Options:
 *  - offsetX: px to nudge final position X (default 0)
 *  - offsetY: px to nudge final position Y (default 0)
 */
async function flipVerticalInPlaceTemporarily(
  sourceName,
  ms = 10000,
  sceneName = "",
  opts = {}
) {
  const offsetX = Number(opts.offsetX || 0);
  const offsetY = Number(opts.offsetY || 0);

  return withSceneItem(sceneName, sourceName, async (o, s, id) => {
    // Save original for exact restore
    await captureTransform(o, s, id);
    const { sceneItemTransform: t } = await o.call("GetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
    });

    // Effective visible size (after crop, with current magnitude of scale)
    const srcW = Number(t.sourceWidth || 0);
    const srcH = Number(t.sourceHeight || 0);
    const cL = Number(t.cropLeft || 0),
      cR = Number(t.cropRight || 0);
    const cT = Number(t.cropTop || 0),
      cB = Number(t.cropBottom || 0);
    const visW = Math.max(1, srcW - cL - cR) * Math.abs(t.scaleX || 1);
    const visH = Math.max(1, srcH - cT - cB) * Math.abs(t.scaleY || 1);

    const { ax, ay } = alignmentToFrac(t.alignment);

    // Compute on-screen center from current anchor + alignment.
    // If your scene’s hierarchy produces a small drift, use offsetX/offsetY to correct.
    const posX = Number(t.positionX || 0);
    const posY = Number(t.positionY || 0);
    const centerX = posX - (0.5 - ax) * visW + offsetX;
    const centerY = posY + (0.5 - ay) * visH + offsetY;

    // Reanchor to center at the same on-screen center, then flip vertical only
    const patch = {
      alignment: 4, // center
      positionX: centerX,
      positionY: centerY,
      rotation: Number(t.rotation || 0),
      scaleX: Math.abs(t.scaleX || 1), // force positive: no horizontal flip
      scaleY: -Math.abs(t.scaleY || 1), // vertical mirror
    };

    await o.call("SetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
      sceneItemTransform: patch,
    });

    setTimeout(() => restoreTransform(o, s, id).catch(() => {}), ms);
  });
}

async function scaleTemporarily(
  sourceName,
  factorX,
  factorY,
  ms = 5000,
  sceneName = process.env.WEBCAM_SCENE || "",
  opts = {}
) {
  return withSceneItem(sceneName, sourceName, async (o, s, id) => {
    // Save original (for restore)
    const { sceneItemTransform: orig } = await o.call("GetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
    });

    const curX = Math.abs(orig.scaleX || 1);
    const curY = Math.abs(orig.scaleY || 1);

    // Build a minimal, valid transform update (just scale + optional position)
    const patch = {
      scaleX: curX * (Number(factorX) || 1),
      scaleY: curY * (Number(factorY) || 1),
    };

    if (opts.center) {
      patch.positionX = orig.positionX || 0;
      patch.positionY = orig.positionY || 0;
    }

    await o.call("SetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
      sceneItemTransform: patch,
    });

    setTimeout(async () => {
      try {
        await o.call("SetSceneItemTransform", {
          sceneName: s,
          sceneItemId: id,
          sceneItemTransform: {
            scaleX: orig.scaleX || 1,
            scaleY: orig.scaleY || 1,
            positionX: orig.positionX || 0,
            positionY: orig.positionY || 0,
          },
        });
      } catch {}
    }, ms);
  });
}

// Shrink in place: keep the on-canvas center fixed while scaling down.
async function tinyInPlaceTemporarily(
  sourceName,
  factor = 0.35, // < 1 to shrink
  ms = 15000, // duration before restore
  sceneName = "",
  opts = {} // { offsetX?: number, offsetY?: number }
) {
  if (!(factor > 0 && factor < 1)) factor = 0.35;
  const offsetX = Number(opts.offsetX || 0);
  const offsetY = Number(opts.offsetY || 0);

  return withSceneItem(sceneName, sourceName, async (o, s, id) => {
    // Save original transform for exact restore
    await captureTransform(o, s, id);

    const { sceneItemTransform: t } = await o.call("GetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
    });

    // Effective visible size (after crop, with current |scale|)
    const srcW = Number(t.sourceWidth || 0);
    const srcH = Number(t.sourceHeight || 0);
    const cropL = Number(t.cropLeft || 0),
      cropR = Number(t.cropRight || 0);
    const cropT = Number(t.cropTop || 0),
      cropB = Number(t.cropBottom || 0);

    if (!srcW || !srcH) {
      // Fallback: if OBS didn’t return dimensions, just scale (may drift if non-center aligned)
      await o.call("SetSceneItemTransform", {
        sceneName: s,
        sceneItemId: id,
        sceneItemTransform: {
          scaleX: (t.scaleX || 1) * factor,
          scaleY: (t.scaleY || 1) * factor,
        },
      });
      setTimeout(() => restoreTransform(o, s, id).catch(() => {}), ms);
      return;
    }

    const visW = Math.max(1, srcW - cropL - cropR) * Math.abs(t.scaleX || 1);
    const visH = Math.max(1, srcH - cropT - cropB) * Math.abs(t.scaleY || 1);

    const { ax, ay } = alignmentToFrac(t.alignment);
    const posX = Number(t.positionX || 0);
    const posY = Number(t.positionY || 0);

    // Compute current on-screen center and keep it fixed
    const centerX = posX + (0.5 - ax) * visW + offsetX;
    const centerY = posY + (0.5 - ay) * visH + offsetY;

    const patch = {
      alignment: 4, // center anchor
      positionX: centerX,
      positionY: centerY,
      rotation: Number(t.rotation || 0),
      // preserve orientation: multiply the existing scales by factor (keeps sign if you had a flip active)
      scaleX: (t.scaleX || 1) * factor,
      scaleY: (t.scaleY || 1) * factor,
      // leave crops as-is (no cropping for tiny)
    };

    await o.call("SetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
      sceneItemTransform: patch,
    });

    // Restore original exactly
    setTimeout(() => restoreTransform(o, s, id).catch(() => {}), ms);
  });
}

async function fullscreenTemporarily(
  sourceName,
  ms = 5000,
  sceneName = CAM_SCENE
) {
  if (FULLCAM_SCENE) {
    const o = await ensureObs();
    const { currentProgramSceneName: prev } = await o.call(
      "GetCurrentProgramScene"
    );
    await o.call("SetCurrentProgramScene", { sceneName: FULLCAM_SCENE });
    setTimeout(
      () =>
        o.call("SetCurrentProgramScene", { sceneName: prev }).catch(() => {}),
      ms
    );
    return;
  }
  return scaleTemporarily(sourceName, 1.8, 1.8, ms, sceneName, {
    center: true,
  });
}

async function rotateTemporarily(
  sourceName,
  degrees,
  ms = 5000,
  sceneName = ""
) {
  return withSceneItem(sceneName, sourceName, async (o, s, id) => {
    await captureTransform(o, s, id);
    const { sceneItemTransform } = await o.call("GetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
    });
    await o.call("SetSceneItemTransform", {
      sceneName: s,
      sceneItemId: id,
      sceneItemTransform: {
        ...sceneItemTransform,
        rotation: (sceneItemTransform.rotation || 0) + degrees,
      },
    });
    setTimeout(() => restoreTransform(o, s, id).catch(() => {}), ms);
  });
}

async function setMuteTemporarily(inputName, ms = 30000) {
  const o = await ensureObs();
  await o.call("SetInputMute", { inputName, inputMuted: true });
  setTimeout(
    () =>
      o.call("SetInputMute", { inputName, inputMuted: false }).catch(() => {}),
    ms
  );
}

// ================== ROUTER / HANDLERS ==================
function who(ctx) {
  const v = ctx.viewer || {};
  return v.login || v.userId || v.opaqueUserId || "unknown";
}

const HANDLERS = {
  // ----- Common -----
  dramatic_zoom: async (ctx) => {
    log("Dramatic Zoom by", who(ctx));
    await zoomInPlaceTemporarily(
      WEBCAM_SOURCE,
      1.5,
      EFFECT_DURATIONS_MS.dramatic_zoom,
      "",
      {
        biasX: 10,
        biasY: -0.6,
      }
    );
    //playSound("dramatic_zoom");
  },
  spongebob_stfu: async (ctx) => {
    log("SpongeBob STFU by", who(ctx));
    await obsPlaySfx("spongebob_stfu");
  },
  titanic_flute: async (ctx) => {
    log("Titanic Flute by", who(ctx));
    await obsPlaySfx("titanic_flute");
  },
  fake_dc: async (ctx) => {
    log("Fake DC overlay by", who(ctx));
    await toggleSourceEnabled(FAKE_DC_SOURCE, EFFECT_DURATIONS_MS.fake_dc);
  },

  // ----- Rare -----
  rave_party: async (ctx) => {
    log("Rave party by", who(ctx));
    await obsPlaySfx("rave");
    // Let your local controller / Streamer.bot handle Hue flash
    await hit("/hue/rave", {
      seconds: EFFECT_DURATIONS_MS.rave,
      viewer: who(ctx),
    });
  },
  tts_message: async (ctx) => {
    log("TTS message by", who(ctx));
    // Streamer.bot action can read {text, viewer} from body
    await sbDoAction("TTS From Bridge", {
      text: ctx?.text || "Hello chat",
      viewer:
        (ctx.viewer && (ctx.viewer.login || ctx.viewer.userId)) || "Unknown",
    });
  },
  voice_changer: async (ctx) => {
    log("Voice Changer by", who(ctx));
    const action =
      process.env.SB_ACTION_VOICEMOD_RANDOM || "Voicemod Random Timed";

    // Pass seconds if you made the action duration dynamic (optional)
    const seconds = EFFECT_DURATIONS_MS.voice_changer;

    await sbDoAction(action, {
      seconds, // only used if your SB action reads it
      viewer: ctx?.viewer?.login || "", // handy for overlay logging in SB
    });

    // Optional: little SFX feedback in stream
    try {
      //await obsPlaySfx("voice_changer");
    } catch {}
  },
  camera_flip: async () => {
    await flipVerticalInPlaceTemporarily(
      WEBCAM_SOURCE,
      EFFECT_DURATIONS_MS.camera_flip,
      "",
      {
        offsetY: 345,
      }
    );
    //await obsPlaySfx("camera_flip"); // if you have a whoosh, etc.
  },
  tiny_cam: async () => {
    await tinyInPlaceTemporarily(
      WEBCAM_SOURCE,
      0.35, // factor < 1 shrinks; tweak (0.5, 0.4, 0.3) to taste
      EFFECT_DURATIONS_MS.tiny_cam, // milliseconds
      "", // current live scene
      {
        offsetX: 470,
        offsetY: 100,
      }
    );
    await obsPlaySfx("tiny_cam");
  },
  streamer_asmr: async (ctx) => {
    log("Streamer ASMR by", who(ctx));
  },

  // ----- Unique -----
  timeout_anyone: async (ctx) => {
    log("Timeout Anyone by", who(ctx));
    // Let Streamer.bot do the timeout; pass target if your panel collected it
    const action = process.env.SB_ACTION_TIMEOUT || "Timeout Anyone";
    const target = String(ctx?.target || "")
      .trim()
      .replace(/^@/, "");
    if (!target) {
      console.warn("[timeout_anyone] missing target");
      return;
    }
    await sbDoAction(action, {
      target,
      seconds: 300, // or read from ctx.seconds if you pass it
      requester: ctx?.viewer?.login || "",
    });
    try {
      await obsPlaySfx("timeout_anyone");
    } catch {}
  },
  notice_me_senpai: async (ctx) => {
    log("Notice Me Senpai by", who(ctx));
    await hit("/overlay/notice", {
      viewer: who(ctx),
      seconds: EFFECT_DURATIONS_MS.notice_me_senpai,
    });
  },
  mute_streamer: async (ctx) => {
    log("Mute Streamer by", who(ctx));
    await setMuteTemporarily(MIC_SOURCE, EFFECT_DURATIONS_MS.mute_streamer);
  },
  fullscreen_cam: async (ctx) => {
    log("Fullscreen cam by", who(ctx));
    await fullscreenTemporarily(
      WEBCAM_SOURCE,
      EFFECT_DURATIONS_MS.fullscreen_cam
    );
  },
  mystery_box: async (ctx) => {
    log("Mystery box opened by", who(ctx));
    //playSound("mystery");
  },

  // ----- Legendary (no-ops per your note) -----
  vip_badge: async () => {},
  carry_now: async () => {},
  game_master: async () => {},
  equipment_master: async () => {},

  // KC point redemptions (EBS handles points; nothing local)
  kc_1000: async () => {},
  kc_5000: async () => {},
  kc_25000: async () => {},
  kc_50000: async () => {},
};

// ================== WS CONNECT / ROUTER ==================
let chain = Promise.resolve();
const recent = new Set();
function dedupeKey(msg) {
  const viewer = msg?.viewer?.opaqueUserId || msg?.viewer?.userId || "";
  const at = Math.round((msg.at || Date.now()) / 2000); // 2s bucket
  return `${msg.type}|${msg.itemId}|${viewer}|${at}`;
}
setInterval(() => recent.clear(), 10000);

async function armObsGating() {
  const o = await ensureObs({ optional: true });
  if (!o) {
    log("OBS not reachable; retrying in 60s");
    setTimeout(armObsGating, 60000);
    return;
  }

  // helper to compute desired WS state and connect/close accordingly
  async function updateWantWs() {
    try {
      const [s, r] = await Promise.all([
        o.call("GetStreamStatus"), // { outputActive: boolean }
        o.call("GetRecordStatus"), // { outputActive: boolean }
      ]);

      const shouldConnect = !!(s?.outputActive || r?.outputActive);

      if (shouldConnect && !wantWs) {
        wantWs = true;
        connect(); // your existing connect() guards against double-connects
      } else if (!shouldConnect && wantWs) {
        wantWs = false;
        if (ws) {
          try { ws.close(); } catch {}
        }
      }
    } catch (e) {
      log("updateWantWs failed:", e?.message || e);
    }
  }

  // initial snapshot
  await updateWantWs();

  // react to OBS state changes
  o.on("StreamStateChanged",      () => updateWantWs());
  o.on("RecordStateChanged",      () => updateWantWs());

  // If you later want VirtualCam to count as "live", also add:
  // o.on("VirtualcamStateChanged", () => updateWantWs());
}

let ws;
let wantWs = false;

function connect() {
  if (!EBS_WS || !wantWs || ws) return;
  log("connecting to", EBS_WS);
  ws = new WebSocket(EBS_WS);

  ws.on("open", () => log("connected"));
  ws.on("close", () => {
    log("disconnected; retrying in 1500ms");
    ws = null;
    if (wantWs) setTimeout(connect, 1500);
  });
  ws.on("error", (e) => log("ws error", e.message));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "redeem" && msg.channelId === CHANNEL_ID) {
      const key = dedupeKey(msg);
      if (recent.has(key)) return;
      recent.add(key);

      console.log("[bridge] msg", { type: msg.type, action: msg.action, ts: Date.now() });
      const handler = HANDLERS[msg.itemId];
      if (!handler) return log("[bridge] no handler for", msg.itemId);

      const hold =
        msg && msg.type === "redeem" ? EFFECT_DURATIONS_MS[msg.itemId] ?? 0 : 0;

      chain = chain
        .then(async () => {
          try {
            log("[queue] start", msg.itemId || msg.type, "hold", hold);
            await handler(msg); // run the effect
          } finally {
            if (hold > 0) await sleep(hold); // keep queue occupied until effect ends
            log("[queue] done", msg.itemId || msg.type);
          }
        })
        .catch((e) => log("handler error", e?.message || e));
    }

    if (msg.type === "mystery" && msg.prizeId) {
      log(`Mystery prize: ${msg.prizeName || msg.prizeId}`);
    }
  });

  // Optional keepalive
  const iv = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {}
    }
  }, 30000);
  ws.on("close", () => clearInterval(iv));
}

// ========================= SELF-TEST CLI (drop-in) =========================
// Usage:
//   node bridge.js                 -> normal mode (connects to EBS)
//   node bridge.js list            -> list available itemIds (HANDLERS keys)
//   node bridge.js test <itemId> [--wait ms] [--viewer name] [--text "msg"] [--target user] [--seconds n]
//
// Examples:
//   node bridge.js list
//   node bridge.js test spongebob_stfu
//   node bridge.js test dramatic_zoom                   # auto-waits ~6s (5s + slack)
//   node bridge.js test dramatic_zoom --wait 6500       # override wait
//   node bridge.js test tts_message --text "Hello chat" --viewer Brody

// Default durations (ms) for timed effects so the process stays alive
const TEST_DURATIONS_MS = {
  dramatic_zoom: 5000,
  camera_flip: 10000,
  tiny_cam: 15000,
  fullscreen_cam: 5000,
  mute_streamer: 30000,
  // add more if you have other timed effects
};

(function boot() {
  const argv = process.argv.slice(2);

  function parseFlags(arr) {
    const flags = {};
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (!a.startsWith("--")) continue;
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) {
        flags[k] = inline;
      } else {
        const next = arr[i + 1];
        if (next && !String(next).startsWith("--")) {
          flags[k] = next;
          i++;
        } else {
          flags[k] = "true";
        }
      }
    }
    return flags;
  }

  const cmd = argv[0];

  if (cmd === "list") {
    console.log("Available itemIds:");
    Object.keys(HANDLERS)
      .sort()
      .forEach((k) => console.log(" -", k));
    return; // don't connect to EBS
  }

  if (cmd === "test") {
    const id = argv[1];
    if (!id || !HANDLERS[id]) {
      console.error("✖ Unknown or missing itemId. Try: node bridge.js list");
      process.exit(1);
    }
    const flags = parseFlags(argv.slice(2));

    // compute wait: use per-item duration + 1s slack, or --wait override
    const base = TEST_DURATIONS_MS[id] || 0;
    const waitMs = Number(flags.wait || 0) || (base ? base + 1000 : 1200);

    // build a minimal ctx the handlers understand
    const ctx = {
      at: Date.now(),
      viewer: { login: flags.viewer || "localtest" },
      ttsText: flags.text || "",
      target: flags.target || "",
      text: typeof msg.text === "string" ? msg.text : "",
      seconds: flags.seconds ? Number(flags.seconds) : undefined,
    };

    (async () => {
      try {
        await HANDLERS[id](ctx);
        console.log(
          `[selftest] ran '${id}', waiting ${waitMs}ms for timed effects/restores...`
        );
        setTimeout(() => process.exit(0), waitMs);
      } catch (e) {
        console.error("[selftest] error:", e?.message || e);
        process.exit(1);
      }
    })();
    return;
  }

  // Default: normal run (connect to EBS)
  armObsGating();
})();