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
	"strconv"
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
				directiveFilename, offset, ok := recognizedLineDirective(
					file, filename, comment.Text, comment.Pos(), data)
				if !ok {
					continue
				}
				if directiveFilename == "" {
					continue
				}
				displayPath := "line://" + opaqueLinePath(directiveFilename)
				if portableLinePath(directiveFilename) {
					displayPath = "line://" + pathpkg.Join(sourceDirectory, directiveFilename)
				}
				lineDirectives = append(lineDirectives, sourceLineDirective{
					offset:      offset,
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

func recognizedLineDirective(
	file *token.File,
	filename string,
	comment string,
	start token.Pos,
	data []byte,
) (string, int, bool) {
	directiveFilename, line, column, lineComment, ok := parseLineDirective(comment)
	if !ok || lineComment && file.PositionFor(start, false).Column != 1 {
		return "", 0, false
	}
	offset := lineDirectiveActivationOffset(file, start, lineComment, data)
	if offset >= file.Size() {
		return "", 0, false
	}
	expectedFilename := directiveFilename
	if expectedFilename == "" && column > 0 {
		directiveOffset := file.Offset(start) + len("//line ")
		expectedFilename = file.PositionFor(file.Pos(directiveOffset), true).Filename
	} else if expectedFilename != "" {
		expectedFilename = filepath.Clean(expectedFilename)
		if !filepath.IsAbs(expectedFilename) {
			expectedFilename = filepath.Join(filepath.Dir(filename), expectedFilename)
		}
	}
	adjusted := file.PositionFor(file.Pos(offset), true)
	if adjusted.Filename != expectedFilename ||
		adjusted.Line != line ||
		adjusted.Column != column {
		return "", 0, false
	}
	return directiveFilename, offset, true
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

func parseLineDirective(comment string) (filename string, line, column int, lineComment, ok bool) {
	switch {
	case strings.HasPrefix(comment, "//line "):
		lineComment = true
	case strings.HasPrefix(comment, "/*line ") && strings.HasSuffix(comment, "*/"):
		comment = strings.TrimSuffix(comment, "*/")
	default:
		return "", 0, 0, false, false
	}
	comment = comment[len("//line "):]
	index, number, valid := trailingDirectiveDigits(comment)
	if index == 0 || !valid {
		return "", 0, 0, false, false
	}
	filename = comment[:index-1]
	line = number
	hasColumn := false
	if lineIndex, lineNumber, columnOK := trailingDirectiveDigits(filename); columnOK {
		hasColumn = true
		filename = filename[:lineIndex-1]
		line = lineNumber
		column = number
	}
	const maxLineColumn = 1 << 30
	if line == 0 || line > maxLineColumn ||
		hasColumn && (column == 0 || column > maxLineColumn) {
		return "", 0, 0, false, false
	}
	return filename, line, column, lineComment, true
}

func trailingDirectiveDigits(value string) (int, int, bool) {
	index := strings.LastIndexByte(value, ':')
	if index < 0 {
		return 0, 0, false
	}
	number, err := strconv.ParseUint(value[index+1:], 10, 0)
	return index + 1, int(number), err == nil
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
