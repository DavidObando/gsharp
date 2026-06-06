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
/// <remarks>
/// ADR-0063 §9: when the receiving class declares an overload family of
/// <c>init(...)</c> constructors, <see cref="SelectedConstructor"/> identifies
/// the specific overload picked by call-site overload resolution. Primary-ctor
/// and parameterless paths leave it <see langword="null"/>.
/// </remarks>
public sealed class BoundConstructorCallExpression : BoundExpression
{
    public BoundConstructorCallExpression(SyntaxNode syntax, StructSymbol structType, ImmutableArray<BoundExpression> arguments)
        : this(syntax, structType, arguments, selectedConstructor: null)
    {
    }

    public BoundConstructorCallExpression(SyntaxNode syntax, StructSymbol structType, ImmutableArray<BoundExpression> arguments, ConstructorSymbol selectedConstructor)
        : base(syntax)
    {
        StructType = structType;
        Arguments = arguments;
        SelectedConstructor = selectedConstructor;
    }

    public StructSymbol StructType { get; }

    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the chosen explicit <c>init(...)</c> overload, per ADR-0063 §9, or <see langword="null"/> when not applicable.</summary>
    public ConstructorSymbol SelectedConstructor { get; }

    public override TypeSymbol Type => StructType;

    public override BoundNodeKind Kind => BoundNodeKind.ConstructorCallExpression;
}
