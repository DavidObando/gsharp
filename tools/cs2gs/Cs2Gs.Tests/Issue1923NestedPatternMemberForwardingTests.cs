// <copyright file="Issue1923NestedPatternMemberForwardingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #1923 (regression, round 2): the <c>isNestedPatternMember</c> flag —
/// which suppresses a redundant <c>!= nil</c> guard on a nested pattern member
/// that is provably non-nullable — was threaded through the direct recursive
/// member-access re-entry into <c>TranslatePatternTest</c>, but NOT through
/// three other recursive re-entry points: the <c>not</c>-pattern dispatch, the
/// list-element loop, and the slice-pattern subpattern. Reaching a nested
/// recursive pattern through any of those paths silently reset the flag to
/// its default (<see langword="false"/>), reproducing the exact "unconditional
/// redundant nil-check on a non-nullable nested member" bug the flag exists to
/// suppress. These tests cover both gap-closing shapes and a control case
/// proving the outer-nullable scenario still gets its own guard.
/// </summary>
public class Issue1923NestedPatternMemberForwardingTests
{
    [Fact]
    public void PropertySubpattern_NotPattern_SkipsRedundantNilCheckOnNonNullableMember()
    {
        string rendered = Render(@"
namespace Corpus.Issue1923
{
    public class Address
    {
        public int Age;
    }

    public class Person
    {
        public Address Friend;
    }

    public class Holder
    {
        public bool Describe(Person person)
        {
            return person is { Friend: not { Age: 0 } };
        }
    }
}
");

        // `Friend` is declared non-nullable, so the nested `not { Age: 0 }`
        // re-entry must NOT re-emit `person.Friend != nil`.
        Assert.DoesNotContain("person.Friend != nil", rendered, StringComparison.Ordinal);
        Assert.Contains("person.Friend.Age", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void PropertySubpattern_ListElementPattern_SkipsRedundantNilCheckOnNonNullableMember()
    {
        string rendered = Render(@"
namespace Corpus.Issue1923
{
    public class Address
    {
        public int Age;
    }

    public class Person
    {
        public Address[] Friends;
    }

    public class Holder
    {
        public bool Describe(Person person)
        {
            return person is { Friends: [{ Age: 0 }] };
        }
    }
}
");

        // `Friends` is declared non-nullable, so the nested element subpattern
        // re-entry must NOT re-emit `person.Friends != nil`.
        Assert.DoesNotContain("person.Friends != nil", rendered, StringComparison.Ordinal);
        Assert.Contains("Age", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void PropertySubpattern_NotPattern_KeepsNilCheckWhenMemberIsNullable()
    {
        string rendered = Render(@"
namespace Corpus.Issue1923
{
    public class Address
    {
        public int Age;
    }

    public class Person
    {
        public Address? Friend;
    }

    public class Holder
    {
        public bool Describe(Person person)
        {
            return person is { Friend: not { Age: 0 } };
        }
    }
}
");

        // `Friend` is declared nullable, so the outer member access still needs
        // its own guard — the fix must not over-correct into dropping it here.
        Assert.Contains("person.Friend != nil", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    private static void AssertRoundTripParses(string rendered)
    {
        RoundTripResult result = GSharpRoundTrip.Validate(rendered);

        Assert.True(
            result.Success,
            "Sanitized G# must round-trip-parse. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + rendered);
    }

    private static string Render(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", source) });

        Assert.True(
            project.BoundWithoutErrors,
            "inline source should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        Cs2Gs.CodeModel.Ast.CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Empty(context.Diagnostics);
        return GSharpPrinter.Print(unit);
    }
}
