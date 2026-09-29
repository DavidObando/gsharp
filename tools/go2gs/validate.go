// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"errors"
	"fmt"
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
	if a.MigrationReady && !a.InventoryComplete {
		return errors.New("migrationReady cannot be true when inventory is incomplete")
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
		if err := requireMany(value.ID, "importPackageIds", value.ImportPackageIDs, "package"); err != nil {
			return err
		}
		if err := requireMany(value.ID, "diagnosticIds", value.DiagnosticIDs, "diagnostic"); err != nil {
			return err
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
	return nil
}
