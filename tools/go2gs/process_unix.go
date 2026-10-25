// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Tests model a group signal that misses a concurrently created descendant.
var signalProcessGroup = syscall.Kill

func configureProcessTree(cmd *exec.Cmd, groupMode processGroupMode) error {
	if groupMode == processGroupOwn {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	}
	return nil
}

func terminateProcessTree(process *os.Process) error {
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := signalProcessGroup(-process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		// Darwin can report EPERM while a killed group awaits reaping.
		if err != nil && !errors.Is(err, syscall.EPERM) {
			return err
		}
		if err == nil {
			exited, inspectErr := processGroupMembersExited(process.Pid)
			if inspectErr != nil {
				return fmt.Errorf("inspect process group %d: %w", process.Pid, inspectErr)
			}
			if exited {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("process group %d did not terminate: %w", process.Pid, errors.Join(context.DeadlineExceeded, err))
		}
		time.Sleep(time.Millisecond)
	}
}

func cleanupProcessTree(process *os.Process) error {
	return terminateProcessTree(process)
}
