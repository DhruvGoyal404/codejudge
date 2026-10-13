# Python variant of snoopipc.cpp. CPython's standard library has no System V
# IPC or POSIX message-queue API (sysv_ipc / posix_ipc are third-party and
# not installed in the run image), so this covers the filesystem-visible
# channels only: /dev/shm and /dev/mqueue. SysV objects are covered by the
# C++ variant.
import importlib.util
import os
import sys

mode = sys.stdin.read().strip()
print("sysv_ipc available:", importlib.util.find_spec("sysv_ipc") is not None)
paths = ["/dev/shm/judge-marker-py", "/dev/mqueue/judge-marker-py"]
if mode == "plant":
    for p in paths:
        try:
            with open(p, "w") as f:
                f.write("MARKER")
            print("plant", p, "ok")
        except OSError as e:
            print("plant", p, "failed:", e.strerror)
else:
    for p in paths:
        print(p, "FOUND" if os.path.exists(p) else "absent")
