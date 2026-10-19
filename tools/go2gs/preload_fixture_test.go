// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func configurePreloadGoFixture(t *testing.T) {
	t.Helper()
	root := secureTestRoot(t)
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(runtime.GOROOT(), "bin", selectedGoName())
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	selected := filepath.Join(bin, selectedGoName())
	if err := os.WriteFile(selected, data, 0o755); err != nil {
		t.Fatal(err)
	}
	version, err := os.ReadFile(filepath.Join(runtime.GOROOT(), "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "VERSION"), version, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO2GS_SELECTED_GO", selected)
	t.Setenv("GO2GS_SELECTED_GO_SHA256", hashBytes(data))
}
