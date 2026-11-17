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

// The profile maps clone3 to ENOSYS (seccomp can't inspect its flags), so
// glibc falls back to clone(2), whose namespace flags the profile filters.
// Both runc and runsc (>= release-20261026.0) honor the errnoRet.
func TestProfileMapsClone3ToENOSYS(t *testing.T) {
	path, err := FindRepoFile("sandbox/seccomp/default.json")
	if err != nil {
		t.Fatal(err)
	}
	base, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rulesOf(t, base) {
		for _, n := range r.Names {
			if n == "clone3" && r.Action == "SCMP_ACT_ERRNO" && r.ErrnoRet != nil && *r.ErrnoRet == 38 {
				return
			}
		}
	}
	t.Fatal("the profile no longer maps clone3 to ENOSYS")
}
