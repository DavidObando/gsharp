// <copyright file="BoundClrIndexAssignmentExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;
using System.Reflection;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Assigns through a CLR indexer (Phase 4 exit). Example:
/// <c>d["key"] = 42</c> where <c>d</c> is a <c>Dictionary[string, int]</c>.
/// Interpreter-only — the evaluator calls
/// <c>Indexer.SetValue(target, value, args)</c>.
/// </summary>
public sealed class BoundClrIndexAssignmentExpression : BoundExpression
{
    public BoundClrIndexAssignmentExpression(SyntaxNode syntax, VariableSymbol target, PropertyInfo indexer, ImmutableArray<BoundExpression> arguments, BoundExpression value, TypeSymbol resultType)
        : base(syntax)
    {
        Target = target;
        Indexer = indexer;
        Arguments = arguments;
        Value = value;
        Type = resultType;
    }

    public VariableSymbol Target { get; }

    public PropertyInfo Indexer { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    public BoundExpression Value { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrIndexAssignmentExpression;
}
