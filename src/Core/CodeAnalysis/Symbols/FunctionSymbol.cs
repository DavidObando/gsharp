// <copyright file="FunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a function symbol in the language.
/// </summary>
public sealed class FunctionSymbol : Symbol
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionSymbol"/> class.
    /// </summary>
    /// <param name="name">The name of the function.</param>
    /// <param name="parameters">The parameters of the function.</param>
    /// <param name="type">The type of the function.</param>
    /// <param name="declaration">The declaration of the function.</param>
    /// <param name="package">The package this function belongs to, or null for built-ins.</param>
    /// <param name="accessibility">The CLR visibility level (defaults to <see cref="Accessibility.Public"/>).</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax declaration = null,
        PackageSymbol package = null,
        Accessibility accessibility = Accessibility.Public)
        : base(name)
    {
        Parameters = parameters;
        Type = type;
        Declaration = declaration;
        Package = package;
        Accessibility = accessibility;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Function;

    /// <summary>
    /// Gets the parameters of the function.
    /// </summary>
    public ImmutableArray<ParameterSymbol> Parameters { get; }

    /// <summary>
    /// Gets the type of the function.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Gets the declaration of the function.
    /// </summary>
    public FunctionDeclarationSyntax Declaration { get; }

    /// <summary>
    /// Gets the package this function belongs to. <c>null</c> for built-in
    /// functions, which are not scoped to a user package.
    /// </summary>
    public PackageSymbol Package { get; }

    /// <summary>
    /// Gets the CLR visibility level for this function.
    /// </summary>
    public Accessibility Accessibility { get; }
}
