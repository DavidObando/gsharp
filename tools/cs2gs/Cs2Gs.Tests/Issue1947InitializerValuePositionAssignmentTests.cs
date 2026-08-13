// <copyright file="Issue1947InitializerValuePositionAssignmentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Regression tests for assignments nested in initializer values. ADR-0161
/// keeps genuine value-position assignments inline while object-initializer
/// member syntax remains structural.
/// </summary>
public class Issue1947InitializerValuePositionAssignmentTests
{
    [Fact]
    public void ObjectInitializerMemberValue_EmbeddedAssignment_RemainsInline()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Widget
    {
        public int A { get; set; }
    }

    public sealed class C
    {
        public void M()
        {
            int x = 0;
            Widget w = new Widget { A = (x = 3) };
            System.Console.WriteLine(w.A);
            System.Console.WriteLine(x);
        }
    }
}");

        Assert.Contains("Widget{A: (x = 3)}", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayInitializerElement_EmbeddedAssignment_RemainsInline()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int x = 0;
            int[] values = new int[] { x = 5, 2 };
            System.Console.WriteLine(values[0]);
            System.Console.WriteLine(x);
        }
    }
}");

        Assert.Contains("[]int32{(x = 5), 2}", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void DictionaryIndexInitializerElement_EmbeddedAssignment_RemainsInline()
    {
        // `["k"] = value` (a C# 6 index/collection initializer) is also an
        // `AssignmentExpressionSyntax` initializer element, but its LHS is an
        // implicit ELEMENT access, not the identifier-member shape, so it is a
        // genuine value-position assignment candidate like the array case
        // above (`new List<int> { x = 5 }` from the issue does not actually
        // compile — the parser always treats an `Identifier = Value` element
        // as an object-initializer member set, regardless of the target
        // type's shape).
        string printed = TranslateUnit(@"
using System.Collections.Generic;

namespace Demo
{
    public sealed class C
    {
        public void M()
        {
            int x = 0;
            Dictionary<string, int> values = new Dictionary<string, int> { [""k""] = (x = 5) };
            System.Console.WriteLine(values[""k""]);
            System.Console.WriteLine(x);
        }
    }
}");

        Assert.Contains("[\"k\"] = (x = 5)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NestedObjectInitializer_EmbeddedAssignmentInInnerMemberValue_RemainsInline()
    {
        // A genuine assignment nested two initializer levels deep (inside the
        // VALUE of another object-initializer member) must still be found —
        // the fix must not stop at the first initializer member boundary.
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Inner
    {
        public int A { get; set; }
    }

    public sealed class Outer
    {
        public Inner Nested { get; set; }
    }

    public sealed class C
    {
        public void M()
        {
            int x = 0;
            Outer o = new Outer { Nested = new Inner { A = (x = 7) } };
            System.Console.WriteLine(o.Nested.A);
            System.Console.WriteLine(x);
        }
    }
}");

        Assert.Contains("Inner{A: (x = 7)}", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The #1892 fix (a plain `Field = value` member emits no stray
    /// assignment statement) must still hold once the #1947 fix descends
    /// into initializer values.
    /// </summary>
    [Fact]
    public void ObjectInitializerPlainMember_StillEmitsNoStrayAssignmentStatement()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class ProfileCard
    {
        public string Name { get; set; }
    }

    public sealed class C
    {
        public void M()
        {
            ProfileCard card = new ProfileCard { Name = ""ada"" };
            System.Console.WriteLine(card.Name);
        }
    }
}");

        bool hasStrayLine = Array.Exists(
            printed.Split(Environment.NewLine),
            line => line.Trim() == "Name = \"ada\"");
        Assert.False(hasStrayLine, $"Found stray bare assignment statement in:\n{printed}");
        Assert.Contains("ProfileCard{Name: \"ada\"}", printed);
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
