// <copyright file="Issue4684EmptyArrayCollectionExpressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Security.Cryptography
import Xunit
import Xunit.Abstractions

/// Issue #4684: csc lowers an empty collection expression that targets an
/// array (`T[] a = []`) to the cached `Array.Empty<T>()`
/// singleton. Translating it to a `[]T{}` literal allocated a fresh
/// zero-length array per evaluation, so the migrated
/// `Gsharp.Runtime.Values` allocated 24 extra bytes per
/// `ManagedLocationKey`, plus another 24 bytes from the bare array field's
/// synthesized zero value, which tripped the array-location allocation
/// bound under self-host stage 2.
open class Issue4684EmptyArrayCollectionExpressionTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func EmptyCollectionExpressionTargetingArray_TranslatesToArrayEmpty() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("System.Array.Empty[(int32, string)]()", printed)
        Assert.Contains("System.Array.Empty[int32]()", printed)
        Assert.DoesNotContain("[](int32, string){}", printed)
        Assert.DoesNotContain("[]int32{}", printed)
    }

    @Fact
    func ExplicitZeroLengthArrayAndNonEmptyCollectionExpression_KeepLiterals() {
        let printed = TranslateUnit(`
namespace Demo
{
    public class C
    {
        public static int[] Fresh() => new int[0];

        public static int[] Filled() => [1, 2];

        public static System.Collections.Generic.List<int> EmptyList() => [];
    }
}`)
        Assert.DoesNotContain("Array.Empty", printed)
        Assert.Contains("[]int32{1, 2}", printed)
        Assert.Contains("List[int32]()", printed)
    }

    @Fact
    func ManagedLocationKeySource_EmitsNoZeroLengthArrayLiteral() {
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){("ManagedLocationKey.cs", ReadManagedLocationKeySource())},
            assemblyName: "Gsharp.Runtime.Values"
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        // Element/Object literals, plus the `path` field's explicit empty initializer
        // that replaces gsc's synthesized zero-value array.
        Assert.Equal(2, CountOccurrences(printed, "System.Array.Empty[(RuntimeFieldHandle, RuntimeTypeHandle)]()"))
        let pathLine = Assert.Single(
            Array.FindAll(
                printed.Split('\n'),
                (line string) -> line.Contains("private let path", StringComparison.Ordinal)
            )
        )
        Assert.Contains("[]", pathLine)
        Assert.Contains("Field RuntimeFieldHandle, Type RuntimeTypeHandle", pathLine)
        Assert.Contains("System.Array.Empty", pathLine)
        Assert.DoesNotContain("[](Field RuntimeFieldHandle, Type RuntimeTypeHandle){}", printed)
    }

    @Fact
    func ProvenCtorOverwrite_BareNonNullableArrayInstanceField_GetsEmptyInitializer_OthersDoNot() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public sealed class C
    {
        private readonly int[] items;
        private int[]? maybe;
        private static int[] shared = new int[2];
        private static int[] bareShared;
        private int[] explicitInit = new int[3];
        private int[,] grid;

        public C(int[] items) { this.items = items; grid = new int[1, 1]; }
    }
    public struct S { public int[] values; }
}`)
        Assert.Contains("let items []int32 = System.Array.Empty[int32]()", printed)
        Assert.DoesNotContain("maybe []int32? =", printed)
        Assert.DoesNotContain("grid [,]int32 =", printed)
        Assert.DoesNotContain("bareShared []int32 =", printed)
        Assert.DoesNotContain("values []int32 =", printed)
        Assert.Equal(1, CountOccurrences(printed, "Array.Empty"))
    }

    /// Issue #4918: proving the constructor overwrites an array field asks
    /// Roslyn for the symbol of every simple name in each constructor
    /// statement, and the `nameof` in `nameof(source)` binds to no symbol.
    /// Oahu's JobScheduler has exactly this shape; the cut-over turned the
    /// unbound name into a NullReferenceException that crashed the translate
    /// stage for the whole project. An unbound name is not an instance member.
    @Fact
    func ProvenCtorOverwrite_StatementWithNameof_DoesNotCrash() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public sealed class C
    {
        private readonly string source;
        private readonly int[] items;

        public C(string source, int count)
        {
            this.source = source ?? throw new System.ArgumentNullException(nameof(source));
            items = new int[count];
        }
    }
}`)
        Assert.Contains("let items []int32 = System.Array.Empty[int32]()", printed)
    }

    @Theory
    @InlineData("int*", false)
    @InlineData("int*", true)
    @InlineData("delegate*<int>", false)
    @InlineData("delegate*<int>", true)
    @InlineData("delegate* unmanaged[Cdecl]<int>", false)
    @InlineData("delegate* unmanaged[Cdecl]<int>", true)
    func UnsafeEmptyArrays_KeepAdmissibleLiteralAndRun(element string, field bool) {
        let members = if field {
            (`private readonly ` + "$element" + `[] items;
public C(` + "$element" + `[] values) { items = values; }
private static ` + "$element" + `[] Empty() => [];
public static int Run() => new C(Empty()).items.Length
    + new C(new ` + "$element" + `[1]).items.Length - 1;`)
        } else {
            (`public static int Run()
{
    ` + "$element" + `[] empty = [];
    var positive = new ` + "$element" + `[1];
    return empty.Length + positive.Length - 1;
}`)
        }
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Pointer.cs", (`namespace Demo
{
    public sealed unsafe class C
    {
        ` + "$members" + `
    }
}`))})
        this.AssertNativeAndTranslatedRun(project, expected: 0)
    }

    @Theory
    @InlineData("default")
    @InlineData("readonly-default")
    @InlineData("default-struct")
    @InlineData("read-before-write")
    @InlineData("rhs-observer")
    @InlineData("alternate")
    @InlineData("delegating")
    @InlineData("escape")
    @InlineData("base-observer")
    @InlineData("partial")
    @InlineData("finalizer")
    @InlineData("other-receiver")
    func ObservableArrayDefaults_DoNotAcquireCachedIdentity(scenario string) {
        var constructors string
        var prefix = string.Empty
        var suffix = string.Empty
        var baseType = string.Empty
        var readOnly = string.Empty
        var run string
        switch scenario {
            case "default" {
                constructors = string.Empty
                run = "new C().IsCached() ? 1 : 0"
            }
            case "readonly-default" {
                constructors = string.Empty
                readOnly = "readonly"
                run = "new C().IsCached() ? 1 : 0"
            }
            case "default-struct" {
                prefix = "public struct S { public int[] Items; }"
                constructors = string.Empty
                run = "(ReferenceEquals(default(S).Items, Array.Empty<int>()) ? 1 : 0) + (ReferenceEquals(new S().Items, Array.Empty<int>()) ? 1 : 0)"
            }
            case "read-before-write" {
                constructors = "public C() { seen = IsCached(); items = new int[1]; }"
                run = "new C().seen ? 1 : 0"
            }
            case "rhs-observer" {
                constructors = "private static bool cached; public C() { items = Observe(items); } private static int[] Observe(int[] values) { cached = ReferenceEquals(values, Array.Empty<int>()); return new int[1]; }"
                run = "new C().Result()"
                constructors += " private int Result() => cached ? 1 : 0;"
            }
            case "alternate" {
                constructors = "public C() {} public C(int[] values) { items = values; }"
                run = "(new C().IsCached() ? 1 : 0) + new C(new int[1]).items.Length - 1"
            }
            case "delegating" {
                constructors = "public C() : this(new int[1]) {} public C(int[] values) { seen = IsCached(); items = values; }"
                run = "new C().seen ? 1 : 0"
            }
            case "escape" {
                constructors = "public C() { Publish(this); items = new int[1]; } private static void Publish(C value) { value.seen = value.IsCached(); }"
                run = "new C().seen ? 1 : 0"
            }
            case "base-observer" {
                prefix = "public abstract class B { protected B() { Observe(); } protected abstract void Observe(); }"
                baseType = ": B"
                constructors = "private static C published; public C() { ReadPublished(); items = new int[1]; } protected override void Observe() { published = this; } private static void ReadPublished() { published.seen = published.IsCached(); }"
                run = "new C().seen ? 1 : 0"
            }
            case "partial" {
                constructors = "public C(int[] values) { items = values; }"
                suffix = "#nullable disable\nnamespace Demo { public sealed partial class C { public C() {} } }"
                run = "new C().IsCached() ? 1 : 0"
            }
            case "finalizer" {
                constructors = `private static bool cached;
private static int finalized;
public C() { Fail(); items = new int[1]; }
private static void Fail() { throw new InvalidOperationException(); }
~C() { cached = IsCached(); finalized++; }
private static int FinalizerResult()
{
    try { new C(); } catch (InvalidOperationException) {}
    GC.Collect();
    GC.WaitForPendingFinalizers();
    return finalized == 1 ? (cached ? 1 : 0) : 2;
}`
                run = "FinalizerResult()"
            }
            case "other-receiver" {
                constructors = "public C(int[] values) { items = values; } public C(C other, int[] values) { other.items = values; }"
                run = "new C(new C(new int[1]), new int[2]).IsCached() ? 1 : 0"
            }
            default {
                throw ArgumentOutOfRangeException("scenario", scenario, "Unknown construction scenario.")
            }
        }
        let sources = List[(string, string)]{("Identity.cs", (`#nullable disable
using System;
namespace Demo
{
    ` + "$prefix" + `
    public sealed partial class C ` + "$baseType" + `
    {
        private ` + "$readOnly" + ` int[] items;
        private bool seen;
        ` + "$constructors" + `
        private bool IsCached() => ReferenceEquals(items, Array.Empty<int>());
        public static int Run() => ` + "$run" + `;
    }
}`))}
        if suffix.Length != 0 {
            sources.Add(("OtherPart.cs", suffix))
        }
        this.AssertNativeAndTranslatedRun(CSharpProjectLoader.LoadInMemory(sources), expected: 0)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func GuaranteedCtorOverwrite_AllConstructorsPreserveAssignments(partial bool) {
        const SecondConstructor = "public C(int[] values, bool alternate) { calls++; this.items = values; }"
        let sources = List[(string, string)]{("Overwrite.cs", (`namespace Demo
{
    public sealed partial class C
    {
        private readonly int[] items;
        private static int calls;
        public C(int[] values) { items = Pass(values); }
        ` + "${(if partial { string.Empty } else { SecondConstructor })}" + `
        private static int[] Pass(int[] values) { calls++; return values; }
        public static int Run()
        {
            var first = new int[1];
            var second = new int[2];
            var a = new C(first);
            var b = new C(second, true);
            return System.Object.ReferenceEquals(first, a.items)
                && System.Object.ReferenceEquals(second, b.items) ? calls - 2 : 1;
        }
    }
}`))}
        if partial {
            sources.Add(
                ("OtherPart.cs", "namespace Demo { public sealed partial class C { " + SecondConstructor + " } }")
            )
        }
        let project = CSharpProjectLoader.LoadInMemory(sources)
        let declaration = project.Documents[0]
        let context = TranslationContext(project.Compilation, declaration.SemanticModel, declaration.FilePath)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(declaration, context))
        Assert.Contains("let items []int32 = System.Array.Empty[int32]()", printed)
        this.AssertNativeAndTranslatedRun(project, expected: 0)
    }

    private func AssertNativeAndTranslatedRun(project LoadedCSharpProject, expected int32) {
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
        Assert.NotNull(compiler)
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-4684-controls", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let sources = project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                    Assert.DoesNotContain(
                        context.Diagnostics,
                        (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                    )
                    let path = Path.Combine(directory, Path.GetFileNameWithoutExtension(document.FilePath) + ".gs")
                    File.WriteAllText(path, printed)
                    return path
                }
            )
                .ToArray()
            using let native = MemoryStream()
            let emitted = project
                .Compilation
                .WithOptions(project.Compilation.Options.WithOptimizationLevel(OptimizationLevel.Release))
                .Emit(native)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let nativePath = Path.Combine(directory, "Native.dll")
            File.WriteAllBytes(nativePath, native.ToArray())
            let translatedPath = Path.Combine(directory, "Translated.dll")
            for path in[]string{nativePath, translatedPath} {
                if path == translatedPath {
                    let compiled = GscInvoker(compiler!!).Compile(
                        sources,
                        translatedPath,
                        TargetKind.Library,
                        Array.Empty[string]()
                    )
                    Assert.True(
                        compiled.Succeeded,
                        compiled.Output + "\n" + string.Join("\n", sources.Select(File.ReadAllText))
                    )
                }
                this.output.WriteLine(
                    Path.GetFileName(path) + " SHA256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
                )
                let assembly = EmittedFixture.Load(File.ReadAllBytes(path), directory)
                let type Type? = assembly.GetType("Demo.C", throwOnError: true)
                Assert.NotNull(type)
                let run MethodInfo? = type!!.GetMethod("Run")
                Assert.NotNull(run)
                let actual = run!!.CreateDelegate[() -> int32]()()
                this.output.WriteLine(Path.GetFileName(path) + " Run=" + actual.ToString())
                Assert.Equal(expected, actual)
                let arguments = List[string]{"tool", "run", "ilverify", path, "-s", "System.Private.CoreLib"}
                let references = Assert.IsType[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
                for reference in references.Split(Path.PathSeparator) {
                    arguments.Add("-r")
                    arguments.Add(reference)
                }
                let verified = ProcessRunner.Run("dotnet", arguments)
                this.output.WriteLine(Path.GetFileName(path) + " strict ILVerify exit=" + verified.ExitCode.ToString())
                this.output.WriteLine(verified.Output)
                Assert.False(verified.TimedOut, verified.Output)
                Assert.Equal(0, verified.ExitCode)
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ArrayInitializersAndConstructorAssignments_PreserveRuntimeBehavior() {
        let printed = TranslateUnit(`#nullable enable
using System;
namespace Demo
{
    public class C
    {
        private static int calls;
        private static string trace = "";
        private readonly int[] items;
        private int[]? maybe;
        private int[] explicitInit = Make(3);
        private int[,] grid;
        public C(int[] items)
        {
            this.items = items;
            grid = new int[1, 1];
            trace += "ctor";
        }
        private static int[] Make(int size)
        {
            calls++;
            trace += "field";
            return new int[size];
        }
        private static int[] Fresh() => new int[0];
        private static int[] Empty() => [];
        public static bool Check()
        {
            calls = 0;
            trace = "";
            var input = new[] { 7 };
            var c = new C(input);
            return ReferenceEquals(input, c.items) && c.items[0] == 7
                && c.maybe == null && c.explicitInit.Length == 3 && c.grid.Length == 1
                && calls == 1 && trace == "fieldctor"
                && !ReferenceEquals(Fresh(), Fresh()) && ReferenceEquals(Empty(), Empty());
        }
    }
}`)
        let result = EmittedOracle.Evaluate(printed + "\nC.Check()")
        Assert.Empty(result.Diagnostics)
        Assert.True(Assert.IsType[bool](result.Value))
    }

    @Fact
    func TranslatedRuntime_FirstGetLocationKeepsOriginalAllocationBound() {
        let files[]string = []string{
            "ManagedLocationKey.cs",
            "ManagedLocation.cs",
            "ManagedRef.cs",
            "ReadOnlyManagedRef.cs",
            "Slice.cs",
            "ReadOnlySlice.cs"
        }
        let project = CSharpProjectLoader.LoadInMemory(files.Select((file string) -> (file, `global using System;
global using System.Collections.Generic;
` + ReadRuntimeSource(file))).ToArray(), assemblyName: "Gsharp.Runtime.Values")
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
        Assert.NotNull(compiler)
        let directory = Path.Combine(AppContext.BaseDirectory, "issue-4684", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let sources = project
                .Documents
                .Select(
                (document LoadedDocument) -> {
                    let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
                    let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
                    Assert.DoesNotContain(
                        context.Diagnostics,
                        (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
                    )
                    let path = Path.Combine(directory, Path.GetFileNameWithoutExtension(document.FilePath) + ".gs")
                    File.WriteAllText(path, printed)
                    return path
                }
            )
                .ToArray()
            let runtimePath = Path.Combine(directory, "Gsharp.Runtime.Values.dll")
            let result = GscInvoker(compiler!!).Compile(sources, runtimePath, TargetKind.Library, Array.Empty[string]())
            Assert.True(result.Succeeded, result.Output)
            this.output.WriteLine("gsc-version=" + GscInvoker(compiler!!).GetVersion())
            this.output.WriteLine(
                "runtime-sha256=" + Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(runtimePath)))
            )
            // The consumer is native Roslyn C#, explicitly referenced to the freshly
            // translated runtime, never the ambient (potentially migrated) test assembly.
            let references = ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Where((path string) -> Path.GetFileNameWithoutExtension(path) != "Gsharp.Runtime.Values")
                .Append(runtimePath)
                .Select((path string) -> MetadataReference.CreateFromFile(path))
            let consumer = CSharpCompilation.Create(
                "Issue4684AllocationProbe",
                []SyntaxTree{CSharpSyntaxTree.ParseText(AllocationProbeSource)},
                references,
                CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    optimizationLevel: OptimizationLevel.Release
                )
            )
            using let image = MemoryStream()
            let emitted = consumer.Emit(image)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let assemblies = EmittedFixture.LoadTogether(directory, File.ReadAllBytes(runtimePath), image.ToArray())
            let probe Type? = assemblies[1].GetType("AllocationProbe", throwOnError: true)
            Assert.NotNull(probe)
            let run MethodInfo? = probe!!.GetMethod("Run")
            Assert.NotNull(run)
            let measure = run!!.CreateDelegate[() -> []int64]()
            let bytes = measure()
            Assert.Equal(2, bytes.Length)
            this.output.WriteLine("iterations=20000; first-identity=${bytes[0]}; warmed-identity=${bytes[1]}")
            // Unchanged ManagedReferenceRuntimeTests ceiling: 40 B/key and its
            // existing 64 KiB one-time allowance, not a per-operation waiver.
            Assert.InRange(bytes[0], int64(1), int64((20_000 * 40) + (64 * 1024)))
            Assert.Equal(int64(0), bytes[1])
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private const AllocationProbeSource string = `using System;
using Gsharp.Values;
public static class AllocationProbe
{
    public static long[] Run()
    {
        const int Iterations = 20_000;
        var owner = new[] { 7 };
        _ = ManagedRef<int>.FromArray(owner, 0).Borrow();
        _ = ReadOnlyManagedRef<int>.FromArray(owner, 0).Borrow();
        _ = ManagedRef<int>.FromArray(owner, 0).GetLocation();
        var retained = new ManagedRef<int>[Iterations];
        for (var i = 0; i < retained.Length; i++)
            retained[i] = ManagedRef<int>.FromArray(owner, 0);
        var keys = new ManagedLocationKey[Iterations];
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < retained.Length; i++)
            keys[i] = retained[i].GetLocation();
        var firstIdentityBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < retained.Length; i++)
            if (!ReferenceEquals(keys[i], retained[i].GetLocation()))
                throw new Exception("Location identity was not cached.");
        var warmedIdentityBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        GC.KeepAlive(retained);
        return new[] { firstIdentityBytes, warmedIdentityBytes };
    }
}`

        private func CountOccurrences(text string, value string) int32 {
            var count = 0
            for var i = text.IndexOf(value, StringComparison.Ordinal); i >= 0; i = text.IndexOf(
                value,
                i + value.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

        private func ReadManagedLocationKeySource() string {
            let text = ReadRuntimeSource("ManagedLocationKey.cs")
            Assert.Contains("public sealed class ManagedLocationKey : IEquatable<ManagedLocationKey>", text)
            Assert.Contains("private readonly (RuntimeFieldHandle Field, RuntimeTypeHandle Type)[] path;", text)
            Assert.Contains("ManagedLocationKey Element(object owner, int index) => new(owner, index, []);", text)
            return "global using System;\n" + text
        }

        private func ReadRuntimeSource(file string) string {
            using let source Stream? = typeof(Issue4684EmptyArrayCollectionExpressionTests)
                .Assembly
                .GetManifestResourceStream("Cs2Gs.Tests.RuntimeValues." + file)
            Assert.NotNull(source)
            using let reader = StreamReader(source!!)
            let text = reader.ReadToEnd()
            Assert.Contains("namespace Gsharp.Values;", text)
            return text
        }

        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
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
