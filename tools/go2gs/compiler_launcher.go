// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"errors"
	"os"
	"path/filepath"
)

const (
	compilerLauncherName      = "go2gs-compiler-launcher"
	compilerTargetEnvironment = "GO2GS_CCOMPILER_TARGET"
	compilerArgv0Environment  = "GO2GS_CCOMPILER_ARGV0"
	compilerPrefixEnvironment = "GO2GS_CCOMPILER_PREFIX"
)

func maybeRunCompilerLauncher() (bool, error) {
	if filepath.Base(os.Args[0]) != compilerLauncherName {
		return false, nil
	}
	target := os.Getenv(compilerTargetEnvironment)
	argv0 := os.Getenv(compilerArgv0Environment)
	prefix := os.Getenv(compilerPrefixEnvironment)
	if target == "" || argv0 == "" || prefix == "" {
		return true, errors.New("compiler launcher environment is incomplete")
	}
	return true, execCapturedCompiler(target, argv0, prefix)
}
