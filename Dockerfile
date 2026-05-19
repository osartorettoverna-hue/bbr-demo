FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        iperf3 \
        iproute2 \
        iputils-ping \
        procps \
        coreutils \
    && rm -rf /var/lib/apt/lists/*
