// <copyright file="CSharpToGSharpTranslator.IfLet.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// ADR-0151: rewrites a C# conditional whose condition is a bare
        /// non-null declaration pattern — `receiver is { } name`,
        /// optionally `&&`-joined with further predicates — into
        /// the canonical G# value-position `if let`:
        /// ```
        /// receiver is { } name && predicate ? whenTrue : whenFalse
        /// =>  if let name = receiver && predicate { whenTrue } else { whenFalse }
        /// ```
        /// The general lowering has to spill `receiver` into a
        /// `let __spillN` (the pattern reads the scrutinee more than once,
        /// issue #1731) and re-assert non-nullness at every binder reference,
        /// which both litters the output and forces an expression-bodied member
        /// to become a block-bodied accessor. The `if let` form evaluates
        /// the receiver exactly once by construction and binds the name at its
        /// non-null type, so neither is needed.
        /// @param conditional The C# conditional expression.
        /// @param result The translated `if let` expression when the rewrite applies.
        /// @returns `true` when the rewrite applied; otherwise `false` and nothing was translated.
        private func TryTranslateIfLetConditional(
            conditional ConditionalExpressionSyntax,
            out result GExpression?
        ) bool {
            result = nil
            // Eligibility is decided ENTIRELY before anything is translated:
            // a mid-way bail-out would leave a half-emitted spill prologue and
            // duplicated diagnostics behind.
            DecomposeConjunction(conditional.Condition, out var leftmost, out var guards)
            if leftmost is not IsPatternExpressionSyntax isPattern {
                return false
            }
            var designation SingleVariableDesignationSyntax?
            var residualPattern RecursivePatternSyntax?
            var asTarget GTypeReference? = nil
            if !TryExtractSingleTopLevelIfLetPattern(
                isPattern.Pattern,
                out var typeSyntax,
                out designation,
                out residualPattern
            ) {
                return false
            }
            let bareNonNullPattern = typeSyntax == nil
            if !bareNonNullPattern && IsTrivialPatternReceiver(isPattern.Expression) {
                return false
            }
            // Issue #4173 round 3: a shared-node analyzer type has no room for
            // its IsNullConditional discriminator (or, for CAE, is not even a
            // castable G# type at all) in this rewrite's plain `receiver as T`
            // — decline here (falling back to the general lowering, which
            // routes through the fixed TranslatePatternTest/TranslateNotPatternTest
            // leaves) rather than reach MapTypeSyntax directly and reintroduce
            // the over-match bug this round fixes.
            if !bareNonNullPattern &&
                (
                this.IsPlainAccessAnalyzerType(typeSyntax, out _) || this.IsConditionalAccessAnalyzerType(typeSyntax)
            ) {
                return false
            }
            if !bareNonNullPattern {
                let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(typeSyntax).Type
                if targetSymbol == nil || targetSymbol.TypeKind == TypeKind.Error || targetSymbol.IsRefLikeType {
                    return false
                }
                asTarget = this.MapTypeSyntax(typeSyntax)
                if targetSymbol.IsValueType {
                    asTarget = MakeNullable(asTarget)
                } else if !targetSymbol.IsReferenceType {
                    return false
                }
            }
            if this.context.GetDeclaredSymbol(designation) is not{} binder {
                return false
            }
            // G# `let` is immutable: a C# binder that is written to anywhere in
            // scope cannot become one.
            if this.IsSymbolReassigned(binder, this.state.CurrentBodyScope ?? conditional) {
                return false
            }
            let directBinding = bareNonNullPattern && !this.IsNullableIfLetReceiver(isPattern.Expression)
            // A guard/true-arm construct that hoists a spill `let` keeps the
            // conservative fallback: the true arm can depend on the if-let
            // binding, and existing spill rewrites are not binding-aware. A
            // false-arm assignment owned by THIS conditional likewise falls
            // back so the general if-expression lowering can host its write
            // inside that arm. Assignments owned by a nested conditional arm
            // are left to the nested conditional's own seam.
            if guards.Any(ContainsSpillHoistingConstruct) ||
                ContainsSpillHoistingConstruct(conditional.WhenTrue) ||
                ContainsAssignmentNeedingBranchSeam(conditional.WhenFalse) {
                return false
            }
            let name string? = this.EmittedName(designation, designation!!.Identifier)
            var residualGuard GExpression? = nil
            if residualPattern != nil && !this.TryTranslateIfLetResidualPattern(
                residualPattern,
                name,
                out residualGuard
            ) {
                return false
            }
            let receiver GExpression? = this.TranslateExpression(isPattern.Expression)
            let initializer GExpression? = if asTarget == nil {
                receiver
            } else {
                cast[GExpression](BinaryExpression(receiver, "as", TypeExpression(asTarget)))
            }
            // While the guard and the true arm are translated, every reference
            // to the C# pattern local reads as the bare G# binding — no `!!`,
            // no `as` narrowing cast, no spill temp.
            let hadPrevious = this.state.PatternBindings.TryGetValue(binder, out var previous)
            this.state.PatternBindings[binder] = IdentifierExpression(name)
            var guard_ GExpression? = residualGuard
            var whenTrue GExpression?
            try {
                if residualPattern == nil && directBinding {
                    guard_ = BinaryExpression(IdentifierExpression(name), "!=", LiteralExpression.Null())
                }
                for conjunct in guards {
                    let translated GExpression? = this.TranslateExpression(conjunct)
                    guard_ = if guard_ == nil {
                        translated
                    } else {
                        cast[GExpression](BinaryExpression(guard_, "&&", translated))
                    }
                }
                whenTrue = this.TranslateValueWithNullForgiveness(conditional.WhenTrue)
            } finally {
                if hadPrevious {
                    this.state.PatternBindings[binder] = previous
                } else {
                    this.state.PatternBindings.Remove(binder)
                }
            }
            // The else arm is translated with the binding OUT of scope, matching
            // both C# definite-assignment and G#'s then-only binding scope.
            var whenFalse GExpression? = this.TranslateValueWithNullForgiveness(conditional.WhenFalse)
            whenTrue, whenFalse = this.CoerceConditionalArms(conditional, whenTrue, whenFalse)
            result = if directBinding {
                cast[GExpression](
                    BlockExpression(
                        []GStatement{LocalDeclarationStatement(BindingKind.Let, name, initializer: initializer)},
                        IfExpression(guard_ ?? LiteralExpression.Bool(true), whenTrue, whenFalse)
                    )
                )
            } else {
                cast[GExpression](
                    IfLetExpression(List[IfLetBinding]{IfLetBinding(name, initializer)}, guard_, whenTrue, whenFalse)
                )
            }
            return true
        }

        /// Issue #3359: rewrites the STATEMENT form
        /// `if (receiver is { } name [&& predicate]) { … } [else { … }]`
        /// into the canonical G# `if let` statement (ADR-0071):
        /// ```
        /// if let name = receiver [&& predicate] { … } [else { … }]
        /// ```
        /// The statement-position counterpart of ADR-0151's
        /// (cref:TryTranslateIfLetConditional), sharing its eligibility
        /// rules. Without it the general lowering spills `receiver` into a
        /// `let __spillN` (the pattern reads the scrutinee more than once,
        /// issue #1731), which destroys the author's chosen binder name, forces a
        /// `!!` at every read, and wraps the statement in an extra brace
        /// level to scope the temp. Measured at ~44 occurrences per 100k lines in
        /// dotnet/roslyn and ~186 per 100k in this repository (issue #3347).
        /// @param ifStatement The C# `if` statement.
        /// @param result The translated statements when the rewrite applies.
        /// @returns `true` when the rewrite applied.
        private func TryBuildIfLetGuard(ifStatement IfStatementSyntax, out result IReadOnlyList[GStatement]?) bool {
            result = nil
            // Eligibility is decided BEFORE anything is translated: a mid-way
            // bail-out would leave a half-emitted spill prologue behind.
            let clauses = List[ExpressionSyntax]()
            FlattenAndClauses(ifStatement.Condition, clauses)
            var isPattern IsPatternExpressionSyntax? = nil
            var designation SingleVariableDesignationSyntax? = nil
            var residualPattern RecursivePatternSyntax? = nil
            var typeSyntax TypeSyntax? = nil
            var patternIndex = -1
            for var i = 0; i < clauses.Count; i++ {
                if clauses[i] is not IsPatternExpressionSyntax candidatePattern ||
                    !TryExtractSingleTopLevelIfLetPattern(
                    candidatePattern.Pattern,
                    out var candidateType,
                    out var candidateDesignation,
                    out var candidateResidual
                ) {
                    continue
                }
                if patternIndex >= 0 {
                    return false
                }
                patternIndex = i
                isPattern = candidatePattern
                typeSyntax = candidateType
                designation = candidateDesignation
                residualPattern = candidateResidual
            }
            if patternIndex < 0 {
                return false
            }
            let prefix = clauses.Take(patternIndex).ToList()
            let guards = clauses.Skip(patternIndex + 1).ToList()
            var asTarget GTypeReference? = nil
            let bareNonNullPattern = typeSyntax == nil
            // Issue #4173 round 3: see TryTranslateIfLetConditional's
            // identical decline.
            if !bareNonNullPattern &&
                (
                this.IsPlainAccessAnalyzerType(typeSyntax, out _) || this.IsConditionalAccessAnalyzerType(typeSyntax)
            ) {
                return false
            }
            if !bareNonNullPattern {
                let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(typeSyntax).Type
                if targetSymbol == nil || targetSymbol.TypeKind == TypeKind.Error || targetSymbol.IsRefLikeType {
                    return false
                }
                if prefix.Count == 0 &&
                    guards.Count == 0 &&
                    (
                    IsTrivialPatternReceiver(isPattern!!.Expression) ||
                        (residualPattern == nil && !targetSymbol.IsValueType)
                ) {
                    return false
                }
                asTarget = this.MapTypeSyntax(typeSyntax)
                if targetSymbol.IsValueType {
                    asTarget = MakeNullable(asTarget)
                } else if !targetSymbol.IsReferenceType {
                    return false
                }
            }
            if this.context.GetDeclaredSymbol(designation) is not ILocalSymbol binder {
                return false
            }
            // ADR-0071 requires a NULLABLE initializer — the binding exists to
            // strip the nullability. C# allows `s is { } text` on a non-nullable
            // reference too (it is still a runtime null test), but there the
            // translated receiver is `string`, not `string?`, and `if let` is
            // rejected with GS0296. Bind the author's name in a scoped block
            // instead.
            let receiverType GTypeReference? = this.ResolveExpressionType(isPattern!!.Expression)
            let directBinding = bareNonNullPattern && !(receiverType != nil && receiverType.IsNullable == true)
            if !directBinding && this.IsLocalReassigned(binder) {
                return false
            }
            // cs2gs emits no statement-form `if let` guard (N-1: the pinned
            // release predates ADR-0201). Nesting a residual
            // or conjoined guard would require attaching the same C# else branch
            // to both binding failure and guard failure; a leading prefix would
            // add a third copy. Let the general pattern lowering keep one branch.
            if ifStatement.Else != nil &&
                (prefix.Count > 0 || (!directBinding && (residualPattern != nil || guards.Count > 0))) {
                return false
            }
            // A guard that itself hoists a spill would need a statement seam
            // ahead of the `if`, but the spill may read the binding — which is
            // only in scope inside the `if let`. Leave those to the general path.
            if prefix.Concat(guards).Any(
                ($guard ExpressionSyntax) -> ContainsSpillHoistingConstruct($guard, includeOutVarDeclarations: false)
            ) ||
                prefix
                .SelectMany(
                func (clause ExpressionSyntax) IEnumerable[SyntaxNode] {
                    return clause.DescendantNodesAndSelf()
                }
            )
                .OfType[SingleVariableDesignationSyntax]()
                .Any(
                (designationNode SingleVariableDesignationSyntax) -> this.context.GetDeclaredSymbol(
                    designationNode
                ) is ILocalSymbol prefixBinder &&
                    ReadsSymbol(ifStatement.Statement, prefixBinder)
            ) {
                return false
            }
            // `if let` binds only for the then-branch, matching C#'s definite
            // assignment. A binder READ in the else-branch (legal in C# when the
            // then-branch exits) has no `if let` spelling; the negated-guard
            // hoist handles that shape instead.
            if ifStatement.Else != nil && ReadsSymbol(ifStatement.Else, binder) {
                return false
            }
            let name string? = this.EmittedName(designation, designation!!.Identifier)
            var residualGuard GExpression? = nil
            if residualPattern != nil && !this.TryTranslateIfLetResidualPattern(
                residualPattern,
                name,
                out residualGuard
            ) {
                return false
            }
            let receiver GExpression? = this.TranslateExpression(isPattern!!.Expression)
            let initializer GExpression? = if asTarget == nil {
                receiver
            } else {
                cast[GExpression](BinaryExpression(receiver, "as", TypeExpression(asTarget)))
            }
            // Inside the guard and the then-branch every reference to the C#
            // pattern local reads as the bare G# binding — no `!!`, no `as`
            // narrowing cast, no spill temp.
            let hadPrevious = this.state.PatternBindings.TryGetValue(binder, out var previous)
            this.state.PatternBindings[binder] = IdentifierExpression(name)
            var guard_ GExpression? = residualGuard
            var then BlockStatement
            try {
                if residualPattern == nil && directBinding {
                    guard_ = BinaryExpression(IdentifierExpression(name), "!=", LiteralExpression.Null())
                }
                for conjunct in guards {
                    let translated GExpression? = this.TranslateExpression(conjunct)
                    guard_ = if guard_ == nil {
                        translated
                    } else {
                        cast[GExpression](BinaryExpression(guard_, "&&", translated))
                    }
                }
                then = this.TranslateStatementAsBlock(ifStatement.Statement)
            } finally {
                if hadPrevious {
                    this.state.PatternBindings[binder] = previous
                } else {
                    this.state.PatternBindings.Remove(binder)
                }
            }
            // The else branch is translated with the binding OUT of scope.
            var elseBranch GStatement? = nil
            if ifStatement.Else != nil {
                elseBranch = this.TranslateElseStatement(ifStatement.Else!!.Statement)
            }
            let translatedThen = then
            var inner GStatement
            if directBinding {
                inner = BlockStatement(
                    []GStatement{
                        LocalDeclarationStatement(
                            if this.IsLocalReassigned(binder) {
                                BindingKind.Var
                            } else {
                                BindingKind.Let
                            },
                            name,
                            initializer: initializer
                        ),
                        IfStatement(guard_ ?? LiteralExpression.Bool(true), then, elseBranch)
                    }
                )
            } else {
                // cs2gs emits no statement-form `if let` guard (N-1; ADR-0201). Nest the residual
                // test/extra conjuncts inside its binding scope. Reuse the same else
                // branch both when binding fails and when the nested guard fails.
                if guard_ != nil {
                    then = BlockStatement([]GStatement{IfStatement(guard_, then, elseBranch)})
                }
                inner = IfLetStatement(List[IfLetBinding]{IfLetBinding(name, initializer)}, then, elseBranch)
            }
            if prefix.Count == 0 {
                result = []GStatement{inner}
                if elseBranch != nil {
                    this.ReportPatternGuardControlTransferMismatch(
                        ifStatement,
                        result,
                        []GStatement{translatedThen, elseBranch}
                    )
                }
                return true
            }
            var prefixGuard GExpression? = nil
            for clause in prefix {
                let translated GExpression? = this.TranslateExpression(clause)
                prefixGuard = if prefixGuard == nil {
                    translated
                } else {
                    cast[GExpression](BinaryExpression(prefixGuard, "&&", translated))
                }
            }
            result = []GStatement{IfStatement(prefixGuard, BlockStatement([]GStatement{inner}), elseBranch)}
            if elseBranch != nil {
                this.ReportPatternGuardControlTransferMismatch(
                    ifStatement,
                    result,
                    []GStatement{translatedThen, elseBranch}
                )
            }
            return true
        }

        /// Issue #3352: emits C#'s body-scoped positive loop-pattern binding as
        /// native G# `while let` when the condition is exactly a non-null
        /// binding or type-test binding, optionally followed by spill-free
        /// `&&` guards:
        /// ```
        /// while (Next() is string text && text.Length > 0) { body }
        /// // becomes
        /// while let text = Next() as string {
        /// if !(text.Length > 0) { break }
        /// body
        /// }
        /// ```
        /// The native loop owns re-evaluation and continue/break routing, so the
        /// old `let __scrutineeN` body prologue is unnecessary.
        private func TryBuildWhileLetLoop(
            condition ExpressionSyntax,
            bodyStatement StatementSyntax,
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            DecomposeConjunction(condition, out var leftmost, out var guards)
            if leftmost is not IsPatternExpressionSyntax isPattern {
                return false
            }
            var designation SingleVariableDesignationSyntax?
            var residualPattern RecursivePatternSyntax?
            var asTarget GTypeReference? = nil
            if !TryExtractSingleTopLevelIfLetPattern(
                isPattern.Pattern,
                out var typeSyntax,
                out designation,
                out residualPattern
            ) {
                return false
            }
            if residualPattern != nil && IsTrivialPatternReceiver(isPattern.Expression) {
                return false
            }
            if typeSyntax == nil {
                // A direct `while let name = receiver` needs an existing
                // nullable layer to strip. Non-nullable receivers keep the
                // general pattern lowering.
                if !this.IsNullableIfLetReceiver(isPattern.Expression) {
                    return false
                }
            } else {
                // Issue #4173 round 3: see TryTranslateIfLetConditional's
                // identical decline.
                if this.IsPlainAccessAnalyzerType(typeSyntax, out _) || this.IsConditionalAccessAnalyzerType(
                    typeSyntax
                ) {
                    return false
                }
                let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(typeSyntax).Type
                if targetSymbol == nil || targetSymbol.TypeKind == TypeKind.Error || targetSymbol.IsRefLikeType {
                    return false
                }
                asTarget = this.MapTypeSyntax(typeSyntax)
                if targetSymbol.IsValueType {
                    // `as` requires a nullable value-type target; `while let`
                    // then strips that nullable layer back to the C# binder's T.
                    asTarget = MakeNullable(asTarget)
                } else if !targetSymbol.IsReferenceType {
                    // An unconstrained type parameter cannot be the target of
                    // G#'s testing conversion.
                    return false
                }
            }
            if this.context.GetDeclaredSymbol(designation) is not ILocalSymbol binder || this.IsLocalReassigned(
                binder
            ) ||
                guards.Any(ContainsSpillHoistingConstruct) || ContainsSpillHoistingConstruct(isPattern.Expression) {
                return false
            }
            let name string? = this.EmittedName(designation, designation!!.Identifier)
            var residualGuard GExpression? = nil
            if residualPattern != nil && !this.TryTranslateIfLetResidualPattern(
                residualPattern,
                name,
                out residualGuard
            ) {
                return false
            }
            let receiver GExpression? = this.TranslateExpression(isPattern.Expression)
            let initializer GExpression? = if asTarget == nil {
                receiver
            } else {
                cast[GExpression](BinaryExpression(receiver, "as", TypeExpression(asTarget)))
            }
            let hadPrevious = this.state.PatternBindings.TryGetValue(binder, out var previous)
            this.state.PatternBindings[binder] = IdentifierExpression(name)
            var body BlockStatement
            try {
                var guard_ GExpression? = residualGuard
                for conjunct in guards {
                    let translated GExpression? = this.TranslateExpression(conjunct)
                    guard_ = if guard_ == nil {
                        translated
                    } else {
                        cast[GExpression](BinaryExpression(guard_, "&&", translated))
                    }
                }
                body = this.TranslateStatementAsBlock(bodyStatement)
                if guard_ != nil {
                    let statements = List[GStatement]{BreakIf(Negate(guard_))}
                    statements.AddRange(body.Statements)
                    body = BlockStatement(statements)
                }
            } finally {
                if hadPrevious {
                    this.state.PatternBindings[binder] = previous
                } else {
                    this.state.PatternBindings.Remove(binder)
                }
            }
            result = []GStatement{WhileLetStatement(List[IfLetBinding]{IfLetBinding(name, initializer)}, body)}
            return true
        }

        private func TryTranslateIfLetBooleanExpression(expression ExpressionSyntax, out result GExpression?) bool {
            result = nil
            DecomposeConjunction(expression, out var leftmost, out var guards)
            if leftmost is not IsPatternExpressionSyntax isPattern ||
                !TryExtractSingleTopLevelIfLetPattern(
                isPattern.Pattern,
                out var typeSyntax,
                out var designation,
                out var residualPattern
            ) ||
                this
                .context
                .GetDeclaredSymbol(designation) is not ILocalSymbol binder || this.IsLocalReassigned(binder) ||
                IsTrivialPatternReceiver(isPattern.Expression) ||
                guards.Any(ContainsSpillHoistingConstruct) {
                return false
            }
            var asTarget GTypeReference? = nil
            var directBinding = false
            if typeSyntax == nil {
                if !this.IsNullableIfLetReceiver(isPattern.Expression) {
                    directBinding = true
                }
            } else {
                // Issue #4173 round 3: see TryTranslateIfLetConditional's
                // identical decline.
                if this.IsPlainAccessAnalyzerType(typeSyntax, out _) || this.IsConditionalAccessAnalyzerType(
                    typeSyntax
                ) {
                    return false
                }
                let targetSymbol ITypeSymbol? = this.context.GetTypeInfo(typeSyntax).Type
                if targetSymbol == nil || targetSymbol.TypeKind == TypeKind.Error || targetSymbol.IsRefLikeType {
                    return false
                }
                asTarget = this.MapTypeSyntax(typeSyntax)
                if targetSymbol.IsValueType {
                    asTarget = MakeNullable(asTarget)
                } else if !targetSymbol.IsReferenceType {
                    return false
                }
            }
            let name string? = this.EmittedName(designation, designation!!.Identifier)
            var residualGuard GExpression? = nil
            if residualPattern != nil && !this.TryTranslateIfLetResidualPattern(
                residualPattern,
                name,
                out residualGuard
            ) {
                return false
            }
            let receiver GExpression? = this.TranslateExpression(isPattern.Expression)
            let initializer GExpression? = if asTarget == nil {
                receiver
            } else {
                cast[GExpression](BinaryExpression(receiver, "as", TypeExpression(asTarget)))
            }
            let hadPrevious = this.state.PatternBindings.TryGetValue(binder, out var previous)
            this.state.PatternBindings[binder] = IdentifierExpression(name)
            var guard_ GExpression? = residualGuard
            try {
                if residualPattern == nil && directBinding {
                    guard_ = BinaryExpression(IdentifierExpression(name), "!=", LiteralExpression.Null())
                }
                for conjunct in guards {
                    let translated GExpression? = this.TranslateExpression(conjunct)
                    guard_ = if guard_ == nil {
                        translated
                    } else {
                        cast[GExpression](BinaryExpression(guard_, "&&", translated))
                    }
                }
            } finally {
                if hadPrevious {
                    this.state.PatternBindings[binder] = previous
                } else {
                    this.state.PatternBindings.Remove(binder)
                }
            }
            result = if directBinding {
                cast[GExpression](
                    BlockExpression(
                        []GStatement{LocalDeclarationStatement(BindingKind.Let, name, initializer: initializer)},
                        guard_ ?? LiteralExpression.Bool(true)
                    )
                )
            } else {
                cast[GExpression](
                    IfLetExpression(
                        List[IfLetBinding]{IfLetBinding(name, initializer)},
                        guard_,
                        LiteralExpression.Bool(true),
                        LiteralExpression.Bool(false)
                    )
                )
            }
            return true
        }

        // True when `node` reads `symbol` anywhere. Used to keep an `if let` from
        // swallowing a shape whose ELSE branch reads the pattern binder — legal in
        // C# when the then-branch exits, but out of scope for a G# `if let`.
        private func ReadsSymbol(node SyntaxNode?, symbol ILocalSymbol) bool {
            for identifier in node!!.DescendantNodesAndSelf().OfType[IdentifierNameSyntax]() {
                if SymbolEqualityComparer.Default.Equals(this.context.GetSymbolInfo(identifier).Symbol, symbol) {
                    return true
                }
            }
            return false
        }

        private func TryTranslateIfLetResidualPattern(
            pattern RecursivePatternSyntax?,
            bindingName string?,
            out result GExpression?
        ) bool {
            result = nil
            let bindings = List[(Symbol ISymbol, Replacement GExpression)]()
            let guards = List[GExpression]()
            let outerBooleanPattern = this.state.TranslatingBooleanPattern
            this.state.TranslatingBooleanPattern = true
            var translated GPattern?
            try {
                translated = this.TranslateRecursivePattern(
                    pattern,
                    IdentifierExpression(bindingName),
                    bindings,
                    HashSet[string](StringComparer.Ordinal),
                    guards,
                    treatAsUntyped: true
                )
            } finally {
                this.state.TranslatingBooleanPattern = outerBooleanPattern
            }
            if translated == nil || bindings.Count != 0 || guards.Count != 0 {
                return false
            }
            result = PatternTestExpression(IdentifierExpression(bindingName), translated)
            return true
        }

        /// True when the pattern scrutinee lands in G# as a nullable type, so
        /// a synthesized `if let` or `while let` initializer has a
        /// nullable layer to strip (gsc GS0296 otherwise). Covers both an
        /// annotated / taint-promoted reference type and a
        /// `Nullable<T>` value type.
        private func IsNullableIfLetReceiver(receiver ExpressionSyntax) bool {
            let type ITypeSymbol? = this.context.GetTypeInfo(receiver).Type
            if type is INamedTypeSymbol namedType &&
                namedType
                .OriginalDefinition
                .SpecialType == SpecialType.System_Nullable_T {
                return true
            }
            return type != nil && type.IsReferenceType == true && this.IsNullablePromotedValue(receiver)
        }

        shared {
            private func ContainsAssignmentNeedingBranchSeam(branch ExpressionSyntax) bool {
                return branch
                    .DescendantNodesAndSelf(
                    descendIntoChildren: (node SyntaxNode) -> !(
                        (node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax)
                    )
                )
                    .OfType[AssignmentExpressionSyntax]()
                    .Where(
                    (
                        assignment AssignmentExpressionSyntax
                    ) -> assignment.Parent is not InitializerExpressionSyntax initializer ||
                        (
                        !initializer.IsKind(SyntaxKind.ObjectInitializerExpression) && !initializer.IsKind(
                            SyntaxKind.WithInitializerExpression
                        )
                    )
                )
                    .Any(
                    (assignment AssignmentExpressionSyntax) -> AssignmentRequiresStatementLowering(assignment) &&
                        !IsInsideConditionalValueBranch(assignment, branch)
                )
            }

            /// Splits a left-associative `&&` chain into its leftmost
            /// leaf and the remaining conjuncts in source order. A condition that is
            /// not a conjunction yields itself and an empty list.
            private func DecomposeConjunction(
                condition ExpressionSyntax,
                out leftmost ExpressionSyntax?,
                out conjuncts List[ExpressionSyntax]
            ) {
                conjuncts = List[ExpressionSyntax]()
                var current ExpressionSyntax? = Unparenthesize(condition)
                while current is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.LogicalAndExpression) {
                    conjuncts.Insert(0, binary.Right)
                    current = Unparenthesize(binary.Left)
                }
                leftmost = current
            }

            private func Unparenthesize(expression ExpressionSyntax?) ExpressionSyntax? {
                var expression = expression
                while expression is ParenthesizedExpressionSyntax parenthesized {
                    expression = parenthesized.Expression
                }
                return expression
            }

            private func IsTrivialPatternReceiver(expression ExpressionSyntax) bool -> (
                Unparenthesize(expression) is IdentifierNameSyntax or ThisExpressionSyntax or LiteralExpressionSyntax
            )

            private func TryExtractSingleTopLevelIfLetPattern(
                pattern PatternSyntax,
                out typeSyntax TypeSyntax?,
                out designation SingleVariableDesignationSyntax?,
                out residualPattern RecursivePatternSyntax?
            ) bool {
                typeSyntax = nil
                designation = nil
                residualPattern = nil
                if pattern.DescendantNodesAndSelf().OfType[SingleVariableDesignationSyntax]().Count() != 1 {
                    return false
                }
                switch pattern {
                    case declaration is DeclarationPatternSyntax when declaration.Designation is SingleVariableDesignationSyntax single {
                        typeSyntax = declaration.Type
                        designation = single
                        return true
                    }
                    case recursive is RecursivePatternSyntax when recursive.Designation is SingleVariableDesignationSyntax single {
                        typeSyntax = recursive.Type
                        designation = single
                        if recursive.PositionalPatternClause != nil ||
                            recursive.PropertyPatternClause is {Subpatterns: {Count: > 0}} {
                            residualPattern = recursive
                        }
                        return true
                    }
                    default {
                        return false
                    }
                }
            }

            /// True when translating [`node`](paramref) can hoist a spill
            /// `let` into the active statement seam (issue #1731 machinery) or
            /// hoist a write/mutation out of the expression. Such a hoist must not
            /// escape an `if let` / `while let` binding scope, so those
            /// rewrites bail out and keep their spill-based fallback instead.
            /// Anonymous-function bodies are skipped: they open their own seam and
            /// can never leak into this one.
            private func ContainsSpillHoistingConstruct(node SyntaxNode) bool -> ContainsSpillHoistingConstruct(
                node,
                includeOutVarDeclarations: true
            )

            private func ContainsSpillHoistingConstruct(node SyntaxNode, includeOutVarDeclarations bool) bool {
                for descendant in node.DescendantNodesAndSelf(
                    descendIntoChildren: (n SyntaxNode) -> !(n is AnonymousFunctionExpressionSyntax) || n == node
                ) {
                    switch descendant {
                        case isPattern is IsPatternExpressionSyntax when PatternIntroducesBinding(isPattern.Pattern) {
                            return true
                        }
                        case assignment is AssignmentExpressionSyntax when AssignmentRequiresStatementLowering(
                            assignment
                        ) {
                            return true
                        }
                        case _ is DeclarationExpressionSyntax when includeOutVarDeclarations {
                            return true
                        }
                        case SwitchExpressionSyntax {
                            return true
                        }
                        case prefix is PrefixUnaryExpressionSyntax when prefix.IsKind(
                            SyntaxKind.PreIncrementExpression
                        ) ||
                            prefix.IsKind(SyntaxKind.PreDecrementExpression) {
                            return true
                        }
                        case postfix is PostfixUnaryExpressionSyntax when postfix.IsKind(
                            SyntaxKind.PostIncrementExpression
                        ) ||
                            postfix.IsKind(SyntaxKind.PostDecrementExpression) {
                            return true
                        }
                    }
                }
                return false
            }
        }
    }
}
