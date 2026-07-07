// <copyright file="Adr0143PartialMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// ADR-0143 §D: G# has no partial methods (or partial properties), so the
/// cs2gs translator must erase the C# <c>partial</c> method construct while
/// preserving behavior. This matters for the ADR-0145 source-generator host,
/// which back-translates real CommunityToolkit.Mvvm output — that generator
/// emits <c>partial void OnXChanging/OnXChanged(...)</c> hooks (declaration
/// only) plus statement-position calls to them.
///
/// Classification (via <c>IMethodSymbol.IsPartialDefinition</c> /
/// <c>PartialImplementationPart</c> / <c>PartialDefinitionPart</c>):
/// <list type="number">
/// <item>An UNIMPLEMENTED partial method (definition with no implementation)
/// elides both its declaration AND every call site (a deletable partial
/// method is necessarily <c>void</c>, has no <c>out</c> params, and is only
/// invoked in statement position).</item>
/// <item>An IMPLEMENTED partial method (defining + implementing pair)
/// translates ONLY the implementation part — the defining part is skipped so
/// the member is emitted exactly once.</item>
/// </list>
/// This applies in BOTH the default cs2gs-migration mode AND the
/// <c>preservePartialParts</c> host mode, and cooperates with the issue #1910
/// partial-TYPE merge (whose merged member list can hold both parts).
/// </summary>
public class Adr0143PartialMethodTests
{
    [Fact]
    public void UnimplementedPartialMethod_MvvmShaped_ElidesDeclarationAndCallSite()
    {
        // The MVVM shape: a generator-style `partial void OnNameChanged(...)`
        // hook DECLARED but never implemented, invoked in statement position
        // from a setter-like method.
        string printed = TranslateSingle(
            preservePartialParts: false,
            ("VM.cs", @"
namespace Demo
{
    public partial class VM
    {
        private string _name;

        partial void OnNameChanged(string value);

        public void SetName(string value)
        {
            _name = value;
            OnNameChanged(value);
        }
    }
}"));

        // Declaration elided: no `OnNameChanged` member survives.
        Assert.DoesNotContain("OnNameChanged", printed);

        // The rest of the class translates: the field and the setter body's
        // real assignment are preserved.
        Assert.Contains("class VM", printed);
        Assert.Contains("func SetName(", printed);
        Assert.Contains("_name = value", printed);
    }

    [Fact]
    public void ImplementedPartialMethod_DefiningPlusImplementingPair_EmitsSingleImplementation()
    {
        // Defining part in one declaration, implementing part in another
        // (partial-TYPE merge, issue #1910). Only the implementation must be
        // emitted — exactly one `OnReady` func with its body — and the call
        // site (which resolves to an implemented partial method) is preserved.
        string printed = TranslateSingle(
            preservePartialParts: false,
            ("VM.cs", @"
namespace Demo
{
    public partial class VM
    {
        partial void OnReady();

        public void Init()
        {
            OnReady();
        }
    }

    public partial class VM
    {
        partial void OnReady()
        {
            DoWork();
        }

        private void DoWork()
        {
        }
    }
}"));

        // Emitted exactly once (the defining part is skipped, not duplicated).
        Assert.Equal(1, CountOccurrences(printed, "func OnReady("));

        // The single surviving `OnReady` carries the IMPLEMENTATION's body.
        Assert.Contains("DoWork()", printed);

        // The call site to an IMPLEMENTED partial method is preserved: the
        // single func declaration (`func OnReady()`) plus the surviving call
        // (`OnReady()` in Init) give two `OnReady()` occurrences in all.
        Assert.Contains("func Init(", printed);
        Assert.Equal(2, CountOccurrences(printed, "OnReady()"));
    }

    [Fact]
    public void UserImplementedHook_GeneratorDeclaresDefinitionUserWritesImplementation_KeepsImplementation()
    {
        // ADR-0143 corpus case: the "generated" document declares the partial
        // hook; the user's own document supplies the implementation. Split
        // across two files (two partial parts of the same type).
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: false,
            ("VM.Generated.cs", @"
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);
    }
}"),
            ("VM.cs", @"
namespace Demo
{
    public partial class VM
    {
        private int _seen;

        partial void OnConfigured(int value)
        {
            _seen = value;
        }
    }
}"));

        string combined = string.Join("\n---\n", printed);

        // The user-written implementation is kept, exactly once, with its body.
        Assert.Equal(1, CountOccurrences(combined, "func OnConfigured("));
        Assert.Contains("_seen = value", combined);
    }

    [Fact]
    public void OrdinaryVoidMethod_NonPartial_IsUnaffected()
    {
        // Control: a plain (non-partial) void method with a body and its
        // statement-position call are both preserved unchanged.
        string printed = TranslateSingle(
            preservePartialParts: false,
            ("VM.cs", @"
namespace Demo
{
    public class VM
    {
        public void OnTick()
        {
        }

        public void Run()
        {
            OnTick();
        }
    }
}"));

        Assert.Equal(1, CountOccurrences(printed, "func OnTick("));
        Assert.Contains("func Run(", printed);

        // The func declaration (`func OnTick()`) plus its preserved call
        // (`OnTick()` in Run) give two `OnTick()` occurrences in all.
        Assert.Equal(2, CountOccurrences(printed, "OnTick()"));
    }

    [Fact]
    public void UnimplementedPartialMethod_InPreserveMode_AlsoElidesDeclarationAndCallSite()
    {
        // The same erasure applies in the source-generator host's
        // preserve-partial-parts mode — it is correct handling of a construct
        // G# cannot express, not migration-mode-specific.
        string printed = TranslateSingle(
            preservePartialParts: true,
            ("VM.g.cs", @"
namespace Demo
{
    public partial class VM
    {
        private string _name;

        partial void OnNameChanged(string value);

        public void SetName(string value)
        {
            _name = value;
            OnNameChanged(value);
        }
    }
}"));

        Assert.DoesNotContain("OnNameChanged", printed);
        Assert.Contains("partial class VM", printed);
        Assert.Contains("_name = value", printed);
    }

    private static string TranslateSingle(
        bool preservePartialParts,
        (string FileName, string Source) file)
    {
        return TranslateFiles(preservePartialParts, file).Single();
    }

    private static IReadOnlyList<string> TranslateFiles(
        bool preservePartialParts,
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var printedFiles = new List<string>();
        foreach (LoadedDocument document in project.Documents)
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator(preservePartialParts).TranslateDocument(document, context);

            string printed = GSharpPrinter.Print(unit);
            RoundTripResult result = GSharpRoundTrip.Validate(printed);
            Assert.True(
                result.Success,
                "Translated G# must round-trip. Errors:\n" +
                    string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
            printedFiles.Add(printed);
        }

        return printedFiles;
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }
}
