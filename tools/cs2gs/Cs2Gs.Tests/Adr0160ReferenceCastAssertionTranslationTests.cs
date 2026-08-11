// <copyright file="Adr0160ReferenceCastAssertionTranslationTests.cs" company="GSharp">
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
/// ADR-0160 / issue #3349: G# has no conversion-call form for a reference downcast,
/// so <c>TranslateCast</c> renders a C# hard cast <c>(T)expr</c> as <c>expr as T</c>
/// (issue #914). Once <c>as</c> yielded <c>T?</c>, every consuming position — member
/// receiver, index target, return, argument, initializer — needed a <c>!!</c> that
/// the null-forgiveness passes would not supply: those key off Roslyn's nullability,
/// and Roslyn correctly reports a hard cast's result as non-null, since a failing
/// cast throws. The assertion is therefore emitted at the CAST, which is both
/// faithful and complete.
/// <para>
/// The distinction that must not regress: a cast written <c>(T?)expr</c> may
/// legitimately be nil and stays unasserted. Getting that wrong throws at runtime
/// where C# does not — a silent behaviour change no compile error would catch.
/// </para>
/// </summary>
public class Adr0160ReferenceCastAssertionTranslationTests
{
    [Fact]
    public void NonNullableTargetCast_UsedAsReceiver_IsAsserted()
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

        Assert.Contains("as IProfile)!!", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NonNullableTargetCast_Indexed_IsAsserted()
    {
        // The oahu-corpus shape behind `GS0116: Type '[]?object' is not indexable`.
        string printed = Translate(@"
public sealed class C
{
    public object First(object o) => ((object[])o)[0];
}");

        Assert.Contains("!!", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("(o as []object)[", printed, StringComparison.Ordinal);
    }

    [Fact]
    public void NonNullableTargetCast_Returned_IsAsserted()
    {
        // The oahu-corpus shape behind `GS0155: Cannot convert 'string?' to 'string'`.
        string printed = Translate(@"
public sealed class C
{
    public string Text(object o) => (string)o;
}");

        Assert.Contains("(o as string)!!", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The regression guard that matters most: a nullable-annotated target keeps the
    /// bare <c>T?</c>. Asserting here would throw at runtime where C# returns null.
    /// </summary>
    [Fact]
    public void NullableTargetCast_IsNotAsserted()
    {
        string printed = Translate(@"
#nullable enable
public sealed class C
{
    public string? Text(object o) => (string?)o;
}");

        Assert.Contains("as string", printed, StringComparison.Ordinal);
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal);
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
