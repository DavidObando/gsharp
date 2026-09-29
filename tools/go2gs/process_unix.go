// Copyright (C) GSharp Authors. All rights reserved.

//go:build unix

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureProcessTree(cmd *exec.Cmd, groupMode processGroupMode) error {
	if groupMode == processGroupOwn {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	}
	return nil
}

func terminateProcessTree(process *os.Process) error {
	err := syscall.Kill(-process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func cleanupProcessTree(process *os.Process) error {
	err := terminateProcessTree(process)
	if errors.Is(err, syscall.EPERM) {
		if signalErr := process.Signal(syscall.Signal(0)); errors.Is(signalErr, os.ErrProcessDone) {
			return nil
		}
	}
	return err
}
