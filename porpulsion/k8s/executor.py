import base64
import logging
import threading
import time
from datetime import datetime, timezone
from kubernetes import client, config
from porpulsion import state

log = logging.getLogger("porpulsion.executor")

# Load in-cluster kubeconfig (the agent runs as a pod)
try:
    config.load_incluster_config()
except config.ConfigException:
    log.warning("Not running in-cluster, falling back to default kubeconfig")
    config.load_kube_config()

apps_v1 = client.AppsV1Api()
core_v1 = client.CoreV1Api()

NAMESPACE = state.NAMESPACE

# Tracks the active polling thread stop-event per app id so re-deploys
# cancel the old watcher before starting a new one.
_stop_events: dict[str, threading.Event] = {}


# ── Naming helpers ────────────────────────────────────────────────────────────

def _deploy_name(remote_app) -> str:
    return f"ra-{remote_app.id}-{remote_app.name}"[:63]

def _cm_name(app_id: str, logical_name: str) -> str:
    return f"ra-{app_id}-cm-{logical_name}"[:63]

def _sec_name(app_id: str, logical_name: str) -> str:
    return f"ra-{app_id}-sec-{logical_name}"[:63]

def _pvc_name(app_id: str, logical_name: str) -> str:
    return f"ra-{app_id}-pvc-{logical_name}"[:63]

def _owner_labels(remote_app) -> dict:
    return {
        "app": _deploy_name(remote_app),
        "porpulsion.io/remote-app-id": remote_app.id,
        "porpulsion.io/source-peer": remote_app.source_peer,
    }


# ── ConfigMap management ──────────────────────────────────────────────────────

def apply_configmap(app_id: str, logical_name: str, data: dict) -> str:
    """Create or update a ConfigMap. Returns the k8s name."""
    name = _cm_name(app_id, logical_name)
    body = client.V1ConfigMap(
        metadata=client.V1ObjectMeta(name=name, namespace=NAMESPACE),
        data=data or {},
    )
    try:
        core_v1.create_namespaced_config_map(namespace=NAMESPACE, body=body)
        log.info("Created ConfigMap %s", name)
    except client.ApiException as e:
        if e.status == 409:
            if not data:
                # Spec has no data — preserve whatever is live (user may have patched it)
                log.info("ConfigMap %s already exists with no spec data — preserving live content", name)
            else:
                core_v1.replace_namespaced_config_map(name=name, namespace=NAMESPACE, body=body)
                log.info("Updated ConfigMap %s", name)
        else:
            raise
    return name


def patch_configmap_data(app_id: str, logical_name: str, data: dict) -> None:
    """Replace a ConfigMap's data in full (used by the config API)."""
    name = _cm_name(app_id, logical_name)
    existing = core_v1.read_namespaced_config_map(name=name, namespace=NAMESPACE)
    existing.data = data
    core_v1.replace_namespaced_config_map(name=name, namespace=NAMESPACE, body=existing)
    log.info("Replaced ConfigMap %s", name)


def get_configmap_data(app_id: str, logical_name: str) -> dict:
    """Read a ConfigMap's data dict."""
    name = _cm_name(app_id, logical_name)
    cm = core_v1.read_namespaced_config_map(name=name, namespace=NAMESPACE)
    return dict(cm.data or {})


def delete_configmap(app_id: str, logical_name: str) -> None:
    name = _cm_name(app_id, logical_name)
    try:
        core_v1.delete_namespaced_config_map(name=name, namespace=NAMESPACE)
        log.info("Deleted ConfigMap %s", name)
    except client.ApiException as e:
        if e.status != 404:
            log.warning("Error deleting ConfigMap %s: %s", name, e.reason)


# ── Secret management ─────────────────────────────────────────────────────────

def apply_secret(app_id: str, logical_name: str, plaintext_data: dict) -> str:
    """Create or update a Secret. Values are base64-encoded automatically by k8s client. Returns k8s name."""
    name = _sec_name(app_id, logical_name)
    # kubernetes python client accepts string_data for automatic base64 encoding
    body = client.V1Secret(
        metadata=client.V1ObjectMeta(name=name, namespace=NAMESPACE),
        string_data=plaintext_data or {},
        type="Opaque",
    )
    try:
        core_v1.create_namespaced_secret(namespace=NAMESPACE, body=body)
        log.info("Created Secret %s", name)
    except client.ApiException as e:
        if e.status == 409:
            if not plaintext_data:
                # Spec has no data — preserve whatever is live (user may have patched it)
                log.info("Secret %s already exists with no spec data — preserving live content", name)
            else:
                core_v1.replace_namespaced_secret(name=name, namespace=NAMESPACE, body=body)
                log.info("Updated Secret %s", name)
        else:
            raise
    return name


def patch_secret_data(app_id: str, logical_name: str, plaintext_data: dict) -> None:
    """Replace a Secret's data in full (used by the config API)."""
    name = _sec_name(app_id, logical_name)
    existing = core_v1.read_namespaced_secret(name=name, namespace=NAMESPACE)
    existing.data = {k: base64.b64encode(v.encode()).decode() for k, v in plaintext_data.items()}
    existing.string_data = None
    core_v1.replace_namespaced_secret(name=name, namespace=NAMESPACE, body=existing)
    log.info("Replaced Secret %s", name)


def get_secret_data(app_id: str, logical_name: str) -> dict:
    """Read a Secret's data and decode from base64 to plaintext."""
    name = _sec_name(app_id, logical_name)
    sec = core_v1.read_namespaced_secret(name=name, namespace=NAMESPACE)
    result = {}
    for k, v in (sec.data or {}).items():
        try:
            result[k] = base64.b64decode(v).decode()
        except Exception:
            result[k] = "(binary)"
    return result


def delete_secret(app_id: str, logical_name: str) -> None:
    name = _sec_name(app_id, logical_name)
    try:
        core_v1.delete_namespaced_secret(name=name, namespace=NAMESPACE)
        log.info("Deleted Secret %s", name)
    except client.ApiException as e:
        if e.status != 404:
            log.warning("Error deleting Secret %s: %s", name, e.reason)


# ── PVC quota helpers ─────────────────────────────────────────────────────────

def _parse_storage_gb(storage: str) -> float:
    """Parse a k8s storage quantity string to GB (float). Returns 0 on parse failure."""
    s = storage.strip()
    try:
        if s.endswith("Ti"):
            return float(s[:-2]) * 1024
        if s.endswith("Gi"):
            return float(s[:-2])
        if s.endswith("Mi"):
            return float(s[:-2]) / 1024
        if s.endswith("Ki"):
            return float(s[:-2]) / (1024 ** 2)
        if s.endswith("G"):
            return float(s[:-1]) * 1000 / 1024
        if s.endswith("M"):
            return float(s[:-1]) * 1000 / (1024 ** 2)
        return float(s) / (1024 ** 3)
    except (ValueError, IndexError):
        return 0.0


# ── PVC management ────────────────────────────────────────────────────────────

def apply_pvc(app_id: str, logical_name: str, storage: str, access_mode: str) -> str:
    """Create a PVC if it doesn't exist yet. Returns k8s name."""
    name = _pvc_name(app_id, logical_name)
    body = client.V1PersistentVolumeClaim(
        metadata=client.V1ObjectMeta(name=name, namespace=NAMESPACE),
        spec=client.V1PersistentVolumeClaimSpec(
            access_modes=[access_mode],
            resources=client.V1ResourceRequirements(requests={"storage": storage}),
        ),
    )
    try:
        core_v1.create_namespaced_persistent_volume_claim(namespace=NAMESPACE, body=body)
        log.info("Created PVC %s (%s %s)", name, storage, access_mode)
    except client.ApiException as e:
        if e.status == 409:
            log.info("PVC %s already exists, skipping", name)
        else:
            raise
    return name


def delete_pvc(app_id: str, logical_name: str) -> None:
    name = _pvc_name(app_id, logical_name)
    try:
        core_v1.delete_namespaced_persistent_volume_claim(name=name, namespace=NAMESPACE)
        log.info("Deleted PVC %s", name)
    except client.ApiException as e:
        if e.status != 404:
            log.warning("Error deleting PVC %s: %s", name, e.reason)


# ── Rollout restart ───────────────────────────────────────────────────────────

def rollout_restart(remote_app) -> None:
    """Patch the deployment's pod template annotation to trigger a rollout restart."""
    deploy_name = _deploy_name(remote_app)
    ts = datetime.now(timezone.utc).isoformat()
    patch = {
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {"porpulsion.io/restarted-at": ts}
                }
            }
        }
    }
    try:
        apps_v1.patch_namespaced_deployment(name=deploy_name, namespace=NAMESPACE, body=patch)
        log.info("Rollout restart triggered for %s at %s", deploy_name, ts)
    except client.ApiException as e:
        log.warning("Failed to trigger rollout restart for %s: %s", deploy_name, e.reason)


# ── Status reporting ──────────────────────────────────────────────────────────

def _report_status(remote_app, callback_url, status, peer=None, retries=3):
    """
    Report status back to the originating peer via the WS channel.
    callback_url is the peer name (channel key), not an HTTP URL.
    """
    remote_app.status = status
    remote_app.updated_at = datetime.now(timezone.utc).isoformat()
    log.info("App %s (%s) -> %s", remote_app.name, remote_app.id, status)

    # Update the ExecutingApp CR status on this cluster
    cr_name = getattr(remote_app, "cr_name", None)
    if cr_name:
        try:
            from porpulsion.k8s.store import update_executingapp_cr_status
            update_executingapp_cr_status(NAMESPACE, cr_name, status, remote_app.id)
        except Exception as _e:
            log.debug("EA CR status update skipped: %s", _e)

    if not callback_url:
        return
    payload = {"id": remote_app.id, "status": status, "updated_at": remote_app.updated_at}
    for attempt in range(retries):
        try:
            from porpulsion.channel import get_channel
            get_channel(callback_url).push("remoteapp/status", payload)
            return
        except Exception as e:
            log.warning("Failed to push status to %s (attempt %d): %s", callback_url, attempt + 1, e)
        if attempt < retries - 1:
            time.sleep(2 ** attempt)


# ── Main workload deploy ──────────────────────────────────────────────────────

def run_workload(remote_app, callback_url, peer=None):
    """Create/update Kubernetes resources for the RemoteApp (Deployment, Service, ConfigMaps, Secrets, PVCs)."""
    existing = _stop_events.get(remote_app.id)
    if existing:
        existing.set()
    stop = threading.Event()
    _stop_events[remote_app.id] = stop

    def _execute():
        spec        = remote_app.spec
        image       = spec.image
        replicas    = spec.replicas
        deploy_name = _deploy_name(remote_app)
        labels      = _owner_labels(remote_app)

        _report_status(remote_app, callback_url, "Creating", peer=peer)

        # ── Volumes + VolumeMounts ──────────────────────────────────────────
        volumes: list[client.V1Volume] = []
        volume_mounts: list[client.V1VolumeMount] = []

        # ConfigMaps
        for cm_spec in (spec.configMaps or []):
            if not cm_spec.name or not cm_spec.mountPath:
                continue
            try:
                cm_data = cm_spec.data
                if hasattr(cm_data, "to_dict"):
                    cm_data = cm_data.to_dict()
                k8s_name = apply_configmap(remote_app.id, cm_spec.name, cm_data)
            except client.ApiException as e:
                _report_status(remote_app, callback_url, f"Failed: ConfigMap {cm_spec.name}: {e.reason}", peer=peer)
                return
            vol_name = f"cm-{cm_spec.name}"[:63]
            volumes.append(client.V1Volume(
                name=vol_name,
                config_map=client.V1ConfigMapVolumeSource(name=k8s_name),
            ))
            volume_mounts.append(client.V1VolumeMount(name=vol_name, mount_path=cm_spec.mountPath))

        # Secrets
        for sec_spec in (spec.secrets or []):
            if not sec_spec.name or not sec_spec.mountPath:
                continue
            try:
                sec_data = sec_spec.data
                if hasattr(sec_data, "to_dict"):
                    sec_data = sec_data.to_dict()
                k8s_name = apply_secret(remote_app.id, sec_spec.name, sec_data)
            except client.ApiException as e:
                _report_status(remote_app, callback_url, f"Failed: Secret {sec_spec.name}: {e.reason}", peer=peer)
                return
            vol_name = f"sec-{sec_spec.name}"[:63]
            volumes.append(client.V1Volume(
                name=vol_name,
                secret=client.V1SecretVolumeSource(secret_name=k8s_name),
            ))
            volume_mounts.append(client.V1VolumeMount(name=vol_name, mount_path=sec_spec.mountPath))

        # PVCs — check total quota first
        total_pvc_limit = state.settings.max_pvc_storage_total_gb
        if total_pvc_limit > 0 and spec.pvcs:
            total_requested_gb = sum(_parse_storage_gb(p.storage) for p in spec.pvcs if p.name and p.mountPath)
            if total_requested_gb > total_pvc_limit:
                _report_status(remote_app, callback_url, f"Failed: app requests {total_requested_gb:.1f}Gi total PVC storage but cluster limit is {total_pvc_limit}Gi", peer=peer)
                return

        for pvc_spec in (spec.pvcs or []):
            if not pvc_spec.name or not pvc_spec.mountPath:
                continue
            if not state.settings.allow_pvcs:
                _report_status(remote_app, callback_url, "Failed: PVCs not enabled on this cluster (allow_pvcs=False in Settings)", peer=peer)
                return
            # Per-PVC storage quota check
            per_pvc_limit = state.settings.max_pvc_storage_per_pvc_gb
            if per_pvc_limit > 0:
                requested_gb = _parse_storage_gb(pvc_spec.storage)
                if requested_gb > per_pvc_limit:
                    _report_status(remote_app, callback_url, f"Failed: PVC {pvc_spec.name} requests {pvc_spec.storage} but per-PVC limit is {per_pvc_limit}Gi", peer=peer)
                    return
            try:
                k8s_name = apply_pvc(remote_app.id, pvc_spec.name, pvc_spec.storage, pvc_spec.accessMode)
            except client.ApiException as e:
                _report_status(remote_app, callback_url, f"Failed: PVC {pvc_spec.name}: {e.reason}", peer=peer)
                return
            vol_name = f"pvc-{pvc_spec.name}"[:63]
            volumes.append(client.V1Volume(
                name=vol_name,
                persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=k8s_name),
            ))
            volume_mounts.append(client.V1VolumeMount(name=vol_name, mount_path=pvc_spec.mountPath))

        # ── Resources ─────────────────────────────────────────────────────
        resource_requirements = None
        res = spec.resources
        if res is not None:
            req = res.requests
            lim = res.limits
            # _DictWrapper → plain dict; plain dict stays as-is
            if isinstance(req, object) and hasattr(req, "to_dict"):
                req = req.to_dict()
            if isinstance(lim, object) and hasattr(lim, "to_dict"):
                lim = lim.to_dict()
            if req or lim:
                resource_requirements = client.V1ResourceRequirements(
                    requests=req or None,
                    limits=lim or None,
                )

        # ── Ports ──────────────────────────────────────────────────────────
        if spec.ports:
            container_ports = [
                client.V1ContainerPort(
                    container_port=p.port,
                    name=(p.name[:15] if p.name else f"port-{p.port}"),
                )
                for p in spec.ports
            ]
        else:
            container_ports = [client.V1ContainerPort(container_port=80)]

        # ── Env ────────────────────────────────────────────────────────────
        env_list = None
        if spec.env:
            env_list = []
            for e in spec.env:
                if e.valueFrom:
                    vf = e.valueFrom
                    if vf.secretKeyRef:
                        ref = vf.secretKeyRef
                        env_list.append(client.V1EnvVar(
                            name=e.name,
                            value_from=client.V1EnvVarSource(
                                secret_key_ref=client.V1SecretKeySelector(
                                    name=ref.get("name"), key=ref.get("key"),
                                )
                            ),
                        ))
                    elif vf.configMapKeyRef:
                        ref = vf.configMapKeyRef
                        env_list.append(client.V1EnvVar(
                            name=e.name,
                            value_from=client.V1EnvVarSource(
                                config_map_key_ref=client.V1ConfigMapKeySelector(
                                    name=ref.get("name"), key=ref.get("key"),
                                )
                            ),
                        ))
                    elif vf.fieldRef:
                        fp = vf.fieldRef.get("fieldPath")
                        if fp:
                            env_list.append(client.V1EnvVar(
                                name=e.name,
                                value_from=client.V1EnvVarSource(
                                    field_ref=client.V1ObjectFieldSelector(field_path=fp)
                                ),
                            ))
                        else:
                            env_list.append(client.V1EnvVar(name=e.name, value=e.value or ""))
                    else:
                        env_list.append(client.V1EnvVar(name=e.name, value=e.value or ""))
                else:
                    env_list.append(client.V1EnvVar(name=e.name, value=e.value or ""))

        # ── imagePullPolicy / imagePullSecrets ─────────────────────────────
        pull_policy = spec.imagePullPolicy
        pull_secrets = [client.V1LocalObjectReference(name=s) for s in spec.imagePullSecrets] \
            if spec.imagePullSecrets else None

        # ── Readiness probe ────────────────────────────────────────────────
        readiness_probe = None
        rp = spec.readinessProbe
        if rp:
            http_get = None
            exec_action = None
            if rp.httpGet:
                http_get = client.V1HTTPGetAction(
                    path=rp.httpGet.get("path", "/"),
                    port=rp.httpGet.get("port", 80),
                )
            elif rp.exec:
                exec_action = client.V1ExecAction(command=rp.exec.get("command", []))
            readiness_probe = client.V1Probe(
                http_get=http_get,
                _exec=exec_action,
                initial_delay_seconds=rp.initialDelaySeconds,
                period_seconds=rp.periodSeconds,
                failure_threshold=rp.failureThreshold,
            )

        # ── Security context ───────────────────────────────────────────────
        pod_security_ctx = None
        container_security_ctx = None
        sc = spec.securityContext
        if sc:
            pod_security_ctx = client.V1PodSecurityContext(
                run_as_non_root=sc.runAsNonRoot,
                run_as_user=sc.runAsUser,
                run_as_group=sc.runAsGroup,
                fs_group=sc.fsGroup,
            )
            if sc.readOnlyRootFilesystem is not None:
                container_security_ctx = client.V1SecurityContext(
                    read_only_root_filesystem=sc.readOnlyRootFilesystem
                )

        # ── Build Deployment ───────────────────────────────────────────────
        deployment = client.V1Deployment(
            metadata=client.V1ObjectMeta(
                name=deploy_name,
                namespace=NAMESPACE,
                labels=labels,
            ),
            spec=client.V1DeploymentSpec(
                replicas=replicas,
                selector=client.V1LabelSelector(match_labels={"app": deploy_name}),
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(
                        labels={
                            "app": deploy_name,
                            "porpulsion.io/remote-app-id": remote_app.id,
                        },
                    ),
                    spec=client.V1PodSpec(
                        containers=[
                            client.V1Container(
                                name="main",
                                image=image,
                                image_pull_policy=pull_policy,
                                command=spec.command or None,
                                args=spec.args or None,
                                ports=container_ports,
                                resources=resource_requirements,
                                env=env_list,
                                volume_mounts=volume_mounts or None,
                                readiness_probe=readiness_probe,
                                security_context=container_security_ctx,
                            )
                        ],
                        volumes=volumes or None,
                        image_pull_secrets=pull_secrets,
                        security_context=pod_security_ctx,
                    ),
                ),
            ),
        )

        try:
            apps_v1.create_namespaced_deployment(namespace=NAMESPACE, body=deployment)
            log.info("Created deployment %s in %s", deploy_name, NAMESPACE)
        except client.ApiException as e:
            if e.status == 409:
                log.info("Deployment %s already exists, updating", deploy_name)
                apps_v1.replace_namespaced_deployment(name=deploy_name, namespace=NAMESPACE, body=deployment)
            else:
                _report_status(remote_app, callback_url, f"Failed: {e.reason}", peer=peer)
                return

        # ── Service ────────────────────────────────────────────────────────
        if spec.ports:
            service_ports = [
                client.V1ServicePort(
                    port=p.port,
                    target_port=p.port,
                    name=(p.name[:15] if p.name else f"port-{p.port}"),
                )
                for p in spec.ports
            ]
        else:
            service_ports = [client.V1ServicePort(port=80, target_port=80, name="http")]

        service = client.V1Service(
            metadata=client.V1ObjectMeta(
                name=deploy_name,
                namespace=NAMESPACE,
                labels={"app": deploy_name, "porpulsion.io/remote-app-id": remote_app.id},
            ),
            spec=client.V1ServiceSpec(
                selector={"app": deploy_name},
                ports=service_ports,
            ),
        )
        try:
            core_v1.create_namespaced_service(namespace=NAMESPACE, body=service)
            log.info("Created service %s in %s", deploy_name, NAMESPACE)
        except client.ApiException as e:
            if e.status == 409:
                core_v1.replace_namespaced_service(name=deploy_name, namespace=NAMESPACE, body=service)
                log.info("Updated service %s", deploy_name)
            else:
                log.warning("Failed to create service %s: %s", deploy_name, e.reason)

        _report_status(remote_app, callback_url, "Running", peer=peer)

        # ── Poll until ready ───────────────────────────────────────────────
        for _ in range(60):
            if stop.is_set():
                log.info("Watcher for %s cancelled (re-deploy)", remote_app.id)
                return
            time.sleep(2)
            try:
                dep = apps_v1.read_namespaced_deployment_status(deploy_name, NAMESPACE)
                ready = dep.status.ready_replicas or 0
                if ready >= replicas:
                    _report_status(remote_app, callback_url, "Ready", peer=peer)
                    _stop_events.pop(remote_app.id, None)
                    return
            except client.ApiException as e:
                log.warning("Error checking deployment status: %s", e.reason)

        _report_status(remote_app, callback_url, "Timeout", peer=peer)
        _stop_events.pop(remote_app.id, None)

    t = threading.Thread(target=_execute, daemon=True)
    t.start()


def delete_workload(remote_app) -> None:
    """Delete all Kubernetes resources for a RemoteApp (Deployment, Service, ConfigMaps, Secrets, PVCs)."""
    deploy_name = _deploy_name(remote_app)
    spec = remote_app.spec

    # Cancel any watcher
    ev = _stop_events.pop(remote_app.id, None)
    if ev:
        ev.set()

    # Deployment
    try:
        apps_v1.delete_namespaced_deployment(
            name=deploy_name, namespace=NAMESPACE,
            body=client.V1DeleteOptions(propagation_policy="Foreground"),
        )
        log.info("Deleted deployment %s", deploy_name)
    except client.ApiException as e:
        if e.status != 404:
            log.warning("Error deleting deployment %s: %s", deploy_name, e.reason)

    # Service
    try:
        core_v1.delete_namespaced_service(name=deploy_name, namespace=NAMESPACE)
        log.info("Deleted service %s", deploy_name)
    except client.ApiException as e:
        if e.status != 404:
            log.warning("Error deleting service %s: %s", deploy_name, e.reason)

    # ConfigMaps
    for cm_spec in (spec.configMaps if spec else []):
        delete_configmap(remote_app.id, cm_spec.name)

    # Secrets
    for sec_spec in (spec.secrets if spec else []):
        delete_secret(remote_app.id, sec_spec.name)

    # PVCs (not deleted by default — data retention)
    # Un-comment the loop below if you want PVCs deleted with the workload
    # for pvc_spec in (spec.pvcs if spec else []):
    #     delete_pvc(remote_app.id, pvc_spec.name)


def scale_workload(remote_app, replicas: int) -> None:
    """Scale a RemoteApp deployment to the given replica count."""
    deploy_name = _deploy_name(remote_app)
    try:
        dep = apps_v1.read_namespaced_deployment(deploy_name, NAMESPACE)
        dep.spec.replicas = replicas
        apps_v1.replace_namespaced_deployment(deploy_name, NAMESPACE, dep)
        log.info("Scaled deployment %s to %d replicas", deploy_name, replicas)
    except client.ApiException as e:
        log.warning("Error scaling deployment %s: %s", deploy_name, e.reason)
        raise


def get_deployment_status(remote_app) -> dict:
    """Return live k8s status info for a RemoteApp deployment."""
    deploy_name = _deploy_name(remote_app)
    try:
        dep = apps_v1.read_namespaced_deployment_status(deploy_name, NAMESPACE)
        pods = core_v1.list_namespaced_pod(
            NAMESPACE,
            label_selector=f"porpulsion.io/remote-app-id={remote_app.id}",
        )
        pod_list = []
        for p in pods.items:
            pod_list.append({
                "name": p.metadata.name,
                "phase": p.status.phase,
                "ready": all(c.ready for c in (p.status.container_statuses or [])),
                "restarts": sum(c.restart_count for c in (p.status.container_statuses or [])),
                "node": p.spec.node_name,
            })
        return {
            "deploy_name": deploy_name,
            "desired": dep.spec.replicas,
            "ready": dep.status.ready_replicas or 0,
            "available": dep.status.available_replicas or 0,
            "updated": dep.status.updated_replicas or 0,
            "pods": pod_list,
        }
    except client.ApiException as e:
        if e.status == 404:
            return {"error": "deployment not found"}
        raise


def get_pod_logs(remote_app, tail: int = 200, pod_name: str | None = None, order_by_time: bool = False) -> dict:
    """
    Return recent log lines from pods of a RemoteApp.
    If pod_name is set, only that pod; otherwise all pods (aggregated with pod prefix).
    If order_by_time is True, fetch with timestamps and return lines sorted by time.
    Returns {"lines": [{"pod": str, "message": str, "ts": str|None}, ...]} or {"error": str}.
    """
    import re
    from datetime import datetime, timezone

    try:
        pods = core_v1.list_namespaced_pod(
            NAMESPACE,
            label_selector=f"porpulsion.io/remote-app-id={remote_app.id}",
        )
        if pod_name:
            pods.items = [p for p in pods.items if p.metadata.name == pod_name]
        if not pods.items:
            return {"lines": [], "error": "no pods found"}

        lines: list[dict] = []
        per_pod_tail = max(50, tail // len(pods.items)) if len(pods.items) > 1 else tail
        ts_re = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*(.*)$")

        for p in pods.items:
            name = p.metadata.name
            try:
                log_text = core_v1.read_namespaced_pod_log(
                    name=name,
                    namespace=NAMESPACE,
                    tail_lines=per_pod_tail,
                    timestamps=order_by_time,
                )
            except client.ApiException as e:
                if e.status == 404:
                    lines.append({"pod": name, "message": "(pod not found)", "ts": None})
                else:
                    lines.append({"pod": name, "message": f"(failed to read logs: {e.reason})", "ts": None})
                continue
            for line in (log_text or "").strip().splitlines():
                ts_val = None
                msg = line
                if order_by_time:
                    m = ts_re.match(line)
                    if m:
                        ts_val = m.group(1)
                        msg = m.group(2) or ""
                lines.append({"pod": name, "message": msg, "ts": ts_val})

        if order_by_time and lines:
            def sort_key(entry):
                t = entry.get("ts")
                if not t:
                    return (datetime.max.replace(tzinfo=timezone.utc), entry.get("pod", ""), entry.get("message", ""))
                try:
                    if t.endswith("Z"):
                        t = t[:-1] + "+00:00"
                    return (datetime.fromisoformat(t), entry.get("pod", ""), entry.get("message", ""))
                except Exception:
                    return (datetime.max.replace(tzinfo=timezone.utc), entry.get("pod", ""), entry.get("message", ""))
            lines.sort(key=sort_key)

        return {"lines": lines}
    except client.ApiException as e:
        if e.status == 404:
            return {"lines": [], "error": "deployment not found"}
        return {"lines": [], "error": str(e.reason)}
