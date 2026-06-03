touch .env
echo "CMC_API_KEY=" > .env
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
echo "Install Complete! "
