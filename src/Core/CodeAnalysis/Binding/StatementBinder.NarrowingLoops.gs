// <copyright file="StatementBinder.NarrowingLoops.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq

/// ADR-0213 section 20, slice L0: the loop comparison. At each loop whose entry
/// state holds a fact, the binder computes the lower bound `Lower(S, R)` of
/// section 6 from the walker (cref:RegionEffectScanner) and compares it, fact by
/// fact, with what today's back-edge analysis removes. It writes every
/// disagreement to the `.loops` report of (cref:NarrowingComparison). At each
/// function with a backward `goto` it computes the span of section 11 and
/// reports it.
/// @remarks Nothing here changes the frames, the diagnostics or the bound tree.
/// The mechanism is off unless (cref:NarrowingComparison.LoopsEnabled) is true.
internal partial class StatementBinder {
    private var regionScanner RegionEffectScanner? = nil

    private func GetRegionScanner() RegionEffectScanner {
        if regionScanner == nil {
            regionScanner = RegionEffectScanner()
        }
        return regionScanner!!
    }

    /// The decision of the consumer rule of section 7 for one fact.
    private sealed class RegionKillDecision {
        init(killed bool, rule string, row string) {
            Killed = killed
            Rule = rule
            Row = row
        }

        prop Killed bool {
            get;
        }

        /// Gets the rule that decided: W1 to W8, P7 or a shared predicate (A2, A3).
        prop Rule string {
            get;
        }

        /// Gets the row of ADR-0213 section 16 that the kill belongs to, or `-`.
        prop Row string {
            get;
        }
    }

    /// The writes of a region resolved at the entry scope of the region.
    private sealed class ResolvedRegionWrites {
        init() {
            Roots = List[VariableSymbol]()
            Writes = List[List[RegionWrite]]()
            ImplicitMemberWrite = false
            WritesViaCallArgument = false
        }

        prop Roots List[VariableSymbol] {
            get;
        }

        prop Writes List[List[RegionWrite]] {
            get;
        }

        /// Whether a write names a field or a property of the enclosing type (rule W1).
        prop ImplicitMemberWrite bool {
            get;
            set;
        }

        prop WritesViaCallArgument bool {
            get;
            set;
        }
    }

    private func SameRoot(first VariableSymbol, second VariableSymbol) bool {
        if object.ReferenceEquals(first, second) {
            return true
        }
        // A lookup of an implicit member makes a new symbol each time. The member is the identity.
        let firstImplicit = first is ImplicitFieldVariableSymbol or
            ImplicitPropertyVariableSymbol or
            ImplicitStaticFieldVariableSymbol or
            ImplicitStaticPropertyVariableSymbol
        return firstImplicit && first.GetType() == second.GetType() && first.Name == second.Name
    }

    private func ResolveRegionWrites(effects RegionEffects) ResolvedRegionWrites {
        let resolved = ResolvedRegionWrites()
        for write in effects.Writes {
            if write.ViaCallArgument {
                resolved.WritesViaCallArgument = true
            }
            let symbol = $scope.TryLookupSymbol(write.Name)
            if symbol is not VariableSymbol variable {
                continue
            }
            if variable is ImplicitFieldVariableSymbol or
                ImplicitPropertyVariableSymbol or
                ImplicitStaticFieldVariableSymbol or
                ImplicitStaticPropertyVariableSymbol {
                resolved.ImplicitMemberWrite = true
            }
            var index = -1
            for var i = 0; i < resolved.Roots.Count; i++ {
                if SameRoot(resolved.Roots[i], variable) {
                    index = i
                    break
                }
            }
            if index < 0 {
                resolved.Roots.Add(variable)
                resolved.Writes.Add(List[RegionWrite]())
                index = resolved.Roots.Count - 1
            }
            resolved.Writes[index].Add(write)
        }
        return resolved
    }

    // The variables that one call of the region passes more than once with at least one `ref`/`out`
    // (ADR-0208 R12, amendment A3): the aliasing is visible at the call site.
    private func IsCallAliasedName(effects RegionEffects, name string) bool {
        for call in effects.Calls {
            var byReference = 0
            var byValue = 0
            for text in call.ByReferenceNames {
                if text == name {
                    byReference++
                }
            }
            for text in call.ByValueNames {
                if text == name {
                    byValue++
                }
            }
            if byReference > 0 && byReference + byValue >= 2 {
                return true
            }
        }
        return false
    }

    private func CallIsIndirect(call RegionCall) bool {
        switch call.Kind {
            case RegionCallKind.NamedInvocation {
                let symbol = $scope.TryLookupSymbol(call.CalleeName)
                // A function value, a parameter of function type, or a name that resolves to nothing.
                return symbol is VariableSymbol || symbol == nil
            }
            case RegionCallKind.ExpressionInvocation, RegionCallKind.Construction, RegionCallKind.Other {
                return true
            }
            default {
                // A member call is a plain call here: ADR-0208 amendment A3 keeps by-reference storage
                // across a call to a method. The walker does not tell a method from a function-typed field.
                return false
            }
        }
    }

    private func StripAllNullability(type TypeSymbol?) TypeSymbol? -> StripNullability(type)

    /// Whether the fact at [`path`](paramref) is a type-test fact: the narrowed type differs from
    /// the declared type with one nullable layer removed. A member path is never one here.
    private func FactKind(path AccessPath, narrowedType TypeSymbol) string {
        if path.HasMembers {
            return "member"
        }
        let declared = StripAllNullability(path.Root.Type)
        return if declared != nil && object.Equals(declared, StripAllNullability(narrowedType)) {
            "nullability"
        } else {
            "type-test"
        }
    }

    /// Resolves a construction type name at the entry scope of the region, or `nil` when the name
    /// is a variable or a function (a callable shadowing a type name takes call binding, probe d2).
    private func ResolveConstructedType(name string) TypeSymbol? {
        let symbol = $scope.TryLookupSymbol(name)
        if symbol is VariableSymbol {
            return nil
        }
        if symbol is FunctionSymbol || !$scope.TryLookupFunctions(name).IsDefaultOrEmpty {
            return nil
        }
        if $scope.TryLookupTypeAlias(name, out var aliased) {
            return aliased
        }
        var imported ImportedClassSymbol? = nil
        if $scope.TryLookupImportedClass(name, nil, out imported) && imported != nil {
            return TypeSymbol.FromClrTypeWithoutNullability(imported.ClassType, NullabilityFreeReason.ResolvedTypeName)
        }
        return nil
    }

    // Proof rule P7 (ADR-0213 section 8) for one write to a root with a fact of the given type.
    // The write proves the nullability fact and the type-test fact separately.
    private func WriteProves(
        root VariableSymbol,
        write RegionWrite,
        narrowedType TypeSymbol,
        factKind string,
        out why string
    ) bool {
        why = "no-proof"
        if !SmartCastStability.IsAssignmentNarrowingRoot(root) || IsExternalStorageAlias(root) {
            why = "root-not-exact-storage"
            return false
        }
        if write.ViaCallArgument {
            why = "written-through-reference"
            return false
        }
        let declared = StripAllNullability(root.Type)
        switch write.Proof {
            case RegionWriteProof.NonNilLiteral {
                if declared == nil || !IsReferenceLikeType(declared) {
                    why = "literal-into-value-type"
                    return false
                }
                if factKind == "type-test" && !ConvertsImplicitly(TypeSymbol.String, narrowedType) {
                    why = "literal-type-differs"
                    return false
                }
                return true
            }
            case RegionWriteProof.NullAssertion {
                if factKind == "type-test" {
                    why = "null-assertion-proves-nullability-only"
                    return false
                }
                return true
            }
            case RegionWriteProof.Construction {
                if write.ConstructedTypeName == nil {
                    return false
                }
                let typeName = write.ConstructedTypeName
                let callee = $scope.TryLookupSymbol(typeName)
                if callee is VariableSymbol or FunctionSymbol {
                    // A callable takes call binding before a type of the same name (probe d2).
                    why = "call"
                    return false
                }
                let constructed = ResolveConstructedType(typeName)
                if constructed == nil {
                    why = "construction-type-unresolved"
                    return false
                }
                if !IsReferenceLikeType(constructed) || constructed is NullableTypeSymbol {
                    why = "construction-of-value-type"
                    return false
                }
                if declared != nil && !ConvertsImplicitly(constructed, declared) {
                    why = "construction-type-differs"
                    return false
                }
                if factKind == "type-test" && !ConvertsImplicitly(constructed, narrowedType) {
                    why = "construction-not-the-fact-type"
                    return false
                }
                return true
            }
            default {
                if write.RightSideName != nil {
                    why = "variable"
                    // Question 4: a pattern-bound name is immutable and non-null by its construct.
                    if write.RightSideDeclaration == "pattern" || write.RightSideDeclaration == "binding" {
                        why = "variable:pattern-bound"
                    } else if write.RightSideDeclaration == nil {
                        let symbol = $scope.TryLookupSymbol(write.RightSideName)
                        if symbol is VariableSymbol source &&
                            source.DeclaringSyntax is {} declaration &&
                            (
                            declaration.Kind == SyntaxKind.TypePattern ||
                                declaration.Kind == SyntaxKind.VarPattern ||
                                declaration.Kind == SyntaxKind.IfLetBindingClause
                        ) {
                            why = "variable:pattern-bound"
                        }
                    }
                }
                return false
            }
        }
    }

    private func ConvertsImplicitly(from TypeSymbol, to TypeSymbol) bool {
        let conversion = Conversion.Classify(from, to)
        return conversion.Exists && conversion.IsImplicit
    }

    /// The consumer rule of ADR-0213 section 7, steps (i) to (vii), for one fact.
    private func DecideRegionKill(
        path AccessPath,
        narrowedType TypeSymbol,
        effects RegionEffects,
        resolved ResolvedRegionWrites,
        filterNames HashSet[string]?
    ) RegionKillDecision {
        let root = path.Root
        // (i) the closed kind list.
        if effects.ContainsUnknownKind {
            return RegionKillDecision(true, "W6", "-")
        }
        let callLike = effects.ContainsCall || effects.ContainsSuspension || effects.ContainsIteration
        // Rule W5: every member or index read is an unknown getter, which is a call.
        let readLike = effects.ContainsMemberRead
        let memberWrite = effects.ContainsMemberWrite || effects.ContainsPointerWrite || resolved.ImplicitMemberWrite
        let mayMutateMemberPaths = callLike || readLike || memberWrite
        var indirectCall = effects.ContainsIteration || effects.ContainsSuspension
        for call in effects.Calls {
            if CallIsIndirect(call) {
                indirectCall = true
            }
        }
        let mayMutateReferenceStorage = memberWrite || readLike || indirectCall
        let mayMutateAnyRoot = callLike || readLike
        let callRule = if callLike {
            "W4"
        } else if readLike {
            "W5"
        } else {
            "W3"
        }
        let callRow = if callLike {
            "R7 c"
        } else if readLike {
            "R7 e"
        } else {
            "-"
        }
        // (ii) a member-bearing path drops on a member write, a call or a member read.
        if path.HasMembers && mayMutateMemberPaths {
            return RegionKillDecision(true, callRule + "(member-path)", callRow)
        }
        // (iii) a root replacement kills every descendant path.
        var rootWritten = false
        for written in resolved.Roots {
            if SameRoot(written, root) {
                rootWritten = true
            }
        }
        if path.HasMembers && rootWritten {
            return RegionKillDecision(true, "W2(root-replaced)", "-")
        }
        // (iv) the shared predicate for every effect other than a plain write to this root.
        if filterNames != nil && effects.ContainsHandler {
            if filterNames.Contains(root.Name) || MayBeMutatedByUnknownCallable(path) {
                return RegionKillDecision(true, "W8", "R10")
            }
        }
        // ADR-0208 amendment A3: a plain call does not kill the fact of a by-reference parameter. A callable of
        // unknown origin and user code the table lists (a getter, a constructor, a loop header) keep the full kill.
        let unknownWrite = if indirectCall {
            MayBeMutatedByUnknownWrite(mayMutateAnyRoot, effects.ContainsPointerWrite, path)
        } else {
            MayBeMutatedByUnknownWrite(mayMutateAnyRoot && !IsByReferenceRoot(root), effects.ContainsPointerWrite, path)
        }
        if unknownWrite {
            return RegionKillDecision(
                true,
                if effects.ContainsPointerWrite {
                    "W3(pointer-write)"
                } else {
                    callRule + "(unknown-write)"
                },
                if effects.ContainsPointerWrite {
                    "-"
                } else {
                    callRow
                }
            )
        }
        if (callLike || readLike) && root is GlobalVariableSymbol && !root.IsReadOnly {
            return RegionKillDecision(true, callRule + "(global)", callRow)
        }
        if resolved.WritesViaCallArgument || indirectCall {
            if root is ParameterSymbol parameter &&
                (parameter.RefKind == RefKind.Ref || parameter.RefKind == RefKind.Out) &&
                indirectCall {
                return RegionKillDecision(true, "A3(indirect-call-on-by-reference-parameter)", "R7 c")
            }
        }
        if DropsOnMemberMutation(path, mayMutateMemberPaths, mayMutateReferenceStorage) {
            return RegionKillDecision(
                true,
                callRule + "(alias-class)",
                if mayMutateReferenceStorage && !memberWrite {
                    callRow
                } else {
                    "-"
                }
            )
        }
        for var i = 0; i < resolved.Roots.Count; i++ {
            let written = resolved.Roots[i]
            if SameRoot(written, root) {
                continue
            }
            var onlyThroughCalls = true
            for write in resolved.Writes[i] {
                if !write.ViaCallArgument {
                    onlyThroughCalls = false
                }
            }
            if onlyThroughCalls && IsCallAliasedName(effects, written.Name) {
                onlyThroughCalls = false
            }
            let shares = if onlyThroughCalls {
                ChainsOverlap(written, root)
            } else {
                MayShareStorage(written, root)
            }
            if shares {
                return RegionKillDecision(true, "W3(shares-storage)", "-")
            }
        }
        // (v) and (vi) a write to this root keeps the fact only when every write proves it (rule P7).
        for var i = 0; i < resolved.Roots.Count; i++ {
            if !SameRoot(resolved.Roots[i], root) {
                continue
            }
            let kind = FactKind(path, narrowedType)
            var allWritesProve = true
            var anyOffExitPath = false
            var firstWhy = ""
            var nullabilityStillProved = true
            for write in resolved.Writes[i] {
                if !WriteProves(root, write, narrowedType, kind, out var why) {
                    allWritesProve = false
                    if !write.FollowedByExit {
                        anyOffExitPath = true
                    }
                    if firstWhy.Length == 0 {
                        firstWhy = why
                    }
                    if !WriteProves(root, write, StripAllNullability(root.Type) ?? narrowedType, "nullability", out _) {
                        nullabilityStillProved = false
                    }
                }
            }
            if !allWritesProve {
                let row = if kind == "type-test" && nullabilityStillProved {
                    "R7 d"
                } else if anyOffExitPath {
                    "R7 b"
                } else {
                    "R7 a"
                }
                return RegionKillDecision(true, "P7(${firstWhy})", row)
            }
        }
        // (vii) otherwise keep.
        return RegionKillDecision(false, "-", "-")
    }

    /// The loop comparison of slice L0. [`body`](paramref) is the body of a loop that was bound once
    /// under the entry facts of [`snapshots`](paramref).
    private func ReportLoopComparison(
        body StatementSyntax,
        snapshots[]Dictionary[AccessPath, TypeSymbol],
        frameCount int32,
        invalidations List[(FrameIndex int32, Path AccessPath)]
    ) {
        let loop = body.Parent
        if loop == nil || RegionEffectKindTable.Classify(loop.Kind) != RegionEffectClass.Loop {
            NarrowingComparison.ReportLoopSummary(body.Location, -1, 0, 0, "no-loop-parent")
            return
        }
        let scanner = GetRegionScanner()
        let visitedBefore = scanner.NodesVisited
        let regionsBefore = scanner.Regions
        let effects = scanner.ScanLoop(loop)
        if scanner.Regions != regionsBefore {
            CompilationMeasurements.Count("narrowing.region-walks")
            CompilationMeasurements.Count("narrowing.region-nodes", cast[int64](scanner.NodesVisited - visitedBefore))
        }
        // S: the facts of the frames the loop inherits, the innermost frame first.
        let paths = List[AccessPath]()
        let types = List[TypeSymbol]()
        let frameIndexes = List[int32]()
        for var i = Math.Min(frameCount, snapshots.Length) - 1; i >= 0; i-- {
            for entry in snapshots[i] {
                var seen = false
                for existing in paths {
                    if existing.Equals(entry.Key) {
                        seen = true
                        break
                    }
                }
                if !seen {
                    paths.Add(entry.Key)
                    types.Add(entry.Value)
                    frameIndexes.Add(i)
                }
            }
        }
        if paths.Count == 0 {
            return
        }
        let resolved = ResolveRegionWrites(effects)
        var filterNames HashSet[string]? = nil
        if effects.ContainsHandler {
            let filters = CollectCatchFiltersAbove(loop)
            if filters.Count > 0 {
                filterNames = CollectEnclosingFilterNames(filters)
            }
        }
        var killedByBoth = 0
        var keptByBoth = 0
        var memberReadsWithLiveFacts = 0
        let location = loop.Location
        for var i = 0; i < paths.Count; i++ {
            let path = paths[i]
            var oldKilled = false
            for (frameIndex, killedPath) in invalidations {
                if frameIndex == frameIndexes[i] && killedPath.Equals(path) {
                    oldKilled = true
                    break
                }
            }
            let decision = DecideRegionKill(path, types[i], effects, resolved, filterNames)
            if decision.Killed {
                CompilationMeasurements.Count("narrowing.region-facts-killed")
            }
            if oldKilled && decision.Killed {
                killedByBoth++
            } else if !oldKilled && !decision.Killed {
                keptByBoth++
            } else if decision.Killed {
                NarrowingComparison.ReportLoopDisagreement(
                    location,
                    path.ToString(),
                    FactKind(path, types[i]),
                    "old-kept/new-killed",
                    decision.Rule,
                    decision.Row
                )
            } else {
                // The walker keeps a fact that today's analysis removes. Rule P7 explains the
                // construction forms (row R7 (d)). Anything else is a defect of the ADR.
                var rowText = "UNCLASSIFIED"
                var ruleText = "none"
                for var r = 0; r < resolved.Roots.Count; r++ {
                    if SameRoot(resolved.Roots[r], path.Root) {
                        ruleText = "P7(kept)"
                        rowText = "R7 d"
                    }
                }
                NarrowingComparison.ReportLoopDisagreement(
                    location,
                    path.ToString(),
                    FactKind(path, types[i]),
                    "old-killed/new-kept",
                    ruleText,
                    rowText
                )
            }
            if effects.MemberReadCount > 0 && MayBeMutatedByUnknownCallable(path) {
                memberReadsWithLiveFacts++
            }
        }
        if effects.MemberReadCount > 0 {
            CompilationMeasurements.Count("narrowing.region-member-reads", cast[int64](effects.MemberReadCount))
            if memberReadsWithLiveFacts > 0 {
                CompilationMeasurements.Count(
                    "narrowing.region-member-reads-with-live-facts",
                    cast[int64](effects.MemberReadCount)
                )
            }
        }
        NarrowingComparison.ReportLoopSummary(
            location,
            paths.Count,
            killedByBoth,
            keptByBoth,
            "nodes=${effects.NodesVisited} reads=${effects.MemberReadCount} ${effects}"
        )
    }

    /// Row R7 (f): the facts that the header of a loop proves when the loop ends and that no frame
    /// holds after the loop today. The report lists the `!!` sites after the loop on the same path.
    private func ReportLoopExitGain(loopBody StatementSyntax, condition BoundExpression?) {
        if condition == nil {
            return
        }
        let loop = loopBody.Parent
        if loop == nil {
            return
        }
        let elseFacts = ComputeConditionNarrowing(condition).Else
        if elseFacts == nil {
            return
        }
        let location = loop.Location
        let hasBreak = ContainsBreakFor(loopBody)
        for entry in elseFacts {
            // The frames hold the state after the loop. A fact that they hold is not a gain.
            if binderCtx.NarrowedVariables.Query(entry.Key) != nil {
                continue
            }
            let text = if entry.Key.HasMembers {
                ""
            } else {
                entry.Key.Root.Name
            }
            let sites = FindBangSitesAfter(loop, text)
            NarrowingComparison.ReportLoopExitGain(location, entry.Key.ToString(), hasBreak, sites)
        }
    }

    private func ContainsBreakFor(node SyntaxNode) bool {
        if node.Kind == SyntaxKind.BreakStatement {
            return true
        }
        for child in node.GetChildren() {
            if ContainsBreakFor(child) {
                return true
            }
        }
        return false
    }

    // The `name!!` sites after the loop in its statement list and in the lists that enclose it, up to
    // the function. An upper bound: the walk does not stop at a write to the name.
    private func FindBangSitesAfter(loop SyntaxNode, name string) string {
        if name.Length == 0 {
            return "-"
        }
        let sites = List[string]()
        var child SyntaxNode = loop
        var parent = loop.Parent
        while parent != nil {
            if parent is BlockStatementSyntax block {
                var seenChild = false
                for statement in block.Statements {
                    if seenChild {
                        CollectBangSites(statement, name, sites)
                    } else if object.ReferenceEquals(statement, child) {
                        seenChild = true
                    }
                }
            }
            if parent is FunctionDeclarationSyntax or
                FunctionLiteralExpressionSyntax or
                LambdaExpressionSyntax or
                ConstructorDeclarationSyntax or
                PropertyAccessorSyntax {
                break
            }
            child = parent
            parent = parent.Parent
        }
        return if sites.Count == 0 {
            "-"
        } else {
            string.Join(";", sites)
        }
    }

    private func CollectBangSites(node SyntaxNode, name string, sites List[string]) {
        if node is UnaryExpressionSyntax{OperatorToken: {Kind: SyntaxKind.BangBangToken}} assertion {
            var operand ExpressionSyntax = assertion.Operand
            while operand is ParenthesizedExpressionSyntax parenthesized {
                operand = parenthesized.Expression
            }
            if operand is NameExpressionSyntax identifier && identifier.IdentifierToken.ValueText == name {
                sites.Add(NarrowingComparison.Format(assertion.Location))
            }
        }
        for child in node.GetChildren() {
            CollectBangSites(child, name, sites)
        }
    }

    /// Computes and reports the backward-jump span of the function that holds the label at
    /// [`labeled`](paramref) (ADR-0213 section 11). A function asks once per label, and it counts once.
    private func ReportBackwardJumpSpan(labeled SyntaxNode) {
        var function SyntaxNode? = nil
        for var current SyntaxNode? = cast[SyntaxNode?](labeled); current != nil; current = current!!.Parent {
            if current is FunctionDeclarationSyntax or
                FunctionLiteralExpressionSyntax or
                LambdaExpressionSyntax or
                ConstructorDeclarationSyntax or
                PropertyAccessorSyntax or
                EventAccessorSyntax or
                DeinitDeclarationSyntax {
                function = current
                break
            }
        }
        if function == nil {
            return
        }
        let location = function.Location
        if !NarrowingComparison.TryRegisterSpanFunction(
            NarrowingComparison.Format(location) + ":" + function.Span.Start.ToString()
        ) {
            return
        }
        var body BlockStatementSyntax? = nil
        if function is FunctionDeclarationSyntax declaration {
            body = declaration.Body
        } else if function is FunctionLiteralExpressionSyntax literal {
            body = literal.Body
        } else if function is ConstructorDeclarationSyntax constructor {
            body = constructor.Body
        } else if function is PropertyAccessorSyntax accessor {
            body = accessor.Body as BlockStatementSyntax
        }
        if body == nil {
            return
        }
        let span = BackwardJumpSpans.Compute(body)
        if span == nil {
            return
        }
        CompilationMeasurements.Count("narrowing.spans")
        let effects = GetRegionScanner().ScanStatements(span.Statements())
        NarrowingComparison.ReportSpan(
            span.Block.Statements[span.FirstIndex].Location,
            "labels=${string.Join(",", span.Labels)} gotos=${span.GotoCount}",
            effects.ToString()
        )
    }
}
