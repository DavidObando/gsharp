// <copyright file="Issue3879RefPropertyEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3879 (ADR-0060 amendment): G# gains a by-ref return on <c>prop</c> —
/// <c>prop P ref int32 { get { return ref slot } }</c>, its arrow sugar
/// <c>prop P ref int32 -&gt; slot</c>, and the indexer form
/// <c>prop this[i int32] ref int32 -&gt; …</c>. Before this, ADR-0060 gave the
/// by-ref return to <c>func</c> only, so cs2gs had nowhere to translate a C#
/// <c>ref</c> property into and gapped loudly at the declaration (#3839 / #3878).
/// <para>
/// The load-bearing assertion here is BEHAVIOURAL, not a printed shape and not
/// metadata alone: a copy-returning property has the same source spelling at the
/// call site and the same observable behaviour on a read, so only a WRITE through
/// the returned reference discriminates the two. G#'s own ref-alias binder does
/// not accept a call result as an lvalue (the documented #1900 limit), so the
/// alias is not expressible in G# — the proof is a C# driver compiled against the
/// gsc-emitted assembly, taking <c>ref int slot = ref holder.Property</c>,
/// writing through it, and reading the storage back through a separate accessor.
/// A copy-returning member reads the old value. This is the same shape PR #3878
/// used to prove the <c>func</c> half of #3839.
/// </para>
/// </summary>
public class Issue3879RefPropertyEmitTests
{
    /// <summary>
    /// The three ref-returning member forms plus two anti-vacuity neighbours: a
    /// plain (by-value) property and a plain method on the same type, so a
    /// blanket "make every property by-ref" cannot satisfy the assertions.
    /// </summary>
    private const string HolderSource = """
        package Repro

        public class Holder {
            private var values []int32 = []int32{40, 41, 42}

            // Block-bodied computed getter: the canonical form.
            public prop Property ref int32 {
                get { return ref values[0] }
            }

            // ADR-0131 arrow sugar. The `ref` on the declaration makes the
            // synthesized return a `return ref`, so the arrow aliases too.
            public prop Arrow ref int32 -> values[1]

            // ADR-0118 indexer, arrow form.
            public prop this[index int32] ref int32 -> values[index]

            // Anti-vacuity: an ordinary property on the same type.
            public prop Plain int32 -> values[0]

            // A separate, by-value read path, so a write through a returned
            // reference is observed through storage rather than through the
            // same member.
            public func Read(index int32) int32 -> values[index]
        }
        """;

    /// <summary>
    /// Metadata direction. Both the PropertyDef signature AND the <c>get_X</c>
    /// MethodDef signature must encode <c>T&amp;</c>: Roslyn only binds
    /// <c>ref int x = ref obj.P</c> when the two agree, so encoding one and not
    /// the other yields a property that reflects as by-ref but that no C#
    /// consumer can actually alias.
    /// </summary>
    [Fact]
    public void RefPropertyAndIndexer_EmitByRefPropertyAndAccessorSignatures()
    {
        string library = CompileLibrary(HolderSource, nameof(RefPropertyAndIndexer_EmitByRefPropertyAndAccessorSignatures));
        var loadContext = new AssemblyLoadContext(
            nameof(RefPropertyAndIndexer_EmitByRefPropertyAndAccessorSignatures), isCollectible: true);
        try
        {
            Type holder = LoadHolder(loadContext, library);

            foreach (string name in new[] { "Property", "Arrow", "Item" })
            {
                PropertyInfo property = holder.GetProperty(name)
                    ?? throw new InvalidOperationException($"'{name}' is missing from the emitted type.");
                Assert.True(
                    property.PropertyType.IsByRef,
                    $"the PropertyDef signature of '{name}' must be T&, not T; it was {property.PropertyType}");
                Assert.True(
                    property.GetMethod!.ReturnType.IsByRef,
                    $"the get_{name} MethodDef must return T&; it returned {property.GetMethod.ReturnType}");
                Assert.Equal(typeof(int).MakeByRefType(), property.GetMethod.ReturnType);
                Assert.Null(property.SetMethod);
            }

            // Anti-vacuity: the ordinary property and the ordinary method on the
            // same type keep their by-value signatures.
            Assert.False(
                holder.GetProperty("Plain")!.PropertyType.IsByRef,
                "a property declared without `ref` must stay by value");
            Assert.False(
                holder.GetProperty("Plain")!.GetMethod!.ReturnType.IsByRef,
                "get_Plain must stay by value");
            Assert.False(
                holder.GetMethod("Read")!.ReturnType.IsByRef,
                "a method declared without `ref` must stay by value");
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// The executing proof, and the only assertion in this file that a
    /// copy-returning member cannot also satisfy. A C# driver aliases each of
    /// the three ref members, writes through the alias, and the writes are read
    /// back through <c>Read</c> — a by-value accessor over the same array. A
    /// property that returned a copy would leave 40/41/42 in place.
    /// </summary>
    [Fact]
    public void RefPropertyAndIndexer_ReturnAliasesThatWriteThrough()
    {
        string library = CompileLibrary(HolderSource, nameof(RefPropertyAndIndexer_ReturnAliasesThatWriteThrough));
        var loadContext = new AssemblyLoadContext(
            nameof(RefPropertyAndIndexer_ReturnAliasesThatWriteThrough), isCollectible: true);
        try
        {
            LoadHolder(loadContext, library);

            const string DriverSource = """
                namespace Repro
                {
                    public static class Driver
                    {
                        public static int[] Run()
                        {
                            var holder = new Holder();

                            ref int fromProperty = ref holder.Property;
                            fromProperty = 99;

                            ref int fromArrow = ref holder.Arrow;
                            fromArrow = 88;

                            ref int fromIndexer = ref holder[2];
                            fromIndexer = 77;

                            return new[] { holder.Read(0), holder.Read(1), holder.Read(2) };
                        }
                    }
                }
                """;

            string driverPath = CompileCSharpDriver(
                DriverSource, library, nameof(RefPropertyAndIndexer_ReturnAliasesThatWriteThrough));
            Assembly driver = loadContext.LoadFromAssemblyPath(driverPath);
            object result = driver.GetType("Repro.Driver")!.GetMethod("Run")!.Invoke(null, null)!;

            Assert.Equal(new[] { 99, 88, 77 }, Assert.IsType<int[]>(result));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    /// <summary>
    /// The G# side of the same members. G# cannot express the alias (#1900), so
    /// every G# use of a ref-returning member is a value read — which means the
    /// emitted call site has to load THROUGH the returned managed pointer.
    /// Without that load the program is either unverifiable
    /// (<c>InvalidProgramException</c>) or prints the raw address as an
    /// <c>int32</c>. Read together with the metadata test above (which pins the
    /// getters as genuinely by-ref), printing the stored values proves the
    /// dereference happened rather than the <c>ref</c> having been dropped.
    /// </summary>
    [Fact]
    public void RefPropertyAndIndexer_ReadFromGSharp_LoadThroughThePointer()
    {
        const string Source = """
            package Repro
            import System

            class Holder {
                var values []int32 = []int32{40, 41, 42}

                prop Property ref int32 { get { return ref values[0] } }

                prop Arrow ref int32 -> values[1]

                prop this[index int32] ref int32 -> values[index]
            }

            var h = Holder{}
            Console.WriteLine(h.Property)
            Console.WriteLine(h.Arrow)
            Console.WriteLine(h[2])
            """;

        string output = CompileAndRun(Source, nameof(RefPropertyAndIndexer_ReadFromGSharp_LoadThroughThePointer));

        Assert.Equal(
            new[] { "40", "41", "42" },
            output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.Trim()).ToArray());
    }

    /// <summary>
    /// GS0578: an auto-property has no storage of its own to name — its getter
    /// copies out of a compiler-synthesized backing field. #3878's GS0219 sweep
    /// showed that backing-field path is exactly where by-ref hazards
    /// concentrate, so the by-ref return is restricted to computed getters.
    /// </summary>
    [Fact]
    public void RefAutoProperty_ReportsGS0578()
    {
        AssertRejected(
            """
            package P
            class Holder { prop Slot ref int32 }
            """,
            "GS0578",
            nameof(RefAutoProperty_ReportsGS0578));
    }

    /// <summary>
    /// GS0578 again: a bodiless <c>{ get }</c> is an abstract slot or a
    /// read-only auto-property. Either way nothing in the declaration says what
    /// is aliased.
    /// </summary>
    [Fact]
    public void BodilessRefProperty_ReportsGS0578()
    {
        AssertRejected(
            """
            package P
            open class Holder { open prop Slot ref int32 { get } }
            """,
            "GS0578",
            nameof(BodilessRefProperty_ReportsGS0578));
    }

    /// <summary>
    /// GS0578 in an interface. An interface member is a slot, not storage, and
    /// G# has no ref-kind matching for property slots (GS0255 covers methods
    /// only) — so a copy-returning implementation of a <c>ref</c> requirement
    /// would go unchecked. Rejected rather than silently accepted.
    /// </summary>
    [Fact]
    public void RefPropertyInInterface_ReportsGS0578()
    {
        AssertRejected(
            """
            package P
            interface IHolder { prop Slot ref int32 { get } }
            """,
            "GS0578",
            nameof(RefPropertyInInterface_ReportsGS0578));
    }

    /// <summary>
    /// GS0579: the returned reference IS the write path, so a setter would be a
    /// second, contradictory one. C# spells the same rule CS8147.
    /// </summary>
    [Fact]
    public void RefPropertyWithSetter_ReportsGS0579()
    {
        AssertRejected(
            """
            package P
            class Holder {
                var slot int32 = 0
                prop Value ref int32 {
                    get { return ref slot }
                    set(v) { slot = v }
                }
            }
            """,
            "GS0579",
            nameof(RefPropertyWithSetter_ReportsGS0579));
    }

    /// <summary>
    /// The accessor body is bound with the getter as its enclosing function, so
    /// the existing #490 return-shape rules apply inside it unchanged: a plain
    /// <c>return</c> in a ref-returning getter is GS0252, exactly as it is in a
    /// ref-returning <c>func</c>. Without this the by-ref-ness would live only
    /// in the signature and the body would silently copy.
    /// </summary>
    [Fact]
    public void PlainReturnInRefPropertyGetter_ReportsGS0252()
    {
        AssertRejected(
            """
            package P
            class Holder {
                var slot int32 = 0
                prop Value ref int32 { get { return slot } }
            }
            """,
            "GS0252",
            nameof(PlainReturnInRefPropertyGetter_ReportsGS0252));
    }

    /// <summary>
    /// A property literally NAMED <c>ref</c> must still parse as an ordinary
    /// property: the modifier is consumed only when a type clause can start at
    /// the next token, and the name is consumed before that test runs.
    /// </summary>
    [Fact]
    public void PropertyNamedRef_IsStillAnOrdinaryProperty()
    {
        string library = CompileLibrary(
            """
            package Repro
            public class Holder {
                private var x int32 = 1
                public prop ref int32 -> x
            }
            """,
            nameof(PropertyNamedRef_IsStillAnOrdinaryProperty));

        var loadContext = new AssemblyLoadContext(
            nameof(PropertyNamedRef_IsStillAnOrdinaryProperty), isCollectible: true);
        try
        {
            Type holder = LoadHolder(loadContext, library);
            PropertyInfo property = holder.GetProperty("ref")
                ?? throw new InvalidOperationException("the property named 'ref' is missing from the emitted type.");
            Assert.False(property.PropertyType.IsByRef, "a property NAMED `ref` must not become ref-returning");
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static Type LoadHolder(AssemblyLoadContext loadContext, string libraryPath)
    {
        Assembly library = loadContext.LoadFromAssemblyPath(libraryPath);
        return library.GetType("Repro.Holder")
            ?? throw new InvalidOperationException(
                "Repro.Holder is missing from the emitted assembly: " +
                string.Join(", ", library.GetTypes().Select(t => t.FullName)));
    }

    private static void AssertRejected(string source, string expectedDiagnostic, string testName)
    {
        (int exitCode, string diagnostics) = CompileTo(
            source, Path.Combine(CreateArtifactDirectory(testName), "test.dll"), "/target:library");

        Assert.True(exitCode != 0, $"{testName}: the source must be rejected. Output:\n{diagnostics}");

        // Match "error GS0578", never the bare id. gsc echoes the SOURCE PATH in
        // every diagnostic, and the artifact directory is named after the test —
        // whose own name contains the id. A bare-id assertion is satisfied by the
        // path alone: measured, it passed on a tree with the whole feature
        // reverted. This is the one line standing between this file and vacuity.
        Assert.Contains($"error {expectedDiagnostic}", diagnostics, StringComparison.Ordinal);
        Assert.DoesNotContain("error GS9998", diagnostics, StringComparison.Ordinal);
    }

    private static string CompileLibrary(string source, string testName)
    {
        string outputPath = Path.Combine(CreateArtifactDirectory(testName), "Repro.dll");
        (int exitCode, string diagnostics) = CompileTo(source, outputPath, "/target:library");

        Assert.True(exitCode == 0, $"{testName}: gsc failed:\n{diagnostics}");
        return outputPath;
    }

    private static string CompileAndRun(string source, string testName)
    {
        string outputPath = Path.Combine(CreateArtifactDirectory(testName), "Repro.dll");
        (int exitCode, string diagnostics) = CompileTo(source, outputPath, "/target:exe");
        Assert.True(exitCode == 0, $"{testName}: gsc failed:\n{diagnostics}");

        var loadContext = new AssemblyLoadContext(testName, isCollectible: true);
        try
        {
            Assembly assembly = loadContext.LoadFromAssemblyPath(outputPath);
            Type program = assembly.GetTypes().First(t => t.Name == "<Program>");
            MethodInfo entry = program.GetMethod(
                "<Main>$", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;

            TextWriter previous = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(previous);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static string CompileCSharpDriver(string driverSource, string libraryPath, string testName)
    {
        var references = new List<MetadataReference>(
            TrustedPlatformAssemblies().Select(path => (MetadataReference)MetadataReference.CreateFromFile(path)))
        {
            MetadataReference.CreateFromFile(libraryPath),
        };

        CSharpCompilation compilation = CSharpCompilation.Create(
            "Repro.Driver",
            new[] { CSharpSyntaxTree.ParseText(driverSource, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        string driverPath = Path.Combine(Path.GetDirectoryName(libraryPath)!, "Repro.Driver.dll");
        Microsoft.CodeAnalysis.Emit.EmitResult emitted = compilation.Emit(driverPath);
        Assert.True(
            emitted.Success,
            $"{testName}: the C# driver must compile against the gsc-emitted assembly — if " +
                "`ref int slot = ref holder.Property` does not compile, the emitted member is not by-ref. " +
                "Diagnostics:\n" + string.Join(Environment.NewLine, emitted.Diagnostics));
        return driverPath;
    }

    private static (int ExitCode, string Diagnostics) CompileTo(string source, string outputPath, string target)
    {
        string sourcePath = Path.Combine(Path.GetDirectoryName(outputPath)!, "test.gs");
        File.WriteAllText(sourcePath, source);

        string[] args =
        {
            "/out:" + outputPath,
            target,
            "/targetframework:net10.0",
            sourcePath,
        };

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }

        return (exitCode, compileOut.ToString() + compileErr.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(tpa)
            ? Enumerable.Empty<string>()
            : tpa.Split(Path.PathSeparator).Where(File.Exists);
    }

    private static string CreateArtifactDirectory(string testName)
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue3879-artifacts",
            testName,
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
