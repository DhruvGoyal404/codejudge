//go:build windows

package sandbox

import (
	"strconv"

	"golang.org/x/sys/windows"
)

const stillActive = 259 // STILL_ACTIVE exit code of a running process

// processStart returns the process creation time (100ns ticks, as a string)
// and whether the process is currently running.
func processStart(pid int) (string, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil || code != stillActive {
		return "", false
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return "", false
	}
	return "win:" + strconv.FormatInt(created.Nanoseconds(), 10), true
}
