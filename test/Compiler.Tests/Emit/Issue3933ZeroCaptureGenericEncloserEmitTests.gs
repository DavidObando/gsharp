// <copyright file="Issue3933ZeroCaptureGenericEncloserEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3933 — root E of #3932's triage and the last ilverify finding
/// standing between migrated `src/Sdk/Gsharp.Runtime.Channels` and green.
/// A capture-free lambda lexically inside a <b>generic</b> type was hoisted to
/// a static method on the top-level `<Program>` host, which is
/// outside the encloser's accessibility domain, so reading the encloser's
/// `private` member emitted an unverifiable
/// `FieldAccess: Field is not visible` site and threw
/// (cref:FieldAccessException) at the first call.
/// @remarks #1469 established exactly this rule (host the lambda in a fieldless
/// display class nested inside the declaring type, as csc does with
/// `<>c`) and explicitly excluded generic enclosers, because a
/// nested type has to re-declare the encloser's type parameters and the
/// synthesis did not model that. #1512 had already taught the CAPTURING
/// sibling to do precisely that, via
/// `SynthesizedClosureReifier` — and that reification is driven from
/// `SynthesizeDisplayClass`, which both paths share. So the fix is to
/// stop excluding generic enclosers and let the zero-capture host go through
/// the machinery its neighbour has used since #1512.
///
/// One thing #1512's path did NOT have to answer: a capturing closure
/// always references the encloser's parameters through its own capture fields,
/// so signature-driven discovery finds them. A capture-free lambda need not —
/// it may reference only SOME of them (facet B below), or none at all
/// (#1469 facet C). Discovery alone therefore under-declares the nested host,
/// and the under-declared shape is invisible to ILVerify: facet C's
/// private-static call ILVERIFIES CLEAN and dies with
/// (cref:BadImageFormatException) at the first call. The encloser's own
/// type-parameter list is passed as a required seed for that reason.
///
/// Every facet COMPILES, ILVERIFIES, RUNS and asserts on behaviour, and
/// then reads the emitted metadata back, because "the host is nested in the
/// encloser rather than on `<Program>`, at the encloser's arity" is
/// an encoding fact no behavioural assertion can name.
///
/// Discrimination (ADR-0154): each facet carries a control that passed
/// BEFORE the fix — the same lambda on a NON-generic encloser, which #1469
/// already nested at arity 0 — so a mutant that nests unconditionally at the
/// wrong arity is caught as surely as one that never nests.
open class Issue3933ZeroCaptureGenericEncloserEmitTests {
    /// Facet A — the reported shape: a capture-free lambda inside a generic
    /// type reads that type's `private` instance field. Before the fix the
    /// lambda was hoisted to `<Program>`, generic-promoted by #2118
    /// so the access read `Node`1<!!T>::secret`, and threw
    /// (cref:FieldAccessException) on the first element.
    @Fact
    func CaptureFreeLambdaInsideGenericType_ReadsThePrivateFieldOfItsEncloser() {
        const source = `package Probe3933a
import System
import System.Linq
import System.Collections.Generic

class Node3933[T] {
    private let secret int32
    private let payload T
    init(s int32, p T) {
        secret = s
        payload = p
    }
    func SumVia() int32 {
        let items = List[Node3933[T]]()
        items.Add(Node3933[T](7, payload))
        items.Add(Node3933[T](35, payload))
        return items.Select((b Node3933[T]) -> b.secret).Sum()
    }
}

// Control: the identical lambda on a NON-generic encloser. #1469
// already nested this one, so it passed before the fix and must
// keep its arity-0 host after it.
class Plain3933 {
    private let secret int32
    init(s int32) {
        secret = s
    }
    func SumVia() int32 {
        let items = List[Plain3933]()
        items.Add(Plain3933(1))
        items.Add(Plain3933(2))
        return items.Select((b Plain3933) -> b.secret).Sum()
    }
}

func Main() {
    Console.WriteLine("generic=" + Node3933[string](0, "p").SumVia().ToString())
    Console.WriteLine("plain=" + Plain3933(0).SumVia().ToString())
    Console.WriteLine("done")
}`
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        // Behaviour: the lambda really read each element's private field, so
        // the sum is the two seeded values rather than a default.
        Assert.Contains("generic=42", lines)
        Assert.Contains("plain=3", lines)
        Assert.Equal("done", lines[^1])
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        // Encoding: the host is a nested type of the GENERIC encloser (which is
        // what puts it inside the accessibility domain) and re-declares the
        // encloser's single type parameter.
        Assert.Equal(1, SingleLambdaHostArity(reader, "Node3933`1"))
        // Control encoding: the non-generic encloser's host stays at arity 0.
        Assert.Equal(0, SingleLambdaHostArity(reader, "Plain3933"))
        // And neither lambda is left on `<Program>`, which is the placement
        // that produced the unverifiable access.
        Assert.Empty(ProgramLambdaMethodNames(reader))
    }

    /// Facet B — the encloser's type parameters that signature/body discovery
    /// does NOT find. A lambda inside `Pair`2` may mention only the second
    /// parameter, and a lambda may mention none at all (#1469 facet C). Both
    /// must still produce a host that re-declares the encloser's parameters
    /// positionally, so the encloser's arity is what the assertion pins.
    @Fact
    func CaptureFreeLambdaHost_RedeclaresTheEnclosersTypeParametersEvenWhenUnreferenced() {
        const source = `package Probe3933b
import System
import System.Linq
import System.Collections.Generic

class Pair3933[T, U] {
    private let left T
    private let right U
    init(l T, r U) {
        left = l
        right = r
    }
    // References only the SECOND type parameter.
    func RightVia() string {
        let items = List[Pair3933[T, U]]()
        items.Add(Pair3933[T, U](left, right))
        return items.Select((p Pair3933[T, U]) -> p.right.ToString()).First()
    }
    // References NEITHER: #1469 facet C's shape, which the old
    // top-level placement handled correctly and which must not
    // regress now that it is nested.
    func Plain() int32 {
        let nums = List[int32]()
        nums.Add(3)
        nums.Add(4)
        return nums.Select((n int32) -> n * 2).Sum()
    }
}

// Control: a generic METHOD on a non-generic type. The host takes
// the method's parameter, and the encloser contributes none.
class Holder3933 {
    private let secret int32
    init(s int32) {
        secret = s
    }
    func Pick[V](v V) string {
        let items = List[Holder3933]()
        items.Add(Holder3933(9))
        let via = items.Select((h Holder3933) -> h.secret).First()
        return v.ToString() + ":" + via.ToString()
    }
}

func Main() {
    let p = Pair3933[int32, string](1, "r")
    Console.WriteLine("right=" + p.RightVia())
    Console.WriteLine("plain=" + p.Plain().ToString())
    Console.WriteLine("pick=" + Holder3933(0).Pick[int32](5))
    Console.WriteLine("done")
}`
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        Assert.Contains("right=r", lines)
        Assert.Contains("plain=14", lines)
        Assert.Contains("pick=5:9", lines)
        Assert.Equal("done", lines[^1])
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        // Both of Pair`2's hosts declare TWO parameters — the one that mentions
        // only `U` and the one that mentions neither. Discovery on its own
        // would have produced 1 and 0.
        let pairHosts = LambdaHostArities(reader, "Pair3933`2")
        Assert.Equal(2, pairHosts.Count)
        Assert.All(pairHosts, (arity int32) -> Assert.Equal(2, arity))
        // Control: the non-generic encloser contributes nothing, so the host
        // carries only what the lambda itself needs — here nothing, because
        // the lambda's signature and body are `V`-free.
        Assert.Equal(0, SingleLambdaHostArity(reader, "Holder3933"))
        Assert.Empty(ProgramLambdaMethodNames(reader))
    }

    /// Facet C — the case ILVerify cannot see. The lambda's signature and
    /// return type are type-parameter free; the only tie to the encloser is a
    /// call to its `private shared` member, which names
    /// `Reg`1<!0>` in the body. A host reified from discovery alone
    /// is arity 0, so that `!0` has no slot — IL that ILVERIFIES CLEAN and
    /// throws (cref:BadImageFormatException) at the first call. Only the
    /// encloser-seeded arity makes it loadable.
    @Fact
    func CaptureFreeLambdaCallingAPrivateSharedMemberOfAGenericEncloser_Loads() {
        const source = `package Probe3933c
import System
import System.Linq
import System.Collections.Generic

class Reg3933[T] {
    shared {
        private func Bump(n int32) int32 -> n + 100
    }

    func Total() int32 {
        let nums = List[int32]()
        nums.Add(3)
        nums.Add(4)
        return nums.Select((n int32) -> Bump(n)).Sum()
    }
}

// Control: the same private-shared call from a NON-generic
// encloser, which #1469 already nested and which needs no arity.
class RegPlain3933 {
    shared {
        private func Bump(n int32) int32 -> n + 1000
    }

    func Total() int32 {
        let nums = List[int32]()
        nums.Add(3)
        nums.Add(4)
        return nums.Select((n int32) -> Bump(n)).Sum()
    }
}

func Main() {
    Console.WriteLine("generic=" + Reg3933[string]().Total().ToString())
    Console.WriteLine("plain=" + RegPlain3933().Total().ToString())
    Console.WriteLine("done")
}`
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        // 103 + 104 and 1003 + 1004: the private shared member really ran.
        Assert.Contains("generic=207", lines)
        Assert.Contains("plain=2007", lines)
        Assert.Equal("done", lines[^1])
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        Assert.Equal(1, SingleLambdaHostArity(reader, "Reg3933`1"))
        Assert.Equal(0, SingleLambdaHostArity(reader, "RegPlain3933"))
        Assert.Empty(ProgramLambdaMethodNames(reader))
    }

    /// Facet D — #2668's async extension of #1469, now on a generic encloser.
    /// A capture-free ASYNC lambda's kickoff becomes the host's `Invoke`
    /// and its state machine is nested one level deeper still, so this pins
    /// that the reified host is a legal home for a state machine as well as a
    /// method.
    @Fact
    func CaptureFreeAsyncLambdaInsideGenericType_KeepsItsPrivateAccess() {
        const source = `package Probe3933d
import System
import System.Linq
import System.Threading.Tasks
import System.Collections.Generic

class Async3933[T] {
    private let secret int32
    private let payload T
    init(s int32, p T) {
        secret = s
        payload = p
    }
    func Total() int32 {
        let items = List[Async3933[T]]()
        items.Add(Async3933[T](7, payload))
        items.Add(Async3933[T](35, payload))
        return items.Select(async func (b Async3933[T]) int32 {
            await Task.Yield()
            return b.secret
        }).Select((t Task[int32]) -> t.Result).Sum()
    }
}

// Control: #2668's original non-generic shape.
class AsyncPlain3933 {
    private let secret int32
    init(s int32) {
        secret = s
    }
    func Total() int32 {
        let items = List[AsyncPlain3933]()
        items.Add(AsyncPlain3933(1))
        items.Add(AsyncPlain3933(2))
        return items.Select(async func (b AsyncPlain3933) int32 {
            await Task.Yield()
            return b.secret
        }).Select((t Task[int32]) -> t.Result).Sum()
    }
}

func Main() {
    Console.WriteLine("generic=" + Async3933[string](0, "p").Total().ToString())
    Console.WriteLine("plain=" + AsyncPlain3933(0).Total().ToString())
    Console.WriteLine("done")
}`
        let lines = CompileVerifyAndRun(source, out var assemblyPath)
        // The await really resumed and the private read really happened.
        Assert.Contains("generic=42", lines)
        Assert.Contains("plain=3", lines)
        Assert.Equal("done", lines[^1])
        using let stream = File.OpenRead(assemblyPath)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        Assert.Equal(2, LambdaHostArities(reader, "Async3933`1").Count)
        Assert.All(LambdaHostArities(reader, "Async3933`1"), (arity int32) -> Assert.Equal(1, arity))
        Assert.All(LambdaHostArities(reader, "AsyncPlain3933"), (arity int32) -> Assert.Equal(0, arity))
        Assert.Empty(ProgramLambdaMethodNames(reader))
    }

    shared {
        /// Returns the generic-parameter count of the single synthesized
        /// zero-capture lambda host nested inside [`typeName`](paramref).
        /// @param reader The metadata reader.
        /// @param typeName The emitted encloser's metadata name.
        /// @returns The host type's generic-parameter count.
        private func SingleLambdaHostArity(reader MetadataReader, typeName string) int32 -> Assert.Single(
            LambdaHostArities(reader, typeName)
        )

        /// Returns the generic-parameter counts of every synthesized zero-capture
        /// lambda host nested inside [`typeName`](paramref).
        /// @param reader The metadata reader.
        /// @param typeName The emitted encloser's metadata name.
        /// @returns One arity per nested lambda host, in metadata order.
        private func LambdaHostArities(reader MetadataReader, typeName string) List[int32] {
            let encloser = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Single((t TypeDefinition) -> reader.GetString(t.Name) == typeName)
            return encloser
                .GetNestedTypes()
                .Select(reader.GetTypeDefinition)
                .Where(
                (t TypeDefinition) -> reader.GetString(t.Name).StartsWith("<lambda_host_", StringComparison.Ordinal)
            )
                .Select((t TypeDefinition) -> t.GetGenericParameters().Count)
                .ToList()
        }

        /// Returns the names of every lambda method still hoisted onto a
        /// `<Program>` host type — the placement whose accessibility
        /// domain is the defect.
        /// @param reader The metadata reader.
        /// @returns The hoisted lambda method names; empty when all are nested.
        private func ProgramLambdaMethodNames(reader MetadataReader) List[string] -> reader
            .TypeDefinitions
            .Select(reader.GetTypeDefinition)
            .Where((t TypeDefinition) -> reader.GetString(t.Name) == "<Program>")
            .SelectMany(
            func (t TypeDefinition) IEnumerable[MethodDefinitionHandle] {
                return t.GetMethods()
            }
        )
            .Select(reader.GetMethodDefinition)
            .Select((m MethodDefinition) -> reader.GetString(m.Name))
            .Where((n string) -> n.StartsWith("<lambda", StringComparison.Ordinal))
            .ToList()

        private func CompileVerifyAndRun(source string, out assemblyPath string)[]string {
            let tempDir = Directory.CreateTempSubdirectory("gs_3933_").FullName
            let srcPath = Path.Combine(tempDir, "Program.gs")
            File.WriteAllText(srcPath, source)
            let outPath = Path.Combine(tempDir, "Program.dll")
            assemblyPath = outPath
            let args = List[string]{"/out:" + outPath, "/target:exe", "/targetframework:net10.0", srcPath}
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var compileExit int32
            try {
                compileExit = Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
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
            using let proc Process? = Process.Start(psi)
            let stdout = proc!!.StandardOutput.ReadToEnd()
            let stderr = proc!!.StandardError.ReadToEnd()
            Assert.True(proc!!.WaitForExit(30_000), "dotnet exec timed out")
            Assert.True(proc!!.ExitCode == 0, (`sample exited ` + "${proc!!.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ReplaceLineEndings(Environment.NewLine).Split(
                Environment.NewLine,
                StringSplitOptions.RemoveEmptyEntries
            )
        }
    }
}
