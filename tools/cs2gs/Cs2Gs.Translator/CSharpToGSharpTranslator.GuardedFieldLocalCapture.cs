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
        /// follows it in the SAME block (or switch section — see
        /// <see cref="AddFollowingStatements"/>). Today every later
        /// dereference of <c>F</c> in that region gets its OWN <c>!!</c> (gsc,
        /// by design, never smart-casts a field/property — see those
        /// methods' doc comments). This is faithful but noisy: a real-corpus
        /// measurement found 220 (28%) of 787 <c>!!</c> sites are exactly
        /// this shape.
        /// <para>
        /// Instead, capture the field into a local — named by lowercasing
        /// the field/property's OWN first letter (<c>AccessToken</c> →
        /// <c>accessToken</c>; an already-lowercase field like
        /// <c>viewModel</c> is used as-is) — right after the guard, and
        /// rewrite the guard-dominated later reads to use that local. gsc
        /// DOES smart-cast a bare local, so no further narrowing/assertion is
        /// needed at its own use sites, collapsing N `!!` sites into the
        /// single one at the capture. This repo deliberately treats
        /// synthetic <c>__identifier</c>s as a cost to avoid (issue #3501's
        /// readability counters target zero of them), so this rewrite never
        /// invents one: if the derived name collides with anything else
        /// visible unqualified at the capture point (see
        /// <see cref="TryDeriveCaptureLocalName"/>), it skips the rewrite for
        /// that guard/field pair entirely — no suffixed fallback name is
        /// ever synthesized. <see cref="IsNullGuardNarrowedFieldUse"/>'s
        /// per-use <c>!!</c> insertion remains the FALLBACK for any read this
        /// rewrite does not safely reach (a name collision, written-between,
        /// loop-carried, a different receiver instance, a goto that can skip
        /// the capture declaration, an unstable/mutable/computed member, or
        /// outside this block) — this pass only ever REMOVES `!!` sites it
        /// can prove safe to remove, never regressing the existing coverage.
        /// </para>
        /// </summary>
        private void EmitGuardedFieldLocalCaptures(
            IfStatementSyntax ifStatement,
            Dictionary<ISymbol, IfStatementSyntax> activeCaptures,
            HashSet<string> capturedNamesInScope,
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

                if (!this.TryDeriveCaptureLocalName(symbol, ifStatement, capturedNamesInScope, out string capturedName))
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
                capturedNamesInScope.Add(capturedName);
            }
        }

        // Requirement from the repo owner (issue #3501's synthetic-identifier
        // reduction target): this rewrite must NEVER introduce a synthetic
        // `__guardN`-style name. The captured local's name is instead DERIVED
        // from the field/property's own name by lowercasing only its first
        // letter (C#'s conventional PascalCase-field → camelCase-local
        // rule): `AccessToken` → `accessToken`; a field already spelled
        // lowercase, like `viewModel`, is used as-is (its own name IS the
        // derived name, so it is explicitly exempted from colliding with
        // itself below). If that derived name collides with ANYTHING else
        // visible unqualified at the exact point the capture would be
        // inserted — another local already in scope, a parameter, a sibling
        // type member, or a G# reserved word — this method does NOT invent a
        // suffixed alternative (`accessToken2`): it returns <see
        // langword="false"/> and the caller skips the rewrite for this
        // guard/field pair entirely, leaving the existing per-use `!!`
        // fallback in place exactly as if the guard had not been recognized.
        // <paramref name="capturedNamesInScope"/> also guards against two
        // DIFFERENT captures within the same enclosing block deriving the
        // identical name (e.g. sibling guards on fields `Token` and `token`)
        // — a case Roslyn's own symbol table cannot see, since neither
        // capture exists in the original C# source.
        private bool TryDeriveCaptureLocalName(
            ISymbol symbol,
            IfStatementSyntax insertionPoint,
            HashSet<string> capturedNamesInScope,
            out string name)
        {
            name = null;
            string candidate = LowercaseFirstLetter(symbol.Name);
            if (string.IsNullOrEmpty(candidate))
            {
                return false;
            }

            if (GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts.IsReservedIdentifier(
                    candidate,
                    GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext.Local)
                || capturedNamesInScope.Contains(candidate))
            {
                return false;
            }

            // Every symbol visible UNQUALIFIED under this exact spelling at
            // the point the `let` would be inserted — parameters, locals
            // already declared earlier in an enclosing block, and unqualified
            // type members (including inherited ones) — must be either
            // nonexistent or be `symbol` itself (the very field/property
            // being captured always resolves under its own name; that is
            // not a real collision, it is the intended shadow).
            foreach (ISymbol visible in this.context.SemanticModel.LookupSymbols(
                insertionPoint.Span.End,
                name: candidate))
            {
                if (!SymbolEqualityComparer.Default.Equals(visible, symbol))
                {
                    return false;
                }
            }

            name = candidate;
            return true;
        }

        private static string LowercaseFirstLetter(string name) =>
            string.IsNullOrEmpty(name) || char.IsLower(name[0])
                ? name
                : char.ToLowerInvariant(name[0]) + name.Substring(1);

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
        // property G# emits `T?` (see TryGetEmittedNullableFieldOrPropertySymbol).
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

        // A narrower, LOCAL variant of <see cref="StatementAlwaysExits"/>
        // that excludes `GotoStatementSyntax`. `StatementAlwaysExits` treats
        // `goto` as "always exits" because that is correct for that helper's
        // own callers (a `goto` never falls through the guard STATEMENT
        // itself). But THIS rewrite's "always exits" question is different:
        // it asks whether the guard body can ever reach the "later
        // statements" region the capture is inserted into via a path that
        // skipped the capture. A `goto` inside the guard body can jump
        // FORWARD to an arbitrary LABEL that happens to lie among those very
        // later statements (`AddFollowingStatements`) — landing there
        // without ever executing the capture's `let`, reading an unassigned
        // local. `return`/`throw` never resume the enclosing method body at
        // all, so they stay safe; `break`/`continue` are ALSO safe here —
        // unlike an arbitrary `goto` label, their target (the loop's
        // next-iteration test, or the statement right after the whole
        // loop/switch) can never coincide with a statement
        // `AddFollowingStatements` returns, because that helper only walks
        // the SAME immediately-enclosing block/switch-section as the `if`,
        // and a `break`/`continue` target always lies strictly outside it.
        // Scoped to this file's own use only — `StatementAlwaysExits` and
        // its other callers (control-flow lowering, native pattern-variable
        // regions) are unchanged.
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
        // Copilot review fix (PR #4280): a candidate must be a genuinely
        // STABLE access path member — reusing <see cref="IsStableMemberSymbol"/>,
        // the exact same predicate item 1's fix (#4277) introduced to decide
        // when gsc itself narrows a member path (mirroring gsc's own
        // `SmartCastStability` in `src/Core/CodeAnalysis/Binding`): a
        // `readonly` instance field, or a non-virtual/non-override/
        // non-abstract auto-implemented property with no setter or an
        // init-only one. `SymbolIsWrittenBetween` only ever sees DIRECT
        // syntactic writes in the same method body — it cannot see that an
        // intervening call (`ResetF(); F.ToUpper();`) might reassign the
        // member internally, or that a virtual/overridable getter could
        // dispatch to an override with a computed body. A genuinely stable
        // member structurally CANNOT be reassigned by any call after
        // construction (no setter, no override dispatch) and CANNOT be a
        // computed getter (auto-implemented only), which closes both holes
        // at once — not just the "evaluate once" noise-reduction concern the
        // auto-property check alone addressed.
        private bool TryGetEmittedNullableFieldOrPropertySymbol(ISymbol symbol)
        {
            if (!IsStableMemberSymbol(symbol))
            {
                return false;
            }

            ITypeSymbol declared = symbol switch
            {
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            return declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.ShouldPromoteToNullableReference(symbol);
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
        // (SymbolIsWrittenBetween — a belt-and-suspenders check; the real
        // protection against indirect/aliased mutation is that
        // TryGetEmittedNullableFieldOrPropertySymbol already restricts every
        // candidate to a genuinely stable member no call can reassign), or
        // reached through a loop-carried write (HasLoopCarriedWrite) —
        // reusing both exactly as <see cref="IsGSharpFlowNarrowedLocal"/>
        // already does for a bare local/parameter.
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
