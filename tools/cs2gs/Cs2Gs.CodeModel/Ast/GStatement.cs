// <copyright file="GStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;

namespace Cs2Gs.CodeModel.Ast;

/// <summary>
/// Base type for a G# statement.
/// </summary>
public abstract class GStatement : GNode
{
}

/// <summary>
/// A brace-delimited block of statements.
/// </summary>
public sealed class BlockStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="BlockStatement"/> class.
    /// </summary>
    /// <param name="statements">The contained statements.</param>
    public BlockStatement(IReadOnlyList<GStatement> statements = null)
    {
        Statements = statements ?? new List<GStatement>();
    }

    /// <summary>Gets the contained statements.</summary>
    public IReadOnlyList<GStatement> Statements { get; }
}

/// <summary>
/// A local declaration <c>let/var/const name [Type] [= init]</c>
/// (ADR-0115 §B.3).
/// </summary>
public sealed class LocalDeclarationStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LocalDeclarationStatement"/> class.
    /// </summary>
    /// <param name="binding">The binding keyword.</param>
    /// <param name="name">The local name.</param>
    /// <param name="type">The optional explicit type clause.</param>
    /// <param name="initializer">The optional initializer expression.</param>
    /// <param name="isUsing">Whether this is a <c>using</c> resource declaration.</param>
    public LocalDeclarationStatement(
        BindingKind binding,
        string name,
        GTypeReference type = null,
        GExpression initializer = null,
        bool isUsing = false)
    {
        Binding = binding;
        Name = name;
        Type = type;
        Initializer = initializer;
        IsUsing = isUsing;
    }

    /// <summary>Gets the binding keyword.</summary>
    public BindingKind Binding { get; }

    /// <summary>
    /// Gets a value indicating whether this declaration is a <c>using</c>
    /// resource declaration (the resource is disposed at the end of the
    /// enclosing block; sample <c>Defer.gs</c>).
    /// </summary>
    public bool IsUsing { get; }

    /// <summary>Gets the local name.</summary>
    public string Name { get; }

    /// <summary>Gets the optional explicit type clause.</summary>
    public GTypeReference Type { get; }

    /// <summary>Gets the optional initializer expression.</summary>
    public GExpression Initializer { get; }
}

/// <summary>
/// An expression statement.
/// </summary>
public sealed class ExpressionStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ExpressionStatement"/> class.
    /// </summary>
    /// <param name="expression">The expression.</param>
    public ExpressionStatement(GExpression expression)
    {
        Expression = expression;
    }

    /// <summary>Gets the expression.</summary>
    public GExpression Expression { get; }
}

/// <summary>
/// An assignment statement <c>target op value</c> (e.g. <c>x = 1</c>, <c>x += 2</c>).
/// </summary>
public sealed class AssignmentStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="AssignmentStatement"/> class.
    /// </summary>
    /// <param name="target">The assignment target.</param>
    /// <param name="value">The assigned value.</param>
    /// <param name="op">The assignment operator (defaults to <c>=</c>).</param>
    public AssignmentStatement(GExpression target, GExpression value, string op = "=")
    {
        Target = target;
        Value = value;
        Operator = op;
    }

    /// <summary>Gets the assignment target.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the assigned value.</summary>
    public GExpression Value { get; }

    /// <summary>Gets the assignment operator.</summary>
    public string Operator { get; }
}

/// <summary>
/// A <c>return</c> statement with an optional value.
/// </summary>
public sealed class ReturnStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ReturnStatement"/> class.
    /// </summary>
    /// <param name="expression">The optional return value.</param>
    public ReturnStatement(GExpression expression = null)
    {
        Expression = expression;
    }

    /// <summary>Gets the optional return value.</summary>
    public GExpression Expression { get; }
}

/// <summary>
/// An <c>if</c>/<c>else</c> statement. The else branch is either another
/// <see cref="IfStatement"/> (else-if) or a <see cref="BlockStatement"/>.
/// </summary>
public sealed class IfStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IfStatement"/> class.
    /// </summary>
    /// <param name="condition">The condition expression.</param>
    /// <param name="then">The then block.</param>
    /// <param name="elseBranch">The optional else branch.</param>
    public IfStatement(GExpression condition, BlockStatement then, GStatement elseBranch = null)
    {
        Condition = condition;
        Then = then;
        ElseBranch = elseBranch;
    }

    /// <summary>Gets the condition expression.</summary>
    public GExpression Condition { get; }

    /// <summary>Gets the then block.</summary>
    public BlockStatement Then { get; }

    /// <summary>Gets the optional else branch.</summary>
    public GStatement ElseBranch { get; }
}

/// <summary>
/// A <c>while</c> loop.
/// </summary>
public sealed class WhileStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="WhileStatement"/> class.
    /// </summary>
    /// <param name="condition">The loop condition.</param>
    /// <param name="body">The loop body.</param>
    public WhileStatement(GExpression condition, BlockStatement body)
    {
        Condition = condition;
        Body = body;
    }

    /// <summary>Gets the loop condition.</summary>
    public GExpression Condition { get; }

    /// <summary>Gets the loop body.</summary>
    public BlockStatement Body { get; }
}

/// <summary>
/// A C-style three-clause <c>for init; cond; incr { }</c> loop. Each clause is
/// optional. The init/incr clauses are "simple" statements (local declaration,
/// assignment, increment/decrement, or expression statement) per the G# grammar
/// (spec §For loops; ADR-0115 §B.11).
/// </summary>
public sealed class ForStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ForStatement"/> class.
    /// </summary>
    /// <param name="initializer">The optional init clause (a simple statement).</param>
    /// <param name="condition">The optional loop condition.</param>
    /// <param name="incrementor">The optional incrementor clause (a simple statement).</param>
    /// <param name="body">The loop body.</param>
    public ForStatement(
        GStatement initializer,
        GExpression condition,
        GStatement incrementor,
        BlockStatement body)
    {
        Initializer = initializer;
        Condition = condition;
        Incrementor = incrementor;
        Body = body;
    }

    /// <summary>Gets the optional init clause.</summary>
    public GStatement Initializer { get; }

    /// <summary>Gets the optional loop condition.</summary>
    public GExpression Condition { get; }

    /// <summary>Gets the optional incrementor clause.</summary>
    public GStatement Incrementor { get; }

    /// <summary>Gets the loop body.</summary>
    public BlockStatement Body { get; }
}

/// <summary>
/// An increment / decrement statement <c>target++</c> / <c>target--</c>. G#
/// models increment/decrement as statements, not expressions (spec §Statements,
/// <c>IncDecStmt</c>); the operand is an identifier-shaped lvalue.
/// </summary>
public sealed class IncrementDecrementStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="IncrementDecrementStatement"/> class.
    /// </summary>
    /// <param name="target">The incremented/decremented lvalue.</param>
    /// <param name="op">The operator token (<c>++</c> or <c>--</c>).</param>
    public IncrementDecrementStatement(GExpression target, string op)
    {
        Target = target;
        Operator = op;
    }

    /// <summary>Gets the incremented/decremented lvalue.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the operator token (<c>++</c> or <c>--</c>).</summary>
    public string Operator { get; }
}

/// <summary>
/// A <c>for x in coll</c> loop (ADR-0031, ADR-0115 §B.11).
/// </summary>
public sealed class ForInStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ForInStatement"/> class.
    /// </summary>
    /// <param name="variableName">The iteration variable name.</param>
    /// <param name="iterable">The iterated expression.</param>
    /// <param name="body">The loop body.</param>
    public ForInStatement(string variableName, GExpression iterable, BlockStatement body)
    {
        VariableName = variableName;
        Iterable = iterable;
        Body = body;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="ForInStatement"/> class for a
    /// key/value iteration <c>for k, v in dict</c>.
    /// </summary>
    /// <param name="keyName">The key iteration variable name.</param>
    /// <param name="valueName">The optional value iteration variable name.</param>
    /// <param name="iterable">The iterated expression.</param>
    /// <param name="body">The loop body.</param>
    public ForInStatement(string keyName, string valueName, GExpression iterable, BlockStatement body)
    {
        VariableName = keyName;
        ValueName = valueName;
        Iterable = iterable;
        Body = body;
    }

    /// <summary>Gets the iteration variable name (the key, for a key/value loop).</summary>
    public string VariableName { get; }

    /// <summary>Gets the optional value iteration variable name (key/value loop), else <see langword="null"/>.</summary>
    public string ValueName { get; }

    /// <summary>Gets the iterated expression.</summary>
    public GExpression Iterable { get; }

    /// <summary>Gets the loop body.</summary>
    public BlockStatement Body { get; }
}

/// <summary>
/// A <c>throw</c> statement.
/// </summary>
public sealed class ThrowStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="ThrowStatement"/> class.
    /// </summary>
    /// <param name="expression">The thrown expression.</param>
    public ThrowStatement(GExpression expression)
    {
        Expression = expression;
    }

    /// <summary>Gets the thrown expression.</summary>
    public GExpression Expression { get; }
}

/// <summary>
/// A <c>defer</c> statement (minimal node; the body runs on scope exit).
/// </summary>
public sealed class DeferStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DeferStatement"/> class.
    /// </summary>
    /// <param name="body">The deferred block.</param>
    public DeferStatement(BlockStatement body)
    {
        Body = body;
    }

    /// <summary>Gets the deferred block.</summary>
    public BlockStatement Body { get; }
}

/// <summary>
/// A raw statement carrying pre-rendered G# text on a single line. An escape
/// hatch for constructs the structured model does not yet cover; the printer
/// emits the text verbatim at the current indentation (no trailing newline).
/// </summary>
public sealed class RawStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="RawStatement"/> class.
    /// </summary>
    /// <param name="text">The verbatim G# text.</param>
    public RawStatement(string text)
    {
        Text = text;
    }

    /// <summary>Gets the verbatim G# text.</summary>
    public string Text { get; }
}

/// <summary>
/// One <c>catch</c> clause of a <see cref="TryStatement"/>: an optional typed
/// exception binding (<c>catch (e Exception)</c>) and the handler block. When
/// <see cref="ExceptionType"/> is <see langword="null"/> the clause is a bare
/// catch-all (<c>catch { }</c>).
/// </summary>
public sealed class CatchClause : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="CatchClause"/> class.
    /// </summary>
    /// <param name="variableName">The bound exception variable name, when present.</param>
    /// <param name="exceptionType">The caught exception type, when present.</param>
    /// <param name="body">The handler block.</param>
    public CatchClause(string variableName, GTypeReference exceptionType, BlockStatement body)
    {
        VariableName = variableName;
        ExceptionType = exceptionType;
        Body = body;
    }

    /// <summary>Gets the bound exception variable name, or <see langword="null"/>.</summary>
    public string VariableName { get; }

    /// <summary>Gets the caught exception type, or <see langword="null"/> for catch-all.</summary>
    public GTypeReference ExceptionType { get; }

    /// <summary>Gets the handler block.</summary>
    public BlockStatement Body { get; }
}

/// <summary>
/// A <c>try</c> statement with zero or more <c>catch</c> clauses and an optional
/// <c>finally</c> block (ADR-0115 §B; sample <c>Exceptions.gs</c>).
/// </summary>
public sealed class TryStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TryStatement"/> class.
    /// </summary>
    /// <param name="tryBlock">The protected block.</param>
    /// <param name="catchClauses">The catch clauses, in source order.</param>
    /// <param name="finallyBlock">The finally block, when present.</param>
    public TryStatement(
        BlockStatement tryBlock,
        IReadOnlyList<CatchClause> catchClauses,
        BlockStatement finallyBlock)
    {
        TryBlock = tryBlock;
        CatchClauses = catchClauses ?? new List<CatchClause>();
        FinallyBlock = finallyBlock;
    }

    /// <summary>Gets the protected block.</summary>
    public BlockStatement TryBlock { get; }

    /// <summary>Gets the catch clauses, in source order.</summary>
    public IReadOnlyList<CatchClause> CatchClauses { get; }

    /// <summary>Gets the finally block, or <see langword="null"/>.</summary>
    public BlockStatement FinallyBlock { get; }
}

/// <summary>
/// One <c>case</c> (or <c>default</c>) arm of a <see cref="SwitchStatement"/>:
/// a pattern and a brace-delimited body. When <see cref="Pattern"/> is
/// <see langword="null"/> the arm is the <c>default</c> arm.
/// </summary>
public sealed class SwitchStatementCase : GNode
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchStatementCase"/> class.
    /// </summary>
    /// <param name="pattern">The arm pattern, or <see langword="null"/> for the <c>default</c> arm.</param>
    /// <param name="body">The arm body block.</param>
    public SwitchStatementCase(GPattern pattern, BlockStatement body)
    {
        Pattern = pattern;
        Body = body;
    }

    /// <summary>Gets the arm pattern, or <see langword="null"/> for the <c>default</c> arm.</summary>
    public GPattern Pattern { get; }

    /// <summary>Gets the arm body block.</summary>
    public BlockStatement Body { get; }
}

/// <summary>
/// A <c>switch</c> statement <c>switch subject { case &lt;pattern&gt; { … } default { … } }</c>
/// used in statement position for side effects (spec §Pattern matching; sample
/// <c>PatternSwitch.gs</c>). Distinct from <c>SwitchExpression</c>, which yields
/// a value.
/// </summary>
public sealed class SwitchStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SwitchStatement"/> class.
    /// </summary>
    /// <param name="subject">The value being matched.</param>
    /// <param name="cases">The ordered case arms.</param>
    public SwitchStatement(GExpression subject, IReadOnlyList<SwitchStatementCase> cases)
    {
        Subject = subject;
        Cases = cases ?? new List<SwitchStatementCase>();
    }

    /// <summary>Gets the value being matched.</summary>
    public GExpression Subject { get; }

    /// <summary>Gets the ordered case arms.</summary>
    public IReadOnlyList<SwitchStatementCase> Cases { get; }
}

/// <summary>
/// A <c>yield</c> statement inside an iterator <c>func</c> whose return type is
/// <c>sequence[T]</c> (spec §Iterators; sample <c>TupleSequenceIterators.gs</c>).
/// When <see cref="Expression"/> is non-<see langword="null"/> the statement is
/// <c>yield &lt;expr&gt;</c> (C# <c>yield return</c>).
/// </summary>
public sealed class YieldStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="YieldStatement"/> class.
    /// </summary>
    /// <param name="expression">The yielded value.</param>
    public YieldStatement(GExpression expression)
    {
        Expression = expression;
    }

    /// <summary>Gets the yielded value.</summary>
    public GExpression Expression { get; }
}
