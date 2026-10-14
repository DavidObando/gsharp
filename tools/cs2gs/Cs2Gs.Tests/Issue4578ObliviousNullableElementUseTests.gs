// <copyright file="Issue4578ObliviousNullableElementUseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issues #4578 and #4577: in a nullable-oblivious compilation, a source
/// iterator whose element the taint analysis promotes renders
/// `sequence[T?]`, so G# infers every `for x in Iterator(...)`
/// binding as `T?`. The C# loop declares a plain oblivious `T`,
/// and cs2gs used to treat the binding as non-null: member accesses,
/// arguments and initializers in the body got no `!!` (GS0158 / GS0154 /
/// GS0155). A lambda capturing the binding inside a LINQ chain failed the
/// same way, and gsc reported the failed lambda as the chain's method being
/// missing (#4577: `.OfType[T]().Where(...)` "Cannot find function
/// Where"). The loop binding now asks the same promotion question the
/// iterator's declaration asks.
open class Issue4578ObliviousNullableElementUseTests {
    @Fact
    func ForEachOverPromotedIteratorElement_AssertsBindingAtEachNonNullUse() {
        let printed = TranslateOblivious(Prelude + `
        public int Run(Node root)
        {
            int total = 0;
            foreach (Node item in Items(root))
            {
                Node copy = item;
                total += Use(item) + item.Start + copy.Start;
            }

            return total;
        }
    }
}`)
        Assert.Contains("sequence[Node?]", printed)
        Assert.Contains("Use(item!!)", printed)
        Assert.Contains("item!!.Start", printed)
    }

    @Fact
    func ForEachOverSuppressedPromotedIteratorCall_AssertsBinding() {
        // A C# `!` on the collection changes only its flow state; the element
        // is still `Node?`, whatever the mix of parentheses and suppressions.
        let printed = TranslateOblivious(Prelude + `
        public int Run(Node root)
        {
            int total = 0;
            foreach (Node item in Items(root)!)
            {
                total += Use(item) + item.Start;
            }

            foreach (Node other in ((Items(root))!))
            {
                total += other.Start;
            }

            return total;
        }
    }
}`)
        Assert.Contains("Use(item!!)", printed)
        Assert.Contains("item!!.Start", printed)
        Assert.Contains("other!!.Start", printed)
    }

    @Fact
    func LambdaCapturingPromotedIteratorBinding_InOfTypeWhereChain_Binds() {
        // #4577: the exact `.OfType<T>().Where(lambda)` shape; the lambda's
        // capture of the outer loop binding is what failed, not the chain.
        let printed = TranslateOblivious(Prelude + `
        public int Run(Node root)
        {
            int total = 0;
            foreach (Node escape in Items(root))
            {
                foreach (Node later in Items(root)
                    .OfType<Node>()
                    .Where(statement => statement.Start > escape.Start))
                {
                    total += later.Start;
                }
            }

            return total;
        }
    }
}`)
        Assert.Contains("escape!!.Start", printed)
        // OfType<Node>() yields non-null elements, so `later` stays bare.
        Assert.Contains("total += later.Start", printed)
    }

    @Fact
    func ForEachOverUnpromotedIteratorElement_StaysBare() {
        // Negative control: an iterator with no null evidence keeps a
        // non-null element, so its loop binding gets no assertion.
        let printed = TranslateOblivious(Prelude + `
        public int Run()
        {
            int total = 0;
            foreach (Node item in Fresh())
            {
                total += Use(item) + item.Start;
            }

            return total;
        }
    }
}`)
        Assert.Contains("func Fresh() sequence[Node]", printed)
        Assert.Contains("Use(item) + item.Start", printed)
        Assert.DoesNotContain("item!!", printed)
    }

    @Fact
    func ForEachOverSiblingProjectPromotedIterator_AssertsBinding() {
        // A sibling project of the same migration run is bound through
        // metadata (no declaring syntax). Its own translation renders
        // `Items` as `sequence[Node?]`, so the consumer's binding must still
        // be asserted at each non-null use; the imported-oblivious collection
        // path (ADR-0186 `T!`) is what covers this shape.
        let printed = TranslateAgainstSiblingLibrary(`
using Lib;

namespace App
{
    public class Consumer
    {
        private static int Use(Node node) => node.Start;

        public int Run(Node root)
        {
            int total = 0;
            foreach (Node item in Source.Items(root))
            {
                total += Use(item) + item.Start;
            }

            return total;
        }
    }
}`)
        Assert.Contains("Use(item!!)", printed)
        Assert.Contains("item!!.Start", printed)
    }

    shared {
        private const Prelude string = (`
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public class Node
    {
        public int Start => 0;
    }

    public class C
    {
        // The null test taints ` + "`" + `node` + "`" + `, and ` + "`" + `yield return node` + "`" + ` carries that
        // taint into the iterator element: Items renders ` + "`" + `sequence[Node?]` + "`" + `.
        private static IEnumerable<Node> Items(Node node)
        {
            if (node == null)
            {
                yield break;
            }

            yield return node;
        }

        // No null evidence anywhere: Fresh renders ` + "`" + `sequence[Node]` + "`" + `.
        private static IEnumerable<Node> Fresh()
        {
            yield return new Node();
        }

        private static int Use(Node node) => node.Start;
`)

        private func TranslateAgainstSiblingLibrary(consumerSource string) string {
            const librarySource = `
using System.Collections.Generic;

namespace Lib
{
    public class Node
    {
        public int Start => 0;
    }

    public static class Source
    {
        public static IEnumerable<Node> Items(Node node)
        {
            if (node == null)
            {
                yield break;
            }

            yield return node;
        }

        public static IEnumerable<Node> Fresh()
        {
            yield return new Node();
        }
    }
}`
            let library = CSharpProjectLoader.LoadInMemory(
                [](string, librarySource string){("Lib.cs", librarySource)},
                CSharpProjectLoader.RuntimeReferences(),
                "Lib"
            )
            Assert.True(library.BoundWithoutErrors, string.Join(Environment.NewLine, library.ErrorDiagnostics))
            // Repository mode binds a sibling project through its built
            // assembly, whose symbols carry no declaring syntax.
            using let image = MemoryStream()
            Assert.True(library.Compilation.Emit(image).Success)
            let libraryReference MetadataReference = MetadataReference.CreateFromImage(image.ToArray())
            let references IReadOnlyList[MetadataReference] = CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]MetadataReference{libraryReference})
                .ToList()
            let consumer = CSharpProjectLoader.LoadInMemory(
                [](string, consumerSource string){("App.cs", consumerSource)},
                references,
                "App"
            )
            Assert.True(consumer.BoundWithoutErrors, string.Join(Environment.NewLine, consumer.ErrorDiagnostics))
            Assert.Equal(NullableContextOptions.Disable, consumer.Compilation.Options.NullableContextOptions)
            let siblings = []CSharpCompilation{library.Compilation, consumer.Compilation}
            let document = Assert.Single(consumer.Documents)
            let context = TranslationContext(
                consumer.Compilation,
                document.SemanticModel,
                document.FilePath,
                siblings,
                repositoryCompilations: siblings
            )
            return GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        }

        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
