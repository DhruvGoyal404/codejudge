package sandbox

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/client"
)

// Sandbox uids. Every container runs as its own unprivileged uid (= gid),
// unique among live containers: RLIMIT_NPROC counts a uid's tasks host-wide
// (no user-namespace remapping), so a shared uid would let one submission's
// processes count against another's.
//
// Range [SandboxUIDBase, SandboxUIDBase+SandboxUIDCount) = [1 000 000 000,
// 1 001 000 000): above every default user range (login.defs UID_MAX 60000,
// nobody 65534) and above the default subordinate-id span used for
// /etc/subuid and /etc/subgid (SUB_UID_MIN 100000 .. SUB_UID_MAX 600100000),
// below 2^31 (tools that treat uids as signed 32-bit). New refuses to start if
// /etc/passwd, /etc/group, /etc/subuid or /etc/subgid on the host touch it.
const (
	SandboxUIDBase  = 1_000_000_000
	SandboxUIDCount = 1_000_000
	labelUID        = "judge.uid"
)

// uidAllocator hands out uids from [base, base+count), never one that is in
// use by this process or excluded (held by another live container).
type uidAllocator struct {
	mu    sync.Mutex
	base  uint32
	count uint32
	next  uint32 // offset of the next candidate
	inUse map[uint32]bool
}

func newUIDAllocator(base, count uint32, seed string) *uidAllocator {
	h := fnv.New32a()
	h.Write([]byte(seed))
	// Different processes start at different offsets (fewer cross-process
	// retries); uniqueness never depends on it.
	return &uidAllocator{base: base, count: count, next: h.Sum32() % count, inUse: map[uint32]bool{}}
}

var errUIDsExhausted = errors.New("no free sandbox uid")

// acquire reserves the next uid not in use here and not in exclude.
func (a *uidAllocator) acquire(exclude map[uint32]bool) (uint32, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i := uint32(0); i < a.count; i++ {
		uid := a.base + (a.next+i)%a.count
		if a.inUse[uid] || exclude[uid] {
			continue
		}
		a.inUse[uid] = true
		a.next = (a.next + i + 1) % a.count
		return uid, nil
	}
	return 0, errUIDsExhausted
}

func (a *uidAllocator) release(uid uint32) {
	a.mu.Lock()
	delete(a.inUse, uid)
	a.mu.Unlock()
}

// liveUIDs returns the uids held by every existing judge.managed container
// (any process, any state).
func (s *Sandbox) liveUIDs(ctx context.Context) (map[uint32]bool, error) {
	list, err := s.cli.ContainerList(ctx, client.ContainerListOptions{
		All: true, Filters: make(client.Filters).Add("label", LabelManaged+"=true"),
	})
	if err != nil {
		return nil, err
	}
	out := map[uint32]bool{}
	for _, c := range list.Items {
		if v, err := strconv.ParseUint(c.Labels[labelUID], 10, 32); err == nil {
			out[uint32(v)] = true
		}
	}
	return out, nil
}

// ownsUID reports whether container id is the rightful holder of uid: of all
// existing containers labelled with it, the oldest (then lowest id) wins. Two
// processes that picked the same uid concurrently reach the same answer, so
// at most one of them starts its container.
func (s *Sandbox) ownsUID(ctx context.Context, uid uint32, id string) (bool, error) {
	list, err := s.cli.ContainerList(ctx, client.ContainerListOptions{
		All: true, Filters: make(client.Filters).Add("label", labelUID+"="+strconv.FormatUint(uint64(uid), 10)),
	})
	if err != nil {
		return false, err
	}
	// The list's Created is in whole seconds: inspect each holder for the
	// nanosecond creation time, so "oldest" matches the real creation order
	// (a same-second tie broken by id let two containers both "win").
	winner := ""
	var winnerCreated time.Time
	for _, c := range list.Items {
		insp, err := s.cli.ContainerInspect(ctx, c.ID, client.ContainerInspectOptions{})
		if err != nil {
			continue // removed meanwhile: not a holder
		}
		created, err := time.Parse(time.RFC3339Nano, insp.Container.Created)
		if err != nil {
			return false, fmt.Errorf("container %s created %q: %w", c.ID, insp.Container.Created, err)
		}
		if winner == "" || created.Before(winnerCreated) || (created.Equal(winnerCreated) && c.ID < winner) {
			winner, winnerCreated = c.ID, created
		}
	}
	return winner == id, nil
}

// createContainer allocates a uid unique among live containers, creates the
// container with it and verifies the uid is still uniquely ours (else the
// container is removed and another uid tried). release frees the uid; call it
// after the container is removed.
func (s *Sandbox) createContainer(ctx context.Context, image string, sp containerSpec) (id string, release func(), err error) {
	for attempt := 0; attempt < 8; attempt++ {
		live, err := s.liveUIDs(ctx)
		if err != nil {
			return "", nil, fmt.Errorf("list containers: %w", err)
		}
		uid, err := s.uids.acquire(live)
		if err != nil {
			return "", nil, err
		}
		cfg, hc := s.containerConfigs(image, sp, uid)
		created, err := s.cli.ContainerCreate(ctx, client.ContainerCreateOptions{Name: randName(), Config: cfg, HostConfig: hc})
		if err != nil {
			s.uids.release(uid)
			return "", nil, err
		}
		mine, err := s.ownsUID(ctx, uid, created.ID)
		if err == nil && mine {
			return created.ID, func() { s.uids.release(uid) }, nil
		}
		_ = s.removeContainer(created.ID)
		s.uids.release(uid)
		if err != nil {
			return "", nil, fmt.Errorf("verify uid: %w", err)
		}
	}
	return "", nil, errors.New("could not allocate a unique sandbox uid")
}

// checkUIDRange fails if any host user, group or subordinate id range
// overlaps the sandbox uid range. Files that don't exist are skipped (e.g. a
// Windows dev host, whose Docker VM is separate).
func checkUIDRange(passwd, group, subuid, subgid string) error {
	lo, hi := uint64(SandboxUIDBase), uint64(SandboxUIDBase)+SandboxUIDCount // [lo, hi)
	overlaps := func(start, n uint64) bool { return start < hi && start+n > lo }
	scan := func(path string, fn func(fields []string) error) error {
		f, err := os.Open(path)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if err := fn(strings.Split(line, ":")); err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
		}
		return sc.Err()
	}
	ids := func(path string) error { // name:x:ID:...
		return scan(path, func(f []string) error {
			if len(f) < 3 {
				return nil
			}
			if id, err := strconv.ParseUint(f[2], 10, 64); err == nil && overlaps(id, 1) {
				return fmt.Errorf("%s (id %d) is inside the sandbox uid range [%d, %d)", f[0], id, lo, hi)
			}
			return nil
		})
	}
	ranges := func(path string) error { // name:start:count
		return scan(path, func(f []string) error {
			if len(f) < 3 {
				return nil
			}
			start, err1 := strconv.ParseUint(f[1], 10, 64)
			n, err2 := strconv.ParseUint(f[2], 10, 64)
			if err1 == nil && err2 == nil && overlaps(start, n) {
				return fmt.Errorf("subordinate range of %s (%d+%d) overlaps the sandbox uid range [%d, %d)", f[0], start, n, lo, hi)
			}
			return nil
		})
	}
	for _, c := range []struct {
		path string
		fn   func(string) error
	}{{passwd, ids}, {group, ids}, {subuid, ranges}, {subgid, ranges}} {
		if err := c.fn(c.path); err != nil {
			return err
		}
	}
	return nil
}
