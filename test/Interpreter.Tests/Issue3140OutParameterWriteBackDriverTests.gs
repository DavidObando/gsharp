// <copyright file="Issue3140OutParameterWriteBackDriverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Threading
import System.Threading.Tasks
import Xunit

/// Issue #3140: user-method ref/out write-back across every receiver and
/// operand shape, asserted against golden values on both emitted hosts —
/// out-of-process (`gsc /out:` + `dotnet exec`) and the in-process
/// submission-mode oracle. The tree-walking evaluator and evaluator
/// SessionEngine columns retired in ADR-0156 Phase 3c (#3176).
@Collection("ConsoleIo")
open class Issue3140OutParameterWriteBackDriverTests {
    @Theory
    @MemberData("ReceiverShapeMatrix")
    async func OutParameterWriteBack_AgreesAcrossEmittedDrivers(receiver ReceiverKind, shape ArgumentShape) {
        await AssertEmittedDriverAgreementAsync(
            BuildSource(receiver, shape),
            GetExpectedOutput(shape),
            receiver.ToString() + "-" + shape.ToString()
        )
    }

    @Theory
    @MemberData("WriteBackOperandMatrix")
    async func OutParameterWriteBack_ReceiverAndOperandKindsAgreeAcrossEmittedDrivers(
        receiver ReceiverKind,
        operand OperandKind
    ) {
        await AssertEmittedDriverAgreementAsync(
            BuildOperandSource(receiver, operand),
            "91",
            receiver.ToString() + "-" + operand.ToString()
        )
    }

    /// Call receiver shape.
    enum ReceiverKind {
        Free,
        ClassShared,
        ClassInstance,
        StructShared,
        StructInstance,
        Interface,
        BaseClass,
        GenericMethod,
        BaseInterface,
        ConstrainedStatic
    }

    /// Argument shape.
    enum ArgumentShape {
        SingleOut,
        MultipleOut,
        OutAndRef,
        OutAndNormal,
        ConditionalOut
    }

    /// Caller storage kind used by a ref/out argument.
    enum OperandKind {
        Variable,
        Field,
        Index,
        Dereference
    }

    private data class ShapeSpec(
        Parameters string,
        Body string,
        Locals string,
        ForwardArguments string,
        Calls[]CallSpec
    ) : IEquatable[ShapeSpec] { }

    private data class CallSpec(Arguments string, Output string) : IEquatable[CallSpec] { }

    private data struct DriverResult(ExitCode int32, Stdout string, Stderr string) : IEquatable[
        Issue3140OutParameterWriteBackDriverTests.DriverResult
    ] { }

    shared {
        /// Gets receiver and argument-shape matrix rows.
        /// @returns Matrix rows.
        func ReceiverShapeMatrix() sequence[[]object] {
            for receiver in Enum.GetValues[ReceiverKind]() {
                for shape in Enum.GetValues[ArgumentShape]() {
                    yield[]object{receiver, shape}
                }
            }
        }

        /// Gets receiver and write-back operand-kind rows.
        /// @returns Receiver and operand-kind rows.
        func WriteBackOperandMatrix() sequence[[]object] {
            for receiver in Enum.GetValues[ReceiverKind]() {
                for operand in Enum.GetValues[OperandKind]() {
                    yield[]object{receiver, operand}
                }
            }
        }

        private func BuildSource(receiver ReceiverKind, shape ArgumentShape) string -> BuildSource(
            receiver,
            GetShape(shape),
            "Issue3140$receiver$shape",
            string.Empty
        )

        private func BuildSource(
            receiver ReceiverKind,
            spec ShapeSpec,
            $package string,
            extraDeclaration string
        ) string {
            var method = (`func Fill(` + "${spec.Parameters}" + `) {
` + "${Indent(spec.Body, 4)}" + `
}`)
            var declarations string
            var target string
            var callPrefix = string.Empty
            switch receiver {
                case ReceiverKind.Free {
                    declarations = method
                    target = "Fill"
                }
                case ReceiverKind.ClassShared {
                    declarations = (`class Target {
    shared {
` + "${Indent(method, 8)}" + `
    }
}`)
                    target = "Target.Fill"
                }
                case ReceiverKind.ClassInstance {
                    declarations = (`class Target {
` + "${Indent(method, 4)}" + `
}`)
                    target = "target.Fill"
                }
                case ReceiverKind.StructShared {
                    declarations = (`struct Target {
    shared {
` + "${Indent(method, 8)}" + `
    }
}`)
                    target = "Target.Fill"
                }
                case ReceiverKind.StructInstance {
                    declarations = (`struct Target {
` + "${Indent(method, 4)}" + `
}`)
                    target = "target.Fill"
                }
                case ReceiverKind.Interface {
                    declarations = (`interface Filler {
    func Fill(` + "${spec.Parameters}" + `);
}
`) + (`class Target : Filler {
` + "${Indent(method, 4)}" + `
}`)
                    target = "target.Fill"
                }
                case ReceiverKind.BaseClass {
                    declarations = (`open class Base {
` + "${Indent(method, 4)}" + `
}
`) + (`class Target : Base {
    func Invoke(` + "${spec.Parameters}" + `) {
`) + (`        base.Fill(` + "${spec.ForwardArguments}" + `)
    }
}`)
                    target = "target.Invoke"
                }
                case ReceiverKind.GenericMethod {
                    method = (`func Fill[T](marker T, ` + "${spec.Parameters}" + `) {
` + "${Indent(spec.Body, 4)}" + `
}`)
                    declarations = (`class Target {
` + "${Indent(method, 4)}" + `
}`)
                    target = "target.Fill[string]"
                    callPrefix = "\"marker\", "
                }
                case ReceiverKind.BaseInterface {
                    declarations = (`interface Filler {
` + "${Indent(method, 4)}" + `
}
`) + (`class Target : Filler {
    func Fill(` + "${spec.Parameters}" + `) {
`) + (`        base[Filler].Fill(` + "${spec.ForwardArguments}" + `)
    }
}`)
                    target = "target.Fill"
                }
                case ReceiverKind.ConstrainedStatic {
                    declarations = (`interface Filler {
    shared {
        func Fill(` + "${spec.Parameters}" + `);
    }
}
`) + (`struct Target : Filler {
    shared {
` + "${Indent(method, 8)}" + `
    }
}
`) + (`func Invoke[T Filler](witness T, ` + "${spec.Parameters}" + `) {
`) + (`    T.Fill(` + "${spec.ForwardArguments}" + `)
}`)
                    target = "Invoke"
                    callPrefix = "Target{}, "
                }
                default {
                    throw ArgumentOutOfRangeException("receiver", receiver, nil)
                }
            }
            let receiverLocal = switch receiver {
                case ReceiverKind.ClassInstance or
                    ReceiverKind.BaseClass or
                    ReceiverKind.GenericMethod or
                    ReceiverKind.BaseInterface: "var target = Target()"
                case ReceiverKind.StructInstance: "var target = Target{}"
                case ReceiverKind.Interface: "var target Filler = Target()"
                default: string.Empty
            }
            let calls = string.Join(
                Environment.NewLine,
                spec.Calls.Select(
                    (call CallSpec) -> "$target($callPrefix${call.Arguments})${Environment.NewLine}${call.Output}"
                )
            )
            return (`package ` + "$$package" + `
import System

` + "$declarations" + `

` + "$extraDeclaration" + `

` + "$receiverLocal" + `
` + "${spec.Locals}" + `
` + "$calls")
        }

        private func BuildOperandSource(receiver ReceiverKind, operand OperandKind) string {
            let (declaration, locals, argument, output) = switch operand {
                case OperandKind.Variable: (string.Empty, "var value = 101", "&value", "value")
                case OperandKind.Field: (
                    "class Holder { var Value int32 }",
                    "let holder = Holder{}\nholder.Value = 102",
                    "&holder.Value",
                    "holder.Value"
                )
                case OperandKind.Index: (string.Empty, "var values = []int32{101, 104}", "&values[1]", "values[1]")
                case OperandKind.Dereference: (string.Empty, "var value = 105", "&*(&value)", "value")
                default: throw ArgumentOutOfRangeException("operand", operand, nil)
            }
            let spec = ShapeSpec(
                "out value int32",
                "value = 91",
                locals,
                "&value",
                []CallSpec{CallSpec(argument, "Console.WriteLine($output)")}
            )
            return BuildSource(receiver, spec, "Issue3140Operand$receiver$operand", declaration)
        }

        private func GetShape(shape ArgumentShape) ShapeSpec -> switch shape {
            case ArgumentShape.SingleOut: ShapeSpec(
                "out first int32",
                "first = 11",
                "var first = 101",
                "&first",
                []CallSpec{CallSpec("&first", "Console.WriteLine(first)")}
            )
            case ArgumentShape.MultipleOut: ShapeSpec(
                "out first int32, out second int32",
                "first = 21\nsecond = 22",
                "var first = 201\nvar second = 202",
                "&first, &second",
                []CallSpec{CallSpec("&first, &second", "Console.WriteLine(first)\nConsole.WriteLine(second)")}
            )
            case ArgumentShape.OutAndRef: ShapeSpec(
                "out first int32, ref second int32",
                "first = 31\nsecond = second + 4",
                "var first = 301\nvar second = 33",
                "&first, &second",
                []CallSpec{CallSpec("&first, &second", "Console.WriteLine(first)\nConsole.WriteLine(second)")}
            )
            case ArgumentShape.OutAndNormal: ShapeSpec(
                "out first int32, input int32",
                "first = input + 1",
                "var first = 401\nlet input = 43",
                "&first, input",
                []CallSpec{CallSpec("&first, input", "Console.WriteLine(first)")}
            )
            case ArgumentShape.ConditionalOut: ShapeSpec("flag bool, out first int32", `if flag {
    first = 51
} else {
    first = 52
}`, "var firstTrue = 501\nvar firstFalse = 502", "flag, &first", []CallSpec{
                    CallSpec("true, &firstTrue", "Console.WriteLine(firstTrue)"),
                    CallSpec("false, &firstFalse", "Console.WriteLine(firstFalse)")
                })
            default: throw ArgumentOutOfRangeException("shape", shape, nil)
        }

        private func GetExpectedOutput(shape ArgumentShape) string -> switch shape {
            case ArgumentShape.SingleOut: "11"
            case ArgumentShape.MultipleOut: "21\n22"
            case ArgumentShape.OutAndRef: "31\n37"
            case ArgumentShape.OutAndNormal: "44"
            case ArgumentShape.ConditionalOut: "51\n52"
            default: throw ArgumentOutOfRangeException("shape", shape, nil)
        }

        private async func AssertEmittedDriverAgreementAsync(source string, expected string, name string) {
            let root = CreateEmptyDirectory(name)
            try {
                let emitted = await RunEmittedAsync(source, CreateEmptyDirectory(root, "emit"))
                let inProcess = RunEmittedOracle(source)
                Assert.Equal(expected, emitted)
                Assert.NotEmpty(emitted)
                Assert.Equal(emitted, inProcess)
            } finally {
                DeleteDirectory(root)
            }
        }

        private func RunEmittedOracle(source string) string {
            let result = EmittedOracle.Evaluate(source)
            let errors = result
                .Diagnostics
                .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                .ToArray()
            Assert.True(
                errors.Length == 0,
                "oracle evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((error GSharp.Core.CodeAnalysis.Diagnostic) -> error.ToString())
                )
            )
            Assert.Equal(string.Empty, result.ErrorOutput)
            return Normalize(result.Output, stripCompilerSuccess: false)
        }

        private async func RunEmittedAsync(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            let assemblyPath = Path.Combine(directory, "probe.dll")
            File.WriteAllText(sourcePath, source)
            let compile = CaptureConsole(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
            Assert.True(compile.ExitCode == 0, (`emit failed (` + "${compile.ExitCode}" + `)
stdout:
` + "${compile.Stdout}" + `
stderr:
` + "${compile.Stderr}"))
            Assert.Equal(string.Empty, compile.Stderr)
            CollectibleAssembly.Inspect(assemblyPath, (assembly Assembly) -> Assert.NotEmpty(assembly.GetTypes()))
            let result = await DotnetProcess.RunAsync(
                directory,
                []string{
                    "exec",
                    "--runtimeconfig",
                    Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                    assemblyPath
                }
            )
            Assert.True(result.ExitCode == 0, (`emitted program failed (` + "${result.ExitCode}" + `)
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            Assert.Equal(string.Empty, result.StandardError)
            return Normalize(result.StandardOutput, stripCompilerSuccess: false)
        }

        private func CaptureConsole(action() -> int32) Issue3140OutParameterWriteBackDriverTests.DriverResult {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return Issue3140OutParameterWriteBackDriverTests.DriverResult(
                    action(),
                    stdout.ToString(),
                    stderr.ToString()
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }

        private func Normalize(output string, stripCompilerSuccess bool) string -> string.Join(
            "\n",
            output
                .ReplaceLineEndings(Environment.NewLine)
                .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
                .Where((line string) -> !stripCompilerSuccess || line != "Success.")
        )

        private func CreateEmptyDirectory(name string) string {
            let parent = Path.Combine(AppContext.BaseDirectory, "Issue3140OutParameterWriteBackDriverTests")
            return CreateEmptyDirectory(parent, name + "-" + Guid.NewGuid().ToString("N"))
        }

        private func CreateEmptyDirectory(parent string, name string) string {
            let path = Path.Combine(parent, name)
            Directory.CreateDirectory(path)
            Assert.Empty(Directory.EnumerateFileSystemEntries(path))
            return path
        }

        private func DeleteDirectory(path string) {
            try {
                Directory.Delete(path, recursive: true)
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }

        private func Indent(value string, spaces int32) string {
            let prefix = String(' ', spaces)
            return string.Join(
                Environment.NewLine,
                value.Split(Environment.NewLine).Select((line string) -> prefix + line)
            )
        }
    }
}
