// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"crypto/rand"
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
	"unicode/utf8"
)

const maxValidatedAnalysisBytes int64 = 512 << 20

var analysisValidationLimitTestHook func() int64

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
	if err := validateGoTarget(profile.GOOS, profile.GOARCH); err != nil {
		return profile, err
	}
	if _, err := resolveArchitectureSettings(profile.GOARCH, profile.ArchitectureFeatures); err != nil {
		return profile, err
	}

	if err := validateGOFLAGS(profile.GOFLAGS); err != nil {
		return profile, err
	}
	for index, tag := range profile.BuildTags {
		if !validBuildTag(tag) {
			return profile, fmt.Errorf("buildTags[%d] has invalid value %q", index, tag)
		}
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
		return errors.New("requestedGoVersion must use canonical final-release form without a go prefix")
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
		return "", errors.New("invalid canonical final-release Go version label")
	}
	if parts[0] != "1" || !canonicalDecimal(parts[1]) ||
		(len(parts) == 3 && !canonicalDecimal(parts[2])) {
		return "", errors.New("invalid canonical final-release Go version label")
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
		return "", errors.New("GOROOT VERSION must self-report a canonical final-release Go version")
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
	_, _, err := splitGOFLAGS(flags)
	return err
}

func splitGOFLAGS(flags []string) (remaining, tags []string, err error) {
	for i := 0; i < len(flags); i++ {
		token := flags[i]
		if token == "" || strings.IndexFunc(token, func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' }) >= 0 {
			return nil, nil, fmt.Errorf("goFlags[%d] must be one non-empty argument", i)
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
					return nil, nil, errors.New("goFlags -tags requires a value")
				}
				value = flags[i]
			}
			if !validBuildTags(value) {
				return nil, nil, fmt.Errorf("goFlags -tags has invalid value %q", value)
			}
			tags = append(tags, strings.Split(value, ",")...)
		case "-trimpath":
			remaining = append(remaining, token)
			if !hasValue {
				continue
			}
			if value != "true" && value != "false" {
				return nil, nil, fmt.Errorf("goFlags -trimpath has invalid boolean %q", value)
			}
		case "-buildvcs":
			if !hasValue {
				i++
				if i >= len(flags) {
					return nil, nil, errors.New("goFlags -buildvcs requires false")
				}
				value = flags[i]
			}
			if value != "false" {
				return nil, nil, errors.New("goFlags permits only -buildvcs=false")
			}
			if hasValue {
				remaining = append(remaining, token)
			} else {
				remaining = append(remaining, name, value)
			}
		default:
			return nil, nil, fmt.Errorf("goFlags option %q is not allowed in M0", name)
		}
	}
	return remaining, tags, nil
}

func effectiveBuildTags(profile Profile) ([]string, error) {
	_, flagTags, err := splitGOFLAGS(profile.GOFLAGS)
	if err != nil {
		return nil, err
	}
	tags := append([]string{}, profile.BuildTags...)
	tags = append(tags, flagTags...)
	for index, tag := range tags {
		if !validBuildTag(tag) {
			return nil, fmt.Errorf("build tag %d has invalid value %q", index, tag)
		}
	}
	return uniqueSorted(tags), nil
}

func validBuildTags(value string) bool {
	if value == "" || strings.HasPrefix(value, "-") {
		return false
	}
	for _, tag := range strings.Split(value, ",") {
		if !validBuildTag(tag) {
			return false
		}
	}
	return true
}

func validBuildTag(tag string) bool {
	if tag == "" || strings.HasPrefix(tag, "-") {
		return false
	}
	for _, r := range tag {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '_' || r == '.') {
			return false
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
	if l.MaxOutputBytes > maxValidatedAnalysisBytes {
		return fmt.Errorf("maxOutputBytes must be <= %d", maxValidatedAnalysisBytes)
	}
	return nil
}

func readAnalysis(path string) (Analysis, error) {
	limit := maxValidatedAnalysisBytes
	if analysisValidationLimitTestHook != nil {
		limit = analysisValidationLimitTestHook()
	}
	return readAnalysisBounded(path, limit)
}

func readAnalysisBounded(path string, limit int64) (Analysis, error) {
	data, err := readBoundedRegularFileContext(context.Background(), path, limit)
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

var workerArtifactReadTestHook func(string)
var publicationBoundaryTestHook func(string)
var publicationAfterBoundaryTestHook func(string)
var artifactEncodingTestHook func(string)

func readWorkerArtifacts(root string, maxBytes int64) ([]byte, []byte, Analysis, error) {
	return readWorkerArtifactsContext(context.Background(), root, maxBytes)
}

func readWorkerArtifactsContext(ctx context.Context, root string, maxBytes int64) ([]byte, []byte, Analysis, error) {
	if workerArtifactReadTestHook != nil {
		workerArtifactReadTestHook("analysis-read")
	}
	analysisBytes, err := readBoundedRegularFileContext(ctx, filepath.Join(root, "analysis.json"), maxBytes)
	if err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("read analysis worker result: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, Analysis{}, err
	}
	analysis, err := decodeAnalysis(analysisBytes)
	if err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("validate analysis worker result: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, Analysis{}, err
	}
	if err := validateAnalysis(analysis); err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("validate analysis worker result: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, Analysis{}, err
	}
	canonicalAnalysis, err := marshalCanonical(analysis)
	if err != nil || !bytes.Equal(canonicalAnalysis, analysisBytes) {
		return nil, nil, Analysis{}, errors.New("analysis worker result is not canonical schema v1 JSON")
	}
	if workerArtifactReadTestHook != nil {
		workerArtifactReadTestHook("run-read")
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, Analysis{}, err
	}
	runBytes, err := readBoundedRegularFileContext(ctx, filepath.Join(root, "run.json"), maxBytes)
	if err != nil {
		return nil, nil, Analysis{}, fmt.Errorf("read analysis worker metadata: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, Analysis{}, err
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
	if err := ctx.Err(); err != nil {
		return nil, nil, Analysis{}, err
	}
	return analysisBytes, runBytes, analysis, nil
}

func publishWorkerArtifacts(out *boundOutputRoot, analysisBytes, runBytes []byte, beforeRun func()) error {
	return publishWorkerArtifactsContext(context.Background(), out, analysisBytes, runBytes, beforeRun)
}

func publishWorkerArtifactsContext(ctx context.Context, out *boundOutputRoot, analysisBytes, runBytes []byte, beforeRun func()) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := out.verifyLock(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := atomicWriteRoot(out, "analysis.json", analysisBytes, 0o644, nil, nil); err != nil {
		return err
	}
	analysisInfo, err := rootEntryStableInfo(out.root, "analysis.json")
	if err != nil {
		return err
	}
	if beforeRun != nil {
		beforeRun()
	}
	if err := ctx.Err(); err != nil {
		_, cleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
		return errors.Join(err, cleanupErr)
	}
	if err := out.verifyLock(); err != nil {
		_, cleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
		return errors.Join(err, cleanupErr)
	}
	if same, err := rootEntryMatches(out.root, "analysis.json", analysisInfo); err != nil || !same {
		_, cleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
		return errors.Join(errors.New("analysis.json identity changed before run publication"), err, cleanupErr)
	}
	if err := atomicWriteRoot(out, "run.json", runBytes, 0o644, nil, nil); err != nil {
		_, cleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
		return errors.Join(err, cleanupErr)
	}
	runInfo, err := rootEntryStableInfo(out.root, "run.json")
	if err != nil {
		return err
	}
	if err := out.verifyLock(); err != nil {
		_, analysisCleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
		_, runCleanupErr := removeRootEntryIfSame(out.root, "run.json", runInfo)
		return errors.Join(err, analysisCleanupErr, runCleanupErr)
	}
	if err := ctx.Err(); err != nil {
		_, analysisCleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
		_, runCleanupErr := removeRootEntryIfSame(out.root, "run.json", runInfo)
		return errors.Join(err, analysisCleanupErr, runCleanupErr)
	}
	for _, published := range []struct {
		name string
		info os.FileInfo
	}{
		{name: "analysis.json", info: analysisInfo},
		{name: "run.json", info: runInfo},
	} {
		same, matchErr := rootEntryMatches(out.root, published.name, published.info)
		if matchErr != nil || !same {
			_, analysisCleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
			_, runCleanupErr := removeRootEntryIfSame(out.root, "run.json", runInfo)
			return errors.Join(
				fmt.Errorf("%s identity changed after publication", published.name),
				matchErr, analysisCleanupErr, runCleanupErr,
			)
		}
	}
	if err := ctx.Err(); err != nil {
		_, analysisCleanupErr := removeRootEntryIfSame(out.root, "analysis.json", analysisInfo)
		_, runCleanupErr := removeRootEntryIfSame(out.root, "run.json", runInfo)
		return errors.Join(err, analysisCleanupErr, runCleanupErr)
	}
	return nil
}

func encodeAnalysisArtifacts(analysis Analysis, run RunMetadata, maxBytes int64) ([]byte, []byte, error) {
	return encodeAnalysisArtifactsContext(context.Background(), analysis, run, maxBytes)
}

func encodeAnalysisArtifactsContext(ctx context.Context, analysis Analysis, run RunMetadata, maxBytes int64) ([]byte, []byte, error) {
	if artifactEncodingTestHook != nil {
		artifactEncodingTestHook("start")
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if err := validateAnalysis(analysis); err != nil {
		return nil, nil, fmt.Errorf("internal schema validation failed: %w", err)
	}
	if artifactEncodingTestHook != nil {
		artifactEncodingTestHook("analysis")
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	analysisBytes, err := marshalCanonical(analysis)
	if err != nil {
		return nil, nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if int64(len(analysisBytes)) > maxBytes {
		return nil, nil, fmt.Errorf("analysis output %d bytes exceeds limit %d", len(analysisBytes), maxBytes)
	}
	run.AnalysisBytes = int64(len(analysisBytes))
	run.PackageCount = len(analysis.Packages)
	run.RecordCount = analysis.RecordCounts.Total
	if artifactEncodingTestHook != nil {
		artifactEncodingTestHook("run")
	}
	runBytes, err := marshalCanonical(run)
	if err != nil {
		return nil, nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if int64(len(runBytes)) > maxBytes {
		return nil, nil, fmt.Errorf("output %d bytes exceeds limit %d", len(runBytes), maxBytes)
	}
	return analysisBytes, runBytes, nil
}

func checkPublicationContext(ctx context.Context, stage string) error {
	if publicationBoundaryTestHook != nil {
		publicationBoundaryTestHook(stage)
	}
	return ctx.Err()
}

func publishWorkerArtifactsAtBoundary(
	ctx context.Context,
	stage string,
	out *boundOutputRoot,
	analysisBytes, runBytes []byte,
) error {
	if err := checkPublicationContext(ctx, stage); err != nil {
		return err
	}
	if publicationAfterBoundaryTestHook != nil {
		publicationAfterBoundaryTestHook(stage)
	}
	return publishWorkerArtifactsContext(ctx, out, analysisBytes, runBytes, nil)
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
	if !secureTempCleanupSupported() {
		return ownedTempDir{}, errors.New("secure temporary-directory cleanup is unsupported on this platform")
	}
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

type boundOutputRoot struct {
	path     string
	root     *os.Root
	lockRoot *os.Root
	lockInfo os.FileInfo
}

var (
	outputRootBoundHook         func()
	outputBeforeStaleRemoveHook func(string)
)

func openBoundOutputRoot(path string) (*boundOutputRoot, error) {
	initial, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !initial.IsDir() || initial.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("output root is not a regular directory")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil {
		_ = root.Close()
		return nil, err
	}
	current, err := os.Lstat(path)
	if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 ||
		!os.SameFile(initial, opened) || !os.SameFile(opened, current) {
		_ = root.Close()
		return nil, errors.New("output root changed while binding")
	}
	return &boundOutputRoot{path: path, root: root}, nil
}

func lockAndInvalidateOutput(outRoot string) (*boundOutputRoot, error) {
	output, err := openBoundOutputRoot(outRoot)
	if err != nil {
		return nil, err
	}
	if outputRootBoundHook != nil {
		outputRootBoundHook()
	}
	if err := output.root.Mkdir(".go2gs-lock", 0o700); err != nil {
		_ = output.root.Close()
		if os.IsExist(err) {
			return nil, errors.New("output directory is already locked; go2gs requires exclusive control during publication")
		}
		return nil, fmt.Errorf("lock output directory: %w", err)
	}
	output.lockRoot, err = output.root.OpenRoot(".go2gs-lock")
	if err != nil {
		_ = output.root.Remove(".go2gs-lock")
		_ = output.root.Close()
		return nil, err
	}
	output.lockInfo, err = output.lockRoot.Stat(".")
	if err != nil {
		_ = output.lockRoot.Close()
		_ = output.root.Remove(".go2gs-lock")
		_ = output.root.Close()
		return nil, err
	}
	for _, name := range []string{"analysis.json", "run.json"} {
		if err := output.verifyLock(); err != nil {
			return nil, errors.Join(err, output.release())
		}
		info, statErr := rootEntryStableInfo(output.root, name)
		if os.IsNotExist(statErr) {
			continue
		}
		if statErr != nil {
			return nil, errors.Join(statErr, output.release())
		}
		if !info.Mode().IsRegular() {
			return nil, errors.Join(
				fmt.Errorf("owned output path is not a regular file: %s", name),
				output.release(),
			)
		}
		if outputBeforeStaleRemoveHook != nil {
			outputBeforeStaleRemoveHook(name)
		}
		removed, removeErr := removeRootEntryIfSame(output.root, name, info)
		if removeErr != nil || !removed {
			if removeErr == nil {
				removeErr = errors.New("output identity changed before stale invalidation")
			}
			return nil, errors.Join(
				fmt.Errorf("remove stale go2gs output %s: %w", name, removeErr),
				output.release(),
			)
		}
	}
	return output, nil
}

func (output *boundOutputRoot) release() error {
	var result error
	if output.lockInfo != nil {
		removed, err := removeRootEntryIfSame(output.root, ".go2gs-lock", output.lockInfo)
		if err != nil {
			result = errors.Join(result, fmt.Errorf("remove output lock: %w", err))
		} else if !removed {
			result = errors.Join(result, errors.New("output lock identity changed before release"))
		}
		output.lockInfo = nil
	}
	if output.lockRoot != nil {
		result = errors.Join(result, output.lockRoot.Close())
		output.lockRoot = nil
	}
	result = errors.Join(result, output.root.Close())
	return result
}

func (output *boundOutputRoot) verifyLock() error {
	if output.lockInfo == nil {
		return nil
	}
	current, err := output.root.Lstat(".go2gs-lock")
	if err != nil {
		return fmt.Errorf("verify output lock: %w", err)
	}
	held, err := output.lockRoot.Stat(".")
	if err != nil {
		return fmt.Errorf("verify held output lock: %w", err)
	}
	if !current.IsDir() || !held.IsDir() ||
		!os.SameFile(output.lockInfo, current) || !os.SameFile(output.lockInfo, held) {
		return errors.New("output lock identity changed")
	}
	return nil
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

func atomicWriteRoot(output *boundOutputRoot, name string, data []byte, mode os.FileMode, beforeRename, afterRename func(string)) (err error) {
	file, staged, err := createRootTempFile(output.root, "."+name+".staged-")
	if err != nil {
		return err
	}
	openedInfo, err := file.Stat()
	if err != nil {
		_ = file.Close()
		_ = output.root.Remove(staged)
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
			_, cleanupErr := removeRootEntryIfSame(output.root, staged, openedInfo)
			err = errors.Join(err, cleanupErr)
			if renamed {
				_, cleanupErr = removeRootEntryIfSame(output.root, name, openedInfo)
				err = errors.Join(err, cleanupErr)
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
	openedInfo, err = file.Stat()
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		file = nil
		return err
	}
	file = nil
	if beforeRename != nil {
		beforeRename(filepath.Join(output.path, staged))
	}
	same, err := rootEntryMatches(output.root, staged, openedInfo)
	if err != nil || !openedInfo.Mode().IsRegular() || !same {
		return errors.New("staged output path changed before rename")
	}
	if err := output.root.Rename(staged, name); err != nil {
		return err
	}
	renamed = true
	if afterRename != nil {
		afterRename(filepath.Join(output.path, name))
	}
	same, err = rootEntryMatches(output.root, name, openedInfo)
	if err != nil || !same {
		return errors.New("final output path does not identify the staged file")
	}
	if err := syncRootPublication(output.root, name, openedInfo); err != nil {
		return err
	}
	committed = true
	return nil
}

func createRootTempFile(root *os.Root, prefix string) (*os.File, string, error) {
	var random [16]byte
	for range 100 {
		if _, err := rand.Read(random[:]); err != nil {
			return nil, "", err
		}
		name := prefix + hex.EncodeToString(random[:])
		file, err := root.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return file, name, nil
		}
		if !os.IsExist(err) {
			return nil, "", err
		}
	}
	return nil, "", errors.New("create unique staged output")
}

func rootEntryMatches(root *os.Root, name string, expected os.FileInfo) (bool, error) {
	current, err := rootEntryStableInfo(root, name)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if current.Mode().Type() != expected.Mode().Type() {
		return false, nil
	}
	return os.SameFile(expected, current), nil
}

func rootEntryStableInfo(root *os.Root, name string) (_ os.FileInfo, err error) {
	pathInfo, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("root entry is a symlink")
	}
	if !pathInfo.Mode().IsRegular() && !pathInfo.IsDir() {
		return nil, errors.New("root entry is not a regular file or directory")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() {
		err = errors.Join(err, file.Close())
	}()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if pathInfo.Mode().Type() != openedInfo.Mode().Type() || !os.SameFile(pathInfo, openedInfo) {
		return nil, errors.New("root entry identity changed while opening")
	}
	return openedInfo, nil
}

func removeRootEntryIfSame(root *os.Root, name string, expected os.FileInfo) (bool, error) {
	same, err := rootEntryMatches(root, name, expected)
	if err != nil || !same {
		return false, err
	}
	if err := root.Remove(name); err != nil {
		return false, err
	}
	return true, nil
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
	openedInfo, err = file.Stat()
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		file = nil
		return err
	}
	file = nil
	if beforeRename != nil {
		beforeRename(staged)
	}
	same, err := pathEntryMatches(staged, openedInfo)
	if err != nil || !openedInfo.Mode().IsRegular() || !same {
		return errors.New("staged output path changed before rename")
	}
	if err := os.Rename(staged, path); err != nil {
		return err
	}
	renamed = true
	if afterRename != nil {
		afterRename(path)
	}
	same, err = pathEntryMatches(path, openedInfo)
	if err != nil || !same {
		return errors.New("final output path does not identify the staged file")
	}
	if err := syncPathPublication(dir, path, openedInfo); err != nil {
		return err
	}
	committed = true
	return nil
}

func pathEntryStableInfo(path string) (_ os.FileInfo, err error) {
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("path entry is a symlink")
	}
	if !pathInfo.Mode().IsRegular() {
		return nil, errors.New("path entry is not a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() {
		err = errors.Join(err, file.Close())
	}()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if pathInfo.Mode().Type() != openedInfo.Mode().Type() || !os.SameFile(pathInfo, openedInfo) {
		return nil, errors.New("path entry identity changed while opening")
	}
	return openedInfo, nil
}

func pathEntryMatches(path string, expected os.FileInfo) (bool, error) {
	current, err := pathEntryStableInfo(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if current.Mode().Type() != expected.Mode().Type() {
		return false, nil
	}
	return os.SameFile(expected, current), nil
}

func removeIfSameFile(path string, expected os.FileInfo) {
	if expected == nil {
		return
	}
	same, err := pathEntryMatches(path, expected)
	if err == nil && same {
		_ = os.Remove(path)
	}
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hashFile(path string) (string, int64, error) {
	return hashFileContext(context.Background(), path)
}

func hashFileContext(ctx context.Context, path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	h := sha256.New()
	var total int64
	buffer := make([]byte, 32<<10)
	for {
		if err := ctx.Err(); err != nil {
			return "", 0, err
		}
		n, readErr := file.Read(buffer)
		if n > 0 {
			_, _ = h.Write(buffer[:n])
			total += int64(n)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", 0, readErr
		}
	}
	return hex.EncodeToString(h.Sum(nil)), total, nil
}

func stableID(kind, canonical string) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + canonical))
	return kind + ":" + hex.EncodeToString(sum[:16])
}

func uniquePlaceholderName() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return ".go2gs-entry-" + hex.EncodeToString(value[:]), nil
}

func truncate(value string, max int) (string, bool) {
	const ellipsis = "..."
	normalized := strings.ToValidUTF8(value, "\uFFFD")
	changed := normalized != value
	value = normalized
	if max <= 0 {
		return "", changed || value != ""
	}
	if len(value) <= max {
		return value, changed
	}
	if max <= len(ellipsis) {
		return ellipsis[:max], true
	}
	end := max - len(ellipsis)
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + ellipsis, true
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
