#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[BBR-DEMO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

info "=== BBR Demo — avvio ==="

# ─── 1. Docker ─────────────────────────────────────────────────────────────────
if ! docker info &>/dev/null; then
  error "Docker non è in esecuzione. Avvia Colima: colima start --vm-type vz"
  exit 1
fi
info "Docker OK ($(docker info --format '{{.ServerVersion}}' 2>/dev/null))"

# ─── 2. Build immagine (unica, condivisa) ──────────────────────────────────────
info "Build immagine bbr-demo-node (prima volta ~30s, poi cached)..."
docker build -t bbr-demo-node:latest . -q
info "Immagine pronta."

# ─── 3. Avvia container (idempotente) ─────────────────────────────────────────
info "Avvio container..."
docker compose up -d
info "Container avviati."

# ─── 4. Attendi Running ────────────────────────────────────────────────────────
info "Attendo che i container siano pronti..."
for i in $(seq 1 20); do
  SERVER_OK=$(docker inspect --format '{{.State.Running}}' bbr-server 2>/dev/null || echo "false")
  CLIENT_OK=$(docker inspect --format '{{.State.Running}}' bbr-client 2>/dev/null || echo "false")
  [[ "$SERVER_OK" == "true" && "$CLIENT_OK" == "true" ]] && { info "Container pronti."; break; }
  sleep 1
  [[ $i -eq 20 ]] && { error "Timeout container."; docker compose logs; exit 1; }
done

# ─── 5. Configura BBR nel kernel VM e nei container ───────────────────────────
info "Abilito BBR nel kernel Colima..."
colima ssh -- bash -c "sudo modprobe tcp_bbr 2>/dev/null || true; sudo sysctl -w net.ipv4.tcp_allowed_congestion_control='reno cubic bbr' 2>/dev/null || true" \
  >/dev/null 2>&1

info "Abilito BBR nei container..."
for C in bbr-client bbr-server; do
  docker exec "$C" bash -c \
    "sysctl -w net.ipv4.tcp_allowed_congestion_control='reno cubic bbr' 2>/dev/null || true" \
    >/dev/null 2>&1
done

# ─── 6. Verifica iperf3 server ────────────────────────────────────────────────
sleep 1
if ! docker exec bbr-server pgrep -x iperf3 >/dev/null 2>&1; then
  warn "iperf3 non rilevato, lo avvio in background..."
  docker exec -d bbr-server bash -c "iperf3 -s"
  sleep 1
fi
info "iperf3 server attivo."

# ─── 7. Test BBR ───────────────────────────────────────────────────────────────
BBR_CHECK=$(docker exec bbr-client bash -c \
  "cat /proc/sys/net/ipv4/tcp_available_congestion_control" 2>/dev/null || echo "")
if echo "$BBR_CHECK" | grep -q "bbr"; then
  info "BBR disponibile: [$BBR_CHECK]"
else
  error "BBR NON disponibile nel kernel: [$BBR_CHECK]"
  error "Assicurati di usare Colima: 'colima start --vm-type vz'"
  exit 1
fi

# ─── 8. Python venv ────────────────────────────────────────────────────────────
info "Configurazione ambiente Python..."
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi
# shellcheck source=/dev/null
source .venv/bin/activate
# Skip pip se fastapi è già installato (ottimizza avvii successivi)
if ! python -c "import fastapi, uvicorn, matplotlib, pydantic" 2>/dev/null; then
  info "Installazione dipendenze Python (solo al primo avvio)..."
  pip install fastapi "uvicorn[standard]" websockets matplotlib numpy pydantic \
    -q --disable-pip-version-check
fi
info "Dipendenze Python OK."

# ─── 9. Avvia backend ──────────────────────────────────────────────────────────
# Assicurati che la porta sia libera
if lsof -ti:8000 >/dev/null 2>&1; then
  warn "Porta 8000 occupata — termino il processo precedente..."
  kill "$(lsof -ti:8000)" 2>/dev/null || true
  sleep 1
fi

info "Avvio backend su http://localhost:8000 ..."
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --log-level warning &
BACKEND_PID=$!

for i in $(seq 1 20); do
  sleep 1
  if curl -sf http://localhost:8000/api/status >/dev/null 2>&1; then
    info "Backend pronto (PID $BACKEND_PID)."
    break
  fi
  [[ $i -eq 20 ]] && { error "Backend non risponde."; kill $BACKEND_PID 2>/dev/null; exit 1; }
done

# ─── 10. Apri browser ──────────────────────────────────────────────────────────
sleep 0.5
open http://localhost:8000 2>/dev/null || true

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Demo pronta!  →  http://localhost:8000      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo "  Ctrl+C  →  ferma backend (container Docker restano attivi)"
echo "  stop.sh →  ferma tutto inclusi i container"
echo ""

_cleanup() {
  echo ""
  info "Fermo backend... container Docker restano attivi."
  kill $BACKEND_PID 2>/dev/null || true
  deactivate 2>/dev/null || true
}
trap _cleanup INT TERM

wait $BACKEND_PID
