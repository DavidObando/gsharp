// <copyright file="Issue3421CheckedReferenceCastTranslationTests.cs" company="GSharp">
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
/// Issue #3421: C# hard reference casts use G#'s unambiguous checked cast
/// <c>cast[T](expr)</c>. Testing conversions remain <c>expr as T</c>.
/// <para>
/// A checked reference cast preserves null and throws <see cref="InvalidCastException"/>
/// for an incompatible non-null value, matching C#.
/// </para>
/// </summary>
public class Issue3421CheckedReferenceCastTranslationTests
{
    [Fact]
    public void NonNullableTargetCast_UsedAsReceiver_UsesConversionCall()
    {
        // The oahu-corpus shape: `((IProfile)p).Member` was GS0158 without the
        // assertion, because the receiver is `IProfile?`.
        string printed = Translate(@"
public interface IProfile { string Name { get; } }
public sealed class Profile : IProfile { public string Name => ""x""; }

public sealed class C
{
    public string Read(Profile p) => ((IProfile)p).Name;
}");

        Assert.Contains("cast[IProfile](p)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as IProfile", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void NonNullableTargetCast_Indexed_UsesConversionCall()
    {
        // The oahu-corpus shape behind `GS0116: Type '[]?object' is not indexable`.
        string printed = Translate(@"
public sealed class C
{
    public object First(object o) => ((object[])o)[0];
}");

        Assert.Contains("cast[[]object](o)", printed, StringComparison.Ordinal);
        Assert.Contains("[0]", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as []object", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void NonNullableTargetCast_Returned_UsesConversionCall()
    {
        // The oahu-corpus shape behind `GS0155: Cannot convert 'string?' to 'string'`.
        string printed = Translate(@"
public sealed class C
{
    public string Text(object o) => (string)o;
}");

        Assert.Contains("cast[string](o)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as string", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A nullable-annotated target keeps checked <c>cast[T?](value)</c> semantics:
    /// null stays null, while an incompatible non-null value still throws.
    /// </summary>
    [Fact]
    public void NullableTargetCast_UsesNullableConversionCall()
    {
        string printed = Translate(@"
#nullable enable
public sealed class C
{
    public string? Text(object o) => (string?)o;
}");

        Assert.Contains("cast[string?](o)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as string", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// A numeric/value conversion is not a reference conversion and keeps the
    /// conversion-call form, with no `as` and no assertion.
    /// </summary>
    [Fact]
    public void ValueConversion_KeepsConversionCallForm()
    {
        string printed = Translate(@"
public sealed class C
{
    public int Truncate(double d) => (int)d;
}");

        Assert.Contains("int32(d)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as ", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// An upcast to <c>object</c> is dropped entirely by `TranslateCast` and must not
    /// acquire an assertion.
    /// </summary>
    [Fact]
    public void ObjectUpcast_IsNotAsserted()
    {
        string printed = Translate(@"
public sealed class C
{
    public object Box(string s) => (object)s;
}");

        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void CSharpAsExpression_RemainsTestingConversion()
    {
        string printed = Translate(@"
public sealed class C
{
    public string? Text(object o) => o as string;
}");

        Assert.Contains("o as string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("string?(o)", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void ExplicitAsNullForgiveness_RemainsTestingConversion()
    {
        string printed = Translate(@"
public sealed class C
{
    public int Length(object value) => (value as string)!.Length;
}");

        Assert.Contains("(value as string)!!.Length", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("cast[string](value)", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void ConditionalInterfaceBoxingCast_UsesUnambiguousCast()
    {
        string printed = Translate(@"
using System.Collections.Generic;
using System.Collections.Immutable;

public static class C
{
    public static IReadOnlyList<string>? Names(ImmutableArray<string> argumentNames) =>
        argumentNames.IsDefault ? null : (IReadOnlyList<string>)argumentNames;
}");

        Assert.Contains(
            "if argumentNames.IsDefault { default(IReadOnlyList[string]?) } else { cast[IReadOnlyList[string]](argumentNames) }",
            printed,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "(argumentNames as IReadOnlyList[string])!!",
            printed,
            StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void GenericAndDynamicReferenceCasts_UseConversionCalls()
    {
        string printed = Translate(@"
using System;
using System.Collections.Generic;

public static class C
{
    public static T Generic<T>(object value) where T : class => (T)value;
    public static string Dynamic(dynamic value) => (string)value;
    public static Func<int> Function(object value) => (Func<int>)value;
    public static Func<int>? NullableFunction(object? value) => (Func<int>?)value;
    public static List<int>? GenericNullable(object? value) => (List<int>?)value;
}");

        Assert.Contains("cast[T](value)", printed, StringComparison.Ordinal);
        Assert.Contains("cast[string](value)", printed, StringComparison.Ordinal);
        Assert.Contains("cast[Func[int32]](value)", printed, StringComparison.Ordinal);
        Assert.Contains("cast[Func[int32]?](value)", printed, StringComparison.Ordinal);
        Assert.Contains("cast[List[int32]?](value)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as T", printed, StringComparison.Ordinal);
        Assert.DoesNotContain(" as string", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void TargetWithApplicableConstructor_StillPerformsCheckedCast()
    {
        string printed = Translate(@"
using System;

public class Base { }

public sealed class Target : Base
{
    public Target(object value) { }
    public string Value => ""constructed"";
}

public static class C
{
    public static string Run(Base value)
    {
        try { return ((Target)value).Value; }
        catch (InvalidCastException) { return nameof(InvalidCastException); }
    }
}");

        Assert.Contains("cast[Target](value)", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("Target(value)", printed, StringComparison.Ordinal);
        TranslationTestValidation.AssertBinds(printed);

        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "C.Run(Base())");
        Assert.Empty(result.Diagnostics);
        Assert.Null(result.UnhandledException);
        Assert.Equal("InvalidCastException", result.Value);
    }

    /// <summary>
    /// The oahu-corpus shape (<c>ExtensionsSyncContext</c>, 14 sites): oblivious C#
    /// binds a local from an <c>as</c> and dereferences it with no null test. Roslyn
    /// never reports such a local maybe-null, so the ordinary forgiveness predicates
    /// cannot see it — yet the local's G# type is <c>T?</c> and the dereference is
    /// GS0116. Asserting at the dereference matches C#, which raises a
    /// NullReferenceException at exactly that point.
    /// </summary>
    [Fact]
    public void LocalBoundFromAs_DereferencedWithoutGuard_IsAssertedAtTheDereference()
    {
        string printed = Translate(@"
public static class C
{
    public static void Go(System.Action<int, int> d, object o)
    {
        var p = o as object[];
        d((int)p[0], (int)p[1]);
    }
}");

        Assert.Contains("p!![0]", printed, StringComparison.Ordinal);
        Assert.Contains("p!![1]", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The guarded counterpart must not change: C# tests the local, so Roslyn
    /// reports it maybe-null and the existing predicates already assert inside the
    /// guard. Asserting at the <c>as</c> instead would move the throw ahead of the
    /// test and break this shape.
    /// </summary>
    [Fact]
    public void LocalBoundFromAs_NullTested_KeepsGuardedShape()
    {
        string printed = Translate(@"
public static class C
{
    public static int Guarded(object o)
    {
        var p = o as object[];
        if (p != null) { return p.Length; }
        return 0;
    }
}");

        Assert.Contains("if p != nil", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(o as []object)!!", printed, StringComparison.Ordinal);
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", "namespace Demo\n{\n" + source + "\n}\n") });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: "
                + string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }
}
