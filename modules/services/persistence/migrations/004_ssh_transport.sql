-- How a machine profile is reached: "ssh" or "wsl" (host is then a WSL distribution).
ALTER TABLE ssh_profiles ADD COLUMN transport TEXT NOT NULL DEFAULT 'ssh';
