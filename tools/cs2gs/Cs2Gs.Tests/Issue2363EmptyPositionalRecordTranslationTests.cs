// <copyright file="Issue2363EmptyPositionalRecordTranslationTests.cs" company="GSharp">
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
/// Issue #2363: <c>CSharpToGSharpTranslator.IsFieldlessRecord</c>'s
/// <c>hasPositional</c> computation previously conflated an EXPLICIT-BUT-
/// EMPTY positional parameter list (<c>record Name();</c>) with NO
/// parameter list at all (<c>record Name;</c>) — both were treated as
/// "not positional", so a genuinely positional-but-empty record was
/// needlessly downgraded to a plain (non-<c>data</c>) class/struct, losing
/// record semantics (equality, <c>with</c>-copy, <c>ToString</c>) even
/// though gsc now supports a zero-field <c>data class</c>/<c>data
/// struct</c> (see the companion gsc-side fix for #2363). Only a record
/// Issue #2704 later generalized zero-field data records, so both shapes now
/// preserve record semantics. These tests exercise record class and record
/// struct, plus the exact
/// Oahu <c>CallbackChallenge</c>/<c>MfaChallenge</c>/<c>CvfChallenge</c>/
/// <c>ApprovalChallenge</c> hierarchy shape (from
/// <c>Oahu.Cli.App/Auth/CallbackBroker.cs</c>) where the empty-positional
/// derived records also override a base computed property.
/// </summary>
public class Issue2363EmptyPositionalRecordTranslationTests
{
    [Fact]
    public void RecordClass_NoParens_PreservesDataClass()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public abstract record Issue2363NoParens;
}");

        Assert.Contains("open data class Issue2363NoParens {", printed);
    }

    [Fact]
    public void RecordClass_ExplicitEmptyParens_PreservesDataClass()
    {
        // The #2363 fix: an explicit-but-empty positional parameter list is
        // positional shape, distinct from no parameter list at all, and
        // must NOT be downgraded.
        string printed = TranslateUnit(@"
namespace Demo
{
    public abstract record Issue2363Base;
    public sealed record Issue2363EmptyPositional() : Issue2363Base;
}");

        Assert.Contains("data class Issue2363EmptyPositional() : Issue2363Base", printed);
        Assert.DoesNotContain("open class Issue2363EmptyPositional", printed);
    }

    [Fact]
    public void RecordStruct_ExplicitEmptyParens_PreservesDataStruct()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public readonly record struct Issue2363EmptyStruct();
}");

        Assert.Contains("data struct Issue2363EmptyStruct()", printed);
        Assert.DoesNotContain("open struct Issue2363EmptyStruct", printed);
    }

    [Fact]
    public void RecordClass_EmptyPositional_WithPropertyOverride_PreservesDataClass()
    {
        // Exact Oahu CallbackBroker.cs shape: an abstract base record with
        // only an abstract computed property (no positional data of its own)
        // plus
        // sealed derived records with an EMPTY positional parameter list
        // that each override the property. The derived records must keep
        // `data class` status.
        string printed = TranslateUnit(@"
namespace Oahu.Cli.App.Auth
{
    public abstract record CallbackChallenge
    {
        public abstract string Kind { get; }
    }

    public sealed record MfaChallenge() : CallbackChallenge
    {
        public override string Kind => ""mfa"";
    }

    public sealed record CvfChallenge() : CallbackChallenge
    {
        public override string Kind => ""cvf"";
    }

    public sealed record ApprovalChallenge() : CallbackChallenge
    {
        public override string Kind => ""approval"";
    }

    public sealed record CaptchaChallenge(byte[] ImageBytes) : CallbackChallenge
    {
        public override string Kind => ""captcha"";
    }
}");

        Assert.Contains("open data class CallbackChallenge {", printed);

        // The three zero-field derived records are the #2363 scenario —
        // must be preserved as `data class`, not downgraded.
        Assert.Contains("data class MfaChallenge() : CallbackChallenge", printed);
        Assert.Contains("data class CvfChallenge() : CallbackChallenge", printed);
        Assert.Contains("data class ApprovalChallenge() : CallbackChallenge", printed);

        // The one-field sibling is unaffected either way.
        Assert.Contains("data class CaptchaChallenge(ImageBytes []uint8) : CallbackChallenge", printed);
    }

    private static string TranslateUnit(string source)
    {
        (string printed, _) = Translate(source);
        return printed;
    }

    private static (string Printed, TranslationContext Context) Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return (printed, context);
    }
}
