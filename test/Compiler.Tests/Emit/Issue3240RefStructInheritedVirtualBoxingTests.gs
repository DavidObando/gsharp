// <copyright file="Issue3240RefStructInheritedVirtualBoxingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Diagnostics
import System.IO
import System.Linq
import Xunit

/// Issue #3240: inherited CLR instance methods on a by-ref-like receiver require
/// illegal boxing and must be rejected before an assembly is emitted.
class Issue3240RefStructInheritedVirtualBoxingTests {
    @Theory
    @MemberData("InheritedCalls")
    func InheritedObjectMethod_OnRefStruct_ReportsBoxingAtCallAndDoesNotEmit(call string) {
        let source = (`ref struct Bare {
    var id int32
}

func Run() {
    var b = Bare{id: 42}
    var result = ` + "$call" + `
}
Run()`)
        AssertRejectedWithoutAssembly(
            source,
            call[(call.IndexOf('.', StringComparison.Ordinal) + 1) ..],
            "invoke inherited method '${MethodName(call)}' because dispatch requires boxing the receiver"
        )
    }

    @Fact
    func InheritedObjectMethod_OnConstructedGenericRefStruct_ReportsBoxing() {
        const Source = `ref struct Bare[T any] {
    var value T
}

func Run() {
    var b = Bare[int32]{value: 42}
    var result = b.ToString()
}
Run()`
        AssertRejectedWithoutAssembly(
            Source,
            "ToString()",
            "invoke inherited method 'ToString' because dispatch requires boxing the receiver"
        )
    }

    @Fact
    func InheritedObjectMethod_OnImportedRefStruct_ReportsBoxing() {
        const Source = `import System

func Run() {
    var values []int32 = []int32{11, 22}
    var span ReadOnlySpan[int32] = values
    var result = span.GetType()
}
Run()`
        AssertRejectedWithoutAssembly(
            Source,
            "GetType()",
            "invoke inherited method 'GetType' because dispatch requires boxing the receiver"
        )
    }

    @Fact
    func RefStructConversionToUserInterface_ReportsExistingBoxingDiagnostic() {
        const Source = `interface Marker {
    func Mark() string;
}

ref struct Bare : Marker {
    var id int32
    func Mark() string -> "marker-55"
}

func Run() {
    var b = Bare{id: 42}
    var marker Marker = b
}
Run()`
        AssertRejectedWithoutAssembly(Source, "b", "be boxed or converted to the reference type 'Marker'")
    }

    @Fact
    func InferredRefStructGenericArgument_ReportsExistingGenericArgumentDiagnostic() {
        const Source = `ref struct Bare {
    var id int32
}

func Use[T any](value T) {
    var text = value.ToString()
}

func Run() {
    var b = Bare{id: 42}
    Use(b)
}
Run()`
        AssertRejectedWithoutAssembly(Source, "Use", "be used as a generic type argument")
    }

    @Fact
    func InferredRefStructGenericInstanceMethodArgument_ReportsExistingGenericArgumentDiagnostic() {
        const Source = `ref struct Bare {
    var id int32
}

class Host {
    func Use[T any](value T) {
        var text = value.ToString()
    }
}

func Run() {
    var b = Bare{id: 42}
    var host = Host()
    host.Use(b)
}
Run()`
        AssertRejectedWithoutAssembly(Source, "Use", "be used as a generic type argument")
    }

    @Fact
    func InferredRefStructGenericExtensionArgument_ReportsExistingGenericArgumentDiagnostic() {
        const Source = `ref struct Bare {
    var id int32
}

func (host string) Use[T any](value T) {
    var text = value.ToString()
}

func Run() {
    var b = Bare{id: 42}
    "host".Use(b)
}
Run()`
        AssertRejectedWithoutAssembly(Source, "Use", "be used as a generic type argument")
    }

    @Fact
    func InheritedMethodGroup_OnRefStruct_ReportsBoxing() {
        const Source = `ref struct Bare {
    var id int32
}

func Run() {
    var b = Bare{id: 42}
    let f () -> string = b.ToString
}
Run()`
        AssertRejectedWithoutAssembly(
            Source,
            "b.ToString",
            "be captured as a delegate target because that requires boxing the receiver"
        )
    }

    @Fact
    func DeclaredMethodGroup_OnRefStruct_ReportsBoxing() {
        const Source = `ref struct Bare {
    var id int32
    func Get() int32 -> id
}

func Run() {
    var b = Bare{id: 42}
    let f () -> int32 = b.Get
}
Run()`
        AssertRejectedWithoutAssembly(
            Source,
            "b.Get",
            "be captured as a delegate target because that requires boxing the receiver"
        )
    }

    @Fact
    func UserExtensionMethodGroup_OnImportedRefStruct_ReportsBoxing() {
        const Source = `import System

func (span ReadOnlySpan[int32]) Ext() int32 -> span.Length

func Run() {
    var values []int32 = []int32{11, 22}
    var span ReadOnlySpan[int32] = values
    let f () -> int32 = span.Ext
}
Run()`
        AssertRejectedWithoutAssembly(
            Source,
            "span.Ext",
            "be captured as a delegate target because that requires boxing the receiver"
        )
    }

    @Fact
    func ImportedExtensionMethodGroup_OnImportedRefStruct_ReportsBoxing() {
        const Source = `import System

func Run() {
    var span ReadOnlySpan[char] = " "
    let f () -> bool = span.IsWhiteSpace
}
Run()`
        AssertRejectedWithoutAssembly(
            Source,
            "span.IsWhiteSpace",
            "be captured as a delegate target because that requires boxing the receiver"
        )
    }

    @Fact
    func DeclaredObjectMethods_OnRefStruct_RemainDirectCalls() {
        const Source = `import System

ref struct Bare {
    var id int32
    override func ToString() string -> "declared-11"
    override func GetHashCode() int32 -> 22
    override func Equals(value object) bool -> true
    func GetType() string -> "declared-44"
}

func Run() {
    var b = Bare{id: 42}
    var other object = "other"
    Console.WriteLine(b.ToString())
    Console.WriteLine(b.GetHashCode())
    Console.WriteLine(b.Equals(other))
    Console.WriteLine(b.GetType())
    Console.WriteLine("implicit=${b}")
}
Run()`
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "declared-11",
                "22",
                "True",
                "declared-44",
                "implicit=declared-11",
                string.Empty
            ),
            CompileAndRun(Source).StandardOutput
        )
    }

    @Fact
    func InheritedObjectMethods_OnPlainStruct_RemainCallable() {
        const Source = `import System

struct Plain {
    var id int32
}

func Run() {
    var value = Plain{id: 42}
    Console.WriteLine(value.ToString())
    Console.WriteLine(value.GetHashCode())
    Console.WriteLine(value.Equals(nil))
    Console.WriteLine(value.GetType().FullName)
}
Run()`
        let lines = CompileAndRun(Source).StandardOutput.Split(
            Environment.NewLine,
            StringSplitOptions.RemoveEmptyEntries
        )
        Assert.Equal(4, lines.Length)
        Assert.Equal("Default.Plain", lines[0])
        Assert.True(int32.TryParse(lines[1], out _), "Expected integer hash code, got '${lines[1]}'.")
        Assert.Equal("False", lines[2])
        Assert.Equal("Default.Plain", lines[3])
    }

    @Fact
    func ImportedRefStructDeclaredMethod_AndUserInterfaceMethod_RemainDirectCalls() {
        const Source = `import System

interface Marker {
    func Mark() string;
}

ref struct Bare : Marker {
    var id int32
    func Mark() string -> "marker-55"
}

func Run() {
    var values []int32 = []int32{11, 22}
    var span ReadOnlySpan[int32] = values
    var bare = Bare{id: 42}
    Console.WriteLine(span.ToString())
    Console.WriteLine(bare.Mark())
}
Run()`
        Assert.Equal(
            string.Join(Environment.NewLine, "System.ReadOnlySpan<Int32>[2]", "marker-55", string.Empty),
            CompileAndRun(Source).StandardOutput
        )
    }

    shared {
        prop InheritedCalls TheoryData[string] -> TheoryData[string]{
            "b.ToString()",
            "b.GetHashCode()",
            "b.Equals(nil)",
            "b.GetType()"
        }

        private func AssertRejectedWithoutAssembly(source string, expectedSpan string, expectedReason string) {
            let root = Path.Combine(Environment.CurrentDirectory, ".issue3240-${Guid.NewGuid():N}")
            Directory.CreateDirectory(root)
            let sourcePath = Path.Combine(root, "probe.gs")
            let assemblyPath = Path.Combine(root, "probe.dll")
            File.WriteAllText(sourcePath, source)
            try {
                let compile = CaptureConsole(
                    () -> Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                )
                let runtime = if compile.ExitCode == 0 && File.Exists(assemblyPath) {
                    RunAssembly(assemblyPath)
                } else {
                    default((ExitCode int32, StandardOutput string, StandardError string))
                }
                Assert.True(
                    compile.ExitCode != 0,
                    "Expected compile rejection, got compile rc=0; run rc=${runtime.ExitCode}; stdout=[${runtime.StandardOutput}]; stderr=[${runtime.StandardError}]."
                )
                Assert.Contains("error GS0219:", compile.StandardOutput, StringComparison.Ordinal)
                Assert.Equal("Failed.${Environment.NewLine}", compile.StandardError)
                Assert.False(File.Exists(assemblyPath), "Compiler must not write an assembly after GS0219.")
                let tree = SyntaxTree.Parse(SourceText.From(source, "issue3240.gs"))
                let compilation = Compilation(tree)
                using let peStream = MemoryStream()
                let emit = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue3240")
                let diagnostic = Assert.Single(emit.Diagnostics.Where((candidate Diagnostic) -> candidate.IsError))
                Assert.False(emit.Success)
                Assert.Equal("GS0219", diagnostic.Id)
                Assert.Contains(expectedReason, diagnostic.Message, StringComparison.Ordinal)
                Assert.Equal(expectedSpan, diagnostic.Location.Text!!.ToString(diagnostic.Location.Span))
                Assert.Equal(int64(0), peStream.Length)
            } finally {
                Directory.Delete(root, recursive: true)
            }
        }

        private func CompileAndRun(source string)(ExitCode int32, StandardOutput string, StandardError string) {
            let root = Path.Combine(Environment.CurrentDirectory, ".issue3240-${Guid.NewGuid():N}")
            Directory.CreateDirectory(root)
            let sourcePath = Path.Combine(root, "control.gs")
            let assemblyPath = Path.Combine(root, "control.dll")
            File.WriteAllText(sourcePath, source)
            try {
                let compile = CaptureConsole(
                    () -> Program.Main(
                        []string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                )
                Assert.Equal(0, compile.ExitCode)
                Assert.Equal(string.Empty, compile.StandardError)
                Assert.True(File.Exists(assemblyPath), "Expected control assembly.")
                let runtime = RunAssembly(assemblyPath)
                Assert.Equal(0, runtime.ExitCode)
                Assert.Equal(string.Empty, runtime.StandardError)
                return runtime
            } finally {
                Directory.Delete(root, recursive: true)
            }
        }

        private func RunAssembly(assemblyPath string)(ExitCode int32, StandardOutput string, StandardError string) {
            using let process Process? = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {"exec", assemblyPath},
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            )
            Assert.NotNull(process)
            let standardOutput = process!!.StandardOutput.ReadToEndAsync()
            let standardError = process!!.StandardError.ReadToEndAsync()
            Assert.True(process!!.WaitForExit(30_000), "Timed out running emitted assembly.")
            return (process!!.ExitCode, standardOutput.GetAwaiter().GetResult(), standardError.GetAwaiter().GetResult())
        }

        private func CaptureConsole(action() -> int32)(ExitCode int32, StandardOutput string, StandardError string) {
            using let standardOutput = StringWriter()
            using let standardError = StringWriter()
            let previousOutput = Console.Out
            let previousError = Console.Error
            Console.SetOut(standardOutput)
            Console.SetError(standardError)
            try {
                return (action(), standardOutput.ToString(), standardError.ToString())
            } finally {
                Console.SetOut(previousOutput)
                Console.SetError(previousError)
            }
        }

        private func MethodName(call string) string {
            let dot = call.IndexOf('.', StringComparison.Ordinal)
            let open_ = call.IndexOf('(', dot + 1)
            return call[(dot + 1) .. open_]
        }
    }
}
