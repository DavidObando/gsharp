// <copyright file="Issue1915GenericStructCtorZipTranslationTests.cs" company="GSharp">
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
/// Issue #1915's generic source-struct construction cases. Issue #2766 now
/// preserves the generic struct's real constructor and constructed call rather
/// than replaying the constructor as a composite literal.
/// </summary>
public class Issue1915GenericStructCtorZipTranslationTests
{
    [Fact]
    public void GenericStruct_PlainParameterAssignCtor_PreservesConstructedCall()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Slot<T>
    {
        private readonly T _content;
        public Slot(T content) { _content = content; }
        public T Content => _content;
    }

    public class C
    {
        public Slot<int> Make() => new Slot<int>(42);
    }
}");

        Assert.Contains("init(content T)", printed);
        Assert.Contains("Slot[int32](42)", printed);
    }

    [Fact]
    public void GenericStruct_MultiParameterCtor_PreservesDeclaredParameterOrder()
    {
        string printed = TranslateUnit(@"
namespace Demo
{
    public struct Pair<T>
    {
        public readonly T First;
        public readonly T Second;
        public Pair(T first, T second) { First = first; Second = second; }
    }

    public class C
    {
        public Pair<string> Make() => new Pair<string>(""a"", ""b"");
    }
}");

        Assert.Contains("init(first T, second T)", printed);
        Assert.Contains("Pair[string](\"a\", \"b\")", printed);
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
