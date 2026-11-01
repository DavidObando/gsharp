// <copyright file="CSharpToGSharpTranslator.Deconstruction.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Hosts value-position deconstruction assignments, the lone assignment
        /// shape without a native G# expression form. Ordinary and compound
        /// assignments remain in place as ADR-0161 assignment expressions.
        private func WithHoistedAssignments(
            expression ExpressionSyntax?,
            includeSelf bool,
            buildMain() -> List[GStatement]
        ) IEnumerable[GStatement] {
            let hoisted = List[GStatement]()
            let replacements = List[ExpressionSyntax]()
            let suppressed = this.HoistAssignmentsInOrder(expression, includeSelf, hoisted, replacements)
            if suppressed.Count == 0 {
                return buildMain()
            }
            try {
                hoisted.AddRange(buildMain())
                return hoisted
            } finally {
                this.ReleaseHoistedAssignments(suppressed, replacements)
            }
        }

        private func HoistAssignmentsInOrder(
            expression ExpressionSyntax?,
            includeSelf bool,
            statements List[GStatement],
            replacements List[ExpressionSyntax]
        ) List[AssignmentExpressionSyntax] {
            let embedded = this.CollectEmbeddedAssignments(expression, includeSelf)
            for node in embedded {
                this.HoistPrecedingEvaluationOperands(expression, node, statements, replacements)
                statements.AddRange(this.FlattenChainedAssignment(node))
                this.state.SuppressedAssignments.Add(node)
            }
            return embedded
        }

        private func ReleaseHoistedAssignments(
            suppressed IEnumerable[AssignmentExpressionSyntax],
            replacements IEnumerable[ExpressionSyntax]
        ) {
            for node in suppressed {
                this.state.SuppressedAssignments.Remove(node)
            }
            for replacement in replacements {
                this.state.HoistedExpressionValues.Remove(replacement)
            }
        }

        private func RequiresLocalAssignmentSeam(expression ExpressionSyntax) bool -> this.CollectEmbeddedAssignments(
            expression,
            includeSelf: true
        )
            .Count > 0

        private func TranslateWithLocalAssignmentSeam(
            expression ExpressionSyntax,
            translate() -> GExpression
        ) GExpression {
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            let statements = List[GStatement]()
            let replacements = List[ExpressionSyntax]()
            this.state.PendingSpillPrologue = statements
            let embedded = this.HoistAssignmentsInOrder(expression, includeSelf: true, statements, replacements)
            try {
                let value = translate()
                return if statements.Count == 0 {
                    value
                } else {
                    cast[GExpression](BlockExpression(statements, value))
                }
            } finally {
                this.ReleaseHoistedAssignments(embedded, replacements)
                this.state.PendingSpillPrologue = outerSpillPrologue
            }
        }

        private func HoistPrecedingEvaluationOperands(
            root ExpressionSyntax?,
            assignment AssignmentExpressionSyntax,
            statements List[GStatement],
            replacements List[ExpressionSyntax]
        ) {
            var current IOperation? = this.context.SemanticModel.GetOperation(assignment)
            if current == nil {
                return
            }
            let groups = List[List[ExpressionSyntax]]()
            while current.Parent is IOperation parent && current.Syntax != root {
                let preceding = List[ExpressionSyntax]()
                for child in parent.ChildOperations {
                    if object.ReferenceEquals(child, current) {
                        break
                    }
                    let expression ExpressionSyntax? = OperationExpression(child)
                    if expression != nil && root!!.Span.Contains(expression.Span) && expression != root {
                        preceding.Add(expression)
                    }
                }
                if preceding.Count > 0 {
                    groups.Insert(0, preceding)
                }
                current = parent
            }
            for preceding in groups.SelectMany(
                func (group List[ExpressionSyntax]) IEnumerable[ExpressionSyntax] {
                    return group
                }
            ) {
                if this
                    .state
                    .HoistedExpressionValues
                    .ContainsKey(preceding) ||
                    preceding is LiteralExpressionSyntax ||
                    preceding is ThisExpressionSyntax ||
                    preceding is BaseExpressionSyntax ||
                    preceding is DefaultExpressionSyntax ||
                    preceding is TypeOfExpressionSyntax {
                    continue
                }
                let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
                this.state.PendingSpillPrologue = statements
                var value GExpression?
                try {
                    value = this.TranslateExpression(preceding)
                } finally {
                    this.state.PendingSpillPrologue = outerSpillPrologue
                }
                let temp = this.NewSpillName()
                statements.Add(LocalDeclarationStatement(BindingKind.Let, temp, type: nil, initializer: value))
                this.state.HoistedExpressionValues[preceding] = IdentifierExpression(temp)
                replacements.Add(preceding)
            }
        }

        /// Translates a condition while redirecting any spill or embedded
        /// deconstruction-assignment statements into [`prologue`](paramref).
        private func TranslateConditionWithHoist(expression ExpressionSyntax, prologue List[GStatement]) GExpression? {
            // Any spill hoisted while translating `expression` (issue #1731) is
            // redirected into `prologue` — the SAME preceding-statement list an
            // embedded deconstruction assignment uses — rather than the enclosing
            // statement's own ambient prologue, so both kinds of hoist land in
            // the same list in evaluation order.
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            this.state.PendingSpillPrologue = prologue
            try {
                return this.TranslateConditionWithHoistCore(expression, prologue)
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
            }
        }

        private func TranslateConditionWithHoistCore(
            expression ExpressionSyntax,
            prologue List[GStatement]
        ) GExpression? {
            let replacements = List[ExpressionSyntax]()
            let embedded = this.HoistAssignmentsInOrder(expression, includeSelf: true, prologue, replacements)
            try {
                return this.TranslateExpression(expression)
            } finally {
                this.ReleaseHoistedAssignments(embedded, replacements)
            }
        }

        /// Finds value-position deconstruction-assignment nodes in
        /// [`expression`](paramref) (in evaluation/document order),
        /// excluding ones inside a nested lambda/local function (their own
        /// statement seam). Assignments inside a conditional
        /// (`?:`) arm are left for that arm's native G# block-expression seam.
        /// Assignments inside any other short-circuited operand are left for that
        /// operand's local block-expression seam.
        private func CollectEmbeddedAssignments(expression ExpressionSyntax?, includeSelf bool) List[
            AssignmentExpressionSyntax
        ] {
            // Issue #1892: an object/`with` initializer's `Field = value`
            // elements (InitializerExpressionSyntax children of kind
            // ObjectInitializerExpression/WithInitializerExpression) are
            // AssignmentExpressionSyntax nodes syntactically, but they are
            // composite-literal/with-expression MEMBERS, not real value-position
            // assignments — collecting the member assignment itself would hoist
            // every initializer member into a stray bare `Field = value;`
            // statement in front of the (correct) literal/with-expression that
            // already carries it. Array/collection initializer elements
            // (ArrayInitializerExpression/CollectionInitializerExpression), by
            // contrast, are plain VALUES — an `AssignmentExpressionSyntax`
            // element there (`new[] { x = 5 }`) is a genuine value-position
            // assignment and must still be collected.
            //
            // Issue #1947: even for a skipped member-assignment, its VALUE may
            // itself embed a genuine value-position assignment
            // (`new T { A = (x = 3) }`) — that must still be found/hoisted, so
            // the member assignment's Right is scanned rather than skipped
            // wholesale.
            let IsInitializerMember = func (assignment AssignmentExpressionSyntax) bool {
                return assignment.Parent is InitializerExpressionSyntax initializer &&
                    (
                    initializer.IsKind(SyntaxKind.ObjectInitializerExpression) || initializer.IsKind(
                        SyntaxKind.WithInitializerExpression
                    )
                )
            }
            let Scan = func (node SyntaxNode?) IEnumerable[AssignmentExpressionSyntax] {
                if node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax {
                    yield break
                }
                // Issue #3348: a query CLAUSE's expression is translated inside the
                // lambda that clause lowers to (see <see cref="BuildScopeLambda"/> /
                // <see cref="LowerLetClause"/>) — its own evaluation scope, exactly
                // like an explicit lambda's, even though it is not an
                // `AnonymousFunctionExpressionSyntax` syntactically. Hoisting an
                // assignment out of one would move the write into the ENCLOSING
                // statement, where the range variable it reads is not in scope at
                // all, and would run it once for the whole query instead of once per
                // element. Only the sub-expressions a query evaluates EAGERLY, in the
                // enclosing scope, are scanned here: the source of the first `from`,
                // and each `join`'s `in` source (C# forbids either from referencing a
                // range variable, so neither can capture one). Every clause body is
                // left to its own lambda's seam, which hoists into the lambda.
                if node is QueryExpressionSyntax query {
                    for eager in EagerQuerySources(query) {
                        for found in Scan(eager) {
                            yield found
                        }
                    }
                    yield break
                }
                if node is AssignmentExpressionSyntax assignment {
                    if IsInitializerMember(assignment) {
                        for found in Scan(assignment.Right) {
                            yield found
                        }
                        yield break
                    }
                    // ADR-0161 / issue #3347: ordinary assignment expressions,
                    // including `??=`, stay where C# put them. Only
                    // deconstruction still requires statement-hosting fallback.
                    if AssignmentRequiresStatementLowering(assignment) {
                        yield assignment
                        yield break
                    }
                    for child in assignment.ChildNodes() {
                        for found in Scan(child) {
                            yield found
                        }
                    }
                    yield break
                }
                for child in node!!.ChildNodes() {
                    for found in Scan(child) {
                        yield found
                    }
                }
            }
            let candidates = if includeSelf || expression is not AssignmentExpressionSyntax rootAssignment {
                Scan(expression)
            } else {
                Scan(rootAssignment.Left).Concat(Scan(rootAssignment.Right))
            }
            let safe = List[AssignmentExpressionSyntax]()
            for candidate in candidates {
                if IsInsideConditionalValueBranch(candidate, expression) {
                    continue
                }
                if IsInShortCircuitedSubexpression(candidate, expression) {
                    // Scalar assignments remain native G# value expressions.
                    // Deconstruction is hosted by the nested short-circuit
                    // operand's own block-expression seam.
                    continue
                }
                safe.Add(candidate)
            }
            return safe
        }

        private func FlattenChainedAssignment(
            assignment AssignmentExpressionSyntax,
            preserveValue bool = true
        ) IEnumerable[GStatement] {
            // Follows the chain through ANY assignment operator (`=`, `+=`, …), not
            // just `=`: `a = b += c` is `a = (b += c)`, so the `+=` link must also be
            // captured or its mutation of `b` is silently dropped (issue #1723). The
            // walk is parenthesis-transparent (`a = (b = c)`) since a link's RHS may
            // be a parenthesized nested assignment.
            let lefts = List[(Target GExpression?, Op string, Syntax ExpressionSyntax)]()
            var current ExpressionSyntax = assignment
            var tupleLink TupleExpressionSyntax? = nil
            var tupleLinkRight ExpressionSyntax? = nil
            while true {
                var unwrapped = current
                while unwrapped is ParenthesizedExpressionSyntax paren {
                    unwrapped = paren.Expression
                }
                if unwrapped is not AssignmentExpressionSyntax link {
                    break
                }
                if link.Left is TupleExpressionSyntax linkTuple {
                    // A deconstruction-assignment link (`(a, b) = ...`) used in
                    // value position, either standalone (`var r = ((x, y) = (1,
                    // 2));`) or feeding an outer chain (`x = (a, b) = (1, 2);`).
                    // It has no single further "target" of its own, so the
                    // chain walk ends here (issue #1974).
                    tupleLink = linkTuple
                    tupleLinkRight = link.Right
                    break
                }
                lefts.Add((this.TranslateExpression(link.Left), link.OperatorToken.Text, link.Left))
                current = link.Right
            }
            let statements = List[GStatement]()
            // C# evaluates every target's receiver/index sub-expression
            // left-to-right — outermost first, matching source order — BEFORE
            // the shared RHS is evaluated (`a[F()] = b[G()] = c` runs F() then
            // G() then c). Spill each target's side-effecting parts here, in
            // that order; a target that is already an identifier/`this`/field
            // with no side-effecting sub-part passes through untouched.
            let safeTargets = [lefts.Count]GExpression
            for var i = 0; i < lefts.Count; i++ {
                safeTargets[i] = this.MakeDuplicationSafeTarget(lefts[i].Target!!, statements, lefts[i].Syntax)
            }
            var value GExpression?
            if tupleLink != nil {
                // A non-identifier target (`arr[i]`, `obj.F`, ...) anywhere in the
                // (possibly nested) target shape is handled by
                // `LowerTupleAssignmentForValue` capturing its receiver/index
                // FIRST, before the RHS is spilled (issue #2234, generalizing
                // #1895/#1974).
                let (tupleStatements, tupleValue) = this.LowerTupleAssignmentForValue(tupleLink, tupleLinkRight)
                statements.AddRange(tupleStatements)
                value = tupleValue
            } else {
                value = this.TranslateExpression(current)
            }
            // Walk the chain innermost-out, assigning to each target in turn.
            // C# assigns the SAME rhs VALUE to every target in a run of plain
            // `=` links — it never re-reads an inner target's getter to obtain
            // the value carried to the next (outer) link (issue #1845): `a =
            // obj.P = c` calls `P`'s setter once and never its getter. A
            // compound link (`+=`, …) genuinely produces a NEW value — the
            // target's old value combined with the operand — so its result
            // still has to be read back for the next link; that read is real
            // C# semantics, unrelated to the #1845 divergence, and is left as
            // it was under the #1731/#1842 fix (the target was already made
            // safe to re-embed above). This fallback is now reached only by a
            // chain containing a tuple-valued link, which has no native
            // assignment-expression form. Re-embedding a compound target
            // expression as-is would re-read its
            // getter once per outer link (issue #1875) — instead of doing
            // that, the read/combine/store is expanded manually (mirroring
            // exactly what the compound operator does) so the combined value
            // is captured directly, with no re-read at all.
            var valueIsShared = false
            for var i = lefts.Count - 1; i >= 0; i-- {
                let hasOuterLink = i > 0
                let targetNeedsCapturedValue = this.AssignmentTargetNeedsCapturedValue(lefts[i].Syntax)
                let captureRootSimpleValue = preserveValue && i == 0 && assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) &&
                    targetNeedsCapturedValue
                let compoundBinaryOp string? = if lefts[i].Op == "=" {
                    default(string?)
                } else {
                    CompoundToBinaryOperator(lefts[i].Op)
                }
                let captureRootCompoundValue = preserveValue &&
                    i == 0 &&
                    targetNeedsCapturedValue &&
                    compoundBinaryOp != nil
                var assignedValue GExpression? = value
                if lefts[i].Op == "=" {
                    let target ISymbol? = this.context.GetSymbolInfo(lefts[i].Syntax).Symbol
                    var targetType ITypeSymbol? = switch target {
                        case local is ILocalSymbol: local.Type
                        case parameter is IParameterSymbol: parameter.Type
                        case field is IFieldSymbol: field.Type
                        case property is IPropertySymbol: property.Type
                        default: this.context.GetTypeInfo(lefts[i].Syntax).Type
                    }
                    var promotionTarget ISymbol? = target
                    if target is ILocalSymbol inferredLocal &&
                        inferredLocal
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} declarator &&
                        declarator
                        .Ancestors()
                        .OfType[VariableDeclarationSyntax]()
                        .FirstOrDefault()
                        ?.Type
                        .IsVar == true {
                        targetType = this.context.GetTypeInfo(initializer).Type
                        promotionTarget = nil
                    }
                    assignedValue = this.ForgiveNullableReferenceValue(
                        current,
                        assignedValue,
                        targetType,
                        promotionTarget,
                        includePromotedValue: true
                    )
                }
                if captureRootSimpleValue {
                    // C# yields the converted RHS, never a post-set target read.
                    // A typed temp preserves that value for properties, set-only
                    // storage, and targets whose receiver/index had to be spilled.
                    assignedValue = this.CaptureAssignmentValue(assignment, assignedValue, statements)
                } else if hasOuterLink && lefts[i].Op == "=" && !valueIsShared {
                    // About to be assigned to more than one target — spill once
                    // so the RHS expression is evaluated exactly one time, then
                    // every remaining target reuses the same temp/trivial value.
                    assignedValue = this.SpillOperand(value!!, statements)
                    value = assignedValue
                    valueIsShared = true
                }
                if (hasOuterLink || captureRootCompoundValue) &&
                    targetNeedsCapturedValue &&
                    compoundBinaryOp is string binaryOp {
                    // A non-trivial compound target must yield its computed value
                    // without re-reading the getter: both an outer assignment chain
                    // (`a = c.P += d`, issue #1875) and a standalone value position
                    // (`Echo(c.P += d)`) reuse the captured combined value.
                    let oldValue GExpression? = this.SpillOperand(safeTargets[i], statements)
                    let combinedValue GExpression = BinaryExpression(oldValue, binaryOp, assignedValue)
                    let newValue GExpression? = if captureRootCompoundValue {
                        this.CaptureAssignmentValue(assignment, combinedValue, statements)
                    } else {
                        this.SpillOperand(combinedValue, statements)
                    }
                    statements.Add(AssignmentStatement(safeTargets[i], newValue, "="))
                    value = newValue
                    valueIsShared = true
                    continue
                }
                statements.Add(AssignmentStatement(safeTargets[i], assignedValue, lefts[i].Op))
                if hasOuterLink && lefts[i].Op != "=" {
                    // Trivial target (bare local/`this`): reading it back has
                    // no getter to worry about, so it stays the simple
                    // read-back this fix has always used for compound links.
                    // `??=` also lands here regardless of target triviality —
                    // it has no side-effect-free binary-expression equivalent
                    // (it must only evaluate/store the right-hand side when
                    // the target is null) — so a non-trivial `??=` target
                    // costs one extra getter call total (not one per outer
                    // link), the minimum faithful cost without reimplementing
                    // its short-circuit semantics.
                    value = if IsTrivialOperand(safeTargets[i]) {
                        safeTargets[i]
                    } else {
                        this.SpillOperand(safeTargets[i], statements)
                    }
                    valueIsShared = true
                }
            }
            return statements
        }

        private func CaptureAssignmentValue(
            assignment AssignmentExpressionSyntax,
            value GExpression?,
            statements List[GStatement]
        ) GExpression {
            let temp = this.NewSpillName()
            statements.Add(
                LocalDeclarationStatement(BindingKind.Let, temp, this.ResolveExpressionType(assignment), value)
            )
            let captured = IdentifierExpression(temp)
            this.state.AssignmentValues[assignment] = captured
            return captured
        }

        private func AssignmentTargetNeedsCapturedValue(target ExpressionSyntax) bool {
            if this.context.GetSymbolInfo(target).Symbol is IPropertySymbol {
                return true
            }
            return !(target is IdentifierNameSyntax)
        }

        // True when a discard element — either the bare-assignment form
        // (`(x, _) = ...`) or the declaration form (`(x, var _) = ...`,
        // parsed as a `DeclarationExpressionSyntax` wrapping a
        // `DiscardDesignationSyntax`).
        private func IsDeconstructionDiscard(targetExpr ExpressionSyntax) bool -> (
            targetExpr is IdentifierNameSyntax discardCandidate &&
                discardCandidate
                .Identifier
                .ValueText == "_" &&
                this.IsTrueDiscard(discardCandidate)
        ) ||
            targetExpr is DeclarationExpressionSyntax &&
            targetExpr.Designation is DiscardDesignationSyntax

        // True when every immediate element is a discard. A nested tuple must
        // recurse because its corresponding value may use a custom Deconstruct.
        private func HasOnlyImmediateDiscards(pattern TupleExpressionSyntax) bool {
            for argument in pattern.Arguments {
                if !this.IsDeconstructionDiscard(argument.Expression) {
                    return false
                }
            }
            return true
        }

        // Statement-position deconstruction assignment (`(a, b) = (x, y);`):
        // the resulting per-element values are never read back, so discards
        // stay true discards (no temp allocated for them).
        private func LowerTupleAssignment(leftTuple TupleExpressionSyntax, right ExpressionSyntax) IEnumerable[
            GStatement
        ]? {
            // Issues #3353/#3358: G#'s native multi-target assignment now
            // accepts storage targets and a tuple-valued single RHS while
            // preserving C#'s targets-then-RHS-then-writes order.
            if this.TryLowerNativeMultiAssignment(leftTuple, right, out var native) {
                return native
            }
            let statements = List[GStatement]()
            let captured = this.CaptureDeconstructionStorageTargets(leftTuple, statements)
            this.LowerTuplePattern(
                leftTuple,
                this.TranslateExpression(right),
                forceRealTemps: false,
                statements,
                captured,
                this.context.GetTypeInfo(right).Type as INamedTypeSymbol
            )
            return statements
        }

        /// Issue #3358: renders a C# deconstruction assignment as G#'s native
        /// multi-target assignment (`a, b = b, a`, ADR-0015) when every part
        /// of the shape is expressible, replacing a temporary tuple binding
        /// plus per-target-write triple.
        /// @remarks ADR-0015 evaluates every right-hand expression left-to-right into
        /// temporaries before any write, then assigns left-to-right — exactly the
        /// order C# specifies, so aliasing swaps and storage targets stay correct.
        ///
        /// Mixed fresh/existing targets use ADR-0168 inline bindings. Nested
        /// target tuples keep the existing lowering. Non-tuple deconstruction
        /// sources also keep it because native multi-assignment unifies tuple
        /// values only.
        /// @param leftTuple The C# deconstruction target tuple.
        /// @param right The right-hand side.
        /// @param result The emitted statements when the rewrite applies.
        /// @returns `true` when the rewrite applied.
        private func TryLowerNativeMultiAssignment(
            leftTuple TupleExpressionSyntax,
            right ExpressionSyntax,
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            if this
                .context
                .GetTypeInfo(right)
                .Type is not INamedTypeSymbol{IsTupleType: true} rightType ||
                rightType
                .TupleElements
                .Length != leftTuple
                .Arguments
                .Count {
                return false
            }
            // Nested target tuples/designations still need recursive lowering.
            // Flat fresh `var` declarations can use G#'s inline let/var targets.
            for argument in leftTuple.Arguments {
                if argument.Expression is TupleExpressionSyntax ||
                    (
                    argument.Expression is DeclarationExpressionSyntax declaration &&
                        (
                        !declaration
                            .Type
                            .IsVar ||
                            declaration.Designation is ParenthesizedVariableDesignationSyntax ||
                            (
                            declaration.Designation is SingleVariableDesignationSyntax single &&
                                this
                                .context
                                .GetDeclaredSymbol(single) is ILocalSymbol local &&
                                this.InferredLocalDefaultRequiresTypedDeclaration(local)
                        )
                    )
                ) {
                    return false
                }
            }
            let targets = List[GExpression](leftTuple.Arguments.Count)
            let targetBindings = List[BindingKind?](leftTuple.Arguments.Count)
            for argument in leftTuple.Arguments {
                if argument.Expression is DeclarationExpressionSyntax declaration {
                    if declaration.Designation is not SingleVariableDesignationSyntax single {
                        targets.Add(IdentifierExpression("_"))
                        targetBindings.Add(nil)
                        continue
                    }
                    let name string? = this.EmittedName(single, single.Identifier)
                    if name == "_" {
                        targets.Add(IdentifierExpression(name))
                        targetBindings.Add(nil)
                        continue
                    }
                    let local ILocalSymbol? = this.context.GetDeclaredSymbol(single) as ILocalSymbol
                    targets.Add(IdentifierExpression(name))
                    targetBindings.Add(
                        if local != nil && this.IsLocalReassigned(local) {
                            BindingKind.Var
                        } else {
                            BindingKind.Let
                        }
                    )
                    continue
                }
                targets.Add(this.TranslateExpression(argument.Expression)!!)
                targetBindings.Add(nil)
            }
            var unwrappedRight = right
            while unwrappedRight is ParenthesizedExpressionSyntax parenthesized {
                unwrappedRight = parenthesized.Expression
            }
            let values IReadOnlyList[GExpression] = if unwrappedRight is TupleExpressionSyntax rightTuple {
                cast[IReadOnlyList[GExpression]](
                    rightTuple
                        .Arguments
                        .Select((argument ArgumentSyntax) -> this.TranslateExpression(argument.Expression)!!)
                        .ToList()
                )
            } else {
                cast[IReadOnlyList[GExpression]]([]GExpression{this.TranslateExpression(right)!!})
            }
            result = []GStatement{MultiAssignmentStatement(targets, values, targetBindings)}
            return true
        }

        // Expression-position deconstruction assignment (`var r = ((x, y) =
        // (1, 2));`, `M((a, b) = e)`, ...): the assignment's VALUE — a tuple
        // of the assigned elements, in target order — is needed by the
        // enclosing expression, so every element (including a discard) is
        // captured in a real temp and the value is rebuilt as a tuple literal
        // over those temps (issue #1974).
        private func LowerTupleAssignmentForValue(leftTuple TupleExpressionSyntax, right ExpressionSyntax?)(
            Statements List[GStatement],
            Value GExpression
        ) {
            let statements = List[GStatement]()
            let captured = this.CaptureDeconstructionStorageTargets(leftTuple, statements)
            let values = this.LowerTuplePattern(
                leftTuple,
                this.TranslateExpression(right),
                forceRealTemps: true,
                statements,
                captured,
                this.context.GetTypeInfo(right).Type as INamedTypeSymbol
            )
            let value GExpression = TupleLiteralExpression(values)
            this.state.TupleAssignmentValues[leftTuple] = value
            return (statements, value)
        }

        // Walks a (possibly nested) deconstruction-assignment target shape
        // and, for every indexer/member-access (or other existing storage-
        // location) leaf, spills its receiver/index sub-expression into a
        // temp via `MakeDuplicationSafeTarget` — the SAME machinery chained
        // assignment (`a[F()] = b[G()] = c`, issue #1731) already uses —
        // emitted into `statements` BEFORE anything about the right-hand
        // side. This preserves C#'s left-to-right, targets-then-value
        // evaluation order (issue #2234, generalizing #1895/#1974: a plain
        // identifier or a new `var`/nested-`var` binding has nothing
        // pre-existing to evaluate, so needs no capture; a nested tuple
        // target is walked recursively, since its own leaves are storage
        // locations too). Returns a map from each captured leaf's original
        // syntax to its now-single-evaluation-safe G# replacement, consulted
        // by `LowerTuplePattern` when it emits the final per-target
        // assignment.
        private func CaptureDeconstructionStorageTargets(
            pattern TupleExpressionSyntax,
            statements List[GStatement]
        ) Dictionary[ExpressionSyntax, GExpression] {
            let captured = Dictionary[ExpressionSyntax, GExpression]()
            this.CaptureDeconstructionStorageTargets(pattern, statements, captured)
            return captured
        }

        private func CaptureDeconstructionStorageTargets(
            pattern TupleExpressionSyntax,
            statements List[GStatement],
            captured Dictionary[ExpressionSyntax, GExpression]
        ) {
            for argument in pattern.Arguments {
                let targetExpr = argument.Expression
                switch targetExpr {
                    case nested is TupleExpressionSyntax {
                        this.CaptureDeconstructionStorageTargets(nested, statements, captured)
                    }
                    case IdentifierNameSyntax, DeclarationExpressionSyntax { }
                    default {
                        // An existing storage location (`arr[i]`, `obj.F`, ...):
                        // spill its receiver/index once, now, before the RHS.
                        captured[targetExpr] = this.MakeDuplicationSafeTarget(
                            this.TranslateExpression(targetExpr)!!,
                            statements,
                            targetExpr
                        )
                    }
                }
            }
        }

        // Core recursive lowering shared by the statement- and
        // expression-position forms above. `rhsValue` is the G# expression to
        // deconstruct — the fully translated original right-hand side on the
        // OUTERMOST call, or a bare temp-identifier read on a recursive call
        // for a nested target (already single-evaluation-safe, so it needs no
        // further spilling). Returns each element's resulting value (`null`
        // for a true discard when `forceRealTemps` is false, since nothing
        // captures its value in that case).
        private func LowerTuplePattern(
            pattern TupleExpressionSyntax,
            rhsValue GExpression?,
            forceRealTemps bool,
            statements List[GStatement],
            captured Dictionary[ExpressionSyntax, GExpression],
            rhsTupleType INamedTypeSymbol? = nil
        ) List[GExpression] {
            let count = pattern.Arguments.Count
            let temps = List[string](count)
            let directNames = [count]bool
            for var i = 0; i < count; i++ {
                let targetExpr = pattern.Arguments[i].Expression
                // Issue #3501 (synthetic-name retirement): a single-variable
                // declaration element (`(int probeExit, _) = …`) binds its
                // REAL name directly in the native `let (…)` instead of a
                // structural temp plus a re-declaration — provided the local
                // is never reassigned (the tuple binding is `let`) and its
                // declared type matches the RHS element (a `var` designation
                // matches by construction; an explicit type must equal the
                // deconstructed element so no implicit conversion is lost).
                if targetExpr is DeclarationExpressionSyntax{
                    Designation: SingleVariableDesignationSyntax directSingle
                } directDecl &&
                    this
                    .context
                    .GetDeclaredSymbol(directSingle) is ILocalSymbol directLocal && !this.IsLocalReassigned(
                    directLocal
                ) &&
                    (!directDecl.Type.IsVar || !this.InferredLocalDefaultRequiresTypedDeclaration(directLocal)) &&
                    (
                    directDecl
                        .Type
                        .IsVar ||
                        (
                        rhsTupleType != nil &&
                            rhsTupleType.IsTupleType == true &&
                            i < rhsTupleType
                            .TupleElements
                            .Length &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(directLocal.Type, rhsTupleType.TupleElements[i].Type)
                    )
                ) {
                    temps.Add(this.EmittedName(directSingle, directSingle.Identifier)!!)
                    directNames[i] = true
                    continue
                }
                // A nested tuple target needs its own real temp to recurse
                // into — UNLESS every leaf underneath it is itself a true
                // discard, in which case the whole nested arm is dead and
                // the RHS element is an actual tuple. A custom Deconstruct
                // method must still run even when every output is discarded.
                let sideEffectFreeAllDiscardTuple = targetExpr is TupleExpressionSyntax nestedDiscardCheck &&
                    this.HasOnlyImmediateDiscards(nestedDiscardCheck) &&
                    rhsTupleType != nil &&
                    rhsTupleType.IsTupleType == true &&
                    i < rhsTupleType
                    .TupleElements
                    .Length &&
                    (rhsTupleType.TupleElements[i].Type is INamedTypeSymbol and {IsTupleType: true})
                let needsRealTemp = forceRealTemps ||
                    (!sideEffectFreeAllDiscardTuple && !this.IsDeconstructionDiscard(targetExpr))
                temps.Add(
                    if needsRealTemp {
                        this.AllocateDeconstructionTempName(targetExpr)
                    } else {
                        "_"
                    }
                )
            }
            // Spill the WHOLE right-hand side in one native decon-binding.
            // These temps are single-use compiler internals, never reassigned,
            // so use the immutable `let (...)` spelling even though ADR-0168
            // also permits mutable `var (...)`. This is exactly the mechanism the
            // declaration form (`var (a, b) = e`) already uses, so it inherits
            // the same RHS-shape support for free.
            statements.Add(TupleDeconstructionStatement(BindingKind.Let, temps, rhsValue))
            let values = List[GExpression](count)
            for var i = 0; i < count; i++ {
                let targetExpr = pattern.Arguments[i].Expression
                if temps[i] == "_" {
                    values.Add(default(GExpression))
                    continue
                }
                if (directNames[i]) {
                    // The element already bound its real name in the tuple
                    // binding — nothing to re-declare; the value read is the
                    // name itself.
                    values.Add(IdentifierExpression(temps[i]))
                    continue
                }
                let tempRead = cast[GExpression](IdentifierExpression(temps[i]))
                if targetExpr is TupleExpressionSyntax nestedTuple {
                    // Nested target (`((a, b), c) = ...`): the outer temp
                    // holds the nested element's value, itself a tuple — spill
                    // IT with a second native decon-binding rather than trying
                    // to flatten every depth into one `let (...)` (issue
                    // #1974). The recursive rhsValue is already a bare temp
                    // read, so no further spill is needed before recursing.
                    let nestedRhsTupleType INamedTypeSymbol? = if rhsTupleType != nil &&
                        rhsTupleType.IsTupleType == true &&
                        i < rhsTupleType
                        .TupleElements
                        .Length {
                        rhsTupleType.TupleElements[i].Type as INamedTypeSymbol
                    } else {
                        default(INamedTypeSymbol?)
                    }
                    let nestedValues = this.LowerTuplePattern(
                        nestedTuple,
                        tempRead,
                        forceRealTemps,
                        statements,
                        captured,
                        nestedRhsTupleType
                    )
                    values.Add(
                        if forceRealTemps {
                            TupleLiteralExpression(nestedValues)
                        } else {
                            default(TupleLiteralExpression?)
                        }
                    )
                    continue
                }
                if targetExpr is DeclarationExpressionSyntax declaration {
                    let declaredValue GExpression? = this.LowerDeconstructionDeclaration(
                        declaration.Designation,
                        tempRead,
                        forceRealTemps,
                        statements,
                        declaration.Type.IsVar
                    )
                    if declaredValue != nil {
                        values.Add(declaredValue)
                    } else {
                        values.Add(default(GExpression))
                    }
                    continue
                }
                // An existing local (or member/element access) target: write
                // the spilled value back. A discard target still gets a real
                // temp here (`forceRealTemps=true`, e.g. expression-position
                // `(x, _) = (1, 2)`) so its value can be reconstructed into
                // the outer tuple, but `_` isn't a real assignable location —
                // skip the write itself to avoid emitting a stray, dead
                // discard write-back statement (issue #2099).
                if !this.IsDeconstructionDiscard(targetExpr) {
                    // A member/element-access target was already captured
                    // into a duplication-safe replacement BEFORE the RHS was
                    // spilled above (issue #2234); a plain identifier has no
                    // entry and translates as-is.
                    let assignTarget GExpression? = if captured.TryGetValue(targetExpr, out var safeTarget) {
                        safeTarget
                    } else {
                        this.TranslateExpression(targetExpr)
                    }
                    statements.Add(
                        AssignmentStatement(assignTarget, this.BridgeDeconstructedElementStore(targetExpr, tempRead))
                    )
                }
                values.Add(tempRead)
            }
            return values
        }

        // Issue #5561: the store bridge of `target = element` for a variable,
        // field or property that a deconstruction assigns. The temp holds the
        // `Deconstruct` element, which G# types from its declaration, so a
        // widened element stored into a slot that stays non-null is asserted
        // exactly as `n = entry.Item!!` is. The slot is the input of a
        // user-defined conversion, as in `ForgiveNullableReferenceValueCore`, or
        // else the target's storage. A local that reads as nullable (a `var`
        // local whose initializer is nullable) has nullable storage; a field or
        // property is decided by its declaration, as for a plain assignment.
        // An element-access target is #5595.
        private func BridgeDeconstructedElementStore(target ExpressionSyntax, value GExpression) GExpression? {
            if !(target is IdentifierNameSyntax || target is MemberAccessExpressionSyntax) {
                return value
            }
            let model = this.context.SemanticModel
            let element = ObliviousNullabilityAnalyzer.DeconstructedElementDeclaration(
                target,
                model,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            )
            if element == nil || !this.IsTranslatorWidenedDeclaration(element) {
                return value
            }
            var slot ISymbol? = this.GetProjectedAssignmentTarget(target, this.context.GetSymbolInfo(target).Symbol)
            var slotType ITypeSymbol? = this.GetAssignmentTargetType(target, slot)
            if ObliviousNullabilityAnalyzer.DeconstructedElementConversionOperator(target, model) is {} conversion {
                slot = conversion.Parameters[0]
                slotType = conversion.Parameters[0].Type
            } else if slot is ILocalSymbol && this.IsNullablePromotedValue(target) {
                return value
            }
            return if this.TargetWillRemainNonNullableReference(slotType, slot) {
                EnsureNonNullAssertion(value)
            } else {
                value
            }
        }

        // G# tuple bindings are deliberately flat (ADR-0168; the issue #4300
        // driver probe rejects `let (a, (b, c)) = ...`), so recursive lowering
        // still needs a carrier for each structural arm. Derive that carrier
        // from the first source leaf and reserve every identifier in the body;
        // this is the smallest collision-safe replacement for `__deconN`.
        private func AllocateDeconstructionTempName(anchor SyntaxNode, preferredName string? = nil) string {
            let stem = this.nameAllocator.GetName(preferredName ?? this.DeconstructionTempStem(anchor))
            let body = this.state.CurrentBodyScope ?? anchor.SyntaxTree.GetRoot()
            if !this.state.SynthesizedLocalOccupiedNamesByBody.TryGetValue(body, out var occupied) {
                occupied = this.CollectOccupiedSynthesizedLocalNames(body)
                this.state.SynthesizedLocalOccupiedNamesByBody.Add(body, occupied)
            }
            if !this.state.DeconstructionTempNamesByBody.TryGetValue(body, out var allocated) {
                allocated = HashSet[string](StringComparer.Ordinal)
                this.state.DeconstructionTempNamesByBody.Add(body, allocated)
            }
            var candidate = stem
            for var suffix = 2; occupied.Contains(candidate) || allocated.Contains(candidate) ||
                !this.ReserveSynthesizedLocalName(candidate, anchor); suffix++ {
                candidate = stem + suffix.ToString(CultureInfo.InvariantCulture)
            }
            allocated.Add(candidate)
            return candidate
        }

        private func CollectOccupiedSynthesizedLocalNames(body SyntaxNode) HashSet[string] {
            let DescendIntoCurrentBody = func (node SyntaxNode) bool {
                return object.ReferenceEquals(node, body) ||
                    !((node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax))
            }
            let occupied = HashSet[string](StringComparer.Ordinal)
            for token in body.DescendantTokens(DescendIntoCurrentBody) {
                if token.IsKind(SyntaxKind.IdentifierToken) {
                    occupied.Add(this.nameAllocator.GetName(token.ValueText))
                }
            }
            for localFunction in body.DescendantNodes().OfType[LocalFunctionStatementSyntax]() {
                if FindNestedFunction(localFunction.Parent, body) == nil {
                    occupied.Add(this.EmittedName(localFunction, localFunction.Identifier)!!)
                }
            }
            for name in body.DescendantNodes().OfType[SimpleNameSyntax]() {
                if FindNestedFunction(name.Parent, body) == nil {
                    continue
                }
                let symbol ISymbol? = this.context.GetSymbolInfo(name).Symbol
                if symbol != nil && !IsDeclaredInNestedFunction(symbol, body) {
                    occupied.Add(this.EmittedName(symbol, name.Identifier.ValueText)!!)
                }
            }
            return occupied
        }

        private func DeconstructionTempStem(anchor SyntaxNode) string {
            let declaredLeaf SingleVariableDesignationSyntax? = anchor
                .DescendantNodesAndSelf()
                .OfType[SingleVariableDesignationSyntax]()
                .FirstOrDefault()
            let sourceLeaf = declaredLeaf?.Identifier ?? anchor.DescendantTokens().FirstOrDefault(
                (token SyntaxToken) -> token.IsKind(SyntaxKind.IdentifierToken) &&
                    token.ValueText != "_" &&
                    token.ValueText != "var"
            )
            let leaf = if sourceLeaf.RawKind == 0 {
                "deconstructed"
            } else {
                this.nameAllocator.GetName(sourceLeaf.ValueText)
            }
            let structural = anchor is TupleExpressionSyntax ||
                anchor is ParenthesizedVariableDesignationSyntax ||
                anchor is DeclarationExpressionSyntax &&
                anchor.Designation is ParenthesizedVariableDesignationSyntax
            return leaf +
                (
                if structural {
                    "Tuple"
                } else {
                    "Value"
                }
            )
        }

        private func LowerDeconstructionDeclaration(
            designation VariableDesignationSyntax,
            value GExpression,
            preserveValue bool,
            statements List[GStatement],
            inferredType bool
        ) GExpression? {
            if designation is DiscardDesignationSyntax {
                return if preserveValue {
                    value
                } else {
                    default(GExpression?)
                }
            }
            if designation is SingleVariableDesignationSyntax single {
                let name = this.EmittedName(single, single.Identifier)
                let local ILocalSymbol? = this.context.GetDeclaredSymbol(single) as ILocalSymbol
                let type = if inferredType && local != nil && this.InferredLocalDefaultRequiresTypedDeclaration(local) {
                    MakeNullable(this.typeMapper.MapEventType(local.Type, this.context, single.GetLocation()))
                } else {
                    default(GTypeReference?)
                }
                statements.Add(
                    LocalDeclarationStatement(
                        if local != nil && this.IsLocalReassigned(local) {
                            BindingKind.Var
                        } else {
                            BindingKind.Let
                        },
                        name,
                        type,
                        initializer: value
                    )
                )
                return IdentifierExpression(name)
            }
            let parenthesized = cast[ParenthesizedVariableDesignationSyntax](designation)
            let temps = List[string](parenthesized.Variables.Count)
            let directNames = [parenthesized.Variables.Count]bool
            for var i = 0; i < parenthesized.Variables.Count; i++ {
                let child = parenthesized.Variables[i]
                if !preserveValue &&
                    child is SingleVariableDesignationSyntax childSingle &&
                    this
                    .context
                    .GetDeclaredSymbol(childSingle) is ILocalSymbol local && !this.IsLocalReassigned(local) &&
                    !(inferredType && this.InferredLocalDefaultRequiresTypedDeclaration(local)) {
                    temps.Add(this.EmittedName(childSingle, childSingle.Identifier)!!)
                    directNames[i] = true
                } else {
                    temps.Add(
                        if !preserveValue && child is DiscardDesignationSyntax {
                            "_"
                        } else {
                            this.AllocateDeconstructionTempName(child)
                        }
                    )
                }
            }
            statements.Add(TupleDeconstructionStatement(BindingKind.Let, temps, value))
            let values = List[GExpression](parenthesized.Variables.Count)
            for var i = 0; i < parenthesized.Variables.Count; i++ {
                if temps[i] == "_" {
                    values.Add(default(GExpression))
                    continue
                }
                if (directNames[i]) {
                    values.Add(IdentifierExpression(temps[i]))
                    continue
                }
                let declaredValue GExpression? = this.LowerDeconstructionDeclaration(
                    parenthesized.Variables[i],
                    IdentifierExpression(temps[i]),
                    preserveValue,
                    statements,
                    inferredType
                )
                if declaredValue != nil {
                    values.Add(declaredValue)
                } else {
                    values.Add(default(GExpression))
                }
            }
            return if preserveValue {
                TupleLiteralExpression(values)
            } else {
                default(TupleLiteralExpression?)
            }
        }

        private func LowerTupleDeclaration(
            designation ParenthesizedVariableDesignationSyntax,
            right ExpressionSyntax,
            inferredType bool
        ) IEnumerable[GStatement] {
            return this.WithHoistedAssignments(
                right,
                includeSelf: true,
                func () List[GStatement] {
                    let statements = List[GStatement]()
                    this.LowerDeconstructionDeclaration(
                        designation,
                        this.TranslateExpression(right)!!,
                        preserveValue: false,
                        statements,
                        inferredType
                    )
                    return statements
                }
            )
        }

        private func TryGetDeconstructionTargets(
            left ExpressionSyntax,
            out binding BindingKind,
            out names IReadOnlyList[string]?
        ) bool {
            binding = BindingKind.Let
            names = nil
            // `var (a, b) = e`.
            if left is DeclarationExpressionSyntax{Designation: ParenthesizedVariableDesignationSyntax parenthesized} {
                if parenthesized.Variables.Any(
                    (designation VariableDesignationSyntax) -> designation is ParenthesizedVariableDesignationSyntax
                ) {
                    return false
                }
                let collected = List[string]()
                for designation in parenthesized.Variables {
                    if designation is ParenthesizedVariableDesignationSyntax {
                        return false
                    }
                    collected.Add(
                        switch designation {
                            case single is SingleVariableDesignationSyntax: this.EmittedName(single, single.Identifier)
                            default: "_"
                        }
                    )
                    // Issue #1967: `var (i, r) = ...` declares each element via a
                    // designation, not a declarator.
                    if designation is SingleVariableDesignationSyntax indexCheckSingle {
                        if this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol local {
                            if this.InferredLocalDefaultRequiresTypedDeclaration(local) {
                                return false
                            }
                            if this.IsLocalReassigned(local) {
                                binding = BindingKind.Var
                            }
                        }
                    }
                }
                names = collected
                return true
            }
            // `(var a, var b) = e`.
            if left is TupleExpressionSyntax tuple && tuple.Arguments.All(
                (a ArgumentSyntax) -> (
                    a.Expression is DeclarationExpressionSyntax and
                        {Designation: SingleVariableDesignationSyntax or DiscardDesignationSyntax}
                )
            ) {
                let collected = List[string]()
                for argument in tuple.Arguments {
                    let declaration = cast[DeclarationExpressionSyntax](argument.Expression)
                    if declaration.Designation is ParenthesizedVariableDesignationSyntax {
                        return false
                    }
                    collected.Add(
                        switch declaration.Designation {
                            case single is SingleVariableDesignationSyntax: this.EmittedName(single, single.Identifier)
                            default: "_"
                        }
                    )
                    // Issue #1967: `(var i, var r) = ...` — same as above, one
                    // designation per tuple element.
                    if declaration.Designation is SingleVariableDesignationSyntax indexCheckSingle {
                        if this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol local &&
                            declaration
                            .Type
                            .IsVar &&
                            this.InferredLocalDefaultRequiresTypedDeclaration(local) {
                            return false
                        }
                        if this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol reassignedLocal &&
                            this.IsLocalReassigned(reassignedLocal) {
                            binding = BindingKind.Var
                        }
                    }
                }
                names = collected
                return true
            }
            return false
        }

        private func TranslateLock(lockStatement LockStatementSyntax) GStatement {
            // Issue #1885: G# has a first-class `lock target { body }` statement
            // with the SAME single-evaluation, Monitor.Enter/try-finally/
            // Monitor.Exit semantics as C#'s `lock`, so the translated target
            // is emitted once and gsc lowers it — no manual Monitor lowering
            // (and no missing `import System.Threading`) needed here.
            let target = this.TranslateExpression(lockStatement.Expression)
            let body = this.TranslateStatementAsBlock(lockStatement.Statement)
            return LockStatement(target, body)
        }

        // Spills `operand` into a fresh `let` in the active statement seam's
        // prologue (see <see cref="pendingSpillPrologue"/>/<see
        // cref="WithSpillSeam"/>) and returns a reference to that local, UNLESS
        // `operand` is already trivial (see <see cref="IsTrivialOperand"/>) — a
        // bare local/`this`/literal is safe to duplicate as-is, so spilling it
        // would only add clutter. When no statement seam is active (translating
        // outside any statement, or across a lambda/local-function boundary —
        // see <see cref="TranslateLambda"/>/<see cref="TranslateLocalFunction"/>)
        // the operand is conservatively left embedded as-is rather than spilled
        // into an unrelated scope.
        private func SpillOperand(operand GExpression, forceNonTrivial bool = false) GExpression -> this.SpillOperand(
            operand,
            this.state.PendingSpillPrologue,
            forceNonTrivial
        )

        // As above, but retains a loud fallback for a future expression-only
        // site that fails to open either a statement seam or issue #3355's
        // native block-expression seam.
        //
        // `forceNonTrivial` suppresses the <see cref="IsTrivialOperand"/>
        // shortcut. That shortcut answers "is duplicating this expression
        // safe?", which is the wrong question for a caller that is REORDERING
        // evaluation rather than duplicating it: a bare identifier is safe to
        // read twice, but it is NOT safe to read it LATER than written when
        // another operand that moved ahead of it can mutate what it names
        // (PR #4211's third review round — see
        // <see cref="SnapshotPermutedArgumentOperand"/>).
        private func SpillOperand(
            operand GExpression,
            operandSyntaxForDiagnostic SyntaxNode,
            forceNonTrivial bool = false
        ) GExpression {
            if !forceNonTrivial && IsTrivialOperand(operand) {
                return operand
            }
            if this.CanAssignShortCircuitSpill(operandSyntaxForDiagnostic) {
                return this.AssignShortCircuitSpill(operand, operandSyntaxForDiagnostic)
            }
            if this.state.PendingSpillPrologue != nil {
                return this.SpillOperand(operand, forceNonTrivial)
            }
            let message = "a non-trivial operand reached an expression-only translation site without opening " +
                "a native block-expression spill seam; emitting it in place would evaluate it more " +
                "than once, or out of source order."
            this.context.ReportUnsupported(operandSyntaxForDiagnostic, message)
            return operand
        }

        private func CanAssignShortCircuitSpill(operandSyntax SyntaxNode) bool {
            if this
                .state
                .ShortCircuitSpillDeclarations == nil ||
                this
                .state
                .PendingSpillPrologue == nil ||
                this
                .state
                .ShortCircuitSpillScope == nil {
                return false
            }
            for var current SyntaxNode? = operandSyntax; current != nil; current = current!!.Parent {
                if current == this.state.ShortCircuitSpillScope {
                    return true
                }
                if current is AnonymousFunctionExpressionSyntax || current is LocalFunctionStatementSyntax {
                    return false
                }
            }
            return false
        }

        private func AssignShortCircuitSpill(operand GExpression, operandSyntax SyntaxNode) GExpression {
            let typeInfo = this.context.GetTypeInfo(operandSyntax)
            let operandType ITypeSymbol? = typeInfo.Type ?? typeInfo.ConvertedType
            if operandType == nil || operandType.TypeKind == TypeKind.Error {
                this.context.ReportUnsupported(
                    operandSyntax,
                    "a short-circuited fallback pattern scrutinee has no resolvable type for its deferred spill local (issue #3419)."
                )
                return this.SpillOperand(operand)
            }
            var spillType = this.typeMapper.Map(operandType, this.context, operandSyntax.GetLocation())
            if operandType.IsReferenceType {
                spillType = MakeNullable(spillType)!!
            }
            let temp = this.NewSpillName()
            let reference = IdentifierExpression(temp)
            this.state.ShortCircuitSpillDeclarations!!.Add(LocalDeclarationStatement(BindingKind.Var, temp, spillType))
            this.state.PendingSpillPrologue!!.Add(AssignmentStatement(reference, operand))
            return reference
        }

        // Issue #3355: field/property initializers and constructor-initializer
        // arguments can host spill statements directly in a native block
        // expression. No result-type lookup or synthesized helper is needed.
        private func TranslateNullSeamExpression(expression ExpressionSyntax) GExpression {
            return this.TranslateWithBlockSpillSeam(
                func () GExpression {
                    return this.TranslateExpression(expression)!!
                }
            )
        }

        private func TranslateNullSeamArguments(
            arguments SeparatedSyntaxList[ArgumentSyntax],
            preserveNames bool = true
        ) List[GExpression] {
            return arguments.Select(
                (argument ArgumentSyntax) -> this.TranslateNullSeamArgument(argument, preserveNames)
            )
                .ToList()
        }

        private func TranslateNullSeamArgument(argument ArgumentSyntax, preserveName bool) GExpression {
            var value GExpression
            if (
                argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword) || argument.RefKindKeyword.IsKind(
                    SyntaxKind.OutKeyword
                )
            ) &&
                !(argument.Expression is DeclarationExpressionSyntax) &&
                argument.Expression is not(IdentifierNameSyntax and {Identifier: {ValueText: "_"}}) {
                // Keep address-of outermost so gsc's ref/out call binder sees
                // the expected argument shape: `&{ spills; lvalue }`.
                value = UnaryExpression(
                    "&",
                    this.TranslateWithBlockSpillSeam(
                        func () GExpression {
                            return WithoutNonNullAssertion(this.TranslateExpression(argument.Expression))!!
                        }
                    )
                )
            } else {
                value = this.TranslateWithBlockSpillSeam(
                    func () GExpression {
                        return this.TranslateArgumentValue(argument)!!
                    }
                )
            }
            return if argument.NameColon == nil || !preserveName {
                value
            } else {
                cast[GExpression](
                    NamedArgumentExpression(
                        this.EmittedName(
                            this.context.GetSymbolInfo(argument.NameColon!!.Name).Symbol,
                            argument.NameColon!!.Name.Identifier.ValueText
                        ),
                        value
                    )
                )
            }
        }

        private func TranslateWithBlockSpillSeam(translate() -> GExpression) GExpression {
            if this.state.PendingSpillPrologue != nil {
                return translate()
            }
            let outerSpillPrologue = this.state.PendingSpillPrologue
            let outerOutDeclarations = this.state.FunctionArgumentOutDeclarations
            let spillPrologue = List[GStatement]()
            this.state.PendingSpillPrologue = spillPrologue
            this.state.FunctionArgumentOutDeclarations = spillPrologue
            try {
                let value = translate()
                return if spillPrologue.Count == 0 {
                    value
                } else {
                    cast[GExpression](BlockExpression(spillPrologue, value))
                }
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
            }
        }

        // As above, but appends the spill declaration directly to an explicit
        // `prologue` list rather than the ambient one — used by callers (e.g.
        // <see cref="FlattenChainedAssignment"/>) that already build their own
        // ordered statement list and know exactly where the spill must land,
        // independent of whatever statement seam happens to be active.
        private func SpillOperand(
            operand GExpression,
            prologue List[GStatement]?,
            forceNonTrivial bool = false
        ) GExpression {
            if (!forceNonTrivial && IsTrivialOperand(operand)) || prologue == nil {
                return operand
            }
            let temp = this.NewSpillName()
            prologue.Add(LocalDeclarationStatement(BindingKind.Let, temp, type: nil, initializer: operand))
            return IdentifierExpression(temp)
        }

        private func NewSpillName() string {
            var candidate string
            do {
                candidate = "__spill${this.state.SpillCounter}"
                this.state.SpillCounter++
            } while !this.TryClaimSynthesizedLocalName(candidate)
            return candidate
        }

        // Rebuilds an assignment TARGET (a link's left-hand side in a chained
        // assignment `a = TARGET = c`) so its receiver/index sub-expression is
        // evaluated exactly once even though the target is written to (and, for
        // a compound-operator link, read back — see
        // <see cref="FlattenChainedAssignment"/>) — the receiver of a member
        // access and the index of an element access are each spilled at most
        // once via <see cref="SpillOperand(GExpression, List{GStatement})"/>,
        // and the target is rebuilt from those (now-trivial) pieces (issue
        // #1731). A target that is already an identifier/`this`/literal, or a
        // member access whose receiver needs no spilling, passes through
        // untouched.
        private func MakeDuplicationSafeTarget(
            target GExpression,
            prologue List[GStatement],
            syntax ExpressionSyntax? = nil
        ) GExpression {
            switch target {
                case member is MemberAccessExpression {
                    return MemberAccessExpression(
                        this.MakeDuplicationSafeTarget(
                            member.Target,
                            prologue,
                            (syntax as MemberAccessExpressionSyntax)?.Expression
                        ),
                        member.MemberName
                    )
                }
                case index is IndexExpression {
                    // `^n` is contextual index syntax: spilling the whole expression
                    // turns `target[^n]` into `let i = ^n; target[i]`, which loses
                    // from-end semantics. Spill only `n` and keep `^` at the access.
                    let safeTarget = this.MakeDuplicationSafeTarget(
                        index.Target,
                        prologue,
                        (syntax as ElementAccessExpressionSyntax)?.Expression
                    )
                    let isFromEnd = syntax is ElementAccessExpressionSyntax elementAccess &&
                        elementAccess
                        .ArgumentList
                        .Arguments
                        .Count == 1 &&
                        elementAccess
                        .ArgumentList
                        .Arguments[0]
                        .Expression
                        .IsKind(SyntaxKind.IndexExpression)
                    if index.Indices.Count > 1 {
                        // Issue #4350: a multi-parameter indexer spills every
                        // argument, left to right, so each still runs once.
                        return IndexExpression(
                            safeTarget,
                            index.Indices.Select((i GExpression) -> this.SpillOperand(i, prologue)).ToList()
                        )
                    }
                    let safeIndex = if isFromEnd && index.Index is FromEndIndexExpression fromEnd {
                        cast[GExpression](FromEndIndexExpression(this.SpillOperand(fromEnd.Operand, prologue)))
                    } else {
                        this.SpillOperand(index.Index, prologue)
                    }
                    return IndexExpression(safeTarget, safeIndex)
                }
                default {
                    return this.SpillOperand(target, prologue)
                }
            }
        }

        // Establishes a fresh statement seam (issue #1731) around a single
        // value-producing translation that has no `TranslateStatement` seam of
        // its own — a member/lambda/local-function arrow body, which behaves
        // like an implicit `return expr;` statement. Any spill collected while
        // running `translate` is emitted immediately ahead of its result, then
        // the ambient seam is restored (mirrors <see cref="TranslateStatement"/>).
        private func WithSpillSeam(translate() -> IReadOnlyList[GStatement]) IReadOnlyList[GStatement] {
            let outerSpillPrologue = this.state.PendingSpillPrologue
            let outerOutDeclarations = this.state.FunctionArgumentOutDeclarations
            let spillPrologue = List[GStatement]()
            this.state.PendingSpillPrologue = spillPrologue
            this.state.FunctionArgumentOutDeclarations = spillPrologue
            try {
                let core = translate()
                if spillPrologue.Count == 0 {
                    return core
                }
                let combined = List[GStatement](spillPrologue)
                combined.AddRange(core)
                return combined
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
            }
        }

        private func TranslateLocalFunction(localFunction LocalFunctionStatementSyntax) IReadOnlyList[GStatement] {
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol unsupportedSuspending &&
                this
                .state
                .UnsupportedSuspendingRefCaptureLocalFunctions
                .Contains(unsupportedSuspending) {
                this.context.ReportUnsupported(
                    localFunction,
                    "recursive async or iterator local function '${localFunction.Identifier.Text}' captures storage written in its declaring scope; G# forbids the ref parameter needed to preserve that shared storage on a suspending helper."
                )
                return []GStatement{
                    RawStatement(
                        "// unsupported: suspending recursive local function '${localFunction.Identifier.Text}' requires a ref capture"
                    )
                }
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol unsupportedGeneric &&
                this
                .state
                .UnsupportedRecursiveEnclosingTypeParameterLocalFunctions
                .Contains(unsupportedGeneric) {
                this.context.ReportUnsupported(
                    localFunction,
                    "recursive local function '${localFunction.Identifier.Text}' cannot preserve an enclosing type parameter in G# lowering."
                )
                return []GStatement{
                    RawStatement(
                        "// unsupported: recursive local function '${localFunction.Identifier.Text}' cannot preserve an enclosing type parameter"
                    )
                }
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol unsupportedTopLevel &&
                this
                .state
                .UnsupportedTopLevelRecursiveLocalFunctions
                .Contains(unsupportedTopLevel) {
                this.context.ReportUnsupported(
                    localFunction,
                    "top-level recursive local function '${localFunction.Identifier.Text}' requires a member-helper fallback, but top-level statements have no containing aggregate for that helper."
                )
                return []GStatement{
                    RawStatement(
                        "// unsupported: top-level recursive local function '${localFunction.Identifier.Text}'"
                    )
                }
            }
            // Issue #4302: a lifted helper keeps `ref` on its own signature, but
            // a delegate or function value built from it is a value-returning
            // wrapper that drops the aliasing contract. Decide this before any
            // lift path returns, so every lowering of a ref-returning local
            // used as a value stays a loud gap.
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol refValueLocal &&
                (refValueLocal.ReturnsByRef || refValueLocal.ReturnsByRefReadonly) &&
                (
                this.IsLocalFunctionReferencedAsValue(
                    refValueLocal,
                    GetLocalFunctionSiblingStatements(localFunction)
                ) ||
                    this.IsLocalFunctionReferencedAsValueFromAnotherSwitchSection(refValueLocal, localFunction)
            ) {
                this.context.ReportUnsupported(
                    localFunction,
                    "ref-returning local function '${localFunction.Identifier.Text}' cannot be used as a delegate or function value in G#."
                )
                return []GStatement{
                    RawStatement("// unsupported: ref-returning local function '${localFunction.Identifier.Text}'")
                }
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol recursiveLocal &&
                this
                .state
                .LiftedRecursiveLocalFunctions
                .TryGetValue(recursiveLocal, out var recursiveLift) {
                if recursiveLift
                    .Captures
                    .Count > 0 &&
                    (
                    this.IsLocalFunctionReferencedAsValue(
                        recursiveLocal,
                        GetLocalFunctionSiblingStatements(localFunction)
                    ) ||
                        this.IsLocalFunctionReferencedAsValueFromAnotherSwitchSection(recursiveLocal, localFunction)
                ) {
                    this.context.ReportUnsupported(
                        localFunction,
                        "capturing recursive local function '${localFunction.Identifier.Text}' cannot be used as a delegate or function value after member lifting."
                    )
                    return []GStatement{
                        RawStatement(
                            "// unsupported: capturing recursive local function value '${localFunction.Identifier.Text}'"
                        )
                    }
                }
                if !this.state.EmittedLiftedRecursiveLocalFunctions.Add(recursiveLocal) {
                    return []GStatement{RawStatement("// lifted recursive local function ${recursiveLift.Name}")}
                }
                let liftedIsAsync = localFunction.Modifiers.Any(SyntaxKind.AsyncKeyword)
                let liftedParameters = this.MapParameters(recursiveLocal, localFunction.ParameterList, skipFirst: false)
                for capture in recursiveLift.Captures {
                    var captureType ITypeSymbol? = switch capture.Symbol {
                        case local is ILocalSymbol: local.Type
                        case parameter is IParameterSymbol: parameter.Type
                        default: default(ITypeSymbol?)
                    }
                    if captureType == nil {
                        continue
                    }
                    if captureType.IsReferenceType && !CaptureHasExplicitNullableType(capture.Symbol) {
                        captureType = captureType.WithNullableAnnotation(
                            Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated
                        )
                    }
                    liftedParameters.Add(
                        Parameter(
                            this.EmittedName(capture.Symbol, capture.Symbol.Name),
                            this.typeMapper.Map(captureType, this.context, capture.Symbol.Locations.FirstOrDefault()),
                            refKind: if capture.IsByRef {
                                "ref"
                            } else {
                                default(string?)
                            }
                        )
                    )
                }
                let liftedReturnType = this.MapDelegateLikeReturnType(
                    recursiveLocal,
                    liftedIsAsync,
                    localFunction.ReturnType.GetLocation()
                )
                let liftedTypeParameters = this.MapMethodTypeParameters(recursiveLocal)
                let liftedBody = this.TranslateBody(
                    localFunction,
                    "recursive local function '${localFunction.Identifier.Text}'"
                )
                let helper = MethodDeclaration(
                    recursiveLift.Name,
                    liftedParameters,
                    liftedReturnType,
                    liftedBody,
                    liftedTypeParameters,
                    visibility: Visibility.Private,
                    isAsync: liftedIsAsync,
                    isRefReturn: recursiveLocal.ReturnsByRef || recursiveLocal.ReturnsByRefReadonly,
                    isReadOnlyRefReturn: recursiveLocal.ReturnsByRefReadonly
                )
                if recursiveLift.IsStatic {
                    (
                        this
                            .state
                            .PendingStaticSynthHelpers ??
                            throw InvalidOperationException(
                            "A recursive static local-function lift must be emitted inside an aggregate."
                        )
                    ).Add(helper)
                } else {
                    (
                        this
                            .state
                            .PendingInstanceSynthHelpers ??
                            throw InvalidOperationException(
                            "A recursive instance local-function lift must be emitted inside an aggregate."
                        )
                    ).Add(helper)
                }
                return []GStatement{RawStatement("// lifted recursive local function ${recursiveLift.Name}")}
            }
            if localFunction.Modifiers.Any(SyntaxKind.StaticKeyword) && this.context.GetDeclaredSymbol(
                localFunction
            ) is IMethodSymbol staticLocal &&
                this
                .state
                .LiftedStaticLocalFunctions
                .TryGetValue(staticLocal, out var liftedName) &&
                this
                .state
                .PendingStaticSynthHelpers != nil {
                if !this.state.EmittedLiftedStaticLocalFunctions.Add(staticLocal) {
                    return []GStatement{RawStatement("// lifted static local function $liftedName")}
                }
                let liftedIsAsync = localFunction.Modifiers.Any(SyntaxKind.AsyncKeyword)
                let liftedParameters = this.MapParameters(staticLocal, localFunction.ParameterList, skipFirst: false)
                let liftedReturnType = this.MapDelegateLikeReturnType(
                    staticLocal,
                    liftedIsAsync,
                    localFunction.ReturnType.GetLocation()
                )
                let liftedTypeParameters = this.MapMethodTypeParameters(staticLocal)
                let liftedBody = this.TranslateBody(
                    localFunction,
                    "static local function '${localFunction.Identifier.Text}'"
                )
                this.state.PendingStaticSynthHelpers!!.Add(
                    MethodDeclaration(
                        liftedName,
                        liftedParameters,
                        liftedReturnType,
                        liftedBody,
                        liftedTypeParameters,
                        visibility: Visibility.Private,
                        isAsync: liftedIsAsync,
                        isRefReturn: staticLocal.ReturnsByRef || staticLocal.ReturnsByRefReadonly,
                        isReadOnlyRefReturn: staticLocal.ReturnsByRefReadonly
                    )
                )
                return []GStatement{RawStatement("// lifted static local function $liftedName")}
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol refLocalFunction &&
                (
                refLocalFunction.ReturnsByRefReadonly ||
                    (
                    refLocalFunction.ReturnsByRef &&
                        (
                        !refLocalFunction.IsStatic ||
                            refLocalFunction.IsGenericMethod ||
                            this.IsLocalFunctionReferencedAsValue(
                            refLocalFunction,
                            GetLocalFunctionSiblingStatements(localFunction)
                        ) ||
                            this.IsLocalFunctionReferencedFromAnotherSwitchSection(refLocalFunction, localFunction) ||
                            this.IsLocalFunctionReferencedBeforeDeclarationInSwitchSection(
                            refLocalFunction,
                            localFunction
                        )
                    )
                )
            ) {
                let refFunctionName = localFunction.Identifier.Text
                var reason string
                if refLocalFunction.ReturnsByRefReadonly {
                    reason = "ref-readonly local function '$refFunctionName' has no canonical G# function-literal form."
                } else if refLocalFunction.IsGenericMethod {
                    reason = "generic ref-returning local function '$refFunctionName' is not supported by G#'s direct function-literal form."
                } else if !refLocalFunction.IsStatic {
                    reason = "capturing ref-returning local function '$refFunctionName' cannot use G#'s direct function-literal form safely; declare it static or move it to a member."
                } else if this.IsLocalFunctionReferencedFromAnotherSwitchSection(refLocalFunction, localFunction) {
                    reason = "ref-returning local function '$refFunctionName' is referenced from another switch section, where its G# function literal is out of scope."
                } else if this.IsLocalFunctionReferencedBeforeDeclarationInSwitchSection(
                    refLocalFunction,
                    localFunction
                ) {
                    reason = "ref-returning local function '$refFunctionName' is referenced before its declaration in the switch section, where its G# function literal is not yet bound."
                } else {
                    reason = "ref-returning local function '$refFunctionName' cannot be used as a delegate or function value in G#."
                }
                this.context.ReportUnsupported(localFunction, reason)
                return []GStatement{
                    RawStatement("// unsupported: ref-returning local function '${localFunction.Identifier.Text}'")
                }
            }
            // A C# local function maps to a G# local `let` bound to a function
            // literal `func (params) RetType { … }` (NOT an arrow lambda — a local
            // function may be recursive and needs an explicit return type).
            let parameters = List[Parameter]()
            for parameter in localFunction.ParameterList.Parameters {
                parameters.Add(this.MapLambdaParameter(parameter))
            }
            let isAsync = localFunction.Modifiers.Any((m SyntaxToken) -> m.IsKind(SyntaxKind.AsyncKeyword))
            // A local function renders as a `func` literal (NOT an arrow lambda):
            // a value-returning one needs an explicit return type (else the literal
            // is inferred void and `return expr` is rejected), and the explicit type
            // also supports recursion. The declared symbol carries the real return
            // type / void-ness; the async unwrap mirrors method `func`s.
            let localSymbol IMethodSymbol? = this.context.GetDeclaredSymbol(localFunction) as IMethodSymbol
            let returnType = if localSymbol != nil {
                this.MapDelegateLikeReturnType(localSymbol, isAsync, localFunction.ReturnType.GetLocation())
            } else {
                default(GTypeReference?)
            }
            // A local function's body is its own evaluation scope: a spill hoisted
            // while translating it (issue #1731) must never leak into the
            // ENCLOSING statement's prologue (that would evaluate the operand once,
            // eagerly, at the local-function declaration instead of per call). The
            // ambient seam is suspended for the body's translation; each statement
            // inside a block body still opens its own fresh seam via
            // <see cref="TranslateStatement"/>.
            let outerSpillPrologue = this.state.PendingSpillPrologue
            let outerOutDeclarations = this.state.FunctionArgumentOutDeclarations
            let previousBodyScope = this.state.CurrentBodyScope
            this.state.PendingSpillPrologue = nil
            this.state.FunctionArgumentOutDeclarations = nil
            this.state.CurrentBodyScope = localFunction
            var lambda LambdaExpression
            try {
                if localFunction.Body != nil {
                    let innerBody = this.WithParameterShadows(localFunction, this.TranslateBlock(localFunction.Body))
                    lambda = LambdaExpression(
                        parameters,
                        blockBody: innerBody,
                        isAsync: isAsync,
                        returnType: returnType,
                        isFunctionLiteral: true,
                        isRefReturn: localSymbol?.ReturnsByRef == true
                    )
                } else if localFunction.ExpressionBody != nil {
                    // The expression body has no per-statement seam of its own
                    // (unlike a block body — see below), so a nested spill (issue
                    // #1731) must open a fresh seam here via
                    // <see cref="WithSpillSeam"/> — evaluated per call, inside this
                    // very body, rather than being silently dropped by the
                    // enclosing null seam above.
                    let innerBody = if localSymbol?.ReturnsVoid == false {
                        BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return List[GStatement]{
                                        ReturnStatement(
                                            this.TranslateValueWithNullForgiveness(
                                                localFunction.ExpressionBody!!.Expression
                                            ),
                                            isRef: localFunction.ExpressionBody!!.Expression is RefExpressionSyntax
                                        )
                                    }
                                }
                            )
                                .ToList()
                        )
                    } else {
                        BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return this.TranslateExpressionStatements(
                                        localFunction.ExpressionBody!!.Expression
                                    )!!.ToList()
                                }
                            )
                                .ToList()
                        )
                    }
                    lambda = LambdaExpression(
                        parameters,
                        blockBody: innerBody,
                        isAsync: isAsync,
                        returnType: returnType,
                        isFunctionLiteral: true,
                        isRefReturn: localSymbol?.ReturnsByRef == true
                    )
                } else {
                    lambda = LambdaExpression(
                        parameters,
                        blockBody: BlockStatement(List[GStatement]()),
                        isAsync: isAsync,
                        returnType: returnType,
                        isFunctionLiteral: true,
                        isRefReturn: localSymbol?.ReturnsByRef == true
                    )
                }
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
                this.state.CurrentBodyScope = previousBodyScope
            }
            // Issue #1886: a generic local function (`T First<T>(a, b) { ... }`)
            // carries its type parameters on the `let` binding, not the anonymous
            // function literal (which has no name to hang `[T]` off) — see
            // `let Name[T, U] = func (...) ... { ... }` in G#.
            let typeParameters List[string]? = localFunction
                .TypeParameterList
                ?.Parameters
                .Select((tp TypeParameterSyntax) -> this.EmittedName(tp, tp.Identifier)!!)
                .ToList()
            // Issue #3399: this local participates in a recursive/mutually
            // recursive SCC of capturing local functions — a bare non-recursive
            // `let` binding of the literal cannot reference itself, so gsc loses
            // the binding for every call (GS0130/GS0125). Lower the whole SCC via
            // G#'s nullable-function-local scheme instead: emit the members'
            // nil-initialized `var Name (… -> R)? = nil` declarations exactly once
            // (the first member translated in document order; all declarations
            // must precede the first assignment because a G# closure body cannot
            // reference a not-yet-declared sibling local), then assign this
            // member's function literal to its own local. SCC partners are
            // reached from a closure body through the nullable local via `!!`
            // (see the TranslateIdentifierName/Invocations rewrite). G#'s
            // capture-by-reference closures preserve C#'s shared mutation of the
            // captured sibling locals.
            if localSymbol != nil &&
                this
                .state
                .RecursiveLocalFunctionGroups
                .TryGetValue(localSymbol, out var recursiveBinding) {
                let statements = List[GStatement]()
                if !recursiveBinding.Members.Any(
                    (m IMethodSymbol) -> this.state.EmittedRecursiveGroupMembers.Contains(m)
                ) {
                    recursiveBinding.DeclarationsEmitted = true
                    for member in recursiveBinding.Members {
                        this.state.EmittedRecursiveGroupMembers.Add(member)
                    }
                    statements.AddRange(recursiveBinding.Declarations)
                }
                statements.Add(AssignmentStatement(IdentifierExpression(recursiveBinding.NameOf(localSymbol)), lambda))
                return statements
            }
            return []GStatement{
                LocalFunctionStatement(
                    this.EmittedName(localSymbol, localFunction.Identifier.ValueText),
                    lambda,
                    typeParameters
                )
            }
        }

        shared {
            private func OperationExpression(operation IOperation) ExpressionSyntax? {
                var operation = operation
                if operation is IInstanceReferenceOperation &&
                    operation.IsImplicit == true ||
                    operation is IMethodReferenceOperation {
                    return nil
                }
                if operation is IArgumentOperation argument {
                    return argument.Value.Syntax as ExpressionSyntax
                }
                while operation.IsImplicit && operation.ChildOperations.Count() == 1 {
                    operation = operation.ChildOperations.Single()
                }
                return operation.Syntax as ExpressionSyntax
            }

            private func AssignmentRequiresStatementLowering(
                assignment AssignmentExpressionSyntax
            ) bool -> assignment.Left is TupleExpressionSyntax ||
                (
                assignment.Left is DeclarationExpressionSyntax and {Designation: ParenthesizedVariableDesignationSyntax}
            )

            // Issue #3348: the sub-expressions of `query` that are evaluated EAGERLY, in
            // the scope enclosing the query, rather than inside one of the lambdas its
            // clauses lower to — the first `from`'s source, and every `join`'s `in`
            // source (including those in an `into` continuation's body). C# forbids both
            // from referencing a range variable, so a hoist out of either is safe.
            // Everything else in a query is a clause body and belongs to its own lambda.
            private func EagerQuerySources(query QueryExpressionSyntax) sequence[ExpressionSyntax] {
                yield query.FromClause.Expression
                for var body QueryBodySyntax? = query.Body; body != nil; body = body!!.Continuation?.Body {
                    for clause in body.Clauses {
                        if clause is JoinClauseSyntax join {
                            yield join.InExpression
                        }
                    }
                }
            }

            // Conditional and switch-expression arms own block-expression seams. An
            // enclosing seam must leave each assignment inside its selected arm.
            private func IsInsideConditionalValueBranch(node SyntaxNode, root ExpressionSyntax?) bool {
                for var current SyntaxNode? = node; current != nil && current != root; current = current!!.Parent {
                    let parent SyntaxNode? = current.Parent
                    if parent is ConditionalExpressionSyntax conditional &&
                        (current == conditional.WhenTrue || current == conditional.WhenFalse) {
                        return true
                    }
                    if parent is SwitchExpressionArmSyntax switchArm && current == switchArm.Expression {
                        return true
                    }
                }
                return false
            }

            // True when `node` is reached only through a not-always-evaluated operand
            // inside `root`: the right operand of `&&`/`||`/`??`, or the "when not
            // null" side of a `?.`/`?[...]` conditional-access chain (including any
            // member/element access further chained off it).
            private func IsInShortCircuitedSubexpression(node SyntaxNode, root ExpressionSyntax?) bool {
                for var current SyntaxNode? = node; current != nil && current != root; current = current!!.Parent {
                    let parent SyntaxNode? = current.Parent
                    if parent is BinaryExpressionSyntax binary &&
                        (
                        binary.IsKind(SyntaxKind.LogicalAndExpression) || binary.IsKind(
                            SyntaxKind.LogicalOrExpression
                        ) ||
                            binary.IsKind(SyntaxKind.CoalesceExpression)
                    ) &&
                        current == binary.Right {
                        return true
                    }
                    if parent is ConditionalAccessExpressionSyntax conditionalAccess &&
                        current == conditionalAccess.WhenNotNull {
                        return true
                    }
                }
                return false
            }

            private func CollectEmbeddedPostfix(expression ExpressionSyntax?) List[PostfixUnaryExpressionSyntax] {
                // Collect eagerly evaluated `i++` / `i--` nodes in document order.
                // Conditional/short-circuited operands keep G#'s native inline form.
                return expression!!
                    .DescendantNodes(
                    descendIntoChildren: (node SyntaxNode) -> !(
                        (node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax)
                    )
                )
                    .OfType[PostfixUnaryExpressionSyntax]()
                    .Where(
                    (p PostfixUnaryExpressionSyntax) -> p.IsKind(SyntaxKind.PostIncrementExpression) || p.IsKind(
                        SyntaxKind.PostDecrementExpression
                    )
                )
                    .Where((p PostfixUnaryExpressionSyntax) -> !IsInsideConditionalValueBranch(p, expression))
                    .Where((p PostfixUnaryExpressionSyntax) -> !IsInShortCircuitedSubexpression(p, expression))
                    .ToList()
            }

            // Maps a C# compound-assignment operator token (`+=`, `-=`, …) to its
            // underlying binary operator (`+`, `-`, …), or null for `??=` (which
            // has no side-effect-preserving binary-expression equivalent — see
            // <see cref="FlattenChainedAssignment"/>).
            private func CompoundToBinaryOperator(compoundOp string) string? -> switch compoundOp {
                case "+=": "+"
                case "-=": "-"
                case "*=": "*"
                case "/=": "/"
                case "%=": "%"
                case "&=": "&"
                case "|=": "|"
                case "^=": "^"
                case "<<=": "<<"
                case ">>=": ">>"
                case ">>>=": ">>>"
                default: default(string?)
            }

            private func FindNestedFunction(node SyntaxNode?, body SyntaxNode) SyntaxNode? {
                for var current SyntaxNode? = node; current != nil && current != body; current = current!!.Parent {
                    if current is AnonymousFunctionExpressionSyntax || current is LocalFunctionStatementSyntax {
                        return current
                    }
                }
                return nil
            }

            private func IsDeclaredInNestedFunction(symbol ISymbol?, body SyntaxNode) bool {
                for reference in symbol!!.DeclaringSyntaxReferences {
                    if reference.SyntaxTree != body.SyntaxTree || !body.Span.Contains(reference.Span) {
                        continue
                    }
                    let declaration = reference.GetSyntax()
                    if FindNestedFunction(declaration.Parent, body) != nil {
                        return true
                    }
                }
                return false
            }

            // True when duplicating `expression` in the output has no observable
            // effect — a bare identifier, `this`, literal, or type-name receiver never
            // has a side effect and always denotes the same value/name, so it is safe
            // to embed at more than one output position without spilling it to a temp
            // first (issue #1731). Anything else (a method/property/indexer read, an
            // arithmetic expression, …) may run a side effect or re-read a mutable
            // value and must be evaluated exactly once if it needs to appear more than
            // once.
            private func IsTrivialOperand(expression GExpression) bool -> expression is IdentifierExpression ||
                expression is ThisExpression ||
                expression is LiteralExpression ||
                expression is TypeExpression

            private func CaptureHasExplicitNullableType(symbol ISymbol) bool {
                for reference in symbol.DeclaringSyntaxReferences {
                    let syntax = reference.GetSyntax()
                    let type = (
                        switch syntax {
                            case parameter is ParameterSyntax: parameter.Type
                            case VariableDeclaratorSyntax{
                                Parent: VariableDeclarationSyntax declaration
                            }: declaration.Type
                            default: default(TypeSyntax?)
                        }
                    )!!
                    if type is NullableTypeSyntax {
                        return true
                    }
                }
                return false
            }

            /// Parenthesizes a statement-condition whose printed form would otherwise be
            /// misparsed. A condition ending in an index expression (`… a[i]`) directly
            /// precedes the block's `{`, which the G# parser greedily reads as a
            /// composite-literal initializer (`a[i]{ … }`); wrapping the condition in
            /// parentheses disambiguates it (G# parser limitation; see PR notes).
            private func GuardBlockCondition(condition GExpression) GExpression {
                if condition is ParenthesizedExpression {
                    return condition
                }
                return if EndsWithIndexExpression(condition) {
                    cast[GExpression](ParenthesizedExpression(condition))
                } else {
                    condition
                }
            }

            private func EndsWithIndexExpression(expression GExpression) bool {
                return switch expression {
                    case _ is IndexExpression: true
                    case binary is BinaryExpression: EndsWithIndexExpression(binary.Right)
                    default: false
                }
            }
        }
    }
}
