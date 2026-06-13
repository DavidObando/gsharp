// <copyright file="StructSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
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

    /// <summary>Gets a value indicating whether this is a by-ref-like (<c>ref struct</c>) declaration (issue #367). By-ref-like value types are stack-only: they cannot be boxed, stored in a field of a non-ref-struct, captured by a closure, hoisted into an async/iterator state machine, or used as a generic type argument. Derived from the declaring syntax so it is preserved across generic construction.</summary>
    public bool IsRefStruct => Declaration?.IsRef ?? false;

    /// <summary>
    /// Gets a value indicating whether this class was declared <c>sealed class</c> (ADR-0078).
    /// A sealed class participates in exhaustiveness checking: its subclasses
    /// form a closed set (Kotlin/Swift sealed-class semantics) and the switch
    /// binder requires every subclass to be covered by an arm.
    /// </summary>
    public bool IsSealedHierarchy => IsClass && (Declaration?.IsSealed ?? false);

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

    /// <summary>
    /// Gets the imported (CLR) interfaces this class implements (issue #525).
    /// Each entry's <see cref="TypeSymbol.ClrType"/> is guaranteed to be an
    /// interface type. Populated by the binder when the base-type clause
    /// names a reachable imported CLR interface; defaults to empty.
    /// When set, the emitter writes an <c>InterfaceImpl</c> row per entry so
    /// the resulting class is a real CLR implementer (<c>Type.GetInterfaces()</c>
    /// surfaces the interface and dispatch through interface receivers works).
    /// </summary>
    public ImmutableArray<TypeSymbol> ImplementedClrInterfaces { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>Gets the methods declared inside the class body (Phase 3.B.3 sub-step 2b). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<FunctionSymbol> Methods { get; private set; } = ImmutableArray<FunctionSymbol>.Empty;

    /// <summary>Gets the properties declared on this type (ADR-0051). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<PropertySymbol> Properties { get; private set; } = ImmutableArray<PropertySymbol>.Empty;

    /// <summary>Gets the events declared on this type (ADR-0052). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<EventSymbol> Events { get; private set; } = ImmutableArray<EventSymbol>.Empty;

    /// <summary>Gets the static fields declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    public ImmutableArray<FieldSymbol> StaticFields { get; private set; } = ImmutableArray<FieldSymbol>.Empty;

    /// <summary>Gets the static methods declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    public ImmutableArray<FunctionSymbol> StaticMethods { get; private set; } = ImmutableArray<FunctionSymbol>.Empty;

    /// <summary>Gets the static properties declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    public ImmutableArray<PropertySymbol> StaticProperties { get; private set; } = ImmutableArray<PropertySymbol>.Empty;

    /// <summary>Gets the static events declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    public ImmutableArray<EventSymbol> StaticEvents { get; private set; } = ImmutableArray<EventSymbol>.Empty;

    /// <summary>Gets the bound initializer expressions for static fields with non-default values (Issue #262). Keyed by field symbol.</summary>
    public ImmutableDictionary<FieldSymbol, BoundExpression> StaticFieldInitializers { get; private set; } = ImmutableDictionary<FieldSymbol, BoundExpression>.Empty;

    /// <summary>Gets the bound initializer expressions for instance fields with non-default values (Issue #640). Keyed by field symbol; iterated in <see cref="Fields"/> source order at emit time.</summary>
    public ImmutableDictionary<FieldSymbol, BoundExpression> InstanceFieldInitializers { get; private set; } = ImmutableDictionary<FieldSymbol, BoundExpression>.Empty;

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

    /// <summary>
    /// Gets the imported (CLR) base class this GSharp class derives from
    /// (issue #296), or <c>null</c> when the class derives from another GSharp
    /// class (<see cref="BaseClass"/>) or directly from <c>System.Object</c>.
    /// When set, the emitter writes this CLR type as the TypeDef's base type
    /// and chains the generated constructor to the CLR base's parameterless
    /// <c>.ctor()</c>; member lookup walks into this type so inherited CLR
    /// members are accessible on instances of the derived GSharp class.
    /// </summary>
    public TypeSymbol ImportedBaseType { get; private set; }

    /// <summary>
    /// Gets the explicit base-constructor initializer (<c>: Base(args)</c>) declared
    /// on this class (issue #306), or <c>null</c> when the class chains to a
    /// parameterless base constructor. When non-null the emitter forwards the
    /// bound arguments to the resolved base <c>.ctor</c> and suppresses the
    /// auto-generated parameterless constructor.
    /// </summary>
    public BaseConstructorInitializer BaseConstructorInitializer { get; private set; }

    /// <summary>
    /// Gets the resolved <see cref="StructLayoutMetadata"/> derived from a
    /// <c>@StructLayout(LayoutKind.…)</c> annotation on the declaration, or
    /// <c>null</c> when no annotation was supplied. ADR-0093 / issue #759:
    /// the emitter consults this property to pick the correct CLR
    /// <see cref="System.Reflection.TypeAttributes"/> layout flag and to
    /// write the optional <c>ClassLayout</c> row.
    /// </summary>
    public StructLayoutMetadata LayoutMetadata { get; private set; }

    /// <summary>
    /// Gets the standalone user-defined constructor (<c>init(...)</c>) declared on
    /// this class (issue #306), or <c>null</c> when the class has none. When non-null
    /// the emitter materializes exactly one <c>.ctor</c> (this constructor) and
    /// suppresses the auto-generated parameterless / primary constructor.
    /// </summary>
    /// <remarks>
    /// ADR-0063: when the class declares an overload family of <c>init(...)</c>
    /// constructors, <see cref="ExplicitConstructor"/> still surfaces the
    /// <em>first</em> declaration so single-constructor callers keep working;
    /// the full overload set lives on <see cref="ExplicitConstructors"/>.
    /// </remarks>
    public ConstructorSymbol ExplicitConstructor { get; private set; }

    /// <summary>
    /// Gets every user-defined <c>init(...)</c> constructor declared on
    /// this class in declaration order (ADR-0063). Empty when the class has no
    /// explicit constructor declarations. The first element always equals
    /// <see cref="ExplicitConstructor"/>.
    /// </summary>
    public ImmutableArray<ConstructorSymbol> ExplicitConstructors { get; private set; } = ImmutableArray<ConstructorSymbol>.Empty;

    /// <summary>
    /// Gets the user-declared <c>deinit { … }</c> destructor on this class
    /// (ADR-0068 / issue #698), or <c>null</c> when the class has none.
    /// Populated by the binder; consumed by the emitter to materialise the
    /// CLR <c>Finalize</c> override.
    /// </summary>
    public DeinitSymbol Deinitializer { get; private set; }

    /// <summary>Sets <see cref="ImportedBaseType"/> after binding (issue #296). Intended to be called exactly once by the binder for a class inheriting an imported CLR base.</summary>
    /// <param name="importedBaseType">The imported CLR base type symbol.</param>
    public void SetImportedBaseType(TypeSymbol importedBaseType)
    {
        ImportedBaseType = importedBaseType;
    }

    /// <summary>Sets <see cref="BaseConstructorInitializer"/> after binding the base-constructor argument list (issue #306).</summary>
    /// <param name="initializer">The resolved base-constructor initializer.</param>
    public void SetBaseConstructorInitializer(BaseConstructorInitializer initializer)
    {
        BaseConstructorInitializer = initializer;
    }

    /// <summary>Sets <see cref="ExplicitConstructor"/> after binding the class body (issue #306).</summary>
    /// <param name="constructor">The resolved standalone constructor.</param>
    public void SetExplicitConstructor(ConstructorSymbol constructor)
    {
        ExplicitConstructor = constructor;
        ExplicitConstructors = constructor == null
            ? ImmutableArray<ConstructorSymbol>.Empty
            : ImmutableArray.Create(constructor);
    }

    /// <summary>
    /// ADR-0063: sets <see cref="ExplicitConstructors"/> (and surfaces the first
    /// declaration as the legacy <see cref="ExplicitConstructor"/>). Intended to
    /// be called exactly once by the binder for a class that declares one or
    /// more <c>init(...)</c> constructors.
    /// </summary>
    /// <param name="constructors">The resolved standalone constructors in declaration order.</param>
    public void SetExplicitConstructors(ImmutableArray<ConstructorSymbol> constructors)
    {
        ExplicitConstructors = constructors.IsDefault ? ImmutableArray<ConstructorSymbol>.Empty : constructors;
        ExplicitConstructor = ExplicitConstructors.Length == 0 ? null : ExplicitConstructors[0];
    }

    /// <summary>ADR-0068 / issue #698: sets <see cref="Deinitializer"/> after the binder synthesises the <c>Finalize</c> function symbol for a class with a <c>deinit { … }</c> body.</summary>
    /// <param name="deinitializer">The bound destructor symbol, or <c>null</c> to clear.</param>
    public void SetDeinitializer(DeinitSymbol deinitializer)
    {
        Deinitializer = deinitializer;
    }

    /// <summary>Sets <see cref="Interfaces"/> after binding. Intended to be called exactly once by the binder during <c>BindStructDeclaration</c>.</summary>
    /// <param name="interfaces">The interfaces this class implements directly.</param>
    public void SetInterfaces(ImmutableArray<InterfaceSymbol> interfaces)
    {
        Interfaces = interfaces;
    }

    /// <summary>
    /// Issue #525: sets <see cref="ImplementedClrInterfaces"/> after binding
    /// the base-type clause. Intended to be called exactly once by the binder
    /// for a class whose base-type clause names one or more imported CLR
    /// interfaces.
    /// </summary>
    /// <param name="interfaces">The imported CLR interface types this class implements directly.</param>
    public void SetImplementedClrInterfaces(ImmutableArray<TypeSymbol> interfaces)
    {
        ImplementedClrInterfaces = interfaces.IsDefault ? ImmutableArray<TypeSymbol>.Empty : interfaces;
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

    /// <summary>Sets <see cref="StaticFields"/> after binding shared-block field declarations (ADR-0053).</summary>
    /// <param name="fields">The bound static field symbols owned by this type.</param>
    public void SetStaticFields(ImmutableArray<FieldSymbol> fields)
    {
        StaticFields = fields;
    }

    /// <summary>Sets <see cref="StaticMethods"/> after binding shared-block method declarations (ADR-0053).</summary>
    /// <param name="methods">The bound static method symbols owned by this type.</param>
    public void SetStaticMethods(ImmutableArray<FunctionSymbol> methods)
    {
        StaticMethods = methods;
    }

    /// <summary>Sets <see cref="StaticProperties"/> after binding shared-block property declarations (ADR-0053).</summary>
    /// <param name="properties">The bound static property symbols owned by this type.</param>
    public void SetStaticProperties(ImmutableArray<PropertySymbol> properties)
    {
        StaticProperties = properties;
    }

    /// <summary>Sets <see cref="StaticEvents"/> after binding shared-block event declarations (ADR-0053).</summary>
    /// <param name="events">The bound static event symbols owned by this type.</param>
    public void SetStaticEvents(ImmutableArray<EventSymbol> events)
    {
        StaticEvents = events;
    }

    /// <summary>Sets <see cref="StaticFieldInitializers"/> after binding shared-block field initializers (Issue #262).</summary>
    /// <param name="initializers">A mapping from field symbol to its bound initializer expression.</param>
    public void SetStaticFieldInitializers(ImmutableDictionary<FieldSymbol, BoundExpression> initializers)
    {
        StaticFieldInitializers = initializers;
    }

    /// <summary>Sets <see cref="InstanceFieldInitializers"/> after binding instance-field initializers (Issue #640).</summary>
    /// <param name="initializers">A mapping from field symbol to its bound initializer expression.</param>
    public void SetInstanceFieldInitializers(ImmutableDictionary<FieldSymbol, BoundExpression> initializers)
    {
        InstanceFieldInitializers = initializers;
    }

    /// <summary>Tries to find a static field by name on this type (ADR-0053).</summary>
    /// <param name="name">The field name.</param>
    /// <param name="field">The found static field on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetStaticField(string name, out FieldSymbol field)
    {
        if (!StaticFields.IsDefaultOrEmpty)
        {
            foreach (var f in StaticFields)
            {
                if (f.Name == name)
                {
                    field = f;
                    return true;
                }
            }
        }

        field = null;
        return false;
    }

    /// <summary>Tries to find a static method by name on this type (ADR-0053).</summary>
    /// <param name="name">The method name.</param>
    /// <param name="method">The found static method on success.</param>
    /// <returns>True if found.</returns>
    public bool TryGetStaticMethod(string name, out FunctionSymbol method)
    {
        if (!StaticMethods.IsDefaultOrEmpty)
        {
            foreach (var m in StaticMethods)
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

    /// <summary>
    /// Sets the resolved <see cref="LayoutMetadata"/>. Intended to be
    /// called once by the binder after attributes have been bound; the
    /// <see cref="StructLayoutBinder"/> helper writes the resolved
    /// metadata onto the symbol so the emitter can consume it. ADR-0093
    /// / issue #759.
    /// </summary>
    /// <param name="metadata">The validated layout metadata.</param>
    public void SetLayoutMetadata(StructLayoutMetadata metadata)
    {
        LayoutMetadata = metadata;
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

    /// <summary>
    /// ADR-0063: returns every instance method whose name equals <paramref name="name"/> (the overload set).
    /// </summary>
    /// <param name="name">The method name.</param>
    /// <returns>The overload set; empty if none.</returns>
    public System.Collections.Immutable.ImmutableArray<FunctionSymbol> GetMethods(string name)
    {
        if (Methods.IsDefaultOrEmpty)
        {
            return System.Collections.Immutable.ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = System.Collections.Immutable.ImmutableArray.CreateBuilder<FunctionSymbol>();
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
    /// ADR-0063: returns every method named <paramref name="name"/> visible on this
    /// class, walking the inheritance chain this-first. Derived methods that share
    /// a signature with a base method (i.e. real overrides) hide the base entry so
    /// the overload set surfaced to overload resolution contains exactly one
    /// FunctionSymbol per visible signature.
    /// </summary>
    /// <param name="name">The method name.</param>
    /// <returns>The merged overload set; empty if none found.</returns>
    public System.Collections.Immutable.ImmutableArray<FunctionSymbol> GetMethodsIncludingInherited(string name)
    {
        System.Collections.Immutable.ImmutableArray<FunctionSymbol>.Builder builder = null;
        for (var c = this; c != null; c = c.BaseClass)
        {
            if (c.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var m in c.Methods)
            {
                if (m.Name != name)
                {
                    continue;
                }

                if (builder != null)
                {
                    var hiddenByDerived = false;
                    foreach (var existing in builder)
                    {
                        if (BoundScope.FunctionSignaturesEqual(existing, m))
                        {
                            hiddenByDerived = true;
                            break;
                        }
                    }

                    if (hiddenByDerived)
                    {
                        continue;
                    }
                }

                builder ??= System.Collections.Immutable.ImmutableArray.CreateBuilder<FunctionSymbol>();
                builder.Add(m);
            }
        }

        return builder == null
            ? System.Collections.Immutable.ImmutableArray<FunctionSymbol>.Empty
            : builder.ToImmutable();
    }

    /// <summary>
    /// ADR-0063: returns every shared/static method whose name equals <paramref name="name"/> (the overload set).
    /// </summary>
    /// <param name="name">The method name.</param>
    /// <returns>The overload set; empty if none.</returns>
    public System.Collections.Immutable.ImmutableArray<FunctionSymbol> GetStaticMethods(string name)
    {
        if (StaticMethods.IsDefaultOrEmpty)
        {
            return System.Collections.Immutable.ImmutableArray<FunctionSymbol>.Empty;
        }

        var builder = System.Collections.Immutable.ImmutableArray.CreateBuilder<FunctionSymbol>();
        foreach (var m in StaticMethods)
        {
            if (m.Name == name)
            {
                builder.Add(m);
            }
        }

        return builder.ToImmutable();
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
                b.Add(new ParameterSymbol(p.Name, SubstituteTypeForConstruction(p.Type, subst), isScoped: p.IsScoped));
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
        if (!definition.Interfaces.IsDefaultOrEmpty)
        {
            var substitutedIfaces = ImmutableArray.CreateBuilder<InterfaceSymbol>(definition.Interfaces.Length);
            foreach (var iface in definition.Interfaces)
            {
                substitutedIfaces.Add((InterfaceSymbol)SubstituteTypeForConstruction(iface, subst));
            }

            constructed.SetInterfaces(substitutedIfaces.MoveToImmutable());
        }
        else
        {
            constructed.SetInterfaces(definition.Interfaces);
        }

        if (!definition.ImplementedClrInterfaces.IsDefaultOrEmpty)
        {
            var substitutedClrIfaces = ImmutableArray.CreateBuilder<TypeSymbol>(definition.ImplementedClrInterfaces.Length);
            foreach (var iface in definition.ImplementedClrInterfaces)
            {
                substitutedClrIfaces.Add(SubstituteTypeForConstruction(iface, subst));
            }

            constructed.SetImplementedClrInterfaces(substitutedClrIfaces.MoveToImmutable());
        }

        constructed.SetMethods(definition.Methods);
        if (definition.ImportedBaseType != null)
        {
            constructed.SetImportedBaseType(definition.ImportedBaseType);
        }

        return constructed;
    }

    private static TypeSymbol SubstituteTypeForConstruction(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> subst)
    {
        if (type is TypeParameterSymbol tp)
        {
            return subst.TryGetValue(tp, out var concrete) ? concrete : type;
        }

        if (type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedArgs = ImmutableArray.CreateBuilder<TypeSymbol>(iface.TypeArguments.Length);
            var changed = false;
            for (var i = 0; i < iface.TypeArguments.Length; i++)
            {
                var substituted = SubstituteTypeForConstruction(iface.TypeArguments[i], subst);
                substitutedArgs.Add(substituted);
                changed |= !ReferenceEquals(substituted, iface.TypeArguments[i]);
            }

            if (!changed)
            {
                return iface;
            }

            return InterfaceSymbol.Construct(iface.Definition, substitutedArgs.MoveToImmutable());
        }

        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && !imported.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedArgs = ImmutableArray.CreateBuilder<TypeSymbol>(imported.TypeArguments.Length);
            var changed = false;
            for (var i = 0; i < imported.TypeArguments.Length; i++)
            {
                var substituted = SubstituteTypeForConstruction(imported.TypeArguments[i], subst);
                substitutedArgs.Add(substituted);
                changed |= !ReferenceEquals(substituted, imported.TypeArguments[i]);
            }

            if (!changed)
            {
                return imported;
            }

            var resolvedClrArgs = new System.Type[substitutedArgs.Count];
            for (var i = 0; i < substitutedArgs.Count; i++)
            {
                resolvedClrArgs[i] = substitutedArgs[i].ClrType ?? typeof(object);
            }

            try
            {
                var closed = imported.OpenDefinition.MakeGenericType(resolvedClrArgs);
                return ImportedTypeSymbol.GetConstructed(closed, imported.OpenDefinition, substitutedArgs.MoveToImmutable());
            }
            catch (ArgumentException)
            {
                return imported;
            }
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
