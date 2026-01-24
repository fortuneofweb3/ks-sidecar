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

# 4. Initialize Database
echo "🗄️ Initializing local database..."
npm run dev -- init

echo ""
echo "✅ Setup complete!"
echo "----------------"
echo "Next steps:"
echo "1. Edit .env with your keys"
echo "2. Place your operator keypair JSON at ./operator-keypair.json"
echo "3. Run 'npm run dev -- start' to begin monitoring"
