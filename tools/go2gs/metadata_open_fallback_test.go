// Copyright (C) GSharp Authors. All rights reserved.

//go:build !unix && !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFallbackEnsureOutputRootFailsBeforeMutation(t *testing.T) {
	target := filepath.Join(t.TempDir(), "missing", "output")
	err := ensureOutputRoot(target, 0o700)
	if err == nil || !strings.Contains(err.Error(), "unsupported on this platform") {
		t.Fatalf("fallback output creation returned %v", err)
	}
	if _, statErr := os.Lstat(filepath.Dir(target)); !os.IsNotExist(statErr) {
		t.Fatalf("fallback output creation mutated the filesystem: %v", statErr)
	}
}

func TestFallbackOwnedTempDirectoryFailsBeforeMutation(t *testing.T) {
	parent := t.TempDir()
	if _, err := createOwnedTempDir(parent, ".go2gs-work-*"); err == nil ||
		!strings.Contains(err.Error(), "unsupported on this platform") {
		t.Fatalf("fallback temporary directory creation returned %v", err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatalf("fallback temporary directory creation mutated its parent: %v, %#v", err, entries)
	}
}
