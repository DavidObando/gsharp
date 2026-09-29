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
	"unicode"
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
	if profile.Schema.Name != profileName || profile.Schema.Version != profileVersion {
		return profile, fmt.Errorf("unsupported profile schema %q version %d", profile.Schema.Name, profile.Schema.Version)
	}
	if profile.ID == "" || len(profile.EntryPatterns) == 0 || profile.RequestedGoVersion == "" {
		return profile, errors.New("profile id, entryPatterns, and requestedGoVersion are required")
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
	if profile.CGOEnabled {
		if err := validateCompilerPath(profile.CCompiler); err != nil {
			return profile, err
		}
	} else if profile.CCompiler != "" {
		return profile, errors.New("cCompiler is only valid when cgoEnabled is true")
	}

	if err := validateGOFLAGS(profile.GOFLAGS); err != nil {
		return profile, err
	}
	if err := validateGODEBUG(profile.GODEBUG); err != nil {
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

func validateCompilerPath(value string) error {
	if value == "" || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return errors.New("cgoEnabled requires a normalized absolute cCompiler path")
	}
	if strings.ContainsAny(value, "'\"`\\") || strings.IndexFunc(value, func(char rune) bool {
		return unicode.IsSpace(char) || unicode.IsControl(char)
	}) >= 0 {
		return errors.New("cCompiler must be one absolute executable pathname without quoting, whitespace, controls, or argument syntax")
	}
	return nil
}

func validateGODEBUG(values map[string]string) error {
	for key, value := range values {
		if key != "gotypesalias" || (value != "0" && value != "1") {
			return fmt.Errorf("goDebug setting %q=%q is not allowed in M0", key, value)
		}
	}
	return nil
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
	var analysis Analysis
	data, err := os.ReadFile(path)
	if err != nil {
		return analysis, err
	}
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
			"architectureFeatures", "buildTags", "cgoEnabled", "goFlags", "goDebug", "moduleMode",
			"vendorMode", "workspaceMode", "offline", "allowNetwork", "generatorsExecuted",
			"targetBinariesExecuted", "trustBoundary", "limits",
		}},
		{"toolchain", []string{
			"requestedVersion", "actualVersion", "executableSha256", "executableName",
			"gorootIdentity", "gorootVersionSha256", "gorootSource", "autoDownload",
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
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	staged := filepath.Join(dir, "."+filepath.Base(path)+".staged")
	if err := os.WriteFile(staged, data, mode); err != nil {
		return err
	}
	if err := os.Rename(staged, path); err != nil {
		_ = os.Remove(staged)
		return err
	}
	return nil
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
