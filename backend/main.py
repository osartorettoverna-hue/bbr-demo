import asyncio
import json
import re
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SERVER_IP = "172.28.0.10"
SERVER_CONTAINER = "bbr-server"
CLIENT_CONTAINER = "bbr-client"

RESULTS_DIR = Path(__file__).parent.parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="BBR Demo API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Shared state (single-user demo — no DB needed)
# ---------------------------------------------------------------------------
current_scenario: dict = {"delay_ms": None, "loss_pct": None, "bandwidth_mbps": None, "applied": False}
all_results: list[dict] = []
test_running: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _run(cmd: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _container_running(name: str) -> bool:
    r = _run(["docker", "inspect", "--format", "{{.State.Running}}", name])
    return r.stdout.strip() == "true"


def _to_mbps(value: float, unit: str) -> float:
    unit = unit.upper()
    if unit in ("K", "KBITS", "KBIT"):
        return value / 1000
    if unit in ("M", "MBITS", "MBIT"):
        return value
    if unit in ("G", "GBITS", "GBIT"):
        return value * 1000
    return value / 1000  # assume kbits as default


# Matches per-second interval lines from iperf3 text output.
# Note: zero-throughput intervals print "0.00 Bytes" (no unit prefix) — use \w*Bytes not \w+Bytes.
# Example: [  5]   1.00-2.00   sec  9.22 MBytes  77.3 Mbits/sec    0   1.00 MBytes
# Example: [  5]   2.00-3.00   sec  0.00 Bytes   0.00 Kbits/sec    4   22.6 KBytes
_IPERF_RE = re.compile(
    r"\[\s*\d+\]\s+"
    r"(\d+\.\d+)-(\d+\.\d+)\s+sec\s+"
    r"[\d.]+\s+\w*Bytes\s+"
    r"([\d.]+)\s+(K|M|G)?bits/sec"
)

_PING_RE = re.compile(rb'time=([\d.]+)')


def _parse_iperf_line(line: str) -> Optional[dict]:
    """Return {t_start, t_end, mbps} if line is a per-second interval, else None."""
    m = _IPERF_RE.search(line)
    if not m:
        return None
    t_start = float(m.group(1))
    t_end = float(m.group(2))
    if (t_end - t_start) > 1.5:
        return None  # summary line
    value = float(m.group(3))
    unit = m.group(4) or "K"
    return {"t_start": t_start, "t_end": t_end, "mbps": round(_to_mbps(value, unit), 2)}


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.get("/api/status")
async def get_status():
    try:
        server_ok = _container_running(SERVER_CONTAINER)
        client_ok = _container_running(CLIENT_CONTAINER)
        return {
            "docker": "ok",
            "server": server_ok,
            "client": client_ok,
            "scenario": current_scenario,
            "test_running": test_running,
        }
    except Exception as exc:
        return {"docker": "error", "error": str(exc), "scenario": current_scenario}


class ScenarioRequest(BaseModel):
    delay_ms: float = Field(ge=0, le=500)
    loss_pct: float = Field(ge=0, le=10)
    bandwidth_mbps: Optional[float] = Field(default=None, ge=1, le=1000)


@app.post("/api/scenario")
async def apply_scenario(req: ScenarioRequest):
    half_ms = req.delay_ms / 2
    loss = req.loss_pct
    bw = req.bandwidth_mbps  # None = unlimited

    def _netem(container: str, delay: float, apply_loss: bool) -> str:
        loss_part = f" loss {loss:.2f}%" if apply_loss else ""
        rate_part = f" rate {bw:.0f}mbit" if bw and bw < 1000 else ""
        return (
            f"tc qdisc del dev eth0 root 2>/dev/null || true; "
            f"tc qdisc add dev eth0 root netem delay {delay:.1f}ms{loss_part}{rate_part}"
        )

    try:
        for container, cmd in [
            (CLIENT_CONTAINER, _netem(CLIENT_CONTAINER, half_ms, True)),
            (SERVER_CONTAINER, _netem(SERVER_CONTAINER, half_ms, False)),
        ]:
            r = _run(["docker", "exec", container, "bash", "-c", cmd])
            if r.returncode != 0:
                raise HTTPException(400, f"netem error on {container}: {r.stderr.strip()}")

        current_scenario["delay_ms"] = req.delay_ms
        current_scenario["loss_pct"] = req.loss_pct
        current_scenario["bandwidth_mbps"] = bw
        current_scenario["applied"] = True
        return {"ok": True, "scenario": current_scenario}

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/results")
async def get_results():
    return all_results


@app.post("/api/reset")
async def reset_all():
    global test_running
    try:
        for container in [CLIENT_CONTAINER, SERVER_CONTAINER]:
            _run(
                ["docker", "exec", container, "bash", "-c",
                 "tc qdisc del dev eth0 root 2>/dev/null || true"],
            )
        # Restart iperf3 server
        _run(
            ["docker", "exec", SERVER_CONTAINER, "bash", "-c",
             "pkill -f iperf3 2>/dev/null; sleep 0.3; iperf3 -s -D"],
        )
        current_scenario["applied"] = False
        current_scenario["delay_ms"] = None
        current_scenario["loss_pct"] = None
        test_running = False
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/export-chart")
async def export_chart(mode: str = Query("all")):
    """Generate a high-res PNG line chart via matplotlib.
    One subplot per scenario, each showing throughput-over-time for CUBIC and BBR.
    """
    if not all_results:
        raise HTTPException(404, "Nessun risultato disponibile")

    colors = {"cubic": "#E85D04", "bbr": "#0077B6"}

    # Group by scenario, keep latest result per algo
    groups: dict = {}
    for r in all_results:
        key = (r["scenario"]["delay_ms"], r["scenario"]["loss_pct"])
        if key not in groups:
            groups[key] = {"cubic": None, "bbr": None}
        groups[key][r["algorithm"]] = r

    scenarios = sorted(groups.keys())
    n = len(scenarios)
    ncols = min(n, 2)
    nrows = (n + ncols - 1) // ncols

    fig, axes = plt.subplots(nrows, ncols,
                             figsize=(ncols * 7, nrows * 4),
                             dpi=200, squeeze=False)
    fig.patch.set_facecolor("#FFFFFF")

    for i, key in enumerate(scenarios):
        row, col = divmod(i, ncols)
        ax = axes[row][col]
        ax.set_facecolor("#F8FAFC")

        delay, loss = key
        ax.set_title(f"{delay:.0f} ms RTT  —  {loss:.1f}% loss", fontsize=12, fontweight="bold")
        ax.set_xlabel("Tempo (s)", fontsize=10)
        ax.set_ylabel("Throughput (Mbps)", fontsize=10)
        ax.grid(alpha=0.35, linestyle="--", zorder=0)
        ax.yaxis.set_major_formatter(mticker.FormatStrFormatter("%.0f"))

        ax2 = ax.twinx()
        ax2.set_ylabel("RTT (ms)", fontsize=9, color="#888")
        ax2.tick_params(axis="y", labelcolor="#888", labelsize=8)
        has_rtt = False
        cubic_drops = []

        for algo in ("cubic", "bbr"):
            r = groups[key][algo]
            if r is None:
                continue
            ts = r.get("times", [])
            tps = r.get("throughputs", [])
            if not ts or not tps:
                continue
            label = f"{algo.upper()}  (avg {r['avg_mbps']:.1f} Mbps)"
            ax.plot(ts, tps, color=colors[algo], linewidth=2.5,
                    label=label, alpha=0.9, zorder=3)

            if algo == "cubic":
                for j in range(1, len(tps)):
                    if tps[j - 1] > 1 and tps[j] < tps[j - 1] * 0.72:
                        cubic_drops.append(ts[j])

            rtt_pairs = [(t, v) for t, v in zip(ts, r.get("rtts", [])) if v is not None]
            if rtt_pairs:
                rtt_ts, rtt_vals = zip(*rtt_pairs)
                ax2.plot(rtt_ts, rtt_vals, color=colors[algo], linewidth=1.2,
                         linestyle="--", alpha=0.55, zorder=2)
                has_rtt = True

        # set_ylim AFTER plotting so matplotlib auto-scales from data
        ax.set_ylim(bottom=0)
        ax2.set_ylim(bottom=0)

        ymax = ax.get_ylim()[1]
        for drop_t in cubic_drops:
            ax.axvline(x=drop_t, color=colors["cubic"], linewidth=1,
                       linestyle=":", alpha=0.6, zorder=4)
            ax.text(drop_t, ymax * 0.97, "↓cwnd", ha="center", va="top",
                    color=colors["cubic"], fontsize=7, fontweight="bold", alpha=0.8)

        if not has_rtt:
            ax2.set_visible(False)

        ax.legend(fontsize=9)

    # Hide unused subplots
    for j in range(n, nrows * ncols):
        row, col = divmod(j, ncols)
        axes[row][col].set_visible(False)

    fig.suptitle("TCP CUBIC vs BBR — Throughput nel tempo",
                 fontsize=15, fontweight="bold", y=1.01)
    plt.tight_layout()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = RESULTS_DIR / f"chart_summary_{ts}.png"
    plt.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)

    return FileResponse(
        str(out_path),
        media_type="image/png",
        filename=out_path.name,
        headers={"Content-Disposition": f'inline; filename="{out_path.name}"'},
    )


# ---------------------------------------------------------------------------
# WebSocket — streaming iperf3 test
# ---------------------------------------------------------------------------
@app.websocket("/ws/test")
async def websocket_test(ws: WebSocket):
    global test_running
    await ws.accept()

    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
        params = json.loads(raw)
    except Exception:
        await ws.send_json({"type": "error", "message": "Parametri non validi"})
        await ws.close()
        return

    algorithm = params.get("algorithm", "cubic")
    duration = int(params.get("duration", 30))

    if algorithm not in ("cubic", "bbr"):
        await ws.send_json({"type": "error", "message": f"Algoritmo sconosciuto: {algorithm}"})
        await ws.close()
        return

    if test_running:
        await ws.send_json({"type": "error", "message": "Un test è già in esecuzione"})
        await ws.close()
        return

    if not current_scenario.get("applied"):
        await ws.send_json({"type": "error", "message": "Applica uno scenario prima di avviare il test"})
        await ws.close()
        return

    test_running = True
    throughputs: list[float] = []
    times: list[float] = []
    rtts: list[Optional[float]] = []

    try:
        # Allow BBR for unprivileged sockets (idempotent)
        _run([
            "docker", "exec", CLIENT_CONTAINER, "bash", "-c",
            "sysctl -w net.ipv4.tcp_allowed_congestion_control='reno cubic bbr' 2>/dev/null || true",
        ])

        iperf_cmd = (
            f"stdbuf -oL iperf3 -c {SERVER_IP} -C {algorithm} "
            f"-t {duration} -i 1 -f k"
        )
        ping_cmd = f"ping -i 1 -c {duration + 2} -W 1 {SERVER_IP}"

        await ws.send_json({"type": "starting", "algorithm": algorithm, "duration": duration})

        proc = await asyncio.create_subprocess_exec(
            "docker", "exec", CLIENT_CONTAINER, "bash", "-c", iperf_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        ping_proc = await asyncio.create_subprocess_exec(
            "docker", "exec", CLIENT_CONTAINER, "bash", "-c", ping_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )

        rtt_queue: asyncio.Queue = asyncio.Queue()

        async def _read_ping():
            async for raw in ping_proc.stdout:
                m = _PING_RE.search(raw)
                if m:
                    await rtt_queue.put(float(m.group(1)))

        ping_task = asyncio.create_task(_read_ping())

        async for line_bytes in proc.stdout:
            line = line_bytes.decode("utf-8", errors="replace").strip()
            parsed = _parse_iperf_line(line)
            if parsed:
                rtt_ms = None
                try:
                    rtt_ms = rtt_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                throughputs.append(parsed["mbps"])
                times.append(parsed["t_end"])
                rtts.append(rtt_ms)
                try:
                    await ws.send_json({
                        "type": "interval",
                        "t": parsed["t_end"],
                        "mbps": parsed["mbps"],
                        "rtt_ms": rtt_ms,
                        "elapsed": len(throughputs),
                        "total": duration,
                    })
                except Exception:
                    break  # client disconnected

        await proc.wait()
        ping_task.cancel()
        try:
            ping_proc.terminate()
        except Exception:
            pass

        if not throughputs:
            stderr_bytes = await proc.stderr.read()
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
            await ws.send_json({
                "type": "error",
                "message": f"iperf3 non ha prodotto dati. Stderr: {stderr_text[:300]}",
            })
            return

        avg_mbps = round(sum(throughputs) / len(throughputs), 2)
        max_mbps = round(max(throughputs), 2)

        # Warn if ratio looks suspicious
        if current_scenario["loss_pct"] > 1:
            companion_algo = "bbr" if algorithm == "cubic" else "cubic"
            companions = [
                r for r in all_results
                if (
                    r["algorithm"] == companion_algo
                    and r["scenario"]["delay_ms"] == current_scenario["delay_ms"]
                    and r["scenario"]["loss_pct"] == current_scenario["loss_pct"]
                )
            ]
            if companions:
                comp_avg = companions[-1]["avg_mbps"]
                if algorithm == "cubic":
                    ratio = comp_avg / avg_mbps if avg_mbps > 0 else 0
                else:
                    ratio = avg_mbps / comp_avg if comp_avg > 0 else 0
                if ratio < 2:
                    print(
                        f"[WARN] BBR/CUBIC ratio={ratio:.2f} < 2x con loss={current_scenario['loss_pct']}% "
                        "— verifica netem"
                    )

        result = {
            "id": str(uuid.uuid4()),
            "algorithm": algorithm,
            "scenario": dict(current_scenario),
            "avg_mbps": avg_mbps,
            "max_mbps": max_mbps,
            "throughputs": throughputs,
            "times": times,
            "rtts": rtts,
            "timestamp": datetime.now().isoformat(),
        }
        all_results.append(result)

        # Persist result
        delay = current_scenario["delay_ms"]
        loss = current_scenario["loss_pct"]
        fname = f"{algorithm}_{delay:.0f}ms_{loss:.1f}pct.json"
        (RESULTS_DIR / fname).write_text(json.dumps(result, indent=2))

        await ws.send_json({"type": "done", "result": result})

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        test_running = False


# ---------------------------------------------------------------------------
# Serve frontend (must be last so API routes take priority)
# ---------------------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
