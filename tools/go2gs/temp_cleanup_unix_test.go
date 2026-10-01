// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func TestOwnedTemporaryDirectoryPropagatesPersistentFileOpenFailure(t *testing.T) {
	if !secureTempCleanupSupported() {
		t.Skip("descriptor-relative cleanup is unavailable")
	}
	directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-worker-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory.path, "owned"), []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}

	previous := tempCleanupOpenFile
	calls := 0
	tempCleanupOpenFile = func(dirfd int, path string, flags int, mode uint32) (int, error) {
		if path == "owned" {
			calls++
			if calls > 1 {
				panic("persistent open failure was ignored and retried")
			}
			return -1, unix.EACCES
		}
		return unix.Openat(dirfd, path, flags, mode)
	}
	t.Cleanup(func() { tempCleanupOpenFile = previous })

	err = directory.cleanupWithHooks(nil, nil)
	if !errors.Is(err, unix.EACCES) || !strings.Contains(err.Error(), "open temporary file for quarantine") {
		t.Fatalf("persistent open failure was not propagated: %v", err)
	}
	if calls != 1 {
		t.Fatalf("persistent open failure calls = %d, want 1", calls)
	}
}
