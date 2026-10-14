// <copyright file="GMember.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System
import System.Collections.Generic

/// Base type for a member that may appear in a type body or, where the grammar
/// allows, at the top level (functions and variables).
abstract class GMember : GNode { }

/// A field or top-level variable declaration. Fields require a binding keyword
/// and a type (ADR-0067, ADR-0115 §B.3/§B.11); top-level variables may infer
/// the type from an initializer.
class FieldDeclaration : GMember {
    /// Initializes a new instance of the (cref:FieldDeclaration) class.
    /// @param binding The binding keyword.
    /// @param name The field name.
    /// @param type The field type (optional only for inferred top-level variables).
    /// @param initializer The optional initializer expression.
    /// @param visibility The accessibility.
    /// @param attributes The field attributes.
    /// @param fixedBufferLength The element count for a (cref:BindingKind.FixedBuffer) field
    /// (ADR-0122 §10); `null` for every other binding.
    /// [`type`](paramref) carries the buffer's ELEMENT type in that case
    /// (e.g. `int8`, not `[32]int8`) — the printer renders the
    /// bracketed count itself.
    init(
        binding BindingKind,
        name string,
        type GTypeReference? = nil,
        initializer GExpression? = nil,
        visibility Visibility = Visibility.Default,
        attributes IReadOnlyList[AttributeUse]? = nil,
        fixedBufferLength int32? = nil
    ) {
        Binding = binding
        Name = name
        Type = type
        Initializer = initializer
        Visibility = visibility
        Attributes = attributes ?? List[AttributeUse]()
        FixedBufferLength = fixedBufferLength
    }

    /// Gets the binding keyword.
    prop Binding BindingKind {
        get;
    }

    /// Gets the field name.
    prop Name string {
        get;
    }

    /// Gets the field type.
    prop Type GTypeReference? {
        get;
    }

    /// Gets the optional initializer expression.
    prop Initializer GExpression? {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets the field attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }

    /// Gets the element count for a (cref:BindingKind.FixedBuffer)
    /// field, or `null` for every other binding.
    prop FixedBufferLength int32? {
        get;
    }
}

/// A property accessor (ADR-0051, ADR-0115 §B.11). A bodyless accessor renders
/// as a signature-only contract; a bodied accessor renders its block.
class PropertyAccessor : GNode {
    /// Initializes a new instance of the (cref:PropertyAccessor) class.
    /// @param kind The accessor kind.
    /// @param body The optional accessor body.
    /// @param setterParameterName The setter value parameter name (e.g. `v`).
    /// @param expressionBody The optional single-statement arrow body (issue #1278 / ADR-0131); when set
    /// the accessor renders as `get -> expr` / `set -> expr`.
    /// @param visibility The optional accessor-specific accessibility.
    init(
        kind AccessorKind,
        body BlockStatement? = nil,
        setterParameterName string? = nil,
        expressionBody GStatement? = nil,
        visibility Visibility = Visibility.Default
    ) {
        Kind = kind
        Body = body
        SetterParameterName = setterParameterName
        ExpressionBody = expressionBody
        Visibility = visibility
    }

    /// Gets the accessor kind.
    prop Kind AccessorKind {
        get;
    }

    /// Gets the optional accessor body.
    prop Body BlockStatement? {
        get;
    }

    /// Gets the setter value parameter name.
    prop SetterParameterName string? {
        get;
    }

    /// Gets the optional single-statement arrow body (issue #1278 / ADR-0131).
    /// When non-null the accessor renders as an expression-bodied accessor
    /// `get -> expr` / `set -> expr` rather than a block body.
    prop ExpressionBody GStatement? {
        get;
    }

    /// Gets the optional accessor-specific accessibility.
    prop Visibility Visibility {
        get;
    }
}

/// A property (ADR-0051, ADR-0115 §B.11). With no accessors it is an
/// auto-property `prop Name T`; otherwise the accessor bodies are rendered.
class PropertyDeclaration : GMember {
    /// Initializes a new instance of the (cref:PropertyDeclaration) class.
    /// @param name The property name.
    /// @param type The property type.
    /// @param accessors The accessors; empty for an auto-property.
    /// @param visibility The accessibility.
    /// @param isOpen Whether the property is `open` (virtual).
    /// @param isOverride Whether the property is an `override`.
    /// @param attributes The property attributes.
    /// @param indexerParameters The index parameters for an indexer member (ADR-0118); empty for an
    /// ordinary property.
    /// @param expressionBody The optional single-statement arrow body for an expression-bodied read-only
    /// property/indexer (issue #1278 / ADR-0131); when set the member renders as `prop Name T -> expr`.
    /// @param explicitInterfaceType ADR-0149: the resolved explicit-interface qualifier clause type, or
    /// `null` for an ordinary property. When set, the
    /// property renders as `prop (InterfaceType) Name T` (or
    /// `prop (InterfaceType) this[...] T` for an indexer) — see
    /// `GSharpPrinter.RenderProperty`.
    /// Mutually exclusive with any receiver-clause concept (properties have
    /// no receiver clause of their own to begin with).
    /// @param isRefReturn Whether the declared type carries G#'s `ref` return modifier
    /// (`prop P ref int32 { get { return ref slot } }`, issue #3879 /
    /// the ADR-0060 amendment) — mapped from a C# ref-returning property or
    /// indexer (issue #3839).
    /// @param isReadOnlyRefReturn Whether the return reference is readonly.
    /// @param isAbstract Whether the property explicitly declares abstract accessor slots.
    init(
        name string,
        type GTypeReference,
        accessors IReadOnlyList[PropertyAccessor]? = nil,
        visibility Visibility = Visibility.Default,
        isOpen bool = false,
        isOverride bool = false,
        attributes IReadOnlyList[AttributeUse]? = nil,
        indexerParameters IReadOnlyList[Parameter]? = nil,
        expressionBody GStatement? = nil,
        explicitInterfaceType GTypeReference? = nil,
        isRefReturn bool = false,
        isReadOnlyRefReturn bool = false,
        isAbstract bool = false
    ) {
        Name = name
        Type = type
        Accessors = accessors ?? List[PropertyAccessor]()
        Visibility = visibility
        IsOpen = isOpen
        IsOverride = isOverride
        Attributes = attributes ?? List[AttributeUse]()
        IndexerParameters = indexerParameters ?? List[Parameter]()
        ExpressionBody = expressionBody
        ExplicitInterfaceType = explicitInterfaceType
        IsRefReturn = isRefReturn
        IsReadOnlyRefReturn = isReadOnlyRefReturn
        IsAbstract = isAbstract
    }

    /// Gets the property name.
    prop Name string {
        get;
    }

    /// Gets the property type.
    prop Type GTypeReference {
        get;
    }

    /// Gets the accessors; empty for an auto-property.
    prop Accessors IReadOnlyList[PropertyAccessor] {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets a value indicating whether the property is `open`.
    prop IsOpen bool {
        get;
    }

    /// Gets a value indicating whether the property is an `override`.
    prop IsOverride bool {
        get;
    }

    /// Gets a value indicating whether this property explicitly declares abstract accessor slots.
    prop IsAbstract bool {
        get;
    }

    /// Gets the property attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }

    /// Gets the index parameters for an indexer member (ADR-0118); empty for an ordinary property.
    prop IndexerParameters IReadOnlyList[Parameter] {
        get;
    }

    /// Gets a value indicating whether this property is an indexer member (`prop this[...]`).
    prop IsIndexer bool -> IndexerParameters.Count > 0

    /// Gets the optional single-statement arrow body (issue #1278 / ADR-0131).
    /// When non-null the property/indexer renders as an expression-bodied
    /// read-only member `prop Name T -> expr` rather than an accessor list.
    prop ExpressionBody GStatement? {
        get;
    }

    /// Gets the ADR-0149 explicit-interface qualifier clause type, or
    /// `null` for an ordinary property.
    prop ExplicitInterfaceType GTypeReference? {
        get;
    }

    /// Gets a value indicating whether the declared type carries G#'s
    /// `ref` return modifier (issue #3879 / the ADR-0060 amendment):
    /// `prop P ref int32 -> slot`. The getter then returns a managed
    /// pointer, so a CLR consumer can write through
    /// `ref int x = ref holder.P`. Restricted by gsc to the computed,
    /// read-only forms, which is exactly the shape a C# ref-returning
    /// property/indexer always has.
    prop IsRefReturn bool {
        get;
    }

    /// Gets a value indicating whether the return reference is readonly.
    prop IsReadOnlyRefReturn bool {
        get;
    }
}

/// A function or method (ADR-0024/ADR-0079, ADR-0115 §B.5). When
/// (cref:Receiver) is set the declaration renders as a receiver-clause
/// extension function; issue #3357's explicit form also supports enum and owned
/// extension receivers. Otherwise it is an in-body method on an owned type (or
/// a top-level function). A `null`
/// (cref:Body) renders the bodyless `;` form (interface/abstract).
class MethodDeclaration : GMember {
    /// Initializes a new instance of the (cref:MethodDeclaration) class.
    /// @param name The method name.
    /// @param parameters The parameters.
    /// @param returnType The return type, or `null` for void.
    /// @param body The body, or `null` for the bodyless form.
    /// @param typeParameters The generic type parameters.
    /// @param receiver The receiver clause for an extension function.
    /// @param visibility The accessibility.
    /// @param isOpen Whether the method is `open` (virtual).
    /// @param isOverride Whether the method is an `override`.
    /// @param isAsync Whether the method is asynchronous.
    /// @param attributes The method attributes.
    /// @param expressionBody The optional single-statement arrow body for an expression-bodied
    /// method/function (issue #1278 / ADR-0131); when set the member renders as `func F(...) T -> expr`.
    /// @param isRefReturn Whether the declared return type carries G#'s `ref` return
    /// modifier (`func F(...) ref T { return ref lvalue }`, issue #490 /
    /// ADR-0060) — mapped from a C# ref-returning method (issue #1900).
    /// @param explicitInterfaceType ADR-0149: the resolved explicit-interface qualifier clause type, or
    /// `null` for an ordinary method. When set, the method
    /// renders as `func (InterfaceType) Name(...)` — see
    /// `GSharpPrinter.RenderMethod`.
    /// Mutually exclusive with [`receiver`](paramref): a C# method
    /// cannot be both an extension method and an explicit interface
    /// implementation, so callers never set both.
    /// @param isSuspend ADR-0174: whether the method renders as a `suspend func`; see (cref:IsSuspend).
    /// @param isReadOnlyRefReturn Whether the return reference is readonly.
    /// @param isPartial ADR-0192: whether the method renders as one part of a `partial func` pair; see
    /// (cref:IsPartial).
    /// @param partialPairKey ADR-0192: identifies the two parts of one partial method pair across
    /// compilation units; see (cref:PartialPairKey).
    init(
        name string,
        parameters IReadOnlyList[Parameter]? = nil,
        returnType GTypeReference? = nil,
        body BlockStatement? = nil,
        typeParameters IReadOnlyList[TypeParameter]? = nil,
        receiver Receiver? = nil,
        visibility Visibility = Visibility.Default,
        isOpen bool = false,
        isOverride bool = false,
        isAsync bool = false,
        attributes IReadOnlyList[AttributeUse]? = nil,
        expressionBody GStatement? = nil,
        isRefReturn bool = false,
        explicitInterfaceType GTypeReference? = nil,
        isSuspend bool = false,
        isReadOnlyRefReturn bool = false,
        isPartial bool = false,
        partialPairKey string? = nil
    ) {
        Name = name
        Parameters = parameters ?? List[Parameter]()
        ReturnType = returnType
        Body = body
        TypeParameters = typeParameters ?? List[TypeParameter]()
        Receiver = receiver
        Visibility = visibility
        IsOpen = isOpen
        IsOverride = isOverride
        IsAsync = isAsync
        Attributes = attributes ?? List[AttributeUse]()
        ExpressionBody = expressionBody
        IsRefReturn = isRefReturn
        IsReadOnlyRefReturn = isReadOnlyRefReturn
        ExplicitInterfaceType = explicitInterfaceType
        IsSuspend = isSuspend
        IsPartial = isPartial
        PartialPairKey = partialPairKey
    }

    /// Gets the method name.
    prop Name string {
        get;
    }

    /// Gets the parameters.
    prop Parameters IReadOnlyList[Parameter] {
        get;
    }

    /// Gets the return type, or `null` for void.
    prop ReturnType GTypeReference? {
        get;
    }

    /// Gets the body, or `null` for the bodyless form.
    prop Body BlockStatement? {
        get;
    }

    /// Gets the generic type parameters.
    prop TypeParameters IReadOnlyList[TypeParameter] {
        get;
    }

    /// Gets the receiver clause, or `null` for an in-body method.
    prop Receiver Receiver? {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets a value indicating whether the method is `open`.
    prop IsOpen bool {
        get;
    }

    /// Gets a value indicating whether the method is an `override`.
    prop IsOverride bool {
        get;
    }

    /// Gets a value indicating whether the method is asynchronous.
    prop IsAsync bool {
        get;
    }

    /// Gets a value indicating whether the method is a G# `suspend func`
    /// (ADR-0174 D4): a C# `async ValueTask`/`ValueTask<T>`
    /// method that is what a suspending function compiles to. Renders the
    /// `suspend` modifier with the logical (awaited) return type;
    /// mutually exclusive with (cref:IsAsync).
    prop IsSuspend bool {
        get;
    }

    /// Gets the method attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }

    /// Gets the optional single-statement arrow body (issue #1278 / ADR-0131).
    /// When non-null the method/function renders as an expression-bodied member
    /// `func F(...) T -> expr` rather than a block body.
    prop ExpressionBody GStatement? {
        get;
    }

    /// Gets a value indicating whether this method's return type carries
    /// G#'s `ref` return modifier (issue #1900).
    prop IsRefReturn bool {
        get;
    }

    /// Gets a value indicating whether the return reference is readonly.
    prop IsReadOnlyRefReturn bool {
        get;
    }

    /// Gets the ADR-0149 explicit-interface qualifier clause type, or
    /// `null` for an ordinary method.
    prop ExplicitInterfaceType GTypeReference? {
        get;
    }

    /// Gets a value indicating whether this method is one part of an ADR-0192
    /// partial method: the body-less declaring part ((cref:Body) and
    /// (cref:ExpressionBody) both `null`, rendered with
    /// the `;` no-body marker) or the implementing part. Renders the
    /// `partial` modifier immediately before `func`.
    prop IsPartial bool {
        get;
    }

    /// Gets the key shared by the two parts of one ADR-0192 partial method pair
    /// (stable across the compilation units of one translation), or
    /// `null`. The pair is tentative until a post-translation
    /// reconciliation pass has compared both parts' printed signatures.
    prop PartialPairKey string? {
        get;
    }
}

/// An explicit constructor `init(params) [: base(args)] { … }`
/// (ADR-0065, ADR-0115 §B.11).
class ConstructorDeclaration : GMember {
    /// Initializes a new instance of the (cref:ConstructorDeclaration) class.
    /// @param parameters The constructor parameters.
    /// @param body The constructor body.
    /// @param baseArguments The base-constructor arguments, or `null` for no chaining.
    /// @param visibility The accessibility.
    /// @param attributes The constructor attributes.
    /// @param isConvenience Whether this is a delegating `convenience init`.
    /// @param delegatingArguments The same-type initializer arguments, or `null` for no delegation.
    init(
        parameters IReadOnlyList[Parameter],
        body BlockStatement,
        baseArguments IReadOnlyList[GExpression]? = nil,
        visibility Visibility = Visibility.Default,
        attributes IReadOnlyList[AttributeUse]? = nil,
        isConvenience bool = false,
        delegatingArguments IReadOnlyList[GExpression]? = nil
    ) {
        Parameters = parameters ?? List[Parameter]()
        Body = body
        BaseArguments = baseArguments
        Visibility = visibility
        Attributes = attributes ?? List[AttributeUse]()
        IsConvenience = isConvenience || delegatingArguments != nil
        DelegatingArguments = delegatingArguments
    }

    /// Gets a value indicating whether this is a `convenience init` that
    /// delegates to another initializer of the same class (ADR-0065). The
    /// delegation call (`init(args)`) is the first statement of the body.
    prop IsConvenience bool {
        get;
    }

    /// Gets the same-type initializer arguments. The printer lowers these to
    /// the first effective body statement, preserving their evaluation order.
    prop DelegatingArguments IReadOnlyList[GExpression]? {
        get;
    }

    /// Gets or sets the diagnostic identifiers the delegation call
    /// (`init(args)`) must suppress (issue #4422). When non-empty the call
    /// is printed inside an ADR-0175 `@SuppressDiagnostic("ID") { … }`
    /// block, which scopes the suppression to that one call.
    private var _delegatingSuppressedDiagnostics IReadOnlyList[string] = Array.Empty[string]()

    prop DelegatingSuppressedDiagnostics IReadOnlyList[string] {
        get {
            return _delegatingSuppressedDiagnostics
        }
        set {
            _delegatingSuppressedDiagnostics = value
        }
    }

    /// Gets the constructor parameters.
    prop Parameters IReadOnlyList[Parameter] {
        get;
    }

    /// Gets the constructor body.
    prop Body BlockStatement {
        get;
    }

    /// Gets the base-constructor arguments, or `null` for no chaining.
    prop BaseArguments IReadOnlyList[GExpression]? {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets the constructor attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }
}

/// A `shared { … }` block grouping static members on a class, struct, or
/// interface (ADR-0053/ADR-0089, ADR-0115 §B.11).
class SharedBlock : GMember {
    /// Initializes a new instance of the (cref:SharedBlock) class.
    /// @param members The static members.
    init(members IReadOnlyList[GMember]) {
        Members = members ?? List[GMember]()
    }

    /// Gets the static members.
    prop Members IReadOnlyList[GMember] {
        get;
    }
}

/// A static-initializer block mapped to the canonical G# `init { … }` form
/// that lives inside a `shared { }` block (ADR-0140, ADR-0115 §B.11). It
/// carries the body of a non-foldable C# `static` constructor, lowering
/// into the type's `.cctor` after static field initializers.
class StaticInitializerBlock : GMember {
    /// Initializes a new instance of the (cref:StaticInitializerBlock) class.
    /// @param body The static-initializer body.
    init(body BlockStatement) {
        Body = body
    }

    /// Gets the static-initializer body.
    prop Body BlockStatement {
        get;
    }
}

/// A class finalizer / destructor mapped to the canonical G# `deinit { … }`
/// form (ADR-0068; class-only, no parameters or return type). Maps the C#
/// `~Type() { … }` destructor.
class DestructorDeclaration : GMember {
    /// Initializes a new instance of the (cref:DestructorDeclaration) class.
    /// @param body The finalizer body.
    /// @param attributes The finalizer attributes.
    init(body BlockStatement, attributes IReadOnlyList[AttributeUse]? = nil) {
        Body = body
        Attributes = attributes ?? List[AttributeUse]()
    }

    /// Gets the finalizer body.
    prop Body BlockStatement {
        get;
    }

    /// Gets the finalizer attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }
}

/// A field-like event declaration `event Name Type` (spec §Members,
/// `EventDecl`; ADR-0115 §B). The C# form
/// `public event EventHandler<T>? X;` maps to the canonical G#
/// name-then-type ordering with no accessor body; the nullable annotation on the
/// delegate type is dropped because a field-like event is nil-initialized.
class EventDeclaration : GMember {
    /// Initializes a new instance of the (cref:EventDeclaration) class.
    /// @param name The event name.
    /// @param type The handler/delegate type.
    /// @param visibility The accessibility.
    /// @param attributes The event attributes.
    /// @param addBody The explicit `add` accessor body, or `null` for a field-like event.
    /// @param removeBody The explicit `remove` accessor body, or `null` for a field-like event.
    /// @param explicitInterfaceType ADR-0149: the resolved explicit-interface qualifier clause type, or
    /// `null` for an ordinary event. When set, the event
    /// renders as `event (InterfaceType) Name T` — see
    /// `GSharpPrinter.RenderEvent`. C# only allows an explicit interface
    /// event implementation to use the custom add/remove accessor form (never
    /// field-like), so this is only ever set alongside non-null
    /// [`addBody`](paramref)/[`removeBody`](paramref).
    /// @param isOpen Whether the event is `open` (virtual).
    /// @param isOverride Whether the event is an `override`.
    init(
        name string,
        type GTypeReference,
        visibility Visibility = Visibility.Default,
        attributes IReadOnlyList[AttributeUse]? = nil,
        addBody BlockStatement? = nil,
        removeBody BlockStatement? = nil,
        explicitInterfaceType GTypeReference? = nil,
        isOpen bool = false,
        isOverride bool = false
    ) {
        Name = name
        Type = type
        Visibility = visibility
        Attributes = attributes ?? List[AttributeUse]()
        AddBody = addBody
        RemoveBody = removeBody
        ExplicitInterfaceType = explicitInterfaceType
        IsOpen = isOpen
        IsOverride = isOverride
    }

    /// Gets the event name.
    prop Name string {
        get;
    }

    /// Gets the handler/delegate type.
    prop Type GTypeReference {
        get;
    }

    /// Gets the accessibility.
    prop Visibility Visibility {
        get;
    }

    /// Gets the event attributes.
    prop Attributes IReadOnlyList[AttributeUse] {
        get;
    }

    /// Gets a value indicating whether the event is `open`.
    prop IsOpen bool {
        get;
    }

    /// Gets a value indicating whether the event is an `override`.
    prop IsOverride bool {
        get;
    }

    /// Gets the explicit `add` accessor body, or `null` for a
    /// field-like event (ADR-0052 §2 "Event with explicit accessors").
    prop AddBody BlockStatement? {
        get;
    }

    /// Gets the explicit `remove` accessor body, or `null` for a
    /// field-like event.
    prop RemoveBody BlockStatement? {
        get;
    }

    /// Gets a value indicating whether this event has explicit add/remove accessor bodies.
    prop HasExplicitAccessors bool -> AddBody != nil || RemoveBody != nil

    /// Gets the resolved explicit-interface qualifier clause type (ADR-0149),
    /// or `null` for an ordinary event.
    prop ExplicitInterfaceType GTypeReference? {
        get;
    }
}
