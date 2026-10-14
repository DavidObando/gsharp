// <copyright file="Issue4612StoreBridgeInventoryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4612: keeps the `CS2GS-GENERIC-STORE-BRIDGE` report complete.
/// Every place in the translator that builds a `!!` must either hand it to
/// `ReportStoreBridge` (a store-position bridge), be inside
/// `ForgiveNullableReferenceValueCore` (whose result the funnel reports),
/// or be listed below with the reason it is not a store into a slot. A new
/// emission point anywhere in the translator fails this test until it is
/// classified.
/// @remarks Discrimination witness (ADR-0154): adding a bare
/// `EnsureNonNullAssertion(x)` to any translator method, or removing a
/// `ReportStoreBridge` wrapper, changes a count below and fails the test.
open class Issue4612StoreBridgeInventoryTests {
    @Fact
    func EveryNonNullAssertion_IsAStoreBridgeOrListedWithAReason() {
        let translatorDirectory = Path.Combine(
            Adr0169TranslatedAnalyzerHarness.FindRepoRoot(),
            "tools",
            "cs2gs",
            "Cs2Gs.Translator"
        )
        let actual = SortedDictionary[string, int32](StringComparer.Ordinal)
        var funneled = 0
        var coreCalls = 0
        for file in Directory.GetFiles(translatorDirectory, "*.cs", SearchOption.AllDirectories).Where(
            (path string) -> !path.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar)
        ) {
            let root = CSharpSyntaxTree.ParseText(File.ReadAllText(file)).GetRoot()
            // ForgiveNullableReferenceValueCore's own `!!` constructions count
            // as funneled only because its result is handed to the funnel; pin
            // that every call of it is a ReportStoreBridge argument.
            for coreCall in root
                .DescendantNodes()
                .OfType[InvocationExpressionSyntax]()
                .Where(
                (call InvocationExpressionSyntax) -> RightmostName(
                    call.Expression
                ) == "ForgiveNullableReferenceValueCore"
            ) {
                coreCalls++
                Assert.True(
                    IsReportStoreBridgeArgument(coreCall),
                    "${Path.GetFileName(file)}: a ForgiveNullableReferenceValueCore call is not handed to ReportStoreBridge: $coreCall"
                )
            }
            for site in root.DescendantNodes().Where(IsAssertionConstruction) {
                let member = EnclosingMemberName(site)
                if member == "EnsureNonNullAssertion" {
                    continue
                }
                if member == "ForgiveNullableReferenceValueCore" || IsReportStoreBridgeArgument(site) {
                    funneled++
                    continue
                }
                actual[member] = if actual.TryGetValue(member, out var count) {
                    count + 1
                } else {
                    1
                }
            }
        }
        Assert.True(funneled >= 10, "expected the store bridges to be found; found $funneled")
        Assert.True(coreCalls >= 1, "expected ForgiveNullableReferenceValueCore to be called")
        let expected = SortedDictionary[string, int32](
            NotStoreBridges.ToDictionary(
                func (entry KeyValuePair[string, (Count int32, Reason string)]) string {
                    return entry.Key
                },
                (entry KeyValuePair[string, (Count int32, Reason string)]) -> entry.Value.Count
            ),
            StringComparer.Ordinal
        )
        if !expected.SequenceEqual(actual) {
            let message = StringBuilder()
                .AppendLine("A `!!` construction in the translator is neither handed to ReportStoreBridge nor listed.")
                .AppendLine(
                "Route a store-position bridge through ReportStoreBridge (#4612); list anything else with its reason."
            )
                .AppendLine("Actual non-store sites:")
            for entry in actual {
                message.AppendLine("  [\"${entry.Key}\"] = (${entry.Value}, ...),")
            }
            Assert.Fail(message.ToString())
        }
    }

    shared {
        // Method name -> number of `!!` constructions in it that are not store
        // bridges, and why.
        private let NotStoreBridges Dictionary[string, (Count int32, Reason string)] = Dictionary[
            string,
            (Count int32, Reason string)
        ]{
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
            ["TryTranslateAnalyzerTypeNameSwitch"] = (1, "analyzer-API switch subject")
        }

        private func IsAssertionConstruction(node SyntaxNode) bool -> switch node {
            case creation is ObjectCreationExpressionSyntax: RightmostName(
                creation.Type
            ) == "NonNullAssertionExpression"
            case invocation is InvocationExpressionSyntax: RightmostName(
                invocation.Expression
            ) == "EnsureNonNullAssertion"
            default: false
        }

        private func IsReportStoreBridgeArgument(site SyntaxNode) bool {
            for var node SyntaxNode? = site.Parent; node != nil && !(node is StatementSyntax); node = node!!.Parent {
                // The `!!` (or the core result) must be the funnel's third
                // argument, `bridged`: anywhere else the funnel reports nothing.
                if node is ArgumentSyntax argument &&
                    argument.Parent is ArgumentListSyntax list &&
                    list.Parent is InvocationExpressionSyntax invocation &&
                    (RightmostName(invocation.Expression) is "ReportStoreBridge" or "ReportForgivenStoreBridge") {
                    // The assertion or core call itself, not something wrapping it.
                    return list.Arguments.IndexOf(argument) == 2 && argument.Expression == site
                }
            }
            return false
        }

        // The identifier a (possibly qualified or `this.`-prefixed) name ends in.
        private func RightmostName(node SyntaxNode) string? -> switch node {
            case simple is SimpleNameSyntax: simple.Identifier.ValueText
            case qualified is QualifiedNameSyntax: qualified.Right.Identifier.ValueText
            case alias is AliasQualifiedNameSyntax: alias.Name.Identifier.ValueText
            case access is MemberAccessExpressionSyntax: access.Name.Identifier.ValueText
            default: default(string?)
        }

        private func EnclosingMemberName(site SyntaxNode) string {
            for node in site.Ancestors() {
                switch node {
                    case method is MethodDeclarationSyntax {
                        return method.Identifier.ValueText
                    }
                    case property is PropertyDeclarationSyntax {
                        return property.Identifier.ValueText
                    }
                    case constructor is ConstructorDeclarationSyntax {
                        return constructor.Identifier.ValueText
                    }
                }
            }
            return "<top level>"
        }
    }
}
