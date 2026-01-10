from flask import Flask, render_template

app = Flask(__name__)

# Route to serve the Single Page Application
@app.route('/')
def home():
    return render_template('index.html')

if __name__ == '__main__':
    # Running on port 5000
    app.run(debug=True, port=5000)