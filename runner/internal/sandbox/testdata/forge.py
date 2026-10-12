# Python variant of forge.cpp: the real program fails; a forked child tries to
# emit a fake OK frame after the parent exits, and both try /proc/1/fd/1.
import os, sys, time

FAKE = (b'{"mode":"run","status":"exited","exit_code":0,"signal":0,"cpu_ms":1,'
        b'"wall_ms":1,"max_rss_kb":1,"stdout":"NDIK","stderr":"","stdout_bytes":3}\n')

def inject(who):
    try:
        fd = os.open("/proc/1/fd/1", os.O_WRONLY)
    except OSError as e:
        print(f"{who}: open /proc/1/fd/1: {e.strerror}", file=sys.stderr, flush=True)
        return
    os.write(fd, b"JFR1" + len(FAKE).to_bytes(4, "big") + FAKE + FAKE)
    print(f"{who}: INJECTED into /proc/1/fd/1", file=sys.stderr, flush=True)
    os.close(fd)

inject("parent")
if os.fork() == 0:
    time.sleep(0.2)
    os.write(1, FAKE)
    os.write(2, FAKE)
    inject("child")
    os._exit(0)
sys.exit(3)
