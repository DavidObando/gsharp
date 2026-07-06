// <copyright file="BareFormExtensionCallTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for a SOURCE-defined extension method called through
/// its BARE name (the unqualified static form a sibling member inside the
/// declaring <c>static class</c> uses, e.g. <c>ApplicableState(book.Conversion)</c>).
/// It must be rewritten to the G# receiver-clause call
/// <c>book.Conversion.ApplicableState()</c> for the same reason as the qualified
/// <c>Owner.M(recv, args)</c> static form (issue #914): cs2gs lifts every non-enum
/// source extension of a <c>static class</c> to a top-level receiver-clause
/// <c>func (recv R) M[…](…)</c> (ADR-0115 §B.19), leaving no <c>Owner</c> type
/// behind — so the bare call would otherwise be qualified as
/// <c>Owner.M(...)</c> and fail to resolve (GS0157). Discovered migrating the Oahu
/// corpus (<c>EntityExtensions.ApplicableState</c>).
/// </summary>
public class BareFormExtensionCallTranslationTests
{
    [Fact]
    public void BareFormExtensionCall_RewrittenToReceiverForm()
    {
        // `Norm(s)` — a bare sibling extension call whose single argument is the
        // receiver — must become `s.Norm()`, never `Ext.Norm(s)`.
        string printed = Render(@"
namespace Demo
{
    public static class Ext
    {
        public static string Norm(this string s) { return s.Trim(); }
        public static string NormOrEmpty(this string s) { return s.Length == 0 ? """" : Norm(s); }
    }
}");

        Assert.Contains("s.Norm()", printed);
        Assert.DoesNotContain("Ext.Norm", printed);
    }

    [Fact]
    public void BareFormExtensionCall_WithTrailingArguments_KeepsThemAfterReceiver()
    {
        // The first argument is the receiver; the rest follow in the receiver call:
        // `Wrap(s, ""x"")` -> `s.Wrap(""x"")`.
        string printed = Render(@"
namespace Demo
{
    public static class Ext
    {
        public static string Wrap(this string s, string suffix) { return s + suffix; }
        public static string WrapX(this string s) { return Wrap(s, ""x""); }
    }
}");

        Assert.Contains(@"s.Wrap(""x"")", printed);
        Assert.DoesNotContain("Ext.Wrap", printed);
    }

    [Fact]
    public void BareFormGenericExtensionCall_RewrittenToReceiverForm_WithTypeArguments()
    {
        // A bare-form generic extension call `Cast<int>(o)` carries its type
        // arguments on the name; it must become `o.Cast[int32]()`.
        string printed = Render(@"
namespace Demo
{
    public static class Ext
    {
        public static T Cast<T>(this object o) { return (T)o; }
        public static int CastInt(this object o) { return Cast<int>(o); }
    }
}");

        Assert.Contains("o.Cast[int32]()", printed);
        Assert.DoesNotContain("Ext.Cast", printed);
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
        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
