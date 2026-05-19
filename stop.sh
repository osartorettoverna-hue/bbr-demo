#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[BBR-DEMO]${NC} $*"; }

info "Arresto BBR Demo..."

# Ferma backend uvicorn (se in esecuzione)
pkill -f "uvicorn backend.main:app" 2>/dev/null && info "Backend fermato." || true

# Ferma e rimuovi container
if docker compose down 2>/dev/null; then
  info "Container Docker fermati."
fi

info "Demo fermata. Bye."
