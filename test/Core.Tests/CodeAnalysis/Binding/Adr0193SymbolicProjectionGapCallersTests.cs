// <copyright file="Adr0193SymbolicProjectionGapCallersTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0193 Phase 2: the known symbolic-projection gap is three members.
/// <c>MemberLookup.MapOpenSignatureWithoutDeclarationMerge</c> is the one member
/// with a GSA0007 suppression. <c>ResolveCallReturnTypeFromSymbolicTypeArgs</c>
/// and <c>ResolveByRefParameterPointeeFromSymbolicTypeArgs</c> project through
/// it. Phase 4 adds the merge. GSA0007 cannot see a reference to any of them,
/// because they are named members rather than doors, so this test pins every
/// reference instead. Each one is keyed by the member that contains it, so
/// swapping a reviewed call for a new one elsewhere fails here, even in the
/// same file, until the new one is reviewed and added.
/// </summary>
public sealed class Adr0193SymbolicProjectionGapCallersTests
{
    private static readonly string[] GapMembers =
    [
        "MapOpenSignatureWithoutDeclarationMerge",
        "ResolveCallReturnTypeFromSymbolicTypeArgs",
        "ResolveByRefParameterPointeeFromSymbolicTypeArgs",
    ];

    private static readonly string[] Expected =
    [
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
        "Symbols/ImportedClassSymbol: ImportedClassSymbol.TryLookupFunction -> ResolveCallReturnTypeFromSymbolicTypeArgs x1",
    ];

    [Fact]
    public void EveryReferenceToTheGapMembersIsListed()
    {
        // Issue #4656: the tree's own language (C# before the cut-over, G#
        // after), keyed by path WITHOUT extension so one list covers both, and a
        // scan that finds nothing fails instead of passing.
        var actual = TestSource.SourceFiles(SearchOption.AllDirectories, "src/Core/CodeAnalysis")
            .SelectMany(path =>
            {
                var relative = TestSource.RelativeStem(path)["src/Core/CodeAnalysis/".Length..];
                var references = TestSource.IsGSharp ? GSharpReferences(path) : CSharpReferences(path);
                return references.Select(reference => $"{relative}: {reference}");
            })
            .GroupBy(entry => entry, StringComparer.Ordinal)
            .Select(group => $"{group.Key} x{group.Count()}")
            .OrderBy(entry => entry, StringComparer.Ordinal)
            .ToArray();

        Assert.True(
            Expected.SequenceEqual(actual),
            "The references to the symbolic-projection gap members changed. A new reference joins the Phase 4 gap; review it, then update the list to:"
                + Environment.NewLine
                + string.Join(Environment.NewLine, actual.Select(entry => $"        \"{entry}\",")));
    }

    private static IEnumerable<string> CSharpReferences(string path)
    {
        var tree = CSharpSyntaxTree.ParseText(File.ReadAllText(path));
        return tree.GetRoot()
            .DescendantNodes()
            .OfType<IdentifierNameSyntax>()
            .Where(name => GapMembers.Contains(name.Identifier.ValueText) && !IsInNameOf(name))
            .Select(name => $"{ContainingMember(name)} -> {name.Identifier.ValueText}");
    }

    private static IEnumerable<string> GSharpReferences(string path) =>
        GSharpSourceSyntax.NameReferences(GSharpSourceSyntax.Parse(path).Root)
            .Where(reference => GapMembers.Contains(reference.Name) && !GSharpSourceSyntax.IsInNameOf(reference.Node))
            .Select(reference => $"{GSharpSourceSyntax.ContainingMember(reference.Node)} -> {reference.Name}");

    // DescendantNodes() does not enter documentation trivia, so a cref is
    // never seen; a nameof() names a member without calling it.
    private static bool IsInNameOf(SyntaxNode node)
        => node.Ancestors().Any(ancestor => ancestor is InvocationExpressionSyntax { Expression: IdentifierNameSyntax { Identifier.ValueText: "nameof" } });

    private static string ContainingMember(SyntaxNode node)
    {
        var member = node.Ancestors().OfType<MemberDeclarationSyntax>()
            .First(candidate => candidate is not BaseTypeDeclarationSyntax);
        var type = member.Ancestors().OfType<BaseTypeDeclarationSyntax>().First().Identifier.ValueText;
        var name = member switch
        {
            MethodDeclarationSyntax method => method.Identifier.ValueText,
            ConstructorDeclarationSyntax => ".ctor",
            PropertyDeclarationSyntax property => property.Identifier.ValueText,
            IndexerDeclarationSyntax => "this[]",
            FieldDeclarationSyntax field => field.Declaration.Variables[0].Identifier.ValueText,
            OperatorDeclarationSyntax op => "operator " + op.OperatorToken.ValueText,
            _ => member.Kind().ToString(),
        };
        return type + "." + name;
    }
}
