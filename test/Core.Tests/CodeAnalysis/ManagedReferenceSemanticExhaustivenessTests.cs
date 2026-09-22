// <copyright file="ManagedReferenceSemanticExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

public sealed class ManagedReferenceSemanticExhaustivenessTests
{
    private const string SafetyAnalyzerPath = "src/Core/CodeAnalysis/Binding/ManagedReferenceSafetyAnalyzer.cs";
    private const string OriginsPath = "src/Core/CodeAnalysis/Binding/ManagedReferenceOrigins.cs";
    private const string CapturePath = "src/Core/CodeAnalysis/Binding/ClosureCaptureLegalityChecker.cs";

    private static readonly Dictionary<string, string> HighRiskExpressionDispositions = new(StringComparer.Ordinal)
    {
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
        ["BoundImportedInstanceCallExpression"] = "call contract, handle-result provenance, and managed-location propagation",
        ["BoundClrIndexAssignmentExpression"] = "imported index storage sink and suspension ordering",
    };

    private static readonly Dictionary<string, string> ContextDispositions = new(StringComparer.Ordinal)
    {
        ["value-preserving-provenance"] = "IsScopedResult",
        ["heap-and-unknown-sinks"] = "CheckScopedStore",
        ["known-and-unknown-call-contracts"] = "CheckArguments",
        ["managed-location-propagation"] = "IsManagedLocation",
        ["suspension-source-ordering"] = "CheckSuspendingLocation",
        ["delegate-target-capture"] = "CheckDelegateTarget",
        ["state-machine-hidden-storage"] = "analyzingStateMachine",
        ["instance-required-initialization"] = "CheckRequiredConstructorPaths",
        ["static-required-initialization"] = "CheckRequiredStaticPaths",
        ["closure-hidden-storage"] = "ClosureCaptureLegalityChecker",
    };

    [Fact]
    public void HighRiskBoundExpressionsHaveExplicitManagedReferenceDispositions()
    {
        var discovered = DiscoverHighRiskBoundExpressions();
        var missing = Missing(discovered, HighRiskExpressionDispositions.Keys);
        Assert.True(
            missing.Count == 0,
            $"Managed-reference semantic inventory is missing high-risk bound expressions: {string.Join(", ", missing)}");

        var stale = Missing(HighRiskExpressionDispositions.Keys, discovered);
        Assert.True(
            stale.Count == 0,
            $"Managed-reference semantic inventory contains stale bound expressions: {string.Join(", ", stale)}");
    }

    [Fact]
    public void ManagedReferenceContextsHaveConcreteImplementationMarkers()
    {
        var source = ReadSource(SafetyAnalyzerPath) + ReadSource(OriginsPath) + ReadSource(CapturePath);
        var missing = ContextDispositions
            .Where(pair => !source.Contains(pair.Value, StringComparison.Ordinal))
            .Select(pair => pair.Key)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        Assert.True(
            missing.Length == 0,
            $"Managed-reference contexts have no concrete implementation marker: {string.Join(", ", missing)}");
    }

    [Fact]
    public void SelfTest_OmittedHighRiskNodeIsDetected()
    {
        var classifications = HighRiskExpressionDispositions.Keys
            .Where(name => name != nameof(BoundFunctionPointerInvocationExpression));
        Assert.Contains(
            nameof(BoundFunctionPointerInvocationExpression),
            Missing(DiscoverHighRiskBoundExpressions(), classifications));
    }

    [Fact]
    public void SelfTest_OmittedContextIsDetected()
    {
        var required = ContextDispositions.Keys.Append("synthetic-required-context");
        Assert.Contains("synthetic-required-context", Missing(required, ContextDispositions.Keys));
    }

    private static HashSet<string> DiscoverHighRiskBoundExpressions()
        => typeof(BoundExpression).Assembly.GetTypes()
            .Where(type => !type.IsAbstract && typeof(BoundExpression).IsAssignableFrom(type))
            .Where(IsHighRisk)
            .Select(type => type.Name)
            .ToHashSet(StringComparer.Ordinal);

    private static bool IsHighRisk(Type type)
        => type.Name.Contains("AssignmentExpression", StringComparison.Ordinal)
            || type.Name.Contains("CallExpression", StringComparison.Ordinal)
            || type.Name.Contains("InvocationExpression", StringComparison.Ordinal)
            || type.Name.Contains("MethodGroupExpression", StringComparison.Ordinal)
            || type.GetProperty("Arguments", BindingFlags.Instance | BindingFlags.Public) != null
            || type.Name is nameof(BoundDefaultExpression)
                or nameof(BoundArrayCreationExpression)
                or nameof(BoundMapLiteralExpression)
                or nameof(BoundStructLiteralExpression)
                or nameof(BoundTupleLiteralExpression)
                or nameof(BoundFunctionLiteralExpression)
                or nameof(BoundManagedReferenceExpression);

    private static List<string> Missing(IEnumerable<string> required, IEnumerable<string> present)
    {
        var found = present.ToHashSet(StringComparer.Ordinal);
        return required.Where(name => !found.Contains(name)).OrderBy(name => name, StringComparer.Ordinal).ToList();
    }

    private static string ReadSource(string relativePath)
        => File.ReadAllText(Path.Combine(TestSource.Root, relativePath));
}
