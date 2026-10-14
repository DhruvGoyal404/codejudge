package sandbox

import (
	"encoding/json"
	"os"
	"testing"
)

type rule struct {
	Names    []string `json:"names"`
	Action   string   `json:"action"`
	ErrnoRet *int     `json:"errnoRet"`
	Includes any      `json:"includes"`
	Excludes any      `json:"excludes"`
	Args     any      `json:"args"`
}

func rulesOf(t *testing.T, data []byte) []rule {
	t.Helper()
	var p struct {
		Syscalls []rule `json:"syscalls"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	return p.Syscalls
}

// The runsc variant differs from the base profile only in clone3: no longer
// an ERRNO rule, and allowed unconditionally. Every other rule is unchanged.
func TestGVisorProfileOnlyAllowsClone3(t *testing.T) {
	path, err := FindRepoFile("sandbox/seccomp/default.json")
	if err != nil {
		t.Fatal(err)
	}
	base, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	variant, err := gVisorProfile(base)
	if err != nil {
		t.Fatal(err)
	}
	b, v := rulesOf(t, base), rulesOf(t, []byte(variant))

	// Base: clone3 -> ENOSYS for processes without CAP_SYS_ADMIN.
	var baseENOSYS bool
	for _, r := range b {
		for _, n := range r.Names {
			if n == "clone3" && r.Action == "SCMP_ACT_ERRNO" && r.ErrnoRet != nil && *r.ErrnoRet == 38 {
				baseENOSYS = true
			}
		}
	}
	if !baseENOSYS {
		t.Fatal("base profile no longer maps clone3 to ENOSYS; revisit gVisorProfile")
	}

	// Variant: exactly one unconditional ALLOW rule for clone3, no ERRNO rule for it.
	allows := 0
	for _, r := range v {
		for _, n := range r.Names {
			if n != "clone3" {
				continue
			}
			if r.Action == "SCMP_ACT_ERRNO" {
				t.Fatalf("variant still has an ERRNO rule for clone3: %+v", r)
			}
			if r.Action == "SCMP_ACT_ALLOW" && r.Includes == nil && r.Excludes == nil && r.Args == nil && len(r.Names) == 1 {
				allows++
			}
		}
	}
	if allows != 1 {
		t.Fatalf("want 1 unconditional ALLOW rule for clone3, got %d", allows)
	}

	// Nothing else changed: the multiset of (action, name) pairs without clone3 is equal.
	count := func(rs []rule) map[string]int {
		m := map[string]int{}
		for _, r := range rs {
			for _, n := range r.Names {
				if n != "clone3" {
					m[r.Action+" "+n]++
				}
			}
		}
		return m
	}
	cb, cv := count(b), count(v)
	if len(cb) != len(cv) {
		t.Fatalf("rule set changed beyond clone3: %d vs %d entries", len(cb), len(cv))
	}
	for k, n := range cb {
		if cv[k] != n {
			t.Fatalf("rule %q changed: %d -> %d", k, n, cv[k])
		}
	}
	if !IsGVisor("runsc") || !IsGVisor("runsc-debug") || IsGVisor("runc") || IsGVisor("") {
		t.Fatal("IsGVisor")
	}
}
