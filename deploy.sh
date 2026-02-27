#!/usr/bin/env bash
set -euo pipefail

# ============================================================
#  LinkRoom K8s 一键部署脚本
# ============================================================
#  用法:
#    ./deploy.sh                    # 构建镜像 + 部署到 K8s
#    ./deploy.sh build              # 仅构建 Docker 镜像
#    ./deploy.sh apply              # 仅应用 K8s 清单
#    ./deploy.sh delete             # 删除所有 K8s 资源
#    ./deploy.sh status             # 查看部署状态
#    ./deploy.sh logs               # 查看实时日志
# ============================================================

# ---------- 配置项 (按需修改) ----------
IMAGE_NAME="${IMAGE_NAME:-linkroom}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
NAMESPACE="linkroom"
K8S_DIR="$(cd "$(dirname "$0")/k8s" && pwd)"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ---------- 前置检查 ----------
check_deps() {
  local missing=()
  command -v docker  &>/dev/null || missing+=(docker)
  command -v kubectl &>/dev/null || missing+=(kubectl)

  if [[ ${#missing[@]} -gt 0 ]]; then
    err "缺少依赖工具: ${missing[*]}"
    err "请先安装后重试"
    exit 1
  fi
}

# ---------- 构建镜像 ----------
do_build() {
  info "构建 Docker 镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
  docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" "${PROJECT_DIR}"
  ok "镜像构建完成: ${IMAGE_NAME}:${IMAGE_TAG}"

  echo ""
  info "镜像信息:"
  docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "  大小: {{.Size}}  创建时间: {{.CreatedSince}}"
}

# ---------- 部署到 K8s ----------
do_apply() {
  info "部署到 Kubernetes..."

  # 按依赖顺序应用
  info "  → 创建命名空间"
  kubectl apply -f "${K8S_DIR}/namespace.yaml"

  info "  → 应用 ConfigMap"
  kubectl apply -f "${K8S_DIR}/configmap.yaml"

  info "  → 创建持久化存储"
  kubectl apply -f "${K8S_DIR}/pvc.yaml"

  info "  → 部署应用"
  kubectl apply -f "${K8S_DIR}/deployment.yaml"

  info "  → 创建 Service"
  kubectl apply -f "${K8S_DIR}/service.yaml"

  info "  → 配置 Ingress"
  kubectl apply -f "${K8S_DIR}/ingress.yaml"

  echo ""
  ok "所有资源已部署"

  # 等待就绪
  info "等待 Pod 就绪..."
  kubectl -n "${NAMESPACE}" rollout status deployment/linkroom --timeout=120s && \
    ok "部署就绪!" || warn "Pod 尚未完全就绪，请用 ./deploy.sh status 查看"

  echo ""
  do_status
}

# ---------- 删除资源 ----------
do_delete() {
  warn "即将删除 LinkRoom 所有 K8s 资源 (命名空间: ${NAMESPACE})"
  read -rp "确认删除? [y/N] " confirm
  if [[ "${confirm}" =~ ^[Yy]$ ]]; then
    kubectl delete namespace "${NAMESPACE}" --ignore-not-found
    ok "已删除命名空间: ${NAMESPACE}"
  else
    info "已取消"
  fi
}

# ---------- 查看状态 ----------
do_status() {
  info "=== LinkRoom 部署状态 ==="
  echo ""

  echo -e "${CYAN}Pods:${NC}"
  kubectl -n "${NAMESPACE}" get pods -o wide 2>/dev/null || warn "无法获取 Pod 信息"
  echo ""

  echo -e "${CYAN}Service:${NC}"
  kubectl -n "${NAMESPACE}" get svc 2>/dev/null || warn "无法获取 Service 信息"
  echo ""

  echo -e "${CYAN}Ingress:${NC}"
  kubectl -n "${NAMESPACE}" get ingress 2>/dev/null || warn "无法获取 Ingress 信息"
  echo ""

  echo -e "${CYAN}PVC:${NC}"
  kubectl -n "${NAMESPACE}" get pvc 2>/dev/null || warn "无法获取 PVC 信息"
}

# ---------- 查看日志 ----------
do_logs() {
  info "查看 LinkRoom 日志 (Ctrl+C 退出)..."
  kubectl -n "${NAMESPACE}" logs -f deployment/linkroom --tail=100
}

# ---------- 主流程 ----------
main() {
  check_deps

  local cmd="${1:-all}"

  case "${cmd}" in
    build)
      do_build
      ;;
    apply)
      do_apply
      ;;
    delete)
      do_delete
      ;;
    status)
      do_status
      ;;
    logs)
      do_logs
      ;;
    all|"")
      do_build
      echo ""
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
      do_apply
      ;;
    *)
      err "未知命令: ${cmd}"
      echo ""
      echo "用法: $0 {build|apply|delete|status|logs}"
      exit 1
      ;;
  esac
}

main "$@"
