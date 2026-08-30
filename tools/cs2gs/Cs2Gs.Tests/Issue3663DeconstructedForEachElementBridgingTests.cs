// <copyright file="Issue3663DeconstructedForEachElementBridgingTests.cs" company="GSharp">
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
/// Regression tests for issue #3663 — the selfmig wall in migrated
/// <c>Cs2Gs.Translator</c> (<c>CollectOwnedExtensions</c>): a Try-pattern
/// <c>out</c> variable, promoted to <c>T?</c> by the #1072/#3501 analysis, is
/// stored into a LOCAL <c>List&lt;(T, …)&gt;</c> and read back through a
/// deconstructing <c>foreach</c>.
/// <para>
/// #3657 widened the nested-tuple flow collectors so a local collection is a
/// declaration sink, which correctly renders the element <c>T?</c>. But a
/// deconstructing <c>foreach</c> variable has no declaration of its own on the
/// G# side — <c>for (a, b) in items</c> infers each name from the sequence's
/// element tuple — so every read of the variable became a <c>T?</c> the
/// translator still believed was a <c>T</c>: <c>GS0158 Cannot find member …</c>
/// at a dereference and <c>GS0154</c> at every non-null argument sink.
/// </para>
/// </summary>
public class Issue3663DeconstructedForEachElementBridgingTests
{
    /// <summary>
    /// The migrated <c>CollectOwnedExtensions</c> wall: the promoted tuple
    /// element's deconstructed reads assert <c>!!</c> at a dereference and at a
    /// non-null argument position, while the sibling untainted element stays
    /// bare.
    /// </summary>
    [Fact]
    public void PromotedTupleElement_TypedForEachDeconstruction_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class Registry
    {
        public int Rank { get; set; }
    }

    public static class Collector
    {
        public static int Collect(IEnumerable<string> names)
        {
            var candidates = new List<(Registry Owner, string Name)>();
            foreach (string name in names)
            {
                if (!TryGetOwner(name, out Registry owner))
                {
                    continue;
                }

                candidates.Add((owner, name));
            }

            int total = 0;
            foreach ((Registry o, string n) in candidates)
            {
                total += Describe(o).Length + o.Rank + n.Length;
            }

            return total;
        }

        private static string Describe(Registry owner)
        {
            return owner.ToString();
        }

        private static bool TryGetOwner(string name, out Registry owner)
        {
            owner = null;
            if (name == null)
            {
                return false;
            }

            owner = new Registry();
            return true;
        }
    }
}");

        Assert.Contains("List[(Owner Registry?, Name string)]", printed);
        Assert.Contains("Describe(o!!)", printed);
        Assert.Contains("o!!.Rank", printed);
        Assert.Contains("n.Length", printed);
    }

    /// <summary>
    /// The <c>var (a, b)</c> header spelling nests its designations differently
    /// from the explicitly typed one and must resolve to the same tuple leaf.
    /// </summary>
    [Fact]
    public void PromotedTupleElement_VarForEachDeconstruction_AssertsNonNull()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class Registry
    {
        public int Rank { get; set; }
    }

    public static class Collector
    {
        public static int Collect(IEnumerable<string> names)
        {
            var candidates = new List<(Registry Owner, string Name)>();
            foreach (string name in names)
            {
                if (!TryGetOwner(name, out Registry owner))
                {
                    continue;
                }

                candidates.Add((owner, name));
            }

            int total = 0;
            foreach (var (o, n) in candidates)
            {
                total += o.Rank + n.Length;
            }

            return total;
        }

        private static bool TryGetOwner(string name, out Registry owner)
        {
            owner = null;
            if (name == null)
            {
                return false;
            }

            owner = new Registry();
            return true;
        }
    }
}");

        Assert.Contains("o!!.Rank", printed);
        Assert.Contains("n.Length", printed);
    }

    /// <summary>
    /// Precision guard: when no null ever reaches the tuple element, neither the
    /// element nor its deconstructed reads grow an assertion.
    /// </summary>
    [Fact]
    public void UntaintedTupleElement_ForEachDeconstruction_StaysBare()
    {
        string printed = TranslateOblivious(@"
using System.Collections.Generic;

namespace Demo
{
    public class Registry
    {
        public int Rank { get; set; }
    }

    public static class Collector
    {
        public static int Collect(IEnumerable<string> names)
        {
            var candidates = new List<(Registry Owner, string Name)>();
            foreach (string name in names)
            {
                candidates.Add((new Registry(), name));
            }

            int total = 0;
            foreach ((Registry o, string n) in candidates)
            {
                total += o.Rank + n.Length;
            }

            return total;
        }
    }
}");

        Assert.Contains("List[(Owner Registry, Name string)]", printed);
        Assert.DoesNotContain("o!!", printed);
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
        return PrintAndValidate(new CSharpToGSharpTranslator().TranslateDocument(document, context));
    }

    private static string PrintAndValidate(CompilationUnit unit)
    {
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
