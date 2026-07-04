// <copyright file="Issue1888VarPatternTranslationTests.cs" company="GSharp">
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
/// Issue #1888: a C# <c>var</c> pattern (<c>VarPatternSyntax</c>) ALWAYS
/// matches and binds the subject (or sub-value); it had no canonical G# form
/// and reported the CS2GS-GAP "pattern 'VarPattern' has no canonical G# form
/// yet". Covers all three surface positions:
/// <list type="bullet">
/// <item>a top-level <c>is</c>-pattern (<c>x is var v</c>) — lowers to the
/// literal <c>true</c> test with <c>v</c> bound directly to the receiver
/// (no narrowing, since unlike a type/declaration pattern a <c>var</c>
/// pattern also matches <see langword="null"/>).</item>
/// <item>a switch-expression/statement arm (<c>var v =&gt;</c>) — lowers to
/// the G# discard <c>_</c> (gsc's own total-arm check treats a bare discard
/// the same as an explicit <c>default:</c>), with <c>v</c> bound via a
/// translator-side substitution to the arm's discriminant.</item>
/// <item>a nested property subpattern (<c>{ Prop: var v }</c>) — the same
/// discard-plus-substitution mapping, with the receiver rewritten to the
/// member access on the enclosing property.</item>
/// </list>
/// </summary>
public class Issue1888VarPatternTranslationTests
{
    [Fact]
    public void IsPattern_VarBinder_LowersToAlwaysTrueTestWithDirectBind()
    {
        string rendered = Render(@"
namespace Corpus.Issue1888
{
    public class Holder
    {
        public string Describe(object product)
        {
            if (product is var captured)
            {
                return captured.ToString();
            }

            return ""unreachable"";
        }
    }
}
");

        Assert.Contains("if true {", rendered, StringComparison.Ordinal);
        Assert.Contains("product.ToString()", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("captured", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_VarArm_LowersToDiscardArmWithSubstitutedBind()
    {
        string rendered = Render(@"
namespace Corpus.Issue1888
{
    public class Holder
    {
        public string Describe(int n) => n switch
        {
            0 => ""zero"",
            var v => $""other ({v})"",
        };
    }
}
");

        Assert.Contains("case _:", rendered, StringComparison.Ordinal);
        Assert.Contains("other ($n)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchStatement_VarArm_LowersToDiscardArmWithSubstitutedBind()
    {
        string rendered = Render(@"
namespace Corpus.Issue1888
{
    public class Holder
    {
        public string Describe(int n)
        {
            switch (n)
            {
                case 0:
                    return ""zero"";
                case var v:
                    return $""other ({v})"";
            }
        }
    }
}
");

        Assert.Contains("case _ {", rendered, StringComparison.Ordinal);
        Assert.Contains("other ($n)", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void PropertyPattern_VarSubpattern_BindsToMemberAccessOnEnclosingProperty()
    {
        string rendered = Render(@"
namespace Corpus.Issue1888
{
    public class Address
    {
        public string City;
    }

    public class Person
    {
        public Address Address;
    }

    public class Holder
    {
        public string Describe(Person person)
        {
            if (person is { Address: var addr })
            {
                return addr.City;
            }

            return ""unreachable"";
        }
    }
}
");

        Assert.Contains("person != nil && true", rendered, StringComparison.Ordinal);
        Assert.Contains("person.Address.City", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("addr", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void SwitchExpression_NestedVarSubpattern_LowersToDiscardFieldWithSubstitutedBind()
    {
        string rendered = Render(@"
namespace Corpus.Issue1888
{
    public class Address
    {
        public string City;
    }

    public class Person
    {
        public string Name;
        public Address Address;
    }

    public class Holder
    {
        public string Describe(Person person) => person switch
        {
            { Name: ""Ada"" } => ""ada"",
            { Address: var addr } => addr.City,
            _ => ""other"",
        };
    }
}
");

        Assert.Contains("{ Address: _ }", rendered, StringComparison.Ordinal);
        Assert.Contains("person.Address.City", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("addr", rendered, StringComparison.Ordinal);
        AssertRoundTripParses(rendered);
    }

    [Fact]
    public void IsPattern_VarTupleDesignation_StaysLoudGap()
    {
        // `var (a, b)` deconstructs — G# has no canonical form, so it must keep
        // reporting the CS2GS-GAP rather than silently emit a bindingless match.
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Source.cs", @"
namespace Corpus.Issue1888
{
    public class Holder
    {
        public bool Describe((int, int) point)
        {
            if (point is var (a, b))
            {
                return a == b;
            }

            return false;
        }
    }
}
") });

        Assert.True(project.BoundWithoutErrors);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.Contains(context.Diagnostics, d => d.Message.Contains("tuple designation", StringComparison.Ordinal));
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
