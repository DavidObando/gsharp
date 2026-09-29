// Copyright (C) GSharp Authors. All rights reserved.

//go:build !unix

package main

import (
	"errors"
	"os"
	"os/exec"
)

func configureProcessTree(*exec.Cmd) error {
	return errors.New("process-tree isolation is unsupported on this platform")
}

func terminateProcessTree(*os.Process) error {
	return errors.New("process-tree isolation is unsupported on this platform")
}
