package sandbox

import (
	"encoding/json"
	"fmt"
	"strings"
)

// IsGVisor reports whether runtime is gVisor's runsc (or a variant of it,
// e.g. "runsc-debug").
func IsGVisor(runtime string) bool { return strings.HasPrefix(runtime, "runsc") }

// gVisorProfile derives the profile used under runsc from the base profile.
//
// The base profile (Docker's default lineage) makes clone3 fail with ENOSYS
// (rule errnoRet 38): seccomp cannot inspect clone3's flags (they are in a
// struct in memory), so glibc must fall back to clone(2), whose flags the
// profile does filter (no namespace creation). gVisor's --oci-seccomp ignores
// every errnoRet and returns EPERM instead, and glibc (>= 2.34) only falls
// back on ENOSYS, so under runsc posix_spawn (g++ starting cc1plus) and
// pthread_create (std::thread, Python threading, the JVM, Node) fail.
//
// Under runsc, clone3 is handled by gVisor's Sentry, not the host kernel,
// which removes the reason the base profile blocks it; capabilities stay
// dropped (no CLONE_NEW* that needs CAP_SYS_ADMIN) and no-new-privileges
// stays on. So the variant allows clone3 and changes nothing else. Under runc
// the base profile is used unchanged. See docs/PHASE6.md § 6a.7.
func gVisorProfile(base []byte) (string, error) {
	var p map[string]any
	if err := json.Unmarshal(base, &p); err != nil {
		return "", err
	}
	rules, _ := p["syscalls"].([]any)
	var kept []any
	for _, r := range rules {
		rule, _ := r.(map[string]any)
		names, _ := rule["names"].([]any)
		if action, _ := rule["action"].(string); action != "SCMP_ACT_ERRNO" {
			kept = append(kept, r)
			continue
		}
		var rest []any
		for _, n := range names {
			if n != "clone3" {
				rest = append(rest, n)
			}
		}
		if len(rest) > 0 {
			rule["names"] = rest
			kept = append(kept, rule)
		}
	}
	kept = append(kept, map[string]any{
		"names":   []any{"clone3"},
		"action":  "SCMP_ACT_ALLOW",
		"comment": "gVisor variant: clone3 allowed (runsc ignores errnoRet; see seccomp.go)",
	})
	p["syscalls"] = kept
	out, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("gVisor seccomp profile: %w", err)
	}
	return string(out), nil
}
