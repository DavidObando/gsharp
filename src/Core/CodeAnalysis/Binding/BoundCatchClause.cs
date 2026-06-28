#nullable disable

// <copyright file="BoundCatchClause.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound catch clause attached to a <see cref="BoundTryStatement"/>.
/// </summary>
public sealed class BoundCatchClause
{
    /// <summary>Initializes a new instance of the <see cref="BoundCatchClause"/> class.</summary>
    /// <param name="exceptionType">The exception type filter; <c>null</c> matches the base exception type.</param>
    /// <param name="variable">The local variable holding the caught instance.</param>
    /// <param name="body">The handler block.</param>
    public BoundCatchClause(TypeSymbol exceptionType, VariableSymbol variable, BoundStatement body)
    {
        ExceptionType = exceptionType;
        Variable = variable;
        Body = body;
    }

    /// <summary>Gets the exception type filter for this clause.</summary>
    public TypeSymbol ExceptionType { get; }

    /// <summary>Gets the bound variable holding the caught instance.</summary>
    public VariableSymbol Variable { get; }

    /// <summary>Gets the handler block.</summary>
    public BoundStatement Body { get; }
}
