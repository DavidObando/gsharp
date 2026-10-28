// <copyright file="PropertySymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Reflection

/// Represents a property declared on a user-defined type (ADR-0051).
class PropertySymbol : Symbol {
    private var getterSymbol FunctionSymbol?
    private var setterSymbol FunctionSymbol?

    /// Initializes a new instance of the (cref:PropertySymbol) class.
    /// @param name The property name.
    /// @param type The property type.
    /// @param accessibility The property accessibility.
    /// @param hasGetter Whether this property has a getter accessor.
    /// @param hasSetter Whether this property has a setter accessor (a `set` or an `init` accessor).
    /// @param isAutoProperty Whether this is an auto-property (compiler-synthesized backing field).
    /// @param isVirtual Whether this property is virtual (open).
    /// @param isOverride Whether this property overrides a base property.
    /// @param setterParameterName The setter parameter name (defaults to "value").
    /// @param isStatic Whether this property is declared inside a `shared` block (ADR-0053).
    /// @param declaration The declaring syntax node, or `null` for synthesized properties.
    /// @param isInitOnly Whether the property's setter is an `init`-only accessor (issue #946).
    /// @param getterAccessibility The getter accessibility, or the property accessibility when omitted.
    /// @param setterAccessibility The setter accessibility, or the property accessibility when omitted.
    /// @param metadataIsAbstract The abstractness read straight out of metadata for an imported property,
    /// or
    /// `null` for a source-declared property whose abstractness is inferred
    /// from its declaration shape (issue #2874).
    init(
        name string,
        type TypeSymbol,
        accessibility Accessibility,
        hasGetter bool,
        hasSetter bool,
        isAutoProperty bool,
        isVirtual bool,
        isOverride bool,
        setterParameterName string = "value",
        isStatic bool = false,
        declaration PropertyDeclarationSyntax? = nil,
        isInitOnly bool = false,
        getterAccessibility Accessibility? = nil,
        setterAccessibility Accessibility? = nil,
        metadataIsAbstract bool? = nil
    ) : base(name) {
        Parameters = ImmutableArray[ParameterSymbol].Empty
        Type = type
        Accessibility = accessibility
        HasGetter = hasGetter
        HasSetter = hasSetter
        IsAutoProperty = isAutoProperty
        IsVirtual = isVirtual
        IsOverride = isOverride
        SetterParameterName = setterParameterName
        IsStatic = isStatic
        Declaration = declaration
        IsInitOnly = isInitOnly
        GetterAccessibility = getterAccessibility ?? accessibility
        SetterAccessibility = setterAccessibility ?? accessibility
        MetadataIsAbstract = metadataIsAbstract
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    /// Gets the reflected member an imported symbol stands for, or null for a declared one (ADR-0212 slice S4).
    /// @remarks The language server reads it to find documentation and cross-assembly definitions until
    /// handle-backed imported symbols replace it (ADR-0209 stage 6).
    prop ImportedMember PropertyInfo? {
        get;
        internal set;
    }

    override prop Kind SymbolKind -> SymbolKind.Property

    /// Gets the property type.
    prop Type TypeSymbol {
        get;
    }

    /// Gets the property accessibility.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets the getter accessor accessibility.
    prop GetterAccessibility Accessibility {
        get;
    }

    /// Gets the setter accessor accessibility.
    prop SetterAccessibility Accessibility {
        get;
    }

    /// Gets a value indicating whether this property has a getter accessor.
    prop HasGetter bool {
        get;
    }

    /// Gets a value indicating whether this property has a setter accessor (a `set` or an `init` accessor).
    prop HasSetter bool {
        get;
    }

    /// Gets a value indicating whether this property's setter is an
    /// `init`-only accessor (issue #946). An init-only setter is emitted
    /// as a `set_Prop` method whose void return carries the
    /// `System.Runtime.CompilerServices.IsExternalInit` modreq, and
    /// assignment is restricted to object initialization (the declaring type's
    /// constructors, object/aggregate initializers at the creation site, and
    /// other `init` accessors of the same instance).
    prop IsInitOnly bool {
        get;
    }

    /// Gets a value indicating whether this is an auto-property (compiler-synthesized backing field).
    prop IsAutoProperty bool {
        get;
    }

    /// Gets a value indicating whether this property is virtual (open).
    prop IsVirtual bool {
        get;
    }

    /// Gets a value indicating whether this property overrides a base property.
    prop IsOverride bool {
        get;
    }

    /// Gets the abstractness read straight out of metadata for an imported property, or
    /// `null` when this property was declared in source (issue #2874).
    /// @remarks An imported property carries no body syntax, so the source-shape inference below
    /// classified every virtual, non-overriding imported property (for example one that
    /// implements an interface member, which is emitted `virtual newslot`) as abstract.
    /// That propagated to (cref:StructSymbol.IsAbstract) and made the whole imported
    /// type unconstructible with `GS0386`. Metadata already records the answer exactly,
    /// so imported properties bypass the inference entirely.
    prop MetadataIsAbstract bool? {
        get;
    }

    /// Gets a value indicating whether this property declares an abstract accessor slot.
    prop IsAbstract bool -> MetadataIsAbstract ??
        (
        Declaration?.AbstractModifier != nil ||
            (
            IsVirtual &&
                !IsOverride &&
                !IsAutoProperty &&
                ((HasGetter && GetterBodySyntax == nil) || (HasSetter && SetterBodySyntax == nil))
        )
    )

    /// Gets the setter parameter name (defaults to "value").
    prop SetterParameterName string {
        get;
    }

    /// Gets a value indicating whether this property is declared inside a `shared` block (ADR-0053).
    prop IsStatic bool {
        get;
    }

    /// Gets the declaring syntax node, or `null` for synthesized properties.
    prop Declaration PropertyDeclarationSyntax? {
        get;
        private set;
    }

    /// Gets the declaring syntax — the property's IDENTIFIER, matching what
    /// #3847 already does for a field and what Roslyn's
    /// `IPropertySymbol.Locations[0]` points at (ADR-0169, issue #3794).
    ///
    /// A migrated symbol-action analyzer reports at `Symbol.Location`, and
    /// the whole declaration spans the accessors and the initializer, so the
    /// reported span swallowed the marked name and the verifier rejected it as
    /// not contained in the marker. The name is the construct the diagnostic is
    /// about; the accessors are not.
    override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> if Declaration is {} declaration {
        ImmutableArray.Create[SyntaxNode](declaration.Identifier)
    } else {
        ImmutableArray[SyntaxNode].Empty
    }

    /// Gets or sets the synthesized backing field symbol for auto-properties. Null for computed properties.
    prop BackingField FieldSymbol?

    /// Gets or sets the synthesized getter function symbol. Assigning one
    /// records this property as its (cref:FunctionSymbol.AssociatedSymbol).
    prop GetterSymbol FunctionSymbol? {
        get -> getterSymbol
        set {
            ReleaseAccessor(getterSymbol, value)
            getterSymbol = value
            AssociateAccessor(value)
        }
    }

    /// Gets or sets the synthesized setter function symbol. Assigning one
    /// records this property as its (cref:FunctionSymbol.AssociatedSymbol).
    prop SetterSymbol FunctionSymbol? {
        get -> setterSymbol
        set {
            ReleaseAccessor(setterSymbol, value)
            setterSymbol = value
            AssociateAccessor(value)
        }
    }

    /// Gets or sets the imported CLR getter slot overridden by this property.
    prop ExternalOverriddenGetter MethodInfo?

    /// Gets or sets the imported CLR setter slot overridden by this property.
    prop ExternalOverriddenSetter MethodInfo?

    /// Returns a copy of this property with [`type`](paramref) and
    /// [`parameters`](paramref) in place of its own, keeping everything
    /// else, including the declaration and the documentation. A constructed generic type's member
    /// substitution builds its members this way, and the language server uses
    /// it to show a member read through a constructed interface (issue #4989).
    /// @param type The substituted property type.
    /// @param parameters The substituted indexer parameters.
    /// @returns The copy.
    internal func WithSignature(type TypeSymbol, parameters ImmutableArray[ParameterSymbol]) PropertySymbol {
        let copy = PropertySymbol(
            Name,
            type,
            Accessibility,
            HasGetter,
            HasSetter,
            IsAutoProperty,
            IsVirtual,
            IsOverride,
            SetterParameterName,
            IsStatic,
            Declaration,
            IsInitOnly,
            GetterAccessibility,
            SetterAccessibility,
            MetadataIsAbstract
        ){
            IsIndexer = IsIndexer,
            Parameters = parameters,
            BackingField = BackingField,
            GetterSymbol = GetterSymbol,
            SetterSymbol = SetterSymbol,
            OverriddenProperty = OverriddenProperty,
            ExternalOverriddenGetter = ExternalOverriddenGetter,
            ExternalOverriddenSetter = ExternalOverriddenSetter,
            ExternalOverrideContainingType = ExternalOverrideContainingType,
            GetterBodySyntax = GetterBodySyntax,
            SetterBodySyntax = SetterBodySyntax,
            ReturnRefKind = ReturnRefKind
        }
        // The documentation is binder-attached state, not part of the declaration.
        if this.GetDocumentation() is {} documentation {
            copy.SetDocumentation(documentation)
        }
        return copy
    }

    /// Gets or sets the source-declared base property overridden by this property.
    prop OverriddenProperty PropertySymbol?

    /// Gets or sets the imported interface getter slot explicitly implemented by this property.
    prop ExplicitInterfaceGetterSlot MethodInfo?

    /// Gets or sets the imported interface setter slot explicitly implemented by this property.
    prop ExplicitInterfaceSetterSlot MethodInfo?

    /// Gets or sets the imported interface type that owns the explicit accessor slots.
    prop ExplicitInterfaceSlotContainingType TypeSymbol?

    /// Gets or sets the imported constructed base type that owns the overridden accessors.
    prop ExternalOverrideContainingType TypeSymbol?

    /// Gets a value indicating whether this property is an indexer member
    /// (ADR-0118 / issue #944). Indexers are emitted as the CLR default
    /// member named `Item` with index parameters.
    prop IsIndexer bool {
        get;
        init;
    }

    /// Gets the index parameters of an indexer member (ADR-0118). Empty for an
    /// ordinary property.
    prop Parameters ImmutableArray[ParameterSymbol] {
        get;
        init;
    }

    /// Gets or sets the by-reference mode of this property's (or indexer's)
    /// GETTER return value — issue #3879, the ADR-0060 amendment that extends
    /// the by-ref return from `func` to `prop`. (cref:Binding.RefKind.Ref)
    /// means the property was declared `prop P ref T`: the PropertyDef
    /// signature and the `get_P` MethodDef signature both encode
    /// `T&`, so a CLR consumer can alias the storage
    /// (`ref int slot = ref holder.P`). Only (cref:Binding.RefKind.None),
    /// (cref:Binding.RefKind.Ref), and (cref:Binding.RefKind.RefReadOnly) are valid here, mirroring
    /// (cref:FunctionSymbol.ReturnRefKind). (cref:Type) stays the
    /// POINTEE type `T` throughout, exactly as it does for a ref-returning
    /// function — the by-ref-ness is a separate bit, not a
    /// (cref:ByRefTypeSymbol) wrap.
    private var _returnRefKind RefKind = RefKind.None

    prop ReturnRefKind RefKind {
        get {
            return _returnRefKind
        }
        set {
            _returnRefKind = value
        }
    }

    /// Gets or sets the getter accessor body syntax (for computed properties). Null for auto-properties.
    prop GetterBodySyntax BlockStatementSyntax?

    /// Gets or sets the setter accessor body syntax (for computed properties). Null for auto-properties.
    prop SetterBodySyntax BlockStatementSyntax?

    /// Gets or sets the in-compilation (G#) interface member this property
    /// explicitly implements (issue #2362, extending the #2010 convention
    /// from methods to properties/indexers; ADR-0149 rewrites the
    /// source-level convention that establishes this link). Set when the
    /// property carries a dedicated explicit-interface qualifier clause
    /// (`prop (IFoo) P T` / `prop (IFoo) this[...] T`, ADR-0149)
    /// whose bound interface type — see (cref:ExplicitInterfaceClauseTarget) —
    /// declares a member with this property's own plain name and a matching
    /// accessor shape. Mirrors (cref:FunctionSymbol.ExplicitInterfaceMember):
    /// the emitter resolves this property's getter/setter accessor methods to a
    /// MethodDef or (for a constructed generic interface) a
    /// MemberRef/TypeSpec token and binds a `MethodImpl` row per
    /// accessor so the CLR routes interface dispatch to this property's own
    /// distinct accessor bodies instead of relying on name-based virtual
    /// dispatch. An explicit property implementation never collides with a
    /// same-named public concrete property (the #2362 defect) because
    /// explicit-clause members are exempt from the plain duplicate-name check
    /// — see (cref:HasExplicitInterfaceClause) and
    /// (cref:Binding.DeclarationBinder.ResolveExplicitInterfaceClauses).
    /// Defaults to `null` for ordinary properties.
    prop ExplicitInterfaceMember PropertySymbol?

    /// Gets a value indicating whether this property's declaration carries a
    /// dedicated explicit-interface qualifier clause (ADR-0149) — a purely
    /// syntactic fact known immediately at declaration time, before
    /// (cref:ExplicitInterfaceClauseTarget) is resolved against the
    /// containing type's implemented interfaces.
    prop HasExplicitInterfaceClause bool -> Declaration?.HasExplicitInterfaceClause == true

    /// Gets or sets the interface type the explicit-interface
    /// qualifier clause ((cref:HasExplicitInterfaceClause)) resolves
    /// to, bound by (cref:Binding.DeclarationBinder.ResolveExplicitInterfaceClauses).
    /// `null` until resolved.
    prop ExplicitInterfaceClauseTarget TypeSymbol?

    /// ADR-0105 Phase 2 — re-points this (reused) property at the declaration
    /// node of a freshly-parsed syntax tree whose property signature and
    /// accessor shape are byte-identical to the previous one (a body-only edit).
    /// The caller is responsible for re-pointing (cref:GetterBodySyntax)
    /// and (cref:SetterBodySyntax) at the corresponding accessor bodies in
    /// the re-parsed tree. The symbol's identity (including
    /// (cref:GetterSymbol)/(cref:SetterSymbol)) is preserved so
    /// cross-compilation reuse stays sound. Intended to be called only by
    /// (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration PropertyDeclarationSyntax) {
        Declaration = declaration
    }

    // An accessor keeps the property that first claimed it. A constructed
    // generic property reuses its definition's accessors, and repointing them
    // at the substitution would lose the definition's attributes, which is
    // what an analyzer reads through AssociatedSymbol.
    //
    // Issue #4589: this is also the single place that marks an accessor
    // SpecialName. Every property accessor is a SpecialName method in CLR
    // metadata (as C# emits it, and as gsc's metadata-only path already did),
    // and FunctionEmitter stamps the flag only from FunctionSymbol.IsSpecialName.
    // Setting it per creation site let computed, explicit-interface and shared
    // accessors drift out of it.
    private func AssociateAccessor(accessor FunctionSymbol?) {
        if accessor == nil {
            return
        }
        accessor.IsSpecialName = true
        if accessor.AssociatedSymbol == nil {
            accessor.AssociatedSymbol = this
        }
    }

    // An accessor that is replaced or removed stops naming this property as
    // its associated symbol, unless it is being assigned again.
    private func ReleaseAccessor(previous FunctionSymbol?, next FunctionSymbol?) {
        if previous != nil && !object.ReferenceEquals(previous, next) && object.ReferenceEquals(
            previous.AssociatedSymbol,
            this
        ) {
            previous.AssociatedSymbol = nil
        }
    }
}
