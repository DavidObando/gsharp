// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix && !linux

package main

import (
	"errors"
	"syscall"
	"testing"
)

func testProcessExitProbe(t *testing.T, pid int) func() bool {
	t.Helper()
	return func() bool {
		t.Helper()
		err := syscall.Kill(pid, 0)
		if err != nil && !errors.Is(err, syscall.ESRCH) {
			t.Fatal(err)
		}
		return errors.Is(err, syscall.ESRCH)
	}
}
