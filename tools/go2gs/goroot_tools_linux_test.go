// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
)

func TestPackageLoadingNeverExecutesGOROOTTools(t *testing.T) {
	goroot, markers := hostileToolGOROOT(t)
	selectedGo := filepath.Join(goroot, "bin", "go")
	t.Setenv("GO2GS_SELECTED_GO", selectedGo)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", "")
	t.Setenv("GO2GS_SELECTED_GOROOT", goroot)

	for _, test := range []struct {
		name     string
		fixture  string
		cgo      bool
		complete bool
	}{
		{"non-cgo-generics-embed-dependency", "complete", false, true},
		{"assembly-native", "native", false, false},
		{"cgo", "cgo", true, false},
		{"replacement", "replacement", false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := testProfile()
			profile.CGOEnabled = test.cgo
			analysis, complete, err := analyze(t.Context(), copyFixture(t, test.fixture), t.TempDir(), profile)
			if err != nil {
				t.Fatal(err)
			}
			if complete != test.complete {
				t.Fatalf("complete=%v, want %v; blockers=%#v", complete, test.complete, analysis.Blockers)
			}
		})
	}
	for tool, marker := range markers {
		if _, err := os.Lstat(marker); !os.IsNotExist(err) {
			t.Fatalf("GOROOT tool %s executed: %v", tool, err)
		}
	}
}

func hostileToolGOROOT(t *testing.T) (string, map[string]string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	copyFile := func(source, destination string, mode os.FileMode) {
		t.Helper()
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(destination, data, mode); err != nil {
			t.Fatal(err)
		}
	}
	copyFile(filepath.Join(runtime.GOROOT(), "bin", "go"), filepath.Join(root, "bin", "go"), 0o755)
	copyFile(filepath.Join(runtime.GOROOT(), "VERSION"), filepath.Join(root, "VERSION"), 0o644)
	for _, name := range []string{"src", "lib", "misc"} {
		source := filepath.Join(runtime.GOROOT(), name)
		if _, err := os.Lstat(source); os.IsNotExist(err) {
			continue
		}
		if err := os.Symlink(source, filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(runtime.GOROOT(), "pkg", "include"), filepath.Join(root, "pkg", "include")); err != nil {
		t.Fatal(err)
	}
	toolDir := filepath.Join(root, "pkg", "tool", runtime.GOOS+"_"+runtime.GOARCH)
	if err := os.MkdirAll(toolDir, 0o755); err != nil {
		t.Fatal(err)
	}
	markers := map[string]string{}
	for _, tool := range []string{"compile", "asm", "link", "cgo", "vet"} {
		marker := filepath.Join(root, tool+"-executed")
		delegate := filepath.Join(runtime.GOROOT(), "pkg", "tool", runtime.GOOS+"_"+runtime.GOARCH, tool)
		body := "#!/bin/sh\n: > " + strconv.Quote(marker) + "\nexec " + strconv.Quote(delegate) + " \"$@\"\n"
		if err := os.WriteFile(filepath.Join(toolDir, tool), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		markers[tool] = marker
	}
	return root, markers
}
