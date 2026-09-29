// Copyright (C) GSharp Authors. All rights reserved.

//go:build linux

package main

import (
	"os"
	"strings"
	"syscall"
)

func execCapturedCompiler(target, argv0, prefix string) error {
	args := append([]string{argv0, "-B" + prefix + string(os.PathSeparator)}, os.Args[1:]...)
	return syscall.Exec(target, args, compilerEnvironment())
}

func compilerEnvironment() []string {
	var result []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case compilerTargetEnvironment, compilerArgv0Environment, compilerPrefixEnvironment:
			continue
		default:
			result = append(result, entry)
		}
	}
	return result
}
