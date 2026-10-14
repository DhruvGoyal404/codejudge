package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestUIDAllocatorUniqueUnderConcurrency(t *testing.T) {
	a := newUIDAllocator(SandboxUIDBase, SandboxUIDCount, "test")
	const n = 200
	got := make(chan uint32, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			uid, err := a.acquire(nil)
			if err != nil {
				t.Error(err)
				return
			}
			got <- uid
		}()
	}
	wg.Wait()
	close(got)
	seen := map[uint32]bool{}
	for uid := range got {
		if seen[uid] {
			t.Fatalf("uid %d handed out twice", uid)
		}
		if uid < SandboxUIDBase || uid >= SandboxUIDBase+SandboxUIDCount {
			t.Fatalf("uid %d outside the sandbox range", uid)
		}
		seen[uid] = true
	}
	if len(seen) != n {
		t.Fatalf("%d distinct uids, want %d", len(seen), n)
	}
}

func TestUIDAllocatorExcludeReleaseExhaust(t *testing.T) {
	a := newUIDAllocator(100, 3, "x")     // uids 100, 101, 102
	exclude := map[uint32]bool{101: true} // held by another live container
	u1, _ := a.acquire(exclude)
	u2, _ := a.acquire(exclude)
	if u1 == 101 || u2 == 101 || u1 == u2 {
		t.Fatalf("got %d, %d", u1, u2)
	}
	if _, err := a.acquire(exclude); err != errUIDsExhausted {
		t.Fatalf("want exhaustion, got %v", err)
	}
	a.release(u1)
	u3, err := a.acquire(exclude)
	if err != nil || u3 != u1 {
		t.Fatalf("after release: %d %v, want %d", u3, err, u1)
	}
}

func TestCheckUIDRange(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	okPasswd := write("passwd", "root:x:0:0::/root:/bin/sh\nnobody:x:65534:65534::/:/usr/sbin/nologin\nalice:x:1000:1000::/home/alice:/bin/bash\n")
	okGroup := write("group", "root:x:0:\nnogroup:x:65534:\n")
	okSub := write("subuid", "alice:100000:65536\nbob:165536:65536\n# comment\n")
	missing := filepath.Join(dir, "absent")
	if err := checkUIDRange(okPasswd, okGroup, okSub, missing); err != nil {
		t.Fatalf("typical host rejected: %v", err)
	}
	cases := map[string][4]string{
		"user in range":     {write("p2", "svc:x:1000000005:1::/:/bin/false\n"), okGroup, okSub, missing},
		"group in range":    {okPasswd, write("g2", "g:x:1000999999:\n"), okSub, missing},
		"subuid overlaps":   {okPasswd, okGroup, write("s2", "carol:999999000:65536\n"), missing},
		"subgid overlaps":   {okPasswd, okGroup, okSub, write("s3", "dave:1000500000:10\n")},
		"subuid covers all": {okPasswd, okGroup, write("s4", "eve:100000:4000000000\n"), missing},
	}
	for name, c := range cases {
		if err := checkUIDRange(c[0], c[1], c[2], c[3]); err == nil || !strings.Contains(err.Error(), "sandbox uid range") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
