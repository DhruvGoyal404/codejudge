// Package lang defines how each supported language is compiled and run.
package lang

import (
	"fmt"
	"sort"
)

// Lang describes one language. Image fields are keys into
// sandbox/images/images.lock.json, which maps them to pinned image IDs.
type Lang struct {
	Name         string
	CompileImage string
	RunImage     string
	Source       string   // file name the submission is stored as in /box
	CompileCmd   []string // run in /box by judge-exec in compile mode
	Artifacts    []string // files the compile step produces for the run step; empty = run the source itself
	RunCmd       []string // run in /box by judge-exec in run mode
}

var langs = map[string]Lang{
	"cpp": {
		Name:         "cpp",
		CompileImage: "cpp-compile",
		RunImage:     "cpp-run", // FROM scratch: no compiler, no shell, no libc
		Source:       "main.cpp",
		CompileCmd:   []string{"g++", "-std=gnu++17", "-O2", "-pipe", "-static", "-o", "main", "main.cpp"},
		Artifacts:    []string{"main"},
		RunCmd:       []string{"/box/main"},
	},
	"python": {
		Name:         "python",
		CompileImage: "python",
		RunImage:     "python",
		Source:       "main.py",
		CompileCmd:   []string{"python3", "-m", "py_compile", "main.py"},
		RunCmd:       []string{"python3", "main.py"},
	},
}

// Get returns the language with the given name.
func Get(name string) (Lang, error) {
	l, ok := langs[name]
	if !ok {
		return Lang{}, fmt.Errorf("unsupported language %q (supported: %v)", name, Names())
	}
	return l, nil
}

// Names lists supported languages.
func Names() []string {
	out := make([]string, 0, len(langs))
	for n := range langs {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
