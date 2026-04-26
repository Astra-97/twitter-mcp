#!/bin/bash
set -e

echo "🐦 Twitter MCP Setup"
echo "===================="

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install Node.js 20+ first."
  echo "   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "   nvm install 20"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "❌ Node.js 20+ required (found v$(node -v))"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# Install deps
echo "📦 Installing dependencies..."
npm install

# Setup .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "⚠️  Edit .env with your Twitter API credentials:"
  echo "   nano .env"
  echo ""
  echo "   Get your keys at https://developer.x.com"
  echo "   1. Create an App → App permissions: Read and write"
  echo "   2. Type of App: Web App, Automated App or Bot"
  echo "   3. Keys and Tokens → copy Consumer Key + Secret"
  echo "   4. Generate Access Token + Secret (OAuth 1.0a)"
  echo "   5. Charge credits at Developer Portal (\$5 min)"
  echo ""
else
  echo "✅ .env already exists"
fi

# Offer systemd install
echo ""
read -p "Install as systemd service? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  SERVICE_FILE=/etc/systemd/system/twitter-mcp.service
  WORK_DIR=$(pwd)
  USER=$(whoami)

  cat > /tmp/twitter-mcp.service << EOF
[Unit]
Description=Twitter MCP Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$WORK_DIR
ExecStart=$WORK_DIR/start.sh
Restart=always
RestartSec=5
EnvironmentFile=$WORK_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

  # Create start.sh
  cat > start.sh << 'SH'
#!/bin/bash
cd "$(dirname "$0")"
set -a
source .env
set +a
exec node server.js
SH
  chmod +x start.sh

  sudo cp /tmp/twitter-mcp.service "$SERVICE_FILE"
  sudo systemctl daemon-reload
  sudo systemctl enable twitter-mcp
  echo "✅ Service installed. Start with: sudo systemctl start twitter-mcp"
else
  # Create start.sh anyway
  cat > start.sh << 'SH'
#!/bin/bash
cd "$(dirname "$0")"
set -a
source .env
set +a
exec node server.js
SH
  chmod +x start.sh
  echo "✅ Start manually with: ./start.sh"
fi

echo ""
echo "🎉 Setup complete!"
echo "   Health check: curl http://localhost:9533/health"
echo "   MCP endpoint: http://localhost:9533/mcp"
