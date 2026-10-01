// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import (
	"errors"
	"os/exec"
)

func publicAnalysisBindingSupported() error { return errors.New(unsupportedExecutionBinding) }

func configureAnalysisWorkerNamespace(_ *exec.Cmd) error {
	return errors.New(unsupportedExecutionBinding)
}
