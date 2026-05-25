// <copyright file="BoundClrConstructorCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Constructs a CLR class instance via a resolved <see cref="ConstructorInfo"/>
/// (Phase 4 exit). Covers both non-generic imports (<c>StringBuilder()</c>) and
/// closed generic imports (<c>List[int]()</c>, <c>Dictionary[string, int]()</c>).
/// Interpreter-only: the evaluator calls <c>Constructor.Invoke(args)</c>.
/// </summary>
public sealed class BoundClrConstructorCallExpression : BoundExpression
{
    public BoundClrConstructorCallExpression(System.Type clrType, ConstructorInfo constructor, ImmutableArray<BoundExpression> arguments, TypeSymbol resultType, ImmutableArray<RefKind> argumentRefKinds = default)
    {
        ClrType = clrType;
        Constructor = constructor;
        Arguments = arguments;
        Type = resultType;
        ArgumentRefKinds = argumentRefKinds.IsDefault ? default : argumentRefKinds;
    }

    public System.Type ClrType { get; }

    public ConstructorInfo Constructor { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    public ImmutableArray<RefKind> ArgumentRefKinds { get; }

    public override TypeSymbol Type { get; }

    public override BoundNodeKind Kind => BoundNodeKind.ClrConstructorCallExpression;
}
