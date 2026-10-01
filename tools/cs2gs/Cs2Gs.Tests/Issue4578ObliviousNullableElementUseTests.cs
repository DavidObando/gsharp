// <copyright file="Issue4578ObliviousNullableElementUseTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issues #4578 and #4577: in a nullable-oblivious compilation, a source
/// iterator whose element the taint analysis promotes renders
/// <c>sequence[T?]</c>, so G# infers every <c>for x in Iterator(...)</c>
/// binding as <c>T?</c>. The C# loop declares a plain oblivious <c>T</c>,
/// and cs2gs used to treat the binding as non-null: member accesses,
/// arguments and initializers in the body got no <c>!!</c> (GS0158 / GS0154 /
/// GS0155). A lambda capturing the binding inside a LINQ chain failed the
/// same way, and gsc reported the failed lambda as the chain's method being
/// missing (#4577: <c>.OfType[T]().Where(...)</c> "Cannot find function
/// Where"). The loop binding now asks the same promotion question the
/// iterator's declaration asks.
/// </summary>
public class Issue4578ObliviousNullableElementUseTests
{
    private const string Prelude = @"
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
        // The null test taints `node`, and `yield return node` carries that
        // taint into the iterator element: Items renders `sequence[Node?]`.
        private static IEnumerable<Node> Items(Node node)
        {
            if (node == null)
            {
                yield break;
            }

            yield return node;
        }

        // No null evidence anywhere: Fresh renders `sequence[Node]`.
        private static IEnumerable<Node> Fresh()
        {
            yield return new Node();
        }

        private static int Use(Node node) => node.Start;
";

    [Fact]
    public void ForEachOverPromotedIteratorElement_AssertsBindingAtEachNonNullUse()
    {
        string printed = TranslateOblivious(Prelude + @"
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
}");

        Assert.Contains("sequence[Node?]", printed);
        Assert.Contains("Use(item!!)", printed);
        Assert.Contains("item!!.Start", printed);
    }

    [Fact]
    public void LambdaCapturingPromotedIteratorBinding_InOfTypeWhereChain_Binds()
    {
        // #4577: the exact `.OfType<T>().Where(lambda)` shape; the lambda's
        // capture of the outer loop binding is what failed, not the chain.
        string printed = TranslateOblivious(Prelude + @"
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
}");

        Assert.Contains("escape!!.Start", printed);

        // OfType<Node>() yields non-null elements, so `later` stays bare.
        Assert.Contains("total += later.Start", printed);
    }

    [Fact]
    public void ForEachOverUnpromotedIteratorElement_StaysBare()
    {
        // Negative control: an iterator with no null evidence keeps a
        // non-null element, so its loop binding gets no assertion.
        string printed = TranslateOblivious(Prelude + @"
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
}");

        Assert.Contains("func Fresh() sequence[Node]", printed);
        Assert.Contains("Use(item) + item.Start", printed);
        Assert.DoesNotContain("item!!", printed);
    }


    private static string TranslateOblivious(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(
            NullableContextOptions.Disable,
            project.Compilation.Options.NullableContextOptions);

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
