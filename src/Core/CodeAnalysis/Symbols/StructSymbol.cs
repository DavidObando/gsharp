// <copyright file="StructSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
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
    private static readonly ConcurrentDictionary<(StructSymbol Def, TypeArgsKey ArgsKey), StructSymbol> ConstructedCache = new();

    // Issue #1521: identity cache for constructed references to types nested
    // inside a generic enclosing type (`Box[int32].Tag`), keyed by the nested
    // definition and the flattened enclosing type-argument vector so two
    // references to the same construction share one symbol (preserving
    // reference equality and TypeSpec caching in the emitter).
    private static readonly ConcurrentDictionary<(StructSymbol Def, TypeArgsKey ArgsKey), StructSymbol> ConstructedNestedCache = new();

    // Issue #1537: identity cache for constructed references to a GENERIC type
    // nested inside a generic enclosing type (`Outer[int32].Middle[string]`),
    // keyed by the nested definition, the flattened enclosing type-argument
    // vector, and the nested type's own type-argument vector. Distinct from
    // ConstructedNestedCache (which keys only the enclosing args for a nested
    // type with no own parameters) so the two representations never collide.
    private static readonly ConcurrentDictionary<(StructSymbol Def, TypeArgsKey EnclosingKey, TypeArgsKey OwnKey), StructSymbol> ConstructedNestedGenericCache = new();

    // Issue #1341: backing stores for the generically-erased member tables whose
    // reads are forwarded to Definition on a constructed instance. On a
    // definition (or non-generic type) these hold the canonical member set; on a
    // constructed instance they are unused (the forwarding getter reads
    // Definition's store) so a late-bound definition body is always observed.
    private ImmutableArray<FunctionSymbol> methods = ImmutableArray<FunctionSymbol>.Empty;
    private ImmutableArray<FunctionSymbol> staticMethods = ImmutableArray<FunctionSymbol>.Empty;
    private ImmutableArray<FieldSymbol> staticFields = ImmutableArray<FieldSymbol>.Empty;
    private ImmutableArray<FieldSymbol> constFields = ImmutableArray<FieldSymbol>.Empty;
    private ImmutableArray<FieldSymbol> fieldsStore = ImmutableArray<FieldSymbol>.Empty;
    private ImmutableArray<PropertySymbol> propertiesStore = ImmutableArray<PropertySymbol>.Empty;
    private ImmutableArray<PropertySymbol> staticPropertiesStore = ImmutableArray<PropertySymbol>.Empty;
    private ImmutableArray<EventSymbol> staticEventsStore = ImmutableArray<EventSymbol>.Empty;

    // Issue #1341: memoized substitution of the definition's instance-member
    // tables (whose member types may mention the type parameters) for a
    // constructed instance. These are recomputed when the definition's source
    // array changes reference — which happens exactly once, when the
    // definition's body is bound — so a construction materialized before the
    // definition's body still observes the substituted members afterward,
    // making member lookup independent of source-file binding order.
    private Dictionary<TypeParameterSymbol, TypeSymbol> substitutionMap;

    // Issue #1537: for a constructed reference to a GENERIC type nested inside a
    // generic enclosing type (`Outer[int32].Middle[string]`), the nested
    // definition's own type parameters captured at construction time (before the
    // emitter re-ordinalizes the nested TypeDef's parameters over the flattened
    // enclosing+own list, ECMA-335 §II.10.3.1). Used to key the own-argument
    // half of the substitution map so a member typed as the nested type's own
    // parameter (`Middle.Label : T`) surfaces closed regardless of when the map
    // is first computed. Empty for every other symbol.
    private ImmutableArray<TypeParameterSymbol> nestedOwnTypeParameters = ImmutableArray<TypeParameterSymbol>.Empty;

    // Issue #1958: the projector supplied to Construct()/ConstructNested()/
    // ConstructNestedGeneric(), retained so the (lazily computed, see
    // GetSubstitutedFields/GetSubstitutedProperties) member substitution can
    // close constructed-generic member types in the right reflection context.
    // Null for definitions and for constructed instances built without a
    // projector (single-context callers; unchanged behavior).
    private Func<Type, Type> mapClrType;
    private ImmutableArray<FieldSymbol> substitutedFields;
    private ImmutableArray<FieldSymbol> substitutedFieldsSource;
    private bool substitutedFieldsComputed;
    private ImmutableArray<PropertySymbol> substitutedProperties;
    private ImmutableArray<PropertySymbol> substitutedPropertiesSource;
    private bool substitutedPropertiesComputed;
    private ImmutableArray<PropertySymbol> substitutedStaticProperties;
    private ImmutableArray<PropertySymbol> substitutedStaticPropertiesSource;
    private bool substitutedStaticPropertiesComputed;
    private ImmutableArray<ParameterSymbol> primaryConstructorParametersStore = ImmutableArray<ParameterSymbol>.Empty;
    private ImmutableArray<InterfaceSymbol> interfacesStore = ImmutableArray<InterfaceSymbol>.Empty;
    private ImmutableArray<TypeSymbol> implementedClrInterfacesStore = ImmutableArray<TypeSymbol>.Empty;
    private ImmutableArray<EventSymbol> eventsStore = ImmutableArray<EventSymbol>.Empty;
    private TypeSymbol importedBaseTypeStore;
    private StructSymbol baseClassStore;
    private BaseClassSnapshot substitutedBaseClass;
    private ParameterArraySnapshot substitutedPrimaryConstructorParameters;
    private InterfaceArraySnapshot substitutedInterfaces;
    private TypeArraySnapshot substitutedImplementedClrInterfaces;
    private TypeSnapshot substitutedImportedBaseType;

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
        : this(name, fields, accessibility, declaration, packageName, isData, isInline, isClass, primaryConstructorParameters, isOpen, baseClass, clrType: null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="StructSymbol"/> class for
    /// a metadata-backed aggregate that still needs G#-level semantics during
    /// binding/emission (for example an imported value type compiled from G#).
    /// </summary>
    /// <param name="name">The aggregate type name.</param>
    /// <param name="fields">The field declarations in source order.</param>
    /// <param name="accessibility">The CLR accessibility.</param>
    /// <param name="declaration">The declaring syntax node, or <see langword="null"/> for imported types.</param>
    /// <param name="packageName">The package/namespace the type lives in.</param>
    /// <param name="isData">True for <c>data struct</c> declarations.</param>
    /// <param name="isInline">True for <c>inline struct</c> declarations.</param>
    /// <param name="isClass">True for <c>class</c> declarations.</param>
    /// <param name="primaryConstructorParameters">The Kotlin-style primary constructor parameters.</param>
    /// <param name="isOpen">True when this class was declared with the <c>open</c> modifier.</param>
    /// <param name="baseClass">The base class symbol.</param>
    /// <param name="clrType">The backing CLR type for imported aggregates, or <see langword="null"/> for same-compilation user types.</param>
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
        StructSymbol baseClass,
        Type clrType)
        : base(name, clrType)
    {
        Fields = fields;
        Accessibility = accessibility;
        Declaration = declaration;
        PackageName = packageName;
        IsData = isData;
        IsInline = isInline;
        IsClass = isClass;
        primaryConstructorParametersStore = primaryConstructorParameters;
        IsOpen = isOpen;
        baseClassStore = baseClass;
        interfacesStore = ImmutableArray<InterfaceSymbol>.Empty;
        Definition = this;
    }

    /// <summary>Gets the field declarations in source order.</summary>
    /// <remarks>Issue #1341: on a constructed instance, fields are substituted lazily from <see cref="Definition"/> so a late-bound definition body is observed (order-independent member lookup).</remarks>
    public ImmutableArray<FieldSymbol> Fields
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? GetSubstitutedFields() : fieldsStore;
        private set => fieldsStore = value;
    }

    /// <summary>Gets the struct CLR accessibility.</summary>
    public Accessibility Accessibility { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public StructDeclarationSyntax Declaration { get; private set; }

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
    public ImmutableArray<ParameterSymbol> PrimaryConstructorParameters
    {
        get => Definition != null && !ReferenceEquals(Definition, this)
            ? GetSubstitutedPrimaryConstructorParameters()
            : primaryConstructorParametersStore;
        private set => primaryConstructorParametersStore = value;
    }

    /// <summary>Gets a value indicating whether this type carries an explicit primary constructor (Phase 3.B.3 sub-step 2).</summary>
    public bool HasPrimaryConstructor => !PrimaryConstructorParameters.IsDefaultOrEmpty;

    /// <summary>Gets a value indicating whether this class was declared <c>open</c> (Phase 3.B.3 sub-step 3 / ADR-0017). Required for subclassing.</summary>
    public bool IsOpen { get; }

    /// <summary>
    /// Gets a value indicating whether this class is abstract — issue #987. A
    /// class is abstract when its effective member set (own + inherited, after
    /// override resolution) contains at least one abstract method (a no-body
    /// <c>open func</c>). Such a type cannot be instantiated and is emitted with
    /// <c>TypeAttributes.Abstract</c>. Always <c>false</c> for value-type structs.
    /// </summary>
    public bool IsAbstract
    {
        get
        {
            if (!IsClass)
            {
                return false;
            }

            // Issue #1055: an abstract base method whose signature uses the base's
            // generic type parameters is implemented by an override whose concrete
            // signature matches the substituted base signature. Route through the
            // substitution-aware unimplemented-method computation so a class that
            // inherits a constructed generic base (e.g. `Derived : Base[int32]`)
            // and overrides every abstract member is correctly treated as concrete.
            return !GetUnimplementedAbstractMethods().IsDefaultOrEmpty;
        }
    }

    /// <summary>Gets the immediate base class (Phase 3.B.3 sub-step 3), or <c>null</c> when this class derives directly from <c>System.Object</c>. Always null for structs.</summary>
    public StructSymbol BaseClass
    {
        get
        {
            if (Definition == null || ReferenceEquals(Definition, this))
            {
                return Volatile.Read(ref baseClassStore);
            }

            return GetSubstitutedBaseClass();
        }
    }

    /// <summary>Gets the interfaces this type implements (Phase 3.B.4). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<InterfaceSymbol> Interfaces
    {
        get => Definition != null && !ReferenceEquals(Definition, this)
            ? GetSubstitutedInterfaces()
            : interfacesStore;
        private set => interfacesStore = value;
    }

    /// <summary>
    /// Gets the imported (CLR) interfaces this class implements (issue #525).
    /// Each entry's <see cref="TypeSymbol.ClrType"/> is guaranteed to be an
    /// interface type. Populated by the binder when the base-type clause
    /// names a reachable imported CLR interface; defaults to empty.
    /// When set, the emitter writes an <c>InterfaceImpl</c> row per entry so
    /// the resulting class is a real CLR implementer (<c>Type.GetInterfaces()</c>
    /// surfaces the interface and dispatch through interface receivers works).
    /// </summary>
    public ImmutableArray<TypeSymbol> ImplementedClrInterfaces
    {
        get => Definition != null && !ReferenceEquals(Definition, this)
            ? GetSubstitutedImplementedClrInterfaces()
            : implementedClrInterfacesStore;
        private set => implementedClrInterfacesStore = value;
    }

    /// <summary>Gets the methods declared inside the class body (Phase 3.B.3 sub-step 2b). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    /// <remarks>
    /// Issue #1341: methods are erased generically (ADR-0004) and carried on a
    /// constructed instance without per-construction substitution, so a
    /// constructed instance always reflects its <see cref="Definition"/>'s
    /// current method set by forwarding the read. This keeps member lookup on a
    /// constructed generic user type independent of the order in which source
    /// files are bound: even when the construction is materialized (and cached)
    /// before the definition's body — and therefore its methods — has been
    /// bound, reads observe the methods once they are populated rather than an
    /// empty snapshot captured at construction time.
    /// </remarks>
    public ImmutableArray<FunctionSymbol> Methods
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? Definition.Methods : methods;
        private set => methods = value;
    }

    /// <summary>Gets the properties declared on this type (ADR-0051). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    /// <remarks>Issue #1341: on a constructed instance, properties are substituted lazily from <see cref="Definition"/> so a late-bound definition body is observed (order-independent member lookup).</remarks>
    public ImmutableArray<PropertySymbol> Properties
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? GetSubstitutedProperties() : propertiesStore;
        private set => propertiesStore = value;
    }

    /// <summary>Gets the events declared on this type (ADR-0052). Populated by the binder after the symbol is constructed; defaults to empty.</summary>
    public ImmutableArray<EventSymbol> Events
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? Definition.Events : eventsStore;
        private set => eventsStore = value;
    }

    /// <summary>Gets the static fields declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    /// <remarks>Issue #1341: forwarded from <see cref="Definition"/> on a constructed instance (static members are shared by identity per issue #1209) so reads are order-independent.</remarks>
    public ImmutableArray<FieldSymbol> StaticFields
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? Definition.StaticFields : staticFields;
        private set => staticFields = value;
    }

    /// <summary>
    /// Gets the compile-time constant fields declared with <c>const</c>
    /// (Issue #948). Const fields are implicitly static and read-only; they are
    /// emitted as CLR <c>literal</c> fields with a <c>Constant</c> row and their
    /// reads are inlined. Held separately from <see cref="StaticFields"/> so the
    /// emitter never produces a runtime static field or a <c>.cctor</c>
    /// assignment for them. Populated by the binder; defaults to empty.
    /// </summary>
    public ImmutableArray<FieldSymbol> ConstFields
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? Definition.ConstFields : constFields;
        private set => constFields = value;
    }

    /// <summary>Gets the static methods declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    /// <remarks>Issue #1341: forwarded from <see cref="Definition"/> on a constructed instance (static members are shared by identity per issue #1209) so reads are order-independent.</remarks>
    public ImmutableArray<FunctionSymbol> StaticMethods
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? Definition.StaticMethods : staticMethods;
        private set => staticMethods = value;
    }

    /// <summary>Gets the static properties declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    /// <remarks>Issue #1341: on a constructed instance, static properties are substituted lazily from <see cref="Definition"/> so a late-bound definition body is observed (order-independent member lookup).</remarks>
    public ImmutableArray<PropertySymbol> StaticProperties
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? GetSubstitutedStaticProperties() : staticPropertiesStore;
        private set => staticPropertiesStore = value;
    }

    /// <summary>Gets the static events declared inside a <c>shared</c> block (ADR-0053). Populated by the binder; defaults to empty.</summary>
    public ImmutableArray<EventSymbol> StaticEvents
    {
        get => Definition != null && !ReferenceEquals(Definition, this) ? Definition.StaticEvents : staticEventsStore;
        private set => staticEventsStore = value;
    }

    /// <summary>Gets the bound initializer expressions for static fields with non-default values (Issue #262). Keyed by field symbol.</summary>
    public ImmutableDictionary<FieldSymbol, BoundExpression> StaticFieldInitializers { get; private set; } = ImmutableDictionary<FieldSymbol, BoundExpression>.Empty;

    /// <summary>Gets the bound initializer expressions for instance fields with non-default values (Issue #640). Keyed by field symbol; iterated in <see cref="Fields"/> source order at emit time.</summary>
    public ImmutableDictionary<FieldSymbol, BoundExpression> InstanceFieldInitializers { get; private set; } = ImmutableDictionary<FieldSymbol, BoundExpression>.Empty;

    /// <summary>
    /// Gets the bound, lowered statements of the type's <c>shared { init { … } }</c>
    /// static-initializer block(s) (ADR-0140 / issue #2131), concatenated in
    /// source order. Emitted into the type's <c>.cctor</c> after the static-field
    /// initializers. Defaults to empty.
    /// </summary>
    public ImmutableArray<BoundStatement> StaticInitializerStatements { get; private set; } = ImmutableArray<BoundStatement>.Empty;

    /// <summary>Gets a value indicating whether the type declares a <c>shared { init { … } }</c> static-initializer block (ADR-0140 / issue #2131). Such a type must not be marked <c>beforefieldinit</c>.</summary>
    public bool HasStaticInitializerBlock => !StaticInitializerStatements.IsDefaultOrEmpty;

    /// <summary>Gets the type parameters when this is a generic definition (Phase 4.3 / ADR-0020). Empty for non-generic types and for constructed instances.</summary>
    public ImmutableArray<TypeParameterSymbol> TypeParameters { get; private set; } = ImmutableArray<TypeParameterSymbol>.Empty;

    /// <summary>Gets the type arguments when this is a constructed instance of a generic definition (Phase 4.3 / ADR-0020). Empty for generic definitions and for non-generic types.</summary>
    public ImmutableArray<TypeSymbol> TypeArguments { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>
    /// Gets the flattened type arguments of the enclosing construction when this
    /// is a reference to a type nested inside a <em>generic</em> enclosing type
    /// used from a <em>constructed</em> context (issue #1521) — e.g. the return
    /// type <c>Tag</c> of <c>Box[int32].MakeTag()</c> surfaces as
    /// <c>Box[int32].Tag</c>. The arguments are ordered outermost-first
    /// (CLR order), aligned 1:1 with the enclosing generic parameters the
    /// emitter reifies the nested type over (ECMA-335 §II.10.3.1), so a
    /// use-site reference / local / field slot encodes
    /// <c>Box`1+Tag`1&lt;int32&gt;</c> rather than the open self-instantiation
    /// <c>Box`1+Tag`1&lt;!0&gt;</c>. Empty for a top-level type, for an open
    /// nested type referenced from within its own enclosing generic's members
    /// (which threads <c>!0…</c>), and for a nested type of a non-generic type.
    /// </summary>
    public ImmutableArray<TypeSymbol> EnclosingTypeArguments { get; private set; } = ImmutableArray<TypeSymbol>.Empty;

    /// <summary>
    /// Gets a value indicating whether this is a constructed reference to a type
    /// nested inside a generic enclosing type (issue #1521) — it carries
    /// <see cref="EnclosingTypeArguments"/> but declares no own type arguments.
    /// </summary>
    public bool IsConstructedNestedType => !EnclosingTypeArguments.IsDefaultOrEmpty;

    /// <summary>
    /// Gets, for a synthesized closure / capture-box class that was reified
    /// generic over enclosing type/method type parameters (issue #1477), the
    /// ordered list of the ORIGINAL enclosing
    /// <see cref="TypeParameterSymbol"/>s its fresh class type parameters
    /// (<see cref="TypeParameters"/>) clone 1:1. The emitter consumes this to
    /// build the outer-TP → own-TP-ordinal remap (mirroring the iterator/async
    /// state-machine treatment) so member signatures encode a valid
    /// <c>VAR(idx)</c> slot. Empty for every other type. Each entry at index
    /// <c>i</c> corresponds to <see cref="TypeParameters"/><c>[i]</c>.
    /// </summary>
    public ImmutableArray<TypeParameterSymbol> ReifiedFromTypeParameters { get; private set; } = ImmutableArray<TypeParameterSymbol>.Empty;

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
    public TypeSymbol ImportedBaseType
    {
        get => Definition != null && !ReferenceEquals(Definition, this)
            ? GetSubstitutedImportedBaseType()
            : Volatile.Read(ref importedBaseTypeStore);
    }

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
    /// Gets a value indicating whether this is a compiler-generated fixed-size
    /// buffer backing struct (ADR-0122 §10 / issue #1035). The emitter stamps
    /// such a struct with <c>[CompilerGenerated]</c> and <c>[UnsafeValueType]</c>
    /// and an explicit <c>ClassLayout</c> size of <c>N * sizeof(T)</c>.
    /// </summary>
    public bool IsFixedBufferBacking { get; private set; }

    /// <summary>Gets the fixed-size buffer element type for a fixed-buffer backing struct (ADR-0122 §10 / issue #1035), or <c>null</c>.</summary>
    public TypeSymbol FixedBufferElementType { get; private set; }

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
    /// Gets the explicit <c>init(...)</c> constructors visible on
    /// this symbol, looking through to the generic definition for a constructed
    /// (closed) generic type (issue #1087). A constructed <see cref="StructSymbol"/> produced
    /// by <see cref="CreateConstructed"/> does not carry its own explicit
    /// constructor table (those are populated on the open definition after the
    /// constructed shell already exists), so base-constructor resolution against
    /// a constructed generic base must consult the definition's table. The
    /// returned <see cref="ConstructorSymbol"/> instances are the definition's,
    /// which is exactly what the emitter keys its constructor handles by; use
    /// <see cref="GetConstructorParameterTypesForConstruction"/> to obtain the
    /// type-argument-substituted parameter signatures for overload matching.
    /// </summary>
    public ImmutableArray<ConstructorSymbol> EffectiveExplicitConstructors =>
        !ExplicitConstructors.IsDefaultOrEmpty || Definition == null
            ? ExplicitConstructors
            : Definition.ExplicitConstructors;

    /// <summary>
    /// Gets the user-declared <c>deinit { … }</c> destructor on this class
    /// (ADR-0068 / issue #698), or <c>null</c> when the class has none.
    /// Populated by the binder; consumed by the emitter to materialise the
    /// CLR <c>Finalize</c> override.
    /// </summary>
    public DeinitSymbol Deinitializer { get; private set; }

    /// <summary>
    /// Gets the enclosing user-defined type when this type is a nested type
    /// declaration (ADR-0110 / issue #910), or <c>null</c> when this is a
    /// top-level type. Populated by the binder; consumed by the emitter to
    /// emit a CLR nested <c>TypeDef</c> with the corresponding
    /// <c>NestedClass</c> row and nested accessibility.
    /// </summary>
    public TypeSymbol ContainingType { get; private set; }

    /// <summary>Sets <see cref="ContainingType"/> (ADR-0110 / issue #910). Intended to be called exactly once by the binder for a nested type declaration.</summary>
    /// <param name="containingType">The enclosing user-defined type.</param>
    public void SetContainingType(TypeSymbol containingType)
    {
        ContainingType = containingType;
    }

    /// <summary>Sets <see cref="ImportedBaseType"/> after binding (issue #296). Intended to be called exactly once by the binder for a class inheriting an imported CLR base.</summary>
    /// <param name="importedBaseType">The imported CLR base type symbol.</param>
    public void SetImportedBaseType(TypeSymbol importedBaseType)
    {
        Volatile.Write(ref importedBaseTypeStore, importedBaseType);
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
    /// Issue #973: sets <see cref="Fields"/> and
    /// <see cref="PrimaryConstructorParameters"/> after the symbol shell is
    /// declared. The binder declares every top-level struct/class name (with
    /// empty fields) up front so that field types may forward-reference a user
    /// type declared later in the same compilation, then binds each body and
    /// installs the resolved instance fields and primary-constructor parameters
    /// here. Intended to be called exactly once by the binder during
    /// <c>BindStructDeclaration</c>.
    /// </summary>
    /// <param name="fields">The bound instance field symbols in source order.</param>
    /// <param name="primaryConstructorParameters">The bound primary-constructor parameters, or empty when none were declared.</param>
    public void SetInstanceFieldsAndPrimaryConstructorParameters(
        ImmutableArray<FieldSymbol> fields,
        ImmutableArray<ParameterSymbol> primaryConstructorParameters)
    {
        Fields = fields;
        PrimaryConstructorParameters = primaryConstructorParameters;
    }

    /// <summary>
    /// Issue #949: sets <see cref="BaseClass"/> after the symbol is constructed.
    /// The symbol is created before its base-type clause is bound so that a
    /// class may reference itself as a generic type argument in its own base
    /// clause (e.g. <c>class Shape : IEquatable[Shape]</c>); the resolved base
    /// class is then installed here once the clause has been bound. Intended to
    /// be called exactly once by the binder during <c>BindStructDeclaration</c>.
    /// </summary>
    /// <param name="baseClass">The resolved base class symbol, or <c>null</c>.</param>
    public void SetBaseClass(StructSymbol baseClass)
    {
        Volatile.Write(ref baseClassStore, baseClass);
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

    /// <summary>Sets <see cref="ConstFields"/> after binding <c>const</c> field declarations (Issue #948).</summary>
    /// <param name="fields">The bound const field symbols owned by this type.</param>
    public void SetConstFields(ImmutableArray<FieldSymbol> fields)
    {
        ConstFields = fields;
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

    /// <summary>Sets <see cref="StaticInitializerStatements"/> after binding the type's <c>shared { init { … } }</c> block(s) (ADR-0140 / issue #2131).</summary>
    /// <param name="statements">The bound, lowered statements concatenated in source order.</param>
    public void SetStaticInitializerStatements(ImmutableArray<BoundStatement> statements)
    {
        StaticInitializerStatements = statements;
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

        // Issue #948: const fields are static for lookup purposes (accessed as
        // `Type.Name`), even though they are emitted as literal fields.
        if (!ConstFields.IsDefaultOrEmpty)
        {
            foreach (var f in ConstFields)
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

    /// <summary>Appends additional static methods after the initial declaration binding pass (issue #1017: user-defined conversion operators declared at top level).</summary>
    /// <param name="methods">The static methods to append.</param>
    public void AddStaticMethods(ImmutableArray<FunctionSymbol> methods)
    {
        if (methods.IsDefaultOrEmpty)
        {
            return;
        }

        StaticMethods = StaticMethods.IsDefaultOrEmpty ? methods : StaticMethods.AddRange(methods);
    }

    /// <summary>Sets <see cref="TypeParameters"/> on a generic definition (Phase 4.3 / ADR-0020). Intended to be called once by the binder during <c>BindStructDeclaration</c> before any constructed instance is materialized.</summary>
    /// <param name="typeParameters">The bound type parameters in declared order.</param>
    public void SetTypeParameters(ImmutableArray<TypeParameterSymbol> typeParameters)
    {
        TypeParameters = typeParameters;
    }

    /// <summary>
    /// Issue #1477: records the ordered original enclosing type parameters that
    /// this synthesized closure / capture-box class's fresh type parameters
    /// clone 1:1 (see <see cref="ReifiedFromTypeParameters"/>). Called once at
    /// synthesis time alongside <see cref="SetTypeParameters"/>.
    /// </summary>
    /// <param name="reifiedFrom">The original enclosing type parameters, aligned to <see cref="TypeParameters"/>.</param>
    public void SetReifiedFromTypeParameters(ImmutableArray<TypeParameterSymbol> reifiedFrom)
    {
        ReifiedFromTypeParameters = reifiedFrom;
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
    /// Issue #1921: returns true when this class is — or transitively
    /// derives from — <see cref="System.Attribute"/>, whether reached via
    /// the <c>@Attribute</c> declaration sugar (<see cref="IsAttributeClass"/>)
    /// or an explicit <c>: Attribute</c> / <c>: System.Attribute</c> base
    /// clause naming the imported CLR type. Same-compilation user classes
    /// have no <see cref="TypeSymbol.ClrType"/> until emitted, so a naive
    /// CLR base-chain walk on this type alone can't see it; this walks the
    /// symbol-level <see cref="BaseClass"/> chain instead, falling back to
    /// the CLR chain only once an <see cref="ImportedBaseType"/> is reached.
    /// </summary>
    /// <returns><c>true</c> when this class is or derives from <see cref="System.Attribute"/>.</returns>
    public bool DerivesFromSystemAttribute()
    {
        for (var current = this; current != null; current = current.BaseClass)
        {
            if (current.IsAttributeClass)
            {
                return true;
            }

            if (current.ImportedBaseType != null)
            {
                var clr = current.ImportedBaseType.ClrType;
                for (var t = clr; t != null; t = t.BaseType)
                {
                    if (t.FullName == typeof(System.Attribute).FullName)
                    {
                        return true;
                    }
                }

                return false;
            }
        }

        return false;
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

    /// <summary>Marks this struct as a fixed-size buffer backing struct (ADR-0122 §10 / issue #1035).</summary>
    /// <param name="elementType">The buffer element type <c>T</c>.</param>
    public void MarkFixedBufferBacking(TypeSymbol elementType)
    {
        IsFixedBufferBacking = true;
        FixedBufferElementType = elementType;
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
    /// Issue #987: enumerates the unimplemented abstract methods this class would
    /// inherit — i.e. every method in the effective member set (own + inherited,
    /// after override resolution) that is still <see cref="FunctionSymbol.IsAbstract"/>.
    /// A concrete (non-<c>open</c>) class with a non-empty result fails to satisfy
    /// its abstract base contract.
    /// <para>
    /// Issue #1055: when a base is inherited as a CONSTRUCTED generic (e.g.
    /// <c>Derived : Base[int32]</c>), an abstract base method whose signature uses
    /// the base's type parameters is satisfied by an override whose CONCRETE
    /// signature matches the substituted base signature. The substitution is
    /// composed across every hop of the inheritance chain so multi-level
    /// constructions (<c>Leaf : Mid[int32] : Base[T]</c>) resolve correctly.
    /// </para>
    /// </summary>
    /// <returns>The set of still-abstract effective methods; empty when none.</returns>
    public ImmutableArray<FunctionSymbol> GetUnimplementedAbstractMethods()
    {
        if (!IsClass)
        {
            return ImmutableArray<FunctionSymbol>.Empty;
        }

        // Capture each class along the chain (most-derived first) together with the
        // substitution that maps its declaration's type parameters onto the concrete
        // type arguments seen in THIS class's context. A deeper base's type arguments
        // are expressed in terms of a shallower base's type parameters, so resolving
        // each argument through the running map composes the substitution across hops.
        var levels = new List<(StructSymbol Cls, Dictionary<TypeParameterSymbol, TypeSymbol> Subst)>();
        Dictionary<TypeParameterSymbol, TypeSymbol> running = null;
        for (var c = this; c != null; c = c.BaseClass)
        {
            if (c.Definition != null
                && !c.TypeArguments.IsDefaultOrEmpty
                && !c.Definition.TypeParameters.IsDefaultOrEmpty)
            {
                var defParams = c.Definition.TypeParameters;
                var count = System.Math.Min(defParams.Length, c.TypeArguments.Length);
                for (var i = 0; i < count; i++)
                {
                    var arg = c.TypeArguments[i];
                    if (arg is TypeParameterSymbol tpArg && running != null && running.TryGetValue(tpArg, out var resolved))
                    {
                        arg = resolved;
                    }

                    running ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                    running[defParams[i]] = arg;
                }
            }

            levels.Add((c, running == null ? null : new Dictionary<TypeParameterSymbol, TypeSymbol>(running)));
        }

        ImmutableArray<FunctionSymbol>.Builder builder = null;
        for (var k = 0; k < levels.Count; k++)
        {
            var (cls, subst) = levels[k];
            if (cls.Methods.IsDefaultOrEmpty)
            {
                continue;
            }

            foreach (var abstractMethod in cls.Methods)
            {
                if (!abstractMethod.IsAbstract)
                {
                    continue;
                }

                // Implemented when a strictly more-derived class declares a
                // non-abstract method whose concrete signature matches the
                // abstract base method's signature after substitution.
                var implemented = false;
                for (var kk = 0; kk < k && !implemented; kk++)
                {
                    var derivedCls = levels[kk].Cls;
                    if (derivedCls.Methods.IsDefaultOrEmpty)
                    {
                        continue;
                    }

                    var candidateSubst = levels[kk].Subst;
                    foreach (var candidate in derivedCls.Methods)
                    {
                        if (candidate.IsAbstract)
                        {
                            continue;
                        }

                        if (AbstractMethodSatisfiedBy(abstractMethod, subst, candidate, candidateSubst))
                        {
                            implemented = true;
                            break;
                        }
                    }
                }

                if (!implemented)
                {
                    builder ??= ImmutableArray.CreateBuilder<FunctionSymbol>();
                    builder.Add(abstractMethod);
                }
            }
        }

        return builder == null ? ImmutableArray<FunctionSymbol>.Empty : builder.ToImmutable();
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
    /// <param name="mapClrType">
    /// Issue #1958: projects a host CLR <see cref="Type"/> into the reflection
    /// context (typically a <see cref="System.Reflection.MetadataLoadContext"/>) that a
    /// member's constructed generic CLR type was resolved from, mirroring
    /// <c>InterfaceSymbol.Construct</c>'s <c>mapClrType</c> (issue #1926 / PR #1956).
    /// Pass <see langword="null"/> (the default) for single-context callers.
    /// </param>
    /// <returns>A constructed <see cref="StructSymbol"/> whose <see cref="Definition"/> is the original.</returns>
    public static StructSymbol Construct(StructSymbol definition, ImmutableArray<TypeSymbol> typeArguments, Func<Type, Type> mapClrType = null)
    {
        if (definition == null || !definition.IsGenericDefinition)
        {
            return definition;
        }

        var key = BuildArgsKey(typeArguments);
        return ConstructedCache.GetOrAdd((definition, key), _ => CreateConstructed(definition, typeArguments, mapClrType));
    }

    /// <summary>
    /// Issue #1521: constructs a reference to a type declared as a nested type
    /// inside a <em>generic</em> enclosing type, closed over the enclosing
    /// construction's type arguments (e.g. <c>Box[int32].Tag</c>). The nested
    /// type has no own type parameters (the CLR models it as
    /// <c>Box`1+Tag`1</c>, redeclaring the encloser's parameters — ECMA-335
    /// §II.10.3.1); the enclosing arguments are recorded on
    /// <see cref="EnclosingTypeArguments"/> and the member types that mention an
    /// enclosing type parameter are substituted lazily (see
    /// <see cref="GetSubstitutionMap"/>). The emitter threads
    /// <see cref="EnclosingTypeArguments"/> as the nested type's type-argument
    /// vector so a constructed use site encodes <c>Box`1+Tag`1&lt;int32&gt;</c>
    /// instead of the open self-instantiation <c>Box`1+Tag`1&lt;!0&gt;</c>.
    /// </summary>
    /// <param name="nestedDefinition">The open nested-type definition (its <see cref="Definition"/> is used).</param>
    /// <param name="enclosingTypeArguments">The flattened enclosing construction arguments in CLR order (outermost first), aligned with <see cref="CollectEnclosingTypeParameters(TypeSymbol)"/>.</param>
    /// <param name="mapClrType">Issue #1958: see <see cref="Construct(StructSymbol, ImmutableArray{TypeSymbol}, Func{Type, Type})"/>.</param>
    /// <returns>A constructed nested reference, or <paramref name="nestedDefinition"/> unchanged when no enclosing arguments apply.</returns>
    public static StructSymbol ConstructNested(StructSymbol nestedDefinition, ImmutableArray<TypeSymbol> enclosingTypeArguments, Func<Type, Type> mapClrType = null)
    {
        if (nestedDefinition == null || enclosingTypeArguments.IsDefaultOrEmpty)
        {
            return nestedDefinition;
        }

        var def = nestedDefinition.Definition ?? nestedDefinition;
        var key = BuildArgsKey(enclosingTypeArguments);
        return ConstructedNestedCache.GetOrAdd((def, key), _ => CreateConstructedNested(def, enclosingTypeArguments, mapClrType));
    }

    /// <summary>
    /// Issue #1537: constructs a reference to a <em>generic</em> type declared
    /// as a nested type inside a <em>generic</em> enclosing type, closed over
    /// BOTH the enclosing construction's type arguments and the nested type's
    /// own type arguments (e.g. <c>Outer[int32].Middle[string]</c>). The nested
    /// type declares its own type parameters, so the CLR models it as
    /// <c>Outer`1+Middle`2</c> — redeclaring the encloser's parameters first,
    /// then its own (ECMA-335 §II.10.3.1). The enclosing arguments are recorded
    /// on <see cref="EnclosingTypeArguments"/> and the own arguments on
    /// <see cref="TypeArguments"/>; a member whose type mentions either an
    /// enclosing parameter (<c>U</c>) or the nested type's own parameter
    /// (<c>T</c>) is substituted through the combined map (see
    /// <see cref="GetSubstitutionMap"/>). The emitter threads the combined
    /// vector <c>[enclosing…, own…]</c> so a constructed use site encodes
    /// <c>Outer`1+Middle`2&lt;int32, string&gt;</c>.
    /// </summary>
    /// <param name="nestedDefinition">The open nested-type definition (its <see cref="Definition"/> is used).</param>
    /// <param name="enclosingTypeArguments">The flattened enclosing construction arguments in CLR order (outermost first), aligned with <see cref="CollectEnclosingTypeParameters(TypeSymbol)"/>. May be empty when the enclosing type is open but the nested type carries own arguments.</param>
    /// <param name="ownTypeArguments">The nested type's own type arguments.</param>
    /// <param name="mapClrType">Issue #1958: see <see cref="Construct(StructSymbol, ImmutableArray{TypeSymbol}, Func{Type, Type})"/>.</param>
    /// <returns>A constructed nested-generic reference, or <paramref name="nestedDefinition"/> unchanged when neither vector applies.</returns>
    public static StructSymbol ConstructNestedGeneric(
        StructSymbol nestedDefinition,
        ImmutableArray<TypeSymbol> enclosingTypeArguments,
        ImmutableArray<TypeSymbol> ownTypeArguments,
        Func<Type, Type> mapClrType = null)
    {
        if (nestedDefinition == null)
        {
            return nestedDefinition;
        }

        // No own arguments: fall back to the enclosing-only construction so the
        // two representations remain reference-equal and share one cache.
        if (ownTypeArguments.IsDefaultOrEmpty)
        {
            return ConstructNested(nestedDefinition, enclosingTypeArguments, mapClrType);
        }

        // No enclosing arguments to thread: this is an ordinary construction of
        // the nested type over its own parameters (e.g. `Middle[string]`
        // referenced from within the enclosing generic's own members, where the
        // enclosing parameters stay open). Route through Construct so the own
        // arguments substitute exactly as for a top-level generic.
        if (enclosingTypeArguments.IsDefaultOrEmpty)
        {
            return Construct(nestedDefinition.Definition ?? nestedDefinition, ownTypeArguments, mapClrType);
        }

        var def = nestedDefinition.Definition ?? nestedDefinition;
        var enclosingKey = BuildArgsKey(enclosingTypeArguments);
        var ownKey = BuildArgsKey(ownTypeArguments);
        return ConstructedNestedGenericCache.GetOrAdd(
            (def, enclosingKey, ownKey),
            _ => CreateConstructedNestedGeneric(def, enclosingTypeArguments, ownTypeArguments, mapClrType));
    }

    /// <summary>
    /// Issue #1521: gathers the flattened generic parameters of every enclosing
    /// type of <paramref name="nested"/>, in CLR order (outermost first). A type
    /// nested inside <c>Outer[U].Inner[T]</c> sees <c>[U, T]</c>. Mirrors the
    /// emitter's reification order so a nested type's
    /// <see cref="EnclosingTypeArguments"/> line up 1:1 with the enclosing
    /// parameters its <c>TypeDef</c> is reified over.
    /// </summary>
    /// <param name="nested">The nested type (definition or constructed reference).</param>
    /// <returns>The flattened enclosing type parameters, or empty when not nested in a generic.</returns>
    public static ImmutableArray<TypeParameterSymbol> CollectEnclosingTypeParameters(TypeSymbol nested)
    {
        List<ImmutableArray<TypeParameterSymbol>> levels = null;
        for (var c = EnclosingTypeOf(nested); c != null; c = EnclosingTypeOf(c))
        {
            var tps = EnclosingTypeParametersOf(c);
            if (!tps.IsDefaultOrEmpty)
            {
                levels ??= new List<ImmutableArray<TypeParameterSymbol>>();

                // Prepend so the outermost enclosing type's parameters come first.
                levels.Insert(0, tps);
            }
        }

        if (levels == null)
        {
            return ImmutableArray<TypeParameterSymbol>.Empty;
        }

        var builder = ImmutableArray.CreateBuilder<TypeParameterSymbol>();
        foreach (var level in levels)
        {
            builder.AddRange(level);
        }

        return builder.ToImmutable();
    }

    /// <summary>
    /// Walks this type and its base-class chain looking for a constructed
    /// generic ancestor whose definition satisfies
    /// <paramref name="declaringDefinitionPredicate"/>, composing the
    /// type-argument substitution across each inheritance hop so the returned
    /// symbol carries fully-resolved type arguments in this type's context.
    /// </summary>
    /// <remarks>
    /// A deeper base's type arguments are expressed in terms of a shallower
    /// base's type parameters (e.g. for <c>Derived : Mid[int32] : Base[T]</c>
    /// the <c>Base</c> instantiation is written <c>Base[Mid.T]</c>), so each
    /// argument is resolved through the running substitution accumulated from
    /// the more-derived levels. Looking up <c>Base</c> therefore yields the
    /// fully-closed <c>Base[int32]</c>. Returns <see langword="null"/> when no
    /// matching generic base exists. The walk includes the receiver itself.
    /// </remarks>
    /// <param name="declaringDefinitionPredicate">Predicate matched against each ancestor's definition (or itself when non-generic).</param>
    /// <returns>The constructed generic base instantiation, or null.</returns>
    public StructSymbol FindConstructedGenericBase(Func<StructSymbol, bool> declaringDefinitionPredicate)
    {
        if (declaringDefinitionPredicate == null)
        {
            return null;
        }

        Dictionary<TypeParameterSymbol, TypeSymbol> running = null;
        for (var c = this; c != null; c = c.BaseClass)
        {
            // Issue #1521: a constructed reference to a type nested inside a
            // generic enclosing type (`Box[int32].Tag`) already carries the
            // enclosing arguments on EnclosingTypeArguments and declares no own
            // type arguments to compose. When such a receiver directly declares
            // the sought member, return it verbatim so the field/method
            // reference is parented at its own `Box`1+Tag`1<int32>` TypeSpec
            // rather than a rebuilt open self-instantiation.
            if (c.IsConstructedNestedType && declaringDefinitionPredicate(c.Definition ?? c))
            {
                return c;
            }

            // Compose this level's type-argument mapping into the running
            // substitution before testing the predicate so a matching base's
            // arguments are already resolved in this type's context.
            var cDef = c.Definition ?? c;
            if (c.Definition != null
                && !c.TypeArguments.IsDefaultOrEmpty
                && !c.Definition.TypeParameters.IsDefaultOrEmpty)
            {
                var defParams = c.Definition.TypeParameters;
                var count = System.Math.Min(defParams.Length, c.TypeArguments.Length);
                for (var i = 0; i < count; i++)
                {
                    var arg = c.TypeArguments[i];
                    if (arg is TypeParameterSymbol tpArg && running != null && running.TryGetValue(tpArg, out var resolved))
                    {
                        arg = resolved;
                    }

                    running ??= new Dictionary<TypeParameterSymbol, TypeSymbol>();
                    running[defParams[i]] = arg;
                }
            }

            if (cDef.TypeParameters.IsDefaultOrEmpty || !declaringDefinitionPredicate(cDef))
            {
                continue;
            }

            var tps = cDef.TypeParameters;
            var args = ImmutableArray.CreateBuilder<TypeSymbol>(tps.Length);
            foreach (var tp in tps)
            {
                if (running != null && running.TryGetValue(tp, out var concrete))
                {
                    args.Add(concrete);
                }
                else
                {
                    args.Add(tp);
                }
            }

            return Construct(cDef, args.MoveToImmutable());
        }

        return null;
    }

    /// <summary>
    /// Issue #1087: gets the parameter types of <paramref name="constructor"/>
    /// as observed on this (possibly constructed) symbol. For a constructed
    /// closed generic type, the open-definition constructor's parameter types
    /// have this symbol's type arguments substituted for the definition's type
    /// parameters (e.g. <c>init(a T)</c> on <c>Base[T]</c> surfaces as
    /// <c>init(a int32)</c> on <c>Base[int32]</c>); for a non-generic or open
    /// symbol the declared parameter types are returned unchanged.
    /// </summary>
    /// <param name="constructor">A constructor drawn from <see cref="EffectiveExplicitConstructors"/>.</param>
    /// <returns>The (substituted, when constructed) parameter types in declaration order.</returns>
    public ImmutableArray<TypeSymbol> GetConstructorParameterTypesForConstruction(ConstructorSymbol constructor)
    {
        var parameters = constructor.Parameters;
        if (Definition == null
            || TypeArguments.IsDefaultOrEmpty
            || Definition.TypeParameters.IsDefaultOrEmpty
            || parameters.IsDefaultOrEmpty)
        {
            var asTypes = ImmutableArray.CreateBuilder<TypeSymbol>(parameters.IsDefaultOrEmpty ? 0 : parameters.Length);
            if (!parameters.IsDefaultOrEmpty)
            {
                foreach (var p in parameters)
                {
                    asTypes.Add(p.Type);
                }
            }

            return asTypes.ToImmutable();
        }

        var subst = new Dictionary<TypeParameterSymbol, TypeSymbol>(Definition.TypeParameters.Length);
        for (var i = 0; i < Definition.TypeParameters.Length && i < TypeArguments.Length; i++)
        {
            subst[Definition.TypeParameters[i]] = TypeArguments[i];
        }

        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(parameters.Length);
        foreach (var p in parameters)
        {
            builder.Add(SubstituteTypeForConstruction(p.Type, subst, mapClrType));
        }

        return builder.MoveToImmutable();
    }

    /// <summary>
    /// Issue #1499: applies a type-parameter <paramref name="substitution"/> to
    /// <paramref name="type"/>, recursively rewriting the generic arguments of
    /// any constructed generic (struct / interface / imported CLR) type and the
    /// element / underlying / function-signature types it contains. Shares the
    /// same traversal used when constructing a generic instantiation, so it is
    /// the canonical way for the symbol layer to remap a constraint reference
    /// type (e.g. <c>IComparable[T]</c> → <c>IComparable[clone]</c>) onto a
    /// cloned type-parameter set. Returns the original instance unchanged when
    /// the substitution touches nothing.
    /// </summary>
    /// <param name="type">The type whose type-parameter references to remap.</param>
    /// <param name="substitution">The original → replacement type-parameter map.</param>
    /// <returns>The substituted type, or <paramref name="type"/> when unchanged.</returns>
    internal static TypeSymbol SubstituteTypeParameters(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        if (type == null || substitution == null || substitution.Count == 0)
        {
            return type;
        }

        return SubstituteTypeForConstruction(type, substitution);
    }

    /// <summary>
    /// ADR-0105 Phase 2 — re-points this (reused) struct symbol at the
    /// declaration node of a freshly-parsed syntax tree whose declaration is
    /// byte-identical to the previous one (a body-only edit). Only the backing
    /// syntax — and therefore source spans — changes; the symbol's identity is
    /// preserved so cross-compilation reuse stays sound. Intended to be called
    /// only by <see cref="Binding.IncrementalGlobalScopeReuse"/>.
    /// </summary>
    /// <param name="declaration">The corresponding declaration in the re-parsed tree.</param>
    internal void RepointDeclaration(StructDeclarationSyntax declaration)
    {
        Declaration = declaration;
    }

    /// <summary>
    /// Issue #1521: threads a type substitution through the enclosing
    /// construction of a reference to a type nested inside a generic enclosing
    /// type. For an open nested reference (<c>Box.Tag</c>) the starting vector is
    /// the flattened enclosing type parameters; for an already-constructed
    /// nested reference (<c>Box[T].Tag</c>) it is the recorded
    /// <see cref="EnclosingTypeArguments"/>. Each element is mapped through
    /// <paramref name="substituteOne"/>. Returns the new enclosing-argument
    /// vector when at least one element changed, or <c>default</c> when
    /// <paramref name="nested"/> is not nested in a generic or nothing changed.
    /// </summary>
    /// <param name="nested">The nested-type reference (definition or constructed).</param>
    /// <param name="substituteOne">Substitution applied to each enclosing argument (the caller's recursion).</param>
    /// <returns>The substituted enclosing-argument vector, or <c>default</c>.</returns>
    internal static ImmutableArray<TypeSymbol> SubstituteEnclosingArguments(StructSymbol nested, Func<TypeSymbol, TypeSymbol> substituteOne)
    {
        if (nested == null || !nested.TypeArguments.IsDefaultOrEmpty)
        {
            return default;
        }

        var enclosingParams = CollectEnclosingTypeParameters(nested);
        if (enclosingParams.IsDefaultOrEmpty)
        {
            return default;
        }

        var current = nested.IsConstructedNestedType
            ? nested.EnclosingTypeArguments
            : ImmutableArray.CreateRange(enclosingParams, static p => (TypeSymbol)p);

        var builder = ImmutableArray.CreateBuilder<TypeSymbol>(current.Length);
        var changed = false;
        foreach (var arg in current)
        {
            var substituted = substituteOne(arg);
            changed |= !ReferenceEquals(substituted, arg);
            builder.Add(substituted);
        }

        return changed ? builder.MoveToImmutable() : default;
    }

    /// <summary>
    /// Removes all entries from the static constructed-struct caches.
    /// Called by <see cref="ReferenceResolver.Dispose"/> to release stale
    /// <see cref="Type"/> objects and definition/argument symbols backed by
    /// a disposed metadata load context that would otherwise pin the
    /// context's memory indefinitely.
    /// </summary>
    internal static void ClearCache()
    {
        ConstructedCache.Clear();
        ConstructedNestedCache.Clear();
        ConstructedNestedGenericCache.Clear();
    }

    /// <summary>
    /// Substitutes this constructed type's arguments through a member type
    /// declared on its generic definition.
    /// </summary>
    /// <param name="type">The open member type to close.</param>
    /// <returns>The member type in this construction's context.</returns>
    internal TypeSymbol SubstituteMemberType(TypeSymbol type)
    {
        if (type == null || Definition == null || ReferenceEquals(Definition, this))
        {
            return type;
        }

        return SubstituteTypeForConstruction(type, GetSubstitutionMap(), mapClrType);
    }

    private static TypeArgsKey BuildArgsKey(ImmutableArray<TypeSymbol> typeArguments) => new(typeArguments);

    private static TypeSymbol EnclosingTypeOf(TypeSymbol type) => type switch
    {
        StructSymbol s => s.ContainingType,
        InterfaceSymbol i => i.ContainingType,
        EnumSymbol e => e.ContainingType,
        _ => null,
    };

    private static ImmutableArray<TypeParameterSymbol> EnclosingTypeParametersOf(TypeSymbol type) => type switch
    {
        StructSymbol s => (s.Definition ?? s).TypeParameters,
        InterfaceSymbol i => (i.Definition ?? i).TypeParameters,
        _ => ImmutableArray<TypeParameterSymbol>.Empty,
    };

    private static StructSymbol CreateConstructed(StructSymbol definition, ImmutableArray<TypeSymbol> typeArguments, Func<Type, Type> mapClrType)
    {
        var subst = new Dictionary<TypeParameterSymbol, TypeSymbol>(definition.TypeParameters.Length);
        for (var i = 0; i < definition.TypeParameters.Length; i++)
        {
            subst[definition.TypeParameters[i]] = typeArguments[i];
        }

        var substitutedFields = ImmutableArray.CreateBuilder<FieldSymbol>(definition.Fields.Length);
        foreach (var f in definition.Fields)
        {
            substitutedFields.Add(new FieldSymbol(f.Name, SubstituteTypeForConstruction(f.Type, subst, mapClrType), f.Accessibility));
        }

        var substitutedPrimary = ImmutableArray<ParameterSymbol>.Empty;
        if (!definition.PrimaryConstructorParameters.IsDefaultOrEmpty)
        {
            var b = ImmutableArray.CreateBuilder<ParameterSymbol>(definition.PrimaryConstructorParameters.Length);
            foreach (var p in definition.PrimaryConstructorParameters)
            {
                b.Add(new ParameterSymbol(p.Name, SubstituteTypeForConstruction(p.Type, subst, mapClrType), isVariadic: p.IsVariadic, isScoped: p.IsScoped));
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
        constructed.mapClrType = mapClrType;

        // Issue #1341: Methods and the static-member tables below are
        // generically erased (ADR-0004) and shared with the definition by
        // identity (no per-construction substitution). They are NOT snapshotted
        // here: the constructed instance forwards their reads to Definition so
        // member lookup observes the definition's members even when this
        // construction is materialized (and cached) before the definition's
        // body has been bound — making lookup independent of source-file order.
        //
        // Issue #1209: a constructed generic class/struct must surface the open
        // definition's static members so a qualified static reference on the
        // construction (`Box[int32].Default`, `Box[int32].Make()`) resolves the
        // same way as on the definition. G# erases generic type parameters to
        // System.Object at emit (ADR-0004), so the static members live on the
        // single erased type and can be shared with the definition by symbol
        // identity (no per-construction substitution at emit). The constructed
        // symbol is still carried as the owner of the bound access so member
        // resolution and diagnostics see the closed type.

        // Issue #989 / #1341: a generic auto-property (or computed property)
        // whose type mentions the class type parameter must resolve on a
        // constructed instance with `T` substituted — exactly like instance
        // fields. The property tables are NOT snapshotted here: the constructed
        // instance substitutes them lazily from the definition (see
        // GetSubstitutedProperties) so a property bound after this construction
        // is materialized is still observed. Accessor FunctionSymbols and
        // backing fields are shared with the open definition (only the
        // definition is emitted; the external accessor call is parented at the
        // constructed TypeSpec by the emitter, and inside-the-type access lowers
        // against the definition).
        return constructed;
    }

    // Issue #1521: materializes a constructed reference to a type nested inside
    // a generic enclosing type (`Box[int32].Tag`). Unlike CreateConstructed the
    // nested type declares no own type parameters — its member types mention the
    // ENCLOSING type's parameters — so the substitution map is keyed by the
    // flattened enclosing parameters (see GetSubstitutionMap) rather than the
    // nested type's own (empty) parameters. Instance-member reads forward to the
    // definition and substitute lazily against that map, so a field/property/
    // return of the nested type whose type is an enclosing parameter surfaces
    // closed (e.g. `Tag.V : int32` on `Box[int32].Tag`).
    private static StructSymbol CreateConstructedNested(StructSymbol definition, ImmutableArray<TypeSymbol> enclosingTypeArguments, Func<Type, Type> mapClrType)
    {
        var constructed = new StructSymbol(
            definition.Name,
            definition.Fields,
            definition.Accessibility,
            definition.Declaration,
            definition.PackageName,
            definition.IsData,
            definition.IsInline,
            definition.IsClass,
            definition.PrimaryConstructorParameters,
            definition.IsOpen,
            definition.BaseClass);

        constructed.Definition = definition;
        constructed.EnclosingTypeArguments = enclosingTypeArguments;
        constructed.mapClrType = mapClrType;
        constructed.ContainingType = definition.ContainingType;
        return constructed;
    }

    // Issue #1537: materializes a constructed reference to a GENERIC type nested
    // inside a generic enclosing type (`Outer[int32].Middle[string]`). Combines
    // the treatment of CreateConstructed (own type arguments) and
    // CreateConstructedNested (enclosing type arguments): the nested type
    // declares its own parameters AND its members may mention the enclosing
    // type's parameters, so the substitution map (GetSubstitutionMap) is keyed
    // by BOTH the nested type's own parameters (-> own arguments) and the
    // flattened enclosing parameters (-> enclosing arguments). Instance-member
    // reads forward to the definition and substitute lazily against that map, so
    // a field/return typed as either an own parameter (`Middle.Label : T`) or an
    // enclosing parameter (`Middle.Owner : U`) surfaces closed.
    private static StructSymbol CreateConstructedNestedGeneric(
        StructSymbol definition,
        ImmutableArray<TypeSymbol> enclosingTypeArguments,
        ImmutableArray<TypeSymbol> ownTypeArguments,
        Func<Type, Type> mapClrType)
    {
        var constructed = new StructSymbol(
            definition.Name,
            definition.Fields,
            definition.Accessibility,
            definition.Declaration,
            definition.PackageName,
            definition.IsData,
            definition.IsInline,
            definition.IsClass,
            definition.PrimaryConstructorParameters,
            definition.IsOpen,
            definition.BaseClass);

        constructed.Definition = definition;
        constructed.TypeArguments = ownTypeArguments;
        constructed.EnclosingTypeArguments = enclosingTypeArguments;
        constructed.mapClrType = mapClrType;

        // Capture the nested type's own type parameters BEFORE the emitter
        // re-ordinalizes the nested TypeDef over the flattened enclosing+own
        // list (RegisterNestedTypeEnclosingGenerics), so the substitution map's
        // own-argument half keeps pairing each original own parameter with its
        // argument no matter when it is first computed.
        constructed.nestedOwnTypeParameters = definition.TypeParameters;
        constructed.ContainingType = definition.ContainingType;
        return constructed;
    }

    // Issue #1341: builds (once) the type-parameter -> type-argument map used to
    // substitute the definition's instance-member types for this constructed
    // instance. Generic definitions are immutable in their type parameters and
    // a construction's type arguments are fixed, so the map is cached.
    private Dictionary<TypeParameterSymbol, TypeSymbol> GetSubstitutionMap()
    {
        var existing = Volatile.Read(ref substitutionMap);
        if (existing != null)
        {
            return existing;
        }

        var def = Definition;
        var map = new Dictionary<TypeParameterSymbol, TypeSymbol>(
            def.TypeParameters.IsDefaultOrEmpty ? 0 : def.TypeParameters.Length);

        // Issue #1537: for a constructed nested-generic reference the emitter
        // re-ordinalizes the definition's TypeParameters over the flattened
        // enclosing+own list, so use the own parameters captured at construction
        // time to pair with TypeArguments. For every other constructed instance
        // the definition's TypeParameters are the own parameters.
        var ownParams = !nestedOwnTypeParameters.IsDefaultOrEmpty ? nestedOwnTypeParameters : def.TypeParameters;
        if (!ownParams.IsDefaultOrEmpty && !TypeArguments.IsDefaultOrEmpty)
        {
            var count = System.Math.Min(ownParams.Length, TypeArguments.Length);
            for (var i = 0; i < count; i++)
            {
                map[ownParams[i]] = TypeArguments[i];
            }
        }

        // Issue #1521: a constructed reference to a type nested inside a generic
        // enclosing type carries the enclosing construction's arguments on
        // EnclosingTypeArguments and declares no own type parameters. Its member
        // types mention the ENCLOSING type's parameters, so key the substitution
        // by the flattened enclosing parameters (outermost first) so a member
        // typed as an enclosing parameter (`Tag.V : T`) surfaces closed
        // (`int32`) on the construction (`Box[int32].Tag`).
        if (!EnclosingTypeArguments.IsDefaultOrEmpty)
        {
            var enclosingParams = CollectEnclosingTypeParameters(this);
            var count = System.Math.Min(enclosingParams.Length, EnclosingTypeArguments.Length);
            for (var i = 0; i < count; i++)
            {
                map[enclosingParams[i]] = EnclosingTypeArguments[i];
            }
        }

        return Interlocked.CompareExchange(ref substitutionMap, map, null) ?? map;
    }

    private StructSymbol GetSubstitutedBaseClass()
    {
        var source = Definition.BaseClass;
        var snapshot = Volatile.Read(ref substitutedBaseClass);
        if (snapshot != null && ReferenceEquals(snapshot.Source, source))
        {
            return snapshot.Value;
        }

        var value = source == null
            ? null
            : SubstituteTypeForConstruction(source, GetSubstitutionMap(), mapClrType) as StructSymbol;
        Volatile.Write(ref substitutedBaseClass, new BaseClassSnapshot(source, value));
        return value;
    }

    private ImmutableArray<ParameterSymbol> GetSubstitutedPrimaryConstructorParameters()
    {
        var source = Definition.PrimaryConstructorParameters;
        var snapshot = Volatile.Read(ref substitutedPrimaryConstructorParameters);
        if (snapshot != null && snapshot.Source.Equals(source))
        {
            return snapshot.Value;
        }

        ImmutableArray<ParameterSymbol> value;
        if (source.IsDefaultOrEmpty)
        {
            value = source;
        }
        else
        {
            var builder = ImmutableArray.CreateBuilder<ParameterSymbol>(source.Length);
            foreach (var parameter in source)
            {
                builder.Add(new ParameterSymbol(
                    parameter.Name,
                    SubstituteTypeForConstruction(parameter.Type, GetSubstitutionMap(), mapClrType),
                    isVariadic: parameter.IsVariadic,
                    isScoped: parameter.IsScoped,
                    refKind: parameter.RefKind));
            }

            value = builder.MoveToImmutable();
        }

        Volatile.Write(
            ref substitutedPrimaryConstructorParameters,
            new ParameterArraySnapshot(source, value));
        return value;
    }

    private ImmutableArray<InterfaceSymbol> GetSubstitutedInterfaces()
    {
        var source = Definition.Interfaces;
        var snapshot = Volatile.Read(ref substitutedInterfaces);
        if (snapshot != null && snapshot.Source.Equals(source))
        {
            return snapshot.Value;
        }

        ImmutableArray<InterfaceSymbol> value;
        if (source.IsDefaultOrEmpty)
        {
            value = source;
        }
        else
        {
            var builder = ImmutableArray.CreateBuilder<InterfaceSymbol>(source.Length);
            foreach (var iface in source)
            {
                builder.Add((InterfaceSymbol)SubstituteTypeForConstruction(
                    iface,
                    GetSubstitutionMap(),
                    mapClrType));
            }

            value = builder.MoveToImmutable();
        }

        Volatile.Write(ref substitutedInterfaces, new InterfaceArraySnapshot(source, value));
        return value;
    }

    private ImmutableArray<TypeSymbol> GetSubstitutedImplementedClrInterfaces()
    {
        var source = Definition.ImplementedClrInterfaces;
        var snapshot = Volatile.Read(ref substitutedImplementedClrInterfaces);
        if (snapshot != null && snapshot.Source.Equals(source))
        {
            return snapshot.Value;
        }

        ImmutableArray<TypeSymbol> value;
        if (source.IsDefaultOrEmpty)
        {
            value = source;
        }
        else
        {
            var builder = ImmutableArray.CreateBuilder<TypeSymbol>(source.Length);
            foreach (var iface in source)
            {
                builder.Add(SubstituteTypeForConstruction(iface, GetSubstitutionMap(), mapClrType));
            }

            value = builder.MoveToImmutable();
        }

        Volatile.Write(
            ref substitutedImplementedClrInterfaces,
            new TypeArraySnapshot(source, value));
        return value;
    }

    private TypeSymbol GetSubstitutedImportedBaseType()
    {
        var source = Definition.ImportedBaseType;
        var snapshot = Volatile.Read(ref substitutedImportedBaseType);
        if (snapshot != null && ReferenceEquals(snapshot.Source, source))
        {
            return snapshot.Value;
        }

        var value = SubstituteTypeForConstruction(source, GetSubstitutionMap(), mapClrType);
        Volatile.Write(ref substitutedImportedBaseType, new TypeSnapshot(source, value));
        return value;
    }

    // Issue #1341: lazily substitutes the definition's instance fields for this
    // constructed instance, memoized against the definition's current field
    // array. The array is replaced (by reference) exactly when the definition's
    // body is bound, so reading after that point recomputes the substitution —
    // making member lookup independent of the order the definition is bound.
    private ImmutableArray<FieldSymbol> GetSubstitutedFields()
    {
        var source = Definition.Fields;
        if (substitutedFieldsComputed && substitutedFieldsSource.Equals(source))
        {
            return substitutedFields;
        }

        var subst = GetSubstitutionMap();
        ImmutableArray<FieldSymbol> result;
        if (source.IsDefaultOrEmpty || subst.Count == 0)
        {
            result = source;
        }
        else
        {
            var builder = ImmutableArray.CreateBuilder<FieldSymbol>(source.Length);
            foreach (var f in source)
            {
                var newType = SubstituteTypeForConstruction(f.Type, subst, mapClrType);
                if (ReferenceEquals(newType, f.Type))
                {
                    builder.Add(f);
                    continue;
                }

                var substituted = new FieldSymbol(
                    f.Name,
                    newType,
                    f.Accessibility,
                    f.IsReadOnly,
                    f.IsStatic,
                    f.IsConst,
                    f.IsEventBackingField);
                if (f.IsConst)
                {
                    substituted.SetConstantValue(f.ConstantValue);
                }

                if (f.ExplicitOffset is int offset)
                {
                    substituted.SetExplicitOffset(offset);
                }

                if (f.IsFixedBuffer)
                {
                    substituted.SetFixedBuffer(
                        SubstituteTypeForConstruction(f.FixedBufferElementType, subst, mapClrType),
                        f.FixedBufferLength);
                }

                builder.Add(substituted);
            }

            result = builder.MoveToImmutable();
        }

        substitutedFields = result;
        substitutedFieldsSource = source;
        substitutedFieldsComputed = true;
        return result;
    }

    // Issue #1341: lazily substitutes the definition's instance properties for
    // this constructed instance, memoized against the definition's current
    // property array (see GetSubstitutedFields for the ordering rationale).
    private ImmutableArray<PropertySymbol> GetSubstitutedProperties()
    {
        var source = Definition.Properties;
        if (substitutedPropertiesComputed && substitutedPropertiesSource.Equals(source))
        {
            return substitutedProperties;
        }

        var result = SubstituteProperties(source, GetSubstitutionMap(), mapClrType);
        substitutedProperties = result;
        substitutedPropertiesSource = source;
        substitutedPropertiesComputed = true;
        return result;
    }

    // Issue #1341: lazily substitutes the definition's static properties for this
    // constructed instance, memoized against the definition's current static
    // property array (see GetSubstitutedFields for the ordering rationale).
    private ImmutableArray<PropertySymbol> GetSubstitutedStaticProperties()
    {
        var source = Definition.StaticProperties;
        if (substitutedStaticPropertiesComputed && substitutedStaticPropertiesSource.Equals(source))
        {
            return substitutedStaticProperties;
        }

        var result = SubstituteProperties(source, GetSubstitutionMap(), mapClrType);
        substitutedStaticProperties = result;
        substitutedStaticPropertiesSource = source;
        substitutedStaticPropertiesComputed = true;
        return result;
    }

    private static ImmutableArray<PropertySymbol> SubstituteProperties(
        ImmutableArray<PropertySymbol> properties,
        Dictionary<TypeParameterSymbol, TypeSymbol> subst,
        Func<Type, Type> mapClrType)
    {
        if (properties.IsDefaultOrEmpty)
        {
            return properties;
        }

        var builder = ImmutableArray.CreateBuilder<PropertySymbol>(properties.Length);
        foreach (var p in properties)
        {
            var newType = SubstituteTypeForConstruction(p.Type, subst, mapClrType);

            var newParams = p.Parameters;
            var paramsChanged = false;
            if (!p.Parameters.IsDefaultOrEmpty)
            {
                var pb = ImmutableArray.CreateBuilder<ParameterSymbol>(p.Parameters.Length);
                foreach (var par in p.Parameters)
                {
                    var st = SubstituteTypeForConstruction(par.Type, subst, mapClrType);
                    paramsChanged |= !ReferenceEquals(st, par.Type);
                    pb.Add(new ParameterSymbol(par.Name, st, isVariadic: par.IsVariadic, isScoped: par.IsScoped));
                }

                if (paramsChanged)
                {
                    newParams = pb.MoveToImmutable();
                }
            }

            if (ReferenceEquals(newType, p.Type) && !paramsChanged)
            {
                builder.Add(p);
                continue;
            }

            var substituted = new PropertySymbol(
                p.Name,
                newType,
                p.Accessibility,
                p.HasGetter,
                p.HasSetter,
                p.IsAutoProperty,
                p.IsVirtual,
                p.IsOverride,
                p.SetterParameterName,
                p.IsStatic,
                p.Declaration,
                p.IsInitOnly,
                p.GetterAccessibility,
                p.SetterAccessibility)
            {
                IsIndexer = p.IsIndexer,
                Parameters = newParams,
                BackingField = p.BackingField,
                GetterSymbol = p.GetterSymbol,
                SetterSymbol = p.SetterSymbol,
                GetterBodySyntax = p.GetterBodySyntax,
                SetterBodySyntax = p.SetterBodySyntax,
            };
            builder.Add(substituted);
        }

        return builder.MoveToImmutable();
    }

    /// <summary>
    /// Issue #1055: decides whether <paramref name="candidate"/> (a more-derived,
    /// non-abstract method) implements <paramref name="abstractMethod"/> once the
    /// abstract method's signature is substituted with <paramref name="subst"/>
    /// (the constructed-base type arguments). Compares name, arity, parameter
    /// count, ref-kinds and parameter types — mirroring CLR override matching.
    /// </summary>
    private static bool AbstractMethodSatisfiedBy(
        FunctionSymbol abstractMethod,
        Dictionary<TypeParameterSymbol, TypeSymbol> subst,
        FunctionSymbol candidate,
        Dictionary<TypeParameterSymbol, TypeSymbol> candidateSubst)
    {
        if (!string.Equals(abstractMethod.Name, candidate.Name, System.StringComparison.Ordinal))
        {
            return false;
        }

        var baseParams = CallableParametersOf(abstractMethod);
        var derivedParams = CallableParametersOf(candidate);
        if (baseParams.Length != derivedParams.Length)
        {
            return false;
        }

        var baseArity = abstractMethod.TypeParameters.IsDefaultOrEmpty ? 0 : abstractMethod.TypeParameters.Length;
        var derivedArity = candidate.TypeParameters.IsDefaultOrEmpty ? 0 : candidate.TypeParameters.Length;
        if (baseArity != derivedArity)
        {
            return false;
        }

        // Issue #1931: a generic abstract method's own type parameter(s) (e.g.
        // `open func Show[T](value T?)`) are distinct TypeParameterSymbol
        // instances from the overriding method's own `[T]` — even though `subst`
        // (the enclosing class's constructed-base substitution) already maps the
        // CLASS-level type parameters, it knows nothing about these METHOD-level
        // ones. Extend a copy of `subst` positionally so `T` in the abstract
        // signature substitutes to the override's `T`, letting `T?` compare equal
        // instead of every generic-method override looking unimplemented.
        if (baseArity > 0)
        {
            var methodSubst = subst == null
                ? new Dictionary<TypeParameterSymbol, TypeSymbol>()
                : new Dictionary<TypeParameterSymbol, TypeSymbol>(subst);
            for (var i = 0; i < baseArity; i++)
            {
                methodSubst[abstractMethod.TypeParameters[i]] = candidate.TypeParameters[i];
            }

            subst = methodSubst;
        }

        for (var i = 0; i < baseParams.Length; i++)
        {
            if (baseParams[i].RefKind != derivedParams[i].RefKind)
            {
                return false;
            }

            var baseType = subst != null
                ? SubstituteTypeForConstruction(baseParams[i].Type, subst)
                : baseParams[i].Type;

            // Issue #1244: the override is declared on a (possibly still-generic)
            // derived class whose own type parameters are distinct symbols from the
            // base's — even when same-named. Substitute the candidate's parameter
            // types with the derived level's construction map so a signature using
            // the derived class type parameter (e.g. Der[T].Handle(T)) unifies with
            // the substituted abstract signature (Base[T].Handle(T) -> Handle(int32)).
            var derivedType = candidateSubst != null
                ? SubstituteTypeForConstruction(derivedParams[i].Type, candidateSubst)
                : derivedParams[i].Type;

            if (!DeclarationBinder.TypeSignaturesEquivalent(baseType, derivedType))
            {
                return false;
            }
        }

        return true;
    }

    private static ImmutableArray<ParameterSymbol> CallableParametersOf(FunctionSymbol method)
        => method.ExplicitReceiverParameter == null ? method.Parameters : method.Parameters.RemoveAt(0);

    private static TypeSymbol SubstituteTypeForConstruction(TypeSymbol type, Dictionary<TypeParameterSymbol, TypeSymbol> subst, Func<Type, Type> mapClrType = null)
    {
        if (type is TypeParameterSymbol tp)
        {
            return subst.TryGetValue(tp, out var concrete) ? concrete : type;
        }

        // Issue #1250: a member type that is itself a constructed generic G#
        // user class (e.g. a field/property/primary-ctor parameter typed
        // `Holder[T]` on `Box[T]`) must have its own type arguments substituted
        // so it surfaces as `Holder[int32]` on `Box[int32]`. Recurses so nested
        // generics (`Holder[Holder[T]]`, `Dictionary[K, List[V]]`) work too.
        if (type is StructSymbol ss
            && ss.Definition != null
            && !ReferenceEquals(ss.Definition, ss)
            && !ss.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedStructArgs = ImmutableArray.CreateBuilder<TypeSymbol>(ss.TypeArguments.Length);
            var structChanged = false;
            for (var i = 0; i < ss.TypeArguments.Length; i++)
            {
                var substituted = SubstituteTypeForConstruction(ss.TypeArguments[i], subst, mapClrType);
                substitutedStructArgs.Add(substituted);
                structChanged |= !ReferenceEquals(substituted, ss.TypeArguments[i]);
            }

            return structChanged
                ? StructSymbol.Construct(ss.Definition, substitutedStructArgs.MoveToImmutable(), mapClrType)
                : type;
        }

        // Issue #1521: a member type that is a reference to a type nested inside
        // the generic being constructed (e.g. a field/return typed `Tag` on
        // `Box[T]`, where `Tag` is `struct Box[T].Tag`) must thread the
        // enclosing construction so it surfaces as `Box[int32].Tag` on
        // `Box[int32]`. `Tag` declares no own type arguments, so this is
        // distinct from the constructed-generic branch above.
        if (type is StructSymbol nestedRef && nestedRef.TypeArguments.IsDefaultOrEmpty)
        {
            var newEnclosing = SubstituteEnclosingArguments(nestedRef, t => SubstituteTypeForConstruction(t, subst, mapClrType));
            if (!newEnclosing.IsDefault)
            {
                return ConstructNested(nestedRef.Definition ?? nestedRef, newEnclosing, mapClrType);
            }
        }

        if (type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedArgs = ImmutableArray.CreateBuilder<TypeSymbol>(iface.TypeArguments.Length);
            var changed = false;
            for (var i = 0; i < iface.TypeArguments.Length; i++)
            {
                var substituted = SubstituteTypeForConstruction(iface.TypeArguments[i], subst, mapClrType);
                substitutedArgs.Add(substituted);
                changed |= !ReferenceEquals(substituted, iface.TypeArguments[i]);
            }

            if (!changed)
            {
                return iface;
            }

            return InterfaceSymbol.Construct(iface.Definition, substitutedArgs.MoveToImmutable(), mapClrType);
        }

        if (type is ImportedTypeSymbol imported
            && imported.OpenDefinition != null
            && !imported.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedArgs = ImmutableArray.CreateBuilder<TypeSymbol>(imported.TypeArguments.Length);
            var changed = false;
            for (var i = 0; i < imported.TypeArguments.Length; i++)
            {
                var substituted = SubstituteTypeForConstruction(imported.TypeArguments[i], subst, mapClrType);
                substitutedArgs.Add(substituted);
                changed |= !ReferenceEquals(substituted, imported.TypeArguments[i]);
            }

            if (!changed)
            {
                return imported;
            }

            // Issue #1958: project each resolved CLR arg into the same
            // reflection context as `imported.OpenDefinition` before calling
            // MakeGenericType — mirrors InterfaceSymbol.SubstituteType's
            // mapClrType fix. Without this, a raw host CLR type mixed with an
            // MLC-resolved open definition throws ArgumentException and
            // silently erases the substitution.
            var resolvedClrArgs = new System.Type[substitutedArgs.Count];
            for (var i = 0; i < substitutedArgs.Count; i++)
            {
                var clr = substitutedArgs[i].ClrType ?? typeof(object);
                resolvedClrArgs[i] = mapClrType != null ? mapClrType(clr) : clr;
            }

            try
            {
                var closed = imported.OpenDefinition.MakeGenericType(resolvedClrArgs);
                return ImportedTypeSymbol.GetConstructed(closed, imported.OpenDefinition, substitutedArgs.MoveToImmutable());
            }
            catch (ArgumentException)
            {
                // MakeGenericType can legitimately throw ArgumentException for CLR
                // generic constraint reasons (e.g. unmanaged/ref-struct constraints),
                // not only cross-reflection-context mismatches, so this is NOT always
                // a bug. Log for diagnosability and fall back to the erased
                // constructed form so both debug and release builds degrade
                // gracefully rather than crash.
                var assertMessage = $"StructSymbol.SubstituteTypeForConstruction: MakeGenericType failed for '{imported.OpenDefinition}' with args [{string.Join(", ", resolvedClrArgs.Select(t => t.ToString()))}] even after mapClrType projection.";
                System.Diagnostics.Debug.WriteLine(assertMessage);
                return imported;
            }
        }

        if (type is NullableTypeSymbol n)
        {
            var inner = SubstituteTypeForConstruction(n.UnderlyingType, subst, mapClrType);
            return ReferenceEquals(inner, n.UnderlyingType) ? type : NullableTypeSymbol.Get(inner);
        }

        if (type is SliceTypeSymbol s)
        {
            var inner = SubstituteTypeForConstruction(s.ElementType, subst, mapClrType);
            return ReferenceEquals(inner, s.ElementType) ? type : SliceTypeSymbol.Get(inner);
        }

        if (type is ArrayTypeSymbol a)
        {
            var inner = SubstituteTypeForConstruction(a.ElementType, subst, mapClrType);
            return ReferenceEquals(inner, a.ElementType) ? type : ArrayTypeSymbol.Get(inner, a.Length);
        }

        // Issue #1503: a `map[K, V]` element of a generic member (e.g. a
        // generic delegate parameter typed `map[K, V]`) recursively
        // substitutes both its key and value types so it surfaces as
        // `map[int32, string]` on the constructed instantiation.
        if (type is MapTypeSymbol map)
        {
            var substKey = SubstituteTypeForConstruction(map.KeyType, subst, mapClrType);
            var substValue = SubstituteTypeForConstruction(map.ValueType, subst, mapClrType);
            return ReferenceEquals(substKey, map.KeyType) && ReferenceEquals(substValue, map.ValueType)
                ? type
                : MapTypeSymbol.Get(substKey, substValue);
        }

        // Issue #1503: a constructed generic named delegate referenced as a
        // member type (e.g. a field/parameter typed `Predicate[T]` on a
        // generic type, or a nested generic delegate argument) substitutes its
        // own type arguments so it surfaces as `Predicate[int32]`.
        if (type is DelegateTypeSymbol del
            && del.Definition != null
            && !ReferenceEquals(del.Definition, del)
            && !del.TypeArguments.IsDefaultOrEmpty)
        {
            var substitutedDelegateArgs = ImmutableArray.CreateBuilder<TypeSymbol>(del.TypeArguments.Length);
            var delegateChanged = false;
            for (var i = 0; i < del.TypeArguments.Length; i++)
            {
                var substituted = SubstituteTypeForConstruction(del.TypeArguments[i], subst, mapClrType);
                substitutedDelegateArgs.Add(substituted);
                delegateChanged |= !ReferenceEquals(substituted, del.TypeArguments[i]);
            }

            return delegateChanged
                ? DelegateTypeSymbol.Construct(del.Definition, substitutedDelegateArgs.MoveToImmutable())
                : type;
        }

        // Issue #1192: a function/delegate type (e.g. a primary-constructor
        // parameter of type `(T) -> void`) must have its parameter types and
        // return type recursively substituted so the constructed generic's
        // synthesized constructor matches a `(int32) -> void` argument.
        if (type is FunctionTypeSymbol fn)
        {
            var substitutedParams = ImmutableArray.CreateBuilder<TypeSymbol>(fn.ParameterTypes.Length);
            var changed = false;
            for (var i = 0; i < fn.ParameterTypes.Length; i++)
            {
                var substituted = SubstituteTypeForConstruction(fn.ParameterTypes[i], subst, mapClrType);
                substitutedParams.Add(substituted);
                changed |= !ReferenceEquals(substituted, fn.ParameterTypes[i]);
            }

            var substitutedReturn = SubstituteTypeForConstruction(fn.ReturnType, subst, mapClrType);
            changed |= !ReferenceEquals(substitutedReturn, fn.ReturnType);

            if (!changed)
            {
                return fn;
            }

            return fn.IsVariadic.IsDefaultOrEmpty
                ? FunctionTypeSymbol.Get(substitutedParams.MoveToImmutable(), substitutedReturn)
                : FunctionTypeSymbol.Get(substitutedParams.MoveToImmutable(), fn.IsVariadic, substitutedReturn);
        }

        return type;
    }

    private sealed class BaseClassSnapshot
    {
        public BaseClassSnapshot(StructSymbol source, StructSymbol value)
        {
            Source = source;
            Value = value;
        }

        public StructSymbol Source { get; }

        public StructSymbol Value { get; }
    }

    private sealed class ParameterArraySnapshot
    {
        public ParameterArraySnapshot(
            ImmutableArray<ParameterSymbol> source,
            ImmutableArray<ParameterSymbol> value)
        {
            Source = source;
            Value = value;
        }

        public ImmutableArray<ParameterSymbol> Source { get; }

        public ImmutableArray<ParameterSymbol> Value { get; }
    }

    private sealed class InterfaceArraySnapshot
    {
        public InterfaceArraySnapshot(
            ImmutableArray<InterfaceSymbol> source,
            ImmutableArray<InterfaceSymbol> value)
        {
            Source = source;
            Value = value;
        }

        public ImmutableArray<InterfaceSymbol> Source { get; }

        public ImmutableArray<InterfaceSymbol> Value { get; }
    }

    private sealed class TypeArraySnapshot
    {
        public TypeArraySnapshot(
            ImmutableArray<TypeSymbol> source,
            ImmutableArray<TypeSymbol> value)
        {
            Source = source;
            Value = value;
        }

        public ImmutableArray<TypeSymbol> Source { get; }

        public ImmutableArray<TypeSymbol> Value { get; }
    }

    private sealed class TypeSnapshot
    {
        public TypeSnapshot(TypeSymbol source, TypeSymbol value)
        {
            Source = source;
            Value = value;
        }

        public TypeSymbol Source { get; }

        public TypeSymbol Value { get; }
    }
}
