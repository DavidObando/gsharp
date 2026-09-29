// Copyright (C) GSharp Authors. All rights reserved.

//go:build !linux

package main

import (
	"errors"
	"os"
)

type ordinaryExecutableDirectory struct {
	path string
}

func prepareExecutableDirectory(path string, immutable bool, _ int64) (executableDirectory, error) {
	if immutable {
		return nil, errors.New("CGo executable identity binding is unsupported on this platform")
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		return nil, err
	}
	return &ordinaryExecutableDirectory{path: path}, nil
}

func (d *ordinaryExecutableDirectory) writePath() string     { return d.path }
func (d *ordinaryExecutableDirectory) executionPath() string { return d.path }
func (d *ordinaryExecutableDirectory) seal() error           { return nil }
func (d *ordinaryExecutableDirectory) close() error          { return nil }
