// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/build"
	"go/build/constraint"
	"go/parser"
	"go/scanner"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/mod/modfile"
	"golang.org/x/tools/go/packages"
)

var requiredRecordKinds = []string{
	"blocker", "call", "constant", "dependency", "diagnostic", "embed", "feature",
	"file", "generate", "instance", "methodSet", "module", "node", "package",
	"scope", "selection", "symbol", "type",
}

var executableCapsuleTestHook func(*executableCapsule)
var packageLoadTestHook func(string)
var rootedReadBeforeOpenHook func(string, string)
var rootedReadAfterOpenHook func(string, string)
var rootedWalkBeforeDescendHook func(string)
var rootedDirectoryBeforeOpenHook func(string)
var boundedReadChunkHook func()

func analyze(ctx context.Context, sourceRoot, outRoot string, profile Profile) (Analysis, bool, error) {
	return analyzeWithSnapshotHook(ctx, sourceRoot, outRoot, profile, nil)
}

func analyzePreload(ctx context.Context, sourceRoot, outRoot string, profile Profile) (Analysis, bool, error) {
	return analyzeWithSnapshotHooksMode(ctx, sourceRoot, outRoot, profile, nil, nil, true, "")
}

func analyzeWithSnapshotHook(ctx context.Context, sourceRoot, outRoot string, profile Profile, afterSnapshot func()) (Analysis, bool, error) {
	return analyzeWithSnapshotHooks(ctx, sourceRoot, outRoot, profile, afterSnapshot, nil)
}

func analyzeWithSnapshotHooks(ctx context.Context, sourceRoot, outRoot string, profile Profile, afterSnapshot, afterLoad func()) (_ Analysis, _ bool, err error) {
	return analyzeWithSnapshotHooksMode(ctx, sourceRoot, outRoot, profile, afterSnapshot, afterLoad, false, os.Getenv("GO2GS_SELECTED_GOROOT"))
}

func analyzeWithSnapshotHooksMode(ctx context.Context, sourceRoot, outRoot string, profile Profile, afterSnapshot, afterLoad func(), preloadOnly bool, gorootHandoff string) (_ Analysis, _ bool, err error) {
	if err := ctx.Err(); err != nil {
		return Analysis{}, false, err
	}
	if err := validateGoTarget(profile.GOOS, profile.GOARCH); err != nil {
		return Analysis{}, false, err
	}
	if _, err := resolveArchitectureSettings(profile.GOARCH, profile.ArchitectureFeatures); err != nil {
		return Analysis{}, false, err
	}
	if err := validateProfileSemanticAuthority(profile); err != nil {
		return Analysis{}, false, err
	}
	sourceRoot, err = secureRoot(sourceRoot)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("source root: %w", err)
	}
	outRoot, err = filepath.Abs(outRoot)
	if err != nil {
		return Analysis{}, false, err
	}
	outRoot = normalizeSystemPathAliases(outRoot)
	if err := validateOutputSourceRoots(sourceRoot, outRoot); err != nil {
		return Analysis{}, false, err
	}
	if _, statErr := os.Lstat(outRoot); statErr == nil {
		outRoot, err = secureRoot(outRoot)
		if err != nil {
			return Analysis{}, false, fmt.Errorf("output root: %w", err)
		}
	} else {
		if !os.IsNotExist(statErr) {
			return Analysis{}, false, statErr
		}
		if err := ensureOutputRoot(outRoot, 0o700); err != nil {
			return Analysis{}, false, err
		}
		outRoot, err = secureRoot(outRoot)
		if err != nil {
			return Analysis{}, false, fmt.Errorf("output root: %w", err)
		}
	}
	if err := validateResolvedOutputSourceRoots(sourceRoot, outRoot); err != nil {
		return Analysis{}, false, err
	}
	selectedGo := os.Getenv("GO2GS_SELECTED_GO")
	if selectedGo == "" {
		selectedGo, err = exec.LookPath("go")
		if err != nil {
			return Analysis{}, false, errors.New("Go executable not found")
		}
	}
	expectedGoHash := os.Getenv("GO2GS_SELECTED_GO_SHA256")
	goExecutable, goHash, err := captureSelectedGoContext(ctx, selectedGo, expectedGoHash)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("capture Go executable: %w", err)
	}
	self, err := os.Executable()
	if err != nil {
		return Analysis{}, false, err
	}
	_, helperHash, err := captureSelectedExecutableContext(
		ctx,
		filepath.Base(self), self, "", maxToolExecutableBytes, true,
	)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("capture helper: %w", err)
	}

	workDirectory, err := createOwnedTempDir("", ".go2gs-work-*")
	if err != nil {
		return Analysis{}, false, err
	}
	defer func() {
		err = errors.Join(err, ownedTempCleanupError(workDirectory, "analysis work"))
	}()
	workRoot := workDirectory.path
	blockedToolsRoot := filepath.Join(workRoot, "blocked-tools")
	if err := os.Mkdir(blockedToolsRoot, 0o500); err != nil {
		return Analysis{}, false, err
	}
	executables := []capturedExecutable{goExecutable}
	secureExecution := os.Getenv("GO2GS_EXEC_NAMESPACE") == "1"
	capsule, err := createExecutableCapsuleContext(ctx, workRoot, executables, secureExecution)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("create private executable capsule: %w", err)
	}
	defer func() {
		err = errors.Join(err, capsule.close())
	}()
	if executableCapsuleTestHook != nil {
		executableCapsuleTestHook(capsule)
	}
	if err := ctx.Err(); err != nil {
		return Analysis{}, false, err
	}
	if secureExecution {
		previousPath, hadPath := os.LookupEnv("PATH")
		if err := os.Setenv("PATH", capsule.directory.executionPath()); err != nil {
			return Analysis{}, false, fmt.Errorf("bind worker PATH to executable capsule: %w", err)
		}
		defer func() {
			if hadPath {
				err = errors.Join(err, os.Setenv("PATH", previousPath))
			} else {
				err = errors.Join(err, os.Unsetenv("PATH"))
			}
		}()
	}
	executable := capsule.path(goExecutable.name)
	profileIdentity := profile
	profileBytes, err := json.Marshal(profileIdentity)
	if err != nil {
		return Analysis{}, false, err
	}

	actualVersion := goExecutable.goVersion
	helperSemanticVersion, err := helperSemanticGoVersion()
	if err != nil {
		return Analysis{}, false, err
	}
	targetGOROOT, err := selectedGoRoot(goExecutable, gorootHandoff)
	if err != nil {
		return Analysis{}, false, err
	}
	gorootVersion, err := readBoundedRegularFileContext(ctx, filepath.Join(targetGOROOT, "VERSION"), 1<<20)
	if err != nil {
		return Analysis{}, false, fmt.Errorf("hash selected Go GOROOT VERSION: %w", err)
	}
	gorootSemanticVersion, err := parseGOROOTVersion(gorootVersion)
	if err != nil {
		return Analysis{}, false, err
	}
	if err := validateSemanticGoVersions(actualVersion, gorootSemanticVersion, helperSemanticVersion); err != nil {
		return Analysis{}, false, err
	}
	gorootVersionHash := hashBytes(gorootVersion)
	env, err := sanitizedEnvironment(profile, workRoot, targetGOROOT, capsule.directory.executionPath())
	if err != nil {
		return Analysis{}, false, err
	}
	effectiveTags, err := effectiveBuildTags(profile)
	if err != nil {
		return Analysis{}, false, err
	}
	semanticProfile := profile
	semanticProfile.BuildTags = effectiveTags

	if err := ctx.Err(); err != nil {
		return Analysis{}, false, err
	}
	actualCommit, sourceCommitErr := sourceCommit(sourceRoot)
	if err := ctx.Err(); err != nil {
		return Analysis{}, false, err
	}
	toolchain := ToolchainProvenance{
		RequestedVersion: profile.RequestedGoVersion, ActualVersion: actualVersion,
		HelperSemanticVersion: helperSemanticVersion, GOROOTVersion: gorootSemanticVersion,
		ExecutableSHA256: goHash, ExecutableName: filepath.Base(executable),
		GOROOTIdentity: stableID("goroot",
			actualVersion+"\x00"+gorootSemanticVersion+"\x00"+helperSemanticVersion+"\x00"+goHash+"\x00"+gorootVersionHash),
		GOROOTVersionSHA256: gorootVersionHash,
		GOROOTSource:        "selected executable path or verified parent handoff (path intentionally omitted)",
		AutoDownload:        false,
	}
	toolchain.CCompilerHelpers = []CompilerHelperIdentity{}
	analysis := Analysis{
		Schema: SchemaHandshake{Name: schemaName, Version: schemaVersion, RequiredRecordKinds: append([]string{}, requiredRecordKinds...)},
		Tool:   VersionIdentity{Version: toolVersion, SHA256: helperHash},
		Helper: VersionIdentity{Version: helperVersion, SHA256: helperHash},
		Profile: ProfileSnapshot{
			ID: profile.ID, SHA256: hashBytes(profileBytes),
			ExpectedSourceCommit: profile.ExpectedSourceCommit, ActualSourceCommit: actualCommit,
			EntryPatterns: append([]string{}, profile.EntryPatterns...), LoadTests: profile.LoadTests,
			GOOS: profile.GOOS, GOARCH: profile.GOARCH,
			CCompilerHelpers:     []CompilerHelperIdentity{},
			ArchitectureFeatures: append([]string{}, profile.ArchitectureFeatures...),
			BuildTags:            append([]string{}, profile.BuildTags...), CGOEnabled: profile.CGOEnabled,
			GOFLAGS: append([]string{}, profile.GOFLAGS...), GOEXPERIMENT: profile.GOEXPERIMENT,
			GODEBUG: copyMap(profile.GODEBUG), ModuleMode: profile.ModuleMode,
			VendorMode: profile.VendorMode, WorkspaceMode: profile.WorkspaceMode,
			Offline: profile.Offline, AllowNetwork: profile.AllowNetwork,
			GeneratorsExecuted: false, TargetBinariesExecuted: false,
			TrustBoundary: "go/packages may execute only the private selected cmd/go with CGO_ENABLED=0; compilers, linkers, assemblers, pkg-config, helpers, target binaries, tests, init functions, generators, and scripts are never executed",
			Limits:        profile.Limits,
		},
		Toolchain: toolchain,
	}

	mirror, err := createSourceMirrorContext(ctx, sourceRoot, outRoot, workRoot, profile.Limits)
	if err != nil {
		return Analysis{}, false, err
	}
	builder := newInventoryBuilder(&analysis, mirror.root, targetGOROOT, profile)
	builder.ctx = ctx
	builder.diagnosticRedactions = append(builder.diagnosticRedactions,
		workRoot,
		capsule.directory.executionPath(),
		goExecutable.sourcePath,
	)
	builder.collectManifests(mirror.manifests.records)
	analysis.Profile.SourceRootIdentity = sourceIdentity(actualCommit, analysis.Manifests)
	preloadBlocked := false
	if sourceCommitErr != nil {
		builder.block("source-metadata", sourceCommitErr.Error(), nil, nil)
		preloadBlocked = true
	}
	if actualVersion != profile.RequestedGoVersion {
		builder.block("toolchain", fmt.Sprintf("profile requests Go %s but verified executable is Go %s; automatic toolchain download and silent upgrade are disabled", profile.RequestedGoVersion, actualVersion), nil, nil)
		preloadBlocked = true
	}
	if profile.ExpectedSourceCommit != "" && actualCommit != profile.ExpectedSourceCommit {
		category := "source"
		if actualCommit == "" {
			category = "source-metadata"
		}
		builder.block(category, fmt.Sprintf("profile requires source commit %s but checkout is %s", profile.ExpectedSourceCommit, displayMissing(actualCommit)), nil, nil)
		preloadBlocked = true
	}
	if preloadBlocked {
		if err := finishInventory(builder, profile.Limits.MaxRecords); err != nil {
			return Analysis{}, false, err
		}
		return analysis, false, nil
	}
	if preloadOnly {
		return Analysis{}, false, errors.New(unsupportedExecutionBinding)
	}
	mode := packages.NeedName | packages.NeedFiles |
		packages.NeedEmbedFiles | packages.NeedEmbedPatterns | packages.NeedImports | packages.NeedDeps |
		packages.NeedModule | packages.NeedForTest
	buildFlags := []string{}
	if len(effectiveTags) > 0 {
		buildFlags = append(buildFlags, "-tags="+strings.Join(effectiveTags, ","))
	}
	config := &packages.Config{
		Context:    ctx,
		Mode:       mode,
		Dir:        mirror.root,
		Env:        env,
		BuildFlags: buildFlags,
		Tests:      profile.LoadTests,
	}
	cgoOnlyOverlay, err := cgoOnlyPackageOverlay(mirror, semanticProfile)
	if err != nil {
		return Analysis{}, false, err
	}
	config.Overlay = cgoOnlyOverlay
	if afterSnapshot != nil {
		afterSnapshot()
	}
	if packageLoadTestHook != nil {
		packageLoadTestHook("preflight-before")
	}
	selectedPreflight, _ := packages.Load(config, profile.EntryPatterns...)
	if packageLoadTestHook != nil {
		packageLoadTestHook("preflight-after")
	}
	selectedPreflight = collectPackages(selectedPreflight)
	sourceSnapshot, err := snapshotPackageInputs(ctx, selectedPreflight, selectedPreflight, mirror, semanticProfile, profile.Limits)
	if err != nil {
		return Analysis{}, false, err
	}
	metadataConfig := *config
	metadataConfig.Overlay = copyBytesMap(cgoOnlyOverlay)
	for path, data := range sourceSnapshot.overlay {
		metadataConfig.Overlay[path] = data
	}
	builder.sourceSnapshot = sourceSnapshot.data
	builder.snapshotPortable = sourceSnapshot.portable
	if packageLoadTestHook != nil {
		packageLoadTestHook("typed-before")
	}
	loaded, loadErr := packages.Load(&metadataConfig, profile.EntryPatterns...)
	if packageLoadTestHook != nil {
		packageLoadTestHook("typed-after")
	}
	if afterLoad != nil {
		afterLoad()
	}
	if err := capsule.verify(); err != nil {
		return Analysis{}, false, fmt.Errorf("verify private executable capsule: %w", err)
	}
	if selectedPkgConfigDirective(sourceSnapshot, semanticProfile) {
		builder.block("pkg-config", "selected package requires #cgo pkg-config, but M0 has no approved pkg-config executable or provenance model", nil, nil)
	}
	if loadErr != nil {
		builder.block("loader", sanitizeMessage(loadErr.Error(), mirror.root, profile.Limits.MaxStringBytes, builder.diagnosticRedactions...), nil, nil)
	}
	if len(loaded) == 0 {
		builder.block("loader", "the requested entry patterns selected no loadable packages under the pinned profile", nil, nil)
	}

	all := collectPackages(loaded)
	typedSources, externalTypedSources, typedSourceErr := captureTypedSources(all, sourceSnapshot.data, metadataConfig.Overlay, profile.Limits.MaxLocalHashBytes)
	if typedSourceErr != nil {
		builder.block("loader", sanitizeMessage(typedSourceErr.Error(), mirror.root, profile.Limits.MaxStringBytes, builder.diagnosticRedactions...), nil, nil)
	} else {
		typeCheckPackages(all, typedSources, semanticProfile)
	}
	if !verifyTypedSources(externalTypedSources) {
		builder.block("input-drift", "Go toolchain or dependency source changed while type checking", nil, nil)
	}
	builder.inputDrift = verifyPackageInputs(sourceSnapshot, all, mirror, semanticProfile)
	for key := range verifyOriginalPackageInputs(mirror, sourceSnapshot) {
		builder.inputDrift[key] = true
	}
	manifestDrift := false
	for _, root := range mirror.manifestRoots {
		if !verifyManifestSnapshot(root.snapshot, root.root, profile.Limits.MaxLocalHashBytes) {
			manifestDrift = true
		}
	}
	if manifestDrift {
		builder.block("input-drift", "module or workspace manifests changed while loading", nil, nil)
	}
	builder.snapshotFiles = sourceSnapshot.packageFiles
	builder.selectedSnapshotFiles = sourceSnapshot.selectedFiles
	builder.snapshotRoles = sourceSnapshot.packageRoles
	if len(builder.inputDrift) > 0 {
		builder.block("input-drift", "selected package inputs changed while loading", nil, nil)
	}
	if len(all) > profile.Limits.MaxPackages {
		return Analysis{}, false, fmt.Errorf("loaded package count %d exceeds limit %d", len(all), profile.Limits.MaxPackages)
	}
	builder.indexPackages(all)
	for _, pkg := range all {
		if err := ctx.Err(); err != nil {
			return Analysis{}, false, err
		}
		if err := builder.addPackage(pkg); err != nil {
			return Analysis{}, false, err
		}
		if builder.recordCount() > profile.Limits.MaxRecords {
			return Analysis{}, false, fmt.Errorf("record count exceeds limit %d", profile.Limits.MaxRecords)
		}
	}
	if err := finishInventory(builder, profile.Limits.MaxRecords); err != nil {
		return Analysis{}, false, err
	}
	return analysis, analysis.InventoryComplete, nil
}

func finishInventory(builder *inventoryBuilder, maxRecords int) error {
	if builder.err != nil {
		return builder.err
	}
	builder.finish()
	if builder.err != nil {
		return builder.err
	}
	if builder.recordCount() > maxRecords {
		return fmt.Errorf("record count exceeds limit %d", maxRecords)
	}
	return nil
}

type snapshottedInput struct {
	data []byte
	info os.FileInfo
}

var manifestNames = []string{
	"go.mod",
	"go.sum",
	"go.work",
	"go.work.sum",
	filepath.Join("vendor", "modules.txt"),
}

type manifestSnapshot struct {
	records []ManifestRecord
	files   map[string]snapshottedInput
}

func snapshotManifests(sourceRoot string, limit int64) (manifestSnapshot, error) {
	result := manifestSnapshot{files: map[string]snapshottedInput{}}
	var total int64
	for _, name := range manifestNames {
		path, err := safeJoin(sourceRoot, name)
		if err != nil {
			return manifestSnapshot{}, err
		}
		initialInfo, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return manifestSnapshot{}, fmt.Errorf("inspect manifest %s: %w", name, err)
		}
		if !initialInfo.Mode().IsRegular() {
			return manifestSnapshot{}, fmt.Errorf("manifest is not a regular file: %s", name)
		}
		if err := rejectSymlinkBelow(sourceRoot, path); err != nil {
			return manifestSnapshot{}, fmt.Errorf("manifest path %s: %w", name, err)
		}
		if _, err := pathWithin(sourceRoot, path); err != nil {
			return manifestSnapshot{}, fmt.Errorf("manifest path %s: %w", name, err)
		}
		data, rootedInfo, err := readBoundedRegularFileWithinRoot(sourceRoot, filepath.FromSlash(name), limit-total)
		if err != nil {
			return manifestSnapshot{}, fmt.Errorf("read manifest %s: %w", name, err)
		}
		if !os.SameFile(initialInfo, rootedInfo) {
			return manifestSnapshot{}, fmt.Errorf("manifest changed while reading: %s", name)
		}
		total += int64(len(data))
		result.files[path] = snapshottedInput{data: data, info: rootedInfo}
		result.records = append(result.records, ManifestRecord{
			Kind: filepath.Base(name), Path: "source://" + slash(name),
			SHA256: hashBytes(data), Bytes: int64(len(data)),
		})
	}
	sort.Slice(result.records, func(i, j int) bool { return result.records[i].Path < result.records[j].Path })
	return result, nil
}

func verifyManifestSnapshot(snapshot manifestSnapshot, sourceRoot string, limit int64) bool {
	for _, name := range manifestNames {
		path, err := safeJoin(sourceRoot, name)
		if err != nil {
			return false
		}
		captured, existed := snapshot.files[path]
		if !existed {
			file, err := openRootedMetadataFile(sourceRoot, filepath.FromSlash(name))
			if err == nil {
				_ = file.Close()
				return false
			}
			if !os.IsNotExist(err) {
				return false
			}
			continue
		}
		data, info, err := readBoundedRegularFileWithinRoot(
			sourceRoot, filepath.FromSlash(name), min(limit, int64(len(captured.data))+1))
		if err != nil || !os.SameFile(captured.info, info) || !bytes.Equal(data, captured.data) {
			return false
		}
	}
	return true
}

type mirrorBudget struct {
	files int
	bytes int64
}

type mirroredTree struct {
	sourceRoot string
	mirrorRoot string
	files      map[string]snapshottedInput
}

type sourceMirror struct {
	root          string
	manifests     manifestSnapshot
	manifestRoots []manifestRootSnapshot
	trees         []mirroredTree
}

type manifestRootSnapshot struct {
	root     string
	snapshot manifestSnapshot
}

func createSourceMirror(sourceRoot, outRoot, workRoot string, limits Limits) (sourceMirror, error) {
	return createSourceMirrorContext(context.Background(), sourceRoot, outRoot, workRoot, limits)
}

func createSourceMirrorContext(ctx context.Context, sourceRoot, outRoot, workRoot string, limits Limits) (sourceMirror, error) {
	if err := ctx.Err(); err != nil {
		return sourceMirror{}, err
	}
	var err error
	sourceRoot, err = secureRoot(sourceRoot)
	if err != nil {
		return sourceMirror{}, fmt.Errorf("secure source root: %w", err)
	}
	outRoot, err = secureRoot(outRoot)
	if err != nil {
		return sourceMirror{}, fmt.Errorf("secure output root: %w", err)
	}
	workRoot, err = secureRoot(workRoot)
	if err != nil {
		return sourceMirror{}, fmt.Errorf("secure work root: %w", err)
	}
	if err := validateResolvedOutputSourceRoots(sourceRoot, outRoot); err != nil {
		return sourceMirror{}, err
	}
	mirrorBase := filepath.Join(workRoot, "source-mirror")
	root := filepath.Join(mirrorBase, "source")
	budget := &mirrorBudget{}
	tree, err := captureTreeContext(ctx, sourceRoot, root, []string{outRoot, workRoot}, limits, budget)
	if err != nil {
		return sourceMirror{}, fmt.Errorf("create immutable source mirror: %w", err)
	}
	result := sourceMirror{root: root, trees: []mirroredTree{tree}}
	mainManifests := manifestsFromTree(tree, sourceRoot, "source://")
	result.manifests = mainManifests
	result.manifestRoots = append(result.manifestRoots, manifestRootSnapshot{root: sourceRoot, snapshot: mainManifests})
	goModPath := filepath.Join(sourceRoot, "go.mod")
	capturedGoMod, ok := tree.files[goModPath]
	if !ok {
		return sourceMirror{}, errors.New("source root has no regular go.mod")
	}
	parsed, err := modfile.Parse("go.mod", capturedGoMod.data, nil)
	if err != nil {
		return sourceMirror{}, fmt.Errorf("parse captured go.mod: %w", err)
	}
	mirroredReplacements := map[string]string{}
	rewritten := false
	type replacementDirective struct {
		oldPath, oldVersion string
		newPath, newVersion string
	}
	replacements := make([]replacementDirective, 0, len(parsed.Replace))
	for _, replacement := range parsed.Replace {
		if err := ctx.Err(); err != nil {
			return sourceMirror{}, err
		}
		replacements = append(replacements, replacementDirective{
			oldPath: replacement.Old.Path, oldVersion: replacement.Old.Version,
			newPath: replacement.New.Path, newVersion: replacement.New.Version,
		})
	}
	for _, replacement := range replacements {
		if err := ctx.Err(); err != nil {
			return sourceMirror{}, err
		}
		if replacement.newVersion != "" {
			continue
		}
		replacementRoot, err := resolveLocalReplacementRoot(sourceRoot, replacement.newPath)
		if err != nil {
			return sourceMirror{}, fmt.Errorf("local replacement %s: %w", replacement.oldPath, err)
		}
		destination := ""
		replacementTree := tree
		if lexicallyWithin(sourceRoot, replacementRoot) {
			relative, relativeErr := filepath.Rel(sourceRoot, replacementRoot)
			if relativeErr != nil {
				return sourceMirror{}, relativeErr
			}
			destination = filepath.Join(root, relative)
		} else {
			if lexicallyWithin(outRoot, replacementRoot) {
				return sourceMirror{}, fmt.Errorf("local replacement %s points into the output root", replacement.oldPath)
			}
			destination = mirroredReplacements[replacementRoot]
			if destination == "" {
				destination = filepath.Join(mirrorBase, "replacements", hashBytes([]byte(replacement.oldPath + "\x00" + replacement.newPath))[:16])
				var captureErr error
				replacementTree, captureErr = captureTreeContext(ctx, replacementRoot, destination, nil, limits, budget)
				if captureErr != nil {
					return sourceMirror{}, fmt.Errorf("mirror local replacement %s: %w", replacement.oldPath, captureErr)
				}
				result.trees = append(result.trees, replacementTree)
				mirroredReplacements[replacementRoot] = destination
			} else {
				for _, candidate := range result.trees {
					if candidate.sourceRoot == replacementRoot {
						replacementTree = candidate
						break
					}
				}
			}
		}
		if err := parsed.AddReplace(replacement.oldPath, replacement.oldVersion, filepath.ToSlash(destination), ""); err != nil {
			return sourceMirror{}, fmt.Errorf("rewrite local replacement %s: %w", replacement.oldPath, err)
		}
		replacementManifests := manifestsFromTree(replacementTree, replacementRoot, "module://"+replacement.oldPath+"@local/")
		result.manifests.records = append(result.manifests.records, replacementManifests.records...)
		result.manifestRoots = append(result.manifestRoots, manifestRootSnapshot{root: replacementRoot, snapshot: replacementManifests})
		rewritten = true
	}
	if rewritten {
		data, err := parsed.Format()
		if err != nil {
			return sourceMirror{}, fmt.Errorf("format operational go.mod: %w", err)
		}
		if err := os.WriteFile(filepath.Join(root, "go.mod"), data, 0o600); err != nil {
			return sourceMirror{}, fmt.Errorf("write operational go.mod: %w", err)
		}
	}
	sort.Slice(result.manifests.records, func(i, j int) bool {
		return result.manifests.records[i].Path < result.manifests.records[j].Path
	})
	return result, nil
}

func captureTree(sourceRoot, mirrorRoot string, excluded []string, limits Limits, budget *mirrorBudget) (mirroredTree, error) {
	return captureTreeContext(context.Background(), sourceRoot, mirrorRoot, excluded, limits, budget)
}

func captureTreeContext(ctx context.Context, sourceRoot, mirrorRoot string, excluded []string, limits Limits, budget *mirrorBudget) (mirroredTree, error) {
	if err := ctx.Err(); err != nil {
		return mirroredTree{}, err
	}
	if err := os.MkdirAll(mirrorRoot, 0o700); err != nil {
		return mirroredTree{}, err
	}
	result := mirroredTree{sourceRoot: sourceRoot, mirrorRoot: mirrorRoot, files: map[string]snapshottedInput{}}
	err := walkRootedMetadataTree(sourceRoot, func(relative string, entry os.DirEntry) (bool, error) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		path := filepath.Join(sourceRoot, relative)
		if relative == ".git" {
			return false, nil
		}
		if entry.IsDir() {
			if excludedMirrorDirectory(path, entry.Name(), excluded) {
				return false, nil
			}
			if err := os.MkdirAll(filepath.Join(mirrorRoot, relative), 0o700); err != nil {
				return false, err
			}
			return true, nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if slices.Contains(manifestNames, filepath.FromSlash(slash(relative))) {
				return false, fmt.Errorf("manifest is not a regular file: %s", relative)
			}
			return false, nil
		}
		info, err := entry.Info()
		if err != nil {
			return false, err
		}
		if !info.Mode().IsRegular() {
			return false, nil
		}
		if budget.files >= limits.MaxFiles || budget.bytes >= limits.MaxLocalHashBytes {
			return false, errors.New("source mirror exceeds configured limits")
		}
		data, rootedInfo, err := readBoundedRegularFileWithinRootContext(
			ctx, sourceRoot, relative, limits.MaxLocalHashBytes-budget.bytes)
		if err != nil {
			return false, fmt.Errorf("capture %s: %w", relative, err)
		}
		if !os.SameFile(info, rootedInfo) {
			return false, fmt.Errorf("source changed while capturing: %s", relative)
		}
		budget.files++
		budget.bytes += int64(len(data))
		destination := filepath.Join(mirrorRoot, relative)
		if err := os.WriteFile(destination, data, info.Mode().Perm()); err != nil {
			return false, err
		}
		result.files[path] = snapshottedInput{data: data, info: rootedInfo}
		return false, nil
	})
	return result, err
}

func excludedMirrorDirectory(path, name string, excluded []string) bool {
	for _, root := range excluded {
		if root != "" && lexicallyWithin(root, path) {
			return true
		}
	}
	return name == ".git" || name == ".go2gs-work" ||
		strings.HasPrefix(name, ".go2gs-work-") ||
		strings.HasPrefix(name, ".go2gs-worker-") ||
		strings.HasPrefix(name, ".go2gs-bootstrap-")
}

func lexicalRelative(root, path string) (string, error) {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("path escapes root")
	}
	return relative, nil
}

func lexicallyWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func manifestsFromTree(tree mirroredTree, manifestRoot, prefix string) manifestSnapshot {
	result := manifestSnapshot{files: map[string]snapshottedInput{}}
	for _, name := range manifestNames {
		path := filepath.Join(manifestRoot, name)
		captured, ok := tree.files[path]
		if !ok {
			continue
		}
		result.files[path] = captured
		result.records = append(result.records, ManifestRecord{
			Kind: filepath.Base(name), Path: prefix + slash(name),
			SHA256: hashBytes(captured.data), Bytes: int64(len(captured.data)),
		})
	}
	sort.Slice(result.records, func(i, j int) bool { return result.records[i].Path < result.records[j].Path })
	return result
}

func resolveLocalReplacementRoot(sourceRoot, replacement string) (string, error) {
	path := filepath.FromSlash(replacement)
	if !filepath.IsAbs(path) {
		path = filepath.Join(sourceRoot, path)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	if filepath.Clean(absolute) != filepath.Clean(resolved) && !lexicallyWithin(sourceRoot, resolved) {
		return "", errors.New("symlinked local replacement roots are not allowed")
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("local replacement root is not a directory")
	}
	return resolved, nil
}

func (mirror sourceMirror) originalPath(path string) (string, string, snapshottedInput, bool) {
	for _, tree := range mirror.trees {
		relative, err := lexicalRelative(tree.mirrorRoot, path)
		if err != nil {
			continue
		}
		original := filepath.Join(tree.sourceRoot, relative)
		captured, ok := tree.files[original]
		return tree.sourceRoot, relative, captured, ok
	}
	return "", "", snapshottedInput{}, false
}

func (mirror sourceMirror) rootedMirrorPath(path string) (string, string, bool) {
	for _, tree := range mirror.trees {
		relative, err := lexicalRelative(tree.mirrorRoot, path)
		if err == nil {
			return tree.mirrorRoot, relative, true
		}
	}
	return "", "", false
}

func (mirror sourceMirror) originalDirectory(path string) (string, bool) {
	for _, tree := range mirror.trees {
		if filepath.Clean(path) == filepath.Clean(tree.mirrorRoot) {
			return tree.sourceRoot, true
		}
		if relative, err := lexicalRelative(tree.mirrorRoot, path); err == nil {
			return filepath.Join(tree.sourceRoot, relative), true
		}
	}
	return "", false
}

func verifyOriginalPackageInputs(mirror sourceMirror, snapshot packageInputSnapshot) map[string]bool {
	drift := map[string]bool{}
	for path, owners := range snapshot.selectedOwners {
		root, relative, captured, ok := mirror.originalPath(path)
		if !ok || !sameCapturedFile(root, relative, captured) {
			for owner := range owners {
				drift[owner] = true
			}
		}
	}
	for key, directory := range snapshot.packageDirs {
		if len(snapshot.selectedFiles[key]) == 0 {
			continue
		}
		originalDirectory, ok := mirror.originalDirectory(directory)
		if !ok || !samePackageFileSet(originalDirectory, directory) {
			drift[key] = true
		}
	}
	return drift
}

func sameCapturedFile(root, relative string, captured snapshottedInput) bool {
	data, info, err := readBoundedRegularFileWithinRoot(root, relative, int64(len(captured.data))+1)
	return err == nil && os.SameFile(captured.info, info) && bytes.Equal(data, captured.data)
}

func samePackageFileSet(originalDirectory, mirrorDirectory string) bool {
	originalEntries, err := readRootedMetadataDirectory(originalDirectory)
	if err != nil {
		return false
	}
	mirrorEntries, err := readRootedMetadataDirectory(mirrorDirectory)
	if err != nil {
		return false
	}
	actual := map[string]bool{}
	for _, entry := range originalEntries {
		if recognizedGoPackageInput(entry.Name()) {
			actual[entry.Name()] = true
		}
	}
	expected := map[string]bool{}
	for _, entry := range mirrorEntries {
		if recognizedGoPackageInput(entry.Name()) {
			expected[entry.Name()] = true
		}
	}
	return mapsEqual(actual, expected)
}

func mapsEqual(left, right map[string]bool) bool {
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if !right[key] {
			return false
		}
	}
	return true
}

type packageInputSnapshot struct {
	data           map[string][]byte
	overlay        map[string][]byte
	files          map[string]snapshottedInput
	packageFiles   map[string][]string
	selectedFiles  map[string][]string
	packageRoles   map[string]map[string]string
	fileOwners     map[string]map[string]bool
	selectedOwners map[string]map[string]bool
	packageDirs    map[string]string
	portable       map[string]string
	pkgConfig      bool
}

func snapshotPackageInputs(ctx context.Context, selected, captured []*packages.Package, mirror sourceMirror, profile Profile, limits Limits) (packageInputSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return packageInputSnapshot{}, err
	}
	sourceRoot := mirror.root
	result := packageInputSnapshot{
		data:           map[string][]byte{},
		overlay:        map[string][]byte{},
		files:          map[string]snapshottedInput{},
		packageFiles:   map[string][]string{},
		selectedFiles:  map[string][]string{},
		packageRoles:   map[string]map[string]string{},
		fileOwners:     map[string]map[string]bool{},
		selectedOwners: map[string]map[string]bool{},
		packageDirs:    map[string]string{},
		portable:       map[string]string{},
	}
	directories := map[string]map[string]bool{}
	for _, pkg := range captured {
		if err := ctx.Err(); err != nil {
			return packageInputSnapshot{}, err
		}
		key := packageInputKey(pkg)
		result.packageRoles[key] = packageInputRoles(pkg)
		if pkg.Dir != "" {
			result.packageDirs[key] = pkg.Dir
		}
		for _, path := range packageInputPaths(pkg, sourceRoot) {
			result.packageFiles[key] = append(result.packageFiles[key], path)
			if result.fileOwners[path] == nil {
				result.fileOwners[path] = map[string]bool{}
			}
			result.fileOwners[path][key] = true
			if filepath.Ext(path) == ".go" {
				directory := filepath.Dir(path)
				if directories[directory] == nil {
					directories[directory] = map[string]bool{}
				}
				directories[directory][key] = true
			}
		}
		for path, role := range profileSelectedDirectoryInputs(pkg, sourceRoot, profile) {
			result.packageFiles[key] = append(result.packageFiles[key], path)
			result.packageRoles[key][path] = role
			if result.fileOwners[path] == nil {
				result.fileOwners[path] = map[string]bool{}
			}
			result.fileOwners[path][key] = true
		}
		result.packageFiles[key] = uniqueSorted(result.packageFiles[key])
	}
	for _, pkg := range selected {
		if err := ctx.Err(); err != nil {
			return packageInputSnapshot{}, err
		}
		key := packageInputKey(pkg)
		result.packageRoles[key] = packageInputRoles(pkg)
		if pkg.Dir != "" {
			result.packageDirs[key] = pkg.Dir
		}
		result.selectedFiles[key] = packageInputPaths(pkg, sourceRoot)
		for path, role := range profileSelectedDirectoryInputs(pkg, sourceRoot, profile) {
			result.selectedFiles[key] = append(result.selectedFiles[key], path)
			result.packageRoles[key][path] = role
		}
		if err := addProfileSelectedInputs(&result, pkg, sourceRoot, profile); err != nil {
			return packageInputSnapshot{}, err
		}
	}
	sortedDirectories := make([]string, 0, len(directories))
	for directory := range directories {
		sortedDirectories = append(sortedDirectories, directory)
	}
	sort.Strings(sortedDirectories)
	for _, directory := range sortedDirectories {
		if err := ctx.Err(); err != nil {
			return packageInputSnapshot{}, err
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return packageInputSnapshot{}, fmt.Errorf("snapshot source directory: %w", err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !recognizedGoPackageInput(entry.Name()) {
				continue
			}
			path := filepath.Join(directory, entry.Name())
			if result.fileOwners[path] == nil {
				result.fileOwners[path] = map[string]bool{}
			}
			for owner := range directories[directory] {
				result.fileOwners[path][owner] = true
				result.packageFiles[owner] = append(result.packageFiles[owner], path)
				if result.packageRoles[owner][path] == "" {
					result.packageRoles[owner][path] = "ignored"
				}
			}
		}
	}
	var total int64
	pending := map[string]bool{}
	for path := range result.fileOwners {
		pending[path] = true
	}
	for len(pending) > 0 {
		if err := ctx.Err(); err != nil {
			return packageInputSnapshot{}, err
		}
		paths := make([]string, 0, len(pending))
		for path := range pending {
			paths = append(paths, path)
		}
		sort.Strings(paths)
		path := paths[0]
		delete(pending, path)
		if _, captured := result.files[path]; captured {
			continue
		}
		if len(result.files) >= limits.MaxFiles || total >= limits.MaxLocalHashBytes {
			return packageInputSnapshot{}, fmt.Errorf("input snapshot exceeds configured limits")
		}
		root, relative, ok := mirror.rootedMirrorPath(path)
		if !ok {
			return packageInputSnapshot{}, fmt.Errorf("snapshot input %s: path escapes mirrored roots", filepath.Base(path))
		}
		data, rootedInfo, err := readBoundedRegularFileWithinRootContext(
			ctx, root, relative, limits.MaxLocalHashBytes-total)
		if err != nil {
			return packageInputSnapshot{}, fmt.Errorf("snapshot input %s: %w", filepath.Base(path), err)
		}
		total += int64(len(data))
		result.data[path] = data
		result.files[path] = snapshottedInput{data: data, info: rootedInfo}
		if relative, err := pathWithin(sourceRoot, path); err == nil {
			result.portable[path] = "source://" + relative
		}
		if filepath.Ext(path) == ".go" {
			result.overlay[path] = data
		}
		if !nativeIncludeCarrier(path) {
			continue
		}
		includes, malformed := localQuotedIncludes(data)
		if malformed {
			continue
		}
		for _, include := range includes {
			for owner := range result.fileOwners[path] {
				target, ok := resolveLocalInclude(result.packageDirs[owner], path, include)
				if !ok {
					continue
				}
				if _, err := pathWithin(result.packageDirs[owner], target); err != nil {
					continue
				}
				if result.fileOwners[target] == nil {
					result.fileOwners[target] = map[string]bool{}
				}
				result.fileOwners[target][owner] = true
				result.packageFiles[owner] = append(result.packageFiles[owner], target)
				result.packageRoles[owner][target] = "native"
				pending[target] = true
			}
		}
	}
	for key := range result.packageFiles {
		result.packageFiles[key] = uniqueSorted(result.packageFiles[key])
	}
	selectedByKey := map[string]*packages.Package{}
	for _, pkg := range selected {
		selectedByKey[packageInputKey(pkg)] = pkg
	}
	for key, files := range result.selectedFiles {
		pkg := selectedByKey[key]
		activeCgo := pathsImportC(pkg.GoFiles, result.data)
		if profile.CGOEnabled && !activeCgo {
			context := profileBuildContext(profile)
			context.CgoEnabled = true
			for _, candidate := range result.packageFiles[key] {
				if filepath.Ext(candidate) != ".go" {
					continue
				}
				matched, _ := context.MatchFile(filepath.Dir(candidate), filepath.Base(candidate))
				if matched && pathsImportC([]string{candidate}, result.data) {
					activeCgo = true
					files = append(files, candidate)
					result.packageRoles[key][candidate] = "active"
					break
				}
			}
			if activeCgo {
				for _, candidate := range result.packageFiles[key] {
					if nativeIncludeCarrier(candidate) && !contains(files, candidate) {
						files = append(files, candidate)
						result.packageRoles[key][candidate] = "native"
					}
				}
			}
		}
		reachable, _ := selectedNativeIncludes(pkg, selectedNativePaths(files, result.packageRoles[key]), result.data)
		refined := make([]string, 0, len(files))
		for _, path := range files {
			if nativeHeader(path) && !activeCgo && !reachable[path] {
				continue
			}
			if !activeCgo && cgoNativeSource(path) {
				continue
			}
			refined = append(refined, path)
			if result.selectedOwners[path] == nil {
				result.selectedOwners[path] = map[string]bool{}
			}
			result.selectedOwners[path][key] = true
		}
		for path := range reachable {
			if !contains(refined, path) {
				refined = append(refined, path)
			}
			if result.selectedOwners[path] == nil {
				result.selectedOwners[path] = map[string]bool{}
			}
			result.selectedOwners[path][key] = true
		}
		result.selectedFiles[key] = uniqueSorted(refined)
	}
	return result, nil
}

func cgoNativeSource(path string) bool {
	return classifyGoPackageInput(path)&goPackageInputCgoOnly != 0
}

func profileSelectedDirectoryInputs(pkg *packages.Package, sourceRoot string, profile Profile) map[string]string {
	result := map[string]string{}
	if !profile.CGOEnabled || pkg.Dir == "" || pkg.Module == nil ||
		(!pkg.Module.Main && (pkg.Module.Replace == nil || pkg.Module.Replace.Version != "")) {
		return result
	}
	context := build.Default
	context.GOOS = profile.GOOS
	context.GOARCH = profile.GOARCH
	context.Compiler = "gc"
	context.CgoEnabled = true
	context.BuildTags = append([]string{}, profile.BuildTags...)
	context.ToolTags = profileToolTags(profile)
	entries, err := os.ReadDir(pkg.Dir)
	if err != nil {
		return result
	}
	activeCgo := false
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" {
			continue
		}
		path := filepath.Join(pkg.Dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil || !packageVariantSelectsGoFile(pkg, entry.Name(), data) ||
			!pathsImportC([]string{path}, map[string][]byte{path: data}) {
			continue
		}
		matched, _ := context.MatchFile(pkg.Dir, entry.Name())
		if matched {
			result[path] = selectedGoRole(entry.Name())
			activeCgo = true
		}
	}
	if !activeCgo {
		return result
	}
	for _, entry := range entries {
		if entry.IsDir() || !recognizedNativePackageInput(entry.Name()) {
			continue
		}
		matched, _ := context.MatchFile(pkg.Dir, entry.Name())
		if matched {
			result[filepath.Join(pkg.Dir, entry.Name())] = "native"
		}
	}
	return result
}

func addProfileSelectedInputs(snapshot *packageInputSnapshot, pkg *packages.Package, sourceRoot string, profile Profile) error {
	if pkg.Dir == "" || !packageInputPathAllowed(pkg, sourceRoot, filepath.Join(pkg.Dir, "_go2gs_probe")) {
		return nil
	}
	context := profileBuildContext(profile)
	context.CgoEnabled = profile.CGOEnabled
	selected, err := context.ImportDir(pkg.Dir, build.ImportComment)
	if err != nil && selected == nil {
		return fmt.Errorf("classify selected package inputs: %w", err)
	}
	snapshot.pkgConfig = snapshot.pkgConfig || len(selected.CgoPkgConfig) != 0
	names := append([]string{}, selected.CgoFiles...)
	names = append(names, selected.CFiles...)
	names = append(names, selected.CXXFiles...)
	names = append(names, selected.MFiles...)
	names = append(names, selected.HFiles...)
	names = append(names, selected.FFiles...)
	names = append(names, selected.SFiles...)
	names = append(names, selected.SwigFiles...)
	names = append(names, selected.SwigCXXFiles...)
	names = append(names, selected.SysoFiles...)
	activeCgo := len(selected.CgoFiles) != 0
	entries, err := os.ReadDir(pkg.Dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".go" {
			continue
		}
		matched, err := context.MatchFile(pkg.Dir, entry.Name())
		if err != nil || !matched {
			continue
		}
		path := filepath.Join(pkg.Dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil || !packageVariantSelectsGoFile(pkg, entry.Name(), data) ||
			!pathsImportC([]string{path}, map[string][]byte{path: data}) {
			continue
		}
		activeCgo = true
		names = append(names, entry.Name())
	}
	if activeCgo {
		for _, entry := range entries {
			if entry.IsDir() || !recognizedNativePackageInput(entry.Name()) {
				continue
			}
			matched, err := context.MatchFile(pkg.Dir, entry.Name())
			if err != nil {
				return fmt.Errorf("classify native input %s: %w", entry.Name(), err)
			}
			if matched {
				names = append(names, entry.Name())
			}
		}
	}
	key := packageInputKey(pkg)
	for _, name := range uniqueSorted(names) {
		path := filepath.Join(pkg.Dir, name)
		if snapshot.fileOwners[path] == nil {
			snapshot.fileOwners[path] = map[string]bool{}
		}
		snapshot.fileOwners[path][key] = true
		snapshot.packageFiles[key] = append(snapshot.packageFiles[key], path)
		snapshot.selectedFiles[key] = append(snapshot.selectedFiles[key], path)
		if filepath.Ext(path) == ".go" {
			snapshot.packageRoles[key][path] = selectedGoRole(name)
		} else {
			snapshot.packageRoles[key][path] = "native"
		}
	}
	snapshot.packageFiles[key] = uniqueSorted(snapshot.packageFiles[key])
	snapshot.selectedFiles[key] = uniqueSorted(snapshot.selectedFiles[key])
	return nil
}

func packageVariantSelectsGoFile(pkg *packages.Package, name string, data []byte) bool {
	if !strings.HasSuffix(name, "_test.go") {
		return true
	}
	if pkg.ForTest == "" || packageVariant(pkg) == "synthetic-test-main" {
		return false
	}
	file, err := parser.ParseFile(token.NewFileSet(), name, data, parser.PackageClauseOnly)
	return err == nil && file.Name.Name == pkg.Name
}

func selectedGoRole(name string) string {
	if strings.HasSuffix(name, "_test.go") {
		return "test"
	}
	return "active"
}

func profileToolTags(profile Profile) []string {
	settings, _ := resolveArchitectureSettings(profile.GOARCH, profile.ArchitectureFeatures)
	return append([]string{}, settings.toolTags...)
}

func profileBuildContext(profile Profile) build.Context {
	context := build.Default
	context.GOOS = profile.GOOS
	context.GOARCH = profile.GOARCH
	context.Compiler = "gc"
	context.BuildTags = append([]string{}, profile.BuildTags...)
	context.ToolTags = profileToolTags(profile)
	context.ReleaseTags = profileReleaseTags(profile.RequestedGoVersion)
	return context
}

func profileReleaseTags(version string) []string {
	parts := strings.Split(version, ".")
	if len(parts) < 2 || parts[0] != "1" {
		return nil
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil || minor < 1 || minor > 1000 {
		return nil
	}
	tags := make([]string, 0, minor)
	for value := 1; value <= minor; value++ {
		tags = append(tags, fmt.Sprintf("go1.%d", value))
	}
	return tags
}

func selectedPkgConfigDirective(snapshot packageInputSnapshot, profile Profile) bool {
	if snapshot.pkgConfig {
		return true
	}
	for path, data := range snapshot.data {
		if !selectedGoSource(snapshot, path) ||
			filepath.Ext(path) != ".go" || !pathsImportC([]string{path}, snapshot.data) {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, data, parser.ImportsOnly|parser.ParseComments)
		if err != nil {
			continue
		}
		for _, group := range importCCommentGroups(file) {
			for _, line := range strings.Split(group.Text(), "\n") {
				line = strings.TrimSpace(line)
				if !strings.HasPrefix(line, "#cgo ") && !strings.HasPrefix(line, "#cgo\t") {
					continue
				}
				directive, _, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(line, "#cgo")), ":")
				if !ok {
					continue
				}
				fields := strings.Fields(directive)
				if len(fields) == 0 || fields[len(fields)-1] != "pkg-config" {
					continue
				}
				if len(fields) == 1 {
					return true
				}
				for _, condition := range fields[:len(fields)-1] {
					if matchCgoCondition(condition, profile) {
						return true
					}
				}
			}
		}
	}
	return false
}

func importCCommentGroups(file *ast.File) []*ast.CommentGroup {
	var result []*ast.CommentGroup
	seen := map[*ast.CommentGroup]bool{}
	for _, declaration := range file.Decls {
		imports, ok := declaration.(*ast.GenDecl)
		if !ok || imports.Tok != token.IMPORT {
			continue
		}
		for _, candidate := range imports.Specs {
			spec, ok := candidate.(*ast.ImportSpec)
			if !ok || spec.Path == nil {
				continue
			}
			path, err := strconv.Unquote(spec.Path.Value)
			if err != nil || path != "C" {
				continue
			}
			for _, group := range []*ast.CommentGroup{imports.Doc, spec.Doc} {
				if group != nil && !seen[group] {
					seen[group] = true
					result = append(result, group)
				}
			}
		}
	}
	return result
}

func selectedGoSource(snapshot packageInputSnapshot, path string) bool {
	for owner := range snapshot.selectedOwners[path] {
		role := snapshot.packageRoles[owner][path]
		if role == "active" || role == "test" {
			return true
		}
	}
	return false
}

func matchCgoCondition(text string, profile Profile) bool {
	line := "// +build " + text
	if strings.ContainsAny(text, "&|()") {
		line = "//go:build " + text
	}
	expression, err := constraint.Parse(line)
	if err != nil {
		return false
	}
	tags := map[string]bool{
		"cgo": true, profile.GOOS: true, profile.GOARCH: true, "gc": true,
	}
	for _, tag := range profileReleaseTags(profile.RequestedGoVersion) {
		tags[tag] = true
	}
	for _, tag := range profile.BuildTags {
		tags[tag] = true
	}
	for _, tag := range profileToolTags(profile) {
		tags[tag] = true
	}
	switch profile.GOOS {
	case "aix", "android", "darwin", "dragonfly", "freebsd", "hurd", "illumos", "ios", "linux", "netbsd", "openbsd", "solaris":
		tags["unix"] = true
	}
	if profile.GOOS == "android" {
		tags["linux"] = true
	}
	if profile.GOOS == "ios" {
		tags["darwin"] = true
	}
	if profile.GOOS == "illumos" {
		tags["solaris"] = true
	}
	return expression.Eval(func(tag string) bool { return tags[tag] })
}

func packageInputKey(pkg *packages.Package) string {
	return pkg.PkgPath + "\x00" + pkg.ForTest + "\x00" + packageVariant(pkg)
}

func packageInputPaths(pkg *packages.Package, sourceRoot string) []string {
	files := append([]string{}, pkg.GoFiles...)
	files = append(files, pkg.IgnoredFiles...)
	files = append(files, pkg.OtherFiles...)
	files = append(files, pkg.EmbedFiles...)
	var result []string
	for _, path := range uniqueSorted(files) {
		if strings.HasPrefix(filepath.Base(path), "zz_go2gs_inventory_") {
			continue
		}
		if packageInputPathAllowed(pkg, sourceRoot, path) {
			result = append(result, path)
		}
	}
	return result
}

func packageInputPathAllowed(pkg *packages.Package, sourceRoot, path string) bool {
	if _, err := pathWithin(sourceRoot, path); err == nil {
		return true
	}
	return pkg.Module != nil && pkg.Module.Replace != nil && pkg.Module.Replace.Version == "" &&
		pkg.Module.Replace.Dir != "" && func() bool {
		_, err := pathWithin(pkg.Module.Replace.Dir, path)
		return err == nil
	}()
}

func cgoOnlyPackageOverlay(mirror sourceMirror, profile Profile) (map[string][]byte, error) {
	overlay := map[string][]byte{}
	if !profile.CGOEnabled {
		return overlay, nil
	}
	context := build.Default
	context.GOOS = profile.GOOS
	context.GOARCH = profile.GOARCH
	context.Compiler = "gc"
	context.CgoEnabled = true
	context.BuildTags = append([]string{}, profile.BuildTags...)
	context.ToolTags = profileToolTags(profile)
	for _, tree := range mirror.trees {
		root := tree.mirrorRoot
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if !entry.IsDir() {
				return nil
			}
			if path != root && (entry.Name() == ".git" || entry.Name() == "vendor" || strings.HasPrefix(entry.Name(), ".")) {
				return filepath.SkipDir
			}
			selected, err := context.ImportDir(path, build.ImportComment)
			if err != nil || selected == nil || len(selected.CgoFiles) == 0 || len(selected.GoFiles) != 0 {
				return nil
			}
			overlay[filepath.Join(path, "zz_go2gs_inventory_"+selected.Name+".go")] = []byte("package " + selected.Name + "\n")
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return overlay, nil
}

func copyBytesMap(source map[string][]byte) map[string][]byte {
	result := make(map[string][]byte, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func packageInputRoles(pkg *packages.Package) map[string]string {
	roles := map[string]string{}
	for _, path := range pkg.GoFiles {
		roles[path] = "active"
	}
	for _, path := range pkg.IgnoredFiles {
		roles[path] = "ignored"
	}
	for _, path := range pkg.OtherFiles {
		roles[path] = "native"
	}
	for _, path := range pkg.EmbedFiles {
		roles[path] = "embed"
	}
	for path := range roles {
		if strings.HasSuffix(path, "_test.go") && roles[path] != "ignored" {
			roles[path] = "test"
		}
	}
	return roles
}

func verifyPackageInputs(snapshot packageInputSnapshot, loaded []*packages.Package, mirror sourceMirror, profile Profile) map[string]bool {
	sourceRoot := mirror.root
	drift := map[string]bool{}
	actual := map[string][]string{}
	for _, pkg := range loaded {
		files := packageInputPaths(pkg, sourceRoot)
		selectedGo := append([]string{}, pkg.GoFiles...)
		for path := range profileSelectedDirectoryInputs(pkg, sourceRoot, profile) {
			files = append(files, path)
			if filepath.Ext(path) == ".go" {
				selectedGo = append(selectedGo, path)
			}
		}
		files = uniqueSorted(files)
		activeCgo := pathsImportC(selectedGo, snapshot.data)
		key := packageInputKey(pkg)
		reachable, _ := selectedNativeIncludes(pkg, selectedNativePaths(snapshot.selectedFiles[key], snapshot.packageRoles[key]), snapshot.data)
		for _, path := range files {
			if nativeHeader(path) && !activeCgo && !reachable[path] {
				continue
			}
			if !activeCgo && cgoNativeSource(path) {
				continue
			}
			actual[packageInputKey(pkg)] = append(actual[packageInputKey(pkg)], path)
		}
		for path := range reachable {
			if !contains(actual[packageInputKey(pkg)], path) {
				actual[packageInputKey(pkg)] = append(actual[packageInputKey(pkg)], path)
			}
		}
		actual[packageInputKey(pkg)] = uniqueSorted(actual[packageInputKey(pkg)])
	}
	keys := map[string]bool{}
	for key := range snapshot.selectedFiles {
		keys[key] = true
	}
	for key := range actual {
		keys[key] = true
	}
	for key := range keys {
		if !slices.Equal(snapshot.selectedFiles[key], actual[key]) {
			drift[key] = true
		}
	}
	for path, owners := range snapshot.selectedOwners {
		captured := snapshot.files[path]
		root, relative, ok := mirror.rootedMirrorPath(path)
		if !ok {
			for owner := range owners {
				drift[owner] = true
			}
			continue
		}
		data, info, err := readBoundedRegularFileWithinRoot(
			root, relative, int64(len(captured.data))+1)
		if err != nil || !os.SameFile(captured.info, info) || !bytes.Equal(data, captured.data) {
			for owner := range owners {
				drift[owner] = true
			}
		}
	}
	return drift
}

func selectedGoRoot(executable capturedExecutable, handoff string) (string, error) {
	root := inferSelectedGOROOT(executable.sourcePath)
	if root == "" {
		root = handoff
	}
	if root == "" {
		return "", errors.New("selected Go GOROOT cannot be derived from its verified path or parent handoff")
	}
	root, err := secureRoot(root)
	if err != nil {
		return "", fmt.Errorf("selected Go GOROOT: %w", err)
	}
	info, err := os.Lstat(filepath.Join(root, "VERSION"))
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("selected Go GOROOT has no regular VERSION file")
	}
	return root, nil
}

func inferSelectedGOROOT(executable string) string {
	candidate := filepath.Dir(filepath.Dir(executable))
	info, err := os.Lstat(filepath.Join(candidate, "VERSION"))
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	root, err := secureRoot(candidate)
	if err != nil {
		return ""
	}
	return root
}

func replaceEnvironment(env []string, key, value string) []string {
	prefix := key + "="
	result := append([]string{}, env...)
	for i, entry := range result {
		if strings.HasPrefix(entry, prefix) {
			result[i] = prefix + value
			return result
		}
	}
	return append(result, prefix+value)
}

func collectPackages(roots []*packages.Package) []*packages.Package {
	seen := map[*packages.Package]bool{}
	var result []*packages.Package
	var visit func(*packages.Package)
	visit = func(pkg *packages.Package) {
		if pkg == nil || seen[pkg] {
			return
		}
		seen[pkg] = true
		result = append(result, pkg)
		keys := make([]string, 0, len(pkg.Imports))
		for key := range pkg.Imports {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			visit(pkg.Imports[key])
		}
	}
	for _, root := range roots {
		visit(root)
	}
	sort.Slice(result, func(i, j int) bool {
		return packageCanonical(result[i]) < packageCanonical(result[j])
	})
	return result
}

func captureTypedSources(loaded []*packages.Package, captured, overlay map[string][]byte, limit int64) (map[string][]byte, map[string][]byte, error) {
	paths := map[string]bool{}
	for _, pkg := range loaded {
		for _, path := range pkg.GoFiles {
			paths[path] = true
		}
	}
	sorted := make([]string, 0, len(paths))
	for path := range paths {
		sorted = append(sorted, path)
	}
	sort.Strings(sorted)
	all := make(map[string][]byte, len(sorted))
	external := map[string][]byte{}
	var externalBytes int64
	for _, path := range sorted {
		if data, ok := overlay[path]; ok {
			all[path] = data
			continue
		}
		if data, ok := captured[path]; ok {
			all[path] = data
			continue
		}
		remaining := limit - externalBytes
		if remaining < 0 {
			return nil, nil, fmt.Errorf("typed dependency source exceeds limit %d", limit)
		}
		data, err := readBoundedRegularFile(path, remaining)
		if err != nil {
			return nil, nil, fmt.Errorf("capture typed dependency source: %w", err)
		}
		externalBytes += int64(len(data))
		all[path] = data
		external[path] = data
	}
	return all, external, nil
}

func verifyTypedSources(captured map[string][]byte) bool {
	for path, expected := range captured {
		actual, err := readBoundedRegularFile(path, int64(len(expected)))
		if err != nil || !bytes.Equal(actual, expected) {
			return false
		}
	}
	return true
}

func typeCheckPackages(loaded []*packages.Package, sources map[string][]byte, profile Profile) {
	state := map[*packages.Package]uint8{}
	var check func(*packages.Package)
	check = func(pkg *packages.Package) {
		if pkg == nil || state[pkg] == 2 {
			return
		}
		if state[pkg] == 1 {
			pkg.Errors = append(pkg.Errors, packages.Error{Kind: packages.TypeError, Msg: "import cycle while type checking captured source"})
			pkg.IllTyped = true
			return
		}
		state[pkg] = 1
		importPaths := make([]string, 0, len(pkg.Imports))
		for path := range pkg.Imports {
			importPaths = append(importPaths, path)
		}
		sort.Strings(importPaths)
		for _, path := range importPaths {
			check(pkg.Imports[path])
		}

		fset := token.NewFileSet()
		syntax := make([]*ast.File, 0, len(pkg.GoFiles))
		for _, path := range pkg.GoFiles {
			data, ok := sources[path]
			if !ok {
				pkg.Errors = append(pkg.Errors, packages.Error{
					Kind: packages.ParseError,
					Pos:  path,
					Msg:  "captured source is unavailable for type checking",
				})
				continue
			}
			file, err := parser.ParseFile(fset, path, data, parser.ParseComments|parser.SkipObjectResolution|parser.AllErrors)
			if err != nil {
				position := path
				if list, ok := err.(scanner.ErrorList); ok && len(list) != 0 {
					position = list[0].Pos.String()
				}
				pkg.Errors = append(pkg.Errors, packages.Error{Kind: packages.ParseError, Pos: position, Msg: err.Error()})
			}
			if file != nil {
				syntax = append(syntax, file)
			}
		}
		info := &types.Info{
			Types:      map[ast.Expr]types.TypeAndValue{},
			Defs:       map[*ast.Ident]types.Object{},
			Uses:       map[*ast.Ident]types.Object{},
			Implicits:  map[ast.Node]types.Object{},
			Selections: map[*ast.SelectorExpr]*types.Selection{},
			Scopes:     map[ast.Node]*types.Scope{},
			Instances:  map[*ast.Ident]types.Instance{},
		}
		sizes := types.SizesFor("gc", profile.GOARCH)
		if sizes == nil {
			pkg.Errors = append(pkg.Errors, packages.Error{Kind: packages.TypeError, Msg: "unsupported target type sizes for " + profile.GOARCH})
		}
		config := types.Config{
			GoVersion: packageGoVersion(pkg, profile.RequestedGoVersion),
			Importer:  capturedPackageImporter{imports: pkg.Imports},
			Sizes:     sizes,
			Error: func(err error) {
				entry := packages.Error{Kind: packages.TypeError, Msg: err.Error()}
				if typed, ok := err.(types.Error); ok {
					entry.Pos = typed.Fset.Position(typed.Pos).String()
					entry.Msg = typed.Msg
				}
				pkg.Errors = append(pkg.Errors, entry)
			},
		}
		checked, _ := config.Check(pkg.PkgPath, fset, syntax, info)
		pkg.Fset = fset
		pkg.Syntax = syntax
		pkg.Types = checked
		pkg.TypesInfo = info
		pkg.TypesSizes = sizes
		pkg.IllTyped = len(pkg.Errors) != 0
		state[pkg] = 2
	}
	for _, pkg := range loaded {
		check(pkg)
	}
}

type capturedPackageImporter struct {
	imports map[string]*packages.Package
}

func (importer capturedPackageImporter) Import(path string) (*types.Package, error) {
	if path == "unsafe" {
		return types.Unsafe, nil
	}
	if pkg := importer.imports[path]; pkg != nil && pkg.Types != nil {
		return pkg.Types, nil
	}
	return nil, fmt.Errorf("captured import %q is unavailable", path)
}

func packageGoVersion(pkg *packages.Package, fallback string) string {
	version := moduleGoVersion(pkg.Module)
	if version == "" {
		version = fallback
	}
	if version != "" && !strings.HasPrefix(version, "go") {
		version = "go" + version
	}
	return version
}

func validateSemanticGoVersions(selected, goroot, helper string) error {
	if selected != goroot || selected != helper {
		return fmt.Errorf(
			"canonical Go version labels differ: selected cmd/go=%s, GOROOT=%s, go2gs helper=%s",
			selected, goroot, helper,
		)
	}
	return nil
}

func helperSemanticGoVersion() (string, error) {
	runtimeVersion, err := normalizeOfficialGoVersion(runtime.Version(), true)
	if err != nil {
		return "", errors.New("go2gs helper must self-report a canonical final-release Go version")
	}
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "", errors.New("go2gs helper has no authoritative Go build information")
	}
	buildVersion, err := normalizeOfficialGoVersion(info.GoVersion, true)
	if err != nil || buildVersion != runtimeVersion {
		return "", errors.New("go2gs helper runtime and build-info version labels must match")
	}
	if err := validateHelperBuildSettings(info.Settings); err != nil {
		return "", err
	}
	return runtimeVersion, nil
}

func validateHelperBuildSettings(settings []debug.BuildSetting) error {
	for _, setting := range settings {
		if setting.Value == "" {
			continue
		}
		switch setting.Key {
		case "GOEXPERIMENT":
			return errors.New("go2gs helper was built with unsupported GOEXPERIMENT semantics")
		case "DefaultGODEBUG":
			return errors.New("go2gs helper was built with unsupported DefaultGODEBUG semantics")
		}
	}
	return nil
}

func packageCanonical(pkg *packages.Package) string {
	files := append([]string{}, pkg.GoFiles...)
	for i := range files {
		files[i] = filepath.Base(files[i])
	}
	sort.Strings(files)
	module := ""
	if pkg.Module != nil {
		module = pkg.Module.Path + "@" + pkg.Module.Version
		if pkg.Module.Replace != nil {
			if pkg.Module.Replace.Version == "" {
				module += "=>local"
			} else {
				module += "=>" + pkg.Module.Replace.Path + "@" + pkg.Module.Replace.Version
			}
		}
	}
	return module + "\x00" + pkg.PkgPath + "\x00" + packageVariant(pkg) + "\x00" + strings.Join(files, "\x00")
}

func packageVariant(pkg *packages.Package) string {
	switch {
	case pkg.ForTest == "":
		return "ordinary"
	case pkg.Name == "main" && strings.HasSuffix(pkg.PkgPath, ".test"):
		return "synthetic-test-main"
	case strings.HasSuffix(pkg.PkgPath, "_test"):
		return "external-test"
	default:
		return "in-package-test"
	}
}

func sourceCommit(root string) (string, error) {
	gitPath := filepath.Join(root, ".git")
	info, err := os.Lstat(gitPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("inspect repository metadata: %w", err)
	}
	gitDir := gitPath
	commonDir := gitDir
	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return "", errors.New("repository .git metadata is neither a directory nor a regular gitdir file")
		}
		data, err := readBoundedRegularFile(gitPath, 4096)
		if err != nil {
			return "", fmt.Errorf("read repository gitdir metadata: %w", err)
		}
		value := strings.TrimSpace(string(data))
		if strings.ContainsAny(value, "\r\n\x00") || !strings.HasPrefix(value, "gitdir: ") {
			return "", errors.New("repository gitdir metadata is malformed")
		}
		gitDir = strings.TrimSpace(strings.TrimPrefix(value, "gitdir: "))
		if gitDir == "" {
			return "", errors.New("repository gitdir metadata has an empty target")
		}
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(root, gitDir)
		}
		gitDir, err = filepath.Abs(gitDir)
		if err != nil {
			return "", fmt.Errorf("resolve repository gitdir metadata: %w", err)
		}
		if err := rejectSymlinkPath(gitDir); err != nil {
			return "", fmt.Errorf("repository gitdir metadata: %w", err)
		}
		targetInfo, err := os.Lstat(gitDir)
		if err != nil || !targetInfo.IsDir() {
			return "", errors.New("repository gitdir target is not a directory")
		}
		commonDir, err = validateGitDirIndirection(root, gitPath, gitDir)
		if err != nil {
			return "", err
		}
	} else if err := rejectSymlinkPath(gitDir); err != nil {
		return "", fmt.Errorf("repository metadata: %w", err)
	}
	head, err := readBoundedRegularFile(filepath.Join(gitDir, "HEAD"), 4096)
	if err != nil {
		return "", fmt.Errorf("read repository HEAD: %w", err)
	}
	value := strings.TrimSpace(string(head))
	if validCommitID(value) {
		return value, nil
	}
	if !strings.HasPrefix(value, "ref: ") {
		return "", errors.New("repository HEAD is malformed")
	}
	ref := strings.TrimSpace(strings.TrimPrefix(value, "ref: "))
	if !validGitRef(ref) {
		return "", fmt.Errorf("repository HEAD contains invalid ref %q", ref)
	}
	for _, metadataRoot := range uniqueSorted([]string{gitDir, commonDir}) {
		refPath := filepath.Join(metadataRoot, filepath.FromSlash(ref))
		if err := rejectSymlinkPath(refPath); err != nil {
			return "", fmt.Errorf("repository ref %q: %w", ref, err)
		}
		if data, err := readBoundedRegularFile(refPath, 4096); err == nil {
			if commit := strings.TrimSpace(string(data)); validCommitID(commit) {
				return commit, nil
			}
			return "", fmt.Errorf("repository ref %q has malformed content", ref)
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("read repository ref %q: %w", ref, err)
		}
		commit, found, err := packedGitReference(filepath.Join(metadataRoot, "packed-refs"), ref)
		if err != nil {
			return "", err
		}
		if found {
			return commit, nil
		}
	}
	return "", fmt.Errorf("repository ref %q is unresolved", ref)
}

func validateGitDirIndirection(root, gitPath, gitDir string) (string, error) {
	data, err := readBoundedRegularFile(filepath.Join(gitDir, "commondir"), 4096)
	if err != nil {
		return "", errors.New("external gitdir target is not a supported linked worktree")
	}
	common := strings.TrimSpace(string(data))
	if common == "" || strings.ContainsAny(common, "\r\n\x00") {
		return "", errors.New("repository commondir metadata is malformed")
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(gitDir, common)
	}
	common, err = filepath.Abs(common)
	if err != nil {
		return "", fmt.Errorf("resolve repository commondir: %w", err)
	}
	expectedWorktrees := filepath.Join(common, "worktrees")
	relative, err := filepath.Rel(expectedWorktrees, gitDir)
	if err != nil || relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		strings.Contains(relative, string(filepath.Separator)) {
		return "", errors.New("repository gitdir target escapes the linked-worktree metadata area")
	}
	backlink, err := readBoundedRegularFile(filepath.Join(gitDir, "gitdir"), 4096)
	if err != nil {
		return "", errors.New("linked-worktree gitdir backlink is missing or unsafe")
	}
	backlinkPath := strings.TrimSpace(string(backlink))
	if !filepath.IsAbs(backlinkPath) {
		backlinkPath = filepath.Join(gitDir, backlinkPath)
	}
	backlinkPath, err = filepath.Abs(backlinkPath)
	if err != nil || filepath.Clean(backlinkPath) != filepath.Clean(gitPath) {
		return "", errors.New("linked-worktree gitdir backlink does not match the source root")
	}
	if err := rejectSymlinkPath(common); err != nil {
		return "", fmt.Errorf("repository common metadata: %w", err)
	}
	return common, nil
}

func packedGitReference(path, ref string) (string, bool, error) {
	data, err := readBoundedRegularFile(path, 16<<20)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read repository packed refs: %w", err)
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		return "", false, errors.New("repository packed-refs metadata is missing its terminating newline")
	}
	if len(data) == 0 {
		return "", false, nil
	}
	var match, previousRef, lastRef string
	previousPeeled := false
	sortedFile := false
	objectIDWidth := 0
	seen := map[string]bool{}
	headerRegion := true
	headerSeen := false
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			return "", false, errors.New("repository packed-refs metadata contains an empty record")
		}
		if strings.HasPrefix(line, "#") {
			if !headerRegion {
				return "", false, errors.New("repository packed-refs metadata has a comment after its first ref")
			}
			const header = "# pack-refs with: "
			if headerSeen || !strings.HasPrefix(line, header) {
				return "", false, errors.New("repository packed-refs metadata has an invalid header")
			}
			traits := strings.Fields(strings.TrimPrefix(line, header))
			if len(traits) == 0 {
				return "", false, errors.New("repository packed-refs metadata has an empty header")
			}
			headerSeen = true
			seenTraits := map[string]bool{}
			for _, trait := range traits {
				if seenTraits[trait] {
					return "", false, errors.New("repository packed-refs metadata has a duplicate header trait")
				}
				seenTraits[trait] = true
				switch trait {
				case "peeled", "fully-peeled":
				case "sorted":
					sortedFile = true
				default:
					return "", false, fmt.Errorf("repository packed-refs metadata has unknown header trait %q", trait)
				}
			}
			previousRef = ""
			previousPeeled = false
			continue
		}
		headerRegion = false
		if strings.HasPrefix(line, "^") {
			hash := strings.TrimPrefix(line, "^")
			if previousRef == "" || previousPeeled || !validCommitID(hash) || len(hash) != objectIDWidth {
				return "", false, errors.New("repository packed-refs metadata has malformed peeled content")
			}
			previousPeeled = true
			continue
		}
		hash, name, found := strings.Cut(line, " ")
		if !found || strings.ContainsAny(name, " \t\r") || !validCommitID(hash) || !validGitRef(name) || seen[name] {
			return "", false, errors.New("repository packed-refs metadata is malformed")
		}
		if objectIDWidth == 0 {
			objectIDWidth = len(hash)
		} else if len(hash) != objectIDWidth {
			return "", false, errors.New("repository packed-refs metadata mixes object ID widths")
		}
		if sortedFile && lastRef != "" && name <= lastRef {
			return "", false, errors.New("repository packed-refs metadata violates sorted ordering")
		}
		seen[name] = true
		previousRef = name
		lastRef = name
		previousPeeled = false
		if name == ref {
			match = hash
		}
	}
	return match, match != "", nil
}

func readBoundedRegularFile(path string, limit int64) ([]byte, error) {
	return readBoundedRegularFileContext(context.Background(), path, limit)
}

func readBoundedRegularFileContext(ctx context.Context, path string, limit int64) ([]byte, error) {
	return readBoundedRegularFileWithHooksContext(ctx, path, limit, nil, nil)
}

func readBoundedRegularFileAfterOpen(path string, limit int64, afterOpen func()) (data []byte, err error) {
	return readBoundedRegularFileWithHooksContext(context.Background(), path, limit, nil, afterOpen)
}

func readBoundedRegularFileWithHooks(path string, limit int64, beforeOpen, afterOpen func()) (data []byte, err error) {
	return readBoundedRegularFileWithHooksContext(context.Background(), path, limit, beforeOpen, afterOpen)
}

func readBoundedRegularFileWithHooksContext(ctx context.Context, path string, limit int64, beforeOpen, afterOpen func()) (data []byte, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	initialInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !initialInfo.Mode().IsRegular() {
		return nil, errors.New("metadata path is not a regular file")
	}
	if beforeOpen != nil {
		beforeOpen()
	}
	file, err := openMetadataFile(path)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := file.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close metadata file: %w", closeErr)
		}
	}()
	if afterOpen != nil {
		afterOpen()
	}
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect opened metadata file: %w", err)
	}
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect metadata path: %w", err)
	}
	if !openedInfo.Mode().IsRegular() || !pathInfo.Mode().IsRegular() ||
		!os.SameFile(initialInfo, openedInfo) || !os.SameFile(openedInfo, pathInfo) ||
		openedInfo.Size() > limit {
		return nil, errors.New("not a bounded regular file")
	}
	data, err = readBoundedContext(ctx, file, limit)
	if err != nil {
		return nil, fmt.Errorf("read metadata file: %w", err)
	}
	return data, nil
}

func readBoundedRegularFileWithinRoot(root, relative string, limit int64) (data []byte, info os.FileInfo, err error) {
	return readBoundedRegularFileWithinRootContext(context.Background(), root, relative, limit)
}

func readBoundedRegularFileWithinRootContext(ctx context.Context, root, relative string, limit int64) (data []byte, info os.FileInfo, err error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if limit < 0 {
		return nil, nil, errors.New("metadata file size limit is negative")
	}
	if rootedReadBeforeOpenHook != nil {
		rootedReadBeforeOpenHook(root, relative)
	}
	file, err := openRootedMetadataFile(root, relative)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		if closeErr := file.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close rooted metadata file: %w", closeErr)
		}
	}()
	if rootedReadAfterOpenHook != nil {
		rootedReadAfterOpenHook(root, relative)
	}
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, nil, fmt.Errorf("inspect rooted metadata file: %w", err)
	}
	verification, err := openRootedMetadataFile(root, relative)
	if err != nil {
		return nil, nil, fmt.Errorf("reopen rooted metadata file: %w", err)
	}
	verificationInfo, statErr := verification.Stat()
	closeErr := verification.Close()
	if statErr != nil {
		return nil, nil, fmt.Errorf("inspect reopened rooted metadata file: %w", statErr)
	}
	if closeErr != nil {
		return nil, nil, fmt.Errorf("close reopened rooted metadata file: %w", closeErr)
	}
	if !openedInfo.Mode().IsRegular() || !verificationInfo.Mode().IsRegular() ||
		!os.SameFile(openedInfo, verificationInfo) || openedInfo.Size() > limit {
		return nil, nil, errors.New("not a bounded rooted regular file")
	}
	data, err = readBoundedContext(ctx, file, limit)
	if err != nil {
		return nil, nil, fmt.Errorf("read rooted metadata file: %w", err)
	}
	return data, openedInfo, nil
}

func readBoundedContext(ctx context.Context, reader io.Reader, limit int64) ([]byte, error) {
	var result bytes.Buffer
	buffer := make([]byte, 32<<10)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if boundedReadChunkHook != nil {
			boundedReadChunkHook()
		}
		n, err := reader.Read(buffer)
		if n > 0 {
			if int64(result.Len()+n) > limit {
				return nil, errors.New("metadata file exceeds size limit")
			}
			_, _ = result.Write(buffer[:n])
		}
		if errors.Is(err, io.EOF) {
			return result.Bytes(), nil
		}
		if err != nil {
			return nil, err
		}
	}
}

func validGitRef(value string) bool {
	if !strings.HasPrefix(value, "refs/") || strings.HasSuffix(value, "/") ||
		strings.Contains(value, "..") || strings.Contains(value, "@{") ||
		strings.Contains(value, "//") {
		return false
	}
	for _, char := range value {
		if char <= ' ' || char == 0x7f || strings.ContainsRune("~^:?*[\\", char) {
			return false
		}
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || component == "." || component == ".." ||
			strings.HasPrefix(component, ".") || strings.HasSuffix(component, ".") ||
			strings.HasSuffix(component, ".lock") {
			return false
		}
	}
	return true
}

func validCommitID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func sourceIdentity(commit string, manifests []ManifestRecord) string {
	var parts []string
	if commit != "" {
		parts = append(parts, "commit="+commit)
	}
	for _, manifest := range manifests {
		parts = append(parts, manifest.Kind+"\x00"+manifest.Path+"\x00"+manifest.SHA256)
	}
	return stableID("source", strings.Join(parts, "\x00"))
}

func sanitizeMessage(message, sourceRoot string, max int, redactions ...string) string {
	message = strings.ReplaceAll(message, sourceRoot, "<source>")
	for _, redaction := range redactions {
		message = strings.ReplaceAll(message, redaction, "<private-path>")
	}
	message, _ = truncate(message, max)
	return message
}

func copyMap(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func displayMissing(value string) string {
	if value == "" {
		return "<not a git checkout>"
	}
	return value
}

func generatedFile(file *ast.File) bool {
	return ast.IsGenerated(file)
}

func tokenPositionFor(fset *token.FileSet, pos token.Pos, adjusted bool) token.Position {
	if fset == nil || pos == token.NoPos {
		return token.Position{}
	}
	return fset.PositionFor(pos, adjusted)
}
