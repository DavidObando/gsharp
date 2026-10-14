// <copyright file="Adr0143PartialMethodTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0143's partial-method rule, as amended 2026-09-23 for ADR-0192 (G#
/// partial methods): how the cs2gs translator handles a C# `partial`
/// method. This matters for the
/// ADR-0145 source-generator host, which back-translates real
/// CommunityToolkit.Mvvm output — that generator emits
/// `partial void OnXChanging/OnXChanged(...)` hooks (declaration only)
/// plus statement-position calls to them.
///
/// Classification (via `IMethodSymbol.IsPartialDefinition` /
/// `PartialImplementationPart` / `PartialDefinitionPart`):
/// 1. An UNIMPLEMENTED partial method (definition with no implementation) elides both its declaration
/// AND every call site (a deletable partial method is necessarily `void`, has no `out` params, and is
/// only invoked in statement position). G# rejects a lone declaring part (GS0609), so this holds in
/// both modes.
/// 2. An IMPLEMENTED pair, in the default preserve-partial-parts mode, whose two parts are both
/// hand-authored source this run translates and whose shape G# can spell, becomes a G# `partial func`
/// declaring part plus implementing part, each in the G# partial type part of its own C# file.
/// 3. Every other IMPLEMENTED pair (legacy merge mode, a part in a generated/dropped document, an
/// extension method, differing parameter names, ...) translates ONLY the implementation part, as an
/// ordinary method — the defining part is skipped so the member is emitted exactly once.
open class Adr0143PartialMethodTests {
    @Fact
    func UnimplementedPartialMethod_MvvmShaped_ElidesDeclarationAndCallSite() {
        // The MVVM shape: a generator-style `partial void OnNameChanged(...)`
        // hook DECLARED but never implemented, invoked in statement position
        // from a setter-like method.
        let printed = TranslateSingle(preservePartialParts: false, ("VM.cs", `
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
}`))
        // Declaration elided: no `OnNameChanged` member survives.
        Assert.DoesNotContain("OnNameChanged", printed)
        // The rest of the class translates: the field and the setter body's
        // real assignment are preserved.
        Assert.Contains("class VM", printed)
        Assert.Contains("func SetName(", printed)
        Assert.Contains("_name = value", printed)
    }

    @Fact
    func ImplementedPartialMethod_DefiningPlusImplementingPair_EmitsSingleImplementation() {
        // Defining part in one declaration, implementing part in another
        // (partial-TYPE merge, issue #1910). Only the implementation must be
        // emitted — exactly one `OnReady` func with its body — and the call
        // site (which resolves to an implemented partial method) is preserved.
        let printed = TranslateSingle(preservePartialParts: false, ("VM.cs", `
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
}`))
        // Emitted exactly once (the defining part is skipped, not duplicated).
        Assert.Equal(1, CountOccurrences(printed, "func OnReady("))
        // The single surviving `OnReady` carries the IMPLEMENTATION's body.
        Assert.Contains("DoWork()", printed)
        // The call site to an IMPLEMENTED partial method is preserved: the
        // single func declaration (`func OnReady()`) plus the surviving call
        // (`OnReady()` in Init) give two `OnReady()` occurrences in all.
        Assert.Contains("func Init(", printed)
        Assert.Equal(2, CountOccurrences(printed, "OnReady()"))
    }

    @Fact
    func UserImplementedHook_GeneratorDeclaresDefinitionUserWritesImplementation_KeepsImplementation() {
        // ADR-0143 corpus case: the "generated" document declares the partial
        // hook; the user's own document supplies the implementation. Split
        // across two files (two partial parts of the same type).
        let printed = TranslateFiles(preservePartialParts: false, ("VM.Generated.cs", `
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);
    }
}`), ("VM.cs", `
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
}`))
        let combined = string.Join(`
---
`, printed)
        // The user-written implementation is kept, exactly once, with its body.
        Assert.Equal(1, CountOccurrences(combined, "func OnConfigured("))
        Assert.Contains("_seen = value", combined)
    }

    @Fact
    func OrdinaryVoidMethod_NonPartial_IsUnaffected() {
        // Control: a plain (non-partial) void method with a body and its
        // statement-position call are both preserved unchanged.
        let printed = TranslateSingle(preservePartialParts: false, ("VM.cs", `
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
}`))
        Assert.Equal(1, CountOccurrences(printed, "func OnTick("))
        Assert.Contains("func Run(", printed)
        // The func declaration (`func OnTick()`) plus its preserved call
        // (`OnTick()` in Run) give two `OnTick()` occurrences in all.
        Assert.Equal(2, CountOccurrences(printed, "OnTick()"))
    }

    @Fact
    func UnimplementedPartialMethod_InPreserveMode_AlsoElidesDeclarationAndCallSite() {
        // The same erasure applies in the source-generator host's
        // preserve-partial-parts mode — it is correct handling of a construct
        // G# cannot express, not migration-mode-specific.
        let printed = TranslateSingle(preservePartialParts: true, ("VM.g.cs", `
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
}`))
        Assert.DoesNotContain("OnNameChanged", printed)
        Assert.Contains("partial class VM", printed)
        Assert.Contains("_name = value", printed)
    }

    @Fact
    func ImplementedPair_PreserveMode_SplitAcrossFiles_EmitsDeclaringAndImplementingParts() {
        // ADR-0192: each C# part becomes a G# `partial func` part in the G#
        // partial type part of its OWN file — the declaring part (`;` no-body
        // marker) where the C# definition is, the implementing part (with
        // the body) where the C# implementation is.
        let printed = TranslateFiles(preservePartialParts: true, ("VM.Hooks.cs", `
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
}`), ("VM.cs", `
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
}`))
        Assert.Equal(2, printed.Count)
        let declaring = printed[0]
        let implementing = printed[1]
        Assert.Contains("partial class VM", declaring)
        Assert.Contains("private partial func OnConfigured(value int32);", declaring)
        Assert.Contains("OnConfigured(value)", declaring)
        Assert.DoesNotContain("_seen = value", declaring)
        Assert.Contains("partial class VM", implementing)
        Assert.Contains("private partial func OnConfigured(value int32) {", implementing)
        Assert.Contains("_seen = value", implementing)
        Assert.Equal(1, CountOccurrences(implementing, "func OnConfigured("))
    }

    @Theory
    @InlineData("record", "data class")
    @InlineData("record struct", "data struct")
    func ImplementedPair_PreserveMode_RecordOwner_EmitsBothPartialParts(csharpKind string, gsharpKind string) {
        let printed = TranslateSingle(preservePartialParts: true, ("Value.cs", `
namespace Demo
{
    public partial ` + csharpKind + ` Value(int Number)
    {
        partial void OnReady();

        partial void OnReady()
        {
        }
    }
}`))
        Assert.Contains("partial " + gsharpKind + " Value", printed)
        Assert.Contains("private partial func OnReady();", printed)
        Assert.Contains("private partial func OnReady() {", printed)
        Assert.Equal(2, CountOccurrences(printed, "partial func OnReady("))
    }

    @Fact
    func ImplementedPair_PreserveMode_SameFile_EmitsBothPartsInOnePartialType() {
        // A single `partial class` may carry both parts itself (C# allows
        // it, and so does G#, ADR-0192 §G).
        let printed = TranslateSingle(preservePartialParts: true, ("VM.cs", `
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
}`))
        Assert.Contains("private partial func OnReady();", printed)
        Assert.Contains("private partial func OnReady() {", printed)
        Assert.Equal(2, CountOccurrences(printed, "partial func OnReady("))
    }

    @Fact
    func ImplementedPair_PreserveMode_Static_EmitsBothPartsAsSharedClassParts() {
        let printed = TranslateFiles(preservePartialParts: true, ("Math.Decl.cs", `
namespace Demo
{
    public static partial class Calc
    {
        public static partial int Twice(int x);
    }
}`), ("Math.Impl.cs", `
namespace Demo
{
    public static partial class Calc
    {
        public static partial int Twice(int x) => x * 2;
    }
}`))
        // ADR-0195: every part of a partial static class is a `shared partial class`
        // with its members flat (no `shared { }` block).
        Assert.Contains("shared partial class Calc", printed[0])
        Assert.DoesNotContain("shared {", printed[0])
        Assert.Contains("partial func Twice(x int32) int32;", printed[0])
        Assert.Contains("shared partial class Calc", printed[1])
        Assert.DoesNotContain("shared {", printed[1])
        Assert.Contains("partial func Twice(x int32) int32 -> x * 2", printed[1])
    }

    @Fact
    func ImplementedPair_PreserveMode_AsyncImplementation_EmitsAsyncOnBothParts() {
        // C# lets only the implementing part say `async`; G# requires it on
        // both (ADR-0192 §D) — so the declaring part is built from the
        // implementation's signature, not the definition's.
        let printed = TranslateFiles(preservePartialParts: true, ("Loader.Decl.cs", `
using System.Threading.Tasks;

namespace Demo
{
    public partial class Loader
    {
        public partial Task<int> LoadAsync(int id);
    }
}`), ("Loader.Impl.cs", `
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
}`))
        Assert.Contains("async partial func LoadAsync(id int32) int32;", printed[0])
        Assert.Contains("async partial func LoadAsync(id int32) int32 {", printed[1])
    }

    @Fact
    func ImplementedPair_PreserveMode_DefinitionOnlyAttribute_IsPreservedOnDeclaringPart() {
        // Before ADR-0192 an attribute written only on the C# definition was
        // silently lost (only the implementation translated). Each G# part
        // now carries its own method-level attributes; gsc unions them.
        let printed = TranslateFiles(preservePartialParts: true, ("Api.Decl.cs", `
using System;

namespace Demo
{
    public partial class Api
    {
        [Obsolete("use V2")]
        public partial void Call();
    }
}`), ("Api.Impl.cs", `
using System;

namespace Demo
{
    public partial class Api
    {
        public partial void Call()
        {
        }
    }
}`))
        Assert.Contains("@Obsolete(\"use V2\")", printed[0])
        Assert.Contains("partial func Call();", printed[0])
        Assert.DoesNotContain("Obsolete", printed[1])
        Assert.Contains("partial func Call() {", printed[1])
    }

    @Fact
    func ImplementedPair_PreserveMode_DefinitionDefaultValue_IsEmittedOnBothParts() {
        // C# puts the default on the definition (the implementation's is
        // ignored, CS1066); G# requires identical defaults on both parts.
        let printed = TranslateFiles(preservePartialParts: true, ("Api.Decl.cs", `
namespace Demo
{
    public partial class Api
    {
        public partial int Scale(int value, int factor = 3);

        public int Use() => Scale(2);
    }
}`), ("Api.Impl.cs", `
namespace Demo
{
    public partial class Api
    {
        public partial int Scale(int value, int factor)
        {
            return value * factor;
        }
    }
}`))
        Assert.Contains("partial func Scale(value int32, factor int32 = 3) int32;", printed[0])
        Assert.Contains("partial func Scale(value int32, factor int32 = 3) int32 {", printed[1])
        Assert.Equal(2, CountOccurrences(string.Join("\n", printed), "factor int32 = 3"))
    }

    @Fact
    func ImplementedPair_DemotedForDifferentImports_InheritsDefaultInImplementationScope() {
        let printed = TranslateFiles(preservePartialParts: true, ("DefaultChoice.cs", `
namespace Defaults
{
    public enum Choice
    {
        First,
    }
}`), ("OtherChoice.cs", `
namespace Other
{
    public enum Choice
    {
        Second,
    }
}`), ("Api.Decl.cs", `
using Defaults;

namespace Demo
{
    public partial class Api
    {
        partial void Select(int value, Choice choice = Choice.First);

        public void Use() => Select(1);
    }
}`), ("Api.Impl.cs", `
using Other;

namespace Demo
{
    public partial class Api
    {
        partial void Select(int value, Defaults.Choice selected)
        {
        }

        public Choice OtherChoice() => Choice.Second;
    }
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func Select(", combined)
        Assert.Equal(1, CountOccurrences(combined, "func Select("))
        Assert.Contains("func Select(value int32, selected Defaults.Choice = Defaults.Choice.First)", combined)
        Assert.Contains("Select(1)", combined)
    }

    @Fact
    func ImplementedPair_PreserveMode_SameFileParameterAttributeOnOnePart_IsUnionedOntoBothParts() {
        // C# unions parameter attributes across the parts; G# requires the
        // same annotations on both parts, so both get the union. Both parts
        // are in one file (one type mapper), so the union cannot move an
        // attribute into another file.
        let printed = TranslateFiles(preservePartialParts: true, ("Note.cs", NoteAttributeSource), ("Api.cs", `
namespace Demo
{
    public partial class Api
    {
        public partial void Log([Note] string message);

        public partial void Log(string message)
        {
        }
    }
}`))
        Assert.Contains("partial func Log(@Note message string);", printed[1])
        Assert.Contains("partial func Log(@Note message string) {", printed[1])
    }

    @Fact
    func ImplementedPair_CrossFileParameterAttribute_KeepsSingleImplementation() {
        // Across files, the union would copy one file's attribute into the
        // other file, where it can resolve differently or add an import that
        // breaks that file (a leak the post-pass cannot see), so a cross-file
        // pair with any parameter attribute keeps the pre-ADR-0192 shape.
        let printed = TranslateFiles(preservePartialParts: true, ("Note.cs", NoteAttributeSource), ("Api.Decl.cs", `
namespace Demo
{
    public partial class Api
    {
        public partial void Log([Note] string message);
    }
}`), ("Api.Impl.cs", `
namespace Demo
{
    public partial class Api
    {
        public partial void Log(string message)
        {
        }
    }
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func Log("))
    }

    @Fact
    func ImplementedPair_ParameterAttributeResolvingDifferentlyPerFile_KeepsSingleImplementation() {
        // Review repro: `Tag` names N1.TagAttribute in the definition's file
        // and N2.TagAttribute in the implementation's. Unioning the
        // definition's `@Tag` onto the implementing part dragged `import N1`
        // into its file, breaking that file's own `@Tag` (N2).
        let printed = TranslateFiles(preservePartialParts: true, ("N1.cs", `
using System;

namespace N1
{
    public sealed class TagAttribute : Attribute
    {
    }
}`), ("N2.cs", `
using System;

namespace N2
{
    public sealed class TagAttribute : Attribute
    {
    }

    public class Other
    {
    }
}`), ("Decl.cs", `
using N1;

namespace Demo
{
    public partial class A
    {
        partial void M([Tag] int x);
    }
}`), ("Impl.cs", `
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
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func M("))
        Assert.DoesNotContain("import N1", printed[3])
    }

    @Fact
    func ImplementedPair_TypeSpelledDifferentlyPerFile_KeepsSingleImplementation() {
        // Review repro: `Timer` is ambiguous (System.Threading vs
        // System.Timers) only in the definition's file, so the two G# files
        // would spell the parameter type differently (an alias in one, the
        // bare name in the other) — gsc compares the parts as text (GS0611).
        let printed = TranslateFiles(preservePartialParts: true, ("Decl.cs", `
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
}`), ("Impl.cs", `
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t)
        {
        }
    }
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func M("))
    }

    @Fact
    func ImplementedPair_ConstraintType_IsSpelledInDefinitionFilesScope() {
        // PR #4360 review: the declaring part's type-parameter constraint is
        // mapped at the DEFINITION's location, as its parameter types are.
        // Only the definition's file sees the source type MyLib.Stream, so the
        // metadata constraint System.IO.Stream must not be spelled bare there.
        // The emitted pair must spell it the same way in both files and bind.
        let printed = TranslateFiles(preservePartialParts: true, ("MyLib.cs", `
namespace MyLib
{
    public class Stream
    {
    }

    public class Gadget
    {
    }
}`), ("Decl.cs", `
using System.IO;
using MyLib;

namespace Demo
{
    public partial class A
    {
        partial void M<T>(T item) where T : System.IO.Stream;

        public void Use(Gadget g)
        {
        }
    }
}`), ("Impl.cs", `
using System.IO;

namespace Demo
{
    public partial class A
    {
        partial void M<T>(T item) where T : Stream
        {
        }
    }
}`))
        Assert.Contains("private partial func M[T IOStream](item T);", printed[1])
        Assert.Contains("private partial func M[T IOStream](item T) {", printed[2])
    }

    @Fact
    func ImplementedPair_CrossFileIterator_EmitsMatchingParts() {
        // The iterator check reads the IMPLEMENTATION's body, so the
        // declaring part in the other file must still spell the same return
        // type as the implementing part.
        let printed = TranslateFiles(preservePartialParts: true, ("Decl.cs", `
using System.Collections.Generic;

namespace Demo
{
    public partial class A
    {
        private partial IEnumerable<int> Items();
    }
}`), ("Impl.cs", `
using System.Collections.Generic;

namespace Demo
{
    public partial class A
    {
        private partial IEnumerable<int> Items()
        {
            yield return 1;
        }
    }
}`))
        AssertMatchingPair(printed[0], printed[1], "Items")
    }

    @Fact
    func ImplementedPair_CrossFileAsyncValueTask_EmitsMatchingParts() {
        // `async` and the ValueTask unwrapping are implementation-only facts;
        // the declaring part in the other file must carry the same ones.
        let printed = TranslateFiles(preservePartialParts: true, ("Decl.cs", `
using System.Threading.Tasks;

namespace Demo
{
    public partial class A
    {
        private partial ValueTask<int> GetAsync();
    }
}`), ("Impl.cs", `
using System.Threading.Tasks;

namespace Demo
{
    public partial class A
    {
        private async partial ValueTask<int> GetAsync()
        {
            await Task.Yield();
            return 1;
        }
    }
}`))
        AssertMatchingPair(printed[0], printed[1], "GetAsync")
    }

    @Fact
    func DemotedPair_ReTranslatedFilesWithAnonymousTypes_DeclareEachShapeOnce() {
        // Demotion re-translates both files; an anonymous-type shape used in
        // both must still be declared exactly once, by the file that first
        // declared it.
        let printed = TranslateFiles(preservePartialParts: true, ("Decl.cs", `
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t);

        public void Use(System.Timers.Timer x, System.Timers.ElapsedEventArgs e)
        {
        }

        public int First()
        {
            var p = new { Name = "a", Count = 1 };
            return p.Count;
        }
    }
}`), ("Impl.cs", `
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t)
        {
        }

        public int Second()
        {
            var q = new { Name = "b", Count = 2 };
            return q.Count;
        }
    }
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func M("))
        Assert.Equal(1, CountOccurrences(combined, "data class "))
    }

    @Fact
    func ImplementedPair_SameUsingsAcrossFiles_EmitsPairEvenWhenTypeNeedsAlias() {
        // Positive control for the using-scope rule: both files import both
        // namespaces, so `Timer` is ambiguous in both and both G# files spell
        // it the same (aliased) way.
        let printed = TranslateFiles(preservePartialParts: true, ("Decl.cs", `
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
}`), ("Impl.cs", `
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
}`))
        Assert.Contains("private partial func M(t ThreadingTimer);", printed[0])
        Assert.Contains("private partial func M(t ThreadingTimer) {", printed[1])
        var declaringHeader = printed[0].Substring(
            printed[0].IndexOf("private partial func M(", StringComparison.Ordinal)
        )
        declaringHeader = declaringHeader.Substring(0, declaringHeader.IndexOf(';'))
        Assert.Contains(declaringHeader + " {", printed[1])
    }

    @Fact
    func ImplementedPair_DifferingParameterNames_KeepsSingleImplementation() {
        // C# only warns (CS8826) on differing parameter names; G# cannot
        // spell that pair (GS0611), so the pre-ADR-0192 shape is kept.
        let printed = TranslateFiles(preservePartialParts: true, ("VM.Decl.cs", `
namespace Demo
{
    public partial class VM
    {
        partial void OnSet(int value = 5);

        public void Set() => OnSet();
    }
}`), ("VM.Impl.cs", `
namespace Demo
{
    public partial class VM
    {
        private int _last;

        partial void OnSet(int newValue)
        {
            _last = newValue;
        }
    }
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func OnSet("))
        Assert.Contains("func OnSet(newValue int32 = 5)", combined)
        Assert.Contains("OnSet()", combined)
    }

    @Fact
    func ImplementedPair_ExtensionMethod_KeepsSingleImplementation() {
        // cs2gs lowers a C# extension method to a receiver-clause func, which
        // G# rejects as partial (GS0607) — so the pre-ADR-0192 shape is kept.
        let printed = TranslateFiles(preservePartialParts: true, ("Ext.Decl.cs", `
namespace Demo
{
    public static partial class TextExtensions
    {
        public static partial string Shout(this string text, string suffix = "!");
    }
}`), ("Ext.Impl.cs", `
namespace Demo
{
    public static partial class TextExtensions
    {
        public static partial string Shout(this string text, string suffix) => text + suffix;

        public static string Use(string text) => text.Shout();
    }
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(2, CountOccurrences(combined, "Shout("))
        Assert.Contains("Shout(suffix string = \"!\")", combined)
        Assert.Contains("text.Shout()", combined)
    }

    @Fact
    func ImplementedPair_LegacyMergeMode_KeepsSingleImplementation() {
        // Legacy issue #1910 merge produces one NON-partial G# type, where a
        // `partial func` would be GS0608.
        let printed = TranslateFiles(preservePartialParts: false, ("VM.Decl.cs", `
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value = 5);
    }
}`), ("VM.Impl.cs", `
namespace Demo
{
    public partial class VM
    {
        private int _seen;

        partial void OnConfigured(int value)
        {
            _seen = value;
        }

        public void Configure() => OnConfigured();
    }
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func OnConfigured("))
        Assert.Contains("func OnConfigured(value int32 = 5)", combined)
        Assert.Contains("OnConfigured()", combined)
        Assert.Contains("_seen = value", combined)
    }

    @Fact
    func ImplementedPair_PreserveMode_DefinitionInAutoGeneratedDocument_KeepsSingleImplementation() {
        // The MVVM shape: a GENERATED document declares the hook and the user
        // implements it. cs2gs drops the `<auto-generated>` document (the
        // loader never hands it to the translator — gsgen regenerates it at
        // build, ADR-0145), so emitting the implementation as `partial func`
        // would leave it with no declaring part (GS0610). Only the
        // implementation translates, as an ordinary method.
        let printed = TranslateFiles(preservePartialParts: true, ("VM.g.cs", `// <auto-generated/>
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);
    }
}`), ("VM.cs", `
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
}`))
        // The generated document was dropped by the loader.
        let translated = Assert.Single(printed)
        Assert.DoesNotContain("partial func", translated)
        Assert.Equal(1, CountOccurrences(translated, "func OnConfigured("))
        Assert.Contains("func OnConfigured(value int32) {", translated)
        Assert.Contains("_seen = value", translated)
    }

    @Fact
    func ImplementedPair_PreserveMode_DefinitionOutsideRetainedFiles_KeepsSingleImplementation() {
        // A project with generator references (issue #2215): the caller's
        // retained-file set excludes generator output, which need not carry
        // an `<auto-generated>` header. A part outside that set is treated
        // exactly like a dropped generated part.
        let printed = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: []string{"VM.cs"},
            ("Generated/VM.Hooks.cs", `
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);
    }
}`),
            ("VM.cs", `
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
}`)
        )
        let translated = Assert.Single(printed)
        Assert.DoesNotContain("partial func", translated)
        Assert.Equal(1, CountOccurrences(translated, "func OnConfigured("))
    }

    @Fact
    func ImplementedPair_PreserveMode_DefinitionUnderObjDirectory_KeepsSingleImplementation() {
        // The loader also drops a file under the project's obj/bin directory
        // even without an <auto-generated> header; the translator applies the
        // same rule (GeneratedSourceDetection) when it knows the project
        // directory.
        let printed = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: nil,
            projectDirectory: "/src/App",
            ("/src/App/obj/Debug/VM.Hooks.cs", `
namespace Demo
{
    public partial class VM
    {
        partial void OnConfigured(int value);
    }
}`),
            ("/src/App/VM.cs", `
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
}`)
        )
        let translated = Assert.Single(printed)
        Assert.DoesNotContain("partial func", translated)
        Assert.Equal(1, CountOccurrences(translated, "func OnConfigured("))
    }

    @Fact
    func ImplementedPair_QualifiedParameterAttributeUnderSameUsings_KeepsSingleImplementation() {
        // Review repro: both files see only `using N2;`, but the definition
        // writes `[N1.Tag]`. Unioning it onto the implementing part added
        // `import N1` to that file, where `@Tag` on `Use` then stopped binding.
        let printed = TranslateFiles(preservePartialParts: true, ("N1.cs", `
using System;

namespace N1
{
    public sealed class TagAttribute : Attribute
    {
    }
}`), ("N2.cs", `
using System;

namespace N2
{
    public sealed class TagAttribute : Attribute
    {
    }

    public class Other
    {
    }
}`), ("Decl.cs", `
using N2;

namespace Demo
{
    public partial class A
    {
        partial void M([N1.Tag] int x);
    }
}`), ("Impl.cs", `
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
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func M("))
        Assert.DoesNotContain("import N1", printed[3])
    }

    @Fact
    func ImplementedPair_QualifiedMemberElsewhereInDefinitionFile_IsDemotedByReconciliation() {
        // Review repro: identical usings, but a qualified System.Timers.Timer
        // elsewhere in the DEFINITION's file makes that file's pre-scan alias
        // `Timer` (ThreadingTimer), while the implementation's file prints the
        // bare `Timer`. Only the post-translation comparison can see that; it
        // demotes the pair to the single-implementation shape.
        let printed = TranslateFiles(
            preservePartialParts: true,
            ("Decl.cs", TimerDefinitionWithQualifiedSibling),
            ("Impl.cs", TimerImplementation)
        )
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func M("))
    }

    @Fact
    func ImplementedPair_QualifiedMemberElsewhereInImplementationFile_IsDemotedByReconciliation() {
        // Mirror of the previous test: the qualified sibling is in the
        // implementation's file.
        let printed = TranslateFiles(preservePartialParts: true, ("Decl.cs", `
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t);
    }
}`), ("Impl.cs", `
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
}`))
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func", combined)
        Assert.Equal(1, CountOccurrences(combined, "func M("))
    }

    @Fact
    func DemotedPair_DefinitionFileOutput_EqualsTranslationWithoutPairs() {
        // A demoted pair's declaring part was already spelled into its file
        // (which may have recorded imports/aliases) before the post-pass
        // removed it. The definition file must still come out exactly as it
        // does with pairs disabled (the pre-ADR-0192 output).
        let files[](FileName string, Source string) = [](FileName string, Source string){
            ("Decl.cs", TimerDefinitionWithQualifiedSibling),
            ("Impl.cs", TimerImplementation)
        }
        let demoted = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: nil,
            projectDirectory: nil,
            emitPartialMethodPairs: true,
            files
        )
        let withoutPairs = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: nil,
            projectDirectory: nil,
            emitPartialMethodPairs: false,
            files
        )
        for var i = 0; i < withoutPairs.Count; i++ {
            Assert.True(withoutPairs[i] == demoted[i], (`File ` + "$i" + ` differs.
--- without pairs ---
` + "${withoutPairs[i]}" + `
--- demoted ---
` + "${demoted[i]}"))
        }
    }

    @Fact
    func ImplementedPair_WithoutEmitPartialMethodPairsOption_KeepsSingleImplementation() {
        // Pairs are opt-in: a caller that does not run the reconciliation
        // post-pass (TestParityStage, SnippetTranslator, gsgen, direct
        // translation) keeps today's output even for a pair that would
        // otherwise be emitted.
        let printed = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: nil,
            projectDirectory: nil,
            emitPartialMethodPairs: false,
            ("VM.cs", `
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
}`)
        )
        let translated = Assert.Single(printed)
        Assert.DoesNotContain("partial func", translated)
        Assert.Equal(1, CountOccurrences(translated, "func OnReady("))
    }

    @Fact
    func TwoPairsInOneFile_OneKeptOneDemoted() {
        // The implementation's file aliases `Timer` (a qualified
        // System.Timers.Timer sibling), so M's parts spell differently and M
        // is demoted; K's parts agree and K stays a pair. Re-translating the
        // units for M must neither lose K nor leave M's alias behind.
        let files[](FileName string, Source string) = [](FileName string, Source string){("Decl.cs", `
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t);

        partial void K(int x);
    }
}`), ("Impl.cs", `
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t)
        {
        }

        partial void K(int x)
        {
        }

        public void Use(System.Timers.Timer x, System.Timers.ElapsedEventArgs e)
        {
        }
    }
}`)}
        let printed = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: nil,
            projectDirectory: nil,
            emitPartialMethodPairs: true,
            files
        )
        let withoutPairs = TranslateFiles(
            preservePartialParts: true,
            retainedFilePaths: nil,
            projectDirectory: nil,
            emitPartialMethodPairs: false,
            files
        )
        Assert.Contains("private partial func K(x int32);", printed[0])
        Assert.Contains("private partial func K(x int32) {", printed[1])
        let combined = string.Join(`
---
`, printed)
        Assert.DoesNotContain("partial func M(", combined)
        Assert.Equal(1, CountOccurrences(combined, "func M("))
        for var i = 0; i < printed.Count; i++ {
            Assert.Equal(ImportLines(withoutPairs[i]), ImportLines(printed[i]))
        }
    }

    shared {
        private func ImportLines(printed string) string -> string.Join(
            "\n",
            printed.Split('\n').Where((line string) -> line.StartsWith("import ", StringComparison.Ordinal))
        )

        private const TimerDefinitionWithQualifiedSibling string = `
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
}`

        private const TimerImplementation string = `
using System.Threading;

namespace Demo
{
    public partial class A
    {
        partial void M(Timer t)
        {
        }
    }
}`

        private const NoteAttributeSource string = `
using System;

namespace Demo
{
    [AttributeUsage(AttributeTargets.Parameter)]
    public sealed class NoteAttribute : Attribute
    {
    }
}`

        private func TranslateSingle(preservePartialParts bool, file(FileName string, Source string)) string {
            return TranslateFiles(preservePartialParts, file).Single()
        }

        private func TranslateFiles(preservePartialParts bool, files ...(FileName string, Source string)) IReadOnlyList[
            string
        ] -> TranslateFiles(preservePartialParts, retainedFilePaths: nil, files)

        private func TranslateFiles(
            preservePartialParts bool,
            retainedFilePaths IReadOnlyCollection[string]?,
            files ...(FileName string, Source string)
        ) IReadOnlyList[string] -> TranslateFiles(preservePartialParts, retainedFilePaths, projectDirectory: nil, files)

        private func TranslateFiles(
            preservePartialParts bool,
            retainedFilePaths IReadOnlyCollection[string]?,
            projectDirectory string?,
            files ...(FileName string, Source string)
        ) IReadOnlyList[string] -> TranslateFiles(
            preservePartialParts,
            retainedFilePaths,
            projectDirectory,
            emitPartialMethodPairs: true,
            files
        )

        // Translates every file, then (with emitPartialMethodPairs, as
        // TranslateStage does) reconciles the tentative partial method pairs
        // across ALL units before printing any of them.
        private func TranslateFiles(
            preservePartialParts bool,
            retainedFilePaths IReadOnlyCollection[string]?,
            projectDirectory string?,
            emitPartialMethodPairs bool,
            files ...(FileName string, Source string)
        ) IReadOnlyList[string] {
            let project = CSharpProjectLoader.LoadInMemory(files)
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            // Mirror the loader: a file under the project's obj/bin directory is
            // never translated (LoadInMemory has no project directory to apply
            // that rule itself).
            let documents = project
                .Documents
                .Where(
                (document LoadedDocument) -> (
                    retainedFilePaths == nil || retainedFilePaths.Contains(document.FilePath)
                ) &&
                    !GeneratedSourceDetection.IsUnderBuildOutputDirectory(document.FilePath, projectDirectory)
            )
                .ToList()
            // One translator for the whole project, as TranslateStage uses, and
            // the same translate/reconcile/re-translate loop.
            let translator = CSharpToGSharpTranslator(
                preservePartialParts,
                retainedFilePaths: retainedFilePaths,
                projectDirectory: projectDirectory,
                emitPartialMethodPairs: emitPartialMethodPairs
            )
            let reconciled = PartialMethodPairReconciler.TranslateUntilStable(
                documents.Count,
                (index int32, suppressedPartialPairKeys IReadOnlyCollection[string]) -> translator.TranslateDocument(
                    documents[index],
                    TranslationContext(project.Compilation, documents[index].SemanticModel, documents[index].FilePath),
                    suppressedPartialPairKeys
                )
            )
            let printedFiles = reconciled.Select(GSharpPrinter.Print).ToList()
            // Bind every translated file TOGETHER: an ADR-0192 partial method's
            // two parts may live in different files, and a file bound alone
            // would report its lone part (GS0609/GS0610).
            TranslationTestValidation.AssertBinds(printedFiles.ToArray())
            return printedFiles
        }

        // Asserts the declaring part (in `declaringFile`) and the implementing part
        // (in `implementingFile`) of `name` were both emitted with identical headers.
        private func AssertMatchingPair(declaringFile string, implementingFile string, name string) {
            let marker = "partial func " + name + "("
            let declaringStart = declaringFile.IndexOf(marker, StringComparison.Ordinal)
            Assert.True(declaringStart >= 0, declaringFile)
            let lineStart = declaringFile.LastIndexOf('\n', declaringStart) + 1
            let header = declaringFile.Substring(lineStart, declaringFile.IndexOf(';', declaringStart) - lineStart)
                .Trim()
            Assert.Contains(header + " {", implementingFile)
        }

        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            var index = 0
            while (index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0 {
                count++
                index += needle.Length
            }
            return count
        }
    }
}
