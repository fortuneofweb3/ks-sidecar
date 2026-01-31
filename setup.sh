#!/bin/bash

echo "🚀 KoraScan Sidecar Setup"
echo "========================="

# 1. Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install it first."
    exit 1
fi

# 2. Install dependencies
echo "📦 Installing dependencies..."
npm install

# 3. Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "📄 Creating .env file..."
    cp .env.example .env
    echo "⚠️  Please edit .env and add your HELIUS_API_KEY and RPC_URL."
fi

# 4. Initialize Multi-Wallet Config
if [ ! -f operators.json ]; then
    echo "📋 Creating operators.json template..."
    echo '{ "operators": [] }' > operators.json
fi

# 5. Initialize Database
echo "🗄️ Initializing local database..."
npm run dev -- init

echo ""
echo "✅ Setup complete!"
echo "----------------"
echo "Next steps:"
echo "1. Edit .env with your RPC & keys"
echo "2. SINGLE WALLET: Place keypair at ./operator-keypair.json"
echo "3. MULTI WALLET:  Add keypair paths to operators.json"
echo "4. Run 'npm run dev -- start' to begin monitoring"
