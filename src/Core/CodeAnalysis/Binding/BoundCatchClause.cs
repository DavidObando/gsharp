// <copyright file="BoundCatchClause.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// Bound catch clause attached to a <see cref="BoundTryStatement"/>.
/// </summary>
public sealed record BoundCatchClause
{
    /// <summary>Initializes a new instance of the <see cref="BoundCatchClause"/> class.</summary>
    /// <param name="exceptionType">The exception type filter; <c>null</c> matches the base exception type.</param>
    /// <param name="variable">The local variable holding the caught instance.</param>
    /// <param name="body">The handler block.</param>
    public BoundCatchClause(TypeSymbol exceptionType, VariableSymbol variable, BoundStatement body)
        : this(exceptionType, variable, body, exitsThroughFinally: false)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="BoundCatchClause"/> class.</summary>
    /// <param name="exceptionType">The exception type filter; <c>null</c> matches the base exception type.</param>
    /// <param name="variable">The local variable holding the caught instance.</param>
    /// <param name="body">The handler block.</param>
    /// <param name="exitsThroughFinally">See <see cref="ExitsThroughFinally"/>.</param>
    public BoundCatchClause(TypeSymbol exceptionType, VariableSymbol variable, BoundStatement body, bool exitsThroughFinally)
    {
        ExceptionType = exceptionType;
        Variable = variable;
        Body = body;
        ExitsThroughFinally = exitsThroughFinally;
    }

    /// <summary>Gets the exception type filter for this clause.</summary>
    public TypeSymbol ExceptionType { get; }

    /// <summary>Gets the bound variable holding the caught instance.</summary>
    public VariableSymbol Variable { get; }

    /// <summary>Gets the handler block.</summary>
    public BoundStatement Body { get; }

    /// <summary>
    /// Gets a value indicating whether the handler only records the exception
    /// for a <c>finally</c> that is guaranteed to rethrow it, so control never
    /// completes the handler normally. The binder sets this on the catch it
    /// synthesizes for a <c>scope</c> block (ADR-0174 D6: <c>ScopeFrame.Exit</c>
    /// always throws when handed a body exception); control-flow analysis
    /// treats such a handler as terminating, so <c>return</c> inside the
    /// scope body still satisfies "all paths return".
    /// </summary>
    public bool ExitsThroughFinally { get; }

    /// <summary>Returns a clause with the same filter, variable and <see cref="ExitsThroughFinally"/> and a rewritten body.</summary>
    /// <param name="body">The rewritten handler block.</param>
    /// <returns>The clause, or <c>this</c> when the body is unchanged.</returns>
    public BoundCatchClause WithBody(BoundStatement body)
        => ReferenceEquals(body, Body) ? this : new BoundCatchClause(ExceptionType, Variable, body, ExitsThroughFinally);
}
