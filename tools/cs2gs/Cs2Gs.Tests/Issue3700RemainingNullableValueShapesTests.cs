// <copyright file="Issue3700RemainingNullableValueShapesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3700: the two nullable-value shapes family F5 (#3683) deliberately
/// left alone, neither of which is the call-result receiver #3701 closed.
/// <list type="number">
/// <item>A conditional-access continuation rooted at a null-conditional INDEX.
/// gsc parses <c>?.</c> and <c>?[</c> asymmetrically — the member form swallows
/// the whole trailing chain into its guarded branch, the index form is one
/// postfix step whose result is <c>T?</c> — so the flat C# shape
/// <c>a?[i].B</c> reaches gsc as <c>(a?[i]).B</c> and is rejected (GS0158 /
/// GS0116). Asserting the index result would be actively wrong: it throws when
/// the receiver itself is nil, which is the case <c>?[</c> exists to
/// short-circuit.</item>
/// <item>An iterator whose element was promoted nullable by a <c>yield
/// return</c> that a null-check guard already proves non-null. The repair is at
/// the DECLARATION: the element must not be promoted at all.</item>
/// </list>
/// </summary>
public class Issue3700RemainingNullableValueShapesTests
{
    // Deliberately ABSTRACT members (mirroring #3683's fixture): an annotated
    // declaration with no body seeds no evidence in the whole-program taint
    // fixpoint, so these tests exercise the ANNOTATION path, not the
    // already-covered oblivious promotion path.
    private const string AnnotatedDeclarations = @"
#nullable enable

namespace Demo
{
    public abstract class Node
    {
        public string Name { get; set; } = string.Empty;

        public abstract Node? Child();

        public abstract Node[]? Children();

        public abstract string Describe();
    }
}";

    [Fact]
    public void ConditionalIndexContinuation_MemberAccess_GetsItsOwnGuardedSeam()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            var name = node.Children()?[0].Name;
            return name ?? string.Empty;
        }
    }
}", out string declarations);

        Assert.Contains("?[0]?.Name", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ConditionalIndexContinuation_Invocation_GetsItsOwnGuardedSeam()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            var text = node.Children()?[0].Describe();
            return text ?? string.Empty;
        }
    }
}", out string declarations);

        Assert.Contains("?[0]?.Describe()", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void ConditionalIndexWithoutContinuation_KeepsTheSingleSeam()
    {
        string printed = Translate(@"
namespace Demo
{
    public class Holder
    {
        public Node Read(Node node)
        {
            var first = node.Children()?[0];
            return first;
        }
    }
}", out string declarations);

        Assert.Contains("node.Children()?[0]", printed);
        Assert.DoesNotContain("?[0]?", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void GuardedYield_DoesNotPromoteTheIteratorElement()
    {
        string printed = Translate(@"
using System.Collections.Generic;

namespace Demo
{
    public class Walker
    {
        public IEnumerable<Node> Children(Node node)
        {
            Node child = node.Child();
            if (child != null)
            {
                yield return child;
            }
        }
    }
}", out string declarations);

        Assert.Contains("sequence[Node]", printed);
        Assert.DoesNotContain("sequence[Node?]", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void UnguardedYieldAlongsideAGuardedOne_StillPromotesTheElement()
    {
        // The exclusion is per-yield evidence, not per-iterator: one unguarded
        // nullable yield still widens the element.
        string printed = Translate(@"
using System.Collections.Generic;

namespace Demo
{
    public class Walker
    {
        public IEnumerable<Node> Children(Node node)
        {
            Node child = node.Child();
            if (child != null)
            {
                yield return child;
            }

            yield return null;
        }
    }
}", out _);

        Assert.Contains("sequence[Node?]", printed);
    }

    // Returns the printed consumer file, and hands back the printed ANNOTATED
    // declarations too so callers can bind the pair with
    // <see cref="TranslationTestValidation.AssertBinds(string[])"/>.
    private static string Translate(string obliviousSource, out string printedDeclarations)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Annotated.cs", AnnotatedDeclarations), ("Oblivious.cs", obliviousSource) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics));

        printedDeclarations = Print(project, 0);
        return Print(project, 1);
    }

    private static string Print(LoadedCSharpProject project, int documentIndex)
    {
        LoadedDocument document = project.Documents[documentIndex];
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
