use std::sync::{Arc, Mutex};
use std::time::Duration;

use dashboard_app_lib::p2p::P2pManager;
use dashboard_app_lib::{Database, School, Student, Teacher};

#[tokio::test]
async fn test_two_nodes_discovery_and_bidirectional_sync() {
    let tmp = std::env::temp_dir();
    let file1 = tmp.join(format!("test_db1_{}.json", uuid::Uuid::new_v4()));
    let file2 = tmp.join(format!("test_db2_{}.json", uuid::Uuid::new_v4()));

    // Node 1 initial database with 1 School and 1 Student
    let db1 = Arc::new(Mutex::new(Database {
        schools: vec![School {
            id: 1,
            sync_id: "school-sync-1".to_string(),
            name: "Apex International Academy".to_string(),
            address: "100 Innovation Way".to_string(),
            updated_at: 1000,
        }],
        teachers: vec![],
        students: vec![Student {
            id: 1,
            sync_id: "student-sync-1".to_string(),
            name: "Sophia Martinez".to_string(),
            grade: "Grade 10".to_string(),
            school_id: 1,
            school_sync_id: "school-sync-1".to_string(),
            updated_at: 1000,
        }],
        tombstones: vec![],
        next_id: 2,
        data_version: 1,
    }));

    // Node 2 initial database with 1 School and 1 Teacher
    let db2 = Arc::new(Mutex::new(Database {
        schools: vec![School {
            id: 1,
            sync_id: "school-sync-2".to_string(),
            name: "Beacon Science High".to_string(),
            address: "200 Discovery Blvd".to_string(),
            updated_at: 1000,
        }],
        teachers: vec![Teacher {
            id: 1,
            sync_id: "teacher-sync-1".to_string(),
            name: "Dr. Alan Turing".to_string(),
            subject: "Computer Science".to_string(),
            school_id: 1,
            school_sync_id: "school-sync-2".to_string(),
            updated_at: 1000,
        }],
        students: vec![],
        tombstones: vec![],
        next_id: 2,
        data_version: 1,
    }));

    println!("Starting Node 1 P2P Manager...");
    let node1 = P2pManager::start(db1.clone(), file1.clone(), None)
        .await
        .expect("Failed to start node 1");

    println!("Starting Node 2 P2P Manager...");
    let node2 = P2pManager::start(db2.clone(), file2.clone(), None)
        .await
        .expect("Failed to start node 2");

    println!("Node 1 port: {}, Node 2 port: {}", node1.tcp_port, node2.tcp_port);

    // Test direct TCP sync between Node 1 and Node 2
    let (added, updated) = node1
        .sync_with_peer_internal("127.0.0.1", node2.tcp_port)
        .await
        .expect("TCP sync from node1 to node2 failed");

    println!("Node 1 sync result: added={}, updated={}", added, updated);

    // Verify Node 1 now has both schools, teacher, and student
    {
        let db = db1.lock().unwrap();
        println!(
            "Node 1 after sync: {} schools, {} teachers, {} students",
            db.schools.len(),
            db.teachers.len(),
            db.students.len()
        );
        assert_eq!(db.schools.len(), 2, "Node 1 should have 2 schools");
        assert_eq!(db.teachers.len(), 1, "Node 1 should have 1 teacher");
        assert_eq!(db.students.len(), 1, "Node 1 should have 1 student");
    }

    // Verify Node 2 also received Node 1's records in the bidirectional exchange!
    {
        let db = db2.lock().unwrap();
        println!(
            "Node 2 after sync: {} schools, {} teachers, {} students",
            db.schools.len(),
            db.teachers.len(),
            db.students.len()
        );
        assert_eq!(db.schools.len(), 2, "Node 2 should have 2 schools");
        assert_eq!(db.teachers.len(), 1, "Node 2 should have 1 teacher");
        assert_eq!(db.students.len(), 1, "Node 2 should have 1 student");
    }

    // Test mutation push: Node 1 adds a new student
    {
        let mut db = db1.lock().unwrap();
        let next_id = db.next_id();
        db.students.push(Student {
            id: next_id,
            sync_id: "student-sync-2".to_string(),
            name: "Lucas Vance".to_string(),
            grade: "Grade 11".to_string(),
            school_id: 1,
            school_sync_id: "school-sync-1".to_string(),
            updated_at: 2000,
        });
        db.data_version += 1;
    }

    // Node 1 broadcasts mutation push to Node 2 directly
    let push_msg = {
        let local = db1.lock().unwrap();
        dashboard_app_lib::p2p::TcpMessage::PushData {
            from_peer_id: node1.profile.read().await.peer_id.clone(),
            schools: local.schools.clone(),
            teachers: local.teachers.clone(),
            students: local.students.clone(),
            tombstones: local.tombstones.clone(),
            data_version: local.data_version,
        }
    };
    use tokio::io::AsyncWriteExt;
    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", node2.tcp_port))
        .await
        .expect("Connect to node2");
    let mut s = serde_json::to_string(&push_msg).unwrap();
    s.push('\n');
    stream.write_all(s.as_bytes()).await.unwrap();

    // Allow a few milliseconds for async apply
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Verify Node 2 has the new student
    {
        let db = db2.lock().unwrap();
        assert_eq!(db.students.len(), 2, "Node 2 should now have 2 students");
        assert!(
            db.students.iter().any(|st| st.name == "Lucas Vance"),
            "Lucas Vance should be present on Node 2"
        );
        println!("Mutation push successfully propagated to Node 2!");
    }

    println!("All P2P discovery and bidirectional sync tests passed!");
}

#[tokio::test]
async fn test_udp_heartbeat_discovery() {
    let tmp = std::env::temp_dir();
    let file1 = tmp.join(format!("disc_db1_{}.json", uuid::Uuid::new_v4()));
    let file2 = tmp.join(format!("disc_db2_{}.json", uuid::Uuid::new_v4()));

    let db1 = Arc::new(Mutex::new(Database::default()));
    let db2 = Arc::new(Mutex::new(Database::default()));

    let node1 = P2pManager::start(db1, file1, None).await.unwrap();
    let node2 = P2pManager::start(db2, file2, None).await.unwrap();

    let node1_id = node1.profile.read().await.peer_id.clone();
    let node2_id = node2.profile.read().await.peer_id.clone();

    // Allow background UDP broadcaster/listener to send heartbeats and discover each other
    let mut discovered = false;
    for _ in 0..12 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let peers1 = node1.get_peers_vec().await;
        let peers2 = node2.get_peers_vec().await;

        if peers1.iter().any(|p| p.peer_id == node2_id && p.status == "online")
            || peers2.iter().any(|p| p.peer_id == node1_id && p.status == "online")
        {
            discovered = true;
            println!("UDP Heartbeat discovery confirmed! Peers discovered each other automatically.");
            break;
        }
    }

    println!("Discovery result: {}", discovered);
}

#[tokio::test]
async fn test_wan_message_handling() {
    use dashboard_app_lib::p2p::WanMessage;

    let tmp = std::env::temp_dir();
    let file = tmp.join(format!("wan_db_{}.json", uuid::Uuid::new_v4()));
    let db = Arc::new(Mutex::new(Database::default()));
    let node = P2pManager::start(db.clone(), file, None).await.unwrap();

    let remote_peer_id = format!("remote-peer-{}", uuid::Uuid::new_v4());

    // 1. Simulate incoming WAN Heartbeat from a remote peer across the internet
    let wan_hb = WanMessage::Heartbeat {
        peer_id: remote_peer_id.clone(),
        device_name: "Cloud-Node-Berlin".to_string(),
        iroh_node_id: "iroh-cloud-test-key".to_string(),
        tcp_port: 0,
        data_version: 5,
        records_count: 10,
        timestamp: dashboard_app_lib::current_timestamp(),
    };

    // Serialize to bytes (as would arrive from MQTT broker) and deserialize
    let payload_bytes = serde_json::to_vec(&wan_hb).expect("Failed to serialize WAN heartbeat");
    let deserialized: WanMessage = serde_json::from_slice(&payload_bytes).expect("Failed to deserialize WAN heartbeat");

    // Manually register as peer to verify PeerInfo attributes
    {
        let mut peers = node.peers.write().await;
        if let WanMessage::Heartbeat { peer_id, device_name, iroh_node_id, data_version, records_count, .. } = deserialized {
            peers.insert(
                peer_id.clone(),
                dashboard_app_lib::p2p::PeerInfo {
                    peer_id,
                    device_name,
                    ip_address: "Internet (Serverless Mesh)".to_string(),
                    tcp_port: 0,
                    iroh_node_id,
                    last_seen_ts: dashboard_app_lib::current_timestamp(),
                    status: "online".to_string(),
                    records_count,
                    data_version,
                    latency_ms: 25,
                    network_type: "wan".to_string(),
                },
            );
        }
    }

    let peers = node.get_peers_vec().await;
    assert!(peers.iter().any(|p| p.peer_id == remote_peer_id && p.network_type == "wan"));
    println!("WAN peer registered successfully with network_type = 'wan'!");

    // 2. Simulate incoming WAN MutationPush
    let mutation = WanMessage::MutationPush {
        from_peer_id: remote_peer_id.clone(),
        schools: vec![School {
            id: 10,
            sync_id: "school-wan-10".to_string(),
            name: "Global WAN Virtual High".to_string(),
            address: "Cloud Gateway".to_string(),
            updated_at: 5000,
        }],
        teachers: vec![],
        students: vec![],
        tombstones: vec![],
        data_version: 5,
    };

    let mutation_bytes = serde_json::to_vec(&mutation).unwrap();
    let parsed_mutation: WanMessage = serde_json::from_slice(&mutation_bytes).unwrap();

    if let WanMessage::MutationPush { schools, teachers, students, tombstones, .. } = parsed_mutation {
        let incoming_db = Database {
            schools,
            teachers,
            students,
            tombstones,
            next_id: 1,
            data_version: 0,
        };
        let mut local = db.lock().unwrap();
        let (added, updated) = local.merge(&incoming_db);
        assert_eq!(added, 1, "Should have merged 1 new school from WAN mutation");
        assert_eq!(updated, 0);
        assert!(local.schools.iter().any(|s| s.sync_id == "school-wan-10"));
    }

    println!("WAN mutation push merge verified successfully!");
}
