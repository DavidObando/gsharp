// <copyright file="StructSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-defined aggregate type (Phase 3.B). Structs are CLR value
/// types; classes are CLR reference types. Methods may be declared inside class
/// bodies or added later through same-package receiver declarations.
/// </summary>
public sealed class StructSymbol : TypeSymbol
{
    private static readonly ConcurrentDictionary<(StructSymbol Def, string ArgsKey), StructSymbol> ConstructedCache = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="StructSymbol"/> class.
    /// </summary>
    /// <param name="name">The struct type name.</param>
    /// <param name="fields">The field declarations in source order.</param>
    /// <param name="accessibility">The struct's CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package the struct lives in.</param>
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName)
        : this(name, fields, accessibility, declaration, packageName, isData: false, isInline: false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructSymbol"/> class.
    /// </summary>
    /// <param name="name">The struct type name.</param>
    /// <param name="fields">The field declarations in source order.</param>
    /// <param name="accessibility">The struct's CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package the struct lives in.</param>
    /// <param name="isData">True for <c>data struct</c> declarations (Phase 3.B.2 / ADR-0029).</param>
    /// <param name="isInline">True for <c>inline struct</c> declarations (ADR-0033).</param>
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName,
        bool isData,
        bool isInline = false)
        : this(name, fields, accessibility, declaration, packageName, isData, isInline, isClass: false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructSymbol"/> class.
    /// </summary>
    /// <param name="name">The aggregate type name.</param>
    /// <param name="fields">The field declarations in source order.</param>
    /// <param name="accessibility">The CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package the type lives in.</param>
    /// <param name="isData">True for <c>data struct</c> declarations (Phase 3.B.2 / ADR-0029).</param>
    /// <param name="isInline">True for <c>inline struct</c> declarations (ADR-0033).</param>
    /// <param name="isClass">True for <c>class</c> declarations (Phase 3.B.3): emitted as a CLR reference type with object base; not value-copied on assignment.</param>
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName,
        bool isData,
        bool isInline,
        bool isClass)
        : this(name, fields, accessibility, declaration, packageName, isData, isInline, isClass, primaryConstructorParameters: ImmutableArray<ParameterSymbol>.Empty)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructSymbol"/> class.
    /// </summary>
    /// <param name="name">The aggregate type name.</param>
    /// <param name="fields">The field declarations in source order.</param>
    /// <param name="accessibility">The CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package the type lives in.</param>
    /// <param name="isData">True for <c>data struct</c> declarations (Phase 3.B.2 / ADR-0029).</param>
    /// <param name="isInline">True for <c>inline struct</c> declarations (ADR-0033).</param>
    /// <param name="isClass">True for <c>class</c> declarations (Phase 3.B.3): emitted as a CLR reference type with object base; not value-copied on assignment.</param>
    /// <param name="primaryConstructorParameters">The Kotlin-style primary constructor parameters (Phase 3.B.3 sub-step 2). Each entry corresponds to a field of the same name; empty when the type has no explicit primary constructor (default parameterless ctor).</param>
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName,
        bool isData,
        bool isInline,
        bool isClass,
        ImmutableArray<ParameterSymbol> primaryConstructorParameters)
        : this(name, fields, accessibility, declaration, packageName, isData, isInline, isClass, primaryConstructorParameters, isOpen: false, baseClass: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructSymbol"/> class.
    /// </summary>
    /// <param name="name">The aggregate type name.</param>
    /// <param name="fields">The field declarations in source order.</param>
    /// <param name="accessibility">The CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node.</param>
    /// <param name="packageName">The package the type lives in.</param>
    /// <param name="isData">True for <c>data struct</c> declarations.</param>
    /// <param name="isInline">True for <c>inline struct</c> declarations.</param>
    /// <param name="isClass">True for <c>class</c> declarations.</param>
    /// <param name="primaryConstructorParameters">The Kotlin-style primary constructor parameters.</param>
    /// <param name="isOpen">True when this class was declared with the <c>open</c> modifier (Phase 3.B.3 sub-step 3 / ADR-0017). Always false for structs.</param>
    /// <param name="baseClass">The base class symbol (Phase 3.B.3 sub-step 3), or <c>null</c> when this class derives directly from <c>System.Object</c>.</param>
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName,
        bool isData,
        bool isInline,
        bool isClass,
        ImmutableArray<ParameterSymbol> primaryConstructorParameters,
        bool isOpen,
        StructSymbol baseClass)
        : base(name)
    {
        Fields = fields;
        Accessibility = accessibility;
        Declaration = declaration;
        PackageName = packageName;
        IsData = isData;
        IsInline = isInline;
        IsClass = isClass;
        PrimaryConstructorParameters = primaryConstructorParameters;
        IsOpen = isOpen;
        BaseClass = baseClass;
        Interfaces = ImmutableArray<InterfaceSymbol>.Empty;
        Definition = this;
    }

    /// <summary>Gets the field declarations in source order.</summary>
    public ImmutableArray<FieldSymbol> Fields { get; }

    /// <summary>Gets the struct CLR accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public StructDeclarationSyntax Declaration { get; }

    /// <summary>Gets the package the struct lives in.</summary>
    public string PackageName { get; }

    /// <summary>Gets a value indicating whether this is a <c>data struct</c> declaration (ADR-0029).</summary>
    public bool IsData { get; }

    /// <summary>Gets a value indicating whether this is an <c>inline struct</c> declaration (ADR-0033).</summary>
    public bool IsInline { get; }

    /// <summary>Gets a value indicating whether this is a <c>class</c> declaration (Phase 3.B.3). Class types are reference types on the CLR; struct types (this flag false) are value types.</summary>
    public bool IsClass { get; }

    /// <summary>Gets the Kotlin-style primary constructor parameters (Phase 3.B.3 sub-step 2). Each entry corresponds 1:1 to a field of the same name and type on this class; empty when no primary constructor was declared (default parameterless ctor).</summary>
    public ImmutableArray<ParameterSymbol> PrimaryConstructorParameters { get; }

    /// <summary>Gets a value indicating whether this type carries an explicit primary constructor (Phase 3.B.3 sub-step 2).</summary>
    public bool HasPrimaryConstructor => !PrimaryConstructorParameters.IsDefaultOrEmpty;

    /// <summary>Gets a value indicating whether this class was declared <c>open</c> (Phase 3.B.3 sub-step 3 / ADR-0017). Required for subclassing.</summary>
    public bool IsOpen { get; }

    /// <summary>Gets the immediate base class (Phase 3.B.3 sub-step 3), or <c>null</c> when this class derives directly from <c>System.Object</c>. Always null for structs.</summary>
    public StructSymbol BaseClass { get; }

    /// <summary>Gets the interfaces this type implements (Phase 3.B.4). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<InterfaceSymbol> Interfaces { get; private set; }

    /// <summary>Gets the methods declared inside the class body (Phase 3.B.3 sub-step 2b). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<FunctionSymbol> Methods { get; private set; } = ImmutableArray<FunctionSymbol>.Empty;

    /// <summary>Gets the properties declared on this type (ADR-0051). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<PropertySymbol> Properties { get; private set; } = ImmutableArray<PropertySymbol>.Empty;

    /// <summary>Gets the events declared on this type (ADR-0052). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<EventSymbol> Events { get; private set; } = ImmutableArray<EventSymbol>.Empty;

    /// <summary>Gets the type parameters when this is a generic definition (Phase 4.3 / ADR-0020). Empty for non-generic types and for constructed instances.</summary>
    public ImmutableArray<TypeParameterSymbol> TypeParameters { get; private set; } = ImmutableArray<TypeParameterSymbol>.Empty;

    /// <summary>Gets the type arguments when this is a constructed instance of a generic definition (Phase 4.3 / ADR-0020). Empty for generic definitions and for non-generic types.</summary>
    public ImmutableArray<TypeSymbol> TypeArguments { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>Gets a value indicating whether this is a generic definition (has type parameters and no type arguments).</summary>
    public bool IsGenericDefinition => !TypeParameters.IsDefaultOrEmpty && TypeArguments.IsDefaultOrEmpty;

    /// <summary>Gets the original generic definition when this is a constructed instance; otherwise <c>this</c>.</summary>
    public StructSymbol Definition { get; private set; }

    /// <summary>
    /// Gets a value indicating whether this class is sugar-marked as a
    /// <see cref="System.Attribute"/>-derived type via the
    /// <c>@Attribute</c> declaration sugar from ADR-0047 §5. When true, the
    /// emitter overrides the CLR base type from <c>System.Object</c> to
    /// <see cref="System.Attribute"/> and chains the class's constructors
    /// to <c>System.Attribute..ctor()</c>.
    /// </summary>
    public bool IsAttributeClass { get; private set; }

    /// <summary>Sets <see cref="Interfaces"/> after binding. Intended to be called exactly once by the binder during <c>BindStructDeclaration</c>.</summary>
    /// <param name="interfaces">The interfaces this class implements directly.</param>
    public void SetInterfaces(ImmutableArray<InterfaceSymbol> interfaces)
    {
        Interfaces = interfaces;
    }

    /// <summary>Sets <see cref="Methods"/> after binding class-body methods.</summary>
    /// <param name="methods">The bound method symbols owned by this type.</param>
    public void SetMethods(ImmutableArray<FunctionSymbol> methods)
    {
        Methods = methods;
    }

    /// <summary>Sets <see cref="Properties"/> after binding property declarations (ADR-0051).</summary>
    /// <param name="properties">The bound property symbols owned by this type.</param>
    public void SetProperties(ImmutableArray<PropertySymbol> properties)
    {
        Properties = properties;
    }

    /// <summary>Sets <see cref="Events"/> after binding event declarations (ADR-0052).</summary>
    /// <param name="events">The bound event symbols owned by this type.</param>
    public void SetEvents(ImmutableArray<EventSymbol> events)
    {
        Events = events;
    }

    /// <summary>Appends additional methods after the initial declaration binding pass.</summary>
    /// <param name="methods">The receiver-clause methods to append.</param>
    public void AddMethods(ImmutableArray<FunctionSymbol> methods)
    {
        if (methods.IsDefaultOrEmpty)
        {
            return;
        }

        Methods = Methods.IsDefaultOrEmpty ? methods : Methods.AddRange(methods);
    }

    /// <summary>Sets <see cref="TypeParameters"/> on a generic definition (Phase 4.3 / ADR-0020). Intended to be called once by the binder during <c>BindStructDeclaration</c> before any constructed instance is materialized.</summary>
    /// <param name="typeParameters">The bound type parameters in declared order.</param>
    public void SetTypeParameters(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        TypeParameters = typeParameters;
    }

    /// <summary>
    /// Marks this class as an <c>@Attribute</c>-sugar attribute type per
    /// ADR-0047 §5. Intended to be called once by the binder after
    /// <see cref="Symbol.SetAttributes"/> when the bound annotation list
    /// contains the <c>@Attribute</c> marker.
    /// </summary>
    public void SetIsAttributeClass()
    {
        IsAttributeClass = true;
    }

    /// <summary>Walks the base chain looking for a method with the given name. Returns the most-derived overridable definition (the binder narrows further on overload match).</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetInheritedMethod(string name, out FunctionSymbol method)
    {
        for (var c = this.BaseClass; c != null; c = c.BaseClass)
        {
            if (c.TryGetMethod(name, out method))
            {
                return true;
            }
        }

        method = null;
        return false;
    }

    /// <summary>Looks up a method by name on this class or any ancestor (this-first).</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetMethodIncludingInherited(string name, out FunctionSymbol method)
    {
        for (var c = this; c != null; c = c.BaseClass)
        {
            if (c.TryGetMethod(name, out method))
            {
                return true;
            }
        }

        method = null;
        return false;
    }

    /// <summary>Tries to find a method by name on this class.</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetMethod(string name, out FunctionSymbol method)
    {
        if (!Methods.IsDefaultOrEmpty)
        {
            foreach (var m in Methods)
            {
                if (m.Name == name)
                {
                    method = m;
                    return true;
                }
            }
        }

        method = null;
        return false;
    }

    /// <summary>Tries to find a field by name.</summary>
    /// <param name="name">The field name.</param>
    /// <param name="field">The found field on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetField(string name, out FieldSymbol field)
    {
        foreach (var f in Fields)
        {
            if (f.Name == name)
            {
                field = f;
                return true;
            }
        }

        field = null;
        return false;
    }

    /// <summary>Looks up a field by name on this class or any ancestor (this-first). Phase 3.B.3 sub-step 3.</summary>
    /// <param name="name">The field name.</param>
    /// <param name="field">The found field on success.</param>
    /// <param name="declaringType">The class that actually declares the field.</param>
    /// <returns>True if found.</returns>
    public bool TryGetFieldIncludingInherited(string name, out FieldSymbol field, out StructSymbol declaringType)
    {
        for (var c = this; c != null; c = c.BaseClass)
        {
            if (c.TryGetField(name, out field))
            {
                declaringType = c;
                return true;
            }
        }

        field = null;
        declaringType = null;
        return false;
    }

    /// <summary>
    /// Constructs a closed instance of a generic definition with the supplied type arguments
    /// (Phase 4.3 / ADR-0020). Field types are substituted; identity is cached so two calls
    /// with the same definition + arguments return the SAME <see cref="StructSymbol"/>
    /// reference (preserving reference-equality semantics on TypeSymbol).
    /// </summary>
    /// <param name="definition">The generic definition to instantiate. Must have <see cref="IsGenericDefinition"/> true; otherwise returned unchanged.</param>
    /// <param name="typeArguments">The type arguments. Length must match <see cref="TypeParameters"/>.</param>
    /// <returns>A constructed <see cref="StructSymbol"/> whose <see cref="Definition"/> is the original.</returns>
    public static StructSymbol Construct(StructSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
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
            parts[i] = System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(typeArguments[i]).ToString();
        }

        return string.Join(",", parts);
    }

    private static StructSymbol CreateConstructed(StructSymbol definition, ImmutableArray<TypeSymbol> typeArguments)
    {
        var subst = new Dictionary<TypeParameterSymbol, TypeSymbol>(definition.TypeParameters.Length);
        for (var i = 0; i < definition.TypeParameters.Length; i++)
        {
            subst[definition.TypeParameters[i]] = typeArguments[i];
        }

        var substitutedFields = ImmutableArray.CreateBuilder<FieldSymbol>(definition.Fields.Length);
        foreach (var f in definition.Fields)
        {
            substitutedFields.Add(new FieldSymbol(f.Name, SubstituteTypeForConstruction(f.Type, subst), f.Accessibility));
        }

        var substitutedPrimary = ImmutableArray<ParameterSymbol>.Empty;
        if (!definition.PrimaryConstructorParameters.IsDefaultOrEmpty)
        {
            var b = ImmutableArray.CreateBuilder<ParameterSymbol>(definition.PrimaryConstructorParameters.Length);
            foreach (var p in definition.PrimaryConstructorParameters)
            {
                b.Add(new ParameterSymbol(p.Name, SubstituteTypeForConstruction(p.Type, subst)));
            }

            substitutedPrimary = b.MoveToImmutable();
        }

        var constructed = new StructSymbol(
            definition.Name,
            substitutedFields.MoveToImmutable(),
            definition.Accessibility,
            definition.Declaration,
            definition.PackageName,
            definition.IsData,
            definition.IsInline,
            definition.IsClass,
            substitutedPrimary,
            definition.IsOpen,
            definition.BaseClass);

        constructed.Definition = definition;
        constructed.TypeArguments = typeArguments;
        constructed.SetInterfaces(definition.Interfaces);
        constructed.SetMethods(definition.Methods);
        return constructed;
    }

    private static TypeSymbol SubstituteTypeForConstruction(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> subst)
    {
        if (type is TypeParameterSymbol tp)
        {
            return subst.TryGetValue(tp, out var concrete) ? concrete : type;
        }

        if (type is NullableTypeSymbol n)
        {
            var inner = SubstituteTypeForConstruction(n.UnderlyingType, subst);
            return ReferenceEquals(inner, n.UnderlyingType) ? type : NullableTypeSymbol.Get(inner);
        }

        if (type is SliceTypeSymbol s)
        {
            var inner = SubstituteTypeForConstruction(s.ElementType, subst);
            return ReferenceEquals(inner, s.ElementType) ? type : SliceTypeSymbol.Get(inner);
        }

        if (type is ArrayTypeSymbol a)
        {
            var inner = SubstituteTypeForConstruction(a.ElementType, subst);
            return ReferenceEquals(inner, a.ElementType) ? type : ArrayTypeSymbol.Get(inner, a.Length);
        }

        return type;
    }
}
