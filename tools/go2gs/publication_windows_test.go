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
	for _, mode := range []os.FileMode{0o600, 0o444} {
		t.Run(mode.String(), func(t *testing.T) {
			t.Run("path", func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "result.json")
				t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
				var probeErr error
				err := atomicWriteWithHooks(path, []byte("published"), mode, func(staged string) {
					probeErr = probeWindowsExclusiveOpen(staged)
				}, nil)
				if err != nil {
					t.Fatal(err)
				}
				if probeErr != nil {
					t.Fatalf("staged path handle remained open before rename: %v", probeErr)
				}
				assertWindowsMode(t, path, mode)
			})

			t.Run("root", func(t *testing.T) {
				directory := t.TempDir()
				output, err := lockAndInvalidateOutput(directory)
				if err != nil {
					t.Fatal(err)
				}
				defer output.release()
				path := filepath.Join(directory, "result.json")
				t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
				var probeErr error
				err = atomicWriteRoot(output, "result.json", []byte("published"), mode, func(staged string) {
					probeErr = probeWindowsExclusiveOpen(staged)
				}, nil)
				if err != nil {
					t.Fatal(err)
				}
				if probeErr != nil {
					t.Fatalf("rooted staged handle remained open before rename: %v", probeErr)
				}
				assertWindowsMode(t, path, mode)
			})
		})
	}
}

func TestWindowsExecutableCapsuleStagesReadOnlyEntry(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source.exe")
	data := []byte("captured executable")
	if err := os.WriteFile(source, data, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(source)
	if err != nil {
		t.Fatal(err)
	}
	capsule, err := createExecutableCapsule(t.TempDir(), []capturedExecutable{{
		name:       "helper.exe",
		sourcePath: source,
		data:       data,
		sourceInfo: info,
		mode:       0o444,
	}}, false)
	if err != nil {
		t.Fatal(err)
	}
	staged := capsule.path("helper.exe")
	t.Cleanup(func() {
		_ = os.Chmod(staged, 0o600)
		_ = capsule.close()
	})
	assertWindowsMode(t, staged, 0o444)
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

func assertWindowsMode(t *testing.T, path string, requested os.FileMode) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !windowsModeMatches(requested, info.Mode()) {
		t.Fatalf("mode = %v, requested %v", info.Mode().Perm(), requested)
	}
}
