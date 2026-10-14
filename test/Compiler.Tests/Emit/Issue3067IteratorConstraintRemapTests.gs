// <copyright file="Issue3067IteratorConstraintRemapTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import Xunit

@Collection("Issue3067Console")
open class Issue3067IteratorConstraintRemapTests {
    @Theory
    @MemberData("ConstraintCases")
    func StateMachineConstraintMetadata_ReferencesClassParameters_AndRuns(
        name string,
        methodName string,
        expectedOutput string,
        shape ConstraintShape,
        source string
    ) {
        let directory = CreateDirectory(name)
        try {
            let assemblyPath = Compile(source, directory)
            let assembly = EmittedFixture.Load(assemblyPath)
            let types = assembly.GetTypes()
            let stateMachine = Assert.Single(
                types,
                (type Type) -> type.Name.StartsWith("<" + methodName + ">d__", StringComparison.Ordinal)
            )
            AssertConstraints(stateMachine, shape)
            Assert.Equal(expectedOutput + Environment.NewLine, Run(assemblyPath, directory))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Theory
    @MemberData("DriverMatrix")
    func ConstraintRepro_PositionAndCompilerDriverMatrix_Runs(position SourcePosition, driver Driver) {
        let expected = if position == SourcePosition.TopLevel {
            "66"
        } else {
            "77"
        }
        let source = if position == SourcePosition.TopLevel {
            TopLevelSource
        } else {
            InFunctionSource
        }
        let directory = CreateDirectory(position.ToString() + "-" + driver.ToString())
        try {
            let sourcePath = Path.Combine(directory, "probe.gs")
            File.WriteAllText(sourcePath, source)
            if driver == Driver.Emit {
                let assemblyPath = Compile(source, directory)
                Assert.Equal(expected + Environment.NewLine, Run(assemblyPath, directory))
                return
            }
            using let output = StringWriter()
            let previous = Console.Out
            Console.SetOut(output)
            try {
                Assert.Equal(0, Program.Main([]string{sourcePath}))
            } finally {
                Console.SetOut(previous)
            }
            Assert.Contains(expected + Environment.NewLine, output.ToString().ReplaceLineEndings(Environment.NewLine))
        } finally {
            DeleteDirectory(directory)
        }
    }

    enum ConstraintShape {
        ClassReferencesMethodParameter,
        InterfaceReferencesSelf,
        DefaultConstructor,
        ClassReferencesTwoMethodParameters,
        ClassReferencesClassAndMethodParameters,
        NestedOwnerAndMethod,
        EnclosingParameterReferencesSelf,
        NonGeneric
    }

    enum SourcePosition {
        TopLevel,
        InFunction
    }

    enum Driver {
        Evaluate,
        Emit
    }

    shared {
        func ConstraintCases() sequence[[]object] {
            yield Case("class-constraint", "ClassValues", "11", ConstraintShape.ClassReferencesMethodParameter, `package Issue3067.ClassConstraint
import System
open class Box[T any] {}
class IntBox : Box[int32] {}
func ClassValues[T any, TBox Box[T] init()](value T) sequence[T] {
    yield value
}
for value in ClassValues[int32, IntBox](11) {
    Console.WriteLine(value)
}`)
            yield Case("interface-constraint", "InterfaceValues", "22", ConstraintShape.InterfaceReferencesSelf, `package Issue3067.InterfaceConstraint
import System
func InterfaceValues[T IComparable[T]](value T) sequence[T] {
    yield value
}
for value in InterfaceValues[int32](22) {
    Console.WriteLine(value)
}`)
            yield Case("new-constraint", "NewValues", "33", ConstraintShape.DefaultConstructor, `package Issue3067.NewConstraint
import System
func NewValues[T init()](value T) sequence[T] {
    yield value
}
for value in NewValues[int32](33) {
    Console.WriteLine(value)
}`)
            yield Case(
                "cross-method-constraint",
                "CrossValues",
                "44",
                ConstraintShape.ClassReferencesTwoMethodParameters,
                `package Issue3067.CrossConstraint
import System
open class Pair[A any, B any] {}
class IntStringPair : Pair[int32, string] {}
func CrossValues[T any, U any, TBox Pair[T, U] init()](value U) sequence[U] {
    yield value
}
for value in CrossValues[int32, string, IntStringPair]("44") {
    Console.WriteLine(value)
}`
            )
            yield Case(
                "generic-owner-and-method",
                "MixedValues",
                "55",
                ConstraintShape.ClassReferencesClassAndMethodParameters,
                `package Issue3067.GenericOwner
import System
open class Pair[A any, B any] {}
class IntStringPair : Pair[int32, string] {}
class Maker[TClass any] {
    func MixedValues[TMethod any, TBox Pair[TClass, TMethod] init()](value TMethod) sequence[TMethod] {
        yield value
    }
}
for value in Maker[int32]().MixedValues[string, IntStringPair]("55") {
    Console.WriteLine(value)
}`
            )
            yield Case("nested-generic-owner", "NestedValues", "66", ConstraintShape.NestedOwnerAndMethod, `package Issue3067.NestedOwner
import System
class Outer[TOuter any] {
    struct Inner[TInner any] {
        func NestedValues[TMethod IComparable[TMethod]](value TMethod) sequence[TMethod] {
            yield value
        }
    }
}
var inner = Outer[int32].Inner[string]{}
for value in inner.NestedValues[int32](66) {
    Console.WriteLine(value)
}`)
            yield Case(
                "enclosing-parameter-constraint",
                "EnclosingValues",
                "77",
                ConstraintShape.EnclosingParameterReferencesSelf,
                `package Issue3067.EnclosingConstraint
import System
class Owner[T IComparable[T]] {
    func EnclosingValues(value T) sequence[T] {
        yield value
    }
}
for value in Owner[int32]().EnclosingValues(77) {
    Console.WriteLine(value)
}`
            )
            yield Case("non-generic-control", "PlainValues", "88", ConstraintShape.NonGeneric, `package Issue3067.NonGeneric
import System
func PlainValues(value int32) sequence[int32] {
    yield value
}
for value in PlainValues(88) {
    Console.WriteLine(value)
}`)
            yield Case("async-iterator", "AsyncValues", "99", ConstraintShape.InterfaceReferencesSelf, `package Issue3067.AsyncInterfaceConstraint
import System
import System.Collections.Generic
import System.Threading.Tasks
async func AsyncValues[T IComparable[T]](value T) IAsyncEnumerable[T] {
    await Task.CompletedTask
    yield value
}
async func Read[T any](values IAsyncEnumerable[T]) Task[T] {
    await for value in values {
        return value
    }
    return default(T)
}
Console.WriteLine(Read[int32](AsyncValues[int32](99)).GetAwaiter().GetResult())`)
        }

        func DriverMatrix() sequence[[]object] {
            for position in Enum.GetValues[SourcePosition]() {
                for driver in Enum.GetValues[Driver]() {
                    yield[]object{position, driver}
                }
            }
        }

        private const TopLevelSource string = `package Issue3067.MatrixTopLevel
import System
open class Box[T any] {}
class IntBox : Box[int32] {}
func Values[T any, TBox Box[T] init()](value T) sequence[T] {
    yield value
}
for value in Values[int32, IntBox](66) {
    Console.WriteLine(value)
}`

        private const InFunctionSource string = `package Issue3067.MatrixInFunction
import System
open class Box[T any] {}
class IntBox : Box[int32] {}
func Values[T any, TBox Box[T] init()](value T) sequence[T] {
    yield value
}
func Run() {
    for value in Values[int32, IntBox](77) {
        Console.WriteLine(value)
    }
}
Run()`

        private func Case(
            name string,
            methodName string,
            expectedOutput string,
            shape ConstraintShape,
            source string
        )[]object -> []object{name, methodName, expectedOutput, shape, source}

        private func AssertConstraints(stateMachine Type, shape ConstraintShape) {
            if shape == ConstraintShape.NonGeneric {
                Assert.False(stateMachine.IsGenericTypeDefinition)
                Assert.Empty(stateMachine.GetGenericArguments())
                return
            }
            Assert.True(stateMachine.IsGenericTypeDefinition)
            let parameters = stateMachine.GetGenericArguments()
            switch shape {
                case ConstraintShape.ClassReferencesMethodParameter {
                    AssertParameterNames(parameters, "T", "TBox")
                    AssertConstructedConstraint(parameters[1], "Box`1", parameters[0])
                    AssertDefaultConstructor(parameters[1])
                }
                case ConstraintShape.InterfaceReferencesSelf {
                    AssertParameterNames(parameters, "T")
                    let comparable = Assert.Single(parameters[0].GetGenericParameterConstraints())
                    Assert.Equal(typeof(IComparable[_]), comparable.GetGenericTypeDefinition())
                    Assert.Equal(parameters[0], Assert.Single(comparable.GetGenericArguments()))
                }
                case ConstraintShape.DefaultConstructor {
                    AssertParameterNames(parameters, "T")
                    Assert.Empty(parameters[0].GetGenericParameterConstraints())
                    AssertDefaultConstructor(parameters[0])
                }
                case ConstraintShape.ClassReferencesTwoMethodParameters {
                    AssertParameterNames(parameters, "T", "U", "TBox")
                    AssertConstructedConstraint(parameters[2], "Pair`2", parameters[0], parameters[1])
                    AssertDefaultConstructor(parameters[2])
                }
                case ConstraintShape.ClassReferencesClassAndMethodParameters {
                    AssertParameterNames(parameters, "TClass", "TMethod", "TBox")
                    AssertConstructedConstraint(parameters[2], "Pair`2", parameters[0], parameters[1])
                    AssertDefaultConstructor(parameters[2])
                }
                case ConstraintShape.NestedOwnerAndMethod {
                    AssertParameterNames(parameters, "TOuter", "TInner", "TMethod")
                    let nestedComparable = Assert.Single(parameters[2].GetGenericParameterConstraints())
                    Assert.Equal(typeof(IComparable[_]), nestedComparable.GetGenericTypeDefinition())
                    Assert.Equal(parameters[2], Assert.Single(nestedComparable.GetGenericArguments()))
                }
                case ConstraintShape.EnclosingParameterReferencesSelf {
                    AssertParameterNames(parameters, "T")
                    let enclosingComparable = Assert.Single(parameters[0].GetGenericParameterConstraints())
                    Assert.Equal(typeof(IComparable[_]), enclosingComparable.GetGenericTypeDefinition())
                    Assert.Equal(parameters[0], Assert.Single(enclosingComparable.GetGenericArguments()))
                }
                default {
                    throw InvalidOperationException("Unexpected constraint shape.")
                }
            }
        }

        private func AssertConstructedConstraint(parameter Type, genericTypeName string, expectedArguments ...Type) {
            let constraint = Assert.Single(parameter.GetGenericParameterConstraints())
            Assert.True(constraint.IsGenericType)
            Assert.Equal(genericTypeName, constraint.GetGenericTypeDefinition().Name)
            Assert.Equal(expectedArguments, constraint.GetGenericArguments())
        }

        private func AssertParameterNames(parameters[]Type, expected ...string) -> Assert.Equal(
            expected,
            parameters.Select((parameter Type) -> parameter.Name)
        )

        private func AssertDefaultConstructor(parameter Type) -> Assert.True(
            (parameter.GenericParameterAttributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0
        )

        private func Compile(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            let assemblyPath = Path.Combine(directory, "probe.dll")
            File.WriteAllText(sourcePath, source)
            Assert.Equal(
                0,
                Program.Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
            return assemblyPath
        }

        private func Run(assemblyPath string, directory string) string {
            using let process = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            ) ??
                throw InvalidOperationException("Failed to start dotnet child process.")
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                throw TimeoutException("dotnet child process timed out.")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, (`dotnet exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CreateDirectory(name string) string -> Directory.CreateDirectory(
            Path.Combine(AppContext.BaseDirectory, "issue3067", name + "-" + Guid.NewGuid().ToString("N"))
        )
            .FullName

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}

@CollectionDefinition("Issue3067Console", DisableParallelization = true)
class Issue3067ConsoleCollection { }
