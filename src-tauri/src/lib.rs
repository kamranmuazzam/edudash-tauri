pub mod p2p;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use p2p::{NetworkActivity, NodeProfile, P2pManager, PeerInfo, SyncResult};
use serde::{Deserialize, Serialize};
use tauri::Manager;

pub fn generate_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct School {
    pub id: usize,
    #[serde(default = "generate_uuid")]
    pub sync_id: String,
    pub name: String,
    pub address: String,
    #[serde(default = "current_timestamp")]
    pub updated_at: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Teacher {
    pub id: usize,
    #[serde(default = "generate_uuid")]
    pub sync_id: String,
    pub name: String,
    pub subject: String,
    pub school_id: usize,
    #[serde(default)]
    pub school_sync_id: String,
    #[serde(default = "current_timestamp")]
    pub updated_at: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Student {
    pub id: usize,
    #[serde(default = "generate_uuid")]
    pub sync_id: String,
    pub name: String,
    pub grade: String,
    pub school_id: usize,
    #[serde(default)]
    pub school_sync_id: String,
    #[serde(default = "current_timestamp")]
    pub updated_at: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct Tombstone {
    pub sync_id: String,
    pub entity_type: String, // "school", "teacher", "student"
    pub deleted_at: u64,
}

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct Database {
    pub schools: Vec<School>,
    pub teachers: Vec<Teacher>,
    pub students: Vec<Student>,
    #[serde(default)]
    pub tombstones: Vec<Tombstone>,
    pub next_id: usize,
    #[serde(default)]
    pub data_version: u64,
}

impl Database {
    pub fn next_id(&mut self) -> usize {
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

    pub fn migrate_missing_sync_ids(&mut self) {
        let mut school_map: std::collections::HashMap<usize, String> = std::collections::HashMap::new();
        for s in &mut self.schools {
            if s.sync_id.is_empty() {
                s.sync_id = generate_uuid();
            }
            if s.updated_at == 0 {
                s.updated_at = current_timestamp();
            }
            school_map.insert(s.id, s.sync_id.clone());
        }

        for t in &mut self.teachers {
            if t.sync_id.is_empty() {
                t.sync_id = generate_uuid();
            }
            if t.updated_at == 0 {
                t.updated_at = current_timestamp();
            }
            if t.school_sync_id.is_empty() {
                if let Some(sync_id) = school_map.get(&t.school_id) {
                    t.school_sync_id = sync_id.clone();
                }
            }
        }

        for st in &mut self.students {
            if st.sync_id.is_empty() {
                st.sync_id = generate_uuid();
            }
            if st.updated_at == 0 {
                st.updated_at = current_timestamp();
            }
            if st.school_sync_id.is_empty() {
                if let Some(sync_id) = school_map.get(&st.school_id) {
                    st.school_sync_id = sync_id.clone();
                }
            }
        }
    }

    pub fn merge(&mut self, incoming: &Database) -> (usize, usize) {
        use std::collections::HashMap;

        let mut deleted_sync_ids: HashMap<String, u64> = HashMap::new();
        for t in &incoming.tombstones {
            deleted_sync_ids.insert(t.sync_id.clone(), t.deleted_at);
            if !self.tombstones.iter().any(|ex| ex.sync_id == t.sync_id) {
                self.tombstones.push(t.clone());
            }
        }
        for t in &self.tombstones {
            deleted_sync_ids
                .entry(t.sync_id.clone())
                .and_modify(|ts| *ts = (*ts).max(t.deleted_at))
                .or_insert(t.deleted_at);
        }

        // 1. Filter out deleted local entities
        self.schools.retain(|s| {
            if let Some(&del_at) = deleted_sync_ids.get(&s.sync_id) {
                s.updated_at > del_at
            } else {
                true
            }
        });
        self.teachers.retain(|t| {
            if let Some(&del_at) = deleted_sync_ids.get(&t.sync_id) {
                t.updated_at > del_at
            } else {
                true
            }
        });
        self.students.retain(|st| {
            if let Some(&del_at) = deleted_sync_ids.get(&st.sync_id) {
                st.updated_at > del_at
            } else {
                true
            }
        });

        let mut added = 0;
        let mut updated = 0;

        // 2. Merge Schools
        for inc_school in &incoming.schools {
            if let Some(&del_at) = deleted_sync_ids.get(&inc_school.sync_id) {
                if inc_school.updated_at <= del_at {
                    continue;
                }
            }

            if let Some(loc_school) = self.schools.iter_mut().find(|s| s.sync_id == inc_school.sync_id) {
                if inc_school.updated_at > loc_school.updated_at {
                    loc_school.name = inc_school.name.clone();
                    loc_school.address = inc_school.address.clone();
                    loc_school.updated_at = inc_school.updated_at;
                    updated += 1;
                }
            } else {
                let mut new_school = inc_school.clone();
                if self.schools.iter().any(|s| s.id == new_school.id) {
                    new_school.id = self.next_id();
                } else if new_school.id >= self.next_id {
                    self.next_id = new_school.id + 1;
                }
                self.schools.push(new_school);
                added += 1;
            }
        }

        let school_map: HashMap<String, usize> = self
            .schools
            .iter()
            .map(|s| (s.sync_id.clone(), s.id))
            .collect();

        // 3. Merge Teachers
        for inc_teacher in &incoming.teachers {
            if let Some(&del_at) = deleted_sync_ids.get(&inc_teacher.sync_id) {
                if inc_teacher.updated_at <= del_at {
                    continue;
                }
            }

            if let Some(loc_teacher) = self.teachers.iter_mut().find(|t| t.sync_id == inc_teacher.sync_id) {
                if inc_teacher.updated_at > loc_teacher.updated_at {
                    loc_teacher.name = inc_teacher.name.clone();
                    loc_teacher.subject = inc_teacher.subject.clone();
                    if let Some(&mapped_school_id) = school_map.get(&inc_teacher.school_sync_id) {
                        loc_teacher.school_id = mapped_school_id;
                        loc_teacher.school_sync_id = inc_teacher.school_sync_id.clone();
                    }
                    loc_teacher.updated_at = inc_teacher.updated_at;
                    updated += 1;
                }
            } else {
                let mut new_teacher = inc_teacher.clone();
                if self.teachers.iter().any(|t| t.id == new_teacher.id) {
                    new_teacher.id = self.next_id();
                } else if new_teacher.id >= self.next_id {
                    self.next_id = new_teacher.id + 1;
                }
                if let Some(&mapped_school_id) = school_map.get(&new_teacher.school_sync_id) {
                    new_teacher.school_id = mapped_school_id;
                }
                self.teachers.push(new_teacher);
                added += 1;
            }
        }

        // 4. Merge Students
        for inc_student in &incoming.students {
            if let Some(&del_at) = deleted_sync_ids.get(&inc_student.sync_id) {
                if inc_student.updated_at <= del_at {
                    continue;
                }
            }

            if let Some(loc_student) = self.students.iter_mut().find(|st| st.sync_id == inc_student.sync_id) {
                if inc_student.updated_at > loc_student.updated_at {
                    loc_student.name = inc_student.name.clone();
                    loc_student.grade = inc_student.grade.clone();
                    if let Some(&mapped_school_id) = school_map.get(&inc_student.school_sync_id) {
                        loc_student.school_id = mapped_school_id;
                        loc_student.school_sync_id = inc_student.school_sync_id.clone();
                    }
                    loc_student.updated_at = inc_student.updated_at;
                    updated += 1;
                }
            } else {
                let mut new_student = inc_student.clone();
                if self.students.iter().any(|s| s.id == new_student.id) {
                    new_student.id = self.next_id();
                } else if new_student.id >= self.next_id {
                    self.next_id = new_student.id + 1;
                }
                if let Some(&mapped_school_id) = school_map.get(&new_student.school_sync_id) {
                    new_student.school_id = mapped_school_id;
                }
                self.students.push(new_student);
                added += 1;
            }
        }

        if added > 0 || updated > 0 {
            self.data_version += 1;
        }

        (added, updated)
    }
}

pub struct AppState {
    db: Arc<Mutex<Database>>,
    file_path: PathBuf,
    p2p: Arc<P2pManager>,
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
    let school = {
        let mut db = state.db.lock().unwrap();
        let id = db.next_id();
        let school = School {
            id,
            sync_id: generate_uuid(),
            name,
            address,
            updated_at: current_timestamp(),
        };
        db.schools.push(school.clone());
        db.data_version += 1;
        school
    };
    state.save();

    let p2p = state.p2p.clone();
    tokio::spawn(async move {
        p2p.broadcast_mutation_push().await;
    });

    school
}

#[tauri::command]
fn delete_school(id: usize, state: tauri::State<AppState>) {
    let tombstone = {
        let mut db = state.db.lock().unwrap();
        let sync_id = db
            .schools
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.sync_id.clone());

        db.schools.retain(|s| s.id != id);
        db.data_version += 1;

        sync_id.map(|sid| Tombstone {
            sync_id: sid,
            entity_type: "school".to_string(),
            deleted_at: current_timestamp(),
        })
    };

    if let Some(t) = tombstone {
        state.db.lock().unwrap().tombstones.push(t);
    }
    state.save();

    let p2p = state.p2p.clone();
    tokio::spawn(async move {
        p2p.broadcast_mutation_push().await;
    });
}

#[tauri::command]
fn get_teachers(state: tauri::State<AppState>) -> Vec<Teacher> {
    state.db.lock().unwrap().teachers.clone()
}

#[tauri::command]
fn add_teacher(
    name: String,
    subject: String,
    school_id: usize,
    state: tauri::State<AppState>,
) -> Teacher {
    let teacher = {
        let mut db = state.db.lock().unwrap();
        let id = db.next_id();
        let school_sync_id = db
            .schools
            .iter()
            .find(|s| s.id == school_id)
            .map(|s| s.sync_id.clone())
            .unwrap_or_default();

        let teacher = Teacher {
            id,
            sync_id: generate_uuid(),
            name,
            subject,
            school_id,
            school_sync_id,
            updated_at: current_timestamp(),
        };
        db.teachers.push(teacher.clone());
        db.data_version += 1;
        teacher
    };
    state.save();

    let p2p = state.p2p.clone();
    tokio::spawn(async move {
        p2p.broadcast_mutation_push().await;
    });

    teacher
}

#[tauri::command]
fn delete_teacher(id: usize, state: tauri::State<AppState>) {
    let tombstone = {
        let mut db = state.db.lock().unwrap();
        let sync_id = db
            .teachers
            .iter()
            .find(|t| t.id == id)
            .map(|t| t.sync_id.clone());

        db.teachers.retain(|t| t.id != id);
        db.data_version += 1;

        sync_id.map(|sid| Tombstone {
            sync_id: sid,
            entity_type: "teacher".to_string(),
            deleted_at: current_timestamp(),
        })
    };

    if let Some(t) = tombstone {
        state.db.lock().unwrap().tombstones.push(t);
    }
    state.save();

    let p2p = state.p2p.clone();
    tokio::spawn(async move {
        p2p.broadcast_mutation_push().await;
    });
}

#[tauri::command]
fn get_students(state: tauri::State<AppState>) -> Vec<Student> {
    state.db.lock().unwrap().students.clone()
}

#[tauri::command]
fn add_student(
    name: String,
    grade: String,
    school_id: usize,
    state: tauri::State<AppState>,
) -> Student {
    let student = {
        let mut db = state.db.lock().unwrap();
        let id = db.next_id();
        let school_sync_id = db
            .schools
            .iter()
            .find(|s| s.id == school_id)
            .map(|s| s.sync_id.clone())
            .unwrap_or_default();

        let student = Student {
            id,
            sync_id: generate_uuid(),
            name,
            grade,
            school_id,
            school_sync_id,
            updated_at: current_timestamp(),
        };
        db.students.push(student.clone());
        db.data_version += 1;
        student
    };
    state.save();

    let p2p = state.p2p.clone();
    tokio::spawn(async move {
        p2p.broadcast_mutation_push().await;
    });

    student
}

#[tauri::command]
fn delete_student(id: usize, state: tauri::State<AppState>) {
    let tombstone = {
        let mut db = state.db.lock().unwrap();
        let sync_id = db
            .students
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.sync_id.clone());

        db.students.retain(|s| s.id != id);
        db.data_version += 1;

        sync_id.map(|sid| Tombstone {
            sync_id: sid,
            entity_type: "student".to_string(),
            deleted_at: current_timestamp(),
        })
    };

    if let Some(t) = tombstone {
        state.db.lock().unwrap().tombstones.push(t);
    }
    state.save();

    let p2p = state.p2p.clone();
    tokio::spawn(async move {
        p2p.broadcast_mutation_push().await;
    });
}

// P2P / Serverless Mesh Commands

#[tauri::command]
async fn get_node_profile(state: tauri::State<'_, AppState>) -> Result<NodeProfile, String> {
    let prof = state.p2p.profile.read().await.clone();
    Ok(prof)
}

#[tauri::command]
async fn get_online_peers(state: tauri::State<'_, AppState>) -> Result<Vec<PeerInfo>, String> {
    let peers = state.p2p.get_peers_vec().await;
    Ok(peers)
}

#[tauri::command]
async fn sync_with_all_peers(state: tauri::State<'_, AppState>) -> Result<SyncResult, String> {
    let res = state.p2p.sync_all_peers().await;
    Ok(res)
}

#[tauri::command]
async fn sync_with_peer(
    peer_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<SyncResult, String> {
    let peers = state.p2p.get_peers_vec().await;
    let peer = peers
        .into_iter()
        .find(|p| p.peer_id == peer_id)
        .ok_or_else(|| "Peer not found".to_string())?;

    match state
        .p2p
        .sync_with_peer_internal(&peer.ip_address, peer.tcp_port)
        .await
    {
        Ok((added, updated)) => Ok(SyncResult {
            success: true,
            peers_contacted: 1,
            added_records: added,
            updated_records: updated,
            message: format!(
                "Synced with {}: +{} added, {} updated",
                peer.device_name, added, updated
            ),
        }),
        Err(e) => Err(format!("Sync failed: {}", e)),
    }
}

#[tauri::command]
async fn broadcast_network_message(
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let ok = state.p2p.broadcast_chat_message(&content).await;
    Ok(ok)
}

#[tauri::command]
async fn get_network_activity(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<NetworkActivity>, String> {
    let acts = state.p2p.get_activities_vec().await;
    Ok(acts)
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DownloadProgressPayload {
    pub downloaded: u64,
    pub total: u64,
    pub percentage: u32,
    pub status: String,
}

#[tauri::command]
async fn download_android_apk(
    url: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tauri::Emitter;
    use tokio::io::AsyncWriteExt;

    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .or_else(|_| app_handle.path().cache_dir())
        .or_else(|_| app_handle.path().temp_dir())
        .unwrap_or_else(|_| std::env::temp_dir());

    let _ = std::fs::create_dir_all(&cache_dir);
    let target_path = cache_dir.join("edudash_update.apk");

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP status: {}", response.status()));
    }

    let total_bytes = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&target_path)
        .await
        .map_err(|e| format!("Failed to create APK file: {}", e))?;

    let mut stream = response.bytes_stream();
    let mut downloaded_bytes: u64 = 0;
    let mut last_pct: u32 = 0;

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Stream read error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Disk write error: {}", e))?;

        downloaded_bytes += chunk.len() as u64;

        let pct = if total_bytes > 0 {
            ((downloaded_bytes as f64 / total_bytes as f64) * 100.0).round() as u32
        } else {
            0
        };

        if pct != last_pct || downloaded_bytes == total_bytes {
            last_pct = pct;
            let _ = app_handle.emit(
                "tauri://download-progress",
                DownloadProgressPayload {
                    downloaded: downloaded_bytes,
                    total: total_bytes,
                    percentage: pct,
                    status: "downloading".to_string(),
                },
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target_path, std::fs::Permissions::from_mode(0o644));
    }

    let _ = app_handle.emit(
        "tauri://download-progress",
        DownloadProgressPayload {
            downloaded: downloaded_bytes,
            total: total_bytes,
            percentage: 100,
            status: "finished".to_string(),
        },
    );

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn install_android_apk(
    file_path: String,
    #[allow(unused_variables)] app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        launch_android_apk_installer(&file_path)
            .map_err(|e| format!("Failed to launch Android package installer: {}", e))?;
        Ok(true)
    }

    #[cfg(not(target_os = "android"))]
    {
        println!("install_android_apk called on desktop: {}", file_path);
        Ok(true)
    }
}

#[cfg(target_os = "android")]
fn launch_android_apk_installer(file_path: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let vm_ptr = ndk_context::android_context().vm();
    let ctx_ptr = ndk_context::android_context().context();
    let vm = unsafe { jni::JavaVM::from_raw(vm_ptr as *mut _) }?;
    let mut env = vm.attach_current_thread()?;
    let context = unsafe { jni::objects::JObject::from_raw(ctx_ptr as *mut _) };

    // 1. Relax StrictMode to allow file:// URI sharing without FileUriExposedException
    if let Ok(strict_mode) = env.find_class("android/os/StrictMode") {
        if let Ok(builder_class) = env.find_class("android/os/StrictMode$VmPolicy$Builder") {
            if let Ok(builder) = env.new_object(builder_class, "()V", &[]) {
                if let Ok(policy) = env.call_method(&builder, "build", "()Landroid/os/StrictMode$VmPolicy;", &[]) {
                    if let Ok(policy_obj) = policy.l() {
                        let _ = env.call_static_method(
                            strict_mode,
                            "setVmPolicy",
                            "(Landroid/os/StrictMode$VmPolicy;)V",
                            &[(&policy_obj).into()],
                        );
                    }
                }
            }
        }
    }

    // 2. Create File and Uri
    let file_class = env.find_class("java/io/File")?;
    let path_jstr = env.new_string(file_path)?;
    let file_obj = env.new_object(file_class, "(Ljava/lang/String;)V", &[(&path_jstr).into()])?;

    let uri_class = env.find_class("android/net/Uri")?;
    let uri_obj = env.call_static_method(
        uri_class,
        "fromFile",
        "(Ljava/io/File;)Landroid/net/Uri;",
        &[(&file_obj).into()],
    )?.l()?;

    // 3. Create Intent(Intent.ACTION_VIEW)
    let intent_class = env.find_class("android/content/Intent")?;
    let action_view_str = env.new_string("android.intent.action.VIEW")?;
    let intent_obj = env.new_object(
        intent_class,
        "(Ljava/lang/String;)V",
        &[(&action_view_str).into()],
    )?;

    // 4. intent.setDataAndType(uri, "application/vnd.android.package-archive")
    let mime_type = env.new_string("application/vnd.android.package-archive")?;
    env.call_method(
        &intent_obj,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[(&uri_obj).into(), (&mime_type).into()],
    )?;

    // 5. intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION)
    let flags: i32 = 0x10000000 | 0x00000001;
    env.call_method(
        &intent_obj,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[flags.into()],
    )?;

    // 6. context.startActivity(intent)
    env.call_method(
        context,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[(&intent_obj).into()],
    )?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .or_else(|_| app.path().app_local_data_dir())
                .or_else(|_| app.path().document_dir())
                .unwrap_or_else(|_| {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                });
            let _ = std::fs::create_dir_all(&app_dir);
            let file_path = app_dir.join("edudash_records.json");

            let mut db = if file_path.exists() {
                std::fs::read_to_string(&file_path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Database>(&s).ok())
                    .unwrap_or_default()
            } else {
                Database {
                    schools: Vec::new(),
                    teachers: Vec::new(),
                    students: Vec::new(),
                    tombstones: Vec::new(),
                    next_id: 1,
                    data_version: 1,
                }
            };

            // Migrate any existing older records to support sync_id and timestamps
            db.migrate_missing_sync_ids();

            let db_arc = Arc::new(Mutex::new(db));
            let app_handle = app.handle().clone();

            // Start P2P Manager asynchronously on Tokio runtime
            let p2p_manager = tauri::async_runtime::block_on(async {
                P2pManager::start(db_arc.clone(), file_path.clone(), Some(app_handle)).await
            })
            .expect("failed to start serverless P2P manager");

            app.manage(AppState {
                db: db_arc,
                file_path,
                p2p: p2p_manager,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_schools,
            add_school,
            delete_school,
            get_teachers,
            add_teacher,
            delete_teacher,
            get_students,
            add_student,
            delete_student,
            get_node_profile,
            get_online_peers,
            sync_with_all_peers,
            sync_with_peer,
            broadcast_network_message,
            get_network_activity,
            download_android_apk,
            install_android_apk
        ]);

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
