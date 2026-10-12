# Python variant of fds.cpp.
import os
for name in sorted(os.listdir("/proc/self/fd"), key=int):
    try:
        print(f"fd {name} -> {os.readlink('/proc/self/fd/' + name)}")
    except OSError:
        pass  # the directory fd used by listdir is already closed
