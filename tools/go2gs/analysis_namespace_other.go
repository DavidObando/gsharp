// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import (
	"errors"
	"os/exec"
)

const unsupportedExecutionBinding = "public analyze requires Linux descriptor-bound immutable cmd/go execution; secure execution binding is unsupported on this platform"

func publicAnalysisBindingSupported() error { return errors.New(unsupportedExecutionBinding) }

func configureAnalysisWorkerNamespace(_ *exec.Cmd) error {
	return errors.New(unsupportedExecutionBinding)
}
