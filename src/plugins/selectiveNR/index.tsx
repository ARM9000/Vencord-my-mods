/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import { Menu, React, Toasts, UserStore } from "@webpack/common";

// ─── Settings ────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    attack: {
        type: OptionType.SLIDER,
        description: "Attack time (ms) — how fast the gate opens when someone speaks",
        markers: [0, 5, 20, 50, 100],
        default: 5,
        stickToMarkers: false,
    },
    release: {
        type: OptionType.SLIDER,
        description: "Release time (ms) — how fast the gate closes after they stop",
        markers: [50, 120, 300, 600, 1000],
        default: 120,
        stickToMarkers: false,
    },
    hold: {
        type: OptionType.SLIDER,
        description: "Hold time (ms) — keeps gate open briefly after signal drops",
        markers: [0, 100, 200, 400, 800],
        default: 200,
        stickToMarkers: false,
    },
    reduction: {
        type: OptionType.SLIDER,
        description: "Volume reduction when gate is closed (dBFS) — lower = more silence. Default -100 = full silence.",
        markers: [-100, -60, -40, -20, 0],
        default: -100,
        stickToMarkers: false,
    },
    debugPanel: {
        type: OptionType.BOOLEAN,
        description: "Show debug overlay with per-user gate state",
        default: false,
        onChange: (v: boolean) => v ? mountPanel() : unmountPanel(),
    },
});

// ─── State ────────────────────────────────────────────────────────────────────

const suppressed = new Set<string>();
const originalVolumes = new Map<string, number>();
const speakingStates = new Map<string, boolean>();

interface GateState {
    state: "closed" | "attack" | "open" | "hold" | "release";
    gain: number;
    holdMs: number;
}
const gateStates = new Map<string, GateState>();

let MediaEngineStore: any = null;
let MediaEngineActions: any = null;
let gateInterval: ReturnType<typeof setInterval> | null = null;
let currentConn: any = null;
const origHandlers = new WeakMap<object, Function | null>();

const TICK_MS = 50;

// ─── MediaEngine helpers ──────────────────────────────────────────────────────

function getConn(): any | null {
    const me = MediaEngineStore?.getMediaEngine?.();
    if (!me?.connections) return null;
    for (const conn of me.connections)
        if (conn.context === "default") return conn;
    return null;
}

function getRemoteUserIds(): string[] {
    const conn = getConn();
    return conn ? Object.keys(conn.remoteAudioSSRCs ?? {}) : [];
}

function isSpeaking(userId: string): boolean {
    return speakingStates.get(userId) ?? false;
}

// ─── Speaking callback ────────────────────────────────────────────────────────

function setupSpeakingCallback(conn: any) {
    if (!conn?.conn?.setOnSpeakingCallback || origHandlers.has(conn)) return;
    const orig = conn.handleSpeakingNative?.bind(conn) ?? null;
    origHandlers.set(conn, orig);
    conn.conn.setOnSpeakingCallback((userId: string, speaking: number, level: number) => {
        speakingStates.set(String(userId), speaking !== 0);
    });
}

function teardownSpeakingCallback(conn: any) {
    if (!origHandlers.has(conn)) return;
    const orig = origHandlers.get(conn);
    conn.conn?.setOnSpeakingCallback?.(orig ?? null);
    origHandlers.delete(conn);
}

function setVol(userId: string, vol: number) {
    MediaEngineActions?.setLocalVolume?.(userId, Math.max(0, Math.min(200, vol)));
}

function getSavedVol(userId: string): number {
    return originalVolumes.get(userId) ?? 100;
}

// ─── Gate ────────────────────────────────────────────────────────────────────

function startSuppressing(userId: string) {
    if (gateStates.has(userId)) return;
    const conn = getConn();
    if (!conn) return;
    const vol = conn.localVolumes?.[userId] ?? 100;
    originalVolumes.set(userId, vol);
    const redLin = Math.pow(10, settings.store.reduction / 20);
    gateStates.set(userId, { state: "closed", gain: redLin, holdMs: 0 });
    setVol(userId, vol * redLin);
}

function stopSuppressing(userId: string) {
    setVol(userId, getSavedVol(userId));
    originalVolumes.delete(userId);
    gateStates.delete(userId);
}

function tickGates() {
    const conn = getConn();
    if (conn !== currentConn) {
        if (currentConn) teardownSpeakingCallback(currentConn);
        currentConn = conn;
        if (conn) setupSpeakingCallback(conn);
    }

    const blockMs = TICK_MS;
    const s = settings.store;
    const redLin = Math.pow(10, s.reduction / 20);

    for (const [userId, gate] of gateStates) {
        const loud = isSpeaking(userId);
        const prevGain = gate.gain;

        switch (gate.state) {
            case "closed":
                if (gate.gain !== redLin) gate.gain = redLin;
                if (loud) gate.state = "attack";
                break;
            case "attack": {
                const step = s.attack > 0 ? blockMs / s.attack : 1;
                gate.gain = Math.min(1, gate.gain + step);
                if (gate.gain >= 1) { gate.gain = 1; gate.state = "open"; }
                if (!loud) { gate.state = "hold"; gate.holdMs = s.hold; }
                break;
            }
            case "open":
                if (!loud) { gate.state = "hold"; gate.holdMs = s.hold; }
                break;
            case "hold":
                if (loud) gate.state = "open";
                else if ((gate.holdMs -= blockMs) <= 0) gate.state = "release";
                break;
            case "release": {
                const step = s.release > 0 ? blockMs / s.release : 1;
                gate.gain = Math.max(redLin, gate.gain - step);
                if (gate.gain <= redLin) { gate.gain = redLin; gate.state = "closed"; }
                if (loud) gate.state = "attack";
                break;
            }
        }

        if (gate.gain !== prevGain)
            setVol(userId, getSavedVol(userId) * gate.gain);
    }
}

// ─── Debug panel ──────────────────────────────────────────────────────────────

const GATE_COLORS: Record<string, string> = {
    open:        "#23a55a",
    attack:      "#f0b132",
    hold:        "#f0b132",
    release:     "#e8702a",
    closed:      "#80848e",
    passthrough: "#5865f2",
};

function DebugPanel() {
    interface Row {
        userId: string;
        username: string;
        suppressed: boolean;
        speaking: boolean;
        gateState: string;
        gateGain: number;
    }

    const [rows, setRows] = React.useState<Row[]>([]);

    React.useEffect(() => {
        const timer = setInterval(() => {
            const userIds = getRemoteUserIds();
            setRows(userIds.map(userId => {
                const user = (UserStore as any).getUser(userId);
                const gate = gateStates.get(userId);
                return {
                    userId,
                    username:   user?.globalName || user?.username || userId,
                    suppressed: suppressed.has(userId),
                    speaking:   isSpeaking(userId),
                    gateState:  gate?.state ?? "passthrough",
                    gateGain:   gate?.gain ?? 1,
                };
            }));
        }, 100);
        return () => clearInterval(timer);
    }, []);

    return (
        <div style={{
            position: "fixed", bottom: "72px", right: "8px", width: "260px",
            background: "rgba(30,31,34,0.96)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "8px", padding: "10px 12px",
            fontFamily: "var(--font-code)", fontSize: "11px", color: "#b5bac1",
            zIndex: 9999, pointerEvents: "none",
            backdropFilter: "blur(10px)",
            boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
        }}>
            <div style={{ color: "#e0e1e5", fontWeight: 700, fontSize: "11px", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: "8px" }}>
                SelectiveNR Debug
            </div>
            {rows.length === 0
                ? <div style={{ color: "#80848e", fontStyle: "italic" }}>No VC users tracked</div>
                : rows.map(r => {
                    const stCol = GATE_COLORS[r.gateState] ?? "#80848e";
                    const gainDb = 20 * Math.log10(Math.max(r.gateGain, 1e-6));
                    const gainPct = r.gateGain * 100;
                    return (
                        <div key={r.userId} style={{ marginBottom: "8px", paddingBottom: "8px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "5px" }}>
                                <div style={{
                                    width: "7px", height: "7px", borderRadius: "50%", flexShrink: 0,
                                    background: r.speaking ? "#23a55a" : "#4e5058",
                                    boxShadow: r.speaking ? "0 0 5px #23a55a" : "none",
                                    transition: "background 0.1s, box-shadow 0.1s",
                                }} />
                                <span style={{ flex: 1, fontWeight: 600, color: "#e0e1e5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {r.username}
                                </span>
                                <span style={{
                                    fontSize: "9px", fontWeight: 700, letterSpacing: "0.07em",
                                    padding: "1px 5px", borderRadius: "3px",
                                    color:      r.suppressed ? "#f0b132" : "#23a55a",
                                    background: r.suppressed ? "#f0b13220" : "#23a55a20",
                                    border:     `1px solid ${r.suppressed ? "#f0b13250" : "#23a55a50"}`,
                                }}>
                                    {r.suppressed ? "GATED" : "ACTIVE"}
                                </span>
                            </div>
                            {r.suppressed && (<>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                                    <span style={{ width: "34px", color: "#80848e", fontSize: "10px" }}>gain</span>
                                    <div style={{ flex: 1, height: "5px", background: "#111214", borderRadius: "3px", overflow: "hidden" }}>
                                        <div style={{ width: `${gainPct}%`, height: "100%", background: stCol, borderRadius: "3px", transition: "width 0.08s ease, background 0.12s" }} />
                                    </div>
                                    <span style={{ width: "46px", textAlign: "right", color: stCol }}>{gainDb.toFixed(1)} dB</span>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <span style={{ width: "34px", color: "#80848e", fontSize: "10px" }}>gate</span>
                                    <span style={{ color: stCol, fontWeight: 700, letterSpacing: "0.06em" }}>
                                        {r.gateState.toUpperCase()}
                                    </span>
                                </div>
                            </>)}
                        </div>
                    );
                })
            }
        </div>
    );
}

let panelContainer: HTMLDivElement | null = null;
let panelRoot: any = null;

function mountPanel() {
    if (panelContainer) return;
    const ReactDOM = findByProps("createRoot");
    if (!ReactDOM?.createRoot) { console.error("[SelectiveNR] ReactDOM.createRoot not found"); return; }
    panelContainer = document.createElement("div");
    panelContainer.id = "snr-debug-root";
    document.body.appendChild(panelContainer);
    panelRoot = ReactDOM.createRoot(panelContainer);
    panelRoot.render(<DebugPanel />);
}

function unmountPanel() {
    panelRoot?.unmount();
    panelContainer?.remove();
    panelContainer = null;
    panelRoot = null;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

const ctxMenuPatch: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user?.id) return;
    const isSuppressed = suppressed.has(user.id);
    children.push(
        <Menu.MenuSeparator key="snr-sep" />,
        <Menu.MenuItem
            key="snr-toggle"
            id="snr-toggle"
            label={isSuppressed ? "Unsuppress" : "Suppress"}
            action={() => {
                if (isSuppressed) {
                    suppressed.delete(user.id);
                    stopSuppressing(user.id);
                    Toasts.show({ message: `${user.username} — noise gate removed`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
                } else {
                    suppressed.add(user.id);
                    startSuppressing(user.id);
                    Toasts.show({ message: `${user.username} — noise gate applied`, type: Toasts.Type.SUCCESS, id: Toasts.genId() });
                }
            }}
        />
    );
};

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "SelectiveNR",
    description: "Right-click any VC user to suppress or unsuppress their audio with a per-user noise gate.",
    authors: [{ name: "ARM9000", id: 540642909930782738n }],
    settings,

    start() {
        MediaEngineStore = findByProps("getMediaEngine");
        MediaEngineActions = findByProps("setLocalVolume");
        gateInterval = setInterval(tickGates, TICK_MS);
        addContextMenuPatch("user-context", ctxMenuPatch);
        if (settings.store.debugPanel) mountPanel();
    },

    stop() {
        unmountPanel();
        if (gateInterval) { clearInterval(gateInterval); gateInterval = null; }
        if (currentConn) { teardownSpeakingCallback(currentConn); currentConn = null; }
        speakingStates.clear();
        removeContextMenuPatch("user-context", ctxMenuPatch);
        for (const userId of suppressed) stopSuppressing(userId);
        suppressed.clear();
        MediaEngineStore = null;
        MediaEngineActions = null;
    },
});
