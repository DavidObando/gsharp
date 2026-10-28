// <copyright file="StructSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Threading

/// Represents a user-defined aggregate type (Phase 3.B). Structs are CLR value
/// types; classes are CLR reference types. Methods may be declared inside class
/// bodies or added later through same-package receiver declarations.
class StructSymbol : TypeSymbol {
    internal prop NativeProtocolEntry NativeProtocolEntryPlan? {
        get;
        set;
    }
    internal prop IsNativeProtocolSupport bool {
        get;
        set;
    }
    private var nativeProtocols ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty

    internal prop NativeProtocols ImmutableArray[TypeSymbol] {
        get -> nativeProtocols
        set -> nativeProtocols = value
    }

    // Issue #1341: backing stores for the generically-erased member tables whose
    // reads are forwarded to Definition on a constructed instance. On a
    // definition (or non-generic type) these hold the canonical member set; on a
    // constructed instance they are unused (the forwarding getter reads
    // Definition's store) so a late-bound definition body is always observed.
    private var methods ImmutableArray[FunctionSymbol] = ImmutableArray[FunctionSymbol].Empty

    private var staticMethods ImmutableArray[FunctionSymbol] = ImmutableArray[FunctionSymbol].Empty
    private var staticFields ImmutableArray[FieldSymbol] = ImmutableArray[FieldSymbol].Empty
    private var constFields ImmutableArray[FieldSymbol] = ImmutableArray[FieldSymbol].Empty
    private var fieldsStore ImmutableArray[FieldSymbol] = ImmutableArray[FieldSymbol].Empty
    private var propertiesStore ImmutableArray[PropertySymbol] = ImmutableArray[PropertySymbol].Empty
    private var staticPropertiesStore ImmutableArray[PropertySymbol] = ImmutableArray[PropertySymbol].Empty
    private var staticEventsStore ImmutableArray[EventSymbol] = ImmutableArray[EventSymbol].Empty

    // Issue #1341: memoized substitution of the definition's instance-member
    // tables (whose member types may mention the type parameters) for a
    // constructed instance. These are recomputed when the definition's source
    // array changes reference — which happens exactly once, when the
    // definition's body is bound — so a construction materialized before the
    // definition's body still observes the substituted members afterward,
    // making member lookup independent of source-file binding order.
    private var substitutionMap Dictionary[TypeParameterSymbol, TypeSymbol]?

    // Issue #1537: for a constructed reference to a GENERIC type nested inside a
    // generic enclosing type (`Outer[int32].Middle[string]`), the nested
    // definition's own type parameters captured at construction time (before the
    // emitter re-ordinalizes the nested TypeDef's parameters over the flattened
    // enclosing+own list, ECMA-335 §II.10.3.1). Used to key the own-argument
    // half of the substitution map so a member typed as the nested type's own
    // parameter (`Middle.Label : T`) surfaces closed regardless of when the map
    // is first computed. Empty for every other symbol.
    private var nestedOwnTypeParameters ImmutableArray[TypeParameterSymbol] = ImmutableArray[TypeParameterSymbol].Empty

    // Issue #1958: the projector supplied to Construct()/ConstructNested()/
    // ConstructNestedGeneric(), retained so the (lazily computed, see
    // GetSubstitutedFields/GetSubstitutedProperties) member substitution can
    // close constructed-generic member types in the right reflection context.
    // Null for definitions and for constructed instances built without a
    // projector (single-context callers; unchanged behavior).
    private var mapClrType((Type) -> Type)?

    private var substitutedFields ImmutableArray[FieldSymbol]
    private var substitutedFieldsSource ImmutableArray[FieldSymbol]
    private var substitutedFieldsComputed bool
    private var substitutedProperties ImmutableArray[PropertySymbol]
    private var substitutedPropertiesSource ImmutableArray[PropertySymbol]
    private var substitutedPropertiesComputed bool
    private var substitutedStaticProperties ImmutableArray[PropertySymbol]
    private var substitutedStaticPropertiesSource ImmutableArray[PropertySymbol]
    private var substitutedStaticPropertiesComputed bool
    private var primaryConstructorParametersStore ImmutableArray[ParameterSymbol] = ImmutableArray[
        ParameterSymbol
    ].Empty
    private var interfacesStore ImmutableArray[InterfaceSymbol] = ImmutableArray[InterfaceSymbol].Empty
    private var implementedClrInterfacesStore ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty
    private var eventsStore ImmutableArray[EventSymbol] = ImmutableArray[EventSymbol].Empty
    private var importedBaseTypeStore TypeSymbol?
    private var baseClassStore StructSymbol?
    private var substitutedBaseClass BaseClassSnapshot?
    private var substitutedPrimaryConstructorParameters ParameterArraySnapshot?
    private var substitutedInterfaces InterfaceArraySnapshot?
    private var substitutedImplementedClrInterfaces TypeArraySnapshot?
    private var substitutedImportedBaseType TypeSnapshot?
    private var dataClassCloneMethod FunctionSymbol?
    private var dataEqualsSelf FunctionSymbol?
    private var dataEqualsObject FunctionSymbol?
    private var dataPrintMembers FunctionSymbol?
    private var dataPrintMembersMethods ImmutableArray[FunctionSymbol]
    private var dataPrintMembersBase StructSymbol?
    private var dataPrintMembersComputed bool
    private var dataEqualsBase FunctionSymbol?
    private var dataEqualsBaseOwner TypeSymbol?

    /// Initializes a new instance of the (cref:StructSymbol) class.
    /// @param name The struct type name.
    /// @param fields The field declarations in source order.
    /// @param accessibility The struct's CLR accessibility.
    /// @param declaration The declaring syntax node.
    /// @param packageName The package the struct lives in.
    convenience init(
        name string,
        fields ImmutableArray[FieldSymbol],
        accessibility Accessibility,
        declaration StructDeclarationSyntax?,
        packageName string
    ) {
        init(name, fields, accessibility, declaration, packageName, false, false)
    }

    /// Initializes a new instance of the (cref:StructSymbol) class.
    /// @param name The struct type name.
    /// @param fields The field declarations in source order.
    /// @param accessibility The struct's CLR accessibility.
    /// @param declaration The declaring syntax node.
    /// @param packageName The package the struct lives in.
    /// @param isData True for `data struct` declarations (Phase 3.B.2 / ADR-0029).
    /// @param isInline True for `inline struct` declarations (ADR-0033).
    convenience init(
        name string,
        fields ImmutableArray[FieldSymbol],
        accessibility Accessibility,
        declaration StructDeclarationSyntax?,
        packageName string,
        isData bool,
        isInline bool = false
    ) {
        init(name, fields, accessibility, declaration, packageName, isData, isInline, false)
    }

    /// Initializes a new instance of the (cref:StructSymbol) class.
    /// @param name The aggregate type name.
    /// @param fields The field declarations in source order.
    /// @param accessibility The CLR accessibility.
    /// @param declaration The declaring syntax node.
    /// @param packageName The package the type lives in.
    /// @param isData True for `data struct` declarations (Phase 3.B.2 / ADR-0029).
    /// @param isInline True for `inline struct` declarations (ADR-0033).
    /// @param isClass True for `class` declarations (Phase 3.B.3): emitted as a CLR reference type with
    /// object base; not value-copied on assignment.
    convenience init(
        name string,
        fields ImmutableArray[FieldSymbol],
        accessibility Accessibility,
        declaration StructDeclarationSyntax?,
        packageName string,
        isData bool,
        isInline bool,
        isClass bool
    ) {
        init(
            name,
            fields,
            accessibility,
            declaration,
            packageName,
            isData,
            isInline,
            isClass,
            ImmutableArray[ParameterSymbol].Empty
        )
    }

    /// Initializes a new instance of the (cref:StructSymbol) class.
    /// @param name The aggregate type name.
    /// @param fields The field declarations in source order.
    /// @param accessibility The CLR accessibility.
    /// @param declaration The declaring syntax node.
    /// @param packageName The package the type lives in.
    /// @param isData True for `data struct` declarations (Phase 3.B.2 / ADR-0029).
    /// @param isInline True for `inline struct` declarations (ADR-0033).
    /// @param isClass True for `class` declarations (Phase 3.B.3): emitted as a CLR reference type with
    /// object base; not value-copied on assignment.
    /// @param primaryConstructorParameters The Kotlin-style primary constructor parameters (Phase 3.B.3
    /// sub-step 2). Each entry corresponds to a field of the same name; empty when the type has no explicit
    /// primary constructor (default parameterless ctor).
    convenience init(
        name string,
        fields ImmutableArray[FieldSymbol],
        accessibility Accessibility,
        declaration StructDeclarationSyntax?,
        packageName string,
        isData bool,
        isInline bool,
        isClass bool,
        primaryConstructorParameters ImmutableArray[ParameterSymbol]
    ) {
        init(
            name,
            fields,
            accessibility,
            declaration,
            packageName,
            isData,
            isInline,
            isClass,
            primaryConstructorParameters,
            false,
            nil
        )
    }

    /// Initializes a new instance of the (cref:StructSymbol) class.
    /// @param name The aggregate type name.
    /// @param fields The field declarations in source order.
    /// @param accessibility The CLR accessibility.
    /// @param declaration The declaring syntax node.
    /// @param packageName The package the type lives in.
    /// @param isData True for `data struct` declarations.
    /// @param isInline True for `inline struct` declarations.
    /// @param isClass True for `class` declarations.
    /// @param primaryConstructorParameters The Kotlin-style primary constructor parameters.
    /// @param isOpen True when this class was declared with the `open` modifier (Phase 3.B.3 sub-step 3 /
    /// ADR-0017). Always false for structs.
    /// @param baseClass The base class symbol (Phase 3.B.3 sub-step 3), or `null` when this class derives
    /// directly from `System.Object`.
    convenience init(
        name string,
        fields ImmutableArray[FieldSymbol],
        accessibility Accessibility,
        declaration StructDeclarationSyntax?,
        packageName string,
        isData bool,
        isInline bool,
        isClass bool,
        primaryConstructorParameters ImmutableArray[ParameterSymbol],
        isOpen bool,
        baseClass StructSymbol?
    ) {
        init(
            name,
            fields,
            accessibility,
            declaration,
            packageName,
            isData,
            isInline,
            isClass,
            primaryConstructorParameters,
            isOpen,
            baseClass,
            nil
        )
    }

    /// Initializes a new instance of the (cref:StructSymbol) class for
    /// a metadata-backed aggregate that still needs G#-level semantics during
    /// binding/emission (for example an imported value type compiled from G#).
    /// @param name The aggregate type name.
    /// @param fields The field declarations in source order.
    /// @param accessibility The CLR accessibility.
    /// @param declaration The declaring syntax node, or `null` for imported types.
    /// @param packageName The package/namespace the type lives in.
    /// @param isData True for `data struct` declarations.
    /// @param isInline True for `inline struct` declarations.
    /// @param isClass True for `class` declarations.
    /// @param primaryConstructorParameters The Kotlin-style primary constructor parameters.
    /// @param isOpen True when this class was declared with the `open` modifier.
    /// @param baseClass The base class symbol.
    /// @param clrType The backing CLR type for imported aggregates, or `null` for same-compilation user
    /// types.
    init(
        name string,
        fields ImmutableArray[FieldSymbol],
        accessibility Accessibility,
        declaration StructDeclarationSyntax?,
        packageName string,
        isData bool,
        isInline bool,
        isClass bool,
        primaryConstructorParameters ImmutableArray[ParameterSymbol],
        isOpen bool,
        baseClass StructSymbol?,
        clrType Type?
    ) : base(name, clrType) {
        ImportedInterfaceAccessors = List[
            (
                Interface InterfaceSymbol,
                Property PropertySymbol,
                Accessor MethodInfo,
                ContainingType TypeSymbol,
                IsSetter bool
            )
        ]()
        Fields = fields
        Accessibility = accessibility
        Declaration = declaration
        PackageName = packageName
        IsData = isData
        IsInline = isInline
        IsClass = isClass
        primaryConstructorParametersStore = primaryConstructorParameters
        IsOpen = isOpen
        baseClassStore = baseClass
        interfacesStore = ImmutableArray[InterfaceSymbol].Empty
        Definition = this
    }

    /// Gets the field declarations in source order.
    /// @remarks Issue #1341: on a constructed instance, fields are substituted lazily from
    /// (cref:Definition) so a late-bound definition body is observed (order-independent member lookup).
    prop Fields ImmutableArray[FieldSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            GetSubstitutedFields()
        } else {
            fieldsStore
        }
        private set -> fieldsStore = value
    }

    /// Gets the struct CLR accessibility.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets the declaring syntax node.
    prop Declaration StructDeclarationSyntax? {
        get;
        private set;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> if Declaration is {} declaration {
        ImmutableArray.Create[SyntaxNode](declaration)
    } else {
        ImmutableArray[SyntaxNode].Empty
    }

    /// Gets the package the struct lives in.
    prop PackageName string {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ContainingNamespace string? -> PackageName

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop IsValueType bool -> !IsClass

    /// Gets a value indicating whether this is a `data struct` declaration (ADR-0029).
    prop IsData bool {
        get;
    }

    /// Gets a value indicating whether this is an `inline struct` declaration (ADR-0033).
    prop IsInline bool {
        get;
    }

    /// Gets a value indicating whether this is a by-ref-like (`ref struct`) declaration (issue #367).
    /// By-ref-like value types are stack-only: they cannot be boxed, stored in a field of a non-ref-struct,
    /// captured by a closure, hoisted into an async/iterator state machine, or used as a generic type
    /// argument. Derived from the declaring syntax so it is preserved across generic construction.
    prop IsRefStruct bool -> Declaration?.IsRef ?? false

    /// Gets a value indicating whether this class was declared `sealed class` (ADR-0078).
    /// A sealed class participates in exhaustiveness checking: its subclasses
    /// form a closed set (Kotlin/Swift sealed-class semantics) and the switch
    /// binder requires every subclass to be covered by an arm.
    prop IsSealedHierarchy bool -> IsClass && (Declaration?.IsSealed ?? false)

    /// Gets a value indicating whether this is a `class` declaration (Phase 3.B.3). Class types are
    /// reference types on the CLR; struct types (this flag false) are value types.
    prop IsClass bool {
        get;
    }

    /// Gets the Kotlin-style primary constructor parameters (Phase 3.B.3 sub-step 2). Each entry
    /// corresponds 1:1 to a field of the same name and type on this class; empty when no primary
    /// constructor was declared (default parameterless ctor).
    prop PrimaryConstructorParameters ImmutableArray[ParameterSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            GetSubstitutedPrimaryConstructorParameters()
        } else {
            primaryConstructorParametersStore
        }
        private set -> primaryConstructorParametersStore = value
    }

    /// Gets a value indicating whether this type carries an explicit primary constructor (Phase 3.B.3
    /// sub-step 2).
    prop HasPrimaryConstructor bool -> !PrimaryConstructorParameters.IsDefaultOrEmpty

    /// Gets a value indicating whether this class was declared `open` (Phase 3.B.3 sub-step 3 / ADR-0017).
    /// Required for subclassing.
    prop IsOpen bool {
        get;
    }

    /// Gets a value indicating whether this class is abstract: an explicit `abstract` or
    /// `shared` modifier (ADR-0195), an unimplemented abstract member in
    /// its effective own/inherited member set after override resolution
    /// (including imported CLR contracts), or a non-data descendant of an
    /// abstract synthesized record-clone ancestor. Such a type cannot be
    /// instantiated and is emitted with `TypeAttributes.Abstract`;
    /// a `shared` class is also sealed. Always `false` for
    /// value-type structs.
    prop IsAbstract bool {
        get {
            if !IsClass {
                return false
            }
            // Issue #1055: an abstract base method whose signature uses the base's
            // generic type parameters is implemented by an override whose concrete
            // signature matches the substituted base signature. Route through the
            // substitution-aware unimplemented-method computation so a class that
            // inherits a constructed generic base (e.g. `Derived : Base[int32]`)
            // and overrides every abstract member is correctly treated as concrete.
            // ADR-0195 / issue #4674: an explicitly `abstract` or `shared` class is
            // abstract whatever its members are.
            return IsDeclaredAbstract ||
                IsSharedClass ||
                (!IsData && GetDataCloneAncestor()?.IsAbstract == true) ||
                !GetUnimplementedAbstractMethods().IsDefaultOrEmpty ||
                !GetUnimplementedAbstractPropertyAccessors().IsDefaultOrEmpty ||
                ExternalClrOverrideResolver.HasUnimplementedAbstractMembers(this)
        }
    }

    /// Gets the immediate base class (Phase 3.B.3 sub-step 3), or `null` when this class derives directly
    /// from `System.Object`. Always null for structs.
    prop BaseClass StructSymbol? {
        get {
            if Definition == nil || object.ReferenceEquals(Definition, this) {
                return Volatile.Read(&baseClassStore)
            }
            return GetSubstitutedBaseClass()
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop BaseType TypeSymbol? -> BaseClass ?? ImportedBaseType

    /// Gets the interfaces this type implements (Phase 3.B.4). Populated by the binder after the symbol is
    /// constructed; defaults to empty.
    prop Interfaces ImmutableArray[InterfaceSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            GetSubstitutedInterfaces()
        } else {
            interfacesStore
        }
        private set -> interfacesStore = value
    }

    /// Gets the imported (CLR) interfaces this class implements (issue #525).
    /// Each entry's (cref:TypeSymbol.ClrType) is guaranteed to be an
    /// interface type. Populated by the binder when the base-type clause
    /// names a reachable imported CLR interface; defaults to empty.
    /// When set, the emitter writes an `InterfaceImpl` row per entry so
    /// the resulting class is a real CLR implementer (`Type.GetInterfaces()`
    /// surfaces the interface and dispatch through interface receivers works).
    prop ImplementedClrInterfaces ImmutableArray[TypeSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            GetSubstitutedImplementedClrInterfaces()
        } else {
            implementedClrInterfacesStore
        }
        private set -> implementedClrInterfacesStore = value
    }

    /// Gets the methods declared inside the class body (Phase 3.B.3 sub-step 2b). Populated by the binder
    /// after the symbol is constructed; defaults to empty.
    /// @remarks Issue #1341: methods are erased generically (ADR-0004) and carried on a
    /// constructed instance without per-construction substitution, so a
    /// constructed instance always reflects its (cref:Definition)'s
    /// current method set by forwarding the read. This keeps member lookup on a
    /// constructed generic user type independent of the order in which source
    /// files are bound: even when the construction is materialized (and cached)
    /// before the definition's body — and therefore its methods — has been
    /// bound, reads observe the methods once they are populated rather than an
    /// empty snapshot captured at construction time.
    prop Methods ImmutableArray[FunctionSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            Definition!!.Methods
        } else {
            methods
        }
        private set -> methods = value
    }

    /// Gets the properties declared on this type (ADR-0051). Populated by the binder after the symbol is
    /// constructed; defaults to empty.
    /// @remarks Issue #1341: on a constructed instance, properties are substituted lazily from
    /// (cref:Definition) so a late-bound definition body is observed (order-independent member lookup).
    prop Properties ImmutableArray[PropertySymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            GetSubstitutedProperties()
        } else {
            propertiesStore
        }
        private set -> propertiesStore = value
    }

    /// Gets the events declared on this type (ADR-0052). Populated by the binder after the symbol is
    /// constructed; defaults to empty.
    prop Events ImmutableArray[EventSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            Definition!!.Events
        } else {
            eventsStore
        }
        private set -> eventsStore = value
    }

    /// Gets the static fields declared inside a `shared` block (ADR-0053). Populated by the binder;
    /// defaults to empty.
    /// @remarks Issue #1341: forwarded from (cref:Definition) on a constructed instance (static members are
    /// shared by identity per issue #1209) so reads are order-independent.
    prop StaticFields ImmutableArray[FieldSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            Definition!!.StaticFields
        } else {
            staticFields
        }
        private set -> staticFields = value
    }

    /// Gets the compile-time constant fields declared with `const`
    /// (Issue #948). Const fields are implicitly static and read-only, and reads
    /// are inlined. ECMA constants emit as literal fields; decimal constants use
    /// static read-only storage initialized by the type constructor. Held
    /// separately from (cref:StaticFields) and populated by the binder.
    prop ConstFields ImmutableArray[FieldSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            Definition!!.ConstFields
        } else {
            constFields
        }
        private set -> constFields = value
    }

    /// Gets the static methods declared inside a `shared` block (ADR-0053). Populated by the binder;
    /// defaults to empty.
    /// @remarks Issue #1341: forwarded from (cref:Definition) on a constructed instance (static members are
    /// shared by identity per issue #1209) so reads are order-independent.
    prop StaticMethods ImmutableArray[FunctionSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            Definition!!.StaticMethods
        } else {
            staticMethods
        }
        private set -> staticMethods = value
    }

    /// Gets the static properties declared inside a `shared` block (ADR-0053). Populated by the binder;
    /// defaults to empty.
    /// @remarks Issue #1341: on a constructed instance, static properties are substituted lazily from
    /// (cref:Definition) so a late-bound definition body is observed (order-independent member lookup).
    prop StaticProperties ImmutableArray[PropertySymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            GetSubstitutedStaticProperties()
        } else {
            staticPropertiesStore
        }
        private set -> staticPropertiesStore = value
    }

    /// Gets the static events declared inside a `shared` block (ADR-0053). Populated by the binder;
    /// defaults to empty.
    prop StaticEvents ImmutableArray[EventSymbol] {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            Definition!!.StaticEvents
        } else {
            staticEventsStore
        }
        private set -> staticEventsStore = value
    }

    /// Gets the bound initializer expressions for static fields with non-default values (Issue #262). Keyed
    /// by field symbol.
    private var _staticFieldInitializers ImmutableDictionary[FieldSymbol, BoundExpression] = ImmutableDictionary[
        FieldSymbol,
        BoundExpression
    ].Empty

    prop StaticFieldInitializers ImmutableDictionary[FieldSymbol, BoundExpression] {
        get {
            return _staticFieldInitializers
        }
        private set {
            _staticFieldInitializers = value
        }
    }

    /// Gets the bound initializer expressions for instance fields with non-default values (Issue #640).
    /// Keyed by field symbol; iterated in (cref:Fields) source order at emit time.
    private var _instanceFieldInitializers ImmutableDictionary[FieldSymbol, BoundExpression] = ImmutableDictionary[
        FieldSymbol,
        BoundExpression
    ].Empty

    prop InstanceFieldInitializers ImmutableDictionary[FieldSymbol, BoundExpression] {
        get {
            return _instanceFieldInitializers
        }
        private set {
            _instanceFieldInitializers = value
        }
    }

    /// Gets the bound, lowered statements of the type's `shared { init { … } }`
    /// static-initializer block(s) (ADR-0140 / issue #2131), concatenated in
    /// source order. Emitted into the type's `.cctor` after the static-field
    /// initializers. Defaults to empty.
    private var _staticInitializerStatements ImmutableArray[BoundStatement] = ImmutableArray[BoundStatement].Empty

    prop StaticInitializerStatements ImmutableArray[BoundStatement] {
        get {
            return _staticInitializerStatements
        }
        private set {
            _staticInitializerStatements = value
        }
    }

    /// Gets or sets the static initializer's function, including its captured lexical unsafe context.
    internal prop StaticInitializerFunction FunctionSymbol?

    /// Gets a value indicating whether the type declares a `shared { init { … } }` static-initializer block
    /// (ADR-0140 / issue #2131). Such a type must not be marked `beforefieldinit`.
    prop HasStaticInitializerBlock bool -> !StaticInitializerStatements.IsDefaultOrEmpty

    /// Gets a value indicating whether the declaration has a `shared { init { … } }` block (#5483). Unlike
    /// (cref:HasStaticInitializerBlock), this is known from the declaration pass on, before any body is bound,
    /// so a body that is bound earlier reads the same answer as one bound later.
    internal prop DeclaresStaticInitializerBlock bool -> StaticInitializerFunction != nil

    /// Gets the type parameters when this is a generic definition (Phase 4.3 / ADR-0020). Empty for
    /// non-generic types and for constructed instances.
    private var _typeParameters ImmutableArray[TypeParameterSymbol] = ImmutableArray[TypeParameterSymbol].Empty

    prop TypeParameters ImmutableArray[TypeParameterSymbol] {
        get {
            return _typeParameters
        }
        private set {
            _typeParameters = value
        }
    }

    /// Gets the type arguments when this is a constructed instance of a generic definition (Phase 4.3 /
    /// ADR-0020). Empty for generic definitions and for non-generic types.
    private var _typeArguments ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty

    prop TypeArguments ImmutableArray[TypeSymbol] {
        get {
            return _typeArguments
        }
        private set {
            _typeArguments = value
        }
    }

    /// Gets the flattened type arguments of the enclosing construction when this
    /// is a reference to a type nested inside a <em>generic</em> enclosing type
    /// used from a <em>constructed</em> context (issue #1521) — e.g. the return
    /// type `Tag` of `Box[int32].MakeTag()` surfaces as
    /// `Box[int32].Tag`. The arguments are ordered outermost-first
    /// (CLR order), aligned 1:1 with the enclosing generic parameters the
    /// emitter reifies the nested type over (ECMA-335 §II.10.3.1), so a
    /// use-site reference / local / field slot encodes
    /// `Box`1+Tag`1<int32>` rather than the open self-instantiation
    /// `Box`1+Tag`1<!0>`. Empty for a top-level type, for an open
    /// nested type referenced from within its own enclosing generic's members
    /// (which threads `!0…`), and for a nested type of a non-generic type.
    private var _enclosingTypeArguments ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty

    prop EnclosingTypeArguments ImmutableArray[TypeSymbol] {
        get {
            return _enclosingTypeArguments
        }
        private set {
            _enclosingTypeArguments = value
        }
    }

    /// Gets a value indicating whether this is a constructed reference to a type
    /// nested inside a generic enclosing type (issue #1521) — it carries
    /// (cref:EnclosingTypeArguments) but declares no own type arguments.
    prop IsConstructedNestedType bool -> !EnclosingTypeArguments.IsDefaultOrEmpty

    /// Gets, for a synthesized closure / capture-box class that was reified
    /// generic over enclosing type/method type parameters (issue #1477), the
    /// ordered list of the ORIGINAL enclosing
    /// (cref:TypeParameterSymbol)s its fresh class type parameters
    /// ((cref:TypeParameters)) clone 1:1. The emitter consumes this to
    /// build the outer-TP → own-TP-ordinal remap (mirroring the iterator/async
    /// state-machine treatment) so member signatures encode a valid
    /// `VAR(idx)` slot. Empty for every other type. Each entry at index
    /// `i` corresponds to (cref:TypeParameters)`[i]`.
    private var _reifiedFromTypeParameters ImmutableArray[TypeParameterSymbol] = ImmutableArray[
        TypeParameterSymbol
    ].Empty

    prop ReifiedFromTypeParameters ImmutableArray[TypeParameterSymbol] {
        get {
            return _reifiedFromTypeParameters
        }
        private set {
            _reifiedFromTypeParameters = value
        }
    }

    /// Gets a value indicating whether (cref:ReifiedFromTypeParameters)
    /// already includes every generic parameter required by this type's
    /// enclosing type chain.
    prop HasCompleteReifiedTypeParameterVector bool {
        get;
        private set;
    }

    /// Gets the first class generic-parameter ordinal occupied by (cref:ReifiedFromTypeParameters).
    prop ReifiedTypeParameterOrdinalOffset int32 {
        get;
        private set;
    }

    /// Gets a value indicating whether this is a generic definition (has type parameters and no type
    /// arguments).
    prop IsGenericDefinition bool -> !TypeParameters.IsDefaultOrEmpty && TypeArguments.IsDefaultOrEmpty

    /// Gets the original generic definition when this is a constructed instance; otherwise `this`.
    prop Definition StructSymbol? {
        get;
        private set;
    }

    /// Gets a value indicating whether this class is sugar-marked as a
    /// (cref:System.Attribute)-derived type via the
    /// `@Attribute` declaration sugar from ADR-0047 §5. When true, the
    /// emitter overrides the CLR base type from `System.Object` to
    /// (cref:System.Attribute) and chains the class's constructors
    /// to `System.Attribute..ctor()`.
    prop IsAttributeClass bool {
        get;
        private set;
    }

    /// Gets the imported (CLR) base class this GSharp class derives from
    /// (issue #296), or `null` when the class derives from another GSharp
    /// class ((cref:BaseClass)) or directly from `System.Object`.
    /// When set, the emitter writes this CLR type as the TypeDef's base type
    /// and chains the generated constructor to the CLR base's parameterless
    /// `.ctor()`; member lookup walks into this type so inherited CLR
    /// members are accessible on instances of the derived GSharp class.
    prop ImportedBaseType TypeSymbol? {
        get -> if Definition != nil && !object.ReferenceEquals(Definition, this) {
            GetSubstitutedImportedBaseType()
        } else {
            Volatile.Read(&importedBaseTypeStore)
        }
    }

    /// Gets the explicit base-constructor initializer (`: Base(args)`) declared
    /// on this class (issue #306), or `null` when the class chains to a
    /// parameterless base constructor. When non-null the emitter forwards the
    /// bound arguments to the resolved base `.ctor` and suppresses the
    /// auto-generated parameterless constructor.
    prop BaseConstructorInitializer BaseConstructorInitializer? {
        get;
        private set;
    }

    /// Gets the resolved (cref:StructLayoutMetadata) derived from a
    /// `@StructLayout(LayoutKind.…)` annotation on the declaration, or
    /// `null` when no annotation was supplied. ADR-0093 / issue #759:
    /// the emitter consults this property to pick the correct CLR
    /// (cref:System.Reflection.TypeAttributes) layout flag and to
    /// write the optional `ClassLayout` row.
    prop LayoutMetadata StructLayoutMetadata? {
        get;
        private set;
    }

    /// Gets a value indicating whether this is a compiler-generated fixed-size
    /// buffer backing struct (ADR-0122 §10 / issue #1035). The emitter stamps
    /// such a struct with `[CompilerGenerated]` and `[UnsafeValueType]`
    /// and an explicit `ClassLayout` size of `N * sizeof(T)`.
    prop IsFixedBufferBacking bool {
        get;
        private set;
    }

    /// Gets the fixed-size buffer element type for a fixed-buffer backing struct (ADR-0122 §10 / issue
    /// #1035), or `null`.
    prop FixedBufferElementType TypeSymbol? {
        get;
        private set;
    }

    /// Gets the standalone user-defined constructor (`init(...)`) declared on
    /// this class or plain struct (issues #306/#2766), or `null` when the aggregate has none. When non-null
    /// the emitter materializes exactly one `.ctor` (this constructor) and
    /// suppresses the auto-generated parameterless / primary constructor.
    /// @remarks ADR-0063: when the class declares an overload family of `init(...)`
    /// constructors, (cref:ExplicitConstructor) still surfaces the
    /// <em>first</em> declaration so single-constructor callers keep working;
    /// the full overload set lives on (cref:ExplicitConstructors).
    prop ExplicitConstructor ConstructorSymbol? {
        get;
        private set;
    }

    /// Gets every user-defined `init(...)` constructor declared on
    /// this class or plain struct in declaration order (ADR-0063). Empty when the aggregate has no
    /// explicit constructor declarations. The first element always equals
    /// (cref:ExplicitConstructor).
    private var _explicitConstructors ImmutableArray[ConstructorSymbol] = ImmutableArray[ConstructorSymbol].Empty

    prop ExplicitConstructors ImmutableArray[ConstructorSymbol] {
        get {
            return _explicitConstructors
        }
        private set {
            _explicitConstructors = value
        }
    }

    /// Gets the explicit `init(...)` constructors visible on
    /// this symbol, looking through to the generic definition for a constructed
    /// (closed) generic type (issue #1087). A constructed (cref:StructSymbol) produced
    /// by (cref:CreateConstructed) does not carry its own explicit
    /// constructor table (those are populated on the open definition after the
    /// constructed shell already exists), so base-constructor resolution against
    /// a constructed generic base must consult the definition's table. The
    /// returned (cref:ConstructorSymbol) instances are the definition's,
    /// which is exactly what the emitter keys its constructor handles by; use
    /// (cref:GetConstructorParameterTypesForConstruction) to obtain the
    /// type-argument-substituted parameter signatures for overload matching.
    prop EffectiveExplicitConstructors ImmutableArray[ConstructorSymbol] -> if !ExplicitConstructors.IsDefaultOrEmpty ||
        Definition == nil {
        ExplicitConstructors
    } else {
        Definition!!.ExplicitConstructors
    }

    /// Gets the user-declared `deinit { … }` destructor on this class
    /// (ADR-0068 / issue #698), or `null` when the class has none.
    /// Populated by the binder; consumed by the emitter to materialise the
    /// CLR `Finalize` override.
    prop Deinitializer DeinitSymbol? {
        get;
        private set;
    }

    /// Gets or sets a value indicating whether the definition's constructor arguments carry
    /// anonymous-object property members.
    internal prop HasAnonymousConstructorMembers bool

    /// Gets a value indicating whether this type declares a primary-constructor parameter list, including
    /// an empty list.
    internal prop HasDeclaredPrimaryConstructor bool -> if Definition != nil && !object.ReferenceEquals(
        Definition,
        this
    ) {
        Definition!!.HasDeclaredPrimaryConstructor
    } else {
        HasPrimaryConstructor || (Declaration?.HasPrimaryConstructor ?? false)
    }

    /// Gets a value indicating whether the compiler-owned value-struct default constructor initializes only
    /// sound zero values.
    internal prop ValueStructDefaultCtorIsZeroInitialization bool -> UsesConstructorOwnedDataConstruction

    internal prop UsesConstructorOwnedDataConstruction bool -> !IsClass && IsData && !IsInline

    /// Gets whether ordinary data construction needs a compiler-owned public constructor.
    internal prop HasSynthesizedDataConstructor bool -> UsesConstructorOwnedDataConstruction &&
        (
        HasDeclaredPrimaryConstructor || !EffectiveExplicitConstructors.Any(
            (constructor ConstructorSymbol) -> !constructor.IsSynthesizedFromPrimaryConstructor &&
                constructor
                .Parameters
                .IsEmpty
        )
    )

    /// Gets whether existing G# metadata assigns brace inputs to a primary constructor.
    internal prop HasDataConstructionPrimary bool -> UsesConstructorOwnedDataConstruction &&
        (
        if ClrType == nil {
            HasDeclaredPrimaryConstructor
        } else {
            ImportedAssemblySemantics.TryGetTypeSemantics(ClrType, out var semantics) &&
                !semantics!!
                .PrimaryConstructorParameterNames
                .IsDefaultOrEmpty
        }
    )

    /// Finds the storage selected by existing primary-member metadata.
    internal func GetDataConstructionPrimaryField(type Type, index int32) FieldInfo? {
        if !ImportedAssemblySemantics.TryGetTypeSemantics(type, out var semantics) ||
            index < 0 ||
            index >= semantics!!
            .PrimaryConstructorParameterNames
            .Length {
            return nil
        }
        let tokens = semantics!!.PrimaryConstructorParameterFieldTokens
        return ClrTypeUtilities.SafeGetFields(
            type,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        )
            .FirstOrDefault(
            (field FieldInfo) -> if !tokens.IsDefaultOrEmpty && index < tokens.Length && tokens[index] != 0 {
                field.MetadataToken == tokens[index]
            } else {
                field.Name == semantics!!.PrimaryConstructorParameterNames[index]
            }
        )
    }

    /// Selects the declaration signature before mapping it to a closed imported type.
    internal func GetDataConstructionConstructor() ConstructorInfo? {
        if ClrType is not{} importedType {
            return nil
        }
        let parameters = if HasDataConstructionPrimary {
            PrimaryConstructorParameters
        } else {
            ImmutableArray[ParameterSymbol].Empty
        }
        if ImportedAssemblySemantics.TryGetTypeSemantics(importedType, out var semantics) &&
            semantics!!
            .PrimaryConstructorParameterNames
            .Length != parameters.Length {
            return nil
        }
        let flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
        let signatureType = if importedType.IsGenericType && !importedType.IsGenericTypeDefinition {
            importedType.GetGenericTypeDefinition()
        } else {
            importedType
        }
        let expectedTypes = ImmutableArray.CreateBuilder[Type](parameters.Length)
        for var i = 0; i < parameters.Length; i++ {
            let field = GetDataConstructionPrimaryField(signatureType, i)
            let physicalType = field?.FieldType ?? ClrTypeUtilities.SafeGetProperty(
                signatureType,
                parameters[i].Name,
                flags
            )
                ?.PropertyType
            if physicalType == nil {
                return nil
            }
            expectedTypes.Add(physicalType)
        }
        for constructor in ClrTypeUtilities.SafeGetConstructors(signatureType, flags) {
            let actual = constructor.GetParameters()
            if actual.Length != parameters.Length {
                continue
            }
            var matches = true
            for var i = 0; i < actual.Length; i++ {
                if !ClrTypeUtilities.AreSame(expectedTypes[i], actual[i].ParameterType) {
                    matches = false
                    break
                }
            }
            if matches {
                return if object.ReferenceEquals(signatureType, importedType) {
                    constructor
                } else {
                    ClrTypeUtilities.FindMetadataDefinition(
                        importedType,
                        constructor,
                        flags,
                        safeEnumeration: true
                    ) as ConstructorInfo
                }
            }
        }
        return nil
    }

    /// Gets a value indicating whether a positional data struct needs an in-type collection-zero helper.
    internal prop NeedsValueStructZeroHelper bool -> ValueStructDefaultCtorIsZeroInitialization &&
        MagicCollectionZeroValue.CanSynthesizeInTypeZeroConstructor(this)

    /// Gets imported accessors selected by interface conformance binding.
    internal prop ImportedInterfaceAccessors List[
        (
            Interface InterfaceSymbol,
            Property PropertySymbol,
            Accessor MethodInfo,
            ContainingType TypeSymbol,
            IsSetter bool
        )
    ] {
        get;
    }

    /// Gets the compiler-owned self equality signature on this exact construction.
    internal prop DataEqualsSelf FunctionSymbol -> (
        if dataEqualsSelf == nil {
            (dataEqualsSelf = DataEqualityMemberModel.Create(this, this, isOverride: false))
        } else {
            dataEqualsSelf
        }
    )!!

    /// Gets or sets a value indicating whether this type is the synthesized backing type of an
    /// anonymous literal (`data object { ... }` or `object { ... }`, ADR-0146).
    /// Such a type keeps G#'s equality surface and prints as a C# anonymous type
    /// (ADR-0199); it gets no `PrintMembers`, copy constructor or clone.
    internal prop IsAnonymousLiteral bool

    /// Gets the compiler-owned `PrintMembers(StringBuilder)` slot (ADR-0199), or
    /// null when this type declares its own (which then replaces it) or is an anonymous literal.
    internal prop DataPrintMembers FunctionSymbol? {
        get {
            // The slot depends on the declared methods and the base class, both
            // installed after the shell exists; re-derive when either changes.
            if !dataPrintMembersComputed || !dataPrintMembersMethods.Equals(Methods) || !object.ReferenceEquals(
                dataPrintMembersBase,
                BaseClass
            ) {
                dataPrintMembers = if DataPrintMembersModel.FindDeclared(this) == nil {
                    DataPrintMembersModel.Create(this)
                } else {
                    default(FunctionSymbol?)
                }
                dataPrintMembersMethods = Methods
                dataPrintMembersBase = BaseClass
                dataPrintMembersComputed = true
            }
            return dataPrintMembers
        }
    }

    /// Gets the compiler-owned override of the nullable object equality slot.
    internal prop DataEqualsObject FunctionSymbol -> (
        if dataEqualsObject == nil {
            (dataEqualsObject = DataEqualityMemberModel.CreateObject(this))
        } else {
            dataEqualsObject
        }
    )!!

    /// Gets the compiler-owned override of a direct data base's typed equality slot.
    internal prop DataEqualsBase FunctionSymbol? {
        get {
            let directBase TypeSymbol? = DataEqualityMemberModel.GetDirectBase(this, out var importedMethod)
            if directBase == nil {
                return nil
            }
            if !object.ReferenceEquals(dataEqualsBaseOwner, directBase) {
                dataEqualsBase = DataEqualityMemberModel.Create(this, directBase, isOverride: true, importedMethod)
                dataEqualsBaseOwner = directBase
            }
            return dataEqualsBase
        }
    }

    /// Gets a value indicating whether the class was declared with the
    /// `abstract` modifier (ADR-0195 / issue #4674). Unlike the
    /// member-derived (cref:IsAbstract), this is the author's explicit
    /// statement, so a class with no abstract member can still be
    /// uninstantiable (a migrated C# `abstract class` with only concrete
    /// members). Such a class is inheritable: the binder gives it
    /// (cref:IsOpen).
    internal prop IsDeclaredAbstract bool -> IsClass && (Declaration?.IsAbstract ?? false)

    /// Gets a value indicating whether the class was declared with the
    /// `shared` modifier (ADR-0195 / issue #4674): emitted CLR
    /// `abstract sealed` with no instance constructor, every member shared,
    /// the shape of a C# `static class`.
    internal prop IsSharedClass bool -> IsClass && (Declaration?.IsShared ?? false)

    /// Gets a value indicating whether value-struct field initializers require an
    /// in-type constructor for accessibility, generic ownership, or primary
    /// parameter scope. A primary type uses its parameterized constructor.
    /// Definition-bound expressions must execute in their owning generic
    /// context, not in a literal site's unrelated VAR/MVAR scope (#4755).
    /// Imported collection defaults retain their existing CLR literal path;
    /// their owning constructor cannot be synthesized in this compilation.
    internal prop NeedsSynthesizedValueStructDefaultCtor bool -> if Definition != nil && !object.ReferenceEquals(
        Definition,
        this
    ) {
        Definition!!.NeedsSynthesizedValueStructDefaultCtor
    } else {
        ClrType == nil &&
            !IsClass &&
            !IsInline &&
            (
            if IsData {
                NeedsValueStructZeroHelper
            } else {
                !InstanceFieldInitializers.IsEmpty &&
                    (
                    IsGenericDefinition || HasPrimaryConstructor || !CollectEnclosingTypeParameters(
                        this
                    ).IsDefaultOrEmpty ||
                        InstanceFieldInitializers
                        .Keys
                        .Any((member FieldSymbol) -> member.Accessibility != Accessibility.Public)
                )
            }
        )
    }

    /// Gets the hidden literal initializer's marker count when an authored
    /// parameterless constructor must remain distinct. Its total arity exceeds
    /// every authored signature, avoiding a collision without a source overload.
    internal prop LiteralInitializerMarkerCount int32 -> if Definition != nil && !object.ReferenceEquals(
        Definition,
        this
    ) {
        Definition!!.LiteralInitializerMarkerCount
    } else {
        (
            if NeedsSynthesizedValueStructDefaultCtor &&
                (
                NeedsValueStructZeroHelper ||
                    (
                    !HasPrimaryConstructor && ExplicitConstructors.Any(
                        (constructor ConstructorSymbol) -> constructor.Parameters.IsEmpty
                    )
                )
            ) {
                Math.Max(
                    PrimaryConstructorParameters.Length,
                    if ExplicitConstructors.IsDefaultOrEmpty {
                        0
                    } else {
                        ExplicitConstructors.Max((constructor ConstructorSymbol) -> constructor.Parameters.Length)
                    }
                ) +
                    1
            } else {
                0
            }
        )
    }

    /// Gets the definition-owned symbol for the emitted data-class clone slot.
    internal prop DataClassCloneMethod FunctionSymbol {
        get {
            if Definition != nil && !object.ReferenceEquals(Definition, this) {
                return Definition!!.DataClassCloneMethod
            }
            if dataClassCloneMethod != nil {
                return dataClassCloneMethod!!
            }
            let clone = FunctionSymbol(
                "<Clone>$$",
                ImmutableArray[ParameterSymbol].Empty,
                this,
                declaration: nil,
                $package: nil,
                accessibility: Accessibility.Public,
                receiverType: this,
                isOpen: true,
                isOverride: false
            )
            return Interlocked.CompareExchange(&dataClassCloneMethod, clone, nil) ?? clone
        }
    }

    /// Sets (cref:Symbol.ContainingType) (ADR-0110 / issue #910). Intended to be called exactly once by the
    /// binder for a nested type declaration.
    /// @param containingType The enclosing user-defined type.
    func SetContainingType(containingType TypeSymbol) {
        SetContainingTypeCore(containingType)
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetMembers() ImmutableArray[Symbol] {
        let builder = ImmutableArray.CreateBuilder[Symbol]()
        builder.AddRange[FieldSymbol](Fields)
        builder.AddRange[FieldSymbol](StaticFields)
        builder.AddRange[FieldSymbol](ConstFields)
        builder.AddRange[PropertySymbol](Properties)
        builder.AddRange[PropertySymbol](StaticProperties)
        builder.AddRange[FunctionSymbol](GetDeclaredInstanceMethods())
        builder.AddRange[FunctionSymbol](StaticMethods)
        builder.AddRange[EventSymbol](Events)
        builder.AddRange[EventSymbol](StaticEvents)
        return builder.ToImmutable()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetConstructors() ImmutableArray[FunctionSymbol] -> EffectiveExplicitConstructors.Select(
        (constructor ConstructorSymbol) -> constructor.Function
    )
        .ToImmutableArray()

    /// Sets (cref:ImportedBaseType) after binding (issue #296). Intended to be called exactly once by the
    /// binder for a class inheriting an imported CLR base.
    /// @param importedBaseType The imported CLR base type symbol.
    func SetImportedBaseType(importedBaseType TypeSymbol) {
        Volatile.Write(&importedBaseTypeStore, importedBaseType)
    }

    /// Sets (cref:BaseConstructorInitializer) after binding the base-constructor argument list (issue
    /// #306).
    /// @param initializer The resolved base-constructor initializer.
    func SetBaseConstructorInitializer(initializer BaseConstructorInitializer) {
        BaseConstructorInitializer = initializer
    }

    /// Sets (cref:ExplicitConstructor) after binding the class or plain-struct body (issues #306/#2766).
    /// @param constructor The resolved standalone constructor.
    func SetExplicitConstructor(constructor ConstructorSymbol?) {
        ExplicitConstructor = constructor
        ExplicitConstructors = if constructor == nil {
            ImmutableArray[ConstructorSymbol].Empty
        } else {
            ImmutableArray.Create(constructor)
        }
    }

    /// ADR-0063: sets (cref:ExplicitConstructors) (and surfaces the first
    /// declaration as the legacy (cref:ExplicitConstructor)). Intended to
    /// be called exactly once by the binder for an aggregate that declares one or
    /// more `init(...)` constructors.
    /// @param constructors The resolved standalone constructors in declaration order.
    func SetExplicitConstructors(constructors ImmutableArray[ConstructorSymbol]) {
        ExplicitConstructors = if constructors.IsDefault {
            ImmutableArray[ConstructorSymbol].Empty
        } else {
            constructors
        }
        ExplicitConstructor = if ExplicitConstructors.Length == 0 {
            default(ConstructorSymbol?)
        } else {
            ExplicitConstructors[0]
        }
    }

    /// ADR-0068 / issue #698: sets (cref:Deinitializer) after the binder synthesises the `Finalize`
    /// function symbol for a class with a `deinit { … }` body.
    /// @param deinitializer The bound destructor symbol, or `null` to clear.
    func SetDeinitializer(deinitializer DeinitSymbol) {
        Deinitializer = deinitializer
    }

    /// Sets (cref:Interfaces) after binding. Intended to be called exactly once by the binder during
    /// `BindStructDeclaration`.
    /// @param interfaces The interfaces this class implements directly.
    func SetInterfaces(interfaces ImmutableArray[InterfaceSymbol]) {
        Interfaces = interfaces
    }

    /// Issue #973: sets (cref:Fields) and
    /// (cref:PrimaryConstructorParameters) after the symbol shell is
    /// declared. The binder declares every top-level struct/class name (with
    /// empty fields) up front so that field types may forward-reference a user
    /// type declared later in the same compilation, then binds each body and
    /// installs the resolved instance fields and primary-constructor parameters
    /// here. Intended to be called exactly once by the binder during
    /// `BindStructDeclaration`.
    /// @param fields The bound instance field symbols in source order.
    /// @param primaryConstructorParameters The bound primary-constructor parameters, or empty when none
    /// were declared.
    func SetInstanceFieldsAndPrimaryConstructorParameters(
        fields ImmutableArray[FieldSymbol],
        primaryConstructorParameters ImmutableArray[ParameterSymbol]
    ) {
        Fields = fields
        PrimaryConstructorParameters = primaryConstructorParameters
    }

    /// Issue #949: sets (cref:BaseClass) after the symbol is constructed.
    /// The symbol is created before its base-type clause is bound so that a
    /// class may reference itself as a generic type argument in its own base
    /// clause (e.g. `class Shape : IEquatable[Shape]`); the resolved base
    /// class is then installed here once the clause has been bound. Intended to
    /// be called exactly once by the binder during `BindStructDeclaration`.
    /// @param baseClass The resolved base class symbol, or `null`.
    func SetBaseClass(baseClass StructSymbol?) {
        Volatile.Write(&baseClassStore, baseClass)
    }

    /// Issue #525: sets (cref:ImplementedClrInterfaces) after binding
    /// the base-type clause. Intended to be called exactly once by the binder
    /// for a class whose base-type clause names one or more imported CLR
    /// interfaces.
    /// @param interfaces The imported CLR interface types this class implements directly.
    func SetImplementedClrInterfaces(interfaces ImmutableArray[TypeSymbol]) {
        ImplementedClrInterfaces = if interfaces.IsDefault {
            ImmutableArray[TypeSymbol].Empty
        } else {
            interfaces
        }
    }

    /// Sets (cref:Methods) after binding class-body methods.
    /// @param methods The bound method symbols owned by this type.
    func SetMethods(methods ImmutableArray[FunctionSymbol]) {
        Methods = methods
    }

    /// Sets (cref:Properties) after binding property declarations (ADR-0051).
    /// @param properties The bound property symbols owned by this type.
    func SetProperties(properties ImmutableArray[PropertySymbol]) {
        Properties = properties
    }

    /// Sets (cref:Events) after binding event declarations (ADR-0052).
    /// @param events The bound event symbols owned by this type.
    func SetEvents(events ImmutableArray[EventSymbol]) {
        Events = events
    }

    /// Sets (cref:StaticFields) after binding shared-block field declarations (ADR-0053).
    /// @param fields The bound static field symbols owned by this type.
    func SetStaticFields(fields ImmutableArray[FieldSymbol]) {
        StaticFields = fields
    }

    /// Sets (cref:ConstFields) after binding `const` field declarations (Issue #948).
    /// @param fields The bound const field symbols owned by this type.
    func SetConstFields(fields ImmutableArray[FieldSymbol]) {
        ConstFields = fields
    }

    /// Sets (cref:StaticMethods) after binding shared-block method declarations (ADR-0053).
    /// @param methods The bound static method symbols owned by this type.
    func SetStaticMethods(methods ImmutableArray[FunctionSymbol]) {
        StaticMethods = methods
    }

    /// Sets (cref:StaticProperties) after binding shared-block property declarations (ADR-0053).
    /// @param properties The bound static property symbols owned by this type.
    func SetStaticProperties(properties ImmutableArray[PropertySymbol]) {
        StaticProperties = properties
    }

    /// Sets (cref:StaticEvents) after binding shared-block event declarations (ADR-0053).
    /// @param events The bound static event symbols owned by this type.
    func SetStaticEvents(events ImmutableArray[EventSymbol]) {
        StaticEvents = events
    }

    /// Sets (cref:StaticFieldInitializers) after binding shared-block field initializers (Issue #262).
    /// @param initializers A mapping from field symbol to its bound initializer expression.
    func SetStaticFieldInitializers(initializers ImmutableDictionary[FieldSymbol, BoundExpression]) {
        StaticFieldInitializers = initializers
    }

    /// Sets (cref:InstanceFieldInitializers) after binding instance-field initializers (Issue #640).
    /// @param initializers A mapping from field symbol to its bound initializer expression.
    func SetInstanceFieldInitializers(initializers ImmutableDictionary[FieldSymbol, BoundExpression]) {
        InstanceFieldInitializers = initializers
    }

    /// Sets (cref:StaticInitializerStatements) after binding the type's `shared { init { … } }` block(s)
    /// (ADR-0140 / issue #2131).
    /// @param statements The bound, lowered statements concatenated in source order.
    func SetStaticInitializerStatements(statements ImmutableArray[BoundStatement]) {
        StaticInitializerStatements = statements
    }

    /// Tries to find a static field by name on this type (ADR-0053).
    /// @param name The field name.
    /// @param field The found static field on success.
    /// @returns True if found.
    func TryGetStaticField(name string, @NotNullWhen(true) out field FieldSymbol?) bool {
        if !StaticFields.IsDefaultOrEmpty {
            for f in StaticFields {
                if f.Name == name {
                    field = f
                    return true
                }
            }
        }
        // Issue #948: const fields are static for lookup purposes (accessed as
        // `Type.Name`), even though they are emitted as literal fields.
        if !ConstFields.IsDefaultOrEmpty {
            for f in ConstFields {
                if f.Name == name {
                    field = f
                    return true
                }
            }
        }
        field = nil
        return false
    }

    /// Tries to find a static method by name on this type (ADR-0053).
    /// @param name The method name.
    /// @param method The found static method on success.
    /// @returns True if found.
    func TryGetStaticMethod(name string, @NotNullWhen(true) out method FunctionSymbol?) bool {
        if !StaticMethods.IsDefaultOrEmpty {
            for m in StaticMethods {
                if m.Name == name {
                    method = m
                    return true
                }
            }
        }
        method = nil
        return false
    }

    /// Appends additional methods after the initial declaration binding pass.
    /// @param methods The receiver-clause methods to append.
    func AddMethods(methods ImmutableArray[FunctionSymbol]) {
        if methods.IsDefaultOrEmpty {
            return
        }
        Methods = if Methods.IsDefaultOrEmpty {
            methods
        } else {
            Methods.AddRange(methods)
        }
    }

    /// Removes methods a lowering pass attached earlier with
    /// (cref:AddMethods), so a pass that runs again over the same bound
    /// symbol (a repeated `Compilation.Emit`) can replace them instead of
    /// accumulating a second copy.
    /// @param methods The methods to remove; any not present are ignored.
    func RemoveMethods(methods IEnumerable[FunctionSymbol]) {
        if Methods.IsDefaultOrEmpty {
            return
        }
        var remaining = Methods
        for method in methods {
            remaining = remaining.Remove(method)
        }
        Methods = remaining
    }

    /// Appends additional static methods after the initial declaration binding pass (issue #1017:
    /// user-defined conversion operators declared at top level).
    /// @param methods The static methods to append.
    func AddStaticMethods(methods ImmutableArray[FunctionSymbol]) {
        if methods.IsDefaultOrEmpty {
            return
        }
        StaticMethods = if StaticMethods.IsDefaultOrEmpty {
            methods
        } else {
            StaticMethods.AddRange(methods)
        }
    }

    /// Sets (cref:TypeParameters) on a generic definition (Phase 4.3 / ADR-0020). Intended to be called
    /// once by the binder during `BindStructDeclaration` before any constructed instance is materialized.
    /// @param typeParameters The bound type parameters in declared order.
    func SetTypeParameters(typeParameters ImmutableArray[TypeParameterSymbol]) {
        TypeParameters = typeParameters
    }

    /// Issue #1477: records the ordered original enclosing type parameters that
    /// this synthesized closure / capture-box class's fresh type parameters
    /// clone 1:1 (see (cref:ReifiedFromTypeParameters)). Called once at
    /// synthesis time alongside (cref:SetTypeParameters).
    /// @param reifiedFrom The original enclosing type parameters.
    /// @param ordinalOffset The first corresponding ordinal in (cref:TypeParameters).
    func SetReifiedFromTypeParameters(reifiedFrom ImmutableArray[TypeParameterSymbol], ordinalOffset int32 = 0) {
        ReifiedFromTypeParameters = reifiedFrom
        ReifiedTypeParameterOrdinalOffset = ordinalOffset
    }

    /// Marks the reified parameter vector as complete for nested-type emission.
    func MarkCompleteReifiedTypeParameterVector() -> HasCompleteReifiedTypeParameterVector = true

    /// Marks this class as an `@Attribute`-sugar attribute type per
    /// ADR-0047 §5. Intended to be called once by the binder after
    /// (cref:Symbol.SetAttributes) when the bound annotation list
    /// contains the `@Attribute` marker.
    func SetIsAttributeClass() {
        IsAttributeClass = true
    }

    /// Issue #1921: returns true when this class is — or transitively
    /// derives from — (cref:System.Attribute), whether reached via
    /// the `@Attribute` declaration sugar ((cref:IsAttributeClass))
    /// or an explicit `: Attribute` / `: System.Attribute` base
    /// clause naming the imported CLR type. Same-compilation user classes
    /// have no (cref:TypeSymbol.ClrType) until emitted, so a naive
    /// CLR base-chain walk on this type alone can't see it; this walks the
    /// symbol-level (cref:BaseClass) chain instead, falling back to
    /// the CLR chain only once an (cref:ImportedBaseType) is reached.
    /// @returns `true` when this class is or derives from (cref:System.Attribute).
    func DerivesFromSystemAttribute() bool {
        for current in GetHierarchy() {
            if current.IsAttributeClass {
                return true
            }
            if current.ImportedBaseType != nil {
                let clr = current.ImportedBaseType!!.ClrType
                for var t Type? = clr; t != nil; t = t!!.BaseType {
                    if t.FullName == typeof(Attribute).FullName {
                        return true
                    }
                }
                return false
            }
        }
        return false
    }

    /// Sets the resolved (cref:LayoutMetadata). Intended to be
    /// called once by the binder after attributes have been bound; the
    /// (cref:StructLayoutBinder) helper writes the resolved
    /// metadata onto the symbol so the emitter can consume it. ADR-0093
    /// / issue #759.
    /// @param metadata The validated layout metadata.
    func SetLayoutMetadata(metadata StructLayoutMetadata) {
        LayoutMetadata = metadata
    }

    /// Marks this struct as a fixed-size buffer backing struct (ADR-0122 §10 / issue #1035).
    /// @param elementType The buffer element type `T`.
    func MarkFixedBufferBacking(elementType TypeSymbol) {
        IsFixedBufferBacking = true
        FixedBufferElementType = elementType
    }

    /// Looks up a method by name on this class or any ancestor (this-first).
    /// @param name The method name.
    /// @param method The found method on success.
    /// @returns True if found.
    func TryGetMethodIncludingInherited(name string, @NotNullWhen(true) out method FunctionSymbol?) bool {
        for c in GetHierarchy() {
            if c.TryGetMethod(name, out method) {
                return true
            }
        }
        method = nil
        return false
    }

    /// Tries to find a method by name on this class.
    /// @param name The method name.
    /// @param method The found method on success.
    /// @returns True if found.
    func TryGetMethod(name string, @NotNullWhen(true) out method FunctionSymbol?) bool {
        if !Methods.IsDefaultOrEmpty {
            for m in Methods {
                if m.Name == name {
                    method = m
                    return true
                }
            }
        }
        if IsData && ClrType == nil && name == "Equals" {
            method = DataEqualsSelf
            return true
        }
        method = nil
        return false
    }

    /// ADR-0063: returns every instance method whose name equals [`name`](paramref) (the overload set).
    /// @param name The method name.
    /// @returns The overload set; empty if none.
    func GetMethods(name string) ImmutableArray[FunctionSymbol] {
        let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        for m in GetDeclaredInstanceMethods() {
            if m.Name == name {
                builder.Add(m)
            }
        }
        return builder.ToImmutable()
    }

    /// ADR-0063: returns every method named [`name`](paramref) visible on this
    /// class, walking the inheritance chain this-first. Derived methods that share
    /// a signature with a base method (i.e. real overrides) hide the base entry so
    /// the overload set surfaced to overload resolution contains exactly one
    /// FunctionSymbol per visible signature.
    /// @param name The method name.
    /// @returns The merged overload set; empty if none found.
    func GetMethodsIncludingInherited(name string) ImmutableArray[FunctionSymbol] {
        var builder ImmutableArray[FunctionSymbol].Builder? = nil
        for c in GetHierarchy() {
            for m in c.GetMethods(name) {
                if m.Name != name {
                    continue
                }
                if builder != nil {
                    var hiddenByDerived = false
                    for existing in builder {
                        if BoundScope.FunctionSignaturesEqual(existing, m) &&
                            ExplicitInterfaceClauseTargetsMatch(existing, m) {
                            hiddenByDerived = true
                            break
                        }
                    }
                    if hiddenByDerived {
                        continue
                    }
                }
                builder ??= ImmutableArray.CreateBuilder[FunctionSymbol]()
                builder!!.Add(m)
            }
        }
        return if builder == nil {
            ImmutableArray[FunctionSymbol].Empty
        } else {
            builder.ToImmutable()
        }
    }

    /// Issue #987: enumerates the unimplemented abstract methods this class would
    /// inherit — i.e. every method in the effective member set (own + inherited,
    /// after override resolution) that is still (cref:FunctionSymbol.IsAbstract).
    /// A concrete (non-`open`) class with a non-empty result fails to satisfy
    /// its abstract base contract.
    ///
    /// Issue #1055: when a base is inherited as a CONSTRUCTED generic (e.g.
    /// `Derived : Base[int32]`), an abstract base method whose signature uses
    /// the base's type parameters is satisfied by an override whose CONCRETE
    /// signature matches the substituted base signature. The substitution is
    /// composed across every hop of the inheritance chain so multi-level
    /// constructions (`Leaf : Mid[int32] : Base[T]`) resolve correctly.
    /// @returns The set of still-abstract effective methods; empty when none.
    func GetUnimplementedAbstractMethods() ImmutableArray[FunctionSymbol] {
        if !IsClass {
            return ImmutableArray[FunctionSymbol].Empty
        }
        // Capture each class along the chain (most-derived first) together with the
        // substitution that maps its declaration's type parameters onto the concrete
        // type arguments seen in THIS class's context. A deeper base's type arguments
        // are expressed in terms of a shallower base's type parameters, so resolving
        // each argument through the running map composes the substitution across hops.
        let levels = List[(Cls StructSymbol, Subst Dictionary[TypeParameterSymbol, TypeSymbol]?)]()
        var running Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
        for c in GetHierarchy() {
            if c.Definition != nil &&
                !c
                .TypeArguments
                .IsDefaultOrEmpty &&
                !c.Definition!!
                .TypeParameters
                .IsDefaultOrEmpty {
                let defParams = c.Definition!!.TypeParameters
                let count = Math.Min(defParams.Length, c.TypeArguments.Length)
                for var i = 0; i < count; i++ {
                    var arg = c.TypeArguments[i]
                    if arg is TypeParameterSymbol tpArg && running != nil && running.TryGetValue(
                        tpArg,
                        out var resolved
                    ) {
                        arg = resolved
                    }
                    running ??= Dictionary[TypeParameterSymbol, TypeSymbol]()
                    running!![defParams[i]] = arg
                }
            }
            levels.Add(
                (
                    c,
                    if running == nil {
                        default(Dictionary[TypeParameterSymbol, TypeSymbol]?)
                    } else {
                        Dictionary[TypeParameterSymbol, TypeSymbol](running)
                    }
                )
            )
        }
        var builder ImmutableArray[FunctionSymbol].Builder? = nil
        for var k = 0; k < levels.Count; k++ {
            let (cls, subst) = levels[k]
            if cls.Methods.IsDefaultOrEmpty {
                continue
            }
            for abstractMethod in cls.Methods {
                if !abstractMethod.IsAbstract {
                    continue
                }
                // Implemented when a strictly more-derived class declares a
                // non-abstract method whose concrete signature matches the
                // abstract base method's signature after substitution.
                var implemented = false
                for var kk = 0; kk < k && !implemented; kk++ {
                    let derivedCls = levels[kk].Cls
                    if derivedCls.Methods.IsDefaultOrEmpty {
                        continue
                    }
                    let candidateSubst = levels[kk].Subst
                    for candidate in derivedCls.Methods {
                        if candidate.IsAbstract {
                            continue
                        }
                        if AbstractMethodSatisfiedBy(abstractMethod, subst, candidate, candidateSubst) {
                            implemented = true
                            break
                        }
                    }
                }
                if !implemented {
                    builder ??= ImmutableArray.CreateBuilder[FunctionSymbol]()
                    builder!!.Add(abstractMethod)
                }
            }
        }
        return if builder == nil {
            ImmutableArray[FunctionSymbol].Empty
        } else {
            builder.ToImmutable()
        }
    }

    /// ADR-0063: returns every shared/static method whose name equals [`name`](paramref) (the overload
    /// set).
    /// @param name The method name.
    /// @returns The overload set; empty if none.
    func GetStaticMethods(name string) ImmutableArray[FunctionSymbol] {
        if StaticMethods.IsDefaultOrEmpty {
            return ImmutableArray[FunctionSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        for m in StaticMethods {
            if m.Name == name {
                builder.Add(m)
            }
        }
        return builder.ToImmutable()
    }

    /// Tries to find a field by name.
    /// @param name The field name.
    /// @param field The found field on success.
    /// @returns True if found.
    func TryGetField(name string, @NotNullWhen(true) out field FieldSymbol?) bool {
        for f in Fields {
            if f.Name == name {
                field = f
                return true
            }
        }
        field = nil
        return false
    }

    /// Looks up a field by name on this class or any ancestor (this-first). Phase 3.B.3 sub-step 3.
    /// @param name The field name.
    /// @param field The found field on success.
    /// @param declaringType The class that actually declares the field.
    /// @returns True if found.
    func TryGetFieldIncludingInherited(
        name string,
        @NotNullWhen(true) out field FieldSymbol?,
        @NotNullWhen(true) out declaringType StructSymbol?
    ) bool {
        for c in GetHierarchy() {
            if c.TryGetField(name, out field) {
                declaringType = c
                return true
            }
        }
        field = nil
        declaringType = nil
        return false
    }

    /// Walks this type and its base-class chain looking for a constructed
    /// generic ancestor whose definition satisfies
    /// [`declaringDefinitionPredicate`](paramref). The returned symbol
    /// carries fully-resolved type arguments in this type's context.
    /// @remarks (cref:BaseClass) projects each inheritance hop through the
    /// receiver's simultaneous substitution, including nested argument types.
    /// Keep that construction unchanged: substituting again can collapse swapped
    /// parameters or substitute an outer parameter twice (issue #5092).
    /// Returns `null` when no matching generic base exists.
    /// The walk includes the receiver itself.
    /// @param declaringDefinitionPredicate Predicate matched against each ancestor's definition (or itself
    /// when non-generic).
    /// @returns The constructed generic base instantiation, or null.
    func FindConstructedGenericBase(declaringDefinitionPredicate((StructSymbol) -> bool)?) StructSymbol? {
        if declaringDefinitionPredicate == nil {
            return nil
        }
        for c in GetHierarchy() {
            let cDef = c.Definition ?? c
            if !declaringDefinitionPredicate(cDef) {
                continue
            }
            if c.IsConstructedNestedType || (c.Definition != nil && !c.TypeArguments.IsDefaultOrEmpty) {
                return c
            }
            if cDef.TypeParameters.IsDefaultOrEmpty {
                continue
            }
            let tps = cDef.TypeParameters
            let args = ImmutableArray.CreateBuilder[TypeSymbol](tps.Length)
            args.AddRange[TypeParameterSymbol](tps)
            return Construct(cDef, args.MoveToImmutable())!!
        }
        return nil
    }

    /// Gets the parameter types of [`constructor`](paramref) in this
    /// construction, substituting both enclosing and own type arguments through
    /// the same member-type projection used by fields and properties.
    /// @param constructor A constructor drawn from (cref:EffectiveExplicitConstructors).
    /// @returns The (substituted, when constructed) parameter types in declaration order.
    func GetConstructorParameterTypesForConstruction(constructor ConstructorSymbol) ImmutableArray[TypeSymbol] {
        let parameters = constructor.Parameters
        if parameters.IsDefaultOrEmpty {
            return ImmutableArray[TypeSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](parameters.Length)
        for p in parameters {
            builder.Add(SubstituteMemberType(p.Type)!!)
        }
        return builder.MoveToImmutable()
    }

    /// Gets the abstract source property accessors left unimplemented by actual overrides.
    /// @returns The owning types, properties and required accessor kinds.
    internal func GetUnimplementedAbstractPropertyAccessors() ImmutableArray[
        (Owner StructSymbol, Property PropertySymbol, IsGetter bool)
    ] {
        let result = ImmutableArray.CreateBuilder[(Owner StructSymbol, Property PropertySymbol, IsGetter bool)]()
        let effectiveAccessors = Dictionary[(Slot object, IsGetter bool), bool]()
        let requirements = HashSet[(Slot object, IsGetter bool)]()
        for owner in GetHierarchy() {
            for property in owner.Properties {
                var slot = property
                while slot.OverriddenProperty is {} overridden {
                    slot = overridden
                }
                // Constructed projections share the declaring syntax, not the
                // property object. Hiding declarations start distinct slots.
                let slotIdentity object = if slot.Declaration is {} declaration {
                    cast[object](declaration)
                } else {
                    cast[object](slot)
                }
                let Check = func (isGetter bool) {
                    let key = (slotIdentity, isGetter)
                    if property.IsOverride || property.IsAbstract {
                        effectiveAccessors.TryAdd(key, !property.IsAbstract)
                    }
                    if property.IsAbstract && requirements.Add(key) && !effectiveAccessors[key] {
                        result.Add((owner, property, isGetter))
                    }
                }
                if property.HasGetter {
                    Check(isGetter: true)
                }
                if property.HasSetter {
                    Check(isGetter: false)
                }
            }
        }
        return result.ToImmutable()
    }

    /// Gets declared source or imported instance methods, including compiler-owned data slots.
    /// @returns The declared instance method set.
    internal func GetDeclaredInstanceMethods() ImmutableArray[FunctionSymbol] {
        if !IsData || ClrType != nil {
            return Methods
        }
        let builder = Methods.ToBuilder()
        builder.Add(DataEqualsSelf)
        if DataEqualsBase is {} baseEquals {
            builder.Add(baseEquals)
        }
        builder.Add(DataEqualsObject)
        if DataPrintMembers is {} printMembers {
            builder.Add(printMembers)
        }
        return builder.ToImmutable()
    }

    /// Gets the nearest base class that declares the synthesized data-class
    /// clone slot, skipping non-data intermediary classes.
    /// @returns The nearest data-class ancestor, or null when none exists.
    internal func GetDataCloneAncestor() StructSymbol? {
        let chain = GetHierarchy()
        for var level = 1; level < chain.Count; level++ {
            let ancestor = chain[level]
            if ancestor.IsData {
                return ancestor
            }
        }
        return nil
    }

    /// ADR-0105 Phase 2 — re-points this (reused) struct symbol at the
    /// declaration node of a freshly-parsed syntax tree whose declaration is
    /// byte-identical to the previous one (a body-only edit). Only the backing
    /// syntax — and therefore source spans — changes; the symbol's identity is
    /// preserved so cross-compilation reuse stays sound. Intended to be called
    /// only by (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration StructDeclarationSyntax) {
        Declaration = declaration
    }

    /// Substitutes this constructed type's arguments through a member type
    /// declared on its generic definition.
    /// @param type The open member type to close.
    /// @returns The member type in this construction's context.
    @return: NotNullIfNotNull("type")
    internal func SubstituteMemberType(type TypeSymbol?) TypeSymbol? {
        if type == nil || Definition == nil || object.ReferenceEquals(Definition, this) {
            return type
        }
        return SubstituteTypeForConstruction(type, GetSubstitutionMap(), mapClrType)
    }

    /// Resolves a bound instance field to its definition-owned identity.
    /// @param field The field in this declaring construction.
    /// @returns The corresponding declared field, or null for storage outside the field list.
    internal func GetDefinitionField(field FieldSymbol) FieldSymbol? {
        let index = Fields.IndexOf(field)
        return if index < 0 {
            default(FieldSymbol?)
        } else {
            Definition!!.Fields[index]
        }
    }

    /// Gets this class and every ancestor along its (cref:BaseClass)
    /// chain, most-derived first.
    /// @remarks Issue #4162 / #4164: a genuine base-class cycle (e.g. `class B : C`
    /// / `class C : B`) is normally caught by the post-bind cycle
    /// detector (#973), but this walk can run earlier — during declaration
    /// binding, before that detector has run — from several independent call
    /// sites (an annotation naming a cyclic type via
    /// (cref:DerivesFromSystemAttribute); an `override` member
    /// whose base-member lookup walks the hierarchy). Without a visited
    /// guard, a cyclic (cref:BaseClass) chain makes this loop forever,
    /// growing the list without bound until the process OOMs. `visited.Add`
    /// returning false on a repeat both detects the cycle and stops the
    /// walk; the returned (truncated) hierarchy is still correct for every
    /// acyclic caller since it only ever omits nodes that would otherwise
    /// repeat.
    ///
    /// Internal rather than private: this is the single guarded walk of the
    /// symbol-level (cref:BaseClass) chain, shared by every caller
    /// that used to keep its own unguarded copy (`TypeMemberModel`,
    /// `ExternalClrOverrideResolver`) so a fix here cannot be
    /// independently missed by a sibling copy again.
    /// @returns This class and its ancestors, most-derived first.
    internal func GetHierarchy() List[StructSymbol] {
        let hierarchy = List[StructSymbol]()
        let visited = HashSet[StructSymbol]()
        var current StructSymbol? = this
        while current != nil && visited.Add(current) {
            hierarchy.Add(current)
            current = current.BaseClass
        }
        return hierarchy
    }

    // Issue #1341: builds (once) the type-parameter -> type-argument map used to
    // substitute the definition's instance-member types for this constructed
    // instance. Generic definitions are immutable in their type parameters and
    // a construction's type arguments are fixed, so the map is cached.
    private func GetSubstitutionMap() Dictionary[TypeParameterSymbol, TypeSymbol] {
        let existing Dictionary[TypeParameterSymbol, TypeSymbol]? = Volatile.Read(&substitutionMap)
        if existing != nil {
            return existing
        }
        let def = Definition
        let map_ = Dictionary[TypeParameterSymbol, TypeSymbol](
            if def!!.TypeParameters.IsDefaultOrEmpty {
                0
            } else {
                def!!.TypeParameters.Length
            }
        )
        // Issue #1537: for a constructed nested-generic reference the emitter
        // re-ordinalizes the definition's TypeParameters over the flattened
        // enclosing+own list, so use the own parameters captured at construction
        // time to pair with TypeArguments. For every other constructed instance
        // the definition's TypeParameters are the own parameters.
        let ownParams = if !nestedOwnTypeParameters.IsDefaultOrEmpty {
            nestedOwnTypeParameters
        } else {
            def!!.TypeParameters
        }
        if !ownParams.IsDefaultOrEmpty && !TypeArguments.IsDefaultOrEmpty {
            let count = Math.Min(ownParams.Length, TypeArguments.Length)
            for var i = 0; i < count; i++ {
                map_[ownParams[i]] = TypeArguments[i]
            }
        }
        // Issue #1521: a constructed reference to a type nested inside a generic
        // enclosing type carries the enclosing construction's arguments on
        // EnclosingTypeArguments and declares no own type parameters. Its member
        // types mention the ENCLOSING type's parameters, so key the substitution
        // by the flattened enclosing parameters (outermost first) so a member
        // typed as an enclosing parameter (`Tag.V : T`) surfaces closed
        // (`int32`) on the construction (`Box[int32].Tag`).
        if !EnclosingTypeArguments.IsDefaultOrEmpty {
            let enclosingParams = CollectEnclosingTypeParameters(this)
            let count = Math.Min(enclosingParams.Length, EnclosingTypeArguments.Length)
            for var i = 0; i < count; i++ {
                map_[enclosingParams[i]] = EnclosingTypeArguments[i]
            }
        }
        return Interlocked.CompareExchange(&substitutionMap, map_, nil) ?? map_
    }

    private func GetSubstitutedBaseClass() StructSymbol? {
        let source StructSymbol? = Definition!!.BaseClass
        let snapshot BaseClassSnapshot? = Volatile.Read(&substitutedBaseClass)
        if snapshot != nil && object.ReferenceEquals(snapshot.Source, source) {
            return snapshot.Value
        }
        let value = if source == nil {
            default(StructSymbol?)
        } else {
            SubstituteTypeForConstruction(source, GetSubstitutionMap(), mapClrType) as StructSymbol
        }
        Volatile.Write(&substitutedBaseClass, BaseClassSnapshot(source, value))
        return value
    }

    private func GetSubstitutedPrimaryConstructorParameters() ImmutableArray[ParameterSymbol] {
        let source = Definition!!.PrimaryConstructorParameters
        let snapshot ParameterArraySnapshot? = Volatile.Read(&substitutedPrimaryConstructorParameters)
        if snapshot != nil && snapshot.Source.Equals(source) {
            return snapshot.Value
        }
        var value ImmutableArray[ParameterSymbol]
        if source.IsDefaultOrEmpty {
            value = source
        } else {
            let builder = ImmutableArray.CreateBuilder[ParameterSymbol](source.Length)
            for parameter in source {
                let substituted = ParameterSymbol(
                    parameter,
                    SubstituteTypeForConstruction(parameter.Type, GetSubstitutionMap(), mapClrType)
                )
                if parameter.HasExplicitDefaultValue {
                    substituted.SetExplicitDefaultValue(parameter.ExplicitDefaultValue)
                }
                builder.Add(substituted)
            }
            value = builder.MoveToImmutable()
        }
        Volatile.Write(&substitutedPrimaryConstructorParameters, ParameterArraySnapshot(source, value))
        return value
    }

    private func GetSubstitutedInterfaces() ImmutableArray[InterfaceSymbol] {
        let source = Definition!!.Interfaces
        let snapshot InterfaceArraySnapshot? = Volatile.Read(&substitutedInterfaces)
        if snapshot != nil && snapshot.Source.Equals(source) {
            return snapshot.Value
        }
        var value ImmutableArray[InterfaceSymbol]
        if source.IsDefaultOrEmpty {
            value = source
        } else {
            let builder = ImmutableArray.CreateBuilder[InterfaceSymbol](source.Length)
            for iface in source {
                builder.Add(
                    cast[InterfaceSymbol](SubstituteTypeForConstruction(iface, GetSubstitutionMap(), mapClrType))
                )
            }
            value = builder.MoveToImmutable()
        }
        Volatile.Write(&substitutedInterfaces, InterfaceArraySnapshot(source, value))
        return value
    }

    private func GetSubstitutedImplementedClrInterfaces() ImmutableArray[TypeSymbol] {
        let source = Definition!!.ImplementedClrInterfaces
        let snapshot TypeArraySnapshot? = Volatile.Read(&substitutedImplementedClrInterfaces)
        if snapshot != nil && snapshot.Source.Equals(source) {
            return snapshot.Value
        }
        var value ImmutableArray[TypeSymbol]
        if source.IsDefaultOrEmpty {
            value = source
        } else {
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](source.Length)
            for iface in source {
                builder.Add(SubstituteTypeForConstruction(iface, GetSubstitutionMap(), mapClrType))
            }
            value = builder.MoveToImmutable()
        }
        Volatile.Write(&substitutedImplementedClrInterfaces, TypeArraySnapshot(source, value))
        return value
    }

    private func GetSubstitutedImportedBaseType() TypeSymbol? {
        let source TypeSymbol? = Definition!!.ImportedBaseType
        // Most constructed types have no imported CLR base (they derive from
        // another G# class or System.Object): short-circuit before touching
        // the snapshot cache or SubstituteTypeForConstruction, both of which
        // operate on a non-null source type.
        if source == nil {
            return nil
        }
        let snapshot TypeSnapshot? = Volatile.Read(&substitutedImportedBaseType)
        if snapshot != nil && object.ReferenceEquals(snapshot.Source, source) {
            return snapshot.Value
        }
        let value = SubstituteTypeForConstruction(source, GetSubstitutionMap(), mapClrType)
        Volatile.Write(&substitutedImportedBaseType, TypeSnapshot(source, value))
        return value
    }

    // Issue #1341: lazily substitutes the definition's instance fields for this
    // constructed instance, memoized against the definition's current field
    // array. The array is replaced (by reference) exactly when the definition's
    // body is bound, so reading after that point recomputes the substitution —
    // making member lookup independent of the order the definition is bound.
    private func GetSubstitutedFields() ImmutableArray[FieldSymbol] {
        let source = Definition!!.Fields
        if substitutedFieldsComputed && substitutedFieldsSource.Equals(source) {
            return substitutedFields
        }
        let subst = GetSubstitutionMap()
        var result ImmutableArray[FieldSymbol]
        if source.IsDefaultOrEmpty || subst.Count == 0 {
            result = source
        } else {
            let builder = ImmutableArray.CreateBuilder[FieldSymbol](source.Length)
            for f in source {
                let newType = SubstituteTypeForConstruction(f.Type, subst, mapClrType)
                if object.ReferenceEquals(newType, f.Type) {
                    builder.Add(f)
                    continue
                }
                let substituted = FieldSymbol(
                    f.Name,
                    newType,
                    f.Accessibility,
                    f.IsReadOnly,
                    f.IsStatic,
                    f.IsConst,
                    f.IsEventBackingField,
                    f.Declaration
                )
                if f.IsConst {
                    substituted.SetConstantValue(f.ConstantValue)
                }
                if f.ExplicitOffset is int32 offset {
                    substituted.SetExplicitOffset(offset)
                }
                if f.IsFixedBuffer {
                    // FixedBufferElementType is always non-null when IsFixedBuffer is
                    // true: FieldSymbol.SetFixedBuffer sets both together from its
                    // non-nullable `elementType` parameter (FieldSymbol.cs).
                    substituted.SetFixedBuffer(
                        SubstituteTypeForConstruction(f.FixedBufferElementType!!, subst, mapClrType),
                        f.FixedBufferLength
                    )
                }
                builder.Add(substituted)
            }
            result = builder.MoveToImmutable()
        }
        substitutedFields = result
        substitutedFieldsSource = source
        substitutedFieldsComputed = true
        return result
    }

    // Issue #1341: lazily substitutes the definition's instance properties for
    // this constructed instance, memoized against the definition's current
    // property array (see GetSubstitutedFields for the ordering rationale).
    private func GetSubstitutedProperties() ImmutableArray[PropertySymbol] {
        let source = Definition!!.Properties
        if substitutedPropertiesComputed && substitutedPropertiesSource.Equals(source) {
            return substitutedProperties
        }
        let result = SubstituteProperties(source, GetSubstitutionMap(), mapClrType)
        substitutedProperties = result
        substitutedPropertiesSource = source
        substitutedPropertiesComputed = true
        return result
    }

    // Issue #1341: lazily substitutes the definition's static properties for this
    // constructed instance, memoized against the definition's current static
    // property array (see GetSubstitutedFields for the ordering rationale).
    private func GetSubstitutedStaticProperties() ImmutableArray[PropertySymbol] {
        let source = Definition!!.StaticProperties
        if substitutedStaticPropertiesComputed && substitutedStaticPropertiesSource.Equals(source) {
            return substitutedStaticProperties
        }
        let result = SubstituteProperties(source, GetSubstitutionMap(), mapClrType)
        substitutedStaticProperties = result
        substitutedStaticPropertiesSource = source
        substitutedStaticPropertiesComputed = true
        return result
    }

    private class BaseClassSnapshot {
        init(source StructSymbol?, value StructSymbol?) {
            Source = source
            Value = value
        }

        prop Source StructSymbol? {
            get;
        }

        prop Value StructSymbol? {
            get;
        }
    }

    private class ParameterArraySnapshot {
        init(source ImmutableArray[ParameterSymbol], value ImmutableArray[ParameterSymbol]) {
            Source = source
            Value = value
        }

        prop Source ImmutableArray[ParameterSymbol] {
            get;
        }

        prop Value ImmutableArray[ParameterSymbol] {
            get;
        }
    }

    private class InterfaceArraySnapshot {
        init(source ImmutableArray[InterfaceSymbol], value ImmutableArray[InterfaceSymbol]) {
            Source = source
            Value = value
        }

        prop Source ImmutableArray[InterfaceSymbol] {
            get;
        }

        prop Value ImmutableArray[InterfaceSymbol] {
            get;
        }
    }

    private class TypeArraySnapshot {
        init(source ImmutableArray[TypeSymbol], value ImmutableArray[TypeSymbol]) {
            Source = source
            Value = value
        }

        prop Source ImmutableArray[TypeSymbol] {
            get;
        }

        prop Value ImmutableArray[TypeSymbol] {
            get;
        }
    }

    private class TypeSnapshot {
        init(source TypeSymbol, value TypeSymbol) {
            Source = source
            Value = value
        }

        prop Source TypeSymbol {
            get;
        }

        prop Value TypeSymbol {
            get;
        }
    }

    shared {
        private let ConstructedCache ConcurrentDictionary[
            (Def StructSymbol, ArgsKey TypeArgsKey),
            StructSymbol
        ] = ConcurrentDictionary[(Def StructSymbol, ArgsKey TypeArgsKey), StructSymbol]()

        // Issue #1521: identity cache for constructed references to types nested
        // inside a generic enclosing type (`Box[int32].Tag`), keyed by the nested
        // definition and the flattened enclosing type-argument vector so two
        // references to the same construction share one symbol (preserving
        // reference equality and TypeSpec caching in the emitter).
        private let ConstructedNestedCache ConcurrentDictionary[
            (Def StructSymbol, ArgsKey TypeArgsKey),
            StructSymbol
        ] = ConcurrentDictionary[(Def StructSymbol, ArgsKey TypeArgsKey), StructSymbol]()

        // Issue #1537: identity cache for constructed references to a GENERIC type
        // nested inside a generic enclosing type (`Outer[int32].Middle[string]`),
        // keyed by the nested definition, the flattened enclosing type-argument
        // vector, and the nested type's own type-argument vector. Distinct from
        // ConstructedNestedCache (which keys only the enclosing args for a nested
        // type with no own parameters) so the two representations never collide.
        private let ConstructedNestedGenericCache ConcurrentDictionary[
            (Def StructSymbol, EnclosingKey TypeArgsKey, OwnKey TypeArgsKey),
            StructSymbol
        ] = ConcurrentDictionary[(Def StructSymbol, EnclosingKey TypeArgsKey, OwnKey TypeArgsKey), StructSymbol]()

        private let EmptyTypeParameterSubstitution Dictionary[TypeParameterSymbol, TypeSymbol] = Dictionary[
            TypeParameterSymbol,
            TypeSymbol
        ]()

        /// Constructs a closed instance of a generic definition with the supplied type arguments
        /// (Phase 4.3 / ADR-0020). Field types are substituted; identity is cached so two calls
        /// with the same definition + arguments return the SAME (cref:StructSymbol)
        /// reference (preserving reference-equality semantics on TypeSymbol).
        /// @param definition The generic definition to instantiate. Must have (cref:IsGenericDefinition) true;
        /// otherwise returned unchanged.
        /// @param typeArguments The type arguments. Length must match (cref:TypeParameters).
        /// @param mapClrType Issue #1958: projects a host CLR (cref:Type) into the reflection
        /// context (typically a (cref:System.Reflection.MetadataLoadContext)) that a
        /// member's constructed generic CLR type was resolved from, mirroring
        /// `InterfaceSymbol.Construct`'s `mapClrType` (issue #1926 / PR #1956).
        /// Pass `null` (the default) for single-context callers.
        /// @returns A constructed (cref:StructSymbol) whose (cref:Definition) is the original.
        @return: NotNullIfNotNull("definition")
        func Construct(
            definition StructSymbol?,
            typeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)? = nil
        ) StructSymbol? {
            if definition == nil {
                return definition
            }
            // A lexically resolved generic nested type may already carry the
            // concrete construction of its enclosing type. Preserve that vector
            // when applying the nested type's own arguments.
            if definition.IsGenericDefinition && !definition.EnclosingTypeArguments.IsDefaultOrEmpty {
                return ConstructNestedGeneric(
                    definition.Definition ?? definition,
                    definition.EnclosingTypeArguments,
                    typeArguments,
                    mapClrType
                )!!
            }
            if !definition.IsGenericDefinition {
                return definition
            }
            let key = BuildArgsKey(typeArguments)
            return ConstructedCache.GetOrAdd(
                (definition, key),
                (_(Def StructSymbol, ArgsKey TypeArgsKey)) -> CreateConstructed(definition, typeArguments, mapClrType)
            )
        }

        /// Issue #1521: constructs a reference to a type declared as a nested type
        /// inside a <em>generic</em> enclosing type, closed over the enclosing
        /// construction's type arguments (e.g. `Box[int32].Tag`). The nested
        /// type has no own type parameters (the CLR models it as
        /// `Box`1+Tag`1`, redeclaring the encloser's parameters — ECMA-335
        /// §II.10.3.1); the enclosing arguments are recorded on
        /// (cref:EnclosingTypeArguments) and the member types that mention an
        /// enclosing type parameter are substituted lazily (see
        /// (cref:GetSubstitutionMap)). The emitter threads
        /// (cref:EnclosingTypeArguments) as the nested type's type-argument
        /// vector so a constructed use site encodes `Box`1+Tag`1<int32>`
        /// instead of the open self-instantiation `Box`1+Tag`1<!0>`.
        /// @param nestedDefinition The open nested-type definition (its (cref:Definition) is used).
        /// @param enclosingTypeArguments The flattened enclosing construction arguments in CLR order (outermost
        /// first), aligned with (cref:CollectEnclosingTypeParameters(TypeSymbol)).
        /// @param mapClrType Issue #1958: see (cref:Construct(StructSymbol, ImmutableArray{TypeSymbol},
        /// Func{Type, Type})).
        /// @returns A constructed nested reference, or [`nestedDefinition`](paramref) unchanged when no
        /// enclosing arguments apply.
        @return: NotNullIfNotNull("nestedDefinition")
        func ConstructNested(
            nestedDefinition StructSymbol?,
            enclosingTypeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)? = nil
        ) StructSymbol? {
            if nestedDefinition == nil || enclosingTypeArguments.IsDefaultOrEmpty {
                return nestedDefinition
            }
            let def = nestedDefinition.Definition ?? nestedDefinition
            let key = BuildArgsKey(enclosingTypeArguments)
            return ConstructedNestedCache.GetOrAdd(
                (def, key),
                (_(Def StructSymbol, ArgsKey TypeArgsKey)) -> CreateConstructedNested(
                    def,
                    enclosingTypeArguments,
                    mapClrType
                )
            )
        }

        /// Issue #1537: constructs a reference to a <em>generic</em> type declared
        /// as a nested type inside a <em>generic</em> enclosing type, closed over
        /// BOTH the enclosing construction's type arguments and the nested type's
        /// own type arguments (e.g. `Outer[int32].Middle[string]`). The nested
        /// type declares its own type parameters, so the CLR models it as
        /// `Outer`1+Middle`2` — redeclaring the encloser's parameters first,
        /// then its own (ECMA-335 §II.10.3.1). The enclosing arguments are recorded
        /// on (cref:EnclosingTypeArguments) and the own arguments on
        /// (cref:TypeArguments); a member whose type mentions either an
        /// enclosing parameter (`U`) or the nested type's own parameter
        /// (`T`) is substituted through the combined map (see
        /// (cref:GetSubstitutionMap)). The emitter threads the combined
        /// vector `[enclosing…, own…]` so a constructed use site encodes
        /// `Outer`1+Middle`2<int32, string>`.
        /// @param nestedDefinition The open nested-type definition (its (cref:Definition) is used).
        /// @param enclosingTypeArguments The flattened enclosing construction arguments in CLR order (outermost
        /// first), aligned with (cref:CollectEnclosingTypeParameters(TypeSymbol)). May be empty when the
        /// enclosing type is open but the nested type carries own arguments.
        /// @param ownTypeArguments The nested type's own type arguments.
        /// @param mapClrType Issue #1958: see (cref:Construct(StructSymbol, ImmutableArray{TypeSymbol},
        /// Func{Type, Type})).
        /// @returns A constructed nested-generic reference, or [`nestedDefinition`](paramref) unchanged when
        /// neither vector applies.
        @return: NotNullIfNotNull("nestedDefinition")
        func ConstructNestedGeneric(
            nestedDefinition StructSymbol?,
            enclosingTypeArguments ImmutableArray[TypeSymbol],
            ownTypeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)? = nil
        ) StructSymbol? {
            if nestedDefinition == nil {
                return nestedDefinition
            }
            // No own arguments: fall back to the enclosing-only construction so the
            // two representations remain reference-equal and share one cache.
            if ownTypeArguments.IsDefaultOrEmpty {
                return ConstructNested(nestedDefinition, enclosingTypeArguments, mapClrType)!!
            }
            // No enclosing arguments to thread: this is an ordinary construction of
            // the nested type over its own parameters (e.g. `Middle[string]`
            // referenced from within the enclosing generic's own members, where the
            // enclosing parameters stay open). Route through Construct so the own
            // arguments substitute exactly as for a top-level generic.
            if enclosingTypeArguments.IsDefaultOrEmpty {
                return Construct(nestedDefinition.Definition ?? nestedDefinition, ownTypeArguments, mapClrType)!!
            }
            let def = nestedDefinition.Definition ?? nestedDefinition
            let enclosingKey = BuildArgsKey(enclosingTypeArguments)
            let ownKey = BuildArgsKey(ownTypeArguments)
            return ConstructedNestedGenericCache.GetOrAdd(
                (def, enclosingKey, ownKey),
                (_(Def StructSymbol, EnclosingKey TypeArgsKey, OwnKey TypeArgsKey)) -> CreateConstructedNestedGeneric(
                    def,
                    enclosingTypeArguments,
                    ownTypeArguments,
                    mapClrType
                )
            )
        }

        /// Issue #1521: gathers the flattened generic parameters of every enclosing
        /// type of [`nested`](paramref), in CLR order (outermost first). A type
        /// nested inside `Outer[U].Inner[T]` sees `[U, T]`. Mirrors the
        /// emitter's reification order so a nested type's
        /// (cref:EnclosingTypeArguments) line up 1:1 with the enclosing
        /// parameters its `TypeDef` is reified over.
        /// @param nested The nested type (definition or constructed reference).
        /// @returns The flattened enclosing type parameters, or empty when not nested in a generic.
        func CollectEnclosingTypeParameters(nested TypeSymbol) ImmutableArray[TypeParameterSymbol] {
            var levels List[ImmutableArray[TypeParameterSymbol]]? = nil
            for var c TypeSymbol? = EnclosingTypeOf(nested); c != nil; c = EnclosingTypeOf(c!!) {
                let tps = EnclosingTypeParametersOf(c)
                if !tps.IsDefaultOrEmpty {
                    levels ??= List[ImmutableArray[TypeParameterSymbol]]()
                    // Prepend so the outermost enclosing type's parameters come first.
                    levels!!.Insert(0, tps)
                }
            }
            if levels == nil {
                return ImmutableArray[TypeParameterSymbol].Empty
            }
            let builder = ImmutableArray.CreateBuilder[TypeParameterSymbol]()
            for level in levels {
                builder.AddRange(level)
            }
            return builder.ToImmutable()
        }

        /// Issue #1499: applies a type-parameter [`substitution`](paramref) to
        /// [`type`](paramref), recursively rewriting the generic arguments of
        /// any constructed generic (struct / interface / imported CLR) type and the
        /// element / underlying / function-signature types it contains. Shares the
        /// same traversal used when constructing a generic instantiation, so it is
        /// the canonical way for the symbol layer to remap a constraint reference
        /// type (e.g. `IComparable[T]` → `IComparable[clone]`) onto a
        /// cloned type-parameter set. Returns the original instance unchanged when
        /// the substitution touches nothing.
        /// @param type The type whose type-parameter references to remap.
        /// @param substitution The original → replacement type-parameter map.
        /// @param eraseReferenceNullability Whether reference-nullable wrappers are erased before substitution.
        /// @returns The substituted type, or [`type`](paramref) when unchanged.
        @return: NotNullIfNotNull("type")
        internal func SubstituteTypeParameters(
            type TypeSymbol?,
            substitution Dictionary[TypeParameterSymbol, TypeSymbol]?,
            eraseReferenceNullability bool = false
        ) TypeSymbol? {
            if type == nil || (!eraseReferenceNullability && (substitution == nil || substitution.Count == 0)) {
                return type
            }
            return SubstituteTypeForConstruction(
                type,
                substitution ?? EmptyTypeParameterSubstitution,
                eraseReferenceNullability: eraseReferenceNullability
            )
        }

        /// Issue #1521: threads a type substitution through the enclosing
        /// construction of a reference to a type nested inside a generic enclosing
        /// type. For an open nested reference (`Box.Tag`) the starting vector is
        /// the flattened enclosing type parameters; for an already-constructed
        /// nested reference (`Box[T].Tag`) it is the recorded
        /// (cref:EnclosingTypeArguments). Each element is mapped through
        /// [`substituteOne`](paramref). Returns the new enclosing-argument
        /// vector when at least one element changed, or `default` when
        /// [`nested`](paramref) is not nested in a generic or nothing changed.
        /// @param nested The nested-type reference (definition or constructed).
        /// @param substituteOne Substitution applied to each enclosing argument (the caller's recursion).
        /// @returns The substituted enclosing-argument vector, or `default`.
        internal func SubstituteEnclosingArguments(
            nested StructSymbol?,
            substituteOne(TypeSymbol) -> TypeSymbol
        ) ImmutableArray[TypeSymbol] {
            if nested == nil || !nested.TypeArguments.IsDefaultOrEmpty {
                return default(ImmutableArray[TypeSymbol])
            }
            let enclosingParams = CollectEnclosingTypeParameters(nested)
            if enclosingParams.IsDefaultOrEmpty {
                return default(ImmutableArray[TypeSymbol])
            }
            var current ImmutableArray[TypeSymbol]
            if nested.IsConstructedNestedType {
                current = nested.EnclosingTypeArguments
            } else {
                let currentBuilder = ImmutableArray.CreateBuilder[TypeSymbol](enclosingParams.Length)
                for parameter in enclosingParams {
                    currentBuilder.Add(parameter)
                }
                current = currentBuilder.MoveToImmutable()
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol](current.Length)
            var changed = false
            for arg in current {
                let substituted = substituteOne(arg)
                changed |= !object.ReferenceEquals(substituted, arg)
                builder.Add(substituted)
            }
            return if changed {
                builder.ToImmutable()
            } else {
                default(ImmutableArray[TypeSymbol])
            }
        }

        internal func SubstituteConstructionArguments(
            type StructSymbol,
            substituteOne(TypeSymbol) -> TypeSymbol,
            mapClrType((Type) -> Type)? = nil
        ) StructSymbol {
            let definition StructSymbol? = type.Definition
            if definition == nil {
                return type
            }
            // Issue #3940: an open nested-generic reference carries only its own
            // arguments. Seed its enclosing parameters too, but retain that vector
            // only when this substitution actually closes one of them.
            var enclosingSource = type.EnclosingTypeArguments
            if enclosingSource.IsDefaultOrEmpty {
                let enclosingParameters = CollectEnclosingTypeParameters(type)
                let sourceBuilder = ImmutableArray.CreateBuilder[TypeSymbol](enclosingParameters.Length)
                sourceBuilder.AddRange[TypeParameterSymbol](enclosingParameters)
                enclosingSource = sourceBuilder.MoveToImmutable()
            }
            let enclosingArguments = ImmutableArray.CreateBuilder[TypeSymbol](enclosingSource.Length)
            let ownArguments = ImmutableArray.CreateBuilder[TypeSymbol](type.TypeArguments.Length)
            var enclosingChanged = false
            var ownChanged = false
            for argument in enclosingSource {
                let substituted = substituteOne(argument)
                enclosingChanged |= !object.ReferenceEquals(substituted, argument)
                enclosingArguments.Add(substituted)
            }
            for argument in type.TypeArguments {
                let substituted = substituteOne(argument)
                ownChanged |= !object.ReferenceEquals(substituted, argument)
                ownArguments.Add(substituted)
            }
            if !enclosingChanged && !ownChanged {
                return type
            }
            let substitutedEnclosing = if enclosingChanged {
                enclosingArguments.MoveToImmutable()
            } else {
                type.EnclosingTypeArguments
            }
            let substitutedOwn = ownArguments.MoveToImmutable()
            return if !substitutedEnclosing.IsDefaultOrEmpty {
                ConstructNestedGeneric(definition, substitutedEnclosing, substitutedOwn, mapClrType)!!
            } else {
                Construct(definition, substitutedOwn, mapClrType)!!
            }
        }

        /// Removes all entries from the static constructed-struct caches.
        /// Called by (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects and definition/argument symbols backed by
        /// a disposed metadata load context that would otherwise pin the
        /// context's memory indefinitely.
        internal func ClearCache() {
            ConstructedCache.Clear()
            ConstructedNestedCache.Clear()
            ConstructedNestedGenericCache.Clear()
        }

        private func BuildArgsKey(typeArguments ImmutableArray[TypeSymbol]) TypeArgsKey -> TypeArgsKey(typeArguments)

        private func EnclosingTypeOf(type TypeSymbol) TypeSymbol? -> switch type {
            case s is StructSymbol: (s.Definition ?? s).ContainingType
            case i is InterfaceSymbol: i.ContainingType
            case e is EnumSymbol: e.ContainingType
            default: default(TypeSymbol?)
        }

        private func EnclosingTypeParametersOf(type TypeSymbol) ImmutableArray[TypeParameterSymbol] -> switch type {
            case s is StructSymbol: (s.Definition ?? s).TypeParameters
            case i is InterfaceSymbol: (i.Definition ?? i).TypeParameters
            default: ImmutableArray[TypeParameterSymbol].Empty
        }

        private func CreateConstructed(
            definition StructSymbol,
            typeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)?
        ) StructSymbol {
            // Issue #3905: the instance fields and primary-constructor parameters are
            // NOT substituted here. On a constructed instance both the `Fields` and
            // `PrimaryConstructorParameters` getters forward to the definition and
            // substitute lazily (GetSubstitutedFields /
            // GetSubstitutedPrimaryConstructorParameters, issue #1341), so anything
            // computed eagerly at this point was written to a store that a
            // constructed instance never reads. Doing that dead work here also put
            // `SubstituteTypeForConstruction` on the construction path, which made
            // mutually-referential generic types (`class Node[T] { var Core
            // ICore[T] }` / `interface ICore[T] { func Register(node Node[T]) }`)
            // recurse forever: this factory runs INSIDE
            // `ConcurrentDictionary.GetOrAdd`, so the entry for `(definition,
            // typeArguments)` is not yet published when the substitution asks for
            // the same construction again, and gsc died with a stack overflow
            // instead of emitting anything. Deferring to the lazy getters — exactly
            // what CreateConstructedNested and CreateConstructedNestedGeneric
            // already do — keeps construction cheap and re-entrancy-free, and picks
            // up the richer lazy substitution (field modifiers, parameter
            // `refKind`) that the eager copy dropped.
            let constructed = StructSymbol(
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
                definition.BaseClass
            )
            constructed.Definition = definition
            constructed.TypeArguments = typeArguments
            constructed.mapClrType = mapClrType
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
            return constructed
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
        private func CreateConstructedNested(
            definition StructSymbol,
            enclosingTypeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)?
        ) StructSymbol {
            let constructed = StructSymbol(
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
                definition.BaseClass
            )
            constructed.Definition = definition
            constructed.EnclosingTypeArguments = enclosingTypeArguments
            constructed.mapClrType = mapClrType
            if !definition.TypeParameters.IsDefaultOrEmpty {
                constructed.SetTypeParameters(definition.TypeParameters)
            }
            constructed.SetContainingTypeCore(definition.ContainingType)
            return constructed
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
        private func CreateConstructedNestedGeneric(
            definition StructSymbol,
            enclosingTypeArguments ImmutableArray[TypeSymbol],
            ownTypeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)?
        ) StructSymbol {
            let constructed = StructSymbol(
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
                definition.BaseClass
            )
            constructed.Definition = definition
            constructed.TypeArguments = ownTypeArguments
            constructed.EnclosingTypeArguments = enclosingTypeArguments
            constructed.mapClrType = mapClrType
            // Capture the nested type's own type parameters BEFORE the emitter
            // re-ordinalizes the nested TypeDef over the flattened enclosing+own
            // list (RegisterNestedTypeEnclosingGenerics), so the substitution map's
            // own-argument half keeps pairing each original own parameter with its
            // argument no matter when it is first computed.
            constructed.nestedOwnTypeParameters = definition.TypeParameters
            constructed.SetContainingTypeCore(definition.ContainingType)
            return constructed
        }

        /// Issue #3814 / ADR-0149: decides whether two same-signature methods occupy
        /// the same slot for the purposes of the hiding rule in
        /// (cref:GetMethodsIncludingInherited(string)).
        ///
        /// Two explicit interface implementations of the SAME member on DIFFERENT
        /// instantiations of one generic interface (`func (IAsyncEnumerable[int32])
        /// GetAsyncEnumerator(…)` and `func (IAsyncEnumerable[string])
        /// GetAsyncEnumerator(…)`) have identical callable signatures — the
        /// interface's type argument only shows up in the RETURN type, which
        /// (cref:BoundScope.FunctionSignaturesEqual) deliberately ignores.
        /// Without this guard the second one was dropped from the overload set as if
        /// it were an override of the first, and the interface-implementation check
        /// then reported the second interface unimplemented (GS0187). They are two
        /// distinct CLR slots and must both stay visible.
        /// @param a The first method.
        /// @param b The second method.
        /// @returns `true` when both carry the same explicit-interface clause target (including none at all).
        private func ExplicitInterfaceClauseTargetsMatch(a FunctionSymbol, b FunctionSymbol) bool {
            let targetA TypeSymbol? = a.ExplicitInterfaceClauseTarget
            let targetB TypeSymbol? = b.ExplicitInterfaceClauseTarget
            if object.ReferenceEquals(targetA, targetB) {
                return true
            }
            if targetA == nil || targetB == nil {
                return false
            }
            return string.Equals(
                SymbolDisplay.ToTypeDisplayString(targetA),
                SymbolDisplay.ToTypeDisplayString(targetB),
                StringComparison.Ordinal
            )
        }

        private func SubstituteProperties(
            properties ImmutableArray[PropertySymbol],
            subst Dictionary[TypeParameterSymbol, TypeSymbol],
            mapClrType((Type) -> Type)?
        ) ImmutableArray[PropertySymbol] {
            if properties.IsDefaultOrEmpty {
                return properties
            }
            let builder = ImmutableArray.CreateBuilder[PropertySymbol](properties.Length)
            for p in properties {
                let newType = SubstituteTypeForConstruction(p.Type, subst, mapClrType)
                var newParams = p.Parameters
                var paramsChanged = false
                if !p.Parameters.IsDefaultOrEmpty {
                    let pb = ImmutableArray.CreateBuilder[ParameterSymbol](p.Parameters.Length)
                    for par in p.Parameters {
                        let st = SubstituteTypeForConstruction(par.Type, subst, mapClrType)
                        paramsChanged |= !object.ReferenceEquals(st, par.Type)
                        pb.Add(ParameterSymbol(par, st, par.DeclaringSyntax))
                    }
                    if paramsChanged {
                        newParams = pb.MoveToImmutable()
                    }
                }
                if object.ReferenceEquals(newType, p.Type) && !paramsChanged {
                    builder.Add(p)
                    continue
                }
                let substituted = p.WithSignature(newType, newParams)
                builder.Add(substituted)
            }
            return builder.MoveToImmutable()
        }

        /// Issue #1055: decides whether [`candidate`](paramref) (a more-derived,
        /// non-abstract method) implements [`abstractMethod`](paramref) once the
        /// abstract method's signature is substituted with [`subst`](paramref)
        /// (the constructed-base type arguments). Compares name, arity, parameter
        /// count, ref-kinds and parameter types — mirroring CLR override matching.
        private func AbstractMethodSatisfiedBy(
            abstractMethod FunctionSymbol,
            subst Dictionary[TypeParameterSymbol, TypeSymbol]?,
            candidate FunctionSymbol,
            candidateSubst Dictionary[TypeParameterSymbol, TypeSymbol]?
        ) bool {
            var subst = subst
            if !string.Equals(abstractMethod.Name, candidate.Name, StringComparison.Ordinal) {
                return false
            }
            let baseParams = CallableParametersOf(abstractMethod)
            let derivedParams = CallableParametersOf(candidate)
            if baseParams.Length != derivedParams.Length {
                return false
            }
            let baseArity = if abstractMethod.TypeParameters.IsDefaultOrEmpty {
                0
            } else {
                abstractMethod.TypeParameters.Length
            }
            let derivedArity = if candidate.TypeParameters.IsDefaultOrEmpty {
                0
            } else {
                candidate.TypeParameters.Length
            }
            if baseArity != derivedArity {
                return false
            }
            // Issue #1931: a generic abstract method's own type parameter(s) (e.g.
            // `open func Show[T](value T?)`) are distinct TypeParameterSymbol
            // instances from the overriding method's own `[T]` — even though `subst`
            // (the enclosing class's constructed-base substitution) already maps the
            // CLASS-level type parameters, it knows nothing about these METHOD-level
            // ones. Extend a copy of `subst` positionally so `T` in the abstract
            // signature substitutes to the override's `T`, letting `T?` compare equal
            // instead of every generic-method override looking unimplemented.
            if baseArity > 0 {
                let methodSubst = if subst == nil {
                    Dictionary[TypeParameterSymbol, TypeSymbol]()
                } else {
                    Dictionary[TypeParameterSymbol, TypeSymbol](subst)
                }
                for var i = 0; i < baseArity; i++ {
                    methodSubst[abstractMethod.TypeParameters[i]] = candidate.TypeParameters[i]
                }
                subst = methodSubst
            }
            for var i = 0; i < baseParams.Length; i++ {
                if baseParams[i].RefKind != derivedParams[i].RefKind {
                    return false
                }
                let baseType = if subst != nil {
                    SubstituteTypeForConstruction(baseParams[i].Type, subst)
                } else {
                    baseParams[i].Type
                }
                // Issue #1244: the override is declared on a (possibly still-generic)
                // derived class whose own type parameters are distinct symbols from the
                // base's — even when same-named. Substitute the candidate's parameter
                // types with the derived level's construction map so a signature using
                // the derived class type parameter (e.g. Der[T].Handle(T)) unifies with
                // the substituted abstract signature (Base[T].Handle(T) -> Handle(int32)).
                let derivedType = if candidateSubst != nil {
                    SubstituteTypeForConstruction(derivedParams[i].Type, candidateSubst)
                } else {
                    derivedParams[i].Type
                }
                if !DeclarationBinder.ConformanceSignaturesEquivalent(baseType, derivedType) {
                    return false
                }
            }
            return true
        }

        private func CallableParametersOf(method FunctionSymbol) ImmutableArray[
            ParameterSymbol
        ] -> if method.ExplicitReceiverParameter == nil {
            method.Parameters
        } else {
            method.Parameters.RemoveAt(0)
        }

        // Every recursive call below feeds this a sub-part of an already-non-null
        // constructed type (element/underlying/parameter/argument types, which are
        // never null on a well-formed TypeSymbol), so `type` is non-nullable here
        // by construction. The one call site that can genuinely hold a null type
        // (GetSubstitutedImportedBaseType, when a class has no imported base)
        // short-circuits before reaching this method instead of passing null
        // through, so the recursive `is` pattern chain below never needs to
        // reason about a null `type`.
        private func SubstituteTypeForConstruction(
            type TypeSymbol,
            subst Dictionary[TypeParameterSymbol, TypeSymbol],
            mapClrType((Type) -> Type)? = nil,
            eraseReferenceNullability bool = false
        ) TypeSymbol {
            // Keep recursive arms on this closure so optional substitution modes propagate.
            let SubstituteNested = func (nested TypeSymbol) TypeSymbol {
                return SubstituteTypeForConstruction(nested, subst, mapClrType, eraseReferenceNullability)
            }
            if eraseReferenceNullability {
                if type is NullabilityAnnotatedTypeSymbol annotated {
                    return SubstituteNested(annotated.BaseType)
                }
                if type is NullableTypeSymbol nullable && !NullableLifting.IsAnyValueTypeNullable(nullable) {
                    return SubstituteNested(nullable.UnderlyingType)
                }
            }
            if type is TypeParameterSymbol tp {
                return if subst.TryGetValue(tp, out var concrete) {
                    concrete
                } else {
                    type
                }
            }
            if TypeSymbol.TrySubstituteCompositeType(type, SubstituteNested, out var composite) {
                return composite
            }
            // Issue #1250: a member type that is itself a constructed generic G#
            // user class (e.g. a field/property/primary-ctor parameter typed
            // `Holder[T]` on `Box[T]`) must have its own type arguments substituted
            // so it surfaces as `Holder[int32]` on `Box[int32]`. Recurses so nested
            // generics (`Holder[Holder[T]]`, `Dictionary[K, List[V]]`) work too.
            if type is StructSymbol ss && ss.Definition != nil && !object.ReferenceEquals(ss.Definition, ss) &&
                !ss
                .TypeArguments
                .IsDefaultOrEmpty {
                return SubstituteConstructionArguments(ss, SubstituteNested, mapClrType)
            }
            // Issue #1521: a member type that is a reference to a type nested inside
            // the generic being constructed (e.g. a field/return typed `Tag` on
            // `Box[T]`, where `Tag` is `struct Box[T].Tag`) must thread the
            // enclosing construction so it surfaces as `Box[int32].Tag` on
            // `Box[int32]`. `Tag` declares no own type arguments, so this is
            // distinct from the constructed-generic branch above.
            if type is StructSymbol nestedRef && nestedRef.TypeArguments.IsDefaultOrEmpty {
                let newEnclosing = SubstituteEnclosingArguments(nestedRef, SubstituteNested)
                if !newEnclosing.IsDefault {
                    return ConstructNested(nestedRef.Definition ?? nestedRef, newEnclosing, mapClrType)!!
                }
            }
            if type is EnumSymbol nestedEnum {
                let newEnclosing = EnumSymbol.SubstituteEnclosingArguments(nestedEnum, SubstituteNested)
                if !newEnclosing.IsDefault {
                    return EnumSymbol.ConstructNested(nestedEnum.Definition ?? nestedEnum, newEnclosing)!!
                }
            }
            if type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty {
                let substitutedArgs = ImmutableArray.CreateBuilder[TypeSymbol](iface.TypeArguments.Length)
                var changed = false
                for var i = 0; i < iface.TypeArguments.Length; i++ {
                    let substituted = SubstituteNested(iface.TypeArguments[i])
                    substitutedArgs.Add(substituted)
                    changed |= !object.ReferenceEquals(substituted, iface.TypeArguments[i])
                }
                if !changed {
                    return iface
                }
                return InterfaceSymbol.Construct(iface.Definition, substitutedArgs.MoveToImmutable(), mapClrType)!!
            }
            if type is ImportedTypeSymbol imported &&
                imported.OpenDefinition != nil &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                let substitutedArgs = ImmutableArray.CreateBuilder[TypeSymbol](imported.TypeArguments.Length)
                var changed = false
                for var i = 0; i < imported.TypeArguments.Length; i++ {
                    let substituted = SubstituteNested(imported.TypeArguments[i])
                    substitutedArgs.Add(substituted)
                    changed |= !object.ReferenceEquals(substituted, imported.TypeArguments[i])
                }
                if !changed {
                    return imported
                }
                // Issue #1958: project each resolved CLR arg into the same
                // reflection context as `imported.OpenDefinition` before calling
                // MakeGenericType — mirrors InterfaceSymbol.SubstituteType's
                // mapClrType fix. Without this, a raw host CLR type mixed with an
                // MLC-resolved open definition throws ArgumentException and
                // silently erases the substitution.
                let resolvedClrArgs = [substitutedArgs.Count]Type
                for var i = 0; i < substitutedArgs.Count; i++ {
                    let clr = if MemberLookup.TryProjectErasedClrType(substitutedArgs[i], out var projected) {
                        projected!!
                    } else {
                        substitutedArgs[i].ClrType ?? typeof(object)
                    }
                    resolvedClrArgs[i] = if mapClrType != nil {
                        mapClrType(clr)
                    } else {
                        clr
                    }
                }
                try {
                    let closed = imported.OpenDefinition!!.MakeGenericType(resolvedClrArgs)
                    return ImportedTypeSymbol.GetConstructed(
                        closed,
                        imported.OpenDefinition,
                        substitutedArgs.MoveToImmutable()
                    )
                } catch (ArgumentException) {
                    // MakeGenericType can legitimately throw ArgumentException for CLR
                    // generic constraint reasons (e.g. unmanaged/ref-struct constraints),
                    // not only cross-reflection-context mismatches, so this is NOT always
                    // a bug. Log for diagnosability and fall back to the erased
                    // constructed form so both debug and release builds degrade
                    // gracefully rather than crash.
                    let renderedArguments = [resolvedClrArgs.Length]string
                    for var i = 0; i < resolvedClrArgs.Length; i++ {
                        renderedArguments[i] = resolvedClrArgs[i].ToString()
                    }
                    let assertMessage = "StructSymbol.SubstituteTypeForConstruction: MakeGenericType failed for '${imported.OpenDefinition}' with args [${string.Join(", ", renderedArguments)}] even after mapClrType projection."
                    Debug.WriteLine(assertMessage)
                    return imported
                }
            }
            // Issue #1503: a constructed generic named delegate referenced as a
            // member type (e.g. a field/parameter typed `Predicate[T]` on a
            // generic type, or a nested generic delegate argument) substitutes its
            // own type arguments so it surfaces as `Predicate[int32]`.
            if type is DelegateTypeSymbol del && del.Definition != nil && !object.ReferenceEquals(
                del.Definition,
                del
            ) &&
                !del
                .TypeArguments
                .IsDefaultOrEmpty {
                let substitutedDelegateArgs = ImmutableArray.CreateBuilder[TypeSymbol](del.TypeArguments.Length)
                var delegateChanged = false
                for var i = 0; i < del.TypeArguments.Length; i++ {
                    let substituted = SubstituteNested(del.TypeArguments[i])
                    substitutedDelegateArgs.Add(substituted)
                    delegateChanged |= !object.ReferenceEquals(substituted, del.TypeArguments[i])
                }
                return if delegateChanged {
                    cast[TypeSymbol](
                        DelegateTypeSymbol.Construct(del.Definition, substitutedDelegateArgs.MoveToImmutable())!!
                    )
                } else {
                    type
                }
            }
            return type
        }
    }
}
