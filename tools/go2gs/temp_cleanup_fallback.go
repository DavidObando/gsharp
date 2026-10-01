// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux && !darwin && !windows

package main

import "errors"

func cleanupOwnedTempDir(ownedTempDir, func(), func(string)) error {
	return errors.New("secure temporary-directory cleanup is unsupported on this platform")
}

func secureTempCleanupSupported() bool {
	return false
}
