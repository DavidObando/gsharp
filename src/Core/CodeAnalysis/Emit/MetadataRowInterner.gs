// <copyright file="MetadataRowInterner.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Generic
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// Adds `MemberRef`, `TypeSpec` and `MethodSpec` rows to one
/// (cref:MetadataBuilder) and returns the existing row when an identical
/// row was added before (issue #5172).
/// @remarks The emitter's token caches are keyed by symbol or reflection
/// identity, so two equal references that arrive as separate objects each
/// used to add a row; about three quarters of those rows repeated an earlier
/// row. A row is identified by its encoded form: the parent, name and
/// signature handles of a `MemberRef`, the signature blob of a
/// `TypeSpec`, and the method and instantiation blob of a `MethodSpec`.
/// `MetadataBuilder.GetOrAddString` and `GetOrAddBlob` already return one
/// handle per distinct content, so equal handles mean equal rows.
///
/// Determinism: the first occurrence keeps its row number and later
/// occurrences return it. The dictionaries are only probed, never enumerated,
/// so no output order depends on hash iteration order.
internal class MetadataRowInterner {
    private let builder MetadataBuilder
    private let memberRefs Dictionary[(Parent EntityHandle, Name StringHandle, Signature BlobHandle), MemberReferenceHandle]
    private let typeSpecs Dictionary[BlobHandle, TypeSpecificationHandle]
    private let methodSpecs Dictionary[(Method EntityHandle, Instantiation BlobHandle), MethodSpecificationHandle]

    init(builder MetadataBuilder) {
        this.builder = builder
        this.memberRefs = Dictionary[(Parent EntityHandle, Name StringHandle, Signature BlobHandle), MemberReferenceHandle]()
        this.typeSpecs = Dictionary[BlobHandle, TypeSpecificationHandle]()
        this.methodSpecs = Dictionary[(Method EntityHandle, Instantiation BlobHandle), MethodSpecificationHandle]()
    }

    /// Returns the `MemberRef` row for (parent, name, signature), adding it on
    /// first use.
    internal func AddMemberReference(parent EntityHandle, name StringHandle, signature BlobHandle) MemberReferenceHandle {
        let key = (parent, name, signature)
        if this.memberRefs.TryGetValue(key, out var existing) {
            CompilationMeasurements.Count("emit.memberref.reused")
            return existing
        }
        let handle = this.builder.AddMemberReference(parent, name, signature)
        this.memberRefs[key] = handle
        return handle
    }

    /// Returns the `TypeSpec` row for a signature blob, adding it on first use.
    internal func AddTypeSpecification(signature BlobHandle) TypeSpecificationHandle {
        if this.typeSpecs.TryGetValue(signature, out var existing) {
            CompilationMeasurements.Count("emit.typespec.reused")
            return existing
        }
        let handle = this.builder.AddTypeSpecification(signature)
        this.typeSpecs[signature] = handle
        return handle
    }

    /// Returns the `MethodSpec` row for (method, instantiation), adding it on
    /// first use.
    internal func AddMethodSpecification(method EntityHandle, instantiation BlobHandle) MethodSpecificationHandle {
        let key = (method, instantiation)
        if this.methodSpecs.TryGetValue(key, out var existing) {
            CompilationMeasurements.Count("emit.methodspec.reused")
            return existing
        }
        let handle = this.builder.AddMethodSpecification(method, instantiation)
        this.methodSpecs[key] = handle
        return handle
    }
}
