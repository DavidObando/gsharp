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
/// Regression tests for issue #1947: issue #1892's descend guard stops
/// <see cref="CSharpToGSharpTranslator"/>'s embedded-assignment hoist (issue
/// #1723) from walking INTO an object/array/collection initializer at all, so
/// each `Field = value` member is skipped correctly, but it ALSO skips a
/// GENUINE value-position assignment nested inside a member's VALUE (`new T {
/// A = (x = 3) }`) or inside an array/collection-initializer element itself
/// (`new int[] { x = 5, 2 }`, `new Dictionary&lt;string, int&gt; { ["k"] = (x
/// = 5) }`) — that inner assignment must still be hoisted. The fix only skips
/// the TOP-LEVEL `AssignmentExpressionSyntax` member of an object/`with`
/// initializer (the `Field = value` shape), while still scanning its RHS, and
/// treats an array/collection-initializer element's assignment as a genuine
/// hoist candidate (it has no "member" shape to protect).
/// </summary>
public class Issue1947InitializerValuePositionAssignmentTests
{
    [Fact]
    public void ObjectInitializerMemberValue_EmbeddedAssignment_IsHoistedAndMemberReadsTarget()
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

        // The embedded write is hoisted as its own statement, ahead of the
        // object-initializer statement that reads the (now up-to-date) `x`.
        int hoistIndex = printed.IndexOf("x = 3", StringComparison.Ordinal);
        int widgetIndex = printed.IndexOf("Widget{A: (x)}", StringComparison.Ordinal);
        Assert.True(hoistIndex >= 0 && widgetIndex >= 0 && hoistIndex < widgetIndex, printed);
    }

    [Fact]
    public void ArrayInitializerElement_EmbeddedAssignment_IsHoistedAndElementReadsTarget()
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

        int hoistIndex = printed.IndexOf("x = 5", StringComparison.Ordinal);
        int arrayIndex = printed.IndexOf("{x, 2}", StringComparison.Ordinal);
        Assert.True(hoistIndex >= 0 && arrayIndex >= 0 && hoistIndex < arrayIndex, printed);
    }

    [Fact]
    public void DictionaryIndexInitializerElement_EmbeddedAssignment_IsHoistedAndElementReadsTarget()
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

        int hoistIndex = printed.IndexOf("x = 5", StringComparison.Ordinal);
        int dictIndex = printed.IndexOf("\"k\"", StringComparison.Ordinal);
        Assert.True(hoistIndex >= 0 && dictIndex >= 0 && hoistIndex < dictIndex, printed);
        Assert.Contains("(x)", printed);
    }

    [Fact]
    public void NestedObjectInitializer_EmbeddedAssignmentInInnerMemberValue_IsHoisted()
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

        int hoistIndex = printed.IndexOf("x = 7", StringComparison.Ordinal);
        int innerIndex = printed.IndexOf("Inner{A: (x)}", StringComparison.Ordinal);
        Assert.True(hoistIndex >= 0 && innerIndex >= 0 && hoistIndex < innerIndex, printed);
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
            printed.Split('\n'),
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
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
