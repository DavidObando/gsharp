// <copyright file="ImportSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents an import symbol in the language.
/// </summary>
public sealed class ImportSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ImportSymbol"/> class.
    /// </summary>
    /// <param name="name">The local name used to reference this import (the alias when one is declared, otherwise the import path).</param>
    /// <param name="target">The fully-qualified target path used for type resolution (e.g. <c>System</c> or <c>System.IO</c>).</param>
    /// <param name="declaration">The declaration, or <c>null</c> for compiler-synthesized imports (e.g. the implicit <c>System</c> import).</param>
    public ImportSymbol(string name, string target, ImportSyntax? declaration)
        : this(name, target, declaration, hoistsStatics: false)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="ImportSymbol"/> class.</summary>
    /// <param name="name">The import's name.</param>
    /// <param name="target">The fully-qualified target path.</param>
    /// <param name="declaration">The declaring syntax, or <see langword="null"/> for an implicit import.</param>
    /// <param name="hoistsStatics">See <see cref="HoistsStatics"/>.</param>
    public ImportSymbol(string name, string target, ImportSyntax? declaration, bool hoistsStatics)
        : base(name)
    {
        Target = target;
        Declaration = declaration;
        HoistsStatics = hoistsStatics;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Import;

    /// <summary>
    /// Gets a value indicating whether this import brings the target package's
    /// top-level functions into bare-name scope, the way an explicit package
    /// import does (ADR-0134). Implicit imports normally do not — an implicitly
    /// imported namespace should not silently add callable names — but
    /// <c>Gsharp.Concurrency</c> does, because ADR-0174 D9's helpers
    /// (<c>after</c>, <c>tick</c>, <c>merge</c>) are meant to read as ordinary
    /// functions and a program that wants the name declares its own, which
    /// wins.
    /// </summary>
    public bool HoistsStatics { get; }

    /// <summary>
    /// Gets the fully-qualified target path used to resolve types under this import.
    /// </summary>
    public string Target { get; }

    /// <summary>
    /// Gets a value indicating whether this import was declared with an explicit alias (e.g. <c>import sys = System</c>).
    /// </summary>
    public bool IsAlias => !string.Equals(Name, Target, System.StringComparison.Ordinal);

    /// <summary>
    /// Gets a value indicating whether this import was synthesized by the compiler rather than written by the user.
    /// </summary>
    public bool IsImplicit => Declaration == null;

    /// <summary>
    /// Gets the declaration of the import, or <c>null</c> for compiler-synthesized imports.
    /// </summary>
    public ImportSyntax? Declaration { get; }
}
