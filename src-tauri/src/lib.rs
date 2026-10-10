use std::sync::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct School {
    id: usize,
    name: String,
    address: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Teacher {
    id: usize,
    name: String,
    subject: String,
    school_id: usize,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Student {
    id: usize,
    name: String,
    grade: String,
    school_id: usize,
}

#[derive(Default)]
pub struct AppState {
    schools: Mutex<Vec<School>>,
    teachers: Mutex<Vec<Teacher>>,
    students: Mutex<Vec<Student>>,
    next_id: Mutex<usize>,
}

#[tauri::command]
fn get_schools(state: tauri::State<AppState>) -> Vec<School> {
    state.schools.lock().unwrap().clone()
}

#[tauri::command]
fn add_school(name: String, address: String, state: tauri::State<AppState>) -> School {
    let mut id_guard = state.next_id.lock().unwrap();
    let id = *id_guard;
    *id_guard += 1;

    let school = School { id, name, address };
    state.schools.lock().unwrap().push(school.clone());
    school
}

#[tauri::command]
fn delete_school(id: usize, state: tauri::State<AppState>) {
    state.schools.lock().unwrap().retain(|s| s.id != id);
}

#[tauri::command]
fn get_teachers(state: tauri::State<AppState>) -> Vec<Teacher> {
    state.teachers.lock().unwrap().clone()
}

#[tauri::command]
fn add_teacher(name: String, subject: String, school_id: usize, state: tauri::State<AppState>) -> Teacher {
    let mut id_guard = state.next_id.lock().unwrap();
    let id = *id_guard;
    *id_guard += 1;

    let teacher = Teacher { id, name, subject, school_id };
    state.teachers.lock().unwrap().push(teacher.clone());
    teacher
}

#[tauri::command]
fn delete_teacher(id: usize, state: tauri::State<AppState>) {
    state.teachers.lock().unwrap().retain(|t| t.id != id);
}

#[tauri::command]
fn get_students(state: tauri::State<AppState>) -> Vec<Student> {
    state.students.lock().unwrap().clone()
}

#[tauri::command]
fn add_student(name: String, grade: String, school_id: usize, state: tauri::State<AppState>) -> Student {
    let mut id_guard = state.next_id.lock().unwrap();
    let id = *id_guard;
    *id_guard += 1;

    let student = Student { id, name, grade, school_id };
    state.students.lock().unwrap().push(student.clone());
    student
}

#[tauri::command]
fn delete_student(id: usize, state: tauri::State<AppState>) {
    state.students.lock().unwrap().retain(|s| s.id != id);
}

#[derive(Serialize, Deserialize)]
pub struct UpdateStatus {
    available: bool,
    download_url: Option<String>,
    version: Option<String>
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[tauri::command]
async fn check_updates() -> Result<UpdateStatus, String> {
    // Fixed actual GitHub repo!
    let url = "https://api.github.com/repos/kamranmuazzam/edudash-tauri/releases/latest";
    
    let client = reqwest::Client::builder().user_agent("EduDashApp").build().map_err(|e| e.to_string())?;
    let res = client.get(url).send().await;
    
    if let Ok(response) = res {
        if response.status().is_success() {
            let release: GithubRelease = response.json().await.map_err(|e| e.to_string())?;
            let current_version = env!("CARGO_PKG_VERSION");
            let latest_version = release.tag_name.trim_start_matches('v');
            
            if latest_version != current_version {
                #[cfg(target_os = "android")]
                let target_ext = ".apk";
                #[cfg(target_os = "windows")]
                let target_ext = ".exe";
                #[cfg(target_os = "macos")]
                let target_ext = ".tar.gz"; // or dmg
                #[cfg(target_os = "linux")]
                let target_ext = ".AppImage";

                let asset = release.assets.into_iter().find(|a| a.name.ends_with(target_ext));
                if let Some(a) = asset {
                    return Ok(UpdateStatus {
                        available: true,
                        download_url: Some(a.browser_download_url),
                        version: Some(latest_version.to_string())
                    });
                }
            }
        }
    }
    
    Ok(UpdateStatus {
        available: false,
        download_url: None,
        version: None
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_schools, add_school, delete_school,
            get_teachers, add_teacher, delete_teacher,
            get_students, add_student, delete_student,
            check_updates
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
