# TCP BBR vs CUBIC — Demo Telecomunicazioni

Demo interattiva per progetto universitario. Confronta throughput TCP CUBIC (loss-based) e TCP BBR (model-based) su rete con latenza e packet loss simulati via `netem`.

## Requisiti

- macOS con Docker Desktop **o** Colima (raccomandato su Apple Silicon per BBR)
- Python 3.11+

## Avvio (un solo comando)

```bash
./start.sh
```

La pagina si apre automaticamente su **http://localhost:8000**

## Stop

```bash
./stop.sh        # ferma backend + container
# oppure Ctrl+C  # ferma solo il backend, container restano attivi
```

## Uso rapido

1. **Sezione 1** — imposta RTT e loss con gli slider → "Applica scenario"
2. **Sezione 2** — avvia il test CUBIC (30s), poi BBR (30s)
3. **Sezione 3** — guarda le curve crescere in tempo reale
4. **Sezione 4** — confronta nella tabella, esporta il grafico per le slide

## Scenari consigliati per la demo

| RTT   | Loss | Effetto atteso                        |
|-------|------|---------------------------------------|
| 0 ms  | 0%   | Baseline — performance simili         |
| 50 ms | 1%   | BBR ~2-3× superiore                   |
| 50 ms | 5%   | BBR domina nettamente (4-10×)         |
| 100 ms| 2%   | RTT alto + loss: CUBIC collassa       |

## Troubleshooting

| Sintomo | Soluzione |
|---------|-----------|
| Docker non running | `colima start --vm-type vz` |
| BBR non disponibile | Verifica Colima: `docker exec bbr-client cat /proc/sys/net/ipv4/tcp_available_congestion_control` |
| Backend non risponde | Porta 8000 occupata? `lsof -i:8000` |
| iperf3 non produce dati | `docker exec bbr-server pgrep iperf3` — se vuoto, reset dalla UI |

## Architettura

```
Host macOS
├── backend/main.py   (FastAPI + WebSocket, porta 8000)
└── Docker (Colima)
    ├── bbr-server  172.28.0.10  (iperf3 -s)
    └── bbr-client  172.28.0.20  (iperf3 client + netem)
```
