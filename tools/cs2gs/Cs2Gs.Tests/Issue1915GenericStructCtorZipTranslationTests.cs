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
/// Issue #1915 (sub-bug a): <c>TryMapCtorParametersToMembers</c> (issue #1739's
/// ctor-to-composite-literal "zip" detection, used to translate a positional
/// <c>new T(a, b)</c> on a struct that has no callable G# constructor into a G#
/// composite literal <c>T{a: ..., b: ...}</c>) compared a resolved field/
/// property's <c>ContainingType</c> against the CONSTRUCTED <c>valueType</c>
/// (e.g. <c>Slot&lt;int&gt;</c>) and a resolved parameter's <c>ContainingSymbol</c>
/// against the CONSTRUCTED ctor symbol — but the ctor body is walked via a
/// semantic model over its own declaring tree, which resolves those symbols
/// against the type's UNSUBSTITUTED (open) definition (<c>Slot&lt;T&gt;</c>).
/// For a generic struct the two never compared equal, so every ctor was
/// rejected with "struct constructor assigns a member from something other
/// than a plain, once-only parameter reference" even for the identical
/// trivial assign-through pattern that zips fine on a non-generic struct.
/// Fixed by keying the parameter→member map by parameter ORDINAL
/// (substitution-invariant) and comparing containing symbols via
/// <c>OriginalDefinition</c>.
/// </summary>
public class Issue1915GenericStructCtorZipTranslationTests
{
    [Fact]
    public void GenericStruct_PlainParameterAssignCtor_ZipsToCompositeLiteral()
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

        Assert.Contains("Slot[int32]{_content: 42}", printed);
    }

    [Fact]
    public void GenericStruct_MultiParameterCtor_ZipsInDeclaredParameterOrder()
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

        Assert.Contains("Pair[string]{First: \"a\", Second: \"b\"}", printed);
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
