// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux && !darwin && !windows

package main

import (
	"errors"
	"os"
)

func initializeOutputRemoval(*boundOutputRoot) error {
	return nil
}

func closeOutputRemoval(*boundOutputRoot) error {
	return nil
}

func removeOutputEntryIfSame(*boundOutputRoot, string, os.FileInfo) (bool, error) {
	return false, errors.New("identity-bound output removal is unsupported on this platform")
}
