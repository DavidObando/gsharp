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
}
