// <copyright file="ManagedReferenceSemanticExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

class ManagedReferenceSemanticExhaustivenessTests {
    @Fact
    func HighRiskBoundExpressionsHaveExplicitManagedReferenceDispositions() {
        let discovered = DiscoverHighRiskBoundExpressions()
        let missing = ManagedReferenceSemanticExhaustivenessTests.Missing(
            discovered,
            HighRiskExpressionDispositions.Keys
        )
        Assert.True(
            missing.Count == 0,
            "Managed-reference semantic inventory is missing high-risk bound expressions: ${string.Join(", ", missing)}"
        )
        let stale = ManagedReferenceSemanticExhaustivenessTests.Missing(HighRiskExpressionDispositions.Keys, discovered)
        Assert.True(
            stale.Count == 0,
            "Managed-reference semantic inventory contains stale bound expressions: ${string.Join(", ", stale)}"
        )
    }

    @Fact
    func ManagedReferenceContextsHaveConcreteImplementationMarkers() {
        let source = ReadSource(SafetyAnalyzerPath) + ReadSource(OriginsPath) + ReadSource(CapturePath)
        let missing = ContextDispositions
            .Where((pair KeyValuePair[string, string]) -> !source.Contains(pair.Value, StringComparison.Ordinal))
            .Select((pair KeyValuePair[string, string]) -> pair.Key)
            .OrderBy((name string) -> name, StringComparer.Ordinal)
            .ToArray()
        Assert.True(
            missing.Length == 0,
            "Managed-reference contexts have no concrete implementation marker: ${string.Join(", ", missing)}"
        )
    }

    @Fact
    func SelfTest_OmittedHighRiskNodeIsDetected() {
        let classifications = HighRiskExpressionDispositions.Keys.Where(
            (name string) -> name != "BoundFunctionPointerInvocationExpression"
        )
        Assert.Contains(
            "BoundFunctionPointerInvocationExpression",
            ManagedReferenceSemanticExhaustivenessTests.Missing(DiscoverHighRiskBoundExpressions(), classifications)
        )
    }

    @Fact
    func SelfTest_OmittedContextIsDetected() {
        let required = ContextDispositions.Keys.Append("synthetic-required-context")
        Assert.Contains(
            "synthetic-required-context",
            ManagedReferenceSemanticExhaustivenessTests.Missing(required, ContextDispositions.Keys)
        )
    }

    shared {
        private const SafetyAnalyzerPath string = "src/Core/CodeAnalysis/Binding/ManagedReferenceSafetyAnalyzer"
        private const OriginsPath string = "src/Core/CodeAnalysis/Binding/ManagedReferenceOrigins"
        private const CapturePath string = "src/Core/CodeAnalysis/Binding/ClosureCaptureLegalityChecker"
        private let HighRiskExpressionDispositions Dictionary[string, string] = Dictionary[string, string](
            StringComparer.Ordinal
        ){
            ["BoundMapLiteralExpression"] = "heap sink: keys and values are retained",
            ["BoundArrayCreationExpression"] = "heap sink and required-element initialization",
            ["BoundClrConstructorCallExpression"] = "unknown constructor arguments",
            ["BoundAssignmentExpression"] = "non-local storage sink; local provenance is preserved by binding",
            ["BoundDefaultExpression"] = "required non-null initialization",
            ["BoundCallExpression"] = "known source call contract through BoundCallOperationExpression",
            ["BoundTupleLiteralExpression"] = "aggregate scoped-result provenance",
            ["BoundIndirectAssignmentExpression"] = "unknown storage sink",
            ["BoundConstructorChainingExpression"] = "selected constructor contract",
            ["BoundIndexAssignmentExpression"] = "container storage sink",
            ["BoundClrPropertyAssignmentExpression"] = "imported property storage sink and suspension ordering",
            ["BoundBaseInterfaceCallExpression"] = "known source call contract through BoundCallOperationExpression",
            ["BoundClrMethodGroupExpression"] = "delegate-target capture",
            ["BoundClrIndexExpression"] = "imported index arguments and managed-location propagation",
            ["BoundStructLiteralExpression"] = "aggregate storage and required-field initialization",
            ["BoundFunctionPointerInvocationExpression"] = "unknown function-pointer call contract",
            ["BoundClrConversionCallExpression"] = "imported conversion arguments",
            ["BoundConstrainedStaticCallExpression"] = "known call contract through BoundCallOperationExpression",
            ["BoundBaseClassCallExpression"] = "known base-call contract",
            ["BoundIndirectCallExpression"] = "unknown indirect-call contract",
            ["BoundFieldAssignmentExpression"] = "field storage sink and suspension ordering",
            ["BoundImportedCallExpression"] = "known imported call contract through BoundCallOperationExpression",
            ["BoundMethodGroupExpression"] = "delegate-target capture",
            ["BoundUserInstanceCallExpression"] = "known source call contract through BoundCallOperationExpression",
            ["BoundConstructorCallExpression"] = "construction initialization and selected constructor contract",
            ["BoundManagedReferenceExpression"] = "handle creation; provenance is checked by the address binder",
            ["BoundPropertyAssignmentExpression"] = "property storage sink and suspension ordering",
            ["BoundClrStaticCallExpression"] = "known imported call contract through BoundCallOperationExpression",
            ["BoundFunctionLiteralExpression"] = "closure capture is checked by ClosureCaptureLegalityChecker",
            [
                "BoundImportedInstanceCallExpression"
            ] = "call contract, handle-result provenance, and managed-location propagation",
            ["BoundClrIndexAssignmentExpression"] = "imported index storage sink and suspension ordering"
        }
        private let ContextDispositions Dictionary[string, string] = Dictionary[string, string](StringComparer.Ordinal){
            ["value-preserving-provenance"] = "IsScopedResult",
            ["heap-and-unknown-sinks"] = "CheckScopedStore",
            ["known-and-unknown-call-contracts"] = "CheckArguments",
            ["managed-location-propagation"] = "IsManagedLocation",
            ["suspension-source-ordering"] = "CheckSuspendingLocation",
            ["delegate-target-capture"] = "CheckDelegateTarget",
            ["state-machine-hidden-storage"] = "analyzingStateMachine",
            ["instance-required-initialization"] = "CheckRequiredConstructorPaths",
            ["static-required-initialization"] = "CheckRequiredStaticPaths",
            ["closure-hidden-storage"] = "ClosureCaptureLegalityChecker"
        }

        private func DiscoverHighRiskBoundExpressions() HashSet[string] -> typeof(BoundExpression)
            .Assembly
            .GetTypes()
            .Where((type Type) -> !type.IsAbstract && typeof(BoundExpression).IsAssignableFrom(type))
            .Where(IsHighRisk)
            .Select((type Type) -> type.Name)
            .ToHashSet(StringComparer.Ordinal)

        private func IsHighRisk(type Type) bool -> type.Name.Contains(
            "AssignmentExpression",
            StringComparison.Ordinal
        ) ||
            type
            .Name
            .Contains("CallExpression", StringComparison.Ordinal) || type.Name.Contains(
            "InvocationExpression",
            StringComparison.Ordinal
        ) ||
            type
            .Name
            .Contains("MethodGroupExpression", StringComparison.Ordinal) || type.GetProperty(
            "Arguments",
            BindingFlags.Instance | BindingFlags.Public
        ) != nil ||
            (
            type.Name is "BoundDefaultExpression" or
                "BoundArrayCreationExpression" or
                "BoundMapLiteralExpression" or
                "BoundStructLiteralExpression" or
                "BoundTupleLiteralExpression" or
                "BoundFunctionLiteralExpression" or
                "BoundManagedReferenceExpression"
        )

        private func Missing(required IEnumerable[string], present IEnumerable[string]) List[string] {
            let found = present.ToHashSet(StringComparer.Ordinal)
            return required
                .Where((name string) -> !found.Contains(name))
                .OrderBy((name string) -> name, StringComparer.Ordinal)
                .ToList()
        }

        // Issue #4656: the paths carry no extension; the file is read in the
        // tree's own language (C# before the cut-over, G# after).
        private func ReadSource(relativePathWithoutExtension string) string -> File.ReadAllText(
            TestSource.SourcePath(relativePathWithoutExtension)
        )
    }
}
