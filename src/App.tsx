import { createSignal, createResource, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

const CURRENT_APP_VERSION = "1.0.12";

type View = "dashboard" | "schools" | "teachers" | "students" | "mesh";
type Theme = "light" | "dark";

interface Student { id: number; name: string; grade: string; school_id: number; }
interface Teacher { id: number; name: string; subject: string; school_id: number; }
interface School { id: number; name: string; address: string; }

export interface NodeProfile {
  peer_id: string;
  device_name: string;
  iroh_node_id: string;
  local_ip: string;
  tcp_port: number;
  started_at: number;
}

export interface PeerInfo {
  peer_id: string;
  device_name: string;
  ip_address: string;
  tcp_port: number;
  iroh_node_id: string;
  last_seen_ts: number;
  status: "online" | "syncing" | "offline";
  records_count: number;
  data_version: number;
  latency_ms: number;
  network_type?: "lan" | "wan" | "hybrid";
}

export interface NetworkActivity {
  id: string;
  title: string;
  detail: string;
  category: "peer" | "sync" | "message" | "system";
  timestamp: number;
}

export interface SyncResult {
  success: boolean;
  peers_contacted: number;
  added_records: number;
  updated_records: number;
  message: string;
}

interface UpdateState {
  checking: boolean;
  isOpen: boolean;
  status: "idle" | "checking" | "available" | "latest" | "downloading" | "ready" | "error";
  version?: string;
  body?: string;
  date?: string;
  progress?: number;
  downloadText?: string;
  errorMessage?: string;
  isAndroid?: boolean;
  downloadUrl?: string;
  downloadedApkPath?: string;
}

export default function App() {
  const [currentView, setCurrentView] = createSignal<View>("dashboard");
  const [searchQuery, setSearchQuery] = createSignal("");

  const handleViewChange = (view: View) => {
    setCurrentView(view);
    setSearchQuery("");
  };

  // Safe Android platform detection (no Rust calls required)
  const isAndroid = () => {
    return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
  };

  // Theme Management (Defaults to Light theme, persistent)
  const storedTheme = (typeof window !== "undefined" && localStorage.getItem("edudash-theme") as Theme) || "light";
  const [theme, setTheme] = createSignal<Theme>(storedTheme);

  createEffect(() => {
    const current = theme();
    document.documentElement.setAttribute("data-theme", current);
    localStorage.setItem("edudash-theme", current);
  });

  const toggleTheme = () => {
    setTheme(t => (t === "light" ? "dark" : "light"));
  };

  // Zoom & Display Scale Controls (Persistent across sessions)
  const storedZoom = (typeof window !== "undefined" && Number(localStorage.getItem("edudash-zoom"))) || 100;
  const [zoomLevel, setZoomLevel] = createSignal<number>(storedZoom);

  createEffect(() => {
    const zoom = zoomLevel();
    if (typeof document !== "undefined") {
      document.documentElement.style.fontSize = `${(zoom / 100) * 16}px`;
      localStorage.setItem("edudash-zoom", zoom.toString());
    }
  });

  const zoomIn = () => setZoomLevel(z => Math.min(130, z + 10));
  const zoomOut = () => setZoomLevel(z => Math.max(80, z - 10));
  const resetZoom = () => setZoomLevel(100);

  // State to force re-fetch
  const [trigger, setTrigger] = createSignal(0);
  const refresh = () => setTrigger(t => t + 1);

  // P2P Serverless Mesh & Sync State
  const [nodeProfile, setNodeProfile] = createSignal<NodeProfile | null>(null);
  const [peers, setPeers] = createSignal<PeerInfo[]>([]);
  const [activities, setActivities] = createSignal<NetworkActivity[]>([]);
  const [isSyncing, setIsSyncing] = createSignal(false);
  const [broadcastMsg, setBroadcastMsg] = createSignal("");
  const [toastMessage, setToastMessage] = createSignal<string | null>(null);

  const onlinePeers = () => peers().filter(p => p.status === "online");

  let toastTimer: any = null;
  const showToast = (msg: string) => {
    if (toastTimer) clearTimeout(toastTimer);
    setToastMessage(msg);
    toastTimer = setTimeout(() => {
      setToastMessage(null);
    }, 4000);
  };

  const handleSyncMesh = async () => {
    setIsSyncing(true);
    try {
      const res = await invoke<SyncResult>("sync_with_all_peers");
      refresh();
      showToast(res.message);
      const [pList, actList] = await Promise.all([
        invoke<PeerInfo[]>("get_online_peers"),
        invoke<NetworkActivity[]>("get_network_activity"),
      ]);
      setPeers(pList);
      setActivities(actList);
    } catch (e: any) {
      showToast(`Sync error: ${e?.message || e}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncPeer = async (peerId: string) => {
    setIsSyncing(true);
    try {
      const res = await invoke<SyncResult>("sync_with_peer", { peerId });
      refresh();
      showToast(res.message);
      const [pList, actList] = await Promise.all([
        invoke<PeerInfo[]>("get_online_peers"),
        invoke<NetworkActivity[]>("get_network_activity"),
      ]);
      setPeers(pList);
      setActivities(actList);
    } catch (e: any) {
      showToast(`Sync error: ${e?.message || e}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSendBroadcast = async (e: Event) => {
    e.preventDefault();
    const msg = broadcastMsg().trim();
    if (!msg) return;
    try {
      await invoke("broadcast_network_message", { content: msg });
      setBroadcastMsg("");
      showToast("Announcement broadcasted across the mesh!");
      const actList = await invoke<NetworkActivity[]>("get_network_activity");
      setActivities(actList);
    } catch (e: any) {
      showToast(`Broadcast failed: ${e?.message || e}`);
    }
  };

  const copyText = (text: string, label: string) => {
    if (navigator?.clipboard) {
      navigator.clipboard.writeText(text);
      showToast(`Copied ${label} to clipboard!`);
    }
  };

  const formatTimeAgo = (ts: number) => {
    if (!ts) return "Just now";
    const now = Math.floor(Date.now() / 1000);
    const diff = now - ts;
    if (diff < 5) return "Just now";
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  // Resources (Fetching from Rust backend)
  const [students] = createResource(trigger, async () => {
    return await invoke<Student[]>("get_students");
  });
  
  const [teachers] = createResource(trigger, async () => {
    return await invoke<Teacher[]>("get_teachers");
  });
  
  const [schools] = createResource(trigger, async () => {
    return await invoke<School[]>("get_schools");
  });

  // Filtered views for search
  const filteredSchools = () => {
    const list = schools() || [];
    const q = searchQuery().toLowerCase().trim();
    if (!q) return list;
    return list.filter(s => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q));
  };

  const filteredTeachers = () => {
    const list = teachers() || [];
    const q = searchQuery().toLowerCase().trim();
    if (!q) return list;
    return list.filter(t => t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q));
  };

  const filteredStudents = () => {
    const list = students() || [];
    const q = searchQuery().toLowerCase().trim();
    if (!q) return list;
    return list.filter(s => s.name.toLowerCase().includes(q) || s.grade.toLowerCase().includes(q));
  };

  // Modal State for Records
  const [isModalOpen, setIsModalOpen] = createSignal(false);
  const [modalType, setModalType] = createSignal<"add_student" | "add_teacher" | "add_school">("add_student");
  
  // Form State
  const [formData, setFormData] = createSignal<any>({});

  const openModal = (type: "add_student" | "add_teacher" | "add_school") => {
    setModalType(type);
    setFormData({});
    setIsModalOpen(true);
  };

  const closeModal = () => setIsModalOpen(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    try {
      if (modalType() === "add_school") {
        await invoke("add_school", { name: formData().name, address: formData().address });
      } else if (modalType() === "add_teacher") {
        await invoke("add_teacher", { name: formData().name, subject: formData().subject, schoolId: parseInt(formData().schoolId) });
      } else if (modalType() === "add_student") {
        await invoke("add_student", { name: formData().name, grade: formData().grade, schoolId: parseInt(formData().schoolId) });
      }
      closeModal();
      refresh();
    } catch (error) {
      console.error("Error adding record:", error);
    }
  };

  const handleDelete = async (type: string, id: number) => {
    if (!confirm(`Are you sure you want to delete this ${type}?`)) return;
    try {
      await invoke(`delete_${type}`, { id });
      refresh();
    } catch (error) {
      console.error(`Error deleting ${type}:`, error);
    }
  };

  // =========================================================================
  // Fast & Safe Auto-Updater Implementation
  // =========================================================================
  const [updateState, setUpdateState] = createSignal<UpdateState>({
    checking: false,
    isOpen: false,
    status: "idle",
  });

  let activeUpdateObj: any = null;

  const closeUpdateModal = () => {
    setUpdateState(prev => ({ ...prev, isOpen: false }));
  };

  const checkForUpdates = async (silent: boolean = false) => {
    setUpdateState(prev => ({
      ...prev,
      checking: true,
      status: "checking",
      isOpen: silent ? prev.isOpen : true,
      errorMessage: undefined,
    }));

    try {
      // Step 1: Ultra-fast pre-check via GitHub Releases API (< 0.5s response)
      const res = await fetch("https://api.github.com/repos/kamranmuazzam/edudash-tauri/releases/latest", {
        headers: { "Accept": "application/vnd.github.v3+json" }
      });

      if (!res.ok) {
        throw new Error(`GitHub responded with status ${res.status}`);
      }

      const releaseData = await res.json();
      const latestTag = (releaseData.tag_name || "").replace(/^v/, "").trim();

      // Version comparison helper
      const isNewer = (latest: string, current: string) => {
        const lParts = latest.split(".").map(Number);
        const cParts = current.split(".").map(Number);
        for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
          const l = lParts[i] || 0;
          const c = cParts[i] || 0;
          if (l > c) return true;
          if (l < c) return false;
        }
        return false;
      };

      if (!isNewer(latestTag, CURRENT_APP_VERSION)) {
        // Already up to date! Instant resolution in under 0.5s
        setUpdateState(prev => ({
          ...prev,
          checking: false,
          status: "latest",
          version: CURRENT_APP_VERSION,
          isOpen: silent ? false : true,
        }));
        return;
      }

      // Step 2: New update is available!
      if (isAndroid()) {
        // Android specific: Locate the signed universal APK
        const apkAsset = releaseData.assets?.find((a: any) => a.name.endsWith(".apk"));
        const downloadUrl = apkAsset ? apkAsset.browser_download_url : releaseData.html_url;

        setUpdateState({
          checking: false,
          isOpen: true,
          status: "available",
          version: latestTag,
          isAndroid: true,
          downloadUrl: downloadUrl,
          body: releaseData.body || "A new version of EduDash for Android is ready.",
        });
      } else {
        // Desktop (Mac/Windows): Dynamically load Tauri updater plugin only on desktop
        try {
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check({ timeout: 15000 });
          if (update && update.available) {
            activeUpdateObj = update;
          }
        } catch (pluginErr) {
          console.warn("Tauri updater plugin check failed, falling back to direct asset URL:", pluginErr);
        }

        const macAsset = releaseData.assets?.find((a: any) => a.name.endsWith(".dmg") || a.name.endsWith(".tar.gz"));
        setUpdateState({
          checking: false,
          isOpen: true,
          status: "available",
          version: latestTag,
          body: releaseData.body || "A new version of EduDash is available with optimizations and fixes.",
          downloadUrl: macAsset?.browser_download_url || releaseData.html_url,
          progress: 0,
        });
      }
    } catch (err: any) {
      console.error("Update check failed:", err);
      setUpdateState(prev => ({
        ...prev,
        checking: false,
        isOpen: silent ? false : true,
        status: "error",
        errorMessage: err?.message || String(err),
      }));
    }
  };

  const handleInstallUpdate = async () => {
    if (updateState().isAndroid && updateState().downloadUrl) {
      setUpdateState(prev => ({
        ...prev,
        status: "downloading",
        progress: 0,
        downloadText: "Connecting to release server...",
      }));

      let unlistenProgress: (() => void) | undefined;
      try {
        unlistenProgress = await listen<{ downloaded: number; total: number; percentage: number; status: string }>(
          "tauri://download-progress",
          (event) => {
            const { downloaded, total, percentage } = event.payload;
            const dlMb = (downloaded / (1024 * 1024)).toFixed(1);
            const totalMb = total > 0 ? (total / (1024 * 1024)).toFixed(1) : undefined;
            setUpdateState(prev => ({
              ...prev,
              status: "downloading",
              progress: percentage,
              downloadText: totalMb ? `${dlMb} MB / ${totalMb} MB (${percentage}%)` : `${dlMb} MB downloaded...`,
            }));
          }
        );

        const apkPath = await invoke<string>("download_android_apk", { url: updateState().downloadUrl! });

        setUpdateState(prev => ({
          ...prev,
          status: "ready",
          progress: 100,
          downloadedApkPath: apkPath,
          downloadText: "APK downloaded! Launching Android package installer...",
        }));

        try {
          await invoke("install_android_apk", { filePath: apkPath });
        } catch (instErr) {
          console.warn("Direct package installer launch notice:", instErr);
        }
      } catch (err: any) {
        console.error("Android in-app update download failed:", err);
        setUpdateState(prev => ({
          ...prev,
          status: "error",
          errorMessage: "Android update error: " + (err?.message || String(err)),
        }));
      } finally {
        if (unlistenProgress) unlistenProgress();
      }
      return;
    }

    if (!activeUpdateObj) {
      // Fallback: If plugin object not loaded, open download asset directly in browser
      if (updateState().downloadUrl) {
        await openUrl(updateState().downloadUrl!);
        closeUpdateModal();
      }
      return;
    }

    try {
      setUpdateState(prev => ({ 
        ...prev, 
        status: "downloading", 
        progress: 0,
        downloadText: "Connecting to release server..." 
      }));

      let downloadedBytes = 0;
      let totalBytes = 0;

      await activeUpdateObj.downloadAndInstall((event: any) => {
        if (event.event === "Started") {
          totalBytes = event.data?.contentLength || 0;
          const totalMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) + " MB" : "";
          setUpdateState(prev => ({
            ...prev,
            status: "downloading",
            progress: 0,
            downloadText: totalMb ? `Starting download (${totalMb})...` : "Starting download..."
          }));
        } else if (event.event === "Progress") {
          downloadedBytes += event.data?.chunkLength || 0;
          const dlMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
          const totalMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : undefined;
          const pct = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : undefined;

          setUpdateState(prev => ({
            ...prev,
            status: "downloading",
            progress: pct,
            downloadText: totalMb ? `${dlMb} MB / ${totalMb} MB (${pct}%)` : `${dlMb} MB downloaded...`
          }));
        } else if (event.event === "Finished") {
          setUpdateState(prev => ({
            ...prev,
            progress: 100,
            status: "ready",
            downloadText: "Update downloaded & verified! Restarting..."
          }));
        }
      });

      setUpdateState(prev => ({ ...prev, status: "ready" }));
    } catch (err: any) {
      console.error("Failed to install update: ", err);
      setUpdateState(prev => ({
        ...prev,
        status: "error",
        errorMessage: "Installation error: " + (err?.message || String(err)),
      }));
    }
  };

  const handleLaunchApkAgain = async () => {
    const path = updateState().downloadedApkPath;
    if (path) {
      try {
        await invoke("install_android_apk", { filePath: path });
      } catch (e) {
        if (updateState().downloadUrl) {
          await openUrl(updateState().downloadUrl!);
        }
      }
    } else if (updateState().downloadUrl) {
      await openUrl(updateState().downloadUrl!);
    }
  };

  // P2P Mesh Lifecycle & Events
  onMount(() => {
    // Background check for app updates
    setTimeout(() => {
      checkForUpdates(true);
    }, 3000);

    // Initial P2P State load
    invoke<NodeProfile>("get_node_profile").then(setNodeProfile).catch(console.error);
    invoke<PeerInfo[]>("get_online_peers").then(setPeers).catch(console.error);
    invoke<NetworkActivity[]>("get_network_activity").then(setActivities).catch(console.error);

    // Subscribe to backend P2P events
    let cleanups: (() => void)[] = [];

    listen<PeerInfo[]>("p2p://peer-list-updated", (event) => {
      setPeers(event.payload);
    }).then(u => cleanups.push(u));

    listen<{ added: number; updated: number; source?: string }>("p2p://data-synced", (event) => {
      refresh();
      showToast(`⚡ Synced: +${event.payload.added || 0} added, ${event.payload.updated || 0} updated`);
      invoke<PeerInfo[]>("get_online_peers").then(setPeers).catch(() => {});
      invoke<NetworkActivity[]>("get_network_activity").then(setActivities).catch(() => {});
    }).then(u => cleanups.push(u));

    listen<NetworkActivity>("p2p://activity-logged", (event) => {
      setActivities(prev => [event.payload, ...prev].slice(0, 50));
    }).then(u => cleanups.push(u));

    listen<{ sender: string; content: string }>("p2p://message-received", (event) => {
      showToast(`💬 Broadcast from ${event.payload.sender}: "${event.payload.content}"`);
      invoke<NetworkActivity[]>("get_network_activity").then(setActivities).catch(() => {});
    }).then(u => cleanups.push(u));

    // Periodic safety poll every 3 seconds
    const interval = setInterval(() => {
      invoke<PeerInfo[]>("get_online_peers").then(setPeers).catch(() => {});
      invoke<NetworkActivity[]>("get_network_activity").then(setActivities).catch(() => {});
    }, 3000);

    onCleanup(() => {
      clearInterval(interval);
      cleanups.forEach(c => c());
    });
  });

  return (
    <div class="app-container">
      {/* Sidebar */}
      <aside class="sidebar">
        <div class="sidebar-header-row">
          <div class="logo-container">
            <div class="logo-icon">EDU</div>
            <div class="logo-info">
              <span class="logo-text">EduDash</span>
              <span class="logo-version">v{CURRENT_APP_VERSION}</span>
            </div>
          </div>

          <div class="mobile-header-actions">
            <div class="zoom-controls" title="Adjust display zoom">
              <button class="zoom-btn" onClick={zoomOut} disabled={zoomLevel() <= 80} title="Zoom Out (Smaller text)">−</button>
              <span class="zoom-label" onClick={resetZoom} title="Reset zoom">{zoomLevel()}%</span>
              <button class="zoom-btn" onClick={zoomIn} disabled={zoomLevel() >= 130} title="Zoom In (Larger text)">+</button>
            </div>

            <button 
              class="btn mobile-action-btn theme-toggle-btn"
              onClick={toggleTheme}
              title={`Switch to ${theme() === "light" ? "Dark" : "Light"} theme`}
              aria-label="Toggle Theme"
            >
              <span>{theme() === "light" ? "☀️" : "🌙"}</span>
            </button>

            <button 
              class="btn mobile-action-btn updater-btn"
              onClick={() => checkForUpdates(false)}
              disabled={updateState().checking}
              title="Check for Updates"
              aria-label="Check for Updates"
            >
              <svg 
                class={updateState().checking ? "spin-animation" : ""}
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                stroke-width="2" 
                stroke-linecap="round" 
                stroke-linejoin="round"
              >
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 21h5v-5"/>
              </svg>
            </button>
          </div>
        </div>
        
        <nav class="nav-links">
          <button 
            class={`nav-item ${currentView() === "dashboard" ? "active" : ""}`}
            onClick={() => handleViewChange("dashboard")}
          >
            <span class="nav-item-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="9" rx="1"/>
                <rect x="14" y="3" width="7" height="5" rx="1"/>
                <rect x="14" y="12" width="7" height="9" rx="1"/>
                <rect x="3" y="16" width="7" height="5" rx="1"/>
              </svg>
            </span>
            <span>Dashboard</span>
          </button>
          <button 
            class={`nav-item ${currentView() === "schools" ? "active" : ""}`}
            onClick={() => handleViewChange("schools")}
          >
            <span class="nav-item-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v4M12 14v4M16 14v4"/>
              </svg>
            </span>
            <span>Schools</span>
          </button>
          <button 
            class={`nav-item ${currentView() === "teachers" ? "active" : ""}`}
            onClick={() => handleViewChange("teachers")}
          >
            <span class="nav-item-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <polyline points="16 11 18 13 22 9"/>
              </svg>
            </span>
            <span>Teachers</span>
          </button>
          <button 
            class={`nav-item ${currentView() === "students" ? "active" : ""}`}
            onClick={() => handleViewChange("students")}
          >
            <span class="nav-item-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </span>
            <span>Students</span>
          </button>
          <button 
            class={`nav-item ${currentView() === "mesh" ? "active" : ""}`}
            onClick={() => handleViewChange("mesh")}
          >
            <span class="nav-item-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="18" cy="5" r="3"/>
                <circle cx="6" cy="12" r="3"/>
                <circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
            </span>
            <span>Mesh & Peers</span>
            <Show when={onlinePeers().length > 0}>
              <span class="nav-peer-badge">{onlinePeers().length}</span>
            </Show>
          </button>
        </nav>
        
        <div class="sidebar-footer desktop-only">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;">
            <div 
              class="system-status-pill" 
              style="margin-bottom: 0; cursor: pointer;"
              onClick={() => handleViewChange("mesh")}
              title="Click to view P2P Mesh & Online Peers"
            >
              <span class={`status-dot ${onlinePeers().length > 0 ? "status-pulse" : ""}`}></span>
              <span>
                {onlinePeers().length > 0 
                  ? `${onlinePeers().length} Peer${onlinePeers().length > 1 ? "s" : ""} Online` 
                  : `Mesh Ready • v${CURRENT_APP_VERSION}`}
              </span>
            </div>

            <div class="zoom-controls" title="Adjust display zoom">
              <button class="zoom-btn" onClick={zoomOut} disabled={zoomLevel() <= 80} title="Zoom Out">−</button>
              <span class="zoom-label" onClick={resetZoom} title="Reset zoom">{zoomLevel()}%</span>
              <button class="zoom-btn" onClick={zoomIn} disabled={zoomLevel() >= 130} title="Zoom In">+</button>
            </div>
          </div>

          <button 
            class="btn theme-toggle-btn" 
            onClick={toggleTheme}
            title={`Switch to ${theme() === "light" ? "Dark" : "Light"} theme`}
          >
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span>{theme() === "light" ? "☀️" : "🌙"}</span>
              <span class="theme-toggle-label">{theme() === "light" ? "Light Mode" : "Dark Mode"}</span>
            </div>
            <span class="theme-toggle-badge">{theme() === "light" ? "Light" : "Dark"}</span>
          </button>

          <button 
            class="btn updater-btn" 
            onClick={() => checkForUpdates(false)}
            disabled={updateState().checking}
          >
            <svg 
              class={updateState().checking ? "spin-animation" : ""}
              width="16" 
              height="16" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              stroke-width="2" 
              stroke-linecap="round" 
              stroke-linejoin="round"
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M16 21h5v-5"/>
            </svg>
            <span>{updateState().checking ? "Checking..." : "Check for Updates"}</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main class="main-content">
        <header class="page-header">
          <div>
            <h1 class="page-title">
              {currentView() === "dashboard" && "Dashboard Overview"}
              {currentView() === "schools" && "Schools Management"}
              {currentView() === "teachers" && "Teachers Directory"}
              {currentView() === "students" && "Students Directory"}
              {currentView() === "mesh" && "Serverless Mesh & Peers"}
            </h1>
            <p class="page-subtitle">
              {currentView() === "dashboard" && "Welcome back! Here is a summary of your educational database."}
              {currentView() === "schools" && "Create, monitor, and search educational institutions."}
              {currentView() === "teachers" && "View faculty profiles, search subjects taught, and manage schools."}
              {currentView() === "students" && "Keep track of active student enrollments, search names and grades."}
              {currentView() === "mesh" && "Zero-configuration serverless peer discovery, real-time sync, and P2P messaging."}
            </p>
          </div>
          
          <div class="page-header-actions">
            <button 
              class="mesh-header-pill" 
              onClick={() => handleViewChange("mesh")}
              title="View P2P Mesh Network status"
            >
              <span class={`status-dot ${onlinePeers().length > 0 ? "status-pulse" : ""}`}></span>
              <span>
                {onlinePeers().length > 0 
                  ? `${onlinePeers().length} Peer${onlinePeers().length > 1 ? "s" : ""} Online` 
                  : "Mesh Ready"}
              </span>
            </button>

            <Show when={currentView() === "mesh"}>
              <button 
                class="mesh-sync-btn"
                onClick={handleSyncMesh}
                disabled={isSyncing()}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class={isSyncing() ? "spin-animation" : ""}>
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                  <path d="M3 3v5h5"/>
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                  <path d="M16 21h5v-5"/>
                </svg>
                <span>{isSyncing() ? "Syncing Mesh..." : "Sync All Peers"}</span>
              </button>
            </Show>

            <Show when={currentView() !== "dashboard" && currentView() !== "mesh"}>
              <div class="search-input-wrapper">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input 
                  type="text" 
                  class="search-input" 
                  placeholder={`Search ${currentView()}...`}
                  value={searchQuery()}
                  onInput={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              <button 
                class="btn btn-primary"
                onClick={() => openModal(`add_${currentView().slice(0,-1)}` as any)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                <span>Add New</span>
              </button>
            </Show>
          </div>
        </header>

        {/* Dashboard View */}
        <Show when={currentView() === "dashboard"}>
          <div class="summary-grid">
            <div class="summary-card">
              <div class="card-content">
                <span class="card-title">Total Schools</span>
                <span class="card-value">{schools() ? schools()?.length : 0}</span>
                <div class="card-trend" style="color: var(--accent-primary);">
                  <span>Institutions</span>
                </div>
              </div>
              <div class="card-icon-wrapper card-icon-blue">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11"/>
                </svg>
              </div>
            </div>

            <div class="summary-card">
              <div class="card-content">
                <span class="card-title">Total Teachers</span>
                <span class="card-value">{teachers() ? teachers()?.length : 0}</span>
                <div class="card-trend" style="color: #8b5cf6;">
                  <span>Faculty Members</span>
                </div>
              </div>
              <div class="card-icon-wrapper card-icon-purple">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                </svg>
              </div>
            </div>

            <div class="summary-card">
              <div class="card-content">
                <span class="card-title">Total Students</span>
                <span class="card-value">{students() ? students()?.length : 0}</span>
                <div class="card-trend" style="color: var(--accent-success);">
                  <span>Enrolled Scholars</span>
                </div>
              </div>
              <div class="card-icon-wrapper card-icon-emerald">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                </svg>
              </div>
            </div>

            <div class="summary-card" onClick={() => handleViewChange("mesh")} style="cursor: pointer;">
              <div class="card-content">
                <span class="card-title">Mesh Network</span>
                <span class="card-value">{onlinePeers().length > 0 ? `${onlinePeers().length} Online` : "Active"}</span>
                <div class="card-trend" style="color: var(--accent-success);">
                  <span>{onlinePeers().length > 0 ? "P2P Real-time Sync" : "Zero-Config Discovery"}</span>
                </div>
              </div>
              <div class="card-icon-wrapper card-icon-blue">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="18" cy="5" r="3"/>
                  <circle cx="6" cy="12" r="3"/>
                  <circle cx="18" cy="19" r="3"/>
                  <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                  <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                </svg>
              </div>
            </div>
          </div>

          <div class="welcome-banner">
            <div class="welcome-text">
              <h2>✨ EduDash v1.0.11 - Serverless P2P Synchronized</h2>
              <p>
                Manage schools, faculty, and students with real-time automatic P2P sync across network peers, instant search, responsive light and dark themes, and high-performance Rust backend.
              </p>
            </div>
            <div class="quick-actions">
              <button class="btn btn-secondary" onClick={() => handleViewChange("schools")}>
                View Schools
              </button>
              <button class="btn btn-secondary" onClick={() => handleViewChange("mesh")}>
                🌐 Mesh Network ({onlinePeers().length})
              </button>
              <button class="btn btn-primary" onClick={() => openModal("add_student")}>
                + Enroll Student
              </button>
            </div>
          </div>
        </Show>

        {/* Schools View */}
        <Show when={currentView() === "schools"}>
          <div class="crud-container table-wrapper">
            <Show 
              when={filteredSchools() && filteredSchools().length > 0}
              fallback={
                <div class="empty-state">
                  <div class="empty-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11"/>
                    </svg>
                  </div>
                  <h3>{searchQuery() ? "No matching schools found" : "No schools registered yet"}</h3>
                  <p>{searchQuery() ? `No results matching "${searchQuery()}".` : "Add your first educational institution to begin managing faculty and students."}</p>
                  <Show when={!searchQuery()}>
                    <button class="btn btn-primary" onClick={() => openModal("add_school")}>
                      + Add First School
                    </button>
                  </Show>
                </div>
              }
            >
              <table>
                <thead>
                  <tr>
                    <th style="width: 80px;">ID</th>
                    <th>School Name</th>
                    <th>Address</th>
                    <th style="width: 120px; text-align: right;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredSchools()}>
                    {(school) => (
                      <tr>
                        <td>
                          <span class="badge badge-gray">#{school.id}</span>
                        </td>
                        <td style="font-weight: 600; color: var(--text-primary);">{school.name}</td>
                        <td style="color: var(--text-secondary);">{school.address}</td>
                        <td style="text-align: right;">
                          <button class="btn btn-danger" onClick={() => handleDelete("school", school.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Show>

        {/* Teachers View */}
        <Show when={currentView() === "teachers"}>
          <div class="crud-container table-wrapper">
            <Show 
              when={filteredTeachers() && filteredTeachers().length > 0}
              fallback={
                <div class="empty-state">
                  <div class="empty-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                    </svg>
                  </div>
                  <h3>{searchQuery() ? "No matching teachers found" : "No teachers registered yet"}</h3>
                  <p>{searchQuery() ? `No results matching "${searchQuery()}".` : "Add teachers and assign them to specific school departments."}</p>
                  <Show when={!searchQuery()}>
                    <button class="btn btn-primary" onClick={() => openModal("add_teacher")}>
                      + Add First Teacher
                    </button>
                  </Show>
                </div>
              }
            >
              <table>
                <thead>
                  <tr>
                    <th style="width: 80px;">ID</th>
                    <th>Teacher Name</th>
                    <th>Department / Subject</th>
                    <th>School ID</th>
                    <th style="width: 120px; text-align: right;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredTeachers()}>
                    {(teacher) => (
                      <tr>
                        <td>
                          <span class="badge badge-gray">#{teacher.id}</span>
                        </td>
                        <td style="font-weight: 600; color: var(--text-primary);">{teacher.name}</td>
                        <td>
                          <span class="badge badge-purple">{teacher.subject}</span>
                        </td>
                        <td>
                          <span class="badge badge-blue">School #{teacher.school_id}</span>
                        </td>
                        <td style="text-align: right;">
                          <button class="btn btn-danger" onClick={() => handleDelete("teacher", teacher.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Show>

        {/* Students View */}
        <Show when={currentView() === "students"}>
          <div class="crud-container table-wrapper">
            <Show 
              when={filteredStudents() && filteredStudents().length > 0}
              fallback={
                <div class="empty-state">
                  <div class="empty-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                    </svg>
                  </div>
                  <h3>{searchQuery() ? "No matching students found" : "No students enrolled yet"}</h3>
                  <p>{searchQuery() ? `No results matching "${searchQuery()}".` : "Enroll students and track their academic grade levels and assigned school."}</p>
                  <Show when={!searchQuery()}>
                    <button class="btn btn-primary" onClick={() => openModal("add_student")}>
                      + Enroll First Student
                    </button>
                  </Show>
                </div>
              }
            >
              <table>
                <thead>
                  <tr>
                    <th style="width: 80px;">ID</th>
                    <th>Student Name</th>
                    <th>Grade / Class</th>
                    <th>School ID</th>
                    <th style="width: 120px; text-align: right;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredStudents()}>
                    {(student) => (
                      <tr>
                        <td>
                          <span class="badge badge-gray">#{student.id}</span>
                        </td>
                        <td style="font-weight: 600; color: var(--text-primary);">{student.name}</td>
                        <td>
                          <span class="badge badge-emerald">{student.grade}</span>
                        </td>
                        <td>
                          <span class="badge badge-blue">School #{student.school_id}</span>
                        </td>
                        <td style="text-align: right;">
                          <button class="btn btn-danger" onClick={() => handleDelete("student", student.id)}>
                            Delete
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </div>
        </Show>

        {/* Mesh & Peers View */}
        <Show when={currentView() === "mesh"}>
          <div class="mesh-view-container">
            {/* Hero Header */}
            <div class="mesh-banner-hero">
              <div class="mesh-hero-text">
                <h2>
                  <span>🌐</span> Serverless P2P Mesh & Data Sync
                </h2>
                <p>
                  Zero-configuration decentralized network. Discovers other running app instances on the local network or hotspot automatically via UDP Multicast and Iroh cryptographic identity, with instant bidirectional synchronization.
                </p>
              </div>
              <div class="mesh-hero-actions">
                <button 
                  class="mesh-sync-btn"
                  onClick={handleSyncMesh}
                  disabled={isSyncing()}
                >
                  <svg 
                    class={isSyncing() ? "spin-animation" : ""}
                    width="16" 
                    height="16" 
                    viewBox="0 0 24 24" 
                    fill="none" 
                    stroke="currentColor" 
                    stroke-width="2.5" 
                    stroke-linecap="round" 
                    stroke-linejoin="round"
                  >
                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                    <path d="M3 3v5h5"/>
                    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                    <path d="M16 21h5v-5"/>
                  </svg>
                  <span>{isSyncing() ? "Synchronizing Mesh..." : "Sync Entire Mesh"}</span>
                </button>
              </div>
            </div>

            {/* Meta Cards: Node Identity + Network Health + Sync Status */}
            <div class="mesh-meta-grid">
              {/* Local Device Identity */}
              <div class="mesh-meta-card">
                <div class="mesh-card-header">
                  <span class="mesh-card-label">Local Identity</span>
                  <span class="badge badge-blue">This Device</span>
                </div>
                <div class="mesh-card-title">
                  {nodeProfile()?.device_name || "Local Node"}
                </div>
                <div class="mesh-chip-group">
                  <div class="mesh-chip-row">
                    <span>Local Endpoint</span>
                    <span class="mesh-chip-value">
                      {nodeProfile()?.local_ip}:{nodeProfile()?.tcp_port}
                    </span>
                  </div>
                  <div class="mesh-chip-row">
                    <span>Peer ID</span>
                    <span class="mesh-chip-value">
                      {nodeProfile() ? `${nodeProfile()!.peer_id.slice(0, 8)}...` : "—"}
                      <button 
                        class="chip-copy-btn" 
                        onClick={() => copyText(nodeProfile()?.peer_id || "", "Peer ID")}
                        title="Copy Peer ID"
                      >
                        Copy
                      </button>
                    </span>
                  </div>
                  <div class="mesh-chip-row">
                    <span>Iroh Cryptographic ID</span>
                    <span class="mesh-chip-value">
                      {nodeProfile() ? `${nodeProfile()!.iroh_node_id.slice(0, 10)}...` : "—"}
                      <button 
                        class="chip-copy-btn" 
                        onClick={() => copyText(nodeProfile()?.iroh_node_id || "", "Iroh Node ID")}
                        title="Copy Iroh Node ID"
                      >
                        Copy
                      </button>
                    </span>
                  </div>
                </div>
              </div>

              {/* Mesh Health */}
              <div class="mesh-meta-card">
                <div class="mesh-card-header">
                  <span class="mesh-card-label">Mesh Health</span>
                  <span class={`status-tag ${onlinePeers().length > 0 ? "peer-status-online" : "peer-status-offline"}`}>
                    <span class={`status-dot ${onlinePeers().length > 0 ? "status-pulse" : ""}`}></span>
                    {onlinePeers().length > 0 ? `${onlinePeers().length} Online` : "Listening"}
                  </span>
                </div>
                <div class="mesh-card-title">
                  {onlinePeers().length > 0 ? "Connected & Synchronized" : "Zero-Config Discovery Active"}
                </div>
                <div class="mesh-chip-group">
                  <div class="mesh-chip-row">
                    <span>Discovery Protocol</span>
                    <span class="mesh-chip-value">UDP Multicast + Serverless WAN Mesh</span>
                  </div>
                  <div class="mesh-chip-row">
                    <span>Transport Engine</span>
                    <span class="mesh-chip-value">Direct TCP Swarm + EMQX PubSub</span>
                  </div>
                  <div class="mesh-chip-row">
                    <span>Heartbeat Beacon</span>
                    <span class="mesh-chip-value">Auto-Sync (Sub-Second)</span>
                  </div>
                </div>
              </div>

              {/* Data Store Status */}
              <div class="mesh-meta-card">
                <div class="mesh-card-header">
                  <span class="mesh-card-label">Data Store</span>
                  <span class="badge badge-emerald">In-Sync</span>
                </div>
                <div class="mesh-card-title">
                  {(schools()?.length || 0) + (teachers()?.length || 0) + (students()?.length || 0)} Total Records
                </div>
                <div class="mesh-chip-group">
                  <div class="mesh-chip-row">
                    <span>Schools / Faculty / Scholars</span>
                    <span class="mesh-chip-value">
                      {schools()?.length || 0} / {teachers()?.length || 0} / {students()?.length || 0}
                    </span>
                  </div>
                  <div class="mesh-chip-row">
                    <span>Conflict Resolution</span>
                    <span class="mesh-chip-value">CRDT Vector + Tombstones</span>
                  </div>
                  <div class="mesh-chip-row">
                    <span>Automatic Sync</span>
                    <span class="mesh-chip-value" style="color: var(--accent-success);">
                      Enabled (LAN & Internet)
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Peers List Section */}
            <div class="peers-section">
              <div class="section-title-row">
                <h3 class="section-heading">
                  <span>👥</span> Discovered Mesh Peers ({peers().length})
                </h3>
                <Show when={peers().length > 0}>
                  <span class="badge badge-gray">{onlinePeers().length} of {peers().length} online</span>
                </Show>
              </div>

              <Show 
                when={peers().length > 0}
                fallback={
                  <div class="radar-empty-state">
                    <div class="radar-pulse-ring">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="2"/>
                        <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>
                      </svg>
                    </div>
                    <h3>Scanning for App Instances on the Mesh...</h3>
                    <p>
                      No other instances detected yet. Launch EduDash on another computer, mobile device, or anywhere in the world on the internet — they will automatically find each other and synchronize data without typing any ID!
                    </p>
                  </div>
                }
              >
                <div class="peers-grid">
                  <For each={peers()}>
                    {(peer) => (
                      <div class="peer-card">
                        <div class="peer-card-top">
                          <div class="peer-avatar">
                            {peer.device_name.slice(0, 2).toUpperCase()}
                          </div>
                          <div class="peer-title-info">
                            <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                              <span class="peer-name">{peer.device_name}</span>
                              <span class={`badge ${peer.network_type === "wan" ? "badge-blue" : peer.network_type === "hybrid" ? "badge-emerald" : "badge-gray"}`} style="font-size: 0.65rem; padding: 0.1rem 0.35rem;">
                                {peer.network_type === "wan" ? "WAN (Internet)" : peer.network_type === "hybrid" ? "LAN + WAN" : "LAN (Wi-Fi)"}
                              </span>
                            </div>
                            <span class="peer-endpoint-text">
                              {peer.network_type === "wan" ? "Global Serverless Mesh" : `${peer.ip_address}:${peer.tcp_port}`}
                            </span>
                          </div>
                          <span class={`peer-status-tag ${peer.status === "online" ? "peer-status-online" : "peer-status-offline"}`}>
                            <span class={`status-dot ${peer.status === "online" ? "status-pulse" : ""}`}></span>
                            {peer.status === "online" ? "Online" : "Offline"}
                          </span>
                        </div>

                        <div class="peer-details-box">
                          <div>
                            <span class="peer-stat-label">Synced Records</span>
                            <span class="peer-stat-val">{peer.records_count} items</span>
                          </div>
                          <div>
                            <span class="peer-stat-label">Latency</span>
                            <span class="peer-stat-val">
                              {peer.latency_ms > 0 ? `${peer.latency_ms}ms` : "< 3ms"}
                            </span>
                          </div>
                          <div>
                            <span class="peer-stat-label">Data Version</span>
                            <span class="peer-stat-val">v{peer.data_version}</span>
                          </div>
                          <div>
                            <span class="peer-stat-label">Last Seen</span>
                            <span class="peer-stat-val">
                              {peer.status === "online" ? "Active now" : "Recently"}
                            </span>
                          </div>
                        </div>

                        <div class="peer-actions-row">
                          <button 
                            class="peer-action-sync-btn"
                            onClick={() => handleSyncPeer(peer.peer_id)}
                            disabled={isSyncing() || peer.status !== "online"}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                              <path d="M3 3v5h5"/>
                              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                              <path d="M16 21h5v-5"/>
                            </svg>
                            <span>Sync With Peer</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            {/* Broadcast Messaging Card */}
            <div class="mesh-chat-card">
              <div class="section-title-row">
                <h3 class="section-heading">
                  <span>💬</span> Broadcast Message to Mesh
                </h3>
                <span class="badge badge-gray">Instant P2P Announcement</span>
              </div>
              <form onSubmit={handleSendBroadcast} class="chat-input-row">
                <input 
                  type="text" 
                  class="chat-input"
                  placeholder="Type an announcement to all online peers... (e.g. 'Updated Grade 5 roster')"
                  value={broadcastMsg()}
                  onInput={(e) => setBroadcastMsg(e.target.value)}
                />
                <button type="submit" class="chat-send-btn" disabled={!broadcastMsg().trim()}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                  <span>Broadcast</span>
                </button>
              </form>
            </div>

            {/* Network Activity Log */}
            <div class="mesh-meta-card">
              <div class="section-title-row" style="margin-bottom: 0.5rem;">
                <h3 class="section-heading">
                  <span>📜</span> Mesh Activity Stream
                </h3>
                <span class="badge badge-gray">{activities().length} entries</span>
              </div>
              <div class="activity-list">
                <Show 
                  when={activities().length > 0}
                  fallback={
                    <div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                      No mesh activity recorded yet. Events and synchronization logs will appear here.
                    </div>
                  }
                >
                  <For each={activities()}>
                    {(act) => (
                      <div class="activity-item">
                        <div class={`activity-icon-badge activity-icon-${act.category}`}>
                          {act.category === "peer" && "👥"}
                          {act.category === "sync" && "⚡"}
                          {act.category === "message" && "💬"}
                          {act.category === "system" && "⚙️"}
                        </div>
                        <div class="activity-content">
                          <div class="activity-title-row">
                            <span class="activity-title">{act.title}</span>
                            <span class="activity-time">{formatTimeAgo(act.timestamp)}</span>
                          </div>
                          <span class="activity-detail">{act.detail}</span>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </main>

      {/* Record Creation Modal */}
      <Show when={isModalOpen()}>
        <div class="dialog-backdrop" onClick={closeModal}>
          <div class="dialog-content" onClick={(e) => e.stopPropagation()}>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem;">
              <h2 class="dialog-header" style="margin-bottom: 0;">
                {modalType() === "add_school" ? "Add New School" : 
                 modalType() === "add_teacher" ? "Add New Teacher" : "Enroll New Student"}
              </h2>
              <button 
                type="button" 
                onClick={closeModal}
                style="background: transparent; border: none; font-size: 1.5rem; line-height: 1; cursor: pointer; color: var(--text-secondary);"
              >
                &times;
              </button>
            </div>
            
            <form onSubmit={handleSubmit}>
              <div class="form-group">
                <label class="form-label">Full Name</label>
                <input 
                  type="text" 
                  class="form-input"
                  required
                  placeholder={modalType() === "add_school" ? "e.g. Springfield High School" : "e.g. Alex Johnson"}
                  value={formData().name || ""}
                  onInput={(e) => setFormData({ ...formData(), name: e.target.value })}
                />
              </div>

              <Show when={modalType() === "add_school"}>
                <div class="form-group">
                  <label class="form-label">Address</label>
                  <input 
                    type="text" 
                    class="form-input"
                    required
                    placeholder="e.g. 742 Evergreen Terrace"
                    value={formData().address || ""}
                    onInput={(e) => setFormData({ ...formData(), address: e.target.value })}
                  />
                </div>
              </Show>

              <Show when={modalType() === "add_teacher"}>
                <div class="form-group">
                  <label class="form-label">Subject / Department</label>
                  <input 
                    type="text" 
                    class="form-input"
                    required
                    placeholder="e.g. Mathematics, Science"
                    value={formData().subject || ""}
                    onInput={(e) => setFormData({ ...formData(), subject: e.target.value })}
                  />
                </div>
              </Show>

              <Show when={modalType() === "add_student"}>
                <div class="form-group">
                  <label class="form-label">Grade / Class</label>
                  <input 
                    type="text" 
                    class="form-input"
                    required
                    placeholder="e.g. Grade 10, Class A"
                    value={formData().grade || ""}
                    onInput={(e) => setFormData({ ...formData(), grade: e.target.value })}
                  />
                </div>
              </Show>

              <Show when={modalType() !== "add_school"}>
                <div class="form-group">
                  <label class="form-label">School ID</label>
                  <input 
                    type="number" 
                    class="form-input"
                    required
                    placeholder="e.g. 0"
                    value={formData().schoolId || ""}
                    onInput={(e) => setFormData({ ...formData(), schoolId: e.target.value })}
                  />
                </div>
              </Show>

              <div class="dialog-actions">
                <button type="button" class="btn btn-secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" class="btn btn-primary">Save Record</button>
              </div>
            </form>
          </div>
        </div>
      </Show>

      {/* In-App Auto-Updater Modal Dialog */}
      <Show when={updateState().isOpen}>
        <div class="dialog-backdrop" onClick={closeUpdateModal}>
          <div class="dialog-content update-modal-card" onClick={(e) => e.stopPropagation()}>
            {/* Status: Checking */}
            <Show when={updateState().status === "checking"}>
              <div class="update-status-icon checking">
                <svg class="spin-animation" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                  <path d="M3 3v5h5"/>
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                  <path d="M16 21h5v-5"/>
                </svg>
              </div>
              <h2 class="update-title">Checking for Updates</h2>
              <p class="update-description">Connecting to GitHub Releases to check for new version manifests...</p>
              <div class="dialog-actions" style="justify-content: center;">
                <button class="btn btn-secondary" onClick={closeUpdateModal}>Cancel</button>
              </div>
            </Show>

            {/* Status: Already on Latest */}
            <Show when={updateState().status === "latest"}>
              <div class="update-status-icon latest">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>
              </div>
              <h2 class="update-title">You're Up to Date!</h2>
              <p class="update-description">
                EduDash is running the latest available release (v{CURRENT_APP_VERSION}). No updates required.
              </p>
              <div class="dialog-actions" style="justify-content: center;">
                <button class="btn btn-primary" onClick={closeUpdateModal}>Got It</button>
              </div>
            </Show>

            {/* Status: Update Available */}
            <Show when={updateState().status === "available"}>
              <div class="update-status-icon available">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </div>
              <h2 class="update-title">Update Available: v{updateState().version}</h2>
              <p class="update-description">
                A new version has been released! Download and install to get the newest features and improvements.
              </p>
              <Show when={updateState().body}>
                <div class="update-notes-box">
                  <strong>What's New:</strong>
                  <div style="margin-top: 0.35rem;">{updateState().body}</div>
                </div>
              </Show>
              <div class="dialog-actions" style="justify-content: center; gap: 0.75rem;">
                <button class="btn btn-secondary" onClick={closeUpdateModal}>Later</button>
                <button class="btn btn-primary" onClick={handleInstallUpdate}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  <span>Download & Install</span>
                </button>
              </div>
            </Show>

            {/* Status: Downloading */}
            <Show when={updateState().status === "downloading"}>
              <div class="update-status-icon checking">
                <svg class="spin-animation" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </div>
              <h2 class="update-title">Downloading Update...</h2>
              <p class="update-description">
                {updateState().isAndroid ? "Downloading Android package directly inside EduDash..." : "Downloading package and validating cryptographic signatures."}
              </p>
              <div class="update-progress-container">
                <div class="update-progress-bar">
                  <div 
                    class="update-progress-fill" 
                    style={{ width: updateState().progress !== undefined ? `${updateState().progress}%` : "100%" }}
                  ></div>
                </div>
                <div class="update-progress-text">
                  <span>{updateState().downloadText || "Downloading..."}</span>
                  <span>{updateState().progress !== undefined ? `${updateState().progress}%` : ""}</span>
                </div>
              </div>
            </Show>

            {/* Status: Ready / Restarting */}
            <Show when={updateState().status === "ready"}>
              <div class="update-status-icon latest">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <path d="M20 6L9 17l-5-5"/>
                </svg>
              </div>
              <Show when={updateState().isAndroid}>
                <h2 class="update-title">Update Ready to Install!</h2>
                <p class="update-description">
                  {updateState().downloadText || "Package downloaded. The Android package installer should launch. If it did not open automatically, tap below."}
                </p>
                <div class="dialog-actions" style="justify-content: center; gap: 0.75rem;">
                  <button class="btn btn-secondary" onClick={closeUpdateModal}>Close</button>
                  <button class="btn btn-primary" onClick={handleLaunchApkAgain}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <span>Open Installer</span>
                  </button>
                </div>
              </Show>
              <Show when={!updateState().isAndroid}>
                <h2 class="update-title">Update Ready!</h2>
                <p class="update-description">
                  The update has been applied successfully. Please restart EduDash to run the new version.
                </p>
                <div class="dialog-actions" style="justify-content: center;">
                  <button class="btn btn-primary" onClick={closeUpdateModal}>Done</button>
                </div>
              </Show>
            </Show>

            {/* Status: Error */}
            <Show when={updateState().status === "error"}>
              <div class="update-status-icon error">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <h2 class="update-title">Update Check Notice</h2>
              <p class="update-description" style="word-break: break-word;">
                {updateState().errorMessage || "An unexpected error occurred while communicating with GitHub Releases."}
              </p>
              <div class="dialog-actions" style="justify-content: center; gap: 0.75rem;">
                <button class="btn btn-secondary" onClick={closeUpdateModal}>Close</button>
                <button class="btn btn-primary" onClick={() => checkForUpdates(false)}>Try Again</button>
              </div>
            </Show>
          </div>
        </div>
      </Show>

      {/* Real-time P2P Floating Toast */}
      <Show when={toastMessage()}>
        <div class="p2p-toast-notification">
          <span>🔔</span>
          <span>{toastMessage()}</span>
        </div>
      </Show>
    </div>
  );
}
