// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"errors"
	"os"
)

func syncRootPublication(root *os.Root, name string, expected os.FileInfo) (err error) {
	file, err := root.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, file.Close())
	}()
	current, err := file.Stat()
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(expected, current) {
		return errors.New("published output identity changed before flush")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	same, err := rootEntryMatches(root, name, expected)
	if err != nil {
		return err
	}
	if !same {
		return errors.New("published output identity changed after flush")
	}
	return nil
}

func syncPathPublication(_ string, path string, expected os.FileInfo) (err error) {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, file.Close())
	}()
	current, err := file.Stat()
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(expected, current) {
		return errors.New("published output identity changed before flush")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	final, err := pathEntryStableInfo(path)
	if err != nil {
		return err
	}
	if !os.SameFile(expected, final) {
		return errors.New("published output identity changed after flush")
	}
	return nil
}
