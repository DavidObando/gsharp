// <copyright file="DelegateTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
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
    private static readonly ConcurrentDictionary<(DelegateTypeSymbol Definition, string ArgsKey), DelegateTypeSymbol> ConstructedCache = new();

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
    /// Gets the delegate's generic type parameters (issue #1503, ADR-0059
    /// follow-up). A non-generic named delegate carries an empty array; a
    /// generic named delegate (<c>type Predicate[T any] = delegate func(value T) bool</c>)
    /// carries one <see cref="TypeParameterSymbol"/> per declared parameter.
    /// Both the open definition and every constructed instance expose the same
    /// type parameters (mirroring <see cref="StructSymbol.TypeParameters"/>);
    /// the emitter consumes these to mangle the TypeDef name with the
    /// backtick-arity suffix and to stamp one <c>GenericParam</c> row per slot.
    /// </summary>
    public ImmutableArray<TypeParameterSymbol> TypeParameters { get; private set; } = ImmutableArray<TypeParameterSymbol>.Empty;

    /// <summary>
    /// Gets the type arguments of a constructed generic delegate (issue #1503)
    /// (e.g. <c>[int32]</c> for <c>Predicate[int32]</c>). Empty on the open
    /// definition and on non-generic delegates.
    /// </summary>
    public ImmutableArray<TypeSymbol> TypeArguments { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>
    /// Gets the open generic definition this delegate was constructed from
    /// (issue #1503), or <see langword="null"/> when this symbol IS the
    /// definition (or is non-generic). Mirrors <see cref="StructSymbol.Definition"/>.
    /// </summary>
    public DelegateTypeSymbol Definition { get; private set; }

    /// <summary>
    /// Gets a value indicating whether this symbol is the OPEN generic
    /// definition (issue #1503) — has type parameters but no type arguments yet.
    /// </summary>
    public bool IsGenericDefinition => !TypeParameters.IsDefaultOrEmpty && TypeArguments.IsDefaultOrEmpty;

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

    /// <summary>
    /// Attaches the delegate's generic type parameters (issue #1503). Called
    /// once by the binder during <see cref="Binding.DeclarationBinder.BindDelegateDeclaration"/>
    /// before any constructed instance is materialized.
    /// </summary>
    /// <param name="typeParameters">The bound type parameters in declaration order.</param>
    public void SetTypeParameters(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        TypeParameters = typeParameters.IsDefault ? ImmutableArray<TypeParameterSymbol>.Empty : typeParameters;
    }

    /// <summary>
    /// Constructs a closed instance of a generic delegate definition with the
    /// supplied type arguments (issue #1503). The delegate's parameter and
    /// return types are substituted (<c>T</c> → <c>int32</c>), so the
    /// constructed delegate's <see cref="EquivalentFunctionType"/>, conversion
    /// classification, and emitted member references all observe the concrete
    /// shape. Identity is cached so two calls with the same definition +
    /// arguments return the SAME <see cref="DelegateTypeSymbol"/> reference
    /// (preserving reference-equality semantics on <see cref="TypeSymbol"/>),
    /// mirroring <see cref="StructSymbol.Construct"/>.
    /// </summary>
    /// <param name="definition">The generic definition to instantiate. Returned unchanged when not an open generic definition.</param>
    /// <param name="typeArguments">The type arguments. Length must match <see cref="TypeParameters"/>.</param>
    /// <returns>A constructed <see cref="DelegateTypeSymbol"/> whose <see cref="Definition"/> is the original.</returns>
    public static DelegateTypeSymbol Construct(DelegateTypeSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
    {
        if (definition == null || !definition.IsGenericDefinition)
        {
            return definition;
        }

        var key = BuildArgsKey(typeArguments);
        return ConstructedCache.GetOrAdd((definition, key), _ => CreateConstructed(definition, typeArguments));
    }

    private static string BuildArgsKey(ImmutableArray<TypeSymbol> typeArguments)
    {
        var parts = new string[typeArguments.Length];
        for (var i = 0; i < typeArguments.Length; i++)
        {
            parts[i] = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(typeArguments[i]).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        return string.Join(",", parts);
    }

    private static DelegateTypeSymbol CreateConstructed(DelegateTypeSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
    {
        var subst = new Dictionary<TypeParameterSymbol, TypeSymbol>(definition.TypeParameters.Length);
        for (var i = 0; i < definition.TypeParameters.Length && i < typeArguments.Length; i++)
        {
            subst[definition.TypeParameters[i]] = typeArguments[i];
        }

        var substitutedParameters = ImmutableArray.CreateBuilder<ParameterSymbol>(definition.Parameters.Length);
        foreach (var p in definition.Parameters)
        {
            var substitutedType = StructSymbol.SubstituteTypeParameters(p.Type, subst);
            var clone = new ParameterSymbol(
                p.Name,
                substitutedType,
                p.IsVariadic,
                declaringSyntax: p.DeclaringSyntax,
                isScoped: p.IsScoped,
                refKind: p.RefKind);
            if (p.HasExplicitDefaultValue)
            {
                clone.SetExplicitDefaultValue(p.ExplicitDefaultValue);
            }

            substitutedParameters.Add(clone);
        }

        var substitutedReturn = StructSymbol.SubstituteTypeParameters(definition.ReturnType, subst);

        var constructed = new DelegateTypeSymbol(
            definition.Name,
            definition.PackageName,
            definition.Accessibility,
            substitutedParameters.MoveToImmutable(),
            substitutedReturn,
            definition.Declaration)
        {
            TypeParameters = definition.TypeParameters,
            TypeArguments = typeArguments,
            Definition = definition,
        };

        return constructed;
    }
}
