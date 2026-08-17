#!/bin/bash
set -e

# ==============================================================================
# Flawless Sync - Bulletproof Server Setup Script (Ubuntu 22.04)
# Domain: vm18027.akenai.host
# ==============================================================================

# 1. Update and install dependencies
echo "[1/7] Updating system and installing dependencies..."
apt-get update
apt-get upgrade -y
apt-get install -y docker.io docker-compose ufw fail2ban curl

# 2. Install Caddy (Stealth Proxy)
echo "[2/7] Installing Caddy..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg || true
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# 3. Sysctl Hardening (DDoS Protection)
echo "[3/7] Applying Kernel Hardening..."
cat <<EOF > /etc/sysctl.d/99-flawless-sync.conf
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.icmp_echo_ignore_broadcasts = 1
EOF
sysctl -p /etc/sysctl.d/99-flawless-sync.conf

# 4. Firewall (UFW) Configuration
echo "[4/7] Configuring UFW Firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 5. MinIO Setup
echo "[5/7] Deploying MinIO..."
mkdir -p /opt/obsidian-sync/data
cd /opt/obsidian-sync

# Generate secure random credentials
MINIO_USER=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 16 | head -n 1)
MINIO_PASS=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
STEALTH_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)

cat <<EOF > docker-compose.yml
version: '3'
services:
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    restart: always
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"
    volumes:
      - ./data:/data
    environment:
      MINIO_ROOT_USER: "$MINIO_USER"
      MINIO_ROOT_PASSWORD: "$MINIO_PASS"
EOF

docker-compose up -d

# 6. Dummy Site Setup
echo "[6/7] Setting up Dummy Site..."
mkdir -p /var/www/fake-site
cat <<EOF > /var/www/fake-site/index.html
<!DOCTYPE html>
<html>
<head><title>Under Maintenance</title></head>
<body>
    <h1>Site is currently under maintenance.</h1>
    <p>Please check back later.</p>
</body>
</html>
EOF

# 7. Caddy Configuration
echo "[7/7] Configuring Caddy Stealth Proxy..."
cat <<EOF > /etc/caddy/Caddyfile
vm18027.akenai.host {
    header -Server
    header -X-Powered-By

    request_body {
        max_size 50MB
    }

    @s3_traffic {
        header X-Vault-Auth "$STEALTH_TOKEN"
    }
    
    handle @s3_traffic {
        reverse_proxy 127.0.0.1:9000
    }
    
    handle {
        root * /var/www/fake-site
        file_server
    }
}
EOF

systemctl restart caddy

echo ""
echo "================================================================="
echo "✅ SERVER DEPLOYMENT COMPLETE!"
echo "================================================================="
echo "Please save the following credentials for your Obsidian Plugin:"
echo ""
echo "Bucket:             obsidian-vault (Create this manually later)"
echo "Region:             us-east-1"
echo "Endpoint:           https://vm18027.akenai.host"
echo "Access Key ID:      $MINIO_USER"
echo "Secret Access Key:  $MINIO_PASS"
echo "Stealth Token:      $STEALTH_TOKEN"
echo "================================================================="
echo "IMPORTANT: Port 9001 (MinIO Console) is intentionally blocked by UFW."
echo "To create your bucket, you must use SSH port forwarding to access it:"
echo "ssh -L 9001:127.0.0.1:9001 root@31.56.185.103"
echo "Then open http://127.0.0.1:9001 in your local browser."
echo "================================================================="
