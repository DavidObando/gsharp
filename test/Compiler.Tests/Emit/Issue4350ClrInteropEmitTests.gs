// <copyright file="Issue4350ClrInteropEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #4350: CLR interop shapes found by the Gsharp.Runtime.Values
/// self-migration. A ref-returning static CLR method auto-dereferences at the
/// use site (ADR-0056 §1), and an imported implicit conversion declared on the
/// SOURCE generic (`Span[T] -> ReadOnlySpan[T]`) is parented at the
/// symbolic TypeSpec rather than the erased `<object>` instance.
open class Issue4350ClrInteropEmitTests {
    @Fact
    func RefReturningStaticClrCalls_AutoDereference() {
        let source = `package P
import System
import System.Runtime.CompilerServices
import System.Runtime.InteropServices

class Box[T] {
    shared {
        func IsString(memory ReadOnlyMemory[T]) bool {
            var memory = memory
            return MemoryMarshal.TryGetString(Unsafe.As[ReadOnlyMemory[T], ReadOnlyMemory[char]](&memory), out _, out _, out _)
        }
    }
}

let arr = []int32{7, 8}
let first = MemoryMarshal.GetArrayDataReference(arr)
Console.WriteLine(first + 1)
var memory = ReadOnlyMemory[int32](arr)
let reinterpreted = Unsafe.As[ReadOnlyMemory[int32], ReadOnlyMemory[uint32]](&memory)
Console.WriteLine(reinterpreted.Length)
Console.WriteLine(Box[char].IsString("abc".AsMemory()))
Console.WriteLine(Box[int32].IsString(memory))`
        Assert.Equal(Lines("8", "2", "True", "False"), CompileAndRun(source))
    }

    @Fact
    func SourceDeclaredGenericImplicitConversions_UseSymbolicOwner() {
        let source = `package P
import System

class Box[T] {
    let items []T
    init(items []T) {
        this.items = items
    }

    func AsMemory() Memory[T] -> items.AsMemory()
    func AsReadOnlyMemory() ReadOnlyMemory[T] -> AsMemory()
    func Count() int32 {
        let span Span[T] = items.AsSpan()
        let view ReadOnlySpan[T] = span
        return view.Length
    }
}

let box = Box[string]([]string{"a", "b", "c"})
Console.WriteLine(box.AsReadOnlyMemory().Length)
Console.WriteLine(box.Count())`
        Assert.Equal(Lines("3", "3"), CompileAndRun(source))
    }

    @Fact
    func RefReturningImportedExtensionsAndStatics_StayAliasableAndWritable() {
        // Review question: auto-dereferencing a ref-returning imported call
        // must not lose its reference. The dereference is an lvalue, so a
        // `let ref` alias, a plain store and a compound store all go through
        // the returned reference, and a value read loads the pointee.
        let library = `namespace RefLib;
public static class Ext
{
    public static ref T First<T>(this T[] items) => ref items[0];
    public static ref int At(int[] items, int index) => ref items[index];
}`
        let source = `package P
import System
import RefLib

func run() {
    let xs = []int32{1, 2, 3}
    let ref alias = xs.First()
    alias = 10
    Console.WriteLine(xs[0])
    xs.First() = 20
    Console.WriteLine(xs[0])
    let ref at = Ext.At(xs, 2)
    at = 30
    Console.WriteLine(xs[2])
    Ext.At(xs, 1) += 5
    Console.WriteLine(xs[1])
    Console.WriteLine(xs.First() + Ext.At(xs, 2))
}

run()`
        let fixtureDirectory = Directory.CreateTempSubdirectory("gs_issue4350_reflib_").FullName
        try {
            Assert.Equal(
                Lines("10", "20", "30", "7", "50"),
                CompileAndRun(source, CompileCSharpLibrary(library, "RefLib", fixtureDirectory))
            )
        } finally {
            try {
                Directory.Delete(fixtureDirectory, recursive: true)
            } catch { }
        }
    }

    @Fact
    func MultiParameterImportedIndexers_ReadAndWrite() {
        // Nightly finding (#4350): cs2gs now keeps `slice[-1, true]`, so gsc
        // must bind a multi-parameter IMPORTED indexer — the runtime's
        // ref-returning `Slice<T>.this[int, bool]` and a C# setter indexer —
        // for reads, writes, and single-evaluation compound writes.
        let library = `namespace GridLib;
public sealed class Grid
{
    private readonly int[] cells = new int[6];
    public int Reads;
    public int this[int row, int column]
    {
        get { Reads++; return cells[(row * 3) + column]; }
        set => cells[(row * 3) + column] = value;
    }
}`
        let source = `package P
import System
import GridLib

func next(log Grid, value int32) int32 {
    log.Reads += 100
    return value
}

func run() {
    var s = slice[int32]{10, 20, 30}
    Console.WriteLine(s[1, true] + s[1, false])
    s[1, true] = 99
    s[0, false] += 5
    Console.WriteLine(String.Join(",", s))
    try {
        Console.WriteLine(s[-1, true])
    } catch (e IndexOutOfRangeException) {
        Console.WriteLine("ioor")
    }

    let grid = Grid()
    grid[1, 2] = 7
    grid[next(grid, 1), 2] += 3
    Console.WriteLine(grid[1, 2])
    Console.WriteLine(grid.Reads)
}

run()`
        let fixtureDirectory = Directory.CreateTempSubdirectory("gs_issue4350_gridlib_").FullName
        try {
            Assert.Equal(
                Lines("50", "15,20,99", "ioor", "10", "102"),
                CompileAndRun(source, CompileCSharpLibrary(library, "GridLib", fixtureDirectory))
            )
        } finally {
            try {
                Directory.Delete(fixtureDirectory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func CompileCSharpLibrary(source string, name string, directory string) string {
            let path = Path.Combine(directory, name + ".dll")
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
                .Select((p string) -> MetadataReference.CreateFromFile(p))
            let result = CSharpCompilation.Create(
                name,
                []SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
                .Emit(path)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            return path
        }

        private func Lines(lines ...string) string -> string.Concat(
            Array.ConvertAll(lines, (line string) -> (line + Environment.NewLine))
        )

        private func CompileAndRun(source string, references ...string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_issue4350_interop_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let outPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExit int32
                try {
                    let compileArgs = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0"}
                    for reference in references {
                        compileArgs.Add("/r:" + reference)
                        File.Copy(reference, Path.Combine(tempDir, Path.GetFileName(reference)), overwrite: true)
                    }
                    compileArgs.Add(srcPath)
                    compileExit = Program.Main(compileArgs.ToArray())
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outPath, additionalReferences: references)
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"))
                psi.ArgumentList.Add(outPath)
                using let proc = Process.Start(psi)!!
                let stdout = proc.StandardOutput.ReadToEnd()
                let stderr = proc.StandardError.ReadToEnd()
                Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out")
                Assert.True(proc.ExitCode == 0, (`exited ` + "${proc.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return stdout.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
