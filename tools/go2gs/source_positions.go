// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"errors"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

type sourcePositionMap struct {
	file        *token.File
	logicalRoot string
	portable    string
}

func newSourcePositionMap(portable string, data []byte) (*sourcePositionMap, error) {
	scheme, payload, ok := strings.Cut(portable, "://")
	if !ok || payload == "" {
		return nil, errors.New("source position path has no portable scheme")
	}
	logicalRoot := filepath.Join(os.TempDir(), "go2gs-position-root", scheme)
	relative := filepath.FromSlash(payload)
	if scheme == "module" {
		at := strings.LastIndex(payload, "@")
		slashIndex := -1
		if at >= 0 {
			if remainder := strings.IndexByte(payload[at:], '/'); remainder >= 0 {
				slashIndex = at + remainder
			}
		}
		if at <= 0 || slashIndex < 0 || slashIndex == len(payload)-1 {
			return nil, errors.New("module source position path has no versioned file identity")
		}
		logicalRoot = filepath.Join(logicalRoot, filepath.FromSlash(payload[:slashIndex]))
		relative = filepath.FromSlash(payload[slashIndex+1:])
	}
	filename := filepath.Join(logicalRoot, relative)
	fset := token.NewFileSet()
	_, _ = parser.ParseFile(fset, filename, data, parser.AllErrors|parser.SkipObjectResolution)
	var file *token.File
	fset.Iterate(func(candidate *token.File) bool {
		file = candidate
		return false
	})
	if file == nil || file.Size() != len(data) {
		return nil, errors.New("parser did not record source positions")
	}
	return &sourcePositionMap{file: file, logicalRoot: logicalRoot, portable: portable}, nil
}

func (positions *sourcePositionMap) span(start, end int) (rawStart, rawEnd token.Position, displayPath string, displayLine, displayColumn int, lineDirective bool) {
	rawStart = positions.file.PositionFor(positions.file.Pos(start), false)
	rawEnd = positions.file.PositionFor(positions.file.Pos(end), false)
	display := positions.file.PositionFor(positions.file.Pos(start), true)
	lineDirective = display.Filename != rawStart.Filename ||
		display.Line != rawStart.Line ||
		display.Column != rawStart.Column
	displayPath = positions.portable
	if lineDirective {
		displayPath = "line://" + logicalLinePath(positions.logicalRoot, display.Filename)
	}
	return rawStart, rawEnd, displayPath, display.Line, display.Column, lineDirective
}

func logicalLinePath(root, filename string) string {
	relative, err := filepath.Rel(root, filename)
	if err == nil && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative) {
		return slash(relative)
	}
	return slash(filepath.Base(filename))
}
