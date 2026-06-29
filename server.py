"""
Minimal proxy server — no browser, no scraping.

Run:  python3 server.py
Then: open http://localhost:5000

The API at etecnic.net restricts CORS to https://etecnic.es, so a browser
fetch from a local file or localhost is blocked by default. This tiny server
sits in the middle: it fetches the API server-side (where CORS doesn't apply)
and re-serves the data with Access-Control-Allow-Origin: * so the HTML works.
"""

from flask import Flask, jsonify, send_file
import requests

app = Flask(__name__)

API = "https://etecnic.net/api/v1/chargers/index.json"
TARGETS = {"IMESAPI - SELBA EdRSR 12", "IMESAPI - SELBA EdRSR 16"}


@app.route("/api/chargers")
def chargers():
    r = requests.get(API, headers={"Origin": "https://etecnic.es"}, timeout=10)
    r.raise_for_status()
    data = [s for s in r.json() if s["name"] in TARGETS]
    return jsonify(data), 200, {"Access-Control-Allow-Origin": "*"}


@app.route("/")
def root():
    return send_file("index.html")


if __name__ == "__main__":
    print("→  http://localhost:5000")
    app.run(port=5000)
