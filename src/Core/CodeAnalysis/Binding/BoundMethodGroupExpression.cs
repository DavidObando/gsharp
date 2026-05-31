// <copyright file="BoundMethodGroupExpression.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

#pragma warning disable CS1591
#pragma warning disable SA1600

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Issue #324: a bare reference to a named function used in a value context
/// (C#/F# "method group"). Its type is the <see cref="FunctionTypeSymbol"/>
/// describing the function's signature, so the existing function-value →
/// delegate conversion machinery materializes it as a delegate (native
/// <c>func(...)</c> slots via identity, <c>Func[...]</c>/<c>Action[...]</c>
/// slots via the function → delegate conversion). The emitter loads the
/// function's address with <c>ldftn</c> and constructs the delegate directly.
/// </summary>
public sealed class BoundMethodGroupExpression : BoundExpression
{
    public BoundMethodGroupExpression(SyntaxNode syntax, FunctionSymbol function, FunctionTypeSymbol type)
        : base(syntax)
    {
        Function = function;
        FunctionType = type;
    }

    public FunctionSymbol Function { get; }

    public FunctionTypeSymbol FunctionType { get; }

    public override TypeSymbol Type => FunctionType;

    public override BoundNodeKind Kind => BoundNodeKind.MethodGroupExpression;
}
