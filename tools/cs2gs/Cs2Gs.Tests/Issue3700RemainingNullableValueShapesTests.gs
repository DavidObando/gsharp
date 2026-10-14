// <copyright file="Issue3700RemainingNullableValueShapesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Xunit

/// Issue #3700: the two nullable-value shapes family F5 (#3683) deliberately
/// left alone, neither of which is the call-result receiver #3701 closed.
/// 1. A conditional-access continuation rooted at a null-conditional INDEX. gsc parses `?.` and `?[`
/// asymmetrically — the member form swallows the whole trailing chain into its guarded branch, the
/// index form is one postfix step whose result is `T?` — so the flat C# shape `a?[i].B` reaches gsc as
/// `(a?[i]).B` and is rejected (GS0158 / GS0116). Asserting the index result would be actively wrong:
/// it throws when the receiver itself is nil, which is the case `?[` exists to short-circuit.
/// 2. An iterator whose element was promoted nullable by a `yield return` that a null-check guard
/// already proves non-null. The repair is at the DECLARATION: the element must not be promoted at all.
open class Issue3700RemainingNullableValueShapesTests {
    @Fact
    func ConditionalIndexContinuation_MemberAccess_GetsItsOwnGuardedSeam() {
        let printed = Translate(`
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
}`, out var declarations)
        Assert.Contains("?[0]?.Name", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func ConditionalIndexContinuation_Invocation_GetsItsOwnGuardedSeam() {
        let printed = Translate(`
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
}`, out var declarations)
        Assert.Contains("?[0]?.Describe()", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func ConditionalIndexWithoutContinuation_KeepsTheSingleSeam() {
        let printed = Translate(`
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
}`, out var declarations)
        Assert.Contains("node.Children()?[0]", printed)
        Assert.DoesNotContain("?[0]?", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func GuardedYield_DoesNotPromoteTheIteratorElement() {
        let printed = Translate(`
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
}`, out var declarations)
        Assert.Contains("sequence[Node]", printed)
        Assert.DoesNotContain("sequence[Node?]", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func UnguardedYieldAlongsideAGuardedOne_StillPromotesTheElement() {
        // The exclusion is per-yield evidence, not per-iterator: one unguarded
        // nullable yield still widens the element.
        let printed = Translate(`
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
}`, out _)
        Assert.Contains("sequence[Node?]", printed)
    }

    shared {
        // Deliberately ABSTRACT members (mirroring #3683's fixture): an annotated
        // declaration with no body seeds no evidence in the whole-program taint
        // fixpoint, so these tests exercise the ANNOTATION path, not the
        // already-covered oblivious promotion path.
        private const AnnotatedDeclarations string = `
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
