// <copyright file="TestDiscoveryComputer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.LanguageServer.Protocol;

namespace GSharp.LanguageServer;

/// <summary>
/// Pure-function test discovery usable by both the handler and tests. Walks a
/// document's syntax tree for functions annotated with a recognized test
/// attribute (xUnit/NUnit/MSTest) and produces a tree of <see cref="TestDiscoveryItem"/>.
/// </summary>
public static class TestDiscoveryComputer
{
    // Recognized test-method annotations across the common .NET test frameworks.
    // Matched against the annotation's last name segment, with or without the
    // conventional "Attribute" suffix.
    private static readonly HashSet<string> TestAttributeNames = new(System.StringComparer.Ordinal)
    {
        "Fact",
        "Theory",
        "Test",
        "TestCase",
        "TestMethod",
    };

    /// <summary>
    /// Computes the discovered tests for a single document.
    /// </summary>
    /// <param name="uri">The document URI (used on every emitted item).</param>
    /// <param name="content">The document content to scan.</param>
    /// <returns>The discovered top-level test items (class groups and free test functions).</returns>
    public static IReadOnlyList<TestDiscoveryItem> ComputeTests(string uri, DocumentContent content)
    {
        var items = new List<TestDiscoveryItem>();
        if (content?.SyntaxTree?.Root == null)
        {
            return items;
        }

        foreach (var member in content.SyntaxTree.Root.Members)
        {
            switch (member)
            {
                case FunctionDeclarationSyntax func when IsTest(func):
                    items.Add(CreateItem(uri, func.Identifier, name => name));
                    break;

                case StructDeclarationSyntax type when type.IsClass:
                    var className = type.Identifier.Text;
                    var methods = type.Methods
                        .Where(IsTest)
                        .Select(m => CreateItem(uri, m.Identifier, name => className + "." + name))
                        .ToArray();

                    if (methods.Length > 0)
                    {
                        items.Add(new TestDiscoveryItem
                        {
                            Id = uri + "#" + className,
                            Label = className,
                            Uri = uri,
                            Line = LineOf(type.Identifier),
                            Filter = null,
                            Children = methods,
                        });
                    }

                    break;
            }
        }

        return items;
    }

    private static bool IsTest(FunctionDeclarationSyntax function)
    {
        foreach (var annotation in function.Annotations)
        {
            var name = LastSegment(annotation.GetNameText());
            if (TestAttributeNames.Contains(name) ||
                (name.EndsWith("Attribute", System.StringComparison.Ordinal) &&
                 TestAttributeNames.Contains(name.Substring(0, name.Length - "Attribute".Length))))
            {
                return true;
            }
        }

        return false;
    }

    private static TestDiscoveryItem CreateItem(string uri, SyntaxToken identifier, System.Func<string, string> toFilter)
    {
        var name = identifier.Text;
        return new TestDiscoveryItem
        {
            Id = uri + "#" + toFilter(name),
            Label = name,
            Uri = uri,
            Line = LineOf(identifier),
            Filter = toFilter(name),
            Children = null,
        };
    }

    private static int LineOf(SyntaxToken token) => SemanticLookup.ToRange(token).Start.Line;

    private static string LastSegment(string dottedName)
    {
        if (string.IsNullOrEmpty(dottedName))
        {
            return dottedName;
        }

        var lastDot = dottedName.LastIndexOf('.');
        return lastDot < 0 ? dottedName : dottedName.Substring(lastDot + 1);
    }
}
