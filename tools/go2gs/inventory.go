// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"go/ast"
	"go/constant"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/tools/go/packages"
)

var overlayDiagnosticPath = regexp.MustCompile(`[^\s\n]*gocommand-[0-9]+[/\\][0-9]+-([^:\s\n]+)`)
var inventorySyntaxNodeTestHook func()

type inventoryBuilder struct {
	analysis              *Analysis
	sourceRoot            string
	goroot                string
	profile               Profile
	packageIDs            map[*packages.Package]string
	packagePathIDs        map[string]string
	typeOwners            map[*types.Package]*packages.Package
	typeIDs               map[types.Type]string
	objectIDs             map[objectRef]string
	fileIDs               map[string]string
	moduleIDs             map[string]string
	seenModules           map[string]bool
	seenFiles             map[string]bool
	seenTypes             map[string]bool
	seenSymbols           map[string]bool
	seenMethodSets        map[string]bool
	scopeIDs              map[*types.Scope]string
	scopeIndexes          map[string]*scopeIndex
	diagnosticSeq         int
	sourceSnapshot        map[string][]byte
	snapshotPortable      map[string]string
	inputDrift            map[string]bool
	snapshotFiles         map[string][]string
	selectedSnapshotFiles map[string][]string
	snapshotRoles         map[string]map[string]string
	diagnosticRedactions  []string
	memberIdentity        map[types.Object]string
	skipSemantics         map[*packages.Package]bool
	positionMaps          map[string]*sourcePositionMap
	maxRecords            int
	records               int
	err                   error
	ctx                   context.Context
}

func newInventoryBuilder(analysis *Analysis, sourceRoot, goroot string, profile Profile) *inventoryBuilder {
	return &inventoryBuilder{
		analysis: analysis, sourceRoot: sourceRoot, goroot: goroot, profile: profile,
		packageIDs: map[*packages.Package]string{}, packagePathIDs: map[string]string{}, typeIDs: map[types.Type]string{},
		typeOwners: map[*types.Package]*packages.Package{},
		objectIDs:  map[objectRef]string{}, fileIDs: map[string]string{},
		moduleIDs: map[string]string{}, seenModules: map[string]bool{},
		seenFiles: map[string]bool{}, seenTypes: map[string]bool{}, seenSymbols: map[string]bool{},
		seenMethodSets: map[string]bool{}, scopeIDs: map[*types.Scope]string{},
		scopeIndexes: map[string]*scopeIndex{},
		inputDrift:   map[string]bool{}, snapshotFiles: map[string][]string{},
		selectedSnapshotFiles: map[string][]string{}, snapshotPortable: map[string]string{},
		snapshotRoles: map[string]map[string]string{}, memberIdentity: map[types.Object]string{},
		skipSemantics: map[*packages.Package]bool{}, positionMaps: map[string]*sourcePositionMap{},
		maxRecords: profile.Limits.MaxRecords, records: analysisRecordCount(analysis),
		ctx: context.Background(),
	}
}

type objectRef struct {
	object    types.Object
	packageID string
}

func (b *inventoryBuilder) collectManifests(records []ManifestRecord) {
	b.analysis.Manifests = append(b.analysis.Manifests, records...)
}

func appendInventoryRecord[T any](b *inventoryBuilder, records *[]T, record T) bool {
	if !b.recordAvailable() {
		return false
	}
	*records = append(*records, record)
	b.records++
	return true
}

func (b *inventoryBuilder) recordAvailable() bool {
	if b.err != nil {
		return false
	}
	if b.records >= b.maxRecords {
		b.err = fmt.Errorf("record count exceeds limit %d", b.maxRecords)
		return false
	}
	return true
}

func analysisRecordCount(a *Analysis) int {
	return len(a.Modules) + len(a.Packages) + len(a.Files) + len(a.Types) + len(a.Symbols) + len(a.Nodes) +
		len(a.Constants) + len(a.Scopes) + len(a.Selections) + len(a.Calls) + len(a.MethodSets) +
		len(a.Instances) + len(a.Embeds) + len(a.GenerateDirectives) + len(a.Dependencies) +
		len(a.FeatureSites) + len(a.Diagnostics) + len(a.Blockers)
}

func (b *inventoryBuilder) indexPackages(packages []*packages.Package) {
	for _, pkg := range packages {
		id := stableID("package", packageCanonical(pkg))
		b.packageIDs[pkg] = id
		if packageVariant(pkg) == "ordinary" || b.packagePathIDs[pkg.PkgPath] == "" {
			b.packagePathIDs[pkg.PkgPath] = id
		}
		if pkg.Types != nil {
			owner := b.typeOwners[pkg.Types]
			if owner == nil || packageCanonical(pkg) < packageCanonical(owner) {
				b.typeOwners[pkg.Types] = pkg
			}
		}
	}
	b.indexDeclaredMembers(packages)
}

func (b *inventoryBuilder) addPackage(pkg *packages.Package) error {
	pkgID := b.packageIDs[pkg]
	moduleID, err := b.addModule(pkg.Module)
	if err != nil {
		return err
	}
	record := PackageRecord{
		ID: pkgID, ImportPath: pkg.PkgPath, Name: pkg.Name, Variant: packageVariant(pkg),
		ModuleID: moduleID, LanguageVersion: moduleGoVersion(pkg.Module),
		InventoryComplete: !pkg.IllTyped && len(pkg.Errors) == 0,
	}
	if b.inputDrift[packageInputKey(pkg)] {
		record.InventoryComplete = false
		b.block("input-drift", "selected package inputs changed while loading", []string{pkgID}, nil)
	}

	importKeys := make([]string, 0, len(pkg.Imports))
	for path := range pkg.Imports {
		importKeys = append(importKeys, path)
	}
	sort.Strings(importKeys)
	for _, path := range importKeys {
		imported := pkg.Imports[path]
		importedID := b.packageIDs[imported]
		if importedID != "" {
			record.ImportPackageIDs = append(record.ImportPackageIDs, importedID)
		}
		disposition := "translated-candidate"
		if imported.Module == nil {
			disposition = "standard-library"
		} else if !imported.Module.Main {
			disposition = "dependency-unclassified"
		}
		depID := stableID("dependency", pkgID+"\x00"+path)
		if !appendInventoryRecord(b, &b.analysis.Dependencies, DependencyRecord{
			ID: depID, FromPackageID: pkgID, ImportPath: path, PackageID: importedID, Disposition: disposition,
		}) {
			return b.err
		}
	}

	for _, pkgErr := range pkg.Errors {
		message, truncated := truncate(b.sanitizeDiagnosticMessage(pkg, pkgErr.Msg), b.profile.Limits.MaxStringBytes)
		position := b.portableDiagnosticPosition(pkg, pkgErr.Pos)
		id := stableID("diagnostic", pkgID+"\x00"+strconv.Itoa(int(pkgErr.Kind))+"\x00"+position+"\x00"+message)
		diagnostic := DiagnosticRecord{
			ID: id, Category: packageErrorCategory(pkgErr.Kind), Severity: "error",
			Message: message, Position: position, PackageID: pkgID, Truncated: truncated,
		}
		if !appendInventoryRecord(b, &b.analysis.Diagnostics, diagnostic) {
			return b.err
		}
		record.DiagnosticIDs = append(record.DiagnosticIDs, id)
		record.InventoryComplete = false
	}

	if !record.InventoryComplete {
		b.block("package-load", "package inventory is incomplete", []string{pkgID}, record.DiagnosticIDs)
	}

	if len(b.snapshotFiles[packageInputKey(pkg)]) > 0 {
		if err := b.addSourcePackage(pkg, &record); err != nil {
			return err
		}
	}

	if !b.skipSemantics[pkg] {
		b.addInitialization(pkg, &record)
	}
	sort.Strings(record.DiagnosticIDs)
	if !appendInventoryRecord(b, &b.analysis.Packages, record) {
		return b.err
	}
	return b.err
}

func (b *inventoryBuilder) sanitizeDiagnosticMessage(pkg *packages.Package, message string) string {
	extra := []messagePathRedaction{}
	if pkg.Module != nil && pkg.Module.Dir != "" {
		extra = append(extra, messagePathRedaction{pkg.Module.Dir, "<module>"})
		if pkg.Module.Replace != nil && pkg.Module.Replace.Dir != "" {
			extra = append(extra, messagePathRedaction{pkg.Module.Replace.Dir, "<replacement>"})
		}
	}
	return b.sanitizeMessage(message, extra...)
}

func (b *inventoryBuilder) sanitizeRecordedMessage(message string) string {
	return b.sanitizeMessage(message)
}

type messagePathRedaction struct {
	root        string
	placeholder string
}

type compiledMessagePathRedaction struct {
	match       string
	normalized  string
	placeholder string
	windows     bool
	filesystem  bool
	drive       bool
	unc         bool
}

func (b *inventoryBuilder) sanitizeMessage(message string, extra ...messagePathRedaction) string {
	message = overlayDiagnosticPath.ReplaceAllString(message, "<overlay>/$1")
	redactions := append([]messagePathRedaction{
		{b.sourceRoot, "<source>"},
		{b.goroot, "<goroot>"},
	}, extra...)
	for _, redaction := range b.diagnosticRedactions {
		redactions = append(redactions, messagePathRedaction{redaction, "<private-path>"})
	}
	return redactMessagePaths(message, redactions)
}

func redactMessagePaths(message string, redactions []messagePathRedaction) string {
	compiled := make([]compiledMessagePathRedaction, 0, len(redactions))
	for _, redaction := range redactions {
		if candidate, ok := compileMessagePathRedaction(redaction); ok {
			compiled = append(compiled, candidate)
		}
	}
	sort.Slice(compiled, func(i, j int) bool {
		if len(compiled[i].match) != len(compiled[j].match) {
			return len(compiled[i].match) > len(compiled[j].match)
		}
		if redactionPriority(compiled[i].placeholder) != redactionPriority(compiled[j].placeholder) {
			return redactionPriority(compiled[i].placeholder) < redactionPriority(compiled[j].placeholder)
		}
		if compiled[i].normalized != compiled[j].normalized {
			return compiled[i].normalized < compiled[j].normalized
		}
		return compiled[i].placeholder < compiled[j].placeholder
	})

	var result strings.Builder
	for offset := 0; offset < len(message); {
		if schemeEnd, uriEnd, ok := messageURIAt(message, offset, compiled); ok {
			if strings.EqualFold(message[offset:schemeEnd-1], "file") {
				result.WriteString(redactFileURI(message[offset:uriEnd], schemeEnd-offset, compiled))
			} else {
				result.WriteString(message[offset:uriEnd])
			}
			offset = uriEnd
			continue
		}
		matched := false
		for _, redaction := range compiled {
			end, replacement, ok := matchMessagePath(message, offset, redaction)
			if !ok {
				continue
			}
			result.WriteString(replacement)
			offset = end
			matched = true
			break
		}
		if matched {
			continue
		}
		_, size := utf8.DecodeRuneInString(message[offset:])
		result.WriteString(message[offset : offset+size])
		offset += size
	}
	return result.String()
}

func compileMessagePathRedaction(redaction messagePathRedaction) (compiledMessagePathRedaction, bool) {
	root := redaction.root
	if root == "" || redaction.placeholder == "" {
		return compiledMessagePathRedaction{}, false
	}
	windows := isWindowsAbsolutePath(root)
	if !windows && !strings.HasPrefix(root, "/") {
		return compiledMessagePathRedaction{}, false
	}
	normalized := root
	if windows {
		normalized = normalizeWindowsMessagePath(root)
	} else {
		normalized = pathpkg.Clean(root)
	}
	filesystem := normalized == "/"
	if normalized == "." || normalized == "" {
		return compiledMessagePathRedaction{}, false
	}
	return compiledMessagePathRedaction{
		match:       normalized,
		normalized:  normalized,
		placeholder: redaction.placeholder,
		windows:     windows,
		filesystem:  filesystem,
		drive:       windows && len(normalized) >= 2 && normalized[1] == ':',
		unc:         windows && strings.HasPrefix(normalized, "//"),
	}, true
}

func isWindowsAbsolutePath(value string) bool {
	if len(value) >= 3 && isASCIIAlpha(value[0]) && value[1] == ':' && isPathSeparator(rune(value[2])) {
		return true
	}
	return len(value) >= 2 && isPathSeparator(rune(value[0])) && isPathSeparator(rune(value[1]))
}

func normalizeWindowsMessagePath(value string) string {
	value = strings.ReplaceAll(value, `\`, "/")
	if strings.HasPrefix(value, "//") {
		value = "//" + strings.TrimPrefix(pathpkg.Clean("/"+strings.TrimLeft(value[2:], "/")), "/")
	} else {
		value = pathpkg.Clean(value)
	}
	if len(value) == 3 && value[1:] == ":/" {
		value = value[:2]
	} else if len(value) > 1 {
		value = strings.TrimRight(value, "/")
	}
	return foldWindowsMessagePath(value)
}

func foldWindowsMessagePath(value string) string {
	var result strings.Builder
	for offset := 0; offset < len(value); {
		current, size := utf8.DecodeRuneInString(value[offset:])
		if current == utf8.RuneError && size == 1 {
			result.WriteByte(value[offset])
		} else {
			result.WriteRune(unicode.ToLower(current))
		}
		offset += size
	}
	return result.String()
}

func matchMessagePath(message string, offset int, redaction compiledMessagePathRedaction) (int, string, bool) {
	return matchMessagePathWithBoundary(message, offset, redaction, true)
}

func matchMessagePathWithBoundary(
	message string,
	offset int,
	redaction compiledMessagePathRedaction,
	requireBoundary bool,
) (int, string, bool) {
	if requireBoundary && !messagePathBoundaryBefore(message, offset) {
		return 0, "", false
	}
	end := offset
	for expectedOffset := 0; expectedOffset < len(redaction.match); {
		if end >= len(message) {
			return 0, "", false
		}
		expected, expectedSize := utf8.DecodeRuneInString(redaction.match[expectedOffset:])
		actual, actualSize := utf8.DecodeRuneInString(message[end:])
		if expected == utf8.RuneError && expectedSize == 1 {
			if message[end] != redaction.match[expectedOffset] {
				return 0, "", false
			}
			expectedOffset++
			end++
			continue
		}
		if actual == utf8.RuneError && actualSize == 1 {
			return 0, "", false
		}
		if expected == '/' {
			if !isPathSeparator(actual) {
				return 0, "", false
			}
		} else if actual != expected && (!redaction.windows || !equalFoldRune(actual, expected)) {
			return 0, "", false
		}
		expectedOffset += expectedSize
		end += actualSize
	}
	if redaction.filesystem {
		if end < len(message) && !messagePathBoundaryAt(message, end) {
			return end, redaction.placeholder + "/", true
		}
		return end, redaction.placeholder, true
	}
	if end < len(message) {
		next, size := utf8.DecodeRuneInString(message[end:])
		if isPathSeparator(next) {
			if messagePathBoundaryAt(message, end+size) {
				end += size
			}
		} else if !isMessagePathDelimiter(next) {
			return 0, "", false
		}
	}
	return end, redaction.placeholder, true
}

func messageURIAt(
	message string,
	offset int,
	redactions []compiledMessagePathRedaction,
) (int, int, bool) {
	if offset > 0 {
		previous, _ := utf8.DecodeLastRuneInString(message[:offset])
		if !isMessagePathDelimiter(previous) {
			return 0, 0, false
		}
	}
	if offset >= len(message) || !isASCIIAlpha(message[offset]) {
		return 0, 0, false
	}
	schemeEnd := offset + 1
	for schemeEnd < len(message) && isURISchemeByte(message[schemeEnd]) {
		schemeEnd++
	}
	if schemeEnd >= len(message) || message[schemeEnd] != ':' {
		return 0, 0, false
	}
	fileScheme := strings.EqualFold(message[offset:schemeEnd], "file")
	if schemeEnd == offset+1 && schemeEnd+1 < len(message) &&
		isPathSeparator(rune(message[schemeEnd+1])) {
		for _, redaction := range redactions {
			if !redaction.drive {
				continue
			}
			if _, _, ok := matchMessagePathWithBoundary(message, offset, redaction, true); ok {
				return 0, 0, false
			}
		}
	}
	schemeEnd++
	uriEnd := schemeEnd
	opening, closing := messageURIWrapper(message, offset)
	depth := 0
	for uriEnd < len(message) {
		current, size := utf8.DecodeRuneInString(message[uriEnd:])
		if current == utf8.RuneError && size == 1 {
			if fileScheme {
				uriEnd++
				continue
			}
			break
		}
		if unicode.IsSpace(current) && !fileScheme {
			break
		}
		if closing != 0 {
			if current == closing {
				if depth == 0 {
					break
				}
				depth--
			} else if current == opening && opening != closing {
				depth++
			}
		} else if !fileScheme && strings.ContainsRune("\"`<>", current) {
			break
		}
		uriEnd += size
	}
	return schemeEnd, uriEnd, true
}

func messageURIWrapper(message string, offset int) (rune, rune) {
	if offset == 0 {
		return 0, 0
	}
	previous, _ := utf8.DecodeLastRuneInString(message[:offset])
	switch previous {
	case '"', '\'', '`':
		return previous, previous
	case '(':
		return previous, ')'
	case '[':
		return previous, ']'
	case '{':
		return previous, '}'
	case '<':
		return previous, '>'
	default:
		return 0, 0
	}
}

func isURISchemeByte(value byte) bool {
	return isASCIIAlpha(value) || value >= '0' && value <= '9' ||
		value == '+' || value == '-' || value == '.'
}

func redactFileURI(
	uri string,
	schemeEnd int,
	redactions []compiledMessagePathRedaction,
) string {
	const privateFileURI = "file:<private-path>"

	if schemeEnd > len(uri) {
		return privateFileURI
	}
	prefix := uri[:schemeEnd]
	remainder := uri[schemeEnd:]
	if strings.Contains(remainder, "%") {
		return privateFileURI
	}
	pathEnd := len(remainder)
	if index := strings.IndexAny(remainder, "?#"); index >= 0 {
		pathEnd = index
	}
	path, suffix := remainder[:pathEnd], remainder[pathEnd:]
	if path == "" || !isBenignFileURISuffix(suffix) {
		return privateFileURI
	}

	leadingSeparators := countLeadingSeparators(path)
	authorityEnd := -1
	authority := ""
	if leadingSeparators == 2 {
		if end := strings.IndexAny(path[2:], `/\`); end >= 0 {
			authorityEnd = end + 2
			authority = path[2:authorityEnd]
		}
	}
	localhostAuthority := authorityEnd >= 0 && strings.EqualFold(authority, "localhost")
	if hasUnsafeFileURIPathComponent(path, localhostAuthority) {
		return privateFileURI
	}

	if hasRepeatedPathSeparators(path[leadingSeparators:]) {
		return privateFileURI
	}
	if leadingSeparators >= 3 {
		if leadingSeparators > 3 && isWindowsAbsolutePath(path[leadingSeparators:]) {
			return privateFileURI
		}
		if redacted, ok := redactFileURIPath(path, leadingSeparators, path[:leadingSeparators], redactions, func(value compiledMessagePathRedaction) bool {
			return value.drive
		}); ok {
			return prefix + redacted + suffix
		}
		if leadingSeparators == 3 && isWindowsAbsolutePath(path[leadingSeparators:]) {
			return privateFileURI
		}
		if redacted, ok := redactFileURIPath(path, leadingSeparators-1, path[:leadingSeparators-1], redactions, func(value compiledMessagePathRedaction) bool {
			return !value.windows
		}); ok {
			return prefix + redacted + suffix
		}
		if leadingSeparators > 3 {
			return privateFileURI
		}
		return uri
	}
	if leadingSeparators == 2 {
		if authorityEnd < 0 {
			return privateFileURI
		}
		if localhostAuthority {
			if authorityEnd+1 >= len(path) || isPathSeparator(rune(path[authorityEnd+1])) {
				return privateFileURI
			}
			localPath := path[authorityEnd+1:]
			if isWindowsAbsolutePath(localPath) {
				if redacted, ok := redactFileURIPath(path, authorityEnd+1, path[:authorityEnd+1], redactions, func(value compiledMessagePathRedaction) bool {
					return value.drive
				}); ok {
					return prefix + redacted + suffix
				}
				return privateFileURI
			}
			if redacted, ok := redactFileURIPath(path, authorityEnd, path[:authorityEnd+1], redactions, func(value compiledMessagePathRedaction) bool {
				return !value.windows
			}); ok {
				return prefix + redacted + suffix
			}
			if redacted, ok := redactFileURIPath(path, 0, path[:2], redactions, func(value compiledMessagePathRedaction) bool {
				return value.unc
			}); ok {
				return prefix + redacted + suffix
			}
			return uri
		}
		if isWindowsDriveAuthority(authority) {
			if redacted, ok := redactFileURIPath(path, 2, path[:2], redactions, func(value compiledMessagePathRedaction) bool {
				return value.drive
			}); ok {
				return prefix + redacted + suffix
			}
			return privateFileURI
		}
		if strings.ContainsAny(authority, ":@[]") {
			return privateFileURI
		}
		if redacted, ok := redactFileURIPath(path, 0, path[:2], redactions, func(value compiledMessagePathRedaction) bool {
			return value.unc
		}); ok {
			return prefix + redacted + suffix
		}
		return privateFileURI
	}
	if leadingSeparators == 0 && isWindowsAbsolutePath(path) {
		if redacted, ok := redactFileURIPath(path, 0, "", redactions, func(value compiledMessagePathRedaction) bool {
			return value.drive
		}); ok {
			return prefix + redacted + suffix
		}
		return privateFileURI
	}
	if leadingSeparators == 1 && isWindowsAbsolutePath(path[1:]) {
		if redacted, ok := redactFileURIPath(path, 1, path[:1], redactions, func(value compiledMessagePathRedaction) bool {
			return value.drive
		}); ok {
			return prefix + redacted + suffix
		}
		return privateFileURI
	}
	if isPathSeparator(rune(path[0])) {
		if redacted, ok := redactFileURIPath(path, 0, "", redactions, func(value compiledMessagePathRedaction) bool {
			return !value.windows
		}); ok {
			return prefix + redacted + suffix
		}
		return uri
	}
	return privateFileURI
}

func isWindowsDriveAuthority(value string) bool {
	return len(value) == 2 && isASCIIAlpha(value[0]) && value[1] == ':'
}

func hasRepeatedPathSeparators(value string) bool {
	for index := 1; index < len(value); index++ {
		if isPathSeparator(rune(value[index-1])) && isPathSeparator(rune(value[index])) {
			return true
		}
	}
	return false
}

func hasUnsafeFileURIPathComponent(value string, localhostAuthority bool) bool {
	componentStart := 0
	nonEmptyComponents := 0
	firstComponent := ""
	for index := 0; index <= len(value); index++ {
		if index < len(value) && !isPathSeparator(rune(value[index])) {
			continue
		}
		component := value[componentStart:index]
		if component != "" {
			if isWindowsDriveAuthority(component) {
				if nonEmptyComponents != 0 &&
					(nonEmptyComponents != 1 || !localhostAuthority ||
						!strings.EqualFold(firstComponent, "localhost")) {
					return true
				}
			} else if !isStrictFileURIPathComponent(component) {
				return true
			}
			if nonEmptyComponents == 0 {
				firstComponent = component
			}
			nonEmptyComponents++
		}
		componentStart = index + 1
	}
	return false
}

func isStrictFileURIPathComponent(value string) bool {
	if value == "." || value == ".." {
		return false
	}
	for len(value) > 0 {
		current, size := utf8.DecodeRuneInString(value)
		if current == utf8.RuneError && size == 1 {
			return false
		}
		if current <= unicode.MaxASCII {
			if !isASCIIAlphaNumeric(byte(current)) &&
				!strings.ContainsRune("-._~", current) {
				return false
			}
		} else if !unicode.IsLetter(current) && !unicode.IsNumber(current) {
			return false
		}
		value = value[size:]
	}
	return true
}

func isBenignFileURISuffix(value string) bool {
	if value == "" {
		return true
	}
	if value[0] == '#' {
		return isBenignFileURIToken(value[1:])
	}
	if value[0] != '?' {
		return false
	}
	query := value[1:]
	fragment := ""
	if fragmentStart := strings.IndexByte(query, '#'); fragmentStart >= 0 {
		fragment = query[fragmentStart+1:]
		query = query[:fragmentStart]
		if !isBenignFileURIToken(fragment) {
			return false
		}
	}
	return isBenignFileURIQuery(query)
}

func isBenignFileURIQuery(value string) bool {
	if value == "" {
		return false
	}
	keys := make(map[string]struct{})
	for _, component := range strings.Split(value, "&") {
		separator := strings.IndexByte(component, '=')
		if separator <= 0 || separator != strings.LastIndexByte(component, '=') ||
			!isBenignFileURIToken(component[:separator]) ||
			!isBenignFileURIToken(component[separator+1:]) {
			return false
		}
		key := component[:separator]
		if _, exists := keys[key]; exists {
			return false
		}
		keys[key] = struct{}{}
	}
	return true
}

func isBenignFileURIToken(value string) bool {
	if value == "" || value == "." || value == ".." ||
		!isASCIIAlphaNumeric(value[0]) ||
		!isASCIIAlphaNumeric(value[len(value)-1]) {
		return false
	}
	for index := 1; index+1 < len(value); index++ {
		current := value[index]
		if !isASCIIAlphaNumeric(current) && !strings.ContainsRune("-._~", rune(current)) {
			return false
		}
	}
	return true
}

func isASCIIAlphaNumeric(value byte) bool {
	return isASCIIAlpha(value) || value >= '0' && value <= '9'
}

func redactFileURIPath(
	path string,
	offset int,
	preservedPrefix string,
	redactions []compiledMessagePathRedaction,
	accept func(compiledMessagePathRedaction) bool,
) (string, bool) {
	for _, redaction := range redactions {
		if !accept(redaction) {
			continue
		}
		end, replacement, ok := matchMessagePathWithBoundary(path, offset, redaction, false)
		if ok {
			return preservedPrefix + replacement + path[end:], true
		}
	}
	return "", false
}

func countLeadingSeparators(value string) int {
	count := 0
	for count < len(value) && isPathSeparator(rune(value[count])) {
		count++
	}
	return count
}

func equalFoldRune(left, right rune) bool {
	if left == right {
		return true
	}
	for current := unicode.SimpleFold(left); current != left; current = unicode.SimpleFold(current) {
		if current == right {
			return true
		}
	}
	return false
}

func messagePathBoundaryBefore(message string, offset int) bool {
	if offset == 0 {
		return true
	}
	previous, _ := utf8.DecodeLastRuneInString(message[:offset])
	return isMessagePathDelimiter(previous)
}

func messagePathBoundaryAt(message string, offset int) bool {
	if offset >= len(message) {
		return true
	}
	next, _ := utf8.DecodeRuneInString(message[offset:])
	return isMessagePathDelimiter(next)
}

func isMessagePathDelimiter(value rune) bool {
	return unicode.IsSpace(value) || strings.ContainsRune("\"'`()[]{}<>,;:=!?", value)
}

func isPathSeparator(value rune) bool {
	return value == '/' || value == '\\'
}

func isASCIIAlpha(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
}

func redactionPriority(placeholder string) int {
	switch placeholder {
	case "<source>":
		return 0
	case "<goroot>":
		return 1
	case "<replacement>":
		return 2
	case "<module>":
		return 3
	default:
		return 4
	}
}

func (b *inventoryBuilder) portableDiagnosticPosition(pkg *packages.Package, position string) string {
	path, suffix := splitDiagnosticPosition(position)
	if path == "" {
		return position
	}
	if !filepath.IsAbs(path) {
		clean := filepath.Clean(path)
		if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			clean = filepath.Base(clean)
		}
		return "line://" + slash(clean) + suffix
	}
	if portable, err := b.portablePath(pkg, path); err == nil {
		return portable + suffix
	}
	return "external://" + slash(filepath.Base(path)) + suffix
}

func splitDiagnosticPosition(position string) (string, string) {
	last := strings.LastIndexByte(position, ':')
	if last < 0 {
		return "", ""
	}
	if _, err := strconv.Atoi(position[last+1:]); err != nil {
		return "", ""
	}
	start := last
	if previous := strings.LastIndexByte(position[:last], ':'); previous >= 0 {
		if _, err := strconv.Atoi(position[previous+1 : last]); err == nil {
			start = previous
		}
	}
	return position[:start], position[start:]
}

func (b *inventoryBuilder) addSourcePackage(pkg *packages.Package, record *PackageRecord) error {
	syntaxPaths := syntaxFilePaths(pkg)
	compiled := stringSet(syntaxPaths)
	active := stringSet(pkg.GoFiles)
	embed := stringSet(pkg.EmbedFiles)
	activeCgo := b.packageImportsC(pkg)
	key := packageInputKey(pkg)
	reachableHeaders, unsafeIncludes, err := selectedNativeIncludesContext(
		b.ctx,
		pkg,
		selectedNativePaths(b.selectedSnapshotFiles[key], b.snapshotRoles[key]),
		b.sourceSnapshot,
	)
	if err != nil {
		return err
	}
	nativeConsumer := hasSelectedNativeConsumer(pkg, activeCgo)
	for _, path := range b.selectedSnapshotFiles[packageInputKey(pkg)] {
		if b.snapshotRoles[packageInputKey(pkg)][path] == "native" {
			nativeConsumer = true
			break
		}
	}
	all := append([]string{}, pkg.GoFiles...)
	all = append(all, pkg.IgnoredFiles...)
	all = append(all, pkg.OtherFiles...)
	all = append(all, pkg.EmbedFiles...)
	all = append(all, b.snapshotFiles[packageInputKey(pkg)]...)
	all = uniqueSorted(all)
	newFiles := 0
	for _, path := range all {
		if _, captured := b.sourceSnapshot[path]; captured && b.fileIDs[b.fileKey(pkg, path)] == "" {
			newFiles++
		}
	}
	if len(b.seenFiles)+newFiles > b.profile.Limits.MaxFiles {
		return fmt.Errorf("file count exceeds limit %d", b.profile.Limits.MaxFiles)
	}
	if nativeConsumer {
		b.block("native", "selected package requires native, assembly, or CGo build inputs; M0 records them but does not authorize the native toolchain", []string{record.ID}, nil)
		record.InventoryComplete = false
	}
	if unsafeIncludes {
		b.block("native-include", "selected native source has an unsafe, unavailable, or malformed local quoted include/raw literal", []string{record.ID}, nil)
		record.InventoryComplete = false
	}
	unmappedCgo := activeCgo
	if unmappedCgo {
		b.block("cgo", "selected package uses CGo-transformed syntax that M0 cannot faithfully relate to original source", []string{record.ID}, nil)
		record.InventoryComplete = false
		b.skipSemantics[pkg] = true
	}
	for _, path := range all {
		if b.err != nil {
			return b.err
		}
		if _, captured := b.sourceSnapshot[path]; !captured {
			if unmappedCgo {
				continue
			}
			b.block("input-snapshot", "selected package input was not captured before loading", []string{record.ID}, nil)
			record.InventoryComplete = false
			continue
		}
		role, reason := "active", ""
		switch {
		case embed[path]:
			role, reason = "embed", "selected by go:embed"
		case contains(pkg.OtherFiles, path):
			if activeCgo || !nativeHeader(path) || reachableHeaders[path] {
				role, reason = "native", "selected non-Go build input"
			} else {
				role, reason = "ignored", "no selected native source can consume this header"
			}
		case contains(pkg.IgnoredFiles, path):
			key := packageInputKey(pkg)
			snapshotRole := b.snapshotRoles[key][path]
			if contains(b.selectedSnapshotFiles[key], path) && snapshotRole != "" && snapshotRole != "ignored" {
				role, reason = snapshotRole, "selected from the immutable source mirror under the requested CGo profile"
			} else {
				role, reason = "ignored", "excluded by current build constraints or file naming"
			}
		case strings.HasSuffix(path, "_test.go"):
			role, reason = "test", "selected test source for this package variant"
		case compiled[path]:
			role = "compiled"
		case active[path]:
			role = "active"
		default:
			role, reason = "input", "reported by go/packages"
		}
		key := packageInputKey(pkg)
		if !contains(pkg.GoFiles, path) &&
			!contains(pkg.IgnoredFiles, path) && !contains(pkg.OtherFiles, path) && !contains(pkg.EmbedFiles, path) {
			snapshotRole := b.snapshotRoles[key][path]
			if contains(b.selectedSnapshotFiles[key], path) {
				if snapshotRole != "" {
					role = snapshotRole
				}
				reason = "captured before package loading"
			} else {
				role = "ignored"
				reason = "discovered defensively but inactive in the selected profile"
			}
			if reachableHeaders[path] {
				role = "native"
				reason = "included by selected native source"
			}
		}
		fileID, err := b.addFile(pkg, path, role, reason)
		if err != nil {
			return err
		}
		record.FileIDs = append(record.FileIDs, fileID)
	}
	if unmappedCgo {
		sort.Strings(record.FileIDs)
		return nil
	}
	for _, path := range syntaxPaths {
		if fileID := b.fileIDs[b.fileKey(pkg, path)]; fileID != "" {
			record.CompiledFileIDs = append(record.CompiledFileIDs, fileID)
		}
	}

	b.addScopes(pkg)
	if b.err != nil {
		return b.err
	}
	for index, file := range pkg.Syntax {
		if b.err != nil {
			return b.err
		}
		if index >= len(syntaxPaths) {
			break
		}
		path := syntaxPaths[index]
		fileID := b.fileIDs[b.fileKey(pkg, path)]
		if fileID == "" {
			continue
		}
		b.markGenerated(fileID, generatedFile(file))
		b.addGenerateDirectives(pkg, fileID, file)
		b.addSyntax(pkg, fileID, file)
	}
	b.addSelections(pkg)
	if b.err != nil {
		return b.err
	}
	b.addInstances(pkg)
	if b.err != nil {
		return b.err
	}
	b.addMethodSets(pkg)
	if b.err != nil {
		return b.err
	}
	b.addEmbeds(pkg)
	if b.err != nil {
		return b.err
	}
	sort.Strings(record.FileIDs)
	sort.Strings(record.ImportPackageIDs)
	return nil
}

func (b *inventoryBuilder) packageImportsC(pkg *packages.Package) bool {
	key := packageInputKey(pkg)
	for _, path := range b.selectedSnapshotFiles[packageInputKey(pkg)] {
		role := b.snapshotRoles[key][path]
		if (role == "active" || role == "compiled") && b.snapshotFileImportsC(path) {
			return true
		}
	}
	return false
}

func (b *inventoryBuilder) snapshotFileImportsC(path string) bool {
	if filepath.Ext(path) != ".go" {
		return false
	}
	_, captured := b.sourceSnapshot[path]
	if !captured {
		return false
	}
	importsC, err := pathsImportCContext(b.ctx, []string{path}, b.sourceSnapshot)
	if err != nil {
		b.err = err
		return false
	}
	return importsC
}

func hasSelectedNativeConsumer(pkg *packages.Package, activeCgo bool) bool {
	for _, path := range pkg.OtherFiles {
		if activeCgo || !nativeHeader(path) {
			return true
		}
	}
	return false
}

func pathsImportC(paths []string, snapshot map[string][]byte) bool {
	importsC, _ := pathsImportCContext(context.Background(), paths, snapshot)
	return importsC
}

func pathsImportCContext(ctx context.Context, paths []string, snapshot map[string][]byte) (bool, error) {
	for _, path := range paths {
		if err := checkAnalysisOperation(ctx, "cgo-import-parse", "file"); err != nil {
			return false, err
		}
		if filepath.Ext(path) != ".go" {
			continue
		}
		if err := checkAnalysisOperation(ctx, "cgo-import-parse", "before"); err != nil {
			return false, err
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, snapshot[path], parser.ImportsOnly)
		if contextErr := checkAnalysisOperation(ctx, "cgo-import-parse", "after"); contextErr != nil {
			return false, contextErr
		}
		if err != nil {
			continue
		}
		for _, imported := range file.Imports {
			if err := checkAnalysisOperation(ctx, "cgo-import-parse", "import"); err != nil {
				return false, err
			}
			if imported.Path.Value == `"C"` {
				return true, nil
			}
		}
	}
	return false, nil
}

func selectedNativeIncludes(pkg *packages.Package, selected []string, snapshot map[string][]byte) (map[string]bool, bool) {
	reachable, unsafe, _ := selectedNativeIncludesContext(context.Background(), pkg, selected, snapshot)
	return reachable, unsafe
}

func selectedNativeIncludesContext(ctx context.Context, pkg *packages.Package, selected []string, snapshot map[string][]byte) (map[string]bool, bool, error) {
	reachable := map[string]bool{}
	pending := []string{}
	for _, path := range append(append([]string{}, pkg.OtherFiles...), selected...) {
		if err := checkAnalysisOperation(ctx, "native-include-scan", "root"); err != nil {
			return nil, false, err
		}
		if nativeIncludeCarrier(path) {
			pending = append(pending, path)
		}
	}
	pending = uniqueSorted(pending)
	visited := map[string]bool{}
	unsafe := false
	for len(pending) > 0 {
		if err := checkAnalysisOperation(ctx, "native-include-scan", "file"); err != nil {
			return nil, false, err
		}
		path := pending[0]
		pending = pending[1:]
		if visited[path] {
			continue
		}
		visited[path] = true
		data, captured := snapshot[path]
		if !captured {
			unsafe = true
			continue
		}
		includes, malformed := localQuotedIncludes(data)
		if err := checkAnalysisOperation(ctx, "native-include-scan", "after-parse"); err != nil {
			return nil, false, err
		}
		if malformed {
			unsafe = true
			continue
		}
		for _, include := range includes {
			if err := checkAnalysisOperation(ctx, "native-include-scan", "include"); err != nil {
				return nil, false, err
			}
			target, ok := resolveLocalInclude(pkg.Dir, path, include)
			if !ok {
				unsafe = true
				continue
			}
			if _, captured := snapshot[target]; !captured {
				unsafe = true
				continue
			}
			if !reachable[target] {
				reachable[target] = true
				pending = append(pending, target)
				sort.Strings(pending)
			}
		}
	}
	return reachable, unsafe, nil
}

func selectedNativePaths(paths []string, roles map[string]string) []string {
	selected := make([]string, 0, len(paths))
	for _, path := range paths {
		if roles[path] == "native" {
			selected = append(selected, path)
		}
	}
	return selected
}

func localQuotedIncludes(data []byte) ([]string, bool) {
	data, malformed := stripCCommentsAndRawStrings(spliceCPreprocessorLines(data))
	if malformed {
		return nil, true
	}
	var result []string
	for len(data) > 0 {
		line := data
		if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
			line, data = data[:newline], data[newline+1:]
		} else {
			data = nil
		}
		i := skipHorizontalSpace(line, 0)
		if i >= len(line) || line[i] != '#' {
			continue
		}
		i = skipHorizontalSpace(line, i+1)
		const keyword = "include"
		if !bytes.HasPrefix(line[i:], []byte(keyword)) {
			continue
		}
		i += len(keyword)
		if i < len(line) && isIdentifierByte(line[i]) {
			continue
		}
		i = skipHorizontalSpace(line, i)
		if i >= len(line) || line[i] != '"' {
			continue
		}
		start := i + 1
		end := bytes.IndexByte(line[start:], '"')
		if end < 0 {
			continue
		}
		result = append(result, string(line[start:start+end]))
	}
	sort.Strings(result)
	return result, false
}

func spliceCPreprocessorLines(data []byte) []byte {
	const (
		cNormal = iota
		cLineComment
		cBlockComment
		cString
		cCharacter
	)
	result := make([]byte, 0, len(data))
	state := cNormal
	escaped := false
	for i := 0; i < len(data); {
		if state == cNormal {
			if prefixLength := cxxRawStringPrefix(data, i); prefixLength > 0 {
				end, ok := cxxRawStringEnd(data, i+prefixLength)
				if !ok {
					return append(result, data[i:]...)
				}
				result = append(result, data[i:end]...)
				i = end
				continue
			}
		}
		if data[i] == '\\' && i+1 < len(data) && data[i+1] == '\n' {
			i += 2
			continue
		}
		if data[i] == '\\' && i+2 < len(data) && data[i+1] == '\r' && data[i+2] == '\n' {
			i += 3
			continue
		}
		value := data[i]
		previous := byte(0)
		if len(result) > 0 {
			previous = result[len(result)-1]
		}
		result = append(result, value)
		i++
		if state == cNormal {
			if previous == '/' && value == '/' {
				state = cLineComment
			} else if previous == '/' && value == '*' {
				state = cBlockComment
			} else if value == '"' {
				state = cString
				escaped = false
			} else if value == '\'' {
				state = cCharacter
				escaped = false
			}
		} else if state == cLineComment && value == '\n' {
			state = cNormal
		} else if state == cBlockComment && previous == '*' && value == '/' {
			state = cNormal
		} else if state == cString || state == cCharacter {
			if escaped {
				escaped = false
			} else if value == '\\' {
				escaped = true
			} else if state == cString && value == '"' || state == cCharacter && value == '\'' {
				state = cNormal
			}
		}
	}
	return result
}

func stripCCommentsAndRawStrings(data []byte) ([]byte, bool) {
	result := make([]byte, 0, len(data))
	for i := 0; i < len(data); {
		if prefixLength := cxxRawStringPrefix(data, i); prefixLength > 0 {
			end, ok := cxxRawStringEnd(data, i+prefixLength)
			if !ok {
				return nil, true
			}
			result = append(result, ' ')
			for _, value := range data[i:end] {
				if value == '\n' {
					result = append(result, '\n')
				}
			}
			i = end
			continue
		}
		if i+1 < len(data) && data[i] == '/' && data[i+1] == '/' {
			result = append(result, ' ')
			i += 2
			for i < len(data) && data[i] != '\n' {
				i++
			}
			continue
		}
		if i+1 < len(data) && data[i] == '/' && data[i+1] == '*' {
			result = append(result, ' ')
			i += 2
			for i+1 < len(data) && (data[i] != '*' || data[i+1] != '/') {
				if data[i] == '\n' {
					result = append(result, '\n')
				}
				i++
			}
			if i+1 < len(data) {
				i += 2
			} else {
				i = len(data)
			}
			continue
		}
		if data[i] == '"' || data[i] == '\'' {
			quote := data[i]
			result = append(result, data[i])
			i++
			for i < len(data) {
				result = append(result, data[i])
				if data[i] == '\\' && i+1 < len(data) {
					i++
					result = append(result, data[i])
				} else if data[i] == quote {
					i++
					break
				}
				i++
			}
			continue
		}
		result = append(result, data[i])
		i++
	}
	return result, false
}

func cxxRawStringPrefix(data []byte, index int) int {
	if index > 0 && isIdentifierByte(data[index-1]) {
		return 0
	}
	for _, prefix := range [...]string{`u8R"`, `uR"`, `UR"`, `LR"`, `R"`} {
		if bytes.HasPrefix(data[index:], []byte(prefix)) {
			return len(prefix)
		}
	}
	return 0
}

func cxxRawStringEnd(data []byte, delimiterStart int) (int, bool) {
	const maxDelimiterLength = 16
	delimiterEnd := delimiterStart
	for delimiterEnd < len(data) && data[delimiterEnd] != '(' {
		value := data[delimiterEnd]
		if delimiterEnd-delimiterStart == maxDelimiterLength ||
			value < 0x21 || value > 0x7e || value == ')' || value == '\\' {
			return 0, false
		}
		delimiterEnd++
	}
	if delimiterEnd >= len(data) {
		return 0, false
	}
	delimiter := data[delimiterStart:delimiterEnd]
	terminator := append(append(make([]byte, 0, len(delimiter)+2), ')'), delimiter...)
	terminator = append(terminator, '"')
	end := bytes.Index(data[delimiterEnd+1:], terminator)
	if end < 0 {
		return 0, false
	}
	return delimiterEnd + 1 + end + len(terminator), true
}

func skipHorizontalSpace(data []byte, index int) int {
	for index < len(data) && (data[index] == ' ' || data[index] == '\t' || data[index] == '\r' || data[index] == '\f' || data[index] == '\v') {
		index++
	}
	return index
}

func isIdentifierByte(value byte) bool {
	return value == '_' || value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9'
}

func resolveLocalInclude(packageDir, includingPath, include string) (string, bool) {
	if packageDir == "" || include == "" || filepath.IsAbs(include) ||
		filepath.VolumeName(include) != "" || strings.ContainsRune(include, '\\') {
		return "", false
	}
	target := filepath.Clean(filepath.Join(filepath.Dir(includingPath), filepath.FromSlash(include)))
	if _, err := pathWithin(packageDir, target); err != nil {
		return "", false
	}
	return target, true
}

func nativeHeader(path string) bool {
	return classifyGoPackageInputExtension(path)&goPackageInputHeader != 0
}

func nativeIncludeCarrier(path string) bool {
	return classifyGoPackageInputExtension(path)&goPackageInputIncludeCarrier != 0
}

type goPackageInputKind uint8

const (
	goPackageInputGo goPackageInputKind = 1 << iota
	goPackageInputNative
	goPackageInputHeader
	goPackageInputIncludeCarrier
	goPackageInputCgoOnly
)

func classifyGoPackageInput(path string) goPackageInputKind {
	name := filepath.Base(path)
	if name == "" || name[0] == '.' || name[0] == '_' {
		return 0
	}
	return classifyGoPackageInputExtension(path)
}

func classifyGoPackageInputExtension(path string) goPackageInputKind {
	switch filepath.Ext(path) {
	case ".go":
		return goPackageInputGo
	case ".h", ".hh", ".hpp", ".hxx":
		return goPackageInputNative | goPackageInputHeader | goPackageInputIncludeCarrier
	case ".c", ".cc", ".cpp", ".cxx", ".m",
		".f", ".F", ".for", ".f90", ".swig", ".swigcxx":
		return goPackageInputNative | goPackageInputIncludeCarrier | goPackageInputCgoOnly
	case ".s":
		return goPackageInputNative | goPackageInputIncludeCarrier
	case ".S", ".sx":
		return goPackageInputNative | goPackageInputIncludeCarrier | goPackageInputCgoOnly
	case ".syso":
		return goPackageInputNative
	default:
		return 0
	}
}

func recognizedGoPackageInput(path string) bool {
	return classifyGoPackageInput(path) != 0
}

func recognizedNativePackageInput(path string) bool {
	return classifyGoPackageInput(path)&goPackageInputNative != 0
}

func (b *inventoryBuilder) addFile(pkg *packages.Package, path, role, reason string) (string, error) {
	key := b.fileKey(pkg, path)
	if id := b.fileIDs[key]; id != "" {
		return id, nil
	}
	portable := b.snapshotPortable[path]
	if portable == "" {
		var err error
		portable, err = b.portablePath(pkg, path)
		if err != nil {
			return "", err
		}
	}
	data, captured := b.sourceSnapshot[path]
	if !captured {
		return "", fmt.Errorf("selected package input was not captured in the immutable loader snapshot: %s", filepath.Base(path))
	}
	id := stableID("file", b.packageIDs[pkg]+"\x00"+portable+"\x00"+hashBytes(data))
	record := FileRecord{
		ID: id, PackageID: b.packageIDs[pkg], Path: portable, Role: role, Reason: reason,
		LanguageVersion: fileLanguageVersion(pkg, path), SHA256: hashBytes(data), Bytes: int64(len(data)),
		ContentBase64: base64.StdEncoding.EncodeToString(data), ValidUTF8: utf8.Valid(data),
		Native: role == "native", Embed: role == "embed", Provenance: "go/packages",
	}
	if !appendInventoryRecord(b, &b.analysis.Files, record) {
		return "", b.err
	}
	b.fileIDs[key] = id
	b.seenFiles[id] = true
	return id, nil
}

func fileLanguageVersion(pkg *packages.Package, path string) string {
	fallback := moduleGoVersion(pkg.Module)
	if pkg == nil || pkg.TypesInfo == nil || pkg.Fset == nil {
		return fallback
	}
	for _, file := range pkg.Syntax {
		if filepath.Clean(pkg.Fset.PositionFor(file.Pos(), false).Filename) != filepath.Clean(path) {
			continue
		}
		version := pkg.TypesInfo.FileVersions[file]
		if version == "" {
			return fallback
		}
		return strings.TrimPrefix(version, "go")
	}
	return fallback
}

func (b *inventoryBuilder) portablePath(pkg *packages.Package, path string) (string, error) {
	if relative, err := pathWithin(b.sourceRoot, path); err == nil {
		return "source://" + relative, nil
	}
	if pkg.Module != nil && pkg.Module.Dir != "" {
		root := pkg.Module.Dir
		logicalPath := pkg.Module.Path
		version := pkg.Module.Version
		if pkg.Module.Replace != nil {
			root = pkg.Module.Replace.Dir
			if pkg.Module.Replace.Version != "" {
				logicalPath = pkg.Module.Replace.Path
				version = pkg.Module.Replace.Version
			} else {
				version = "local"
			}
		}
		if relative, err := pathWithin(root, path); err == nil {
			if version == "" {
				version = "local"
			}
			return "module://" + logicalPath + "@" + version + "/" + relative, nil
		}
	}
	if relative, err := pathWithin(b.goroot, path); err == nil {
		return "goroot://" + relative, nil
	}
	return "", fmt.Errorf("selected path is outside declared source/module/GOROOT roots: %s", path)
}

func (b *inventoryBuilder) markGenerated(fileID string, generated bool) {
	if !generated {
		return
	}
	for i := range b.analysis.Files {
		if b.analysis.Files[i].ID == fileID {
			b.analysis.Files[i].Generated = true
			return
		}
	}
}

func (b *inventoryBuilder) addSyntax(pkg *packages.Package, fileID string, file *ast.File) {
	pkgID := b.packageIDs[pkg]
	var parents []string
	nodeParents := map[ast.Node]ast.Node{}
	var astParents []ast.Node
	constants := declaredConstants(file)
	stop := new(int)
	defer func() {
		if recovered := recover(); recovered != nil && recovered != stop {
			panic(recovered)
		}
	}()
	ast.Inspect(file, func(node ast.Node) bool {
		if node == nil {
			parents = parents[:len(parents)-1]
			exited := astParents[len(astParents)-1]
			delete(nodeParents, exited)
			astParents = astParents[:len(astParents)-1]
			return true
		}
		if b.err != nil {
			panic(stop)
		}
		if inventorySyntaxNodeTestHook != nil {
			inventorySyntaxNodeTestHook()
		}
		var parent ast.Node
		if len(astParents) > 0 {
			parent = astParents[len(astParents)-1]
			nodeParents[node] = parent
		}
		astParents = append(astParents, node)
		span := b.span(pkg, node.Pos(), node.End())
		nodeID := syntaxNodeID(pkgID, fileID, node, span)
		record := NodeRecord{ID: nodeID, PackageID: pkgID, FileID: fileID, Kind: fmt.Sprintf("%T", node), Span: span}
		if len(parents) > 0 {
			record.ParentID = parents[len(parents)-1]
		}
		parents = append(parents, nodeID)
		record.ScopeID = b.scopeFor(pkgID, node.Pos())
		if expression, ok := node.(ast.Expr); ok {
			tv, exists := pkg.TypesInfo.Types[expression]
			if exists {
				original, effective, conversion := expressionTypeFacts(pkg, expression, tv, nodeParents)
				record.OriginalTypeID = b.addType(pkg, original)
				record.EffectiveTypeID = b.addType(pkg, effective)
				record.ConversionTypeID = b.addType(pkg, conversion)
				record.Addressable = tv.Addressable()
				record.Assignable = tv.Assignable()
				record.IsType = tv.IsType()
				record.IsValue = tv.IsValue()
				record.IsNil = tv.IsNil()
				record.IsBuiltin = tv.IsBuiltin()
				if tv.Value != nil {
					arrayLength := false
					if array, ok := parent.(*ast.ArrayType); ok {
						arrayLength = array.Len == expression
					}
					b.addConstant(pkg, nodeID, expression, tv, conversion, span, arrayLength)
				}
			}
			if call, ok := expression.(*ast.CallExpr); ok {
				b.addCall(pkg, nodeID, call)
			}
		}
		if ident, ok := node.(*ast.Ident); ok {
			if object := pkg.TypesInfo.Defs[ident]; object != nil {
				record.DeclarationID = b.addObject(pkg, object, b.span(pkg, ident.Pos(), ident.End()))
				if value, ok := object.(*types.Const); ok {
					b.addDeclaredConstant(pkg, nodeID, record.DeclarationID, value, span, constants[ident])
				}
			}
			if object := pkg.TypesInfo.Uses[ident]; object != nil {
				if selector, ok := nodeParents[ident].(*ast.SelectorExpr); ok && selector.Sel == ident {
					if selection := pkg.TypesInfo.Selections[selector]; selection != nil {
						record.UseID = b.addObjectWithFallback(pkg, object, SourceSpan{}, selectionObjectIdentity(selection))
					} else {
						record.UseID = b.addObject(pkg, object, SourceSpan{})
					}
				} else {
					record.UseID = b.addObject(pkg, object, SourceSpan{})
				}
			}
		}
		if !appendInventoryRecord(b, &b.analysis.Nodes, record) {
			panic(stop)
		}
		b.addFeatureSites(pkg, pkgID, fileID, node, nodeID, span)
		if b.err != nil {
			panic(stop)
		}
		return true
	})
}

func syntaxNodeID(pkgID, fileID string, node ast.Node, span SourceSpan) string {
	return stableID("node", pkgID+"\x00"+fileID+"\x00"+fmt.Sprintf("%d:%d:%T", span.StartByte, span.EndByte, node))
}

func expressionTypeFacts(pkg *packages.Package, expr ast.Expr, tv types.TypeAndValue, parents map[ast.Node]ast.Node) (original, effective, conversion types.Type) {
	effective = tv.Type
	if call, ok := expr.(*ast.CallExpr); ok && len(call.Args) == 1 {
		if fun, exists := pkg.TypesInfo.Types[call.Fun]; exists && fun.IsType() {
			argumentType := pkg.TypesInfo.TypeOf(call.Args[0])
			if argument, exists := pkg.TypesInfo.Types[call.Args[0]]; exists && argument.Value != nil {
				if untyped := untypedConstantType(pkg, call.Args[0], argument.Value); untyped != nil {
					argumentType = untyped
				}
			}
			return argumentType, tv.Type, tv.Type
		}
	}
	contextType := contextualType(pkg, expr, parents)
	if contextType != nil && tv.Type != nil && !types.Identical(tv.Type, contextType) && types.AssignableTo(tv.Type, contextType) {
		return tv.Type, contextType, contextType
	}
	if tv.Value != nil && tv.Type != nil && !isUntyped(tv.Type) {
		if untyped := untypedConstantType(pkg, expr, tv.Value); untyped != nil && !types.Identical(untyped, tv.Type) {
			return untyped, tv.Type, tv.Type
		}
	}
	return nil, effective, nil
}

func contextualType(pkg *packages.Package, expr ast.Expr, parents map[ast.Node]ast.Node) types.Type {
	parent := parents[expr]
	switch value := parent.(type) {
	case *ast.ValueSpec:
		if value.Type != nil && slices.Contains(value.Values, expr) {
			return pkg.TypesInfo.TypeOf(value.Type)
		}
	case *ast.AssignStmt:
		if value.Tok == token.ASSIGN && len(value.Lhs) == len(value.Rhs) {
			for i, rhs := range value.Rhs {
				if rhs == expr {
					return pkg.TypesInfo.TypeOf(value.Lhs[i])
				}
			}
		}
	case *ast.CallExpr:
		if fun, ok := pkg.TypesInfo.Types[value.Fun]; ok && fun.IsType() {
			return fun.Type
		}
		signature, _ := pkg.TypesInfo.TypeOf(value.Fun).(*types.Signature)
		if signature == nil {
			return nil
		}
		for i, argument := range value.Args {
			if argument != expr {
				continue
			}
			index := i
			if signature.Variadic() && index >= signature.Params().Len()-1 {
				index = signature.Params().Len() - 1
				parameter := signature.Params().At(index).Type()
				if !value.Ellipsis.IsValid() {
					if slice, ok := parameter.(*types.Slice); ok {
						return slice.Elem()
					}
				}
				return parameter
			}
			if index < signature.Params().Len() {
				return signature.Params().At(index).Type()
			}
		}
	case *ast.SendStmt:
		if value.Value == expr {
			channelType := pkg.TypesInfo.TypeOf(value.Chan)
			if channelType != nil {
				if channel, ok := channelType.Underlying().(*types.Chan); ok {
					return channel.Elem()
				}
			}
		}
	case *ast.ReturnStmt:
		for node := ast.Node(value); node != nil; node = parents[node] {
			switch function := parents[node].(type) {
			case *ast.FuncDecl:
				if object, ok := pkg.TypesInfo.Defs[function.Name].(*types.Func); ok {
					return resultTypeForExpression(object.Type().(*types.Signature), value, expr)
				}
			case *ast.FuncLit:
				if signature, ok := pkg.TypesInfo.TypeOf(function.Type).(*types.Signature); ok {
					return resultTypeForExpression(signature, value, expr)
				}
			}
		}
	case *ast.CompositeLit:
		return compositeElementType(pkg.TypesInfo.TypeOf(value), value, expr)
	case *ast.KeyValueExpr:
		if literal, ok := parents[value].(*ast.CompositeLit); ok {
			switch composite := pkg.TypesInfo.TypeOf(literal).Underlying().(type) {
			case *types.Map:
				if value.Key == expr {
					return composite.Key()
				}
				if value.Value == expr {
					return composite.Elem()
				}
			case *types.Struct:
				if value.Value == expr {
					if ident, ok := value.Key.(*ast.Ident); ok {
						for i := 0; i < composite.NumFields(); i++ {
							if composite.Field(i).Name() == ident.Name {
								return composite.Field(i).Type()
							}
						}
					}
				}
			}
		}
	}
	return nil
}

func resultTypeForExpression(signature *types.Signature, statement *ast.ReturnStmt, expr ast.Expr) types.Type {
	if signature == nil || signature.Results() == nil || len(statement.Results) != signature.Results().Len() {
		return nil
	}
	for i, result := range statement.Results {
		if result == expr {
			return signature.Results().At(i).Type()
		}
	}
	return nil
}

func compositeElementType(t types.Type, literal *ast.CompositeLit, expr ast.Expr) types.Type {
	if t == nil {
		return nil
	}
	switch composite := t.Underlying().(type) {
	case *types.Array:
		return composite.Elem()
	case *types.Slice:
		return composite.Elem()
	case *types.Struct:
		for i, element := range literal.Elts {
			if element == expr && i < composite.NumFields() {
				return composite.Field(i).Type()
			}
		}
	}
	return nil
}

func untypedConstantType(pkg *packages.Package, expr ast.Expr, value constant.Value) types.Type {
	if !isUntypedConstantExpression(pkg, expr) {
		return nil
	}
	if ident, ok := expr.(*ast.Ident); ok {
		if object, ok := pkg.TypesInfo.Uses[ident].(*types.Const); ok {
			return object.Type()
		}
	}
	if literal, ok := expr.(*ast.BasicLit); ok && literal.Kind == token.CHAR {
		return types.Typ[types.UntypedRune]
	}
	switch value.Kind() {
	case constant.Bool:
		return types.Typ[types.UntypedBool]
	case constant.String:
		return types.Typ[types.UntypedString]
	case constant.Int:
		return types.Typ[types.UntypedInt]
	case constant.Float:
		return types.Typ[types.UntypedFloat]
	case constant.Complex:
		return types.Typ[types.UntypedComplex]
	default:
		return nil
	}
}

func isUntypedConstantExpression(pkg *packages.Package, expression ast.Expr) bool {
	switch value := expression.(type) {
	case *ast.BasicLit:
		return true
	case *ast.Ident:
		if object, ok := pkg.TypesInfo.Uses[value].(*types.Const); ok {
			return isUntyped(object.Type())
		}
		return value.Name == "true" || value.Name == "false" || value.Name == "iota"
	case *ast.ParenExpr:
		return isUntypedConstantExpression(pkg, value.X)
	case *ast.UnaryExpr:
		return isUntypedConstantExpression(pkg, value.X)
	case *ast.BinaryExpr:
		return isUntypedConstantExpression(pkg, value.X) && isUntypedConstantExpression(pkg, value.Y)
	default:
		return false
	}
}

func declaredConstants(file *ast.File) map[*ast.Ident]bool {
	result := map[*ast.Ident]bool{}
	for _, declaration := range file.Decls {
		group, ok := declaration.(*ast.GenDecl)
		if !ok || group.Tok != token.CONST {
			continue
		}
		var inherited []ast.Expr
		for _, raw := range group.Specs {
			spec := raw.(*ast.ValueSpec)
			if len(spec.Values) > 0 {
				inherited = spec.Values
			}
			for index, name := range spec.Names {
				result[name] = index < len(inherited) && expressionsContainIota([]ast.Expr{inherited[index]})
			}
		}
	}
	return result
}

func expressionsContainIota(expressions []ast.Expr) bool {
	found := false
	for _, expression := range expressions {
		ast.Inspect(expression, func(node ast.Node) bool {
			if ident, ok := node.(*ast.Ident); ok && ident.Name == "iota" {
				found = true
			}
			return !found
		})
	}
	return found
}

func calleeObject(pkg *packages.Package, expression ast.Expr) types.Object {
	switch value := expression.(type) {
	case *ast.Ident:
		return pkg.TypesInfo.Uses[value]
	case *ast.SelectorExpr:
		if selection := pkg.TypesInfo.Selections[value]; selection != nil {
			return selection.Obj()
		}
		return pkg.TypesInfo.Uses[value.Sel]
	case *ast.IndexExpr:
		return calleeObject(pkg, value.X)
	case *ast.IndexListExpr:
		return calleeObject(pkg, value.X)
	case *ast.ParenExpr:
		return calleeObject(pkg, value.X)
	default:
		return nil
	}
}

func (b *inventoryBuilder) addConstant(pkg *packages.Package, nodeID string, expr ast.Expr, tv types.TypeAndValue, contextType types.Type, span SourceSpan, arrayLength bool) {
	exact := tv.Value.ExactString()
	record := ConstantRecord{
		ID: stableID("constant", nodeID+"\x00"+exact), NodeID: nodeID,
		TypeID: b.addType(pkg, tv.Type), Category: constantCategory(tv.Type), Exact: exact,
		Untyped: isUntyped(tv.Type), ContextTypeID: b.addType(pkg, contextType), Span: span,
	}
	if tv.Value.Kind() == constant.Complex {
		record.RealExact = constant.Real(tv.Value).ExactString()
		record.ImaginaryExact = constant.Imag(tv.Value).ExactString()
	}
	if ident, ok := expr.(*ast.Ident); ok && ident.Name == "iota" {
		record.Iota = true
	}
	record.ArrayLength = arrayLength
	appendInventoryRecord(b, &b.analysis.Constants, record)
}

func (b *inventoryBuilder) addDeclaredConstant(pkg *packages.Package, nodeID, symbolID string, value *types.Const, span SourceSpan, iota bool) {
	exact := value.Val().ExactString()
	record := ConstantRecord{
		ID: stableID("constant", symbolID+"\x00"+exact), NodeID: nodeID, SymbolID: symbolID,
		TypeID: b.addType(pkg, value.Type()), Category: constantCategory(value.Type()), Exact: exact,
		Untyped: isUntyped(value.Type()), Iota: iota, Span: span,
	}
	if !record.Untyped {
		record.ContextTypeID = record.TypeID
	}
	if value.Val().Kind() == constant.Complex {
		record.RealExact = constant.Real(value.Val()).ExactString()
		record.ImaginaryExact = constant.Imag(value.Val()).ExactString()
	}
	appendInventoryRecord(b, &b.analysis.Constants, record)
}

func (b *inventoryBuilder) addCall(pkg *packages.Package, nodeID string, call *ast.CallExpr) {
	record := CallRecord{ID: stableID("call", nodeID), NodeID: nodeID, Kind: "function", Ellipsis: call.Ellipsis.IsValid()}
	if tv, ok := pkg.TypesInfo.Types[call.Fun]; ok && tv.IsType() {
		record.Kind = "conversion"
		record.SignatureTypeID = b.addType(pkg, tv.Type)
	}
	if signature, ok := pkg.TypesInfo.TypeOf(call.Fun).(*types.Signature); ok {
		record.SignatureTypeID = b.addType(pkg, signature)
		record.Variadic = signature.Variadic()
	}
	if object := calleeObject(pkg, call.Fun); object != nil {
		if _, isType := object.(*types.TypeName); !isType {
			record.CalleeSymbolID = b.addObject(pkg, object, SourceSpan{})
		}
		if _, ok := object.(*types.Builtin); ok {
			record.Kind = "builtin"
			record.Builtin = object.Name()
		}
	}
	for _, argument := range call.Args {
		record.ArgumentTypeIDs = append(record.ArgumentTypeIDs, b.addType(pkg, pkg.TypesInfo.TypeOf(argument)))
	}
	appendInventoryRecord(b, &b.analysis.Calls, record)
}

func (b *inventoryBuilder) addFeatureSites(pkg *packages.Package, pkgID, fileID string, node ast.Node, nodeID string, span SourceSpan) {
	features := map[string]string{}
	add := func(feature, blocker string) {
		features[feature] = blocker
	}
	switch node.(type) {
	case *ast.GoStmt:
		add("goroutine", "m1-concurrency")
	case *ast.DeferStmt:
		add("defer", "m1-panic-defer-recover")
	case *ast.RangeStmt:
		add("range", "")
	case *ast.TypeSwitchStmt:
		add("type-switch", "m1-typed-nil-interface")
	case *ast.IndexListExpr:
		add("generic-instantiation", "")
	case *ast.FuncLit:
		add("closure", "")
	case *ast.SendStmt:
		add("channel-send", "m1-concurrency")
	case *ast.SelectStmt:
		add("channel-select", "m1-concurrency")
	case *ast.ChanType:
		add("channel-type", "m1-concurrency")
	case *ast.ArrayType:
		if node.(*ast.ArrayType).Len != nil {
			add("fixed-value-array", "m1-fixed-value-arrays")
		}
	}
	if expression, ok := node.(ast.Expr); ok {
		t := pkg.TypesInfo.TypeOf(expression)
		if t != nil {
			switch t.Underlying().(type) {
			case *types.Interface:
				add("interface-value", "m1-typed-nil-interface")
			case *types.Map:
				add("map-value", "m1-byte-strings-maps")
			case *types.Array:
				add("fixed-value-array", "m1-fixed-value-arrays")
			case *types.Chan:
				add("channel-value", "m1-concurrency")
			}
		}
		if isStringType(t) {
			add("byte-string", "m1-byte-strings-maps")
		}
	}
	if ident, ok := node.(*ast.Ident); ok {
		switch ident.Name {
		case "nil":
			if _, semanticNil := pkg.TypesInfo.Uses[ident].(*types.Nil); semanticNil {
				add("nil-value", "m1-typed-nil-interface")
			}
		case "panic", "recover":
			if _, builtin := pkg.TypesInfo.Uses[ident].(*types.Builtin); builtin {
				add(ident.Name, "m1-panic-defer-recover")
			}
		case "close":
			if _, builtin := pkg.TypesInfo.Uses[ident].(*types.Builtin); builtin {
				add("channel-close", "m1-concurrency")
			}
		}
	}
	if unary, ok := node.(*ast.UnaryExpr); ok && unary.Op == token.ARROW {
		add("channel-receive", "m1-concurrency")
	}
	names := make([]string, 0, len(features))
	for feature := range features {
		names = append(names, feature)
	}
	sort.Strings(names)
	for _, feature := range names {
		blocker := features[feature]
		disposition := "inventoried"
		if blocker != "" {
			disposition = "m1-prerequisite"
			b.migrationBlock(blocker, "M1 requires an approved lowering/runtime design for "+feature, []string{pkgID})
		}
		if !appendInventoryRecord(b, &b.analysis.FeatureSites, FeatureSite{
			ID: stableID("feature", nodeID+"\x00"+feature), NodeID: nodeID, PackageID: pkgID, FileID: fileID,
			Feature: feature, Disposition: disposition, Span: span,
		}) {
			return
		}
	}
}

func isStringType(t types.Type) bool {
	if t == nil {
		return false
	}
	basic, ok := t.Underlying().(*types.Basic)
	return ok && basic.Info()&types.IsString != 0
}

func (b *inventoryBuilder) addScopes(pkg *packages.Package) {
	type pair struct {
		node  ast.Node
		scope *types.Scope
	}
	var scopes []pair
	for node, scope := range pkg.TypesInfo.Scopes {
		scopes = append(scopes, pair{node: node, scope: scope})
	}
	sort.Slice(scopes, func(i, j int) bool {
		if scopes[i].node.Pos() != scopes[j].node.Pos() {
			return scopes[i].node.Pos() < scopes[j].node.Pos()
		}
		return scopes[i].node.End() > scopes[j].node.End()
	})
	ranges := make([]scopeRange, 0, len(scopes))
	recordStart := len(b.analysis.Scopes)
	for index := range scopes {
		entry := &scopes[index]
		span := b.span(pkg, entry.node.Pos(), entry.node.End())
		id := stableID("scope", b.packageIDs[pkg]+"\x00"+fmt.Sprintf("%d:%d", span.StartByte, span.EndByte))
		b.scopeIDs[entry.scope] = id
		ranges = append(ranges, scopeRange{start: entry.node.Pos(), end: entry.node.End(), id: id})
		names := entry.scope.Names()
		sort.Strings(names)
		record := ScopeRecord{ID: id, PackageID: b.packageIDs[pkg], Span: span}
		for _, name := range names {
			object := entry.scope.Lookup(name)
			symbolID := b.addObject(pkg, object, SourceSpan{})
			record.SymbolIDs = append(record.SymbolIDs, symbolID)
			if _, ok := object.(*types.Label); ok {
				record.Labels = append(record.Labels, symbolID)
			}
		}
		if !appendInventoryRecord(b, &b.analysis.Scopes, record) {
			return
		}
	}
	type labelEntry struct {
		ident  *ast.Ident
		object *types.Label
		scope  *types.Scope
	}
	var labels []labelEntry
	for _, file := range pkg.Syntax {
		var functionScopes []*types.Scope
		var enteredFunction []bool
		ast.Inspect(file, func(node ast.Node) bool {
			if node == nil {
				if enteredFunction[len(enteredFunction)-1] {
					functionScopes = functionScopes[:len(functionScopes)-1]
				}
				enteredFunction = enteredFunction[:len(enteredFunction)-1]
				return true
			}
			entered := false
			switch value := node.(type) {
			case *ast.FuncDecl:
				if scope := pkg.TypesInfo.Scopes[value.Type]; scope != nil {
					functionScopes = append(functionScopes, scope)
					entered = true
				}
			case *ast.FuncLit:
				if scope := pkg.TypesInfo.Scopes[value.Type]; scope != nil {
					functionScopes = append(functionScopes, scope)
					entered = true
				}
			}
			enteredFunction = append(enteredFunction, entered)
			if statement, ok := node.(*ast.LabeledStmt); ok && len(functionScopes) != 0 {
				if label, ok := pkg.TypesInfo.Defs[statement.Label].(*types.Label); ok {
					labels = append(labels, labelEntry{
						ident: statement.Label, object: label, scope: functionScopes[len(functionScopes)-1],
					})
				}
			}
			return true
		})
	}
	sort.Slice(labels, func(i, j int) bool {
		if labels[i].ident.Name != labels[j].ident.Name {
			return labels[i].ident.Name < labels[j].ident.Name
		}
		return labels[i].ident.Pos() < labels[j].ident.Pos()
	})
	records := make(map[string]*ScopeRecord, len(scopes))
	for index := range scopes {
		record := &b.analysis.Scopes[recordStart+index]
		records[record.ID] = record
	}
	for _, label := range labels {
		record := records[b.scopeIDs[label.scope]]
		if record == nil {
			continue
		}
		symbolID := b.addObject(pkg, label.object, b.span(pkg, label.ident.Pos(), label.ident.End()))
		record.SymbolIDs = append(record.SymbolIDs, symbolID)
		record.Labels = append(record.Labels, symbolID)
	}
	for index, entry := range scopes {
		if entry.scope.Parent() != nil {
			b.analysis.Scopes[recordStart+index].ParentID = b.scopeIDs[entry.scope.Parent()]
		}
	}
	b.scopeIndexes[b.packageIDs[pkg]] = newScopeIndex(ranges)
}

type scopeRange struct {
	start token.Pos
	end   token.Pos
	id    string
}

type scopeIndex struct {
	center      token.Pos
	left        *scopeIndex
	right       *scopeIndex
	byStart     []scopeRange
	bestByStart []scopeRange
	byEnd       []scopeRange
	bestByEnd   []scopeRange
	centerBest  scopeRange
}

func newScopeIndex(ranges []scopeRange) *scopeIndex {
	ranges = append([]scopeRange{}, ranges...)
	sort.Slice(ranges, func(i, j int) bool {
		if ranges[i].start != ranges[j].start {
			return ranges[i].start < ranges[j].start
		}
		if ranges[i].end != ranges[j].end {
			return ranges[i].end > ranges[j].end
		}
		return ranges[i].id < ranges[j].id
	})
	return buildScopeIndex(ranges)
}

func buildScopeIndex(ranges []scopeRange) *scopeIndex {
	if len(ranges) == 0 {
		return nil
	}
	index := &scopeIndex{center: ranges[len(ranges)/2].start}
	var left, right []scopeRange
	for _, candidate := range ranges {
		switch {
		case candidate.end < index.center:
			left = append(left, candidate)
		case candidate.start > index.center:
			right = append(right, candidate)
		default:
			index.byStart = append(index.byStart, candidate)
			index.centerBest = narrowerScope(index.centerBest, candidate)
		}
	}
	index.bestByStart = scopePrefixBest(index.byStart)
	index.byEnd = append([]scopeRange{}, index.byStart...)
	sort.Slice(index.byEnd, func(i, j int) bool {
		if index.byEnd[i].end != index.byEnd[j].end {
			return index.byEnd[i].end > index.byEnd[j].end
		}
		if index.byEnd[i].start != index.byEnd[j].start {
			return index.byEnd[i].start < index.byEnd[j].start
		}
		return index.byEnd[i].id < index.byEnd[j].id
	})
	index.bestByEnd = scopePrefixBest(index.byEnd)
	index.left = buildScopeIndex(left)
	index.right = buildScopeIndex(right)
	return index
}

func scopePrefixBest(ranges []scopeRange) []scopeRange {
	best := make([]scopeRange, len(ranges))
	var current scopeRange
	for index, candidate := range ranges {
		current = narrowerScope(current, candidate)
		best[index] = current
	}
	return best
}

func narrowerScope(left, right scopeRange) scopeRange {
	if left.id == "" {
		return right
	}
	if right.id == "" {
		return left
	}
	leftWidth, rightWidth := left.end-left.start, right.end-right.start
	if leftWidth != rightWidth {
		if leftWidth < rightWidth {
			return left
		}
		return right
	}
	if left.start != right.start {
		if left.start < right.start {
			return left
		}
		return right
	}
	if left.end != right.end {
		if left.end < right.end {
			return left
		}
		return right
	}
	if left.id < right.id {
		return left
	}
	return right
}

func (index *scopeIndex) lookup(pos token.Pos, steps *int) scopeRange {
	if index == nil {
		return scopeRange{}
	}
	if steps != nil {
		(*steps)++
	}
	var best scopeRange
	switch {
	case pos < index.center:
		count := sort.Search(len(index.byStart), func(i int) bool {
			if steps != nil {
				(*steps)++
			}
			return index.byStart[i].start > pos
		})
		if count > 0 {
			best = index.bestByStart[count-1]
		}
		best = narrowerScope(best, index.left.lookup(pos, steps))
	case pos > index.center:
		count := sort.Search(len(index.byEnd), func(i int) bool {
			if steps != nil {
				(*steps)++
			}
			return index.byEnd[i].end < pos
		})
		if count > 0 {
			best = index.bestByEnd[count-1]
		}
		best = narrowerScope(best, index.right.lookup(pos, steps))
	default:
		best = index.centerBest
	}
	return best
}

func (b *inventoryBuilder) scopeFor(packageID string, pos token.Pos) string {
	return b.scopeIndexes[packageID].lookup(pos, nil).id
}

func (b *inventoryBuilder) addSelections(pkg *packages.Package) {
	type entry struct {
		expr      *ast.SelectorExpr
		selection *types.Selection
	}
	var entries []entry
	for expr, selection := range pkg.TypesInfo.Selections {
		entries = append(entries, entry{expr, selection})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].expr.Pos() < entries[j].expr.Pos() })
	for _, item := range entries {
		span := b.span(pkg, item.expr.Pos(), item.expr.End())
		nodeID := stableID("node", b.packageIDs[pkg]+"\x00"+b.fileIDForPosition(pkg, item.expr.Pos())+"\x00"+fmt.Sprintf("%d:%d:%T", span.StartByte, span.EndByte, item.expr))
		index := append([]int{}, item.selection.Index()...)
		objectID := b.addObjectWithFallback(pkg, item.selection.Obj(), SourceSpan{}, selectionObjectIdentity(item.selection))
		if !appendInventoryRecord(b, &b.analysis.Selections, SelectionRecord{
			ID: stableID("selection", nodeID), NodeID: nodeID, Kind: selectionKind(item.selection.Kind()),
			ObjectID:       objectID,
			ReceiverTypeID: b.addType(pkg, item.selection.Recv()), TypeID: b.addType(pkg, item.selection.Type()),
			IndexPath: index, Indirect: item.selection.Indirect(),
		}) {
			return
		}
	}
}

func (b *inventoryBuilder) addInstances(pkg *packages.Package) {
	type entry struct {
		ident    *ast.Ident
		instance types.Instance
	}
	var entries []entry
	for ident, instance := range pkg.TypesInfo.Instances {
		entries = append(entries, entry{ident, instance})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ident.Pos() < entries[j].ident.Pos() })
	for _, item := range entries {
		span := b.span(pkg, item.ident.Pos(), item.ident.End())
		nodeID := stableID("node", b.packageIDs[pkg]+"\x00"+b.fileIDForPosition(pkg, item.ident.Pos())+"\x00"+fmt.Sprintf("%d:%d:%T", span.StartByte, span.EndByte, item.ident))
		record := InstanceRecord{ID: stableID("instance", nodeID), NodeID: nodeID, TypeID: b.addType(pkg, item.instance.Type)}
		for i := 0; i < item.instance.TypeArgs.Len(); i++ {
			record.TypeArgIDs = append(record.TypeArgIDs, b.addType(pkg, item.instance.TypeArgs.At(i)))
		}
		if !appendInventoryRecord(b, &b.analysis.Instances, record) {
			return
		}
	}
}

func (b *inventoryBuilder) addMethodSets(pkg *packages.Package) {
	if pkg.Types == nil {
		return
	}
	names := pkg.Types.Scope().Names()
	sort.Strings(names)
	for _, name := range names {
		typeName, ok := pkg.Types.Scope().Lookup(name).(*types.TypeName)
		if !ok {
			continue
		}
		t := typeName.Type()
		for _, candidate := range []struct {
			t       types.Type
			pointer bool
		}{{t, false}, {types.NewPointer(t), true}} {
			typeID := b.addType(pkg, candidate.t)
			id := stableID("methodSet", typeID+"\x00"+strconv.FormatBool(candidate.pointer))
			if b.seenMethodSets[id] {
				continue
			}
			b.seenMethodSets[id] = true
			record := MethodSetRecord{ID: id, TypeID: typeID, Pointer: candidate.pointer}
			for _, method := range methodSetObjects(candidate.t) {
				fallback := "method-set\x00" + typeID + "\x00" + method.Name()
				record.MethodSymbolIDs = append(record.MethodSymbolIDs, b.addObjectWithFallback(pkg, method, SourceSpan{}, fallback))
			}
			if !appendInventoryRecord(b, &b.analysis.MethodSets, record) {
				return
			}
		}
	}
}

func (b *inventoryBuilder) addEmbeds(pkg *packages.Package) {
	if len(pkg.EmbedPatterns) == 0 {
		return
	}
	for _, pattern := range pkg.EmbedPatterns {
		pattern = b.embedPattern(pkg, pattern)
		for _, path := range pkg.EmbedFiles {
			logical := filepath.Base(path)
			if pkg.Dir != "" {
				if relative, err := pathWithin(pkg.Dir, path); err == nil {
					logical = relative
				}
			}
			if !embedPatternMatches(pattern, logical) {
				continue
			}
			fileID := b.fileIDs[b.fileKey(pkg, path)]
			if fileID == "" {
				continue
			}

			hash := ""
			for _, file := range b.analysis.Files {
				if file.ID == fileID {
					hash = file.SHA256
					break
				}
			}
			if !appendInventoryRecord(b, &b.analysis.Embeds, EmbedRecord{
				ID:        stableID("embed", b.packageIDs[pkg]+"\x00"+pattern+"\x00"+logical),
				PackageID: b.packageIDs[pkg], FileID: fileID, Pattern: pattern,
				LogicalName: logical, ContentSHA256: hash,
			}) {
				return
			}
		}
	}
}

func embedPatternMatches(pattern, logical string) bool {
	all := strings.HasPrefix(pattern, "all:")
	pattern = strings.TrimPrefix(pattern, "all:")
	logical = slash(logical)
	matched, err := pathpkg.Match(pattern, logical)
	if err != nil {
		return false
	}
	if matched {
		return true
	}
	for directory := pathpkg.Dir(logical); directory != "." && directory != "/"; directory = pathpkg.Dir(directory) {
		matched, err := pathpkg.Match(pattern, directory)
		if err != nil {
			return false
		}
		if !matched {
			continue
		}
		relative := strings.TrimPrefix(logical, directory+"/")
		return all || embedWalkVisible(relative)
	}
	return false
}

func embedWalkVisible(relative string) bool {
	for _, element := range strings.Split(relative, "/") {
		if strings.HasPrefix(element, ".") || strings.HasPrefix(element, "_") {
			return false
		}
	}
	return true
}

func (b *inventoryBuilder) embedPattern(pkg *packages.Package, pattern string) string {
	if !filepath.IsAbs(pattern) {
		return slash(pattern)
	}
	if pkg.Dir != "" {
		if relative, err := filepath.Rel(pkg.Dir, pattern); err == nil &&
			relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return slash(relative)
		}
	}
	if relative, err := filepath.Rel(b.sourceRoot, pattern); err == nil &&
		relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return slash(relative)
	}
	return slash(filepath.Base(pattern))
}

func (b *inventoryBuilder) addGenerateDirectives(pkg *packages.Package, fileID string, file *ast.File) {
	for _, group := range file.Comments {
		for _, comment := range group.List {
			text := strings.TrimSpace(strings.TrimPrefix(comment.Text, "//"))
			if !strings.HasPrefix(text, "go:generate ") {
				continue
			}
			span := b.span(pkg, comment.Pos(), comment.End())
			if !appendInventoryRecord(b, &b.analysis.GenerateDirectives, GenerateRecord{
				ID:     stableID("generate", fileID+"\x00"+fmt.Sprintf("%d", span.StartByte)),
				FileID: fileID, Directive: boundedDirective(strings.TrimPrefix(text, "go:generate "), b.profile.Limits.MaxStringBytes), Executed: false, Span: span,
			}) {
				return
			}
		}
	}
}

func boundedDirective(value string, limit int) string {
	value, _ = truncate(value, limit)
	return value
}

func (b *inventoryBuilder) addType(pkg *packages.Package, t types.Type) string {
	if t == nil {
		return ""
	}
	if id := b.typeIDs[t]; id != "" {
		return id
	}
	display := canonicalType(t)
	canonical := b.typeIdentity(pkg, t)
	id := stableID("type", canonical)
	b.typeIDs[t] = id
	if b.seenTypes[id] {
		return id
	}
	if !b.recordAvailable() {
		return ""
	}
	b.seenTypes[id] = true
	pkgPath, name, alias, named, args, underlying := typeDetails(t)
	record := TypeRecord{
		ID: id, Kind: typeKind(t), Canonical: canonical, Display: display,
		Package: pkgPath, Name: name, Alias: alias, Named: named, Underlying: underlying,
		Comparable: types.Comparable(t), Size: -1, Align: -1,
	}
	for _, arg := range args {
		record.TypeArgs = append(record.TypeArgs, b.addType(pkg, arg))
	}
	if parameter, ok := t.(*types.TypeParam); ok {
		record.Constraint = canonicalType(parameter.Constraint())
	}
	if structure, ok := t.Underlying().(*types.Struct); ok {
		for i := 0; i < structure.NumFields(); i++ {
			field := structure.Field(i)
			record.Fields = append(record.Fields, StructFieldRecord{
				Name: field.Name(), TypeID: b.addType(pkg, field.Type()),
				TagBase64: base64.StdEncoding.EncodeToString([]byte(structure.Tag(i))),
				Exported:  field.Exported(), Embedded: field.Embedded(),
			})
		}
	}
	if pkg.TypesSizes != nil {
		record.Size, record.Align = safeSize(pkg.TypesSizes, t)
	}
	appendInventoryRecord(b, &b.analysis.Types, record)
	return id
}

func safeSize(sizes types.Sizes, t types.Type) (size, align int64) {
	size, align = -1, -1
	defer func() {
		if recover() != nil {
			size, align = -1, -1
		}
	}()
	size = sizes.Sizeof(t)
	align = int64(sizes.Alignof(t))
	return size, align
}

func (b *inventoryBuilder) typeIdentity(_ *packages.Package, t types.Type) string {
	return canonicalTypeIdentityWith(t, func(object *types.TypeName) string {
		base := typeObjectIdentity(object)
		if object == nil || object.Pkg() == nil ||
			object.Pkg().Scope().Lookup(object.Name()) == object || !object.Pos().IsValid() {
			return base
		}
		owner := b.typeOwners[object.Pkg()]
		if owner == nil || owner.Fset == nil {
			return base
		}
		span := b.span(owner, object.Pos(), object.Pos()+token.Pos(len(object.Name())))
		if span.Path == "" {
			return base
		}
		return base + ":" + span.Path + ":" + strconv.Itoa(span.StartByte)
	})
}

func (b *inventoryBuilder) addObject(pkg *packages.Package, object types.Object, declaration SourceSpan) string {
	return b.addObjectWithFallback(pkg, object, declaration, "")
}

func (b *inventoryBuilder) addObjectWithFallback(pkg *packages.Package, object types.Object, declaration SourceSpan, fallback string) string {
	if object == nil {
		return ""
	}
	object = objectOrigin(object)
	if identity := b.memberIdentity[object]; identity != "" {
		fallback = identity
	}
	pkgID := b.packageIDs[pkg]
	if object.Pkg() != nil && object.Pkg().Path() != pkg.PkgPath {
		pkgID = b.packagePathIDs[object.Pkg().Path()]
		if pkgID == "" {
			pkgID = b.packageIDs[pkg]
		}
	}
	declarationPackage := pkg
	if object.Pkg() != nil && object.Pkg() != pkg.Types {
		declarationPackage = b.typeOwners[object.Pkg()]
	}
	if declaration.Path == "" && object.Pos().IsValid() && declarationPackage != nil &&
		b.fileIDForPosition(declarationPackage, object.Pos()) != "" {
		declaration = b.span(declarationPackage, object.Pos(), object.Pos()+token.Pos(len(object.Name())))
	}
	key := objectRef{object: object, packageID: pkgID}
	if id := b.objectIDs[key]; id != "" {
		if declaration.Path != "" {
			for i := range b.analysis.Symbols {
				if b.analysis.Symbols[i].ID == id && b.analysis.Symbols[i].Declaration == nil {
					b.analysis.Symbols[i].Declaration = &declaration
					break
				}
			}
		}
		return id
	}
	declarationKey := ""
	if identity := b.memberIdentity[object]; identity != "" {
		declarationKey = identity
	} else if declaration.Path != "" {
		declarationKey = declaration.Path + "\x00" + strconv.Itoa(declaration.StartByte)
	} else if fallback != "" {
		declarationKey = fallback
	}
	id := stableID("symbol", objectCanonical(pkgID, object, declarationKey))
	b.objectIDs[key] = id
	if b.seenSymbols[id] {
		return id
	}
	b.seenSymbols[id] = true
	record := SymbolRecord{
		ID: id, PackageID: pkgID, Name: object.Name(), Kind: objectKind(object),
		TypeID: b.addType(pkg, object.Type()), Exported: object.Exported(),
	}
	if declaration.Path != "" {
		record.Declaration = &declaration
	}
	appendInventoryRecord(b, &b.analysis.Symbols, record)
	return id
}

func objectOrigin(object types.Object) types.Object {
	switch value := object.(type) {
	case *types.Var:
		return value.Origin()
	case *types.Func:
		return value.Origin()
	default:
		return object
	}
}

func (b *inventoryBuilder) indexDeclaredMembers(loaded []*packages.Package) {
	seen := map[types.Type]bool{}
	var indexType func(*packages.Package, types.Type)
	indexType = func(pkg *packages.Package, current types.Type) {
		switch value := current.(type) {
		case *types.Pointer:
			indexType(pkg, value.Elem())
		case *types.Alias:
			indexType(pkg, value.Origin().Rhs())
		case *types.Named:
			value = value.Origin()
			if seen[value] {
				return
			}
			seen[value] = true
			owner := b.typeIdentity(pkg, value)
			for i := 0; i < value.NumMethods(); i++ {
				method := value.Method(i).Origin()
				b.memberIdentity[method] = owner + "\x00method\x00" + strconv.Itoa(i)
			}
			switch underlying := value.Underlying().(type) {
			case *types.Struct:
				for i := 0; i < underlying.NumFields(); i++ {
					field := underlying.Field(i).Origin()
					b.memberIdentity[field] = owner + "\x00field\x00" + strconv.Itoa(i)
					if field.Embedded() {
						indexType(pkg, field.Type())
					}
				}
			case *types.Interface:
				underlying.Complete()
				for i := 0; i < underlying.NumExplicitMethods(); i++ {
					method := underlying.ExplicitMethod(i).Origin()
					b.memberIdentity[method] = owner + "\x00interface-method\x00" + strconv.Itoa(i)
				}
				for i := 0; i < underlying.NumEmbeddeds(); i++ {
					indexType(pkg, underlying.EmbeddedType(i))
				}
			}
		}
	}
	for _, pkg := range loaded {
		if pkg.Types == nil {
			continue
		}
		for _, name := range pkg.Types.Scope().Names() {
			if object, ok := pkg.Types.Scope().Lookup(name).(*types.TypeName); ok {
				indexType(pkg, object.Type())
			}
		}
	}
}

func (b *inventoryBuilder) addModule(module *packages.Module) (string, error) {
	if module == nil {
		return "", nil
	}
	replacementID := ""
	if module.Replace != nil {
		var err error
		if module.Replace.Version == "" && module.Replace.Dir != "" {
			replacementID, err = b.addLocalReplacement(module.Path, module.Replace)
		} else {
			replacementID, err = b.addModule(module.Replace)
		}
		if err != nil {
			return "", err
		}
	}
	canonical := module.Path + "\x00" + module.Version + "\x00replace\x00" + replacementID
	id := stableID("module", canonical)
	b.moduleIDs[canonical] = id
	if b.seenModules[id] {
		return id, nil
	}
	b.seenModules[id] = true
	record := ModuleRecord{ID: id, Path: module.Path, Version: module.Version, GoVersion: module.GoVersion, Main: module.Main}
	if replacementID != "" {
		record.ReplacementID = replacementID
	}
	if b.profile.VendorMode {
		record.VendorProvenance = "source://vendor/modules.txt"
	}
	if !appendInventoryRecord(b, &b.analysis.Modules, record) {
		return "", b.err
	}
	return id, b.err
}

func (b *inventoryBuilder) addLocalReplacement(logicalPath string, replacement *packages.Module) (string, error) {
	hash, err := hashTreeContext(b.ctx, replacement.Dir, b.profile.Limits.MaxLocalHashBytes)
	if err != nil {
		return "", fmt.Errorf("hash local replacement for %s: %w", logicalPath, err)
	}
	canonical := logicalPath + "\x00local-replacement\x00" + hash
	id := stableID("module", canonical)
	if b.seenModules[id] {
		return id, nil
	}
	b.seenModules[id] = true
	if !appendInventoryRecord(b, &b.analysis.Modules, ModuleRecord{
		ID: id, Path: logicalPath, GoVersion: replacement.GoVersion, LocalContentSHA256: hash,
	}) {
		return "", b.err
	}
	return id, b.err
}

func hashTree(root string, maxBytes int64) (string, error) {
	return hashTreeContext(context.Background(), root, maxBytes)
}

func hashTreeContext(ctx context.Context, root string, maxBytes int64) (string, error) {
	var entries []string
	var total int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink not allowed in local replacement: %s", path)
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := pathWithin(root, path)
		if err != nil {
			return err
		}
		hash, size, err := hashFileContext(ctx, path)
		if err != nil {
			return err
		}
		total += size
		if total > maxBytes {
			return fmt.Errorf("content exceeds %d-byte limit", maxBytes)
		}
		entries = append(entries, relative+"\x00"+hash)
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(entries)
	return hashBytes([]byte(strings.Join(entries, "\n"))), nil
}

func (b *inventoryBuilder) span(pkg *packages.Package, start, end token.Pos) SourceSpan {
	rawStart := tokenPositionFor(pkg.Fset, start, false)
	rawEnd := tokenPositionFor(pkg.Fset, end, false)
	path := ""
	portable := ""
	if rawStart.Filename != "" {
		if value, err := b.portablePath(pkg, rawStart.Filename); err == nil {
			portable = value
			path = value
		}
	}
	displayPath, displayLine, displayColumn := portable, rawStart.Line, rawStart.Column
	lineDirective := false
	positions := b.positionMaps[rawStart.Filename]
	if positions == nil {
		if data := b.sourceSnapshot[rawStart.Filename]; data != nil {
			var err error
			positions, err = newSourcePositionMapContext(b.ctx, portable, data)
			if err != nil && b.ctx.Err() != nil {
				b.err = err
			}
			b.positionMaps[rawStart.Filename] = positions
		}
	}
	if positions != nil {
		if err := checkAnalysisOperation(b.ctx, "source-position-parse", "use"); err != nil {
			b.err = err
			return SourceSpan{}
		}
		mappedStart, mappedEnd, mappedPath, mappedLine, mappedColumn, mappedDirective :=
			positions.span(rawStart.Offset, rawEnd.Offset)
		rawStart, rawEnd = mappedStart, mappedEnd
		displayPath, displayLine, displayColumn, lineDirective =
			mappedPath, mappedLine, mappedColumn, mappedDirective
	}
	return SourceSpan{
		Path: path, StartByte: rawStart.Offset, EndByte: rawEnd.Offset,
		StartLine: rawStart.Line, StartColumn: rawStart.Column, EndLine: rawEnd.Line, EndColumn: rawEnd.Column,
		DisplayPath: displayPath, DisplayLine: displayLine, DisplayColumn: displayColumn,
		LineDirective: lineDirective,
	}
}

func (b *inventoryBuilder) fileIDForPosition(pkg *packages.Package, pos token.Pos) string {
	position := tokenPositionFor(pkg.Fset, pos, false)
	return b.fileIDs[b.fileKey(pkg, position.Filename)]
}

func (b *inventoryBuilder) fileKey(pkg *packages.Package, path string) string {
	return b.packageIDs[pkg] + "\x00" + path
}

func (b *inventoryBuilder) addInitialization(pkg *packages.Package, record *PackageRecord) {
	for _, init := range pkg.TypesInfo.InitOrder {
		entry := InitializationRecord{Order: len(record.InitializationOrder), Kind: "variable", SymbolIDs: []string{}}
		for _, variable := range init.Lhs {
			entry.SymbolIDs = append(entry.SymbolIDs, b.addObjectForPackageID(record.ID, variable))
		}
		if position := pkg.Fset.PositionFor(init.Rhs.Pos(), false); position.IsValid() {
			entry.FileID = b.fileIDs[b.fileKey(pkg, position.Filename)]
			if entry.FileID != "" {
				entry.NodeID = syntaxNodeID(record.ID, entry.FileID, init.Rhs, b.span(pkg, init.Rhs.Pos(), init.Rhs.End()))
			}
		}
		record.InitializationOrder = append(record.InitializationOrder, entry)
	}
	syntaxPaths := syntaxFilePaths(pkg)
	for index, file := range pkg.Syntax {
		if index >= len(syntaxPaths) {
			break
		}
		fileID := b.fileIDs[b.fileKey(pkg, syntaxPaths[index])]
		if fileID == "" {
			continue
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv != nil || function.Name.Name != "init" {
				continue
			}
			span := b.span(pkg, function.Pos(), function.End())
			record.InitializationOrder = append(record.InitializationOrder, InitializationRecord{
				Order: len(record.InitializationOrder), Kind: "init-function", FileID: fileID,
				NodeID: syntaxNodeID(record.ID, fileID, function, span), SymbolIDs: []string{},
			})
		}
	}

}

func syntaxFilePaths(pkg *packages.Package) []string {
	paths := make([]string, len(pkg.Syntax))
	for index, file := range pkg.Syntax {
		paths[index] = tokenPositionFor(pkg.Fset, file.Pos(), false).Filename
	}
	return paths
}

func (b *inventoryBuilder) addObjectForPackageID(pkgID string, object types.Object) string {
	object = objectOrigin(object)
	key := objectRef{object: object, packageID: pkgID}
	if id := b.objectIDs[key]; id != "" {
		return id
	}
	id := stableID("symbol", objectCanonical(pkgID, object, ""))
	b.objectIDs[key] = id
	if !b.seenSymbols[id] {
		b.seenSymbols[id] = true
		appendInventoryRecord(b, &b.analysis.Symbols, SymbolRecord{
			ID: id, PackageID: pkgID, Name: object.Name(), Kind: objectKind(object),
			TypeID: b.addTypeForUnknown(object.Type()), Exported: object.Exported(),
		})
	}
	return id
}

func (b *inventoryBuilder) addTypeForUnknown(t types.Type) string {
	if t == nil {
		return ""
	}
	if id := b.typeIDs[t]; id != "" {
		return id
	}
	display := canonicalType(t)
	canonical := canonicalTypeIdentity(t)
	id := stableID("type", canonical)
	b.typeIDs[t] = id
	if !b.seenTypes[id] {
		b.seenTypes[id] = true
		pkgPath, name, alias, named, _, underlying := typeDetails(t)
		appendInventoryRecord(b, &b.analysis.Types, TypeRecord{
			ID: id, Kind: typeKind(t), Canonical: canonical, Display: display,
			Package: pkgPath, Name: name, Alias: alias, Named: named,
			Underlying: underlying, Comparable: types.Comparable(t), Size: -1, Align: -1,
		})
	}
	return id
}

func (b *inventoryBuilder) block(category, message string, units, diagnostics []string) {
	b.addBlocker("inventory", category, message, units, diagnostics)
}

func (b *inventoryBuilder) migrationBlock(category, message string, units []string) {
	b.addBlocker("migration", category, message, units, nil)
}

func (b *inventoryBuilder) addBlocker(blocks, category, message string, units, diagnostics []string) {
	message, _ = truncate(b.sanitizeRecordedMessage(message), b.profile.Limits.MaxStringBytes)
	if units == nil {
		units = []string{}
	}
	if diagnostics == nil {
		diagnostics = []string{}
	}
	sort.Strings(units)
	sort.Strings(diagnostics)
	id := stableID("blocker", blocks+"\x00"+category+"\x00"+message+"\x00"+strings.Join(units, "\x00"))
	for _, existing := range b.analysis.Blockers {
		if existing.ID == id {
			return
		}
	}
	appendInventoryRecord(b, &b.analysis.Blockers, BlockerRecord{
		ID: id, Blocks: blocks, Category: category, Message: message, AffectedUnits: units, DiagnosticIDs: diagnostics,
	})
}

func (b *inventoryBuilder) recordCount() int {
	return analysisRecordCount(b.analysis)
}

func (b *inventoryBuilder) finish() {
	a := b.analysis
	normalizeAnalysisCollections(a)
	sort.Slice(a.Modules, func(i, j int) bool { return a.Modules[i].ID < a.Modules[j].ID })
	sort.Slice(a.Packages, func(i, j int) bool { return a.Packages[i].ID < a.Packages[j].ID })
	sort.Slice(a.Files, func(i, j int) bool { return a.Files[i].ID < a.Files[j].ID })
	sort.Slice(a.Types, func(i, j int) bool { return a.Types[i].ID < a.Types[j].ID })
	sort.Slice(a.Symbols, func(i, j int) bool { return a.Symbols[i].ID < a.Symbols[j].ID })
	sort.Slice(a.Nodes, func(i, j int) bool { return a.Nodes[i].ID < a.Nodes[j].ID })
	sort.Slice(a.Constants, func(i, j int) bool { return a.Constants[i].ID < a.Constants[j].ID })
	sort.Slice(a.Scopes, func(i, j int) bool { return a.Scopes[i].ID < a.Scopes[j].ID })
	sort.Slice(a.Selections, func(i, j int) bool { return a.Selections[i].ID < a.Selections[j].ID })
	sort.Slice(a.Calls, func(i, j int) bool { return a.Calls[i].ID < a.Calls[j].ID })
	sort.Slice(a.MethodSets, func(i, j int) bool { return a.MethodSets[i].ID < a.MethodSets[j].ID })
	sort.Slice(a.Instances, func(i, j int) bool { return a.Instances[i].ID < a.Instances[j].ID })
	sort.Slice(a.Embeds, func(i, j int) bool { return a.Embeds[i].ID < a.Embeds[j].ID })
	sort.Slice(a.GenerateDirectives, func(i, j int) bool { return a.GenerateDirectives[i].ID < a.GenerateDirectives[j].ID })
	sort.Slice(a.Dependencies, func(i, j int) bool { return a.Dependencies[i].ID < a.Dependencies[j].ID })
	sort.Slice(a.FeatureSites, func(i, j int) bool { return a.FeatureSites[i].ID < a.FeatureSites[j].ID })
	sort.Slice(a.Diagnostics, func(i, j int) bool { return a.Diagnostics[i].ID < a.Diagnostics[j].ID })
	sort.Slice(a.Blockers, func(i, j int) bool { return a.Blockers[i].ID < a.Blockers[j].ID })
	a.RecordCounts = RecordCounts{
		Modules: len(a.Modules), Packages: len(a.Packages), Files: len(a.Files), Types: len(a.Types), Symbols: len(a.Symbols),
		Nodes: len(a.Nodes), Constants: len(a.Constants), Scopes: len(a.Scopes), Selections: len(a.Selections),
		Calls: len(a.Calls), MethodSets: len(a.MethodSets), Instances: len(a.Instances), Embeds: len(a.Embeds),
		GenerateDirectives: len(a.GenerateDirectives), Dependencies: len(a.Dependencies),
		FeatureSites: len(a.FeatureSites), Diagnostics: len(a.Diagnostics), Blockers: len(a.Blockers),
	}
	a.RecordCounts.Total = b.recordCount()
	a.InventoryComplete = true
	for _, blocker := range a.Blockers {
		if blocker.Blocks == "inventory" {
			a.InventoryComplete = false
			break
		}
	}
	a.MigrationReady = false
}

func normalizeAnalysisCollections(a *Analysis) {
	if a.Profile.EntryPatterns == nil {
		a.Profile.EntryPatterns = []string{}
	}
	if a.Profile.ArchitectureFeatures == nil {
		a.Profile.ArchitectureFeatures = []string{}
	}
	if a.Profile.BuildTags == nil {
		a.Profile.BuildTags = []string{}
	}
	if a.Profile.GOFLAGS == nil {
		a.Profile.GOFLAGS = []string{}
	}
	if a.Profile.GODEBUG == nil {
		a.Profile.GODEBUG = map[string]string{}
	}
	if a.Profile.CCompilerHelpers == nil {
		a.Profile.CCompilerHelpers = []CompilerHelperIdentity{}
	}
	if a.Toolchain.CCompilerHelpers == nil {
		a.Toolchain.CCompilerHelpers = []CompilerHelperIdentity{}
	}
	if a.Manifests == nil {
		a.Manifests = []ManifestRecord{}
	}
	if a.Modules == nil {
		a.Modules = []ModuleRecord{}
	}
	if a.Packages == nil {
		a.Packages = []PackageRecord{}
	}
	if a.Files == nil {
		a.Files = []FileRecord{}
	}
	if a.Types == nil {
		a.Types = []TypeRecord{}
	}
	if a.Symbols == nil {
		a.Symbols = []SymbolRecord{}
	}
	if a.Nodes == nil {
		a.Nodes = []NodeRecord{}
	}
	if a.Constants == nil {
		a.Constants = []ConstantRecord{}
	}
	if a.Scopes == nil {
		a.Scopes = []ScopeRecord{}
	}
	if a.Selections == nil {
		a.Selections = []SelectionRecord{}
	}
	if a.Calls == nil {
		a.Calls = []CallRecord{}
	}
	if a.MethodSets == nil {
		a.MethodSets = []MethodSetRecord{}
	}
	if a.Instances == nil {
		a.Instances = []InstanceRecord{}
	}
	if a.Embeds == nil {
		a.Embeds = []EmbedRecord{}
	}
	if a.GenerateDirectives == nil {
		a.GenerateDirectives = []GenerateRecord{}
	}
	if a.Dependencies == nil {
		a.Dependencies = []DependencyRecord{}
	}
	if a.FeatureSites == nil {
		a.FeatureSites = []FeatureSite{}
	}
	if a.Diagnostics == nil {
		a.Diagnostics = []DiagnosticRecord{}
	}
	if a.Blockers == nil {
		a.Blockers = []BlockerRecord{}
	}
	for i := range a.Packages {
		if a.Packages[i].FileIDs == nil {
			a.Packages[i].FileIDs = []string{}
		}
		if a.Packages[i].CompiledFileIDs == nil {
			a.Packages[i].CompiledFileIDs = []string{}
		}
		if a.Packages[i].ImportPackageIDs == nil {
			a.Packages[i].ImportPackageIDs = []string{}
		}
		if a.Packages[i].InitializationOrder == nil {
			a.Packages[i].InitializationOrder = []InitializationRecord{}
		}
		if a.Packages[i].DiagnosticIDs == nil {
			a.Packages[i].DiagnosticIDs = []string{}
		}
		for j := range a.Packages[i].InitializationOrder {
			if a.Packages[i].InitializationOrder[j].SymbolIDs == nil {
				a.Packages[i].InitializationOrder[j].SymbolIDs = []string{}
			}
		}
	}
	for i := range a.Types {
		if a.Types[i].TypeArgs == nil {
			a.Types[i].TypeArgs = []string{}
		}
		if a.Types[i].Fields == nil {
			a.Types[i].Fields = []StructFieldRecord{}
		}
	}
	for i := range a.Scopes {
		if a.Scopes[i].SymbolIDs == nil {
			a.Scopes[i].SymbolIDs = []string{}
		}
		if a.Scopes[i].Labels == nil {
			a.Scopes[i].Labels = []string{}
		}
	}
	for i := range a.Calls {
		if a.Calls[i].ArgumentTypeIDs == nil {
			a.Calls[i].ArgumentTypeIDs = []string{}
		}
	}
	for i := range a.MethodSets {
		if a.MethodSets[i].MethodSymbolIDs == nil {
			a.MethodSets[i].MethodSymbolIDs = []string{}
		}
	}
	for i := range a.Instances {
		if a.Instances[i].TypeArgIDs == nil {
			a.Instances[i].TypeArgIDs = []string{}
		}
	}
	for i := range a.Blockers {
		if a.Blockers[i].AffectedUnits == nil {
			a.Blockers[i].AffectedUnits = []string{}
		}
		if a.Blockers[i].DiagnosticIDs == nil {
			a.Blockers[i].DiagnosticIDs = []string{}
		}
	}
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func uniqueSorted(values []string) []string {
	set := stringSet(values)
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func moduleGoVersion(module *packages.Module) string {
	if module == nil {
		return ""
	}
	return module.GoVersion
}

func packageErrorCategory(kind packages.ErrorKind) string {
	switch kind {
	case packages.ListError:
		return "loader"
	case packages.ParseError:
		return "parser"
	case packages.TypeError:
		return "typechecker"
	default:
		return "unknown"
	}
}
