// <copyright file="DiagnosticDescriptors.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Microsoft.CodeAnalysis;

namespace GSharp.InternalAnalyzers;

/// <summary>
/// Diagnostic descriptors for G# internal source analyzers.
/// </summary>
public static class DiagnosticDescriptors
{
    /// <summary>
    /// Reports direct reads from the struct field definition cache.
    /// </summary>
    public static readonly DiagnosticDescriptor StructFieldDefsRead = new(
        "GSA0001",
        "Resolve emitted field tokens through ResolveFieldToken",
        "Read field tokens through ResolveFieldToken or ResolveInterfaceFieldToken instead of StructFieldDefs",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Direct StructFieldDefs reads emit the wrong token for generic self-instantiated field access.");

    /// <summary>
    /// Reports reference comparisons between reflection type identities.
    /// </summary>
    public static readonly DiagnosticDescriptor ReflectionTypeReferenceComparison = new(
        "GSA0002",
        "Compare typeof Type identities with ClrTypeUtilities",
        "Compare System.Type values to typeof expressions with ClrTypeUtilities.AreSame or IsSameAs",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Imported metadata Type instances and typeof literals can represent the same identity without being reference-equal.");

    /// <summary>
    /// Reports strong static dictionaries keyed by reflection identities.
    /// </summary>
    public static readonly DiagnosticDescriptor StrongStaticReflectionCache = new(
        "GSA0003",
        "Use weak storage for static reflection identity caches",
        "Static dictionaries keyed by reflection {0} must use weak storage or be instance-scoped",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Strong static caches keyed by reflection Type, Assembly, or Module can pin MetadataLoadContexts.");

    /// <summary>
    /// Reports Emit-layer symbol-keyed metadata-reference caches whose key
    /// omits the generic-remap scope.
    /// </summary>
    public static readonly DiagnosticDescriptor EmitCacheKeyMissingRemapScope = new(
        "GSA0004",
        "Include RemapScope in Emit-layer symbol-keyed metadata caches",
        "Emit cache '{0}' maps symbols to scope-sensitive metadata rows but its key does not include RemapScope",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "The same symbol encodes to different VAR/MVAR ordinals under different active generic remaps, so a TypeSpec/MemberRef/MethodSpec cache keyed on symbols without the RemapScope reuses rows across scopes and emits an invalid assembly (issues #2930, #3057, #3065; invariant #3163).");

    /// <summary>
    /// Reports a <c>BoundTreeRewriter</c> override that reconstructs its node
    /// while reading fewer of the node's members than the base rewriter does.
    /// </summary>
    public static readonly DiagnosticDescriptor RewriterCloneDropsMember = new(
        "GSA0005",
        "Preserve every member the base rewriter preserves when cloning a bound node",
        "'{0}' rebuilds {1} but never reads node.{2}, which BoundTreeRewriter.{3} preserves",
        "GSharp.InternalAnalyzers",
        DiagnosticSeverity.Warning,
        isEnabledByDefault: true,
        description: "Bound nodes are discriminated unions over their constructors, so a member one constructor omits is silently lost when a rewriter rebuilds the node through the wrong one. The base BoundTreeRewriter branches on the discriminator; an override that does not drops it and mis-codegens (issues #1644, #3333).");
}
