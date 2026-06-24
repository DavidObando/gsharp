// <copyright file="BoundFunctionPointerInvocationExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0122 §9 / issue #1035. A direct invocation through a function-pointer
/// value — <c>fp(args)</c>. Emits the CIL <c>calli</c> opcode with the
/// function pointer's standalone signature (managed or unmanaged calling
/// convention). Its result type is the function pointer's return type.
/// </summary>
public sealed class BoundFunctionPointerInvocationExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundFunctionPointerInvocationExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax.</param>
    /// <param name="pointer">The function-pointer expression to invoke.</param>
    /// <param name="arguments">The converted call arguments.</param>
    /// <param name="functionPointerType">The function-pointer type being invoked.</param>
    public BoundFunctionPointerInvocationExpression(
        SyntaxNode syntax,
        BoundExpression pointer,
        ImmutableArray<BoundExpression> arguments,
        FunctionPointerTypeSymbol functionPointerType)
        : base(syntax)
    {
        Pointer = pointer;
        Arguments = arguments;
        FunctionPointerType = functionPointerType;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.FunctionPointerInvocationExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => FunctionPointerType.ReturnType;

    /// <summary>Gets the function-pointer expression to invoke.</summary>
    public BoundExpression Pointer { get; }

    /// <summary>Gets the converted call arguments.</summary>
    public ImmutableArray<BoundExpression> Arguments { get; }

    /// <summary>Gets the function-pointer type being invoked.</summary>
    public FunctionPointerTypeSymbol FunctionPointerType { get; }
}
