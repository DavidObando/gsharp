// Copyright (C) GSharp Authors. All rights reserved.

//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestReadBoundedRegularFileRejectsFIFOPromptly(t *testing.T) {
	t.Run("existing", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "HEAD")
		if err := syscall.Mkfifo(path, 0o600); err != nil {
			t.Fatal(err)
		}
		assertMetadataReadFailsPromptly(t, func() error {
			_, err := readBoundedRegularFile(path, 4096)
			return err
		})
	})
	t.Run("race-swapped", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "HEAD")
		if err := os.WriteFile(path, []byte("ref"), 0o600); err != nil {
			t.Fatal(err)
		}
		assertMetadataReadFailsPromptly(t, func() error {
			var setupErr error
			_, err := readBoundedRegularFileWithHooks(path, 4096, func() {
				if setupErr = os.Remove(path); setupErr == nil {
					setupErr = syscall.Mkfifo(path, 0o600)
				}
			}, nil)
			if setupErr != nil {
				return setupErr
			}
			return err
		})
	})
}

func assertMetadataReadFailsPromptly(t *testing.T, read func() error) {
	t.Helper()
	result := make(chan error, 1)
	go func() { result <- read() }()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("FIFO metadata was accepted")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("FIFO metadata read blocked")
	}
}
