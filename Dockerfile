FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# 系统工具
RUN apt-get update && apt-get install -y \
    vim nano \
    curl wget net-tools iputils-ping dnsutils traceroute telnet nmap openssh-client openssh-server \
    htop procps tmux screen tree less file unzip tar gzip \
    git jq python3 python3-pip python3-venv \
    sudo cron rsync ca-certificates gnupg gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL --retry 3 --retry-delay 3 https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# Caddy
RUN curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
    'https://github.com/caddyserver/caddy/releases/download/v2.11.1/caddy_2.11.1_linux_amd64.tar.gz' \
    -o /tmp/caddy.tar.gz \
    && tar xzf /tmp/caddy.tar.gz -C /usr/local/bin/ caddy && rm /tmp/caddy.tar.gz \
    && chmod +x /usr/local/bin/caddy

# 浏览器服务（noVNC远程访问）
RUN apt-get update && apt-get install -y \
    xvfb x11vnc novnc websockify supervisor \
    fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Chromium（Ubuntu 24.04 Docker环境）
RUN wget -q --tries=3 --retry-connrefused https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && (dpkg -i google-chrome-stable_current_amd64.deb || apt-get -f install -y) \
    && rm -f google-chrome-stable_current_amd64.deb \
    && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99

# LightGBM (交易系统推理用)
RUN pip3 install --break-system-packages lightgbm pandas numpy baostock

# 登录欢迎界面
COPY motd.sh /etc/profile.d/openclaw-motd.sh
RUN chmod +x /etc/profile.d/openclaw-motd.sh

# OpenClaw
RUN npm install -g openclaw

# Web管理面板
COPY web/ /opt/openclaw-web/
RUN cd /opt/openclaw-web && npm install --omit=dev

COPY start-services.sh /usr/local/bin/
COPY Caddyfile.template /etc/caddy/
RUN chmod +x /usr/local/bin/start-services.sh

WORKDIR /root
CMD ["/usr/local/bin/start-services.sh"]
