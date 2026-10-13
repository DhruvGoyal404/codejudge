//go:build linux

package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

const ipcRMID = 0 // IPC_RMID

// sysvTables maps each /proc/sysvipc table to the syscall that removes one
// of its objects. The id is column 2 in every table (after the key).
var sysvTables = []struct {
	path   string
	remove func(id int) syscall.Errno
}{
	{"/proc/sysvipc/shm", func(id int) syscall.Errno {
		_, _, e := syscall.Syscall(syscall.SYS_SHMCTL, uintptr(id), ipcRMID, 0)
		return e
	}},
	{"/proc/sysvipc/msg", func(id int) syscall.Errno {
		_, _, e := syscall.Syscall(syscall.SYS_MSGCTL, uintptr(id), ipcRMID, 0)
		return e
	}},
	{"/proc/sysvipc/sem", func(id int) syscall.Errno {
		_, _, e := syscall.Syscall6(syscall.SYS_SEMCTL, uintptr(id), 0, ipcRMID, 0, 0, 0)
		return e
	}},
}

// cleanSysVIPC removes every System V shared memory segment, message queue
// and semaphore set in the container's IPC namespace, then verifies the
// tables are empty. Called after reapAll, so nothing is still attached and
// removal takes effect immediately. Any failure is returned so the batch can
// end instead of running the next test with leftover state.
func cleanSysVIPC() error {
	for _, t := range sysvTables {
		ids, err := sysvIDs(t.path)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if e := t.remove(id); e != 0 && e != syscall.EINVAL && e != syscall.EIDRM {
				return fmt.Errorf("remove %s id %d: %v", t.path, id, e)
			}
		}
		left, err := sysvIDs(t.path)
		if err != nil {
			return err
		}
		if len(left) != 0 {
			return fmt.Errorf("%s: %d objects left after IPC_RMID", t.path, len(left))
		}
	}
	return nil
}

// sysvIDs lists the object ids in one /proc/sysvipc table. A missing table
// (kernel without SysV IPC) means there is nothing to clean.
func sysvIDs(path string) ([]int, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var ids []int
	sc := bufio.NewScanner(f)
	sc.Scan() // header line
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		id, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, fmt.Errorf("%s: bad id %q", path, fields[1])
		}
		ids = append(ids, id)
	}
	return ids, sc.Err()
}

// optionalScratch returns extra per-test reset directories that exist in
// this container (e.g. /dev/mqueue, which Docker may mount even with
// --ipc none, and /dev/shm if IPC mode ever allows it).
func optionalScratch() []string {
	var dirs []string
	for _, d := range []string{"/dev/shm", "/dev/mqueue"} {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			dirs = append(dirs, d)
		}
	}
	return dirs
}
