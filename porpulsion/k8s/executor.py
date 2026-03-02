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



def _report_status(remote_app, callback_url, status, peer=None, retries=3):
    """
    Report status back to the originating peer via the WS channel.
    callback_url is now the peer name (channel key), not an HTTP URL.
    """
    remote_app.status = status
    remote_app.updated_at = datetime.now(timezone.utc).isoformat()
    log.info("App %s (%s) -> %s", remote_app.name, remote_app.id, status)
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


def run_workload(remote_app, callback_url, peer=None):
    """Create a real Kubernetes Deployment for the RemoteApp."""
    # Cancel any existing watcher for this app before starting a new one
    existing = _stop_events.get(remote_app.id)
    if existing:
        existing.set()
    stop = threading.Event()
    _stop_events[remote_app.id] = stop

    def _execute():
        spec     = remote_app.spec
        image    = spec.image
        replicas = spec.replicas
        deploy_name = f"ra-{remote_app.id}-{remote_app.name}"[:63]

        # ── resources ────────────────────────────────────────
        resource_requirements = None
        if not spec.resources.is_empty():
            resource_requirements = client.V1ResourceRequirements(
                requests=spec.resources.requests or None,
                limits=spec.resources.limits or None,
            )

        # ── ports ─────────────────────────────────────────────
        if spec.ports:
            container_ports = [
                client.V1ContainerPort(
                    container_port=p.port,
                    name=(p.name[:15] if p.name else f"port-{p.port}"),
                )
                for p in spec.ports
            ]
        else:
            container_ports = [client.V1ContainerPort(
                container_port=spec.port or 80
            )]

        # ── env ─────────────────────────────────────────────
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
                                    name=ref["name"], key=ref["key"]
                                )
                            ),
                        ))
                    elif vf.configMapKeyRef:
                        ref = vf.configMapKeyRef
                        env_list.append(client.V1EnvVar(
                            name=e.name,
                            value_from=client.V1EnvVarSource(
                                config_map_key_ref=client.V1ConfigMapKeySelector(
                                    name=ref["name"], key=ref["key"]
                                )
                            ),
                        ))
                    elif vf.fieldRef and vf.fieldRef.get("fieldPath"):
                        env_list.append(client.V1EnvVar(
                            name=e.name,
                            value_from=client.V1EnvVarSource(
                                field_ref=client.V1ObjectFieldSelector(
                                    field_path=vf.fieldRef["fieldPath"]
                                )
                            ),
                        ))
                    else:
                        env_list.append(client.V1EnvVar(name=e.name, value=e.value))

        # ── imagePullPolicy / imagePullSecrets ───────────────
        pull_policy = spec.imagePullPolicy
        pull_secrets = [client.V1LocalObjectReference(name=s) for s in spec.imagePullSecrets] \
            if spec.imagePullSecrets else None

        # ── command / args ───────────────────────────────────
        command = spec.command or None
        args    = spec.args    or None

        # ── readinessProbe ───────────────────────────────────
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

        # ── securityContext ──────────────────────────────────
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

        _report_status(remote_app, callback_url, "Creating", peer=peer)

        deployment = client.V1Deployment(
            metadata=client.V1ObjectMeta(
                name=deploy_name,
                namespace=NAMESPACE,
                labels={
                    "app": deploy_name,
                    "porpulsion.io/remote-app-id": remote_app.id,
                    "porpulsion.io/source-peer": remote_app.source_peer,
                },
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
                                command=command,
                                args=args,
                                ports=container_ports,
                                resources=resource_requirements,
                                env=env_list,
                                readiness_probe=readiness_probe,
                                security_context=container_security_ctx,
                            )
                        ],
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
                apps_v1.replace_namespaced_deployment(
                    name=deploy_name, namespace=NAMESPACE, body=deployment
                )
            else:
                _report_status(remote_app, callback_url, f"Failed: {e.reason}", peer=peer)
                return

        # Service for proxy/load-balancing (same name as deployment, selector = app=deploy_name)
        # Expose all ports from spec.ports (or single spec.port/80)
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
            single_port = spec.port or 80
            service_ports = [
                client.V1ServicePort(port=single_port, target_port=single_port, name="http"),
            ]
        service = client.V1Service(
            metadata=client.V1ObjectMeta(
                name=deploy_name,
                namespace=NAMESPACE,
                labels={
                    "app": deploy_name,
                    "porpulsion.io/remote-app-id": remote_app.id,
                },
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
                core_v1.replace_namespaced_service(
                    name=deploy_name, namespace=NAMESPACE, body=service
                )
                log.info("Updated service %s", deploy_name)
            else:
                log.warning("Failed to create service %s: %s", deploy_name, e.reason)

        _report_status(remote_app, callback_url, "Running", peer=peer)

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
    """Delete the Kubernetes Deployment and Service for a RemoteApp."""
    deploy_name = f"ra-{remote_app.id}-{remote_app.name}"[:63]
    try:
        apps_v1.delete_namespaced_deployment(
            name=deploy_name,
            namespace=NAMESPACE,
            body=client.V1DeleteOptions(propagation_policy="Foreground"),
        )
        log.info("Deleted deployment %s", deploy_name)
    except client.ApiException as e:
        if e.status == 404:
            log.info("Deployment %s already gone", deploy_name)
        else:
            log.warning("Error deleting deployment %s: %s", deploy_name, e.reason)
    try:
        core_v1.delete_namespaced_service(name=deploy_name, namespace=NAMESPACE)
        log.info("Deleted service %s", deploy_name)
    except client.ApiException as e:
        if e.status == 404:
            log.info("Service %s already gone", deploy_name)
        else:
            log.warning("Error deleting service %s: %s", deploy_name, e.reason)


def scale_workload(remote_app, replicas: int) -> None:
    """Scale a RemoteApp deployment to the given replica count."""
    deploy_name = f"ra-{remote_app.id}-{remote_app.name}"[:63]
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
    deploy_name = f"ra-{remote_app.id}-{remote_app.name}"[:63]
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
    If order_by_time is True, fetch with timestamps and return lines sorted by time (single tail).
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
            return {"lines": [], "error": "no pods found" if pod_name else "no pods found"}

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
                    # Parse ISO8601 with Z suffix
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
