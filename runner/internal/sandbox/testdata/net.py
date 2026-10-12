import socket
try:
    s = socket.create_connection(("1.1.1.1", 80), timeout=3)
    print("CONNECTED")
except OSError as e:
    print("blocked:", e.errno, e.strerror)
try:
    socket.getaddrinfo("example.com", 80)
    print("DNS-RESOLVED")
except OSError as e:
    print("dns blocked:", type(e).__name__)
