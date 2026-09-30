// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func readProfile(path string) (Profile, error) {
	var profile Profile
	data, err := os.ReadFile(path)
	if err != nil {
		return profile, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&profile); err != nil {
		return profile, fmt.Errorf("invalid profile: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return profile, errors.New("invalid profile: trailing JSON value")
		}
		return profile, fmt.Errorf("invalid profile trailing data: %w", err)
	}
	if profile.Schema.Name != profileName || profile.Schema.Version != profileVersion {
		return profile, fmt.Errorf("unsupported profile schema %q version %d", profile.Schema.Name, profile.Schema.Version)
	}
	if profile.ID == "" || len(profile.EntryPatterns) == 0 || profile.RequestedGoVersion == "" {
		return profile, errors.New("profile id, entryPatterns, and requestedGoVersion are required")
	}
	if profile.CCompilerHelpers == nil {
		return profile, errors.New("cCompilerHelpers must be an array")
	}
	if profile.ExpectedSourceCommit != "" && !validCommitID(profile.ExpectedSourceCommit) {
		return profile, errors.New("expectedSourceCommit must be a lowercase 40- or 64-character Git object ID")
	}
	if profile.AllowNetwork || !profile.Offline {
		return profile, errors.New("M0 accepts offline profiles only")
	}
	if profile.AllowGOPACKAGESDRIVER {
		return profile, errors.New("M0 does not allow GOPACKAGESDRIVER")
	}
	if profile.ModuleMode != "readonly" && profile.ModuleMode != "vendor" {
		return profile, errors.New("moduleMode must be readonly or vendor")
	}
	if profile.VendorMode != (profile.ModuleMode == "vendor") {
		return profile, errors.New("vendorMode must match moduleMode=vendor")
	}
	if profile.WorkspaceMode != "off" {
		return profile, errors.New("M0 requires workspaceMode=off")
	}
	if profile.CCompiler != "" {
		return profile, errors.New("cCompiler is obsolete and is never executed in M0; remove it")
	}
	if len(profile.CCompilerHelpers) != 0 {
		return profile, errors.New("cCompilerHelpers are obsolete and are never executed in M0; use an empty array")
	}
	if err := validateProfileSemanticAuthority(profile); err != nil {
		return profile, err
	}

	if err := validateGOFLAGS(profile.GOFLAGS); err != nil {
		return profile, err
	}
	if err := validateLimits(profile.Limits); err != nil {
		return profile, err
	}
	sort.Strings(profile.EntryPatterns)
	sort.Strings(profile.ArchitectureFeatures)
	sort.Strings(profile.BuildTags)
	return profile, nil
}

func validateGODEBUG(values map[string]string) error {
	if len(values) != 0 {
		return errors.New("goDebug must be empty because in-process parser/type-checker semantics cannot be changed")
	}
	return nil
}

func validateSemanticProfile(profile Profile) error {
	if profile.GOEXPERIMENT != "" {
		return errors.New("goExperiment must be empty because in-process parser/type-checker semantics cannot be changed")
	}
	return validateGODEBUG(profile.GODEBUG)
}

func validateProfileSemanticAuthority(profile Profile) error {
	if normalized, err := normalizeOfficialGoVersion(profile.RequestedGoVersion, false); err != nil ||
		normalized != profile.RequestedGoVersion {
		return errors.New("requestedGoVersion must be an exact official Go release version without a go prefix")
	}
	return validateSemanticProfile(profile)
}

func normalizeOfficialGoVersion(value string, requirePrefix bool) (string, error) {
	hasPrefix := strings.HasPrefix(value, "go")
	if hasPrefix != requirePrefix {
		return "", errors.New("invalid Go version prefix")
	}
	if hasPrefix {
		value = strings.TrimPrefix(value, "go")
	}
	parts := strings.Split(value, ".")
	if len(parts) != 2 && len(parts) != 3 {
		return "", errors.New("invalid official Go release version")
	}
	if parts[0] != "1" || !canonicalDecimal(parts[1]) ||
		(len(parts) == 3 && !canonicalDecimal(parts[2])) {
		return "", errors.New("invalid official Go release version")
	}
	return strings.Join(parts, "."), nil
}

func canonicalDecimal(value string) bool {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func parseGOROOTVersion(data []byte) (string, error) {
	text := strings.TrimSuffix(string(data), "\n")
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || len(lines) > 2 {
		return "", errors.New("GOROOT VERSION has unsupported formatting")
	}
	version, err := normalizeOfficialGoVersion(strings.TrimSuffix(lines[0], "\r"), true)
	if err != nil {
		return "", errors.New("GOROOT VERSION does not name an official Go release")
	}
	if len(lines) == 2 {
		timestamp := strings.TrimSuffix(lines[1], "\r")
		if !strings.HasPrefix(timestamp, "time ") {
			return "", errors.New("GOROOT VERSION has unsupported metadata")
		}
		if _, err := time.Parse(time.RFC3339, strings.TrimPrefix(timestamp, "time ")); err != nil {
			return "", errors.New("GOROOT VERSION has an invalid release timestamp")
		}
	}
	return version, nil
}

func validateGOFLAGS(flags []string) error {
	for i := 0; i < len(flags); i++ {
		token := flags[i]
		if token == "" || strings.IndexFunc(token, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' }) >= 0 {
			return fmt.Errorf("goFlags[%d] must be one non-empty argument", i)
		}
		name, value, hasValue := token, "", false
		if index := strings.IndexByte(token, '='); index >= 0 {
			name, value, hasValue = token[:index], token[index+1:], true
		}
		switch name {
		case "-tags":
			if !hasValue {
				i++
				if i >= len(flags) {
					return errors.New("goFlags -tags requires a value")
				}
				value = flags[i]
			}
			if !validBuildTags(value) {
				return fmt.Errorf("goFlags -tags has invalid value %q", value)
			}
		case "-trimpath":
			if !hasValue {
				continue
			}
			if value != "true" && value != "false" {
				return fmt.Errorf("goFlags -trimpath has invalid boolean %q", value)
			}
		case "-buildvcs":
			if !hasValue {
				i++
				if i >= len(flags) {
					return errors.New("goFlags -buildvcs requires false")
				}
				value = flags[i]
			}
			if value != "false" {
				return errors.New("goFlags permits only -buildvcs=false")
			}
		default:
			return fmt.Errorf("goFlags option %q is not allowed in M0", name)
		}
	}
	return nil
}

func validBuildTags(value string) bool {
	if value == "" || strings.HasPrefix(value, "-") {
		return false
	}
	for _, tag := range strings.Split(value, ",") {
		if tag == "" {
			return false
		}
		for _, r := range tag {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
				(r >= '0' && r <= '9') || r == '_' || r == '.') {
				return false
			}
		}
	}
	return true
}

func validateLimits(l Limits) error {
	if l.MaxDurationSeconds <= 0 || l.MaxDurationSeconds > 3600 ||
		l.MaxPackages <= 0 || l.MaxFiles <= 0 || l.MaxRecords <= 0 ||
		l.MaxStringBytes <= 0 || l.MaxLogBytes <= 0 ||
		l.MaxOutputBytes <= 0 || l.MaxLocalHashBytes <= 0 {
		return errors.New("all resource limits must be positive and maxDurationSeconds must be <= 3600")
	}
	return nil
}

func readAnalysis(path string) (Analysis, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Analysis{}, err
	}
	return decodeAnalysis(data)
}

func decodeAnalysis(data []byte) (Analysis, error) {
	var analysis Analysis
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&analysis); err != nil {
		return analysis, fmt.Errorf("invalid analysis: %w", err)
	}
	if err := validateAnalysisJSONShape(data); err != nil {
		return analysis, err
	}
	return analysis, nil
}

func readWorkerArtifacts(root string, maxBytes int64) ([]byte, []byte, Analysis, error) {
	analysisBytes, err := readBoundedRegularFile(filepath.Join(root, "analysis.json"), maxBytes)
	if err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("read analysis worker result: %w", err)
	}
	analysis, err := decodeAnalysis(analysisBytes)
	if err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("validate analysis worker result: %w", err)
	}
	if err := validateAnalysis(analysis); err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("validate analysis worker result: %w", err)
	}
	canonicalAnalysis, err := marshalCanonical(analysis)
	if err != nil || !bytes.Equal(canonicalAnalysis, analysisBytes) {
		return nil, nil, Analysis{}, errors.New("analysis worker result is not canonical schema v1 JSON")
	}
	runBytes, err := readBoundedRegularFile(filepath.Join(root, "run.json"), maxBytes)
	if err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("read analysis worker metadata: %w", err)
	}
	var run RunMetadata
	decoder := json.NewDecoder(bytes.NewReader(runBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&run); err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("invalid analysis worker metadata: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, nil, Analysis{}, errors.New("analysis worker metadata has trailing JSON")
	}
	if run.SchemaVersion != schemaVersion || run.AnalysisBytes != int64(len(analysisBytes)) ||
		run.PackageCount != len(analysis.Packages) || run.RecordCount != analysis.RecordCounts.Total {
		return nil, nil, Analysis{}, errors.New("analysis worker metadata does not match its analysis")
	}
	canonicalRun, err := marshalCanonical(run)
	if err != nil || !bytes.Equal(canonicalRun, runBytes) {
		return nil, nil, Analysis{}, errors.New("analysis worker metadata is not canonical JSON")
	}
	return analysisBytes, runBytes, analysis, nil
}

func publishWorkerArtifacts(outRoot string, analysisBytes, runBytes []byte, beforeRun func()) error {
	analysisPath := filepath.Join(outRoot, "analysis.json")
	if err := atomicWrite(analysisPath, analysisBytes, 0o644); err != nil {
		return err
	}
	analysisInfo, err := os.Lstat(analysisPath)
	if err != nil {
		return err
	}
	if beforeRun != nil {
		beforeRun()
	}
	if err := atomicWrite(filepath.Join(outRoot, "run.json"), runBytes, 0o644); err != nil {
		removeIfSameFile(analysisPath, analysisInfo)
		return err
	}
	return nil
}

func encodeAnalysisArtifacts(analysis Analysis, run RunMetadata, maxBytes int64) ([]byte, []byte, error) {
	if err := validateAnalysis(analysis); err != nil {
		return nil, nil, fmt.Errorf("internal schema validation failed: %w", err)
	}
	analysisBytes, err := marshalCanonical(analysis)
	if err != nil {
		return nil, nil, err
	}
	if int64(len(analysisBytes)) > maxBytes {
		return nil, nil, fmt.Errorf("analysis output %d bytes exceeds limit %d", len(analysisBytes), maxBytes)
	}
	run.AnalysisBytes = int64(len(analysisBytes))
	run.PackageCount = len(analysis.Packages)
	run.RecordCount = analysis.RecordCounts.Total
	runBytes, err := marshalCanonical(run)
	if err != nil {
		return nil, nil, err
	}
	if int64(len(runBytes)) > maxBytes {
		return nil, nil, fmt.Errorf("output %d bytes exceeds limit %d", len(runBytes), maxBytes)
	}
	return analysisBytes, runBytes, nil
}

type ownedTempDir struct {
	path string
	info os.FileInfo
}

var (
	tempDirectoryCreatedHook          func(ownedTempDir)
	tempCleanupPlaceholderCreatedHook func(string, string, string)
)

func createOwnedTempDir(parent, pattern string) (ownedTempDir, error) {
	path, err := os.MkdirTemp(parent, pattern)
	if err != nil {
		return ownedTempDir{}, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		_ = os.Remove(path)
		return ownedTempDir{}, errors.New("created temporary path is not a directory")
	}
	directory := ownedTempDir{path: path, info: info}
	if tempDirectoryCreatedHook != nil {
		tempDirectoryCreatedHook(directory)
	}
	return directory, nil
}

func (directory ownedTempDir) cleanup() error {
	return directory.cleanupWithHooks(nil, nil)
}

func (directory ownedTempDir) cleanupWithHook(beforeRename func()) error {
	return directory.cleanupWithHooks(beforeRename, nil)
}

func (directory ownedTempDir) cleanupWithHooks(beforeRename func(), afterTombstoneIdentity func(string)) error {
	current, err := os.Lstat(directory.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !current.IsDir() || !os.SameFile(directory.info, current) {
		return errors.New("owned temporary directory path was replaced before cleanup")
	}
	return cleanupOwnedTempDir(directory, beforeRename, afterTombstoneIdentity)
}

func ownedTempCleanupError(directory ownedTempDir, label string) error {
	if cleanupErr := directory.cleanup(); cleanupErr != nil {
		return fmt.Errorf("cleanup %s directory: %w", label, cleanupErr)
	}
	return nil
}

func lockAndInvalidateOutput(outRoot string) (func(), error) {
	lockPath := filepath.Join(outRoot, ".go2gs-lock")
	if err := os.Mkdir(lockPath, 0o700); err != nil {
		return nil, fmt.Errorf("lock output directory: %w", err)
	}
	lockInfo, err := os.Lstat(lockPath)
	if err != nil {
		_ = os.Remove(lockPath)
		return nil, err
	}
	release := func() {
		if current, statErr := os.Lstat(lockPath); statErr == nil && os.SameFile(lockInfo, current) {
			_ = os.Remove(lockPath)
		}
	}
	entries, err := os.ReadDir(outRoot)
	if err != nil {
		release()
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "analysis.json" || name == "run.json" {
			if entry.IsDir() {
				release()
				return nil, fmt.Errorf("owned output path is a directory: %s", name)
			}
			if err := os.Remove(filepath.Join(outRoot, name)); err != nil {
				release()
				return nil, fmt.Errorf("remove stale go2gs output %s: %w", name, err)
			}
		}
	}
	return release, nil
}

func validateAnalysisJSONShape(data []byte) error {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("invalid analysis: %w", err)
	}
	if err := requireJSONFields("analysis", root,
		"schema", "tool", "helper", "profile", "toolchain", "manifests", "modules", "packages",
		"files", "types", "symbols", "nodes", "constants", "scopes", "selections", "calls",
		"methodSets", "instances", "embeds", "generateDirectives", "dependencies", "featureSites",
		"diagnostics", "blockers", "recordCounts", "inventoryComplete", "migrationReady"); err != nil {
		return err
	}
	nested := []struct {
		name   string
		fields []string
	}{
		{"schema", []string{"name", "version", "requiredRecordKinds"}},
		{"tool", []string{"version", "sha256"}},
		{"helper", []string{"version", "sha256"}},
		{"profile", []string{
			"id", "sha256", "sourceRootIdentity", "entryPatterns", "loadTests", "goos", "goarch",
			"cCompilerHelpers", "architectureFeatures", "buildTags", "cgoEnabled", "goFlags",
			"goDebug", "moduleMode", "vendorMode", "workspaceMode", "offline", "allowNetwork",
			"generatorsExecuted", "targetBinariesExecuted", "trustBoundary", "limits",
		}},
		{"toolchain", []string{
			"requestedVersion", "actualVersion", "helperSemanticVersion", "gorootVersion",
			"executableSha256", "executableName",
			"gorootIdentity", "gorootVersionSha256", "gorootSource", "cCompilerHelpers", "autoDownload",
		}},
		{"recordCounts", []string{
			"modules", "packages", "files", "types", "symbols", "nodes", "constants", "scopes", "selections",
			"calls", "methodSets", "instances", "embeds", "generateDirectives", "dependencies",
			"featureSites", "diagnostics", "blockers", "total",
		}},
	}
	for _, item := range nested {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(root[item.name], &object); err != nil {
			return fmt.Errorf("analysis.%s must be an object", item.name)
		}
		if err := requireJSONFields("analysis."+item.name, object, item.fields...); err != nil {
			return err
		}
	}
	records := []struct {
		name   string
		fields []string
	}{
		{"manifests", []string{"kind", "path", "sha256", "bytes"}},
		{"modules", []string{"id", "path", "main"}},
		{"packages", []string{
			"id", "importPath", "name", "variant", "fileIds", "compiledFileIds",
			"importPackageIds", "initializationOrder", "diagnosticIds", "inventoryComplete",
		}},
		{"files", []string{
			"id", "packageId", "path", "role", "sha256", "bytes", "contentBase64", "validUtf8",
			"generated", "native", "embed", "provenance",
		}},
		{"types", []string{
			"id", "kind", "canonical", "display", "alias", "named", "typeArgs",
			"fields", "comparable", "size", "align",
		}},
		{"symbols", []string{"id", "packageId", "name", "kind", "exported"}},
		{"nodes", []string{
			"id", "packageId", "fileId", "kind", "span", "addressable", "assignable",
			"isType", "isValue", "isNil", "isBuiltin",
		}},
		{"constants", []string{"id", "nodeId", "category", "exact", "untyped", "iota", "arrayLength", "span"}},
		{"scopes", []string{"id", "packageId", "span", "symbolIds", "labels"}},
		{"selections", []string{"id", "nodeId", "kind", "objectId", "receiverTypeId", "typeId", "indexPath", "indirect"}},
		{"calls", []string{"id", "nodeId", "kind", "argumentTypeIds", "variadic", "ellipsis"}},
		{"methodSets", []string{"id", "typeId", "pointer", "methodSymbolIds"}},
		{"instances", []string{"id", "nodeId", "typeId", "typeArgIds"}},
		{"embeds", []string{"id", "packageId", "fileId", "pattern", "logicalName", "contentSha256"}},
		{"generateDirectives", []string{"id", "fileId", "directive", "executed", "span"}},
		{"dependencies", []string{"id", "fromPackageId", "importPath", "disposition"}},
		{"featureSites", []string{"id", "nodeId", "packageId", "fileId", "feature", "disposition", "span"}},
		{"diagnostics", []string{"id", "category", "severity", "message", "truncated"}},
		{"blockers", []string{"id", "blocks", "category", "message", "affectedUnits", "diagnosticIds"}},
	}
	for _, record := range records {
		if err := requireJSONArrayFields(root, record.name, record.fields...); err != nil {
			return err
		}
	}
	if err := validateNestedJSONFields(root); err != nil {
		return err
	}
	return nil
}

func requireJSONFields(owner string, object map[string]json.RawMessage, fields ...string) error {
	for _, field := range fields {
		value, ok := object[field]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fmt.Errorf("%s is missing required field %q", owner, field)
		}
	}
	return nil
}

func requireJSONArrayFields(root map[string]json.RawMessage, name string, fields ...string) error {
	var records []map[string]json.RawMessage
	if err := json.Unmarshal(root[name], &records); err != nil {
		return fmt.Errorf("analysis.%s must be an array", name)
	}
	for index, record := range records {
		if err := requireJSONFields(fmt.Sprintf("analysis.%s[%d]", name, index), record, fields...); err != nil {
			return err
		}
	}
	return nil
}

var sourceSpanFields = []string{
	"path", "startByte", "endByte", "startLine", "startColumn", "endLine", "endColumn",
	"displayPath", "displayLine", "displayColumn", "lineDirective",
}

func validateNestedJSONFields(root map[string]json.RawMessage) error {
	for _, owner := range []string{"profile", "toolchain"} {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(root[owner], &object); err != nil {
			return fmt.Errorf("analysis.%s must be an object", owner)
		}
		if err := requireObjectJSONArrayFields(
			"analysis."+owner, object, "cCompilerHelpers",
			"name", "sha256", "bytes", "executableMode",
		); err != nil {
			return err
		}
	}
	for _, collection := range []string{"nodes", "constants", "scopes", "generateDirectives", "featureSites"} {
		records, err := rawRecordObjects(root, collection)
		if err != nil {
			return err
		}
		for index, record := range records {
			if err := requireNestedObjectFields(
				fmt.Sprintf("analysis.%s[%d]", collection, index), record, "span", false, sourceSpanFields...,
			); err != nil {
				return err
			}
		}
	}
	for _, collection := range []string{"symbols", "diagnostics"} {
		records, err := rawRecordObjects(root, collection)
		if err != nil {
			return err
		}
		for index, record := range records {
			if err := requireNestedObjectFields(
				fmt.Sprintf("analysis.%s[%d]", collection, index), record, map[string]string{
					"symbols": "declaration", "diagnostics": "span",
				}[collection], true, sourceSpanFields...,
			); err != nil {
				return err
			}
		}
	}
	types, err := rawRecordObjects(root, "types")
	if err != nil {
		return err
	}
	for typeIndex, record := range types {
		var fields []map[string]json.RawMessage
		if err := json.Unmarshal(record["fields"], &fields); err != nil {
			return fmt.Errorf("analysis.types[%d].fields must be an array", typeIndex)
		}
		for fieldIndex, field := range fields {
			if err := requireJSONFields(
				fmt.Sprintf("analysis.types[%d].fields[%d]", typeIndex, fieldIndex),
				field, "name", "typeId", "exported", "embedded",
			); err != nil {
				return err
			}
		}
	}
	packages, err := rawRecordObjects(root, "packages")
	if err != nil {
		return err
	}
	for packageIndex, record := range packages {
		var initializers []map[string]json.RawMessage
		if err := json.Unmarshal(record["initializationOrder"], &initializers); err != nil {
			return fmt.Errorf("analysis.packages[%d].initializationOrder must be an array", packageIndex)
		}
		for initializerIndex, initializer := range initializers {
			if err := requireJSONFields(
				fmt.Sprintf("analysis.packages[%d].initializationOrder[%d]", packageIndex, initializerIndex),
				initializer, "order", "kind", "symbolIds",
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func rawRecordObjects(root map[string]json.RawMessage, name string) ([]map[string]json.RawMessage, error) {
	var records []map[string]json.RawMessage
	if err := json.Unmarshal(root[name], &records); err != nil {
		return nil, fmt.Errorf("analysis.%s must be an array of objects", name)
	}
	return records, nil
}

func requireObjectJSONArrayFields(owner string, object map[string]json.RawMessage, name string, fields ...string) error {
	var records []map[string]json.RawMessage
	if err := json.Unmarshal(object[name], &records); err != nil {
		return fmt.Errorf("%s.%s must be an array", owner, name)
	}
	for index, record := range records {
		if err := requireJSONFields(fmt.Sprintf("%s.%s[%d]", owner, name, index), record, fields...); err != nil {
			return err
		}
	}
	return nil
}

func requireNestedObjectFields(owner string, record map[string]json.RawMessage, field string, optional bool, fields ...string) error {
	value, ok := record[field]
	if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		if optional {
			return nil
		}
		return fmt.Errorf("%s is missing required field %q", owner, field)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(value, &object); err != nil {
		return fmt.Errorf("%s.%s must be an object", owner, field)
	}
	return requireJSONFields(owner+"."+field, object, fields...)
}

func writeAnalysis(path string, analysis Analysis, maxBytes int64) (int, error) {
	if err := validateAnalysis(analysis); err != nil {
		return 0, fmt.Errorf("internal schema validation failed: %w", err)
	}
	data, err := marshalCanonical(analysis)
	if err != nil {
		return 0, err
	}
	if int64(len(data)) > maxBytes {
		return 0, fmt.Errorf("analysis output %d bytes exceeds limit %d", len(data), maxBytes)
	}
	if err := atomicWrite(path, data, 0o644); err != nil {
		return 0, err
	}
	return len(data), nil
}

func writeJSON(path string, value any, maxBytes int64) error {
	data, err := marshalCanonical(value)
	if err != nil {
		return err
	}
	if int64(len(data)) > maxBytes {
		return fmt.Errorf("output %d bytes exceeds limit %d", len(data), maxBytes)
	}
	return atomicWrite(path, data, 0o644)
}

func marshalCanonical(value any) ([]byte, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	return atomicWriteWithHooks(path, data, mode, nil, nil)
}

func atomicWriteWithHooks(path string, data []byte, mode os.FileMode, beforeRename, afterRename func(string)) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, "."+filepath.Base(path)+".staged-*")
	if err != nil {
		return err
	}
	staged := file.Name()
	openedInfo, err := file.Stat()
	if err != nil {
		_ = file.Close()
		_ = os.Remove(staged)
		return err
	}
	renamed := false
	committed := false
	defer func() {
		if file != nil {
			if closeErr := file.Close(); err == nil && closeErr != nil {
				err = closeErr
			}
			file = nil
		}
		if !committed {
			removeIfSameFile(staged, openedInfo)
			if renamed {
				removeIfSameFile(path, openedInfo)
			}
		}
	}()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	written, err := file.Write(data)
	if err != nil {
		return err
	}
	if written != len(data) {
		return io.ErrShortWrite
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if beforeRename != nil {
		beforeRename(staged)
	}
	openedInfo, err = file.Stat()
	if err != nil {
		return err
	}
	stagedInfo, err := os.Lstat(staged)
	if err != nil || !openedInfo.Mode().IsRegular() || !stagedInfo.Mode().IsRegular() || !os.SameFile(openedInfo, stagedInfo) {
		return errors.New("staged output path changed before rename")
	}
	if err := os.Rename(staged, path); err != nil {
		return err
	}
	renamed = true
	if afterRename != nil {
		afterRename(path)
	}
	finalInfo, err := os.Lstat(path)
	if err != nil || !finalInfo.Mode().IsRegular() || !os.SameFile(openedInfo, finalInfo) {
		return errors.New("final output path does not identify the staged file")
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	if err := directory.Sync(); err != nil {
		_ = directory.Close()
		return err
	}
	if err := directory.Close(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		file = nil
		return err
	}
	file = nil
	committed = true
	return nil
}

func removeIfSameFile(path string, expected os.FileInfo) {
	if expected == nil {
		return
	}
	current, err := os.Lstat(path)
	if err == nil && current.Mode().IsRegular() && os.SameFile(expected, current) {
		_ = os.Remove(path)
	}
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hashFile(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	h := sha256.New()
	n, err := io.Copy(h, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func stableID(kind, canonical string) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + canonical))
	return kind + ":" + hex.EncodeToString(sum[:16])
}

func truncate(value string, max int) (string, bool) {
	if len(value) <= max {
		return value, false
	}
	if max <= 3 {
		return value[:max], true
	}
	return value[:max-3] + "...", true
}

func slash(path string) string {
	return filepath.ToSlash(filepath.Clean(path))
}

func canonicalEnv(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+values[key])
	}
	return out
}

func joinNonEmpty(values ...string) string {
	var result []string
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return strings.Join(result, "\n")
}
