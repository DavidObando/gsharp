// Copyright (C) GSharp Authors. All rights reserved.

//go:build !windows

package main

import "os"

func syncRootPublication(root *os.Root, _ string, _ os.FileInfo) (err error) {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := directory.Close(); err == nil {
			err = closeErr
		}
	}()
	return directory.Sync()
}

func syncPathPublication(directoryPath, _ string, _ os.FileInfo) (err error) {
	directory, err := os.Open(directoryPath)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := directory.Close(); err == nil {
			err = closeErr
		}
	}()
	return directory.Sync()
}
