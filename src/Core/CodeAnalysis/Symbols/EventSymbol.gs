// <copyright file="EventSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Syntax
import System.Reflection

/// Represents an event declared on a user-defined type (ADR-0052).
class EventSymbol : Symbol {
    /// Initializes a new instance of the (cref:EventSymbol) class.
    /// @param name The event name.
    /// @param type The event handler type (should be a FunctionTypeSymbol).
    /// @param accessibility The event accessibility.
    /// @param isFieldLike Whether this is a field-like event (no explicit accessors).
    /// @param isVirtual Whether this event is virtual (open modifier present).
    /// @param isOverride Whether this event overrides a base event.
    /// @param isStatic Whether this event is declared inside a `shared` block (ADR-0053).
    /// @param declaration The declaring syntax node, or `null` for synthesized events.
    init(
        name string,
        type TypeSymbol,
        accessibility Accessibility,
        isFieldLike bool,
        isVirtual bool,
        isOverride bool,
        isStatic bool = false,
        declaration EventDeclarationSyntax? = nil
    ) : base(name) {
        Type = type
        Accessibility = accessibility
        IsFieldLike = isFieldLike
        IsVirtual = isVirtual
        IsOverride = isOverride
        IsStatic = isStatic
        Declaration = declaration
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    /// Gets the reflected member an imported symbol stands for, or null for a declared one (ADR-0212 slice S4).
    /// @remarks The language server reads it to find documentation and cross-assembly definitions until
    /// handle-backed imported symbols replace it (ADR-0209 stage 6).
    prop ImportedMember EventInfo? {
        get;
        internal set;
    }

    override prop Kind SymbolKind -> SymbolKind.Event

    /// Gets the event handler type.
    prop Type TypeSymbol {
        get;
    }

    /// Gets the event accessibility.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets a value indicating whether this is a field-like event (no explicit accessors).
    prop IsFieldLike bool {
        get;
    }

    /// Gets a value indicating whether this event is virtual (open modifier present).
    prop IsVirtual bool {
        get;
    }

    /// Gets a value indicating whether this event overrides a base event.
    prop IsOverride bool {
        get;
    }

    /// Gets a value indicating whether this event is declared inside a `shared` block (ADR-0053).
    prop IsStatic bool {
        get;
    }

    /// Gets the declaring syntax node, or `null` for synthesized events.
    prop Declaration EventDeclarationSyntax? {
        get;
        private set;
    }

    /// Gets or sets the synthesized backing delegate field (null for explicit accessors).
    prop BackingField FieldSymbol?

    /// Gets or sets the synthesized add method symbol.
    prop AddMethodSymbol FunctionSymbol?

    /// Gets or sets the synthesized remove method symbol.
    prop RemoveMethodSymbol FunctionSymbol?

    /// Gets or sets the synthesized raise method symbol (issue #257). Null when no `raise` accessor is
    /// declared.
    prop RaiseMethodSymbol FunctionSymbol?

    /// Gets or sets the imported CLR add slot overridden by this event.
    prop ExternalOverriddenAddMethod MethodInfo?

    /// Gets or sets the imported CLR remove slot overridden by this event.
    prop ExternalOverriddenRemoveMethod MethodInfo?

    /// Gets or sets the imported CLR raise slot overridden by this event.
    prop ExternalOverriddenRaiseMethod MethodInfo?

    /// Gets or sets the source-declared base event overridden by this event.
    prop OverriddenEvent EventSymbol?

    /// Gets or sets the imported interface add slot explicitly implemented by this event.
    prop ExplicitInterfaceAddSlot MethodInfo?

    /// Gets or sets the imported interface remove slot explicitly implemented by this event.
    prop ExplicitInterfaceRemoveSlot MethodInfo?

    /// Gets or sets the imported interface raise slot explicitly implemented by this event.
    prop ExplicitInterfaceRaiseSlot MethodInfo?

    /// Gets or sets the imported interface type that owns the explicit accessor slots.
    prop ExplicitInterfaceSlotContainingType TypeSymbol?

    /// Gets or sets the imported constructed base type that owns the overridden event accessors.
    prop ExternalOverrideContainingType TypeSymbol?

    /// Gets or sets the explicit add body syntax (null for field-like events).
    prop AddBodySyntax BlockStatementSyntax?

    /// Gets or sets the explicit remove body syntax (null for field-like events).
    prop RemoveBodySyntax BlockStatementSyntax?

    /// Gets or sets the explicit raise body syntax (issue #257). Null when no `raise` accessor is declared.
    prop RaiseBodySyntax BlockStatementSyntax?

    /// Gets or sets the in-compilation (G#) interface member this event
    /// explicitly implements (ADR-0149, generalizing the #2010/#2362
    /// explicit-interface convention from methods/properties to events for
    /// the first time). Set when the event carries a dedicated
    /// explicit-interface qualifier clause (`event (IFoo) Changed T`,
    /// ADR-0149) whose bound interface type —
    /// see (cref:ExplicitInterfaceClauseTarget) — declares a member
    /// with this event's own plain name and a matching handler type. Mirrors
    /// (cref:PropertySymbol.ExplicitInterfaceMember): the emitter
    /// resolves this event's add/remove accessor methods to a MethodDef or
    /// (for a constructed generic interface) a MemberRef/TypeSpec token and
    /// binds a `MethodImpl` row per accessor so the CLR routes interface
    /// dispatch to this event's own distinct accessor bodies. Defaults to
    /// `null` for ordinary events.
    prop ExplicitInterfaceMember EventSymbol?

    /// Gets a value indicating whether this event's declaration carries a
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

    /// ADR-0105 Phase 2 — re-points this (reused) event at the declaration node
    /// of a freshly-parsed syntax tree whose event signature and accessor shape
    /// are byte-identical to the previous one (a body-only edit). The caller is
    /// responsible for re-pointing (cref:AddBodySyntax),
    /// (cref:RemoveBodySyntax) and (cref:RaiseBodySyntax) at the
    /// corresponding accessor bodies in the re-parsed tree. The symbol's identity
    /// (including the add/remove/raise method symbols) is preserved so
    /// cross-compilation reuse stays sound. Intended to be called only by
    /// (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration EventDeclarationSyntax) {
        Declaration = declaration
    }
}
