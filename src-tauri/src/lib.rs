use std::sync::Mutex;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::Manager;

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

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Database {
    schools: Vec<School>,
    teachers: Vec<Teacher>,
    students: Vec<Student>,
    next_id: usize,
}

impl Database {
    fn next_id(&mut self) -> usize {
        let max_school = self.schools.iter().map(|s| s.id).max().unwrap_or(0);
        let max_teacher = self.teachers.iter().map(|t| t.id).max().unwrap_or(0);
        let max_student = self.students.iter().map(|s| s.id).max().unwrap_or(0);
        let current_max = max_school.max(max_teacher).max(max_student);
        if self.next_id <= current_max {
            self.next_id = current_max + 1;
        }
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

pub struct AppState {
    db: Mutex<Database>,
    file_path: PathBuf,
}

impl AppState {
    fn save(&self) {
        if let Ok(db) = self.db.lock() {
            if let Ok(json) = serde_json::to_string_pretty(&*db) {
                if let Some(parent) = self.file_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&self.file_path, json);
            }
        }
    }
}

#[tauri::command]
fn get_schools(state: tauri::State<AppState>) -> Vec<School> {
    state.db.lock().unwrap().schools.clone()
}

#[tauri::command]
fn add_school(name: String, address: String, state: tauri::State<AppState>) -> School {
    let mut db = state.db.lock().unwrap();
    let id = db.next_id();
    let school = School { id, name, address };
    db.schools.push(school.clone());
    drop(db);
    state.save();
    school
}

#[tauri::command]
fn delete_school(id: usize, state: tauri::State<AppState>) {
    let mut db = state.db.lock().unwrap();
    db.schools.retain(|s| s.id != id);
    drop(db);
    state.save();
}

#[tauri::command]
fn get_teachers(state: tauri::State<AppState>) -> Vec<Teacher> {
    state.db.lock().unwrap().teachers.clone()
}

#[tauri::command]
fn add_teacher(name: String, subject: String, school_id: usize, state: tauri::State<AppState>) -> Teacher {
    let mut db = state.db.lock().unwrap();
    let id = db.next_id();
    let teacher = Teacher { id, name, subject, school_id };
    db.teachers.push(teacher.clone());
    drop(db);
    state.save();
    teacher
}

#[tauri::command]
fn delete_teacher(id: usize, state: tauri::State<AppState>) {
    let mut db = state.db.lock().unwrap();
    db.teachers.retain(|t| t.id != id);
    drop(db);
    state.save();
}

#[tauri::command]
fn get_students(state: tauri::State<AppState>) -> Vec<Student> {
    state.db.lock().unwrap().students.clone()
}

#[tauri::command]
fn add_student(name: String, grade: String, school_id: usize, state: tauri::State<AppState>) -> Student {
    let mut db = state.db.lock().unwrap();
    let id = db.next_id();
    let student = Student { id, name, grade, school_id };
    db.students.push(student.clone());
    drop(db);
    state.save();
    student
}

#[tauri::command]
fn delete_student(id: usize, state: tauri::State<AppState>) {
    let mut db = state.db.lock().unwrap();
    db.students.retain(|s| s.id != id);
    drop(db);
    state.save();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()
                .or_else(|_| app.path().app_local_data_dir())
                .or_else(|_| app.path().document_dir())
                .unwrap_or_else(|_| {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                });
            let _ = std::fs::create_dir_all(&app_dir);
            let file_path = app_dir.join("edudash_records.json");

            let db = if file_path.exists() {
                std::fs::read_to_string(&file_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Database>(&s).ok())
                    .unwrap_or_default()
            } else {
                Database {
                    schools: Vec::new(),
                    teachers: Vec::new(),
                    students: Vec::new(),
                    next_id: 1,
                }
            };

            app.manage(AppState {
                db: Mutex::new(db),
                file_path,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_schools, add_school, delete_school,
            get_teachers, add_teacher, delete_teacher,
            get_students, add_student, delete_student
        ]);

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder.run(tauri::generate_context!())
        .expect("error while running tauri application");
}
