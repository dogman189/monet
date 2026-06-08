touch .env
echo "CMC_API_KEY=" > .env
# Detect python command
PYTHON_CMD="python3"
if ! command -v python3 &> /dev/null; then
    PYTHON_CMD="python"
fi

$PYTHON_CMD -m venv venv
source venv/bin/activate
pip install -r requirements.txt
echo "Install Complete! "
