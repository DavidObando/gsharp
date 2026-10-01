// Copyright (C) GSharp Authors. All rights reserved.

//go:build !unix && !windows

package main

import (
	"errors"
	"os"
)

func openMetadataFile(path string) (*os.File, error) {
	return os.Open(path)
}

func openRootedMetadataFile(root, relative string) (*os.File, error) {
	return nil, errors.New("secure descriptor-relative source reads are unsupported on this platform")
}

func walkRootedMetadataTree(root string, visit func(string, os.DirEntry) (bool, error)) error {
	return errors.New("secure descriptor-relative source traversal is unsupported on this platform")
}

func readRootedMetadataDirectory(path string) ([]os.DirEntry, error) {
	return nil, errors.New("secure descriptor-relative directory reads are unsupported on this platform")
}

func ensureOutputRoot(string, os.FileMode) error {
	return errors.New("secure output-root creation is unsupported on this platform")
}
