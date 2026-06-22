// <copyright file="Issue944IndexerDeclarationEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #944 / ADR-0118: canonical G# user indexer-member declaration
/// (<c>prop this[i int32] T { get {...} set {...} }</c>). Before the fix,
/// declaring an indexer crashed the compiler with <c>GS9998</c>
/// (<c>ArgumentNullException: Parameter 'key'</c>) for generic enclosing
/// types and produced no canonical declaration form at all.
///
/// These tests compile AND run programs that declare and consume indexers,
/// covering get-only, get/set, generic, and non-generic enclosing types,
/// the original <c>Repo[T]</c> repro, plus a guard that the ICE is gone
/// (malformed shapes now report a clean diagnostic, never <c>GS9998</c>).
/// </summary>
public class Issue944IndexerDeclarationEmitTests
{
    [Fact]
    public void GetOnlyGenericIndexer_RepoRepro_ReadsBack()
    {
        // The headline repro from issue #944: a generic `Repo[T]` exposing a
        // get-only indexer that delegates to an inner list. Previously this
        // crashed with GS9998; now it emits a valid CLR default indexer.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Repo[T] {
                private let _items List[T] = List[T]()
                func Add(item T) { _items.Add(item) }
                prop this[index int32] T {
                    get { return _items[index] }
                }
            }

            let r = Repo[int32]()
            r.Add(10)
            r.Add(20)
            r.Add(30)
            public var result = r[2]
            """;

        Assert.Equal(30, RunAndGetIntResult(source));
    }

    [Fact]
    public void GetSetIndexer_NonGeneric_WritesThroughAndReadsBack()
    {
        // A non-generic class with a get/set indexer. The write `b[1] = 99`
        // binds to set_Item and the read `b[0] + b[1]` binds to get_Item.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Box {
                private let _items List[int32] = List[int32]()
                func Add(item int32) { _items.Add(item) }
                prop this[index int32] int32 {
                    get { return _items[index] }
                    set { _items[index] = value }
                }
            }

            let b = Box()
            b.Add(10)
            b.Add(20)
            b[1] = 99
            public var result = b[0] + b[1]
            """;

        Assert.Equal(109, RunAndGetIntResult(source));
    }

    [Fact]
    public void GetOnlyIndexer_NonGeneric_StringKeyedElementType()
    {
        // Non-generic get-only indexer with a non-int element type to confirm
        // the PropertyDef/get_Item signatures encode the declared element type
        // (here `string`) rather than erasing to object.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Names {
                private let _items List[string] = List[string]()
                func Add(item string) { _items.Add(item) }
                prop this[index int32] string {
                    get { return _items[index] }
                }
            }

            let n = Names()
            n.Add("alpha")
            n.Add("beta")
            public var result = n[1].Length
            """;

        // "beta".Length == 4
        Assert.Equal(4, RunAndGetIntResult(source));
    }

    [Fact]
    public void GenericGetSetIndexer_FieldBacked_WritesAndReadsBack()
    {
        // Generic enclosing type with BOTH accessors: exercises generic
        // substitution on the setter `value` parameter and the getter return
        // type, plus the MemberRef/TypeSpec resolution path for the accessor
        // tokens. Storage is a single `T` field (a generic-collection element
        // write is a separate, pre-existing limitation unrelated to indexers).
        var source = """
            package P
            import System

            class Store[T] {
                private var _slot T
                func Init(seed T) { _slot = seed }
                prop this[index int32] T {
                    get { return _slot }
                    set { _slot = value }
                }
            }

            let s = Store[int32]()
            s.Init(1)
            s[0] = 42
            public var result = s[0]
            """;

        Assert.Equal(42, RunAndGetIntResult(source));
    }

    [Fact]
    public void IndexerType_CarriesDefaultMemberAttribute_AndItemProperty()
    {
        // Metadata shape check: the declaring type must carry
        // DefaultMemberAttribute("Item") and expose an `Item` property with
        // one index parameter plus a get_Item accessor, so C# consumers and
        // the CLR recognise it as a default indexer.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Repo[T] {
                private let _items List[T] = List[T]()
                func Add(item T) { _items.Add(item) }
                prop this[index int32] T {
                    get { return _items[index] }
                }
            }

            public var result = 0
            """;

        var assembly = CompileToAssembly(source);
        var repo = assembly.GetTypes().Single(t => t.Name.StartsWith("Repo", StringComparison.Ordinal));

        var defaultMember = repo.GetCustomAttribute<System.Reflection.DefaultMemberAttribute>();
        Assert.NotNull(defaultMember);
        Assert.Equal("Item", defaultMember!.MemberName);

        var item = repo.GetProperty("Item");
        Assert.NotNull(item);
        Assert.Single(item!.GetIndexParameters());

        Assert.NotNull(repo.GetMethod("get_Item"));
    }

    [Fact]
    public void IceIsGone_OriginalCrashingShape_NowCompiles()
    {
        // Regression guard for the ICE: the exact crashing shape from #944
        // (generic enclosing type with an indexer) must compile cleanly and
        // never surface GS9998.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Repo[T] {
                private let _items List[T] = List[T]()
                func Add(item T) { _items.Add(item) }
                prop this[index int32] T {
                    get { return _items[index] }
                }
            }

            public var result = 1
            """;

        var (exitCode, output) = TryCompile(source);
        Assert.DoesNotContain("GS9998", output);
        Assert.Equal(0, exitCode);
    }

    [Fact]
    public void MalformedIndexer_MissingAccessorBody_ReportsCleanDiagnostic_NotIce()
    {
        // An indexer declared as an auto-property (no accessor body) is not a
        // supported shape. It must report the clean GS0371 diagnostic rather
        // than crashing with GS9998.
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Repo[T] {
                private let _items List[T] = List[T]()
                prop this[index int32] T
            }

            public var result = 1
            """;

        var (exitCode, output) = TryCompile(source);
        Assert.DoesNotContain("GS9998", output);
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0371", output);
    }

    private static int RunAndGetIntResult(string source)
    {
        var assembly = CompileToAssembly(source);
        var program = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var entry = program.GetMethod(
            "<Main>$",
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        var resultField = program.GetField(
            "result",
            BindingFlags.Public | BindingFlags.Static);

        entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
        return (int)resultField!.GetValue(null)!;
    }

    private static Assembly CompileToAssembly(string source)
    {
        var (exitCode, output, outPath) = CompileToFile(source);
        Assert.True(exitCode == 0, $"gsc failed:\n{output}");
        var bytes = File.ReadAllBytes(outPath);
        return Assembly.Load(bytes);
    }

    private static (int ExitCode, string Output) TryCompile(string source)
    {
        var (exitCode, output, _) = CompileToFile(source);
        return (exitCode, output);
    }

    private static (int ExitCode, string Output, string OutPath) CompileToFile(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue944_emit_").FullName;
        var srcPath = Path.Combine(tempDir, "test.gs");
        var outPath = Path.Combine(tempDir, "test.dll");
        File.WriteAllText(srcPath, source);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        int compileExit;
        try
        {
            compileExit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                srcPath,
            });
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        var output = compileOut.ToString() + compileErr.ToString();
        return (compileExit, output, outPath);
    }
}
