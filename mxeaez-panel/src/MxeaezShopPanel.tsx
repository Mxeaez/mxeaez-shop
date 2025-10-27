import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Medieval-themed, compact grid inventory/shop
// - Shows a "Show my points" button if identity isn't shared (calls requestIdShare())
// - After approval, refetches /me and displays StreamElements points as coins
// - Fixed-size slot grid that fills/centers width (both views)
// - Only icons on slots; names show in hover popover
// - Stacked inventory counts, rarity-colored borders w/ glow
// - Tooltip clamps inside viewport & renders above others
// - Smooth toast on redeem

const PanelContext = React.createContext<{ container: HTMLElement | null }>({
  container: null,
});

const EBS_BASE = import.meta.env.VITE_EBS_BASE || "http://localhost:8080";

const MIN_INV_SLOTS = 6;

type Rarity = "Common" | "Rare" | "Unique" | "Legendary";

type ShopItem = {
  id: string;
  name: string;
  description: string;
  cost: number;
  rarity: Rarity;
  iconUrl?: string;
};

type InventoryEntry = { id: string; acquiredAt: number };

const RARITY_BORDER_PX = 3;

const RARITY_COLORS: Record<Rarity, string> = {
  Common: "#9CA3AF",
  Rare: "#93C5FD",
  Unique: "#FDE047",
  Legendary: "#22C55E",
};
const RARITY_GLOWS: Record<Rarity, string> = {
  Common: "rgba(156,163,175,.45)",
  Rare: "rgba(147, 197, 253, 0.45)",
  Unique: "rgba(253,224,71,.45)",
  Legendary: "rgba(34,197,94,.45)",
};

// ---------------------- Shell & Header ----------------------
const PanelShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const shellRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <PanelContext.Provider value={{ container: shellRef.current }}>
      <div
        ref={shellRef}
        className="relative min-h-[300px] w-full text-white p-3 font-sans overflow-x-hidden overflow-y-auto"
        style={{
          background:
            "radial-gradient(1200px 600px at 50% -200px, rgba(255,200,60,0.06), transparent 60%), linear-gradient(to bottom, #14100C, #0B0907)",
          // 👇 keeps column count stable when a vertical scrollbar appears
          scrollbarGutter: "stable",
        }}
      >
        {/* Button pop animation */}
        <style>{`
          @keyframes mx-pop {
            0% { transform: translateZ(0) scale(1); }
            45% { transform: translateZ(0) scale(0.96); }
            100% { transform: translateZ(0) scale(1); }
          }
          @keyframes mx-toast-in { from { opacity:.0; transform: translateY(6px)} to {opacity:1; transform: translateY(0)} }
            .toast-enter { animation: mx-toast-in 180ms ease-out; }
            .btn-pop { animation: mx-pop 180ms ease-out; }
        `}</style>

        {children}
      </div>
    </PanelContext.Provider>
  );
};

const Header: React.FC<{ coins: number }> = ({ coins }) => (
  <div className="flex items-center justify-between mb-2 w-full">
    <div
      className="px-3 py-1 rounded-md border border-amber-900/30 shadow"
      style={{
        background: "#1b1510",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,.05), 0 4px 12px rgba(0,0,0,.35)",
      }}
    >
      <h1 className="text-base font-serif tracking-wide uppercase text-amber-300">
        Mxeaez Shop
      </h1>
    </div>
    <div
      className="text-sm rounded-xl px-3 py-1 flex items-center gap-2 shadow border border-amber-700/40"
      style={{
        background: "linear-gradient(180deg,#3A2A18,#22180E)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,.06), 0 0 12px rgba(0,0,0,.35)",
      }}
    >
      <CoinIcon />
      <span className="font-semibold">
        {Number.isFinite(coins) ? coins.toLocaleString() : "-"}
      </span>
    </div>
  </div>
);

const Tabs: React.FC<{
  active: "shop" | "inventory";
  onChange: (t: "shop" | "inventory") => void;
}> = ({ active, onChange }) => (
  <div className="flex items-center justify-center gap-2 mb-3 w-full">
    {(["inventory", "shop"] as const).map((t) => (
      <button
        key={t}
        onClick={(e) => {
          popOnce(e);
          onChange(t);
        }}
        className={`px-4 py-1.5 rounded-full text-sm font-medium transition transform active:scale-95 shadow
    ${
      active === t
        ? "bg-amber-500/90 text-black hover:bg-amber-400"
        : "bg-[#1a120a] text-neutral-200 hover:bg-[#23170d] border border-amber-900/30"
    }`}
        style={{
          boxShadow:
            active === t
              ? "0 0 0 1px rgba(161,98,7,.25), 0 6px 18px rgba(0,0,0,.35)"
              : "inset 0 1px 0 rgba(255,255,255,.05)",
        }}
      >
        {t[0].toUpperCase() + t.slice(1)}
      </button>
    ))}
  </div>
);

// ---------------------- Item Card ----------------------
type ItemCardProps = {
  item: ShopItem;
  actionLabel: "Buy" | "Use";
  disabled?: boolean;
  onAction?: () => Promise<void> | void;
  count?: number;
  onSell?: () => Promise<void> | void;
  tipsDisabled?: boolean;
};

const EmptySlot: React.FC = () => (
  <div
    className="relative aspect-square rounded-xl
                  border-2 border-neutral-700/60
                  bg-neutral-900/40
                  flex items-center justify-center
                  text-neutral-500 text-[11px] select-none"
  ></div>
);

const ItemCard: React.FC<ItemCardProps> = ({
  item,
  actionLabel,
  onAction,
  disabled,
  count,
  onSell,
  tipsDisabled = false,
}) => {
  const [hover, setHover] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [busySell, setBusySell] = useState(false);
  const isBusy = busyAction || busySell; // <-- one is running => both disabled
  const { container } = React.useContext(PanelContext);
  const [tipW, setTipW] = useState(224); // tooltip width
  const [tipPos, setTipPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  }); // px from container
  const [tipVisible, setTipVisible] = useState(false);

  const hideTimer = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const icon = item.iconUrl; // rely on server-provided icon only

  const open = () => {
    if (tipsDisabled) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setHover(true);
  };
  const scheduleClose = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 150);
  };
  const cancelClose = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  useEffect(() => {
    if (tipsDisabled) {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setHover(false);
      setTipVisible(false);
    }
  }, [tipsDisabled]);

  useEffect(() => {
    if (!hover) {
      setTipVisible(false);
      return;
    }

    const compute = () => {
      const card = cardRef.current?.getBoundingClientRect();
      const tipEl = tooltipRef.current as HTMLDivElement | null;
      const cr = container?.getBoundingClientRect?.();
      if (!card || !cr) return;

      const MARGIN = 8;

      // stable width that fits inside the container
      const maxW = Math.min(224, cr.width - MARGIN * 2);
      setTipW(maxW);

      // LEFT: center over card, clamped to container
      const desiredLeftAbs = card.left + card.width / 2 - maxW / 2;
      const clampedLeftAbs = Math.max(
        cr.left + MARGIN,
        Math.min(desiredLeftAbs, cr.right - maxW - MARGIN)
      );

      // HEIGHT & TOP: flip above if needed, then clamp inside container
      const estH = tipEl?.offsetHeight || 180;
      const spaceBelow = cr.bottom - card.bottom;
      const spaceAbove = card.top - cr.top;

      const topAbs =
        estH + MARGIN > spaceBelow && spaceAbove >= estH + MARGIN
          ? card.top - estH // above
          : card.bottom; // below

      const clampedTopAbs = Math.max(
        cr.top + MARGIN,
        Math.min(topAbs, cr.bottom - estH - MARGIN)
      );

      // store container-relative offsets
      setTipPos({
        left: clampedLeftAbs - cr.left,
        top: clampedTopAbs - cr.top,
      });
      setTipVisible(true);
    };

    const raf = requestAnimationFrame(compute);
    window.addEventListener("resize", compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", compute);
    };
  }, [hover, container]);

  const borderColor = RARITY_COLORS[item.rarity];
  const glow = RARITY_GLOWS[item.rarity];

  const clickWithPop = async (
    e: React.MouseEvent<HTMLButtonElement>,
    which: "action" | "sell"
  ) => {
    popOnce(e);
    if (isBusy || disabled) return; // <-- guard: if anything running, ignore click

    setHover(false);
    setTipVisible(false);

    if (which === "action") {
      setBusyAction(true);
      try {
        await onAction?.();
      } finally {
        setBusyAction(false);
      }
    } else {
      setBusySell(true);
      try {
        await onSell?.();
      } finally {
        setBusySell(false);
      }
    }
  };

  return (
    <div
      ref={cardRef}
      className="relative box-border p-1 rounded-md flex items-center justify-center aspect-square w-full select-none transition transform hover:-translate-y-0.5 hover:scale-[1.02] cursor-pointer"
      style={{
        background: "linear-gradient(180deg,#1C130B,#15100B)",
        border: `${RARITY_BORDER_PX}px solid ${borderColor}`,
        boxShadow: `0 0 10px ${glow}, inset 0 1px 0 rgba(255,255,255,.04)`,
        zIndex: hover ? 60 : 1,
      }}
      onMouseEnter={open}
      onMouseLeave={scheduleClose}
      onFocus={open}
      onBlur={scheduleClose}
      tabIndex={0}
    >
      {!!count && count > 1 && (
        <div
          className="absolute top-0.5 right-0.5 text-[10px] leading-none rounded-full px-1.5 py-0.5 font-bold"
          style={{
            background: "linear-gradient(180deg,#F59E0B,#D97706)",
            color: "#111827",
            boxShadow: "0 0 0 1px rgba(0,0,0,.25), 0 2px 6px rgba(0,0,0,.35)",
          }}
        >
          {count}
        </div>
      )}

      <div className="w-full h-full flex items-center justify-center">
        {icon ? (
          <img
            src={icon}
            alt=""
            className="block max-w-[92%] max-h-[92%] object-contain pointer-events-none select-none"
            draggable={false}
          />
        ) : (
          <div className="w-12 h-12 rounded-md bg-neutral-800/70" />
        )}
      </div>

      {hover &&
        !tipsDisabled &&
        container &&
        createPortal(
          <div
            ref={tooltipRef}
            className="absolute text-left pointer-events-auto whitespace-normal break-words"
            style={{
              position: "absolute",
              left: tipPos.left,
              top: tipPos.top,
              width: tipW,
              background: "linear-gradient(180deg,#1C130B,#15100B)",
              border: `${RARITY_BORDER_PX}px solid ${borderColor}`,
              boxShadow: `0 12px 30px rgba(0,0,0,.5), 0 0 12px ${glow}`,
              borderRadius: 14,
              zIndex: 200,
              visibility: tipVisible ? "visible" : "hidden",
              maxHeight: 220,
              overflowY: "auto",
              contain: "layout paint style",
              willChange: "left, top",
            }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className="flex items-start gap-3 p-3">
              {icon ? (
                <img
                  src={icon}
                  alt=""
                  className="w-10 h-10 object-contain block"
                />
              ) : (
                <div className="w-10 h-10 flex items-center justify-center rounded-xl bg-[#2a1c11]" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-bold leading-snug whitespace-normal break-words">
                    {item.name}
                  </div>
                  <div
                    className="text-[12px] font-bold"
                    style={{ color: RARITY_COLORS[item.rarity] }}
                  >
                    {item.rarity}
                  </div>
                </div>
                <div className="text-[11px] text-neutral-300 mt-1 leading-snug">
                  {item.description}
                </div>

                <div className="mt-2 flex items-center justify-between">
                  <div className="text-[12px] font-semibold">
                    {/* cost display, coin icon optional */}
                    {item.cost}
                  </div>

                  <div className="flex items-center gap-2">
                    {onSell && (
                      <button
                        onClick={(e) => clickWithPop(e, "sell")}
                        disabled={isBusy || !onSell}
                        aria-disabled={isBusy || !onSell}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-300 text-black transition shadow active:scale-95 ${
                          isBusy || !onSell
                            ? "opacity-50 cursor-not-allowed"
                            : "hover:bg-amber-200"
                        }`}
                        style={{
                          boxShadow:
                            "inset 0 1px 0 rgba(255,255,255,.25), 0 6px 18px rgba(0,0,0,.35)",
                        }}
                      >
                        {busySell ? (
                          <span className="flex items-center gap-1">
                            <Spinner size={12} /> Selling…
                          </span>
                        ) : (
                          "Sell"
                        )}
                      </button>
                    )}

                    <button
                      onClick={(e) => clickWithPop(e, "action")}
                      disabled={isBusy || disabled}
                      aria-disabled={isBusy || disabled}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition transform active:scale-95 shadow ${
                        isBusy || disabled
                          ? "bg-[#2a1c11] text-neutral-500 cursor-not-allowed opacity-50"
                          : actionLabel === "Buy"
                          ? "bg-emerald-500 text-black hover:bg-emerald-400"
                          : "bg-indigo-400 text-black hover:bg-indigo-300"
                      }`}
                      style={{
                        boxShadow:
                          "inset 0 1px 0 rgba(255,255,255,.25), 0 6px 18px rgba(0,0,0,.35)",
                      }}
                    >
                      {busyAction ? (
                        <span className="flex items-center gap-1">
                          <Spinner size={12} />
                          {actionLabel === "Buy" ? "Buying…" : "Using…"}
                        </span>
                      ) : (
                        actionLabel
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          container
        )}
    </div>
  );
};

// ---------------------- Slot Board ----------------------
// 3 fixed columns; each column flexes to fill available width.
// No placeholders – items stretch so there’s no wasted margin.
const GridBoard: React.FC<{
  children: React.ReactNode;
  cols?: number;
  gap?: number;
}> = ({ children, cols = 3, gap = 10 }) => {
  return (
    <div
      className="grid w-full"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap,
      }}
    >
      {children}
    </div>
  );
};

function decodeJwt(t: string): any {
  try {
    const p = t.split(".")[1];
    const json = atob(p.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ---------------------- Main ----------------------
export default function MxeaezShopPanel() {
  const [active, setActive] = useState<"shop" | "inventory">("shop");
  const [coins, setCoins] = useState<number>(0);
  const [inventory, setInventory] = useState<InventoryEntry[]>([]);
  const [catalog, setCatalog] = useState<ShopItem[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [allItems, setAllItems] = useState<ShopItem[]>([]);
  // --- Timeout modal state
  const [askTimeout, setAskTimeout] = useState(false);
  const [timeoutName, setTimeoutName] = useState("");
  const [timeoutSubmitting, setTimeoutSubmitting] = useState(false);

  // --- TTS modal state
  const [askTts, setAskTts] = useState(false);
  const [ttsText, setTtsText] = useState("");
  const [ttsSubmitting, setTtsSubmitting] = useState(false);
  const TTS_MAX = 350; // tweak as you like

  // NEW: identity share UI flag
  const [needsIdShare, setNeedsIdShare] = useState(false);

  // keep a stable copy of the latest JWT for refreshes
  const tokenRef = useRef<string | null>(null);

  // NEW: store channel id for WS connection
  const [channelId, setChannelId] = useState<string | null>(null);
  const [panelVisible, setPanelVisible] = useState(false);

  // NEW: current viewer opaque id (to target per-user grant events)
  const viewerOpaqueRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${EBS_BASE}/catalog`)
      .then((r) => r.json())
      .then((items: ShopItem[]) => {
        if (!alive) return;
        setCatalog(items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`${EBS_BASE}/items-index`)
      .then((r) => r.json())
      .then((all: ShopItem[]) => {
        if (alive) setAllItems(all);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const ext = (window as any)?.Twitch?.ext;
    if (!ext) {
      setError("Twitch Extension environment not detected.");
      setLoading(false);
      return;
    }

    ext.onAuthorized(
      async (auth: {
        token: string;
        channelId: string;
        clientId: string;
        userId?: string;
      }) => {
        const { token, userId, channelId } = auth;
        tokenRef.current = token;
        try {
          setToken(token);
          setChannelId(channelId);

          // NEW: remember my opaque id (prefer Twitch.ext.viewer, fallback to JWT)
          const extViewer = (window as any)?.Twitch?.ext?.viewer;
          viewerOpaqueRef.current =
            (extViewer && extViewer.opaqueId) ||
            decodeJwt(token)?.opaque_user_id ||
            null;

          const me = await fetch(`${EBS_BASE}/me`, {
            headers: { Authorization: `Bearer ${token}` },
          }).then((r) => r.json());

          setCoins(me.coins ?? 0);
          setInventory(
            (me.inventory ?? []).map((x: any) => ({
              id: x.id,
              acquiredAt: x.acquiredAt,
            }))
          );

          // Prefer server hint; fallback to presence of userId from Twitch
          if (typeof me.needsIdShare === "boolean") {
            setNeedsIdShare(me.needsIdShare);
          } else {
            setNeedsIdShare(!userId);
          }
        } catch {
          setError("Failed to load from EBS.");
        } finally {
          setLoading(false);
        }
      }
    );
  }, []);

  useEffect(() => {
    // Twitch panel visibility (fires when panel opens/becomes visible)
    const ext = (window as any)?.Twitch?.ext;
    const onVisChanged = (isVisible: boolean) => {
      setPanelVisible(isVisible);
      if (isVisible && tokenRef.current) refreshNow(tokenRef.current);
    };
    if (ext?.onVisibilityChanged) {
      ext.onVisibilityChanged(onVisChanged);
    }

    // Browser focus (alt-tab back, etc.)
    const onFocus = () => {
      if (tokenRef.current) refreshNow(tokenRef.current);
    };
    window.addEventListener("focus", onFocus);

    // Tab visibility (safety net)
    const onDocVis = () => {
      if (document.visibilityState === "visible" && tokenRef.current) {
        refreshNow(tokenRef.current);
      }
    };
    document.addEventListener("visibilitychange", onDocVis);

    return () => {
      if (ext?.onVisibilityChanged) {
        // no official "off", but safe to leave as-is; we remove our DOM listeners:
      }
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onDocVis);
    };
  }, []);

  useEffect(() => {
    if (!channelId || !panelVisible) return;

    // Build ws:// or wss:// using your EBS_BASE host
    const host = new URL(EBS_BASE).host;
    const wsUrl =
      (location.protocol === "https:" ? "wss://" : "ws://") +
      host +
      `/bridge?channel_id=${encodeURIComponent(channelId)}`;

    let ws: WebSocket | null = null;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (!msg || !msg.type) return;

          // Only refresh me if a targeted grant matches my opaque id
          if (msg.type === "grant") {
            const mine = viewerOpaqueRef.current;
            if (msg.targetOpaque && mine && msg.targetOpaque === mine) {
              if (tokenRef.current) refreshSoon(tokenRef.current);
            }
            return;
          }

          // For channel-wide or other relevant events, refresh everyone
          if (
            msg.type === "grant_all" ||
            msg.type === "refund" ||
            msg.type === "mystery"
          ) {
            if (tokenRef.current) refreshSoon(tokenRef.current);
            return;
          }
        } catch (err) {
          void err;
        }
      };

      ws.onclose = () => {
        if (!closed && panelVisible) setTimeout(connect, 1500);
      };
      ws.onerror = () => {
        // let onclose retry
      };
    };

    connect();

    return () => {
      closed = true;
      try {
        if (ws) {
          ws.close();
        }
      } catch (err) {
        void err;
      }
    };
  }, [channelId, panelVisible]);

  async function refreshMe(tok: string) {
    const me = await fetch(`${EBS_BASE}/me`, {
      headers: { Authorization: `Bearer ${tok}` },
    }).then((r) => r.json());
    setCoins(me.coins ?? 0);
    setInventory(
      (me.inventory ?? []).map((x: any) => ({
        id: x.id,
        acquiredAt: x.acquiredAt,
      }))
    );
    if (typeof me.needsIdShare === "boolean") setNeedsIdShare(me.needsIdShare);
  }

  // force-fetch /me now
  function refreshNow(tok: string) {
    return refreshMe(tok);
  }

  // fetch now + again shortly (helps beat eventual consistency on writes)
  function refreshSoon(tok: string) {
    refreshNow(tok);
    setTimeout(() => refreshNow(tok), 500);
  }

  async function buy(item: ShopItem) {
    if (!token) return;
    const res = await fetch(`${EBS_BASE}/buy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ itemId: item.id }),
    });
    const data = await res.json();
    if (data?.ok) {
      await refreshMe(token);
      setToast(`Purchased ${item.name}!`);
      setTimeout(() => setToast(null), 1800);
    } else {
      setError(data?.error || "Purchase failed");
    }
  }

  async function redeemStacked(item: ShopItem) {
    if (item.id === "tts_message") {
      setTtsText("");
      setAskTts(true);
      return;
    }

    if (item.id === "timeout_anyone") {
      setTimeoutName("");
      setAskTimeout(true);
      return;
    }

    if (!token) return;
    const res = await fetch(`${EBS_BASE}/redeem`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ itemId: item.id }),
    });
    const data = await res.json();
    if (data?.ok) {
      setInventory((inv) => {
        const idx = inv.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
          const arr = [...inv];
          arr.splice(idx, 1);
          return arr;
        }
        return inv;
      });

      if (data.prizeId && tokenRef.current) {
        refreshSoon(tokenRef.current); // now + shortly to pick up the gifted item
      } else if (tokenRef.current) {
        refreshNow(tokenRef.current);
      }

      setToast(`Redeemed ${item.name}!`);
      setTimeout(() => setToast(null), 1800);
    } else {
      setError(data?.error || "Redeem failed");
    }
  }

  async function sellStacked(item: ShopItem) {
    if (!token) return;
    const res = await fetch(`${EBS_BASE}/sell`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ itemId: item.id }),
    });
    const data = await res.json();
    if (data?.ok) {
      // remove one from inventory
      setInventory((inv) => {
        const idx = inv.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
          const arr = [...inv];
          arr.splice(idx, 1);
          return arr;
        }
        return inv;
      });
      // refresh coins (or: setCoins((c)=>c + data.awardedPoints))
      await refreshMe(token);
      setToast(`Sold ${item.name} for ${data.awardedPoints}`);
      setTimeout(() => setToast(null), 1800);
    } else {
      setError(data?.error || "Sell failed");
    }
  }
  async function submitTimeout() {
    if (!token) return;
    const target = timeoutName.trim().replace(/^@/, "");
    if (!target) return;
    setTimeoutSubmitting(true);
    try {
      const r = await fetch(`${EBS_BASE}/redeem`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ itemId: "timeout_anyone", target }),
      });
      if (!r.ok) throw new Error(await r.text());
      await refreshMe(token); // pulls updated inventory/coins
      setToast(`Queued timeout for ${target}`);
      setTimeout(() => setToast(null), 1800);
      setAskTimeout(false);
    } catch (e: any) {
      setError(`Timeout failed: ${e?.message || "Unknown error"}`);
    } finally {
      setTimeoutSubmitting(false);
    }
  }

  async function submitTts() {
    if (!token) return;
    const text = ttsText.trim();
    if (!text) return;

    setTtsSubmitting(true);
    try {
      const r = await fetch(`${EBS_BASE}/redeem`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ itemId: "tts_message", text }),
      });
      if (!r.ok) throw new Error(await r.text());
      await refreshMe(token); // if you have this; otherwise update inventory locally
      setToast("Queued TTS message"); // use your toast helper
      setTimeout(() => setToast(null), 1800);
      setAskTts(false);
    } catch (e: any) {
      setError(`TTS failed: ${e?.message || "Unknown error"}`);
    } finally {
      setTtsSubmitting(false);
    }
  }

  // Shop items already come from /catalog (server hides grant-only items there)
  const shopItems = catalog;

  const itemById = useMemo(() => {
    const m = new Map<string, ShopItem>();
    allItems.forEach((it) => m.set(it.id, it));
    return m;
  }, [allItems]);

  // Group inventory into stacks and compute total item count
  const { invGrouped } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of inventory) counts.set(it.id, (counts.get(it.id) || 0) + 1);

    // only include items that still exist in ITEMS
    const grouped: { item: ShopItem; count: number }[] = [];
    let total = 0;
    for (const [id, count] of counts.entries()) {
      const it = itemById.get(id);
      if (!it) continue; // skip old / unknown item ids
      grouped.push({ item: it, count });
      total += count;
    }

    grouped.sort((a, b) => a.item.name.localeCompare(b.item.name));
    return { invGrouped: grouped, totalInvCount: total };
  }, [inventory, itemById]);

  // Identity share handler: prompts Twitch, then refetches /me
  async function handleIdShare() {
    try {
      (window as any)?.Twitch?.ext?.actions?.requestIdShare?.();
      // small delay for Twitch to issue a new token with user_id
      await new Promise((r) => setTimeout(r, 1500));
      if (token) await refreshMe(token);
      setNeedsIdShare(false);
    } catch {
      // no-op; user may cancel the prompt
    }
  }

  return (
    <PanelShell>
      <Header coins={coins} />
      {/* Identity share prompt */}
      {needsIdShare && (
        <div className="mb-2 flex items-center justify-center">
          <button
            onClick={(e) => {
              popOnce(e);
              handleIdShare();
            }}
            className="px-3 py-1 rounded-md text-sm font-semibold bg-white text-black hover:bg-amber-200 transition shadow active:scale-95"
          >
            Show my points
          </button>
        </div>
      )}

      <Tabs active={active} onChange={setActive} />

      {loading && (
        <div className="text-center text-neutral-400 py-8 text-sm">
          Summoning wares…
        </div>
      )}
      {!loading && error && (
        <div className="text-center text-red-300 py-3 text-sm bg-red-900/40 rounded-xl border border-red-800 mb-3">
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {active === "shop" ? (
            <GridBoard cols={3}>
              {shopItems.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  actionLabel="Buy"
                  onAction={() => buy(item)}
                  disabled={coins < item.cost}
                  tipsDisabled={askTimeout}
                />
              ))}
            </GridBoard>
          ) : (
            <GridBoard cols={3}>
              {invGrouped.map(({ item, count }) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  count={count}
                  actionLabel="Use"
                  onAction={() => redeemStacked(item)}
                  onSell={() => sellStacked(item)}
                  tipsDisabled={askTimeout}
                />
              ))}
              {Array.from({
                length: Math.max(0, MIN_INV_SLOTS - invGrouped.length),
              }).map((_, i) => (
                <EmptySlot key={`inv-empty-${i}`} />
              ))}
            </GridBoard>
          )}
        </>
      )}

      {askTimeout && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !timeoutSubmitting && setAskTimeout(false)}
          />
          <div
            className="relative w-[92vw] max-w-[520px] rounded-2xl bg-neutral-900 border border-neutral-700 shadow-2xl p-5 overflow-hidden"
            data-show="true"
          >
            <h3 className="text-lg font-semibold text-white mb-1">
              Timeout anyone
            </h3>
            <p className="text-[13px] text-neutral-300 mb-4">
              Enter the Twitch username to timeout (no @).
            </p>

            <div className="flex items-stretch gap-2">
              <input
                autoFocus
                className="min-w-0 flex-1 rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white outline-none focus:border-neutral-500"
                placeholder="username"
                value={timeoutName}
                onChange={(e) =>
                  setTimeoutName(e.target.value.replace(/\s+/g, ""))
                }
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !timeoutSubmitting &&
                    timeoutName.trim()
                  )
                    submitTimeout();
                  if (e.key === "Escape" && !timeoutSubmitting)
                    setAskTimeout(false);
                }}
                disabled={timeoutSubmitting}
              />
              <button
                onClick={() => setAskTimeout(false)}
                disabled={timeoutSubmitting}
                className="shrink-0 px-3 py-2 rounded-lg border border-neutral-700 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => submitTimeout()}
                disabled={timeoutSubmitting || !timeoutName.trim()}
                className="shrink-0 px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-sm text-white disabled:opacity-50 transition-transform active:scale-[0.98]"
              >
                Timeout
              </button>
            </div>
          </div>
        </div>
      )}

      {askTts && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !ttsSubmitting && setAskTts(false)}
          />
          <div className="relative w-[96vw] max-w-[680px] rounded-2xl bg-neutral-900 border border-neutral-700 shadow-2xl p-5 overflow-hidden">
            <h3 className="text-lg font-semibold text-white mb-1">
              Text-to-Speech message
            </h3>
            <p className="text-[13px] text-neutral-300 mb-3">
              Type your message (max {TTS_MAX} characters). It will be spoken on
              stream.
            </p>

            <div className="flex flex-col gap-2">
              <textarea
                autoFocus
                value={ttsText}
                maxLength={TTS_MAX}
                onChange={(e) => setTtsText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && !ttsSubmitting) setAskTts(false);
                  if (
                    e.key === "Enter" &&
                    (e.ctrlKey || e.metaKey) &&
                    !ttsSubmitting &&
                    ttsText.trim()
                  )
                    submitTts();
                }}
                className="min-h-[160px] rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white outline-none focus:border-neutral-500 resize-y"
                placeholder="Enter your TTS message…"
                disabled={ttsSubmitting}
              />
              <div className="flex items-center justify-between text-xs text-neutral-400">
                <span>Tip: Press Ctrl/Cmd+Enter to send</span>
                <span>
                  {ttsText.length}/{TTS_MAX}
                </span>
              </div>

              <div className="flex items-stretch gap-2 pt-2">
                <button
                  onClick={() => setAskTts(false)}
                  disabled={ttsSubmitting}
                  className="shrink-0 px-3 py-2 rounded-lg border border-neutral-700 text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submitTts}
                  disabled={ttsSubmitting || !ttsText.trim()}
                  className="shrink-0 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm text-white disabled:opacity-50 transition-transform active:scale-[0.98]"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between text-xs text-neutral-400/80">
        {/*<div className="truncate">EBS: {EBS_BASE}</div> */}
        {!token && <div className="italic">Awaiting Twitch authorization…</div>}
      </div>

      {/* Toast (portaled above everything so it never sits behind cards/tooltips) */}
      {toast &&
        createPortal(
          <div className="pointer-events-none fixed inset-0 z-[1000] flex items-end justify-center px-3 pb-3">
            <div
              className="pointer-events-auto px-3 py-1.5 rounded-md text-sm font-medium text-black toast-enter"
              style={{
                background: "linear-gradient(180deg,#FDE68A,#D97706)",
                boxShadow: "0 10px 24px rgba(0,0,0,.45)",
                border: "1px solid #92400E",
              }}
            >
              {toast}
            </div>
          </div>,
          document.body
        )}
    </PanelShell>
  );
}

function CoinIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className="opacity-90"
    >
      <defs>
        <linearGradient id="coinGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#FDE68A" />
          <stop offset="100%" stopColor="#D97706" />
        </linearGradient>
      </defs>
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="url(#coinGrad)"
        stroke="#92400E"
        strokeWidth="1"
      />
      <ellipse cx="12" cy="10" rx="6" ry="3" fill="#FCD34D" opacity="0.6" />
    </svg>
  );
}

function popOnce(e: React.MouseEvent<HTMLElement>) {
  const el = e.currentTarget as HTMLElement;
  el.classList.remove("btn-pop"); // reset if already present
  // force reflow so the animation can retrigger
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  el.offsetWidth;
  el.classList.add("btn-pop");
}

function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="4"
        fill="none"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
