// <copyright file="Issue3714LoopGuardedYieldElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Xunit

/// Issue #3714: an iterator whose element was promoted nullable by a
/// `yield return` that a LOOP CONDITION already proves non-null. The
/// shape that surfaced it is the base-declaration walk introduced into
/// `ObliviousNullabilityAnalyzer` by #3706 — `for (ISymbol current =
/// Overridden(m); current != null; current = Overridden(current)) { yield
/// return current; }` — consumed by a `sequence[ISymbol]`-declared
/// iterator that yields the `foreach` variable straight through. Promoting
/// the producer's element left the two DISAGREEING: the consumer kept its
/// `sequence[ISymbol]` declaration (nothing taints a plain `foreach`
/// variable) while gsc inferred the loop variable as `ISymbol?` from the
/// producer's element, so the pass-through yield was rejected (GS0155).
///
/// The repair is the same one #3700 / #3709 made for an `if` guard, at the
/// DECLARATION rather than the value: a loop condition guards its body exactly
/// as an `if` condition guards its consequence, so the yield is no
/// evidence at all about the element.
open class Issue3714LoopGuardedYieldElementTests {
    @Fact
    func ForConditionGuardedYield_DoesNotPromoteTheIteratorElement() {
        let printed = Translate(`
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
}`, out var declarations)
        Assert.Contains("sequence[Node]", printed)
        Assert.DoesNotContain("sequence[Node?]", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func WhileConditionGuardedYield_DoesNotPromoteTheIteratorElement() {
        let printed = Translate(`
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
}`, out var declarations)
        Assert.Contains("sequence[Node]", printed)
        Assert.DoesNotContain("sequence[Node?]", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func DoWhileConditionGuardedYield_StillPromotesTheElement() {
        // A `do`/`while` condition is tested AFTER the body, so it proves
        // nothing on entry — the first yield really can be null.
        let printed = Translate(`
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
}`, out _)
        Assert.Contains("sequence[Node?]", printed)
    }

    @Fact
    func ALoopGuardedProducerAgreesWithAPassThroughConsumer() {
        // The reported shape: the consumer's own declaration stays
        // `sequence[Node]` (nothing taints a plain `foreach` variable), so the
        // producer's element must stay `Node` too or the pass-through yield is
        // a `Node? -> Node` (GS0155).
        let printed = Translate(`
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
}`, out var declarations)
        Assert.DoesNotContain("sequence[Node?]", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    shared {
        // Deliberately ABSTRACT members (the #3683 / #3700 fixture): an annotated
        // declaration with no body seeds no evidence in the whole-program taint
        // fixpoint, so these tests exercise the ANNOTATION path rather than the
        // already-covered oblivious promotion path.
        private const AnnotatedDeclarations string = `
#nullable enable

namespace Demo
{
    public abstract class Node
    {
        public string Name { get; set; } = string.Empty;

        public abstract Node? Parent();
    }
}`

        // Returns the printed consumer file, and hands back the printed ANNOTATED
        // declarations too so callers can bind the pair with
        // <see cref="TranslationTestValidation.AssertBinds(string[])"/>.
        private func Translate(obliviousSource string, out printedDeclarations string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){("Annotated.cs", AnnotatedDeclarations), ("Oblivious.cs", obliviousSource)}
            )
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join("\n", project.ErrorDiagnostics)
            )
            printedDeclarations = Print(project, 0)
            return Print(project, 1)
        }

        private func Print(project LoadedCSharpProject, documentIndex int32) string {
            let document = project.Documents[documentIndex]
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
