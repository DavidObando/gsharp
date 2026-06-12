// <copyright file="InterfaceSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-defined interface type (Phase 3.B.4 / ADR-0018).
/// Interfaces are CLR reference types (TypeAttributes.Interface | Abstract)
/// containing method signatures only — no bodies, no default impls,
/// no static members.
/// </summary>
public sealed class InterfaceSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<(InterfaceSymbol Def, string Args), InterfaceSymbol> ConstructedCache = new();

    /// <summary>Initializes a new instance of the <see cref="InterfaceSymbol"/> class.</summary>
    /// <param name="name">The interface type name.</param>
    /// <param name="accessibility">The interface's CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package this interface lives in.</param>
    public InterfaceSymbol(
        string name,
        Accessibility accessibility,
        InterfaceDeclarationSyntax declaration,
        string packageName)
        : base(name)
    {
        Accessibility = accessibility;
        Declaration = declaration;
        PackageName = packageName;
        Methods = ImmutableArray<FunctionSymbol>.Empty;
        Definition = this;
    }

    private InterfaceSymbol(InterfaceSymbol definition, ImmutableArray<TypeSymbol> typeArguments, string constructedName)
        : base(constructedName)
    {
        Accessibility = definition.Accessibility;
        Declaration = definition.Declaration;
        PackageName = definition.PackageName;
        Methods = ImmutableArray<FunctionSymbol>.Empty;
        TypeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
        TypeArguments = typeArguments;
        Definition = definition;
    }

    /// <summary>Gets the interface accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public InterfaceDeclarationSyntax Declaration { get; }

    /// <summary>Gets the package this interface lives in.</summary>
    public string PackageName { get; }

    /// <summary>Gets a value indicating whether this interface was declared <c>sealed</c> (Phase 3.B.5). All implementors must live in the same package; binder-enforced.</summary>
    public bool IsSealed => Declaration?.IsSealed ?? false;

    /// <summary>Gets the abstract method signatures declared on this interface. Populated by the binder via <see cref="SetMethods"/>.</summary>
    public ImmutableArray<FunctionSymbol> Methods { get; private set; }

    /// <summary>Gets the property signatures declared on this interface (ADR-0051). Populated by the binder via <see cref="SetProperties"/>.</summary>
    public ImmutableArray<PropertySymbol> Properties { get; private set; } = ImmutableArray<PropertySymbol>.Empty;

    /// <summary>Gets the event signatures declared on this interface (ADR-0052). Populated by the binder via <see cref="SetEvents"/>.</summary>
    public ImmutableArray<EventSymbol> Events { get; private set; } = ImmutableArray<EventSymbol>.Empty;

    /// <summary>Gets the type parameters when this is a generic definition (Phase 4.3c / ADR-0020).</summary>
    public ImmutableArray<TypeParameterSymbol> TypeParameters { get; private set; } = ImmutableArray<TypeParameterSymbol>.Empty;

    /// <summary>Gets the type arguments when this is a constructed instance (Phase 4.3c / ADR-0020).</summary>
    public ImmutableArray<TypeSymbol> TypeArguments { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>Gets a value indicating whether this is a generic definition (has type parameters and no type arguments).</summary>
    public bool IsGenericDefinition => !TypeParameters.IsDefaultOrEmpty && TypeArguments.IsDefaultOrEmpty;

    /// <summary>Gets the original generic definition when this is a constructed instance; otherwise <c>this</c>.</summary>
    public InterfaceSymbol Definition { get; }

    /// <summary>Sets <see cref="Methods"/>. Intended to be called once by the binder.</summary>
    /// <param name="methods">The bound method signatures.</param>
    public void SetMethods(ImmutableArray<FunctionSymbol> methods)
    {
        Methods = methods;
    }

    /// <summary>Sets <see cref="Properties"/>. Intended to be called once by the binder (ADR-0051).</summary>
    /// <param name="properties">The bound property signatures.</param>
    public void SetProperties(ImmutableArray<PropertySymbol> properties)
    {
        Properties = properties;
    }

    /// <summary>Sets <see cref="Events"/>. Intended to be called once by the binder (ADR-0052).</summary>
    /// <param name="events">The bound event signatures.</param>
    public void SetEvents(ImmutableArray<EventSymbol> events)
    {
        Events = events;
    }

    /// <summary>Sets <see cref="TypeParameters"/> on a generic definition (Phase 4.3c). Intended to be called once by the binder.</summary>
    /// <param name="typeParameters">The bound type parameters in declared order.</param>
    public void SetTypeParameters(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        TypeParameters = typeParameters;
    }

    /// <summary>Tries to look up an interface method by name.</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetMethod(string name, out FunctionSymbol method)
    {
        foreach (var m in Methods)
        {
            if (m.Name == name)
            {
                method = m;
                return true;
            }
        }

        method = null;
        return false;
    }

    /// <summary>
    /// ADR-0063: returns every interface method whose name equals <paramref name="name"/> (the overload set).
    /// </summary>
    /// <param name="name">The method name.</param>
    /// <returns>The overload set; empty if none.</returns>
    public ImmutableArray<FunctionSymbol> GetMethods(string name)
    {
        if (Methods.IsDefaultOrEmpty)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var m in Methods)
        {
            if (m.Name == name)
            {
                builder.Add(m);
            }
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Constructs a closed instance of a generic interface definition with the supplied type arguments
    /// (Phase 4.3c / ADR-0020). Method signatures are substituted; identity is cached so two calls with
    /// the same definition + arguments return the same <see cref="InterfaceSymbol"/> reference.
    /// </summary>
    /// <param name="definition">The generic definition to instantiate.</param>
    /// <param name="typeArguments">The type arguments. Length must match <see cref="TypeParameters"/>.</param>
    /// <returns>A constructed <see cref="InterfaceSymbol"/> whose <see cref="Definition"/> is the original.</returns>
    public static InterfaceSymbol Construct(InterfaceSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
    {
        if (definition == null || !definition.IsGenericDefinition)
        {
            return definition;
        }

        var key = BuildArgsKey(typeArguments);
        return ConstructedCache.GetOrAdd((definition, key), _ => CreateConstructed(definition, typeArguments));
    }

    /// <summary>
    /// ADR-0085 / issue #726: returns true when <paramref name="method"/> is
    /// a default-interface method on this interface — i.e. its declaring
    /// <see cref="FunctionSymbol.Declaration"/> carries a non-null
    /// <c>Body</c>. Abstract interface methods return false.
    /// </summary>
    /// <param name="method">The interface method to inspect.</param>
    /// <returns>True when the method has a default body.</returns>
    public static bool HasDefaultBody(FunctionSymbol method)
    {
        return method != null && method.Declaration?.Body != null;
    }

    private static string BuildArgsKey(ImmutableArray<TypeSymbol> typeArguments)
    {
        var parts = new string[typeArguments.Length];
        for (var i = 0; i < typeArguments.Length; i++)
        {
            parts[i] = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(typeArguments[i]).ToString();
        }

        return string.Join(",", parts);
    }

    private static InterfaceSymbol CreateConstructed(InterfaceSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
    {
        var subst = new Dictionary<TypeParameterSymbol, TypeSymbol>(definition.TypeParameters.Length);
        for (var i = 0; i < definition.TypeParameters.Length; i++)
        {
            subst[definition.TypeParameters[i]] = typeArguments[i];
        }

        var argParts = new string[typeArguments.Length];
        for (var i = 0; i < typeArguments.Length; i++)
        {
            argParts[i] = typeArguments[i].Name;
        }

        var constructedName = $"{definition.Name}[{string.Join(", ", argParts)}]";
        var instance = new InterfaceSymbol(definition, typeArguments, constructedName);

        var substMethods = ImmutableArray.CreateBuilder<FunctionSymbol>(definition.Methods.Length);
        foreach (var m in definition.Methods)
        {
            var substParams = ImmutableArray.CreateBuilder<ParameterSymbol>(m.Parameters.Length);
            foreach (var p in m.Parameters)
            {
                var newParam = new ParameterSymbol(p.Name, SubstituteType(p.Type, subst), isVariadic: p.IsVariadic, isScoped: p.IsScoped, refKind: p.RefKind);

                // ADR-0063: propagate explicit default values across generic substitution.
                if (p.HasExplicitDefaultValue)
                {
                    newParam.SetExplicitDefaultValue(p.ExplicitDefaultValue);
                }

                substParams.Add(newParam);
            }

            var substReturn = SubstituteType(m.Type, subst);
            var substMethod = new FunctionSymbol(
                m.Name,
                substParams.MoveToImmutable(),
                substReturn,
                m.Declaration,
                m.Package,
                m.Accessibility,
                receiverType: null);
            substMethods.Add(substMethod);
        }

        instance.SetMethods(substMethods.MoveToImmutable());
        return instance;
    }

    private static TypeSymbol SubstituteType(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> subst)
    {
        if (type is TypeParameterSymbol tp && subst.TryGetValue(tp, out var concrete))
        {
            return concrete;
        }

        if (type is SliceTypeSymbol s)
        {
            var sub = SubstituteType(s.ElementType, subst);
            return sub == s.ElementType ? s : SliceTypeSymbol.Get(sub);
        }

        if (type is ArrayTypeSymbol a)
        {
            var sub = SubstituteType(a.ElementType, subst);
            return sub == a.ElementType ? a : ArrayTypeSymbol.Get(sub, a.Length);
        }

        if (type is NullableTypeSymbol n)
        {
            var sub = SubstituteType(n.UnderlyingType, subst);
            return sub == n.UnderlyingType ? n : NullableTypeSymbol.Get(sub);
        }

        return type;
    }
}
