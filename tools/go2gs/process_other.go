// Copyright (C) GSharp Authors. All rights reserved.

//go:build !unix

package main

import (
	"errors"
	"os"
	"os/exec"
)

func configureProcessTree(*exec.Cmd, bool) error {
	return errors.New("process-tree isolation is unsupported on this platform")
}

func ownsProcessGroup() bool {
	return false
}

func terminateProcessTree(*os.Process) error {
	return errors.New("process-tree isolation is unsupported on this platform")
}

func terminateInheritedProcessTree(process *os.Process) error {
	err := process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

func cleanupProcessTree(process *os.Process) error {
	return terminateProcessTree(process)
}
