#nullable disable

// <copyright file="DelegateTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-declared named delegate type (ADR-0059 / issue #255).
/// A <c>type Name = delegate func(...)</c> declaration produces a
/// <see cref="DelegateTypeSymbol"/> that the emitter materialises as a sealed
/// CLR class deriving from <c>System.MulticastDelegate</c> with a
/// runtime-implemented <c>.ctor</c> + <c>Invoke</c>.
/// </summary>
/// <remarks>
/// <para>
/// Like <see cref="StructSymbol"/> and <see cref="InterfaceSymbol"/>, a delegate
/// declared in source has no <see cref="TypeSymbol.ClrType"/> at bind time —
/// the underlying CLR type only comes into being once the emitter has produced
/// the corresponding TypeDef row. Callers that need a CLR <see cref="Type"/>
/// (for example, conversion classification) should fall back to the
/// <see cref="EquivalentFunctionType"/> shape exposed below, which projects the
/// delegate onto an <c>Action&lt;…&gt;</c> / <c>Func&lt;…&gt;</c> instance.
/// </para>
/// </remarks>
public sealed class DelegateTypeSymbol : TypeSymbol
{
    private FunctionTypeSymbol equivalentFunctionType;

    /// <summary>
    /// Initializes a new instance of the <see cref="DelegateTypeSymbol"/> class.
    /// </summary>
    /// <param name="name">The delegate type name (the identifier from <c>type Name = …</c>).</param>
    /// <param name="packageName">The package owning the delegate.</param>
    /// <param name="accessibility">The CLR accessibility of the emitted TypeDef.</param>
    /// <param name="parameters">The delegate's parameter symbols (names preserved for emit so consumers see meaningful names).</param>
    /// <param name="returnType">The delegate's return type. Use <see cref="TypeSymbol.Void"/> for a void delegate.</param>
    /// <param name="declaration">The declaring syntax node (used to surface diagnostics later).</param>
    public DelegateTypeSymbol(
        string name,
        string packageName,
        Accessibility accessibility,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol returnType,
        DelegateDeclarationSyntax declaration)
        : base(name)
    {
        PackageName = packageName;
        Accessibility = accessibility;
        Parameters = parameters.IsDefault ? ImmutableArray<ParameterSymbol>.Empty : parameters;
        ReturnType = returnType ?? Void;
        Declaration = declaration;
    }

    /// <summary>Gets the package the delegate is declared in.</summary>
    public string PackageName { get; }

    /// <summary>Gets the CLR accessibility of the emitted delegate type.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the delegate's named parameters in declaration order.</summary>
    public ImmutableArray<ParameterSymbol> Parameters { get; }

    /// <summary>Gets the delegate's return type (<see cref="TypeSymbol.Void"/> for a void delegate).</summary>
    public TypeSymbol ReturnType { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public DelegateDeclarationSyntax Declaration { get; }

    /// <summary>
    /// Gets the structural <see cref="FunctionTypeSymbol"/> equivalent to this
    /// named delegate. The equivalent function type shares parameter and
    /// return types and lets existing func-based binder paths (overload
    /// resolution, conversion classification, type display) operate on a
    /// named delegate without per-symbol special-casing.
    /// </summary>
    public FunctionTypeSymbol EquivalentFunctionType
    {
        get
        {
            if (equivalentFunctionType == null)
            {
                var paramTypes = ImmutableArray.CreateBuilder<TypeSymbol>(Parameters.Length);
                var variadicBuilder = ImmutableArray.CreateBuilder<bool>(Parameters.Length);
                var anyVariadic = false;
                foreach (var p in Parameters)
                {
                    paramTypes.Add(p.Type);
                    variadicBuilder.Add(p.IsVariadic);
                    anyVariadic |= p.IsVariadic;
                }

                // ADR-0102 follow-up / issue #818: a named delegate with a
                // trailing variadic parameter materialises a variadic
                // FunctionTypeSymbol so callers that take a `(T, ...U) -> R`
                // typed value and a named delegate value share identity.
                var variadicFlags = anyVariadic ? variadicBuilder.MoveToImmutable() : default;
                equivalentFunctionType = FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), variadicFlags, ReturnType);
            }

            return equivalentFunctionType;
        }
    }
}
