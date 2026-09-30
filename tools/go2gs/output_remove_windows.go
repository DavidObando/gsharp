// Copyright (C) GSharp Authors. All rights reserved.

//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

func initializeOutputRemoval(*boundOutputRoot) error {
	return nil
}

func closeOutputRemoval(*boundOutputRoot) error {
	return nil
}

func removeOutputEntryIfSame(output *boundOutputRoot, name string, expected os.FileInfo) (bool, error) {
	if expected == nil || filepath.Base(name) != name ||
		(!expected.Mode().IsRegular() && !expected.IsDir()) {
		return false, errors.New("unsupported output entry for identity-bound removal")
	}
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return false, err
	}
	attributes := windows.OBJECT_ATTRIBUTES{
		Length:        uint32(unsafe.Sizeof(windows.OBJECT_ATTRIBUTES{})),
		RootDirectory: windows.Handle(output.operationRoot.Fd()),
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	options := uint32(windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT)
	if expected.IsDir() {
		options |= windows.FILE_DIRECTORY_FILE
	} else {
		options |= windows.FILE_NON_DIRECTORY_FILE
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(
		&handle,
		windows.DELETE|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		&attributes,
		&status,
		nil,
		0,
		windowsMetadataShare,
		windows.FILE_OPEN,
		options,
		0,
		0,
	)
	if err != nil {
		if status, ok := err.(windows.NTStatus); ok {
			err = status.Errno()
		}
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return false, nil
		}
		return false, err
	}
	file := os.NewFile(uintptr(handle), name)
	if file == nil {
		_ = windows.CloseHandle(handle)
		return false, errors.New("open output entry handle")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	if !os.SameFile(expected, info) {
		return false, nil
	}
	var handleInfo windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &handleInfo); err != nil {
		return false, err
	}
	if handleInfo.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return false, errors.New("output entry is a reparse point")
	}
	if outputBeforeDestructiveHook != nil {
		outputBeforeDestructiveHook(name)
	}
	disposition := struct{ Flags uint32 }{
		Flags: windows.FILE_DISPOSITION_DELETE |
			windows.FILE_DISPOSITION_POSIX_SEMANTICS |
			windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE,
	}
	if err := windows.SetFileInformationByHandle(
		handle,
		windows.FileDispositionInfoEx,
		(*byte)(unsafe.Pointer(&disposition)),
		uint32(unsafe.Sizeof(disposition)),
	); err != nil {
		return false, err
	}
	return true, nil
}
