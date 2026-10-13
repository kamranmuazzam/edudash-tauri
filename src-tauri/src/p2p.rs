use std::collections::{HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::RwLock;

use crate::{current_timestamp, Database, School, Student, Teacher, Tombstone};

pub const MULTICAST_IPV4: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 99);
pub const DISCOVERY_PORT: u16 = 47888;
const MAX_ACTIVITIES: usize = 60;
const PEER_OFFLINE_TIMEOUT_SECS: u64 = 8;
const PEER_PRUNE_TIMEOUT_SECS: u64 = 35;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NodeProfile {
    pub peer_id: String,
    pub device_name: String,
    pub iroh_node_id: String,
    pub local_ip: String,
    pub tcp_port: u16,
    pub started_at: u64,
}

pub fn default_network_type() -> String {
    "lan".to_string()
}

pub const WAN_BROKER_HOST: &str = "broker.emqx.io";
pub const WAN_BROKER_PORT: u16 = 1883;
pub const TOPIC_HEARTBEAT: &str = "edudash/mesh/v1/heartbeat";
pub const TOPIC_BROADCAST_MUTATION: &str = "edudash/mesh/v1/broadcast/mutation";
pub const TOPIC_BROADCAST_CHAT: &str = "edudash/mesh/v1/broadcast/chat";

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct PeerInfo {
    pub peer_id: String,
    pub device_name: String,
    pub ip_address: String,
    pub tcp_port: u16,
    pub iroh_node_id: String,
    pub last_seen_ts: u64,
    pub status: String, // "online" | "syncing" | "offline"
    pub records_count: usize,
    pub data_version: u64,
    pub latency_ms: u64,
    #[serde(default = "default_network_type")]
    pub network_type: String, // "lan" | "wan" | "hybrid"
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NetworkActivity {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub category: String, // "peer" | "sync" | "message" | "system"
    pub timestamp: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct SyncResult {
    pub success: bool,
    pub peers_contacted: usize,
    pub added_records: usize,
    pub updated_records: usize,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum DiscoveryMessage {
    #[serde(rename = "heartbeat")]
    Heartbeat {
        peer_id: String,
        device_name: String,
        iroh_node_id: String,
        tcp_port: u16,
        data_version: u64,
        records_count: usize,
        timestamp: u64,
    },
    #[serde(rename = "heartbeat_ack")]
    HeartbeatAck {
        peer_id: String,
        device_name: String,
        iroh_node_id: String,
        tcp_port: u16,
        data_version: u64,
        records_count: usize,
        timestamp: u64,
    },
    #[serde(rename = "broadcast_message")]
    BroadcastMessage {
        id: String,
        peer_id: String,
        sender_name: String,
        content: String,
        timestamp: u64,
    },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "action")]
pub enum TcpMessage {
    #[serde(rename = "get_data")]
    GetData {
        from_peer_id: String,
        known_version: u64,
    },
    #[serde(rename = "data_payload")]
    DataPayload {
        from_peer_id: String,
        schools: Vec<School>,
        teachers: Vec<Teacher>,
        students: Vec<Student>,
        tombstones: Vec<Tombstone>,
        data_version: u64,
    },
    #[serde(rename = "push_data")]
    PushData {
        from_peer_id: String,
        schools: Vec<School>,
        teachers: Vec<Teacher>,
        students: Vec<Student>,
        tombstones: Vec<Tombstone>,
        data_version: u64,
    },
    #[serde(rename = "chat")]
    Chat {
        id: String,
        from_peer_id: String,
        sender_name: String,
        content: String,
        timestamp: u64,
    },
    #[serde(rename = "ack")]
    Ack {
        status: String,
        added: usize,
        updated: usize,
    },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum WanMessage {
    #[serde(rename = "heartbeat")]
    Heartbeat {
        peer_id: String,
        device_name: String,
        iroh_node_id: String,
        tcp_port: u16,
        data_version: u64,
        records_count: usize,
        timestamp: u64,
    },
    #[serde(rename = "sync_request")]
    SyncRequest {
        from_peer_id: String,
        from_device_name: String,
        known_version: u64,
    },
    #[serde(rename = "sync_response")]
    SyncResponse {
        from_peer_id: String,
        from_device_name: String,
        schools: Vec<School>,
        teachers: Vec<Teacher>,
        students: Vec<Student>,
        tombstones: Vec<Tombstone>,
        data_version: u64,
    },
    #[serde(rename = "mutation_push")]
    MutationPush {
        from_peer_id: String,
        schools: Vec<School>,
        teachers: Vec<Teacher>,
        students: Vec<Student>,
        tombstones: Vec<Tombstone>,
        data_version: u64,
    },
    #[serde(rename = "chat")]
    Chat {
        id: String,
        peer_id: String,
        sender_name: String,
        content: String,
        timestamp: u64,
    },
}

pub struct P2pManager {
    pub profile: Arc<RwLock<NodeProfile>>,
    pub peers: Arc<RwLock<HashMap<String, PeerInfo>>>,
    pub activities: Arc<RwLock<VecDeque<NetworkActivity>>>,
    pub db: Arc<Mutex<Database>>,
    pub file_path: PathBuf,
    pub app_handle: Arc<RwLock<Option<tauri::AppHandle>>>,
    pub running: Arc<AtomicBool>,
    pub tcp_port: u16,
    pub wan_client: Arc<RwLock<Option<rumqttc::AsyncClient>>>,
}

impl P2pManager {
    pub async fn start(
        db: Arc<Mutex<Database>>,
        file_path: PathBuf,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error + Send + Sync>> {
        let peer_id = uuid::Uuid::new_v4().to_string();

        let raw_host = gethostname::gethostname().to_string_lossy().to_string();
        let device_name = if raw_host.is_empty() || raw_host == "localhost" {
            format!("Node-{}", &peer_id[..6])
        } else {
            raw_host
        };

        let local_ip = local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "127.0.0.1".to_string());

        // Bind TCP Server for direct synchronization and high-speed data transfer
        let tcp_listener = TcpListener::bind("0.0.0.0:0").await?;
        let tcp_port = tcp_listener.local_addr()?.port();

        // Initialize Iroh endpoint in background for cryptographic Ed25519 node identity
        let initial_iroh_id = format!("iroh-{}", &peer_id[..12]);
        let profile = Arc::new(RwLock::new(NodeProfile {
            peer_id: peer_id.clone(),
            device_name: device_name.clone(),
            iroh_node_id: initial_iroh_id,
            local_ip,
            tcp_port,
            started_at: current_timestamp(),
        }));

        let manager = Arc::new(Self {
            profile: profile.clone(),
            peers: Arc::new(RwLock::new(HashMap::new())),
            activities: Arc::new(RwLock::new(VecDeque::new())),
            db: db.clone(),
            file_path,
            app_handle: Arc::new(RwLock::new(app_handle)),
            running: Arc::new(AtomicBool::new(true)),
            tcp_port,
            wan_client: Arc::new(RwLock::new(None)),
        });

        // Launch Iroh Node async init
        let profile_clone = profile.clone();
        let manager_clone = manager.clone();
        tokio::spawn(async move {
            match iroh::Endpoint::builder(iroh::endpoint::presets::N0).bind().await {
                Ok(endpoint) => {
                    let node_id = endpoint.id().to_string();
                    let mut prof = profile_clone.write().await;
                    prof.iroh_node_id = node_id.clone();
                    drop(prof);
                    manager_clone
                        .add_activity(
                            "Iroh Node Initialized",
                            &format!("Serverless P2P cryptographic ID: {}", &node_id[..16]),
                            "system",
                        )
                        .await;
                }
                Err(err) => {
                    eprintln!("Iroh endpoint bind note: {}", err);
                }
            }
        });

        manager
            .add_activity(
                "Mesh Network Started",
                &format!(
                    "Listening on port {} (Zero-config local multicast & UDP discovery active)",
                    tcp_port
                ),
                "system",
            )
            .await;

        // Start UDP Listener & Multicast
        Self::spawn_udp_discovery(manager.clone());

        // Start Periodic Heartbeat Broadcast
        Self::spawn_heartbeat_broadcaster(manager.clone());

        // Start TCP Server
        Self::spawn_tcp_server(manager.clone(), tcp_listener);

        // Start Peer Pruning & Health Monitor
        Self::spawn_peer_monitor(manager.clone());

        // Start Global Serverless WAN Mesh (EMQX / MQTT)
        Self::spawn_wan_mesh(manager.clone());

        Ok(manager)
    }

    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        if let Ok(mut lock) = self.app_handle.try_write() {
            *lock = Some(handle);
        }
    }

    pub async fn add_activity(&self, title: &str, detail: &str, category: &str) {
        let act = NetworkActivity {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            detail: detail.to_string(),
            category: category.to_string(),
            timestamp: current_timestamp(),
        };

        let mut acts = self.activities.write().await;
        acts.push_front(act.clone());
        if acts.len() > MAX_ACTIVITIES {
            acts.pop_back();
        }
        drop(acts);

        self.emit_event("p2p://activity-logged", &act);
    }

    pub fn emit_event<T: Serialize + Clone>(&self, event: &str, payload: &T) {
        if let Ok(lock) = self.app_handle.try_read() {
            if let Some(ref handle) = *lock {
                let _ = handle.emit(event, payload.clone());
            }
        }
    }

    fn spawn_udp_discovery(self_arc: Arc<Self>) {
        tokio::spawn(async move {
            // Setup dual-socket UDP: bind to 0.0.0.0:47888 with SO_REUSEPORT if possible,
            // or fallback to 0.0.0.0:0 while joining multicast group
            let socket = match Self::create_multicast_socket(DISCOVERY_PORT) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("Failed to bind port {}: {}, falling back to ephemeral port", DISCOVERY_PORT, e);
                    match Self::create_multicast_socket(0) {
                        Ok(s) => s,
                        Err(e2) => {
                            eprintln!("Fatal error creating discovery UDP socket: {}", e2);
                            return;
                        }
                    }
                }
            };

            let mut buf = vec![0u8; 65535];
            while self_arc.running.load(Ordering::Relaxed) {
                match socket.recv_from(&mut buf).await {
                    Ok((len, src_addr)) => {
                        let data = &buf[..len];
                        if let Ok(msg) = serde_json::from_slice::<DiscoveryMessage>(data) {
                            self_arc.handle_discovery_message(msg, src_addr).await;
                        }
                    }
                    Err(_e) => {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
            }
        });
    }

    fn create_multicast_socket(port: u16) -> Result<UdpSocket, Box<dyn std::error::Error + Send + Sync>> {
        let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
        socket.set_reuse_address(true)?;
        #[cfg(not(windows))]
        socket.set_reuse_port(true).ok();
        socket.set_broadcast(true)?;
        socket.set_multicast_loop_v4(true)?;
        socket.set_nonblocking(true)?;

        let bind_addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port);
        socket.bind(&bind_addr.into())?;
        socket.join_multicast_v4(&MULTICAST_IPV4, &Ipv4Addr::UNSPECIFIED).ok();

        let std_socket: std::net::UdpSocket = socket.into();
        let tokio_socket = UdpSocket::from_std(std_socket)?;
        Ok(tokio_socket)
    }

    async fn handle_discovery_message(&self, msg: DiscoveryMessage, src_addr: SocketAddr) {
        let my_peer_id = {
            let prof = self.profile.read().await;
            prof.peer_id.clone()
        };

        match msg {
            DiscoveryMessage::Heartbeat {
                peer_id,
                device_name,
                iroh_node_id,
                tcp_port,
                data_version,
                records_count,
                timestamp,
            } => {
                if peer_id == my_peer_id {
                    return; // Ignore own beacon
                }

                let now = current_timestamp();
                let latency_ms = now.saturating_sub(timestamp);
                let ip_str = src_addr.ip().to_string();

                let mut is_new = false;
                let mut should_sync = false;

                {
                    let mut peers = self.peers.write().await;
                    if let Some(existing) = peers.get_mut(&peer_id) {
                        existing.last_seen_ts = now;
                        existing.status = "online".to_string();
                        existing.ip_address = ip_str.clone();
                        existing.tcp_port = tcp_port;
                        existing.data_version = data_version;
                        existing.records_count = records_count;
                        existing.iroh_node_id = iroh_node_id.clone();
                        existing.latency_ms = latency_ms;
                        if existing.network_type == "wan" {
                            existing.network_type = "hybrid".to_string();
                        }

                        // Check if version mismatch triggers auto-sync
                        let local_version = {
                            self.db.lock().unwrap().data_version
                        };
                        if data_version != local_version {
                            should_sync = true;
                        }
                    } else {
                        is_new = true;
                        peers.insert(
                            peer_id.clone(),
                            PeerInfo {
                                peer_id: peer_id.clone(),
                                device_name: device_name.clone(),
                                ip_address: ip_str.clone(),
                                tcp_port,
                                iroh_node_id: iroh_node_id.clone(),
                                last_seen_ts: now,
                                status: "online".to_string(),
                                records_count,
                                data_version,
                                latency_ms,
                                network_type: "lan".to_string(),
                            },
                        );
                        should_sync = true;
                    }
                }

                if is_new {
                    self.add_activity(
                        "New Peer Discovered",
                        &format!("{} ({}:{}) connected on mesh", device_name, ip_str, tcp_port),
                        "peer",
                    )
                    .await;
                    self.emit_peer_list().await;

                    // Immediately send a direct UDP acknowledgement so the sender knows about us right away
                    self.send_unicast_ack(&src_addr).await;
                }

                if should_sync {
                    let self_clone = Arc::new(self.clone_ref());
                    tokio::spawn(async move {
                        let _ = self_clone.sync_with_peer_internal(&ip_str, tcp_port).await;
                    });
                }
            }
            DiscoveryMessage::HeartbeatAck {
                peer_id,
                device_name,
                iroh_node_id,
                tcp_port,
                data_version,
                records_count,
                timestamp,
            } => {
                if peer_id == my_peer_id {
                    return;
                }

                let now = current_timestamp();
                let latency_ms = now.saturating_sub(timestamp);
                let ip_str = src_addr.ip().to_string();

                let is_new = {
                    let mut peers = self.peers.write().await;
                    if let Some(existing) = peers.get_mut(&peer_id) {
                        existing.last_seen_ts = now;
                        existing.status = "online".to_string();
                        existing.ip_address = ip_str.clone();
                        existing.tcp_port = tcp_port;
                        existing.data_version = data_version;
                        existing.records_count = records_count;
                        existing.iroh_node_id = iroh_node_id;
                        existing.latency_ms = latency_ms;
                        if existing.network_type == "wan" {
                            existing.network_type = "hybrid".to_string();
                        }
                        false
                    } else {
                        peers.insert(
                            peer_id.clone(),
                            PeerInfo {
                                peer_id: peer_id.clone(),
                                device_name: device_name.clone(),
                                ip_address: ip_str.clone(),
                                tcp_port,
                                iroh_node_id,
                                last_seen_ts: now,
                                status: "online".to_string(),
                                records_count,
                                data_version,
                                latency_ms,
                                network_type: "lan".to_string(),
                            },
                        );
                        true
                    }
                };

                if is_new {
                    self.add_activity(
                        "Peer Mutual Handshake",
                        &format!("{} established mesh connection", device_name),
                        "peer",
                    )
                    .await;
                    self.emit_peer_list().await;
                }
            }
            DiscoveryMessage::BroadcastMessage {
                id: _,
                peer_id,
                sender_name,
                content,
                timestamp: _,
            } => {
                if peer_id == my_peer_id {
                    return;
                }
                self.add_activity(
                    &format!("Broadcast from {}", sender_name),
                    &content,
                    "message",
                )
                .await;
                self.emit_event(
                    "p2p://message-received",
                    &serde_json::json!({
                        "sender": sender_name,
                        "content": content,
                        "peer_id": peer_id,
                    }),
                );
            }
        }
    }

    async fn send_unicast_ack(&self, target_addr: &SocketAddr) {
        let (profile, db_info) = {
            let prof = self.profile.read().await.clone();
            let db = self.db.lock().unwrap();
            let count = db.schools.len() + db.teachers.len() + db.students.len();
            (prof, (db.data_version, count))
        };

        let ack = DiscoveryMessage::HeartbeatAck {
            peer_id: profile.peer_id,
            device_name: profile.device_name,
            iroh_node_id: profile.iroh_node_id,
            tcp_port: profile.tcp_port,
            data_version: db_info.0,
            records_count: db_info.1,
            timestamp: current_timestamp(),
        };

        if let Ok(bytes) = serde_json::to_vec(&ack) {
            if let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await {
                let _ = sock.send_to(&bytes, target_addr).await;
            }
        }
    }

    fn spawn_heartbeat_broadcaster(self_arc: Arc<Self>) {
        tokio::spawn(async move {
            let send_socket = match UdpSocket::bind("0.0.0.0:0").await {
                Ok(s) => {
                    let _ = s.set_broadcast(true);
                    s
                }
                Err(e) => {
                    eprintln!("Failed to bind heartbeat sender UDP: {}", e);
                    return;
                }
            };

            let destinations = vec![
                SocketAddr::new(MULTICAST_IPV4.into(), DISCOVERY_PORT),
                SocketAddr::new(Ipv4Addr::BROADCAST.into(), DISCOVERY_PORT),
                SocketAddr::new(Ipv4Addr::LOCALHOST.into(), DISCOVERY_PORT),
            ];

            while self_arc.running.load(Ordering::Relaxed) {
                let (profile, (data_ver, count)) = {
                    let prof = self_arc.profile.read().await.clone();
                    let db = self_arc.db.lock().unwrap();
                    let c = db.schools.len() + db.teachers.len() + db.students.len();
                    (prof, (db.data_version, c))
                };

                let hb = DiscoveryMessage::Heartbeat {
                    peer_id: profile.peer_id,
                    device_name: profile.device_name,
                    iroh_node_id: profile.iroh_node_id,
                    tcp_port: profile.tcp_port,
                    data_version: data_ver,
                    records_count: count,
                    timestamp: current_timestamp(),
                };

                if let Ok(bytes) = serde_json::to_vec(&hb) {
                    for dst in &destinations {
                        let _ = send_socket.send_to(&bytes, dst).await;
                    }
                }

                tokio::time::sleep(Duration::from_millis(2500)).await;
            }
        });
    }

    fn spawn_tcp_server(self_arc: Arc<Self>, listener: TcpListener) {
        tokio::spawn(async move {
            while self_arc.running.load(Ordering::Relaxed) {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let manager = self_arc.clone();
                        tokio::spawn(async move {
                            manager.handle_tcp_connection(stream).await;
                        });
                    }
                    Err(_e) => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        });
    }

    async fn handle_tcp_connection(&self, stream: TcpStream) {
        let (reader, mut writer) = stream.into_split();
        let mut buf_reader = BufReader::new(reader);
        let mut line = String::new();

        while let Ok(n) = buf_reader.read_line(&mut line).await {
            if n == 0 {
                break;
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                line.clear();
                continue;
            }

            if let Ok(msg) = serde_json::from_str::<TcpMessage>(trimmed) {
                match msg {
                    TcpMessage::GetData {
                        from_peer_id: _,
                        known_version: _,
                    } => {
                        let from_peer_id = self.profile.read().await.peer_id.clone();
                        let db_payload = {
                            let db = self.db.lock().unwrap();
                            TcpMessage::DataPayload {
                                from_peer_id,
                                schools: db.schools.clone(),
                                teachers: db.teachers.clone(),
                                students: db.students.clone(),
                                tombstones: db.tombstones.clone(),
                                data_version: db.data_version,
                            }
                        };
                        if let Ok(mut json) = serde_json::to_string(&db_payload) {
                            json.push('\n');
                            let _ = writer.write_all(json.as_bytes()).await;
                        }
                    }
                    TcpMessage::PushData {
                        from_peer_id,
                        schools,
                        teachers,
                        students,
                        tombstones,
                        data_version: _,
                    } => {
                        let incoming_db = Database {
                            schools,
                            teachers,
                            students,
                            tombstones,
                            next_id: 1,
                            data_version: 0,
                        };

                        let (added, updated) = {
                            let mut local = self.db.lock().unwrap();
                            let changes = local.merge(&incoming_db);
                            drop(local);
                            self.save_local_db();
                            changes
                        };

                        if added > 0 || updated > 0 {
                            self.emit_event(
                                "p2p://data-synced",
                                &serde_json::json!({
                                    "added": added,
                                    "updated": updated,
                                    "source": from_peer_id,
                                }),
                            );
                            self.add_activity(
                                "Data Synchronized",
                                &format!("Merged +{} new and {} updated records", added, updated),
                                "sync",
                            )
                            .await;
                        }

                        let ack = TcpMessage::Ack {
                            status: "ok".to_string(),
                            added,
                            updated,
                        };
                        if let Ok(mut json) = serde_json::to_string(&ack) {
                            json.push('\n');
                            let _ = writer.write_all(json.as_bytes()).await;
                        }
                    }
                    TcpMessage::Chat {
                        id: _,
                        from_peer_id,
                        sender_name,
                        content,
                        timestamp: _,
                    } => {
                        self.add_activity(
                            &format!("Message from {}", sender_name),
                            &content,
                            "message",
                        )
                        .await;
                        self.emit_event(
                            "p2p://message-received",
                            &serde_json::json!({
                                "sender": sender_name,
                                "content": content,
                                "peer_id": from_peer_id,
                            }),
                        );
                        let ack = TcpMessage::Ack {
                            status: "delivered".to_string(),
                            added: 0,
                            updated: 0,
                        };
                        if let Ok(mut json) = serde_json::to_string(&ack) {
                            json.push('\n');
                            let _ = writer.write_all(json.as_bytes()).await;
                        }
                    }
                    _ => {}
                }
            }
            line.clear();
        }
    }

    fn spawn_peer_monitor(self_arc: Arc<Self>) {
        tokio::spawn(async move {
            while self_arc.running.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_secs(2)).await;

                let now = current_timestamp();
                let mut changed = false;

                {
                    let mut peers = self_arc.peers.write().await;
                    peers.retain(|_id, peer| {
                        let age = now.saturating_sub(peer.last_seen_ts);
                        let prune_limit = if peer.network_type == "wan" { 60 } else { PEER_PRUNE_TIMEOUT_SECS };
                        let offline_limit = if peer.network_type == "wan" { 15 } else { PEER_OFFLINE_TIMEOUT_SECS };
                        if age > prune_limit {
                            changed = true;
                            false
                        } else {
                            if age > offline_limit && peer.status == "online" {
                                peer.status = "offline".to_string();
                                changed = true;
                            }
                            true
                        }
                    });
                }

                if changed {
                    self_arc.emit_peer_list().await;
                }
            }
        });
    }

    fn spawn_wan_mesh(self_arc: Arc<Self>) {
        tokio::spawn(async move {
            let (my_peer_id, _device_name) = {
                let prof = self_arc.profile.read().await;
                (prof.peer_id.clone(), prof.device_name.clone())
            };

            let my_inbox_topic = format!("edudash/mesh/v1/peer/{}/inbox", my_peer_id);
            let client_id = format!("edudash-{}", &my_peer_id[..10]);

            let mut mqttoptions = rumqttc::MqttOptions::new(client_id, WAN_BROKER_HOST, WAN_BROKER_PORT);
            mqttoptions.set_keep_alive(Duration::from_secs(30));
            mqttoptions.set_clean_session(true);

            let (client, mut eventloop) = rumqttc::AsyncClient::new(mqttoptions, 50);

            {
                let mut w = self_arc.wan_client.write().await;
                *w = Some(client.clone());
            }

            self_arc
                .add_activity(
                    "Global WAN Mesh Connected",
                    &format!("Connected to serverless broker ({}:{})", WAN_BROKER_HOST, WAN_BROKER_PORT),
                    "system",
                )
                .await;

            // Subscribe to mesh topics
            let _ = client.subscribe(TOPIC_HEARTBEAT, rumqttc::QoS::AtLeastOnce).await;
            let _ = client.subscribe(&my_inbox_topic, rumqttc::QoS::AtLeastOnce).await;
            let _ = client.subscribe(TOPIC_BROADCAST_MUTATION, rumqttc::QoS::AtLeastOnce).await;
            let _ = client.subscribe(TOPIC_BROADCAST_CHAT, rumqttc::QoS::AtLeastOnce).await;

            // Spawn WAN periodic heartbeat task
            let client_hb = client.clone();
            let self_hb = self_arc.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                while self_hb.running.load(Ordering::Relaxed) {
                    let (prof, (data_ver, count)) = {
                        let p = self_hb.profile.read().await.clone();
                        let db = self_hb.db.lock().unwrap();
                        let c = db.schools.len() + db.teachers.len() + db.students.len();
                        (p, (db.data_version, c))
                    };

                    let hb = WanMessage::Heartbeat {
                        peer_id: prof.peer_id,
                        device_name: prof.device_name,
                        iroh_node_id: prof.iroh_node_id,
                        tcp_port: prof.tcp_port,
                        data_version: data_ver,
                        records_count: count,
                        timestamp: current_timestamp(),
                    };

                    if let Ok(bytes) = serde_json::to_vec(&hb) {
                        let _ = client_hb
                            .publish(TOPIC_HEARTBEAT, rumqttc::QoS::AtMostOnce, false, bytes)
                            .await;
                    }

                    tokio::time::sleep(Duration::from_secs(4)).await;
                }
            });

            // Process incoming WAN messages from the event loop
            while self_arc.running.load(Ordering::Relaxed) {
                match eventloop.poll().await {
                    Ok(rumqttc::Event::Incoming(rumqttc::Packet::Publish(publish))) => {
                        let payload = publish.payload;
                        if let Ok(msg) = serde_json::from_slice::<WanMessage>(&payload) {
                            self_arc.handle_wan_message(msg).await;
                        }
                    }
                    Ok(rumqttc::Event::Incoming(rumqttc::Packet::ConnAck(_))) => {
                        let _ = client.subscribe(TOPIC_HEARTBEAT, rumqttc::QoS::AtLeastOnce).await;
                        let _ = client.subscribe(&my_inbox_topic, rumqttc::QoS::AtLeastOnce).await;
                        let _ = client.subscribe(TOPIC_BROADCAST_MUTATION, rumqttc::QoS::AtLeastOnce).await;
                        let _ = client.subscribe(TOPIC_BROADCAST_CHAT, rumqttc::QoS::AtLeastOnce).await;
                    }
                    Err(_) => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                    _ => {}
                }
            }
        });
    }

    async fn handle_wan_message(&self, msg: WanMessage) {
        let (my_peer_id, my_device_name) = {
            let prof = self.profile.read().await;
            (prof.peer_id.clone(), prof.device_name.clone())
        };

        match msg {
            WanMessage::Heartbeat {
                peer_id,
                device_name,
                iroh_node_id,
                tcp_port: _,
                data_version,
                records_count,
                timestamp,
            } => {
                if peer_id == my_peer_id {
                    return; // Ignore own beacon
                }

                let now = current_timestamp();
                let latency_ms = now.saturating_sub(timestamp) * 1000;
                let mut is_new = false;
                let mut should_sync = false;

                {
                    let mut peers = self.peers.write().await;
                    if let Some(existing) = peers.get_mut(&peer_id) {
                        existing.last_seen_ts = now;
                        existing.status = "online".to_string();
                        existing.data_version = data_version;
                        existing.records_count = records_count;
                        existing.iroh_node_id = iroh_node_id.clone();
                        existing.latency_ms = latency_ms.min(999);
                        if existing.network_type == "lan" {
                            existing.network_type = "hybrid".to_string();
                        }

                        let local_version = self.db.lock().unwrap().data_version;
                        if data_version != local_version {
                            should_sync = true;
                        }
                    } else {
                        is_new = true;
                        peers.insert(
                            peer_id.clone(),
                            PeerInfo {
                                peer_id: peer_id.clone(),
                                device_name: device_name.clone(),
                                ip_address: "Internet (Serverless Mesh)".to_string(),
                                tcp_port: 0,
                                iroh_node_id: iroh_node_id.clone(),
                                last_seen_ts: now,
                                status: "online".to_string(),
                                records_count,
                                data_version,
                                latency_ms: latency_ms.min(999),
                                network_type: "wan".to_string(),
                            },
                        );
                        should_sync = true;
                    }
                }

                if is_new {
                    self.add_activity(
                        "WAN Peer Discovered",
                        &format!("{} online via global serverless mesh", device_name),
                        "peer",
                    )
                    .await;
                    self.emit_peer_list().await;
                }

                if should_sync {
                    let self_clone = Arc::new(self.clone_ref());
                    tokio::spawn(async move {
                        let _ = self_clone.request_wan_sync(&peer_id).await;
                    });
                }
            }
            WanMessage::SyncRequest {
                from_peer_id,
                from_device_name: _,
                known_version: _,
            } => {
                if from_peer_id == my_peer_id {
                    return;
                }

                let payload = {
                    let db = self.db.lock().unwrap();
                    WanMessage::SyncResponse {
                        from_peer_id: my_peer_id.clone(),
                        from_device_name: my_device_name,
                        schools: db.schools.clone(),
                        teachers: db.teachers.clone(),
                        students: db.students.clone(),
                        tombstones: db.tombstones.clone(),
                        data_version: db.data_version,
                    }
                };

                let target_topic = format!("edudash/mesh/v1/peer/{}/inbox", from_peer_id);
                if let Ok(bytes) = serde_json::to_vec(&payload) {
                    if let Some(client) = self.wan_client.read().await.as_ref() {
                        let _ = client
                            .publish(target_topic, rumqttc::QoS::AtLeastOnce, false, bytes)
                            .await;
                    }
                }
            }
            WanMessage::SyncResponse {
                from_peer_id,
                from_device_name,
                schools,
                teachers,
                students,
                tombstones,
                data_version: _,
            } => {
                if from_peer_id == my_peer_id {
                    return;
                }

                let inc_db = Database {
                    schools,
                    teachers,
                    students,
                    tombstones,
                    next_id: 1,
                    data_version: 0,
                };

                let (added, updated) = {
                    let mut local = self.db.lock().unwrap();
                    let changes = local.merge(&inc_db);
                    drop(local);
                    if changes.0 > 0 || changes.1 > 0 {
                        self.save_local_db();
                    }
                    changes
                };

                if added > 0 || updated > 0 {
                    self.emit_event(
                        "p2p://data-synced",
                        &serde_json::json!({
                            "added": added,
                            "updated": updated,
                            "source": from_peer_id,
                        }),
                    );
                    self.add_activity(
                        "WAN Sync Completed",
                        &format!("Merged +{} added, {} updated records from {}", added, updated, from_device_name),
                        "sync",
                    )
                    .await;
                }
            }
            WanMessage::MutationPush {
                from_peer_id,
                schools,
                teachers,
                students,
                tombstones,
                data_version: _,
            } => {
                if from_peer_id == my_peer_id {
                    return;
                }

                let inc_db = Database {
                    schools,
                    teachers,
                    students,
                    tombstones,
                    next_id: 1,
                    data_version: 0,
                };

                let (added, updated) = {
                    let mut local = self.db.lock().unwrap();
                    let changes = local.merge(&inc_db);
                    drop(local);
                    if changes.0 > 0 || changes.1 > 0 {
                        self.save_local_db();
                    }
                    changes
                };

                if added > 0 || updated > 0 {
                    self.emit_event(
                        "p2p://data-synced",
                        &serde_json::json!({
                            "added": added,
                            "updated": updated,
                            "source": from_peer_id,
                        }),
                    );
                    self.add_activity(
                        "Live WAN Update",
                        &format!("Instantly merged +{} new and {} updated records via WAN", added, updated),
                        "sync",
                    )
                    .await;
                }
            }
            WanMessage::Chat {
                id: _,
                peer_id,
                sender_name,
                content,
                timestamp: _,
            } => {
                if peer_id == my_peer_id {
                    return;
                }
                self.add_activity(
                    &format!("WAN Broadcast from {}", sender_name),
                    &content,
                    "message",
                )
                .await;
                self.emit_event(
                    "p2p://message-received",
                    &serde_json::json!({
                        "sender": sender_name,
                        "content": content,
                        "peer_id": peer_id,
                    }),
                );
            }
        }
    }

    pub async fn request_wan_sync(&self, target_peer_id: &str) -> bool {
        let (my_id, my_name, local_ver) = {
            let p = self.profile.read().await;
            let v = self.db.lock().unwrap().data_version;
            (p.peer_id.clone(), p.device_name.clone(), v)
        };

        let req = WanMessage::SyncRequest {
            from_peer_id: my_id,
            from_device_name: my_name,
            known_version: local_ver,
        };

        let topic = format!("edudash/mesh/v1/peer/{}/inbox", target_peer_id);
        if let Ok(bytes) = serde_json::to_vec(&req) {
            if let Some(client) = self.wan_client.read().await.as_ref() {
                return client
                    .publish(topic, rumqttc::QoS::AtLeastOnce, false, bytes)
                    .await
                    .is_ok();
            }
        }
        false
    }

    pub async fn emit_peer_list(&self) {
        let list = self.get_peers_vec().await;
        self.emit_event("p2p://peer-list-updated", &list);
    }

    pub async fn get_peers_vec(&self) -> Vec<PeerInfo> {
        let peers = self.peers.read().await;
        let mut list: Vec<PeerInfo> = peers.values().cloned().collect();
        list.sort_by(|a, b| {
            if a.status == "online" && b.status != "online" {
                std::cmp::Ordering::Less
            } else if a.status != "online" && b.status == "online" {
                std::cmp::Ordering::Greater
            } else {
                b.last_seen_ts.cmp(&a.last_seen_ts)
            }
        });
        list
    }

    pub async fn get_activities_vec(&self) -> Vec<NetworkActivity> {
        let acts = self.activities.read().await;
        acts.iter().cloned().collect()
    }

    pub async fn sync_with_peer_internal(
        &self,
        ip: &str,
        port: u16,
    ) -> Result<(usize, usize), Box<dyn std::error::Error + Send + Sync>> {
        let target = format!("{}:{}", ip, port);
        let stream = tokio::time::timeout(
            Duration::from_secs(4),
            TcpStream::connect(&target),
        )
        .await??;

        let (reader, mut writer) = stream.into_split();
        let mut buf_reader = BufReader::new(reader);

        // 1. Send GetData request
        let my_peer_id = self.profile.read().await.peer_id.clone();
        let local_version = self.db.lock().unwrap().data_version;
        let get_req = TcpMessage::GetData {
            from_peer_id: my_peer_id.clone(),
            known_version: local_version,
        };

        let mut req_str = serde_json::to_string(&get_req)?;
        req_str.push('\n');
        writer.write_all(req_str.as_bytes()).await?;

        // 2. Read incoming DataPayload
        let mut resp_line = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            buf_reader.read_line(&mut resp_line),
        )
        .await??;

        let incoming_msg: TcpMessage = serde_json::from_str(resp_line.trim())?;

        let (mut added, mut updated) = (0, 0);

        if let TcpMessage::DataPayload {
            from_peer_id: _,
            schools,
            teachers,
            students,
            tombstones,
            data_version: _,
        } = incoming_msg
        {
            let inc_db = Database {
                schools,
                teachers,
                students,
                tombstones,
                next_id: 1,
                data_version: 0,
            };

            // Merge incoming records
            {
                let mut local = self.db.lock().unwrap();
                let changes = local.merge(&inc_db);
                added = changes.0;
                updated = changes.1;
                drop(local);
                if added > 0 || updated > 0 {
                    self.save_local_db();
                }
            }

            // 3. Send back our full dataset so the remote peer also receives any records they didn't have
            let push_msg = {
                let local = self.db.lock().unwrap();
                TcpMessage::PushData {
                    from_peer_id: my_peer_id,
                    schools: local.schools.clone(),
                    teachers: local.teachers.clone(),
                    students: local.students.clone(),
                    tombstones: local.tombstones.clone(),
                    data_version: local.data_version,
                }
            };

            let mut push_str = serde_json::to_string(&push_msg)?;
            push_str.push('\n');
            let _ = writer.write_all(push_str.as_bytes()).await;
            let _ = writer.flush().await;

            let mut ack_line = String::new();
            let _ = buf_reader.read_line(&mut ack_line).await;

            if added > 0 || updated > 0 {
                self.emit_event(
                    "p2p://data-synced",
                    &serde_json::json!({
                        "added": added,
                        "updated": updated,
                        "target": target,
                    }),
                );
                self.add_activity(
                    "P2P Sync Completed",
                    &format!("Synchronized with {}: +{} added, {} updated", target, added, updated),
                    "sync",
                )
                .await;
            }
        }

        Ok((added, updated))
    }

    pub async fn sync_all_peers(&self) -> SyncResult {
        let peers = self.get_peers_vec().await;
        let online_peers: Vec<PeerInfo> = peers
            .into_iter()
            .filter(|p| p.status == "online")
            .collect();

        if online_peers.is_empty() {
            return SyncResult {
                success: true,
                peers_contacted: 0,
                added_records: 0,
                updated_records: 0,
                message: "No other peers currently online on the mesh.".to_string(),
            };
        }

        let mut total_added = 0;
        let mut total_updated = 0;
        let mut contacted = 0;

        for peer in &online_peers {
            if peer.network_type == "wan" || peer.tcp_port == 0 {
                if self.request_wan_sync(&peer.peer_id).await {
                    contacted += 1;
                }
            } else {
                match self.sync_with_peer_internal(&peer.ip_address, peer.tcp_port).await {
                    Ok((a, u)) => {
                        total_added += a;
                        total_updated += u;
                        contacted += 1;
                    }
                    Err(e) => {
                        eprintln!("Error syncing with peer {}: {}", peer.device_name, e);
                    }
                }
            }
        }

        SyncResult {
            success: true,
            peers_contacted: contacted,
            added_records: total_added,
            updated_records: total_updated,
            message: format!(
                "Successfully contacted {} peer(s) across LAN & WAN mesh.",
                contacted
            ),
        }
    }

    pub async fn broadcast_mutation_push(&self) {
        let peers = self.get_peers_vec().await;
        let my_id = self.profile.read().await.peer_id.clone();

        let (schools, teachers, students, tombstones, data_version) = {
            let local = self.db.lock().unwrap();
            (
                local.schools.clone(),
                local.teachers.clone(),
                local.students.clone(),
                local.tombstones.clone(),
                local.data_version,
            )
        };

        // 1. Broadcast over WAN broker to all peers across the internet
        let wan_msg = WanMessage::MutationPush {
            from_peer_id: my_id.clone(),
            schools: schools.clone(),
            teachers: teachers.clone(),
            students: students.clone(),
            tombstones: tombstones.clone(),
            data_version,
        };

        if let Ok(bytes) = serde_json::to_vec(&wan_msg) {
            if let Some(client) = self.wan_client.read().await.as_ref() {
                let _ = client
                    .publish(
                        TOPIC_BROADCAST_MUTATION,
                        rumqttc::QoS::AtLeastOnce,
                        false,
                        bytes,
                    )
                    .await;
            }
        }

        // 2. Direct TCP push to LAN/hybrid peers
        let lan_peers: Vec<PeerInfo> = peers
            .into_iter()
            .filter(|p| (p.network_type == "lan" || p.network_type == "hybrid") && p.status == "online" && p.tcp_port > 0)
            .collect();

        if lan_peers.is_empty() {
            return;
        }

        let tcp_msg = TcpMessage::PushData {
            from_peer_id: my_id,
            schools,
            teachers,
            students,
            tombstones,
            data_version,
        };

        let mut push_str = match serde_json::to_string(&tcp_msg) {
            Ok(s) => s,
            Err(_) => return,
        };
        push_str.push('\n');

        for peer in lan_peers {
            let ip = peer.ip_address.clone();
            let port = peer.tcp_port;
            let payload = push_str.clone();

            tokio::spawn(async move {
                if let Ok(Ok(mut stream)) = tokio::time::timeout(
                    Duration::from_secs(3),
                    TcpStream::connect(format!("{}:{}", ip, port)),
                )
                .await
                {
                    let _ = stream.write_all(payload.as_bytes()).await;
                }
            });
        }
    }

    pub async fn broadcast_chat_message(&self, content: &str) -> bool {
        let (prof, _peers) = {
            let p = self.profile.read().await.clone();
            let peers = self.get_peers_vec().await;
            (p, peers)
        };

        let chat_id = uuid::Uuid::new_v4().to_string();
        let now = current_timestamp();

        // 1. Broadcast over WAN broker
        let wan_msg = WanMessage::Chat {
            id: chat_id.clone(),
            peer_id: prof.peer_id.clone(),
            sender_name: prof.device_name.clone(),
            content: content.to_string(),
            timestamp: now,
        };

        if let Ok(bytes) = serde_json::to_vec(&wan_msg) {
            if let Some(client) = self.wan_client.read().await.as_ref() {
                let _ = client
                    .publish(TOPIC_BROADCAST_CHAT, rumqttc::QoS::AtLeastOnce, false, bytes)
                    .await;
            }
        }

        // 2. Broadcast over local UDP
        let udp_msg = DiscoveryMessage::BroadcastMessage {
            id: chat_id,
            peer_id: prof.peer_id,
            sender_name: prof.device_name,
            content: content.to_string(),
            timestamp: now,
        };

        if let Ok(bytes) = serde_json::to_vec(&udp_msg) {
            if let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await {
                let _ = sock.set_broadcast(true);
                let destinations = vec![
                    SocketAddr::new(MULTICAST_IPV4.into(), DISCOVERY_PORT),
                    SocketAddr::new(Ipv4Addr::BROADCAST.into(), DISCOVERY_PORT),
                    SocketAddr::new(Ipv4Addr::LOCALHOST.into(), DISCOVERY_PORT),
                ];
                for dst in destinations {
                    let _ = sock.send_to(&bytes, dst).await;
                }
            }
        }

        self.add_activity("Sent Broadcast Message", content, "message")
            .await;

        true
    }

    fn save_local_db(&self) {
        if let Ok(db) = self.db.lock() {
            if let Ok(json) = serde_json::to_string_pretty(&*db) {
                if let Some(parent) = self.file_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&self.file_path, json);
            }
        }
    }

    fn clone_ref(&self) -> Self {
        Self {
            profile: self.profile.clone(),
            peers: self.peers.clone(),
            activities: self.activities.clone(),
            db: self.db.clone(),
            file_path: self.file_path.clone(),
            app_handle: self.app_handle.clone(),
            running: self.running.clone(),
            tcp_port: self.tcp_port,
            wan_client: self.wan_client.clone(),
        }
    }
}
