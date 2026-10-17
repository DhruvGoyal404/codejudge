// 8 pthreads sum disjoint ranges (multithreading works in the sandbox; glibc
// pthread_create uses clone3, see TestClone3).
#include <pthread.h>
#include <stdio.h>

#define T 8
static long long part[T];

static void *work(void *arg) {
    long id = (long)arg;
    for (long long i = id; i < 1000000; i += T) part[id] += i;
    return NULL;
}

int main(void) {
    pthread_t ts[T];
    for (long t = 0; t < T; t++)
        if (pthread_create(&ts[t], NULL, work, (void *)t) != 0) { perror("pthread_create"); return 1; }
    long long sum = 0;
    for (int t = 0; t < T; t++) { pthread_join(ts[t], NULL); sum += part[t]; }
    printf("threads=%d sum=%lld\n", T, sum);
    return 0;
}
