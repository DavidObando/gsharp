// <copyright file="Issue3750ElidedExtensionHolderReferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3750: a C# <c>static class</c> holding only extension methods is
/// lowered to top-level receiver-clause funcs and the holder itself is elided
/// (ADR-0115 §B.5) — but a surviving reference to the holder BY NAME then
/// names a type that no longer exists (<c>GS0113</c>), and where the result
/// feeds a member lookup it cascades into <c>GS0159</c>. The lifted funcs
/// carry the holder's behaviour but not its identity, so a holder whose
/// identity is still observed must survive the lowering.
/// </summary>
public class Issue3750ElidedExtensionHolderReferenceTests
{
    /// <summary>
    /// #3745 family F6: <c>test/Compiler.Tests/Emit/ClrInteropEmitTests.cs</c>
    /// holds one extension in <c>NamedParamsExtensionFixture</c> and names that
    /// class from <c>typeof(NamedParamsExtensionFixture).Assembly.Location</c>.
    /// </summary>
    [Fact]
    public void TypeOfElidedHolder_KeepsHolderDeclaration()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Extensions.cs", @"
namespace Demo;

public static class NamedParamsExtensionFixture
{
    public static string Describe(this string source, int statusCode) =>
        source + statusCode;
}"),
            ("Use.cs", @"
using System;

namespace Demo;

public sealed class Consumer
{
    public string Location() => typeof(NamedParamsExtensionFixture).Assembly.Location;

    public string Call() => ""x"".Describe(200);
}"));

        // The extension still lifts to the idiomatic receiver-clause func …
        Assert.Contains("func (source string) Describe(", printed["Extensions.cs"]);

        // … and the holder survives only as the empty type its identity needs.
        Assert.Contains("class NamedParamsExtensionFixture {", printed["Extensions.cs"]);
        Assert.Contains("typeof(NamedParamsExtensionFixture)", printed["Use.cs"]);
    }

    /// <summary>
    /// #3684 family F1b: the same defect through a namespace-qualified
    /// reference (<c>typeof(Fixtures.Handler322Extensions).Assembly.Location</c>
    /// in migrated <c>test/Core.Tests</c>), which was originally mis-diagnosed
    /// as a dropped import qualifier.
    /// </summary>
    [Fact]
    public void QualifiedTypeOfElidedHolder_KeepsHolderDeclaration()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Fixture.cs", @"
using System;

namespace Demo.Fixtures;

public static class Handler322Extensions
{
    public static string Handle(this string source, Delegate handler) =>
        source + (string)handler.DynamicInvoke();
}"),
            ("Use.cs", @"
using System;
using Demo.Fixtures;

namespace Demo;

public sealed class Consumer
{
    public string Location() => typeof(Handler322Extensions).Assembly.Location;
}"));

        Assert.Contains("func (source string) Handle(", printed["Fixture.cs"]);
        Assert.Contains("class Handler322Extensions {", printed["Fixture.cs"]);
        Assert.Contains("import Demo.Fixtures", printed["Use.cs"]);
        Assert.Contains("typeof(Handler322Extensions)", printed["Use.cs"]);
    }

    /// <summary>
    /// The attribute-argument form of the same reference: an attribute argument
    /// is an ordinary <c>typeof</c> expression, so it keeps the holder alive too.
    /// </summary>
    [Fact]
    public void TypeOfInAttributeArgument_KeepsHolderDeclaration()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Attr.cs", @"
using System;

namespace Demo;

[AttributeUsage(AttributeTargets.Class)]
public sealed class CoveredByAttribute : Attribute
{
    public CoveredByAttribute(Type target) => Target = target;

    public Type Target { get; }
}"),
            ("Extensions.cs", @"
namespace Demo;

public static class AttributeReferencedExtensions
{
    public static int Twice(this int value) => value * 2;
}"),
            ("Use.cs", @"
namespace Demo;

[CoveredBy(typeof(AttributeReferencedExtensions))]
public sealed class Consumer
{
    public int Call() => 21.Twice();
}"));

        Assert.Contains("func (value int32) Twice(", printed["Extensions.cs"]);
        Assert.Contains("class AttributeReferencedExtensions {", printed["Extensions.cs"]);
        Assert.Contains("typeof(AttributeReferencedExtensions)", printed["Use.cs"]);
    }

    /// <summary>
    /// The elision itself is unchanged for the overwhelmingly common case: a
    /// holder nothing names keeps producing extension-only output.
    /// </summary>
    [Fact]
    public void UnreferencedHolder_IsStillElided()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Extensions.cs", @"
namespace Demo;

public static class QuietExtensions
{
    public static string Describe(this string source, int statusCode) =>
        source + statusCode;
}"),
            ("Use.cs", @"
namespace Demo;

public sealed class Consumer
{
    public string Call() => ""x"".Describe(200);
}"));

        Assert.Contains("func (source string) Describe(", printed["Extensions.cs"]);
        Assert.DoesNotContain("QuietExtensions", printed["Extensions.cs"]);
    }

    /// <summary>
    /// A static-form call through the holder is already rewritten to the
    /// receiver form, so it names no type and does not keep the holder alive.
    /// </summary>
    [Fact]
    public void StaticFormCallThroughHolder_DoesNotKeepHolderDeclaration()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Extensions.cs", @"
namespace Demo;

public static class StaticFormExtensions
{
    public static string Describe(this string source, int statusCode) =>
        source + statusCode;
}"),
            ("Use.cs", @"
namespace Demo;

public sealed class Consumer
{
    public string Call() => StaticFormExtensions.Describe(""x"", 200);
}"));

        Assert.DoesNotContain("StaticFormExtensions", printed["Extensions.cs"]);
        Assert.DoesNotContain("StaticFormExtensions", printed["Use.cs"]);
        Assert.Contains(@"""x"".Describe(200)", printed["Use.cs"]);
    }

    /// <summary>
    /// <c>nameof(Holder)</c> constant-folds to a string literal before the
    /// printer sees it, so it never names a type and never dangles.
    /// </summary>
    [Fact]
    public void NameOfHolder_FoldsToLiteralAndLeavesHolderElided()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            ("Extensions.cs", @"
namespace Demo;

public static class NameOfExtensions
{
    public static int Twice(this int value) => value * 2;
}"),
            ("Use.cs", @"
namespace Demo;

public sealed class Consumer
{
    public string Name() => nameof(NameOfExtensions);
}"));

        Assert.DoesNotContain("class NameOfExtensions", printed["Extensions.cs"]);
        Assert.Contains(@"""NameOfExtensions""", printed["Use.cs"]);
    }

    /// <summary>
    /// A <c>typeof</c> that lives in a file this translation does not emit
    /// cannot keep the holder alive — that file produces no G# output.
    /// </summary>
    [Fact]
    public void TypeOfInExcludedFile_LeavesHolderElided()
    {
        IReadOnlyDictionary<string, string> printed = TranslateFiles(
            new CSharpToGSharpTranslator(retainedFilePaths: new[] { "Extensions.cs" }),
            validate: false,
            ("Extensions.cs", @"
namespace Demo;

public static class ExcludedReferenceExtensions
{
    public static int Twice(this int value) => value * 2;
}"),
            ("Generated.cs", @"
using System;

namespace Demo;

public sealed class Consumer
{
    public string Location() => typeof(ExcludedReferenceExtensions).Assembly.Location;
}"));

        Assert.DoesNotContain("ExcludedReferenceExtensions", printed["Extensions.cs"]);
    }

    private static IReadOnlyDictionary<string, string> TranslateFiles(
        params (string FileName, string Source)[] files)
    {
        return TranslateFiles(new CSharpToGSharpTranslator(), validate: true, files);
    }

    private static IReadOnlyDictionary<string, string> TranslateFiles(
        CSharpToGSharpTranslator translator,
        bool validate,
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(
                project.Compilation,
                document.SemanticModel,
                document.FilePath);
            CompilationUnit unit = translator.TranslateDocument(document, context);
            result.Add(document.FilePath, GSharpPrinter.Print(unit));
        }

        if (validate)
        {
            TranslationTestValidation.AssertBinds(result.Values.ToArray());
        }

        return result;
    }
}
