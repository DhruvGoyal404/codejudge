// Cross-test state probe for batch mode.
// Input "plant": try to leave a marker in every shared-state channel:
//   /dev/shm file, POSIX message queue (/dev/mqueue), System V shared memory
//   segment, message queue and semaphore set (fixed keys).
// Input "look": report every marker that survived. Batch mode must reset all
// of them between tests, so "look" must print only "absent"/"unavailable".
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <mqueue.h>
#include <string>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <sys/sem.h>
#include <sys/shm.h>
#include <unistd.h>

static const key_t kShm = 0x4A554401, kMsg = 0x4A554402, kSem = 0x4A554403;
static const char *kShmFile = "/dev/shm/judge-marker";
static const char *kMq = "/judge-marker";

static void report(const char *what, bool ok, int err) {
    if (ok) std::printf("%s ok\n", what);
    else std::printf("%s failed: %s\n", what, std::strerror(err));
}

static void plant() {
    int fd = open(kShmFile, O_CREAT | O_WRONLY, 0600);
    report("plant /dev/shm", fd >= 0, errno);
    if (fd >= 0) { (void)!write(fd, "MARKER", 6); close(fd); }

    struct mq_attr attr = {};
    attr.mq_maxmsg = 1; attr.mq_msgsize = 16;
    mqd_t q = mq_open(kMq, O_CREAT | O_WRONLY, 0600, &attr);
    report("plant mqueue", q != (mqd_t)-1, errno);
    if (q != (mqd_t)-1) { mq_send(q, "MARKER", 6, 0); mq_close(q); }

    int shm = shmget(kShm, 4096, IPC_CREAT | 0600);
    report("plant sysv shm", shm >= 0, errno);
    if (shm >= 0) {
        void *p = shmat(shm, nullptr, 0);
        if (p != (void *)-1) { std::memcpy(p, "MARKER", 6); shmdt(p); }
    }

    int msq = msgget(kMsg, IPC_CREAT | 0600);
    report("plant sysv msg", msq >= 0, errno);
    if (msq >= 0) {
        struct { long type; char text[8]; } m = {1, "MARKER"};
        msgsnd(msq, &m, sizeof m.text, IPC_NOWAIT);
    }

    int sem = semget(kSem, 1, IPC_CREAT | 0600);
    report("plant sysv sem", sem >= 0, errno);
}

static void look() {
    int fd = open(kShmFile, O_RDONLY);
    std::printf("/dev/shm marker: %s\n", fd >= 0 ? "FOUND" : "absent");
    if (fd >= 0) close(fd);

    mqd_t q = mq_open(kMq, O_RDONLY);
    std::printf("mqueue marker: %s\n", q != (mqd_t)-1 ? "FOUND" : "absent");
    if (q != (mqd_t)-1) mq_close(q);

    std::printf("sysv shm: %s\n", shmget(kShm, 0, 0) >= 0 ? "FOUND" : "absent");
    std::printf("sysv msg: %s\n", msgget(kMsg, 0) >= 0 ? "FOUND" : "absent");
    std::printf("sysv sem: %s\n", semget(kSem, 0, 0) >= 0 ? "FOUND" : "absent");
}

int main() {
    char buf[16] = {};
    if (std::scanf("%15s", buf) != 1) return 2;
    if (std::string(buf) == "plant") plant(); else look();
    return 0;
}
