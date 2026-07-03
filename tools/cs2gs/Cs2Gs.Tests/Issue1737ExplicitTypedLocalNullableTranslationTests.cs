// <copyright file="Issue1737ExplicitTypedLocalNullableTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #1737: the issue-#1072 nullable promotion
/// (a non-nullable reference local that is null-checked or null-assigned in scope
/// is really nullable) was only reached for a `var` local. An explicit-typed local
/// whose declared type equals the initializer's natural type took a shortcut that
/// omits the type clause entirely and bypassed the promotion, so `T?` was silently
/// rendered as non-nullable `T`. The fix routes that shape through the same
/// <c>IsPromotedToNullableReference</c> decision `var` already uses.
/// </summary>
public class Issue1737ExplicitTypedLocalNullableTranslationTests
{
    [Fact]
    public void NullAssignedExplicitTypedLocal_SameNaturalType_PromotesToNullable()
    {
        // Reported shape: `StreamReader r = new StreamReader(...)` has a declared
        // type equal to the initializer's natural type, then `r` is later
        // assigned null.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Box { }
    public class C
    {
        public void F()
        {
            Box r = new Box();
            r = null;
            System.Console.WriteLine(r);
        }
    }
}");

        Assert.Contains("r Box? =", printed);
    }

    [Fact]
    public void NullComparedExplicitTypedLocal_SameNaturalType_PromotesToNullable()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Box { }
    public class C
    {
        public void F()
        {
            Box r = new Box();
            if (r == null) { return; }
            System.Console.WriteLine(r);
        }
    }
}");

        Assert.Contains("r Box? =", printed);
    }

    [Fact]
    public void NullAssignedExplicitTypedLocal_DifferentNaturalType_PromotesToNullable()
    {
        // Generalization: an explicit declared type that differs from the
        // initializer's natural type (already forced through the type-preserving
        // path) must still get the #1072 promotion when it is later null-assigned.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Box { }
    public class Derived : Box { }
    public class C
    {
        public void F()
        {
            Box r = new Derived();
            r = null;
            System.Console.WriteLine(r);
        }
    }
}");

        Assert.Contains("r Box? =", printed);
    }

    [Fact]
    public void NeverNullExplicitTypedLocal_SameNaturalType_StaysNonNullable()
    {
        // Precision guard: a local that is never null-checked nor null-assigned
        // must not be over-promoted.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Box { }
    public class C
    {
        public void F()
        {
            Box r = new Box();
            System.Console.WriteLine(r);
        }
    }
}");

        Assert.Contains("let r = ", printed);
        Assert.DoesNotContain("r Box? =", printed);
    }

    [Fact]
    public void AlreadyNullableExplicitTypedLocal_DoesNotDoublePromote()
    {
        // A local already declared `Box?` in C# must render a single `?`, not
        // a doubled one, when it is also null-assigned in scope.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Box { }
    public class C
    {
        public void F()
        {
            Box? r = new Box();
            r = null;
            System.Console.WriteLine(r);
        }
    }
}");

        Assert.Contains("r Box? =", printed);
        Assert.DoesNotContain("Box??", printed);
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
