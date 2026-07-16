// <copyright file="StatementBinder.Conditionals.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class StatementBinder
{
    private BoundStatement BindIfStatement(IfStatementSyntax syntax)
    {
        if (syntax.Initializer == null)
        {
            var condition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);

            // Phase 3.C.4/6.6: recognise one top-level nullable guard. Boolean
            // conjunction/disjunction flow (for example `s != nil && IsValid(s)`)
            // is intentionally deferred for the nil-guard classifier.
            var (thenNarrow, elseNarrow) = TryClassifyNilGuard(condition);
            if (thenNarrow == null && elseNarrow == null)
            {
                (thenNarrow, elseNarrow) = TryClassifyBoolCallNarrowing(condition);
            }

            // ADR-0069 / issue #700: smart-cast type-test narrowing on
            // `x is T`, `x !is T`, and `&&` chains thereof. Compose with the
            // nullable / `[NotNullWhen]` frames computed above so a condition
            // that combines both styles narrows on both axes.
            var (typeThen, typeElse) = TryClassifyTypeTestNarrowing(condition);
            thenNarrow = MergeNarrowingFrames(thenNarrow, typeThen);
            elseNarrow = MergeNarrowingFrames(elseNarrow, typeElse);

            var thenStatement = BindStatementWithNarrowing(syntax.ThenStatement, thenNarrow);
            var elseStatement = syntax.ElseClause == null ? null : BindStatementWithNarrowing(syntax.ElseClause.ElseStatement, elseNarrow);
            var result = new BoundIfStatement(syntax, condition, thenStatement, elseStatement);

            // ADR-0069 / issue #700: record the else-frame so `BindBlockStatements`
            // can lift it into the enclosing block when the then-branch ends in
            // an unconditional exit (`return`/`throw`/`break`/`continue`).
            if (elseNarrow != null && elseNarrow.Count > 0)
            {
                binderCtx.PendingEarlyExitFrames[result] = elseNarrow;
            }

            return result;
        }

        // `if init; cond { then } else { else }` lowers to a block that
        // scopes the initializer to both arms:
        //   {
        //     <init>
        //     if cond { then } else { else }
        //   }
        scope = new BoundScope(scope);

        var initStatement = BindStatement(syntax.Initializer);
        var initCondition = bindExpressionWithTargetType(syntax.Condition, TypeSymbol.Bool);

        var (initThenNarrow, initElseNarrow) = TryClassifyNilGuard(initCondition);
        if (initThenNarrow == null && initElseNarrow == null)
        {
            (initThenNarrow, initElseNarrow) = TryClassifyBoolCallNarrowing(initCondition);
        }

        var (initTypeThen, initTypeElse) = TryClassifyTypeTestNarrowing(initCondition);
        initThenNarrow = MergeNarrowingFrames(initThenNarrow, initTypeThen);
        initElseNarrow = MergeNarrowingFrames(initElseNarrow, initTypeElse);

        var initThen = BindStatementWithNarrowing(syntax.ThenStatement, initThenNarrow);
        var initElse = syntax.ElseClause == null ? null : BindStatementWithNarrowing(syntax.ElseClause.ElseStatement, initElseNarrow);

        scope = scope.Parent;

        var inner = new BoundIfStatement(syntax, initCondition, initThen, initElse);
        if (initElseNarrow != null && initElseNarrow.Count > 0)
        {
            binderCtx.PendingEarlyExitFrames[inner] = initElseNarrow;
        }

        return new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(initStatement, inner));
    }

    // ──────────────────────────────────────────────────────────────────────
    //  ADR-0071 / issue #708: `if let` and `guard let` binding statements.
    //
    //  Both forms strip one layer of nullability from the right-hand-side
    //  expression and introduce a fresh local for it. The lowering is
    //  expressed entirely in terms of existing bound-node kinds so the
    //  rewriter / walker / printer / spiller / emitter / interpreter
    //  surface needs no updates.
    // ──────────────────────────────────────────────────────────────────────

    /// <summary>
    /// ADR-0071 / issue #708: bind <c>if let</c> as a self-contained block
    /// containing the synthesized let-declarations and a nested if whose
    /// condition is the nil-guard. Multi-binding forms with an else-arm use
    /// a synthesized <c>bool</c> flag so the else-block appears in the
    /// bound tree exactly once.
    /// </summary>
    private BoundStatement BindIfLetStatement(IfLetStatementSyntax syntax)
    {
        var bindings = syntax.Bindings.ToImmutableArray();

        // Push a new scope to contain the synthesized locals. The locals
        // declared from the bindings only need to be visible inside the
        // then-branch, so a single block-scoped lifetime is correct.
        scope = new BoundScope(scope);

        var localsForFrame = new List<(VariableSymbol Variable, TypeSymbol Underlying)>(bindings.Length);
        var declStatements = ImmutableArray.CreateBuilder<BoundStatement>(bindings.Length);
        var anyValid = false;
        foreach (var binding in bindings)
        {
            var (variable, underlying, decl) = BindIfLetBindingClause(binding);
            declStatements.Add(decl);
            if (variable != null && underlying != null)
            {
                localsForFrame.Add((variable, underlying));
                anyValid = true;
            }
        }

        // Build the nil-test condition: `_b0 != nil && _b1 != nil && …`.
        // Each variable expression carries its underlying narrowing type so
        // that read sites inside the then-branch see the non-null type.
        BoundExpression nilCheck = BuildNilCheckChain(syntax, localsForFrame);

        // Build the narrowing frame so the then-block sees each binding at
        // its non-null underlying type. The else-block does NOT see the
        // narrowing — the bindings are not even in scope there.
        Dictionary<AccessPath, TypeSymbol> thenFrame = null;
        if (localsForFrame.Count > 0)
        {
            thenFrame = new Dictionary<AccessPath, TypeSymbol>(localsForFrame.Count);
            foreach (var (variable, underlying) in localsForFrame)
            {
                thenFrame[variable] = underlying;
            }
        }

        var thenStatement = BindStatementWithNarrowing(syntax.ThenStatement, thenFrame);

        // Pop the scope BEFORE binding the else clause so the bindings are
        // not visible inside it (ADR-0071: bindings are then-only).
        scope = scope.Parent;
        var elseStatement = syntax.ElseClause == null ? null : BindStatement(syntax.ElseClause.ElseStatement);

        // If no binding survived (every initializer was an error), just
        // return the synthesized block so the user still sees diagnostics
        // but no synthetic if-shape leaks.
        if (!anyValid)
        {
            return new BoundBlockStatement(syntax, declStatements.ToImmutable());
        }

        BoundStatement core;
        if (syntax.ElseClause == null || localsForFrame.Count <= 1)
        {
            // No else, or a single binding (which fits the natural shape
            // without needing a matched-flag): build a simple if/else.
            core = new BoundIfStatement(syntax, nilCheck, thenStatement, elseStatement);
        }
        else
        {
            // Multi-binding with an else: route through a synthesized
            // `bool _matched` flag so the else block runs exactly once and
            // is duplicated zero times in the bound tree.
            //
            // var __ifLet_matched_<pos> = false
            // let a = e0; if a != nil { let b = e1; if b != nil { ... if zN != nil { __matched = true; <then> } } }
            // if !__matched { <else> }
            var flagName = $"<ifLetMatched{System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter)}>";
            var flagVar = new LocalVariableSymbol(flagName, isReadOnly: false, TypeSymbol.Bool);
            scope.TryDeclareVariable(flagVar);

            var flagDecl = new BoundVariableDeclaration(syntax, flagVar, new BoundLiteralExpression(syntax, false, TypeSymbol.Bool));
            var setFlag = new BoundExpressionStatement(
                syntax,
                new BoundAssignmentExpression(syntax, flagVar, new BoundLiteralExpression(syntax, true, TypeSymbol.Bool)));
            var combinedThen = new BoundBlockStatement(syntax, ImmutableArray.Create<BoundStatement>(setFlag, thenStatement));
            var matchIf = new BoundIfStatement(syntax, nilCheck, combinedThen, elseStatement: null);

            var notFlag = new BoundUnaryExpression(syntax, BoundUnaryOperator.Bind(SyntaxKind.BangToken, TypeSymbol.Bool), new BoundVariableExpression(syntax, flagVar));
            var elseIf = new BoundIfStatement(syntax, notFlag, elseStatement, elseStatement: null);

            var sequenced = ImmutableArray.CreateBuilder<BoundStatement>(declStatements.Count + 3);
            sequenced.Add(flagDecl);
            sequenced.AddRange(declStatements);
            sequenced.Add(matchIf);
            sequenced.Add(elseIf);
            return new BoundBlockStatement(syntax, sequenced.ToImmutable());
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>(declStatements.Count + 1);
        statements.AddRange(declStatements);
        statements.Add(core);
        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    /// <summary>
    /// ADR-0071 / issue #708: bind a single <c>let name [T] = expr</c>
    /// binding clause inside an <c>if let</c> or <c>guard let</c> header.
    /// Returns the synthesized variable (or <c>null</c> when the clause is
    /// erroneous), its underlying non-null type, and the resulting decl.
    /// The variable is declared in the binder's current scope; callers
    /// control that scope to scope the binding to a then-block or to the
    /// enclosing block as appropriate.
    /// </summary>
    private (VariableSymbol Variable, TypeSymbol Underlying, BoundStatement Declaration) BindIfLetBindingClause(IfLetBindingClauseSyntax binding)
    {
        TypeSymbol declaredUnderlying = null;
        if (binding.TypeClause != null)
        {
            declaredUnderlying = bindTypeClause(binding.TypeClause);

            // The author wrote `if let s string = …`: they declared the
            // underlying (non-null) type. A nullable spelling would be
            // self-defeating — reject it through the standard
            // initializer-type diagnostic by widening to the nullable.
            if (declaredUnderlying is NullableTypeSymbol declaredNullable)
            {
                declaredUnderlying = declaredNullable.UnderlyingType;
            }
        }

        var initializerExpr = bindExpression(binding.Initializer);
        var initializerType = initializerExpr.Type;

        if (initializerType == TypeSymbol.Error)
        {
            var errorVar = bindLocalVariable(binding.Identifier, isReadOnly: true, declaredUnderlying ?? TypeSymbol.Error);
            return (null, null, new BoundVariableDeclaration(binding, errorVar, initializerExpr));
        }

        // ADR-0071: the right-hand side must be of nullable type so the
        // binding has something to strip. A non-nullable RHS is GS0296.
        TypeSymbol underlying;
        TypeSymbol nullableStorageType;
        if (initializerType is NullableTypeSymbol nullable)
        {
            underlying = nullable.UnderlyingType;
            nullableStorageType = nullable;
        }
        else if (initializerType == TypeSymbol.Null)
        {
            // A bare `nil` literal — there's no narrowing to do; bind to
            // the declared underlying type if available, otherwise error.
            if (declaredUnderlying == null)
            {
                Diagnostics.ReportIfLetInitializerMustBeNullable(binding.Initializer.Location, binding.Identifier.Text, initializerType);
                var errorVar = bindLocalVariable(binding.Identifier, isReadOnly: true, TypeSymbol.Error);
                return (null, null, new BoundVariableDeclaration(binding, errorVar, initializerExpr));
            }

            underlying = declaredUnderlying;
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying);
        }
        else
        {
            Diagnostics.ReportIfLetInitializerMustBeNullable(binding.Initializer.Location, binding.Identifier.Text, initializerType);
            var errorVar = bindLocalVariable(binding.Identifier, isReadOnly: true, declaredUnderlying ?? initializerType);
            return (null, null, new BoundVariableDeclaration(binding, errorVar, initializerExpr));
        }

        // If the user gave an explicit type clause, the underlying type
        // they wrote must match (or be a conversion-target of) the RHS's
        // underlying. We route through the existing conversion classifier
        // for an apples-to-apples diagnostic.
        if (declaredUnderlying != null)
        {
            var conv = conversions.BindConversion(binding.Initializer.Location, initializerExpr, NullableTypeSymbol.Get(declaredUnderlying));
            initializerExpr = conv;
            underlying = declaredUnderlying;
            nullableStorageType = NullableTypeSymbol.Get(declaredUnderlying);
        }

        // The synthesized binding is `let name <nullable> = expr`. The
        // user observes it at the underlying type via the existing
        // narrowing path (NarrowedType on each read site).
        var variable = bindLocalVariable(binding.Identifier, isReadOnly: true, nullableStorageType);
        var declaration = new BoundVariableDeclaration(binding, variable, initializerExpr);
        return (variable, underlying, declaration);
    }

    /// <summary>
    /// ADR-0071 / issue #708: build a left-folded `&amp;&amp;` chain of
    /// <c>variable != nil</c> tests for the given bindings. With a single
    /// binding this is just <c>variable != nil</c>.
    /// </summary>
    private static BoundExpression BuildNilCheckChain(SyntaxNode syntax, List<(VariableSymbol Variable, TypeSymbol Underlying)> bindings)
    {
        BoundExpression result = null;
        foreach (var (variable, _) in bindings)
        {
            var read = new BoundVariableExpression(syntax, variable);
            var nilLiteral = new BoundLiteralExpression(syntax, null, TypeSymbol.Null);
            var neqOp = BoundBinaryOperator.Bind(SyntaxKind.BangEqualsToken, variable.Type, TypeSymbol.Null);
            BoundExpression test = new BoundBinaryExpression(syntax, read, neqOp, nilLiteral);
            if (result == null)
            {
                result = test;
            }
            else
            {
                var andOp = BoundBinaryOperator.Bind(SyntaxKind.AmpersandAmpersandToken, TypeSymbol.Bool, TypeSymbol.Bool);
                result = new BoundBinaryExpression(syntax, result, andOp, test);
            }
        }

        return result;
    }

    /// <summary>
    /// ADR-0071 / issue #708: standalone fallback for binding
    /// <c>guard let</c> when it appears outside a block (for example as a
    /// stray statement at the top of a function body when the outer
    /// dispatch routes through <see cref="BindStatement"/>). The normal
    /// path goes through <see cref="BindGuardLetStatementInBlock"/>, which
    /// integrates with the enclosing block's narrowing frame.
    /// </summary>
    private BoundStatement BindGuardLetStatement(GuardLetStatementSyntax syntax)
    {
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var pseudoFrame = new Dictionary<AccessPath, TypeSymbol>();
        BindGuardLetStatementInBlock(syntax, statements, pseudoFrame);
        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }

    /// <summary>
    /// ADR-0071 / issue #708: bind <c>guard let</c> into the enclosing
    /// statement builder so the synthesized locals and the narrowings
    /// extend the enclosing block. Each binding becomes a let-decl
    /// followed by an `if x == nil { else }` whose else-block is the
    /// user's exit clause; the existing
    /// <see cref="ApplyEarlyExitNarrowings"/> path lifts each binding's
    /// non-nil narrowing into <paramref name="persistentFrame"/>.
    /// </summary>
    private void BindGuardLetStatementInBlock(
        GuardLetStatementSyntax syntax,
        ImmutableArray<BoundStatement>.Builder statements,
        Dictionary<AccessPath, TypeSymbol> persistentFrame)
    {
        // The else block must be re-bound once per binding arm because the
        // ControlFlowGraph builder demands that each BoundStatement appear
        // at most once in the tree (it keys block lookup by statement
        // identity). Re-binding the same syntax repeatedly would otherwise
        // report every diagnostic inside the else block once per arm
        // (issue #1637), so only the first bind's diagnostics are kept;
        // subsequent re-binds are truncated back to that point.
        var hasBoundElseOnce = false;

        foreach (var binding in syntax.Bindings)
        {
            var (variable, underlying, decl) = BindIfLetBindingClause(binding);
            statements.Add(decl);
            if (variable == null || underlying == null)
            {
                continue;
            }

            // Bind a fresh copy of the else block for this arm so that the
            // ControlFlowGraph builder sees a unique BoundStatement
            // instance per arm.
            var diagMark = Diagnostics.Count;
            var armElse = BindStatement(syntax.ElseStatement);
            if (hasBoundElseOnce)
            {
                Diagnostics.TruncateTo(diagMark);
            }
            else
            {
                hasBoundElseOnce = true;
                if (!EndsInUnconditionalExit(armElse))
                {
                    Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location);
                }
            }

            // Build `if <var> == nil { else }`.
            var read = new BoundVariableExpression(binding, variable);
            var nilLiteral = new BoundLiteralExpression(binding, null, TypeSymbol.Null);
            var eqOp = BoundBinaryOperator.Bind(SyntaxKind.EqualsEqualsToken, variable.Type, TypeSymbol.Null);
            var condition = new BoundBinaryExpression(binding, read, eqOp, nilLiteral);
            var ifStmt = new BoundIfStatement(binding, condition, armElse, elseStatement: null);

            // Manually thread the persistent-frame narrowing for this
            // binding. We *cannot* round-trip through
            // ApplyEarlyExitNarrowings because that helper consumes
            // entries from PendingEarlyExitFrames keyed by the if node;
            // we have the data inline here, so just promote directly.
            persistentFrame[variable] = underlying;
            statements.Add(ifStmt);
        }

        // If every arm's binding clause failed (all `continue`d above), the
        // else block was never bound and its diagnostics -- including
        // GS0297 -- would silently vanish. Bind it once here, purely for
        // diagnostics; it isn't wired into any statement since there's no
        // successful binding left to guard.
        if (!hasBoundElseOnce)
        {
            var armElse = BindStatement(syntax.ElseStatement);
            if (!EndsInUnconditionalExit(armElse))
            {
                Diagnostics.ReportGuardLetElseMustExit(syntax.ElseStatement.Location);
            }
        }
    }

    private static Dictionary<AccessPath, TypeSymbol> MergeNarrowingFrames(
        Dictionary<AccessPath, TypeSymbol> a,
        Dictionary<AccessPath, TypeSymbol> b)
    {
        if (a == null || a.Count == 0)
        {
            return (b == null || b.Count == 0) ? null : b;
        }

        if (b == null || b.Count == 0)
        {
            return a;
        }

        var merged = new Dictionary<AccessPath, TypeSymbol>(a);
        foreach (var kv in b)
        {
            // Later (more specific) wins on conflict. The type-test path passes
            // its frame as `b`, so a type-test narrowing supersedes a coincident
            // nil-guard narrowing on the same variable.
            merged[kv.Key] = kv.Value;
        }

        return merged;
    }

    /// <summary>
    /// ADR-0069 / issue #700: classify <c>is</c> / <c>!is</c> tests (and
    /// <c>&amp;&amp;</c> chains thereof) on a local-variable or parameter
    /// receiver into per-branch narrowing frames.
    /// </summary>
    /// <param name="condition">The bound condition expression.</param>
    /// <returns>A pair of narrowing frames — the first applies to the
    /// then-branch, the second to the else-branch. Either may be
    /// <c>null</c> if the corresponding branch has no narrowing.</returns>
    private (Dictionary<AccessPath, TypeSymbol> Then, Dictionary<AccessPath, TypeSymbol> Else) TryClassifyTypeTestNarrowing(BoundExpression condition)
    {
        switch (condition)
        {
            case BoundIsExpression isExpr:
                {
                    AccessPath targetPath;
                    TypeSymbol currentType;
                    if (IsNarrowableVariable(isExpr.Expression, out var target))
                    {
                        targetPath = target;
                        currentType = target.Type;
                    }
                    else if (SmartCastStability.TryGetStableMemberPath(isExpr.Expression, out targetPath, out currentType))
                    {
                        // ADR-0069 addendum / issue #1180: a stable immutable
                        // member path (`x.shape`, `this.box.lid`) narrows just
                        // like a local. Unstable members never reach here.
                    }
                    else
                    {
                        return (null, null);
                    }

                    var targetType = isExpr.TargetType;
                    if (targetType == null || targetType == TypeSymbol.Error)
                    {
                        return (null, null);
                    }

                    // `x is T` narrows `x` to `T` in the then-branch. The
                    // else-branch carries no narrowing: failing the type test
                    // tells us nothing more about the variable's type.
                    var narrowed = StripNullable(targetType);
                    if (!IsStrictlyNarrower(currentType, narrowed))
                    {
                        return (null, null);
                    }

                    return (new Dictionary<AccessPath, TypeSymbol> { [targetPath] = narrowed }, null);
                }

            case BoundUnaryExpression unary when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation:
                {
                    var (inThen, inElse) = TryClassifyTypeTestNarrowing(unary.Operand);
                    return (inElse, inThen);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalAnd:
                {
                    // De Morgan for `&&`: then = thenL ∧ thenR (both true → both narrowings apply).
                    // The else frame is intentionally dropped — either operand could have been
                    // the false one, so we cannot single out a per-variable narrowing.
                    var (leftThen, _) = TryClassifyTypeTestNarrowing(binary.Left);
                    var (rightThen, _) = TryClassifyTypeTestNarrowing(binary.Right);
                    var combinedThen = MergeNarrowingFrames(leftThen, rightThen);
                    if (combinedThen == null || combinedThen.Count == 0)
                    {
                        return (null, null);
                    }

                    return (combinedThen, null);
                }

            case BoundBinaryExpression binary when binary.Op.Kind == BoundBinaryOperatorKind.LogicalOr:
                {
                    // ADR-0069 addendum / issue #712: De Morgan dual of `&&` for `||`.
                    // For `A || B`:
                    //   • then = intersection of thenL and thenR — only narrowings present
                    //     in BOTH operands' then-frames with the same target type survive
                    //     (canonical example: `x is T || x is T` keeps `{x → T}`).
                    //   • else = elseL ∧ elseR — when the whole `||` is false, BOTH operands
                    //     were false, so both negative narrowings apply.
                    var (leftThen, leftElse) = TryClassifyTypeTestNarrowing(binary.Left);
                    var (rightThen, rightElse) = TryClassifyTypeTestNarrowing(binary.Right);

                    var combinedThen = IntersectNarrowingFrames(leftThen, rightThen);
                    var combinedElse = MergeNarrowingFrames(leftElse, rightElse);

                    if ((combinedThen == null || combinedThen.Count == 0)
                        && (combinedElse == null || combinedElse.Count == 0))
                    {
                        return (null, null);
                    }

                    return (combinedThen, combinedElse);
                }
        }

        return (null, null);
    }

    /// <summary>
    /// ADR-0069 addendum / issue #712: intersect two narrowing frames. Only
    /// variables present in both frames AND narrowed to the same type
    /// survive. Used by the <c>||</c> then-frame classifier where a
    /// narrowing is only sound if both operands prove the same fact.
    /// </summary>
    private static Dictionary<AccessPath, TypeSymbol> IntersectNarrowingFrames(
        Dictionary<AccessPath, TypeSymbol> a,
        Dictionary<AccessPath, TypeSymbol> b)
    {
        if (a == null || a.Count == 0 || b == null || b.Count == 0)
        {
            return null;
        }

        Dictionary<AccessPath, TypeSymbol> result = null;
        foreach (var kv in a)
        {
            if (b.TryGetValue(kv.Key, out var other) && other == kv.Value)
            {
                result ??= new Dictionary<AccessPath, TypeSymbol>();
                result[kv.Key] = kv.Value;
            }
        }

        return result;
    }

    private static bool IsNarrowableVariable(BoundExpression expr, out VariableSymbol variable)
    {
        variable = null;
        if (expr is not BoundVariableExpression bve)
        {
            return false;
        }

        // ADR-0069 narrows locals and parameters only — never fields,
        // properties, or implicit-field/property reads. Those receivers
        // can be mutated by aliasing or another thread between the test
        // and the use, so narrowing would be unsound.
        if (bve.Variable is LocalVariableSymbol or ParameterSymbol)
        {
            variable = bve.Variable;
            return true;
        }

        return false;
    }

    /// <summary>
    /// ADR-0069 addendum / issue #712: stability rule for switch-pattern
    /// narrowing. We narrow non-mutable receivers — locals, parameters,
    /// and read-only globals (<c>let</c>). Mutable globals are excluded
    /// because they can be reassigned between the test and the use under
    /// aliasing or another thread.
    /// </summary>
    private static bool IsStableNarrowableVariable(VariableSymbol variable)
    {
        return variable switch
        {
            LocalVariableSymbol => true,
            GlobalVariableSymbol g => g.IsReadOnly,
            _ => false,
        };
    }

    private static TypeSymbol StripNullable(TypeSymbol type)
    {
        return type is NullableTypeSymbol nullable ? nullable.UnderlyingType : type;
    }

    private static bool IsStrictlyNarrower(TypeSymbol declared, TypeSymbol candidate)
    {
        // Shared with the short-circuit (`x is T && …`) classifier in
        // ExpressionBinder so `if`-statement and `&&` narrowing agree. Handles
        // the subtype lattice (issue #1636) and the type-parameter/interface
        // operand tested against an interface (issue #2165).
        return SmartCastStability.IsTypeTestNarrowing(declared, candidate);
    }

    private (Dictionary<AccessPath, TypeSymbol> NonNil, Dictionary<AccessPath, TypeSymbol> Nil) TryClassifyNilGuard(BoundExpression condition)
    {
        // ADR-0069 addendum / issue #712: compose nil-guard classification across
        // `!`, `&&`, and `||` so guards like `if a == nil || cond { ... } else { use(a) }`
        // narrow `a` to its non-nullable underlying type in the else-branch.
        switch (condition)
        {
            case BoundUnaryExpression unary when unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation:
                {
                    var (inThen, inElse) = TryClassifyNilGuard(unary.Operand);
                    return (inElse, inThen);
                }

            case BoundBinaryExpression bin when bin.Op.Kind == BoundBinaryOperatorKind.LogicalAnd:
                {
                    var (leftThen, _) = TryClassifyNilGuard(bin.Left);
                    var (rightThen, _) = TryClassifyNilGuard(bin.Right);
                    var combinedThen = MergeNarrowingFrames(leftThen, rightThen);
                    if (combinedThen == null || combinedThen.Count == 0)
                    {
                        return (null, null);
                    }

                    return (combinedThen, null);
                }

            case BoundBinaryExpression bin when bin.Op.Kind == BoundBinaryOperatorKind.LogicalOr:
                {
                    var (leftThen, leftElse) = TryClassifyNilGuard(bin.Left);
                    var (rightThen, rightElse) = TryClassifyNilGuard(bin.Right);
                    var combinedThen = IntersectNarrowingFrames(leftThen, rightThen);
                    var combinedElse = MergeNarrowingFrames(leftElse, rightElse);
                    if ((combinedThen == null || combinedThen.Count == 0)
                        && (combinedElse == null || combinedElse.Count == 0))
                    {
                        return (null, null);
                    }

                    return (combinedThen, combinedElse);
                }
        }

        // Phase 3.C.4: recognise the canonical narrowing patterns via the shared
        // leaf classifier (SmartCastStability.TryClassifyNilGuardLeaf), kept in
        // sync with ExpressionBinder.ClassifyTypeTestNarrowing (issue #1545). We
        // support only single-variable/stable-path guards here at the leaf;
        // conjunctions, disjunctions and pattern-based narrowing compose via the
        // cases above.
        if (!SmartCastStability.TryClassifyNilGuardLeaf(condition, restrictBareVariableToLocalsAndParams: false, referenceNullableOnly: false, out var target, out var underlying, out var nonNilWhenTrue))
        {
            return (null, null);
        }

        Dictionary<AccessPath, TypeSymbol> nonNilFrame = null;
        Dictionary<AccessPath, TypeSymbol> nilFrame = null;
        if (nonNilWhenTrue)
        {
            nonNilFrame = new Dictionary<AccessPath, TypeSymbol> { [target] = underlying };
        }
        else
        {
            nilFrame = new Dictionary<AccessPath, TypeSymbol> { [target] = underlying };
        }

        return (nonNilFrame, nilFrame);
    }

    private (Dictionary<AccessPath, TypeSymbol> Then, Dictionary<AccessPath, TypeSymbol> Else) TryClassifyBoolCallNarrowing(BoundExpression condition)
    {
        var negate = false;
        var inner = condition;
        if (inner is BoundUnaryExpression unary && unary.Op.Kind == BoundUnaryOperatorKind.LogicalNegation)
        {
            negate = true;
            inner = unary.Operand;
        }

        if (inner is BoundImportedCallExpression importedCall && importedCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyImportedBoolCallNarrowing(importedCall, negate);
            MergeClrMemberNotNullWhenNarrowings(importedCall.Function.Method, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundImportedInstanceCallExpression importedInstanceCall && importedInstanceCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyImportedMethodBoolCallNarrowing(importedInstanceCall.Method.GetParameters(), importedInstanceCall.Arguments, negate);
            MergeClrMemberNotNullWhenNarrowings(importedInstanceCall.Method, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundCallExpression userCall && userCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = ClassifyUserBoolCallNarrowing(userCall, negate);
            MergeUserMemberNotNullWhenNarrowings(userCall.Function.Attributes, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        if (inner is BoundUserInstanceCallExpression userInstanceCall && userInstanceCall.Type == TypeSymbol.Bool)
        {
            var (thenFrame, elseFrame) = (default(Dictionary<AccessPath, TypeSymbol>), default(Dictionary<AccessPath, TypeSymbol>));
            MergeUserMemberNotNullWhenNarrowings(userInstanceCall.Method.Attributes, negate, ref thenFrame, ref elseFrame);
            return (thenFrame, elseFrame);
        }

        return (null, null);
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a CLR-imported method.
    private void MergeClrMemberNotNullWhenNarrowings(
        System.Reflection.MethodInfo method,
        bool negate,
        ref Dictionary<AccessPath, TypeSymbol> thenFrame,
        ref Dictionary<AccessPath, TypeSymbol> elseFrame)
    {
        if (!ClrNullability.TryGetMemberNotNullWhenData(method, out var returnValue, out var members))
        {
            return;
        }

        var narrowThen = returnValue != negate;
        var frame = narrowThen ? (thenFrame ??= new Dictionary<AccessPath, TypeSymbol>()) : (elseFrame ??= new Dictionary<AccessPath, TypeSymbol>());
        foreach (var name in members)
        {
            NarrowFieldIfNullable(name, frame);
        }
    }

    // Issue #208: merge [MemberNotNullWhen] field narrowings from a user-declared method.
    private void MergeUserMemberNotNullWhenNarrowings(
        ImmutableArray<BoundAttribute> attributes,
        bool negate,
        ref Dictionary<AccessPath, TypeSymbol> thenFrame,
        ref Dictionary<AccessPath, TypeSymbol> elseFrame)
    {
        if (attributes.IsDefaultOrEmpty)
        {
            return;
        }

        foreach (var attr in attributes)
        {
            if (!KnownAttributes.TryGetMemberNotNullWhenData(attr, out var returnValue, out var members))
            {
                continue;
            }

            var narrowThen = returnValue != negate;
            var frame = narrowThen ? (thenFrame ??= new Dictionary<AccessPath, TypeSymbol>()) : (elseFrame ??= new Dictionary<AccessPath, TypeSymbol>());
            foreach (var name in members)
            {
                NarrowFieldIfNullable(name, frame);
            }
        }
    }

    private static (Dictionary<AccessPath, TypeSymbol> Then, Dictionary<AccessPath, TypeSymbol> Else) ClassifyImportedBoolCallNarrowing(BoundImportedCallExpression call, bool negate)
        => ClassifyImportedMethodBoolCallNarrowing(call.Function.Method.GetParameters(), call.Arguments, negate);
    private static (Dictionary<AccessPath, TypeSymbol> Then, Dictionary<AccessPath, TypeSymbol> Else) ClassifyImportedMethodBoolCallNarrowing(
        ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        bool negate)
    {
        Dictionary<AccessPath, TypeSymbol> thenFrame = null;
        Dictionary<AccessPath, TypeSymbol> elseFrame = null;
        var count = Math.Min(parameters.Length, arguments.Length);
        for (var i = 0; i < count; i++)
        {
            var parameter = parameters[i];

            // [MaybeNullWhen(rv)] on a non-nullable argument widens the caller's
            // variable to its nullable counterpart on the arm where the call returns
            // rv. The argument may be a plain variable or an address-of expression
            // (&var) when the CLR parameter is declared `out T`.
            if (ClrNullability.TryGetMaybeNullWhen(parameter, out var maybeNullWhenReturnValue))
            {
                var rawArg = arguments[i];
                var widenArg = rawArg is BoundAddressOfExpression addrOf ? addrOf.Operand : rawArg;
                if (widenArg is BoundVariableExpression widenVarExpr
                    && widenVarExpr.Variable.Type is not NullableTypeSymbol
                    && widenVarExpr.Variable.Type != TypeSymbol.Null)
                {
                    var widenThen = maybeNullWhenReturnValue != negate;
                    var widenFrame = widenThen
                        ? (thenFrame ??= new Dictionary<AccessPath, TypeSymbol>())
                        : (elseFrame ??= new Dictionary<AccessPath, TypeSymbol>());
                    widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type);
                }

                continue;
            }

            if (!ClrNullability.TryGetNotNullWhen(parameter, out var returnValue)
                || arguments[i] is not BoundVariableExpression variableExpression
                || variableExpression.Variable.Type is not NullableTypeSymbol nullable)
            {
                continue;
            }

            var narrowThen = returnValue != negate;
            var frame = narrowThen ? (thenFrame ??= new Dictionary<AccessPath, TypeSymbol>()) : (elseFrame ??= new Dictionary<AccessPath, TypeSymbol>());
            frame[variableExpression.Variable] = nullable.UnderlyingType;
        }

        return (thenFrame, elseFrame);
    }

    private static (Dictionary<AccessPath, TypeSymbol> Then, Dictionary<AccessPath, TypeSymbol> Else) ClassifyUserBoolCallNarrowing(BoundCallExpression call, bool negate)
    {
        // Issue #178 / ADR-0047 §6: a user-declared function may carry the
        // same [NotNullWhen] / [MaybeNullWhen] postconditions C# uses.
        // Recognition is type-identity based via KnownAttributes so renaming
        // or shadowing the source name cannot bypass the narrowing rule.
        var parameters = call.Function.Parameters;
        Dictionary<AccessPath, TypeSymbol> thenFrame = null;
        Dictionary<AccessPath, TypeSymbol> elseFrame = null;
        var count = Math.Min(parameters.Length, call.Arguments.Length);
        for (var i = 0; i < count; i++)
        {
            var parameter = parameters[i];
            var attributes = parameter.Attributes;
            if (attributes.IsDefaultOrEmpty)
            {
                continue;
            }

            var notNullWhenReturnValue = (bool?)null;
            var maybeNullWhenReturnValue = (bool?)null;
            foreach (var attribute in attributes)
            {
                if (KnownAttributes.TryGetNotNullWhenReturnValue(attribute, out var rv))
                {
                    notNullWhenReturnValue = rv;
                }
                else if (KnownAttributes.TryGetMaybeNullWhenReturnValue(attribute, out var mrv))
                {
                    maybeNullWhenReturnValue = mrv;
                }
            }

            var argExpr = call.Arguments[i];

            // [NotNullWhen(rv)]: narrow a nullable argument to its underlying
            // non-nullable type on the arm where the call returns rv.
            if (notNullWhenReturnValue is bool returnValue
                && argExpr is BoundVariableExpression narrowVarExpr
                && narrowVarExpr.Variable.Type is NullableTypeSymbol nullable)
            {
                var narrowThen = returnValue != negate;
                var frame = narrowThen
                    ? (thenFrame ??= new Dictionary<AccessPath, TypeSymbol>())
                    : (elseFrame ??= new Dictionary<AccessPath, TypeSymbol>());
                frame[narrowVarExpr.Variable] = nullable.UnderlyingType;
            }

            // [MaybeNullWhen(rv)]: widen a non-nullable argument to its nullable
            // counterpart on the arm where the call returns rv.
            if (maybeNullWhenReturnValue is bool widenReturnValue
                && argExpr is BoundVariableExpression widenVarExpr
                && widenVarExpr.Variable.Type is not NullableTypeSymbol
                && widenVarExpr.Variable.Type != TypeSymbol.Null)
            {
                var widenThen = widenReturnValue != negate;
                var widenFrame = widenThen
                    ? (thenFrame ??= new Dictionary<AccessPath, TypeSymbol>())
                    : (elseFrame ??= new Dictionary<AccessPath, TypeSymbol>());
                widenFrame[widenVarExpr.Variable] = NullableTypeSymbol.Get(widenVarExpr.Variable.Type);
            }
        }

        return (thenFrame, elseFrame);
    }

    internal static bool IsNilLiteral(BoundExpression expr)
    {
        while (expr is BoundConversionExpression conversion)
        {
            expr = conversion.Expression;
        }

        return expr is BoundLiteralExpression lit && lit.Type == TypeSymbol.Null;
    }

    internal static Dictionary<AccessPath, TypeSymbol> TryClassifyPatternNarrowing(BoundExpression discriminant, BoundPattern pattern)
    {
        if (pattern == null)
        {
            return null;
        }

        // ADR-0069 addendum / issue #712: only narrow non-mutable receivers
        // (locals, parameters, and read-only globals). ADR-0069 addendum /
        // issue #1180 extends this to stable immutable member paths
        // (`switch x.shape { case c is Circle: ... }`). Mutable receivers could
        // be reassigned or mutated between the test and the use.
        AccessPath discriminantPath;
        if (discriminant is BoundVariableExpression variableExpression
            && IsStableNarrowableVariable(variableExpression.Variable))
        {
            discriminantPath = variableExpression.Variable;
        }
        else if (SmartCastStability.TryGetStableMemberPath(discriminant, out var memberPath, out _))
        {
            discriminantPath = memberPath;
        }
        else
        {
            return null;
        }

        var discriminantType = discriminant.Type;
        TypeSymbol narrowedType = null;
        switch (pattern)
        {
            case BoundTypePattern typePattern:
                narrowedType = typePattern.TargetType;
                break;
            case BoundConstantPattern constantPattern when discriminantType is NullableTypeSymbol nullable && !IsNilLiteral(constantPattern.Value):
                narrowedType = nullable.UnderlyingType;
                break;
            case BoundDiscardPattern:
                break;
            case BoundBinaryPattern binaryPattern when binaryPattern.IsConjunction:
                // Issue #992: `and` — both sub-patterns hold, so the union of
                // their narrowings is sound.
                {
                    var left = TryClassifyPatternNarrowing(discriminant, binaryPattern.Left);
                    var right = TryClassifyPatternNarrowing(discriminant, binaryPattern.Right);
                    return MergeNarrowingFrames(left, right);
                }

            case BoundBinaryPattern binaryPattern:
                // Issue #992: `or` — only narrowings proven by BOTH branches
                // (same variable, same type) survive. This keeps the smart-cast
                // sound: `x is Cat or x is Dog` narrows nothing.
                {
                    var left = TryClassifyPatternNarrowing(discriminant, binaryPattern.Left);
                    var right = TryClassifyPatternNarrowing(discriminant, binaryPattern.Right);
                    return IntersectNarrowingFrames(left, right);
                }

            case BoundNotPattern:
                // Issue #992: `not P` tells us P did NOT match, which carries no
                // positive narrowing.
                break;
            case BoundRelationalPattern:
            case BoundPropertyPattern:
            case BoundListPattern:
                // These patterns can imply non-nullness in some cases, but this
                // phase keeps narrowing to simple type and non-nil constant arms.
                break;
        }

        return narrowedType == null ? null : new Dictionary<AccessPath, TypeSymbol> { [discriminantPath] = narrowedType };
    }

    private BoundStatement BindStatementWithNarrowing(StatementSyntax syntax, Dictionary<AccessPath, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return BindStatement(syntax);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return BindStatement(syntax);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    // Issue #991: bind a switch-arm `when` guard as a boolean expression under
    // the arm's pattern-narrowing frame. A non-bool guard surfaces the standard
    // conversion diagnostic.
    private BoundExpression BindGuardExpressionWithNarrowing(ExpressionSyntax syntax, Dictionary<AccessPath, TypeSymbol> frame)
    {
        if (frame == null)
        {
            return bindExpressionWithTargetType(syntax, TypeSymbol.Bool);
        }

        binderCtx.NarrowedVariables.Add(frame);
        try
        {
            return bindExpressionWithTargetType(syntax, TypeSymbol.Bool);
        }
        finally
        {
            binderCtx.NarrowedVariables.RemoveAt(binderCtx.NarrowedVariables.Count - 1);
        }
    }

    private BoundStatement BindMultiAssignmentStatement(MultiAssignmentStatementSyntax syntax)
    {
        var targets = syntax.Targets.ToImmutableArray();
        var values = syntax.Values.ToImmutableArray();

        if (targets.Length != values.Length)
        {
            Diagnostics.ReportMultiAssignmentMismatch(syntax.Location, targets.Length, values.Length);
            return new BoundExpressionStatement(syntax, new BoundErrorExpression(null));
        }

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        var isShortDecl = syntax.OperatorToken.Kind == SyntaxKind.ColonEqualsToken;

        if (isShortDecl)
        {
            for (var i = 0; i < targets.Length; i++)
            {
                var nameExpr = (NameExpressionSyntax)targets[i];
                var initializer = bindExpression(values[i]);
                var variable = bindLocalVariable(nameExpr.IdentifierToken, isReadOnly: false, type: initializer.Type);
                statements.Add(new BoundVariableDeclaration(syntax, variable, initializer));
            }

            return new BoundBlockStatement(syntax, statements.ToImmutable());
        }

        // Plain assignment: evaluate every RHS into a fresh temp, then assign each temp to its target.
        // This is the semantics Go specifies for `a, b = b, a` and friends.
        var temps = ImmutableArray.CreateBuilder<VariableSymbol>(targets.Length);
        var basePos = syntax.OperatorToken.Position;
        for (var i = 0; i < values.Length; i++)
        {
            var initializer = bindExpression(values[i]);
            var tempName = $"<>m_{basePos}_{i}";
            var temp = function == null
                ? (VariableSymbol)new GlobalVariableSymbol(tempName, isReadOnly: true, initializer.Type)
                : new LocalVariableSymbol(tempName, isReadOnly: true, initializer.Type);
            scope.TryDeclareVariable(temp);
            temps.Add(temp);
            statements.Add(new BoundVariableDeclaration(syntax, temp, initializer));
        }

        for (var i = 0; i < targets.Length; i++)
        {
            var nameExpr = (NameExpressionSyntax)targets[i];
            var name = nameExpr.IdentifierToken.Text;
            var variable = bindVariableReference(name, nameExpr.IdentifierToken.Location);
            if (variable == null)
            {
                continue;
            }

            if (variable.IsReadOnly)
            {
                Diagnostics.ReportCannotAssign(syntax.OperatorToken.Location, name);
            }

            var tempRef = new BoundVariableExpression(null, temps[i]);
            var converted = conversions.BindConversion(values[i].Location, tempRef, variable.Type);
            statements.Add(new BoundExpressionStatement(syntax, new BoundAssignmentExpression(null, variable, converted)));
        }

        return new BoundBlockStatement(syntax, statements.ToImmutable());
    }
}
