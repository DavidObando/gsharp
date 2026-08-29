// <copyright file="Issue3641NullArmInitializedLocalTranslationTests.cs" company="GSharp">
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
/// Translator-fidelity tests for issue #3641: a value initialized through a
/// conditional expression whose false (or true) arm is <c>null</c> is really
/// nullable — it observably holds <c>null</c> on that path, and the source
/// typically null-checks it later, which trips GS0523 (ADR-0159) when the
/// declaration renders bare.
/// <para>
/// The four SIMPLE-local shapes below already promoted correctly through the
/// issue-#1072 used-as-nullable analysis and are locked here as regression
/// probes. The real wall (the selfmig one at SdkCompileRunner.gs) is the fifth:
/// the null-bearing value is packed into a TUPLE ELEMENT that lives under a
/// generic type argument — <c>List&lt;(string Path, byte[] Original)&gt;</c> — and is
/// handed across three signatures. Because G# tuple types agree structurally,
/// the element has to render nullable at every one of those occurrences or at
/// none of them.
/// </para>
/// </summary>
public class Issue3641NullArmInitializedLocalTranslationTests
{
    [Fact]
    public void TernaryNullArmByteArrayLocal_WithLaterIsNullCheck_PromotesToNullable()
    {
        // The exact SdkCompileRunner shape: `byte[] x = cond ? bytes : null;`
        // followed by `if (x is null)`.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void F(string path)
        {
            byte[] originalNugetConfig = System.IO.File.Exists(path)
                ? System.IO.File.ReadAllBytes(path)
                : null;
            if (originalNugetConfig is null)
            {
                System.Console.WriteLine(""missing"");
            }
            else
            {
                System.IO.File.WriteAllBytes(path, originalNugetConfig);
            }
        }
    }
}");

        Assert.Contains("originalNugetConfig []?uint8 =", printed);
        Assert.DoesNotContain("originalNugetConfig []uint8 =", printed);
    }

    [Fact]
    public void TernaryNullArmLocalIntoTupleElement_TaintsTupleElementAcrossMembers()
    {
        // The surviving SdkCompileRunner wall (the .gs GS0523): a ternary-null
        // local packed into a tuple element that lives under a generic type
        // argument, handed across three signatures — the producer's
        // `IReadOnlyList<...>` return, an intermediate local, and a SIBLING
        // method's `IEnumerable<...>` parameter that null-checks the element
        // (`temporary.Original == null`). G# tuple types agree structurally, so
        // `Original` must render `[]?uint8` at EVERY one of those occurrences.
        string printed = TranslateUnit(@"
using System.Collections.Generic;
using System.Linq;

namespace Demo
{
    public static class C
    {
        public static void Run(IEnumerable<string> paths)
        {
            IReadOnlyList<(string Path, byte[] Original)> temporaryBuildProps = Prepare(paths);
            Restore(temporaryBuildProps);
        }

        public static IReadOnlyList<(string Path, byte[] Original)> Prepare(IEnumerable<string> paths)
        {
            var prepared = new List<(string Path, byte[] Original)>();
            foreach (string path in paths)
            {
                byte[] original = System.IO.File.Exists(path)
                    ? System.IO.File.ReadAllBytes(path)
                    : null;
                prepared.Add((path, original));
            }

            return prepared;
        }

        public static void Restore(IEnumerable<(string Path, byte[] Original)> temporaryBuildProps)
        {
            foreach (var temporary in temporaryBuildProps.Reverse())
            {
                if (temporary.Original == null)
                {
                    System.IO.File.Delete(temporary.Path);
                }
                else
                {
                    System.IO.File.WriteAllBytes(temporary.Path, temporary.Original);
                }
            }
        }
    }
}");

        Assert.DoesNotContain("Original []uint8)", printed);
        Assert.Contains("temporaryBuildProps IEnumerable[(Path string, Original []?uint8)]", printed);
        Assert.Contains("IReadOnlyList[(Path string, Original []?uint8)]", printed);
        Assert.Contains("List[(Path string, Original []?uint8)]", printed);
    }

    [Fact]
    public void TernaryNullArmStringLocal_WithLaterIsNullCheck_PromotesToNullable()
    {
        // Reference-type variant of the same shape.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void F(bool cond)
        {
            string s = cond ? ""x"" : null;
            if (s is null)
            {
                System.Console.WriteLine(""nil"");
            }
            else
            {
                System.Console.WriteLine(s);
            }
        }
    }
}");

        Assert.Contains("s string? =", printed);
    }

    [Fact]
    public void TernaryNullArmLocal_NeverNullChecked_StillPromotesToNullable()
    {
        // Even without a later null check, the null arm alone proves the local
        // can hold nil, so the declared type must be nullable for the
        // initializer itself to bind.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class Box { }
    public class C
    {
        public void F(bool cond)
        {
            Box b = cond ? new Box() : null;
            System.Console.WriteLine(b);
        }
    }
}");

        Assert.Contains("b Box? =", printed);
    }

    [Fact]
    public void TernaryNonNullArms_LocalStaysNonNullable()
    {
        // Precision guard: a conditional initializer with two non-null arms
        // must not be over-promoted.
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public void F(bool cond)
        {
            string s = cond ? ""x"" : ""y"";
            System.Console.WriteLine(s);
        }
    }
}");

        Assert.DoesNotContain("string?", printed);
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
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip and bind. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
