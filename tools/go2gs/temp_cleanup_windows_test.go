// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/sys/windows"
)

func TestWindowsOwnedTempCleanupRemovesTreeWithoutFollowingReparse(t *testing.T) {
	directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-work-*")
	if err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(directory.path, "nested")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "owned"), []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	valuable := filepath.Join(outside, "valuable")
	if err := os.WriteFile(valuable, []byte("safe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory.path, "outside-link")); err != nil {
		t.Skipf("directory symlinks unavailable: %v", err)
	}
	if err := directory.cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(directory.path); !os.IsNotExist(err) {
		t.Fatalf("owned directory remains: %v", err)
	}
	if data, err := os.ReadFile(valuable); err != nil || string(data) != "safe" {
		t.Fatalf("reparse target changed: %q, %v", data, err)
	}
}

func TestWindowsOwnedTempCleanupRejectsIdentityDrift(t *testing.T) {
	t.Run("before-rename", func(t *testing.T) {
		directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-work-*")
		if err != nil {
			t.Fatal(err)
		}
		displaced := directory.path + ".owned"
		err = directory.cleanupWithHook(func() {
			if err := os.Rename(directory.path, displaced); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(directory.path, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(directory.path, "valuable"), []byte("safe"), 0o600); err != nil {
				t.Fatal(err)
			}
		})
		if err == nil || !strings.Contains(err.Error(), "changed during cleanup") {
			t.Fatalf("identity drift returned %v", err)
		}
		if data, err := os.ReadFile(filepath.Join(directory.path, "valuable")); err != nil || string(data) != "safe" {
			t.Fatalf("replacement changed: %q, %v", data, err)
		}
		if _, err := os.Stat(displaced); err != nil {
			t.Fatalf("owned directory changed after drift: %v", err)
		}
	})

	t.Run("after-rename", func(t *testing.T) {
		directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-work-*")
		if err != nil {
			t.Fatal(err)
		}
		var replacement, displaced string
		err = directory.cleanupWithHooks(nil, func(tombstone string) {
			replacement = tombstone
			displaced = tombstone + ".owned"
			if err := os.Rename(tombstone, displaced); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(tombstone, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(tombstone, "valuable"), []byte("safe"), 0o600); err != nil {
				t.Fatal(err)
			}
		})
		if err == nil || !strings.Contains(err.Error(), "tombstone was replaced") {
			t.Fatalf("tombstone drift returned %v", err)
		}
		if data, err := os.ReadFile(filepath.Join(replacement, "valuable")); err != nil || string(data) != "safe" {
			t.Fatalf("tombstone replacement changed: %q, %v", data, err)
		}
		if _, err := os.Stat(displaced); err != nil {
			t.Fatalf("owned tombstone changed after drift: %v", err)
		}
	})
}

func TestWindowsOwnedTempCleanupReportsRemovalFailure(t *testing.T) {
	directory, err := createOwnedTempDir(t.TempDir(), ".go2gs-work-*")
	if err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(directory.path, "locked")
	if err := os.WriteFile(locked, []byte("owned"), 0o600); err != nil {
		t.Fatal(err)
	}
	var tombstone string
	var handle windows.Handle
	var hookErr error
	err = directory.cleanupWithHooks(nil, func(path string) {
		tombstone = path
		var lockedPath *uint16
		lockedPath, hookErr = windows.UTF16PtrFromString(filepath.Join(path, "locked"))
		if hookErr != nil {
			return
		}
		handle, hookErr = windows.CreateFile(
			lockedPath,
			windows.GENERIC_READ,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
			nil,
			windows.OPEN_EXISTING,
			windows.FILE_ATTRIBUTE_NORMAL,
			0,
		)
	})
	if hookErr != nil {
		t.Fatal(hookErr)
	}
	if err == nil {
		_ = windows.CloseHandle(handle)
		t.Fatal("cleanup succeeded while an entry denied delete sharing")
	}
	if tombstone == "" {
		_ = windows.CloseHandle(handle)
		t.Fatal("cleanup failure did not identify its tombstone")
	}
	if _, statErr := os.Stat(tombstone); statErr != nil {
		_ = windows.CloseHandle(handle)
		t.Fatalf("failed cleanup removed its owned tombstone: %v", statErr)
	}
	if err := windows.CloseHandle(handle); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(tombstone); err != nil {
		t.Fatal(err)
	}
}

type triggeredDeadlineContext struct {
	context.Context
	done      chan struct{}
	once      sync.Once
	mu        sync.Mutex
	callbacks []*triggeredDeadlineCallback
}

type triggeredDeadlineCallback struct {
	run    func()
	active bool
}

func newTriggeredDeadlineContext(parent context.Context) *triggeredDeadlineContext {
	return &triggeredDeadlineContext{Context: parent, done: make(chan struct{})}
}

func (c *triggeredDeadlineContext) Done() <-chan struct{} {
	return c.done
}

func (c *triggeredDeadlineContext) Err() error {
	select {
	case <-c.done:
		return context.DeadlineExceeded
	default:
		return nil
	}
}

func (c *triggeredDeadlineContext) AfterFunc(run func()) func() bool {
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		run()
		return func() bool { return false }
	default:
	}
	callback := &triggeredDeadlineCallback{run: run, active: true}
	c.callbacks = append(c.callbacks, callback)
	c.mu.Unlock()
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		if !callback.active {
			return false
		}
		callback.active = false
		return true
	}
}

func (c *triggeredDeadlineContext) trigger() {
	c.once.Do(func() {
		close(c.done)
		c.mu.Lock()
		var callbacks []func()
		for _, callback := range c.callbacks {
			if callback.active {
				callback.active = false
				callbacks = append(callbacks, callback.run)
			}
		}
		c.mu.Unlock()
		for _, run := range callbacks {
			run()
		}
	})
}

func TestWindowsOwnedTempCleanupRunsOnBlockerAndTimeout(t *testing.T) {
	run := func(t *testing.T, timeoutOnWork bool) error {
		t.Helper()
		var created []string
		previous := tempDirectoryCreatedHook
		ctx := newTriggeredDeadlineContext(t.Context())
		tempDirectoryCreatedHook = func(directory ownedTempDir) {
			created = append(created, directory.path)
			if timeoutOnWork && strings.HasPrefix(filepath.Base(directory.path), ".go2gs-work-") {
				ctx.trigger()
			}
		}
		t.Cleanup(func() {
			ctx.trigger()
			tempDirectoryCreatedHook = previous
		})

		root := copyFixture(t, "complete")
		profile := testProfile()
		if !timeoutOnWork {
			profile.RequestedGoVersion = "1.26.6"
		}
		out := secureTestRoot(t)
		err := runAnalyze(ctx, []string{
			"--source", root,
			"--profile", writeTestProfile(t, profile),
			"--out", out,
		})
		if len(created) == 0 {
			t.Fatal("analysis created no owned temporary directory")
		}
		for _, path := range created {
			if _, statErr := os.Lstat(path); !os.IsNotExist(statErr) {
				t.Fatalf("owned temporary directory remains after %v: %s: %v", err, path, statErr)
			}
		}
		return err
	}

	t.Run("blocker", func(t *testing.T) {
		var exitErr *exitError
		if err := run(t, false); !errors.As(err, &exitErr) || exitErr.code != 1 {
			t.Fatalf("blocker exit = %v", err)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		var exitErr *exitError
		if err := run(t, true); !errors.As(err, &exitErr) || exitErr.code != 2 ||
			!strings.Contains(err.Error(), context.DeadlineExceeded.Error()) {
			t.Fatalf("timeout exit = %v", err)
		}
	})
}
