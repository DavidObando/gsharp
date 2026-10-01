// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
)

func cleanupOwnedTempDir(directory ownedTempDir, beforeRename func(), afterTombstoneIdentity func(string)) (err error) {
	parentPath := filepath.Dir(directory.path)
	parent, err := os.OpenRoot(parentPath)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, parent.Close())
	}()

	name := filepath.Base(directory.path)
	current, err := parent.Lstat(name)
	if err != nil {
		return err
	}
	if !current.IsDir() || !os.SameFile(directory.info, current) {
		return errors.New("owned temporary directory changed during cleanup")
	}
	if beforeRename != nil {
		beforeRename()
	}
	current, err = parent.Lstat(name)
	if err != nil || !current.IsDir() || !os.SameFile(directory.info, current) {
		return errors.New("owned temporary directory changed during cleanup")
	}

	tombstoneName, err := uniquePlaceholderName()
	if err != nil {
		return err
	}
	if err := parent.Rename(name, tombstoneName); err != nil {
		return err
	}
	tombstonePath := filepath.Join(parentPath, tombstoneName)
	opened, err := parent.OpenRoot(tombstoneName)
	if err != nil {
		restoreWindowsRenamedDirectory(parent, tombstoneName, name)
		return err
	}
	defer func() {
		if opened != nil {
			err = errors.Join(err, opened.Close())
		}
	}()
	openedInfo, err := opened.Stat(".")
	if err != nil || !openedInfo.IsDir() || !os.SameFile(directory.info, openedInfo) {
		restoreWindowsRenamedDirectory(parent, tombstoneName, name)
		return errors.New("owned temporary directory changed during cleanup")
	}
	if afterTombstoneIdentity != nil {
		afterTombstoneIdentity(tombstonePath)
	}
	current, err = parent.Lstat(tombstoneName)
	if err != nil || !current.IsDir() || !os.SameFile(openedInfo, current) {
		return errors.New("temporary cleanup tombstone was replaced")
	}
	if err := parent.RemoveAll(tombstoneName); err != nil {
		return err
	}
	if err := opened.Close(); err != nil {
		return err
	}
	opened = nil
	if _, err := parent.Lstat(tombstoneName); !os.IsNotExist(err) {
		if err == nil {
			return errors.New("owned temporary directory remains after cleanup")
		}
		return err
	}
	return nil
}

func restoreWindowsRenamedDirectory(parent *os.Root, tombstone, original string) {
	if _, err := parent.Lstat(original); os.IsNotExist(err) {
		_ = parent.Rename(tombstone, original)
	}
}

func secureTempCleanupSupported() bool {
	return true
}
