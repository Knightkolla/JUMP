#!/bin/bash
# Start the Conduit backend server.
# Run from the conduit/backend/ directory.

set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Creating virtual environment with Python 3.11..."
  python3.11 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  echo "No .env found — copying .env.example. Edit it to add your OPENAI_API_KEY."
  cp .env.example .env
fi

echo "Starting Conduit backend on http://localhost:8765"
echo "API docs: http://localhost:8765/docs"
echo ""
.venv/bin/python3.11 main.py
