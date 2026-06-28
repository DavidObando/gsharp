#nullable disable

// <copyright file="BoundFunctionPointerFromMethodExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0122 §9 / issue #1035. The result of taking the address of a static
/// method as a function pointer — <c>&amp;StaticMethod</c>. Emits the CIL
/// <c>ldftn &lt;method&gt;</c> opcode, pushing the method's entry-point address
/// as a managed function pointer value. Its result type is a managed
/// <see cref="FunctionPointerTypeSymbol"/> matching the method's signature.
/// </summary>
public sealed class BoundFunctionPointerFromMethodExpression : BoundExpression
{
    /// <summary>Initializes a new instance of the <see cref="BoundFunctionPointerFromMethodExpression"/> class.</summary>
    /// <param name="syntax">The originating syntax (may be <see langword="null"/> for lowered nodes).</param>
    /// <param name="method">The target static method whose address is taken.</param>
    /// <param name="type">The managed function-pointer type produced.</param>
    public BoundFunctionPointerFromMethodExpression(SyntaxNode syntax, FunctionSymbol method, FunctionPointerTypeSymbol type)
        : base(syntax)
    {
        Method = method;
        FunctionPointerType = type;
    }

    /// <inheritdoc/>
    public override BoundNodeKind Kind => BoundNodeKind.FunctionPointerFromMethodExpression;

    /// <inheritdoc/>
    public override TypeSymbol Type => FunctionPointerType;

    /// <summary>Gets the target static method whose address is taken.</summary>
    public FunctionSymbol Method { get; }

    /// <summary>Gets the managed function-pointer type produced.</summary>
    public FunctionPointerTypeSymbol FunctionPointerType { get; }
}
