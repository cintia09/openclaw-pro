FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# ── 持久化路径（/root 为 volume 挂载点，容器重建后数据保留）──
ENV VIRTUAL_ENV=/root/.venv
ENV NPM_CONFIG_PREFIX=/root/.npm-global
ENV PATH="/root/.venv/bin:/root/.npm-global/bin:$PATH"

# 系统工具
RUN apt-get update && apt-get install -y \
    vim nano \
    curl wget net-tools iputils-ping dnsutils traceroute telnet nmap openssh-client openssh-server \
    htop procps psmisc tmux screen tree less file unzip tar gzip \
    git jq python3 python3-pip python3-venv build-essential \
    sudo cron rsync ca-certificates gnupg gettext-base \
    dnsmasq \
    && rm -rf /var/lib/apt/lists/*

# SSH 默认安全策略：禁用密码登录，仅允许密钥登录（运行时脚本会再次强制校验）
RUN sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#*KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config

# sudo 保留代理环境变量（企业代理环境下 sudo apt-get 需要）
RUN echo 'Defaults env_keep += "http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY"' > /etc/sudoers.d/keep-proxy \
    && chmod 0440 /etc/sudoers.d/keep-proxy

# Node.js 22
RUN curl -fsSL --retry 3 --retry-delay 3 https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# 预装源码构建工具（避免运行时网络抖动）
RUN npm install -g pnpm@10.23.0 rolldown@1.0.0-rc.6 --no-audit --no-fund \
    && corepack disable >/dev/null 2>&1 \
    && pnpm -v >/dev/null 2>&1

# Caddy
RUN curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
    'https://github.com/caddyserver/caddy/releases/download/v2.11.1/caddy_2.11.1_linux_amd64.tar.gz' \
    -o /tmp/caddy.tar.gz \
    && tar xzf /tmp/caddy.tar.gz -C /usr/local/bin/ caddy && rm /tmp/caddy.tar.gz \
    && chmod +x /usr/local/bin/caddy

# LightGBM (交易系统推理用)
RUN pip3 install --break-system-packages lightgbm pandas numpy baostock

# 登录欢迎界面
COPY motd.sh /etc/profile.d/openclaw-motd.sh
RUN chmod +x /etc/profile.d/openclaw-motd.sh

# OpenClaw
RUN npm install -g openclaw \
    && mkdir -p /root/.openclaw/openclaw-source /root/.openclaw/openclaw /root/.openclaw/logs /root/.openclaw/cache/openclaw /root/.openclaw/locks /root/.openclaw/home \
    && OPENCLAW_NPM_ROOT="$(npm root -g)" \
    && if [ -d "$OPENCLAW_NPM_ROOT/openclaw" ]; then cp -a "$OPENCLAW_NPM_ROOT/openclaw"/. /root/.openclaw/openclaw-source/; fi \
    && ln -sfn /root/.openclaw/openclaw-source /root/.openclaw/openclaw

# Web管理面板
COPY web/ /opt/openclaw-web/
RUN cd /opt/openclaw-web && npm install --omit=dev

COPY start-services.sh /usr/local/bin/
COPY scripts/openclaw-gateway-watchdog.sh /usr/local/bin/
COPY post-install-restore.sh /opt/
COPY Caddyfile.template /etc/caddy/
RUN chmod +x /usr/local/bin/start-services.sh /usr/local/bin/openclaw-gateway-watchdog.sh /opt/post-install-restore.sh

# 写入构建时版本（由 CI 的 tag 决定）
ARG BUILD_VERSION=dev
RUN echo "$BUILD_VERSION" > /etc/openclaw-version

# 标记为完整版
RUN echo "full" > /etc/openclaw-edition

# 写入 Dockerfile hash（用于检测是否需要完整更新）
COPY Dockerfile /tmp/Dockerfile.build
RUN sha256sum /tmp/Dockerfile.build | cut -d' ' -f1 > /etc/openclaw-dockerfile-hash && rm /tmp/Dockerfile.build

WORKDIR /root
CMD ["/usr/local/bin/start-services.sh"]
