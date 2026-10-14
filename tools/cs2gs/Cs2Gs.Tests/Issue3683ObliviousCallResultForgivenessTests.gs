// <copyright file="Issue3683ObliviousCallResultForgivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Xunit

/// Issue #3683, family F5: a CALL RESULT whose declared return is an annotated
/// `T?` reference, read from an OBLIVIOUS file. This is the sibling of the
/// cast-receiver half (family F6, fixed in #3687) — the same
/// cross-nullable-context read through a different syntactic door.
/// `test/Core.Tests` declares no `Nullable` setting while
/// `src/Core` is annotated, so Roslyn erases the annotation at the call
/// site (the expression's type reports `NullableAnnotation.None` and the
/// flow state is `None`); none of the ordinary forgiveness predicates
/// fire, and the chained dereference reached gsc as a `T?` receiver
/// (GS0158 on a member, GS0116 on an index).
open class Issue3683ObliviousCallResultForgivenessTests {
    @Fact
    func ObliviousCallOfAnnotatedNullableReturn_MemberAccessReceiver_IsForgiven() {
        let printed = Translate(`
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            return node.Child().Name;
        }
    }
}`, out var declarations)
        Assert.Contains("node.Child()!!.Name", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func ObliviousCallOfAnnotatedNullableArrayReturn_ElementAccessReceiver_IsForgiven() {
        let printed = Translate(`
namespace Demo
{
    public class Holder
    {
        public Node Read(Node node)
        {
            return node.Children()[0];
        }
    }
}`, out var declarations)
        Assert.Contains("node.Children()!![0]", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func ObliviousReadOfAnnotatedNullableIndexer_MemberAccessReceiver_IsForgiven() {
        let printed = Translate(`
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            return node[0].Name;
        }
    }
}`, out var declarations)
        Assert.Contains("node[0]!!.Name", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func ObliviousCallOfNonNullableReturn_StaysUnforgiven() {
        let printed = Translate(`
namespace Demo
{
    public class Holder
    {
        public string Read(Node node)
        {
            return node.Required().Name;
        }
    }
}`, out var declarations)
        Assert.Contains("node.Required().Name", printed)
        Assert.DoesNotContain("Required()!!", printed)
        TranslationTestValidation.AssertBinds(declarations, printed)
    }

    @Fact
    func ObliviousAwaitOfNonNullableTaskReturn_EnvelopeStaysUnforgiven() {
        // A `Task<T>` envelope is itself non-null; nothing here is annotated, so
        // the new rule must not manufacture an assertion on the awaited call.
        let printed = Translate(`
using System.Threading.Tasks;

namespace Demo
{
    public class Holder
    {
        public async Task<string> ReadAsync(Node node)
        {
            return (await node.LoadAsync()).Name;
        }
    }
}`, out _)
        Assert.DoesNotContain("LoadAsync()!!", printed)
    }

    shared {
        // Deliberately ABSTRACT members: an annotated declaration with no body can
        // seed no evidence in the whole-program taint fixpoint, so these tests
        // exercise the ANNOTATION path only and never the (already-covered)
        // oblivious promotion path.
        private const AnnotatedDeclarations string = (`
#nullable enable
using System.Threading.Tasks;

namespace Demo
{
    public abstract class Node
    {
        private Node? slot;

        public string Name { get; set; } = string.Empty;

        public abstract Node? Child();

        public abstract Node Required();

        public abstract Node[]? Children();

        public abstract Task<Node> LoadAsync();

        // Concrete on purpose: gsc has no ` + "`" + `open prop this[...]` + "`" + ` form yet, so an
        // abstract indexer could not be bound back by AssertBinds.
        public Node? this[int index] => this.slot;
    }
}`)

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
