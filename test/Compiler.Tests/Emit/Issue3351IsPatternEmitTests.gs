// <copyright file="Issue3351IsPatternEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Runtime and IL verification for boolean pattern `is` expressions.
class Issue3351IsPatternEmitTests {
    @Theory
    @InlineData("Demo.Wrapper?(nil)", "Tag", "nil\n0\n0\n0\n0\n")
    @InlineData("NamespaceAlias.Wrapper?(Nothing())", "Read(Next(\"-read\"))", "nil\n0\n1\n0\n0\n")
    @InlineData("Demo.Wrapper(Next(\"top\"))", "Read(Next(\"-read\"))", "top-read\n1\n2\n1\n0\n")
    @InlineData("Demo.Wrapper{Tag: Next(\"top\")}", "Read(Next(\"-read\"))", "top-read\n1\n2\n1\n0\n")
    @InlineData("Demo.Wrapper(){Tag = Next(\"top\")}", "Read(Next(\"-read\"))", "top-read\n1\n2\n1\n0\n")
    @InlineData("Demo.Wrapper(){Next(\"top\")}", "Read(Next(\"-read\"))", "top-read\n1\n2\n1\n1\n")
    func QualifiedConstructionContinuation_NullConditionalGuardsAndEvaluatesOnce(
        construction string,
        continuation string,
        expected string
    ) {
        const Source = `package Demo
import System
import NamespaceAlias = Demo
class Wrapper {
    var Tag string = "top"
    shared {
        var Constructions int32
        var Reads int32
        var Adds int32
    }
    init() { Constructions += 1 }
    init(tag string) {
        Constructions += 1
        Tag = tag
    }
    func Read(suffix string) string {
        Reads += 1
        return Tag + suffix
    }
    func Add(value string) {
        Adds += 1
        Tag = value
    }
}
class Holder {
    class Wrapper { var Tag string = "nested" }
    shared {
        var Arguments int32
        func Next(value string) string {
            Arguments += 1
            return value
        }
        func Nothing() object? {
            Arguments += 1
            return nil
        }
    }
    func Run() {
        let value = CONSTRUCTION?.CONTINUATION
        Console.WriteLine(value ?? "nil")
        Console.WriteLine(Demo.Wrapper.Constructions)
        Console.WriteLine(Arguments)
        Console.WriteLine(Demo.Wrapper.Reads)
        Console.WriteLine(Demo.Wrapper.Adds)
    }
}
Holder().Run()`
        let source = Source.Replace("CONSTRUCTION", construction).Replace("CONTINUATION", continuation)
        let result = CompileAndRun(source)
        Assert.Equal(
            Encoding.UTF8.GetBytes(expected.Replace("\n", Environment.NewLine)),
            Encoding.UTF8.GetBytes(result.Stdout)
        )
        CompileAndRun(
            source.Replace("let value =", "let value string ="),
            "(39,28,39,${28 + construction.Length + 2 + continuation.Length}): error GS0155:"
        )
    }

    @Theory
    @InlineData("Demo.Wrapper()")
    @InlineData("Demo.Wrapper{}")
    func QualifiedConstructionContinuation_NullConditionalRetainsNullableResultType(construction string) {
        const Source = `package Demo
class Wrapper { var Tag string = "top" }
let value string = CONSTRUCTION?.Tag`
        CompileAndRun(Source.Replace("CONSTRUCTION", construction), "(3,20,3,39): error GS0155:")
    }

    @Theory
    @InlineData("Demo.Derived(baseValue)", "Object.ReferenceEquals(baseValue, value)", "True\n")
    @InlineData("Demo.Wrapper?(nil)", "value == nil", "True\n0\n")
    @InlineData("Demo.Outer.Derived(nestedBaseValue)", "Object.ReferenceEquals(nestedBaseValue, value)", "True\n")
    @InlineData("Demo.Outer.Wrapper?(nil)", "value == nil", "True\n0\n")
    @InlineData("Demo.Marker(markerValue)", "Object.ReferenceEquals(markerValue, value)", "True\n")
    @InlineData(
        "Demo.GenericDerived[int32](genericBaseValue)",
        "Object.ReferenceEquals(genericBaseValue, value)",
        "True\n"
    )
    @InlineData(
        "Demo.GenericMarker[int32](genericMarkerValue)",
        "Object.ReferenceEquals(genericMarkerValue, value)",
        "True\n"
    )
    func QualifiedTypeCall_UsesCanonicalConversionAndConstruction(call string, comparison string, expected string) {
        const Source = `package Demo
import System
open class Base {}
class Derived : Base {}
open class GenericBase[T] {}
class GenericDerived[T] : GenericBase[T] {}
interface Marker {}
class Implementation : Marker {}
interface GenericMarker[T] {}
class GenericImplementation[T] : GenericMarker[T] {}
class Wrapper {
    shared { var Calls int32 }
    init(value object?) { Calls += 1 }
}
class Outer {
    open class Base {}
    class Derived : Base {}
    class Wrapper {
        shared { var Calls int32 }
        init(value object?) { Calls += 1 }
    }
}
enum Role { Zero, One }
let baseValue Base = Derived()
let nestedBaseValue Outer.Base = Outer.Derived()
let genericBaseValue GenericBase[int32] = GenericDerived[int32]()
let markerValue object = Implementation()
let genericMarkerValue object = GenericImplementation[int32]()
let value = CALL
Console.WriteLine(COMPARISON)
EXTRA
Console.WriteLine(Demo.Role(1) == Role.One)`
        let source = Source
            .Replace("CALL", call)
            .Replace("COMPARISON", comparison)
            .Replace(
            "EXTRA",
            if call.Contains("Outer.Wrapper", StringComparison.Ordinal) {
                "Console.WriteLine(Outer.Wrapper.Calls)"
            } else if call.Contains("Wrapper", StringComparison.Ordinal) {
                "Console.WriteLine(Wrapper.Calls)"
            } else {
                ""
            }
        )
        let result = CompileAndRun(source)
        Assert.Equal(
            Encoding.UTF8.GetBytes((expected + "True\n").Replace("\n", Environment.NewLine)),
            Encoding.UTF8.GetBytes(result.Stdout)
        )
    }

    @Fact
    func QualifiedTypeCall_DoesNotFallBackToLexicalTypeParameter() {
        const Source = `package Demo
interface Target {}
func Create[Target init()]() {
    Target()
    Demo.Target()
}`
        CompileAndRun(Source, "(5,10,5,16): error GS0131:")
    }

    @Theory
    @InlineData("Demo.Box(5)")
    @InlineData("Demo.Box{Value: 5}")
    @InlineData("NamespaceAlias.Box(5)")
    @InlineData("NamespaceAlias.Box{Value: 5}")
    func QualifiedConstruction_InfersOmittedArityAndPrefersNongeneric(construction string) {
        const Source = `package Demo
import System
import NamespaceAlias = Demo
class Box[T](Value T) { func Kind() string -> "top" }
class Choice { var Value int32 = 9 }
class Choice[T](Value T) {}
class Holder {
    class Box[T](Value T) { func Kind() string -> "nested" }
    func Make() Demo.Box[int32] { return CONSTRUCTION }
}
let value = Holder().Make()
Console.WriteLine(value.Value)
Console.WriteLine(value.Kind())
Console.WriteLine(Demo.Choice{}.Value)
Console.WriteLine(Demo.Choice().Value)`
        let result = CompileAndRun(Source.Replace("CONSTRUCTION", construction))
        Assert.Equal(
            Encoding.UTF8.GetBytes("5\ntop\n9\n9\n".Replace("\n", Environment.NewLine)),
            Encoding.UTF8.GetBytes(result.Stdout)
        )
    }

    @Theory
    @InlineData("Demo.Target[int32]", "Field")
    @InlineData("Demo.Target[int32?]", "Field")
    @InlineData("NamespaceAlias.Target[int32]", "Field")
    @InlineData("NamespaceAlias.Target[int32?]", "Field")
    @InlineData("Demo.Target[int32]", "Property")
    @InlineData("Demo.Target[int32?]", "Property")
    @InlineData("NamespaceAlias.Target[int32]", "Property")
    @InlineData("NamespaceAlias.Target[int32?]", "Property")
    @InlineData("Demo.Deep.Target[int32]", "Field")
    @InlineData("Demo.Deep.Target[int32?]", "Property")
    func QualifiedGenericStaticMutation_SharesReadIdentityAndEvaluatesOnce(receiver string, member string) {
        const Source = `package Demo
import System
import NamespaceAlias = Demo
class Target[T] {
    shared {
        var Field int32
        prop Property int32 { get; set; }
    }
}
class Holder {
    class Target[T] {
        shared {
            var Field int32
            prop Property int32 { get; set; }
        }
    }
    shared {
        var Calls int32
        func Next() int32 {
            Calls += 1
            return Calls
        }
    }
    func Run() {
        RECEIVER.MEMBER = Next()
        Console.WriteLine(RECEIVER.MEMBER)
        RECEIVER.MEMBER += Next()
        Console.WriteLine(RECEIVER.MEMBER)
        RECEIVER.MEMBER++
        Console.WriteLine(RECEIVER.MEMBER)
        Console.WriteLine(Target[ARGUMENT].MEMBER)
        Console.WriteLine(Calls)
    }
}
Holder().Run()`
        let argument = if receiver.Contains("?", StringComparison.Ordinal) {
            "int32?"
        } else {
            "int32"
        }
        let packageName = if receiver.StartsWith("Demo.Deep.", StringComparison.Ordinal) {
            "Demo.Deep"
        } else {
            "Demo"
        }
        let result = CompileAndRun(
            Source
                .Replace("package Demo", "package " + packageName)
                .Replace("import NamespaceAlias = Demo", "import NamespaceAlias = " + packageName)
                .Replace("RECEIVER", receiver)
                .Replace("MEMBER", member)
                .Replace("ARGUMENT", argument)
        )
        Assert.Equal(
            Encoding.UTF8.GetBytes("1\n3\n4\n0\n2\n".Replace("\n", Environment.NewLine)),
            Encoding.UTF8.GetBytes(result.Stdout)
        )
    }

    @Theory
    @InlineData("Missing", "Missing", false)
    @InlineData("Missing?", "Missing", false)
    @InlineData("5", "5", false)
    @InlineData("1 + 2", "1 + 2", false)
    @InlineData("Missing", "Missing", true)
    @InlineData("Missing?", "Missing", true)
    @InlineData("5", "5", true)
    func QualifiedGenericStaticAccess_RetainsLocatedTypeArgumentErrors(argument string, errorText string, write bool) {
        let source = `package Demo
import System
class Target[T] { shared { var Value int32 } }
` + if write {
            "Demo.Target[" + argument + "].Value = 1"
        } else {
            "Console.WriteLine(Demo.Target[" + argument + "].Value)"
        }
        let lineStart = source.LastIndexOf('\n') + 1
        let column = source.LastIndexOf(argument, StringComparison.Ordinal) - lineStart + 1
        CompileAndRun(source, "(4,$column,4,${column + errorText.Length}): error GS0113:")
    }

    @Fact
    func QualifiedDeclaredAliases_PreserveTheirOwnNamesAndTargetIdentity() {
        const Source = `package Repro
import System
import System.Text
import NamespaceAlias = Repro

type Count = int32
type OtherCount = int32
type Label = string
type Builder = StringBuilder

func Echo(value Repro.Count) Repro.OtherCount -> value
let n NamespaceAlias.Count = 41
Console.WriteLine(Echo(n) + 1)
let text Repro.Label = "alias"
Console.WriteLine(text)
let value object = "alias"
Console.WriteLine(value is Repro.Label)
let builder Repro.Builder = StringBuilder()
builder.Append("ok")
Console.WriteLine(builder.ToString())`
        let result = CompileAndRun(Source)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                "42${Environment.NewLine}alias${Environment.NewLine}True${Environment.NewLine}ok${Environment.NewLine}"
            ),
            Encoding.UTF8.GetBytes(result.Stdout)
        )
    }

    @Theory
    @InlineData("Demo.Target", "Demo.Target{}", "top")
    @InlineData("Demo.Target", "Demo.Target()", "top")
    @InlineData("Demo.Target", "NamespaceAlias.Target{}", "top")
    @InlineData("Demo.Target", "NamespaceAlias.Target()", "top")
    @InlineData("Demo.Target", "Demo.Target(Target{}.Tag)", "nested")
    @InlineData("Demo.Target", "Demo.Target(){Tag = Target{}.Tag}", "nested")
    @InlineData("Demo.Target", "Demo.Target(){\"collection\"}", "collection")
    @InlineData("Demo.Target[int32]", "Demo.Target[int32]{}", "generic-top")
    @InlineData("Demo.Target[int32]", "Demo.Target[int32]()", "generic-top")
    func QualifiedConstruction_UsesAnnotationIdentityWithoutChangingArgumentScope(
        returnType string,
        construction string,
        tag string
    ) {
        const Source = `package Demo
import System
import NamespaceAlias = Demo

class Target {
    var Tag string = "top"
    init() { }
    init(tag string) { Tag = tag }
    func Add(value string) { Tag = value }
}
class Target[T] { var Tag string = "generic-top" }
class Holder {
    class Target { var Tag string = "nested" }
    class Target[T] { var Tag string = "generic-nested" }
    func Make() RETURNTYPE {
        return CONSTRUCTION
    }
}
let value = Holder().Make()
Console.WriteLine(value.Tag)
Console.WriteLine(value.GetType().DeclaringType == nil)`
        let result = CompileAndRun(Source.Replace("RETURNTYPE", returnType).Replace("CONSTRUCTION", construction))
        Assert.Equal(
            Encoding.UTF8.GetBytes(tag + Environment.NewLine + "True" + Environment.NewLine),
            Encoding.UTF8.GetBytes(result.Stdout)
        )
    }

    @Theory
    @InlineData("Role", "Role.TextInput")
    @InlineData("Role", "Repro.Role.TextInput")
    @InlineData("Role", "RoleAlias.TextInput")
    @InlineData("Role", "Role.StringBuilder")
    @InlineData("Role", "Repro.Role.StringBuilder")
    @InlineData("Role", "RoleAlias.StringBuilder")
    @InlineData("System.DayOfWeek", "System.DayOfWeek.Monday")
    func QualifiedEnumConstant_WithTypeHomonym_RunsInEveryPatternContext(enumType string, constant string) {
        const Source = `package Repro
import System
import System.Text
import RoleAlias = Repro.Role
import TextInputAlias = Repro.TextInput
import NamespaceAlias = Repro
import SystemAlias = System

public enum Role { TextInput, StringBuilder, Other }
public class TextInput { }
public class Monday { }
class Holder { prop Value ENUMTYPE { get; init; } }
class Outer { public class TextInput { } }

let role = CONSTANT
Console.WriteLine(role is CONSTANT)
Console.WriteLine(role == CONSTANT)
Console.WriteLine(role !is CONSTANT)
Console.WriteLine(role is not CONSTANT)
Console.WriteLine(role is (CONSTANT))
Console.WriteLine(role is CONSTANT or == role)
Console.WriteLine(role is CONSTANT and not nil)
Console.WriteLine(switch role { case CONSTANT: "hit" default: "miss" })
switch role {
    case CONSTANT { Console.WriteLine("hit") }
    default { Console.WriteLine("miss") }
}
Console.WriteLine([]ENUMTYPE{role} is [CONSTANT])
Console.WriteLine(Holder{Value: role} is { Value: CONSTANT })
let other = Role.Other
Console.WriteLine(other is Role.TextInput)
Console.WriteLine(other is Role.StringBuilder)
let value object = TextInput{}
Console.WriteLine(value is TextInput)
Console.WriteLine(value is Repro.TextInput)
Console.WriteLine(value is TextInputAlias)
Console.WriteLine(value is NamespaceAlias.TextInput)
Console.WriteLine(value is System.Text.StringBuilder)
let builder object = StringBuilder{}
Console.WriteLine(builder is SystemAlias.Text.StringBuilder)
let nested object = Outer.TextInput{}
Console.WriteLine(nested is Outer.TextInput)
Console.WriteLine(value is Outer.TextInput)`
        let result = CompileAndRun(Source.Replace("ENUMTYPE", enumType).Replace("CONSTANT", constant))
        Assert.Equal(0, result.ExitCode)
        let expected = string.Join(
            Environment.NewLine,
            []string? {
                "True",
                "True",
                "False",
                "False",
                "True",
                "True",
                "True",
                "hit",
                "hit",
                "True",
                "True",
                "False",
                "False",
                "True",
                "True",
                "True",
                "True",
                "False",
                "True",
                "True",
                "False",
                string.Empty
            }
        )
        Assert.Equal(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(result.Stdout))
    }

    @Fact
    func ValueTypeAndNotNil_AfterTypeNarrowing_IsAlwaysTrue() {
        const Source = `package Issue3351.NotNil
import System

func Match(value object) bool {
    return value is int32 and not nil
}

Console.WriteLine(Match(0))
Console.WriteLine(Match(42))
Console.WriteLine(Match("not an int"))`
        let result = CompileAndRun(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}", result.Stdout)
    }

    @Fact
    func FullPatternMatrix_AndSwitchNarrowing_VerifiesAndRuns() {
        const Source = `package Issue3351
import System
import System.Threading.Tasks

enum Color { Red, Green }

class Box {
    prop P int32 { get; init; }
}

open class Animal { }
class Dog : Animal {
    prop Name string { get; init; }
    func Bark() string { return Name + ":woof" }
}

class Counter {
    shared {
        var Reads int32
    }
}

func Next() int32 {
    Counter.Reads += 1
    return 5
}

func ConstantOr(n int32) bool { return n is 1 or 2 }
func RelationalAnd(n int32) bool { return n is > 0 and < 10 }
func ListMatch(values []int32) bool { return values is [1, .., 3] }
func NotMatch(n int32) bool { return n is not 5 }
func Parenthesized(n int32) bool { return n is (1 or > 5) }
func Property(value Box) bool { return value is { P: > 0 } }
func Nested(n int32) bool { return n is (1 or > 5) and not 9 }
func NilTest(value object?) bool { return value is nil }
func TypeTest(value object?) bool { return value is string }
func TypeAndNil(value object?) bool { return value is string and not nil }
func ArrayType(value object) bool { return value is []int32 }

async func AsyncPattern(n int32) bool {
    await Task.Yield()
    return n is > 0 and < 10
}

func TypeProperty(value object) int32 {
    if value is string { Length: > 0 } {
        return value.Length
    }
    return -1
}

func DirectSwitch(value Animal) string {
    return switch value {
        case Dog { Name: "Rex" }: value.Bark()
        default: "miss"
    }
}

func AndSwitch(value Animal) string {
    return switch value {
        case Dog and { Name: "Rex" }: value.Bark()
        default: "miss"
    }
}

func StatementSwitch(value Animal) string {
    var result = "miss"
    switch value {
        case Dog { Name: "Rex" } { result = value.Bark() }
        default { }
    }
    return result
}

const limit = 5
const string = 5
let bookended = []int32{1, 2, 3}
let short = []int32{1, 2}
let red = Color.Red

Console.WriteLine(ConstantOr(2))
Console.WriteLine(ConstantOr(3))
Console.WriteLine(RelationalAnd(5))
Console.WriteLine(RelationalAnd(15))
Console.WriteLine(ListMatch(bookended))
Console.WriteLine(ListMatch(short))
Console.WriteLine(NotMatch(4))
Console.WriteLine(NotMatch(5))
Console.WriteLine(5 !is 6 or 7)
Console.WriteLine(Parenthesized(7))
Console.WriteLine(Property(Box{P: 1}))
Console.WriteLine(Property(Box{P: 0}))
Console.WriteLine(TypeProperty("hello"))
Console.WriteLine(TypeProperty(42))
Console.WriteLine(Nested(7))
Console.WriteLine(Nested(9))
Console.WriteLine(NilTest(nil))
Console.WriteLine(NilTest("x"))
Console.WriteLine(TypeTest("x"))
Console.WriteLine(TypeTest(42))
Console.WriteLine(TypeAndNil("x"))
Console.WriteLine(TypeAndNil(42))
Console.WriteLine(ArrayType(bookended))
Console.WriteLine(ArrayType("x"))
Console.WriteLine(AsyncPattern(5).Result)
Console.WriteLine(Next() is > 0 and < 10)
Console.WriteLine(Counter.Reads)
Console.WriteLine(DirectSwitch(Dog{Name: "Rex"}))
Console.WriteLine(DirectSwitch(Animal{}))
Console.WriteLine(AndSwitch(Dog{Name: "Rex"}))
Console.WriteLine(AndSwitch(Dog{Name: "Buddy"}))
Console.WriteLine(StatementSwitch(Dog{Name: "Rex"}))
Console.WriteLine(StatementSwitch(Animal{}))
Console.WriteLine(switch red { case Color.Red: "red" case Color.Green: "green" default: "other" })
Console.WriteLine(switch 5 { case limit: "limit" default: "other" })
Console.WriteLine(Color.Red is Color.Red)
Console.WriteLine(5 is limit)
Console.WriteLine(switch 5 { case string: "collision-constant" default: "other" })
Console.WriteLine("hello" is string)
Console.WriteLine(5 is == string)`
        let result = CompileAndRun(Source)
        Assert.Equal(0, result.ExitCode)
        Assert.Equal(
            string.Join(
                Environment.NewLine,
                []string? {
                    "True",
                    "False",
                    "True",
                    "False",
                    "True",
                    "False",
                    "True",
                    "False",
                    "True",
                    "True",
                    "True",
                    "False",
                    "5",
                    "-1",
                    "True",
                    "False",
                    "True",
                    "False",
                    "True",
                    "False",
                    "True",
                    "False",
                    "True",
                    "False",
                    "True",
                    "True",
                    "1",
                    "Rex:woof",
                    "miss",
                    "Rex:woof",
                    "miss",
                    "Rex:woof",
                    "miss",
                    "red",
                    "limit",
                    "True",
                    "True",
                    "collision-constant",
                    "True",
                    "True",
                    string.Empty
                }
            ),
            result.Stdout
        )
    }

    shared {
        private func CompileAndRun(source string, expectedError string? = nil)(ExitCode int32, Stdout string) {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3351IsPatternEmitTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                let outputPath = Path.Combine(directory, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let compileOut = StringWriter()
                using let compileErr = StringWriter()
                let previousOut = Console.Out
                let previousErr = Console.Error
                Console.SetOut(compileOut)
                Console.SetError(compileErr)
                var compileExitCode int32
                try {
                    compileExitCode = Program.Main(
                        []string{
                            "/out:" + outputPath,
                            "/target:exe",
                            "/targetframework:net10.0",
                            "/nowarn:GS9100,GS0286",
                            sourcePath
                        }
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousErr)
                }
                if expectedError != nil {
                    let output = compileOut.ToString() + compileErr.ToString()
                    Assert.Equal(1, compileExitCode)
                    Assert.Equal(1, output.Split("error GS", StringSplitOptions.None).Length - 1)
                    Assert.Contains(expectedError, output, StringComparison.Ordinal)
                    Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
                    Assert.False(File.Exists(outputPath))
                    return (compileExitCode, output)
                }
                Assert.True(compileExitCode == 0, (`gsc failed (exit ` + "$compileExitCode" + `):
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
                IlVerifier.Verify(outputPath)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    WorkingDirectory = directory
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add("--runtimeconfig")
                startInfo.ArgumentList.Add(Path.ChangeExtension(outputPath, ".runtimeconfig.json"))
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo) ??
                    throw InvalidOperationException("Failed to start dotnet exec.")
                let stdout = process.StandardOutput.ReadToEnd()
                let stderr = process.StandardError.ReadToEnd()
                Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.")
                Assert.True(process.ExitCode == 0, (`sample exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
                return (process.ExitCode, stdout)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
