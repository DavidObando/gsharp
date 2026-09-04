// <copyright file="FunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>Identifies compiler-generated CLR-representation variants of an unconstrained nullable sequence iterator.</summary>
internal enum NullableSequenceSpecializationKind
{
    /// <summary>Ordinary function.</summary>
    None,

    /// <summary>Reference-type specialization.</summary>
    ReferenceType,

    /// <summary>Value-type specialization.</summary>
    ValueType,
}

/// <summary>
/// Represents a function symbol in the language.
/// </summary>
public sealed class FunctionSymbol : Symbol
{
    /// <summary>The unspeakable name of the hidden <c>Context</c> parameter (ADR-0174 D7).</summary>
    public const string HiddenContextParameterName = "<>ctx";

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionSymbol"/> class.
    /// </summary>
    /// <param name="name">The name of the function.</param>
    /// <param name="parameters">The parameters of the function.</param>
    /// <param name="type">The type of the function.</param>
    /// <param name="declaration">The declaration of the function.</param>
    /// <param name="package">The package this function belongs to, or null for built-ins.</param>
    /// <param name="accessibility">The CLR visibility level (defaults to <see cref="Accessibility.Public"/>).</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax? declaration = null,
        PackageSymbol? package = null,
        Accessibility accessibility = Accessibility.Public)
        : this(name, parameters, type, declaration, package, accessibility, receiverType: (TypeSymbol?)null)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionSymbol"/> class.
    /// </summary>
    /// <param name="name">The name of the function.</param>
    /// <param name="parameters">The parameters of the function (excluding the implicit instance receiver, when any).</param>
    /// <param name="type">The return type of the function.</param>
    /// <param name="declaration">The declaration of the function.</param>
    /// <param name="package">The package this function belongs to, or null for built-ins.</param>
    /// <param name="accessibility">The CLR visibility level.</param>
    /// <param name="receiverType">The class that owns this function when it is an instance method (Phase 3.B.3 sub-step 2b); <c>null</c> for top-level functions and static methods.</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax? declaration,
        PackageSymbol? package,
        Accessibility accessibility,
        StructSymbol? receiverType)
        : this(name, parameters, type, declaration, package, accessibility, receiverType, isOpen: false, isOverride: false)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="FunctionSymbol"/> class.
    /// </summary>
    /// <param name="name">The name of the function.</param>
    /// <param name="parameters">The parameters of the function.</param>
    /// <param name="type">The return type of the function.</param>
    /// <param name="declaration">The declaration of the function.</param>
    /// <param name="package">The package this function belongs to, or null for built-ins.</param>
    /// <param name="accessibility">The CLR visibility level.</param>
    /// <param name="receiverType">The class that owns this function when it is an instance method (Phase 3.B.3 sub-step 2b).</param>
    /// <param name="isOpen">True when the method is declared <c>open</c> — overridable (Phase 3.B.3 sub-step 3 / ADR-0017). Only meaningful on instance methods.</param>
    /// <param name="isOverride">True when the method is declared <c>override</c> — must shadow an open base method.</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax? declaration,
        PackageSymbol? package,
        Accessibility accessibility,
        StructSymbol? receiverType,
        bool isOpen,
        bool isOverride)
        : this(name, parameters, type, declaration, package, accessibility, (TypeSymbol?)receiverType, isOpen, isOverride)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="FunctionSymbol"/> class with a generic <see cref="TypeSymbol"/> receiver (Phase 3.B.4 — supports interface methods).</summary>
    /// <param name="name">The function name.</param>
    /// <param name="parameters">The function parameters.</param>
    /// <param name="type">The return type.</param>
    /// <param name="declaration">The declaring syntax.</param>
    /// <param name="package">The owning package.</param>
    /// <param name="accessibility">The CLR accessibility.</param>
    /// <param name="receiverType">The receiver type for instance methods, or <c>null</c> for top-level functions.</param>
    /// <param name="isOpen">Whether the method is declared <c>open</c> (overridable).</param>
    /// <param name="isOverride">Whether the method overrides an inherited base method.</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax? declaration,
        PackageSymbol? package,
        Accessibility accessibility,
        TypeSymbol? receiverType,
        bool isOpen = false,
        bool isOverride = false)
        : this(name, parameters, type, declaration, package, accessibility, receiverType, explicitReceiverParameter: null, isOpen, isOverride)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="FunctionSymbol"/> class for a receiver-clause method whose receiver parameter is source-visible.</summary>
    /// <param name="name">The function name.</param>
    /// <param name="parameters">The function parameters, including <paramref name="explicitReceiverParameter"/> at index zero.</param>
    /// <param name="type">The return type.</param>
    /// <param name="declaration">The declaring syntax.</param>
    /// <param name="package">The owning package.</param>
    /// <param name="accessibility">The CLR accessibility.</param>
    /// <param name="receiverType">The receiver type for instance methods.</param>
    /// <param name="explicitReceiverParameter">The source receiver parameter from <c>func (r R) M</c>, or <c>null</c>.</param>
    /// <param name="isOpen">Whether the method is declared <c>open</c> (overridable).</param>
    /// <param name="isOverride">Whether the method overrides an inherited base method.</param>
    public FunctionSymbol(
        string name,
        ImmutableArray<ParameterSymbol> parameters,
        TypeSymbol type,
        FunctionDeclarationSyntax? declaration,
        PackageSymbol? package,
        Accessibility accessibility,
        TypeSymbol? receiverType,
        ParameterSymbol? explicitReceiverParameter,
        bool isOpen = false,
        bool isOverride = false)
        : base(name)
    {
        Parameters = parameters;
        Type = type;
        Declaration = declaration;
        Package = package;
        Accessibility = accessibility;
        ReceiverType = receiverType;
        ExplicitReceiverParameter = explicitReceiverParameter;
        ThisParameter = explicitReceiverParameter ?? (receiverType != null ? new ParameterSymbol("this", receiverType) : null);
        IsOpen = isOpen;
        IsOverride = isOverride;
    }

    /// <inheritdoc/>
    public override SymbolKind Kind => SymbolKind.Function;

    /// <summary>
    /// Gets the parameters of the function.
    /// </summary>
    public ImmutableArray<ParameterSymbol> Parameters { get; }

    /// <summary>
    /// Gets the hidden leading <c>Context</c> parameter a suspending function
    /// carries (ADR-0174 D7), or <see langword="null"/> for every other
    /// function. It is deliberately absent from <see cref="Parameters"/> —
    /// overload resolution, arity checks, hover and signature help must never
    /// see it, and binding runs again on every keystroke in the language
    /// server — and appears only in <see cref="EmittedParameters"/>, the list
    /// the CLR signature, slot assignment and state-machine hoisting use.
    /// It is emitted as a trailing optional parameter, so a caller written
    /// against the function's declared signature — C#, reflection with
    /// <see cref="System.Type.Missing"/>, another G# assembly — still binds.
    /// </summary>
    public ParameterSymbol? HiddenContextParameter { get; private set; }

    /// <summary>
    /// Gets the parameter this function's channel operations park on
    /// (ADR-0174 D7): a <c>Context</c> the author declared in the signature, or
    /// the synthesized <see cref="HiddenContextParameter"/>, or
    /// <see langword="null"/> when the function carries neither.
    /// </summary>
    public ParameterSymbol? AmbientContextParameter { get; private set; }

    /// <summary>
    /// Gets the parameters as the CLR sees them: <see cref="Parameters"/>, then
    /// the hidden <c>Context</c> of a suspending function (ADR-0174 D7). Every
    /// emit-time consumer — signature encoding, parameter rows, argument slots,
    /// state-machine hoisting — uses this list. The context goes last, and is
    /// emitted optional, so a caller that does not know about it (C#, another
    /// G# assembly) still binds the signature it was written to call.
    /// </summary>
    public ImmutableArray<ParameterSymbol> EmittedParameters => emittedParameters.IsDefault ? Parameters : emittedParameters;

    /// <summary>
    /// Gets the type of the function.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Gets the declaration of the function.
    /// </summary>
    public FunctionDeclarationSyntax? Declaration { get; private set; }

    /// <inheritdoc/>
    public override ImmutableArray<SyntaxNode> DeclaringSyntaxNodes =>
        Declaration is { } declaration ? ImmutableArray.Create<SyntaxNode>(declaration) : ImmutableArray<SyntaxNode>.Empty;

    /// <summary>
    /// Gets the package this function belongs to. <c>null</c> for built-in
    /// functions, which are not scoped to a user package.
    /// </summary>
    public PackageSymbol? Package { get; }

    /// <inheritdoc/>
    public override string? ContainingNamespace => Package?.Name ?? base.ContainingNamespace;

    /// <summary>
    /// Gets the CLR visibility level for this function.
    /// </summary>
    public Accessibility Accessibility { get; }

    /// <summary>
    /// Gets the class type that owns this function when it is an instance
    /// method (Phase 3.B.3 sub-step 2b). <c>null</c> for top-level functions
    /// and static methods.
    /// </summary>
    public TypeSymbol? ReceiverType { get; }

    /// <summary>Gets a value indicating whether this function is an instance method on a user-defined class.</summary>
    public bool IsInstanceMethod => ReceiverType != null;

    /// <summary>Gets the synthesized <c>this</c> parameter for instance methods, or <c>null</c> for non-instance functions. Always at IL parameter slot 0 when emitted.</summary>
    public ParameterSymbol? ThisParameter { get; }

    /// <summary>Gets the source receiver parameter for <c>func (r R) M</c> methods-with-receivers; <c>null</c> for in-body methods and non-method functions.</summary>
    public ParameterSymbol? ExplicitReceiverParameter { get; }

    /// <summary>Gets a value indicating whether this method is declared <c>open</c> — overridable per ADR-0017 (Phase 3.B.3 sub-step 3).</summary>
    public bool IsOpen { get; }

    /// <summary>Gets a value indicating whether this method is declared <c>override</c> — must shadow an open base method per ADR-0017.</summary>
    public bool IsOverride { get; }

    /// <summary>
    /// Gets or sets a value indicating whether this method is abstract — issue #987.
    /// A no-body <c>open func F() R;</c> on an <c>open class</c> is the canonical
    /// G# spelling of a C# <c>abstract</c> method: it declares a virtual slot with
    /// no implementation that concrete derived classes must override. When true,
    /// the binder skips body binding (there is no body) and the emitter writes a
    /// <c>MethodAttributes.Abstract | Virtual | NewSlot</c> method with no IL body,
    /// and the containing type is emitted with <c>TypeAttributes.Abstract</c>.
    /// Defaults to <c>false</c>.
    /// </summary>
    public bool IsAbstract { get; set; }

    /// <summary>Gets or sets the base method this method overrides. Set by the binder when <see cref="IsOverride"/> is true and a matching open base method is found; <c>null</c> otherwise.</summary>
    public FunctionSymbol? OverriddenMethod { get; set; }

    /// <summary>
    /// Gets or sets the imported CLR virtual method this method overrides.
    /// The emitter uses this target to write an explicit MethodImpl row, which
    /// is required for covariant-return overrides and keeps reflection/runtime
    /// dispatch tied to the external base slot.
    /// </summary>
    public MethodInfo? ExternalOverriddenMethod { get; set; }

    /// <summary>
    /// Gets or sets the imported constructed base type that owns
    /// <see cref="ExternalOverriddenMethod"/>. Preserves symbolic generic type
    /// arguments when the base is inherited as <c>Base[T]</c>.
    /// </summary>
    public TypeSymbol? ExternalOverrideContainingType { get; set; }

    /// <summary>Gets or sets a value indicating whether this function is an extension function (Phase 3.B.6, ADR-0019). When true, the function's first parameter is the receiver and call sites <c>x.Foo(args)</c> bind to <c>Foo(x, args)</c>.</summary>
    public bool IsExtension { get; set; }

    /// <summary>Gets or sets the receiver type for an extension function (Phase 3.B.6). <c>null</c> when <see cref="IsExtension"/> is false.</summary>
    public TypeSymbol? ExtensionReceiverType { get; set; }

#pragma warning disable SA1201
    private ImmutableArray<TypeParameterSymbol> typeParameters = ImmutableArray<TypeParameterSymbol>.Empty;
    private ImmutableArray<ParameterSymbol> emittedParameters;
#pragma warning restore SA1201

    /// <summary>Gets or sets the generic type parameters declared on this function (Phase 4.1 / ADR-0020). Empty for non-generic functions.</summary>
    /// <remarks>
    /// ADR-0087 §3 R2: setting this collection flips each parameter's
    /// <see cref="TypeParameterSymbol.IsMethodTypeParameter"/> flag so the
    /// emitter encodes references as <c>MVAR(idx)</c> instead of
    /// <c>VAR(idx)</c> in signature blobs.
    /// </remarks>
    public ImmutableArray<TypeParameterSymbol> TypeParameters
    {
        get => typeParameters;
        set
        {
            typeParameters = value;
            if (!value.IsDefaultOrEmpty)
            {
                foreach (var tp in value)
                {
                    tp.IsMethodTypeParameter = true;
                }
            }
        }
    }

    /// <summary>Gets a value indicating whether this function declares one or more type parameters (Phase 4.1).</summary>
    public bool IsGeneric => !TypeParameters.IsDefaultOrEmpty;

    /// <summary>Gets or sets a value indicating whether this function is declared inside a <c>shared</c> block (ADR-0053). Static functions have no receiver.</summary>
    public bool IsStatic { get; set; }

    /// <summary>Gets or sets the type that owns this static method (ADR-0053 for struct/class owners; ADR-0089 for interface owners). <c>null</c> for non-static or top-level functions.</summary>
    public TypeSymbol? StaticOwnerType { get; set; }

    /// <summary>
    /// Gets or sets the nearest enclosing user-defined type whose member body
    /// lexically contains this function (issue #1335). This is set on synthetic
    /// lambda / function-literal symbols so that <c>protected</c>/<c>private</c>
    /// accessibility checks performed while binding a closure body resolve the
    /// same access context as the enclosing member — a closure nested in a
    /// member of type <c>C</c> has the same access to <c>C</c>'s members as the
    /// member itself. <c>null</c> for ordinary methods and top-level functions
    /// (which carry their context via <see cref="ReceiverType"/>/<see cref="StaticOwnerType"/>).
    /// </summary>
    public TypeSymbol? LexicalEnclosingType { get; set; }

    /// <summary>Gets or sets a value indicating whether this function should be emitted with <c>MethodAttributes.SpecialName</c> (e.g., event accessor methods).</summary>
    public bool IsSpecialName { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this function is the synthesized
    /// setter of an <c>init</c>-only property (issue #946). When true the
    /// emitter stamps the void return with the <c>IsExternalInit</c> modreq,
    /// and the binder treats the accessor body as an init-assignment context
    /// (so it may assign other <c>init</c>-only properties on the same instance).
    /// </summary>
    public bool IsInitOnlySetter { get; set; }

    /// <summary>Gets or sets a value indicating whether this function is declared <c>async</c> (Phase 5.1 / ADR-0023). When true, callers observe the function's return as <c>Task[T]</c> (or <c>Task</c> when no return type was declared) and the body may use <c>await</c>.</summary>
    public bool IsAsync { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this function explicitly
    /// declares <c>async ... void</c>. Such a function uses
    /// <c>AsyncVoidMethodBuilder</c> and is observable as <c>void</c>, while an
    /// async function whose return type is omitted remains Task-returning.
    /// </summary>
    public bool IsAsyncVoid { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether this async function's declared
    /// return-type clause explicitly spelled a <c>ValueTask</c> / <c>ValueTask[T]</c>
    /// wrapper (issue #1918) rather than the default (implicit or explicit
    /// <c>Task</c> / <c>Task[T]</c>) wrapper. <see cref="Type"/> still holds the
    /// unwrapped awaited result (<c>T</c>, or <see cref="TypeSymbol.Void"/> for
    /// bare <c>ValueTask</c>) — this flag only steers which BCL wrapper /
    /// async-method-builder the state machine and observable call-site return
    /// type use.
    /// </summary>
    public bool AsyncReturnsValueTask { get; set; }

    /// <summary>
    /// Gets or sets how this function is suspending (ADR-0174 D4). A suspending
    /// function is compiled through the same state-machine pipeline as an
    /// <c>async func</c> but returns <c>ValueTask[R]</c> with the pooling
    /// builder, carries <c>[Suspending]</c>, and is awaited implicitly by every
    /// G# call site — <see cref="Type"/> stays the logical <c>R</c>. Never set
    /// together with <see cref="IsAsync"/>.
    /// </summary>
    public SuspendingKind SuspendingKind { get; set; }

    /// <summary>Gets a value indicating whether this function is suspending (ADR-0174 D4).</summary>
    public bool IsSuspending => SuspendingKind != SuspendingKind.None;

    /// <summary>Gets a value indicating whether this function's body is compiled as an async state machine — declared <c>async</c>, or suspending.</summary>
    public bool IsAsyncOrSuspending => IsAsync || IsSuspending;

    /// <summary>
    /// Gets or sets a value indicating whether this (ADR-0122 / issue #1014)
    /// function constitutes an <c>unsafe</c> context — either because the
    /// declaration carried the <c>unsafe</c> modifier (<c>unsafe func</c>) or
    /// because its containing type was declared <c>unsafe</c>. When true, the
    /// signature and body may use unmanaged raw pointers
    /// (<see cref="PointerTypeSymbol"/>) and raw-pointer operations.
    /// </summary>
    public bool IsUnsafe { get; set; }

    /// <summary>Gets or sets a value indicating whether this function is the synthesized
    /// top-level-statement entry point (<c>&lt;Main&gt;$</c>) introduced by ADR-0066.
    /// When true, variable declarations inside its body continue to be promoted to
    /// <see cref="GlobalVariableSymbol"/> (matching the historical TLS shape) and a
    /// few other binder paths treat the function as a top-level context even though
    /// a non-null <see cref="FunctionSymbol"/> exists for return-type validation.</summary>
    public bool IsTopLevelEntryPoint { get; set; }

    /// <summary>Gets or sets the synthesized state-machine type that hosts
    /// this method's lowered body, when the async state-machine rewriter has
    /// run on this method. <c>null</c> when the method is not async or when
    /// the rewriter has not yet visited it. The owning property is typed as
    /// <see cref="object"/> to avoid a project-layer cycle (state-machine
    /// types live under <c>Lowering.Async</c>); callers cast to
    /// <c>SynthesizedStateMachineType</c>.</summary>
    public object? StateMachineType { get; set; }

    /// <summary>
    /// Gets or sets the by-reference passing mode of this function's return value
    /// (issue #490 / ADR-0060 follow-up). Defaults to <see cref="Binding.RefKind.None"/>.
    /// When set to <see cref="Binding.RefKind.Ref"/>, the function returns a managed
    /// pointer (<c>T&amp;</c>) and the body must use <c>return ref &lt;lvalue&gt;</c>.
    /// Only <see cref="Binding.RefKind.None"/> and <see cref="Binding.RefKind.Ref"/> are
    /// valid here; <c>out</c>/<c>in</c> are not meaningful on a return position.
    /// </summary>
    public RefKind ReturnRefKind { get; set; } = RefKind.None;

    /// <summary>
    /// Gets or sets a value indicating whether this function's return type is
    /// being inferred (ADR-0076 / issue #716). Set to <c>true</c> on the
    /// synthetic placeholder <see cref="FunctionSymbol"/> the arrow-lambda
    /// binder pushes while binding a lambda body whose return type is not
    /// declared up-front. When this flag is <c>true</c>, the return-statement
    /// binder must skip the usual void / declared-return-type validation and
    /// must NOT apply a target-typed conversion — the lambda binder collects
    /// the bound return expressions, computes the inferred return type from
    /// their common-type, and applies a single post-bind conversion pass.
    /// Defaults to <c>false</c>.
    /// </summary>
    public bool IsReturnTypeInferred { get; set; }

    /// <summary>
    /// Gets or sets the resolved <c>@DllImport</c> metadata for a P/Invoke
    /// function declaration (ADR-0086 / issue #727). Non-null when the
    /// function is a well-formed P/Invoke stub; the emitter consumes the
    /// payload to produce the <c>ImplMap</c> row that points the unmanaged
    /// entry point at the runtime's native-library loader. Defaults to
    /// <c>null</c> for ordinary managed functions.
    /// </summary>
    public PInvokeMetadata? PInvokeMetadata { get; set; }

    /// <summary>
    /// Gets or sets the CLR interface slot this method explicitly implements via
    /// a covariant-return interface bridge (issue #985). Two same-name,
    /// same-parameter methods that differ only by return type and satisfy two
    /// DIFFERENT interface slots — e.g. the non-generic
    /// <c>IEnumerable.GetEnumerator()</c> alongside the generic
    /// <c>IEnumerable&lt;T&gt;.GetEnumerator()</c> — form a bridge. This carries
    /// the CLR interface method the emitter must bind to with an explicit
    /// <c>MethodImpl</c> row. A private bridge method cannot implicitly
    /// implement an interface slot, so the explicit row is required for the
    /// resulting type to load. Defaults to <c>null</c> for ordinary methods.
    /// </summary>
    public System.Reflection.MethodInfo? ExplicitInterfaceSlot { get; set; }

    /// <summary>Gets or sets the imported interface type that owns <see cref="ExplicitInterfaceSlot"/>.</summary>
    public TypeSymbol? ExplicitInterfaceSlotContainingType { get; set; }

    /// <summary>
    /// Gets or sets the in-compilation (G#) interface member this method
    /// explicitly implements (issue #2010; property/indexer generalization:
    /// issue #2362; ADR-0149 rewrites the source-level convention that
    /// establishes this link). Set when the method carries a dedicated
    /// explicit-interface qualifier clause (<c>func (IFoo) M(...)</c>, ADR-0149)
    /// whose bound interface type — see <see cref="ExplicitInterfaceClauseTarget"/> —
    /// declares a member with this method's own plain name and a matching
    /// signature. Unlike <see cref="ExplicitInterfaceSlot"/> (which binds to
    /// an external CLR interface resolved via reflection), this points at the
    /// interface member's own <see cref="FunctionSymbol"/> within the same
    /// compilation — the emitter resolves it to a MethodDef or (for a
    /// constructed generic interface) a MemberRef/TypeSpec token and binds a
    /// <c>MethodImpl</c> row so the CLR routes interface dispatch to this
    /// method's own distinct body instead of relying on name-based virtual
    /// dispatch. Two explicit implementations of same-name/same-signature
    /// members from different interfaces never collide at the source level —
    /// see <see cref="ExplicitInterfaceClauseTarget"/> and
    /// <see cref="Binding.DeclarationBinder.ResolveExplicitInterfaceClauses"/>
    /// for the duplicate-declaration carve-out — even though the emitter must
    /// still synthesize a CLR-unique metadata name for the MethodDef (the
    /// source/diagnostic name stays the plain declared name). Defaults to
    /// <c>null</c> for ordinary methods.
    /// </summary>
    public FunctionSymbol? ExplicitInterfaceMember { get; set; }

    /// <summary>
    /// Gets a value indicating whether this method's declaration carries a
    /// dedicated explicit-interface qualifier clause (<c>func (IFoo) M(...)</c>,
    /// ADR-0149) — a purely syntactic fact known immediately at declaration
    /// time, before <see cref="ExplicitInterfaceClauseTarget"/> is resolved
    /// against the containing type's implemented interfaces. Members with
    /// this flag set are exempt from the ordinary duplicate-overload-signature
    /// check (ADR-0063 §11): an explicit-interface member is never expected to
    /// share the plain concrete API surface, so it may coexist with (or, once
    /// resolved, with another explicit member targeting a different
    /// interface) a same-name/same-signature member.
    /// </summary>
    public bool HasExplicitInterfaceClause => Declaration?.HasExplicitInterfaceClause == true;

    /// <summary>
    /// Gets or sets the interface type the explicit-interface
    /// qualifier clause (<see cref="HasExplicitInterfaceClause"/>) resolves
    /// to, bound by <see cref="Binding.DeclarationBinder.ResolveExplicitInterfaceClauses"/>
    /// once the containing type's interface list is fully known. <c>null</c>
    /// until resolved, and remains <c>null</c> if the clause's type does not
    /// bind to an interface implemented by the containing type (a diagnostic
    /// is reported in that case).
    /// </summary>
    public TypeSymbol? ExplicitInterfaceClauseTarget { get; set; }

    /// <summary>Gets a value indicating whether this function is a P/Invoke stub (ADR-0086).</summary>
    public bool IsPInvoke => PInvokeMetadata != null;

    /// <summary>Gets or sets a value indicating whether this synthetic function represents a type's static-constructor context.</summary>
    internal bool IsStaticInitializer { get; set; }

    /// <summary>Gets or sets a value indicating whether statements are being bound inside a field or constructor-initializer expression.</summary>
    internal bool IsExpressionInitializer { get; set; }

    internal NullableSequenceSpecializationKind NullableSequenceSpecialization { get; set; }

    /// <summary>
    /// Prepends the hidden <c>Context</c> parameter of ADR-0174 D7, so channel
    /// operations in this function's body observe the caller's scope. Called
    /// once, by the suspension inference pass, after the fixed point.
    /// </summary>
    /// <param name="contextType">The runtime's <c>Context</c> type.</param>
    /// <returns>
    /// The parameter this function's channel operations observe: a
    /// <c>Context</c> the author declared, else the freshly added hidden one,
    /// else <see langword="null"/> when the function cannot carry one — a
    /// variadic function, whose <c>...T</c> parameter must stay positionally
    /// last. A function without one runs its channel operations under
    /// <c>Context.None</c>: it loses cross-call cancellation, not correctness.
    /// </returns>
    public ParameterSymbol? AddHiddenContextParameter(TypeSymbol contextType)
    {
        if (AmbientContextParameter is { } existing)
        {
            return existing;
        }

        // ADR-0174 D7: an author who writes `ctx Context` in the signature has
        // said how the context arrives. Use theirs — visible, callable from C#,
        // and passed by every caller explicitly — instead of adding a second.
        var declaredContextTypeName = contextType.ClrType?.FullName;
        foreach (var parameter in Parameters)
        {
            if (declaredContextTypeName != null && parameter.Type.ClrType?.FullName == declaredContextTypeName)
            {
                AmbientContextParameter = parameter;
                return parameter;
            }
        }

        foreach (var parameter in Parameters)
        {
            if (parameter.IsVariadic)
            {
                return null;
            }
        }

        var hidden = new ParameterSymbol(HiddenContextParameterName, contextType);

        // Optional with a null default: a caller that predates the parameter —
        // C#, another G# assembly, a reflection caller passing Type.Missing —
        // binds the signature it was written against, and the runtime reads a
        // missing context as `Context.None`.
        hidden.SetExplicitDefaultValue(null);
        HiddenContextParameter = hidden;
        AmbientContextParameter = hidden;
        emittedParameters = Parameters.Add(hidden);
        return hidden;
    }

    /// <summary>
    /// ADR-0174 D7: adopts a declared <c>ctx Context</c> parameter as this
    /// function's ambient context <em>without</em> adding a hidden one. This is
    /// the non-suspending case — a boundary such as an <c>open</c> method or an
    /// interface implementation never gains the hidden parameter, but an author
    /// who spelled <c>ctx Context</c> in the signature still expects the body's
    /// channel operations, scopes and selects to observe it.
    /// </summary>
    /// <param name="contextType">The runtime's <c>Context</c> type.</param>
    /// <returns>The declared parameter, or <see langword="null"/> when there is none.</returns>
    public ParameterSymbol? AdoptDeclaredContextParameter(TypeSymbol contextType)
    {
        if (AmbientContextParameter is { } existing)
        {
            return existing;
        }

        var declaredContextTypeName = contextType.ClrType?.FullName;
        if (declaredContextTypeName == null)
        {
            return null;
        }

        foreach (var parameter in Parameters)
        {
            if (parameter.Type.ClrType?.FullName == declaredContextTypeName)
            {
                AmbientContextParameter = parameter;
                return parameter;
            }
        }

        return null;
    }

    /// <summary>
    /// ADR-0105 Phase 2 — re-points this (reused) function symbol at the
    /// declaration node of a freshly-parsed syntax tree whose member signature
    /// is byte-identical to the previous one (a body-only edit). Only the
    /// backing syntax — and therefore the body text and source spans — changes;
    /// the symbol's identity and signature are preserved so cross-compilation
    /// reuse stays sound. Intended to be called only by
    /// <see cref="Binding.IncrementalGlobalScopeReuse"/>.
    /// </summary>
    /// <param name="declaration">The corresponding declaration in the re-parsed tree.</param>
    internal void RepointDeclaration(FunctionDeclarationSyntax declaration)
    {
        Declaration = declaration;
    }
}
