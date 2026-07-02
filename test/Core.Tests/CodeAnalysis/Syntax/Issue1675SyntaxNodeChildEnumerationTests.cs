// <copyright file="Issue1675SyntaxNodeChildEnumerationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Syntax;

/// <summary>
/// Issue #1675: <see cref="SyntaxNode.GetChildren"/> used to re-run
/// <c>GetType().GetProperties()</c> plus <c>PropertyInfo.GetValue</c> on every
/// enumeration; it now uses cached, compiled per-type accessors, and
/// <see cref="SyntaxNode.Span"/> is cached per node. Because <c>Span</c> is
/// derived from the child sequence, the new enumeration must be byte-identical
/// to the historical reflection order for every node type. These tests pin
/// that equivalence against a reference implementation that is a verbatim copy
/// of the pre-#1675 reflection-based code.
/// </summary>
public class Issue1675SyntaxNodeChildEnumerationTests
{
    /// <summary>
    /// Source snippets that, together with <c>samples/**/*.gs</c>, instantiate
    /// every concrete <see cref="SyntaxNode"/> subclass in the Core assembly
    /// (verified by <see cref="Corpus_CoversEveryConcreteSyntaxNodeType"/>).
    /// </summary>
    private static readonly IReadOnlyList<string> Snippets = new[]
    {
        // as / typeof / nameof / throw statement
        "package p\nimport System\nfunc F(x any) {\n  let s = x as string\n  let t = typeof(int32)\n  let n = nameof(x)\n  throw Exception(\"boom\")\n}\n",

        // throw expression
        "package p\nimport System\nfunc G(s string?) string {\n  return s ?? throw Exception(\"null\")\n}\n",

        // object creation with property initializers
        "package P\nclass WithInit {\n  public var Asin string\n  public var Title string\n}\nfunc Main() {\n  var w = WithInit() { Asin = \"X\", Title = \"T\" }\n}\n",

        // event declaration with add/remove accessors
        "package P\nimport System\nclass Foo {\n  event Changed () -> void {\n    add { }\n    remove { }\n  }\n}\n",

        // pattern combinators: and / or / not / parenthesized
        "package p\nfunc F(v int32) int32 {\n  let x = switch v { case > 0 and < 10: 1 case not > 20: 2 case (== 0 or > 5): 3 default: 0 }\n  return x\n}\n",

        // from-end index and ranges
        "package p\nfunc F(a []int32) {\n  let b = a[^1]\n  let c = a[1..^1]\n  let d = a[..2]\n}\n",

        // generic static receiver
        "package p\nstruct Box[T] { shared { func Make(x int32) int32 { return x } } }\nclass C { func F() int32 { return Box[int32?].Make(5) } }\n",

        // multi-assignment
        "package p\nfunc F() {\n  var a = 1\n  var b = 2\n  a, b = b, a\n}\n",

        // infinite for
        "package p\nfunc F() {\n  for {\n    break\n  }\n}\n",

        // unsafe: fixed, stackalloc, sizeof, indirect assignment
        "package p\nunsafe func F(dest []uint8) {\n  fixed pD *uint8 = dest { }\n  var buf = stackalloc [4]uint8\n  let sz = sizeof(int32)\n  var x = 1\n  var px = &x\n  *px = 2\n}\n",

        // member field / member index / compound index assignments
        "package p\nstruct Inner { var x int32 }\nstruct S {\n  var arr []int32\n  var inner Inner\n}\nfunc F(s S, arr []int32) {\n  s.inner.x = 1\n  s.arr[0] = 1\n  arr[0] += 1\n  s.arr[0] += 2\n}\n",

        // conditional ref argument (legacy ADR-0061 inner-modifier shape)
        "package p\nfunc F(cond bool) {\n  var a = 1\n  var b = 2\n  var x = cond ? ref a : ref b\n}\n",

        // annotation use-site targets
        "package p\nimport System\n@field:Obsolete\nvar counter = 0\nfunc F(@param:NotNull x int32) {\n}\n",

        // type alias
        "package p\ntype MyInt = int32\n",

        // await using / await for
        "package p\nimport System\nasync func F(stream any) {\n  await using let r = stream\n  await for v in stream {\n  }\n}\n",
    };

    /// <summary>
    /// The cached accessor list must select the same properties in the same
    /// order as the historical reflection-based filter, for every concrete
    /// node type in the assembly — no parsing required.
    /// </summary>
    [Fact]
    public void ChildPropertyOrder_MatchesLegacyReflectionOrder_ForEveryNodeType()
    {
        foreach (var type in GetConcreteNodeTypes())
        {
            var actual = SyntaxNode.GetChildPropertiesInEnumerationOrder(type)
                .Select(p => p.Name)
                .ToArray();
            var expected = LegacyChildProperties(type)
                .Select(p => p.Name)
                .ToArray();
            Assert.True(
                expected.SequenceEqual(actual),
                $"Child property order mismatch for {type.Name}: expected [{string.Join(", ", expected)}], got [{string.Join(", ", actual)}]");
        }
    }

    /// <summary>
    /// For every node of every tree in the corpus, the new
    /// <see cref="SyntaxNode.GetChildren"/> must yield exactly the same child
    /// instances, in exactly the same order, as the legacy reflection-based
    /// implementation.
    /// </summary>
    [Fact]
    public void GetChildren_MatchesLegacyReflectionImplementation_OnCorpus()
    {
        var nodesChecked = 0;
        foreach (var tree in ParseCorpus())
        {
            nodesChecked += AssertChildrenMatchLegacy(tree.Root);
        }

        // Sanity check that the corpus actually exercised a large tree set.
        Assert.True(nodesChecked > 10_000, $"corpus unexpectedly small: {nodesChecked} nodes");
    }

    /// <summary>
    /// The corpus must instantiate every concrete <see cref="SyntaxNode"/>
    /// subclass so the parity check above is exhaustive. If this fails after
    /// adding a new syntax node type, add a snippet exercising it to
    /// <see cref="Snippets"/>.
    /// </summary>
    [Fact]
    public void Corpus_CoversEveryConcreteSyntaxNodeType()
    {
        var covered = new HashSet<Type>();
        foreach (var tree in ParseCorpus())
        {
            Collect(tree.Root, covered);
        }

        var missing = GetConcreteNodeTypes()
            .Where(t => !covered.Contains(t))
            .Select(t => t.Name)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.True(
            missing.Count == 0,
            "Corpus does not instantiate: " + string.Join(", ", missing) +
            ". Add a snippet to Issue1675SyntaxNodeChildEnumerationTests.Snippets covering the new node type(s).");
    }

    /// <summary>
    /// Spans are cached per node (nodes are immutable once parsed), so
    /// accessing them in different orders on two identical trees must produce
    /// identical values node-for-node.
    /// </summary>
    [Fact]
    public void Span_IsIdenticalRegardlessOfAccessOrder()
    {
        const string source = "package p\n\nfunc main() {\n  let x = (1 + 2) * 3\n  if x > 5 {\n    let y = \"hello\"\n  }\n}\n";

        // Tree 1: root-first — computing the root span recursively computes
        // (and caches) every descendant span.
        var tree1 = SyntaxTree.Parse(source);
        var nodes1 = Flatten(tree1.Root);
        _ = tree1.Root.Span;

        // Tree 2: leaf-first — access spans bottom-up in reverse order.
        var tree2 = SyntaxTree.Parse(source);
        var nodes2 = Flatten(tree2.Root);
        for (var i = nodes2.Count - 1; i >= 0; i--)
        {
            _ = nodes2[i].Span;
        }

        Assert.Equal(nodes1.Count, nodes2.Count);
        for (var i = 0; i < nodes1.Count; i++)
        {
            Assert.Equal(nodes1[i].Kind, nodes2[i].Kind);
            Assert.Equal(nodes1[i].Span.Start, nodes2[i].Span.Start);
            Assert.Equal(nodes1[i].Span.End, nodes2[i].Span.End);
        }
    }

    /// <summary>
    /// The parser assigns some child-bearing properties after construction
    /// (e.g. <see cref="BlockStatementSyntax.UnsafeKeyword"/>). Those setters
    /// must invalidate a previously computed span so the cache never serves a
    /// stale value.
    /// </summary>
    [Fact]
    public void Span_IsInvalidatedWhenParserAssignsChildAfterConstruction()
    {
        const string source = "package p\nfunc F() {\n  let x = 1\n}\n";
        var tree = SyntaxTree.Parse(source);
        var block = Flatten(tree.Root).OfType<BlockStatementSyntax>().First();

        // Force the span to be computed and cached.
        var before = block.Span;
        Assert.True(before.Start > 0);

        // Simulate the parser's post-construction mutation: attach a token
        // that lies before the block's current span.
        block.UnsafeKeyword = new SyntaxToken(tree, SyntaxKind.IdentifierToken, 0, "unsafe", null);

        var after = block.Span;
        Assert.Equal(0, after.Start);
        Assert.Equal(before.End, after.End);
    }

    private static List<Type> GetConcreteNodeTypes()
    {
        return typeof(SyntaxNode).Assembly.GetTypes()
            .Where(t => typeof(SyntaxNode).IsAssignableFrom(t) && !t.IsAbstract)
            .OrderBy(t => t.FullName, StringComparer.Ordinal)
            .ToList();
    }

    private static IEnumerable<SyntaxTree> ParseCorpus()
    {
        foreach (var snippet in Snippets)
        {
            yield return SyntaxTree.Parse(snippet);
        }

        var samplesDirectory = LocateSamplesDirectory();
        Assert.NotNull(samplesDirectory);
        foreach (var path in Directory.EnumerateFiles(samplesDirectory, "*.gs", SearchOption.AllDirectories).OrderBy(p => p, StringComparer.Ordinal))
        {
            yield return SyntaxTree.Parse(File.ReadAllText(path));
        }
    }

    private static string LocateSamplesDirectory()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(Issue1675SyntaxNodeChildEnumerationTests).Assembly.Location) !);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "samples");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        return null;
    }

    private static int AssertChildrenMatchLegacy(SyntaxNode node)
    {
        var expected = LegacyGetChildren(node).ToList();
        var actual = node.GetChildren().ToList();

        Assert.True(
            expected.Count == actual.Count,
            $"{node.GetType().Name}: expected {expected.Count} children, got {actual.Count}");
        var checkedNodes = 1;
        for (var i = 0; i < expected.Count; i++)
        {
            Assert.Same(expected[i], actual[i]);
        }

        foreach (var child in expected)
        {
            checkedNodes += AssertChildrenMatchLegacy(child);
        }

        return checkedNodes;
    }

    private static void Collect(SyntaxNode node, HashSet<Type> covered)
    {
        covered.Add(node.GetType());
        foreach (var child in node.GetChildren())
        {
            Collect(child, covered);
        }
    }

    private static List<SyntaxNode> Flatten(SyntaxNode root)
    {
        var result = new List<SyntaxNode>();
        var stack = new Stack<SyntaxNode>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var node = stack.Pop();
            result.Add(node);
            foreach (var child in node.GetChildren().Reverse())
            {
                stack.Push(child);
            }
        }

        return result;
    }

    private static IEnumerable<PropertyInfo> LegacyChildProperties(Type nodeType)
    {
        // Verbatim filter from the pre-#1675 GetChildren implementation.
        var properties = nodeType.GetProperties(BindingFlags.Public | BindingFlags.Instance);
        foreach (var property in properties)
        {
            if (typeof(SyntaxNode).IsAssignableFrom(property.PropertyType)
                || typeof(SeparatedSyntaxList).IsAssignableFrom(property.PropertyType)
                || typeof(IEnumerable<SyntaxNode>).IsAssignableFrom(property.PropertyType))
            {
                yield return property;
            }
        }
    }

    private static IEnumerable<SyntaxNode> LegacyGetChildren(SyntaxNode node)
    {
        // Verbatim copy of the pre-#1675 reflection-based implementation.
        var properties = node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance);

        foreach (var property in properties)
        {
            if (typeof(SyntaxNode).IsAssignableFrom(property.PropertyType))
            {
                var child = (SyntaxNode)property.GetValue(node);
                if (child != null)
                {
                    yield return child;
                }
            }
            else if (typeof(SeparatedSyntaxList).IsAssignableFrom(property.PropertyType))
            {
                var separatedSyntaxList = (SeparatedSyntaxList)property.GetValue(node);
                if (separatedSyntaxList == null)
                {
                    continue;
                }

                foreach (var child in separatedSyntaxList.GetWithSeparators())
                {
                    yield return child;
                }
            }
            else if (typeof(IEnumerable<SyntaxNode>).IsAssignableFrom(property.PropertyType))
            {
                var children = (IEnumerable<SyntaxNode>)property.GetValue(node);
                foreach (var child in children)
                {
                    if (child != null)
                    {
                        yield return child;
                    }
                }
            }
        }
    }
}
