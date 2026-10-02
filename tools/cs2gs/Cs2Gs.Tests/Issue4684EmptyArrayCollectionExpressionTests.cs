// <copyright file="Issue4684EmptyArrayCollectionExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4684: csc lowers an empty collection expression that targets an
/// array (<c>T[] a = []</c>) to the cached <c>Array.Empty&lt;T&gt;()</c>
/// singleton. Translating it to a <c>[]T{}</c> literal allocated a fresh
/// zero-length array per evaluation, so the migrated
/// <c>Gsharp.Runtime.Values</c> allocated 24 extra bytes per
/// <c>ManagedLocationKey</c>, which tripped the array-location allocation
/// bound under self-host stage 2.
/// </summary>
public class Issue4684EmptyArrayCollectionExpressionTests
{
    [Fact]
    public void EmptyCollectionExpressionTargetingArray_TranslatesToArrayEmpty()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        private readonly (int, string)[] path;

        public C() { path = []; }

        public static (int, string)[] Make() => [];

        public static int[] Pass() => Take([]);

        private static int[] Take(int[] values) => values;
    }
}");

        Assert.Contains("System.Array.Empty[(int32, string)]()", printed);
        Assert.Contains("System.Array.Empty[int32]()", printed);
        Assert.DoesNotContain("{}", printed);
    }

    [Fact]
    public void ExplicitZeroLengthArrayAndNonEmptyCollectionExpression_KeepLiterals()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public class C
    {
        public static int[] Fresh() => new int[0];

        public static int[] Filled() => [1, 2];
    }
}");

        Assert.DoesNotContain("Array.Empty", printed);
        Assert.Contains("[]int32{1, 2}", printed);
    }

    [Fact]
    public void ManagedLocationKeySource_EmitsNoZeroLengthArrayLiteral()
    {
        string path = Path.Combine(RepoRoot(), "src", "Sdk", "Gsharp.Runtime.Values", "ManagedLocationKey.cs");
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("ManagedLocationKey.cs", "global using System;\n" + File.ReadAllText(path)) },
            assemblyName: "Gsharp.Runtime.Values");
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(document, context));

        // Element/Object literals, plus the `path` field's explicit empty initializer
        // that replaces gsc's synthesized zero-value array.
        Assert.Equal(2, CountOccurrences(printed, "System.Array.Empty[(RuntimeFieldHandle, RuntimeTypeHandle)]()"));
        Assert.Contains(
            "private let path [](Field RuntimeFieldHandle, Type RuntimeTypeHandle) = System.Array.Empty[",
            printed);
        Assert.DoesNotContain("(RuntimeFieldHandle, RuntimeTypeHandle){}", printed);
    }

    [Fact]
    public void BareNonNullableArrayInstanceField_GetsEmptyInitializer_OthersDoNot()
    {
        string printed = TranslateUnit(@"
#nullable enable
namespace Demo
{
    public class C
    {
        private readonly int[] items;
        private int[]? maybe;
        private static int[] shared = new int[2];
        private int[] explicitInit = new int[3];
        private int[,] grid;

        public C(int[] items) { this.items = items; grid = new int[1, 1]; }
    }
}");

        Assert.Contains("let items []int32 = System.Array.Empty[int32]()", printed);
        Assert.DoesNotContain("maybe []int32? =", printed);
        Assert.DoesNotContain("grid [,]int32 =", printed);
        Assert.Equal(1, CountOccurrences(printed, "Array.Empty"));
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        for (int i = text.IndexOf(value, StringComparison.Ordinal); i >= 0; i = text.IndexOf(value, i + value.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("Repository root not found.");
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
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }
}
