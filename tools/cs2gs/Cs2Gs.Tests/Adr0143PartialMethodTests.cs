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
using System;

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
    public void ImplementedPair_PreserveMode_SameFileParameterAttributeOnOnePart_IsUnionedOntoBothParts()
    {
        // C# unions parameter attributes across the parts; G# requires the
        // same annotations on both parts, so both get the union. Both parts
        // are in one file (one type mapper), so the union cannot move an
        // attribute into another file.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Note.cs", NoteAttributeSource),
            ("Api.cs", @"
namespace Demo
{
    public partial class Api
    {
        public partial void Log([Note] string message);

        public partial void Log(string message)
        {
        }
    }
}"));

        Assert.Contains("partial func Log(@Note message string);", printed[1]);
        Assert.Contains("partial func Log(@Note message string) {", printed[1]);
    }

    [Fact]
    public void ImplementedPair_CrossFileParameterAttribute_KeepsSingleImplementation()
    {
        // Across files, the union would copy one file's attribute into the
        // other file, where it can resolve differently or add an import that
        // breaks that file (a leak the post-pass cannot see), so a cross-file
        // pair with any parameter attribute keeps the pre-ADR-0192 shape.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Note.cs", NoteAttributeSource),
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

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func Log("));
    }

    [Fact]
    public void ImplementedPair_ParameterAttributeResolvingDifferentlyPerFile_KeepsSingleImplementation()
    {
        // Review repro: `Tag` names N1.TagAttribute in the definition's file
        // and N2.TagAttribute in the implementation's. Unioning the
        // definition's `@Tag` onto the implementing part dragged `import N1`
        // into its file, breaking that file's own `@Tag` (N2).
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("N1.cs", @"
using System;

namespace N1
{
    public sealed class TagAttribute : Attribute
    {
    }
}"),
            ("N2.cs", @"
using System;

namespace N2
{
    public sealed class TagAttribute : Attribute
    {
    }

    public class Other
    {
    }
}"),
            ("Decl.cs", @"
using N1;

namespace Demo
{
    public partial class A
    {
        partial void M([Tag] int x);
    }
}"),
            ("Impl.cs", @"
using N2;

namespace Demo
{
    public partial class A
    {
        partial void M(int x)
        {
        }

        [Tag]
        public void Use(Other o)
        {
        }
    }
}"));

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func M("));
        Assert.DoesNotContain("import N1", printed[3]);
    }

    [Fact]
    public void ImplementedPair_TypeSpelledDifferentlyPerFile_KeepsSingleImplementation()
    {
        // Review repro: `Timer` is ambiguous (System.Threading vs
        // System.Timers) only in the definition's file, so the two G# files
        // would spell the parameter type differently (an alias in one, the
        // bare name in the other) — gsc compares the parts as text (GS0611).
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Decl.cs", @"
using System.Threading;
using System.Timers;

namespace Demo
{
    public partial class A
    {
        partial void M(System.Threading.Timer t);

        public void Use(ElapsedEventArgs e, CancellationToken c)
        {
        }
    }
}"),
            ("Impl.cs", @"
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t)
        {
        }
    }
}"));

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func M("));
    }

    [Fact]
    public void ImplementedPair_SameUsingsAcrossFiles_EmitsPairEvenWhenTypeNeedsAlias()
    {
        // Positive control for the using-scope rule: both files import both
        // namespaces, so `Timer` is ambiguous in both and both G# files spell
        // it the same (aliased) way.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Decl.cs", @"
using System.Threading;
using System.Timers;

namespace Demo
{
    public partial class A
    {
        partial void M(System.Threading.Timer t);

        public void Use(ElapsedEventArgs e, CancellationToken c)
        {
        }
    }
}"),
            ("Impl.cs", @"
using System.Threading;
using System.Timers;

namespace Demo
{
    public partial class A
    {
        partial void M(System.Threading.Timer t)
        {
        }
    }
}"));

        Assert.Contains("private partial func M(t ThreadingTimer);", printed[0]);
        Assert.Contains("private partial func M(t ThreadingTimer) {", printed[1]);
        string declaringHeader = printed[0].Substring(printed[0].IndexOf("private partial func M(", StringComparison.Ordinal));
        declaringHeader = declaringHeader.Substring(0, declaringHeader.IndexOf(';'));
        Assert.Contains(declaringHeader + " {", printed[1]);
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

    [Fact]
    public void ImplementedPair_PreserveMode_DefinitionUnderObjDirectory_KeepsSingleImplementation()
    {
        // The loader also drops a file under the project's obj/bin directory
        // even without an <auto-generated> header; the translator applies the
        // same rule (GeneratedSourceDetection) when it knows the project
        // directory.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: null,
            projectDirectory: "/src/App",
            ("/src/App/obj/Debug/VM.Hooks.cs", @"
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);
    }
}"),
            ("/src/App/VM.cs", @"
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

    [Fact]
    public void ImplementedPair_QualifiedParameterAttributeUnderSameUsings_KeepsSingleImplementation()
    {
        // Review repro: both files see only `using N2;`, but the definition
        // writes `[N1.Tag]`. Unioning it onto the implementing part added
        // `import N1` to that file, where `@Tag` on `Use` then stopped binding.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("N1.cs", @"
using System;

namespace N1
{
    public sealed class TagAttribute : Attribute
    {
    }
}"),
            ("N2.cs", @"
using System;

namespace N2
{
    public sealed class TagAttribute : Attribute
    {
    }

    public class Other
    {
    }
}"),
            ("Decl.cs", @"
using N2;

namespace Demo
{
    public partial class A
    {
        partial void M([N1.Tag] int x);
    }
}"),
            ("Impl.cs", @"
using N2;

namespace Demo
{
    public partial class A
    {
        partial void M(int x)
        {
        }

        [Tag]
        public void Use(Other o)
        {
        }
    }
}"));

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func M("));
        Assert.DoesNotContain("import N1", printed[3]);
    }

    [Fact]
    public void ImplementedPair_QualifiedMemberElsewhereInDefinitionFile_IsDemotedByReconciliation()
    {
        // Review repro: identical usings, but a qualified System.Timers.Timer
        // elsewhere in the DEFINITION's file makes that file's pre-scan alias
        // `Timer` (ThreadingTimer), while the implementation's file prints the
        // bare `Timer`. Only the post-translation comparison can see that; it
        // demotes the pair to the single-implementation shape.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Decl.cs", TimerDefinitionWithQualifiedSibling),
            ("Impl.cs", TimerImplementation));

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func M("));
    }

    [Fact]
    public void ImplementedPair_QualifiedMemberElsewhereInImplementationFile_IsDemotedByReconciliation()
    {
        // Mirror of the previous test: the qualified sibling is in the
        // implementation's file.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            ("Decl.cs", @"
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t);
    }
}"),
            ("Impl.cs", @"
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t)
        {
        }

        public void Use(System.Timers.Timer x, System.Timers.ElapsedEventArgs e)
        {
        }
    }
}"));

        string combined = string.Join("\n---\n", printed);
        Assert.DoesNotContain("partial func", combined);
        Assert.Equal(1, CountOccurrences(combined, "func M("));
    }

    [Fact]
    public void DemotedPair_DefinitionFileOutput_EqualsTranslationWithoutPairs()
    {
        // A demoted pair's declaring part was already spelled into its file
        // (which may have recorded imports/aliases) before the post-pass
        // removed it. The definition file must still come out exactly as it
        // does with pairs disabled (the pre-ADR-0192 output).
        (string FileName, string Source)[] files =
        {
            ("Decl.cs", TimerDefinitionWithQualifiedSibling),
            ("Impl.cs", TimerImplementation),
        };
        IReadOnlyList<string> demoted = TranslateFiles(
            preservePartialParts: true, retainedFilePaths: null, projectDirectory: null, emitPartialMethodPairs: true, files);
        IReadOnlyList<string> withoutPairs = TranslateFiles(
            preservePartialParts: true, retainedFilePaths: null, projectDirectory: null, emitPartialMethodPairs: false, files);

        for (int i = 0; i < withoutPairs.Count; i++)
        {
            Assert.True(
                withoutPairs[i] == demoted[i],
                $"File {i} differs.\n--- without pairs ---\n{withoutPairs[i]}\n--- demoted ---\n{demoted[i]}");
        }
    }

    [Fact]
    public void ImplementedPair_WithoutEmitPartialMethodPairsOption_KeepsSingleImplementation()
    {
        // Pairs are opt-in: a caller that does not run the reconciliation
        // post-pass (TestParityStage, SnippetTranslator, gsgen, direct
        // translation) keeps today's output even for a pair that would
        // otherwise be emitted.
        IReadOnlyList<string> printed = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: null,
            projectDirectory: null,
            emitPartialMethodPairs: false,
            ("VM.cs", @"
namespace Demo
{
    public partial class VM
    {
        private int _count;

        partial void OnReady();

        partial void OnReady()
        {
            _count++;
        }
    }
}"));

        string translated = Assert.Single(printed);
        Assert.DoesNotContain("partial func", translated);
        Assert.Equal(1, CountOccurrences(translated, "func OnReady("));
    }

    private const string TimerDefinitionWithQualifiedSibling = @"
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t);

        public void Use(System.Timers.Timer x, System.Timers.ElapsedEventArgs e)
        {
        }
    }
}";

    private const string TimerImplementation = @"
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t)
        {
        }
    }
}";

    private const string NoteAttributeSource = @"
using System;

namespace Demo
{
    [AttributeUsage(AttributeTargets.Parameter)]
    public sealed class NoteAttribute : Attribute
    {
    }
}";

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
        params (string FileName, string Source)[] files) =>
        TranslateFiles(preservePartialParts, retainedFilePaths, projectDirectory: null, files);

    private static IReadOnlyList<string> TranslateFiles(
        bool preservePartialParts,
        IReadOnlyCollection<string> retainedFilePaths,
        string projectDirectory,
        params (string FileName, string Source)[] files) =>
        TranslateFiles(preservePartialParts, retainedFilePaths, projectDirectory, emitPartialMethodPairs: true, files);

    // Translates every file, then (with emitPartialMethodPairs, as
    // TranslateStage does) reconciles the tentative partial method pairs
    // across ALL units before printing any of them.
    private static IReadOnlyList<string> TranslateFiles(
        bool preservePartialParts,
        IReadOnlyCollection<string> retainedFilePaths,
        string projectDirectory,
        bool emitPartialMethodPairs,
        params (string FileName, string Source)[] files)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(files);
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        var units = new List<CompilationUnit>();

        // Mirror the loader: a file under the project's obj/bin directory is
        // never translated (LoadInMemory has no project directory to apply
        // that rule itself).
        foreach (LoadedDocument document in project.Documents.Where(document =>
            (retainedFilePaths == null || retainedFilePaths.Contains(document.FilePath))
            && !GeneratedSourceDetection.IsUnderBuildOutputDirectory(document.FilePath, projectDirectory)))
        {
            var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
            CompilationUnit unit = new CSharpToGSharpTranslator(
                preservePartialParts,
                retainedFilePaths: retainedFilePaths,
                projectDirectory: projectDirectory,
                emitPartialMethodPairs: emitPartialMethodPairs).TranslateDocument(document, context);
            units.Add(unit);
        }

        IReadOnlyList<CompilationUnit> reconciled = emitPartialMethodPairs
            ? PartialMethodPairReconciler.Reconcile(units)
            : units;
        var printedFiles = reconciled.Select(GSharpPrinter.Print).ToList();

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
