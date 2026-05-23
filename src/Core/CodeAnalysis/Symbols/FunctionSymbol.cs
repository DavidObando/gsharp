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
        : this(name, parameters, type, declaration, package, accessibility, receiverType: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionSymbol"/> class.
    /// </summary>
    /// <param name="name">The name of the function.</param>
    /// <param name="parameters">The parameters of the function (excluding the implicit instance receiver, when any).</param>
    /// <param name="type">The return type of the function.</param>
    /// <param name="declaration">The declaration of the function.</param>
    /// <param name="package">The package this function belongs to, or null for built-ins.</param>
    /// <param name="accessibility">The CLR visibility level.</param>
    /// <param name="receiverType">The class that owns this function when it is an instance method (Phase 3.B.3 sub-step 2b); <c>null</c> for top-level functions and static methods.</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax declaration,
        PackageSymbol package,
        Accessibility accessibility,
        StructSymbol receiverType)
        : this(name, parameters, type, declaration, package, accessibility, receiverType, isOpen: false, isOverride: false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionSymbol"/> class.
    /// </summary>
    /// <param name="name">The name of the function.</param>
    /// <param name="parameters">The parameters of the function.</param>
    /// <param name="type">The return type of the function.</param>
    /// <param name="declaration">The declaration of the function.</param>
    /// <param name="package">The package this function belongs to, or null for built-ins.</param>
    /// <param name="accessibility">The CLR visibility level.</param>
    /// <param name="receiverType">The class that owns this function when it is an instance method (Phase 3.B.3 sub-step 2b).</param>
    /// <param name="isOpen">True when the method is declared <c>open</c> — overridable (Phase 3.B.3 sub-step 3 / ADR-0017). Only meaningful on instance methods.</param>
    /// <param name="isOverride">True when the method is declared <c>override</c> — must shadow an open base method.</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax declaration,
        PackageSymbol package,
        Accessibility accessibility,
        StructSymbol receiverType,
        bool isOpen,
        bool isOverride)
        : this(name, parameters, type, declaration, package, accessibility, (TypeSymbol)receiverType, isOpen, isOverride)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="FunctionSymbol"/> class with a generic <see cref="TypeSymbol"/> receiver (Phase 3.B.4 — supports interface methods).</summary>
    /// <param name="name">The function name.</param>
    /// <param name="parameters">The function parameters.</param>
    /// <param name="type">The return type.</param>
    /// <param name="declaration">The declaring syntax.</param>
    /// <param name="package">The owning package.</param>
    /// <param name="accessibility">The CLR accessibility.</param>
    /// <param name="receiverType">The receiver type for instance methods, or <c>null</c> for top-level functions.</param>
    /// <param name="isOpen">Whether the method is declared <c>open</c> (overridable).</param>
    /// <param name="isOverride">Whether the method overrides an inherited base method.</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax declaration,
        PackageSymbol package,
        Accessibility accessibility,
        TypeSymbol receiverType,
        bool isOpen = false,
        bool isOverride = false)
        : base(name)
    {
        Parameters = parameters;
        Type = type;
        Declaration = declaration;
        Package = package;
        Accessibility = accessibility;
        ReceiverType = receiverType;
        ThisParameter = receiverType != null ? new ParameterSymbol("this", receiverType) : null;
        IsOpen = isOpen;
        IsOverride = isOverride;
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

    /// <summary>
    /// Gets the class type that owns this function when it is an instance
    /// method (Phase 3.B.3 sub-step 2b). <c>null</c> for top-level functions
    /// and static methods.
    /// </summary>
    public TypeSymbol ReceiverType { get; }

    /// <summary>Gets a value indicating whether this function is an instance method on a user-defined class.</summary>
    public bool IsInstanceMethod => ReceiverType != null;

    /// <summary>Gets the synthesized <c>this</c> parameter for instance methods, or <c>null</c> for non-instance functions. Always at IL parameter slot 0 when emitted.</summary>
    public ParameterSymbol ThisParameter { get; }

    /// <summary>Gets a value indicating whether this method is declared <c>open</c> — overridable per ADR-0017 (Phase 3.B.3 sub-step 3).</summary>
    public bool IsOpen { get; }

    /// <summary>Gets a value indicating whether this method is declared <c>override</c> — must shadow an open base method per ADR-0017.</summary>
    public bool IsOverride { get; }

    /// <summary>Gets or sets the base method this method overrides. Set by the binder when <see cref="IsOverride"/> is true and a matching open base method is found; <c>null</c> otherwise.</summary>
    public FunctionSymbol OverriddenMethod { get; set; }
}
