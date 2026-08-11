#!/usr/bin/env bash
# Install the command center on the server. Idempotent: run it again after a
# deploy to pick up new dependencies.
#
#   ./ops/cc/install.sh          venv + /usr/local/bin/cc
#   ./ops/cc/install.sh /srv/x   same, against a checkout somewhere else
#
# Deliberately not a systemd unit. This is a program you run when you want to
# look at something, not a service -- a dashboard nobody is watching is just a
# process holding a subprocess open.
set -euo pipefail

REPO=${1:-/opt/osint}
VENV="$REPO/ops/cc/.venv"

python -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REPO/ops/cc/requirements.txt"

sudo tee /usr/local/bin/cc >/dev/null <<EOF
#!/usr/bin/env bash
# The command center. Runs from the repo so 'docker compose' finds the project.
cd "$REPO"
exec "$VENV/bin/python" -m ops.cc "\$@"
EOF
sudo chmod +x /usr/local/bin/cc

echo "Installed. Run: cc"
echo
if ! groups | grep -qw docker; then
  echo "Note: $USER is not in the docker group, so every collector will fail with"
  echo "      'permission denied on /var/run/docker.sock'. Fix with:"
  echo "        sudo usermod -aG docker $USER   # then log out and back in"
fi
