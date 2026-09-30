// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsRootedMetadataTraversal(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "inside"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inside", "value"), []byte("inside"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, _, err := readBoundedRegularFileWithinRoot(root, filepath.Join("inside", "value"), 64)
	if err != nil || string(data) != "inside" {
		t.Fatalf("rooted read = %q, %v", data, err)
	}
	if _, err := openRootedMetadataFile(root, filepath.Join("inside", "missing")); !os.IsNotExist(err) {
		t.Fatalf("missing rooted file error = %v", err)
	}
	var visited []string
	if err := walkRootedMetadataTree(root, func(relative string, entry os.DirEntry) (bool, error) {
		visited = append(visited, filepath.ToSlash(relative))
		return entry.IsDir(), nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(visited) != 2 || visited[0] != "inside" || visited[1] != "inside/value" {
		t.Fatalf("visited paths = %#v", visited)
	}
}

func TestWindowsRootedMetadataRejectsAncestorReparsePoint(t *testing.T) {
	t.Run("read", func(t *testing.T) {
		root := t.TempDir()
		outside := t.TempDir()
		if err := os.WriteFile(filepath.Join(outside, "value"), []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(root, "inside")
		if err := os.Symlink(outside, link); err != nil {
			t.Skipf("directory symlink unavailable: %v", err)
		}
		if _, _, err := readBoundedRegularFileWithinRoot(root, filepath.Join("inside", "value"), 64); err == nil {
			t.Fatal("ancestor reparse point escaped rooted read")
		}
	})

	t.Run("capture-race", func(t *testing.T) {
		root, inside, original, outside := windowsMetadataRaceFixture(t)
		rootedWalkBeforeDescendHook = func(relative string) {
			if relative != "inside" {
				return
			}
			rootedWalkBeforeDescendHook = nil
			replaceWindowsMetadataDirectoryWithSymlink(t, inside, original, outside)
		}
		t.Cleanup(func() { rootedWalkBeforeDescendHook = nil })
		if err := walkRootedMetadataTree(root, func(_ string, entry os.DirEntry) (bool, error) {
			return entry.IsDir(), nil
		}); err == nil {
			t.Fatal("ancestor reparse-point replacement escaped rooted traversal")
		}
	})

	t.Run("verification-race", func(t *testing.T) {
		_, inside, original, outside := windowsMetadataRaceFixture(t)
		rootedDirectoryBeforeOpenHook = func(path string) {
			if path != inside {
				return
			}
			rootedDirectoryBeforeOpenHook = nil
			replaceWindowsMetadataDirectoryWithSymlink(t, inside, original, outside)
		}
		t.Cleanup(func() { rootedDirectoryBeforeOpenHook = nil })
		if _, err := readRootedMetadataDirectory(inside); err == nil {
			t.Fatal("ancestor reparse-point replacement escaped verification traversal")
		}
	})
}

func TestWindowsEnsureOutputRootRejectsAncestorReparsePointWithoutMutation(t *testing.T) {
	parent := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(parent, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("directory symlink unavailable: %v", err)
	}
	if err := ensureOutputRoot(filepath.Join(link, "new", "output"), 0o700); err == nil {
		t.Fatal("output creation followed an ancestor reparse point")
	}
	if _, err := os.Lstat(filepath.Join(outside, "new")); !os.IsNotExist(err) {
		t.Fatalf("output rejection mutated the reparse target: %v", err)
	}
}

func TestWindowsEnsureOutputRootCreatesMissingSuffix(t *testing.T) {
	target := filepath.Join(t.TempDir(), "existing", "missing", "output")
	if err := os.Mkdir(filepath.Dir(filepath.Dir(target)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ensureOutputRoot(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(target); err != nil || !info.IsDir() {
		t.Fatalf("safe output root was not created: %v, %v", info, err)
	}
}

func TestWindowsEnsureOutputRootDetectsAncestorReplacement(t *testing.T) {
	parent := t.TempDir()
	inside := filepath.Join(parent, "inside")
	original := filepath.Join(parent, "original")
	outside := t.TempDir()
	if err := os.Mkdir(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	outputCreateBeforeComponentHook = func(path string) {
		if path != inside {
			return
		}
		outputCreateBeforeComponentHook = nil
		if err := os.Rename(inside, original); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, inside); err != nil {
			if restoreErr := os.Rename(original, inside); restoreErr != nil {
				t.Fatalf("create directory symlink: %v; restore: %v", err, restoreErr)
			}
			t.Skipf("directory symlink unavailable: %v", err)
		}
	}
	t.Cleanup(func() { outputCreateBeforeComponentHook = nil })
	if err := ensureOutputRoot(filepath.Join(inside, "new", "output"), 0o700); err == nil {
		t.Fatal("output creation accepted an ancestor replacement")
	}
	if _, err := os.Lstat(filepath.Join(outside, "new")); !os.IsNotExist(err) {
		t.Fatalf("ancestor replacement redirected output creation: %v", err)
	}
}

func windowsMetadataRaceFixture(t *testing.T) (root, inside, original, outside string) {
	t.Helper()
	root = t.TempDir()
	inside = filepath.Join(root, "inside")
	original = filepath.Join(root, "original")
	outside = t.TempDir()
	if err := os.Mkdir(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(inside, "value"):  "inside",
		filepath.Join(outside, "value"): "outside",
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root, inside, original, outside
}

func replaceWindowsMetadataDirectoryWithSymlink(t *testing.T, inside, original, outside string) {
	t.Helper()
	if err := os.Rename(inside, original); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, inside); err != nil {
		if restoreErr := os.Rename(original, inside); restoreErr != nil {
			t.Fatalf("create directory symlink: %v; restore: %v", err, restoreErr)
		}
		t.Skipf("directory symlink unavailable: %v", err)
	}
}
