// <copyright file="FunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable
import System.Reflection

/// Identifies compiler-generated CLR-representation variants of an unconstrained nullable sequence
/// iterator.
internal enum NullableSequenceSpecializationKind {
    None,
    ReferenceType,
    ValueType
}

/// Represents a function symbol in the language.
class FunctionSymbol : Symbol {
    /// Initializes a new instance of the (cref:FunctionSymbol) class.
    /// @param name The name of the function.
    /// @param parameters The parameters of the function.
    /// @param type The type of the function.
    /// @param declaration The declaration of the function.
    /// @param package The package this function belongs to, or null for built-ins.
    /// @param accessibility The CLR visibility level (defaults to (cref:Accessibility.Public)).
    convenience init(
        name string,
        parameters ImmutableArray[ParameterSymbol],
        type TypeSymbol,
        declaration FunctionDeclarationSyntax? = nil,
        $package PackageSymbol? = nil,
        accessibility Accessibility = Accessibility.Public
    ) {
        init(name, parameters, type, declaration, $package, accessibility, default(TypeSymbol?), false, false)
    }

    /// Initializes a new instance of the (cref:FunctionSymbol) class.
    /// @param name The name of the function.
    /// @param parameters The parameters of the function (excluding the implicit instance receiver, when
    /// any).
    /// @param type The return type of the function.
    /// @param declaration The declaration of the function.
    /// @param package The package this function belongs to, or null for built-ins.
    /// @param accessibility The CLR visibility level.
    /// @param receiverType The class that owns this function when it is an instance method (Phase 3.B.3
    /// sub-step 2b); `null` for top-level functions and static methods.
    convenience init(
        name string,
        parameters ImmutableArray[ParameterSymbol],
        type TypeSymbol,
        declaration FunctionDeclarationSyntax?,
        $package PackageSymbol?,
        accessibility Accessibility,
        receiverType StructSymbol?
    ) {
        init(name, parameters, type, declaration, $package, accessibility, receiverType, false, false)
    }

    /// Initializes a new instance of the (cref:FunctionSymbol) class.
    /// @param name The name of the function.
    /// @param parameters The parameters of the function.
    /// @param type The return type of the function.
    /// @param declaration The declaration of the function.
    /// @param package The package this function belongs to, or null for built-ins.
    /// @param accessibility The CLR visibility level.
    /// @param receiverType The class that owns this function when it is an instance method (Phase 3.B.3
    /// sub-step 2b).
    /// @param isOpen True when the method is declared `open` — overridable (Phase 3.B.3 sub-step 3 /
    /// ADR-0017). Only meaningful on instance methods.
    /// @param isOverride True when the method is declared `override` — must shadow an open base method.
    convenience init(
        name string,
        parameters ImmutableArray[ParameterSymbol],
        type TypeSymbol,
        declaration FunctionDeclarationSyntax?,
        $package PackageSymbol?,
        accessibility Accessibility,
        receiverType StructSymbol?,
        isOpen bool,
        isOverride bool
    ) {
        init(
            name,
            parameters,
            type,
            declaration,
            $package,
            accessibility,
            cast[TypeSymbol?](receiverType),
            isOpen,
            isOverride
        )
    }

    /// Initializes a new instance of the (cref:FunctionSymbol) class with a generic (cref:TypeSymbol)
    /// receiver (Phase 3.B.4 — supports interface methods).
    /// @param name The function name.
    /// @param parameters The function parameters.
    /// @param type The return type.
    /// @param declaration The declaring syntax.
    /// @param package The owning package.
    /// @param accessibility The CLR accessibility.
    /// @param receiverType The receiver type for instance methods, or `null` for top-level functions.
    /// @param isOpen Whether the method is declared `open` (overridable).
    /// @param isOverride Whether the method overrides an inherited base method.
    convenience init(
        name string,
        parameters ImmutableArray[ParameterSymbol],
        type TypeSymbol,
        declaration FunctionDeclarationSyntax?,
        $package PackageSymbol?,
        accessibility Accessibility,
        receiverType TypeSymbol?,
        isOpen bool = false,
        isOverride bool = false
    ) {
        init(name, parameters, type, declaration, $package, accessibility, receiverType, nil, isOpen, isOverride)
    }

    /// Initializes a new instance of the (cref:FunctionSymbol) class for a receiver-clause method whose
    /// receiver parameter is source-visible.
    /// @param name The function name.
    /// @param parameters The function parameters, including [`explicitReceiverParameter`](paramref) at
    /// index zero.
    /// @param type The return type.
    /// @param declaration The declaring syntax.
    /// @param package The owning package.
    /// @param accessibility The CLR accessibility.
    /// @param receiverType The receiver type for instance methods.
    /// @param explicitReceiverParameter The source receiver parameter from `func (r R) M`, or `null`.
    /// @param isOpen Whether the method is declared `open` (overridable).
    /// @param isOverride Whether the method overrides an inherited base method.
    init(
        name string,
        parameters ImmutableArray[ParameterSymbol],
        type TypeSymbol,
        declaration FunctionDeclarationSyntax?,
        $package PackageSymbol?,
        accessibility Accessibility,
        receiverType TypeSymbol?,
        explicitReceiverParameter ParameterSymbol?,
        isOpen bool = false,
        isOverride bool = false
    ) : base(name) {
        Parameters = parameters
        Type = type
        Declaration = declaration
        Package = $package
        Accessibility = accessibility
        ReceiverType = receiverType
        ExplicitReceiverParameter = explicitReceiverParameter
        ThisParameter = explicitReceiverParameter ??
            (
            if receiverType != nil {
                ParameterSymbol("this", receiverType)
            } else {
                default(ParameterSymbol?)
            }
        )
        // ADR-0184: mark whichever parameter is the receiver, so the static
        // ref-capability classifiers (which have no enclosing-function context)
        // can tell the CLR's writable, caller-scoped `ref S` receiver apart
        // from an ordinary by-value parameter slot.
        if ThisParameter != nil {
            this.ThisParameter.IsReceiverParameter = true
        }
        IsOpen = isOpen
        IsOverride = isOverride
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.Function

    /// Gets the property this function is an accessor of, or
    /// `null` — the Roslyn `IMethodSymbol.AssociatedSymbol`
    /// analogue (ADR-0169, issue #4436). Set when a property's
    /// (cref:PropertySymbol.GetterSymbol) or
    /// (cref:PropertySymbol.SetterSymbol) is assigned.
    prop AssociatedSymbol Symbol? {
        get;
        internal set;
    }

    /// Gets what kind of function this is — the Roslyn
    /// `IMethodSymbol.MethodKind` analogue (ADR-0169, issue #4436).
    prop MethodKind MethodKind {
        get {
            if AssociatedSymbol is PropertySymbol property {
                return if object.ReferenceEquals(property.SetterSymbol, this) {
                    MethodKind.PropertySet
                } else {
                    MethodKind.PropertyGet
                }
            }
            if IsStaticInitializer {
                return MethodKind.StaticConstructor
            }
            if IsLocalFunction || LocalDeclaration != nil {
                return MethodKind.LocalFunction
            }
            return if IsFunctionLiteral {
                MethodKind.AnonymousFunction
            } else {
                MethodKind.Ordinary
            }
        }
    }

    /// Gets the parameters of the function.
    prop Parameters ImmutableArray[ParameterSymbol] {
        get;
    }

    /// Gets the hidden leading `Context` parameter a suspending function
    /// carries (ADR-0174 D7), or `null` for every other
    /// function. It is deliberately absent from (cref:Parameters) —
    /// overload resolution, arity checks, hover and signature help must never
    /// see it, and binding runs again on every keystroke in the language
    /// server — and appears only in (cref:EmittedParameters), the list
    /// the CLR signature, slot assignment and state-machine hoisting use.
    /// It is emitted as a trailing optional parameter, so a caller written
    /// against the function's declared signature — C#, reflection with
    /// (cref:System.Type.Missing), another G# assembly — still binds.
    prop HiddenContextParameter ParameterSymbol? {
        get;
        private set;
    }

    /// Gets the parameter this function's channel operations park on
    /// (ADR-0174 D7): a `Context` the author declared in the signature, or
    /// the synthesized (cref:HiddenContextParameter), or
    /// `null` when the function carries neither.
    prop AmbientContextParameter ParameterSymbol? {
        get;
        private set;
    }

    /// Gets the parameters as the CLR sees them: (cref:Parameters), then
    /// the hidden `Context` of a suspending function (ADR-0174 D7). Every
    /// emit-time consumer — signature encoding, parameter rows, argument slots,
    /// state-machine hoisting — uses this list. The context goes last, and is
    /// emitted optional, so a caller that does not know about it (C#, another
    /// G# assembly) still binds the signature it was written to call.
    prop EmittedParameters ImmutableArray[ParameterSymbol] -> if emittedParameters.IsDefault {
        Parameters
    } else {
        emittedParameters
    }

    /// Gets the type of the function.
    prop Type TypeSymbol {
        get;
        private set;
    }

    /// Gets the declaration of the function.
    prop Declaration FunctionDeclarationSyntax? {
        get;
        private set;
    }

    /// Gets the source declaration of a directly callable generic local function.
    prop LocalDeclaration VariableDeclarationSyntax? {
        get;
        internal set;
    }

    /// Gets a value indicating whether this direct-call local function
    /// ((cref:LocalDeclaration) non-null; issue #4219 umbrella
    /// remainder) captures outer state. Stamped from
    /// (cref:BoundFunctionLiteralExpression.CapturedVariables) once
    /// the literal's body (and, for a group, the #4221 fixed-point capture
    /// reconciliation) has finished binding — see
    /// `StatementBinder.BindLocalFunctionLiteralGroup`. Consulted by
    /// method-group/delegate conversion (`ExpressionBinder.IsMethodGroupCandidateUsable`):
    /// a NON-capturing direct-call local converts like an ordinary function,
    /// but a CAPTURING one has no single stable closure instance to bind a
    /// delegate to (each direct call to it materializes its own), so bare-
    /// name conversion is not offered — same limitation an existing
    /// capturing GENERIC local function already has.
    prop HasCaptures bool {
        get;
        internal set;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop DeclaringSyntaxNodes ImmutableArray[SyntaxNode] -> if (
        cast[SyntaxNode?](Declaration) ?? LocalDeclaration
    ) is {} declaration {
        ImmutableArray.Create(declaration)
    } else {
        ImmutableArray[SyntaxNode].Empty
    }

    /// Gets the package this function belongs to. `null` for built-in
    /// functions, which are not scoped to a user package.
    prop Package PackageSymbol? {
        get;
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop ContainingNamespace string? -> Package?.Name ?? base.ContainingNamespace

    /// Gets the CLR visibility level for this function.
    prop Accessibility Accessibility {
        get;
    }

    /// Gets the class type that owns this function when it is an instance
    /// method (Phase 3.B.3 sub-step 2b). `null` for top-level functions
    /// and static methods.
    prop ReceiverType TypeSymbol? {
        get;
    }

    /// Gets a value indicating whether this function is an instance method on a user-defined class.
    prop IsInstanceMethod bool -> ReceiverType != nil

    /// Gets the synthesized `this` parameter for instance methods, or `null` for non-instance functions.
    /// Always at IL parameter slot 0 when emitted.
    prop ThisParameter ParameterSymbol? {
        get;
    }

    /// Gets the source receiver parameter for `func (r R) M` methods-with-receivers; `null` for in-body
    /// methods and non-method functions.
    prop ExplicitReceiverParameter ParameterSymbol? {
        get;
    }

    /// Gets a value indicating whether this method is declared `open` — overridable per ADR-0017 (Phase
    /// 3.B.3 sub-step 3).
    prop IsOpen bool {
        get;
    }

    /// Gets a value indicating whether this method is declared `override` — must shadow an open base method
    /// per ADR-0017.
    prop IsOverride bool {
        get;
    }

    /// Gets or sets a value indicating whether this method is abstract — issue #987.
    /// A no-body `open func F() R;` on an `open class` is the canonical
    /// G# spelling of a C# `abstract` method: it declares a virtual slot with
    /// no implementation that concrete derived classes must override. When true,
    /// the binder skips body binding (there is no body) and the emitter writes a
    /// `MethodAttributes.Abstract | Virtual | NewSlot` method with no IL body,
    /// and the containing type is emitted with `TypeAttributes.Abstract`.
    /// Defaults to `false`.
    prop IsAbstract bool

    /// Gets or sets the base method this method overrides. Set by the binder when (cref:IsOverride) is true
    /// and a matching open base method is found; `null` otherwise.
    prop OverriddenMethod FunctionSymbol?

    /// Gets or sets the imported CLR virtual method this method overrides.
    /// The emitter uses this target to write an explicit MethodImpl row, which
    /// is required for covariant-return overrides and keeps reflection/runtime
    /// dispatch tied to the external base slot.
    prop ExternalOverriddenMethod MethodInfo?

    /// Gets or sets the imported constructed base type that owns
    /// (cref:ExternalOverriddenMethod). Preserves symbolic generic type
    /// arguments when the base is inherited as `Base[T]`.
    prop ExternalOverrideContainingType TypeSymbol?

    /// Gets or sets a value indicating whether this function is an extension function (Phase 3.B.6,
    /// ADR-0019). When true, the function's first parameter is the receiver and call sites `x.Foo(args)`
    /// bind to `Foo(x, args)`.
    prop IsExtension bool

    /// Gets or sets the receiver type for an extension function (Phase 3.B.6). `null` when
    /// (cref:IsExtension) is false.
    prop ExtensionReceiverType TypeSymbol?

    private var typeParameters ImmutableArray[TypeParameterSymbol] = ImmutableArray[TypeParameterSymbol].Empty
    private var emittedParameters ImmutableArray[ParameterSymbol]

    // ADR-0184: set for a property/indexer accessor whose OWNING property
    // carries @UnscopedRef. Accessors have no attribute list of their own.
    private var unscopedRefFromContainingMember bool

    /// Gets or sets the generic type parameters declared on this function (Phase 4.1 / ADR-0020). Empty for
    /// non-generic functions.
    /// @remarks ADR-0087 §3 R2: setting this collection flips each parameter's
    /// (cref:TypeParameterSymbol.IsMethodTypeParameter) flag so the
    /// emitter encodes references as `MVAR(idx)` instead of
    /// `VAR(idx)` in signature blobs.
    prop TypeParameters ImmutableArray[TypeParameterSymbol] {
        get -> typeParameters
        set {
            typeParameters = value
            if !value.IsDefaultOrEmpty {
                for tp in value {
                    tp.IsMethodTypeParameter = true
                }
            }
        }
    }

    /// Gets a value indicating whether this function declares one or more type parameters (Phase 4.1).
    prop IsGeneric bool -> !TypeParameters.IsDefaultOrEmpty

    /// Gets or sets a value indicating whether this function is declared inside a `shared` block
    /// (ADR-0053). Static functions have no receiver.
    prop IsStatic bool

    /// Gets or sets the type that owns this static method (ADR-0053 for struct/class owners; ADR-0089 for
    /// interface owners). `null` for non-static or top-level functions.
    prop StaticOwnerType TypeSymbol?

    /// Gets or sets the nearest enclosing user-defined type whose member body
    /// lexically contains this function (issue #1335). This is set on synthetic
    /// lambda / function-literal symbols so that `protected`/`private`
    /// accessibility checks performed while binding a closure body resolve the
    /// same access context as the enclosing member — a closure nested in a
    /// member of type `C` has the same access to `C`'s members as the
    /// member itself. `null` for ordinary methods and top-level functions
    /// (which carry their context via (cref:ReceiverType)/(cref:StaticOwnerType)).
    prop LexicalEnclosingType TypeSymbol?

    /// Gets or sets a value indicating whether this function should be emitted with
    /// `MethodAttributes.SpecialName` (e.g., event accessor methods).
    prop IsSpecialName bool

    /// Gets or sets a value indicating whether this function is the synthesized
    /// setter of an `init`-only property (issue #946). When true the
    /// emitter stamps the void return with the `IsExternalInit` modreq,
    /// and the binder treats the accessor body as an init-assignment context
    /// (so it may assign other `init`-only properties on the same instance).
    prop IsInitOnlySetter bool

    /// Gets a value indicating whether this function carries `@UnscopedRef`
    /// (ADR-0184 / issue #376; (cref:System.Diagnostics.CodeAnalysis.UnscopedRefAttribute)),
    /// which lifts the implicit `scoped` on a struct instance member's
    /// `this` so the member may return a reference into its own instance
    /// state.
    /// @remarks Computed over (cref:Symbol.Attributes) rather than stored, so it
    /// is immune to the binder's construct-then-`SetAttributes` ordering
    /// and propagates for free through every symbol-cloning site that copies
    /// the attribute list. A property/indexer accessor is the one shape that
    /// cannot answer from its own list — accessors are built with
    /// `declaration: null` and never receive a `SetAttributes` call —
    /// so (cref:MarkUnscopedRef) pushes the owning property's answer
    /// down onto it.
    prop HasUnscopedRef bool -> this.unscopedRefFromContainingMember || KnownAttributes.HasUnscopedRef(Attributes)

    /// Gets or sets a value indicating whether this function is declared `async` (Phase 5.1 / ADR-0023).
    /// When true, callers observe the function's return as `Task[T]` (or `Task` when no return type was
    /// declared) and the body may use `await`.
    prop IsAsync bool

    /// Gets or sets a value indicating whether this function explicitly
    /// declares `async ... void`. Such a function uses
    /// `AsyncVoidMethodBuilder` and is observable as `void`, while an
    /// async function whose return type is omitted remains Task-returning.
    prop IsAsyncVoid bool

    /// Gets or sets a value indicating whether this async function's declared
    /// return-type clause explicitly spelled a `ValueTask` / `ValueTask[T]`
    /// wrapper (issue #1918) rather than the default (implicit or explicit
    /// `Task` / `Task[T]`) wrapper. (cref:Type) still holds the
    /// unwrapped awaited result (`T`, or (cref:TypeSymbol.Void) for
    /// bare `ValueTask`) — this flag only steers which BCL wrapper /
    /// async-method-builder the state machine and observable call-site return
    /// type use.
    prop AsyncReturnsValueTask bool

    /// Gets or sets how this function is suspending (ADR-0174 D4). A suspending
    /// function is compiled through the same state-machine pipeline as an
    /// `async func` but returns `ValueTask[R]` with the pooling
    /// builder, carries `[Suspending]`, and is awaited implicitly by every
    /// G# call site — (cref:Type) stays the logical `R`. Never set
    /// together with (cref:IsAsync).
    prop SuspendingKind SuspendingKind

    /// Gets a value indicating whether this function is suspending (ADR-0174 D4).
    prop IsSuspending bool -> SuspendingKind != SuspendingKind.None

    /// Gets a value indicating whether this function's body is compiled as an async state machine —
    /// declared `async`, or suspending.
    prop IsAsyncOrSuspending bool -> IsAsync || IsSuspending

    /// Gets or sets a value indicating whether this (ADR-0122 / issue #1014)
    /// function constitutes an `unsafe` context — either because the
    /// declaration carried the `unsafe` modifier (`unsafe func`) or
    /// because its containing type was declared `unsafe`. When true, the
    /// signature and body may use unmanaged raw pointers
    /// ((cref:PointerTypeSymbol)) and raw-pointer operations.
    prop IsUnsafe bool

    /// Gets or sets a value indicating whether this function is the synthesized
    /// top-level-statement entry point (`<Main>$`) introduced by ADR-0066.
    /// When true, variable declarations inside its body continue to be promoted to
    /// (cref:GlobalVariableSymbol) (matching the historical TLS shape) and a
    /// few other binder paths treat the function as a top-level context even though
    /// a non-null (cref:FunctionSymbol) exists for return-type validation.
    prop IsTopLevelEntryPoint bool

    /// Gets or sets the synthesized state-machine type that hosts
    /// this method's lowered body, when the async state-machine rewriter has
    /// run on this method. `null` when the method is not async or when
    /// the rewriter has not yet visited it. The owning property is typed as
    /// (cref:object) to avoid a project-layer cycle (state-machine
    /// types live under `Lowering.Async`); callers cast to
    /// `SynthesizedStateMachineType`.
    prop StateMachineType object?

    /// Gets or sets the by-reference passing mode of this function's return value
    /// (issue #490 / ADR-0060 follow-up). Defaults to (cref:Binding.RefKind.None).
    /// When set to (cref:Binding.RefKind.Ref) or (cref:Binding.RefKind.RefReadOnly), the function returns a
    /// managed
    /// pointer (`T&`) and the body must use `return ref <lvalue>`.
    /// Only (cref:Binding.RefKind.None), (cref:Binding.RefKind.Ref), and (cref:Binding.RefKind.RefReadOnly)
    /// are
    /// valid here; `out`/`in` are not meaningful on a return position.
    private var _returnRefKind RefKind = RefKind.None

    prop ReturnRefKind RefKind {
        get {
            return _returnRefKind
        }
        set {
            _returnRefKind = value
        }
    }

    /// Gets or sets a value indicating whether this function's return type is
    /// being inferred (ADR-0076 / issue #716). Set to `true` on the
    /// synthetic placeholder (cref:FunctionSymbol) the arrow-lambda
    /// binder pushes while binding a lambda body whose return type is not
    /// declared up-front. When this flag is `true`, the return-statement
    /// binder must skip the usual void / declared-return-type validation and
    /// must NOT apply a target-typed conversion — the lambda binder collects
    /// the bound return expressions, computes the inferred return type from
    /// their common-type, and applies a single post-bind conversion pass.
    /// Defaults to `false`.
    prop IsReturnTypeInferred bool

    /// Gets or sets the state of a lambda body whose return statements keep their value unconverted (issue
    /// #5569). The lambda binder converts them after the body, so one body bind can give the target function
    /// type or the natural one. Unlike (cref:IsReturnTypeInferred), the declared return type still target-types
    /// the return values. `null` for every other function.
    internal prop DeferredReturns LambdaBinder.DeferredReturnState?

    /// Gets a value indicating whether (cref:DeferredReturns) is set.
    internal prop DefersReturnConversion bool -> DeferredReturns != nil

    /// Gets or sets the resolved `@DllImport` metadata for a P/Invoke
    /// function declaration (ADR-0086 / issue #727). Non-null when the
    /// function is a well-formed P/Invoke stub; the emitter consumes the
    /// payload to produce the `ImplMap` row that points the unmanaged
    /// entry point at the runtime's native-library loader. Defaults to
    /// `null` for ordinary managed functions.
    prop PInvokeMetadata PInvokeMetadata?

    /// Gets or sets the CLR interface slot this method explicitly implements via
    /// a covariant-return interface bridge (issue #985). Two same-name,
    /// same-parameter methods that differ only by return type and satisfy two
    /// DIFFERENT interface slots — e.g. the non-generic
    /// `IEnumerable.GetEnumerator()` alongside the generic
    /// `IEnumerable<T>.GetEnumerator()` — form a bridge. This carries
    /// the CLR interface method the emitter must bind to with an explicit
    /// `MethodImpl` row. A private bridge method cannot implicitly
    /// implement an interface slot, so the explicit row is required for the
    /// resulting type to load. Defaults to `null` for ordinary methods.
    prop ExplicitInterfaceSlot MethodInfo?

    /// Gets or sets the imported interface type that owns (cref:ExplicitInterfaceSlot).
    prop ExplicitInterfaceSlotContainingType TypeSymbol?

    /// Gets or sets the in-compilation (G#) interface member this method
    /// explicitly implements (issue #2010; property/indexer generalization:
    /// issue #2362; ADR-0149 rewrites the source-level convention that
    /// establishes this link). Set when the method carries a dedicated
    /// explicit-interface qualifier clause (`func (IFoo) M(...)`, ADR-0149)
    /// whose bound interface type — see (cref:ExplicitInterfaceClauseTarget) —
    /// declares a member with this method's own plain name and a matching
    /// signature. Unlike (cref:ExplicitInterfaceSlot) (which binds to
    /// an external CLR interface resolved via reflection), this points at the
    /// interface member's own (cref:FunctionSymbol) within the same
    /// compilation — the emitter resolves it to a MethodDef or (for a
    /// constructed generic interface) a MemberRef/TypeSpec token and binds a
    /// `MethodImpl` row so the CLR routes interface dispatch to this
    /// method's own distinct body instead of relying on name-based virtual
    /// dispatch. Two explicit implementations of same-name/same-signature
    /// members from different interfaces never collide at the source level —
    /// see (cref:ExplicitInterfaceClauseTarget) and
    /// (cref:Binding.DeclarationBinder.ResolveExplicitInterfaceClauses)
    /// for the duplicate-declaration carve-out — even though the emitter must
    /// still synthesize a CLR-unique metadata name for the MethodDef (the
    /// source/diagnostic name stays the plain declared name). Defaults to
    /// `null` for ordinary methods.
    prop ExplicitInterfaceMember FunctionSymbol?

    /// Gets a value indicating whether this method's declaration carries a
    /// dedicated explicit-interface qualifier clause (`func (IFoo) M(...)`,
    /// ADR-0149) — a purely syntactic fact known immediately at declaration
    /// time, before (cref:ExplicitInterfaceClauseTarget) is resolved
    /// against the containing type's implemented interfaces. Members with
    /// this flag set are exempt from the ordinary duplicate-overload-signature
    /// check (ADR-0063 §11): an explicit-interface member is never expected to
    /// share the plain concrete API surface, so it may coexist with (or, once
    /// resolved, with another explicit member targeting a different
    /// interface) a same-name/same-signature member.
    prop HasExplicitInterfaceClause bool -> Declaration?.HasExplicitInterfaceClause == true

    /// Gets or sets the interface type the explicit-interface
    /// qualifier clause ((cref:HasExplicitInterfaceClause)) resolves
    /// to, bound by (cref:Binding.DeclarationBinder.ResolveExplicitInterfaceClauses)
    /// once the containing type's interface list is fully known. `null`
    /// until resolved, and remains `null` if the clause's type does not
    /// bind to an interface implemented by the containing type (a diagnostic
    /// is reported in that case).
    prop ExplicitInterfaceClauseTarget TypeSymbol?

    /// Gets a value indicating whether this function is a P/Invoke stub (ADR-0086).
    prop IsPInvoke bool -> PInvokeMetadata != nil

    /// Gets a value indicating whether a fieldless direct-call host needs no enclosing generic slots.
    internal prop HasNonGenericLexicalOwner bool -> LexicalEnclosingType is {} owner &&
        (
        owner is StructSymbol and
            {TypeParameters: {IsEmpty: true}} or
            InterfaceSymbol and
            {TypeParameters: {IsEmpty: true}}
    ) &&
        StructSymbol
        .CollectEnclosingTypeParameters(owner).IsEmpty

    /// Gets or sets a value indicating whether a function literal's body is bound under this symbol.
    internal prop IsFunctionLiteral bool

    /// Gets or sets a value indicating whether this is a local function's symbol.
    internal prop IsLocalFunction bool

    /// Gets or sets a value indicating whether this synthetic function represents a type's
    /// static-constructor context.
    internal prop IsStaticInitializer bool

    /// Gets or sets a value indicating whether statements are being bound inside a field or
    /// constructor-initializer expression.
    internal prop IsExpressionInitializer bool

    internal prop NullableSequenceSpecialization NullableSequenceSpecializationKind

    /// Prepends the hidden `Context` parameter of ADR-0174 D7, so channel
    /// operations in this function's body observe the caller's scope. Called
    /// once, by the suspension inference pass, after the fixed point.
    /// @param contextType The runtime's `Context` type.
    /// @returns The parameter this function's channel operations observe: a
    /// `Context` the author declared, else the freshly added hidden one,
    /// else `null` when the function cannot carry one — a
    /// variadic function, whose `...T` parameter must stay positionally
    /// last. A function without one runs its channel operations under
    /// `Context.None`: it loses cross-call cancellation, not correctness.
    func AddHiddenContextParameter(contextType TypeSymbol) ParameterSymbol? {
        if AmbientContextParameter is {} existing {
            return existing
        }
        // ADR-0174 D7: an author who writes `ctx Context` in the signature has
        // said how the context arrives. Use theirs — visible, callable from C#,
        // and passed by every caller explicitly — instead of adding a second.
        let declaredContextTypeName string? = contextType.ClrType?.FullName
        for parameter in Parameters {
            if declaredContextTypeName != nil && parameter.Type.ClrType?.FullName == declaredContextTypeName {
                AmbientContextParameter = parameter
                return parameter
            }
        }
        for parameter in Parameters {
            if parameter.IsVariadic {
                return nil
            }
        }
        let hidden = ParameterSymbol(HiddenContextParameterName, contextType)
        // Optional with a null default: a caller that predates the parameter —
        // C#, another G# assembly, a reflection caller passing Type.Missing —
        // binds the signature it was written against, and the runtime reads a
        // missing context as `Context.None`.
        hidden.SetExplicitDefaultValue(nil)
        HiddenContextParameter = hidden
        AmbientContextParameter = hidden
        emittedParameters = Parameters.Add(hidden)
        return hidden
    }

    /// ADR-0174 D7: adopts a declared `ctx Context` parameter as this
    /// function's ambient context <em>without</em> adding a hidden one. This is
    /// the non-suspending case — a boundary such as an `open` method or an
    /// interface implementation never gains the hidden parameter, but an author
    /// who spelled `ctx Context` in the signature still expects the body's
    /// channel operations, scopes and selects to observe it.
    /// @param contextType The runtime's `Context` type.
    /// @returns The declared parameter, or `null` when there is none.
    func AdoptDeclaredContextParameter(contextType TypeSymbol) ParameterSymbol? {
        if AmbientContextParameter is {} existing {
            return existing
        }
        let declaredContextTypeName string? = contextType.ClrType?.FullName
        if declaredContextTypeName == nil {
            return nil
        }
        for parameter in Parameters {
            if parameter.Type.ClrType?.FullName == declaredContextTypeName {
                AmbientContextParameter = parameter
                return parameter
            }
        }
        return nil
    }

    internal func SetRichAnonymousReturnType(type TypeSymbol) {
        Type = type
    }

    /// ADR-0105 Phase 2 — re-points this (reused) function symbol at the
    /// declaration node of a freshly-parsed syntax tree whose member signature
    /// is byte-identical to the previous one (a body-only edit). Only the
    /// backing syntax — and therefore the body text and source spans — changes;
    /// the symbol's identity and signature are preserved so cross-compilation
    /// reuse stays sound. Intended to be called only by
    /// (cref:Binding.IncrementalGlobalScopeReuse).
    /// @param declaration The corresponding declaration in the re-parsed tree.
    internal func RepointDeclaration(declaration FunctionDeclarationSyntax) {
        Declaration = declaration
    }

    /// ADR-0184: records that this accessor's OWNING property/indexer carries
    /// `@UnscopedRef`. Property accessors are constructed with
    /// `declaration: null` and never receive their own attribute list —
    /// only the `PropertySymbol` does — so the property-level answer has
    /// to be pushed down here for (cref:HasUnscopedRef) to see it.
    internal func MarkUnscopedRef() {
        this.unscopedRefFromContainingMember = true
    }

    /// A method knows its own declaring type without being anchored (issue
    /// #3920): the receiver for an instance method, the owner for a static
    /// one. A free function has neither and stays null.
    /// @returns The declaring type, or null for a free function.
    internal override func DefaultContainingType() TypeSymbol? -> ReceiverType ?? StaticOwnerType

    shared {
        /// The unspeakable name of the hidden `Context` parameter (ADR-0174 D7).
        const HiddenContextParameterName string = "<>ctx"
    }
}
