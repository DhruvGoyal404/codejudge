# Prints the uid it runs as, after a pause so that containers overlap in time.
import os
import time

time.sleep(1.5)
print(os.getuid(), os.getgid())
