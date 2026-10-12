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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
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
