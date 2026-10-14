// <copyright file="Issue4591TupleOverNonRuntimeElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Text
import Xunit

/// Issue #4591: a tuple whose element is an imported type that is not a host
/// `RuntimeType` (`(int32, Type)`, `(int32, Uri)`, a tuple over
/// a class from a referenced library) got a poisoned CLR backing type, so an
/// array of it could not convert to `IEnumerable[(…)]`.
/// @remarks <b>The mechanism.</b> `TupleTypeSymbol.BuildClrType` closed the
/// HOST `typeof(ValueTuple<,>)` over the elements' CLR types. The
/// G# primitives (`int32`, `string`, `object`, …) are bound to
/// host `typeof(...)` literals, but every other imported type is loaded
/// through the compiler's `MetadataLoadContext`. Given one such argument,
/// `RuntimeType.MakeGenericType` does not throw: it silently returns a
/// `System.Reflection.Emit.TypeBuilderInstantiation`, whose
/// `GetInterfaces` and member lookups throw
/// (cref:NotSupportedException) ("Not supported in a non-reflected
/// type"). This is the mechanism #4015 fixed for `map[K, V]` at its emit
/// sites; for a tuple the poisoned type is the symbol's own
/// `ClrType`, so the binder trips over it first.
///
/// <b>How it surfaced.</b> The self-migrated
/// `Issue4313ReferenceReceiverCallvirtTests` passes
/// `[](OpCode, Method MethodBase?)` to xunit's `Assert.Single`. The
/// generic `Single<T>(IEnumerable<T>)` became inapplicable, so
/// overload resolution silently chose the non-generic
/// `Single(IEnumerable)` returning `object`, and the following
/// `call.Item1` / `call.Item2` reported GS0158. A plain
/// conversion of the same array to `IEnumerable[(int32, Type)]` was an
/// internal compiler error (GS9998).
///
/// <b>The fix.</b> When every non-host element provably belongs to one
/// load context, the tuple is closed in that context: the matching
/// `ValueTuple`N` (and, for a nullable value-type element, the
/// `Nullable<>`) is resolved from that context's core assembly and
/// any host primitive element is remapped into it (the same rule
/// `MemberLookup.ResolveErasedValueTupleOpenDefinition` already applied
/// to erased inference shapes). A function-type element's own
/// `Func<…>` is a host instantiation over imported types, so its
/// parts decide the context and it is rebuilt there. Every shape whose
/// context cannot be proven keeps the previous host construction exactly.
///
/// <b>Discrimination witness (ADR-0154).</b> Reverting
/// `src/Core/CodeAnalysis/Symbols/TupleTypeSymbol.cs` and
/// `src/Core/CodeAnalysis/Binding/MemberLookup.cs` to their parent
/// state fails every `TupleOverANonRuntimeElement_CompilesVerifiesAndRuns`
/// row (GS9998 or GS0158/GS0159) and leaves every
/// `AGreenNeighbour_CompilesVerifiesAndRuns` row passing.
open class Issue4591TupleOverNonRuntimeElementTests {
    /// Each failing row now compiles, verifies, and prints the expected lines.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("FailingCases")
    func TupleOverANonRuntimeElement_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    /// The neighbours that always worked keep working, and print what they
    /// always printed.
    /// @param name The case name.
    /// @param source The G# source.
    /// @param expectedLines The expected stdout lines, in order.
    @Theory
    @MemberData("GreenNeighbours")
    func AGreenNeighbour_CompilesVerifiesAndRuns(
        name string,
        source string,
        expectedLines[]string
    ) -> CompileVerifyAndRun(name, source, expectedLines)

    shared {
        /// Timeout for running an emitted sample.
        private const RunTimeout int32 = 60_000

        /// The C# library the imported rows link against. `Picker` mirrors
        /// the overload set of xunit's `Assert.Single`: a generic
        /// `IEnumerable<T>` overload next to a non-generic
        /// `IEnumerable` one, so a lost generic candidate is observable as
        /// the wrong overload rather than as a missing function.
        private const LibrarySource string = `using System.Collections;
using System.Collections.Generic;

namespace HelperLib;

public class ImportedBase
{
    public string Name { get; set; } = "base";
}

public struct ImportedPoint
{
    public int X { get; set; }

    public int Y { get; set; }
}

public interface IImportedShape
{
    string Shape { get; }
}

public sealed class Square : IImportedShape
{
    public string Shape => "square";
}

public static class Picker
{
    public static T Single<T>(IEnumerable<T> items)
    {
        T? found = default;
        var count = 0;
        foreach (var item in items)
        {
            found = item;
            count++;
        }

        return count == 1 ? found! : throw new System.InvalidOperationException("not single");
    }

    public static object? Single(IEnumerable items) => null;

    public static int Count<T>(IEnumerable<T> items)
    {
        var count = 0;
        foreach (var unused in items)
        {
            count++;
        }

        return count;
    }
}`

        /// The rows that failed before the fix. Every one is a tuple with at least
        /// one element whose `ClrType` is not a host `RuntimeType`.
        /// @returns Case name, G# source, expected stdout lines.
        func FailingCases() sequence[[]object] {
            // The GS9998 crash: no imported library involved at all, only a BCL
            // class (`System.Type`) in the tuple.
            yield[]object{"bcl-class-element-to-ienumerable", `package P
import System
import System.Collections.Generic
import System.Linq

let xs = [](int32, Type){(1, typeof(string)), (2, typeof(int32))}
let e IEnumerable[(int32, Type)] = xs
Console.WriteLine(e.Count())`, []string{"2"}}
            // The same crash through a read-only list interface.
            yield[]object{"bcl-class-element-to-ireadonlylist", `package P
import System
import System.Collections.Generic

let xs = [](int32, Uri){(7, Uri("https://example.org/"))}
let e IReadOnlyList[(int32, Uri)] = xs
Console.WriteLine(e[0].Item2.Host)`, []string{"example.org"}}
            // The migrated Issue4313 shape: inference against an imported generic
            // that has a non-generic sibling overload. Before the fix the generic
            // candidate dropped out, the `object?` overload won, and `.Item1`
            // reported GS0158.
            yield[]object{"inference-picks-the-generic-overload-named-tuple", `package P
import System
import HelperLib

let calls = [](Code int32, Method Type?){(3, typeof(string))}
let call = Picker.Single(calls)
Console.WriteLine(call.Item1)
Console.WriteLine(call.Item2!!.Name)
Console.WriteLine(call.Method!!.Name)`, []string{"3", "String", "String"}}
            // A class from the referenced library (not in the core assembly).
            yield[]object{"imported-library-class-element", `package P
import System
import HelperLib

let pairs = [](int32, ImportedBase){(5, ImportedBase{Name: "five"})}
let pair = Picker.Single(pairs)
Console.WriteLine(pair.Item1)
Console.WriteLine(pair.Item2.Name)`, []string{"5", "five"}}
            // An imported INTERFACE element, which has no base-type chain to find
            // its load context through.
            yield[]object{"imported-library-interface-element", `package P
import System
import HelperLib

let pairs = [](int32, IImportedShape){(9, Square{})}
Console.WriteLine(Picker.Count(pairs))
let pair = Picker.Single(pairs)
Console.WriteLine(pair.Item2.Shape)`, []string{"1", "square"}}
            // Arity nine: the CLR shape nests a `TRest` ValueTuple, and the
            // imported elements live in that rest node, so the recursion has to
            // build it in the same load context as the outer node.
            yield[]object{"arity-nine-imported-elements-in-the-rest-node", `package P
import System
import System.Collections.Generic
import System.Linq
import HelperLib

let xs = [](int32, int32, int32, int32, int32, int32, int32, Uri, Uri){
    (1, 2, 3, 4, 5, 6, 7, Uri("https://a.example/"), Uri("https://b.example/")),
}
let e IEnumerable[(int32, int32, int32, int32, int32, int32, int32, Uri, Uri)] = xs
Console.WriteLine(e.Count())
let one = Picker.Single(xs)
Console.WriteLine(one.Item1)
Console.WriteLine(one.Item9.Host)`, []string{"1", "1", "b.example"}}
            // A direct imported element next to a function type over an imported
            // type. The function type's own `Func<Uri, int32>` is a host
            // instantiation over a context type; its parts decide the context, so
            // the tuple is rebuilt there instead of falling back to a host tuple
            // over the context `Uri`.
            yield[]object{"imported-element-beside-a-function-over-an-imported-type", `package P
import System
import System.Collections.Generic
import System.Linq
import HelperLib

let xs = [](Uri, (Uri) -> int32){(Uri("https://example.org:8443/"), (u Uri) -> u.Port)}
let e IEnumerable[(Uri, (Uri) -> int32)] = xs
Console.WriteLine(e.Count())
let one = Picker.Single(xs)
Console.WriteLine(one.Item2(one.Item1))`, []string{"1", "8443"}}
            // A NULLABLE imported value type. Its `Nullable<T>` used to be built
            // from the host `typeof(Nullable<>)` before the tuple ever saw it, an
            // instantiation that is already poisoned (the #4035 trap), so the
            // wrapper has to be built in the context too.
            yield[]object{"nullable-bcl-struct-element-to-ienumerable", `package P
import System
import System.Collections.Generic
import System.Linq

let xs = [](int32, DateTime?){(1, DateTime(2020, 1, 2)), (2, nil)}
let e IEnumerable[(int32, DateTime?)] = xs
Console.WriteLine(e.Count())
Console.WriteLine(e.Last().Item2.HasValue)`, []string{"2", "False"}}
            yield[]object{"nullable-library-struct-element-inference", `package P
import System
import HelperLib

let pairs = [](int32, ImportedPoint?){(6, ImportedPoint{X: 3, Y: 4})}
let pair = Picker.Single(pairs)
Console.WriteLine(pair.Item1)
Console.WriteLine(pair.Item2!!.X)`, []string{"6", "3"}}
        }

        /// Neighbours that always worked: tuples over host primitives only, and
        /// non-tuple containers of a non-runtime element.
        /// @returns Case name, G# source, expected stdout lines.
        func GreenNeighbours() sequence[[]object] {
            yield[]object{"primitive-only-tuple", `package P
import System
import HelperLib

let xs = [](int32, string){(4, "four")}
let x = Picker.Single(xs)
Console.WriteLine(x.Item1)
Console.WriteLine(x.Item2)`, []string{"4", "four"}}
            yield[]object{"array-of-non-runtime-element", `package P
import System
import HelperLib

let xs = []Type{typeof(string)}
Console.WriteLine(Picker.Single(xs).Name)`, []string{"String"}}
            yield[]object{"tuple-literal-construction-and-read", `package P
import System

let t = (1, typeof(string))
Console.WriteLine(t.Item2.Name)`, []string{"String"}}
            // A function-type element over an imported type, through LINQ. This
            // is the code-exploder migration's shape (`tools.Select(...)`,
            // `tools.FirstOrDefault(...)`), which an earlier draft of the fix
            // broke by making the tuple symbolic.
            yield[]object{"function-type-element-through-linq", `package P
import System
import System.Linq

let tools = [](Name string, Handler (Uri) -> int32){("a", (u Uri) -> u.Port)}
let tool = tools.FirstOrDefault((t (Name string, Handler (Uri) -> int32)) -> t.Name == "a")
Console.WriteLine(tool.Handler(Uri("https://example.org:8443/")))
let names = tools.Select((t (Name string, Handler (Uri) -> int32)) -> t.Name).ToArray()
Console.WriteLine(names[0])`, []string{"8443", "a"}}
            // Explicit type arguments bypass inference and already bound before the
            // fix; kept so the context-aware construction cannot regress them.
            yield[]object{"explicit-type-arguments", `package P
import System
import HelperLib

let xs = [](int32, Version){(1, Version(1, 2))}
Console.WriteLine(Picker.Count[(int32, Version)](xs))`, []string{"1"}}
        }

        private func CompileVerifyAndRun(name string, source string, expectedLines[]string) {
            let tempDir = Directory.CreateTempSubdirectory("gs_4591_").FullName
            try {
                let libPath = CompileCSharpLibrary(tempDir)
                let appPath = Path.Combine(tempDir, name + ".dll")
                let appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath)
                Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal)
                Assert.DoesNotContain(" error ", appLog, StringComparison.Ordinal)
                Assert.True(File.Exists(appPath), (`'` + "$name" + `' must compile. Log:
` + "$appLog"))
                IlVerifier.Verify(appPath, []string{libPath})
                let (exit, output) = RunDotnet(appPath)
                Assert.True(exit == 0, (`'` + "$name" + `' must run to completion. Exit ` + "$exit" + `:
` + "$output"))
                let lines = output
                    .Split('\n')
                    .Select((line string) -> line.TrimEnd('\r'))
                    .Where((line string) -> line.Length > 0)
                    .ToArray()
                Assert.Equal(expectedLines, lines)
            } finally {
                Directory.Delete(tempDir, recursive: true)
            }
        }

        private func CompileCSharpLibrary(tempDir string) string {
            let references = TrustedPlatformAssemblies().Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
                .ToList()
            let compilation = CSharpCompilation.Create(
                "HelperLib",
                []SyntaxTree{CSharpSyntaxTree.ParseText(LibrarySource)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                    NullableContextOptions.Enable
                )
            )
            let libPath = Path.Combine(tempDir, "HelperLib.dll")
            let result = compilation.Emit(libPath)
            Assert.True(
                result.Success,
                "the C# library must compile:\n" + string.Join(
                    "\n",
                    result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
                )
            )
            return libPath
        }

        // Compiles against the targeting pack (`/targetframework` only, no
        // runtime-assembly references), which is how the self-migrated projects
        // and the original repro are compiled: BCL classes such as `System.Type`
        // then load through the compiler's MetadataLoadContext.
        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func RunDotnet(assemblyPath string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", "\"$assemblyPath\""){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? "."
            }
            using let process = Process.Start(psi) ?? throw InvalidOperationException("could not start dotnet")
            let stdout = process.StandardOutput.ReadToEndAsync()
            let stderr = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(RunTimeout) {
                try {
                    process.Kill(entireProcessTree: true)
                } catch (InvalidOperationException) {
                    // The process exited between the timeout and the kill.

                }
                return (-1, "timed out after ${RunTimeout / 1000}s.")
            }
            let output = StringBuilder()
            output.Append(stdout.GetAwaiter().GetResult())
            output.Append(stderr.GetAwaiter().GetResult())
            return (process.ExitCode, output.ToString())
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string
            if string.IsNullOrEmpty(tpa) {
                return Enumerable.Empty[string]()
            }
            return tpa.Split(Path.PathSeparator).Where(File.Exists)
        }
    }
}
