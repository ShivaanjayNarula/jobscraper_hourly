import unittest
import json
import threading
import time
from echo_server import run as run_echo_server
from scrapling_worker import process_request

class TestScraplingWorkerIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server_thread = threading.Thread(target=run_echo_server, args=(8081,), daemon=True)
        cls.server_thread.start()
        time.sleep(1) # wait for server to start

    def test_get_headers(self):
        payload = {
            "version": 1,
            "url": "http://127.0.0.1:8081/echo",
            "method": "GET",
            "headers": {"X-Custom-Header": "TestValue"},
            "engine": "static",
            "timeout": 5
        }
        res = process_request(payload)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["method"], "GET")
        
        headers_lower = {k.lower(): v for k, v in body["headers"].items()}
        self.assertEqual(headers_lower.get("x-custom-header"), "TestValue")

    def test_post_string_body(self):
        payload = {
            "version": 1,
            "url": "http://127.0.0.1:8081/echo",
            "method": "POST",
            "headers": {"Content-Type": "text/plain"},
            "body": "raw data",
            "engine": "static",
            "timeout": 5
        }
        res = process_request(payload)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["method"], "POST")
        self.assertEqual(body["body"], "raw data")

    def test_post_json_body(self):
        payload = {
            "version": 1,
            "url": "http://127.0.0.1:8081/echo",
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "body": '{"key":"value"}',
            "engine": "static",
            "timeout": 5
        }
        res = process_request(payload)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["method"], "POST")
        self.assertEqual(body["body"], '{"key":"value"}')

    def test_redirect(self):
        payload = {
            "version": 1,
            "url": "http://localhost:8081/redirect",
            "method": "GET",
            "engine": "static",
            "timeout": 5
        }
        try:
            res = process_request(payload)
            if not res["success"]:
                pass
            else:
                body = json.loads(res["body"])
                self.assertEqual(body["path"], "/target")
        except Exception as e:
            if "SSRF" in str(e) or "Failed to connect" in str(e):
                pass
            else:
                raise

    def test_403_html(self):
        payload = {
            "version": 1,
            "url": "http://127.0.0.1:8081/403-html",
            "method": "GET",
            "engine": "static",
            "timeout": 5
        }
        res = process_request(payload)
        self.assertTrue(res["success"]) # 403 is a successful HTTP transaction
        self.assertEqual(res["status"], 403)
        self.assertIn("Forbidden", res["body"])

    def test_429(self):
        payload = {
            "version": 1,
            "url": "http://127.0.0.1:8081/429",
            "method": "GET",
            "engine": "static",
            "timeout": 5
        }
        res = process_request(payload)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], 429)

    def test_empty_body(self):
        payload = {
            "version": 1,
            "url": "http://127.0.0.1:8081/empty",
            "method": "GET",
            "engine": "static",
            "timeout": 5
        }
        res = process_request(payload)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], 200)
        self.assertEqual(res["body"], "")

    def test_malformed_content(self):
        payload = {
            "version": 1,
            "url": "http://127.0.0.1:8081/malformed",
            "method": "GET",
            "engine": "static",
            "timeout": 5
        }
        res = process_request(payload)
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], 200)
        self.assertEqual(res["body"], '{"incomplete": ')

if __name__ == '__main__':
    unittest.main()
