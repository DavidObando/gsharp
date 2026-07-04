// <copyright file="GStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
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
    /// <param name="isUnsafe">Whether this block is an <c>unsafe { … }</c> block (ADR-0122 / issue #1014).</param>
    public BlockStatement(IReadOnlyList<GStatement> statements = null, bool isUnsafe = false)
    {
        Statements = statements ?? new List<GStatement>();
        IsUnsafe = isUnsafe;
    }

    /// <summary>Gets the contained statements.</summary>
    public IReadOnlyList<GStatement> Statements { get; }

    /// <summary>
    /// Gets a value indicating whether this block is an <c>unsafe { … }</c> block
    /// introducing an unsafe context (ADR-0122 / issue #1014).
    /// </summary>
    public bool IsUnsafe { get; }
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
/// A <c>lock target { body }</c> statement (issue #1885). G# has a first-class
/// <c>lock</c> keyword mirroring C#'s mutual-exclusion statement, so the
/// translator emits it directly rather than lowering to the
/// <c>Monitor.Enter</c>/try-finally/<c>Monitor.Exit</c> pattern by hand.
/// </summary>
public sealed class LockStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LockStatement"/> class.
    /// </summary>
    /// <param name="target">The lock-target expression.</param>
    /// <param name="body">The protected body.</param>
    public LockStatement(GExpression target, BlockStatement body)
    {
        Target = target;
        Body = body;
    }

    /// <summary>Gets the lock-target expression.</summary>
    public GExpression Target { get; }

    /// <summary>Gets the protected body.</summary>
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
    /// <param name="isAwait">Whether this is an asynchronous iteration (<c>await for</c>).</param>
    public ForInStatement(string variableName, GExpression iterable, BlockStatement body, bool isAwait = false)
    {
        VariableName = variableName;
        Iterable = iterable;
        Body = body;
        IsAwait = isAwait;
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

    /// <summary>
    /// Gets a value indicating whether this is an asynchronous iteration
    /// (<c>await for x in seq</c>, the translation of C# <c>await foreach</c>).
    /// Async iteration is only valid for the single-variable form.
    /// </summary>
    public bool IsAwait { get; }
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
/// A <c>defer</c> statement. Per ADR-0030, the operand is a single call
/// expression that runs on scope exit (LIFO); G# has no block-bodied
/// <c>defer { … }</c> form.
/// </summary>
public sealed class DeferStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DeferStatement"/> class.
    /// </summary>
    /// <param name="call">The deferred call expression.</param>
    public DeferStatement(GExpression call)
    {
        Call = call;
    }

    /// <summary>Gets the deferred call expression.</summary>
    public GExpression Call { get; }
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
    /// <param name="guard">The optional <c>when</c> guard expression, or <see langword="null"/>.</param>
    public SwitchStatementCase(GPattern pattern, BlockStatement body, GExpression guard = null)
    {
        Pattern = pattern;
        Body = body;
        Guard = guard;
    }

    /// <summary>Gets the arm pattern, or <see langword="null"/> for the <c>default</c> arm.</summary>
    public GPattern Pattern { get; }

    /// <summary>Gets the arm body block.</summary>
    public BlockStatement Body { get; }

    /// <summary>Gets the optional <c>when</c> guard expression, or <see langword="null"/> when the arm has no guard.</summary>
    public GExpression Guard { get; }
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

/// <summary>
/// A <c>break</c> statement (spec §Statements; ADR-0070). Maps the C#
/// <c>break;</c> directly, and is also the canonical end-of-generator form for
/// C# <c>yield break;</c>.
/// </summary>
public sealed class BreakStatement : GStatement
{
}

/// <summary>
/// A <c>continue</c> statement (spec §Statements; ADR-0070). Maps the C#
/// <c>continue;</c> directly.
/// </summary>
public sealed class ContinueStatement : GStatement
{
}

/// <summary>
/// A post-test <c>do { body } while cond</c> loop (spec §Statements; ADR-0070).
/// Maps the C# <c>do … while (cond);</c> directly.
/// </summary>
public sealed class DoWhileStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="DoWhileStatement"/> class.
    /// </summary>
    /// <param name="body">The loop body.</param>
    /// <param name="condition">The post-test condition.</param>
    public DoWhileStatement(BlockStatement body, GExpression condition)
    {
        Body = body;
        Condition = condition;
    }

    /// <summary>Gets the loop body.</summary>
    public BlockStatement Body { get; }

    /// <summary>Gets the post-test condition.</summary>
    public GExpression Condition { get; }
}

/// <summary>
/// A tuple / named deconstruction binding <c>let (a, b) = expr</c> (spec
/// §Bindings). Maps a C# deconstructing declaration
/// (<c>var (a, b) = …</c> / <c>(T a, T b) = …</c>).
/// </summary>
public sealed class TupleDeconstructionStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="TupleDeconstructionStatement"/> class.
    /// </summary>
    /// <param name="binding">The binding keyword (<c>let</c> / <c>var</c>).</param>
    /// <param name="names">The deconstruction target names (<c>_</c> for a discard).</param>
    /// <param name="initializer">The deconstructed value.</param>
    public TupleDeconstructionStatement(
        BindingKind binding,
        IReadOnlyList<string> names,
        GExpression initializer)
    {
        Binding = binding;
        Names = names ?? new List<string>();
        Initializer = initializer;
    }

    /// <summary>Gets the binding keyword.</summary>
    public BindingKind Binding { get; }

    /// <summary>Gets the deconstruction target names.</summary>
    public IReadOnlyList<string> Names { get; }

    /// <summary>Gets the deconstructed value.</summary>
    public GExpression Initializer { get; }
}

/// <summary>
/// A local function declaration mapped to a G# function-valued <c>let</c>
/// binding (<c>let f = func(params) ret { body }</c>). The C# local function
/// becomes an immutable local holding a function literal (ADR-0115 §B).
/// </summary>
public sealed class LocalFunctionStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="LocalFunctionStatement"/> class.
    /// </summary>
    /// <param name="name">The local function name.</param>
    /// <param name="lambda">The function literal holding the parameters / body.</param>
    /// <param name="typeParameters">Issue #1886: the local function's type-parameter names (e.g. <c>["T"]</c> for <c>T First&lt;T&gt;(...)</c>), or <c>null</c>/empty when non-generic.</param>
    public LocalFunctionStatement(string name, LambdaExpression lambda, IReadOnlyList<string> typeParameters = null)
    {
        Name = name;
        Lambda = lambda;
        TypeParameters = typeParameters ?? Array.Empty<string>();
    }

    /// <summary>Gets the local function name.</summary>
    public string Name { get; }

    /// <summary>Gets the function literal.</summary>
    public LambdaExpression Lambda { get; }

    /// <summary>Gets the type-parameter names (issue #1886), empty when non-generic.</summary>
    public IReadOnlyList<string> TypeParameters { get; }
}

/// <summary>
/// A G# <c>fixed name *ElemType = source { body }</c> statement (ADR-0122 /
/// issue #1026). Pins a managed array/string and exposes a raw pointer for the
/// duration of <see cref="Body"/>. Only legal inside an <c>unsafe</c> context.
/// </summary>
public sealed class FixedStatement : GStatement
{
    /// <summary>
    /// Initializes a new instance of the <see cref="FixedStatement"/> class.
    /// </summary>
    /// <param name="name">The pinned pointer variable name.</param>
    /// <param name="pointerType">The pointer type clause (<c>*ElemType</c>).</param>
    /// <param name="source">The managed source expression being pinned.</param>
    /// <param name="body">The fixed-region body.</param>
    public FixedStatement(string name, GTypeReference pointerType, GExpression source, BlockStatement body)
    {
        Name = name;
        PointerType = pointerType;
        Source = source;
        Body = body;
    }

    /// <summary>Gets the pinned pointer variable name.</summary>
    public string Name { get; }

    /// <summary>Gets the pointer type clause.</summary>
    public GTypeReference PointerType { get; }

    /// <summary>Gets the managed source expression being pinned.</summary>
    public GExpression Source { get; }

    /// <summary>Gets the fixed-region body.</summary>
    public BlockStatement Body { get; }
}
