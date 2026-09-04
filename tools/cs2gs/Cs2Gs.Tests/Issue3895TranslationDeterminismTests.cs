// <copyright file="Issue3895TranslationDeterminismTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3895: the corpus-wide <c>!!</c> count is a tracked #3501 gate metric
/// (<c>nullAssertionCeiling</c>), and every ratchet decision assumes it is a
/// FUNCTION OF THE INPUT. These tests pin that assumption where it is cheap to
/// pin it: identical input must produce byte-identical G#, and the
/// null-forgiveness decision must not depend on the order in which the
/// compilation's syntax trees are visited.
/// <para>
/// The order-invariance half is the one with teeth. The oblivious-nullability
/// taint analysis is a fixpoint over an edge set collected in ONE pass over
/// <c>compilation.SyntaxTrees</c>; if any part of that collection ever starts
/// reading the partially-built taint set, or if the propagation loop stops
/// being monotone, the answer silently becomes a function of tree order — and
/// tree order is set by MSBuild's <c>Compile</c> item list, which is an
/// implementation detail no ratchet should depend on. Reversing the trees is a
/// cheap, deterministic stand-in for "some other order".
/// </para>
/// <para>
/// WHAT THESE TESTS DO NOT COVER. Both passes run in ONE process, so neither
/// can observe a dependence on .NET's per-process string hash seed, on
/// filesystem enumeration order, or on GC timing evicting a
/// <c>ConditionalWeakTable</c> entry. A whole-corpus repeat run is the only
/// thing that covers those, and issue #3895 records five of them.
/// </para>
/// </summary>
public class Issue3895TranslationDeterminismTests
{
    // Deliberately NOT `#nullable enable`: the oblivious-nullability taint
    // analysis — the thing that decides where `!!` lands — only runs on a
    // compilation whose nullable context is disabled, which is the default for
    // an in-memory load and is what the migration corpus mostly looks like.
    private static readonly (string FileName, string Source)[] Sources =
    {
        ("Model.cs", @"
namespace Demo
{
    public class Node
    {
        public string Name;
        public Node Parent;

        public static Node Find(string key)
        {
            return null;
        }

        public string Describe()
        {
            return null;
        }
    }
}"),
        ("Consumer.cs", @"
namespace Demo
{
    public class Consumer
    {
        public int NameLength(string key)
        {
            Node node = Node.Find(key);
            return node.Name.Length;
        }

        public string ParentName(Node node)
        {
            return node.Parent.Name;
        }

        public string Description(Node node)
        {
            return node.Describe().Trim();
        }
    }
}"),
        ("Relay.cs", @"
namespace Demo
{
    public class Relay
    {
        private Node cached;

        public Node Cached
        {
            get { return this.cached; }
        }

        public string Relayed(string key)
        {
            this.cached = Node.Find(key);
            return this.cached.Describe();
        }
    }
}"),
    };

    /// <summary>
    /// Two independent translations of identical input must agree byte for
    /// byte — not merely in their <c>!!</c> COUNT, which a compensating pair
    /// of moves would keep constant.
    /// </summary>
    [Fact]
    public void TranslatingTheSameSourcesTwice_ProducesByteIdenticalOutput()
    {
        IReadOnlyDictionary<string, string> first = TranslateAll(Sources);
        IReadOnlyDictionary<string, string> second = TranslateAll(Sources);

        AssertEmitsAssertions(first);
        AssertSameOutput(first, second, "a second translation of identical input");
    }

    /// <summary>
    /// Reversing the compilation's syntax-tree order must not move a single
    /// character of any file's output. Each document is translated on its own,
    /// so its text is a function of that document plus whole-program facts; a
    /// whole-program fact that changed with visit order would be a
    /// non-converged fixpoint, not a formatting difference.
    /// </summary>
    [Fact]
    public void ReversingSyntaxTreeOrder_ProducesTheSamePerDocumentOutput()
    {
        IReadOnlyDictionary<string, string> forward = TranslateAll(Sources);
        IReadOnlyDictionary<string, string> reversed = TranslateAll(Sources.Reverse().ToArray());

        AssertEmitsAssertions(forward);
        AssertSameOutput(forward, reversed, "a reversed syntax-tree order");
    }

    /// <summary>
    /// The nullable TYPE decisions the same fixpoint drives, asserted
    /// independently of the assertion sites: a declaration that renders
    /// <c>T?</c> under one tree order must render <c>T?</c> under the other.
    /// A promotion that flipped would move every downstream <c>!!</c> with it.
    /// </summary>
    [Fact]
    public void NullablePromotions_AreInvariantUnderSyntaxTreeOrder()
    {
        IReadOnlyDictionary<string, string> forward = TranslateAll(Sources);
        IReadOnlyDictionary<string, string> reversed = TranslateAll(Sources.Reverse().ToArray());

        // Anti-vacuity: the fixture must actually promote something, or the
        // comparison below compares two promotion-free trees.
        Assert.Contains(forward, entry => entry.Value.Contains("?", StringComparison.Ordinal));

        foreach (KeyValuePair<string, string> entry in forward)
        {
            Assert.Equal(
                CountOccurrences(entry.Value, "?"),
                CountOccurrences(reversed[entry.Key], "?"));
            Assert.Equal(
                CountOccurrences(entry.Value, "!!"),
                CountOccurrences(reversed[entry.Key], "!!"));
        }
    }

    private static int CountOccurrences(string text, string needle)
    {
        var count = 0;
        var index = 0;
        while (true)
        {
            index = text.IndexOf(needle, index, StringComparison.Ordinal);
            if (index < 0)
            {
                return count;
            }

            count++;
            index += needle.Length;
        }
    }

    private static void AssertEmitsAssertions(IReadOnlyDictionary<string, string> printed)
    {
        // Anti-vacuity guard: if the fixture ever stops emitting `!!`, these
        // tests would keep passing while covering nothing this issue is about.
        Assert.Contains(printed, entry => entry.Value.Contains("!!", StringComparison.Ordinal));
    }

    private static void AssertSameOutput(
        IReadOnlyDictionary<string, string> expected,
        IReadOnlyDictionary<string, string> actual,
        string what)
    {
        Assert.Equal(expected.Keys.OrderBy(k => k, StringComparer.Ordinal), actual.Keys.OrderBy(k => k, StringComparer.Ordinal));
        foreach (KeyValuePair<string, string> entry in expected)
        {
            string other = actual[entry.Key];
            Assert.True(
                string.Equals(entry.Value, other, StringComparison.Ordinal),
                $"{entry.Key} translated differently under {what}.\n--- first ---\n{entry.Value}\n--- second ---\n{other}");
        }
    }

    private static IReadOnlyDictionary<string, string> TranslateAll(
        IReadOnlyList<(string FileName, string Source)> sources)
    {
        LoadedCSharpProject project = LoadBound(sources);
        var printed = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
            printed[System.IO.Path.GetFileName(document.FilePath)] = GSharpPrinter.Print(unit);
        }

        return printed;
    }

    private static LoadedCSharpProject LoadBound(IReadOnlyList<(string FileName, string Source)> sources)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(sources);
        Assert.True(
            project.BoundWithoutErrors,
            "Fixture should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));
        return project;
    }
}
