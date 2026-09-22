// <copyright file="BoundInitializationPlan.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>Emit-local constructor/type-initializer storage, separate from cached declaration symbols.</summary>
internal sealed class BoundInitializationPlan
{
    internal BoundInitializationPlan(
        FunctionSymbol function,
        ImmutableArray<BoundExpression> arguments,
        BoundBlockStatement prologue,
        BoundBlockStatement body)
    {
        Function = function;
        Arguments = arguments;
        Prologue = prologue;
        Body = body;
    }

    internal FunctionSymbol Function { get; }

    internal ImmutableArray<BoundExpression> Arguments { get; }

    internal BoundBlockStatement Prologue { get; }

    internal BoundBlockStatement Body { get; }

    internal BoundInitializationPlan Rewrite(Func<BoundExpression, BoundExpression> expression, Func<BoundStatement, BoundStatement> statement)
    {
        var arguments = Arguments.Select(expression).ToImmutableArray();
        var prologue = (BoundBlockStatement)statement(Prologue);
        var body = (BoundBlockStatement)statement(Body);
        return arguments.SequenceEqual(Arguments) && prologue == Prologue && body == Body
            ? this : new BoundInitializationPlan(Function, arguments, prologue, body);
    }
}
