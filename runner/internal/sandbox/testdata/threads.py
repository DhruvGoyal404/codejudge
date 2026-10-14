# Multithreading must work under both runtimes (CPython threads are pthreads).
import threading

T = 8
part = [0] * T


def work(t):
    part[t] = sum(range(t, 1000000, T))


ts = [threading.Thread(target=work, args=(t,)) for t in range(T)]
for th in ts:
    th.start()
for th in ts:
    th.join()
print(f"threads={T} sum={sum(part)}")
