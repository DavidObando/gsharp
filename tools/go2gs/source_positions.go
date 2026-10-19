// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"go/parser"
	"go/token"
	"os"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strings"
)

type sourceLineDirective struct {
	offset      int
	displayPath string
}

type sourcePositionMap struct {
	file           *token.File
	logicalRoot    string
	portable       string
	lineDirectives []sourceLineDirective
}

func newSourcePositionMap(portable string, data []byte) (*sourcePositionMap, error) {
	return newSourcePositionMapContext(context.Background(), portable, data)
}

func newSourcePositionMapContext(ctx context.Context, portable string, data []byte) (*sourcePositionMap, error) {
	scheme, payload, ok := strings.Cut(portable, "://")
	if !ok || payload == "" {
		return nil, errors.New("source position path has no portable scheme")
	}
	logicalRoot := filepath.Join(os.TempDir(), "go2gs-position-root", scheme)
	relative := filepath.FromSlash(payload)
	if scheme == "module" {
		at := strings.IndexByte(payload, '@')
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
	if err := checkAnalysisOperation(ctx, "source-position-parse", "before"); err != nil {
		return nil, err
	}
	parsed, _ := parser.ParseFile(
		fset, filename, data, parser.AllErrors|parser.ParseComments|parser.SkipObjectResolution)
	if err := checkAnalysisOperation(ctx, "source-position-parse", "after"); err != nil {
		return nil, err
	}
	var file *token.File
	fset.Iterate(func(candidate *token.File) bool {
		file = candidate
		return false
	})
	if file == nil || file.Size() != len(data) {
		return nil, errors.New("parser did not record source positions")
	}
	sourceDirectory, ok := relativeLinePath(logicalRoot, filepath.Dir(filename))
	if !ok {
		return nil, errors.New("source position path escaped its portable root")
	}
	lineDirectives := []sourceLineDirective{}
	if parsed != nil {
		for _, group := range parsed.Comments {
			for _, comment := range group.List {
				directiveFilename, ok := lineDirectiveFilename(comment.Text)
				if !ok {
					continue
				}
				displayPath := "line://" + opaqueLinePath(directiveFilename)
				if portableLinePath(directiveFilename) {
					displayPath = "line://" + pathpkg.Join(sourceDirectory, directiveFilename)
				}
				lineDirectives = append(lineDirectives, sourceLineDirective{
					offset: lineDirectiveActivationOffset(
						file, comment.Pos(), strings.HasPrefix(comment.Text, "//line "), data),
					displayPath: displayPath,
				})
			}
		}
	}
	sort.Slice(lineDirectives, func(i, j int) bool {
		return lineDirectives[i].offset < lineDirectives[j].offset
	})
	return &sourcePositionMap{
		file: file, logicalRoot: logicalRoot, portable: portable,
		lineDirectives: lineDirectives,
	}, nil
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
		index := sort.Search(len(positions.lineDirectives), func(index int) bool {
			return positions.lineDirectives[index].offset > rawStart.Offset
		})
		if index > 0 {
			displayPath = positions.lineDirectives[index-1].displayPath
		} else {
			displayPath = "line://" + logicalLinePath(
				positions.logicalRoot, rawStart.Filename, display.Filename)
		}
	}
	return rawStart, rawEnd, displayPath, display.Line, display.Column, lineDirective
}

func lineDirectiveActivationOffset(file *token.File, start token.Pos, line bool, data []byte) int {
	offset := file.Offset(start)
	if line {
		if newline := bytes.IndexByte(data[offset:], '\n'); newline >= 0 {
			return offset + newline + 1
		}
		return len(data)
	}
	if end := bytes.Index(data[offset:], []byte("*/")); end >= 0 {
		return offset + end + len("*/")
	}
	return len(data)
}

func logicalLinePath(root, rawFilename, displayFilename string) string {
	relative, withinRoot := relativeLinePath(root, displayFilename)
	if withinRoot && portableLinePath(relative) {
		return relative
	}
	opaque := displayFilename
	if withinRoot {
		if candidate, err := filepath.Rel(filepath.Dir(rawFilename), displayFilename); err == nil {
			opaque = candidate
		}
	}
	return opaqueLinePath(opaque)
}

func opaqueLinePath(value string) string {
	opaque := strings.ReplaceAll(value, "\\", "/")
	unc := strings.HasPrefix(opaque, "//")
	opaque = pathpkg.Clean(opaque)
	if unc && opaque != "/" {
		opaque = "/" + opaque
	}
	return "opaque/" + base64.RawURLEncoding.EncodeToString([]byte(opaque))
}

func lineDirectiveFilename(comment string) (string, bool) {
	switch {
	case strings.HasPrefix(comment, "//line "):
		comment = strings.TrimSpace(strings.TrimPrefix(comment, "//line "))
	case strings.HasPrefix(comment, "/*line ") && strings.HasSuffix(comment, "*/"):
		comment = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(comment, "/*line "), "*/"))
	default:
		return "", false
	}
	lastColon := strings.LastIndexByte(comment, ':')
	if lastColon <= 0 || !decimalDigits(comment[lastColon+1:]) {
		return "", false
	}
	filename := comment[:lastColon]
	if columnColon := strings.LastIndexByte(filename, ':'); columnColon > 0 &&
		decimalDigits(filename[columnColon+1:]) {
		filename = filename[:columnColon]
	}
	return filename, filename != ""
}

func decimalDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func relativeLinePath(root, filename string) (string, bool) {
	relative, err := filepath.Rel(root, filename)
	if err == nil && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative) {
		return slash(relative), true
	}
	return "", false
}

func portableLinePath(value string) bool {
	if value == "" || value == "." || value == ".." ||
		strings.HasPrefix(value, "/") || strings.HasPrefix(value, "../") ||
		pathpkg.Clean(value) != value {
		return false
	}
	for _, character := range value {
		if character == '/' || character == '.' || character == '-' || character == '_' ||
			character >= '0' && character <= '9' ||
			character >= 'A' && character <= 'Z' ||
			character >= 'a' && character <= 'z' {
			continue
		}
		return false
	}
	return true
}
