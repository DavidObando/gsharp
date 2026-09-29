// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import (
	"errors"
	"os/exec"
)

func configureAnalysisWorkerNamespace(_ *exec.Cmd, enabled bool) error {
	if enabled {
		return errors.New("CGo executable identity binding is unsupported on this platform")
	}
	return nil
}
