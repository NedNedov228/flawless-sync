import paramiko
import sys
import io

IP = "31.56.185.103"
USER = "root"
PASSWORD = "YoT43pe8TaKM"

CADDYFILE = b"""
http://31.56.185.103 {
    header -Server
    header -X-Powered-By

    request_body {
        max_size 50MB
    }

    @s3_traffic {
        header X-Vault-Auth "DTxLnemQ6ZFEyM0eCTscsHxgbH0Szd51"
    }
    
    handle @s3_traffic {
        reverse_proxy 127.0.0.1:9000
    }
    
    handle {
        root * /var/www/fake-site
        file_server
    }
}
"""

def update_caddy():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(IP, username=USER, password=PASSWORD, timeout=10)
        
        sftp = ssh.open_sftp()
        with sftp.file('/etc/caddy/Caddyfile', 'wb') as f:
            f.write(CADDYFILE)
        sftp.close()
        
        stdin, stdout, stderr = ssh.exec_command("systemctl restart caddy")
        stdout.read()
        print("Caddy updated successfully to use IP address.")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        ssh.close()

if __name__ == "__main__":
    update_caddy()
