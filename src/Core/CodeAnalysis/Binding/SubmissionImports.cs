// <copyright file="SubmissionImports.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0156 Phase 2: the ordered (newest-first) set of prior interactive
/// submissions a REPL submission binds against. Each prior submission is a
/// real emitted assembly reachable through the compilation's
/// <see cref="ReferenceResolver"/>; its top-level functions and globals live
/// as static members of its per-package <c>&lt;Program&gt;</c> container and
/// its user types as ordinary CLR types under the submission's package
/// namespace. Name lookup walks submissions newest-first so a redefinition in
/// a later cell shadows earlier cells, matching the historical evaluator
/// scope-chain semantics.
/// </summary>
public sealed class SubmissionImports
{
    /// <summary>
    /// The reserved name of the synthesized public static field that receives
    /// the value of a submission's trailing expression (or trailing variable
    /// declaration) for the REPL's cell-value echo.
    /// </summary>
    public const string ResultFieldName = "<Result>$";

    /// <summary>
    /// The metadata type name of the per-package top-level container that
    /// holds a submission's top-level functions (static methods) and globals
    /// (static fields).
    /// </summary>
    public const string ProgramTypeName = "<Program>";

    private SubmissionImports(ImmutableArray<SubmissionReference> newestFirst)
    {
        NewestFirst = newestFirst;
    }

    /// <summary>
    /// Gets the prior submissions, newest first.
    /// </summary>
    public ImmutableArray<SubmissionReference> NewestFirst { get; }

    /// <summary>
    /// Gets the metadata name of a package's synthesized top-level container.
    /// </summary>
    /// <param name="packageName">The declaring package.</param>
    /// <returns>The package-qualified metadata type name.</returns>
    public static string GetProgramTypeName(string packageName) =>
        packageName + "." + ProgramTypeName;

    /// <summary>
    /// Creates a <see cref="SubmissionImports"/> over the given prior
    /// submissions.
    /// </summary>
    /// <param name="newestFirst">The prior submissions, newest first.</param>
    /// <returns>The import set.</returns>
    public static SubmissionImports Create(ImmutableArray<SubmissionReference> newestFirst)
        => new(newestFirst.IsDefault ? ImmutableArray<SubmissionReference>.Empty : newestFirst);

    /// <summary>
    /// Finds the newest prior submission that declares a top-level function
    /// named <paramref name="name"/> and resolves its <c>&lt;Program&gt;</c>
    /// container type through <paramref name="references"/>.
    /// </summary>
    /// <param name="references">The active reference resolver.</param>
    /// <param name="name">The bare function name.</param>
    /// <param name="programType">The container CLR type on success.</param>
    /// <returns>Whether a prior submission declares the function.</returns>
    public bool TryFindFunctionContainer(ReferenceResolver references, string name, out Type? programType)
    {
        programType = null;
        foreach (var submission in NewestFirst)
        {
            if (DeclaresFunction(submission, name))
            {
                return TryResolveProgramType(references, submission, out programType);
            }

            // A same-named global in a newer submission shadows an older
            // submission's function, mirroring the evaluator scope chain
            // where the newest declaration of a name wins regardless of kind.
            if (DeclaresGlobal(submission, name))
            {
                return false;
            }
        }

        return false;
    }

    /// <summary>
    /// Finds the newest prior submission that declares a top-level global
    /// variable named <paramref name="name"/>, resolving its container type
    /// and reporting the source-side declaration (for read-only checks).
    /// </summary>
    /// <param name="references">The active reference resolver.</param>
    /// <param name="name">The bare variable name.</param>
    /// <param name="programType">The container CLR type on success.</param>
    /// <param name="declared">The submission's source-side variable symbol.</param>
    /// <returns>Whether a prior submission declares the global.</returns>
    public bool TryFindGlobalVariable(ReferenceResolver references, string name, out Type? programType, out VariableSymbol? declared)
    {
        programType = null;
        declared = null;
        foreach (var submission in NewestFirst)
        {
            var match = FindGlobal(submission, name);
            if (match is not null)
            {
                declared = match;
                return TryResolveProgramType(references, submission, out programType);
            }

            // A same-named function in a newer submission shadows an older
            // submission's global (newest declaration wins regardless of kind).
            if (DeclaresFunction(submission, name))
            {
                return false;
            }
        }

        return false;
    }

    /// <summary>
    /// Finds the newest prior submission that declares a top-level function
    /// or global variable named <paramref name="name"/> and resolves its
    /// container type. Used by the bare-identifier read fallback, which
    /// binds fields, and method groups through the same accessor machinery.
    /// </summary>
    /// <param name="references">The active reference resolver.</param>
    /// <param name="name">The bare member name.</param>
    /// <param name="programType">The container CLR type on success.</param>
    /// <returns>Whether a prior submission declares the member.</returns>
    public bool TryFindMemberContainer(ReferenceResolver references, string name, out Type? programType)
    {
        programType = null;
        foreach (var submission in NewestFirst)
        {
            if (DeclaresFunction(submission, name) || DeclaresGlobal(submission, name))
            {
                return TryResolveProgramType(references, submission, out programType);
            }
        }

        return false;
    }

    /// <summary>
    /// Finds the newest prior submission that declares a type (struct, class,
    /// interface, enum, or delegate) named <paramref name="name"/> and
    /// resolves its emitted CLR type through <paramref name="references"/>.
    /// </summary>
    /// <param name="references">The active reference resolver.</param>
    /// <param name="name">The simple type name.</param>
    /// <param name="preferredArity">The preferred generic arity, or -1/0 for a non-generic use site.</param>
    /// <param name="clrType">The resolved CLR type on success.</param>
    /// <returns>Whether a prior submission declares the type.</returns>
    public bool TryResolveType(ReferenceResolver references, string name, int preferredArity, [NotNullWhen(true)] out Type? clrType)
    {
        clrType = null;
        foreach (var submission in NewestFirst)
        {
            var arity = FindDeclaredTypeArity(submission, name, preferredArity);
            if (arity < 0)
            {
                continue;
            }

            var metadataName = arity == 0
                ? name
                : name + "`" + arity.ToString(CultureInfo.InvariantCulture);
            return references.TryResolveTypeInAssembly(submission.AssemblyName, submission.PackageName + "." + metadataName, out clrType);
        }

        return false;
    }

    private static bool DeclaresFunction(SubmissionReference submission, string name)
        => submission.GlobalScope.Functions.Any(f =>
            !f.IsSpecialName
            && !f.IsTopLevelEntryPoint
            && string.Equals(f.Name, name, StringComparison.Ordinal));

    private static bool DeclaresGlobal(SubmissionReference submission, string name)
        => FindGlobal(submission, name) is not null;

    private static VariableSymbol? FindGlobal(SubmissionReference submission, string name)
        => string.Equals(name, ResultFieldName, StringComparison.Ordinal)
            ? null
            : submission.GlobalScope.Variables.FirstOrDefault(v =>
                v is GlobalVariableSymbol && string.Equals(v.Name, name, StringComparison.Ordinal));

    // Returns the declared generic arity of the newest matching type in this
    // submission, or -1 when the submission does not declare the name. When
    // the use site requests a specific arity (> 0), only a same-arity
    // declaration matches; a bare use site (-1 or 0) matches a non-generic
    // declaration first and otherwise any declared arity.
    private static int FindDeclaredTypeArity(SubmissionReference submission, string name, int preferredArity)
    {
        var scope = submission.GlobalScope;
        var arities = scope.Structs
            .Where(s => string.Equals(s.Name, name, StringComparison.Ordinal))
            .Select(s => s.TypeParameters.IsDefaultOrEmpty ? 0 : s.TypeParameters.Length)
            .Concat(scope.Interfaces
                .Where(i => string.Equals(i.Name, name, StringComparison.Ordinal))
                .Select(i => i.TypeParameters.IsDefaultOrEmpty ? 0 : i.TypeParameters.Length))
            .Concat(scope.Enums
                .Where(e => string.Equals(e.Name, name, StringComparison.Ordinal))
                .Select(_ => 0))
            .Concat(scope.Delegates
                .Where(d => string.Equals(d.Name, name, StringComparison.Ordinal))
                .Select(d => d.TypeParameters.IsDefaultOrEmpty ? 0 : d.TypeParameters.Length))
            .ToArray();

        if (arities.Length == 0)
        {
            return -1;
        }

        if (preferredArity > 0)
        {
            return arities.Contains(preferredArity) ? preferredArity : -1;
        }

        return arities.Contains(0) ? 0 : arities[0];
    }

    // Issue #3297: resolve against the declaring submission's own assembly,
    // not the flat namespace-qualified name. Two cells that redeclare the
    // same `package foo` each emit a `foo.<Program>` container into their own
    // submission assembly (`gsi$1`, `gsi$2`); the flat lookup collides on the
    // newest, which made the older cell's declarations unreachable even
    // though the newest-first declaration walk had correctly found them.
    private static bool TryResolveProgramType(ReferenceResolver references, SubmissionReference submission, out Type? programType)
        => references.TryResolveTypeInAssembly(
            submission.AssemblyName,
            GetProgramTypeName(submission.PackageName),
            out programType);
}

/// <summary>
/// One prior interactive submission: its emitted assembly identity, the
/// package (namespace) its members were emitted under, and the source-side
/// global scope recording what it declared (names, kinds, and read-only
/// flags — used to steer metadata lookup without reflection scans).
/// </summary>
public sealed class SubmissionReference
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SubmissionReference"/> class.
    /// </summary>
    /// <param name="assemblyName">The emitted assembly's simple name (e.g. <c>gsi$3</c>).</param>
    /// <param name="packageName">The package (metadata namespace) the submission's members were emitted under.</param>
    /// <param name="globalScope">The submission's bound global scope.</param>
    public SubmissionReference(string assemblyName, string packageName, BoundGlobalScope globalScope)
    {
        AssemblyName = assemblyName ?? throw new ArgumentNullException(nameof(assemblyName));
        PackageName = packageName ?? throw new ArgumentNullException(nameof(packageName));
        GlobalScope = globalScope ?? throw new ArgumentNullException(nameof(globalScope));
    }

    /// <summary>Gets the emitted assembly's simple name.</summary>
    public string AssemblyName { get; }

    /// <summary>Gets the package (metadata namespace) of the submission's members.</summary>
    public string PackageName { get; }

    /// <summary>Gets the submission's bound global scope.</summary>
    public BoundGlobalScope GlobalScope { get; }
}

/// <summary>
/// ADR-0156 Phase 2: options that put a compilation into interactive
/// submission mode — prior-submission metadata binding, a per-submission
/// default package, replayed session imports, and trailing-expression value
/// capture for the REPL echo.
/// </summary>
public sealed class SubmissionBindingOptions
{
    /// <summary>Gets or sets the prior-submission import set (may be <see langword="null"/> for the first cell).</summary>
    public SubmissionImports? Imports { get; set; }

    /// <summary>
    /// Gets or sets the package name used for syntax trees without a
    /// <c>package</c> declaration (each submission gets a distinct default
    /// package so its emitted members have a unique namespace).
    /// </summary>
    public string? DefaultPackageName { get; set; }

    /// <summary>
    /// Gets or sets the imports accumulated by earlier submissions, replayed
    /// into this submission's root scope so <c>import</c> statements keep
    /// their session-wide effect.
    /// </summary>
    public ImmutableArray<ImportSymbol> ReplayImports { get; set; } = ImmutableArray<ImportSymbol>.Empty;

    /// <summary>
    /// Gets or sets a value indicating whether the trailing expression (or
    /// trailing variable declaration) of the submission is captured into the
    /// synthesized <see cref="SubmissionImports.ResultFieldName"/> global for
    /// the REPL's cell-value echo. Defaults to <see langword="true"/>.
    /// </summary>
    public bool CaptureTrailingExpression { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether a user-declared entry point
    /// (<c>func Main</c>) becomes the submission assembly's entry point.
    /// Interactive cells leave this <see langword="false"/> — declaring
    /// <c>Main</c> in a REPL cell is an ordinary function declaration with no
    /// side effect (ADR-0156 Phase 3c, #3176; the evaluator engine's
    /// <c>RunEntryPoint=false</c> contract). One-shot script-shaped
    /// submissions (the emitted test oracle) opt in to preserve
    /// <c>Compilation.Evaluate</c>'s historical script semantics, where an
    /// explicit <c>Main</c> runs and its return value is the result.
    /// </summary>
    public bool RunUserEntryPoint { get; set; }
}
