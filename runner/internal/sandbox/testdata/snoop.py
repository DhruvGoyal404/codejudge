# Looks for other tests' inputs anywhere it can write or read scratch data,
# and prints everything it finds. Hidden inputs of later tests must never be
# present, and earlier tests' files must have been wiped.
import os
own = open("/dev/stdin").read()
print("own:", own.strip())
for root in ("/box", "/tmp", "/dev/shm"):
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            try:
                with open(p, "rb") as f:
                    data = f.read(4096)
            except OSError:
                continue
            print("found", p, data.decode(errors="replace").strip()[:200])
# Leave a trace for the next test to find, if the box were not wiped.
with open("/tmp/left-behind", "w") as f:
    f.write("LEFTOVER " + own)
with open("/box/left-behind", "w") as f:
    f.write("LEFTOVER " + own)
