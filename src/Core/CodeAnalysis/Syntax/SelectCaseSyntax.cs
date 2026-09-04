// <copyright file="SelectCaseSyntax.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// Discriminates the four arm shapes a <c>select</c> case can take
/// (Phase 5.6 / ADR-0022).
/// </summary>
public enum SelectCaseKind
{
    /// <summary><c>case &lt;-ch { … }</c> — receive, discard the value.</summary>
    ReceiveDiscard,

    /// <summary><c>case v := &lt;-ch { … }</c> — receive and bind the value.</summary>
    ReceiveBind,

    /// <summary><c>case ch &lt;- v { … }</c> — send.</summary>
    Send,

    /// <summary><c>default { … }</c> — taken if no other arm is immediately ready.</summary>
    Default,

    /// <summary>ADR-0174 D8: <c>case let v = await task { … }</c> — a <c>Task[T]</c> arm.</summary>
    AwaitBind,

    /// <summary>ADR-0174 D8: <c>case await task { … }</c> — a <c>Task</c> arm whose result is discarded.</summary>
    AwaitDiscard,

    /// <summary>
    /// ADR-0174 D8: <c>case cancelled { … }</c> — the ambient context's
    /// cancellation, as an arm. A select containing one does not unwind on
    /// cancellation; the arm would otherwise be unreachable.
    /// </summary>
    Cancelled,
}

/// <summary>
/// A single arm of a <c>select</c> statement.
/// </summary>
public sealed class SelectCaseSyntax : SyntaxNode
{
    /// <summary>Initializes a new instance of the <see cref="SelectCaseSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>case</c> or <c>default</c> keyword.</param>
    /// <param name="caseKind">Which arm shape this is.</param>
    /// <param name="identifier">For <see cref="SelectCaseKind.ReceiveBind"/>: the identifier being declared. Null otherwise.</param>
    /// <param name="channel">Channel expression for send/receive arms. Null for default.</param>
    /// <param name="value">Value expression for send arms. Null otherwise.</param>
    /// <param name="body">The case body block.</param>
    public SelectCaseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SelectCaseKind caseKind,
        SyntaxToken? identifier,
        ExpressionSyntax? channel,
        ExpressionSyntax? value,
        BlockStatementSyntax body)
        : this(syntaxTree, keyword, caseKind, identifier, channel, value, whenKeyword: null, guard: null, body)
    {
    }

    /// <summary>Initializes a new instance of the <see cref="SelectCaseSyntax"/> class.</summary>
    /// <param name="syntaxTree">The parent syntax tree.</param>
    /// <param name="keyword">The <c>case</c> or <c>default</c> keyword.</param>
    /// <param name="caseKind">Which arm shape this is.</param>
    /// <param name="identifier">For a binding arm: the identifier being declared. Null otherwise.</param>
    /// <param name="channel">The channel, selectable or task operand. Null for default and cancelled arms.</param>
    /// <param name="value">Value expression for send arms. Null otherwise.</param>
    /// <param name="whenKeyword">The <c>when</c> keyword of an arm guard (ADR-0174 D8), or null.</param>
    /// <param name="guard">The arm guard's condition, or null.</param>
    /// <param name="body">The case body block.</param>
    public SelectCaseSyntax(
        SyntaxTree syntaxTree,
        SyntaxToken keyword,
        SelectCaseKind caseKind,
        SyntaxToken? identifier,
        ExpressionSyntax? channel,
        ExpressionSyntax? value,
        SyntaxToken? whenKeyword,
        ExpressionSyntax? guard,
        BlockStatementSyntax body)
        : base(syntaxTree)
    {
        Keyword = keyword;
        CaseKind = caseKind;
        Identifier = identifier;
        Channel = channel;
        Value = value;
        WhenKeyword = whenKeyword;
        Guard = guard;
        Body = body;
    }

    /// <inheritdoc/>
    public override SyntaxKind Kind => SyntaxKind.SelectCase;

    /// <summary>Gets the <c>case</c> or <c>default</c> keyword.</summary>
    public SyntaxToken Keyword { get; }

    /// <summary>Gets the kind of arm.</summary>
    public SelectCaseKind CaseKind { get; }

    /// <summary>Gets the identifier declared by <c>case v := &lt;-ch</c>; null otherwise.</summary>
    public SyntaxToken? Identifier { get; }

    /// <summary>Gets the channel expression for send/receive arms; null for <c>default</c>.</summary>
    public ExpressionSyntax? Channel { get; }

    /// <summary>Gets the value expression for send arms; null otherwise.</summary>
    public ExpressionSyntax? Value { get; }

    /// <summary>
    /// Gets the <c>when</c> keyword of the arm's guard (ADR-0174 D8); null when
    /// the arm has no guard.
    /// </summary>
    public SyntaxToken? WhenKeyword { get; }

    /// <summary>
    /// Gets the arm's <c>when</c> guard (ADR-0174 D8); null when the arm has
    /// none. A false guard keeps the arm out of the select entirely, which is
    /// how G# spells Go's nil-channel trick.
    /// </summary>
    public ExpressionSyntax? Guard { get; }

    /// <summary>Gets the case body block.</summary>
    public BlockStatementSyntax Body { get; }

    /// <summary>Gets a value indicating whether this is the <c>default</c> arm.</summary>
    public bool IsDefault => CaseKind == SelectCaseKind.Default;
}
