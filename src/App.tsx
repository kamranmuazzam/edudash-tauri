import { createSignal, createResource, createEffect, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

const CURRENT_APP_VERSION = "1.0.10";

type View = "dashboard" | "schools" | "teachers" | "students";
type Theme = "light" | "dark";

interface Student { id: number; name: string; grade: string; school_id: number; }
interface Teacher { id: number; name: string; subject: string; school_id: number; }
interface School { id: number; name: string; address: string; }

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
      await openUrl(updateState().downloadUrl!);
      closeUpdateModal();
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

  // Safe background check on launch (delayed by 3s, completely non-blocking)
  onMount(() => {
    setTimeout(() => {
      checkForUpdates(true);
    }, 3000);
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
        </nav>
        
        <div class="sidebar-footer desktop-only">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;">
            <div class="system-status-pill" style="margin-bottom: 0;">
              <span class="status-dot"></span>
              <span>Online • v{CURRENT_APP_VERSION}</span>
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
            </h1>
            <p class="page-subtitle">
              {currentView() === "dashboard" && "Welcome back! Here is a summary of your educational database."}
              {currentView() === "schools" && "Create, monitor, and search educational institutions."}
              {currentView() === "teachers" && "View faculty profiles, search subjects taught, and manage schools."}
              {currentView() === "students" && "Keep track of active student enrollments, search names and grades."}
            </p>
          </div>
          
          <Show when={currentView() !== "dashboard"}>
            <div class="page-header-actions">
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
            </div>
          </Show>
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
          </div>

          <div class="welcome-banner">
            <div class="welcome-text">
              <h2>✨ EduDash v1.0.10 - Fast & Stable Cross-Platform</h2>
              <p>
                Manage schools, faculty, and students with real-time instant search, responsive light and dark themes, and high-performance Rust backend.
              </p>
            </div>
            <div class="quick-actions">
              <button class="btn btn-secondary" onClick={() => handleViewChange("schools")}>
                View Schools
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
                  <span>{updateState().isAndroid ? "Download APK" : "Download & Install"}</span>
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
              <p class="update-description">Downloading package and validating cryptographic signatures.</p>
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
              <h2 class="update-title">Update Ready!</h2>
              <p class="update-description">
                The update has been applied successfully. Please restart EduDash to run the new version.
              </p>
              <div class="dialog-actions" style="justify-content: center;">
                <button class="btn btn-primary" onClick={closeUpdateModal}>Done</button>
              </div>
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
    </div>
  );
}
