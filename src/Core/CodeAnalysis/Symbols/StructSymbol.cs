// <copyright file="StructSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a user-defined struct type (Phase 3.B.1). Structs are CLR value
/// types with public-by-default fields and no methods of their own. Methods are
/// added via extension functions in a later sub-phase.
/// </summary>
public sealed class StructSymbol : TypeSymbol
{
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
        : this(name, fields, accessibility, declaration, packageName, isData: false)
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
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName,
        bool isData)
        : this(name, fields, accessibility, declaration, packageName, isData, isClass: false)
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
    /// <param name="isClass">True for <c>class</c> declarations (Phase 3.B.3): emitted as a CLR reference type with object base; not value-copied on assignment.</param>
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName,
        bool isData,
        bool isClass)
        : this(name, fields, accessibility, declaration, packageName, isData, isClass, primaryConstructorParameters: ImmutableArray<ParameterSymbol>.Empty)
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
    /// <param name="isClass">True for <c>class</c> declarations (Phase 3.B.3): emitted as a CLR reference type with object base; not value-copied on assignment.</param>
    /// <param name="primaryConstructorParameters">The Kotlin-style primary constructor parameters (Phase 3.B.3 sub-step 2). Each entry corresponds to a field of the same name; empty when the type has no explicit primary constructor (default parameterless ctor).</param>
    public StructSymbol(
        string name,
        ImmutableArray<FieldSymbol> fields,
        Accessibility accessibility,
        StructDeclarationSyntax declaration,
        string packageName,
        bool isData,
        bool isClass,
        ImmutableArray<ParameterSymbol> primaryConstructorParameters)
        : base(name)
    {
        Fields = fields;
        Accessibility = accessibility;
        Declaration = declaration;
        PackageName = packageName;
        IsData = isData;
        IsClass = isClass;
        PrimaryConstructorParameters = primaryConstructorParameters;
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

    /// <summary>Gets a value indicating whether this is a <c>class</c> declaration (Phase 3.B.3). Class types are reference types on the CLR; struct types (this flag false) are value types.</summary>
    public bool IsClass { get; }

    /// <summary>Gets the Kotlin-style primary constructor parameters (Phase 3.B.3 sub-step 2). Each entry corresponds 1:1 to a field of the same name and type on this class; empty when no primary constructor was declared (default parameterless ctor).</summary>
    public ImmutableArray<ParameterSymbol> PrimaryConstructorParameters { get; }

    /// <summary>Gets a value indicating whether this type carries an explicit primary constructor (Phase 3.B.3 sub-step 2).</summary>
    public bool HasPrimaryConstructor => !PrimaryConstructorParameters.IsDefaultOrEmpty;

    /// <summary>Gets the methods declared inside the class body (Phase 3.B.3 sub-step 2b). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<FunctionSymbol> Methods { get; private set; } = ImmutableArray<FunctionSymbol>.Empty;

    /// <summary>Sets <see cref="Methods"/> after binding. Intended to be called exactly once by the binder during <c>BindStructDeclaration</c>.</summary>
    /// <param name="methods">The bound method symbols owned by this class.</param>
    public void SetMethods(ImmutableArray<FunctionSymbol> methods)
    {
        Methods = methods;
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
}
