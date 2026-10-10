import { createSignal, createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-opener";
import { type } from "@tauri-apps/plugin-os";
import { check } from "@tauri-apps/plugin-updater";
import "./App.css";

type View = "dashboard" | "students" | "teachers" | "schools";

interface Student { id: number; name: string; grade: string; school_id: number; }
interface Teacher { id: number; name: string; subject: string; school_id: number; }
interface School { id: number; name: string; address: string; }

export default function App() {
  const [currentView, setCurrentView] = createSignal<View>("dashboard");

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
            await open(res.download_url);
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
          <div class="logo-text">EduDash</div>
        </div>
        
        <nav class="nav-links">
          <button 
            class={`nav-item ${currentView() === "dashboard" ? "active" : ""}`}
            onClick={() => setCurrentView("dashboard")}
          >
            Dashboard
          </button>
          <button 
            class={`nav-item ${currentView() === "schools" ? "active" : ""}`}
            onClick={() => setCurrentView("schools")}
          >
            Schools
          </button>
          <button 
            class={`nav-item ${currentView() === "teachers" ? "active" : ""}`}
            onClick={() => setCurrentView("teachers")}
          >
            Teachers
          </button>
          <button 
            class={`nav-item ${currentView() === "students" ? "active" : ""}`}
            onClick={() => setCurrentView("students")}
          >
            Students
          </button>
        </nav>
        
        <button class="btn updater-btn" onClick={checkForUpdates}>
          Check for Updates
        </button>
      </aside>

      {/* Main Content */}
      <main class="main-content">
        <header class="page-header">
          <div>
            <h1 class="page-title">
              {currentView() === "dashboard" && "Overview"}
              {currentView() === "schools" && "Schools Management"}
              {currentView() === "teachers" && "Teachers Management"}
              {currentView() === "students" && "Students Management"}
            </h1>
            <p class="page-subtitle">Manage your educational records seamlessly.</p>
          </div>
          
          <Show when={currentView() !== "dashboard"}>
            <button 
              class="btn btn-primary"
              onClick={() => openModal(`add_${currentView().slice(0,-1)}` as any)}
            >
              + Add New
            </button>
          </Show>
        </header>

        {/* Dashboard View */}
        <Show when={currentView() === "dashboard"}>
          <div class="summary-grid">
            <div class="summary-card">
              <span class="card-title">Total Schools</span>
              <span class="card-value">{schools() ? schools()?.length : 0}</span>
            </div>
            <div class="summary-card">
              <span class="card-title">Total Teachers</span>
              <span class="card-value">{teachers() ? teachers()?.length : 0}</span>
            </div>
            <div class="summary-card">
              <span class="card-title">Total Students</span>
              <span class="card-value">{students() ? students()?.length : 0}</span>
            </div>
          </div>
          <div class="crud-container">
            <h2>Welcome to EduDash!</h2>
            <p style="color: var(--text-secondary); margin-top: 1rem;">
              Navigate using the sidebar to manage schools, teachers, and students. Data is stored locally via Rust backend.
            </p>
          </div>
        </Show>

        {/* Schools View */}
        <Show when={currentView() === "schools"}>
          <div class="crud-container table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={schools()}>
                  {(school) => (
                    <tr>
                      <td>{school.id}</td>
                      <td>{school.name}</td>
                      <td>{school.address}</td>
                      <td>
                        <button class="btn btn-danger" onClick={() => handleDelete("school", school.id)}>Delete</button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Teachers View */}
        <Show when={currentView() === "teachers"}>
          <div class="crud-container table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>School ID</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={teachers()}>
                  {(teacher) => (
                    <tr>
                      <td>{teacher.id}</td>
                      <td>{teacher.name}</td>
                      <td>{teacher.subject}</td>
                      <td>{teacher.school_id}</td>
                      <td>
                        <button class="btn btn-danger" onClick={() => handleDelete("teacher", teacher.id)}>Delete</button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        {/* Students View */}
        <Show when={currentView() === "students"}>
          <div class="crud-container table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Grade</th>
                  <th>School ID</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                <For each={students()}>
                  {(student) => (
                    <tr>
                      <td>{student.id}</td>
                      <td>{student.name}</td>
                      <td>{student.grade}</td>
                      <td>{student.school_id}</td>
                      <td>
                        <button class="btn btn-danger" onClick={() => handleDelete("student", student.id)}>Delete</button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

      </main>

      {/* Modal Dialog */}
      <Show when={isModalOpen()}>
        <div class="dialog-backdrop" onClick={closeModal}>
          <div class="dialog-content" onClick={(e) => e.stopPropagation()}>
            <h2 class="dialog-header">
              {modalType() === "add_school" ? "Add School" : 
               modalType() === "add_teacher" ? "Add Teacher" : "Add Student"}
            </h2>
            <form onSubmit={handleSubmit}>
              <div class="form-group">
                <label class="form-label">Name</label>
                <input 
                  type="text" 
                  class="form-input"
                  required
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
                    value={formData().address || ""}
                    onInput={(e) => setFormData({ ...formData(), address: e.target.value })}
                  />
                </div>
              </Show>

              <Show when={modalType() === "add_teacher"}>
                <div class="form-group">
                  <label class="form-label">Subject</label>
                  <input 
                    type="text" 
                    class="form-input"
                    required
                    value={formData().subject || ""}
                    onInput={(e) => setFormData({ ...formData(), subject: e.target.value })}
                  />
                </div>
              </Show>

              <Show when={modalType() === "add_student"}>
                <div class="form-group">
                  <label class="form-label">Grade</label>
                  <input 
                    type="text" 
                    class="form-input"
                    required
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
                    value={formData().schoolId || ""}
                    onInput={(e) => setFormData({ ...formData(), schoolId: e.target.value })}
                  />
                </div>
              </Show>

              <div class="dialog-actions">
                <button type="button" class="btn btn-secondary" onClick={closeModal}>Cancel</button>
                <button type="submit" class="btn btn-primary">Save</button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
