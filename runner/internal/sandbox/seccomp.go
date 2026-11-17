package sandbox

import "strings"

// IsGVisor reports whether runtime is gVisor's runsc (or a variant of it,
// e.g. "runsc-debug").
func IsGVisor(runtime string) bool { return strings.HasPrefix(runtime, "runsc") }
