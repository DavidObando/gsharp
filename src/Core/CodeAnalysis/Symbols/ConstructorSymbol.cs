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
    /// <param name="declaration">The declaring syntax.</param>
    public ConstructorSymbol(FunctionSymbol function, ConstructorDeclarationSyntax declaration)
    {
        Function = function;
        Declaration = declaration;
    }

    /// <summary>Gets the underlying function symbol (receiver = the owning class) keyed in <c>BoundProgram.Functions</c>.</summary>
    public FunctionSymbol Function { get; }

    /// <summary>Gets the declaring syntax node.</summary>
    public ConstructorDeclarationSyntax Declaration { get; }

    /// <summary>Gets the constructor parameters (excluding the implicit <c>this</c>).</summary>
    public System.Collections.Immutable.ImmutableArray<ParameterSymbol> Parameters => Function.Parameters;

    /// <summary>Gets the owning class.</summary>
    public StructSymbol DeclaringType => Function.ReceiverType as StructSymbol;

    /// <summary>Gets the resolved explicit base-constructor initializer (<c>: base(args)</c>), or <c>null</c> when the constructor chains to a parameterless base constructor.</summary>
    public BaseConstructorInitializer BaseInitializer { get; private set; }

    /// <summary>Sets <see cref="BaseInitializer"/> after the binder resolves the base-constructor argument list.</summary>
    /// <param name="initializer">The resolved base-constructor initializer.</param>
    public void SetBaseInitializer(BaseConstructorInitializer initializer)
    {
        BaseInitializer = initializer;
    }
}
