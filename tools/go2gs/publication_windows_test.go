// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsAtomicWriteClosesStagedHandleBeforeRename(t *testing.T) {
	t.Run("path", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "result.json")
		var probeErr error
		err := atomicWriteWithHooks(path, []byte("published"), 0o600, func(staged string) {
			probeErr = probeWindowsExclusiveOpen(staged)
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if probeErr != nil {
			t.Fatalf("staged path handle remained open before rename: %v", probeErr)
		}
	})

	t.Run("root", func(t *testing.T) {
		output, err := lockAndInvalidateOutput(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		defer output.release()
		var probeErr error
		err = atomicWriteRoot(output, "result.json", []byte("published"), 0o600, func(staged string) {
			probeErr = probeWindowsExclusiveOpen(staged)
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if probeErr != nil {
			t.Fatalf("rooted staged handle remained open before rename: %v", probeErr)
		}
	})
}

func TestWindowsRootEntryIdentityPreservesReplacement(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "analysis.json")
	if err := os.WriteFile(path, []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	ownedInfo, err := rootEntryStableInfo(root, "analysis.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".owned"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	if removed, err := removeRootEntryIfSame(root, "analysis.json", ownedInfo); err != nil || removed {
		t.Fatalf("replacement removal = %t, %v", removed, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "replacement" {
		t.Fatalf("replacement changed: %q, %v", data, err)
	}
	if data, err := os.ReadFile(path + ".owned"); err != nil || string(data) != "owned" {
		t.Fatalf("owned file changed: %q, %v", data, err)
	}
}

func probeWindowsExclusiveOpen(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(
		name,
		windows.GENERIC_READ,
		0,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return err
	}
	return windows.CloseHandle(handle)
}
