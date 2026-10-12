import { createSignal, createResource, createEffect, onMount, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type } from "@tauri-apps/plugin-os";
import { check } from "@tauri-apps/plugin-updater";
import "./App.css";

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
  errorMessage?: string;
  isAndroid?: boolean;
  downloadUrl?: string;
}

export default function App() {
  const [currentView, setCurrentView] = createSignal<View>("dashboard");

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
  // In-App Auto-Updater State & Logic
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
      let osType = "unknown";
      try {
        osType = type();
      } catch {
        if (typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("android")) {
          osType = "android";
        }
      }

      if (osType === "android") {
        const res: any = await invoke("check_updates");
        if (res && res.available && res.download_url) {
          setUpdateState({
            checking: false,
            isOpen: true,
            status: "available",
            version: res.version,
            isAndroid: true,
            downloadUrl: res.download_url,
            body: "A new version of EduDash for Android is ready to download.",
          });
        } else {
          setUpdateState(prev => ({
            ...prev,
            checking: false,
            status: "latest",
            isOpen: silent ? false : true,
          }));
        }
      } else {
        // Desktop updater check via official Tauri plugin
        const update = await check();
        if (update && update.available) {
          activeUpdateObj = update;
          setUpdateState({
            checking: false,
            isOpen: true,
            status: "available",
            version: update.version,
            body: update.body || "A new update of EduDash is available with the latest features.",
            date: update.date,
            progress: 0,
          });
        } else {
          setUpdateState(prev => ({
            ...prev,
            checking: false,
            status: "latest",
            isOpen: silent ? false : true,
          }));
        }
      }
    } catch (err: any) {
      console.error("Update error: ", err);

      // Attempt fallback to Rust backend command if plugin threw an error
      try {
        const fallback: any = await invoke("check_updates");
        if (fallback && fallback.available && fallback.download_url) {
          setUpdateState({
            checking: false,
            isOpen: true,
            status: "available",
            version: fallback.version,
            downloadUrl: fallback.download_url,
            body: "New release found on GitHub Releases.",
          });
          return;
        }
      } catch {
        // Fallback also errored
      }

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
      if (updateState().downloadUrl) {
        await openUrl(updateState().downloadUrl!);
        closeUpdateModal();
      }
      return;
    }

    try {
      setUpdateState(prev => ({ ...prev, status: "downloading", progress: 0 }));
      let downloaded = 0;
      let totalBytes = 0;

      await activeUpdateObj.downloadAndInstall((event: any) => {
        if (event.event === "Started") {
          totalBytes = event.data?.contentLength || 0;
        } else if (event.event === "Progress") {
          downloaded += event.data?.chunkLength || 0;
          if (totalBytes > 0) {
            const percent = Math.min(99, Math.round((downloaded / totalBytes) * 100));
            setUpdateState(prev => ({ ...prev, progress: percent }));
          }
        } else if (event.event === "Finished") {
          setUpdateState(prev => ({ ...prev, progress: 100 }));
        }
      });

      setUpdateState(prev => ({ ...prev, status: "ready" }));
    } catch (err: any) {
      console.error("Failed to install update: ", err);
      setUpdateState(prev => ({
        ...prev,
        status: "error",
        errorMessage: "Installation failed: " + (err?.message || String(err)),
      }));
    }
  };

  // Automatic background update check on app launch
  onMount(() => {
    setTimeout(() => {
      checkForUpdates(true);
    }, 2500);
  });

  return (
    <div class="app-container">
      {/* Sidebar */}
      <aside class="sidebar">
        <div class="logo-container">
          <div class="logo-icon">EDU</div>
          <div class="logo-info">
            <span class="logo-text">EduDash</span>
            <span class="logo-version">v1.0.7</span>
          </div>
        </div>
        
        <nav class="nav-links">
          <button 
            class={`nav-item ${currentView() === "dashboard" ? "active" : ""}`}
            onClick={() => setCurrentView("dashboard")}
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
            onClick={() => setCurrentView("schools")}
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
            onClick={() => setCurrentView("teachers")}
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
            onClick={() => setCurrentView("students")}
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
        
        <div class="sidebar-footer">
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
              {currentView() === "schools" && "Create, monitor, and manage educational institutions."}
              {currentView() === "teachers" && "View faculty profiles, subjects taught, and affiliated schools."}
              {currentView() === "students" && "Keep track of active student enrollments and grade levels."}
            </p>
          </div>
          
          <Show when={currentView() !== "dashboard"}>
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
              <h2>✨ EduDash v1.0.7 with Integrated Auto-Updater</h2>
              <p>
                Manage schools, faculty, and students seamlessly with native Rust speed, light and dark themes, and real-time auto-updates.
              </p>
            </div>
            <div class="quick-actions">
              <button class="btn btn-secondary" onClick={() => setCurrentView("schools")}>
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
              when={schools() && schools()!.length > 0}
              fallback={
                <div class="empty-state">
                  <div class="empty-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11"/>
                    </svg>
                  </div>
                  <h3>No schools registered yet</h3>
                  <p>Add your first educational institution to begin managing faculty and students.</p>
                  <button class="btn btn-primary" onClick={() => openModal("add_school")}>
                    + Add First School
                  </button>
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
                  <For each={schools()}>
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
              when={teachers() && teachers()!.length > 0}
              fallback={
                <div class="empty-state">
                  <div class="empty-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                    </svg>
                  </div>
                  <h3>No teachers registered yet</h3>
                  <p>Add teachers and assign them to specific school departments.</p>
                  <button class="btn btn-primary" onClick={() => openModal("add_teacher")}>
                    + Add First Teacher
                  </button>
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
                  <For each={teachers()}>
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
              when={students() && students()!.length > 0}
              fallback={
                <div class="empty-state">
                  <div class="empty-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                    </svg>
                  </div>
                  <h3>No students enrolled yet</h3>
                  <p>Enroll students and track their academic grade levels and assigned school.</p>
                  <button class="btn btn-primary" onClick={() => openModal("add_student")}>
                    + Enroll First Student
                  </button>
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
                  <For each={students()}>
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
                EduDash is running the latest available release. No action is required.
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
              <p class="update-description">Downloading new version assets and verifying cryptographic signatures.</p>
              <div class="update-progress-container">
                <div class="update-progress-bar">
                  <div class="update-progress-fill" style={{ width: `${updateState().progress || 0}%` }}></div>
                </div>
                <div class="update-progress-text">
                  <span>Downloading...</span>
                  <span>{updateState().progress || 0}%</span>
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
              <h2 class="update-title">Update Installed!</h2>
              <p class="update-description">
                The update has been applied successfully. Please restart EduDash to enjoy the new version.
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
              <h2 class="update-title">Update Check Failed</h2>
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
