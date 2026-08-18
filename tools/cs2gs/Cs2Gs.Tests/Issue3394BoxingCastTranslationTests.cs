// <copyright file="Issue3394BoxingCastTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Tests;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #3394: an explicit value-type-to-interface boxing cast retains its
/// target type without being misrendered as interface construction.
/// </summary>
public class Issue3394BoxingCastTranslationTests
{
    [Fact]
    public void OpcodePrefixCombination_WidensBeforeBitwiseOr()
    {
        const string source = @"
namespace Demo
{
    public static class C
    {
        public static short Decode(byte next)
        {
            int encodedKey = 0xFE00 | next;
            return unchecked((short)encodedKey);
        }
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("let encodedKey = 0xFE00 | int32(next)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("uint8(0xFE00)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void SameCompilationReferenceDowncast_UsesCheckedCast()
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

        Assert.Contains("cast[Derived](value)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain(" as Derived", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    /// <summary>
    /// ADR-0166 / issue #3409: a type-parameter scrutinee with a constrained
    /// reference target is a native pattern variable — no scoped <c>if let</c>
    /// and no <c>as</c> conversion of the type parameter.
    /// </summary>
    [Fact]
    public void TypeParameterPatternBinding_UsesNativePatternVariable()
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

        Assert.Contains("if value is MethodInfo method && method.IsGenericMethod {", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("if let", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("as MethodInfo", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    /// <summary>
    /// ADR-0166 / issue #3409: the binder read in the <c>&amp;&amp;</c> right
    /// operand is a native pattern variable, so no narrowing cast is emitted at
    /// all — neither the <c>(value as Candidate)!!</c> substitution nor the
    /// <c>Candidate(value)</c> construction misrender this issue guards against.
    /// </summary>
    [Fact]
    public void ShortCircuitPatternBinding_UsesNativePatternVariable()
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

        Assert.Contains("value is Candidate candidate && candidate.Value > 0", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("as Candidate", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("Candidate(value)", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    /// <summary>
    /// ADR-0166 / issue #3409: a bare <c>{ } present</c> designation over a
    /// nullable value in a switch <c>when</c> guard is a native pattern variable
    /// scoped to the arm body, so the arm reads <c>present</c> directly — no
    /// <c>value!!</c> assertion and no <c>int32(value)</c> conversion.
    /// </summary>
    [Fact]
    public void BareRecursivePatternOnNullableValue_UsesNativePatternVariable()
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

        Assert.Contains("case 0 when value is { } present {", rendered, StringComparison.Ordinal);
        Assert.Contains("return present", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("value!!", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("int32(value)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void ImmutableArrayToReadOnlyList_UsesNativeInterfaceProjection()
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

        Assert.Contains("(values as IReadOnlyList[string])!!", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__cast", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("IReadOnlyList[string](values)", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);
    }

    [Fact]
    public void InferredLocal_BoxingCastKeepsInterfaceTypeAndRuns()
    {
        const string source = @"
namespace Demo
{
    public interface IValue
    {
        int Read();
    }

    public struct Value : IValue
    {
        public int Read() => 7;
    }

    public sealed class C
    {
        public int Run()
        {
            var value = new Value();
            var boxed = (IValue)value;
            return boxed.Read();
        }
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("let boxed = (value as IValue)!!", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__cast", rendered, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(rendered);

        var result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "C().Run()");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal(7, result.Value);
    }

    [Fact]
    public void NullableInterfaceBoxingCast_PreservesNullableAnnotation()
    {
        const string source = @"
#nullable enable
namespace Demo
{
    public interface IValue { }
    public struct Value : IValue { }

    public static class C
    {
        public static IValue? Box(Value value) => (IValue?)value;
    }
}
";

        string rendered = Translate(source);

        Assert.Contains("value as IValue?", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("(value as IValue?)!!", rendered, StringComparison.Ordinal);
        Assert.DoesNotContain("__cast", rendered, StringComparison.Ordinal);
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
