// <copyright file="Issue3394BoxingCastTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3394: an explicit value-type-to-interface boxing cast retains its
/// target type without being misrendered as interface construction.
/// </summary>
public class Issue3394BoxingCastTranslationTests
{
    [Fact]
    public void SameCompilationReferenceDowncast_UsesAsAssertion()
    {
        const string source = @"
namespace Demo
{
    public class Base {}
    public class Derived : Base {}

    public static class C
    {
        public static Derived Cast(Base value) => (Derived)value;
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("(value as Derived)!!", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Derived(value)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void TypeParameterPatternBinding_UsesScopedIfLet()
    {
        const string source = @"
using System.Reflection;

namespace Demo
{
    public static class C
    {
        public static bool Check<T>(T value) where T : MemberInfo
        {
            if (value is MethodInfo method && method.IsGenericMethod)
            {
                return method.GetGenericArguments().Length > 0;
            }

            return false;
        }
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("if let method = value as MethodInfo", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ShortCircuitPatternBinding_UsesExplicitNarrowingCast()
    {
        const string source = @"
namespace Demo
{
    public class Base {}
    public sealed class Candidate : Base { public int Value; }

    public static class C
    {
        public static bool Check(Base value) =>
            value is Candidate candidate && candidate.Value > 0;
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("(value as Candidate)!!.Value", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void BareRecursivePatternOnNullableValue_UsesAssertion()
    {
        const string source = @"
namespace Demo
{
    public static class C
    {
        public static int Read(int? value)
        {
            switch (0)
            {
                case 0 when value is { } present:
                    return present;
                default:
                    return 0;
            }
        }
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("return value!!", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ImmutableArrayToReadOnlyList_UsesTypedBlockLocal()
    {
        const string source = @"
using System.Collections.Generic;
using System.Collections.Immutable;
namespace Demo
{
    public static class C
    {
        private static int Count(IReadOnlyList<string> values) => values.Count;

        public static int Read(ImmutableArray<string> values) =>
            Count((IReadOnlyList<string>)values);
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("let __cast", rendered, StringComparison.Ordinal);
        Assert.Contains("IReadOnlyList[string] = values", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("IReadOnlyList[string](values)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ReferenceTypedUserDefinedCast_UsesConversionCall()
    {
        const string source = @"
using System.Text.Json.Nodes;
namespace Demo
{
    public static class C
    {
        public static string? Read(JsonObject value) => (string?)value[""name""];
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("string?(value[\"name\"])", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("as string", rendered, StringComparison.Ordinal);
        var roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
            rendered,
            "The standalone binder fixture does not reference System.Text.Json.Nodes.");
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors));
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) });
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(
            project.Compilation,
            document.SemanticModel,
            document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
