from flask import Flask, render_template

app = Flask(__name__)

# 1. Main Route
@app.route('/')
def home():
    return render_template('index.html')

# 2. Add this "Kiosk" route that ALSO loads index.html
@app.route('/kiosk')
def kiosk_view():
    return render_template('index.html') 

if __name__ == '__main__':
    app.run(debug=True, port=5000)
