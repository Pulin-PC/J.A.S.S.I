#!/usr/bin/env python3
"""A throwaway stand-in for the J.A.S.S.I server, for testing the iPhone shell only.

  /                    the bridge check page
  /auth/google/start   pretends sign-in worked: sends the browser to jassi://auth?code=test
  /frame               the check page again, to load inside a frame

Run:  python3 apps/ios/dev/stub_server.py        (listens on http://localhost:8899)
"""
import http.server
import pathlib
import sys

PAGE = pathlib.Path(__file__).with_name("bridge-check.html")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899


class Stub(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/auth/google/start":
            self.send_response(302)
            self.send_header("Location", "jassi://auth?code=test")
            self.end_headers()
            return
        if path in ("/", "/bridge-check.html", "/frame"):
            body = PAGE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)


if __name__ == "__main__":
    print(f"J.A.S.S.I stub on http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Stub).serve_forever()
