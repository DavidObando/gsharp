// <copyright file="Issue4612StoreBridgeInventoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4612: keeps the <c>CS2GS-GENERIC-STORE-BRIDGE</c> report complete.
/// Every place in the translator that builds a <c>!!</c> must either hand it to
/// <c>ReportStoreBridge</c> (a store-position bridge), be inside
/// <c>ForgiveNullableReferenceValueCore</c> (whose result the funnel reports),
/// or be listed below with the reason it is not a store into a slot. A new
/// emission point anywhere in the translator fails this test until it is
/// classified.
/// </summary>
/// <remarks>
/// Discrimination witness (ADR-0154): adding a bare
/// <c>EnsureNonNullAssertion(x)</c> to any translator method, or removing a
/// <c>ReportStoreBridge</c> wrapper, changes a count below and fails the test.
/// </remarks>
public class Issue4612StoreBridgeInventoryTests
{
    // Method name -> number of `!!` constructions in it that are not store
    // bridges, and why.
    private static readonly Dictionary<string, (int Count, string Reason)> NotStoreBridges = new()
    {
        ["AssertFlowNarrowedNullableReference"] = (1, "C# flow analysis proved the value non-null here"),
        ["BuildNegatedPatternBindingValue"] = (3, "pattern binding narrowed by the enclosing test"),
        ["BuildNullConditionalStaticExtensionHelper"] = (1, "receiver of a ?. helper, guarded by its nil test"),
        ["BuildPatternNarrowingReplacement"] = (4, "pattern binding narrowed by the enclosing test"),
        ["BuildPositiveValueGuardHoist"] = (1, "value narrowed by the hoisted guard"),
        ["EmitGuardedFieldLocalCaptures"] = (1, "field capture narrowed by its guard"),
        ["MaterializeFallbackPatternBindings"] = (1, "pattern binding narrowed by the enclosing test"),
        ["NarrowToType"] = (1, "type-test narrowing, not a store"),
        ["SnapshotReorderedDelegateTarget"] = (1, "delegate call receiver"),
        ["TranslateAssignmentAsExpression"] = (1, "result of an assignment expression, not a store"),
        ["TranslateAssignmentTarget"] = (2, "assignment-target receiver"),
        ["TranslateCast"] = (2, "cast operand"),
        ["TranslateCoalescingAssignmentAsExpression"] = (1, "result of ??=, not a store"),
        ["TranslateConditionalAccessWithLocalAssignmentSeam"] = (1, "receiver of a ?. access"),
        ["TranslateExpression"] = (1, "the ??= hoisted assignment target"),
        ["TranslateExtendedPropertyLink"] = (2, "receiver of an extended property pattern"),
        ["TranslateIdentifierName"] = (1, "recursive local function reference"),
        ["TranslateInvocationCore"] = (2, "call receiver"),
        ["TranslateListPatternTest"] = (1, "pattern subject narrowed by the test"),
        ["TranslateMemberAccess"] = (1, "member-access receiver"),
        ["TranslateNotPatternTest"] = (1, "pattern subject narrowed by the test"),
        ["TranslatePatternTest"] = (1, "pattern subject narrowed by the test"),
        ["TranslateReceiverWithNullForgiveness"] = (2, "dereference receiver"),
        ["TranslateRecursivePatternTest"] = (3, "pattern subject narrowed by the test"),
        ["TranslateVoidConditionalAccessWithLocalAssignmentSeam"] = (1, "receiver of a ?. access"),
        ["TranslateYieldStatement"] = (1, "C# flow analysis proved the yielded value non-null"),
        ["TryBuildNestedNegatedGuardHoist"] = (1, "value narrowed by the hoisted guard"),
        ["TryBuildPositiveGuardHoist"] = (1, "value narrowed by the hoisted guard"),
        ["TryTranslateAnalyzerMemberAccess"] = (1, "analyzer-API member-access receiver"),
        ["TryTranslateAnalyzerTypeNameSwitch"] = (1, "analyzer-API switch subject"),
    };

    [Fact]
    public void EveryNonNullAssertion_IsAStoreBridgeOrListedWithAReason()
    {
        string translatorDirectory = Path.Combine(
            Adr0169TranslatedAnalyzerHarness.FindRepoRoot(), "tools", "cs2gs", "Cs2Gs.Translator");
        var actual = new SortedDictionary<string, int>(System.StringComparer.Ordinal);
        int funneled = 0;
        int coreCalls = 0;
        foreach (string file in Directory.GetFiles(translatorDirectory, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)))
        {
            SyntaxNode root = CSharpSyntaxTree.ParseText(File.ReadAllText(file)).GetRoot();

            // ForgiveNullableReferenceValueCore's own `!!` constructions count
            // as funneled only because its result is handed to the funnel; pin
            // that every call of it is a ReportStoreBridge argument.
            foreach (InvocationExpressionSyntax coreCall in root.DescendantNodes().OfType<InvocationExpressionSyntax>()
                .Where(call => RightmostName(call.Expression) == "ForgiveNullableReferenceValueCore"))
            {
                coreCalls++;
                Assert.True(
                    IsReportStoreBridgeArgument(coreCall),
                    $"{Path.GetFileName(file)}: a ForgiveNullableReferenceValueCore call is not handed to ReportStoreBridge: {coreCall}");
            }

            foreach (SyntaxNode site in root.DescendantNodes().Where(IsAssertionConstruction))
            {
                string member = EnclosingMemberName(site);
                if (member == "EnsureNonNullAssertion")
                {
                    continue;
                }

                if (member == "ForgiveNullableReferenceValueCore" || IsReportStoreBridgeArgument(site))
                {
                    funneled++;
                    continue;
                }

                actual[member] = actual.TryGetValue(member, out int count) ? count + 1 : 1;
            }
        }

        Assert.True(funneled >= 10, $"expected the store bridges to be found; found {funneled}");
        Assert.True(coreCalls >= 1, "expected ForgiveNullableReferenceValueCore to be called");
        var expected = new SortedDictionary<string, int>(
            NotStoreBridges.ToDictionary(entry => entry.Key, entry => entry.Value.Count),
            System.StringComparer.Ordinal);
        if (!expected.SequenceEqual(actual))
        {
            var message = new StringBuilder()
                .AppendLine("A `!!` construction in the translator is neither handed to ReportStoreBridge nor listed.")
                .AppendLine("Route a store-position bridge through ReportStoreBridge (#4612); list anything else with its reason.")
                .AppendLine("Actual non-store sites:");
            foreach (KeyValuePair<string, int> entry in actual)
            {
                message.AppendLine($"  [\"{entry.Key}\"] = ({entry.Value}, ...),");
            }

            Assert.Fail(message.ToString());
        }
    }

    private static bool IsAssertionConstruction(SyntaxNode node) => node switch
    {
        ObjectCreationExpressionSyntax creation => RightmostName(creation.Type) == "NonNullAssertionExpression",
        InvocationExpressionSyntax invocation => RightmostName(invocation.Expression) == "EnsureNonNullAssertion",
        _ => false,
    };

    private static bool IsReportStoreBridgeArgument(SyntaxNode site)
    {
        for (SyntaxNode node = site.Parent; node != null && node is not StatementSyntax; node = node.Parent)
        {
            // The `!!` (or the core result) must be the funnel's third
            // argument, `bridged`: anywhere else the funnel reports nothing.
            if (node is ArgumentSyntax argument
                && argument.Parent is ArgumentListSyntax list
                && list.Parent is InvocationExpressionSyntax invocation
                && RightmostName(invocation.Expression) is "ReportStoreBridge" or "ReportForgivenStoreBridge")
            {
                // The assertion or core call itself, not something wrapping it.
                return list.Arguments.IndexOf(argument) == 2 && argument.Expression == site;
            }
        }

        return false;
    }

    // The identifier a (possibly qualified or `this.`-prefixed) name ends in.
    private static string RightmostName(SyntaxNode node) => node switch
    {
        SimpleNameSyntax simple => simple.Identifier.ValueText,
        QualifiedNameSyntax qualified => qualified.Right.Identifier.ValueText,
        AliasQualifiedNameSyntax alias => alias.Name.Identifier.ValueText,
        MemberAccessExpressionSyntax access => access.Name.Identifier.ValueText,
        _ => null,
    };

    private static string EnclosingMemberName(SyntaxNode site)
    {
        foreach (SyntaxNode node in site.Ancestors())
        {
            switch (node)
            {
                case MethodDeclarationSyntax method:
                    return method.Identifier.ValueText;
                case PropertyDeclarationSyntax property:
                    return property.Identifier.ValueText;
                case ConstructorDeclarationSyntax constructor:
                    return constructor.Identifier.ValueText;
            }
        }

        return "<top level>";
    }
}
