use futures::StreamExt;
use idevice::{
    IdeviceService,
    provider::{IdeviceProvider, UsbmuxdProvider},
    services::lockdown::LockdownClient,
    usbmuxd::{UsbmuxdAddr, UsbmuxdConnection, UsbmuxdDevice, UsbmuxdListenEvent},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, OpenOptions},
    future::Future,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
    net::{TcpListener, UnixListener, UnixStream},
    process::{Child, Command},
    signal::unix::{SignalKind, signal},
    sync::{Mutex, RwLock, mpsc, oneshot, watch},
    time::{Instant, sleep, timeout},
};
use uuid::Uuid;

const RPC_VERSION: u16 = 1;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_AGENT_PORT: u16 = 5913;
const DEFAULT_SSH_PORT: u16 = 22;
const MAX_RPC_DEADLINE_MS: u64 = 120_000;
const RPC_OPERATION_SHUTDOWN_GRACE: Duration = Duration::from_secs(125);
const RPC_CLIENT_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
const DEVICE_SERVICE_CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcRequest {
    version: u16,
    request_id: String,
    auth: String,
    operation: String,
    device_id: Option<String>,
    port: Option<u16>,
    payload: Option<Value>,
    agent_secret: Option<String>,
    deadline_ms: Option<u64>,
    host_id: Option<String>,
    follow: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcResponse {
    version: u16,
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSummary {
    id: String,
    udid: String,
    device_id: u32,
    transport: String,
}

trait DeviceServiceStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin {}

impl<T> DeviceServiceStream for T where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin
{
}

type DeviceServiceConnectFuture =
    Pin<Box<dyn Future<Output = Result<Box<dyn DeviceServiceStream>, RpcError>> + Send>>;

trait DeviceServiceConnector: Send + Sync {
    fn connect(&self, device_id: String, port: u16) -> DeviceServiceConnectFuture;
}

struct UsbmuxdDeviceServiceConnector {
    mux_socket: PathBuf,
}

#[derive(Clone)]
struct CancellationToken {
    cancelled: watch::Sender<bool>,
}

impl CancellationToken {
    fn new() -> Self {
        let (cancelled, _) = watch::channel(false);
        Self { cancelled }
    }

    fn cancel(&self) {
        self.cancelled.send_replace(true);
    }

    fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    async fn cancelled(&self) {
        let mut receiver = self.cancelled.subscribe();
        if *receiver.borrow() {
            return;
        }
        let _ = receiver.changed().await;
    }
}

struct Tunnel {
    cancellation: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

struct BridgeState {
    secrets: Vec<String>,
    mux_socket: PathBuf,
    host_id: String,
    service_connector: Arc<dyn DeviceServiceConnector>,
    shutdown: CancellationToken,
    operation_gate: RwLock<()>,
    tunnels: Mutex<HashMap<String, Tunnel>>,
    cancellations: Mutex<HashMap<String, CancellationToken>>,
    event_sequence: AtomicU64,
    mux_recovery: Option<mpsc::UnboundedSender<String>>,
}

impl BridgeState {
    async fn register_cancellation(&self, request_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.cancellations
            .lock()
            .await
            .insert(request_id.to_string(), token.clone());
        token
    }

    async fn remove_cancellation(&self, request_id: &str) {
        self.cancellations.lock().await.remove(request_id);
    }

    async fn cancel_request(&self, request_id: &str) -> bool {
        let token = self.cancellations.lock().await.get(request_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}

fn error(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> RpcError {
    RpcError {
        code: code.into(),
        message: message.into(),
        retryable,
    }
}

fn response(request_id: String, result: Value) -> RpcResponse {
    RpcResponse {
        version: RPC_VERSION,
        request_id,
        ok: true,
        result: Some(result),
        error: None,
    }
}

fn failure(request_id: String, rpc_error: RpcError) -> RpcResponse {
    RpcResponse {
        version: RPC_VERSION,
        request_id,
        ok: false,
        result: None,
        error: Some(rpc_error),
    }
}

fn valid_frame_length(length: usize, maximum: usize) -> bool {
    length > 0 && length <= maximum
}

fn bridge_capabilities() -> [&'static str; 14] {
    [
        "list_devices",
        "pair",
        "metadata",
        "agent",
        "remote_command",
        "service_port",
        "open_tunnel",
        "close_tunnel",
        "health",
        "capabilities",
        "events",
        "file_read",
        "file_write",
        "cancel",
    ]
}

fn next_event_sequence(state: &BridgeState) -> u64 {
    state.event_sequence.fetch_add(1, Ordering::Relaxed) + 1
}

fn authorized_secret(secrets: &[String], candidate: &str) -> bool {
    secrets.iter().any(|secret| secret == candidate)
}

fn required_env(name: &str) -> Result<String, RpcError> {
    env::var(name).map_err(|_| error("configuration", format!("missing {name}"), false))
}

fn unix_path(name: &str, default: &str) -> PathBuf {
    PathBuf::from(env::var(name).unwrap_or_else(|_| default.to_string()))
}

fn device_summary(device: UsbmuxdDevice) -> DeviceSummary {
    let transport = match device.connection_type {
        idevice::usbmuxd::Connection::Usb => "usb".to_string(),
        idevice::usbmuxd::Connection::Network(address) => format!("wifi:{address}"),
        idevice::usbmuxd::Connection::Unknown(value) => format!("unknown:{value}"),
    };
    DeviceSummary {
        id: device.udid.clone(),
        udid: device.udid,
        device_id: device.device_id,
        transport,
    }
}

async fn mux_connection(state: &BridgeState) -> Result<UsbmuxdConnection, RpcError> {
    UsbmuxdAddr::UnixSocket(state.mux_socket.to_string_lossy().to_string())
        .connect(0)
        .await
        .map_err(|value| {
            error(
                "mux_unavailable",
                format!("could not connect to netmuxd: {value}"),
                true,
            )
        })
}

async fn find_device(
    mux_socket: &Path,
    id: &str,
) -> Result<(UsbmuxdDevice, UsbmuxdAddr), RpcError> {
    let addr = UsbmuxdAddr::UnixSocket(mux_socket.to_string_lossy().to_string());
    let mut mux = addr.connect(0).await.map_err(|value| {
        error(
            "mux_unavailable",
            format!("could not connect to netmuxd: {value}"),
            true,
        )
    })?;
    let devices = mux.get_devices().await.map_err(|value| {
        error(
            "device_discovery",
            format!("could not list devices: {value}"),
            true,
        )
    })?;
    devices
        .into_iter()
        .find(|device| device.udid == id || format!("id:{}", device.udid) == id)
        .map(|device| (device, addr))
        .ok_or_else(|| {
            error(
                "device_not_found",
                format!("device {id} is not connected"),
                true,
            )
        })
}

async fn provider_for(
    mux_socket: &Path,
    id: &str,
) -> Result<(UsbmuxdProvider, UsbmuxdAddr), RpcError> {
    let (device, addr) = find_device(mux_socket, id).await?;
    Ok((
        device.to_provider(addr.clone(), format!("dkrypt-device-{id}")),
        addr,
    ))
}

impl DeviceServiceConnector for UsbmuxdDeviceServiceConnector {
    fn connect(&self, device_id: String, port: u16) -> DeviceServiceConnectFuture {
        let mux_socket = self.mux_socket.clone();
        Box::pin(async move {
            let (provider, _) = provider_for(&mux_socket, &device_id).await?;
            let device = provider.connect(port).await.map_err(|value| {
                error(
                    "device_service_unavailable",
                    format!("could not connect to device service on port {port}: {value}"),
                    true,
                )
            })?;
            let socket = device.get_socket().ok_or_else(|| {
                error(
                    "device_service_unavailable",
                    format!("device service on port {port} did not expose a socket"),
                    true,
                )
            })?;
            Ok(Box::new(socket) as Box<dyn DeviceServiceStream>)
        })
    }
}

async fn read_value(lockdown: &mut LockdownClient, key: &str) -> Option<String> {
    lockdown
        .get_value(Some(key), None)
        .await
        .ok()
        .and_then(|value| value.as_string().map(ToString::to_string))
}

async fn list_device_records(state: &BridgeState) -> Result<Vec<UsbmuxdDevice>, RpcError> {
    let mut mux = mux_connection(state).await?;
    mux.get_devices().await.map_err(|value| {
        error(
            "device_discovery",
            format!("could not list devices: {value}"),
            true,
        )
    })
}

async fn list_devices(state: &BridgeState) -> Result<Value, RpcError> {
    serde_json::to_value(
        list_device_records(state)
            .await?
            .into_iter()
            .map(device_summary)
            .collect::<Vec<_>>(),
    )
    .map_err(|value| error("serialization", value.to_string(), false))
}

async fn device_event_snapshot(state: &BridgeState) -> Result<Value, RpcError> {
    Ok(json!({
        "type": "device_snapshot",
        "sequence": next_event_sequence(state),
        "devices": list_devices(state).await?,
    }))
}

async fn stream_device_events(
    stream: &mut UnixStream,
    state: Arc<BridgeState>,
    request_id: String,
) {
    let (events_tx, mut events_rx) = mpsc::channel(64);
    let (stop_tx, stop_rx) = oneshot::channel();
    let event_request_id = request_id.clone();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        match runtime {
            Ok(runtime) => runtime.block_on(stream_native_device_events(
                state,
                event_request_id,
                events_tx,
                stop_rx,
            )),
            Err(value) => {
                let _ = events_tx.blocking_send(failure(
                    event_request_id,
                    error(
                        "device_events",
                        format!("could not start device event listener: {value}"),
                        true,
                    ),
                ));
            }
        }
    });
    loop {
        tokio::select! {
            event = events_rx.recv() => match event {
                Some(value) => if write_frame(stream, &value).await.is_err() { return; },
                None => return,
            },
            frame = read_frame(stream) => {
                if frame.is_err() || frame.ok().flatten().is_none() {
                    let _ = stop_tx.send(());
                    return;
                }
            }
        }
    }
}

async fn stream_native_device_events(
    state: Arc<BridgeState>,
    request_id: String,
    sender: mpsc::Sender<RpcResponse>,
    stop: oneshot::Receiver<()>,
) {
    tokio::pin!(stop);
    let mut consecutive_failures = 0_u32;
    let mut devices = BTreeMap::new();
    loop {
        let mut mux = tokio::select! {
            _ = &mut stop => return,
            result = mux_connection(&state) => match result {
                Ok(value) => value,
                Err(value) => {
                    if !wait_for_device_event_retry(&state, &request_id, &sender, &devices, &mut stop, &mut consecutive_failures, value.message).await {
                        return;
                    }
                    continue;
                }
            },
        };
        let mut events = tokio::select! {
            _ = &mut stop => return,
            result = mux.listen() => match result {
                Ok(value) => value,
                Err(value) => {
                    if !wait_for_device_event_retry(
                        &state,
                        &request_id,
                        &sender,
                        &devices,
                        &mut stop,
                        &mut consecutive_failures,
                        format!("could not listen for usbmuxd events: {value}"),
                    ).await {
                        return;
                    }
                    continue;
                }
            },
        };
        let initial = tokio::select! {
            _ = &mut stop => return,
            result = list_device_records(&state) => match result {
                Ok(value) => value,
                Err(value) => {
                    drop(events);
                    drop(mux);
                    if !wait_for_device_event_retry(&state, &request_id, &sender, &devices, &mut stop, &mut consecutive_failures, value.message).await {
                        return;
                    }
                    continue;
                }
            },
        };
        devices = initial
            .into_iter()
            .map(|device| (device.device_id, device))
            .collect::<BTreeMap<_, _>>();
        let snapshot = json!({
            "type": "device_snapshot",
            "sequence": next_event_sequence(&state),
            "devices": devices.values().cloned().map(device_summary).collect::<Vec<_>>(),
        });
        if sender
            .send(response(request_id.clone(), snapshot))
            .await
            .is_err()
        {
            return;
        }
        let connected_at = Instant::now();
        let reason = loop {
            tokio::select! {
                _ = &mut stop => return,
                event = events.next() => {
                    let (event_type, event_device_id) = match event {
                        Some(Ok(UsbmuxdListenEvent::Connected(device))) => {
                            let device_id = device.device_id;
                            devices.insert(device_id, device);
                            ("device_connected", device_id)
                        }
                        Some(Ok(UsbmuxdListenEvent::Disconnected(device_id))) => {
                            devices.remove(&device_id);
                            ("device_disconnected", device_id)
                        }
                        Some(Err(value)) => break format!("usbmuxd event stream failed: {value}"),
                        None => break "usbmuxd event stream closed".to_string(),
                    };
                    let output = response(request_id.clone(), json!({
                        "type": event_type,
                        "sequence": next_event_sequence(&state),
                        "deviceId": event_device_id,
                        "devices": devices.values().cloned().map(device_summary).collect::<Vec<_>>(),
                    }));
                    if sender.send(output).await.is_err() { return; }
                }
            }
        };
        drop(events);
        drop(mux);
        if connected_at.elapsed() >= Duration::from_secs(30) {
            consecutive_failures = 0;
        }
        if !wait_for_device_event_retry(
            &state,
            &request_id,
            &sender,
            &devices,
            &mut stop,
            &mut consecutive_failures,
            reason,
        )
        .await
        {
            return;
        }
    }
}

async fn wait_for_device_event_retry(
    state: &BridgeState,
    request_id: &str,
    sender: &mpsc::Sender<RpcResponse>,
    devices: &BTreeMap<u32, UsbmuxdDevice>,
    stop: &mut Pin<&mut oneshot::Receiver<()>>,
    consecutive_failures: &mut u32,
    reason: String,
) -> bool {
    let reconnecting = response(
        request_id.to_string(),
        json!({
            "type": "device_event_stream_reconnecting",
            "sequence": next_event_sequence(state),
            "devices": devices.values().cloned().map(device_summary).collect::<Vec<_>>(),
        }),
    );
    if sender.send(reconnecting).await.is_err() {
        return false;
    }
    *consecutive_failures = consecutive_failures.saturating_add(1).min(30);
    let delay = netmuxd_restart_delay(*consecutive_failures);
    eprintln!(
        "usbmuxd event stream unavailable; reconnecting in {}ms: {reason}",
        delay.as_millis()
    );
    tokio::select! {
        _ = stop.as_mut() => false,
        _ = sleep(delay) => true,
    }
}

async fn device_metadata(state: &BridgeState, id: &str) -> Result<Value, RpcError> {
    let (provider, _) = provider_for(&state.mux_socket, id).await?;
    let mut lockdown = LockdownClient::connect(&provider).await.map_err(|value| {
        error(
            "lockdown_unavailable",
            format!("could not open lockdown: {value}"),
            true,
        )
    })?;
    let pairing = provider.get_pairing_file().await.map_err(|value| {
        error(
            "pairing_unavailable",
            format!("could not read pairing record: {value}"),
            true,
        )
    })?;
    lockdown.start_session(&pairing).await.map_err(|value| {
        error(
            "lockdown_session",
            format!("could not start lockdown session: {value}"),
            true,
        )
    })?;
    let mut values = Map::new();
    for key in [
        "DeviceName",
        "ProductType",
        "ProductVersion",
        "UniqueDeviceID",
        "SerialNumber",
        "BatteryCurrentCapacity",
        "BatteryIsCharging",
    ] {
        if let Some(value) = read_value(&mut lockdown, key).await {
            values.insert(key.to_string(), Value::String(value));
        }
    }
    Ok(Value::Object(values))
}

async fn pair_device(
    state: &BridgeState,
    id: &str,
    requested_host_id: Option<String>,
) -> Result<Value, RpcError> {
    let (device, addr) = find_device(&state.mux_socket, id).await?;
    let mut mux = addr.connect(0).await.map_err(|value| {
        error(
            "mux_unavailable",
            format!("could not connect to netmuxd: {value}"),
            true,
        )
    })?;
    let system_buid = mux.get_buid().await.map_err(|value| {
        error(
            "pairing",
            format!("could not read system BUID: {value}"),
            true,
        )
    })?;
    let provider = device.to_provider(addr.clone(), format!("dkrypt-pair-{id}"));
    let mut lockdown = LockdownClient::connect(&provider).await.map_err(|value| {
        error(
            "lockdown_unavailable",
            format!("could not open lockdown: {value}"),
            true,
        )
    })?;
    let host_id = requested_host_id.unwrap_or_else(|| state.host_id.clone());
    let pairing = lockdown
        .pair_once(host_id.clone(), system_buid, Some("dkrypt"))
        .await
        .map_err(|value| {
            error(
                "pairing_pending",
                format!("device pairing requires trust confirmation: {value}"),
                true,
            )
        })?;
    let serialized = pairing.clone().serialize().map_err(|value| {
        error(
            "pairing",
            format!("could not serialize pairing record: {value}"),
            false,
        )
    })?;
    mux.save_pair_record(&device.udid, serialized)
        .await
        .map_err(|value| {
            error(
                "pairing",
                format!("could not save pairing record: {value}"),
                true,
            )
        })?;
    Ok(json!({ "deviceId": device.udid, "hostId": host_id, "paired": true }))
}

async fn write_agent_frame<T: tokio::io::AsyncWrite + Unpin>(
    socket: &mut T,
    payload: &Value,
) -> Result<(), RpcError> {
    let body = serde_json::to_vec(payload)
        .map_err(|value| error("serialization", value.to_string(), false))?;
    if !valid_frame_length(body.len(), 4 * 1024 * 1024) {
        return Err(error(
            "invalid_frame",
            "agent request exceeds frame limits",
            false,
        ));
    }
    socket
        .write_u32(body.len() as u32)
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))?;
    socket
        .write_all(&body)
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))?;
    socket
        .flush()
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))
}

async fn read_agent_frame<T: tokio::io::AsyncRead + Unpin>(
    socket: &mut T,
) -> Result<Value, RpcError> {
    let length = socket
        .read_u32()
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))? as usize;
    if !valid_frame_length(length, 4 * 1024 * 1024) {
        return Err(error(
            "invalid_frame",
            "agent response exceeds frame limits",
            false,
        ));
    }
    let mut response = vec![0; length];
    socket
        .read_exact(&mut response)
        .await
        .map_err(|value| error("agent_io", value.to_string(), true))?;
    serde_json::from_slice(&response)
        .map_err(|value| error("invalid_response", value.to_string(), false))
}

async fn request_agent_exchange<T>(
    socket: &mut T,
    agent_secret: &str,
    payload: &Value,
    deadline_ms: u64,
) -> Result<Value, RpcError>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let bootstrap = json!({
        "version": 1,
        "requestId": Uuid::new_v4().to_string(),
        "action": "bootstrap",
        "secret": agent_secret
    });
    let deadline = Duration::from_millis(deadline_ms.clamp(1, 120_000));
    timeout(deadline, async {
        write_agent_frame(socket, &bootstrap).await?;
        let bootstrap_response = read_agent_frame(socket).await?;
        if bootstrap_response.get("ok") != Some(&Value::Bool(true)) {
            return Err(error(
                "agent_bootstrap",
                "device agent rejected the bridge secret",
                true,
            ));
        }
        write_agent_frame(socket, payload).await?;
        read_agent_frame(socket).await
    })
    .await
    .map_err(|_| {
        error(
            "agent_timeout",
            "device agent did not respond before the deadline",
            true,
        )
    })?
}

async fn request_agent(
    state: &BridgeState,
    id: &str,
    payload: Value,
    agent_secret: String,
    deadline_ms: u64,
) -> Result<Value, RpcError> {
    let mut socket = state
        .service_connector
        .connect(id.to_string(), DEFAULT_AGENT_PORT)
        .await
        .map_err(|value| {
            if value.code == "device_service_unavailable" {
                error("agent_unavailable", value.message, value.retryable)
            } else {
                value
            }
        })?;
    request_agent_exchange(&mut socket, &agent_secret, &payload, deadline_ms).await
}

async fn open_tunnel(
    state: Arc<BridgeState>,
    id: &str,
    remote_port: u16,
) -> Result<Value, RpcError> {
    open_tunnel_with_timeout(state, id, remote_port, DEVICE_SERVICE_CONNECT_TIMEOUT).await
}

async fn connect_device_service(
    state: &BridgeState,
    id: &str,
    remote_port: u16,
    connect_timeout: Duration,
) -> Result<Box<dyn DeviceServiceStream>, RpcError> {
    match timeout(
        connect_timeout,
        state.service_connector.connect(id.to_string(), remote_port),
    )
    .await
    {
        Ok(Ok(device)) => Ok(device),
        Ok(Err(failure)) => {
            if failure.retryable {
                if let Some(recovery) = &state.mux_recovery {
                    let _ = recovery.send(id.to_string());
                }
            }
            Err(failure)
        }
        Err(_) => {
            if let Some(recovery) = &state.mux_recovery {
                let _ = recovery.send(id.to_string());
            }
            Err(error(
                "device_service_timeout",
                format!(
                    "device service on port {remote_port} did not respond within {}ms",
                    connect_timeout.as_millis()
                ),
                true,
            ))
        }
    }
}

async fn open_tunnel_with_timeout(
    state: Arc<BridgeState>,
    id: &str,
    remote_port: u16,
    connect_timeout: Duration,
) -> Result<Value, RpcError> {
    let initial_service = connect_device_service(&state, id, remote_port, connect_timeout).await?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|value| error("tunnel_bind", value.to_string(), true))?;
    let local_port = listener
        .local_addr()
        .map_err(|value| error("tunnel_bind", value.to_string(), true))?
        .port();
    let tunnel_id = Uuid::new_v4().to_string();
    let device_id = id.to_string();
    let task_state = state.clone();
    let mut first_service = Some(initial_service);
    let cancellation = CancellationToken::new();
    let task_cancellation = cancellation.clone();
    let task = tokio::spawn(async move {
        let mut connection_tasks = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = task_cancellation.cancelled() => break,
                accepted = listener.accept() => {
                    let Ok((mut incoming, _)) = accepted else {
                        break;
                    };
                    let preconnected = first_service.take();
                    let service_state = task_state.clone();
                    let device_id = device_id.clone();
                    let connection_cancellation = task_cancellation.clone();
                    connection_tasks.spawn(async move {
                        let device = match preconnected {
                            Some(device) => Ok(device),
                            None => tokio::select! {
                                _ = connection_cancellation.cancelled() => return,
                                result = connect_device_service(&service_state, &device_id, remote_port, connect_timeout) => result,
                            },
                        };
                        let Ok(mut device) = device else {
                            return;
                        };
                        tokio::select! {
                            _ = connection_cancellation.cancelled() => {},
                            _ = copy_bidirectional(&mut incoming, &mut device) => {},
                        }
                    });
                }
                _ = connection_tasks.join_next(), if !connection_tasks.is_empty() => {}
            }
        }
        task_cancellation.cancel();
        while connection_tasks.join_next().await.is_some() {}
    });
    state
        .tunnels
        .lock()
        .await
        .insert(tunnel_id.clone(), Tunnel { cancellation, task });
    Ok(
        json!({ "tunnelId": tunnel_id, "host": "127.0.0.1", "port": local_port, "remotePort": remote_port }),
    )
}

async fn close_tunnel(state: &BridgeState, tunnel_id: &str) -> Value {
    if let Some(tunnel) = state.tunnels.lock().await.remove(tunnel_id) {
        tunnel.cancellation.cancel();
        let _ = tunnel.task.await;
        json!({ "closed": true })
    } else {
        json!({ "closed": false })
    }
}

async fn close_all_tunnels(state: &BridgeState) {
    let tunnel_ids = state
        .tunnels
        .lock()
        .await
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for tunnel_id in tunnel_ids {
        close_tunnel(state, &tunnel_id).await;
    }
}

async fn execute(state: Arc<BridgeState>, request: RpcRequest) -> Result<Value, RpcError> {
    match request.operation.as_str() {
        "capabilities" => Ok(
            json!({ "protocolVersion": RPC_VERSION, "transport": "rust-netmuxd", "capabilities": bridge_capabilities() }),
        ),
        "cancel" => {
            let request_id = request
                .payload
                .as_ref()
                .and_then(Value::as_str)
                .ok_or_else(|| error("invalid_request", "request id is required", false))?;
            Ok(
                json!({ "cancelled": state.cancel_request(request_id).await, "requestId": request_id }),
            )
        }
        "health" => {
            let devices = list_devices(&state).await?;
            let transport = devices
                .as_array()
                .map(|values| {
                    let has_usb = values
                        .iter()
                        .any(|value| value.get("transport").and_then(Value::as_str) == Some("usb"));
                    let has_wifi = values.iter().any(|value| {
                        value
                            .get("transport")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value.starts_with("wifi:"))
                    });
                    match (has_usb, has_wifi) {
                        (true, true) => "mixed",
                        (true, false) => "usb",
                        (false, true) => "wifi",
                        (false, false) => "unknown",
                    }
                })
                .unwrap_or("unknown");
            let device_present = request.device_id.as_deref().map_or_else(
                || devices.as_array().is_some_and(|values| !values.is_empty()),
                |device_id| {
                    devices.as_array().is_some_and(|values| {
                        values.iter().any(|value| {
                            value.get("udid").and_then(Value::as_str) == Some(device_id)
                                || value.get("id").and_then(Value::as_str) == Some(device_id)
                        })
                    })
                },
            );
            Ok(
                json!({ "state": "ready", "transport": transport, "deviceCount": devices.as_array().map_or(0, Vec::len), "devicePresent": device_present, "muxSocket": state.mux_socket, "capabilities": bridge_capabilities(), "version": env!("CARGO_PKG_VERSION") }),
            )
        }
        "list_devices" => list_devices(&state).await,
        "events" => device_event_snapshot(&state).await,
        "metadata" => {
            device_metadata(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
            )
            .await
        }
        "pair" => {
            pair_device(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request.host_id,
            )
            .await
        }
        "agent" => {
            request_agent(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .payload
                    .ok_or_else(|| error("invalid_request", "payload is required", false))?,
                request
                    .agent_secret
                    .ok_or_else(|| error("invalid_request", "agent_secret is required", false))?,
                request.deadline_ms.unwrap_or(20_000),
            )
            .await
        }
        "remote_command" => {
            request_agent(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .payload
                    .ok_or_else(|| error("invalid_request", "payload is required", false))?,
                request
                    .agent_secret
                    .ok_or_else(|| error("invalid_request", "agent_secret is required", false))?,
                request.deadline_ms.unwrap_or(20_000),
            )
            .await
        }
        "file_read" | "file_write" => {
            request_agent(
                &state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .payload
                    .ok_or_else(|| error("invalid_request", "payload is required", false))?,
                request
                    .agent_secret
                    .ok_or_else(|| error("invalid_request", "agent_secret is required", false))?,
                request.deadline_ms.unwrap_or(20_000),
            )
            .await
        }
        "service_port" => {
            open_tunnel(
                state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request
                    .port
                    .ok_or_else(|| error("invalid_request", "port is required", false))?,
            )
            .await
        }
        "open_tunnel" => {
            open_tunnel(
                state,
                request
                    .device_id
                    .as_deref()
                    .ok_or_else(|| error("invalid_request", "device_id is required", false))?,
                request.port.unwrap_or(DEFAULT_SSH_PORT),
            )
            .await
        }
        "close_tunnel" => Ok(close_tunnel(
            &state,
            request
                .payload
                .as_ref()
                .and_then(Value::as_str)
                .ok_or_else(|| error("invalid_request", "tunnel id is required", false))?,
        )
        .await),
        _ => Err(error(
            "unsupported_operation",
            format!("unsupported operation {}", request.operation),
            false,
        )),
    }
}

async fn read_frame(stream: &mut UnixStream) -> Result<Option<Vec<u8>>, String> {
    let mut header = [0; 4];
    match stream.read_exact(&mut header).await {
        Ok(_) => {}
        Err(value) if value.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(value) => return Err(value.to_string()),
    }
    let length = u32::from_be_bytes(header) as usize;
    if !valid_frame_length(length, MAX_FRAME_BYTES) {
        return Err("frame length is outside the allowed range".to_string());
    }
    let mut body = vec![0; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|value| value.to_string())?;
    Ok(Some(body))
}

async fn write_frame(stream: &mut UnixStream, response: &RpcResponse) -> Result<(), String> {
    let body = serde_json::to_vec(response).map_err(|value| value.to_string())?;
    if !valid_frame_length(body.len(), MAX_FRAME_BYTES) {
        return Err("response exceeds frame limits".to_string());
    }
    stream
        .write_u32(body.len() as u32)
        .await
        .map_err(|value| value.to_string())?;
    stream
        .write_all(&body)
        .await
        .map_err(|value| value.to_string())?;
    stream.flush().await.map_err(|value| value.to_string())
}

async fn handle_client(mut stream: UnixStream, state: Arc<BridgeState>) {
    loop {
        let frame = match tokio::select! {
            _ = state.shutdown.cancelled() => return,
            frame = read_frame(&mut stream) => frame,
        } {
            Ok(Some(frame)) => frame,
            Ok(None) | Err(_) => return,
        };
        let request = match serde_json::from_slice::<RpcRequest>(&frame) {
            Ok(request) => request,
            Err(value) => {
                let _ = write_frame(
                    &mut stream,
                    &failure(
                        String::new(),
                        error("invalid_request", value.to_string(), false),
                    ),
                )
                .await;
                continue;
            }
        };
        let request_id = request.request_id.clone();
        let operation = request.operation.clone();
        let request_device_id = request.device_id.clone();
        let follow_events = operation == "events" && request.follow == Some(true);
        let result = if request.version != RPC_VERSION {
            Err(error(
                "protocol_version",
                "unsupported RPC protocol version",
                false,
            ))
        } else if !authorized_secret(&state.secrets, &request.auth) {
            Err(error(
                "unauthorized",
                "device bridge authentication failed",
                false,
            ))
        } else if follow_events {
            tokio::select! {
                _ = state.shutdown.cancelled() => return,
                _ = stream_device_events(&mut stream, state.clone(), request_id) => {}
            }
            return;
        } else {
            let _operation_admission = state.operation_gate.read().await;
            if state.shutdown.is_cancelled() {
                return;
            }
            let deadline = Duration::from_millis(
                request
                    .deadline_ms
                    .unwrap_or(20_000)
                    .clamp(1, MAX_RPC_DEADLINE_MS),
            );
            if operation == "cancel" {
                match timeout(deadline, execute(state.clone(), request)).await {
                    Ok(value) => value,
                    Err(_) => Err(error(
                        "deadline_exceeded",
                        "device bridge request exceeded its deadline",
                        true,
                    )),
                }
            } else {
                let cancellation = state.register_cancellation(&request_id).await;
                let result = tokio::select! {
                    value = execute(state.clone(), request) => value,
                    _ = cancellation.cancelled() => Err(error("cancelled", "device bridge request was cancelled", true)),
                    _ = sleep(deadline) => Err(error("deadline_exceeded", "device bridge request exceeded its deadline", true)),
                };
                state.remove_cancellation(&request_id).await;
                result
            }
        };
        if matches!(
            operation.as_str(),
            "agent" | "remote_command" | "file_read" | "file_write" | "metadata"
        ) && matches!(&result, Err(value) if value.code == "deadline_exceeded")
        {
            if let (Some(sender), Some(device_id)) =
                (&state.mux_recovery, request_device_id.as_ref())
            {
                let _ = sender.send(device_id.clone());
            }
        }
        let output = match result {
            Ok(result) => response(request_id, result),
            Err(value) => failure(request_id, value),
        };
        if write_frame(&mut stream, &output).await.is_err() {
            return;
        }
    }
}

async fn serve_rpc(listener: UnixListener, state: Arc<BridgeState>) -> Result<(), String> {
    let mut clients = tokio::task::JoinSet::new();
    let outcome = loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => break Ok(()),
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    if state.shutdown.is_cancelled() {
                        break Ok(());
                    }
                    let client_state = state.clone();
                    clients.spawn(async move {
                        handle_client(stream, client_state).await;
                    });
                }
                Err(value) => break Err(value.to_string()),
            },
            _ = clients.join_next(), if !clients.is_empty() => {}
        }
    };
    state.shutdown.cancel();
    let operations_drained = timeout(RPC_OPERATION_SHUTDOWN_GRACE, state.operation_gate.write())
        .await
        .is_ok();
    let clients_drained = operations_drained
        && timeout(RPC_CLIENT_SHUTDOWN_GRACE, async {
            while clients.join_next().await.is_some() {}
        })
        .await
        .is_ok();
    if !clients_drained {
        clients.abort_all();
        while clients.join_next().await.is_some() {}
    }
    close_all_tunnels(&state).await;
    outcome
}

async fn wait_for_path(path: &Path) -> Result<(), String> {
    for _ in 0..100 {
        if path.exists() {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }
    Err(format!("netmuxd did not create {}", path.display()))
}

async fn stop_netmuxd(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn stop_netmuxd_and_clear_socket(child: &mut Child, socket: &Path) {
    stop_netmuxd(child).await;
    let _ = remove_socket_if_present(socket);
}

fn netmuxd_restart_delay(consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(7);
    Duration::from_millis((250_u64 << exponent).min(30_000))
}

fn remove_socket_if_present(socket: &Path) -> Result<(), String> {
    match std::fs::remove_file(socket) {
        Ok(()) => Ok(()),
        Err(value) if value.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(value) => Err(format!("could not remove stale netmuxd socket: {value}")),
    }
}

async fn supervise_netmuxd(
    binary: String,
    socket: PathBuf,
    pairing_store: PathBuf,
    shutdown: CancellationToken,
    recovery_state: Option<Arc<BridgeState>>,
    mut recovery_requests: mpsc::UnboundedReceiver<String>,
) {
    let mut consecutive_failures = 0_u32;
    let mut last_recovery = Instant::now() - Duration::from_secs(60);
    loop {
        if shutdown.is_cancelled() {
            break;
        }
        let mut failure = remove_socket_if_present(&socket).err();
        if failure.is_none() {
            match start_netmuxd(&binary, &socket, &pairing_store) {
                Ok(mut child) => {
                    let started_at = Instant::now();
                    let startup = tokio::select! {
                        _ = shutdown.cancelled() => {
                            stop_netmuxd_and_clear_socket(&mut child, &socket).await;
                            return;
                        }
                        status = child.wait() => Err(format!("netmuxd exited before creating its socket: {}", status.map(|value| value.to_string()).unwrap_or_else(|value| value.to_string()))),
                        result = wait_for_path(&socket) => result,
                    };
                    match startup {
                        Ok(()) => {
                            let status = loop {
                                tokio::select! {
                                    _ = shutdown.cancelled() => {
                                        stop_netmuxd_and_clear_socket(&mut child, &socket).await;
                                        return;
                                    }
                                    status = child.wait() => break status.map(|value| value.to_string()).map_err(|value| value.to_string()),
                                    Some(device_id) = recovery_requests.recv(), if recovery_state.is_some() => {
                                        let state = recovery_state.as_ref().expect("recovery state exists");
                                        if last_recovery.elapsed() < Duration::from_secs(60) || !state.tunnels.lock().await.is_empty() {
                                            continue;
                                        }
                                        let probe = timeout(Duration::from_secs(3), state.service_connector.connect(device_id, 62078)).await;
                                        if matches!(probe, Ok(Ok(_))) {
                                            continue;
                                        }
                                        if !state.tunnels.lock().await.is_empty() {
                                            continue;
                                        }
                                        last_recovery = Instant::now();
                                        eprintln!("netmuxd service connection stalled; restarting mux process");
                                        stop_netmuxd_and_clear_socket(&mut child, &socket).await;
                                        break Err("netmuxd service connection stalled".to_string());
                                    }
                                }
                            };
                            failure = Some(match status {
                                Ok(status) => format!("netmuxd exited with {status}"),
                                Err(value) => format!("could not wait for netmuxd: {value}"),
                            });
                            if started_at.elapsed() >= Duration::from_secs(30) {
                                consecutive_failures = 0;
                            }
                        }
                        Err(value) => {
                            stop_netmuxd_and_clear_socket(&mut child, &socket).await;
                            failure = Some(value);
                        }
                    }
                }
                Err(value) => failure = Some(value),
            }
        }
        let _ = remove_socket_if_present(&socket);
        consecutive_failures = consecutive_failures.saturating_add(1).min(30);
        let delay = netmuxd_restart_delay(consecutive_failures);
        eprintln!(
            "netmuxd unavailable; restarting in {}ms: {}",
            delay.as_millis(),
            failure.unwrap_or_else(|| "unknown netmuxd failure".to_string())
        );
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = sleep(delay) => {}
        }
    }
    let _ = remove_socket_if_present(&socket);
}

fn start_netmuxd(binary: &str, socket: &Path, pairing_store: &Path) -> Result<Child, String> {
    let mut command = Command::new(binary);
    unsafe {
        command.as_std_mut().pre_exec(|| {
            libc::umask(0o077);
            Ok(())
        });
    }
    command
        .arg("--socket-path")
        .arg(socket)
        .arg("--plist-storage")
        .arg(pairing_store)
        .env(
            "RUST_LOG",
            env::var("NETMUXD_LOG_LEVEL").unwrap_or_else(|_| "warn".to_string()),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|value| format!("could not start netmuxd: {value}"))
}

fn read_pairing_host_id(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|value| format!("could not inspect pairing host identity: {value}"))?;
    if !metadata.file_type().is_file() {
        return Err("pairing host identity is not a regular file".to_string());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|value| {
        format!("could not restrict pairing host identity permissions: {value}")
    })?;
    let value = fs::read_to_string(path)
        .map_err(|value| format!("could not read pairing host identity: {value}"))?;
    let host_id = value.trim();
    Uuid::parse_str(host_id)
        .map_err(|value| format!("pairing host identity is invalid: {value}"))?;
    Ok(host_id.to_string())
}

fn persistent_pairing_host_id(pairing_store: &Path) -> Result<String, String> {
    let host_id_path = pairing_store.join(".dkrypt-host-id");
    if host_id_path.exists() {
        return read_pairing_host_id(&host_id_path);
    }

    let host_id = Uuid::new_v4().to_string();
    let temporary_path = pairing_store.join(format!(".dkrypt-host-id-{}.tmp", Uuid::new_v4()));
    let mut temporary_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary_path)
        .map_err(|value| format!("could not create pairing host identity: {value}"))?;
    temporary_file
        .write_all(host_id.as_bytes())
        .and_then(|_| temporary_file.sync_all())
        .map_err(|value| format!("could not persist pairing host identity: {value}"))?;
    drop(temporary_file);

    let linked = fs::hard_link(&temporary_path, &host_id_path);
    let _ = fs::remove_file(&temporary_path);
    match linked {
        Ok(()) => fs::File::open(pairing_store)
            .and_then(|directory| directory.sync_all())
            .map_err(|value| format!("could not sync pairing host identity directory: {value}"))?,
        Err(value) if value.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(value) => return Err(format!("could not publish pairing host identity: {value}")),
    }
    read_pairing_host_id(&host_id_path)
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let rpc_socket = unix_path("DEVICE_BRIDGE_SOCKET", "/run/dkrypt/device-bridge.sock");
    let mux_socket = unix_path("DEVICE_MUX_SOCKET", "/run/dkrypt/usbmuxd.sock");
    let pairing_store = unix_path("DEVICE_PAIRING_STORE", "/data/state/device-pairing");
    let secret = required_env("DEVICE_BRIDGE_SECRET").map_err(|value| value.message)?;
    if secret.len() < 32 {
        return Err("DEVICE_BRIDGE_SECRET must contain at least 32 characters".to_string());
    }
    let mut secrets = vec![secret];
    if let Ok(previous) = env::var("DEVICE_BRIDGE_SECRET_PREVIOUS")
        && previous.len() >= 32
    {
        secrets.push(previous);
    }
    if let Some(parent) = rpc_socket.parent() {
        std::fs::create_dir_all(parent).map_err(|value| value.to_string())?;
    }
    if let Some(parent) = mux_socket.parent() {
        std::fs::create_dir_all(parent).map_err(|value| value.to_string())?;
    }
    std::fs::create_dir_all(&pairing_store).map_err(|value| value.to_string())?;
    std::fs::set_permissions(
        &pairing_store,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .map_err(|value| value.to_string())?;
    if rpc_socket.exists() {
        std::fs::remove_file(&rpc_socket).map_err(|value| value.to_string())?;
    }
    let host_id = env::var("DEVICE_BRIDGE_HOST_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(Ok)
        .unwrap_or_else(|| persistent_pairing_host_id(&pairing_store))?;
    let shutdown = CancellationToken::new();
    let (mux_recovery, recovery_requests) = mpsc::unbounded_channel();
    let state = Arc::new(BridgeState {
        secrets,
        service_connector: Arc::new(UsbmuxdDeviceServiceConnector {
            mux_socket: mux_socket.clone(),
        }),
        mux_socket,
        host_id,
        shutdown: shutdown.clone(),
        operation_gate: RwLock::new(()),
        tunnels: Mutex::new(HashMap::new()),
        cancellations: Mutex::new(HashMap::new()),
        event_sequence: AtomicU64::new(0),
        mux_recovery: Some(mux_recovery),
    });
    let listener = UnixListener::bind(&rpc_socket).map_err(|value| value.to_string())?;
    let permissions = std::os::unix::fs::PermissionsExt::from_mode(0o660);
    std::fs::set_permissions(&rpc_socket, permissions).map_err(|value| value.to_string())?;
    let mut terminate = signal(SignalKind::terminate()).map_err(|value| value.to_string())?;
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|value| value.to_string())?;
    let binary = env::var("NETMUXD_BIN").unwrap_or_else(|_| "netmuxd".to_string());
    let supervisor_shutdown = shutdown.clone();
    let supervisor = tokio::spawn(supervise_netmuxd(
        binary,
        state.mux_socket.clone(),
        pairing_store,
        supervisor_shutdown,
        Some(state.clone()),
        recovery_requests,
    ));
    let server = serve_rpc(listener, state.clone());
    tokio::pin!(server);
    let outcome = tokio::select! {
        result = &mut server => result,
        _ = terminate.recv() => {
            shutdown.cancel();
            server.await
        }
        _ = interrupt.recv() => {
            shutdown.cancel();
            server.await
        }
    };
    shutdown.cancel();
    let supervisor_result = supervisor.await;
    let _ = std::fs::remove_file(&rpc_socket);
    let _ = remove_socket_if_present(&state.mux_socket);
    if let Err(value) = supervisor_result {
        return Err(format!("netmuxd supervisor failed: {value}"));
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::{
        BridgeState, CancellationToken, DeviceServiceConnectFuture, DeviceServiceConnector,
        DeviceServiceStream, MAX_FRAME_BYTES, MAX_RPC_DEADLINE_MS, RPC_OPERATION_SHUTDOWN_GRACE,
        RPC_VERSION, UsbmuxdDeviceServiceConnector, authorized_secret, bridge_capabilities, error,
        failure, handle_client, netmuxd_restart_delay, open_tunnel_with_timeout, read_agent_frame,
        read_frame, request_agent_exchange, response, serve_rpc, supervise_netmuxd,
        valid_frame_length, write_agent_frame,
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use hmac::{Hmac, Mac};
    use idevice::usbmuxd::{
        RawPacket,
        server::{UsbmuxdServerRequest, UsbmuxdServerResponse},
    };
    use plist::{Dictionary, Value as PlistValue};
    use serde_json::{Value, json};
    use sha2::Sha256;
    use std::{
        collections::HashMap,
        fs, io,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        pin::Pin,
        sync::{Arc, atomic::AtomicU64},
        task::{Context, Poll},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tokio::{
        io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf},
        net::{TcpStream, UnixListener, UnixStream},
        process::Command,
        sync::{Mutex, RwLock, mpsc, oneshot},
        time::timeout,
    };

    struct DropSignalStream {
        stream: DuplexStream,
        drop_signal: Option<oneshot::Sender<()>>,
    }

    struct StalledDeviceServiceConnector;

    impl DeviceServiceConnector for StalledDeviceServiceConnector {
        fn connect(&self, _device_id: String, _port: u16) -> DeviceServiceConnectFuture {
            Box::pin(std::future::pending())
        }
    }

    impl Drop for DropSignalStream {
        fn drop(&mut self) {
            if let Some(signal) = self.drop_signal.take() {
                let _ = signal.send(());
            }
        }
    }

    impl AsyncRead for DropSignalStream {
        fn poll_read(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().stream).poll_read(context, buffer)
        }
    }

    impl AsyncWrite for DropSignalStream {
        fn poll_write(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
            buffer: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.get_mut().stream).poll_write(context, buffer)
        }

        fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().stream).poll_flush(context)
        }

        fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().stream).poll_shutdown(context)
        }
    }

    #[derive(Clone)]
    struct FixtureDeviceServiceConnector {
        stream: Arc<Mutex<Option<DuplexStream>>>,
        connect_calls: Arc<Mutex<Vec<(String, u16)>>>,
        drop_signal: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    }

    impl FixtureDeviceServiceConnector {
        fn new(stream: DuplexStream) -> Self {
            Self::with_drop_signal(stream, None)
        }

        fn with_drop_signal(
            stream: DuplexStream,
            drop_signal: Option<oneshot::Sender<()>>,
        ) -> Self {
            Self {
                stream: Arc::new(Mutex::new(Some(stream))),
                connect_calls: Arc::new(Mutex::new(Vec::new())),
                drop_signal: Arc::new(Mutex::new(drop_signal)),
            }
        }
    }

    impl DeviceServiceConnector for FixtureDeviceServiceConnector {
        fn connect(&self, device_id: String, port: u16) -> DeviceServiceConnectFuture {
            let stream = Arc::clone(&self.stream);
            let connect_calls = Arc::clone(&self.connect_calls);
            let drop_signal = Arc::clone(&self.drop_signal);
            Box::pin(async move {
                connect_calls.lock().await.push((device_id, port));
                let stream = stream.lock().await.take().ok_or_else(|| {
                    error(
                        "device_service_unavailable",
                        "fixture stream already used",
                        true,
                    )
                })?;
                let drop_signal = drop_signal.lock().await.take();
                Ok(Box::new(DropSignalStream {
                    stream,
                    drop_signal,
                }) as Box<dyn DeviceServiceStream>)
            })
        }
    }

    async fn read_usbmux_request(stream: &mut UnixStream) -> (RawPacket, UsbmuxdServerRequest) {
        let mut header = [0u8; 16];
        stream
            .read_exact(&mut header)
            .await
            .expect("usbmux request header should be readable");
        let packet_size = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        let mut bytes = header.to_vec();
        bytes.resize(packet_size, 0);
        stream
            .read_exact(&mut bytes[16..])
            .await
            .expect("usbmux request body should be readable");
        let packet = RawPacket::try_from(bytes.as_slice())
            .expect("usbmux request should decode as a packet");
        let request = UsbmuxdServerRequest::decode(&packet)
            .expect("usbmux request should decode as a request");
        (packet, request)
    }

    async fn write_usbmux_response(
        stream: &mut UnixStream,
        response: UsbmuxdServerResponse,
        tag: u32,
    ) {
        let packet: Vec<u8> = response.into_packet(tag).into();
        stream
            .write_all(&packet)
            .await
            .expect("usbmux response should be writable");
    }

    fn usbmux_device_record(device_id: u32, udid: &str) -> PlistValue {
        let mut properties = Dictionary::new();
        properties.insert(
            "ConnectionType".into(),
            PlistValue::String("USB".to_string()),
        );
        properties.insert("SerialNumber".into(), PlistValue::String(udid.to_string()));
        let mut device = Dictionary::new();
        device.insert("DeviceID".into(), device_id.into());
        device.insert("Properties".into(), PlistValue::Dictionary(properties));
        PlistValue::Dictionary(device)
    }

    async fn read_bridge_event(stream: &mut UnixStream) -> Value {
        let frame = read_frame(stream)
            .await
            .expect("bridge event frame should be readable")
            .expect("bridge event stream should remain open");
        let response: Value = serde_json::from_slice(&frame).expect("bridge event should be JSON");
        assert_eq!(response["requestId"], "event-stream-request");
        assert_eq!(response["ok"], true);
        response["result"].clone()
    }

    async fn write_bridge_request(stream: &mut UnixStream, request: Value) {
        let body = serde_json::to_vec(&request).expect("bridge request should serialize");
        stream
            .write_u32(body.len() as u32)
            .await
            .expect("bridge request header should be writable");
        stream
            .write_all(&body)
            .await
            .expect("bridge request body should be writable");
    }

    async fn read_bridge_response(stream: &mut UnixStream) -> Value {
        serde_json::from_slice(
            &read_frame(stream)
                .await
                .expect("bridge response frame should be readable")
                .expect("bridge response should not be empty"),
        )
        .expect("bridge response should be valid JSON")
    }

    fn hmac_signature(secret: &str, message: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
            .expect("HMAC accepts any secret length");
        mac.update(message.as_bytes());
        let digest = mac.finalize().into_bytes();
        let mut signature = String::with_capacity(digest.len() * 2);
        for byte in digest {
            signature.push(char::from(b"0123456789abcdef"[(byte >> 4) as usize]));
            signature.push(char::from(b"0123456789abcdef"[(byte & 0x0f) as usize]));
        }
        signature
    }

    fn current_agent_response(fixture: &Value, secret: &str, request_id: &str) -> Value {
        let issued_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_secs();
        let payload = fixture["responsePayload"]
            .as_str()
            .expect("fixture response payload should be a string");
        let message =
            format!("dkrypt-autoinstall-agent-response-v1|{request_id}|{issued_at}|{payload}");
        let signature = hmac_signature(secret, &message);
        json!({
            "version": 1,
            "requestId": request_id,
            "issuedAt": issued_at,
            "payload": payload,
            "signature": signature
        })
    }

    #[test]
    fn frame_limits_reject_empty_and_oversized_payloads() {
        assert!(!valid_frame_length(0, MAX_FRAME_BYTES));
        assert!(valid_frame_length(1, MAX_FRAME_BYTES));
        assert!(valid_frame_length(MAX_FRAME_BYTES, MAX_FRAME_BYTES));
        assert!(!valid_frame_length(MAX_FRAME_BYTES + 1, MAX_FRAME_BYTES));
    }

    #[test]
    fn responses_preserve_request_ids_and_protocol_version() {
        let success = response("request-1".to_string(), json!({ "ok": true }));
        assert_eq!(success.version, RPC_VERSION);
        assert_eq!(success.request_id, "request-1");
        assert!(success.ok);
        assert_eq!(
            serde_json::to_value(&success).unwrap()["requestId"],
            "request-1"
        );
        let failed = failure("request-2".to_string(), error("test", "failed", false));
        assert_eq!(failed.version, RPC_VERSION);
        assert_eq!(failed.request_id, "request-2");
        assert!(!failed.ok);
    }

    #[test]
    fn secret_rotation_accepts_current_and_previous_only() {
        let secrets = vec!["current-secret".to_string(), "previous-secret".to_string()];
        assert!(authorized_secret(&secrets, "current-secret"));
        assert!(authorized_secret(&secrets, "previous-secret"));
        assert!(!authorized_secret(&secrets, "unknown-secret"));
    }

    #[test]
    fn cancellation_is_advertised_as_a_bridge_capability() {
        assert!(bridge_capabilities().contains(&"cancel"));
    }

    #[test]
    fn netmuxd_restart_delay_grows_exponentially_and_caps_at_thirty_seconds() {
        assert_eq!(netmuxd_restart_delay(1), Duration::from_millis(250));
        assert_eq!(netmuxd_restart_delay(2), Duration::from_millis(500));
        assert_eq!(netmuxd_restart_delay(8), Duration::from_secs(30));
        assert_eq!(netmuxd_restart_delay(30), Duration::from_secs(30));
    }

    #[tokio::test]
    async fn netmuxd_supervisor_restarts_an_exited_child_and_stops_cleanly() {
        let directory = PathBuf::from(format!("/tmp/dkrypt-netmuxd-{}", uuid::Uuid::new_v4()));
        let socket_path = directory.join("netmuxd.sock");
        let pairing_store = directory.join("pairing");
        let restart_counter = pairing_store.join("restarts");
        let executable = directory.join("netmuxd-fixture");
        fs::create_dir_all(&pairing_store).expect("pairing directory should be created");
        fs::write(
            &executable,
            "#!/bin/sh\nset -eu\nsocket=\nstore=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--socket-path\" ]; then socket=$2; shift 2; elif [ \"$1\" = \"--plist-storage\" ]; then store=$2; shift 2; else shift; fi\ndone\nprintf x >> \"$store/restarts\"\n: > \"$socket\"\nsleep 0.4\n",
        )
        .expect("fixture executable should be written");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("fixture executable should be made executable");

        let shutdown = CancellationToken::new();
        let supervisor = tokio::spawn(supervise_netmuxd(
            executable.to_string_lossy().into_owned(),
            socket_path.clone(),
            pairing_store,
            shutdown.clone(),
            None,
            mpsc::unbounded_channel().1,
        ));

        timeout(Duration::from_secs(2), async {
            loop {
                if socket_path.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("supervisor did not expose its socket");
        timeout(Duration::from_secs(3), async {
            loop {
                if fs::read_to_string(&restart_counter).is_ok_and(|value| value.len() >= 2) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("supervisor did not restart netmuxd after it exited");

        shutdown.cancel();
        timeout(Duration::from_secs(2), supervisor)
            .await
            .expect("supervisor did not stop")
            .expect("supervisor task panicked");
        assert!(!socket_path.exists());
        fs::remove_dir_all(directory).expect("fixture directory should be removed");
    }

    #[tokio::test]
    async fn stalled_agent_rpc_requests_mux_recovery_before_client_timeout() {
        let directory = PathBuf::from(format!("/tmp/dkrypt-rpc-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("test directory should be created");
        let socket_path = directory.join("bridge.sock");
        let listener = UnixListener::bind(&socket_path).expect("RPC socket should bind");
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let state = Arc::new(BridgeState {
            secrets: vec!["bridge-test-secret".to_string()],
            mux_socket: directory.join("mux.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(StalledDeviceServiceConnector),
            shutdown: CancellationToken::new(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: Some(sender),
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("RPC socket should accept");
            handle_client(stream, state).await;
        });
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("RPC socket should connect");
        let request = json!({
            "version": RPC_VERSION,
            "requestId": "stalled-agent",
            "auth": "bridge-test-secret",
            "operation": "agent",
            "deviceId": "fixture-device",
            "agentSecret": "fixture-agent-secret",
            "payload": {},
            "deadlineMs": 50,
        });
        let payload = serde_json::to_vec(&request).expect("request should encode");
        client
            .write_u32(payload.len() as u32)
            .await
            .expect("length should write");
        client
            .write_all(&payload)
            .await
            .expect("request should write");
        let frame = timeout(Duration::from_secs(1), read_frame(&mut client))
            .await
            .expect("RPC should respond before client timeout")
            .expect("RPC frame should be valid")
            .expect("RPC frame should exist");
        let reply: Value = serde_json::from_slice(&frame).expect("RPC response should decode");
        assert_eq!(reply["error"]["code"], "deadline_exceeded");
        assert_eq!(
            receiver
                .try_recv()
                .expect("mux recovery should be requested"),
            "fixture-device"
        );
        drop(client);
        server.await.expect("RPC server should stop");
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[tokio::test]
    async fn stalled_service_probe_restarts_live_netmuxd_child() {
        let directory = PathBuf::from(format!(
            "/tmp/dkrypt-netmuxd-stall-{}",
            uuid::Uuid::new_v4()
        ));
        let socket_path = directory.join("netmuxd.sock");
        let pairing_store = directory.join("pairing");
        let restart_counter = pairing_store.join("restarts");
        let executable = directory.join("netmuxd-fixture");
        fs::create_dir_all(&pairing_store).expect("pairing directory should be created");
        fs::write(&executable, "#!/bin/sh\nset -eu\nsocket=\nstore=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = \"--socket-path\" ]; then socket=$2; shift 2; elif [ \"$1\" = \"--plist-storage\" ]; then store=$2; shift 2; else shift; fi\ndone\nprintf x >> \"$store/restarts\"\n: > \"$socket\"\nexec sleep 30\n").expect("fixture executable should be written");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("fixture executable should be executable");
        let (stream, _peer) = tokio::io::duplex(16);
        let connector = FixtureDeviceServiceConnector::new(stream);
        connector.stream.lock().await.take();
        let shutdown = CancellationToken::new();
        let (sender, receiver) = mpsc::unbounded_channel();
        let state = Arc::new(BridgeState {
            secrets: vec!["bridge-test-secret".to_string()],
            mux_socket: socket_path.clone(),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(connector),
            shutdown: shutdown.clone(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: Some(sender.clone()),
        });
        let supervisor = tokio::spawn(supervise_netmuxd(
            executable.to_string_lossy().into_owned(),
            socket_path.clone(),
            pairing_store,
            shutdown.clone(),
            Some(state),
            receiver,
        ));
        timeout(Duration::from_secs(2), async {
            while fs::read_to_string(&restart_counter).map_or(true, |value| value.len() < 1) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("netmuxd fixture should start");
        sender
            .send("fixture-device".to_string())
            .expect("recovery request should send");
        timeout(Duration::from_secs(3), async {
            while fs::read_to_string(&restart_counter).map_or(true, |value| value.len() < 2) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("stalled netmuxd fixture should restart");
        shutdown.cancel();
        timeout(Duration::from_secs(2), supervisor)
            .await
            .expect("supervisor should stop")
            .expect("supervisor should not panic");
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[tokio::test]
    async fn cancellation_wakes_waiting_requests() {
        let token = CancellationToken::new();
        let waiters = (0..8)
            .map(|_| {
                let token = token.clone();
                tokio::spawn(async move {
                    token.cancelled().await;
                    true
                })
            })
            .collect::<Vec<_>>();
        tokio::task::yield_now().await;
        token.cancel();
        for waiter in waiters {
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
                    .await
                    .expect("cancellation waiter timed out")
                    .expect("cancellation waiter panicked")
            );
        }
    }

    #[tokio::test]
    async fn device_agent_fixture_bootstraps_then_accepts_the_signed_request() {
        let (mut bridge, mut agent) = tokio::io::duplex(16 * 1024);
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/device-agent-v1.fixture.json"))
                .expect("device-agent fixture should be valid JSON");
        let request = fixture["envelope"].clone();
        let agent_secret = fixture["secret"]
            .as_str()
            .expect("device-agent fixture should contain a secret")
            .to_string();
        let response_payload = json!({ "ok": true, "result": { "agentVersion": "1.4.0" } });
        let expected_request = request.clone();
        let expected_response = response_payload.clone();
        let expected_secret = agent_secret.clone();
        let fixture = tokio::spawn(async move {
            let bootstrap = read_agent_frame(&mut agent)
                .await
                .expect("bootstrap frame should be readable");
            assert_eq!(
                bootstrap.get("action").and_then(Value::as_str),
                Some("bootstrap")
            );
            assert_eq!(
                bootstrap.get("secret").and_then(Value::as_str),
                Some(expected_secret.as_str())
            );
            write_agent_frame(&mut agent, &json!({ "ok": true }))
                .await
                .expect("bootstrap response should be writable");
            let forwarded = read_agent_frame(&mut agent)
                .await
                .expect("authenticated request frame should be readable");
            assert_eq!(forwarded, expected_request);
            write_agent_frame(&mut agent, &expected_response)
                .await
                .expect("agent response should be writable");
        });

        let response = request_agent_exchange(&mut bridge, &agent_secret, &request, 1_000)
            .await
            .expect("device-agent exchange should succeed");
        fixture.await.expect("device-agent fixture should complete");
        assert_eq!(response, response_payload);
    }

    #[tokio::test]
    async fn device_agent_fixture_rejects_a_failed_bootstrap() {
        let (mut bridge, mut agent) = tokio::io::duplex(16 * 1024);
        let fixture = tokio::spawn(async move {
            let _bootstrap = read_agent_frame(&mut agent)
                .await
                .expect("bootstrap frame should be readable");
            write_agent_frame(
                &mut agent,
                &json!({ "ok": false, "error": "invalid_secret" }),
            )
            .await
            .expect("bootstrap rejection should be writable");
        });

        let error = request_agent_exchange(&mut bridge, "wrong-secret", &json!({}), 1_000)
            .await
            .expect_err("a rejected bootstrap must fail the exchange");
        fixture.await.expect("device-agent fixture should complete");
        assert_eq!(error.code, "agent_bootstrap");
    }

    #[tokio::test]
    async fn device_agent_fixture_times_out_when_the_bridge_stops_responding() {
        let (mut bridge, _agent) = tokio::io::duplex(16 * 1024);
        let error = request_agent_exchange(&mut bridge, "fixture-secret", &json!({}), 50)
            .await
            .expect_err("an unresponsive agent must time out");
        assert_eq!(error.code, "agent_timeout");
    }

    #[tokio::test]
    async fn authenticated_agent_rpc_returns_the_device_agent_response() {
        let socket_path = PathBuf::from(format!("/tmp/dkrypt-agent-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/device-agent-v1.fixture.json"))
                .expect("device-agent fixture should be valid JSON");
        let (bridge_agent, mut device_agent) = tokio::io::duplex(16 * 1024);
        let connector = FixtureDeviceServiceConnector::new(bridge_agent);
        let expected_request = fixture["envelope"].clone();
        let expected_secret = fixture["secret"]
            .as_str()
            .expect("device-agent fixture should contain a secret")
            .to_string();
        let request_id = fixture["requestId"]
            .as_str()
            .expect("fixture request ID should be a string");
        let expected_response = current_agent_response(&fixture, &expected_secret, request_id);
        let response_to_device = expected_response.clone();
        let device_agent_task = tokio::spawn(async move {
            let bootstrap = read_agent_frame(&mut device_agent)
                .await
                .expect("bootstrap frame should be readable");
            assert_eq!(bootstrap["action"], "bootstrap");
            assert_eq!(bootstrap["secret"], expected_secret);
            write_agent_frame(&mut device_agent, &json!({ "ok": true }))
                .await
                .expect("bootstrap response should be writable");
            let request = read_agent_frame(&mut device_agent)
                .await
                .expect("signed request should be readable");
            assert_eq!(request, expected_request);
            write_agent_frame(&mut device_agent, &response_to_device)
                .await
                .expect("signed response should be writable");
        });
        let state = Arc::new(BridgeState {
            secrets: vec!["bridge-test-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(connector.clone()),
            shutdown: CancellationToken::new(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("test socket accept failed");
            handle_client(stream, state).await;
        });
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test socket connect failed");
        let request_id = "agent-rpc-fixture-request";
        let request = json!({
            "version": RPC_VERSION,
            "requestId": request_id,
            "auth": "bridge-test-secret",
            "operation": "agent",
            "deviceId": "fixture-device",
            "payload": fixture["envelope"],
            "agentSecret": fixture["secret"],
            "deadlineMs": 1_000
        });
        let body = serde_json::to_vec(&request).expect("test request serialization failed");
        client
            .write_u32(body.len() as u32)
            .await
            .expect("test request header failed");
        client
            .write_all(&body)
            .await
            .expect("test request body failed");
        let output = read_frame(&mut client)
            .await
            .expect("test response frame failed")
            .expect("test response was empty");
        let output: Value =
            serde_json::from_slice(&output).expect("test response should be valid JSON");

        assert_eq!(output["requestId"], request_id);
        assert_eq!(output["ok"], true);
        assert_eq!(output["result"], expected_response);
        assert_eq!(
            connector.connect_calls.lock().await.as_slice(),
            &[("fixture-device".to_string(), 5913)]
        );
        device_agent_task
            .await
            .expect("mock device agent should complete");
        server.abort();
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn bun_device_agent_client_roundtrips_through_authenticated_rust_rpc() {
        let socket_path =
            PathBuf::from(format!("/tmp/dkrypt-bun-rpc-{}.sock", uuid::Uuid::new_v4()));
        let runtime_dir =
            std::env::temp_dir().join(format!("dkrypt-bun-rpc-runtime-{}", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/device-agent-v1.fixture.json"))
                .expect("device-agent fixture should be valid JSON");
        let bridge_secret = fixture["secret"]
            .as_str()
            .expect("device-agent fixture should contain a secret")
            .to_string();
        let (bridge_agent, mut device_agent) = tokio::io::duplex(16 * 1024);
        let connector = FixtureDeviceServiceConnector::new(bridge_agent);
        let state = Arc::new(BridgeState {
            secrets: vec![bridge_secret.clone()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(connector.clone()),
            shutdown: CancellationToken::new(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.expect("test socket accept failed");
                let client_state = state.clone();
                tokio::spawn(async move {
                    handle_client(stream, client_state).await;
                });
            }
        });
        let fixture_for_agent = fixture.clone();
        let device_agent_task = tokio::spawn(async move {
            let bootstrap = read_agent_frame(&mut device_agent)
                .await
                .expect("bootstrap frame should be readable");
            assert_eq!(bootstrap["action"], "bootstrap");
            let agent_secret = bootstrap["secret"]
                .as_str()
                .expect("bootstrap should contain the device-agent secret");
            assert_eq!(agent_secret.len(), 43);
            write_agent_frame(&mut device_agent, &json!({ "ok": true }))
                .await
                .expect("bootstrap response should be writable");
            let request = read_agent_frame(&mut device_agent)
                .await
                .expect("signed request should be readable");
            assert_eq!(request["version"], 1);
            let request_id = request["requestId"]
                .as_str()
                .expect("signed request should contain a request ID");
            let request_issued_at = request["issuedAt"]
                .as_u64()
                .expect("signed request should contain an issue time");
            let request_payload = request["payload"]
                .as_str()
                .expect("signed request should contain a payload");
            let request_signature = request["signature"]
                .as_str()
                .expect("signed request should contain a signature");
            let signing_message = format!(
                "dkrypt-autoinstall-agent-v1|{request_id}|{request_issued_at}|{request_payload}"
            );
            assert_eq!(
                request_signature,
                hmac_signature(agent_secret, &signing_message)
            );
            let request_payload = URL_SAFE_NO_PAD
                .decode(request_payload)
                .expect("signed request payload should be base64url");
            let request_payload: Value = serde_json::from_slice(&request_payload)
                .expect("signed request payload should be valid JSON");
            assert_eq!(request_payload["action"], "status");
            let response = current_agent_response(&fixture_for_agent, agent_secret, request_id);
            write_agent_frame(&mut device_agent, &response)
                .await
                .expect("signed response should be writable");
        });
        let client_script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../dkrypt/scripts/device-agent-client.integration.mjs");
        let output = timeout(
            Duration::from_secs(20),
            Command::new("bun")
                .args(["run"])
                .arg(client_script)
                .env("API_KEY", "rpc-integration-test")
                .env("SESSION_SIGNING_SECRET", "rpc-integration-test")
                .env("ADMIN_PASSWORD", "rpc-integration-test")
                .env("DEVICE_BRIDGE_SOCKET", &socket_path)
                .env("DEVICE_BRIDGE_SECRET", &bridge_secret)
                .env("DEVICE_RUNTIME_DIR", &runtime_dir)
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let output = match output {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                server.abort();
                device_agent_task.abort();
                let _ = std::fs::remove_file(&socket_path);
                let _ = std::fs::remove_dir_all(&runtime_dir);
                panic!(
                    "Bun should be installed to run the Rust/Bun device-agent integration test: {error}"
                );
            }
            Err(_) => {
                server.abort();
                device_agent_task.abort();
                let _ = std::fs::remove_file(&socket_path);
                let _ = std::fs::remove_dir_all(&runtime_dir);
                panic!("Bun device-agent integration timed out");
            }
        };
        if !output.status.success() {
            server.abort();
            device_agent_task.abort();
            let _ = std::fs::remove_file(&socket_path);
            let _ = std::fs::remove_dir_all(&runtime_dir);
            panic!(
                "Bun device-agent client failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let agent_result = device_agent_task.await;
        let server_result = server.await;
        let _ = std::fs::remove_file(&socket_path);
        let _ = std::fs::remove_dir_all(&runtime_dir);
        assert!(String::from_utf8_lossy(&output.stdout).contains("DKRYPT_RPC_OK"));
        agent_result.expect("mock device agent should complete");
        server_result.expect("RPC server should accept both Bun requests");
    }

    #[tokio::test]
    async fn rpc_socket_preserves_authentication_and_request_ids() {
        let socket_path =
            std::env::temp_dir().join(format!("dkrypt-bridge-test-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(UsbmuxdDeviceServiceConnector {
                mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            }),
            shutdown: CancellationToken::new(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("test socket accept failed");
            handle_client(stream, state).await;
        });
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test socket connect failed");
        let request = json!({
            "version": RPC_VERSION,
            "requestId": "capability-request",
            "auth": "current-secret",
            "operation": "capabilities"
        });
        let body = serde_json::to_vec(&request).expect("test request serialization failed");
        client
            .write_u32(body.len() as u32)
            .await
            .expect("test request header failed");
        client
            .write_all(&body)
            .await
            .expect("test request body failed");
        let response: serde_json::Value = serde_json::from_slice(
            &read_frame(&mut client)
                .await
                .expect("test response frame failed")
                .expect("test response was empty"),
        )
        .expect("test response serialization failed");
        assert_eq!(
            response.get("requestId").and_then(|value| value.as_str()),
            Some("capability-request")
        );
        assert_eq!(
            response.get("ok").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            response
                .get("result")
                .and_then(|value| value.get("transport"))
                .and_then(|value| value.as_str()),
            Some("rust-netmuxd")
        );
        server.abort();
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    fn rpc_shutdown_drain_outlasts_maximum_request_deadline() {
        assert!(
            RPC_OPERATION_SHUTDOWN_GRACE
                >= Duration::from_millis(MAX_RPC_DEADLINE_MS) + Duration::from_secs(5)
        );
    }

    #[tokio::test]
    async fn rpc_server_rejects_operations_queued_when_shutdown_begins() {
        let socket_path = PathBuf::from(format!(
            "/tmp/dkrypt-operation-shutdown-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let shutdown = CancellationToken::new();
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/device-agent-v1.fixture.json"))
                .expect("device-agent fixture should be valid JSON");
        let (bridge_agent, _device_agent) = tokio::io::duplex(16 * 1024);
        let connector = FixtureDeviceServiceConnector::new(bridge_agent);
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(connector.clone()),
            shutdown: shutdown.clone(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let admission_blocker = state.operation_gate.write().await;
        let server = tokio::spawn(serve_rpc(listener, state.clone()));
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test RPC socket should accept clients");
        write_bridge_request(
            &mut client,
            json!({
                "version": RPC_VERSION,
                "requestId": "queued-agent-operation",
                "auth": "current-secret",
                "operation": "agent",
                "deviceId": "fixture-device",
                "payload": fixture["envelope"],
                "agentSecret": fixture["secret"],
                "deadlineMs": 250
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        shutdown.cancel();
        drop(admission_blocker);
        timeout(Duration::from_secs(1), server)
            .await
            .expect("server should reject queued work and finish shutdown")
            .expect("RPC server task should not panic")
            .expect("RPC server should drain cleanly");
        assert!(connector.connect_calls.lock().await.is_empty());
        let closed = timeout(Duration::from_secs(1), read_frame(&mut client))
            .await
            .expect("bridge should close RPC clients during shutdown")
            .expect("client should observe a clean socket close");
        assert!(closed.is_none());
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn rpc_server_rejects_cancellation_queued_when_shutdown_begins() {
        let socket_path = PathBuf::from(format!(
            "/tmp/dkrypt-cancel-shutdown-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let shutdown = CancellationToken::new();
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(UsbmuxdDeviceServiceConnector {
                mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            }),
            shutdown: shutdown.clone(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let active_operation = state.register_cancellation("active-operation").await;
        let admission_blocker = state.operation_gate.write().await;
        let server = tokio::spawn(serve_rpc(listener, state.clone()));
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test RPC socket should accept clients");
        write_bridge_request(
            &mut client,
            json!({
                "version": RPC_VERSION,
                "requestId": "queued-cancel-operation",
                "auth": "current-secret",
                "operation": "cancel",
                "payload": "active-operation"
            }),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        shutdown.cancel();
        drop(admission_blocker);
        timeout(Duration::from_secs(1), server)
            .await
            .expect("server should reject queued cancellation and finish shutdown")
            .expect("RPC server task should not panic")
            .expect("RPC server should drain cleanly");
        assert!(!active_operation.is_cancelled());
        let closed = timeout(Duration::from_secs(1), read_frame(&mut client))
            .await
            .expect("bridge should close RPC clients during shutdown")
            .expect("client should observe a clean socket close");
        assert!(closed.is_none());
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn rpc_server_closes_idle_clients_when_shutdown_begins() {
        let socket_path = PathBuf::from(format!(
            "/tmp/dkrypt-shutdown-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let shutdown = CancellationToken::new();
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(UsbmuxdDeviceServiceConnector {
                mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            }),
            shutdown: shutdown.clone(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let server = tokio::spawn(serve_rpc(listener, state));
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test socket connect failed");
        write_bridge_request(
            &mut client,
            json!({
                "version": RPC_VERSION,
                "requestId": "before-shutdown",
                "auth": "current-secret",
                "operation": "capabilities"
            }),
        )
        .await;
        assert_eq!(read_bridge_response(&mut client).await["ok"], true);
        shutdown.cancel();
        let closed = timeout(Duration::from_secs(1), read_frame(&mut client))
            .await
            .expect("bridge should close idle RPC clients during shutdown")
            .expect("idle RPC client should observe a clean socket close");
        assert!(closed.is_none());
        server
            .await
            .expect("RPC server task should not panic")
            .expect("RPC server should finish draining cleanly after shutdown");
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn rpc_server_closes_active_tunnels_before_shutdown_completes() {
        let socket_path = PathBuf::from(format!(
            "/tmp/dkrypt-tunnel-shutdown-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let shutdown = CancellationToken::new();
        let (bridge_service, mut device_service) = tokio::io::duplex(4096);
        let (stream_dropped, mut stream_dropped_receiver) = oneshot::channel();
        let connector =
            FixtureDeviceServiceConnector::with_drop_signal(bridge_service, Some(stream_dropped));
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(connector),
            shutdown: shutdown.clone(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let server = tokio::spawn(serve_rpc(listener, state));
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test socket connect failed");
        write_bridge_request(
            &mut client,
            json!({
                "version": RPC_VERSION,
                "requestId": "open-before-shutdown",
                "auth": "current-secret",
                "operation": "service_port",
                "deviceId": "fixture-device",
                "port": 12345
            }),
        )
        .await;
        let opened = read_bridge_response(&mut client).await;
        assert_eq!(opened["ok"], true);
        let local_port = opened["result"]["port"]
            .as_u64()
            .expect("tunnel response should include a local port") as u16;
        let mut local = TcpStream::connect(("127.0.0.1", local_port))
            .await
            .expect("local tunnel should accept connections");
        let device_service_task = tokio::spawn(async move {
            let mut request = [0; 4];
            device_service
                .read_exact(&mut request)
                .await
                .expect("device service should receive tunnel traffic");
            assert_eq!(&request, b"ping");
            device_service
                .write_all(b"pong")
                .await
                .expect("device service response should be writable");
            let mut closed = [0; 1];
            assert_eq!(
                device_service
                    .read(&mut closed)
                    .await
                    .expect("closed device service should be readable"),
                0
            );
        });
        local
            .write_all(b"ping")
            .await
            .expect("local tunnel should accept traffic");
        let mut response = [0; 4];
        timeout(Duration::from_secs(1), local.read_exact(&mut response))
            .await
            .expect("device response should arrive before timeout")
            .expect("device response should be complete");
        assert_eq!(&response, b"pong");
        shutdown.cancel();
        server
            .await
            .expect("RPC server task should not panic")
            .expect("RPC server should drain clients and tunnels");
        stream_dropped_receiver
            .try_recv()
            .expect("server shutdown should wait for the device service stream to close");
        let closed = timeout(Duration::from_secs(1), read_frame(&mut client))
            .await
            .expect("bridge should close RPC clients during shutdown")
            .expect("client should observe a clean RPC socket close");
        assert!(closed.is_none());
        let mut trailing = [0; 1];
        assert_eq!(
            timeout(Duration::from_secs(1), local.read(&mut trailing))
                .await
                .expect("server shutdown should close active local streams")
                .expect("closed local stream should be readable"),
            0
        );
        device_service_task
            .await
            .expect("device service task should stop during bridge shutdown");
        drop(local);
        drop(client);
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn authenticated_tunnel_rpc_forwards_service_data_and_waits_for_close() {
        let socket_path =
            PathBuf::from(format!("/tmp/dkrypt-tunnel-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&socket_path).expect("test socket bind failed");
        let (bridge_service, mut device_service) = tokio::io::duplex(4096);
        let (stream_dropped, mut stream_dropped_receiver) = oneshot::channel();
        let connector =
            FixtureDeviceServiceConnector::with_drop_signal(bridge_service, Some(stream_dropped));
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: PathBuf::from("/tmp/missing-netmuxd.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(connector.clone()),
            shutdown: CancellationToken::new(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("test socket accept failed");
            handle_client(stream, state).await;
        });
        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("test socket connect failed");
        write_bridge_request(
            &mut client,
            json!({
                "version": RPC_VERSION,
                "requestId": "open-tunnel",
                "auth": "current-secret",
                "operation": "service_port",
                "deviceId": "fixture-device",
                "port": 12345
            }),
        )
        .await;
        let opened = read_bridge_response(&mut client).await;
        assert_eq!(opened["ok"], true);
        let tunnel_id = opened["result"]["tunnelId"]
            .as_str()
            .expect("open response should include a tunnel ID")
            .to_string();
        let local_port = opened["result"]["port"]
            .as_u64()
            .expect("open response should include a local port") as u16;
        let mut local = TcpStream::connect(("127.0.0.1", local_port))
            .await
            .expect("local tunnel should accept connections");
        let device_service_task = tokio::spawn(async move {
            let mut request = vec![0; b"device request".len()];
            device_service
                .read_exact(&mut request)
                .await
                .expect("device should receive forwarded request bytes");
            assert_eq!(request, b"device request");
            device_service
                .write_all(b"device response")
                .await
                .expect("device response should be writable");
            let mut closed = [0; 1];
            assert_eq!(
                device_service
                    .read(&mut closed)
                    .await
                    .expect("closed device service should be readable"),
                0
            );
        });
        local
            .write_all(b"device request")
            .await
            .expect("local tunnel should accept request bytes");
        let mut forwarded_response = vec![0; b"device response".len()];
        timeout(
            Duration::from_secs(1),
            local.read_exact(&mut forwarded_response),
        )
        .await
        .expect("tunnel should return a device response before timeout")
        .expect("tunnel should return a complete device response");
        assert_eq!(forwarded_response, b"device response");
        assert_eq!(
            connector.connect_calls.lock().await.as_slice(),
            &[("fixture-device".to_string(), 12345)]
        );
        write_bridge_request(
            &mut client,
            json!({
                "version": RPC_VERSION,
                "requestId": "close-tunnel",
                "auth": "current-secret",
                "operation": "close_tunnel",
                "payload": tunnel_id
            }),
        )
        .await;
        let closed = read_bridge_response(&mut client).await;
        assert_eq!(closed["result"]["closed"], true);
        stream_dropped_receiver
            .try_recv()
            .expect("close response must wait until device service streams are dropped");
        device_service_task
            .await
            .expect("closing tunnel should drop device service connections");
        let second_close = json!({
            "version": RPC_VERSION,
            "requestId": "close-tunnel-again",
            "auth": "current-secret",
            "operation": "close_tunnel",
            "payload": tunnel_id
        });
        write_bridge_request(&mut client, second_close).await;
        let closed_again = read_bridge_response(&mut client).await;
        assert_eq!(closed_again["result"]["closed"], false);
        let mut trailing = [0; 1];
        assert_eq!(
            timeout(Duration::from_secs(1), local.read(&mut trailing))
                .await
                .expect("close should shut down forwarded streams before responding")
                .expect("closed tunnel stream should be readable"),
            0
        );
        drop(local);
        drop(client);
        server
            .await
            .expect("RPC server should stop after client close");
        let _ = std::fs::remove_file(socket_path);
    }

    #[tokio::test]
    async fn tunnel_open_does_not_report_ready_before_device_service_is_connected() {
        let directory = PathBuf::from(format!("/tmp/dkrypt-tunnel-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("test directory should be created");
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: directory.join("mux.sock"),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(StalledDeviceServiceConnector),
            shutdown: CancellationToken::new(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: Some(sender),
        });

        let result =
            open_tunnel_with_timeout(state, "fixture-device", 22, Duration::from_millis(25)).await;

        assert_eq!(
            result.expect_err("a stalled device service must fail").code,
            "device_service_timeout"
        );
        assert_eq!(
            receiver
                .try_recv()
                .expect("a stalled service must request mux recovery"),
            "fixture-device"
        );
        fs::remove_dir_all(directory).expect("test directory should be removed");
    }

    #[tokio::test]
    async fn rpc_event_stream_reconnects_and_refreshes_the_device_snapshot_after_listener_loss() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be available")
            .as_nanos();
        let socket_path = std::env::temp_dir().join(format!(
            "dkrypt-bridge-events-{}-{unique}.sock",
            std::process::id()
        ));
        let mux_socket_path = std::env::temp_dir().join(format!(
            "dkrypt-bridge-usbmuxd-{}-{unique}.sock",
            std::process::id()
        ));
        let bridge_listener = UnixListener::bind(&socket_path).expect("bridge socket bind failed");
        let mux_listener = UnixListener::bind(&mux_socket_path).expect("mux socket bind failed");
        let state = Arc::new(BridgeState {
            secrets: vec!["current-secret".to_string()],
            mux_socket: mux_socket_path.clone(),
            host_id: "test-host".to_string(),
            service_connector: Arc::new(UsbmuxdDeviceServiceConnector {
                mux_socket: mux_socket_path.clone(),
            }),
            shutdown: CancellationToken::new(),
            operation_gate: RwLock::new(()),
            tunnels: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
            event_sequence: AtomicU64::new(0),
            mux_recovery: None,
        });
        let bridge_server = tokio::spawn(async move {
            let (stream, _) = bridge_listener
                .accept()
                .await
                .expect("bridge socket should accept a client");
            handle_client(stream, state).await;
        });
        let mux_server = tokio::spawn(async move {
            let (mut initial_listener, _) = mux_listener
                .accept()
                .await
                .expect("initial mux listener should connect");
            let (listen_packet, listen_request) = read_usbmux_request(&mut initial_listener).await;
            assert!(matches!(listen_request, UsbmuxdServerRequest::Listen));
            write_usbmux_response(
                &mut initial_listener,
                UsbmuxdServerResponse::Result(0),
                listen_packet.tag,
            )
            .await;

            let (mut initial_inventory, _) = mux_listener
                .accept()
                .await
                .expect("initial device inventory should connect");
            let (inventory_packet, inventory_request) =
                read_usbmux_request(&mut initial_inventory).await;
            assert!(matches!(
                inventory_request,
                UsbmuxdServerRequest::ListDevices
            ));
            write_usbmux_response(
                &mut initial_inventory,
                UsbmuxdServerResponse::DeviceList(vec![usbmux_device_record(
                    41,
                    "same-device-udid",
                )]),
                inventory_packet.tag,
            )
            .await;
            write_usbmux_response(
                &mut initial_listener,
                UsbmuxdServerResponse::Detached(41),
                0,
            )
            .await;

            let mut attached = usbmux_device_record(43, "same-device-udid")
                .as_dictionary()
                .expect("device fixture should be a dictionary")
                .clone();
            attached.insert(
                "MessageType".into(),
                PlistValue::String("Attached".to_string()),
            );
            write_usbmux_response(
                &mut initial_listener,
                UsbmuxdServerResponse::Attached(attached),
                0,
            )
            .await;
            drop(initial_listener);

            let (mut recovered_listener, _) =
                timeout(Duration::from_secs(4), mux_listener.accept())
                    .await
                    .map_err(|_| "device bridge did not reopen the mux event listener".to_string())?
                    .map_err(|value| value.to_string())?;
            let (recovered_listen_packet, recovered_listen_request) =
                read_usbmux_request(&mut recovered_listener).await;
            assert!(matches!(
                recovered_listen_request,
                UsbmuxdServerRequest::Listen
            ));
            write_usbmux_response(
                &mut recovered_listener,
                UsbmuxdServerResponse::Result(0),
                recovered_listen_packet.tag,
            )
            .await;

            let (mut recovered_inventory, _) = mux_listener
                .accept()
                .await
                .expect("recovered device inventory should connect");
            let (recovered_inventory_packet, recovered_inventory_request) =
                read_usbmux_request(&mut recovered_inventory).await;
            assert!(matches!(
                recovered_inventory_request,
                UsbmuxdServerRequest::ListDevices
            ));
            write_usbmux_response(
                &mut recovered_inventory,
                UsbmuxdServerResponse::DeviceList(vec![usbmux_device_record(
                    43,
                    "same-device-udid",
                )]),
                recovered_inventory_packet.tag,
            )
            .await;
            Ok::<(), String>(())
        });

        let mut client = UnixStream::connect(&socket_path)
            .await
            .expect("bridge client should connect");
        write_bridge_request(
            &mut client,
            json!({
                "version": RPC_VERSION,
                "requestId": "event-stream-request",
                "auth": "current-secret",
                "operation": "events",
                "follow": true
            }),
        )
        .await;

        let initial = timeout(Duration::from_secs(2), read_bridge_event(&mut client))
            .await
            .expect("initial device snapshot should arrive");
        assert_eq!(initial["type"], "device_snapshot");
        assert_eq!(initial["sequence"], 1);
        assert_eq!(initial["devices"][0]["deviceId"], 41);

        let disconnected = timeout(Duration::from_secs(2), read_bridge_event(&mut client))
            .await
            .expect("device detach event should arrive");
        assert_eq!(disconnected["type"], "device_disconnected");
        assert_eq!(disconnected["sequence"], 2);
        assert_eq!(disconnected["devices"].as_array().unwrap().len(), 0);

        let connected = timeout(Duration::from_secs(2), read_bridge_event(&mut client))
            .await
            .expect("device attach event should arrive");
        assert_eq!(connected["type"], "device_connected");
        assert_eq!(connected["sequence"], 3);
        assert_eq!(connected["devices"][0]["deviceId"], 43);

        let reconnecting = timeout(Duration::from_secs(2), read_bridge_event(&mut client))
            .await
            .expect("mux listener recovery state should arrive");
        assert_eq!(reconnecting["type"], "device_event_stream_reconnecting");
        assert_eq!(reconnecting["sequence"], 4);
        assert_eq!(reconnecting["devices"][0]["deviceId"], 43);

        let recovered_frame = timeout(Duration::from_secs(5), read_frame(&mut client))
            .await
            .expect("recovered device snapshot should arrive")
            .expect("recovered device snapshot frame should be readable")
            .expect("event stream should remain open during mux recovery");
        let recovered: Value =
            serde_json::from_slice(&recovered_frame).expect("recovered event should be JSON");
        let mux_result = timeout(Duration::from_secs(5), mux_server)
            .await
            .expect("mock mux server should finish")
            .expect("mock mux server task should not panic");
        drop(client);
        let bridge_result = timeout(Duration::from_secs(2), bridge_server)
            .await
            .expect("bridge RPC server should stop after client disconnects");
        let _ = std::fs::remove_file(socket_path);
        let _ = std::fs::remove_file(mux_socket_path);

        assert!(mux_result.is_ok(), "{}", mux_result.unwrap_err());
        bridge_result.expect("bridge RPC server task should not panic");
        assert_eq!(recovered["requestId"], "event-stream-request");
        assert_eq!(recovered["ok"], true);
        assert_eq!(recovered["result"]["type"], "device_snapshot");
        assert_eq!(recovered["result"]["sequence"], 5);
        assert_eq!(recovered["result"]["devices"].as_array().unwrap().len(), 1);
        assert_eq!(recovered["result"]["devices"][0]["deviceId"], 43);
    }
}
