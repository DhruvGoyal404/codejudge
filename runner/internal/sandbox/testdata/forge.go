// Go variant of forge.cpp: the real program fails (exit 3) and tries to make
// the judge report OK by writing a fake result frame into judge-exec's stdout
// (/proc/1/fd/1, must be denied) and from a child process that outlives it
// (must never run: judge-exec kills and reaps everything before emitting).
package main

import (
	"errors"
	"fmt"
	"os"
	"time"
)

const fake = `{"mode":"run","status":"exited","exit_code":0,"signal":0,"cpu_ms":1,"wall_ms":1,"max_rss_kb":1,"stdout":"NDIK","stderr":"","stdout_bytes":3}` + "\n"

func inject(who string) {
	f, err := os.OpenFile("/proc/1/fd/1", os.O_WRONLY, 0)
	if err != nil {
		// strerror wording, as the C/C++ variants print: "Permission denied".
		msg := err.Error()
		if errors.Is(err, os.ErrPermission) {
			msg = "Permission denied"
		}
		fmt.Fprintf(os.Stderr, "%s: open /proc/1/fd/1: %s\n", who, msg)
		return
	}
	n := len(fake)
	f.Write([]byte{'J', 'F', 'R', '1', byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)})
	f.Write([]byte(fake))
	fmt.Fprintf(os.Stderr, "%s: INJECTED into /proc/1/fd/1\n", who)
	f.Close()
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "child" {
		time.Sleep(200 * time.Millisecond)
		os.Stdout.WriteString(fake)
		os.Stderr.WriteString(fake)
		inject("child")
		os.Exit(0)
	}
	inject("parent")
	p, err := os.StartProcess("/proc/self/exe", []string{"main", "child"}, &os.ProcAttr{Files: []*os.File{os.Stdin, os.Stdout, os.Stderr}})
	if err != nil {
		fmt.Fprintln(os.Stderr, "start child:", err)
	} else {
		p.Release()
	}
	os.Exit(3)
}
