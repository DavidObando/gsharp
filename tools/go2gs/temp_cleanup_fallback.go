// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd && !dragonfly && !solaris

package main

func cleanupOwnedTempDir(ownedTempDir, func(), func(string)) error {
	return nil
}

func secureTempCleanupSupported() bool {
	return false
}
