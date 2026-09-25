// <copyright file="StubPartialDefinition.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0192 follow-on 2: a lone G# declaring part the stub offered to
/// generators as a C# partial method definition, with the top-level type and
/// package that own it.
/// </summary>
public sealed class StubPartialDefinition
{
    /// <summary>
    /// Initializes a new instance of the <see cref="StubPartialDefinition"/> class.
    /// </summary>
    /// <param name="packageName">The owning type's package, or <see langword="null"/> for none.</param>
    /// <param name="typeName">The owning top-level type's name.</param>
    /// <param name="declaration">The declaring part's syntax, in the user's file.</param>
    public StubPartialDefinition(string packageName, string typeName, FunctionDeclarationSyntax declaration)
    {
        PackageName = packageName;
        TypeName = typeName;
        Declaration = declaration;
    }

    /// <summary>Gets the owning type's package, or <see langword="null"/> for none.</summary>
    public string PackageName { get; }

    /// <summary>Gets the owning top-level type's name.</summary>
    public string TypeName { get; }

    /// <summary>Gets the declaring part's syntax, in the user's file.</summary>
    public FunctionDeclarationSyntax Declaration { get; }
}
