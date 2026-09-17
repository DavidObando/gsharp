// <copyright file="CSharpToGSharpTranslator.GuardedFieldLocalCapture.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// Issue #4262 follow-up (5-item plan, item 2): a statement-level
        /// early-return null guard on a field/property
        /// (<c>if (F == null) { return; }</c>, and the compound-condition
        /// sibling <c>if (flag || F == null) { return; }</c> — the shapes
        /// <see cref="IsNullGuardNarrowedFieldUse"/> and
        /// <see cref="IsLazyInitGuardedFieldUse"/> already recognize the
        /// simple atoms of) proves <c>F</c> non-null for every statement that
        /// follows it in the SAME block. Today every later dereference of
        /// <c>F</c> in that region gets its OWN <c>!!</c> (gsc, by design,
        /// never smart-casts a field/property — see those methods' doc
        /// comments). This is faithful but noisy: a real-corpus measurement
        /// found 220 (28%) of 787 <c>!!</c> sites are exactly this shape.
        /// <para>
        /// Instead, capture the field into a synthesized local right after
        /// the guard (<c>let __guardN = F!!</c>) and rewrite the
        /// guard-dominated later reads to use that local — a genuinely
        /// non-null <c>T</c> local needs no further narrowing or assertion
        /// at its own use sites, collapsing N `!!` sites into the single one
        /// at the capture. <see cref="IsNullGuardNarrowedFieldUse"/>'s
        /// per-use <c>!!</c> insertion remains the FALLBACK for any read this
        /// rewrite does not safely reach (written-between, loop-carried, a
        /// different receiver instance, or outside this block) — this pass
        /// only ever REMOVES `!!` sites it can prove safe to remove, never
        /// regressing the existing coverage.
        /// </para>
        /// </summary>
        private void EmitGuardedFieldLocalCaptures(
            IfStatementSyntax ifStatement,
            Dictionary<ISymbol, IfStatementSyntax> activeCaptures,
            List<GStatement> statements)
        {
            List<ISymbol> provenNonNull = this.GetFieldsOrPropertiesProvenNonNullByEarlyReturnGuard(ifStatement);
            if (provenNonNull.Count == 0)
            {
                return;
            }

            // Only a direct child of a block (or switch section) leaks to the
            // statements that follow it — mirrors ComputeBooleanFlowRegions'
            // identical restriction for a pattern local (issue #3409).
            var regions = new List<SyntaxNode>();
            AddFollowingStatements(ifStatement, regions);
            if (regions.Count == 0)
            {
                return;
            }

            SyntaxNode scope = this.state.CurrentBodyScope
                ?? ifStatement.Ancestors().FirstOrDefault(node =>
                    node is BaseMethodDeclarationSyntax
                        or AccessorDeclarationSyntax
                        or LocalFunctionStatementSyntax
                        or AnonymousFunctionExpressionSyntax)
                ?? ifStatement.SyntaxTree.GetRoot();

            foreach (ISymbol symbol in provenNonNull)
            {
                // A redundant later guard on the SAME (still-unwritten) field
                // needs no second capture: the earlier capture's
                // AddFollowingStatements region already reached everything
                // after THIS guard too.
                if (activeCaptures.TryGetValue(symbol, out IfStatementSyntax existingGuard)
                    && !this.SymbolIsWrittenBetween(symbol, existingGuard, ifStatement, scope))
                {
                    continue;
                }

                var eligibleUses = new List<ExpressionSyntax>();
                foreach (SyntaxNode region in regions)
                {
                    this.CollectEligibleGuardCaptureUses(region, symbol, ifStatement, scope, eligibleUses);
                }

                if (eligibleUses.Count == 0)
                {
                    continue;
                }

                // Translate the representative read BEFORE registering any
                // substitution — otherwise this exact node would short-
                // circuit to the (not-yet-declared) capture and translate the
                // field read as itself.
                GExpression fieldRead = this.TranslateExpression(eligibleUses[0]);
                string capturedName = $"__guard{this.state.GuardCaptureCounter++}";
                statements.Add(new LocalDeclarationStatement(
                    BindingKind.Let,
                    capturedName,
                    type: null,
                    initializer: EnsureNonNullAssertion(fieldRead)));

                foreach (ExpressionSyntax use in eligibleUses)
                {
                    this.state.GuardCapturedFieldReads[use] = capturedName;
                }

                activeCaptures[symbol] = ifStatement;
            }
        }

        // True when `expression` is the exact C# node a guard capture already
        // rewrote (see EmitGuardedFieldLocalCaptures / GuardCapturedFieldReads).
        private bool IsGuardCapturedFieldRead(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax parenthesized)
            {
                expression = parenthesized.Expression;
            }

            return this.state.GuardCapturedFieldReads.ContainsKey(expression);
        }

        // The field/property symbols an early-return guard with NO else
        // (`if (<cond>) { <alwaysExits> }`) proves non-null for every
        // statement that follows it in the same block — one entry per
        // top-level `||`-disjunct null-check atom in `<cond>` whose operand is
        // a safely-attributable (bare or `this.`-qualified) read of a field/
        // property G# emits `T?` (see TryGetEmittedNullableFieldOrProperty).
        private List<ISymbol> GetFieldsOrPropertiesProvenNonNullByEarlyReturnGuard(
            IfStatementSyntax ifStatement)
        {
            var results = new List<ISymbol>();
            if (ifStatement.Else != null || !AlwaysExitsViaReturnOrThrow(ifStatement.Statement))
            {
                return results;
            }

            foreach (ISymbol candidate in this.CollectCandidateFieldsOrProperties(ifStatement.Condition))
            {
                if (this.ConditionImpliesNullOnTrueViaOrChain(ifStatement.Condition, candidate))
                {
                    results.Add(candidate);
                }
            }

            return results;
        }

        // Rubber-duck review fix (item 2 follow-up): a narrower, LOCAL variant
        // of <see cref="StatementAlwaysExits"/> that excludes
        // `GotoStatementSyntax`. `StatementAlwaysExits` treats `goto` as
        // "always exits" because that is correct for that helper's own
        // callers (a `goto` never falls through the guard STATEMENT itself).
        // But THIS rewrite's "always exits" question is different: it asks
        // whether the guard body can ever reach the "later statements"
        // region the capture is inserted into via a path that skipped the
        // capture. A `goto` inside the guard body can jump FORWARD to an
        // arbitrary LABEL that happens to lie among those very later
        // statements (`AddFollowingStatements`) — landing there without ever
        // executing `let __guardN = F!!`, reading an unassigned local.
        // `return`/`throw` never resume the enclosing method body at all, so
        // they stay safe; `break`/`continue` are ALSO safe here — unlike an
        // arbitrary `goto` label, their target (the loop's next-iteration
        // test, or the statement right after the whole loop/switch) can
        // never coincide with a statement `AddFollowingStatements` returns,
        // because that helper only walks the SAME immediately-enclosing
        // block/switch-section as the `if`, and a `break`/`continue` target
        // always lies strictly outside it. Scoped to this file's own use
        // only — `StatementAlwaysExits` and its other callers (control-flow
        // lowering, native pattern-variable regions) are unchanged.
        private static bool AlwaysExitsViaReturnOrThrow(StatementSyntax statement) =>
            statement switch
            {
                ReturnStatementSyntax or ThrowStatementSyntax
                    or BreakStatementSyntax or ContinueStatementSyntax => true,
                BlockSyntax { Statements.Count: > 0 } block =>
                    AlwaysExitsViaReturnOrThrow(block.Statements[block.Statements.Count - 1]),
                _ => false,
            };

        // Every distinct field/property symbol G# emits `T?` that appears
        // anywhere in `condition` — the candidate pool
        // GetFieldsOrPropertiesProvenNonNullByEarlyReturnGuard tests each
        // OR-chain position against.
        private List<ISymbol> CollectCandidateFieldsOrProperties(ExpressionSyntax condition)
        {
            var seen = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            var results = new List<ISymbol>();
            foreach (IdentifierNameSyntax identifier in condition
                .DescendantNodesAndSelf()
                .OfType<IdentifierNameSyntax>())
            {
                ISymbol symbol = this.context.GetSymbolInfo(identifier).Symbol;
                if (symbol is IFieldSymbol or IPropertySymbol
                    && this.TryGetEmittedNullableFieldOrPropertySymbol(symbol)
                    && seen.Add(symbol))
                {
                    results.Add(symbol);
                }
            }

            return results;
        }

        // The symbol-only counterpart of TryGetEmittedNullableFieldOrProperty
        // (issue #2202), used here where only the DECLARING symbol — not a
        // specific read syntax node — is available yet.
        //
        // Rubber-duck review fix (item 2 follow-up, Finding 2): a PROPERTY
        // candidate is additionally required to be auto-implemented
        // (<see cref="IsAutoImplementedProperty"/>). The `!!`-per-use
        // fallback re-evaluates a computed property's getter at every read —
        // faithful to C#'s own call count. This rewrite instead evaluates the
        // guarded value ONCE, at the capture, and every later read reuses
        // that one result. For a plain auto-property (or a field) that is a
        // pure storage read with no observable difference. For a computed
        // property whose getter runs arbitrary code (`=> Lookup();`), it is
        // a real behavior change — fewer calls, and any side effect or
        // freshly-computed value in the getter body would only be observed
        // once instead of once per read. Fields have no such getter and are
        // unaffected by this restriction.
        private bool TryGetEmittedNullableFieldOrPropertySymbol(ISymbol symbol)
        {
            ITypeSymbol declared = symbol switch
            {
                IFieldSymbol field => field.Type,
                IPropertySymbol property when IsAutoImplementedProperty(property) => property.Type,
                IPropertySymbol => null,
                _ => null,
            };

            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            return declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.ShouldPromoteToNullableReference(symbol);
        }

        // True when `property` is auto-implemented: every accessor it
        // declares is body-less (`{ get; }`, `{ get; set; }`, `{ get; init; }`)
        // and the property itself has no expression body (`=> expr`) — a pure
        // compiler-backed storage read/write with no observable getter side
        // effects or per-call recomputation. A property with no source
        // declaration at all (e.g. imported from metadata) is conservatively
        // treated as NOT auto-implemented, since its accessor body cannot be
        // inspected here.
        private static bool IsAutoImplementedProperty(IPropertySymbol property)
        {
            foreach (SyntaxReference reference in property.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is not PropertyDeclarationSyntax propertySyntax)
                {
                    return false;
                }

                if (propertySyntax.ExpressionBody != null || propertySyntax.AccessorList == null)
                {
                    return false;
                }

                foreach (AccessorDeclarationSyntax accessor in propertySyntax.AccessorList.Accessors)
                {
                    if (accessor.Body != null || accessor.ExpressionBody != null)
                    {
                        return false;
                    }
                }

                return true;
            }

            return false;
        }

        // True when `condition == true` proves `symbol` is null via a
        // top-level `||`-chain of null-check atoms (De Morgan: on the
        // guard's FALSE/fallthrough path every disjunct — including this
        // one — is false, so `symbol` is non-null there). Only descends
        // through `||`; an atom under `&&` proves nothing about the
        // fallthrough path on its own (`if (a && F == null) return;` leaves
        // `F` possibly null when `a` is false).
        private bool ConditionImpliesNullOnTrueViaOrChain(ExpressionSyntax condition, ISymbol symbol)
        {
            condition = StripParentheses(condition);
            if (this.IsSafeNullCheckOf(condition, symbol))
            {
                return true;
            }

            return condition is BinaryExpressionSyntax binary
                && binary.IsKind(SyntaxKind.LogicalOrExpression)
                && (this.ConditionImpliesNullOnTrueViaOrChain(binary.Left, symbol)
                    || this.ConditionImpliesNullOnTrueViaOrChain(binary.Right, symbol));
        }

        // Issue #4262 follow-up: a RECEIVER-SAFE sibling of
        // <see cref="IsNullCheckOf"/>. That predicate matches by symbol
        // equality alone, which is adequate for the read-side `!!`
        // predicates it drives (asserting an extra `!!` on a same-named
        // field read through a DIFFERENT instance is still safe — it only
        // ever adds an assertion). This predicate instead feeds a rewrite
        // that substitutes a captured LOCAL for later reads: a field/
        // property symbol is shared across every instance of its declaring
        // type, so `other.F == null` and `this.F == null` resolve to the
        // IDENTICAL symbol, and treating the former as proof of the
        // latter's non-nullity would substitute a wrong-instance value.
        // Scoped to the same unqualified/`this.`-qualified shapes
        // <see cref="CollectEligibleGuardCaptureUses"/> requires on the use
        // side.
        private bool IsSafeNullCheckOf(ExpressionSyntax condition, ISymbol symbol)
        {
            condition = StripParentheses(condition);
            switch (condition)
            {
                case BinaryExpressionSyntax binary when binary.IsKind(SyntaxKind.EqualsExpression):
                    return (IsNullLiteral(binary.Right) && this.IsSafeGuardOperand(binary.Left, symbol))
                        || (IsNullLiteral(binary.Left) && this.IsSafeGuardOperand(binary.Right, symbol));

                case IsPatternExpressionSyntax isPattern
                    when this.IsSafeGuardOperand(isPattern.Expression, symbol):
                    return IsNullConstantPattern(isPattern.Pattern)
                        && isPattern.Pattern is not UnaryPatternSyntax;

                default:
                    return false;
            }
        }

        private bool IsSafeGuardOperand(ExpressionSyntax expression, ISymbol symbol) =>
            IsUnqualifiedOrThisQualifiedFieldAccess(expression)
            && this.BindsToGuardSymbol(expression, symbol);

        private static bool IsUnqualifiedOrThisQualifiedFieldAccess(ExpressionSyntax expression)
        {
            expression = StripParentheses(expression);
            return expression is IdentifierNameSyntax
                || (expression is MemberAccessExpressionSyntax member
                    && member.Expression is ThisExpressionSyntax);
        }

        // Collects, from `region` (a statement following the guard in the
        // same block), every read of `symbol` this rewrite may safely
        // redirect to the captured local: a bare or `this.`-qualified
        // occurrence (never a different instance's same-named field/
        // property — see IsSafeNullCheckOf's remarks) that is not itself a
        // write, a `nameof` argument, written between the guard and this use
        // (SymbolIsWrittenBetween), or reached through a loop-carried write
        // (HasLoopCarriedWrite) — reusing both exactly as
        // <see cref="IsGSharpFlowNarrowedLocal"/> already does for a bare
        // local/parameter.
        private void CollectEligibleGuardCaptureUses(
            SyntaxNode region,
            ISymbol symbol,
            IfStatementSyntax guard,
            SyntaxNode scope,
            List<ExpressionSyntax> eligible)
        {
            foreach (SyntaxNode node in region.DescendantNodesAndSelf(descend =>
                descend is not (LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax)))
            {
                ExpressionSyntax candidate = node switch
                {
                    MemberAccessExpressionSyntax memberAccess
                        when memberAccess.Expression is ThisExpressionSyntax =>
                        memberAccess,
                    IdentifierNameSyntax identifier
                        when identifier.Parent is not MemberAccessExpressionSyntax parentAccess
                            || parentAccess.Name != identifier =>
                        identifier,
                    _ => null,
                };

                if (candidate == null
                    || !this.BindsToGuardSymbol(candidate, symbol)
                    || IsGuardCaptureWritePosition(candidate)
                    || IsNameofArgument(candidate)
                    || this.SymbolIsWrittenBetween(symbol, guard, candidate, scope)
                    || this.HasLoopCarriedWrite(candidate, symbol, scope, guard))
                {
                    continue;
                }

                eligible.Add(candidate);
            }
        }

        // The receiver-agnostic generalization of <see cref="IsDirectWrite"/>
        // (which only accepts a bare IdentifierNameSyntax): a write through
        // either a bare read or a `this.`-qualified member access must never
        // be redirected to a stale captured copy.
        private static bool IsGuardCaptureWritePosition(ExpressionSyntax candidate) =>
            candidate.Parent switch
            {
                AssignmentExpressionSyntax assignment when assignment.Left == candidate => true,
                PrefixUnaryExpressionSyntax prefix
                    when prefix.Operand == candidate
                        && (prefix.IsKind(SyntaxKind.PreIncrementExpression)
                            || prefix.IsKind(SyntaxKind.PreDecrementExpression)) => true,
                PostfixUnaryExpressionSyntax postfix
                    when postfix.Operand == candidate
                        && (postfix.IsKind(SyntaxKind.PostIncrementExpression)
                            || postfix.IsKind(SyntaxKind.PostDecrementExpression)) => true,
                ArgumentSyntax argument
                    when argument.Expression == candidate
                        && (argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword)
                            || argument.RefKindKeyword.IsKind(SyntaxKind.OutKeyword)) => true,
                _ => false,
            };

        private static bool IsNameofArgument(ExpressionSyntax candidate) =>
            candidate.Parent is ArgumentSyntax argument
            && argument.Parent is ArgumentListSyntax { Parent: InvocationExpressionSyntax invocation }
            && invocation.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" };
    }
}
