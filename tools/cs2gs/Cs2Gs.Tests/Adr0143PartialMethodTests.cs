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
/// ADR-0143's partial-method rule, as amended 2026-09-23 for ADR-0192 (G#
/// partial methods): how the cs2gs translator handles a C# <c>partial</c>
/// method. This matters for the
/// ADR-0145 source-generator host, which back-translates real
/// CommunityToolkit.Mvvm output — that generator emits
/// <c>partial void OnXChanging/OnXChanged(...)</c> hooks (declaration only)
/// plus statement-position calls to them.
///
/// Classification (via <c>IMethodSymbol.IsPartialDefinition</c> /
/// <c>PartialImplementationPart</c> / <c>PartialDefinitionPart</c>):
/// <list type="number">
/// <item>An UNIMPLEMENTED partial method (definition with no implementation)
/// elides both its declaration AND every call site (a deletable partial
/// method is necessarily <c>void</c>, has no <c>out</c> params, and is only
/// invoked in statement position). G# rejects a lone declaring part
/// (GS0609), so this holds in both modes.</item>
/// <item>An IMPLEMENTED pair, in the default preserve-partial-parts mode,
/// whose two parts are both hand-authored source this run translates and
/// whose shape G# can spell, becomes a G# <c>partial func</c> declaring part
/// plus implementing part, each in the G# partial type part of its own C#
/// file.</item>
/// <item>Every other IMPLEMENTED pair (legacy merge mode, a part in a
/// generated/dropped document, an extension method, differing parameter
/// names, ...) translates ONLY the implementation part, as an ordinary
/// method — the defining part is skipped so the member is emitted exactly
/// once.</item>
/// </list>
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

    [Fact]
    public void ImplementedPair_PreserveMode_SplitAcrossFiles_EmitsDeclaringAndImplementingParts()
    {
        // ADR-0192: each C# part becomes a G# `partial func` part in the G#
        // partial type part of its OWN file — the declaring part (`;` no-body
        // marker) where the C# definition is, the implementing part (with
        // the body) where the C# implementation is.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("VM.Hooks.cs", @"
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);

        public void Configure(int value)
        {
            OnConfigured(value);
        }
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

        Assert.Equal(2, printed.Count);
        string declaring = printed[0];
        string implementing = printed[1];

        Assert.Contains("partial class VM", declaring);
        Assert.Contains("private partial func OnConfigured(value int32);", declaring);
        Assert.Contains("OnConfigured(value)", declaring);
        Assert.DoesNotContain("_seen = value", declaring);

        Assert.Contains("partial class VM", implementing);
        Assert.Contains("private partial func OnConfigured(value int32) {", implementing);
        Assert.Contains("_seen = value", implementing);
        Assert.Equal(1, CountOccurrences(implementing, "func OnConfigured("));
    }

    [Fact]
    public void ImplementedPair_PreserveMode_SameFile_EmitsBothPartsInOnePartialType()
    {
        // A single `partial class` may carry both parts itself (C# allows
        // it, and so does G#, ADR-0192 §G).
        string printed = TranslateSingle(
            preservePartialParts: true,
            ("VM.cs", @"
namespace Demo
{
    public partial class VM
    {
        private int _count;

        partial void OnReady();

        public void Init()
        {
            OnReady();
        }

        partial void OnReady()
        {
            _count++;
        }
    }
}"));

        Assert.Contains("private partial func OnReady();", printed);
        Assert.Contains("private partial func OnReady() {", printed);
        Assert.Equal(2, CountOccurrences(printed, "partial func OnReady("));
    }

    [Fact]
    public void ImplementedPair_PreserveMode_Static_EmitsBothPartsInSharedBlocks()
    {
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Math.Decl.cs", @"
namespace Demo
{
    public static partial class Calc
    {
        public static partial int Twice(int x);
    }
}"),
            ("Math.Impl.cs", @"
namespace Demo
{
    public static partial class Calc
    {
        public static partial int Twice(int x) => x * 2;
    }
}"));

        Assert.Contains("shared {", printed[0]);
        Assert.Contains("partial func Twice(x int32) int32;", printed[0]);
        Assert.Contains("shared {", printed[1]);
        Assert.Contains("partial func Twice(x int32) int32 -> x * 2", printed[1]);
    }

    [Fact]
    public void ImplementedPair_PreserveMode_AsyncImplementation_EmitsAsyncOnBothParts()
    {
        // C# lets only the implementing part say `async`; G# requires it on
        // both (ADR-0192 §D) — so the declaring part is built from the
        // implementation's signature, not the definition's.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Loader.Decl.cs", @"
using System.Threading.Tasks;

namespace Demo
{
    public partial class Loader
    {
        public partial Task<int> LoadAsync(int id);
    }
}"),
            ("Loader.Impl.cs", @"
using System.Threading.Tasks;

namespace Demo
{
    public partial class Loader
    {
        public async partial Task<int> LoadAsync(int id)
        {
            await Task.Yield();
            return id;
        }
    }
}"));

        Assert.Contains("async partial func LoadAsync(id int32) int32;", printed[0]);
        Assert.Contains("async partial func LoadAsync(id int32) int32 {", printed[1]);
    }

    [Fact]
    public void ImplementedPair_PreserveMode_DefinitionOnlyAttribute_IsPreservedOnDeclaringPart()
    {
        // Before ADR-0192 an attribute written only on the C# definition was
        // silently lost (only the implementation translated). Each G# part
        // now carries its own method-level attributes; gsc unions them.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Api.Decl.cs", @"
using System;

namespace Demo
{
    public partial class Api
    {
        [Obsolete(""use V2"")]
        public partial void Call();
    }
}"),
            ("Api.Impl.cs", @"
namespace Demo
{
    public partial class Api
    {
        public partial void Call()
        {
        }
    }
}"));

        Assert.Contains("@Obsolete(\"use V2\")", printed[0]);
        Assert.Contains("partial func Call();", printed[0]);
        Assert.DoesNotContain("Obsolete", printed[1]);
        Assert.Contains("partial func Call() {", printed[1]);
    }

    [Fact]
    public void ImplementedPair_PreserveMode_DefinitionDefaultValue_IsEmittedOnBothParts()
    {
        // C# puts the default on the definition (the implementation's is
        // ignored, CS1066); G# requires identical defaults on both parts.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Api.Decl.cs", @"
namespace Demo
{
    public partial class Api
    {
        public partial int Scale(int value, int factor = 3);

        public int Use() => Scale(2);
    }
}"),
            ("Api.Impl.cs", @"
namespace Demo
{
    public partial class Api
    {
        public partial int Scale(int value, int factor)
        {
            return value * factor;
        }
    }
}"));

        Assert.Contains("partial func Scale(value int32, factor int32 = 3) int32;", printed[0]);
        Assert.Contains("partial func Scale(value int32, factor int32 = 3) int32 {", printed[1]);
    }

    [Fact]
    public void ImplementedPair_PreserveMode_ParameterAttributeOnOnePart_IsUnionedOntoBothParts()
    {
        // C# unions parameter attributes across the parts; G# requires the
        // same annotations on both parts, so both get the union.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Note.cs", @"
using System;

namespace Demo
{
    [AttributeUsage(AttributeTargets.Parameter)]
    public sealed class NoteAttribute : Attribute
    {
    }
}"),
            ("Api.Decl.cs", @"
namespace Demo
{
    public partial class Api
    {
        public partial void Log([Note] string message);
    }
}"),
            ("Api.Impl.cs", @"
namespace Demo
{
    public partial class Api
    {
        public partial void Log(string message)
        {
        }
    }
}"));

        string declaring = printed[1];
        string implementing = printed[2];
        Assert.Contains("partial func Log(@Note message string);", declaring);
        Assert.Contains("partial func Log(@Note message string) {", implementing);
    }

    [Fact]
    public void ImplementedPair_DifferingParameterNames_KeepsSingleImplementation()
    {
        // C# only warns (CS8826) on differing parameter names; G# cannot
        // spell that pair (GS0611), so the pre-ADR-0192 shape is kept.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("VM.Decl.cs", @"
namespace Demo
{
    public partial class VM
    {
        partial void OnSet(int value);

        public void Set(int v) => OnSet(v);
    }
}"),
            ("VM.Impl.cs", @"
namespace Demo
{
    public partial class VM
    {
        private int _last;

#pragma warning disable CS8826
        partial void OnSet(int newValue)
        {
            _last = newValue;
        }
#pragma warning restore CS8826
    }
}"));

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func OnSet("));
        Assert.Contains("func OnSet(newValue int32)", combined);
    }

    [Fact]
    public void ImplementedPair_ExtensionMethod_KeepsSingleImplementation()
    {
        // cs2gs lowers a C# extension method to a receiver-clause func, which
        // G# rejects as partial (GS0607) — so the pre-ADR-0192 shape is kept.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Ext.Decl.cs", @"
namespace Demo
{
    public static partial class TextExtensions
    {
        public static partial string Shout(this string text);
    }
}"),
            ("Ext.Impl.cs", @"
namespace Demo
{
    public static partial class TextExtensions
    {
        public static partial string Shout(this string text) => text + ""!"";
    }
}"));

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "Shout("));
    }

    [Fact]
    public void ImplementedPair_LegacyMergeMode_KeepsSingleImplementation()
    {
        // Legacy issue #1910 merge produces one NON-partial G# type, where a
        // `partial func` would be GS0608.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: false,
            ("VM.Decl.cs", @"
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);
    }
}"),
            ("VM.Impl.cs", @"
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
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func OnConfigured("));
        Assert.Contains("_seen = value", combined);
    }

    [Fact]
    public void ImplementedPair_PreserveMode_DefinitionInAutoGeneratedDocument_KeepsSingleImplementation()
    {
        // The MVVM shape: a GENERATED document declares the hook and the user
        // implements it. cs2gs drops the `<auto-generated>` document (the
        // loader never hands it to the translator — gsgen regenerates it at
        // build, ADR-0145), so emitting the implementation as `partial func`
        // would leave it with no declaring part (GS0610). Only the
        // implementation translates, as an ordinary method.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("VM.g.cs", @"// <auto-generated/>
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

        // The generated document was dropped by the loader.
        string translated = Assert.Single(printed);
        Assert.DoesNotContain("partial func", translated);
        Assert.Equal(1, CountOccurrences(translated, "func OnConfigured("));
        Assert.Contains("_seen = value", translated);
    }

    [Fact]
    public void ImplementedPair_PreserveMode_DefinitionOutsideRetainedFiles_KeepsSingleImplementation()
    {
        // A project with generator references (issue #2215): the caller's
        // retained-file set excludes generator output, which need not carry
        // an `<auto-generated>` header. A part outside that set is treated
        // exactly like a dropped generated part.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: new[] { "VM.cs" },
            ("Generated/VM.Hooks.cs", @"
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

        string translated = Assert.Single(printed);
        Assert.DoesNotContain("partial func", translated);
        Assert.Equal(1, CountOccurrences(translated, "func OnConfigured("));
    }

    private static string TranslateSingle(
        bool preservePartialParts,
        (string FileName, string Source) file)
    {
        return TranslateFiles(preservePartialParts, file).Single();
    }

    private static IReadOnlyList<string> TranslateFiles(
        bool preservePartialParts,
        params (string FileName, string Source)[] files) =>
        TranslateFiles(preservePartialParts, retainedFilePaths: null, files);

    private static IReadOnlyList<string> TranslateFiles(
        bool preservePartialParts,
        IReadOnlyCollection<string> retainedFilePaths,
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var printedFiles = new List<string>();
        foreach (LoadedDocument document in project.Documents.Where(document =>
            retainedFilePaths == null || retainedFilePaths.Contains(document.FilePath)))
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator(
                preservePartialParts,
                retainedFilePaths: retainedFilePaths).TranslateDocument(document, context);

            printedFiles.Add(GSharpPrinter.Print(unit));
        }

        // Bind every translated file TOGETHER: an ADR-0192 partial method's
        // two parts may live in different files, and a file bound alone
        // would report its lone part (GS0609/GS0610).
        TranslationTestValidation.AssertBinds(printedFiles.ToArray());
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
