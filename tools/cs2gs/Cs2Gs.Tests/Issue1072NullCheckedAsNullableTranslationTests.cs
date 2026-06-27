// <copyright file="Issue1072NullCheckedAsNullableTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #1072: G# follows Kotlin-style nullability
/// safety, so a `nil` comparison or `nil` assignment is only legal on a nullable
/// type. A C# parameter/field/local DECLARED non-nullable (`T`) but defensively
/// compared against <c>null</c> (<c>== null</c> / <c>!= null</c>) or assigned
/// <c>null</c> / <c>null!</c> is in truth nullable, so the faithful G# rendering of
/// its type clause is the nullable <c>T?</c> (otherwise gsc rejects the guard with
/// <c>GS0129</c>). The negative tests pin the precision guard so a parameter/field
/// that is never null-checked nor null-assigned keeps its non-nullable type.
/// </summary>
public class Issue1072NullCheckedAsNullableTranslationTests
{
    [Fact]
    public void NullCheckedReferenceParameter_RendersNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void F(string s)
        {
            if (s == null) throw new System.ArgumentException(""s"");
            System.Console.WriteLine(s.Length);
        }
    }
}");

        Assert.Contains("F(s string?)", printed);
    }

    [Fact]
    public void NullCheckedArrayParameter_RendersNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public C(byte[] key)
        {
            if (key == null || key.Length != 16) throw new System.ArgumentException(""key"");
        }
    }
}");

        Assert.Contains("key []?uint8", printed);
    }

    [Fact]
    public void IsNullPatternCheckedArrayParameter_RendersNullableType()
    {
        // `key is null` (constant pattern) is the C# pattern form of a null
        // comparison; it must promote the parameter to nullable just like `==`.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public C(byte[] iv)
        {
            if (iv is null || iv.Length != 16) throw new System.ArgumentException(""iv"");
        }
    }
}");

        Assert.Contains("iv []?uint8", printed);
    }

    [Fact]
    public void NullAssignedReferenceField_RendersNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private string name = null!;
        public void Reset() { name = null!; }
    }
}");

        Assert.Contains("name string?", printed);
    }

    [Fact]
    public void NullComparedReferenceField_RendersNullableType()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private object box = new object();
        public bool HasBox() => box != null;
    }
}");

        Assert.Contains("box object?", printed);
    }

    [Fact]
    public void NeverNullCheckedReferenceParameter_StaysNonNullable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public int F(string s)
        {
            return s.Length;
        }
    }
}");

        Assert.Contains("F(s string)", printed);
        Assert.DoesNotContain("s string?", printed);
    }

    [Fact]
    public void NeverNullCheckedReferenceField_StaysNonNullable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private string name = ""x"";
        public int Len() => name.Length;
    }
}");

        Assert.Contains("name string", printed);
        Assert.DoesNotContain("name string?", printed);
    }

    [Fact]
    public void NullCheckedValueParameter_StaysNonNullable()
    {
        // Value types are out of scope for this pass: an `int` compared to null is
        // a C# nullable-value scenario handled elsewhere, not a reference promotion.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void F(int x)
        {
            System.Console.WriteLine(x);
        }
    }
}");

        Assert.Contains("F(x int32)", printed);
        Assert.DoesNotContain("x int32?", printed);
    }

    [Fact]
    public void NullableTypeParameterReturn_RendersNullableType()
    {
        // A `T?` return on a method whose type parameter is interface-constrained
        // (`where T : IBox`) reports `IsReferenceType == false` in Roslyn, so the
        // `?` must be honoured via the type-parameter path or it is silently
        // dropped and `let x = GetChild<T>()` infers a non-nullable `T`, breaking
        // the subsequent `x == nil` guard at the call site (issue #1072 cascade).
        string printed = TranslateUnit(@"
namespace Demo
{
    public interface IBox { }
    public class Box : IBox
    {
        public T? GetChild<T>() where T : IBox => default;
    }
}");

        Assert.Contains("GetChild[T IBox]() T?", printed);
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
