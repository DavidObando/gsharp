// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import "errors"

func execCapturedCompiler(_, _, _ string) error {
	return errors.New("captured C compiler execution is unsupported on this platform")
}
