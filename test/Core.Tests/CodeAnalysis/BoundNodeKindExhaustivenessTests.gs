// <copyright file="BoundNodeKindExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Validates that every (cref:BoundNodeKind) value is explicitly
/// handled (or intentionally allowlisted) in each of the four emit/lowering
/// dispatch switches. A missing case surfaces as a test failure naming the
/// kind, so adding a new (cref:BoundNodeKind) without updating the
/// consuming switches is impossible without a red test.
open class BoundNodeKindExhaustivenessTests {
    @Fact
    func EmitExpression_HandlesAllBoundNodeKinds() {
        let allKinds = GetAllBoundNodeKindNames()
        let source = ReadSourceFile(EmitExpressionsPath)
        let handledKinds = ExtractHandledKinds(source, EmitExpressionSignature)
        AssertExhaustive(allKinds, handledKinds, EmitExpressionAllowlist, "EmitExpression")
    }

    @Fact
    func EmitStatement_HandlesAllBoundNodeKinds() {
        let allKinds = GetAllBoundNodeKindNames()
        let source = ReadSourceFile(EmitStatementsPath)
        let handledKinds = ExtractHandledKinds(source, EmitStatementSignature)
        AssertExhaustive(allKinds, handledKinds, EmitStatementAllowlist, "EmitStatement")
    }

    @Fact
    func SpillExpression_HandlesAllBoundNodeKinds() {
        let allKinds = GetAllBoundNodeKindNames()
        let source = ReadSourceFile(SpillSequenceSpillerPath)
        let handledKinds = ExtractHandledKinds(source, SpillExpressionSignature)
        AssertExhaustive(allKinds, handledKinds, SpillExpressionAllowlist, "SpillExpression")
    }

    @Fact
    func RewriteStatementToList_HandlesAllBoundNodeKinds() {
        let allKinds = GetAllBoundNodeKindNames()
        let source = ReadSourceFile(SpillSequenceSpillerPath)
        let handledKinds = ExtractHandledKinds(source, RewriteStatementToListSignature)
        AssertExhaustive(allKinds, handledKinds, RewriteStatementAllowlist, "RewriteStatementToList")
    }

    @Fact
    func SelfTest_SyntheticKindDetected() {
        // Guard against the test silently passing because its regex broke or
        // its allowlists swallow everything. Inject a synthetic kind and
        // assert the helper fails with a message naming it.
        let allKinds = GetAllBoundNodeKindNames()
        allKinds.Add("SyntheticTestKind")
        let source = ReadSourceFile(EmitExpressionsPath)
        let handledKinds = ExtractHandledKinds(source, EmitExpressionSignature)
        let missing = GetMissingKinds(allKinds, handledKinds, EmitExpressionAllowlist)
        Assert.Contains("SyntheticTestKind", missing)
    }

    shared {
        /// Map from (cref:BoundNodeKind) enum-value name to the C# class
        /// name(s) used in `case` patterns. Most map 1:1 by prepending
        /// "Bound"; a few share a CLR class (e.g. `AwaitYieldPoint` and
        /// `AwaitResumePoint` both map to `BoundAwaitSequencePoint`).
        private let KindToClassNames Dictionary[string, []string] = BuildKindToClassMap()

        // Source paths relative to the repo root.
        private const EmitExpressionsPath string = "src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Expressions"

        private const EmitStatementsPath string = "src/Core/CodeAnalysis/Emit/MethodBodyEmitter"
        private const SpillSequenceSpillerPath string = "src/Core/CodeAnalysis/Lowering/Async/SpillSequenceSpiller"

        // ──────────────────────────────────────────────────────────────────────
        //  Allowlists: kinds that legitimately never appear in a given switch.
        //  Each entry documents the reason (lowered away, wrong category, etc.).
        // ──────────────────────────────────────────────────────────────────────
        /// Kinds the EmitExpression switch never sees — patterns, statements,
        /// and expression kinds lowered away before emit.
        private let EmitExpressionAllowlist HashSet[string] = HashSet[string](
            []string{
                "ConstantPattern",
                "DiscardPattern",
                "TypePattern",
                "PropertyPattern",
                "PropertyPatternField",
                "RelationalPattern",
                "ListPattern",
                "SlicePattern",
                "BinaryPattern",
                "NotPattern",
                "BlockStatement",
                "VariableDeclaration",
                "LocalFunctionDeclaration",
                "IfStatement",
                "ForInfiniteStatement",
                "ForEllipsisStatement",
                "ForRangeStatement",
                "LabelStatement",
                "GotoStatement",
                "ConditionalGotoStatement",
                "ReturnStatement",
                "ExpressionStatement",
                "TryStatement",
                "ThrowStatement",
                "RethrowStatement",
                "PatternSwitchStatement",
                "GoStatement",
                "ChannelSendStatement",
                "SelectStatement",
                "ScopeStatement",
                "FixedStatement",
                "AwaitForRangeStatement",
                "YieldStatement",
                "PatternSwitchArm",
                "SwitchExpressionArm",
                "Attribute",
                "ManagedReferenceExpression",
                "AwaitExpression",
                "SpillSequenceExpression",
                "AwaitYieldPoint",
                "AwaitResumePoint",
                "InterpolatedStringExpression"
            }
        )

        /// Kinds the EmitStatement switch never sees.
        private let EmitStatementAllowlist HashSet[string] = HashSet[string](
            []string{
                "ErrorExpression",
                "LiteralExpression",
                "Utf8StringExpression",
                "VariableExpression",
                "AssignmentExpression",
                "UnaryExpression",
                "BinaryExpression",
                "CallExpression",
                "ConversionExpression",
                "ImportedCallExpression",
                "ImportedInstanceCallExpression",
                "ConstrainedStaticCallExpression",
                "ArrayCreationExpression",
                "StackAllocExpression",
                "MapLiteralExpression",
                "MapDeleteExpression",
                "IndexExpression",
                "IndexAssignmentExpression",
                "LenExpression",
                "CapExpression",
                "AppendExpression",
                "StructLiteralExpression",
                "ConstructorCallExpression",
                "UserInstanceCallExpression",
                "BaseInterfaceCallExpression",
                "BaseClassCallExpression",
                "FieldAccessExpression",
                "FieldAssignmentExpression",
                "PropertyAccessExpression",
                "PropertyAssignmentExpression",
                "NullConditionalAccessExpression",
                "TupleLiteralExpression",
                "TupleElementAccessExpression",
                "FunctionLiteralExpression",
                "MethodGroupExpression",
                "ClrMethodGroupExpression",
                "IndirectCallExpression",
                "InterpolatedStringExpression",
                "ClrConstructorCallExpression",
                "ClrPropertyAccessExpression",
                "ClrPropertyAssignmentExpression",
                "ClrBinaryOperatorExpression",
                "ClrUnaryOperatorExpression",
                "ClrConversionCallExpression",
                "ClrIndexExpression",
                "ClrIndexAssignmentExpression",
                "ClrEventSubscriptionExpression",
                "EventSubscriptionExpression",
                "AwaitExpression",
                "SwitchExpression",
                "BlockExpression",
                "AddressOfExpression",
                "ManagedReferenceExpression",
                "ManagedFieldKeyExpression",
                "DereferenceExpression",
                "StateMachineAwaitOnCompleted",
                "StateMachineBuilderMoveNext",
                "SpillSequenceExpression",
                "DefaultExpression",
                "ClrStaticCallExpression",
                "ConditionalAddressExpression",
                "ConditionalExpression",
                "ThrowExpression",
                "IndirectAssignmentExpression",
                "TypeOfExpression",
                "SizeOfExpression",
                "FunctionPointerFromMethodExpression",
                "FunctionPointerInvocationExpression",
                "MakeChannelExpression",
                "ChannelReceiveExpression",
                "ChannelCloseExpression",
                "IsExpression",
                "AsExpression",
                "ConstructorChainingExpression",
                "TypeParameterConstructionExpression",
                "ConstantPattern",
                "DiscardPattern",
                "TypePattern",
                "PropertyPattern",
                "PropertyPatternField",
                "RelationalPattern",
                "ListPattern",
                "SlicePattern",
                "BinaryPattern",
                "NotPattern",
                "PatternSwitchArm",
                "SwitchExpressionArm",
                "Attribute",
                "IfStatement",
                "ForInfiniteStatement",
                "ForEllipsisStatement",
                "ForRangeStatement",
                "AwaitForRangeStatement"
            }
        )

        /// Kinds the SpillExpression switch never sees — statement kinds, pattern kinds,
        /// and annotation kinds.
        private let SpillExpressionAllowlist HashSet[string] = HashSet[string](
            []string{
                "BlockStatement",
                "VariableDeclaration",
                "LocalFunctionDeclaration",
                "IfStatement",
                "ForInfiniteStatement",
                "ForEllipsisStatement",
                "ForRangeStatement",
                "LabelStatement",
                "GotoStatement",
                "ConditionalGotoStatement",
                "ReturnStatement",
                "ExpressionStatement",
                "TryStatement",
                "ThrowStatement",
                "RethrowStatement",
                "PatternSwitchStatement",
                "GoStatement",
                "ChannelSendStatement",
                "SelectStatement",
                "ScopeStatement",
                "FixedStatement",
                "AwaitForRangeStatement",
                "YieldStatement",
                "ConstantPattern",
                "DiscardPattern",
                "TypePattern",
                "PropertyPattern",
                "PropertyPatternField",
                "RelationalPattern",
                "ListPattern",
                "SlicePattern",
                "BinaryPattern",
                "NotPattern",
                "PatternSwitchArm",
                "SwitchExpressionArm",
                "Attribute",
                "AwaitYieldPoint",
                "AwaitResumePoint"
            }
        )

        /// Kinds the RewriteStatementToList switch never sees — expression kinds,
        /// pattern kinds, annotation kinds, and statement kinds that are lowered
        /// away before the async spill pass.
        private let RewriteStatementAllowlist HashSet[string] = HashSet[string](
            []string{
                "ErrorExpression",
                "LiteralExpression",
                "Utf8StringExpression",
                "VariableExpression",
                "AssignmentExpression",
                "UnaryExpression",
                "BinaryExpression",
                "CallExpression",
                "ConversionExpression",
                "ImportedCallExpression",
                "ImportedInstanceCallExpression",
                "ConstrainedStaticCallExpression",
                "ArrayCreationExpression",
                "StackAllocExpression",
                "MapLiteralExpression",
                "MapDeleteExpression",
                "IndexExpression",
                "IndexAssignmentExpression",
                "LenExpression",
                "CapExpression",
                "AppendExpression",
                "StructLiteralExpression",
                "ConstructorCallExpression",
                "UserInstanceCallExpression",
                "BaseInterfaceCallExpression",
                "BaseClassCallExpression",
                "FieldAccessExpression",
                "FieldAssignmentExpression",
                "PropertyAccessExpression",
                "PropertyAssignmentExpression",
                "NullConditionalAccessExpression",
                "TupleLiteralExpression",
                "TupleElementAccessExpression",
                "FunctionLiteralExpression",
                "MethodGroupExpression",
                "ClrMethodGroupExpression",
                "IndirectCallExpression",
                "InterpolatedStringExpression",
                "ClrConstructorCallExpression",
                "ClrPropertyAccessExpression",
                "ClrPropertyAssignmentExpression",
                "ClrBinaryOperatorExpression",
                "ClrUnaryOperatorExpression",
                "ClrConversionCallExpression",
                "ClrIndexExpression",
                "ClrIndexAssignmentExpression",
                "ClrEventSubscriptionExpression",
                "EventSubscriptionExpression",
                "AwaitExpression",
                "SwitchExpression",
                "BlockExpression",
                "AddressOfExpression",
                "ManagedReferenceExpression",
                "ManagedFieldKeyExpression",
                "DereferenceExpression",
                "StateMachineAwaitOnCompleted",
                "StateMachineBuilderMoveNext",
                "SpillSequenceExpression",
                "DefaultExpression",
                "ClrStaticCallExpression",
                "ConditionalAddressExpression",
                "ConditionalExpression",
                "ThrowExpression",
                "IndirectAssignmentExpression",
                "TypeOfExpression",
                "SizeOfExpression",
                "FunctionPointerFromMethodExpression",
                "FunctionPointerInvocationExpression",
                "MakeChannelExpression",
                "ChannelReceiveExpression",
                "ChannelCloseExpression",
                "IsExpression",
                "AsExpression",
                "ConstructorChainingExpression",
                "TypeParameterConstructionExpression",
                "ConstantPattern",
                "DiscardPattern",
                "TypePattern",
                "PropertyPattern",
                "PropertyPatternField",
                "RelationalPattern",
                "ListPattern",
                "SlicePattern",
                "BinaryPattern",
                "NotPattern",
                "PatternSwitchArm",
                "SwitchExpressionArm",
                "Attribute",
                "ForInfiniteStatement",
                "ForEllipsisStatement",
                "ForRangeStatement",
                "AwaitForRangeStatement"
            }
        )

        private prop EmitExpressionSignature string -> Signature(
            "private void EmitExpression(BoundExpression expression)",
            "private func EmitExpressionCore(expression BoundExpression)"
        )

        private prop EmitStatementSignature string -> Signature(
            "private void EmitStatement(BoundStatement statement)",
            "private func EmitStatement(statement BoundStatement)"
        )

        private prop SpillExpressionSignature string -> Signature(
            "private BoundSpillSequenceExpression SpillExpression(BoundExpression expression)",
            "private func SpillExpression(expression BoundExpression) BoundSpillSequenceExpression"
        )

        private prop RewriteStatementToListSignature string -> Signature(
            "private bool RewriteStatementToList(BoundStatement statement",
            "private func RewriteStatementToList("
        )

        // ──────────────────────────────────────────────────────────────────────
        //  Helpers
        // ──────────────────────────────────────────────────────────────────────
        internal func GetAllBoundNodeKindNames() HashSet[string] {
            return HashSet[string](Enum.GetNames(typeof(BoundNodeKind)))
        }

        private func ReadSourceFile(relativePathWithoutExtension string) string {
            let fullPath = TestSource.SourcePath(relativePathWithoutExtension)
            Assert.True(File.Exists(fullPath), "Source file not found: $fullPath")
            return File.ReadAllText(fullPath)
        }

        /// Extracts the set of (cref:BoundNodeKind) names handled by a
        /// switch statement inside the named method. Recognizes two patterns:
        /// - `case BoundXyzExpression …:` (type-pattern arms)
        /// - `case BoundNodeKind.Xyz:` (enum-value arms)
        internal func ExtractHandledKinds(source string, methodSignature string) HashSet[string] {
            // Find the method body start.
            let sigIndex = source.IndexOf(methodSignature, StringComparison.Ordinal)
            Assert.True(sigIndex >= 0, "Method signature not found: $methodSignature")
            // The marker must name ONE method: an overload or helper sharing the
            // prefix would otherwise slice the wrong body without failing.
            Assert.True(
                source.IndexOf(methodSignature, sigIndex + 1, StringComparison.Ordinal) < 0,
                "Method signature is ambiguous (occurs more than once): $methodSignature"
            )
            // Find the opening brace of the method.
            let bodyStart = source.IndexOf('{', sigIndex)
            Assert.True(bodyStart >= 0, "Opening brace not found after method signature.")
            // Walk braces to find the matching close brace.
            let bodyEnd = FindMatchingBrace(source, bodyStart)
            let methodBody = source.Substring(bodyStart, bodyEnd - bodyStart + 1)
            let handled = HashSet[string]()
            if TestSource.IsGSharp {
                AddGSharpHandledKinds(methodBody, handled)
                return handled
            }
            // Pattern 1: `case BoundXyzExpression …:` or `case BoundXyzStatement …:`
            // or `case BoundXyz:` (any Bound-prefixed type).
            let typePatternRegex = Regex("case\\s+(Bound\\w+)\\b", RegexOptions.Multiline)
            for m Match in typePatternRegex.Matches(methodBody) {
                let className = m.Groups[1].Value
                let kinds = MapClassNameToKinds(className)
                for kind in kinds {
                    handled.Add(kind)
                }
            }
            // Pattern 2: `case BoundNodeKind.Xyz:`
            let enumPatternRegex = Regex("case\\s+BoundNodeKind\\.(\\w+)\\s*:", RegexOptions.Multiline)
            for m Match in enumPatternRegex.Matches(methodBody) {
                handled.Add(m.Groups[1].Value)
            }
            return handled
        }

        /// Issue #4656: the G# spelling of the same switch arms. G# folds C#'s
        /// stacked labels into one comma-separated clause ending at the arm's
        /// brace, and binds a designation before `is`:
        /// `case BoundA,` / `BoundB {`, `case x is BoundC {`,
        /// `case BoundNodeKind.D {`.
        private func AddGSharpHandledKinds(methodBody string, handled HashSet[string]) {
            for clause Match in Regex.Matches(methodBody, "\\bcase\\s+([^{}]*)\\{") {
                for item in clause.Groups[1].Value.Split(',') {
                    let enumArm = Regex.Match(item, "^\\s*BoundNodeKind\\.(\\w+)\\s*$$")
                    if enumArm.Success {
                        handled.Add(enumArm.Groups[1].Value)
                        continue
                    }
                    let typeArm = Regex.Match(item, "^\\s*(?:\\w+\\s+is\\s+|is\\s+)?(Bound\\w+)\\b")
                    if typeArm.Success {
                        for kind in MapClassNameToKinds(typeArm.Groups[1].Value) {
                            handled.Add(kind)
                        }
                    }
                }
            }
        }

        internal func GetMissingKinds(
            allKinds HashSet[string],
            handledKinds HashSet[string],
            allowlist HashSet[string]
        ) List[string] {
            return allKinds
                .Where((k string) -> !handledKinds.Contains(k) && !allowlist.Contains(k))
                .OrderBy((k string) -> k)
                .ToList()
        }

        private func AssertExhaustive(
            allKinds HashSet[string],
            handledKinds HashSet[string],
            allowlist HashSet[string],
            switchName string
        ) {
            let missing = GetMissingKinds(allKinds, handledKinds, allowlist)
            Assert.True(
                missing.Count == 0,
                "$switchName is missing case arms for the following BoundNodeKind values: ${string.Join(", ", missing)}"
            )
        }

        private func FindMatchingBrace(source string, openBraceIndex int32) int32 {
            var depth = 0
            for var i = openBraceIndex; i < source.Length; i++ {
                if source[i] == '{' {
                    depth++
                } else if source[i] == '}' {
                    depth--
                    if depth == 0 {
                        return i
                    }
                }
            }
            throw InvalidOperationException("Unmatched opening brace.")
        }

        /// Maps a C# class name (e.g. `BoundAwaitSequencePoint`) to the
        /// (cref:BoundNodeKind) values it represents.
        private func MapClassNameToKinds(className string)[]string {
            // Collect all kinds that map to this class name (handles multi-kind
            // classes like BoundAwaitSequencePoint → AwaitYieldPoint + AwaitResumePoint).
            let results = List[string]()
            for kvp in KindToClassNames {
                for cn in kvp.Value {
                    if cn == className {
                        results.Add(kvp.Key)
                    }
                }
            }
            if results.Count > 0 {
                return results.ToArray()
            }
            // Fallback: strip "Bound" prefix and return.
            if className.StartsWith("Bound", StringComparison.Ordinal) {
                let kindName = className.Substring("Bound".Length)
                return []string{kindName}
            }
            return Array.Empty[string]()
        }

        /// Builds the map from (cref:BoundNodeKind) name to CLR class name(s).
        /// Most entries follow the convention `Xyz` → `BoundXyz`. Only
        /// exceptions are listed explicitly.
        private func BuildKindToClassMap() Dictionary[string, []string] {
            let map_ = Dictionary[string, []string]()
            for name in Enum.GetNames(typeof(BoundNodeKind)) {
                // Default convention.
                map_[name] = []string{"Bound" + name}
            }
            // Overrides for non-standard mappings.
            // BoundAwaitSequencePoint uses AwaitYieldPoint / AwaitResumePoint kinds.
            map_["AwaitYieldPoint"] = []string{"BoundAwaitSequencePoint"}
            map_["AwaitResumePoint"] = []string{"BoundAwaitSequencePoint"}
            // BoundAttribute uses the Attribute kind.
            map_["Attribute"] = []string{"BoundAttribute"}
            return map_
        }

        // Issue #4656: each switch-hosting method is located by its signature in
        // the tree's own language (C# before the cut-over, G# after).
        private func Signature(csharp string, gsharp string) string -> if TestSource.IsGSharp {
            gsharp
        } else {
            csharp
        }
    }
}
