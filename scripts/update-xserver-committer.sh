#!/usr/bin/env bash
set -euo pipefail
clear

MODEL="xVSGravityTools:committer-4b"
BASE_MODEL="qwen3.5:4b-q4_K_M"
OLLAMA_URL="${OLLAMA_HOST:-http://127.0.0.1:11434}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

export OLLAMA_HOST="$OLLAMA_URL"

echo "========== VERIFY BASE MODEL =========="
if ! ollama show "$BASE_MODEL" >/dev/null 2>&1; then
  echo "Base model $BASE_MODEL is not installed."
  echo "Pulling it now..."
  ollama pull "$BASE_MODEL"
fi

echo
echo "========== BUILD FAST 4B COMMITTER PROFILE =========="
cat > "$WORK_DIR/Modelfile" <<'MODELFILE'
FROM qwen3.5:4b-q4_K_M
PARAMETER num_ctx 2048
PARAMETER num_predict 40
PARAMETER num_thread 5
PARAMETER temperature 0
PARAMETER top_k 20
PARAMETER top_p 0.85
PARAMETER repeat_penalty 1.05
MODELFILE

ollama create "$MODEL" -f "$WORK_DIR/Modelfile"

echo
echo "========== VERIFY MODEL SETTINGS =========="
ollama show "$MODEL" --parameters
echo
echo "========== COMPLETE =========="
echo "Smart Commit will send think=false and its own per-request limits."
