// <copyright file="Adr0193SymbolicProjectionGapCallersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Xunit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.Tests

/// ADR-0193 Phase 2: the known symbolic-projection gap is three members.
/// `MemberLookup.MapOpenSignatureWithoutDeclarationMerge` is the one member
/// with a GSA0007 suppression. `ResolveCallReturnTypeFromSymbolicTypeArgs`
/// and `ResolveByRefParameterPointeeFromSymbolicTypeArgs` project through
/// it. Phase 4 adds the merge. GSA0007 cannot see a reference to any of them,
/// because they are named members rather than doors, so this test pins every
/// reference instead. Each one is keyed by the member that contains it, so
/// swapping a reviewed call for a new one elsewhere fails here, even in the
/// same file, until the new one is reviewed and added.
class Adr0193SymbolicProjectionGapCallersTests {
    @Fact
    func EveryReferenceToTheGapMembersIsListed() {
        // Issue #4656: the tree's own language (C# before the cut-over, G#
        // after), keyed by path WITHOUT extension so one list covers both, and a
        // scan that finds nothing fails instead of passing.
        let actual = TestSource
            .SourceFiles(SearchOption.AllDirectories, "src/Core/CodeAnalysis")
            .SelectMany(
            func (path string) IEnumerable[string] {
                let relative = TestSource.RelativeStem(path)["src/Core/CodeAnalysis/".Length ..]
                let references = if TestSource.IsGSharp {
                    GSharpReferences(path)
                } else {
                    CSharpReferences(path)
                }
                return references.Select((reference string) -> "$relative: $reference")
            }
        )
            .GroupBy((entry string) -> entry, StringComparer.Ordinal)
            .Select((group IGrouping[string, string]) -> "${group.Key} x${group.Count()}")
            .OrderBy((entry string) -> entry, StringComparer.Ordinal)
            .ToArray()
        Assert.True(
            Expected.SequenceEqual(actual),
            "The references to the symbolic-projection gap members changed. A new reference joins the Phase 4 gap; review it, then update the list to:" +
                Environment.NewLine +
                string.Join(Environment.NewLine, actual.Select((entry string) -> "        \"$entry\","))
        )
    }

    shared {
        private let GapMembers[]string = []string{
            "MapOpenSignatureWithoutDeclarationMerge",
            "ResolveCallReturnTypeFromSymbolicTypeArgs",
            "ResolveByRefParameterPointeeFromSymbolicTypeArgs"
        }
        private let Expected[]string = []string{
            "Binding/ExpressionBinder.Access.MemberLookup: ExpressionBinder.TryBindTypeParameterStaticClrCall -> ResolveCallReturnTypeFromSymbolicTypeArgs x1",
            "Binding/ExpressionBinder.Calls.Arguments: ExpressionBinder.TryBindConstrainedClrCall -> ResolveCallReturnTypeFromSymbolicTypeArgs x1",
            "Binding/ExpressionBinder.Calls.Arguments: ExpressionBinder.TryBindImportedExtensionCall -> ResolveCallReturnTypeFromSymbolicTypeArgs x1",
            "Binding/ExpressionBinder.Calls.Arguments: ExpressionBinder.TryResolveAndBindClrInstanceCall -> ResolveCallReturnTypeFromSymbolicTypeArgs x1",
            "Binding/ExpressionBinder.Calls.Invocation: ExpressionBinder.BindAccessorCallCore -> ResolveCallReturnTypeFromSymbolicTypeArgs x1",
            "Binding/ExpressionBinder.Calls.Invocation: ExpressionBinder.RebindInlineOutVarArguments -> ResolveByRefParameterPointeeFromSymbolicTypeArgs x1",
            "Binding/ExpressionBinder.Calls.Invocation: ExpressionBinder.TryBuildSymbolicDelegateTarget -> MapOpenSignatureWithoutDeclarationMerge x1",
            "Binding/ExpressionBinder.Calls.Invocation: ExpressionBinder.TryBuildSymbolicDelegateTargetForMethodParam -> MapOpenSignatureWithoutDeclarationMerge x2",
            "Binding/ExpressionBinder.Calls.Invocation: ExpressionBinder.TryMapDeferredLambdaTargetsSymbolic -> MapOpenSignatureWithoutDeclarationMerge x3",
            "Binding/ExpressionBinder.Literals: ExpressionBinder.RefineSymbolicArgsForMethodGroups -> MapOpenSignatureWithoutDeclarationMerge x1",
            "Binding/MemberLookup: MemberLookup.ResolveByRefParameterPointeeFromSymbolicTypeArgs -> MapOpenSignatureWithoutDeclarationMerge x1",
            "Binding/MemberLookup: MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs -> MapOpenSignatureWithoutDeclarationMerge x2",
            "Binding/OverloadResolution/OverloadResolver.Arguments: OverloadResolver.ExpandParamsArguments -> MapOpenSignatureWithoutDeclarationMerge x1",
            "Symbols/ImportedClassSymbol: ImportedClassSymbol.TryLookupNativeFunction -> ResolveCallReturnTypeFromSymbolicTypeArgs x1"
        }

        private func CSharpReferences(path string) IEnumerable[string] {
            let tree = CSharpSyntaxTree.ParseText(File.ReadAllText(path))
            return tree
                .GetRoot()
                .DescendantNodes()
                .OfType[IdentifierNameSyntax]()
                .Where(
                (name IdentifierNameSyntax) -> GapMembers.Contains(name.Identifier.ValueText) && !IsInNameOf(name)
            )
                .Select((name IdentifierNameSyntax) -> "${ContainingMember(name)} -> ${name.Identifier.ValueText}")
        }

        private func GSharpReferences(path string) IEnumerable[string] -> GSharpSourceSyntax
            .NameReferences(GSharpSourceSyntax.Parse(path).Root)
            .Where(
            (reference(Node GSharp.Core.CodeAnalysis.Syntax.SyntaxNode, Name string)) -> GapMembers.Contains(
                reference.Name
            ) &&
                !GSharpSourceSyntax.IsInNameOf(reference.Node)
        )
            .Select(
            (
                reference(Node GSharp.Core.CodeAnalysis.Syntax.SyntaxNode, Name string)
            ) -> "${GSharpSourceSyntax.ContainingMember(reference.Node)} -> ${reference.Name}"
        )

        // DescendantNodes() does not enter documentation trivia, so a cref is
        // never seen; a nameof() names a member without calling it.
        private func IsInNameOf(node Microsoft.CodeAnalysis.SyntaxNode) bool -> node.Ancestors().Any(
            (ancestor Microsoft.CodeAnalysis.SyntaxNode) -> (
                ancestor is InvocationExpressionSyntax and
                    {Expression: IdentifierNameSyntax and {Identifier: {ValueText: "nameof"}}}
            )
        )

        private func ContainingMember(node Microsoft.CodeAnalysis.SyntaxNode) string {
            let member = node
                .Ancestors()
                .OfType[MemberDeclarationSyntax]()
                .First((candidate MemberDeclarationSyntax) -> !(candidate is BaseTypeDeclarationSyntax))
            let type = member.Ancestors().OfType[BaseTypeDeclarationSyntax]().First().Identifier.ValueText
            let name = switch member {
                case method is MethodDeclarationSyntax: method.Identifier.ValueText
                case _ is Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax: ".ctor"
                case property is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .PropertyDeclarationSyntax: property
                    .Identifier
                    .ValueText
                case _ is IndexerDeclarationSyntax: "this[]"
                case field is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .FieldDeclarationSyntax: field
                    .Declaration
                    .Variables[0]
                    .Identifier
                    .ValueText
                case op is OperatorDeclarationSyntax: "operator " + op.OperatorToken.ValueText
                default: member.Kind().ToString()
            }
            return type + "." + name
        }
    }
}
