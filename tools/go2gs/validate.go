// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	pathpkg "path"
	"path/filepath"
	"slices"
	"strings"
)

func validateAnalysis(a Analysis) error {
	if a.Schema.Name != schemaName || a.Schema.Version != schemaVersion {
		return fmt.Errorf("unsupported analysis schema %q version %d", a.Schema.Name, a.Schema.Version)
	}
	knownKinds := map[string]bool{
		"blocker": true, "call": true, "constant": true, "dependency": true,
		"diagnostic": true, "embed": true, "feature": true, "file": true,
		"generate": true, "instance": true, "methodSet": true, "module": true,
		"node": true, "package": true, "scope": true, "selection": true,
		"symbol": true, "type": true,
	}
	for _, kind := range a.Schema.RequiredRecordKinds {
		if !knownKinds[kind] {
			return fmt.Errorf("unknown required record kind %q", kind)
		}
	}
	if !slices.Equal(a.Schema.RequiredRecordKinds, requiredRecordKinds) {
		return errors.New("analysis required-record handshake does not exactly match schema v1")
	}
	if err := validateAnalysisHeader(a); err != nil {
		return err
	}
	if err := validateAnalysisCollections(a); err != nil {
		return err
	}
	if err := validateRecordFields(a); err != nil {
		return err
	}
	if a.MigrationReady {
		return errors.New("migrationReady must be false for schema v1 M0 inventories")
	}
	if a.InventoryComplete {
		for _, pkg := range a.Packages {
			if !pkg.InventoryComplete {
				return fmt.Errorf("complete analysis contains incomplete package %q", pkg.ID)
			}
		}
	}
	ids := map[string]string{}
	add := func(id, kind string) error {
		if id == "" {
			return fmt.Errorf("%s record has empty id", kind)
		}
		if existing := ids[id]; existing != "" {
			return fmt.Errorf("duplicate id %q used by %s and %s", id, existing, kind)
		}
		ids[id] = kind
		return nil
	}
	for _, value := range a.Modules {
		if err := add(value.ID, "module"); err != nil {
			return err
		}
	}
	for _, value := range a.Packages {
		if err := add(value.ID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.Files {
		if err := add(value.ID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.Types {
		if err := add(value.ID, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Symbols {
		if err := add(value.ID, "symbol"); err != nil {
			return err
		}
	}
	for _, value := range a.Nodes {
		if err := add(value.ID, "node"); err != nil {
			return err
		}
	}
	for _, value := range a.Constants {
		if err := add(value.ID, "constant"); err != nil {
			return err
		}
	}
	for _, value := range a.Scopes {
		if err := add(value.ID, "scope"); err != nil {
			return err
		}
	}
	for _, value := range a.Selections {
		if err := add(value.ID, "selection"); err != nil {
			return err
		}
	}
	for _, value := range a.Calls {
		if err := add(value.ID, "call"); err != nil {
			return err
		}
	}
	for _, value := range a.MethodSets {
		if err := add(value.ID, "methodSet"); err != nil {
			return err
		}
	}
	for _, value := range a.Instances {
		if err := add(value.ID, "instance"); err != nil {
			return err
		}
	}
	for _, value := range a.Embeds {
		if err := add(value.ID, "embed"); err != nil {
			return err
		}
	}
	for _, value := range a.GenerateDirectives {
		if err := add(value.ID, "generate"); err != nil {
			return err
		}
	}
	for _, value := range a.Dependencies {
		if err := add(value.ID, "dependency"); err != nil {
			return err
		}
	}
	for _, value := range a.FeatureSites {
		if err := add(value.ID, "feature"); err != nil {
			return err
		}
	}
	for _, value := range a.Diagnostics {
		if err := add(value.ID, "diagnostic"); err != nil {
			return err
		}
	}
	for _, value := range a.Blockers {
		if err := add(value.ID, "blocker"); err != nil {
			return err
		}
	}
	require := func(owner, field, id, kind string) error {
		if id == "" {
			return nil
		}
		if ids[id] != kind {
			return fmt.Errorf("%s.%s has dangling %s id %q", owner, field, kind, id)
		}
		return nil
	}
	requireMany := func(owner, field string, values []string, kind string) error {
		for _, id := range values {
			if err := require(owner, field, id, kind); err != nil {
				return err
			}
		}
		return nil
	}
	for _, value := range a.Modules {
		if err := require(value.ID, "replacementId", value.ReplacementID, "module"); err != nil {
			return err
		}
	}
	for _, value := range a.Packages {
		if err := require(value.ID, "moduleId", value.ModuleID, "module"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "fileIds", value.FileIDs, "file"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "compiledFileIds", value.CompiledFileIDs, "file"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "importPackageIds", value.ImportPackageIDs, "package"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "diagnosticIds", value.DiagnosticIDs, "diagnostic"); err != nil {
			return err
		}
		for _, initialization := range value.InitializationOrder {
			if err := require(value.ID, "initializationOrder.fileId", initialization.FileID, "file"); err != nil {
				return err
			}
			if err := require(value.ID, "initializationOrder.nodeId", initialization.NodeID, "node"); err != nil {
				return err
			}
			if err := requireMany(value.ID, "initializationOrder.symbolIds", initialization.SymbolIDs, "symbol"); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Files {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.Types {
		if err := requireMany(value.ID, "typeArgs", value.TypeArgs, "type"); err != nil {
			return err
		}
		for _, field := range value.Fields {
			if err := require(value.ID, "fields.typeId", field.TypeID, "type"); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Symbols {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Nodes {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
		for field, id := range map[string]string{
			"originalTypeId": value.OriginalTypeID, "effectiveTypeId": value.EffectiveTypeID,
			"conversionTypeId": value.ConversionTypeID,
		} {
			if err := require(value.ID, field, id, "type"); err != nil {
				return err
			}
		}
		if err := require(value.ID, "declarationId", value.DeclarationID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "useId", value.UseID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "scopeId", value.ScopeID, "scope"); err != nil {
			return err
		}
		if err := require(value.ID, "parentId", value.ParentID, "node"); err != nil {
			return err
		}
	}
	for _, value := range a.Constants {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "symbolId", value.SymbolID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
		if err := require(value.ID, "contextTypeId", value.ContextTypeID, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Scopes {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "parentId", value.ParentID, "scope"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "symbolIds", value.SymbolIDs, "symbol"); err != nil {
			return err
		}
	}
	for _, value := range a.Selections {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "objectId", value.ObjectID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "receiverTypeId", value.ReceiverTypeID, "type"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Calls {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "calleeSymbolId", value.CalleeSymbolID, "symbol"); err != nil {
			return err
		}
		if err := require(value.ID, "signatureTypeId", value.SignatureTypeID, "type"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "argumentTypeIds", value.ArgumentTypeIDs, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.MethodSets {
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "methodSymbolIds", value.MethodSymbolIDs, "symbol"); err != nil {
			return err
		}
	}
	for _, value := range a.Instances {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "typeId", value.TypeID, "type"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "typeArgIds", value.TypeArgIDs, "type"); err != nil {
			return err
		}
	}
	for _, value := range a.Embeds {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.GenerateDirectives {
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.Dependencies {
		if err := require(value.ID, "fromPackageId", value.FromPackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.FeatureSites {
		if err := require(value.ID, "nodeId", value.NodeID, "node"); err != nil {
			return err
		}
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
		if err := require(value.ID, "fileId", value.FileID, "file"); err != nil {
			return err
		}
	}
	for _, value := range a.Diagnostics {
		if err := require(value.ID, "packageId", value.PackageID, "package"); err != nil {
			return err
		}
	}
	for _, value := range a.Blockers {
		if value.Blocks != "inventory" && value.Blocks != "migration" {
			return fmt.Errorf("%s.blocks has unknown disposition %q", value.ID, value.Blocks)
		}
		if a.InventoryComplete && value.Blocks == "inventory" {
			return errors.New("inventoryComplete cannot be true when inventory blockers exist")
		}
		if a.MigrationReady && value.Blocks == "migration" {
			return errors.New("migrationReady cannot be true when migration blockers exist")
		}
		if err := requireMany(value.ID, "affectedUnits", value.AffectedUnits, "package"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "diagnosticIds", value.DiagnosticIDs, "diagnostic"); err != nil {
			return err
		}
	}
	if err := validateOwnership(a); err != nil {
		return err
	}
	expectedCounts := RecordCounts{
		Modules: len(a.Modules), Packages: len(a.Packages), Files: len(a.Files), Types: len(a.Types), Symbols: len(a.Symbols),
		Nodes: len(a.Nodes), Constants: len(a.Constants), Scopes: len(a.Scopes), Selections: len(a.Selections),
		Calls: len(a.Calls), MethodSets: len(a.MethodSets), Instances: len(a.Instances), Embeds: len(a.Embeds),
		GenerateDirectives: len(a.GenerateDirectives), Dependencies: len(a.Dependencies),
		FeatureSites: len(a.FeatureSites), Diagnostics: len(a.Diagnostics), Blockers: len(a.Blockers),
	}
	expectedCounts.Total = expectedCounts.Modules + expectedCounts.Packages + expectedCounts.Files + expectedCounts.Types +
		expectedCounts.Symbols + expectedCounts.Nodes + expectedCounts.Constants + expectedCounts.Scopes +
		expectedCounts.Selections + expectedCounts.Calls + expectedCounts.MethodSets + expectedCounts.Instances +
		expectedCounts.Embeds + expectedCounts.GenerateDirectives + expectedCounts.Dependencies +
		expectedCounts.FeatureSites + expectedCounts.Diagnostics + expectedCounts.Blockers
	if a.RecordCounts != expectedCounts {
		return fmt.Errorf("recordCounts do not match records: got %#v, expected %#v", a.RecordCounts, expectedCounts)
	}
	if err := validateCompletenessEvidence(a); err != nil {
		return err
	}
	return nil
}

func validateCompletenessEvidence(a Analysis) error {
	hasInventoryBlocker := slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
		return blocker.Blocks == "inventory"
	})
	if !a.InventoryComplete {
		if !hasInventoryBlocker {
			return errors.New("incomplete analysis requires an inventory blocker")
		}
		return nil
	}
	if hasInventoryBlocker {
		return errors.New("complete analysis cannot contain an inventory blocker")
	}
	if len(a.Modules) == 0 || len(a.Packages) == 0 || len(a.Files) == 0 {
		return errors.New("complete analysis requires loaded modules, packages, and source files")
	}
	mainModules := map[string]bool{}
	for _, module := range a.Modules {
		if module.Main {
			mainModules[module.ID] = true
		}
	}
	if len(mainModules) == 0 {
		return errors.New("complete analysis requires a main module")
	}
	for _, pkg := range a.Packages {
		if mainModules[pkg.ModuleID] && len(pkg.FileIDs) != 0 && len(pkg.CompiledFileIDs) != 0 {
			return nil
		}
	}
	return errors.New("complete analysis requires a loaded main-module package with owned source and compiled files")
}

func validateAnalysisHeader(a Analysis) error {
	for name, value := range map[string]VersionIdentity{"tool": a.Tool, "helper": a.Helper} {
		if value.Version == "" || !validSHA256(value.SHA256) {
			return fmt.Errorf("%s identity requires version and SHA-256", name)
		}
	}
	p := a.Profile
	if p.ID == "" || !validSHA256(p.SHA256) || p.SourceRootIdentity == "" ||
		len(p.EntryPatterns) == 0 || p.GOOS == "" || p.GOARCH == "" ||
		p.ModuleMode == "" || p.WorkspaceMode == "" || !p.Offline || p.AllowNetwork ||
		p.GeneratorsExecuted || p.TargetBinariesExecuted || p.TrustBoundary == "" ||
		p.CCompilerHelpers == nil {
		return errors.New("analysis profile snapshot is missing mandatory or fail-closed fields")
	}
	if err := validateLimits(p.Limits); err != nil {
		return fmt.Errorf("analysis profile limits: %w", err)
	}
	if err := validateGOFLAGS(p.GOFLAGS); err != nil {
		return fmt.Errorf("analysis profile: %w", err)
	}
	if err := validateSemanticProfile(Profile{GOEXPERIMENT: p.GOEXPERIMENT, GODEBUG: p.GODEBUG}); err != nil {
		return fmt.Errorf("analysis profile: %w", err)
	}
	if (p.ExpectedSourceCommit != "" && !validCommitID(p.ExpectedSourceCommit)) ||
		(p.ActualSourceCommit != "" && !validCommitID(p.ActualSourceCommit)) {
		return errors.New("analysis source commits must be lowercase 40- or 64-character Git object IDs")
	}
	if (p.ModuleMode != "readonly" && p.ModuleMode != "vendor") ||
		p.VendorMode != (p.ModuleMode == "vendor") || p.WorkspaceMode != "off" {
		return errors.New("analysis profile has inconsistent module or workspace mode")
	}
	t := a.Toolchain
	if t.RequestedVersion == "" || t.ActualVersion == "" || t.HelperSemanticVersion == "" ||
		t.GOROOTVersion == "" || !validSHA256(t.ExecutableSHA256) ||
		t.ExecutableName == "" || t.GOROOTIdentity == "" || !validSHA256(t.GOROOTVersionSHA256) ||
		t.GOROOTSource == "" || t.AutoDownload || t.CCompilerHelpers == nil {
		return errors.New("analysis toolchain provenance is missing mandatory or fail-closed fields")
	}
	for name, version := range map[string]string{
		"requested": t.RequestedVersion,
		"actual":    t.ActualVersion,
		"helper":    t.HelperSemanticVersion,
		"goroot":    t.GOROOTVersion,
	} {
		normalized, err := normalizeOfficialGoVersion(version, false)
		if err != nil || normalized != version {
			return fmt.Errorf("analysis %s Go version is not an exact official release", name)
		}
	}
	if t.ActualVersion != t.HelperSemanticVersion || t.ActualVersion != t.GOROOTVersion {
		return errors.New("analysis selected, GOROOT, and helper semantic Go versions must exactly agree")
	}
	expectedGOROOTIdentity := stableID("goroot",
		t.ActualVersion+"\x00"+t.GOROOTVersion+"\x00"+t.HelperSemanticVersion+"\x00"+
			t.ExecutableSHA256+"\x00"+t.GOROOTVersionSHA256)
	if t.GOROOTIdentity != expectedGOROOTIdentity {
		return errors.New("analysis GOROOT identity does not match semantic versions and hashes")
	}
	if t.RequestedVersion != t.ActualVersion {
		if a.InventoryComplete || !slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
			return blocker.Blocks == "inventory" && blocker.Category == "toolchain"
		}) {
			return errors.New("analysis toolchain version mismatch requires an incomplete inventory and toolchain blocker")
		}
	}
	hasSourceBlocker := slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
		return blocker.Blocks == "inventory" && blocker.Category == "source"
	})
	hasSourceMetadataBlocker := slices.ContainsFunc(a.Blockers, func(blocker BlockerRecord) bool {
		return blocker.Blocks == "inventory" && blocker.Category == "source-metadata"
	})
	if p.ExpectedSourceCommit != "" && p.ActualSourceCommit == "" && !hasSourceMetadataBlocker {
		return errors.New("missing actual source commit requires a source-metadata blocker")
	}
	if p.ActualSourceCommit != "" && hasSourceMetadataBlocker {
		return errors.New("source-metadata blocker requires a missing actual source commit")
	}
	sourceMismatch := p.ExpectedSourceCommit != "" && p.ActualSourceCommit != "" &&
		p.ExpectedSourceCommit != p.ActualSourceCommit
	if sourceMismatch != hasSourceBlocker {
		return errors.New("analysis source commit mismatch and source blocker must agree")
	}
	if t.CCompilerName != "" || t.CCompilerSHA256 != "" ||
		len(t.CCompilerHelpers) != 0 || len(p.CCompilerHelpers) != 0 {
		return errors.New("M0 analysis must not contain obsolete C compiler provenance")
	}
	return nil
}

func validateAnalysisCollections(a Analysis) error {
	switch {
	case a.Schema.RequiredRecordKinds == nil:
		return errors.New("schema.requiredRecordKinds must be an array")
	case a.Profile.EntryPatterns == nil:
		return errors.New("profile.entryPatterns must be an array")
	case a.Profile.ArchitectureFeatures == nil:
		return errors.New("profile.architectureFeatures must be an array")
	case a.Profile.BuildTags == nil:
		return errors.New("profile.buildTags must be an array")
	case a.Profile.GOFLAGS == nil:
		return errors.New("profile.goFlags must be an array")
	case a.Profile.GODEBUG == nil:
		return errors.New("profile.goDebug must be an object")
	case a.Manifests == nil, a.Modules == nil, a.Packages == nil, a.Files == nil,
		a.Types == nil, a.Symbols == nil, a.Nodes == nil, a.Constants == nil,
		a.Scopes == nil, a.Selections == nil, a.Calls == nil, a.MethodSets == nil,
		a.Instances == nil, a.Embeds == nil, a.GenerateDirectives == nil,
		a.Dependencies == nil, a.FeatureSites == nil, a.Diagnostics == nil, a.Blockers == nil:
		return errors.New("analysis record collections must be arrays, not null or missing")
	}
	return nil
}

func validateRecordFields(a Analysis) error {
	for _, value := range a.Manifests {
		if value.Kind == "" || !validPortableLocation(value.Path) || !validSHA256(value.SHA256) || value.Bytes < 0 {
			return fmt.Errorf("manifest %q has invalid required fields", value.Path)
		}
	}
	for _, value := range a.Modules {
		if value.ID == "" || value.Path == "" || filepath.IsAbs(value.Path) ||
			filepath.VolumeName(value.Path) != "" || strings.Contains(value.Path, "\\") ||
			(value.LocalContentSHA256 != "" && !validSHA256(value.LocalContentSHA256)) {
			return fmt.Errorf("module %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.Packages {
		if value.ID == "" || value.ImportPath == "" || value.Name == "" || value.Variant == "" ||
			value.FileIDs == nil || value.CompiledFileIDs == nil || value.ImportPackageIDs == nil ||
			value.InitializationOrder == nil || value.DiagnosticIDs == nil {
			return fmt.Errorf("package %q has invalid required fields", value.ID)
		}
		for index, initialization := range value.InitializationOrder {
			if initialization.Order != index ||
				(initialization.Kind != "variable" && initialization.Kind != "init-function") ||
				initialization.SymbolIDs == nil {
				return fmt.Errorf("package %q has invalid initialization record %d", value.ID, index)
			}
			hasFile, hasNode := initialization.FileID != "", initialization.NodeID != ""
			if hasFile != hasNode || (initialization.Kind == "init-function" && !hasFile) ||
				(initialization.Kind == "variable" && len(value.CompiledFileIDs) > 0 && !hasFile) {
				return fmt.Errorf("package %q initialization record %d has incomplete location", value.ID, index)
			}
			if initialization.Kind == "variable" && len(initialization.SymbolIDs) == 0 {
				return fmt.Errorf("package %q variable initialization %d has no symbols", value.ID, index)
			}
		}
	}
	for _, value := range a.Files {
		data, err := base64.StdEncoding.DecodeString(value.ContentBase64)
		if value.ID == "" || value.PackageID == "" || !validPortableLocation(value.Path) ||
			value.Role == "" || value.Provenance == "" ||
			!validSHA256(value.SHA256) || value.Bytes < 0 || err != nil ||
			int64(len(data)) != value.Bytes || hashBytes(data) != value.SHA256 {
			return fmt.Errorf("file %q has invalid required fields or content identity", value.ID)
		}
	}
	for _, value := range a.Types {
		if value.ID == "" || value.Kind == "" || value.Canonical == "" || value.Display == "" ||
			value.TypeArgs == nil || value.Fields == nil {
			return fmt.Errorf("type %q has invalid required fields", value.ID)
		}
		for index, field := range value.Fields {
			if field.Name == "" || field.TypeID == "" {
				return fmt.Errorf("type %q struct field %d has invalid required fields", value.ID, index)
			}
			if field.TagBase64 != "" {
				if _, err := base64.StdEncoding.DecodeString(field.TagBase64); err != nil {
					return fmt.Errorf("type %q struct field %d has invalid tag encoding", value.ID, index)
				}
			}
		}
	}
	for _, value := range a.Symbols {
		if value.ID == "" || value.PackageID == "" || value.Name == "" || value.Kind == "" {
			return fmt.Errorf("symbol %q has invalid required fields", value.ID)
		}
		if value.Declaration != nil {
			if err := validateSourceSpan(*value.Declaration, value.ID+".declaration"); err != nil {
				return err
			}
		}
	}
	for _, value := range a.Nodes {
		if value.ID == "" || value.PackageID == "" || value.FileID == "" || value.Kind == "" {
			return fmt.Errorf("node %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Constants {
		if value.ID == "" || value.NodeID == "" || value.Category == "" || value.Exact == "" {
			return fmt.Errorf("constant %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Scopes {
		if value.ID == "" || value.PackageID == "" || value.SymbolIDs == nil || value.Labels == nil {
			return fmt.Errorf("scope %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Selections {
		if value.ID == "" || value.NodeID == "" || value.Kind == "" || value.ObjectID == "" ||
			value.ReceiverTypeID == "" || value.TypeID == "" || value.IndexPath == nil {
			return fmt.Errorf("selection %q has invalid required fields", value.ID)
		}
		for _, index := range value.IndexPath {
			if index < 0 {
				return fmt.Errorf("selection %q has negative index path", value.ID)
			}
		}
	}
	for _, value := range a.Calls {
		if value.ID == "" || value.NodeID == "" || value.Kind == "" || value.ArgumentTypeIDs == nil {
			return fmt.Errorf("call %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.MethodSets {
		if value.ID == "" || value.TypeID == "" || value.MethodSymbolIDs == nil {
			return fmt.Errorf("method set %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.Instances {
		if value.ID == "" || value.NodeID == "" || value.TypeID == "" || value.TypeArgIDs == nil {
			return fmt.Errorf("instance %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.Embeds {
		if value.ID == "" || value.PackageID == "" || value.FileID == "" || value.Pattern == "" ||
			value.LogicalName == "" || !validSHA256(value.ContentSHA256) {
			return fmt.Errorf("embed %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.GenerateDirectives {
		if value.ID == "" || value.FileID == "" || value.Directive == "" || value.Executed {
			return fmt.Errorf("generate directive %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Dependencies {
		if value.ID == "" || value.FromPackageID == "" || value.ImportPath == "" || value.Disposition == "" {
			return fmt.Errorf("dependency %q has invalid required fields", value.ID)
		}
	}
	for _, value := range a.FeatureSites {
		if value.ID == "" || value.NodeID == "" || value.PackageID == "" || value.FileID == "" ||
			value.Feature == "" || value.Disposition == "" {
			return fmt.Errorf("feature %q has invalid required fields", value.ID)
		}
		if err := validateSourceSpan(value.Span, value.ID+".span"); err != nil {
			return err
		}
	}
	for _, value := range a.Diagnostics {
		if value.ID == "" || value.Category == "" || value.Severity == "" || value.Message == "" {
			return fmt.Errorf("diagnostic %q has invalid required fields", value.ID)
		}
		if value.Span != nil {
			if err := validateSourceSpan(*value.Span, value.ID+".span"); err != nil {
				return err
			}
		}
	}

	for _, value := range a.Blockers {
		if value.ID == "" || value.Blocks == "" || value.Category == "" || value.Message == "" ||
			value.AffectedUnits == nil || value.DiagnosticIDs == nil {
			return fmt.Errorf("blocker %q has invalid required fields", value.ID)
		}
	}
	return nil
}

func validateSourceSpan(span SourceSpan, owner string) error {
	if !validPortableLocation(span.Path) || !validPortableLocation(span.DisplayPath) ||
		span.StartByte < 0 || span.EndByte < span.StartByte ||
		span.StartLine < 1 || span.StartColumn < 1 || span.EndLine < span.StartLine ||
		(span.EndLine == span.StartLine && span.EndColumn < span.StartColumn) ||
		span.EndColumn < 1 || span.DisplayLine < 1 || span.DisplayColumn < 0 ||
		(!span.LineDirective && (span.DisplayPath != span.Path ||
			span.DisplayLine != span.StartLine || span.DisplayColumn != span.StartColumn)) ||
		(span.LineDirective && !strings.HasPrefix(span.DisplayPath, "line://")) {
		return fmt.Errorf("%s is not a complete, ordered source span: %#v", owner, span)
	}
	return nil
}

func validateOwnership(a Analysis) error {
	packages := make(map[string]PackageRecord, len(a.Packages))
	files := make(map[string]FileRecord, len(a.Files))
	nodes := make(map[string]NodeRecord, len(a.Nodes))
	symbols := make(map[string]SymbolRecord, len(a.Symbols))
	packagePaths := make(map[string]bool, len(a.Packages))
	fileListings := map[string]map[string]int{}
	for _, pkg := range a.Packages {
		packages[pkg.ID] = pkg
		packagePaths[pkg.ImportPath] = true
		listings := map[string]int{}
		for _, fileID := range pkg.FileIDs {
			listings[fileID]++
			if listings[fileID] != 1 {
				return fmt.Errorf("package %q lists file %q more than once", pkg.ID, fileID)
			}
		}
		fileListings[pkg.ID] = listings
		compiled := map[string]bool{}
		for _, fileID := range pkg.CompiledFileIDs {
			if compiled[fileID] {
				return fmt.Errorf("package %q lists compiled file %q more than once", pkg.ID, fileID)
			}
			compiled[fileID] = true
			if listings[fileID] != 1 {
				return fmt.Errorf("package %q compiled file %q is not listed exactly once", pkg.ID, fileID)
			}
		}
	}
	for _, file := range a.Files {
		if _, ok := packages[file.PackageID]; !ok {
			return fmt.Errorf("file %q has unknown package %q", file.ID, file.PackageID)
		}
		if fileListings[file.PackageID][file.ID] != 1 {
			return fmt.Errorf("file %q is not listed exactly once by package %q", file.ID, file.PackageID)
		}
		files[file.ID] = file
	}
	for _, pkg := range a.Packages {
		for _, fileID := range pkg.FileIDs {
			if file, ok := files[fileID]; !ok || file.PackageID != pkg.ID {
				return fmt.Errorf("package %q lists file %q owned by another package", pkg.ID, fileID)
			}
		}
	}
	for _, node := range a.Nodes {
		file, ok := files[node.FileID]
		if !ok || file.PackageID != node.PackageID {
			return fmt.Errorf("node %q package/file ownership is inconsistent", node.ID)
		}
		if err := validateSpanForFile(node.Span, file, node.ID+".span"); err != nil {
			return err
		}
		nodes[node.ID] = node
	}
	for _, node := range a.Nodes {
		if node.ParentID == "" {
			continue
		}
		parent, ok := nodes[node.ParentID]
		if !ok || parent.PackageID != node.PackageID || parent.FileID != node.FileID {
			return fmt.Errorf("node %q parent %q ownership is inconsistent", node.ID, node.ParentID)
		}
	}
	for _, symbol := range a.Symbols {
		if _, ok := packages[symbol.PackageID]; !ok {
			return fmt.Errorf("symbol %q has unknown package %q", symbol.ID, symbol.PackageID)
		}
		if symbol.Declaration != nil {
			if err := validateSpanInPackage(*symbol.Declaration, symbol.PackageID, fileListings, files, symbol.ID+".declaration"); err != nil {
				return err
			}
		}
		symbols[symbol.ID] = symbol
	}
	for _, node := range a.Nodes {
		if node.DeclarationID == "" {
			continue
		}
		symbol := symbols[node.DeclarationID]
		if symbol.PackageID != node.PackageID || symbol.Declaration == nil || *symbol.Declaration != node.Span {
			return fmt.Errorf("node %q (%s) declaration %q ownership or span is inconsistent: node=%#v declaration=%#v", node.ID, node.Kind, node.DeclarationID, node.Span, symbol.Declaration)
		}
	}
	diagnostics := make(map[string]DiagnosticRecord, len(a.Diagnostics))
	for _, diagnostic := range a.Diagnostics {
		diagnostics[diagnostic.ID] = diagnostic
	}
	for _, pkg := range a.Packages {
		diagnosticListings := map[string]bool{}
		for _, diagnosticID := range pkg.DiagnosticIDs {
			diagnostic := diagnostics[diagnosticID]
			if diagnosticListings[diagnosticID] || diagnostic.PackageID != pkg.ID {
				return fmt.Errorf("package %q diagnostic %q ownership is inconsistent", pkg.ID, diagnosticID)
			}
			diagnosticListings[diagnosticID] = true
		}
		for _, initialization := range pkg.InitializationOrder {
			if initialization.FileID != "" {
				file, ok := files[initialization.FileID]
				if !ok || file.PackageID != pkg.ID || fileListings[pkg.ID][file.ID] != 1 {
					return fmt.Errorf("package %q initialization file ownership is inconsistent", pkg.ID)
				}
				node, ok := nodes[initialization.NodeID]
				if !ok || node.PackageID != pkg.ID || node.FileID != file.ID {
					return fmt.Errorf("package %q initialization node ownership is inconsistent", pkg.ID)
				}
				if initialization.Kind == "init-function" && node.Kind != "*ast.FuncDecl" {
					return fmt.Errorf("package %q init-function does not reference a function declaration", pkg.ID)
				}
			}
			for _, symbolID := range initialization.SymbolIDs {
				if symbol, ok := symbols[symbolID]; !ok || symbol.PackageID != pkg.ID {
					return fmt.Errorf("package %q initialization symbol ownership is inconsistent", pkg.ID)
				}
			}
		}
	}
	for _, scope := range a.Scopes {
		if scope.ParentID != "" {
			parent := findScope(a.Scopes, scope.ParentID)
			if parent == nil || parent.PackageID != scope.PackageID {
				return fmt.Errorf("scope %q parent ownership is inconsistent", scope.ID)
			}
		}
		if err := validateSpanInPackage(scope.Span, scope.PackageID, fileListings, files, scope.ID+".span"); err != nil {
			return err
		}
		for _, symbolID := range scope.SymbolIDs {
			if symbol, ok := symbols[symbolID]; !ok || symbol.PackageID != scope.PackageID {
				return fmt.Errorf("scope %q symbol ownership is inconsistent", scope.ID)
			}
		}
	}
	constantsBySymbol := map[string]int{}
	for _, constant := range a.Constants {
		node := nodes[constant.NodeID]
		if constant.Span != node.Span {
			return fmt.Errorf("constant %q span does not match node %q", constant.ID, constant.NodeID)
		}
		if constant.SymbolID != "" {
			symbol := symbols[constant.SymbolID]
			if node.DeclarationID != symbol.ID || node.PackageID != symbol.PackageID {
				return fmt.Errorf("constant %q declaration ownership is inconsistent", constant.ID)
			}
			constantsBySymbol[constant.SymbolID]++
			if constantsBySymbol[constant.SymbolID] != 1 {
				return fmt.Errorf("symbol %q has multiple declared constant values", constant.SymbolID)
			}
		}
	}
	for _, symbol := range a.Symbols {
		if symbol.Kind == "constant" && symbol.Declaration != nil && constantsBySymbol[symbol.ID] != 1 {
			return fmt.Errorf("declared constant symbol %q must have exactly one linked value", symbol.ID)
		}
	}
	for _, embed := range a.Embeds {
		if file := files[embed.FileID]; file.PackageID != embed.PackageID ||
			!file.Embed || file.SHA256 != embed.ContentSHA256 {
			return fmt.Errorf("embed %q package/file ownership is inconsistent", embed.ID)
		}
	}

	for _, generate := range a.GenerateDirectives {
		if err := validateSpanForFile(generate.Span, files[generate.FileID], generate.ID+".span"); err != nil {
			return err
		}
	}
	for _, feature := range a.FeatureSites {
		node := nodes[feature.NodeID]
		if node.PackageID != feature.PackageID || node.FileID != feature.FileID || node.Span != feature.Span {
			return fmt.Errorf("feature %q node/package/file/span ownership is inconsistent", feature.ID)
		}
	}
	for _, diagnostic := range a.Diagnostics {
		if diagnostic.PackageID != "" {
			pkg, ok := packages[diagnostic.PackageID]
			if !ok {
				return fmt.Errorf("diagnostic %q has unknown package %q", diagnostic.ID, diagnostic.PackageID)
			}
			if !slices.Contains(pkg.DiagnosticIDs, diagnostic.ID) {
				return fmt.Errorf("diagnostic %q is not listed by package %q", diagnostic.ID, diagnostic.PackageID)
			}
			if diagnostic.Span != nil {
				if err := validateSpanInPackage(*diagnostic.Span, diagnostic.PackageID, fileListings, files, diagnostic.ID+".span"); err != nil {
					return err
				}
			}
		}
	}
	for _, value := range a.Types {
		if value.Package != "" && !packagePaths[value.Package] {
			return fmt.Errorf("type %q has unknown package path %q", value.ID, value.Package)
		}
	}
	return nil
}

func findScope(scopes []ScopeRecord, id string) *ScopeRecord {
	for i := range scopes {
		if scopes[i].ID == id {
			return &scopes[i]
		}
	}
	return nil
}

func validateSpanInPackage(span SourceSpan, packageID string, listings map[string]map[string]int, files map[string]FileRecord, owner string) error {
	for fileID := range listings[packageID] {
		file := files[fileID]
		if file.Path == span.Path {
			return validateSpanForFile(span, file, owner)
		}
	}
	return fmt.Errorf("%s path %q does not belong to package %q", owner, span.Path, packageID)
}

func validateSpanForFile(span SourceSpan, file FileRecord, owner string) error {
	if span.Path != file.Path || int64(span.StartByte) > file.Bytes || int64(span.EndByte) > file.Bytes {
		return fmt.Errorf("%s does not match file %q or exceeds its byte bounds", owner, file.ID)
	}
	data, err := base64.StdEncoding.DecodeString(file.ContentBase64)
	if err != nil {
		return fmt.Errorf("%s references file %q with invalid content", owner, file.ID)
	}
	startLine, startColumn := sourceCoordinate(data, span.StartByte)
	endLine, endColumn := sourceCoordinate(data, span.EndByte)
	if span.StartLine != startLine || span.StartColumn != startColumn ||
		span.EndLine != endLine || span.EndColumn != endColumn {
		return fmt.Errorf("%s raw coordinates do not match file %q byte offsets", owner, file.ID)
	}
	if !span.LineDirective && (span.DisplayPath != span.Path ||
		span.DisplayLine != span.StartLine || span.DisplayColumn != span.StartColumn) {
		return fmt.Errorf("%s display coordinates differ without //line provenance", owner)
	}
	return nil
}

func sourceCoordinate(data []byte, offset int) (line, column int) {
	line, column = 1, 1
	for index := 0; index < offset; index++ {
		if data[index] == '\n' {
			line, column = line+1, 1
		} else {
			column++
		}
	}
	return line, column
}

func validPortableLocation(value string) bool {
	if value == "" || filepath.IsAbs(value) {
		return false
	}
	prefixes := []string{"source://", "module://", "goroot://", "line://", "external://"}
	prefix := ""
	for _, candidate := range prefixes {
		if strings.HasPrefix(value, candidate) {
			prefix = candidate
			break
		}
	}
	if prefix == "" {
		return false
	}
	path := strings.TrimPrefix(value, prefix)
	if path == "" || path == "." || strings.Contains(path, "\\") || isDrivePath(path) ||
		strings.HasPrefix(path, "/") || filepath.IsAbs(path) || filepath.VolumeName(path) != "" {
		return false
	}
	clean := pathpkg.Clean(path)
	return clean == path && clean != ".." && !strings.HasPrefix(clean, "../")
}

func isDrivePath(value string) bool {
	return len(value) >= 2 && ((value[0] >= 'a' && value[0] <= 'z') ||
		(value[0] >= 'A' && value[0] <= 'Z')) && value[1] == ':'
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
