// <copyright file="BoundStateMachineAwaitOnCompleted.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Marker bound expression for the <c>builder.AwaitOnCompleted/AwaitUnsafeOnCompleted</c>
/// call inside <c>MoveNext</c>. This node exists because the call requires a
/// <c>MethodSpec</c> whose second type argument is the synthesized state-machine
/// <c>TypeDef</c>, which cannot be represented as a CLR <see cref="System.Type"/>.
/// The emitter handles this node specifically by constructing the MethodSpec manually.
/// </summary>
public sealed class BoundStateMachineAwaitOnCompleted : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundStateMachineAwaitOnCompleted"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="awaiterLocal">The local variable holding the awaiter.</param>
    /// <param name="awaiterClrType">The CLR type of the awaiter.</param>
    /// <param name="useCritical">Whether to use <c>AwaitUnsafeOnCompleted</c> (true) or <c>AwaitOnCompleted</c> (false).</param>
    public BoundStateMachineAwaitOnCompleted(SyntaxNode syntax, VariableSymbol awaiterLocal, Type awaiterClrType, bool useCritical)
        : base(syntax)
    {
        AwaiterLocal = awaiterLocal ?? throw new ArgumentNullException(nameof(awaiterLocal));
        AwaiterClrType = awaiterClrType ?? throw new ArgumentNullException(nameof(awaiterClrType));
        UseCritical = useCritical;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.StateMachineAwaitOnCompleted;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Void;

    /// <summary>Gets the local variable holding the awaiter.</summary>
    public VariableSymbol AwaiterLocal { get; }

    /// <summary>Gets the CLR type of the awaiter.</summary>
    public Type AwaiterClrType { get; }

    /// <summary>Gets a value indicating whether to use <c>AwaitUnsafeOnCompleted</c>.</summary>
    public bool UseCritical { get; }
}
