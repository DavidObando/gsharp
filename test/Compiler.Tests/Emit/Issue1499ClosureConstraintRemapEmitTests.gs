// <copyright file="Issue1499ClosureConstraintRemapEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit

/// Issue #1499 — when a lambda is reified into a GENERIC synthesized closure /
/// capture-box class (generic over captured enclosing type parameters, per
/// #1477), the cloned closure type parameters must REMAP self-/cross-referential
/// generic constraints onto the clone set. A constraint such as
/// `TKey IComparable[TKey]` copied onto the closure clone previously still
/// referenced the ORIGINAL `TKey` (out of scope inside the reified class),
/// so the emitted `GenericParamConstraint` was unsatisfiable at the capture
/// site (`UnsatisfiedMethodParentInst`/`UnsatisfiedFieldParentInst`)
/// and the constrained member call inside the closure's `Invoke` erased its
/// constraint type argument to `object`
/// (`StackUnexpected [found value 'TKey'][expected ref 'object']`).
///
/// The fix is a two-pass clone in `SynthesizedClosureReifier` that
/// substitutes the original → clone type-parameter map into every cloned
/// constraint, plus preserving the constrained-call metadata through
/// `BoundTreeRewriter.RewriteImportedInstanceCallExpression` (which the
/// closure lowering invokes) so the lambda body still binds to the GENERIC
/// interface method (`IComparable[T].CompareTo(T)`, no box) rather than the
/// non-generic `object` overload.
///
/// Each facet ilverifies clean and runs; the controls (unconstrained captured
/// TP, non-generic user-interface constraint) must not regress.
open class Issue1499ClosureConstraintRemapEmitTests {
    @Theory
    @InlineData(true, false, "A, R ICollection[A]", "int, List<int>", "A,R")
    @InlineData(false, false, "A, R ICollection[A]", "int, List<int>", "A,R")
    @InlineData(false, false, "A, B ICollection[A], R B", "int, List<int>, List<int>", "A,B,R")
    @InlineData(false, true, "R ICollection[A], A", "List<int>, int", "Owner,R,A")
    func CapturedConstraintDependenciesBelongToTheGeneratedType(
        expression bool,
        nested bool,
        parameters string,
        arguments string,
        expectedParameters string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let result = if expression {
            "Expression[Func[int32]] -> () -> value.Count"
        } else {
            "() -> R -> () -> value"
        }
        let owner = if nested {
            "Reader[Owner]"
        } else {
            "Reader"
        }
        let library = fixture.Compile(`package CapturedReader
import System.Collections.Generic
import System.Linq.Expressions
import System
public class OWNER {
    shared {
        public func Read[PARAMETERS](value R) RESULT
    }
}`.Replace("OWNER", owner).Replace("PARAMETERS", parameters).Replace("RESULT", result), "CapturedReader", false)
        VerifyStrict(library)
        let runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        using let metadata = MetadataLoadContext(
            PathAssemblyResolver(Directory.GetFiles(runtimeDirectory, "*.dll").Append(library)),
            "System.Private.CoreLib"
        )
        let box = Assert.Single(
            metadata.LoadFromAssemblyPath(library).GetTypes().Where((type Type) -> type.Name.Contains("__Box_"))
        )
        let cloned = box.GetGenericArguments()
        Assert.Equal(expectedParameters.Split(','), cloned.Select((type Type) -> type.Name).ToArray())
        let captured = cloned.Single((type Type) -> type.Name == "R")
        Assert.Equal(captured, box.GetField("Value")!!.FieldType)
        for parameter in cloned {
            Assert.Equal(box, parameter.DeclaringType)
            Assert.Null(parameter.DeclaringMethod)
            if parameter.Name == "R" || parameter.Name == "B" {
                let constraint = Assert.Single(parameter.GetGenericParameterConstraints())
                let dependency = if constraint.IsGenericParameter {
                    constraint
                } else {
                    Assert.Single(constraint.GetGenericArguments())
                }
                Assert.Equal(box, dependency.DeclaringType)
                Assert.Null(dependency.DeclaringMethod)
                Assert.Equal(
                    if parameter.Name == "R" && expectedParameters.Contains("B") {
                        "B"
                    } else {
                        "A"
                    },
                    dependency.Name
                )
            } else {
                Assert.Empty(parameter.GetGenericParameterConstraints())
            }
        }
        let reader = if nested {
            "Reader<string>"
        } else {
            "Reader"
        }
        let observe = if expression {
            `var read = READER.Read<ARGUMENTS>(values).Compile();
return read() + "," + AddAndRead(values, read);`
        } else {
            `var read = READER.Read<ARGUMENTS>(values);
var first = read();
values.Add(3);
return ReferenceEquals(values, first) + "," + read().Count;`
        }
        let consumer = fixture.CompileCSharp(`using System;
using System.Collections.Generic;
using CapturedReader;
namespace CaptureConsumer;
public static class Consumer {
    public static string Run() {
        var values = new List<int> { 1, 2 };
        OBSERVE
    }
    private static int AddAndRead(List<int> values, Func<int> read) {
        values.Add(3);
        return read();
    }
}`.Replace("OBSERVE", observe).Replace("READER", reader).Replace("ARGUMENTS", arguments), "Consumer", library)
        VerifyStrict(consumer, library)
        let app = fixture.Compile(
            "import System\nimport CaptureConsumer\nConsole.Write(Consumer.Run())",
            "CaptureApp",
            true,
            "/reference:" + consumer,
            "/reference:" + library
        )
        VerifyStrict(app, consumer, library)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                if expression {
                    "2,3"
                } else {
                    "True,3"
                }
            ),
            fixture.RunBytes(app)
        )
    }

    @Fact
    func EndToEnd_SelfReferentialIComparableConstraint_ConstrainedCallInClosure_Runs() {
        let source = `package Issue1499Cmp
import System
class C {
    shared {
        func Make[TResult, TKey IComparable[TKey]](keySelector (TResult) -> TKey) (TResult, TResult) -> int32 ->
            (x TResult, y TResult) -> keySelector(x).CompareTo(keySelector(y))
    }
}
func Main() {
    let f = C.Make[int32, int32]((v int32) -> v)
    System.Console.WriteLine(f(3, 5))
    System.Console.WriteLine(f(5, 3))
    System.Console.WriteLine(f(4, 4))
}`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}1${Environment.NewLine}0${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_SelfReferentialIEquatableConstraint_EqualsCallInClosure_Runs() {
        let source = `package Issue1499Eq
import System
class C {
    shared {
        func Make[TResult, TKey IEquatable[TKey]](keySelector (TResult) -> TKey) (TResult, TResult) -> bool ->
            (x TResult, y TResult) -> keySelector(x).Equals(keySelector(y))
    }
}
func Main() {
    let f = C.Make[int32, int32]((v int32) -> v)
    System.Console.WriteLine(f(4, 4))
    System.Console.WriteLine(f(4, 5))
}`
        let output = CompileAndRun(source)
        Assert.Equal("True${Environment.NewLine}False${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_TwoCapturedTypeParameters_SecondSelfReferentiallyConstrained_Runs() {
        let source = `package Issue1499TwoTp
import System
class C {
    shared {
        func Make[T, U IComparable[U]](sel (T) -> U) (T, T) -> int32 ->
            (a T, b T) -> sel(a).CompareTo(sel(b))
    }
}
func Main() {
    let f = C.Make[string, int32]((s string) -> s.Length)
    System.Console.WriteLine(f("aa", "bbbb"))
    System.Console.WriteLine(f("xxxxx", "y"))
}`
        let output = CompileAndRun(source)
        Assert.Equal("-1${Environment.NewLine}1${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_UnconstrainedCapturedTypeParameter_Control_Runs() {
        let source = `package Issue1499Unconstrained
import System
class C {
    shared {
        func Make[T](item T) () -> T ->
            () -> item
    }
}
func Main() {
    let f = C.Make[int32](77)
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source)
        Assert.Equal("77${Environment.NewLine}", output)
    }

    @Fact
    func EndToEnd_NonGenericUserInterfaceConstraint_Control_Runs() {
        let source = `package Issue1499NonGenericIface
import System
interface ILabeled {
    func Label() string;
}
data struct Tag(Name string) : ILabeled {
    func Label() string -> Name
}
class C {
    shared {
        func Make[T ILabeled](item T) () -> string ->
            () -> item.Label()
    }
}
func Main() {
    let t = Tag("hello")
    let f = C.Make[Tag](t)
    System.Console.WriteLine(f())
}`
        let output = CompileAndRun(source)
        Assert.Equal("hello${Environment.NewLine}", output)
    }

    shared {
        private func VerifyStrict(path string, references ...string) {
            var report = string.Empty
            IlVerifier.Verify(
                path,
                references,
                report: (text string) -> {
                    report = text
                }
            )
            Assert.Contains("raw exit: 0", report, StringComparison.Ordinal)
            Assert.DoesNotContain("[approved", report, StringComparison.Ordinal)
        }

        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_1499_exe_").FullName
            try {
                let srcPath = Path.Combine(tempDir, "test.gs")
                let dllPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(srcPath, source)
                let args = []string{"/out:" + dllPath, "/target:exe", "/targetframework:net10.0", srcPath}
                using let stdoutWriter = StringWriter()
                using let stderrWriter = StringWriter()
                let prevOut = Console.Out
                let prevErr = Console.Error
                Console.SetOut(stdoutWriter)
                Console.SetError(stderrWriter)
                var compileExit int32
                try {
                    compileExit = Program.Main(args)
                } finally {
                    Console.SetOut(prevOut)
                    Console.SetError(prevErr)
                }
                Assert.True(compileExit == 0, (`gsc failed:
stdout:
` + "$stdoutWriter" + `
stderr:
` + "$stderrWriter"))
                IlVerifier.Verify(dllPath)
                let rtConfig = Path.ChangeExtension(dllPath, ".runtimeconfig.json")
                if !File.Exists(rtConfig) {
                    File.WriteAllText(rtConfig, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                }
                let psi = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = tempDir
                }
                psi.ArgumentList.Add("exec")
                psi.ArgumentList.Add("--runtimeconfig")
                psi.ArgumentList.Add(rtConfig)
                psi.ArgumentList.Add(dllPath)
                using let proc = Process.Start(psi) ?? throw InvalidOperationException("Failed to start dotnet exec")
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
