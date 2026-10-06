import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.parse

class EchoHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass
        
    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/target')
            self.end_headers()
            return
            
        if self.path == '/403-html':
            self.send_response(403)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html><body>Forbidden</body></html>')
            return
            
        if self.path == '/403-json':
            self.send_response(403)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "forbidden"}')
            return
            
        if self.path == '/429':
            self.send_response(429)
            self.send_header('Retry-After', '5')
            self.end_headers()
            return
            
        if self.path == '/empty':
            self.send_response(200)
            self.end_headers()
            return
            
        if self.path == '/malformed':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"incomplete": ')
            return

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        
        headers_dict = dict(self.headers)
        response = {
            "method": "GET",
            "path": self.path,
            "headers": headers_dict
        }
        self.end_headers()
        self.wfile.write(json.dumps(response).encode('utf-8'))

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        
        response = {
            "method": "POST",
            "path": self.path,
            "headers": dict(self.headers),
            "body": body.decode('utf-8') if body else ""
        }
        self.wfile.write(json.dumps(response).encode('utf-8'))

def run(port=8080):
    server = HTTPServer(('127.0.0.1', port), EchoHandler)
    server.serve_forever()

if __name__ == '__main__':
    run()
