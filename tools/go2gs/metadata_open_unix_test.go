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

func TestRootedReadRejectsAncestorSymlinkAndReplacement(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "inside")
	outside := t.TempDir()
	if err := os.Mkdir(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inside, "value"), []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "value"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(root, "original")
	if err := os.Rename(inside, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, inside); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readBoundedRegularFileWithinRoot(root, filepath.Join("inside", "value"), 64); err == nil {
		t.Fatal("ancestor symlink escaped rooted read")
	}
	if err := os.Remove(inside); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(original, inside); err != nil {
		t.Fatal(err)
	}

	rootedReadAfterOpenHook = func(hookRoot, relative string) {
		if hookRoot != root || relative != filepath.Join("inside", "value") {
			return
		}
		rootedReadAfterOpenHook = nil
		if err := os.Rename(inside, original); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, inside); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { rootedReadAfterOpenHook = nil })
	if _, _, err := readBoundedRegularFileWithinRoot(root, filepath.Join("inside", "value"), 64); err == nil {
		t.Fatal("ancestor replacement between rooted opens was accepted")
	}
}

func TestRootedDirectoryEnumerationRejectsAncestorSymlinkRaces(t *testing.T) {
	t.Run("capture", func(t *testing.T) {
		root := t.TempDir()
		inside := filepath.Join(root, "inside")
		outside := t.TempDir()
		if err := os.Mkdir(inside, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(inside, "value"), []byte("inside"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(outside, "value"), []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		original := filepath.Join(root, "original")
		rootedWalkBeforeDescendHook = func(relative string) {
			if relative != "inside" {
				return
			}
			rootedWalkBeforeDescendHook = nil
			if err := os.Rename(inside, original); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, inside); err != nil {
				t.Fatal(err)
			}
		}
		t.Cleanup(func() { rootedWalkBeforeDescendHook = nil })
		if err := walkRootedMetadataTree(root, func(_ string, entry os.DirEntry) (bool, error) {
			return entry.IsDir(), nil
		}); err == nil {
			t.Fatal("capture traversal followed an ancestor symlink replacement")
		}
	})

	t.Run("verification", func(t *testing.T) {
		root := t.TempDir()
		inside := filepath.Join(root, "inside")
		outside := t.TempDir()
		if err := os.Mkdir(inside, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(inside, "value"), []byte("inside"), 0o600); err != nil {
			t.Fatal(err)
		}
		original := filepath.Join(root, "original")
		rootedDirectoryBeforeOpenHook = func(path string) {
			if path != inside {
				return
			}
			rootedDirectoryBeforeOpenHook = nil
			if err := os.Rename(inside, original); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(outside, inside); err != nil {
				t.Fatal(err)
			}
		}
		t.Cleanup(func() { rootedDirectoryBeforeOpenHook = nil })
		if _, err := readRootedMetadataDirectory(inside); err == nil {
			t.Fatal("verification enumeration followed an ancestor symlink replacement")
		}
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
