# Prints its uid, gid and the wall-clock interval it was alive for (ns), with
# a pause so that containers overlap in time.
import os
import time

start = time.time_ns()
time.sleep(3)
print(os.getuid(), os.getgid(), start, time.time_ns())
