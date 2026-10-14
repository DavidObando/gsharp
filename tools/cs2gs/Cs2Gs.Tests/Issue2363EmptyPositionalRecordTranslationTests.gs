// <copyright file="Issue2363EmptyPositionalRecordTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #2363: `CSharpToGSharpTranslator.IsFieldlessRecord`'s
/// `hasPositional` computation previously conflated an EXPLICIT-BUT-
/// EMPTY positional parameter list (`record Name();`) with NO
/// parameter list at all (`record Name;`) — both were treated as
/// "not positional", so a genuinely positional-but-empty record was
/// needlessly downgraded to a plain (non-`data`) class/struct, losing
/// record semantics (equality, `with`-copy, `ToString`) even
/// though gsc now supports a zero-field `data class`/`data
/// struct` (see the companion gsc-side fix for #2363). Only a record
/// Issue #2704 later generalized zero-field data records, so both shapes now
/// preserve record semantics. These tests exercise record class and record
/// struct, plus the exact
/// Oahu `CallbackChallenge`/`MfaChallenge`/`CvfChallenge`/
/// `ApprovalChallenge` hierarchy shape (from
/// `Oahu.Cli.App/Auth/CallbackBroker.cs`) where the empty-positional
/// derived records also override a base computed property.
open class Issue2363EmptyPositionalRecordTranslationTests {
    @Fact
    func RecordClass_NoParens_PreservesDataClass() {
        let printed = TranslateUnit(`
namespace Demo
{
    public abstract record Issue2363NoParens;
}`)
        Assert.Contains("abstract data class Issue2363NoParens", printed)
        Assert.DoesNotContain("open data class Issue2363NoParens", printed)
    }

    @Fact
    func RecordClass_ExplicitEmptyParens_PreservesDataClass() {
        // The #2363 fix: an explicit-but-empty positional parameter list is
        // positional shape, distinct from no parameter list at all, and
        // must NOT be downgraded.
        let printed = TranslateUnit(`
namespace Demo
{
    public abstract record Issue2363Base;
    public sealed record Issue2363EmptyPositional() : Issue2363Base;
}`)
        Assert.Contains("data class Issue2363EmptyPositional() : Issue2363Base", printed)
        Assert.DoesNotContain("open class Issue2363EmptyPositional", printed)
    }

    @Fact
    func RecordStruct_ExplicitEmptyParens_PreservesDataStruct() {
        let printed = TranslateUnit(`
namespace Demo
{
    public readonly record struct Issue2363EmptyStruct();
}`)
        Assert.Contains("data struct Issue2363EmptyStruct()", printed)
        Assert.DoesNotContain("open struct Issue2363EmptyStruct", printed)
    }

    @Fact
    func RecordClass_EmptyPositional_WithPropertyOverride_PreservesDataClass() {
        // Exact Oahu CallbackBroker.cs shape: an abstract base record with
        // only an abstract computed property (no positional data of its own)
        // plus
        // sealed derived records with an EMPTY positional parameter list
        // that each override the property. The derived records must keep
        // `data class` status.
        let printed = TranslateUnit(`
namespace Oahu.Cli.App.Auth
{
    public abstract record CallbackChallenge
    {
        public abstract string Kind { get; }
    }

    public sealed record MfaChallenge() : CallbackChallenge
    {
        public override string Kind => "mfa";
    }

    public sealed record CvfChallenge() : CallbackChallenge
    {
        public override string Kind => "cvf";
    }

    public sealed record ApprovalChallenge() : CallbackChallenge
    {
        public override string Kind => "approval";
    }

    public sealed record CaptchaChallenge(byte[] ImageBytes) : CallbackChallenge
    {
        public override string Kind => "captcha";
    }
}`)
        Assert.Contains("abstract data class CallbackChallenge", printed)
        Assert.DoesNotContain("open data class CallbackChallenge", printed)
        // The three zero-field derived records are the #2363 scenario —
        // must be preserved as `data class`, not downgraded.
        Assert.Contains("data class MfaChallenge() : CallbackChallenge", printed)
        Assert.Contains("data class CvfChallenge() : CallbackChallenge", printed)
        Assert.Contains("data class ApprovalChallenge() : CallbackChallenge", printed)
        // The one-field sibling is unaffected either way.
        Assert.Contains("data class CaptchaChallenge(ImageBytes []uint8) : CallbackChallenge", printed)
    }

    shared {
        private func TranslateUnit(source string) string {
            let (printed, _) = Translate(source)
            return printed
        }

        private func Translate(source string)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return (printed, context)
        }
    }
}
