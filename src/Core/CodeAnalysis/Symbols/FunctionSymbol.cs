// <copyright file="FunctionSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Represents a function symbol in the language.
/// </summary>
public sealed class FunctionSymbol : Symbol
{
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
        FunctionDeclarationSyntax declaration = null,
        PackageSymbol package = null,
        Accessibility accessibility = Accessibility.Public)
        : this(name, parameters, type, declaration, package, accessibility, receiverType: null)
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
        FunctionDeclarationSyntax declaration,
        PackageSymbol package,
        Accessibility accessibility,
        StructSymbol receiverType)
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
        FunctionDeclarationSyntax declaration,
        PackageSymbol package,
        Accessibility accessibility,
        StructSymbol receiverType,
        bool isOpen,
        bool isOverride)
        : this(name, parameters, type, declaration, package, accessibility, (TypeSymbol)receiverType, isOpen, isOverride)
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
        FunctionDeclarationSyntax declaration,
        PackageSymbol package,
        Accessibility accessibility,
        TypeSymbol receiverType,
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
        FunctionDeclarationSyntax declaration,
        PackageSymbol package,
        Accessibility accessibility,
        TypeSymbol receiverType,
        ParameterSymbol explicitReceiverParameter,
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
    /// Gets the type of the function.
    /// </summary>
    public TypeSymbol Type { get; }

    /// <summary>
    /// Gets the declaration of the function.
    /// </summary>
    public FunctionDeclarationSyntax Declaration { get; }

    /// <summary>
    /// Gets the package this function belongs to. <c>null</c> for built-in
    /// functions, which are not scoped to a user package.
    /// </summary>
    public PackageSymbol Package { get; }

    /// <summary>
    /// Gets the CLR visibility level for this function.
    /// </summary>
    public Accessibility Accessibility { get; }

    /// <summary>
    /// Gets the class type that owns this function when it is an instance
    /// method (Phase 3.B.3 sub-step 2b). <c>null</c> for top-level functions
    /// and static methods.
    /// </summary>
    public TypeSymbol ReceiverType { get; }

    /// <summary>Gets a value indicating whether this function is an instance method on a user-defined class.</summary>
    public bool IsInstanceMethod => ReceiverType != null;

    /// <summary>Gets the synthesized <c>this</c> parameter for instance methods, or <c>null</c> for non-instance functions. Always at IL parameter slot 0 when emitted.</summary>
    public ParameterSymbol ThisParameter { get; }

    /// <summary>Gets the source receiver parameter for <c>func (r R) M</c> methods-with-receivers; <c>null</c> for in-body methods and non-method functions.</summary>
    public ParameterSymbol ExplicitReceiverParameter { get; }

    /// <summary>Gets a value indicating whether this method is declared <c>open</c> — overridable per ADR-0017 (Phase 3.B.3 sub-step 3).</summary>
    public bool IsOpen { get; }

    /// <summary>Gets a value indicating whether this method is declared <c>override</c> — must shadow an open base method per ADR-0017.</summary>
    public bool IsOverride { get; }

    /// <summary>Gets or sets the base method this method overrides. Set by the binder when <see cref="IsOverride"/> is true and a matching open base method is found; <c>null</c> otherwise.</summary>
    public FunctionSymbol OverriddenMethod { get; set; }

    /// <summary>Gets or sets a value indicating whether this function is an extension function (Phase 3.B.6, ADR-0019). When true, the function's first parameter is the receiver and call sites <c>x.Foo(args)</c> bind to <c>Foo(x, args)</c>.</summary>
    public bool IsExtension { get; set; }

    /// <summary>Gets or sets the receiver type for an extension function (Phase 3.B.6). <c>null</c> when <see cref="IsExtension"/> is false.</summary>
    public TypeSymbol ExtensionReceiverType { get; set; }

    /// <summary>Gets or sets the generic type parameters declared on this function (Phase 4.1 / ADR-0020). Empty for non-generic functions.</summary>
    public ImmutableArray<TypeParameterSymbol> TypeParameters { get; set; } = ImmutableArray<TypeParameterSymbol>.Empty;

    /// <summary>Gets a value indicating whether this function declares one or more type parameters (Phase 4.1).</summary>
    public bool IsGeneric => !TypeParameters.IsDefaultOrEmpty;

    /// <summary>Gets or sets a value indicating whether this function is declared inside a <c>shared</c> block (ADR-0053). Static functions have no receiver.</summary>
    public bool IsStatic { get; set; }

    /// <summary>Gets or sets the struct/class that owns this static method (ADR-0053 / #261). <c>null</c> for non-static or top-level functions.</summary>
    public StructSymbol StaticOwnerType { get; set; }

    /// <summary>Gets or sets a value indicating whether this function should be emitted with <c>MethodAttributes.SpecialName</c> (e.g., event accessor methods).</summary>
    public bool IsSpecialName { get; set; }

    /// <summary>Gets or sets a value indicating whether this function is declared <c>async</c> (Phase 5.1 / ADR-0023). When true, callers observe the function's return as <c>Task[T]</c> (or <c>Task</c> when no return type was declared) and the body may use <c>await</c>.</summary>
    public bool IsAsync { get; set; }

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
    public object StateMachineType { get; set; }

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
    public PInvokeMetadata PInvokeMetadata { get; set; }

    /// <summary>Gets a value indicating whether this function is a P/Invoke stub (ADR-0086).</summary>
    public bool IsPInvoke => PInvokeMetadata != null;
}
