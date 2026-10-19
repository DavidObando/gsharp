// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"errors"
	"os"
)

func prepareStagedPublication(_ *os.File, _ os.FileMode) error {
	return nil
}

func syncRootPublication(root *os.Root, name string, expected os.FileInfo, mode os.FileMode) (err error) {
	file, err := root.OpenFile(name, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer func() {
		if file != nil {
			err = errors.Join(err, file.Close())
		}
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
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		file = nil
		return err
	}
	file = nil
	final, err := rootEntryStableInfo(root, name)
	if err != nil {
		return err
	}
	if !os.SameFile(expected, final) || !windowsModeMatches(mode, final.Mode()) {
		return errors.New("published output identity changed after flush")
	}
	return nil
}

func syncPathPublication(_ string, path string, expected os.FileInfo, mode os.FileMode) (err error) {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer func() {
		if file != nil {
			err = errors.Join(err, file.Close())
		}
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
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		file = nil
		return err
	}
	file = nil
	final, err := pathEntryStableInfo(path)
	if err != nil {
		return err
	}
	if !os.SameFile(expected, final) || !windowsModeMatches(mode, final.Mode()) {
		return errors.New("published output identity changed after flush")
	}
	return nil
}

func windowsModeMatches(requested, actual os.FileMode) bool {
	return (requested.Perm()&0o222 == 0) == (actual.Perm()&0o222 == 0)
}
