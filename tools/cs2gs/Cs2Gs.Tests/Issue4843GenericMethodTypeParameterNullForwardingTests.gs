// <copyright file="Issue4843GenericMethodTypeParameterNullForwardingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Text.RegularExpressions
import Xunit

/// Issue #4843: a parameter promoted to `T?` because its caller passes
/// `null`, then forwarded to an imported generic METHOD whose parameter
/// is declared as a method type parameter
/// (`DecodeSignature<TType, TGenericContext>(provider, TGenericContext)`),
/// must not be bridged with a runtime `!!`: gsc infers that type argument
/// from the argument, and the assertion turned a legal C# call into a
/// NullReferenceException (migrated test/Core.Tests CorePublicApiSnapshotTests).
open class Issue4843GenericMethodTypeParameterNullForwardingTests {
    @Fact
    func Oblivious_NullForwardedToImportedMethodTypeParameter_IsNotAsserted() {
        let printed = TranslateOblivious(`
using System.Reflection.Metadata;
namespace Demo
{
    public class P : ISignatureTypeProvider<string, object>
    {
        public string Describe(MetadataReader r, TypeSpecificationHandle h) => GetTypeFromSpecification(r, null, h, 0);
        public string GetTypeFromSpecification(MetadataReader reader, object genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
        public string GetPrimitiveType(PrimitiveTypeCode t) => "";
        public string GetGenericTypeParameter(object c, int i) => "";
        public string GetGenericMethodParameter(object c, int i) => "";
        public string GetTypeFromDefinition(MetadataReader r, TypeDefinitionHandle h, byte k) => "";
        public string GetTypeFromReference(MetadataReader r, TypeReferenceHandle h, byte k) => "";
        public string GetGenericInstantiation(string g, System.Collections.Immutable.ImmutableArray<string> a) => "";
        public string GetArrayType(string e, ArrayShape s) => "";
        public string GetByReferenceType(string e) => "";
        public string GetPointerType(string e) => "";
        public string GetSZArrayType(string e) => "";
        public string GetFunctionPointerType(MethodSignature<string> s) => "";
        public string GetModifiedType(string m, string u, bool b) => "";
        public string GetPinnedType(string e) => "";
    }
}`)
        let flat = Regex.Replace(printed, "\\s+", " ")
        Assert.Contains("genericContext object?", flat, StringComparison.Ordinal)
        Assert.True(flat.Contains("DecodeSignature(this, genericContext)"), flat)
        Assert.DoesNotContain("genericContext!!", flat, StringComparison.Ordinal)
    }

    @Fact
    func Oblivious_NullForwardedToClassTypeParameterTarget_StillAsserted() {
        let printed = TranslateOblivious(`
using System;
using System.Collections.Generic;
namespace Demo
{
    public class C
    {
        private readonly List<string> items = new List<string>();
        public void Run() => Add(null);
        public void Add(string s) => items.Add(s);
        public int Count => items.Count;
    }
}`)
        // Control: a CLASS type parameter is fixed by the receiver before the
        // argument is seen, so the existing bridge (or equivalent widening)
        // must be untouched by the method-type-parameter exemption.
        Assert.True(printed.Contains("items.Add(s!!)") || printed.Contains("List[string?]"), printed)
    }

    @Fact
    func Oblivious_NullForwardedToImportedMethodTypeParameter_KeepsBridgeOnlyWhenConstrained() {
        // `Accept<T>(T) where T : class` rejects a nullable inferred type
        // argument, so its bridge must stay; the unconstrained, result-free
        // `Free<T>(T)` is the exempt shape.
        let tree = CSharpSyntaxTree.ParseText(
            "namespace Lib { public static class Sink { public static void Accept<T>(T value) where T : class { } public static void Free<T>(T value) { } } }"
        )
        let compilation = CSharpCompilation.Create(
            "Issue4843.Lib",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        using let stream = MemoryStream()
        let emitted = compilation.Emit(stream)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let reference = MetadataReference.CreateFromImage(stream.ToArray())
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
using Lib;
namespace Demo
{
    public class C
    {
        public void Run() => Both(null);
        public void Both(string s) { Sink.Accept(s); Sink.Free(s); }
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Sink.Accept(s!!)", printed, StringComparison.Ordinal)
        Assert.Contains("Sink.Free(s)", printed, StringComparison.Ordinal)
    }

    @Fact
    func Oblivious_NullForwardedToImportedParamsMethodTypeParameter_KeepsBridgeOnlyWhenConstrained() {
        // Issue #4857: an expanded `params T[]` call to an imported, oblivious,
        // result-free generic method (`Sink.Free<T>(params T[] values)`) must
        // extract the params element type `T` and omit the runtime `!!` bridge,
        // while a constrained `Sink.Accept<T>(params T[] values) where T : class`
        // keeps its bridge.
        let tree = CSharpSyntaxTree.ParseText(
            "namespace Lib { public static class Sink { public static void Accept<T>(params T[] values) where T : class { } public static void Free<T>(params T[] values) { } } }"
        )
        let compilation = CSharpCompilation.Create(
            "Issue4857.Lib",
            []SyntaxTree{tree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        using let stream = MemoryStream()
        let emitted = compilation.Emit(stream)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let reference = MetadataReference.CreateFromImage(stream.ToArray())
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Snippet.cs", `
using Lib;
namespace Demo
{
    public class C
    {
        public void Run() => Both(null);
        public void Both(string s) { Sink.Accept(s); Sink.Free(s); }
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        Assert.Contains("Sink.Accept(s!!)", printed, StringComparison.Ordinal)
        Assert.Contains("Sink.Free(s)", printed, StringComparison.Ordinal)
    }

    @Fact
    func BarePrintedMetadataType_PinnedWithAliasImportWhenSynthesizedImportIntroducesHomonym() {
        // Issue #4602: `Runner.cs` prints `System.Threading.Timer` bare because
        // `CollectImportedNamespaceNames` sees only `System.Threading` and `Demo`.
        // Target-typed `new("desc")` (`ImplicitObjectCreationExpressionSyntax`) has
        // no `NameSyntax` node in `Runner.cs`, so `System.Timers` enters
        // `ShortenedNamespaces` only when `TranslateImplicitObjectCreation` maps
        // `System.Timers.TimersDescriptionAttribute`. Because `System.Timers` also
        // exports `System.Timers.Timer`, import assembly must emit
        // `import Timer = System.Threading.Timer` so gsc does not reject the bare
        // `Timer` with GS0547.
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Helper.cs", `
namespace Demo
{
    public static class Helper
    {
        public static void Use(System.Timers.TimersDescriptionAttribute attr) { }
    }
}`), ("Runner.cs", `
using System.Threading;
namespace Demo
{
    public class Runner
    {
        public Timer Check(Timer timer)
        {
            Helper.Use(new("desc"));
            return timer;
        }
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let translator = CSharpToGSharpTranslator()
        let helperDoc = project.Documents[0]
        let runnerDoc = project.Documents[1]
        let helperPrinted = GSharpPrinter.Print(
            translator.TranslateDocument(
                helperDoc,
                TranslationContext(project.Compilation, helperDoc.SemanticModel, helperDoc.FilePath)
            )
        )
        let runnerPrinted = GSharpPrinter.Print(
            translator.TranslateDocument(
                runnerDoc,
                TranslationContext(project.Compilation, runnerDoc.SemanticModel, runnerDoc.FilePath)
            )
        )
        Assert.Contains("import System.Threading", runnerPrinted, StringComparison.Ordinal)
        Assert.Contains("import System.Timers", runnerPrinted, StringComparison.Ordinal)
        Assert.Contains("import Timer = System.Threading.Timer", runnerPrinted, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(runnerPrinted, helperPrinted)
    }

    @Fact
    func TwoTargetTypedSynthesizedMetadataHomonyms_PinFirstAndDisambiguateSecond() {
        // Issue #4602 review: when two target-typed constructions in the same file
        // reference distinct metadata types with the same simple name (`Alpha.Widget`
        // and `Beta.Widget`, whose helper signatures live in another file), the first
        // prints bare and is pinned by `import Widget = Alpha.Widget`, while the
        // second sees the competing bare type and prints qualified as `Beta.Widget`.
        let libTree = CSharpSyntaxTree.ParseText(
            "namespace Alpha { public class Widget { public int Kind => 1; } } namespace Beta { public class Widget { public int Kind => 2; } }"
        )
        let libCompilation = CSharpCompilation.Create(
            "Issue4602.HomonymLib",
            []SyntaxTree{libTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-4602-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let libraryPath = Path.Combine(root, "Issue4602.HomonymLib.dll")
            let emitted = libCompilation.Emit(libraryPath)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let reference = MetadataReference.CreateFromFile(libraryPath)
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Helper.cs", `
namespace Demo
{
    public static class Helper
    {
        public static int UseAlpha(Alpha.Widget w) => w.Kind;
        public static int UseBeta(Beta.Widget w) => w.Kind;
    }
}`), ("Runner.cs", `
namespace Demo
{
    public class Runner
    {
        public int Run() => Helper.UseAlpha(new()) + Helper.UseBeta(new());
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator()
            let helperDoc = project.Documents[0]
            let runnerDoc = project.Documents[1]
            let helperPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    helperDoc,
                    TranslationContext(project.Compilation, helperDoc.SemanticModel, helperDoc.FilePath)
                )
            )
            let runnerPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    runnerDoc,
                    TranslationContext(project.Compilation, runnerDoc.SemanticModel, runnerDoc.FilePath)
                )
            )
            Assert.Contains("import Alpha", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Beta", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Widget = Alpha.Widget", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseAlpha(Widget())", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseBeta(Beta.Widget())", runnerPrinted, StringComparison.Ordinal)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            TranslationTestValidation.AssertBinds(resolver, runnerPrinted, helperPrinted)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func MixedAritySynthesizedMetadataHomonyms_PinFirstAndDisambiguateSecondAndBind() {
        // Issue #4602 review: when `Alpha.Widget` (arity 0) and `Beta.Widget<int>`
        // (arity 1) are constructed target-typed in the same file and a later
        // synthesized import (`Gamma`) introduces homonyms at both arities,
        // `Beta.Widget<int>` is treated as a competitor of `Alpha.Widget`
        // regardless of arity and prints qualified as `Beta.Widget[int32]`, while
        // `import Widget = Alpha.Widget` pins the bare `Widget`.
        let libTree = CSharpSyntaxTree.ParseText(`
namespace Alpha { public class Widget { public int Kind => 1; } }
namespace Beta { public class Widget<T> { public int Kind => 2; } }
namespace Gamma
{
    public class Widget { }
    public class Widget<T> { }
    public class Marker { public int Kind => 3; }
}`)
        let libCompilation = CSharpCompilation.Create(
            "Issue4602.MixedArityHomonymLib",
            []SyntaxTree{libTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-4602-arity-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let libraryPath = Path.Combine(root, "Issue4602.MixedArityHomonymLib.dll")
            let emitted = libCompilation.Emit(libraryPath)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let reference = MetadataReference.CreateFromFile(libraryPath)
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Helper.cs", `
namespace Demo
{
    public static class Helper
    {
        public static int UseAlpha(Alpha.Widget w) => w.Kind;
        public static int UseBeta(Beta.Widget<int> w) => w.Kind;
        public static int UseGamma(Gamma.Marker m) => m.Kind;
    }
}`), ("Runner.cs", `
namespace Demo
{
    public class Runner
    {
        public int Run() => Helper.UseAlpha(new()) + Helper.UseBeta(new()) + Helper.UseGamma(new());
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator()
            let helperDoc = project.Documents[0]
            let runnerDoc = project.Documents[1]
            let helperPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    helperDoc,
                    TranslationContext(project.Compilation, helperDoc.SemanticModel, helperDoc.FilePath)
                )
            )
            let runnerPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    runnerDoc,
                    TranslationContext(project.Compilation, runnerDoc.SemanticModel, runnerDoc.FilePath)
                )
            )
            Assert.Contains("import Alpha", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Beta", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Gamma", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Widget = Alpha.Widget", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseAlpha(Widget())", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseBeta(Beta.Widget[int32]())", runnerPrinted, StringComparison.Ordinal)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            TranslationTestValidation.AssertBinds(resolver, runnerPrinted, helperPrinted)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func SameNamespaceMixedAritySynthesizedMetadataHomonyms_EmitAliasAndBind() {
        // Issue #4602 review: when target-typed constructions print both
        // `Alpha.Widget` (arity 0) and `Alpha.Widget<int>` (arity 1) from the
        // same namespace before a later synthesized import (`Gamma`) introduces
        // only `Gamma.Widget<T>` (arity 1), both Alpha arities are recorded in
        // `barePrintedMetadataTypes` so import collection emits
        // `import Widget = Alpha.Widget` and `Widget[int32]` binds without GS0547.
        let libTree = CSharpSyntaxTree.ParseText(`
namespace Alpha
{
    public class Widget { public int Kind => 1; }
    public class Widget<T> { public int Kind => 2; }
}
namespace Gamma
{
    public class Widget<T> { }
    public class Marker { public int Kind => 3; }
}`)
        let libCompilation = CSharpCompilation.Create(
            "Issue4602.SameNamespaceMixedArityLib",
            []SyntaxTree{libTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-4602-same-ns-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let libraryPath = Path.Combine(root, "Issue4602.SameNamespaceMixedArityLib.dll")
            let emitted = libCompilation.Emit(libraryPath)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let reference = MetadataReference.CreateFromFile(libraryPath)
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Helper.cs", `
namespace Demo
{
    public static class Helper
    {
        public static int UsePlain(Alpha.Widget w) => w.Kind;
        public static int UseGeneric(Alpha.Widget<int> w) => w.Kind;
        public static int UseGamma(Gamma.Marker m) => m.Kind;
    }
}`), ("Runner.cs", `
namespace Demo
{
    public class Runner
    {
        public int Run() => Helper.UsePlain(new()) + Helper.UseGeneric(new()) + Helper.UseGamma(new());
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator()
            let helperDoc = project.Documents[0]
            let runnerDoc = project.Documents[1]
            let helperPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    helperDoc,
                    TranslationContext(project.Compilation, helperDoc.SemanticModel, helperDoc.FilePath)
                )
            )
            let runnerPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    runnerDoc,
                    TranslationContext(project.Compilation, runnerDoc.SemanticModel, runnerDoc.FilePath)
                )
            )
            Assert.Contains("import Alpha", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Gamma", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Widget = Alpha.Widget", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UsePlain(Widget())", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseGeneric(Widget[int32]())", runnerPrinted, StringComparison.Ordinal)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            TranslationTestValidation.AssertBinds(resolver, runnerPrinted, helperPrinted)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func AuthoredMixedArityMetadataHomonyms_WithSynthesizedImportConflict_DisambiguatesAndBinds() {
        // Issue #4602 review: when `using Alpha; using Beta;` are authored in
        // `Runner.cs` and target-typed constructions print `Alpha.Widget`
        // (arity 0) and `Beta.Widget<int>` (arity 1) before a later synthesized
        // import (`Gamma`) introduces homonyms at both arities, `Beta.Widget<int>`
        // must still be qualified as `Beta.Widget[int32]` while `import Widget = Alpha.Widget`
        // pins the bare `Widget`.
        let libTree = CSharpSyntaxTree.ParseText(`
namespace Alpha { public class Widget { public int Kind => 1; } }
namespace Beta { public class Widget<T> { public int Kind => 2; } }
namespace Gamma
{
    public class Widget { }
    public class Widget<T> { }
    public class Marker { public int Kind => 3; }
}`)
        let libCompilation = CSharpCompilation.Create(
            "Issue4602.AuthoredMixedArityHomonymLib",
            []SyntaxTree{libTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-4602-authored-arity-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let libraryPath = Path.Combine(root, "Issue4602.AuthoredMixedArityHomonymLib.dll")
            let emitted = libCompilation.Emit(libraryPath)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let reference = MetadataReference.CreateFromFile(libraryPath)
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Helper.cs", `
namespace Demo
{
    public static class Helper
    {
        public static int UseAlpha(Alpha.Widget w) => w.Kind;
        public static int UseBeta(Beta.Widget<int> w) => w.Kind;
        public static int UseGamma(Gamma.Marker m) => m.Kind;
    }
}`), ("Runner.cs", `
using Alpha;
using Beta;

namespace Demo
{
    public class Runner
    {
        public int Run() => Helper.UseAlpha(new()) + Helper.UseBeta(new()) + Helper.UseGamma(new());
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator()
            let helperDoc = project.Documents[0]
            let runnerDoc = project.Documents[1]
            let helperPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    helperDoc,
                    TranslationContext(project.Compilation, helperDoc.SemanticModel, helperDoc.FilePath)
                )
            )
            let runnerPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    runnerDoc,
                    TranslationContext(project.Compilation, runnerDoc.SemanticModel, runnerDoc.FilePath)
                )
            )
            Assert.Contains("import Alpha", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Beta", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Gamma", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Widget = Alpha.Widget", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseAlpha(Widget())", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseBeta(Beta.Widget[int32]())", runnerPrinted, StringComparison.Ordinal)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            TranslationTestValidation.AssertBinds(resolver, runnerPrinted, helperPrinted)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func MergedPartialPartSiblingUsing_WithAuthoredMixedArityMetadataHomonyms_DisambiguatesAndBinds() {
        // Issue #4602 review: in merged-part mode (`preservePartialParts: false`),
        // the primary part can have `using Alpha; using Beta;` and construct
        // `Alpha.Widget` (arity 0) and `Beta.Widget<int>` (arity 1) target-typed
        // while a sibling partial part contributes `using Gamma;`, where `Gamma`
        // declares homonyms at both arities. Including `reservedImportedNamespaces`
        // in `GetPotentialSynthesizedNamespaceNames` ensures `Beta.Widget<int>`
        // prints qualified as `Beta.Widget[int32]` while `import Widget = Alpha.Widget`
        // pins the bare `Widget`.
        let libTree = CSharpSyntaxTree.ParseText(`
namespace Alpha { public class Widget { public int Kind => 1; } }
namespace Beta { public class Widget<T> { public int Kind => 2; } }
namespace Gamma
{
    public class Widget { }
    public class Widget<T> { }
    public class Marker { public int Kind => 3; }
}`)
        let libCompilation = CSharpCompilation.Create(
            "Issue4602.MergedPartMixedArityHomonymLib",
            []SyntaxTree{libTree},
            CSharpProjectLoader.RuntimeReferences(),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        let root = Path.Combine(Path.GetTempPath(), "cs2gs-4602-merged-part-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(root)
        try {
            let libraryPath = Path.Combine(root, "Issue4602.MergedPartMixedArityHomonymLib.dll")
            let emitted = libCompilation.Emit(libraryPath)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let reference = MetadataReference.CreateFromFile(libraryPath)
            let project = CSharpProjectLoader.LoadInMemory([](string, string){("Helper.cs", `
namespace Demo
{
    public static class Helper
    {
        public static int UseAlpha(Alpha.Widget w) => w.Kind;
        public static int UseBeta(Beta.Widget<int> w) => w.Kind;
    }
}`), ("Runner.Part1.cs", `
using Alpha;
using Beta;

namespace Demo
{
    public partial class Runner
    {
        public int Run() => Helper.UseAlpha(new()) + Helper.UseBeta(new()) + Extra();
    }
}`), ("Runner.Part2.cs", `
using Gamma;

namespace Demo
{
    public partial class Runner
    {
        private int Extra() => new Marker().Kind;
    }
}`)}, CSharpProjectLoader.RuntimeReferences().Append(reference).ToList())
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let translator = CSharpToGSharpTranslator(preservePartialParts: false)
            let helperDoc = project.Documents[0]
            let runnerDoc = project.Documents[1]
            let helperPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    helperDoc,
                    TranslationContext(project.Compilation, helperDoc.SemanticModel, helperDoc.FilePath)
                )
            )
            let runnerPrinted = GSharpPrinter.Print(
                translator.TranslateDocument(
                    runnerDoc,
                    TranslationContext(project.Compilation, runnerDoc.SemanticModel, runnerDoc.FilePath)
                )
            )
            Assert.Contains("import Alpha", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Beta", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Gamma", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("import Widget = Alpha.Widget", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseAlpha(Widget())", runnerPrinted, StringComparison.Ordinal)
            Assert.Contains("Helper.UseBeta(Beta.Widget[int32]())", runnerPrinted, StringComparison.Ordinal)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            TranslationTestValidation.AssertBinds(resolver, runnerPrinted, helperPrinted)
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    shared {
        private func TranslateOblivious(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }
    }
}
