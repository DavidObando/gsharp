// <copyright file="GStatement.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.CodeModel.Ast

import System
import System.Collections.Generic

/// Base type for a G# statement.
abstract class GStatement : GNode { }

/// A brace-delimited block of statements.
class BlockStatement : GStatement {
    /// Initializes a new instance of the (cref:BlockStatement) class.
    /// @param statements The contained statements.
    /// @param isUnsafe Whether this block is an `unsafe { … }` block (ADR-0122 / issue #1014).
    /// @param isChecked Whether this block is a `checked { … }` block (issue #1881).
    /// @param isUnchecked Whether this block is an `unchecked { … }` block (issue #1881).
    init(
        statements IReadOnlyList[GStatement]? = nil,
        isUnsafe bool = false,
        isChecked bool = false,
        isUnchecked bool = false
    ) {
        Statements = statements ?? List[GStatement]()
        IsUnsafe = isUnsafe
        IsChecked = isChecked
        IsUnchecked = isUnchecked
    }

    /// Gets the contained statements.
    prop Statements IReadOnlyList[GStatement] {
        get;
    }

    /// Gets a value indicating whether this block is an `unsafe { … }` block
    /// introducing an unsafe context (ADR-0122 / issue #1014).
    prop IsUnsafe bool {
        get;
    }

    /// Gets a value indicating whether this block is a `checked { … }` block
    /// introducing a checked arithmetic context (issue #1881).
    prop IsChecked bool {
        get;
    }

    /// Gets a value indicating whether this block is an `unchecked { … }` block
    /// introducing an unchecked arithmetic context (issue #1881).
    prop IsUnchecked bool {
        get;
    }

    /// Gets or sets the diagnostic identifiers an ADR-0175
    /// `@SuppressDiagnostic("ID") { … }` block form suppresses (issue
    /// #4422). Empty for an ordinary block. Printed only in statement position.
    private var _suppressedDiagnostics IReadOnlyList[string] = Array.Empty[string]()

    prop SuppressedDiagnostics IReadOnlyList[string] {
        get {
            return _suppressedDiagnostics
        }
        set {
            _suppressedDiagnostics = value
        }
    }
}

/// A local declaration `let/var/const name [Type] [= init]`
/// (ADR-0115 §B.3).
class LocalDeclarationStatement : GStatement {
    /// Initializes a new instance of the (cref:LocalDeclarationStatement) class.
    /// @param binding The binding keyword.
    /// @param name The local name.
    /// @param type The optional explicit type clause.
    /// @param initializer The optional initializer expression.
    /// @param isUsing Whether this is a `using` resource declaration.
    /// @param isAwait Whether this is an `await using` resource declaration — the
    /// resource is disposed via `IAsyncDisposable.DisposeAsync` instead
    /// of `IDisposable.Dispose` (issue #1903; ADR-0030). Only meaningful
    /// when [`isUsing`](paramref) is `true`.
    /// @param isRefAlias Whether this is a ref-aliasing local (`let ref name [T] = lvalue` /
    /// `var ref name [T] = lvalue`, issue #491/ADR-0060) — G#'s native
    /// managed by-ref local, mapped from a C# ref local (issue #1900).
    /// @param isReadOnlyRefAlias Whether the alias prohibits writes.
    init(
        binding BindingKind,
        name string,
        type GTypeReference? = nil,
        initializer GExpression? = nil,
        isUsing bool = false,
        isAwait bool = false,
        isRefAlias bool = false,
        isReadOnlyRefAlias bool = false
    ) {
        Binding = binding
        Name = name
        Type = type
        Initializer = initializer
        IsUsing = isUsing
        IsAwait = isAwait
        IsRefAlias = isRefAlias
        IsReadOnlyRefAlias = isReadOnlyRefAlias
    }

    /// Gets the binding keyword.
    prop Binding BindingKind {
        get;
    }

    /// Gets a value indicating whether this declaration is a `using`
    /// resource declaration (the resource is disposed at the end of the
    /// enclosing block; sample `Defer.gs`).
    prop IsUsing bool {
        get;
    }

    /// Gets a value indicating whether this `using` resource is
    /// asynchronously disposed (`await using let`, issue #1903).
    prop IsAwait bool {
        get;
    }

    /// Gets the local name.
    prop Name string {
        get;
    }

    /// Gets the optional explicit type clause.
    prop Type GTypeReference? {
        get;
    }

    /// Gets the optional initializer expression.
    prop Initializer GExpression? {
        get;
    }

    /// Gets a value indicating whether this is a ref-aliasing local
    /// (issue #1900).
    prop IsRefAlias bool {
        get;
    }

    /// Gets a value indicating whether the alias prohibits writes.
    prop IsReadOnlyRefAlias bool {
        get;
    }

    /// Gets or sets the diagnostic identifiers an ADR-0175
    /// `@SuppressDiagnostic("ID")` annotation on this declaration
    /// suppresses (issue #4422). Empty for an ordinary declaration.
    private var _suppressedDiagnostics2 IReadOnlyList[string] = Array.Empty[string]()

    prop SuppressedDiagnostics IReadOnlyList[string] {
        get {
            return _suppressedDiagnostics2
        }
        set {
            _suppressedDiagnostics2 = value
        }
    }
}

/// An expression statement.
class ExpressionStatement : GStatement {
    /// Initializes a new instance of the (cref:ExpressionStatement) class.
    /// @param expression The expression.
    init(expression GExpression) {
        Expression = expression
    }

    /// Gets the expression.
    prop Expression GExpression {
        get;
    }
}

/// An `if let` statement — ADR-0071:
/// `if let a = e [, let b = e2]* { … } [else { … }]`.
/// @remarks The canonical G# rendering of C#'s `if (receiver is { } name) { … }`
/// (issue #3359). The general pattern lowering must spill `receiver` into a
/// `let __spillN` — the pattern reads the scrutinee more than once (issue
/// #1731) — which destroys the author's binder name, forces a `!!` at every
/// read, and adds a brace level to scope the temp. `if let` evaluates the
/// receiver once by construction and binds the name at its non-null type.
///
/// Mirrors (cref:Cs2Gs.CodeModel.Ast.IfLetExpression), the value-position
/// form added by ADR-0151, and reuses its
/// (cref:Cs2Gs.CodeModel.Ast.IfLetBinding) clause type.
class IfLetStatement : GStatement {
    /// Initializes a new instance of the (cref:IfLetStatement) class.
    /// @param bindings The `let` binding clauses.
    /// @param then The then-branch block.
    /// @param elseBranch The optional else branch.
    /// @remarks Issue #4961 / ADR-0201 gave the STATEMENT grammar the same
    /// optional `&& guard` as ADR-0151's value-position
    /// (cref:IfLetExpression), but cs2gs output must still compile with the
    /// pinned previous release, which has no statement guard. A C# guard is
    /// therefore nested inside the then-branch by the translator, and no guard
    /// is representable here until a release with ADR-0201 is the pin.
    init(bindings IReadOnlyList[IfLetBinding], then BlockStatement, elseBranch GStatement? = nil) {
        Bindings = bindings
        Then = then
        Else = elseBranch
    }

    /// Gets the `let` binding clauses.
    prop Bindings IReadOnlyList[IfLetBinding] {
        get;
    }

    /// Gets the then-branch block.
    prop Then BlockStatement {
        get;
    }

    /// Gets the optional else branch.
    prop Else GStatement? {
        get;
    }
}

/// A Go-style multi-target assignment — `a, b = x, y` (ADR-0015),
/// optionally introducing fresh locals such as `a, let b = Pair()`.
/// @remarks The native G# rendering of a C# deconstruction assignment into existing
/// variables or storage locations (issues #3353/#3358). ADR-0015 evaluates
/// every target's receiver/index first, then every right-hand value, then writes
/// left-to-right — exactly C#'s deconstruction-assignment order.
///
/// A tuple-valued single right-hand expression is supported. Fresh
/// `let`/`var` targets may mix with existing storage. Nested target
/// tuples keep recursive lowering because they have no flat assignment form.
class MultiAssignmentStatement : GStatement {
    /// Initializes a new instance of the (cref:MultiAssignmentStatement) class.
    /// @param targets The assignment targets, in source order.
    /// @param values One value per target, or one tuple-valued expression.
    /// @param targetBindings Optional fresh-local binding per target.
    init(
        targets IReadOnlyList[GExpression],
        values IReadOnlyList[GExpression],
        targetBindings IReadOnlyList[BindingKind?]? = nil
    ) {
        Targets = targets
        Values = values
        TargetBindings = targetBindings ?? [Targets.Count]BindingKind?
        if TargetBindings.Count != Targets.Count {
            throw ArgumentException("Multi-assignment target binding count must match target count.", "targetBindings")
        }
    }

    /// Gets the assignment targets, in source order.
    prop Targets IReadOnlyList[GExpression] {
        get;
    }

    /// Gets the assigned values or single tuple-valued expression.
    prop Values IReadOnlyList[GExpression] {
        get;
    }

    /// Gets the optional fresh-local binding for each target.
    prop TargetBindings IReadOnlyList[BindingKind?] {
        get;
    }
}

/// An assignment statement `target op value` (e.g. `x = 1`, `x += 2`).
class AssignmentStatement : GStatement {
    /// Initializes a new instance of the (cref:AssignmentStatement) class.
    /// @param target The assignment target.
    /// @param value The assigned value.
    /// @param op The assignment operator (defaults to `=`).
    init(target GExpression, value GExpression, op string = "=") {
        Target = target
        Value = value
        Operator = op
    }

    /// Gets the assignment target.
    prop Target GExpression {
        get;
    }

    /// Gets the assigned value.
    prop Value GExpression {
        get;
    }

    /// Gets the assignment operator.
    prop Operator string {
        get;
    }
}

/// A `return` statement with an optional value.
class ReturnStatement : GStatement {
    /// Initializes a new instance of the (cref:ReturnStatement) class.
    /// @param expression The optional return value.
    /// @param isRef Whether this is a `return ref expr` (G#'s native ref-return,
    /// issue #490/ADR-0060) — mapped from a C# ref return (issue #1900).
    init(expression GExpression? = nil, isRef bool = false) {
        Expression = expression
        IsRef = isRef
    }

    /// Gets the optional return value.
    prop Expression GExpression? {
        get;
    }

    /// Gets a value indicating whether this is a ref return (issue #1900).
    prop IsRef bool {
        get;
    }
}

/// An `if`/`else` statement. The else branch is either another
/// (cref:IfStatement) (else-if) or a (cref:BlockStatement).
class IfStatement : GStatement {
    /// Initializes a new instance of the (cref:IfStatement) class.
    /// @param condition The condition expression.
    /// @param then The then block.
    /// @param elseBranch The optional else branch.
    init(condition GExpression, then BlockStatement, elseBranch GStatement? = nil) {
        Condition = condition
        Then = then
        ElseBranch = elseBranch
    }

    /// Gets the condition expression.
    prop Condition GExpression {
        get;
    }

    /// Gets the then block.
    prop Then BlockStatement {
        get;
    }

    /// Gets the optional else branch.
    prop ElseBranch GStatement? {
        get;
    }
}

/// A `while` loop.
class WhileStatement : GStatement {
    /// Initializes a new instance of the (cref:WhileStatement) class.
    /// @param condition The loop condition.
    /// @param body The loop body.
    init(condition GExpression, body BlockStatement) {
        Condition = condition
        Body = body
    }

    /// Gets the loop condition.
    prop Condition GExpression {
        get;
    }

    /// Gets the loop body.
    prop Body BlockStatement {
        get;
    }
}

/// A nullable-binding `while let` loop:
/// `while let a = e [, let b = e2]* { … }` (ADR-0163).
class WhileLetStatement : GStatement {
    /// Initializes a new instance of the (cref:WhileLetStatement) class.
    /// @param bindings The `let` binding clauses.
    /// @param body The loop body.
    init(bindings IReadOnlyList[IfLetBinding], body BlockStatement) {
        Bindings = bindings
        Body = body
    }

    /// Gets the binding clauses evaluated before each iteration.
    prop Bindings IReadOnlyList[IfLetBinding] {
        get;
    }

    /// Gets the loop body.
    prop Body BlockStatement {
        get;
    }
}

/// A `lock target { body }` statement (issue #1885). G# has a first-class
/// `lock` keyword mirroring C#'s mutual-exclusion statement, so the
/// translator emits it directly rather than lowering to the
/// `Monitor.Enter`/try-finally/`Monitor.Exit` pattern by hand.
class LockStatement : GStatement {
    /// Initializes a new instance of the (cref:LockStatement) class.
    /// @param target The lock-target expression.
    /// @param body The protected body.
    init(target GExpression, body BlockStatement) {
        Target = target
        Body = body
    }

    /// Gets the lock-target expression.
    prop Target GExpression {
        get;
    }

    /// Gets the protected body.
    prop Body BlockStatement {
        get;
    }
}

/// A C-style three-clause `for init; cond; incr { }` loop. Each clause is
/// optional. The init/incr clauses are "simple" statements (local declaration,
/// assignment, increment/decrement, or expression statement) per the G# grammar
/// (spec §For loops; ADR-0115 §B.11).
class ForStatement : GStatement {
    /// Initializes a new instance of the (cref:ForStatement) class.
    /// @param initializer The optional init clause (a simple statement).
    /// @param condition The optional loop condition.
    /// @param incrementor The optional incrementor clause (a simple statement).
    /// @param body The loop body.
    init(initializer GStatement, condition GExpression, incrementor GStatement, body BlockStatement) {
        Initializer = initializer
        Condition = condition
        Incrementor = incrementor
        Body = body
    }

    /// Gets the optional init clause.
    prop Initializer GStatement? {
        get;
    }

    /// Gets the optional loop condition.
    prop Condition GExpression? {
        get;
    }

    /// Gets the optional incrementor clause.
    prop Incrementor GStatement? {
        get;
    }

    /// Gets the loop body.
    prop Body BlockStatement {
        get;
    }
}

/// An increment / decrement statement `target++` / `target--`. G#
/// models increment/decrement as statements, not expressions (spec §Statements,
/// `IncDecStmt`); the operand is an identifier-shaped lvalue.
class IncrementDecrementStatement : GStatement {
    /// Initializes a new instance of the (cref:IncrementDecrementStatement) class.
    /// @param target The incremented/decremented lvalue.
    /// @param op The operator token (`++` or `--`).
    init(target GExpression, op string) {
        Target = target
        Operator = op
    }

    /// Gets the incremented/decremented lvalue.
    prop Target GExpression {
        get;
    }

    /// Gets the operator token (`++` or `--`).
    prop Operator string {
        get;
    }
}

/// A `for x in coll` loop (ADR-0031, ADR-0115 §B.11).
class ForInStatement : GStatement {
    /// Initializes a new instance of the (cref:ForInStatement) class.
    /// @param variableName The iteration variable name.
    /// @param iterable The iterated expression.
    /// @param body The loop body.
    /// @param isAwait Whether this is an asynchronous iteration (`await for`).
    /// @param variableType The optional declared iteration-variable type.
    init(
        variableName string,
        iterable GExpression,
        body BlockStatement,
        isAwait bool = false,
        variableType GTypeReference? = nil
    ) {
        VariableName = variableName
        Iterable = iterable
        Body = body
        IsAwait = isAwait
        VariableType = variableType
    }

    /// Initializes a new instance of the (cref:ForInStatement) class for a
    /// key/value iteration `for k, v in dict`.
    /// @param keyName The key iteration variable name.
    /// @param valueName The optional value iteration variable name.
    /// @param iterable The iterated expression.
    /// @param body The loop body.
    init(keyName string, valueName string, iterable GExpression, body BlockStatement) {
        VariableName = keyName
        ValueName = valueName
        Iterable = iterable
        Body = body
    }

    /// Gets the iteration variable name (the key, for a key/value loop).
    prop VariableName string {
        get;
    }

    /// Gets the optional declared iteration-variable type.
    prop VariableType GTypeReference? {
        get;
    }

    /// Gets the optional value iteration variable name (key/value loop), else `null`.
    prop ValueName string {
        get;
    }

    /// Gets the iterated expression.
    prop Iterable GExpression {
        get;
    }

    /// Gets the loop body.
    prop Body BlockStatement {
        get;
    }

    /// Gets a value indicating whether this is an asynchronous iteration
    /// (`await for x in seq`, the translation of C# `await foreach`).
    /// Async iteration is only valid for the single-variable form.
    prop IsAwait bool {
        get;
    }
}

/// A deconstructing `for (a, b, ...) in coll` loop (issue #1922): the
/// first-class G# form of a C# `foreach (var (a, b) in xs)` over a
/// tuple-typed sequence. Unlike (cref:ForInStatement)'s two-name
/// key/value form, every name here binds a positional element of the
/// current tuple-typed value — there is no hidden temp variable or
/// separate (cref:TupleDeconstructionStatement) in the body.
class ForTupleInStatement : GStatement {
    /// Initializes a new instance of the (cref:ForTupleInStatement) class.
    /// @param names The deconstruction target names, in order (arity ≥ 2).
    /// @param iterable The iterated expression.
    /// @param body The loop body.
    init(names IReadOnlyList[string], iterable GExpression, body BlockStatement) {
        Names = names
        Iterable = iterable
        Body = body
    }

    /// Gets the deconstruction target names, in order.
    prop Names IReadOnlyList[string] {
        get;
    }

    /// Gets the iterated expression.
    prop Iterable GExpression {
        get;
    }

    /// Gets the loop body.
    prop Body BlockStatement {
        get;
    }
}

/// A `throw` statement.
class ThrowStatement : GStatement {
    /// Initializes a new instance of the (cref:ThrowStatement) class.
    /// @param expression The thrown expression.
    init(expression GExpression) {
        Expression = expression
    }

    /// Gets the thrown expression.
    prop Expression GExpression {
        get;
    }
}

/// A `rethrow` statement (ADR-0176, issue #3897): re-raises the exception
/// the enclosing `catch` is handling, preserving its original throw site.
/// Distinct from (cref:ThrowStatement) over the catch binder, which
/// resets `StackTrace` to the throw site.
class RethrowStatement : GStatement { }

/// A `defer` statement. Per ADR-0030, the operand is a single call
/// expression that runs on scope exit (LIFO); G# has no block-bodied
/// `defer { … }` form.
class DeferStatement : GStatement {
    /// Initializes a new instance of the (cref:DeferStatement) class.
    /// @param call The deferred call expression.
    init(call GExpression) {
        Call = call
    }

    /// Gets the deferred call expression.
    prop Call GExpression {
        get;
    }
}

/// A raw statement carrying pre-rendered G# text on a single line. An escape
/// hatch for constructs the structured model does not yet cover; the printer
/// emits the text verbatim at the current indentation (no trailing newline).
class RawStatement : GStatement {
    /// Initializes a new instance of the (cref:RawStatement) class.
    /// @param text The verbatim G# text.
    init(text string) {
        Text = text
    }

    /// Gets the verbatim G# text.
    prop Text string {
        get;
    }
}

/// One `catch` clause of a (cref:TryStatement): an optional typed
/// exception binding (`catch (e Exception)`) and the handler block. When
/// (cref:ExceptionType) is `null` the clause is a bare
/// catch-all (`catch { }`).
class CatchClause : GNode {
    /// Initializes a new instance of the (cref:CatchClause) class.
    /// @param variableName The bound exception variable name, when present.
    /// @param exceptionType The caught exception type, when present.
    /// @param body The handler block.
    /// @param filter The `when` filter expression, when present (ADR-0177).
    init(variableName string, exceptionType GTypeReference, body BlockStatement, filter GExpression? = nil) {
        VariableName = variableName
        ExceptionType = exceptionType
        Body = body
        Filter = filter
    }

    /// Gets the bound exception variable name, or `null`.
    prop VariableName string {
        get;
    }

    /// Gets the caught exception type, or `null` for catch-all.
    prop ExceptionType GTypeReference? {
        get;
    }

    /// Gets the handler block.
    prop Body BlockStatement {
        get;
    }

    /// Gets the `when` filter expression, or `null` when the
    /// clause has none. ADR-0177 gave G# native filters, so a C# filter maps
    /// straight across instead of being lowered into the handler body.
    prop Filter GExpression? {
        get;
    }
}

/// A `try` statement with zero or more `catch` clauses and an optional
/// `finally` block (ADR-0115 §B; sample `Exceptions.gs`).
class TryStatement : GStatement {
    /// Initializes a new instance of the (cref:TryStatement) class.
    /// @param tryBlock The protected block.
    /// @param catchClauses The catch clauses, in source order.
    /// @param finallyBlock The finally block, when present.
    init(tryBlock BlockStatement, catchClauses IReadOnlyList[CatchClause], finallyBlock BlockStatement) {
        TryBlock = tryBlock
        CatchClauses = catchClauses ?? List[CatchClause]()
        FinallyBlock = finallyBlock
    }

    /// Gets the protected block.
    prop TryBlock BlockStatement {
        get;
    }

    /// Gets the catch clauses, in source order.
    prop CatchClauses IReadOnlyList[CatchClause] {
        get;
    }

    /// Gets the finally block, or `null`.
    prop FinallyBlock BlockStatement? {
        get;
    }
}

/// One `case` (or `default`) arm of a (cref:SwitchStatement):
/// a pattern and a brace-delimited body. When (cref:Pattern) is
/// `null` the arm is the `default` arm.
class SwitchStatementCase : GNode {
    /// Initializes a new instance of the (cref:SwitchStatementCase) class.
    /// @param pattern The arm pattern, or `null` for the `default` arm.
    /// @param body The arm body block.
    /// @param guard The optional `when` guard expression, or `null`.
    init(pattern GPattern, body BlockStatement, $guard GExpression? = nil) {
        Pattern = pattern
        Body = body
        Guard = $guard
    }

    /// Gets the arm pattern, or `null` for the `default` arm.
    prop Pattern GPattern? {
        get;
    }

    /// Gets or sets the additional comma-joined patterns of a Go-style
    /// multi-pattern arm (issue #3501 A3: `case 1, 2, 3 { … }`).
    /// Empty for a single-pattern arm. Only meaningful when
    /// (cref:Pattern) is non-null.
    private var _additionalPatterns IReadOnlyList[GPattern] = Array.Empty[GPattern]()

    prop AdditionalPatterns IReadOnlyList[GPattern] {
        get {
            return _additionalPatterns
        }
        set {
            _additionalPatterns = value
        }
    }

    /// Gets the arm body block.
    prop Body BlockStatement {
        get;
    }

    /// Gets the optional `when` guard expression, or `null` when the arm has no guard.
    prop Guard GExpression? {
        get;
    }
}

/// A `switch` statement `switch subject { case <pattern> { … } default { … } }`
/// used in statement position for side effects (spec §Pattern matching; sample
/// `PatternSwitch.gs`). Distinct from `SwitchExpression`, which yields
/// a value.
class SwitchStatement : GStatement {
    /// Initializes a new instance of the (cref:SwitchStatement) class.
    /// @param subject The value being matched.
    /// @param cases The ordered case arms.
    init(subject GExpression, cases IReadOnlyList[SwitchStatementCase]) {
        Subject = subject
        Cases = cases ?? List[SwitchStatementCase]()
    }

    /// Gets the value being matched.
    prop Subject GExpression {
        get;
    }

    /// Gets the ordered case arms.
    prop Cases IReadOnlyList[SwitchStatementCase] {
        get;
    }
}

/// A `yield` statement inside an iterator `func` whose return type is
/// `sequence[T]` (spec §Iterators; sample `TupleSequenceIterators.gs`).
/// When (cref:Expression) is non-`null` the statement is
/// `yield <expr>` (C# `yield return`), or the
/// iteration-terminating `yield break` when (cref:Expression) is
/// `null` (issue #3501).
class YieldStatement : GStatement {
    /// Initializes a new instance of the (cref:YieldStatement) class.
    /// @param expression The yielded value, or `null` for `yield break`.
    init(expression GExpression) {
        Expression = expression
    }

    /// Gets the yielded value.
    prop Expression GExpression? {
        get;
    }
}

/// A `break` statement (spec §Statements; ADR-0070). Maps the C#
/// `break;` directly, and is also the canonical end-of-generator form for
/// C# `yield break;`.
class BreakStatement : GStatement { }

/// A `continue` statement (spec §Statements; ADR-0070). Maps the C#
/// `continue;` directly.
class ContinueStatement : GStatement { }

/// A `fallthrough` statement (issue #3501 A3, Go semantics): legal
/// only as the last statement of a non-final `switch` arm; transfers
/// into the next arm's body without evaluating its pattern. The canonical
/// translation of an adjacent-target C# `goto case`/`goto default`.
class FallthroughStatement : GStatement { }

/// A `goto label` statement (ADR-0139; issue #1884). Maps the C#
/// `goto label;` directly, and is also the synthesized form used to
/// lower C# `goto case K;` / `goto default;` to a jump into a
/// (cref:LabeledStatement) placed at the top of the targeted
/// `switch` arm's body.
class GotoStatement : GStatement {
    /// Initializes a new instance of the (cref:GotoStatement) class.
    /// @param label The target label name.
    init(label string) {
        Label = label
    }

    /// Gets the target label name.
    prop Label string {
        get;
    }
}

/// A `label: statement` labeled statement (ADR-0070, generalized by
/// ADR-0139; issue #1884). Maps the C# `label: statement;` directly, and
/// is also the synthesized label a `goto case`/`goto default`
/// lowering places at the top of a `switch` arm's body.
class LabeledStatement : GStatement {
    /// Initializes a new instance of the (cref:LabeledStatement) class.
    /// @param label The label name.
    /// @param statement The labeled statement.
    init(label string, statement GStatement) {
        Label = label
        Statement = statement
    }

    /// Gets the label name.
    prop Label string {
        get;
    }

    /// Gets the labeled statement.
    prop Statement GStatement {
        get;
    }
}

/// A post-test `do { body } while cond` loop (spec §Statements; ADR-0070).
/// Maps the C# `do … while (cond);` directly.
class DoWhileStatement : GStatement {
    /// Initializes a new instance of the (cref:DoWhileStatement) class.
    /// @param body The loop body.
    /// @param condition The post-test condition.
    init(body BlockStatement, condition GExpression) {
        Body = body
        Condition = condition
    }

    /// Gets the loop body.
    prop Body BlockStatement {
        get;
    }

    /// Gets the post-test condition.
    prop Condition GExpression {
        get;
    }
}

/// A tuple / named deconstruction binding `let (a, b) = expr` (spec
/// §Bindings). Maps a C# deconstructing declaration
/// (`var (a, b) = …` / `(T a, T b) = …`).
class TupleDeconstructionStatement : GStatement {
    /// Initializes a new instance of the (cref:TupleDeconstructionStatement) class.
    /// @param binding The binding keyword (`let` / `var`).
    /// @param names The deconstruction target names (`_` for a discard).
    /// @param initializer The deconstructed value.
    init(binding BindingKind, names IReadOnlyList[string], initializer GExpression) {
        Binding = binding
        Names = names ?? List[string]()
        Initializer = initializer
    }

    /// Gets the binding keyword.
    prop Binding BindingKind {
        get;
    }

    /// Gets the deconstruction target names.
    prop Names IReadOnlyList[string] {
        get;
    }

    /// Gets the deconstructed value.
    prop Initializer GExpression {
        get;
    }
}

/// A local function declaration mapped to a G# function-valued `let`
/// binding (`let f = func(params) ret { body }`). The C# local function
/// becomes an immutable local holding a function literal (ADR-0115 §B).
class LocalFunctionStatement : GStatement {
    /// Initializes a new instance of the (cref:LocalFunctionStatement) class.
    /// @param name The local function name.
    /// @param lambda The function literal holding the parameters / body.
    /// @param typeParameters Issue #1886: the local function's type-parameter names (e.g. `["T"]` for
    /// `T First<T>(...)`), or `null`/empty when non-generic.
    init(name string, lambda LambdaExpression, typeParameters IReadOnlyList[string]? = nil) {
        Name = name
        Lambda = lambda
        TypeParameters = typeParameters ?? Array.Empty[string]()
    }

    /// Gets the local function name.
    prop Name string {
        get;
    }

    /// Gets the function literal.
    prop Lambda LambdaExpression {
        get;
    }

    /// Gets the type-parameter names (issue #1886), empty when non-generic.
    prop TypeParameters IReadOnlyList[string] {
        get;
    }
}

/// A G# `fixed name *ElemType = source { body }` statement (ADR-0122 /
/// issue #1026). Pins a managed array/string and exposes a raw pointer for the
/// duration of (cref:Body). Only legal inside an `unsafe` context.
class FixedStatement : GStatement {
    /// Initializes a new instance of the (cref:FixedStatement) class.
    /// @param name The pinned pointer variable name.
    /// @param pointerType The pointer type clause (`*ElemType`).
    /// @param source The managed source expression being pinned.
    /// @param body The fixed-region body.
    init(name string, pointerType GTypeReference, source GExpression, body BlockStatement) {
        Name = name
        PointerType = pointerType
        Source = source
        Body = body
    }

    /// Gets the pinned pointer variable name.
    prop Name string {
        get;
    }

    /// Gets the pointer type clause.
    prop PointerType GTypeReference {
        get;
    }

    /// Gets the managed source expression being pinned.
    prop Source GExpression {
        get;
    }

    /// Gets the fixed-region body.
    prop Body BlockStatement {
        get;
    }
}
