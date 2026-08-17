import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8')
import os

IP = "31.56.185.103"
USER = "root"
PASSWORD = "YoT43pe8TaKM"
SCRIPT_PATH = "scripts/setup_vps.sh"
REMOTE_PATH = "/root/setup_vps.sh"

def deploy():
    print(f"Connecting to {IP}...")
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        ssh.connect(IP, username=USER, password=PASSWORD, timeout=10)
        print("Connected successfully!")
        
        print(f"Uploading {SCRIPT_PATH} to {REMOTE_PATH}...")
        sftp = ssh.open_sftp()
        sftp.put(SCRIPT_PATH, REMOTE_PATH)
        sftp.close()
        
        print("Executing script on the server. This may take a few minutes (installing Docker, Caddy, etc.)...")
        
        stdin, stdout, stderr = ssh.exec_command(f"chmod +x {REMOTE_PATH} && bash {REMOTE_PATH}")
        
        # Stream the output
        for line in iter(stdout.readline, ""):
            print(line, end="")
            
        err = stderr.read().decode()
        if err:
            print("Errors/Warnings:")
            print(err)
            
        exit_status = stdout.channel.recv_exit_status()
        print(f"Script finished with exit status: {exit_status}")
        
    except Exception as e:
        print(f"Failed: {e}")
        sys.exit(1)
    finally:
        ssh.close()

if __name__ == "__main__":
    deploy()
