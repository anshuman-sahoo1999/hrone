import requests
import json
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

# --- Turso DB Configuration ---
TURSO_URL = 'https://hrone-db-anshuman-sahoo1999.aws-ap-south-1.turso.io'
TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzE4NDc4MjMsImlkIjoiZjRjZjBiODYtNDAzNS00Mzk5LWEyZWYtMDBjMzcxYjYxYjRmIiwicmlkIjoiZWZkZDNmMmItOWE5Yy00NDU2LWJhYzYtYjYyMjIxZGJhZDBjIn0.leq6G0-Ku5bMsIROT015KdLvhR5gbjwdwz6lade401mlxfMIDWEvYuCB_mH4zNIUge_3xA-g0CkpoJ4tdmKXCQ'

def to_turso_value(val):
    if val is None:
        return {"type": "null"}
    if isinstance(val, (list, dict)):
        return {"type": "text", "value": json.dumps(val)}
    if isinstance(val, bool):
        return {"type": "integer", "value": "1" if val else "0"}
    if isinstance(val, int):
        return {"type": "integer", "value": str(val)}
    if isinstance(val, float):
        return {"type": "float", "value": val}
    return {"type": "text", "value": str(val)}

@app.route('/db', methods=['POST'])
def proxy_db():
    try:
        data = request.json
        sql = data.get('sql')
        args = data.get('args', [])

        # Format arguments for Turso v2 (must be typed objects)
        turso_args = [to_turso_value(a) for a in args]

        # Using /v2/pipeline which is supported on AWS
        payload = {
            "requests": [
                { "type": "execute", "stmt": { "sql": sql, "args": turso_args } },
                { "type": "close" }
            ]
        }

        response = requests.post(
            f"{TURSO_URL}/v2/pipeline",
            headers={
                "Authorization": f"Bearer {TURSO_TOKEN}",
                "Content-Type": "application/json"
            },
            json=payload
        )
        
        result = response.json()
        
        # Extract the specialized result from the first 'execute' request
        if "results" in result and len(result["results"]) > 0:
            exec_result = result["results"][0]
            if exec_result.get("type") == "error":
                return jsonify({"error": exec_result["error"]["message"]}), 400
            
            # Extract cols and rows from the response result
            return jsonify(exec_result["response"]["result"]), 200
        
        return jsonify(result), response.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# 1. Main Route
@app.route('/')
def home():
    return render_template('index.html')

# 2. Add this "Kiosk" route that ALSO loads index.html
@app.route('/kiosk')
def kiosk_view():
    return render_template('index.html') 

@app.route('/public-scan')
def public_kiosk():
    # This renders a simplified page specifically for mobile/public use
    return render_template('kiosk_public.html')


if __name__ == '__main__':
    app.run(debug=True, port=5000)

