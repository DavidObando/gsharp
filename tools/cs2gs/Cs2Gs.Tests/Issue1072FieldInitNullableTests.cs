// <copyright file="Issue1072FieldInitNullableTests.cs" company="GSharp">
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
/// Translator-fidelity tests for the issue #1072 field/property INITIALIZER form:
/// when a field or property whose declared type is a non-nullable reference type is
/// initialized from an expression that yields a nullable value (a <c>?.</c>
/// conditional access, a <c>?? nullableFallback</c> coalesce, or a member declared
/// <c>T?</c>), the emitted G# declared type must be widened to <c>T?</c>; otherwise
/// gsc rejects the initializer with <c>GS0156: Cannot convert type 'T?' to 'T'</c>.
/// The negative tests pin the precision guard: a provably non-null initializer keeps
/// its non-nullable <c>T</c> type.
/// </summary>
public class Issue1072FieldInitNullableTests
{
    [Fact]
    public void StaticGetOnlyProperty_ConditionalAccessInitializer_RendersNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public static string Name { get; } = Get()?.ToString();
        private static object Get() => null;
    }
}");

        Assert.Contains("let _name string? =", printed);
        Assert.Contains("prop Name string?", printed);
    }

    [Fact]
    public void StaticGetOnlyProperty_NonNullInitializer_KeepsNonNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public static string Name { get; } = ""hello"";
    }
}");

        Assert.Contains("let _name string =", printed);
        Assert.Contains("prop Name string", printed);
        Assert.DoesNotContain("let _name string? =", printed);
    }

    [Fact]
    public void StaticGetOnlyProperty_CoalesceWithNonNullFallback_KeepsNonNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public static string Name { get; } = Get()?.ToString() ?? ""fallback"";
        private static object Get() => null;
    }
}");

        Assert.Contains("let _name string =", printed);
        Assert.Contains("prop Name string", printed);
        Assert.DoesNotContain("let _name string? =", printed);
    }

    [Fact]
    public void StaticGetOnlyProperty_CoalesceWithNullableFallback_RendersNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public static string Name { get; } = Get()?.ToString() ?? Maybe();
        private static object Get() => null;
        private static string? Maybe() => null;
    }
}");

        Assert.Contains("let _name string? =", printed);
        Assert.Contains("prop Name string?", printed);
    }

    [Fact]
    public void InstanceField_ConditionalAccessInitializer_RendersNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private readonly string s = Get()?.ToString();
        private static object Get() => null;
    }
}");

        Assert.Contains("let s string? =", printed);
    }

    [Fact]
    public void StaticField_NullableMemberInitializer_RendersNullableType()
    {
        // `AssemblyName.Name` is declared `string?` in BCL metadata, so the
        // initializer is nullable even though the consuming nullable context is off.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public static string Title { get; } =
            System.Reflection.Assembly.GetEntryAssembly().GetName().Name;
    }
}");

        Assert.Contains("let _title string? =", printed);
        Assert.Contains("prop Title string?", printed);
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
