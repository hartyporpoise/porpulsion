SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE   := docker-compose
CLUSTER_A := porpulsion-cluster-a-1
CLUSTER_B := porpulsion-cluster-b-1
HELM      := porpulsion-helm-1

# kubectl via docker exec - no local kubeconfig ever needed
KUBECTL_A := docker exec $(CLUSTER_A) kubectl
KUBECTL_B := docker exec $(CLUSTER_B) kubectl

# Single-cluster setup (docker-compose.single.yml)
COMPOSE_SINGLE  := docker-compose -f docker-compose.single.yml
CLUSTER_SINGLE  := porpulsion-cluster-1
HELM_SINGLE     := porpulsion-helm-1
KUBECTL_SINGLE  := docker exec $(CLUSTER_SINGLE) kubectl

# Run helm inside the persistent helm container.
# Usage: $(call helm, K3S_CONTAINER, K3S_HOSTNAME:PORT, helm args...)
#
# The helm container is on the same Docker network as both k3s clusters,
# so it can reach them by hostname. It docker-execs into k3s to fetch
# the kubeconfig, rewrites 127.0.0.1 to the k3s service hostname,
# and writes it to /tmp inside the helm container only.
define helm
	docker exec $(HELM) sh -c "\
		docker exec $(1) cat /etc/rancher/k3s/k3s.yaml \
			| sed 's|127.0.0.1:[0-9]*|$(2)|g' \
			> /tmp/kubeconfig-$(1).yaml && \
		chmod 600 /tmp/kubeconfig-$(1).yaml && \
		KUBECONFIG=/tmp/kubeconfig-$(1).yaml helm $(3) \
	"
endef

.PHONY: help deploy teardown clean-ns _clean-cluster status logs \
        deploy-single teardown-single status-single logs-single \
        test test-teardown

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

deploy: ## Full deploy: start clusters, build image, helm install all agents
	@_names=.porpulsion-agents; \
	_get() { grep "^$$1=" $$_names 2>/dev/null | cut -d= -f2; }; \
	NAME_A=$$(_get a); NAME_B=$$(_get b); \
	[ -z "$$NAME_A" ] && NAME_A=$$(openssl rand -hex 6); \
	[ -z "$$NAME_B" ] && NAME_B=$$(openssl rand -hex 6); \
	printf 'a=%s\nb=%s\n' "$$NAME_A" "$$NAME_B" > $$_names; \
	echo ""; \
	echo "==> Starting clusters + helm runner (a=$$NAME_A b=$$NAME_B)..."; \
	$(COMPOSE) up -d; \
	echo "Waiting for cluster-a API..."; \
	until $(KUBECTL_A) get nodes &>/dev/null; do sleep 2; done; \
	echo "  cluster-a ready"; \
	echo "Waiting for cluster-b API..."; \
	until $(KUBECTL_B) get nodes &>/dev/null; do sleep 2; done; \
	echo "  cluster-b ready"; \
	echo ""; \
	echo "==> Building porpulsion-agent image..."; \
	docker build -t porpulsion-agent:local .; \
	echo ""; \
	echo "==> Loading image into clusters..."; \
	docker save porpulsion-agent:local | docker exec -i $(CLUSTER_A) ctr images import -; \
	docker save porpulsion-agent:local | docker exec -i $(CLUSTER_B) ctr images import -; \
	echo ""; \
	echo "==> Helm installing on cluster-a ($$NAME_A)..."; \
	IP_A=$$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $(CLUSTER_A)); \
	echo "  cluster-a IP: $$IP_A"; \
	docker exec $(HELM) sh -c " \
		docker exec $(CLUSTER_A) cat /etc/rancher/k3s/k3s.yaml \
			| sed 's|127.0.0.1:[0-9]*|cluster-a:6443|g' \
			> /tmp/kubeconfig-a.yaml && \
		chmod 600 /tmp/kubeconfig-a.yaml && \
		KUBECONFIG=/tmp/kubeconfig-a.yaml helm upgrade --install porpulsion /charts/porpulsion \
			--create-namespace --namespace porpulsion \
			--set agent.agentName=$$NAME_A \
			--set agent.selfUrl=http://$$IP_A:30080 \
			--set agent.image=porpulsion-agent:local \
			--set agent.pullPolicy=Never \
			--set service.type=NodePort \
			--set service.nodePort=30080 \
			--set networkPolicy.enabled=false \
			--wait --timeout 90s \
	"; \
	echo ""; \
	echo "==> Helm installing on cluster-b ($$NAME_B)..."; \
	IP_B=$$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $(CLUSTER_B)); \
	echo "  cluster-b IP: $$IP_B"; \
	docker exec $(HELM) sh -c " \
		docker exec $(CLUSTER_B) cat /etc/rancher/k3s/k3s.yaml \
			| sed 's|127.0.0.1:[0-9]*|cluster-b:6444|g' \
			> /tmp/kubeconfig-b.yaml && \
		chmod 600 /tmp/kubeconfig-b.yaml && \
		KUBECONFIG=/tmp/kubeconfig-b.yaml helm upgrade --install porpulsion /charts/porpulsion \
			--create-namespace --namespace porpulsion \
			--set agent.agentName=$$NAME_B \
			--set agent.selfUrl=http://$$IP_B:30080 \
			--set agent.image=porpulsion-agent:local \
			--set agent.pullPolicy=Never \
			--set service.type=NodePort \
			--set service.nodePort=30080 \
			--set networkPolicy.enabled=false \
			--wait --timeout 90s \
	"; \
	echo ""; \
	echo "============================================"; \
	echo "  porpulsion is running!"; \
	echo "  a=$$NAME_A  b=$$NAME_B"; \
	echo "============================================"; \
	echo ""; \
	echo "  cluster-a:  http://localhost:8001  (/ws on same port)"; \
	echo "  cluster-b:  http://localhost:8002  (/ws on same port)"; \
	echo ""; \
	echo "  kubectl:"; \
	echo "    docker exec $(CLUSTER_A) kubectl get pods -n porpulsion"; \
	echo "    docker exec $(CLUSTER_B) kubectl get pods -n porpulsion"
	@echo ""

teardown: ## Destroy clusters and volumes
	$(COMPOSE) down -v
	@rm -f .porpulsion-agents

status: ## Show pods, deployments, and peer status
	@echo "=== Cluster A Pods ==="
	@$(KUBECTL_A) -n porpulsion get pods 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== Cluster A Deployments ==="
	@$(KUBECTL_A) -n porpulsion get deployments 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== Cluster A RemoteApps ==="
	@$(KUBECTL_A) -n porpulsion get remoteapps.porpulsion.io 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== Cluster A ExecutingApps ==="
	@$(KUBECTL_A) -n porpulsion get executingapps.porpulsion.io 2>/dev/null || echo "  not available"
	@echo "-------------------------------------------------------------------------------"
	@echo "=== Cluster B Pods ==="
	@$(KUBECTL_B) -n porpulsion get pods 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== Cluster B Deployments ==="
	@$(KUBECTL_B) -n porpulsion get deployments 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== Cluster B RemoteApps ==="
	@$(KUBECTL_B) -n porpulsion get remoteapps.porpulsion.io 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== Cluster B ExecutingApps ==="
	@$(KUBECTL_B) -n porpulsion get executingapps.porpulsion.io 2>/dev/null || echo "  not available"
	@echo ""

logs: ## Stream live logs from all clusters (Ctrl-C to stop)
	@$(KUBECTL_A) -n porpulsion logs -l app=porpulsion-agent -f --tail=20 2>/dev/null | sed 's/^/\x1b[36m[A]\x1b[0m /' & \
	$(KUBECTL_B) -n porpulsion logs -l app=porpulsion-agent -f --tail=20 2>/dev/null | sed 's/^/\x1b[33m[B]\x1b[0m /' & \
	trap 'kill 0' INT; wait

clean-ns: ## Remove porpulsion namespace from all clusters (handles CRD finalizers)
	@$(MAKE) --no-print-directory _clean-cluster KUBECTL="$(KUBECTL_A)" CLUSTER=$(CLUSTER_A) APIHOST=cluster-a:6443
	@$(MAKE) --no-print-directory _clean-cluster KUBECTL="$(KUBECTL_B)" CLUSTER=$(CLUSTER_B) APIHOST=cluster-b:6444

# Internal: clean one cluster's porpulsion namespace safely.
# Caller must pass: KUBECTL, CLUSTER, APIHOST (e.g. cluster-a:6443)
_clean-cluster:
	@$(KUBECTL) -n porpulsion get secret sh.helm.release.v1.porpulsion.v1 &>/dev/null 2>&1 && \
		docker exec $(HELM) sh -c " \
			docker exec $(CLUSTER) cat /etc/rancher/k3s/k3s.yaml \
				| sed 's|127.0.0.1:[0-9]*|$(APIHOST)|g' \
				> /tmp/kubeconfig-clean-$(CLUSTER).yaml && \
			chmod 600 /tmp/kubeconfig-clean-$(CLUSTER).yaml && \
			KUBECONFIG=/tmp/kubeconfig-clean-$(CLUSTER).yaml \
			helm uninstall porpulsion --namespace porpulsion --ignore-not-found 2>/dev/null \
		" || true
	@$(KUBECTL) get remoteapps.porpulsion.io -n porpulsion \
		-o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null \
		| while read name; do \
			[ -z "$$name" ] && continue; \
			$(KUBECTL) patch remoteapp.porpulsion.io "$$name" -n porpulsion \
				--type=json -p '[{"op":"remove","path":"/metadata/finalizers"}]' \
				2>/dev/null || true; \
			$(KUBECTL) delete remoteapp.porpulsion.io "$$name" -n porpulsion \
				--ignore-not-found=true 2>/dev/null || true; \
		done
	@$(KUBECTL) delete crd remoteapps.porpulsion.io --ignore-not-found=true 2>/dev/null || true
	@$(KUBECTL) delete namespace porpulsion --ignore-not-found=true 2>/dev/null || true

# ---------------------------------------------------------------------------
# Single-cluster targets (docker-compose.single.yml)
# ---------------------------------------------------------------------------

deploy-single: ## Start a single k3s cluster, build image, helm install
	@if [ -f .porpulsion-agents-single ]; then \
		NAME=$$(cat .porpulsion-agents-single); \
	else \
		NAME=$$(openssl rand -hex 6); \
		echo "$$NAME" > .porpulsion-agents-single; \
	fi; \
	echo ""; \
	echo "==> Starting single cluster + helm runner (agent: $$NAME)..."; \
	$(COMPOSE_SINGLE) up -d; \
	echo "Waiting for cluster API..."; \
	until $(KUBECTL_SINGLE) get nodes &>/dev/null; do sleep 2; done; \
	echo "  cluster ready"; \
	echo ""; \
	echo "==> Building porpulsion-agent image..."; \
	docker build -t porpulsion-agent:local .; \
	echo ""; \
	echo "==> Loading image into cluster..."; \
	docker save porpulsion-agent:local | docker exec -i $(CLUSTER_SINGLE) ctr images import -; \
	echo ""; \
	echo "==> Helm installing porpulsion..."; \
	IP=$$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $(CLUSTER_SINGLE)); \
	echo "  cluster IP: $$IP"; \
	docker exec $(HELM_SINGLE) sh -c " \
		docker exec $(CLUSTER_SINGLE) cat /etc/rancher/k3s/k3s.yaml \
			| sed 's|127.0.0.1:[0-9]*|cluster:6443|g' \
			> /tmp/kubeconfig-single.yaml && \
		chmod 600 /tmp/kubeconfig-single.yaml && \
		KUBECONFIG=/tmp/kubeconfig-single.yaml helm upgrade --install porpulsion /charts/porpulsion \
			--create-namespace --namespace porpulsion \
			--set agent.agentName=$$NAME \
			--set agent.selfUrl=http://$$IP:30080 \
			--set agent.image=porpulsion-agent:local \
			--set agent.pullPolicy=Never \
			--set service.type=NodePort \
			--set service.nodePort=30080 \
			--set networkPolicy.enabled=false \
			--wait --timeout 90s \
	"; \
	echo ""; \
	echo "============================================"; \
	echo "  porpulsion is running! (agent: $$NAME)"; \
	echo "============================================"; \
	echo ""; \
	echo "  UI + peer: http://localhost:8080  (/ws on same port)"; \
	echo ""

teardown-single: ## Destroy single cluster and volumes
	$(COMPOSE_SINGLE) down -v
	@rm -f .porpulsion-agents-single

status-single: ## Show pods and deployments for single cluster
	@echo "=== Pods ==="
	@$(KUBECTL_SINGLE) -n porpulsion get pods 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== Deployments ==="
	@$(KUBECTL_SINGLE) -n porpulsion get deployments 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== RemoteApps ==="
	@$(KUBECTL_SINGLE) -n porpulsion get remoteapps.porpulsion.io 2>/dev/null || echo "  not available"
	@echo ""
	@echo "=== ExecutingApps ==="
	@$(KUBECTL_SINGLE) -n porpulsion get executingapps.porpulsion.io 2>/dev/null || echo "  not available"

logs-single: ## Stream live logs from single cluster (Ctrl-C to stop)
	$(KUBECTL_SINGLE) -n porpulsion logs -l app=porpulsion-agent -f --tail=50

# ---------------------------------------------------------------------------
# E2E test targets (containerised Cypress, uses main docker-compose.yml)
# ---------------------------------------------------------------------------

CYPRESS_IMAGE := porpulsion-cypress:local
TEST_USERNAME := admin
TEST_PASSWORD := adminpass1

test: ## Deploy 2 clusters, run Cypress E2E suite, tear down (watch at http://localhost:6080/vnc.html)
	@trap '$(MAKE) teardown' INT TERM EXIT; $(MAKE) _cypress-run; EXIT=$$?; trap - EXIT; $(MAKE) teardown; exit $$EXIT

_cypress-run: ## Internal: build image, wait for agents, run Cypress
	@$(MAKE) deploy; \
	echo ""; \
	echo "==> [test] Building Cypress image..."; \
	docker build -f Dockerfile.cypress -t $(CYPRESS_IMAGE) .; \
	echo ""; \
	echo "==> [test] Waiting for agent-a (localhost:8001)..."; \
	until curl -sf http://localhost:8001/ -o /dev/null; do sleep 2; done; \
	echo "  agent-a ready"; \
	echo "==> [test] Waiting for agent-b (localhost:8002)..."; \
	until curl -sf http://localhost:8002/ -o /dev/null; do sleep 2; done; \
	echo "  agent-b ready"; \
	echo ""; \
	echo "==> [test] Running Cypress — open http://localhost:6080/vnc.html to watch..."; \
	DOCKER_NET=$$(docker inspect $(CLUSTER_A) \
		--format '{{range $$k, $$v := .NetworkSettings.Networks}}{{$$k}}{{end}}' | head -1); \
	docker run --rm \
		--network "$$DOCKER_NET" \
		-p 6080:6080 \
		-e CYPRESS_BASE_URL=http://cluster-a:30080 \
		-e CYPRESS_AGENT_A_URL=http://cluster-a:30080 \
		-e CYPRESS_AGENT_B_URL=http://cluster-b:30080 \
		-e CYPRESS_USERNAME=$(TEST_USERNAME) \
		-e CYPRESS_PASSWORD=$(TEST_PASSWORD) \
		-v "$$(pwd)/cypress/screenshots:/e2e/cypress/screenshots" \
		$(CYPRESS_IMAGE); \
	EXIT_CODE=$$?; \
	if [ $$EXIT_CODE -eq 0 ]; then \
		echo "  ✓ All tests passed"; \
	else \
		echo "  ✗ Tests failed (exit $$EXIT_CODE) — screenshots in cypress/screenshots/"; \
		exit $$EXIT_CODE; \
	fi

test-teardown: ## Destroy clusters if make test was interrupted
	$(MAKE) teardown
