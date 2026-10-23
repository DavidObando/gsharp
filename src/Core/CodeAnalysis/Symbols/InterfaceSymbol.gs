// <copyright file="InterfaceSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.Linq

/// Represents a user-defined interface type (Phase 3.B.4 / ADR-0018).
/// Interfaces are CLR reference types (TypeAttributes.Interface | Abstract)
/// containing method signatures only — no bodies, no default impls,
/// no static members.
class InterfaceSymbol : TypeSymbol {
    // Issue #1958: the projector supplied to Construct(), retained so the
    // (possibly deferred, see EnsureMembersResolved) member substitution pass
    // can close constructed-generic member types in the right reflection
    // context. Null for definitions and for constructed instances built
    // without a projector (single-context callers; unchanged behavior).
    private let mapClrType((Type) -> Type)?

    private var methods ImmutableArray[FunctionSymbol]
    private var staticMethods ImmutableArray[FunctionSymbol] = ImmutableArray[FunctionSymbol].Empty
    private var privateMethods ImmutableArray[FunctionSymbol] = ImmutableArray[FunctionSymbol].Empty
    private var staticPrivateMethods ImmutableArray[FunctionSymbol] = ImmutableArray[FunctionSymbol].Empty
    private var baseInterfaces ImmutableArray[InterfaceSymbol] = ImmutableArray[InterfaceSymbol].Empty
    private var baseClrInterfaces ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty

    // ADR-0087 R5 / issue #765: constructed instances of a generic interface
    // may be created (e.g. as a base type on a class declaration) BEFORE the
    // definition's member-binding pass has run. <see cref="EnsureMembersResolved"/>
    // detects the staleness on the accessor hot-paths and re-substitutes
    // lazily so call-site dispatch through a constructed interface
    // (e.g. <c>IBox[int32].Get()</c>) succeeds.
    private var membersResolved bool

    // Issue #3905: the managed thread currently substituting this instance's
    // member tables, or 0 when none is. Guards <see cref="TryResolveMembers"/>
    // against re-entering itself on the same thread through a
    // mutually-referential generic type.
    private var resolvingThreadId int32

    /// Initializes a new instance of the (cref:InterfaceSymbol) class.
    /// @param name The interface type name.
    /// @param accessibility The interface's CLR accessibility.
    /// @param declaration The declaring syntax node.
    /// @param packageName The package this interface lives in.
    init(name string, accessibility Accessibility, declaration InterfaceDeclarationSyntax, packageName string) : base(
        name
    ) {
        Accessibility = accessibility
        Declaration = declaration
        PackageName = packageName
        Methods = ImmutableArray[FunctionSymbol].Empty
        Definition = this
    }

    private init(
        definition InterfaceSymbol,
        typeArguments ImmutableArray[TypeSymbol],
        constructedName string,
        mapClrType((Type) -> Type)?
    ) : base(constructedName) {
        Accessibility = definition.Accessibility
        Declaration = definition.Declaration
        PackageName = definition.PackageName
        Methods = ImmutableArray[FunctionSymbol].Empty
        TypeParameters = ImmutableArray[TypeParameterSymbol].Empty
        TypeArguments = typeArguments
        Definition = definition
        this.mapClrType = mapClrType
    }

    /// Gets the interface accessibility.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets the declaring syntax node.
    prop Declaration InterfaceDeclarationSyntax {
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

    /// Gets the package this interface lives in.
    prop PackageName string {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ContainingNamespace string? -> PackageName

    /// Gets a value indicating whether this interface was declared `sealed` (Phase 3.B.5). All implementors
    /// must live in the same package; binder-enforced.
    prop IsSealed bool -> Declaration?.IsSealed ?? false

    internal prop IsProtocol bool -> Declaration?.IsProtocol ?? false

    /// Gets the abstract method signatures declared on this interface. Populated by the binder via
    /// (cref:SetMethods).
    prop Methods ImmutableArray[FunctionSymbol] {
        get {
            EnsureMembersResolved()
            return methods
        }
        private set -> methods = value
    }

    /// Gets the static-virtual method signatures declared on this interface (ADR-0089 / issue #755).
    /// Populated by the binder via (cref:SetStaticMethods).
    prop StaticMethods ImmutableArray[FunctionSymbol] {
        get {
            EnsureMembersResolved()
            return staticMethods
        }
        private set -> staticMethods = value
    }

    /// Gets the `private` instance helper methods declared on this interface (ADR-0090 / issue #756).
    /// Private helpers are part of the interface's own implementation, not its
    /// public contract; the binder routes them here so the
    /// (cref:Methods) set continues to drive implementer-contract
    /// verification (GS0187 / GS0320) unaffected. Populated by the binder via
    /// (cref:SetPrivateMethods).
    prop PrivateMethods ImmutableArray[FunctionSymbol] {
        get {
            EnsureMembersResolved()
            return privateMethods
        }
        private set -> privateMethods = value
    }

    /// Gets the `private static` helper methods declared on this interface (ADR-0090 / issue #756).
    /// (Combined private + ADR-0089 static-virtual surface.) Static-virtual
    /// dispatch through type-parameter constraints continues to use
    /// (cref:StaticMethods); private static helpers are never part of
    /// that dispatch table. Populated by the binder via
    /// (cref:SetStaticPrivateMethods).
    prop StaticPrivateMethods ImmutableArray[FunctionSymbol] {
        get {
            EnsureMembersResolved()
            return staticPrivateMethods
        }
        private set -> staticPrivateMethods = value
    }

    /// Gets a value indicating whether this interface declares at least one static-virtual member
    /// (ADR-0089).
    prop HasStaticVirtualMembers bool -> !StaticMethods.IsDefaultOrEmpty

    /// Gets the property signatures declared on this interface (ADR-0051). Populated by the binder via
    /// (cref:SetProperties).
    private var _properties ImmutableArray[PropertySymbol] = ImmutableArray[PropertySymbol].Empty

    prop Properties ImmutableArray[PropertySymbol] {
        get {
            return _properties
        }
        private set {
            _properties = value
        }
    }

    /// Gets the event signatures declared on this interface (ADR-0052). Populated by the binder via
    /// (cref:SetEvents).
    private var _events ImmutableArray[EventSymbol] = ImmutableArray[EventSymbol].Empty

    prop Events ImmutableArray[EventSymbol] {
        get {
            return _events
        }
        private set {
            _events = value
        }
    }

    /// Gets the static fields declared inside the interface `shared { … }`
    /// block (ADR-0089 / issue #1030). CLR interfaces may own static fields;
    /// these are emitted as `Static` FieldDef rows on the interface
    /// TypeDef. Populated by the binder via (cref:SetStaticFields).
    private var _staticFields ImmutableArray[FieldSymbol] = ImmutableArray[FieldSymbol].Empty

    prop StaticFields ImmutableArray[FieldSymbol] {
        get {
            return _staticFields
        }
        private set {
            _staticFields = value
        }
    }

    /// Gets the compile-time `const` fields declared inside the interface
    /// `shared { … }` block (issue #1030). Reads are inlined. ECMA
    /// constants emit as literal fields; decimal constants use static read-only
    /// storage initialized by the interface type constructor.
    private var _constFields ImmutableArray[FieldSymbol] = ImmutableArray[FieldSymbol].Empty

    prop ConstFields ImmutableArray[FieldSymbol] {
        get {
            return _constFields
        }
        private set {
            _constFields = value
        }
    }

    /// Gets the bound initializer expressions for interface static fields with
    /// non-default values (issue #1030). Keyed by field symbol; run in the
    /// interface's synthesized `.cctor` in (cref:StaticFields)
    /// source order.
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

    /// Gets the directly-declared base interfaces (issue #1006), e.g. the
    /// `A` in `interface B : A`. Populated by the binder via
    /// (cref:SetBaseInterfaces). A base interface contributes its
    /// members to this interface's member-lookup surface and is emitted as an
    /// InterfaceImpl row on this interface's TypeDef.
    prop BaseInterfaces ImmutableArray[InterfaceSymbol] -> if Definition != nil && !object.ReferenceEquals(
        Definition,
        this
    ) {
        SubstituteBaseInterfaces(Definition!!.BaseInterfaces)
    } else {
        baseInterfaces
    }

    /// Gets the directly-declared base interfaces imported from metadata
    /// (issue #1006), e.g. `System.IDisposable` in
    /// `interface B : System.IDisposable`. These are CLR interface types
    /// surfaced through their (cref:TypeSymbol.ClrType).
    prop BaseClrInterfaces ImmutableArray[TypeSymbol] -> if Definition != nil && !object.ReferenceEquals(
        Definition,
        this
    ) {
        SubstituteBaseClrInterfaces(Definition!!.BaseClrInterfaces)
    } else {
        baseClrInterfaces
    }

    /// Gets the type parameters when this is a generic definition (Phase 4.3c / ADR-0020).
    private var _typeParameters ImmutableArray[TypeParameterSymbol] = ImmutableArray[TypeParameterSymbol].Empty

    prop TypeParameters ImmutableArray[TypeParameterSymbol] {
        get {
            return _typeParameters
        }
        private set {
            _typeParameters = value
        }
    }

    /// Gets the type arguments when this is a constructed instance (Phase 4.3c / ADR-0020).
    private var _typeArguments ImmutableArray[TypeSymbol] = ImmutableArray[TypeSymbol].Empty

    prop TypeArguments ImmutableArray[TypeSymbol] {
        get {
            return _typeArguments
        }
        private set {
            _typeArguments = value
        }
    }

    /// Gets a value indicating whether this is a generic definition (has type parameters and no type
    /// arguments).
    prop IsGenericDefinition bool -> !TypeParameters.IsDefaultOrEmpty && TypeArguments.IsDefaultOrEmpty

    /// Gets the original generic definition when this is a constructed instance; otherwise `this`.
    prop Definition InterfaceSymbol? {
        get;
    }

    /// Sets (cref:Symbol.ContainingType) (ADR-0110 / issue #910).
    /// @param containingType The enclosing user-defined type.
    func SetContainingType(containingType TypeSymbol) {
        SetContainingTypeCore(containingType)
    }

    /// Sets (cref:Methods). Intended to be called once by the binder.
    /// @param methods The bound method signatures.
    func SetMethods(methods ImmutableArray[FunctionSymbol]) {
        Methods = methods
    }

    /// Sets (cref:BaseInterfaces) (issue #1006). Intended to be called once by the binder.
    /// @param baseInterfaces The directly-declared user base interfaces.
    func SetBaseInterfaces(baseInterfaces ImmutableArray[InterfaceSymbol]) {
        this.baseInterfaces = baseInterfaces
    }

    /// Sets (cref:BaseClrInterfaces) (issue #1006). Intended to be called once by the binder.
    /// @param baseClrInterfaces The directly-declared imported CLR base interfaces.
    func SetBaseClrInterfaces(baseClrInterfaces ImmutableArray[TypeSymbol]) {
        this.baseClrInterfaces = baseClrInterfaces
    }

    /// Issue #1006: enumerates this interface together with the transitive
    /// closure of its user base interfaces ((cref:BaseInterfaces)),
    /// each appearing once. `this` is yielded first, then bases in
    /// declaration order, depth-first. Used by member lookup and by the
    /// implementer-contract verification so an `interface B : A` surfaces
    /// `A`'s members.
    /// @returns The self-and-bases set, deduplicated by reference.
    func SelfAndAllBaseInterfaces() IEnumerable[InterfaceSymbol] {
        let seen = HashSet[InterfaceSymbol]()
        let ordered = List[InterfaceSymbol]()
        let visiting = Stack[InterfaceSymbol]()
        visiting.Push(this)
        while visiting.Count > 0 {
            let current = visiting.Pop()
            if !seen.Add(current) {
                continue
            }
            ordered.Add(current)
            if !current.BaseInterfaces.IsDefaultOrEmpty {
                // Push in reverse so declaration order is preserved on pop.
                for var i = current.BaseInterfaces.Length - 1; i >= 0; i-- {
                    visiting.Push(current.BaseInterfaces[i])
                }
            }
        }
        return ordered
    }

    /// Sets (cref:StaticMethods). Intended to be called once by the binder (ADR-0089 / issue #755).
    /// @param methods The bound static-virtual method signatures.
    func SetStaticMethods(methods ImmutableArray[FunctionSymbol]) {
        StaticMethods = methods
    }

    /// Sets (cref:PrivateMethods). Intended to be called once by the binder (ADR-0090 / issue #756).
    /// @param methods The bound private instance helper signatures.
    func SetPrivateMethods(methods ImmutableArray[FunctionSymbol]) {
        PrivateMethods = methods
    }

    /// Sets (cref:StaticPrivateMethods). Intended to be called once by the binder (ADR-0090 / issue #756).
    /// @param methods The bound private static helper signatures.
    func SetStaticPrivateMethods(methods ImmutableArray[FunctionSymbol]) {
        StaticPrivateMethods = methods
    }

    /// ADR-0090 / issue #756: returns every `private` instance helper whose name equals [`name`](paramref).
    /// Used by call-site visibility checks: callers inside the same interface
    /// declaration see this overload set; external callers do not.
    /// @param name The helper name.
    /// @returns The overload set; empty when none.
    func GetPrivateMethods(name string) ImmutableArray[FunctionSymbol] {
        EnsureMembersResolved()
        if PrivateMethods.IsDefaultOrEmpty {
            return ImmutableArray[FunctionSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        for m in PrivateMethods {
            if m.Name == name {
                builder.Add(m)
            }
        }
        return builder.ToImmutable()
    }

    /// ADR-0090 / issue #756: returns every `private static` helper whose name equals [`name`](paramref).
    /// @param name The helper name.
    /// @returns The overload set; empty when none.
    func GetStaticPrivateMethods(name string) ImmutableArray[FunctionSymbol] {
        EnsureMembersResolved()
        if StaticPrivateMethods.IsDefaultOrEmpty {
            return ImmutableArray[FunctionSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        for m in StaticPrivateMethods {
            if m.Name == name {
                builder.Add(m)
            }
        }
        return builder.ToImmutable()
    }

    /// Tries to look up a static-virtual interface method by name (ADR-0089 / issue #755).
    /// @param name The method name.
    /// @param method The found method on success.
    /// @returns True if found.
    func TryGetStaticMethod(name string, @NotNullWhen(true) out method FunctionSymbol?) bool {
        EnsureMembersResolved()
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

    /// Returns every static-virtual interface method whose name equals [`name`](paramref) (ADR-0089).
    /// @param name The method name.
    /// @returns The overload set; empty when none.
    func GetStaticMethods(name string) ImmutableArray[FunctionSymbol] {
        EnsureMembersResolved()
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

    /// Sets (cref:Properties). Intended to be called once by the binder (ADR-0051).
    /// @param properties The bound property signatures.
    func SetProperties(properties ImmutableArray[PropertySymbol]) {
        Properties = properties
    }

    /// Sets (cref:Events). Intended to be called once by the binder (ADR-0052).
    /// @param events The bound event signatures.
    func SetEvents(events ImmutableArray[EventSymbol]) {
        Events = events
    }

    /// Sets (cref:StaticFields) after binding interface shared-block field declarations (issue #1030).
    /// @param fields The bound static fields in declared order.
    func SetStaticFields(fields ImmutableArray[FieldSymbol]) {
        StaticFields = fields
    }

    /// Sets (cref:ConstFields) after binding interface `const` field declarations (issue #1030).
    /// @param fields The bound const fields in declared order.
    func SetConstFields(fields ImmutableArray[FieldSymbol]) {
        ConstFields = fields
    }

    /// Sets (cref:StaticFieldInitializers) after binding interface shared-block field initializers (issue
    /// #1030).
    /// @param initializers The bound initializer expressions keyed by field.
    func SetStaticFieldInitializers(initializers ImmutableDictionary[FieldSymbol, BoundExpression]) {
        StaticFieldInitializers = initializers
    }

    /// Looks up an interface static field (storage or const) by name (issue
    /// #1030). Returns `null` when no such field exists.
    /// @param name The field name.
    /// @returns The matching (cref:FieldSymbol), or `null`.
    func GetStaticField(name string) FieldSymbol? {
        if !StaticFields.IsDefaultOrEmpty {
            for f in StaticFields {
                if f.Name == name {
                    return f
                }
            }
        }
        if !ConstFields.IsDefaultOrEmpty {
            for f in ConstFields {
                if f.Name == name {
                    return f
                }
            }
        }
        return nil
    }

    /// Sets (cref:TypeParameters) on a generic definition (Phase 4.3c). Intended to be called once by the
    /// binder.
    /// @param typeParameters The bound type parameters in declared order.
    func SetTypeParameters(typeParameters ImmutableArray[TypeParameterSymbol]) {
        TypeParameters = typeParameters
    }

    /// Tries to look up an interface method by name.
    /// @param name The method name.
    /// @param method The found method on success.
    /// @returns True if found.
    func TryGetMethod(name string, @NotNullWhen(true) out method FunctionSymbol?) bool {
        EnsureMembersResolved()
        for m in Methods {
            if m.Name == name {
                method = m
                return true
            }
        }
        method = nil
        return false
    }

    /// ADR-0063: returns every interface method whose name equals [`name`](paramref) (the overload set).
    /// @param name The method name.
    /// @returns The overload set; empty if none.
    func GetMethods(name string) ImmutableArray[FunctionSymbol] {
        EnsureMembersResolved()
        if Methods.IsDefaultOrEmpty {
            return ImmutableArray[FunctionSymbol].Empty
        }
        let builder = ImmutableArray.CreateBuilder[FunctionSymbol]()
        for m in Methods {
            if m.Name == name {
                builder.Add(m)
            }
        }
        return builder.ToImmutable()
    }

    /// ADR-0105 Phase 2 — re-points this (reused) interface symbol at the
    /// declaration node of a freshly-parsed syntax tree whose declaration is
    /// byte-identical to the previous one (a body-only edit). Only the backing
    /// syntax — and therefore source spans — changes; the symbol's identity and
    /// its method symbols are preserved so cross-compilation reuse stays sound.
    /// The interface's default/private/static-virtual method bodies are
    /// re-pointed separately via their (cref:FunctionSymbol.RepointDeclaration(FunctionDeclarationSyntax)).
    /// Intended to be called only by (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration InterfaceDeclarationSyntax) {
        Declaration = declaration
    }

    /// Ensures the lazy member tables ((cref:Methods), (cref:StaticMethods),
    /// (cref:PrivateMethods), (cref:StaticPrivateMethods)) of a constructed
    /// generic interface instance have been substituted/populated. Idempotent. Exposed as
    /// `internal` (ADR-0112 A9) so (cref:TypeMemberModel) can guarantee the same
    /// resolution the per-accessor getters perform before enumerating member tables directly.
    internal func EnsureMembersResolved() {
        if membersResolved {
            return
        }
        TryResolveMembers()
    }

    /// Substitutes a member type through this interface construction.
    /// @param type Member type declared on the generic definition.
    /// @returns Type closed over this interface's type arguments.
    internal func SubstituteMemberType(type TypeSymbol) TypeSymbol {
        return if Definition != nil && !object.ReferenceEquals(Definition, this) && !TypeArguments.IsDefaultOrEmpty {
            SubstituteType(type, GetTypeSubstitution(), mapClrType)
        } else {
            type
        }
    }

    private func SubstituteBaseInterfaces(source ImmutableArray[InterfaceSymbol]) ImmutableArray[InterfaceSymbol] {
        if source.IsDefaultOrEmpty {
            return source
        }
        let subst = GetTypeSubstitution()
        let builder = ImmutableArray.CreateBuilder[InterfaceSymbol](source.Length)
        for baseInterface in source {
            builder.Add(cast[InterfaceSymbol](SubstituteType(baseInterface, subst, mapClrType)))
        }
        return builder.MoveToImmutable()
    }

    private func SubstituteBaseClrInterfaces(source ImmutableArray[TypeSymbol]) ImmutableArray[TypeSymbol] {
        if source.IsDefaultOrEmpty {
            return source
        }
        let subst = GetTypeSubstitution()
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](source.Length)
        for baseInterface in source {
            builder.Add(SubstituteType(baseInterface, subst, mapClrType))
        }
        return builder.MoveToImmutable()
    }

    private func GetTypeSubstitution() Dictionary[TypeParameterSymbol, TypeSymbol] {
        let subst = Dictionary[TypeParameterSymbol, TypeSymbol](Definition!!.TypeParameters.Length)
        for var i = 0; i < Definition!!.TypeParameters.Length; i++ {
            subst[Definition!!.TypeParameters[i]] = TypeArguments[i]
        }
        return subst
    }

    private func TryResolveMembers() {
        // Only constructed instances need substitution. Definitions return
        // their own pre-populated member lists.
        if Definition == nil || object.ReferenceEquals(Definition, this) {
            membersResolved = true
            return
        }
        let definition = Definition!!
        // Issue #3905: substituting this instance's members can, through a
        // mutually-referential generic type, come back round and read one of
        // this instance's member tables. That read must not restart the
        // substitution that is already in flight on this thread — it would
        // recurse until the stack overflowed. Returning early leaves the
        // re-entrant reader with the (still empty) tables, which is the same
        // "members aren't populated yet; try again later" state the method
        // already produces for a definition whose body has not been bound; the
        // outer call completes the tables and the next read observes them. The
        // guard is per-thread so a genuinely concurrent resolution on another
        // thread still proceeds, exactly as it did before.
        if resolvingThreadId == Environment.CurrentManagedThreadId {
            return
        }
        let defMethods = definition.Methods
        let defStatic = definition.StaticMethods
        let defPriv = definition.PrivateMethods
        let defStaticPriv = definition.StaticPrivateMethods
        // Members aren't populated yet on the definition; try again later.
        let defHasAnything = (!defMethods.IsDefaultOrEmpty) ||
            (!defStatic.IsDefaultOrEmpty) ||
            (!defPriv.IsDefaultOrEmpty) ||
            (!defStaticPriv.IsDefaultOrEmpty)
        if !defHasAnything {
            return
        }
        resolvingThreadId = Environment.CurrentManagedThreadId
        try {
            let subst = GetTypeSubstitution()
            if !defMethods.IsDefaultOrEmpty {
                let builder = ImmutableArray.CreateBuilder[FunctionSymbol](defMethods.Length)
                for m in defMethods {
                    builder.Add(SubstituteMethod(m, subst, this, isStatic: false, isPrivate: false, mapClrType))
                }
                Methods = builder.MoveToImmutable()
            }
            if !defStatic.IsDefaultOrEmpty {
                let builder = ImmutableArray.CreateBuilder[FunctionSymbol](defStatic.Length)
                for m in defStatic {
                    builder.Add(SubstituteMethod(m, subst, this, isStatic: true, isPrivate: false, mapClrType))
                }
                StaticMethods = builder.MoveToImmutable()
            }
            if !defPriv.IsDefaultOrEmpty {
                let builder = ImmutableArray.CreateBuilder[FunctionSymbol](defPriv.Length)
                for m in defPriv {
                    builder.Add(SubstituteMethod(m, subst, this, isStatic: false, isPrivate: true, mapClrType))
                }
                PrivateMethods = builder.MoveToImmutable()
            }
            if !defStaticPriv.IsDefaultOrEmpty {
                let builder = ImmutableArray.CreateBuilder[FunctionSymbol](defStaticPriv.Length)
                for m in defStaticPriv {
                    builder.Add(SubstituteMethod(m, subst, this, isStatic: true, isPrivate: true, mapClrType))
                }
                StaticPrivateMethods = builder.MoveToImmutable()
            }
        } finally {
            resolvingThreadId = 0
        }
        membersResolved = true
    }

    shared {
        private let ConstructedCache ConcurrentDictionary[
            (Def InterfaceSymbol, Args TypeArgsKey),
            InterfaceSymbol
        ] = ConcurrentDictionary[(Def InterfaceSymbol, Args TypeArgsKey), InterfaceSymbol]()

        /// Constructs a closed instance of a generic interface definition with the supplied type arguments
        /// (Phase 4.3c / ADR-0020). Method signatures are substituted; identity is cached so two calls with
        /// the same definition + arguments return the same (cref:InterfaceSymbol) reference.
        /// @param definition The generic definition to instantiate.
        /// @param typeArguments The type arguments. Length must match (cref:TypeParameters).
        /// @param mapClrType Issue #1958: projects a host CLR (cref:System.Type) into the reflection
        /// context (typically a (cref:System.Reflection.MetadataLoadContext)) that a
        /// member's constructed generic CLR type was resolved from, mirroring
        /// `Binder.SubstituteType`'s `mapClrType` (issue #1926 / PR #1956). Pass
        /// `null` (the default) for single-context callers.
        /// @returns A constructed (cref:InterfaceSymbol) whose (cref:Definition) is the original.
        @return: NotNullIfNotNull("definition")
        func Construct(
            definition InterfaceSymbol?,
            typeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)? = nil
        ) InterfaceSymbol? {
            if definition == nil || !definition.IsGenericDefinition {
                return definition
            }
            let cacheKey = (definition, BuildArgsKey(typeArguments))
            if ConstructedCache.TryGetValue(cacheKey, out var cached) {
                return cached
            }
            // Issue #3905: publish the (member-less) instance BEFORE resolving its
            // members. Member substitution can construct other generic types whose
            // own members mention this very construction — mutually-referential
            // generic types such as `interface ICore[T] { func Register(node
            // Node[T]) }` paired with `class Node[T] { var Core ICore[T] }`, or two
            // interfaces that name each other. Resolving inside the
            // `ConcurrentDictionary.GetOrAdd` factory meant the entry for this key
            // was still unpublished when the recursive request arrived (GetOrAdd
            // gives no re-entrancy protection and does not promise the factory runs
            // once), so gsc recursed until the stack overflowed and the process
            // died with no diagnostics at all. Publishing first makes the recursive
            // request a cache hit that returns this instance, and the members it
            // still needs resolve lazily on first access via EnsureMembersResolved.
            let instance = CreateConstructed(definition, typeArguments, mapClrType)
            let published = ConstructedCache.GetOrAdd(cacheKey, instance)
            published.EnsureMembersResolved()
            return published
        }

        /// ADR-0085 / issue #726: returns true when [`method`](paramref) is
        /// a default-interface method on this interface — i.e. its declaring
        /// (cref:FunctionSymbol.Declaration) carries a non-null
        /// `Body`. Abstract interface methods return false.
        /// @param method The interface method to inspect.
        /// @returns True when the method has a default body.
        func HasDefaultBody(method FunctionSymbol?) bool {
            return method != nil && method.Declaration?.Body != nil
        }

        /// Removes all entries from the static constructed-interface cache.
        /// Called by (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects and definition/argument symbols backed by
        /// a disposed metadata load context that would otherwise pin the
        /// context's memory indefinitely.
        internal func ClearCache() -> ConstructedCache.Clear()

        private func BuildArgsKey(typeArguments ImmutableArray[TypeSymbol]) TypeArgsKey -> TypeArgsKey(typeArguments)

        private func CreateConstructed(
            definition InterfaceSymbol,
            typeArguments ImmutableArray[TypeSymbol],
            mapClrType((Type) -> Type)?
        ) InterfaceSymbol {
            let argParts = [typeArguments.Length]string
            for var i = 0; i < typeArguments.Length; i++ {
                argParts[i] = typeArguments[i].Name
            }
            let constructedName = "${definition.Name}[${string.Join(", ", argParts)}]"
            let instance = InterfaceSymbol(definition, typeArguments, constructedName, mapClrType)
            // ADR-0087 R5 / issue #765: defer the actual member substitution
            // (Methods / StaticMethods / PrivateMethods / StaticPrivateMethods)
            // to first access through <see cref="EnsureMembersResolved"/>.
            // Eager substitution at construction time produced stale-empty lists
            // when the constructed instance is built before the definition's
            // member-binding pass has populated them (e.g. when a class
            // declaration's base-type clause references `IBox[int32]` before
            // `BindInterfaceMembers` runs on `IBox`). Lazy resolution keeps the
            // construction cheap and self-heals once the definition is complete.
            //
            // Issue #3905: the resolution is driven by Construct AFTER the instance
            // has been published to the constructed-instance cache, so a
            // mutually-referential generic type that asks for this same
            // construction while its members are being substituted gets this
            // instance back instead of recursing into a second factory invocation.
            return instance
        }

        private func SubstituteMethod(
            m FunctionSymbol,
            subst Dictionary[TypeParameterSymbol, TypeSymbol],
            instance InterfaceSymbol,
            isStatic bool,
            isPrivate bool,
            mapClrType((Type) -> Type)?
        ) FunctionSymbol {
            let substParams = ImmutableArray.CreateBuilder[ParameterSymbol](m.Parameters.Length)
            for p in m.Parameters {
                let newParam = ParameterSymbol(p, SubstituteType(p.Type, subst, mapClrType), p.DeclaringSyntax)
                if p.HasExplicitDefaultValue {
                    newParam.SetExplicitDefaultValue(p.ExplicitDefaultValue)
                }
                substParams.Add(newParam)
            }
            let substReturn = SubstituteType(m.Type, subst, mapClrType)
            let substMethod = FunctionSymbol(
                m.Name,
                substParams.MoveToImmutable(),
                substReturn,
                m.Declaration,
                m.Package,
                m.Accessibility,
                receiverType: if isPrivate {
                    instance
                } else {
                    default(InterfaceSymbol?)
                }
            )
            substMethod.ReturnRefKind = m.ReturnRefKind
            if isStatic {
                substMethod.IsStatic = true
                substMethod.StaticOwnerType = instance
            }
            // Issue #2340 follow-up: preserve the ORIGINAL method's own
            // (method-level) generic type parameters, e.g. `func Transform[TOut](...)`
            // on a generic interface `ITransformer[TIn]`. These type parameters are
            // never touched by `subst` (which only maps the INTERFACE's own type
            // parameters, e.g. TIn), so the same TypeParameterSymbol instances
            // remain valid on the constructed method. Without copying them here,
            // every constructed generic interface's methods silently lost their
            // method-level generic arity (defaulting to the empty array), which
            // made `DeclarationBinder.TryBuildMethodTypeParameterMap` see a bogus
            // arity mismatch (0 vs. the implementer's real arity) against ANY
            // otherwise-correct implementation of a generic method on a
            // constructed generic interface, incorrectly rejecting it before
            // signature comparison ever ran and misreporting GS0187.
            if !m.TypeParameters.IsDefaultOrEmpty {
                substMethod.TypeParameters = m.TypeParameters
            }
            return substMethod
        }

        private func SubstituteType(
            type TypeSymbol,
            subst Dictionary[TypeParameterSymbol, TypeSymbol],
            mapClrType((Type) -> Type)?
        ) TypeSymbol {
            if type is TypeParameterSymbol tp && subst.TryGetValue(tp, out var concrete) {
                return concrete
            }
            if TypeSymbol.TrySubstituteCompositeType(
                type,
                (nested TypeSymbol) -> SubstituteType(nested, subst, mapClrType),
                out var composite
            ) {
                return composite
            }
            // Issue #974: a constructed generic interface used as a member type
            // (e.g. a base interface `ISeq[T]` exposing `IComparable[T]`) carries
            // the definition's type parameters in its arguments. Recurse so they
            // are substituted with this constructed instance's type arguments.
            if type is InterfaceSymbol iface && !iface.TypeArguments.IsDefaultOrEmpty {
                let substitutedArgs = ImmutableArray.CreateBuilder[TypeSymbol](iface.TypeArguments.Length)
                var changed = false
                for var i = 0; i < iface.TypeArguments.Length; i++ {
                    let substituted = SubstituteType(iface.TypeArguments[i], subst, mapClrType)
                    substitutedArgs.Add(substituted)
                    changed |= !object.ReferenceEquals(substituted, iface.TypeArguments[i])
                }
                return if changed {
                    Construct(iface.Definition, substitutedArgs.MoveToImmutable(), mapClrType)!!
                } else {
                    iface
                }
            }
            if type is EnumSymbol enumType {
                let enclosingArgs = EnumSymbol.SubstituteEnclosingArguments(
                    enumType,
                    (argument TypeSymbol) -> {
                        return SubstituteType(argument, subst, mapClrType)
                    }
                )
                return if enclosingArgs.IsDefaultOrEmpty {
                    enumType
                } else {
                    EnumSymbol.ConstructNested(enumType.Definition ?? enumType, enclosingArgs)!!
                }
            }
            // Issue #2340 follow-up: a member type that is a constructed
            // struct/class over the interface's own type parameter (e.g. a
            // generic interface method `func Make() Box[T]`) carries the
            // definition's type parameters in its arguments, exactly like the
            // InterfaceSymbol case above. Without this branch a constructed
            // interface's method kept exposing `Box[T_iface]` instead of
            // `Box[int32]`, which made GS0187's signature-matching (see
            // DeclarationBinder.TypeSignaturesEquivalent's StructSymbol branch)
            // compare an unsubstituted type argument against the implementing
            // class's closed argument and reject a genuinely correct
            // implementation. Mirrors StructSymbol.SubstituteTypeForConstruction's
            // own recursive handling of nested constructed generics.
            if type is StructSymbol structType && !structType.TypeArguments.IsDefaultOrEmpty {
                return StructSymbol.SubstituteConstructionArguments(
                    structType,
                    (argument TypeSymbol) -> {
                        return SubstituteType(argument, subst, mapClrType)
                    },
                    mapClrType
                )
            }
            // Issue #2340 follow-up (sibling to the #1503 branch already present
            // in StructSymbol.SubstituteTypeForConstruction, and the matching
            // Binder.SubstituteType branch added for the call-site defect): a
            // member type that is a constructed named delegate over the
            // interface's own type parameter (e.g. `func Make() Getter[T]`) must
            // have its own type arguments substituted so the constructed
            // interface exposes `Getter[int32]` rather than the still-open
            // `Getter[T]`.
            if type is DelegateTypeSymbol del && del.Definition != nil && !object.ReferenceEquals(
                del.Definition,
                del
            ) &&
                !del
                .TypeArguments
                .IsDefaultOrEmpty {
                let substitutedArgs = ImmutableArray.CreateBuilder[TypeSymbol](del.TypeArguments.Length)
                var changed = false
                for var i = 0; i < del.TypeArguments.Length; i++ {
                    let substituted = SubstituteType(del.TypeArguments[i], subst, mapClrType)
                    substitutedArgs.Add(substituted)
                    changed |= !object.ReferenceEquals(substituted, del.TypeArguments[i])
                }
                return if changed {
                    DelegateTypeSymbol.Construct(del.Definition, substitutedArgs.MoveToImmutable())!!
                } else {
                    del
                }
            }
            // Issue #974: a member type that is a constructed imported generic over
            // the interface's type parameter (e.g. `func Iter() IEnumerator[T]`)
            // must have its symbolic type arguments rewritten so the constructed
            // interface exposes `IEnumerator[T_class]` rather than the definition's
            // `IEnumerator[T_iface]`. Mirrors StructSymbol's construction-time
            // substitution.
            if type is ImportedTypeSymbol imported &&
                imported.OpenDefinition != nil &&
                !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                let substitutedArgs = ImmutableArray.CreateBuilder[TypeSymbol](imported.TypeArguments.Length)
                var changed = false
                for var i = 0; i < imported.TypeArguments.Length; i++ {
                    let substituted = SubstituteType(imported.TypeArguments[i], subst, mapClrType)
                    substitutedArgs.Add(substituted)
                    changed |= !object.ReferenceEquals(substituted, imported.TypeArguments[i])
                }
                if !changed {
                    return imported
                }
                // Issue #1958: project each resolved CLR arg into the same
                // reflection context as `imported.OpenDefinition` before calling
                // MakeGenericType — mirrors Binder.SubstituteType's mapClrType
                // fix for issue #1926 (PR #1956). Without this, a raw host CLR
                // type mixed with an MLC-resolved open definition throws
                // ArgumentException and silently erases the substitution.
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
                    let assertMessage = "InterfaceSymbol.SubstituteType: MakeGenericType failed for '${imported.OpenDefinition}' with args [${FormatClrTypes(resolvedClrArgs)}] even after mapClrType projection."
                    Debug.WriteLine(assertMessage)
                    return imported
                }
            }
            return type
        }

        private func FormatClrTypes(types[]Type) string {
            let text = [types.Length]string
            for var i = 0; i < types.Length; i++ {
                text[i] = types[i].ToString()
            }
            return string.Join(", ", text)
        }
    }
}
