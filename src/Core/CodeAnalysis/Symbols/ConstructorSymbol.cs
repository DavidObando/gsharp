#nullable disable

// <copyright file="ConstructorSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Symbols;

/// <summary>
/// Issue #306: a standalone user-defined constructor declared on a GSharp
/// <c>class</c> via the <c>init(params) [: base(args)] { ... }</c> form.
/// </summary>
/// <remarks>
/// The constructor body is bound and emitted/interpreted through the same
/// machinery as an instance method: the <see cref="Function"/> carries a
/// synthesized <c>this</c> parameter and the declared parameters, and its body
/// is keyed in <c>BoundProgram.Functions</c> by <see cref="Function"/>. The
/// emitter materializes it as a <c>.ctor</c> that first chains to the resolved
/// base constructor (<see cref="BaseInitializer"/>, or the conventional
/// parameterless chain) and then runs the bound body.
/// </remarks>
public sealed class ConstructorSymbol
{
    /// <summary>Initializes a new instance of the <see cref="ConstructorSymbol"/> class.</summary>
    /// <param name="function">The underlying instance-method-shaped function symbol used as the bind/emit/interpret key.</param>
    /// <param name="declaration">The declaring syntax. May be <see langword="null"/> for compiler-synthesized constructors (e.g. ADR-0065 §5 primary-ctor synthesis).</param>
    public ConstructorSymbol(FunctionSymbol function, ConstructorDeclarationSyntax declaration)
    {
        Function = function;
        Declaration = declaration;
    }

    /// <summary>Gets the underlying function symbol (receiver = the owning class) keyed in <c>BoundProgram.Functions</c>.</summary>
    public FunctionSymbol Function { get; }

    /// <summary>Gets the declaring syntax node, or <see langword="null"/> when this is a compiler-synthesized constructor (ADR-0065 §5).</summary>
    public ConstructorDeclarationSyntax Declaration { get; private set; }

    /// <summary>Gets the constructor parameters (excluding the implicit <c>this</c>).</summary>
    public System.Collections.Immutable.ImmutableArray<ParameterSymbol> Parameters => Function.Parameters;

    /// <summary>Gets the owning class.</summary>
    public StructSymbol DeclaringType => Function.ReceiverType as StructSymbol;

    /// <summary>Gets the resolved explicit base-constructor initializer (<c>: base(args)</c>), or <c>null</c> when the constructor chains to a parameterless base constructor.</summary>
    public BaseConstructorInitializer BaseInitializer { get; private set; }

    /// <summary>
    /// Gets a value indicating whether this constructor is a
    /// <c>convenience init</c> (ADR-0065 §2) that must delegate to another
    /// initializer in the same class before performing any other work.
    /// </summary>
    public bool IsConvenience { get; private set; }

    /// <summary>
    /// Gets a value indicating whether this constructor was compiler-synthesized
    /// from a primary-constructor parameter list (ADR-0065 §5). The emitter
    /// materializes the field-assignment body for these constructors rather
    /// than reading it from the program's function bodies.
    /// </summary>
    public bool IsSynthesizedFromPrimaryConstructor { get; private set; }

    /// <summary>Sets <see cref="BaseInitializer"/> after the binder resolves the base-constructor argument list.</summary>
    /// <param name="initializer">The resolved base-constructor initializer.</param>
    public void SetBaseInitializer(BaseConstructorInitializer initializer)
    {
        BaseInitializer = initializer;
    }

    /// <summary>ADR-0065 §2: marks this constructor as <c>convenience</c>.</summary>
    public void MarkConvenience()
    {
        IsConvenience = true;
    }

    /// <summary>ADR-0065 §5: marks this constructor as synthesized from the primary-constructor parameter list.</summary>
    public void MarkSynthesizedFromPrimaryConstructor()
    {
        IsSynthesizedFromPrimaryConstructor = true;
    }

    /// <summary>
    /// ADR-0105 Phase 2 — re-points this (reused) constructor at the declaration
    /// node of a freshly-parsed syntax tree whose constructor signature is
    /// byte-identical to the previous one (a body-only edit). Only the backing
    /// syntax — and therefore the body text and source spans — changes; the
    /// symbol's identity (including <see cref="Function"/> and its parameters)
    /// is preserved so cross-compilation reuse stays sound. Intended to be
    /// called only by <see cref="Binding.IncrementalGlobalScopeReuse"/>.
    /// </summary>
    /// <param name="declaration">The corresponding declaration in the re-parsed tree.</param>
    internal void RepointDeclaration(ConstructorDeclarationSyntax declaration)
    {
        Declaration = declaration;
    }
}
