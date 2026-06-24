// <copyright file="BoundSizeOfExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0122 §4 / issue #1034. Bound <c>sizeof(T)</c> expression used by the
/// unmanaged-pointer arithmetic lowering to scale offsets by the size of a
/// pointee whose size is not known at G# compile time (a user/value struct).
/// Emits the CIL <c>sizeof &lt;T&gt;</c> opcode (an <c>int32</c> byte count).
/// Its result type is <c>int32</c>.
/// </summary>
public sealed class BoundSizeOfExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundSizeOfExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax (may be <see langword="null"/> for lowered nodes).</param>
    /// <param name="measuredType">The type whose unmanaged size is measured.</param>
    public BoundSizeOfExpression(SyntaxNode syntax, TypeSymbol measuredType)
        : base(syntax)
    {
        MeasuredType = measuredType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.SizeOfExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => TypeSymbol.Int32;

    /// <summary>Gets the type whose unmanaged size is measured.</summary>
    public TypeSymbol MeasuredType { get; }
}
