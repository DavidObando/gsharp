// <copyright file="BoundConstructorCallExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using System.Collections.Immutable;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Constructs a class or inline-struct instance via its Kotlin-style primary constructor:
/// <c>ClassName(arg1, arg2)</c> (Phase 3.B.3 sub-step 2). The arguments
/// correspond 1:1 with <see cref="StructSymbol.PrimaryConstructorParameters"/>
/// and are assigned to the same-named fields of the new instance.
/// </summary>
public sealed class BoundConstructorCallExpression : BoundExpression
{
    public BoundConstructorCallExpression(SyntaxNode syntax, StructSymbol structType, ImmutableArray<BoundExpression> arguments)
        : base(syntax)
    {
        StructType = structType;
        Arguments = arguments;
    }

    public StructSymbol StructType { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.ConstructorCallExpression;
}
