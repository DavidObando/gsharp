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

        /// Whether an operator of the region may be user-defined: an operand is not a plain name or a literal, or
        /// a name that is an operand has a type that is not built in.
        prop RunsUserOperator bool {
            get;
            set;
        }

        /// Whether the region writes a bare property (a setter), or converts a value in a package that declares a
        /// user-defined conversion (rule W4).
        prop RunsUserCodeOnWrite bool {
            get;
            set;
        }

        /// Whether a bare name that the region reads binds to a property of the enclosing type (rule W5).
        prop ReadsProperty bool {
            get;
            set;
        }
    }

    private var packageDeclaresConversions bool? = nil

    // Whether a type of the package declares a user-defined conversion operator.
    private func PackageDeclaresConversions() bool {
        if packageDeclaresConversions == nil {
            var found = false
            for declared in $scope.GetDeclaredStructs() {
                for method in declared.StaticMethods {
                    if method.Name == "op_Implicit" || method.Name == "op_Explicit" {
                        found = true
                    }
                }
            }
            packageDeclaresConversions = found
        }
        return packageDeclaresConversions == true
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
        if effects.ContainsConversionCandidate {
            resolved.RunsUserCodeOnWrite = true
        }
        // A returned name or constant runs no conversion operator when its type keeps its representation in the
        // return type, or when the return type is built in (a user conversion needs a type of the package).
        let enclosing = function
        let returnType = if enclosing == nil || enclosing.IsReturnTypeInferred {
            default(TypeSymbol?)
        } else {
            StripAllNullability(enclosing.Type)
        }
        if effects.ReturnsConstant && (returnType == nil || !MetadataTypeKeys.IsBuiltIn(returnType)) {
            resolved.RunsUserCodeOnWrite = true
        }
        for name in effects.ReturnedNames {
            let returned = if $scope.TryLookupSymbol(name) is VariableSymbol variable {
                StripAllNullability(variable.Type)
            } else {
                default(TypeSymbol?)
            }
            if returned == nil || returnType == nil || !Conversion.IsRepresentationPreservingImplicit(
                returned,
                returnType
            ) {
                resolved.RunsUserCodeOnWrite = true
            }
        }
        if effects.ContainsOperatorCandidate {
            resolved.RunsUserOperator = effects.OperatorHasUnresolvedOperand
            for name in effects.OperatorOperandNames {
                // A declaration of the region is not found here, and its type is unknown: it counts.
                if $scope.TryLookupSymbol(name) is VariableSymbol operand {
                    let operandType = StripAllNullability(operand.Type)
                    // `object` can hold a value of a type with operators.
                    if operandType == nil || !MetadataTypeKeys.IsBuiltIn(operandType) || object.Equals(
                        operandType,
                        TypeSymbol.Object
                    ) {
                        resolved.RunsUserOperator = true
                    }
                } else {
                    resolved.RunsUserOperator = true
                }
            }
        }
        for name in effects.NilCompareOperandNames {
            if $scope.TryLookupSymbol(name) is VariableSymbol compared {
                let comparedType = compared.Type
                // A non-nullable value type compared with `nil` may select a user-defined `==`.
                if comparedType != nil &&
                    (
                    object.Equals(StripAllNullability(comparedType), TypeSymbol.Object) ||
                        (comparedType !is NullableTypeSymbol && !IsReferenceLikeType(comparedType))
                ) {
                    resolved.RunsUserOperator = true
                }
            }
        }
        for name in effects.BareReads {
            if $scope.TryLookupSymbol(name) is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol {
                resolved.ReadsProperty = true
            }
        }
        for write in effects.Writes {
            if write.ViaCallArgument {
                resolved.WritesViaCallArgument = true
            }
            let symbol = $scope.TryLookupSymbol(write.Name)
            if symbol is not VariableSymbol variable {
                continue
            }
            if variable is ImplicitPropertyVariableSymbol or ImplicitStaticPropertyVariableSymbol {
                resolved.RunsUserCodeOnWrite = true
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
    // The storage that a call operand names: the variable at the end of its `ref` alias chain at the entry
    // scope. Two spellings that reach one storage are one operand (ADR-0208 R12, amendment A3).
    private func SameOperandStorage(first string, second string) bool {
        if first == second {
            return true
        }
        let left = $scope.TryLookupSymbol(first)
        let right = $scope.TryLookupSymbol(second)
        if left is VariableSymbol leftVariable && right is VariableSymbol rightVariable {
            return ChainsOverlap(leftVariable, rightVariable)
        }
        return false
    }

    // The variables that one call of the region passes more than once with at least one `ref`/`out`
    // (ADR-0208 R12, amendment A3): the aliasing is visible at the call site.
    private func IsCallAliasedName(effects RegionEffects, name string) bool {
        for call in effects.Calls {
            var byReference = 0
            var total = 0
            for text in call.ByReferenceNames {
                if SameOperandStorage(text, name) {
                    byReference++
                    total++
                }
            }
            for text in call.ByValueNames {
                if SameOperandStorage(text, name) {
                    total++
                }
            }
            if byReference > 0 && total >= 2 {
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
                // The literal proves a type-test fact only when its own type converts to the fact's type.
                if factKind == "type-test" &&
                    (write.ConstructedTypeName != "string" || !ConvertsImplicitly(TypeSymbol.String, narrowedType)) {
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
                // The asserted value must convert to the root without a conversion operator: a name whose type
                // keeps its representation.
                if write.RightSideName == nil || write.RightSideDeclaration != nil {
                    why = "null-assertion-of-an-unknown-value"
                    return false
                }
                if $scope.TryLookupSymbol(write.RightSideName) is VariableSymbol asserted {
                    let assertedType = StripAllNullability(asserted.Type)
                    if assertedType == nil || declared == nil || !Conversion.IsRepresentationPreservingImplicit(
                        assertedType,
                        declared
                    ) {
                        why = "null-assertion-converts"
                        return false
                    }
                    return true
                }
                why = "null-assertion-of-an-unknown-value"
                return false
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
                    // Question 4 (decided for slice L1): a type-pattern variable of the region is non-null and
                    // read-only. The scanner gives it a typed kind only where the binder scopes it; the binder
                    // drops the scope that a guard leaks (`leaked|Type`) when the function has a user label. Its
                    // type must convert to the root without a conversion operator.
                    var patternType TypeSymbol? = nil
                    var patternBound = false
                    let declaration = write.RightSideDeclaration
                    if declaration != nil && declaration.StartsWith("pattern|", StringComparison.Ordinal) {
                        patternBound = true
                        patternType = ResolveConstructedType(declaration.Substring("pattern|".Length))
                    } else if declaration != nil && declaration.StartsWith("leaked|", StringComparison.Ordinal) {
                        patternBound = true
                        if !binderCtx.FunctionContainsUserGotoOrLabel {
                            patternType = ResolveConstructedType(declaration.Substring("leaked|".Length))
                        }
                    } else if declaration == "pattern" || declaration == "binding" {
                        patternBound = true
                    }
                    if patternBound {
                        why = "variable:pattern-bound"
                        let declaredRoot = StripAllNullability(root.Type)
                        if patternType != nil && declaredRoot != nil && Conversion.IsRepresentationPreservingImplicit(
                            patternType,
                            declaredRoot
                        ) &&
                            (
                            factKind != "type-test" || Conversion.IsRepresentationPreservingImplicit(
                                patternType,
                                narrowedType
                            )
                        ) {
                            return true
                        }
                    }
                }
                return false
            }
        }
    }

    private func ConvertsImplicitly(from TypeSymbol, to TypeSymbol) bool {
        // A structural projection between unrelated classes makes a new object of the other type, so only a
        // conversion that keeps the representation proves a type-test fact.
        return Conversion.IsRepresentationPreservingImplicit(from, to)
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
        // A user-defined operator is a call (ADR-0208 construct table).
        let callLike = effects.ContainsCall ||
            effects.ContainsSuspension ||
            effects.ContainsIteration ||
            resolved.RunsUserOperator ||
            resolved.RunsUserCodeOnWrite
        // Rule W5: every member or index read is an unknown getter, which is a call.
        let readLike = effects.ContainsMemberRead || resolved.ReadsProperty
        let memberWrite = effects.ContainsMemberWrite || effects.ContainsPointerWrite || resolved.ImplicitMemberWrite
        let mayMutateMemberPaths = callLike || readLike || memberWrite
        var indirectCall = effects.ContainsIteration || effects.ContainsSuspension
        for call in effects.Calls {
            if CallIsIndirect(call) {
                indirectCall = true
            }
        }
        // A member read is an unknown getter, which the table classes as a call (ADR-0208 R14). Amendment A3
        // (#5292) keeps the fact of a by-reference parameter across a call, so a read does not write the
        // storage that such a parameter names. It still removes member-bearing paths and the facts of an
        // alias of an element or a member.
        let mayMutateReferenceStorage = memberWrite || indirectCall
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

    /// ADR-0213 section 6 (slice L1): applies the lower bound `Lower(S, R)` of the loop whose body is
    /// [`body`](paramref) to the frames, before the header and the body are bound. `S` is the facts of the
    /// frames, `R` the region of the loop. A fact that the consumer rule of section 7 removes leaves its
    /// frame, and stays out of it after the loop. The external callable aliases that the region may
    /// reassign leave their set. When `GSHARP_NARROWING_COMPARE` is set, the decision for every fact goes
    /// to the `.loops` report.
    private func ApplyLoopEntryLowerBound(body StatementSyntax, iterationRunsUserCode bool) {
        let loop = body.Parent
        let frameCount = binderCtx.NarrowedVariables.Count
        let invalidations = List[(FrameIndex int32, Path AccessPath)]()
        if loop == nil || RegionEffectKindTable.Classify(loop.Kind) != RegionEffectClass.Loop {
            // A loop that the walker cannot name has no region to scan: every fact is removed (rule W6).
            for var i = frameCount - 1; i >= 0; i-- {
                for path in binderCtx.NarrowedVariables[i].Keys {
                    invalidations.Add((i, path))
                }
            }
            InvalidateInheritedNarrowings(invalidations)
            externalCallableAliases.Clear()
            CompilationMeasurements.Count("narrowing.region-facts-killed", cast[int64](invalidations.Count))
            if NarrowingComparison.LoopsEnabled {
                NarrowingComparison.ReportLoopSummary(
                    body.Location,
                    invalidations.Count,
                    invalidations.Count,
                    0,
                    "no-loop-parent"
                )
            }
            return
        }
        // The names that a closure of the function assigns decide the shared predicates below. They are
        // computed on first use, and until then every name is assumed assigned.
        EnsureClosureAssignedNames(loop)
        if HeaderIsLiteralFalse(loop) {
            // No back edge: the body runs once from the entry state, or never.
            return
        }
        let scanner = GetRegionScanner()
        let visitedBefore = scanner.NodesVisited
        let regionsBefore = scanner.Regions
        let effects = scanner.ScanLoop(loop, iterationRunsUserCode)
        if scanner.Regions != regionsBefore {
            CompilationMeasurements.Count("narrowing.region-walks")
            CompilationMeasurements.Count("narrowing.region-nodes", cast[int64](scanner.NodesVisited - visitedBefore))
        }
        let resolved = ResolveRegionWrites(effects)
        var filterNames HashSet[string]? = nil
        if effects.ContainsHandler {
            let filters = CollectCatchFiltersAbove(loop)
            if filters.Count > 0 {
                filterNames = CollectEnclosingFilterNames(filters)
            }
        }
        // S: the facts of the frames. A path that two frames hold is reported once, for the innermost frame.
        let reported = List[AccessPath]()
        var factCount = 0
        var killedCount = 0
        var memberReadsWithLiveFacts = 0
        let location = loop.Location
        for var i = frameCount - 1; i >= 0; i-- {
            for entry in binderCtx.NarrowedVariables[i] {
                let path = entry.Key
                let decision = DecideRegionKill(path, entry.Value, effects, resolved, filterNames)
                if decision.Killed {
                    invalidations.Add((i, path))
                }
                var seen = false
                for existing in reported {
                    if existing.Equals(path) {
                        seen = true
                        break
                    }
                }
                if seen {
                    continue
                }
                reported.Add(path)
                factCount++
                if decision.Killed {
                    killedCount++
                    CompilationMeasurements.Count("narrowing.region-facts-killed")
                }
                if effects.MemberReadCount > 0 && MayBeMutatedByUnknownCallable(path) {
                    memberReadsWithLiveFacts++
                }
                if NarrowingComparison.LoopsEnabled && decision.Killed {
                    NarrowingComparison.ReportLoopKill(
                        location,
                        path.ToString(),
                        FactKind(path, entry.Value),
                        decision.Rule,
                        decision.Row
                    )
                }
            }
        }
        InvalidateInheritedNarrowings(invalidations)
        // ADR-0213 section 13: a function value that the region may reassign is no longer external at the
        // loop header, so a call in the loop can reach a closure.
        if effects.ContainsUnknownKind || effects.ContainsPointerWrite {
            externalCallableAliases.Clear()
        } else if externalCallableAliases.Count > 0 && resolved.Roots.Count > 0 {
            externalCallableAliases.RemoveWhere(
                (alias VariableSymbol) -> resolved.Roots.Any(
                    (written VariableSymbol) -> SameRoot(written, alias) || MayShareStorage(written, alias)
                )
            )
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
        if NarrowingComparison.LoopsEnabled {
            NarrowingComparison.ReportLoopSummary(
                location,
                factCount,
                killedCount,
                factCount - killedCount,
                "nodes=${effects.NodesVisited} reads=${effects.MemberReadCount} ${effects}"
            )
        }
    }

    // A loop whose condition is the literal `false` has no back edge (`while false`, `do { } while false`),
    // so its body is bound under the state at its entry.
    private func HeaderIsLiteralFalse(loop SyntaxNode) bool {
        var condition ExpressionSyntax? = nil
        switch loop.Kind {
            case SyntaxKind.WhileStatement {
                condition = cast[WhileStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForConditionStatement {
                condition = cast[ForConditionStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForClauseStatement {
                condition = cast[ForClauseStatementSyntax](loop).Condition
            }
            case SyntaxKind.DoWhileStatement {
                condition = cast[DoWhileStatementSyntax](loop).Condition
            }
            default { }
        }
        while condition is ParenthesizedExpressionSyntax parenthesized {
            condition = parenthesized.Expression
        }
        return condition is LiteralExpressionSyntax literal && literal.LiteralToken.Kind == SyntaxKind.FalseKeyword
    }

    // The facts that the header of a loop proves when the loop ends, by loop statement. Row R7 (f).
    private let loopExitFacts Dictionary[SyntaxNode, Dictionary[AccessPath, TypeSymbol]] = Dictionary[
        SyntaxNode,
        Dictionary[AccessPath, TypeSymbol]
    ]()

    /// Row R7 (f), table 9 column `Exit state`: a loop without a `break` ends only when its header is
    /// false, so the facts that the condition proves false hold after the loop whatever the body wrote.
    /// The header is bound under the lower bound of the loop, so each fact holds on every iteration.
    /// A fact that the condition itself may remove is dropped, as for a statement (rule A2).
    /// @remarks A loop with a `break` keeps today's exit (no fact is added): the states of the `break`
    /// statements are not recorded yet, so the join of table 9 cannot be taken. The same holds in a
    /// function with a user label or `goto` (#4285).
    private func RecordLoopExitFacts(loopBody StatementSyntax, condition BoundExpression?) {
        if condition == nil {
            return
        }
        let loop = loopBody.Parent
        if loop == nil {
            return
        }
        let elseFacts = ComputeConditionNarrowing(condition).Else
        if elseFacts == nil || elseFacts.Count == 0 {
            return
        }
        let hasBreak = ContainsBreakFor(loop)
        if NarrowingComparison.LoopsEnabled {
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
                NarrowingComparison.ReportLoopExitGain(
                    loop.Location,
                    entry.Key.ToString(),
                    hasBreak,
                    FindBangSitesAfter(loop, text)
                )
            }
        }
        // The loop ends when the header is false, so the break of a block expression in the header or in the post
        // statement also leaves it: the whole loop is scanned.
        if hasBreak || binderCtx.FunctionContainsUserGotoOrLabel {
            return
        }
        // The effects of the header decide which facts survive it, by the same rule as the entry (A2): a call,
        // a getter, an operator, a write to the root, a write through `ref` or a filter of an enclosing try.
        let headerSyntax = HeaderSyntax(loop)
        if headerSyntax == nil {
            return
        }
        let headerEffects = GetRegionScanner().ScanStatements([]SyntaxNode{headerSyntax})
        let resolved = ResolveRegionWrites(headerEffects)
        let filters = CollectCatchFiltersAbove(loop)
        var filterNames HashSet[string]? = nil
        if filters.Count > 0 {
            filterNames = CollectEnclosingFilterNames(filters)
        }
        let facts = Dictionary[AccessPath, TypeSymbol]()
        for entry in elseFacts {
            let path = entry.Key
            var removed = DecideRegionKill(path, entry.Value, headerEffects, resolved, filterNames).Killed
            if !removed &&
                filterNames != nil &&
                (
                headerEffects.ContainsCall ||
                    headerEffects.ContainsMemberRead ||
                    resolved.ReadsProperty ||
                    resolved.RunsUserOperator ||
                    resolved.RunsUserCodeOnWrite
            ) &&
                (filterNames.Contains(path.Root.Name) || MayBeMutatedByUnknownCallable(path)) {
                removed = true
            }
            if !removed {
                facts[path] = entry.Value
            }
        }
        if facts.Count > 0 {
            loopExitFacts[loop] = facts
        }
    }

    // The condition of a loop statement, or `nil`.
    private func HeaderSyntax(loop SyntaxNode) SyntaxNode? {
        switch loop.Kind {
            case SyntaxKind.WhileStatement {
                return cast[WhileStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForConditionStatement {
                return cast[ForConditionStatementSyntax](loop).Condition
            }
            case SyntaxKind.ForClauseStatement {
                return cast[ForClauseStatementSyntax](loop).Condition
            }
            case SyntaxKind.DoWhileStatement {
                return cast[DoWhileStatementSyntax](loop).Condition
            }
            default {
                return nil
            }
        }
    }

    /// Adds the facts that the header of the loop statement [`syntax`](paramref) proves on exit to
    /// [`persistentFrame`](paramref). It runs after the statement's invalidation, which removes the
    /// roots that the body writes: the exit state is the state of the header, not of the body.
    private func ApplyLoopExitNarrowings(syntax SyntaxNode, persistentFrame NarrowingFrame) {
        var node = syntax
        while node is LabeledStatementSyntax labeled {
            node = labeled.Statement
        }
        if !loopExitFacts.TryGetValue(node, out var facts) {
            return
        }
        loopExitFacts.Remove(node)
        for entry in facts {
            SetPersistentNarrowing(persistentFrame, entry.Key, entry.Value)
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
        var body SyntaxNode? = nil
        if function is FunctionDeclarationSyntax declaration {
            body = declaration.Body
        } else if function is FunctionLiteralExpressionSyntax literal {
            body = literal.Body
        } else if function is ConstructorDeclarationSyntax constructor {
            body = constructor.Body
        } else if function is PropertyAccessorSyntax accessor {
            body = accessor.Body
        } else if function is EventAccessorSyntax eventAccessor {
            body = eventAccessor.Body
        } else if function is DeinitDeclarationSyntax destructor {
            body = destructor.Body
        } else if function is LambdaExpressionSyntax lambda && lambda.Body is BlockExpressionSyntax lambdaBlock {
            body = lambdaBlock
        }
        if body == nil {
            return
        }
        let span = BackwardJumpSpans.Compute(body)
        if span == nil {
            return
        }
        NarrowingComparison.TryRegisterSpanFunction(
            "span:" + NarrowingComparison.Format(location) + ":" + function.Span.Start.ToString()
        )
        let effects = GetRegionScanner().ScanStatements(span.Statements())
        NarrowingComparison.ReportSpan(
            span.FirstStatement.Location,
            "labels=${string.Join(",", span.Labels)} gotos=${span.GotoCount}",
            effects.ToString()
        )
    }
}
