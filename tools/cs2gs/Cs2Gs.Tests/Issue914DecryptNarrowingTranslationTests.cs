// <copyright file="Issue914DecryptNarrowingTranslationTests.cs" company="GSharp">
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
/// Regression tests for the <c>Oahu.Decrypt</c> migration fixes tracked under
/// issue #914: narrowing of declaration-pattern bindings, assignment-LHS
/// null-forgiveness / <c>this</c>-qualification, null-conditional enum-extension
/// lowering, and nullable-arm typing of a ternary with a <c>null</c> branch.
/// Each snippet must round-trip-parse through the real G# parser.
/// </summary>
public class Issue914DecryptNarrowingTranslationTests
{
    /// <summary>
    /// Assigning through an implicit-<c>this</c> property receiver
    /// (<c>Header.FilePosition = x</c>) must qualify the receiver as
    /// <c>this.Header.FilePosition</c>; gsc rejects (ICEs on) the bare
    /// implicit-this property receiver as an assignment target (GS0158/GS9998).
    /// </summary>
    [Fact]
    public void AssignmentToImplicitThisPropertyMember_QualifiesThis()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class Hdr { public long FilePosition { get; set; } }

    public sealed class Box
    {
        public Hdr Header { get; } = new Hdr();

        public void Init(long pos)
        {
            Header.FilePosition = pos;
        }
    }
}");

        Assert.Contains("this.Header.FilePosition = pos", printed);
    }

    /// <summary>
    /// A positive type-pattern guard whose scrutinee is not smart-castable
    /// (here a method call) is hoisted to a nullable local; writing through that
    /// local inside the guard must null-forgive the receiver (<c>x!!.Member = …</c>)
    /// because gsc narrows pattern locals for reads but not for assignment targets.
    /// </summary>
    [Fact]
    public void AssignmentThroughHoistedGuardLocal_NullForgivesReceiver()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public interface IRefs { int[] TrackIds { get; set; } }
    public sealed class RefBox : IRefs { public int[] TrackIds { get; set; } = System.Array.Empty<int>(); }

    public sealed class Owner
    {
        public IRefs Lookup() => new RefBox();

        public void Apply(int[] references)
        {
            if (Lookup() is IRefs referenceType)
            {
                referenceType.TrackIds = references;
            }
        }
    }
}");

        Assert.Contains("referenceType!!.TrackIds = references", printed);
    }

    /// <summary>
    /// A null-conditional call to an enum extension method
    /// (<c>recv?.Count()</c> where the <c>this</c> parameter is an enum) cannot
    /// bind via the G# <c>?.</c> member-binding form because the helper is a
    /// plain static (a receiver clause is rejected on enums, GS0103). It lowers
    /// to the guarded positional call <c>if recv != nil { Owner.Count(recv!!) } else { nil }</c>.
    /// </summary>
    [Fact]
    public void NullConditionalEnumExtension_LowersToGuardedPositionalCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public enum Groups { A, B }

    public static class Ext
    {
        public static int Count(this Groups g) => 1;
    }

    public sealed class C
    {
        public Groups? G;

        public int? Read() => G?.Count();
    }
}");

        Assert.Contains("Ext.Count(", printed);
        Assert.Contains("!= nil", printed);
        Assert.DoesNotContain("?.Count()", printed);
    }

    /// <summary>
    /// A ternary with a <c>null</c> arm over a reference type
    /// (<c>cond ? value : null</c>) must re-emit the null arm as
    /// <c>default(T?)</c> carrying the mapped nullable type; a bare <c>nil</c>
    /// leaves gsc unable to unify the branches into the nullable union (GS0155).
    /// </summary>
    [Fact]
    public void TernaryWithNullArm_EmitsTypedDefaultForReferenceResult()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public sealed class C
    {
        public string? Pick(bool b, string s) => b ? s : null;
    }
}");

        Assert.Contains("default(string?)", printed);
        Assert.DoesNotContain("else { nil }", printed);
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

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = GSharpRoundTrip.Validate(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
