// <copyright file="Issue3714LoopGuardedYieldElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3714: an iterator whose element was promoted nullable by a
/// <c>yield return</c> that a LOOP CONDITION already proves non-null. The
/// shape that surfaced it is the base-declaration walk introduced into
/// <c>ObliviousNullabilityAnalyzer</c> by #3706 — <c>for (ISymbol current =
/// Overridden(m); current != null; current = Overridden(current)) { yield
/// return current; }</c> — consumed by a <c>sequence[ISymbol]</c>-declared
/// iterator that yields the <c>foreach</c> variable straight through. Promoting
/// the producer's element left the two DISAGREEING: the consumer kept its
/// <c>sequence[ISymbol]</c> declaration (nothing taints a plain <c>foreach</c>
/// variable) while gsc inferred the loop variable as <c>ISymbol?</c> from the
/// producer's element, so the pass-through yield was rejected (GS0155).
/// <para>
/// The repair is the same one #3700 / #3709 made for an <c>if</c> guard, at the
/// DECLARATION rather than the value: a loop condition guards its body exactly
/// as an <c>if</c> condition guards its consequence, so the yield is no
/// evidence at all about the element.
/// </para>
/// </summary>
public class Issue3714LoopGuardedYieldElementTests
{
    // Deliberately ABSTRACT members (the #3683 / #3700 fixture): an annotated
    // declaration with no body seeds no evidence in the whole-program taint
    // fixpoint, so these tests exercise the ANNOTATION path rather than the
    // already-covered oblivious promotion path.
    private const string AnnotatedDeclarations = @"
#nullable enable

namespace Demo
{
    public abstract class Node
    {
        public string Name { get; set; } = string.Empty;

        public abstract Node? Parent();
    }
}";

    [Fact]
    public void ForConditionGuardedYield_DoesNotPromoteTheIteratorElement()
    {
        string printed = Translate(
            @"
using System.Collections.Generic;

namespace Demo
{
    public class Walker
    {
        public IEnumerable<Node> Ancestors(Node node)
        {
            for (Node current = node.Parent(); current != null; current = current.Parent())
            {
                yield return current;
            }
        }
    }
}",
            out string declarations);

        Assert.Contains("sequence[Node]", printed);
        Assert.DoesNotContain("sequence[Node?]", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void WhileConditionGuardedYield_DoesNotPromoteTheIteratorElement()
    {
        string printed = Translate(
            @"
using System.Collections.Generic;

namespace Demo
{
    public class Walker
    {
        public IEnumerable<Node> Ancestors(Node node)
        {
            Node current = node.Parent();
            while (current != null)
            {
                yield return current;
                current = current.Parent();
            }
        }
    }
}",
            out string declarations);

        Assert.Contains("sequence[Node]", printed);
        Assert.DoesNotContain("sequence[Node?]", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
    }

    [Fact]
    public void DoWhileConditionGuardedYield_StillPromotesTheElement()
    {
        // A `do`/`while` condition is tested AFTER the body, so it proves
        // nothing on entry — the first yield really can be null.
        string printed = Translate(
            @"
using System.Collections.Generic;

namespace Demo
{
    public class Walker
    {
        public IEnumerable<Node> Ancestors(Node node)
        {
            Node current = node.Parent();
            do
            {
                yield return current;
                current = current.Parent();
            }
            while (current != null);
        }
    }
}",
            out _);

        Assert.Contains("sequence[Node?]", printed);
    }

    [Fact]
    public void ALoopGuardedProducerAgreesWithAPassThroughConsumer()
    {
        // The reported shape: the consumer's own declaration stays
        // `sequence[Node]` (nothing taints a plain `foreach` variable), so the
        // producer's element must stay `Node` too or the pass-through yield is
        // a `Node? -> Node` (GS0155).
        string printed = Translate(
            @"
using System.Collections.Generic;

namespace Demo
{
    public class Walker
    {
        public IEnumerable<Node> ContractSites(Node node)
        {
            yield return node;
            foreach (Node inherited in Ancestors(node))
            {
                yield return inherited;
            }
        }

        private static IEnumerable<Node> Ancestors(Node node)
        {
            for (Node current = node.Parent(); current != null; current = current.Parent())
            {
                yield return current;
            }
        }
    }
}",
            out string declarations);

        Assert.DoesNotContain("sequence[Node?]", printed);
        TranslationTestValidation.AssertBinds(declarations, printed);
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
