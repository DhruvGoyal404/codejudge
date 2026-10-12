//go:build !windows

package sandbox

import (
	"os"
	"strconv"
	"strings"
)

// processStart returns the process start time (field 22 of /proc/<pid>/stat,
// clock ticks since boot) and whether the process exists and is not a zombie.
func processStart(pid int) (string, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", false
	}
	// comm (field 2) may contain spaces/parens; fields after the last ')' are fixed.
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return "", false
	}
	f := strings.Fields(s[i+1:]) // f[0] = state (field 3), f[19] = starttime (field 22)
	if len(f) < 20 || f[0] == "Z" || f[0] == "X" {
		return "", false
	}
	return "linux:" + f[19], true
}
