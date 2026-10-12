# Python variant of overread.cpp.
import os, sys, time
own = b""
while True:
    chunk = os.read(0, 4096)
    if not chunk:
        break
    own += chunk
extra = b""
for _ in range(20):
    time.sleep(0.05)
    while True:
        chunk = os.read(0, 4096)
        if not chunk:
            break
        extra += chunk
print(f"own={own.decode()} extra={len(extra)} extradata={extra.decode(errors='replace')}")
