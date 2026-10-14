// <copyright file="BaseClassCycleUnsafeWalkAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Immutable

/// GSA0006 (issues #4162, #4164): flags a loop that walks
/// `StructSymbol.BaseClass` by hand instead of through the guarded
/// `StructSymbol.GetHierarchy()` helper.
/// @remarks A genuine base-class cycle (`class B : C` / `class C : B`) is
/// normally rejected by the post-bind cycle detector (issue #973), but
/// declaration binding walks a struct's `BaseClass` chain in several
/// places BEFORE that detector runs once at the end for every struct in the
/// compilation. #4162 fixed the first discovered instance
/// (`StructSymbol.GetHierarchy()` itself); auditing every other
/// `.BaseClass` walk for #4164 found five more independent, unguarded
/// copies of the identical loop shape, two of which reproduced the exact
/// same unbounded-memory-growth failure #4162 first found. Six independent
/// recurrences of one bug class is a signal that hand-auditing after each
/// new hang/OOM report does not scale — this rule makes a seventh
/// recurrence a build warning instead of a runtime defect.
///
/// The rule: any assignment of the shape `x = x.BaseClass`, where
/// `x` is a local/parameter identifier, occurring anywhere inside a
/// `for`/`while`/`do` loop is exactly the "advance one step
/// up the hierarchy" operation — the only legitimate reason to repeatedly
/// reassign a variable to its own `BaseClass` is to walk the chain, and
/// an unguarded walk of a cyclic chain never terminates. A single,
/// non-repeating fetch into a NEW variable name (e.g. `var parent =
/// current.BaseClass;`, used throughout the binder for immediate-base-class
/// checks) is not flagged — only self-reassignment inside a loop is the
/// unsafe shape.
///
/// (cref:IsInsideExemptMethod) exempts `StructSymbol.GetHierarchy()`
/// itself (the one sanctioned implementation every other walk should call
/// instead of re-deriving its own guard) and
/// `DeclarationBinder.DetectClassInheritanceCycles()` (the cycle
/// detector itself — it cannot be rewritten to call
/// `GetHierarchy()` because it needs the exact back-edge node to
/// break, not just the acyclic prefix a hierarchy walk would silently stop
/// at).
///
/// Deliberately out of scope: a RECURSIVE walk (a method calling itself
/// with `x.BaseClass` as an argument) is a different syntactic shape
/// this rule does not detect — none of the sites found so far were
/// recursive, so this is not yet a proven gap, but it is a known one.
/// A null-conditional reassignment (`x = x?.BaseClass`) is also not
/// detected: this file self-migrates as part of the cs2gs-pr-guard hot-core
/// set (issue #4172), and `ConditionalAccessExpressionSyntax` /
/// `MemberBindingExpressionSyntax` have no G# analyzer-API mapping
/// (ADR-0169) — see issue #4173. Not a proven gap either: across every real
/// `.BaseClass`-walk site found and fixed (#4162, #4164, #4172), the
/// one null-conditional access encountered (`derived?.BaseClass` in
/// `DeclarationBinder.Functions.cs`, fixed by #4164) was in a loop
/// INITIALIZER, a position this rule never inspects — never in the
/// reassignment position this rule targets.
///
/// ENABLED BY DEFAULT (`isEnabledByDefault: true` on
/// (cref:DiagnosticDescriptors.UnguardedBaseClassWalk)): a real-tree
/// run against `src/Core` initially found 47 further hand-rolled
/// `.BaseClass` walks beyond the six this rule was written to catch.
/// Two of those 47 were not migration candidates at all: one was
/// `DeclarationBinder.DetectClassInheritanceCycles()` itself, already
/// exempted above — safe because of its own independent back-edge guard
/// (`onPath`/`acyclic` sets), not because of binding-phase
/// ordering — and one, `StructSymbol.TryGetInheritedMethod`, was
/// confirmed dead code (zero callers) and deleted outright. The remaining
/// sites were all safe only because of binding-phase ordering (they ran
/// after the cycle detector, or after emit-time diagnostics had already
/// rejected a cyclic program) — not a structural guarantee a future edit
/// couldn't break. Issue #4172 migrated every one of those onto
/// `GetHierarchy()`, so this repository's
/// `TreatWarningsAsErrors=true` build now enforces the rule for real:
/// any new unguarded walk is a build break, not a runtime hang waiting to
/// be reported.
@GSharpDiagnosticAnalyzer
class BaseClassCycleUnsafeWalkAnalyzer : GSharpDiagnosticAnalyzer {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _supportedDiagnostics ImmutableArray[DiagnosticDescriptor] = ImmutableArray.Create(
        DiagnosticDescriptors.UnguardedBaseClassWalk
    )

    override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> _supportedDiagnostics

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Initialize(context AnalysisContext) {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None)
        context.EnableConcurrentExecution()
        context.RegisterSyntaxNodeAction(AnalyzeAssignment, SyntaxKind.AssignmentExpression)
    }

    shared {
        private const StructSymbolTypeName string = "StructSymbol"
        private const BaseClassPropertyName string = "BaseClass"
        private const ExemptMethodName string = "GetHierarchy"
        private const ExemptDetectorMethodName string = "DetectClassInheritanceCycles"
        private const ExemptDetectorTypeName string = "DeclarationBinder"

        private func AnalyzeAssignment(context SyntaxNodeAnalysisContext) {
            let assignment = cast[AssignmentExpressionSyntax](context.Node)
            // Issue #4173: gets the assignment target WITHOUT ever naming
            // `.Left` — it has no G# counterpart at all (G#'s
            // AssignmentExpressionSyntax targets a plain IdentifierToken, never
            // an arbitrary expression), and cs2gs's analyzer-API mode
            // unconditionally folds any COMPARISON against a no-G#-counterpart
            // member to a fixed constant regardless of what actually matches at
            // the call site — an earlier version of this method learned that the
            // hard way (`assignment.Left != leftIdentifier` compiled but always
            // evaluated true once translated, making this whole rule a silent
            // no-op in its migrated form). `GetFirstToken()`/`.Parent`, unlike
            // `.Left`, are ordinary SyntaxNode members with no such folding.
            //
            // `GetFirstToken()` returns the assignment's very first token
            // regardless of shape. For `x = y` that token IS `x`; walking up from
            // it, `x`'s immediate parent is the wrapping `IdentifierNameSyntax`,
            // and THAT node's parent is the assignment itself (two hops). For
            // `obj.Field = y` or `arr[i] = y`, the same walk needs a third hop
            // (through a MemberAccessExpressionSyntax/ElementAccessExpressionSyntax)
            // before reaching the assignment — so "one or two hops up reaches the
            // assignment" is true only for a bare-identifier target, exactly
            // mirroring `assignment.Left is IdentifierNameSyntax`. In G#, where
            // this callback only ever fires for an already-identifier-only
            // target, `IdentifierToken` is a DIRECT child of the assignment, so
            // the same first token's immediate parent (one hop) already IS the
            // assignment — the disjunction covers both shapes so this reads
            // correctly translated OR not.
            let leftToken = assignment.GetFirstToken()
            if leftToken.Parent != assignment && leftToken.Parent?.Parent != assignment {
                return
            }
            let leftText = leftToken.Text
            let baseClassAccess ExpressionSyntax? = GetBaseClassAccess(assignment.Expression, out var rightReceiver)
            if baseClassAccess == nil ||
                rightReceiver is not NameExpressionSyntax rightIdentifier ||
                rightIdentifier
                .GetLastToken().Text != leftText {
                return
            }
            if !IsInsideLoop(assignment) || IsInsideExemptMethod(assignment) {
                return
            }
            if !IsStructSymbolBaseClassAccess(context, baseClassAccess) {
                return
            }
            context.ReportDiagnostic(
                Diagnostic.Create(DiagnosticDescriptors.UnguardedBaseClassWalk, assignment.Location, leftText)
            )
        }

        /// Returns the member-access node of a `.BaseClass` access — an
        /// ordinary (cref:MemberAccessExpressionSyntax) for
        /// `x.BaseClass` — together with its receiver expression in
        /// [`receiver`](paramref). Returns `null` when
        /// [`expression`](paramref) is not a `BaseClass` access at all.
        /// Deliberately does not also match a null-conditional `x?.BaseClass`
        /// (see the "Deliberately out of scope" remark on this type — issue
        /// #4173).
        private func GetBaseClassAccess(expression ExpressionSyntax, out receiver ExpressionSyntax?) ExpressionSyntax? {
            if expression is AccessorExpressionSyntax{IsNullConditional: false} memberAccess &&
                memberAccess
                .RightPart
                .GetLastToken()
                .Text == BaseClassPropertyName {
                // Issue #4173: cs2gs's nullable-lifting inserts a null-forgiving
                // wrapper around a nullable receiver that has no equivalent
                // narrowing in G#'s flow analysis, so the migrated form of even
                // an unwrapped `current.BaseClass` receiver becomes
                // `current!!.BaseClass` — a real, structural difference from the
                // C# source this rule never sees written explicitly here, but
                // must still recognize once translated. Unwrapping a leading
                // null-forgiving operator on the receiver is also correct for
                // real C# source that spells it explicitly (`current!.BaseClass`),
                // which is a legitimate shape this rule should catch too.
                receiver = UnwrapNullForgiving(memberAccess.LeftPart)
                return memberAccess
            }
            receiver = nil
            return nil
        }

        private func UnwrapNullForgiving(expression ExpressionSyntax) ExpressionSyntax {
            var expression = expression
            while expression is UnaryExpressionSyntax postfixUnary {
                expression = postfixUnary.Operand
            }
            return expression
        }

        private func IsInsideLoop(node SyntaxNode) bool {
            for var current SyntaxNode? = node; current != nil; current = current!!.Parent {
                if (current is ForClauseStatementSyntax or WhileStatementSyntax or DoWhileStatementSyntax) {
                    return true
                }
                // A loop body is its own scope boundary for this check: stop at
                // the innermost method/lambda/local-function so a `.BaseClass`
                // reassignment in an unrelated OUTER loop (with this assignment
                // living inside a nested function literal instead) is not
                // mistaken for being inside that outer loop.
                if (
                    current is FunctionDeclarationSyntax or
                        FunctionDeclarationSyntax or
                        LambdaExpressionSyntax or
                        LambdaExpressionSyntax
                ) {
                    return false
                }
            }
            return false
        }

        private func IsInsideExemptMethod(node SyntaxNode) bool {
            let method FunctionDeclarationSyntax? = node.FirstAncestorOrSelf[FunctionDeclarationSyntax]()
            let type StructDeclarationSyntax? = method?.FirstAncestorOrSelf[StructDeclarationSyntax]()
            if method == nil || type == nil {
                return false
            }
            if method.Identifier.Text == ExemptMethodName && type.Identifier.Text == StructSymbolTypeName {
                // The one sanctioned implementation every other walk should call.
                return true
            }
            if method.Identifier.Text == ExemptDetectorMethodName && type.Identifier.Text == ExemptDetectorTypeName {
                // DeclarationBinder.DetectClassInheritanceCycles() is the
                // post-bind cycle detector (#973) itself: it CANNOT be
                // rewritten to call GetHierarchy(), because it needs to
                // identify the exact back-edge node to break
                // (`current.SetBaseClass(null)`) and memoizes already-verified
                // acyclic nodes across the classes it walks — both are outside
                // what GetHierarchy()'s return value alone can express. It is
                // already independently guarded (`onPath`/`acyclic` sets).
                return true
            }
            return false
        }

        private func IsStructSymbolBaseClassAccess(
            context SyntaxNodeAnalysisContext,
            baseClassAccess ExpressionSyntax
        ) bool {
            // Checked against the member SYMBOL rather than syntax alone so an
            // unrelated `.BaseClass` member on some other type is not mistaken
            // for this one (see IgnoresUnrelatedTypeNamedSimilarly). Accepts
            // either a property or a field: StructSymbol.BaseClass is a property
            // today, but nothing about this rule depends on that.
            let symbolInfo = context.SemanticModel.GetSymbolInfo(baseClassAccess, context.CancellationToken)
            let member Symbol? = symbolInfo.Symbol
            if member == nil ||
                member.Name != BaseClassPropertyName ||
                !((member is PropertySymbol || member is FieldSymbol)) {
                return false
            }
            return member.ContainingType?.Name == StructSymbolTypeName
        }
    }
}
