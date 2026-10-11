import { createSignal, createResource, createEffect, For, Show } from "solid-js";
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

  // Modal State
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

  const checkForUpdates = async () => {
    try {
      const osType = type();
      
      if (osType === "android") {
        const res: any = await invoke("check_updates");
        if (res.available && res.download_url) {
          if (confirm(`New update (v${res.version}) available! Would you like to download it?`)) {
            await openUrl(res.download_url);
          }
        } else {
          alert("You are on the latest version!");
        }
      } else {
        const update = await check();
        if (update) {
          if (confirm(`Update ${update.version} available! Install and restart?`)) {
            await update.downloadAndInstall();
            alert("Update installed successfully. Please restart the app.");
          }
        } else {
          alert("You are on the latest version!");
        }
      }
    } catch(err) {
      console.error("Update error: ", err);
      alert("Error checking for updates: " + err);
    }
  };

  return (
    <div class="app-container">
      {/* Sidebar */}
      <aside class="sidebar">
        <div class="logo-container">
          <div class="logo-icon">EDU</div>
          <div class="logo-info">
            <span class="logo-text">EduDash</span>
            <span class="logo-version">v1.0.6</span>
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

          <button class="btn updater-btn" onClick={checkForUpdates}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
              <path d="M16 21h5v-5"/>
            </svg>
            <span>Check for Updates</span>
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
              <h2>✨ EduDash v1.0.6 with Fresh Light Theme</h2>
              <p>
                Manage schools, faculty, and students seamlessly with native Rust speed and customizable theme preferences.
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

      {/* Modal Dialog */}
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
    </div>
  );
}
