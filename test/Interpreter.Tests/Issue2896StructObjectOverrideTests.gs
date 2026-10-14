// <copyright file="Issue2896StructObjectOverrideTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import CompilerProgram = GSharp.Compiler.Program
import GSharp.Core.CodeAnalysis
import GSharp.Repl
import GSharp.Repl.Engine
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Threading.Tasks
import Xunit

/// Issue #2896: plain structs may override Object virtual methods, including
/// calls dispatched through an object-typed receiver, with most-derived class
/// overrides preserved. Issue #3116 extends that dispatch to Object virtuals
/// invoked by the BCL. All drivers execute emitted code (the tree-walking
/// evaluator retired in ADR-0156 Phase 3c, #3176).
@Collection("ConsoleIo")
open class Issue2896StructObjectOverrideTests {
    @Theory
    @InlineData(`package Issue2896.TopLevel
import System

struct Value {
    var Number int32
    override func ToString() string -> "OVERRIDDEN-11"
    override func Equals(value object) bool -> false
    override func GetHashCode() int32 -> 289611
}

let direct = Value{Number: 7}
let peer object = Value{Number: 7}
let boxed object = direct
Console.WriteLine(direct.ToString())
Console.WriteLine(boxed.ToString())
Console.WriteLine(direct.Equals(peer))
Console.WriteLine(boxed.Equals(peer))
Console.WriteLine(direct.GetHashCode())
Console.WriteLine(boxed.GetHashCode())`)
    @InlineData(`package Issue2896.Function
import System

struct Value {
    var Number int32
    override func ToString() string -> "OVERRIDDEN-11"
    override func Equals(value object) bool -> false
    override func GetHashCode() int32 -> 289611
}

func Run() {
    let direct = Value{Number: 7}
    let peer object = Value{Number: 7}
    let boxed object = direct
    Console.WriteLine(direct.ToString())
    Console.WriteLine(boxed.ToString())
    Console.WriteLine(direct.Equals(peer))
    Console.WriteLine(boxed.Equals(peer))
    Console.WriteLine(direct.GetHashCode())
    Console.WriteLine(boxed.GetHashCode())
}

Run()`)
    func AllObjectOverrides_DirectAndBoxed_DispatchAtTopLevelAndInsideFunction(source string) {
        Assert.Equal(
            "OVERRIDDEN-11${Environment.NewLine}OVERRIDDEN-11${Environment.NewLine}False${Environment.NewLine}False${Environment.NewLine}289611${Environment.NewLine}289611${Environment.NewLine}",
            RunEmittedOracle(source)
        )
    }

    @Theory
    @InlineData(false, "gsc-script")
    @InlineData(false, "gsc-emit")
    @InlineData(false, "gsi")
    @InlineData(true, "gsc-script")
    @InlineData(true, "gsc-emit")
    @InlineData(true, "gsi")
    async func ClassObjectOverrideChain_UsesMostDerivedOverrideAcrossDrivers(insideFunction bool, driver string) {
        let suffix = Guid.NewGuid().ToString("N")
        let source = BuildClassOverrideChainSource(insideFunction, suffix)
        Assert.Equal(
            "L0-11${Environment.NewLine}L1-22${Environment.NewLine}L2-33${Environment.NewLine}",
            await RunDriverAsync(source, suffix, driver)
        )
    }

    @Theory
    @MemberData("ImplicitBclOverrideCases")
    async func ImplicitBclCalls_DispatchStructObjectOverridesAcrossDrivers(
        surface string,
        insideFunction bool,
        driver string
    ) {
        let suffix = Guid.NewGuid().ToString("N")
        let source = BuildImplicitBclOverrideSource(surface, insideFunction, suffix)
        let expected = switch surface {
            case "dictionary": "DICT-1${Environment.NewLine}"
            case "hashSet": "HASHSET-1${Environment.NewLine}"
            case "listContains": "LIST-True${Environment.NewLine}"
            case "format": "FORMAT-TOSTRING-33${Environment.NewLine}INTERP-TOSTRING-33${Environment.NewLine}"
            default: throw ArgumentOutOfRangeException("surface", surface, nil)
        }
        Assert.Equal(expected, await RunDriverAsync(source, suffix, driver))
    }

    @Theory
    @InlineData("dictionary")
    @InlineData("hashSet")
    @InlineData("listContains")
    @InlineData("operatorEquals")
    @InlineData("equals")
    @InlineData("getHashCode")
    async func Issue3134_ClassIdentityAndStructValueEqualityAgreeAcrossEmittedDrivers(surface string) {
        let suffix = Guid.NewGuid().ToString("N")
        let source = BuildIssue3134Source(surface, suffix)
        let emitted = await RunDriverAsync(source, suffix + "Emit", "gsc-emit")
        AssertIssue3134EmittedSemantics(surface, emitted)
        Assert.Equal(emitted, await RunDriverAsync(source, suffix + "Evaluate", "gsc-script"))
        Assert.Equal(emitted, await RunDriverAsync(source, suffix + "Gsi", "gsi"))
    }

    @Theory
    @InlineData("objectStringLiterals", "ObjectStringLiterals|True|True|False|False|False|True")
    @InlineData("objectLiteralAndComputedString", "ObjectLiteralAndComputedString|False|True|False|True|False|True")
    @InlineData("objectStrings", "ObjectStrings|False|True|False|True|False|True")
    @InlineData("objectClass", "ObjectClass|False|True|False|True|False|True")
    @InlineData("objectBoxedInts", "ObjectBoxedInts|False|True|False|True|False|True")
    @InlineData("objectBoxedStruct", "ObjectBoxedStruct|False|True|False|True|False|True")
    @InlineData(
        "objectBoxedStructClrInterfaceAlias",
        "ObjectBoxedStructClrInterfaceAlias|False|True|False|True|False|True"
    )
    @InlineData("objectBoxedStructInterfaceAlias", "ObjectBoxedStructInterfaceAlias|False|True|False|True|False|True")
    @InlineData("objectBoxedStructInCopiedValue", "ObjectBoxedStructInCopiedValue|False|True|False|True|False|True")
    @InlineData("objectBoxedEnum", "ObjectBoxedEnum|False|True|False|True|False|True")
    @InlineData("dataClass", "DataClass|True|True|False|False|False|True")
    @InlineData("version", "Version|True|True|False|False|False|True")
    @InlineData("typedStrings", "TypedStrings|True|True|False|False|False|True")
    async func Issue3173_ObjectReferenceEqualityAgreesAcrossEmittedDrivers(specimen string, expected string) {
        let suffix = Guid.NewGuid().ToString("N")
        let source = BuildIssue3173Source(specimen, suffix)
        let emitted = await RunDriverAsync(source, suffix + "Emit", "gsc-emit")
        // ADR-0156 Phase 3c (#3176): #3195 pinned the emitted output first
        // and required the tree-walking evaluator and evaluator SessionEngine
        // to match it; those engines are deleted, so the goldens stand as
        // emitted assertions across the surviving hosts (bare gsc script,
        // gsi script, and the interactive emitted engine).
        Assert.Equal(expected + Environment.NewLine, emitted)
        Assert.All(
            []string{
                await RunDriverAsync(source, suffix + "Evaluate", "gsc-script"),
                await RunDriverAsync(source, suffix + "Gsi", "gsi"),
                EvaluateWithSessionEngine(source)
            },
            (output string) -> Assert.Equal(emitted, output)
        )
    }

    @Theory
    @InlineData(false, "gsc-script")
    @InlineData(false, "gsc-emit")
    @InlineData(false, "gsi")
    @InlineData(true, "gsc-script")
    @InlineData(true, "gsc-emit")
    @InlineData(true, "gsi")
    async func ImplicitBclToString_DepthFourOverrideChain_UsesMostDerivedOverrideAcrossDrivers(
        insideFunction bool,
        driver string
    ) {
        let suffix = Guid.NewGuid().ToString("N")
        let source = BuildDepthFourBclOverrideSource(insideFunction, suffix)
        Assert.Equal(
            "FORMAT-LEVEL-44${Environment.NewLine}INTERP-LEVEL-44${Environment.NewLine}",
            await RunDriverAsync(source, suffix, driver)
        )
    }

    @Fact
    func GenericInterfaceOperatorNestedAndSharedShapes_DispatchOverrides() {
        const Source = `package Issue2896.Shapes
import System

interface IMarker {
    func Marker() string;
}

struct GenericValue[T any] {
    var Item T
    override func ToString() string -> "GENERIC-OVERRIDDEN-23"
}

struct InterfaceValue : IMarker {
    var Number int32
    func Marker() string -> "MARKER-31"
    override func ToString() string -> "INTERFACE-OVERRIDDEN-31"
}

struct OperatorValue : IEquatable[OperatorValue] {
    var Number int32
    func Equals(other OperatorValue) bool -> Number == other.Number
    override func Equals(value object) bool -> false
    override func GetHashCode() int32 -> 289637
}

func (left OperatorValue) operator ==(right OperatorValue) bool ->
    left.Number == right.Number

func (left OperatorValue) operator !=(right OperatorValue) bool ->
    left.Number != right.Number

class Container {
    struct NestedValue {
        var Number int32
        override func ToString() string -> "NESTED-OVERRIDDEN-41"
    }
}

struct SharedValue {
    var Number int32
    shared {
        func Label() string -> "SHARED-43"
    }
    override func ToString() string -> "SHARED-OVERRIDDEN-43"
}

func PrintGeneric[T any](value T) {
    Console.WriteLine(value.ToString())
}

let genericValue = GenericValue[int32]{Item: 7}
Console.WriteLine(genericValue.ToString())
PrintGeneric(genericValue)

let interfaceValue = InterfaceValue{Number: 7}
let boxedInterface object = interfaceValue
Console.WriteLine(interfaceValue.Marker())
Console.WriteLine(interfaceValue.ToString())
Console.WriteLine(boxedInterface.ToString())

let operatorLeft = OperatorValue{Number: 7}
let operatorRight = OperatorValue{Number: 7}
let boxedOperator object = operatorLeft
Console.WriteLine(operatorLeft == operatorRight)
Console.WriteLine(operatorLeft.Equals(operatorRight))
Console.WriteLine(boxedOperator.Equals(operatorRight))
Console.WriteLine(boxedOperator.GetHashCode())

let nestedValue = Container.NestedValue{Number: 7}
let boxedNested object = nestedValue
Console.WriteLine(nestedValue.ToString())
Console.WriteLine(boxedNested.ToString())

let sharedValue = SharedValue{Number: 7}
let boxedShared object = sharedValue
Console.WriteLine(SharedValue.Label())
Console.WriteLine(sharedValue.ToString())
Console.WriteLine(boxedShared.ToString())`
        Assert.Equal(`GENERIC-OVERRIDDEN-23
GENERIC-OVERRIDDEN-23
MARKER-31
INTERFACE-OVERRIDDEN-31
INTERFACE-OVERRIDDEN-31
True
True
False
289637
NESTED-OVERRIDDEN-41
NESTED-OVERRIDDEN-41
SHARED-43
SHARED-OVERRIDDEN-43
SHARED-OVERRIDDEN-43`.ReplaceLineEndings(Environment.NewLine) + Environment.NewLine, RunEmittedOracle(Source))
    }

    @Fact
    func DataAndDefaultStructBehavior_RemainsUnchanged() {
        const Source = `package Issue2896.Controls
import System

data struct DataValue {
    var Number int32
}

struct DefaultValue {
    var Number int32
}

let dataValue = DataValue{Number: 7}
let boxedData object = dataValue
Console.WriteLine(dataValue.ToString())
Console.WriteLine(boxedData.ToString())

let defaultValue = DefaultValue{Number: 7}
let boxedDefault object = defaultValue
Console.WriteLine(defaultValue.ToString())
Console.WriteLine(boxedDefault.ToString())`
        // Issue #3204 / ADR-0156 Phase 3c (#3176): with the tree-walking
        // evaluator retired, emitted execution IS the semantics — a `data`
        // struct keeps its synthesized record-style rendering, while a plain
        // struct without a ToString override falls to ValueType.ToString
        // (the CLR type name). The evaluator's record-style rendering for
        // plain structs retired with it.
        Assert.Equal(
            "DataValue { Number = 7 }${Environment.NewLine}DataValue { Number = 7 }${Environment.NewLine}" +
                "Issue2896.Controls.DefaultValue${Environment.NewLine}Issue2896.Controls.DefaultValue${Environment.NewLine}",
            RunEmittedOracle(Source)
        )
    }

    shared {
        private func RunEmittedOracle(source string) string {
            let result = EmittedOracle.Evaluate(source)
            let errors = result
                .Diagnostics
                .Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                .ToArray()
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.ToString())
                )
            )
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }

        private func BuildIssue3134Source(surface string, suffix string) string {
            let declarations = (`package Issue3134` + "$suffix" + `
import System
import System.Collections.Generic

class ClassWithOverrides` + "$suffix" + ` {
    var Number int32
    override func Equals(value object) bool -> true
    override func GetHashCode() int32 -> 313401
}

class ClassWithoutOverrides` + "$suffix" + ` {
    var Number int32
}

data class DataClass` + "$suffix" + `(Number int32) {
}

struct StructWithOverrides` + "$suffix" + ` {
    var Number int32
    override func Equals(value object) bool -> true
    override func GetHashCode() int32 -> 313402
}

struct StructWithoutOverrides` + "$suffix" + ` {
    var Number int32
}`)
            return declarations +
                "\n" +
                BuildIssue3134TypeProbe(
                surface,
                "ClassWithOverrides",
                "cwo",
                "ClassWithOverrides" + suffix,
                isClass: true,
                secondNumber: 22
            ) +
                BuildIssue3134TypeProbe(
                surface,
                "ClassWithoutOverrides",
                "cno",
                "ClassWithoutOverrides" + suffix,
                isClass: true,
                secondNumber: 11
            ) +
                BuildIssue3134TypeProbe(
                surface,
                "DataClass",
                "data",
                "DataClass" + suffix,
                isClass: true,
                secondNumber: 11,
                usePrimaryConstructor: true
            ) +
                BuildIssue3134TypeProbe(
                surface,
                "StructWithOverrides",
                "swo",
                "StructWithOverrides" + suffix,
                isClass: false,
                secondNumber: 22
            ) +
                BuildIssue3134TypeProbe(
                surface,
                "StructWithoutOverrides",
                "sno",
                "StructWithoutOverrides" + suffix,
                isClass: false,
                secondNumber: 11
            )
        }

        private func BuildIssue3134TypeProbe(
            surface string,
            label string,
            prefix string,
            typeName string,
            isClass bool,
            secondNumber int32,
            usePrimaryConstructor bool = false
        ) string {
            let setup = if usePrimaryConstructor {
                (`let ` + "$prefix" + `A = ` + "$typeName" + `(11)
let ` + "$prefix" + `B = ` + "$typeName" + `(` + "$secondNumber" + `)
let ` + "$prefix" + `C = ` + "$prefix" + `A
let ` + "$prefix" + `Other = ` + "$typeName" + `(33)`)
            } else {
                (
                    if isClass {
                        (`let ` + "$prefix" + `A = ` + "$typeName" + `()
` + "$prefix" + `A.Number = 11
let ` + "$prefix" + `B = ` + "$typeName" + `()
` + "$prefix" + `B.Number = ` + "$secondNumber" + `
let ` + "$prefix" + `C = ` + "$prefix" + `A
let ` + "$prefix" + `Other = ` + "$typeName" + `()
` + "$prefix" + `Other.Number = 33`)
                    } else {
                        (`let ` + "$prefix" + `A = ` + "$typeName" + `{Number: 11}
let ` + "$prefix" + `B = ` + "$typeName" + `{Number: ` + "$secondNumber" + `}
let ` + "$prefix" + `C = ` + "$prefix" + `A
let ` + "$prefix" + `Other = ` + "$typeName" + `{Number: 33}`)
                    }
                )
            }
            let probe = switch surface {
                case "dictionary": (`let ` + "$prefix" + `Values = Dictionary[` + "$typeName" + `, string]()
` + "$prefix" + `Values[` + "$prefix" + `A] = "A-11"
` + "$prefix" + `Values[` + "$prefix" + `B] = "B-` + "$secondNumber" + `"
` + "$prefix" + `Values[` + "$prefix" + `C] = "C-11"
Console.WriteLine(String.Format(
    "` + "$label" + `|{0}|{1}|{2}|{3}",
    ` + "$prefix" + `Values.Count,
    ` + "$prefix" + `Values[` + "$prefix" + `A],
    ` + "$prefix" + `Values[` + "$prefix" + `B],
    ` + "$prefix" + `Values.ContainsKey(` + "$prefix" + `Other)))`)
                case "hashSet": (`let ` + "$prefix" + `Values = HashSet[` + "$typeName" + `]()
let ` + "$prefix" + `AddedA = ` + "$prefix" + `Values.Add(` + "$prefix" + `A)
let ` + "$prefix" + `AddedB = ` + "$prefix" + `Values.Add(` + "$prefix" + `B)
let ` + "$prefix" + `AddedC = ` + "$prefix" + `Values.Add(` + "$prefix" + `C)
Console.WriteLine(String.Format(
    "` + "$label" + `|{0}|{1}|{2}|{3}|{4}",
    ` + "$prefix" + `Values.Count,
    ` + "$prefix" + `AddedA,
    ` + "$prefix" + `AddedB,
    ` + "$prefix" + `AddedC,
    ` + "$prefix" + `Values.Contains(` + "$prefix" + `Other)))`)
                case "listContains": (`let ` + "$prefix" + `Values = List[` + "$typeName" + `]()
` + "$prefix" + `Values.Add(` + "$prefix" + `A)
Console.WriteLine(String.Format(
    "` + "$label" + `|{0}|{1}|{2}|{3}|{4}",
    ` + "$prefix" + `Values.Count,
    ` + "$prefix" + `Values[0].Number,
    ` + "$prefix" + `Values.Contains(` + "$prefix" + `A),
    ` + "$prefix" + `Values.Contains(` + "$prefix" + `B),
    ` + "$prefix" + `Values.Contains(` + "$prefix" + `Other)))`)
                case "operatorEquals" when isClass: (`Console.WriteLine(String.Format(
    "` + "$label" + `|{0}|{1}|{2}|{3}|{4}|{5}",
    ` + "$prefix" + `A == ` + "$prefix" + `B,
    ` + "$prefix" + `A == ` + "$prefix" + `C,
    ` + "$prefix" + `A == ` + "$prefix" + `Other,
    ` + "$prefix" + `A != ` + "$prefix" + `B,
    ` + "$prefix" + `A != ` + "$prefix" + `C,
    ` + "$prefix" + `A != ` + "$prefix" + `Other))`)
                case "operatorEquals": "Console.WriteLine(\"$label|N/A\")"
                case "equals": (`Console.WriteLine(String.Format(
    "` + "$label" + `|{0}|{1}|{2}",
    ` + "$prefix" + `A.Equals(` + "$prefix" + `B),
    ` + "$prefix" + `A.Equals(` + "$prefix" + `C),
    ` + "$prefix" + `A.Equals(` + "$prefix" + `Other)))`)
                case "getHashCode": (`Console.WriteLine(String.Format(
    "` + "$label" + `|{0}|{1}",
    ` + "$prefix" + `A.GetHashCode() == ` + "$prefix" + `B.GetHashCode(),
    ` + "$prefix" + `A.GetHashCode() == ` + "$prefix" + `C.GetHashCode()))`)
                default: throw ArgumentOutOfRangeException("surface", surface, nil)
            }
            return setup + "\n" + probe + "\n"
        }

        private func AssertIssue3134EmittedSemantics(surface string, output string) {
            let expected = switch surface {
                case "dictionary": []string{
                    "ClassWithOverrides|1|C-11|C-11|True",
                    "ClassWithoutOverrides|2|C-11|B-11|False",
                    "DataClass|1|C-11|C-11|False",
                    "StructWithOverrides|1|C-11|C-11|True",
                    "StructWithoutOverrides|1|C-11|C-11|False"
                }
                case "hashSet": []string{
                    "ClassWithOverrides|1|True|False|False|True",
                    "ClassWithoutOverrides|2|True|True|False|False",
                    "DataClass|1|True|False|False|False",
                    "StructWithOverrides|1|True|False|False|True",
                    "StructWithoutOverrides|1|True|False|False|False"
                }
                case "listContains": []string{
                    "ClassWithOverrides|1|11|True|True|True",
                    "ClassWithoutOverrides|1|11|True|False|False",
                    "DataClass|1|11|True|True|False",
                    "StructWithOverrides|1|11|True|True|True",
                    "StructWithoutOverrides|1|11|True|True|False"
                }
                case "operatorEquals": []string{
                    "ClassWithOverrides|False|True|False|True|False|True",
                    "ClassWithoutOverrides|False|True|False|True|False|True",
                    "DataClass|True|True|False|False|False|True",
                    "StructWithOverrides|N/A",
                    "StructWithoutOverrides|N/A"
                }
                case "equals": []string{
                    "ClassWithOverrides|True|True|True",
                    "ClassWithoutOverrides|False|True|False",
                    "DataClass|True|True|False",
                    "StructWithOverrides|True|True|True",
                    "StructWithoutOverrides|True|True|False"
                }
                case "getHashCode": []string{
                    "ClassWithOverrides|True|True",
                    "ClassWithoutOverrides|False|True",
                    "DataClass|True|True",
                    "StructWithOverrides|True|True",
                    "StructWithoutOverrides|True|True"
                }
                default: throw ArgumentOutOfRangeException("surface", surface, nil)
            }
            Assert.Equal(expected, output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries))
        }

        private func BuildIssue3173Source(specimen string, suffix string) string {
            let declarations = (`package Issue3173` + "$suffix" + `
import System

class ClassWithOverrides` + "$suffix" + ` {
    var Number int32
    override func Equals(value object) bool -> true
}

data class DataClass` + "$suffix" + `(Number int32) {
}

interface Marker` + "$suffix" + ` {
}

struct Value` + "$suffix" + ` : Marker` + "$suffix" + `, IEquatable[Value` + "$suffix" + `] {
    var Number int32
    func Equals(other Value` + "$suffix" + `) bool -> Number == other.Number
}

struct Holder` + "$suffix" + ` {
    var Item object
}

enum Shade` + "$suffix" + ` {
    Light,
    Dark
}`)
            let (label, setup) = switch specimen {
                case "objectStringLiterals": ("ObjectStringLiterals", `let a object = "hello"
let b object = "hello"
let c object = a
let other object = "world"`)
                case "objectLiteralAndComputedString": ("ObjectLiteralAndComputedString", `let a object = "hello"
let b object = String.Concat("hel", "lo")
let c object = a
let other object = "world"`)
                case "objectStrings": ("ObjectStrings", `let a object = String.Concat("he", "llo")
let b object = String.Concat("hel", "lo")
let c object = a
let other object = String.Concat("wor", "ld")`)
                case "objectClass": ("ObjectClass", (`let a object = ClassWithOverrides` + "$suffix" + `{Number: 5}
let b object = ClassWithOverrides` + "$suffix" + `{Number: 5}
let c object = a
let other object = ClassWithOverrides` + "$suffix" + `{Number: 6}`))
                case "objectBoxedInts": ("ObjectBoxedInts", `let a object = 5
let b object = 5
let c object = a
let other object = 6`)
                case "objectBoxedStruct": ("ObjectBoxedStruct", (`let a object = Value` + "$suffix" + `{Number: 5}
let b object = Value` + "$suffix" + `{Number: 5}
let c object = a
let other object = Value` + "$suffix" + `{Number: 6}`))
                case "objectBoxedStructClrInterfaceAlias": (
                    "ObjectBoxedStructClrInterfaceAlias",
                    (`let a object = Value` + "$suffix" + `{Number: 5}
let b object = Value` + "$suffix" + `{Number: 5}
let c = a as IEquatable[Value` + "$suffix" + `]
let other object = Value` + "$suffix" + `{Number: 6}`)
                )
                case "objectBoxedStructInterfaceAlias": (
                    "ObjectBoxedStructInterfaceAlias",
                    (`let a object = Value` + "$suffix" + `{Number: 5}
let b object = Value` + "$suffix" + `{Number: 5}
let c = a as Marker` + "$suffix" + `
let other object = Value` + "$suffix" + `{Number: 6}`)
                )
                case "objectBoxedStructInCopiedValue": (
                    "ObjectBoxedStructInCopiedValue",
                    (`let a object = Value` + "$suffix" + `{Number: 5}
let holder = Holder` + "$suffix" + `{Item: a}
let copy = holder
let b object = Value` + "$suffix" + `{Number: 5}
let c object = copy.Item
let other object = Value` + "$suffix" + `{Number: 6}`)
                )
                case "objectBoxedEnum": ("ObjectBoxedEnum", (`let a object = Shade` + "$suffix" + `.Dark
let b object = Shade` + "$suffix" + `.Dark
let c object = a
let other object = Shade` + "$suffix" + `.Light`))
                case "dataClass": ("DataClass", (`let a = DataClass` + "$suffix" + `(5)
let b = DataClass` + "$suffix" + `(5)
let c = a
let other = DataClass` + "$suffix" + `(6)`))
                case "version": ("Version", `let a = Version(1, 2, 3)
let b = Version(1, 2, 3)
let c = a
let other = Version(2, 0, 0)`)
                case "typedStrings": ("TypedStrings", `let a = String.Concat("he", "llo")
let b = String.Concat("hel", "lo")
let c = a
let other = String.Concat("wor", "ld")`)
                default: throw ArgumentOutOfRangeException("specimen", specimen, nil)
            }
            return declarations + "\n" + setup + "\n" + (`Console.WriteLine(String.Format(
    "` + "$label" + `|{0}|{1}|{2}|{3}|{4}|{5}",
    a == b,
    a == c,
    a == other,
    a != b,
    a != c,
    a != other))`)
        }

        private func EvaluateWithSessionEngine(source string) string {
            // The interactive emitted engine (ADR-0156 Phase 3c, #3176).
            using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
            let cell = engine.Evaluate(source)
            Assert.False(
                cell.HasError,
                "interactive engine failed:\n" + string.Join(
                    "\n",
                    cell.Diagnostics.Select((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.ToString())
                )
            )
            Assert.Equal(string.Empty, cell.StandardError)
            return cell.Output.ReplaceLineEndings(Environment.NewLine)
        }

        private func BuildClassOverrideChainSource(insideFunction bool, suffix string) string {
            let declarations = (`package Issue2896.Driver` + "$suffix" + `
import System

open class L0` + "$suffix" + ` {
    open override func ToString() string -> "L0-11"
}

open class L1` + "$suffix" + ` : L0` + "$suffix" + ` {
    open override func ToString() string -> "L1-22"
}

class L2` + "$suffix" + ` : L1` + "$suffix" + ` {
    override func ToString() string -> "L2-33"
}`)
            let calls = (`let l0 object = L0` + "$suffix" + `()
let l1 object = L1` + "$suffix" + `()
let l2 object = L2` + "$suffix" + `()
Console.WriteLine(l0.ToString())
Console.WriteLine(l1.ToString())
Console.WriteLine(l2.ToString())`)
            return if insideFunction {
                declarations + "\nfunc Run" + suffix + "() {\n" + calls + `
}
Run` + suffix + "()\n"
            } else {
                declarations + "\n" + calls
            }
        }

        /// Gets all four implicit-BCL surfaces across both source positions and all drivers.
        func ImplicitBclOverrideCases() sequence[[]object] {
            let surfaces = []string{"dictionary", "hashSet", "listContains", "format"}
            let drivers = []string{"gsc-script", "gsc-emit", "gsi"}
            for surface in surfaces {
                for insideFunction in[]bool{false, true} {
                    for driver in drivers {
                        yield[]object{surface, insideFunction, driver}
                    }
                }
            }
        }

        private func BuildImplicitBclOverrideSource(surface string, insideFunction bool, suffix string) string {
            let declarations = (`package Issue3116` + "$suffix" + `
import System
import System.Collections.Generic

struct Value` + "$suffix" + ` {
    var Number int32
    override func ToString() string -> "TOSTRING-33"
    override func Equals(value object) bool -> true
    override func GetHashCode() int32 -> 7
}`)
            let calls = switch surface {
                case "dictionary": (`let values = Dictionary[Value` + "$suffix" + `, string]()
values[Value` + "$suffix" + `{Number: 11}] = "first"
values[Value` + "$suffix" + `{Number: 22}] = "second"
Console.WriteLine(String.Format("DICT-{0}", values.Count))`)
                case "hashSet": (`let values = HashSet[Value` + "$suffix" + `]()
values.Add(Value` + "$suffix" + `{Number: 11})
values.Add(Value` + "$suffix" + `{Number: 22})
Console.WriteLine(String.Format("HASHSET-{0}", values.Count))`)
                case "listContains": (`let values = List[Value` + "$suffix" + `]()
values.Add(Value` + "$suffix" + `{Number: 11})
Console.WriteLine(String.Format(
    "LIST-{0}",
    values.Contains(Value` + "$suffix" + `{Number: 22})))`)
                case "format": (`let value = Value` + "$suffix" + `{Number: 11}
Console.WriteLine(String.Format("FORMAT-{0}", value))
Console.WriteLine("INTERP-$value")`)
                default: throw ArgumentOutOfRangeException("surface", surface, nil)
            }
            return if insideFunction {
                declarations + "\nfunc Run" + suffix + "() {\n" + calls + `
}
Run` + suffix + "()\n"
            } else {
                declarations + "\n" + calls
            }
        }

        private func BuildDepthFourBclOverrideSource(insideFunction bool, suffix string) string {
            let declarations = (`package Issue3116Depth` + "$suffix" + `
import System

open class L0` + "$suffix" + ` {
    open override func ToString() string -> "LEVEL-11"
}

open class L1` + "$suffix" + ` : L0` + "$suffix" + ` {
    open override func ToString() string -> "LEVEL-22"
}

open class L2` + "$suffix" + ` : L1` + "$suffix" + ` {
    open override func ToString() string -> "LEVEL-33"
}

class L3` + "$suffix" + ` : L2` + "$suffix" + ` {
    override func ToString() string -> "LEVEL-44"
}`)
            let calls = (`let value object = L3` + "$suffix" + `()
Console.WriteLine(String.Format("FORMAT-{0}", value))
Console.WriteLine("INTERP-$value")`)
            return if insideFunction {
                declarations + "\nfunc Run" + suffix + "() {\n" + calls + `
}
Run` + suffix + "()\n"
            } else {
                declarations + "\n" + calls
            }
        }

        private async func RunDriverAsync(source string, suffix string, driver string) string {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2896StructObjectOverrideTests", suffix)
            Assert.False(Directory.Exists(directory))
            Directory.CreateDirectory(directory)
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory))
            try {
                let sourcePath = Path.Combine(directory, "test.gs")
                File.WriteAllText(sourcePath, source)
                return switch driver {
                    case "gsc-script": RunGscScript(sourcePath)
                    case "gsc-emit": await RunEmittedBinaryAsync(directory, sourcePath, suffix)
                    case "gsi": RunGsiScript(sourcePath)
                    default: throw ArgumentOutOfRangeException("driver", driver, nil)
                }
            } finally {
                try {
                    Directory.Delete(directory, recursive: true)
                } catch { }
            }
        }

        private func RunGscScript(sourcePath string) string {
            let result = CaptureConsole(() -> CompilerProgram.Main([]string{sourcePath}))
            Assert.True(result.ExitCode == 0, (`gsc script failed (` + "${result.ExitCode}" + `)
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            Assert.Equal(string.Empty, result.StandardError)
            Assert.EndsWith("Success.${Environment.NewLine}", result.StandardOutput, StringComparison.Ordinal)
            return result.StandardOutput[.. ^"Success.${Environment.NewLine}".Length]
        }

        private func RunGsiScript(sourcePath string) string {
            let result = CaptureConsole(() -> GSharp.Repl.Program.Main([]string{sourcePath}))
            Assert.True(result.ExitCode == 0, (`gsi failed (` + "${result.ExitCode}" + `)
stdout:
` + "${result.StandardOutput}" + `
stderr:
` + "${result.StandardError}"))
            Assert.Equal(string.Empty, result.StandardError)
            return result.StandardOutput
        }

        private async func RunEmittedBinaryAsync(directory string, sourcePath string, suffix string) string {
            let assemblyName = "Issue2896Driver" + suffix
            let outputPath = Path.Combine(directory, assemblyName + ".dll")
            let compile = CaptureConsole(
                () -> CompilerProgram.Main(
                    []string{
                        "/out:" + outputPath,
                        "/assemblyname:" + assemblyName,
                        "/target:exe",
                        "/targetframework:net10.0",
                        sourcePath
                    }
                )
            )
            Assert.True(compile.ExitCode == 0, (`gsc emit failed (` + "${compile.ExitCode}" + `)
stdout:
` + "${compile.StandardOutput}" + `
stderr:
` + "${compile.StandardError}"))
            Assert.Equal(string.Empty, compile.StandardError)
            CollectibleAssembly.Inspect(outputPath, (assembly Assembly) -> Assert.NotEmpty(assembly.GetTypes()))
            let runtimeConfigPath = Path.ChangeExtension(outputPath, ".runtimeconfig.json")
            File.WriteAllText(runtimeConfigPath, `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
            let result = await DotnetProcess.RunAsync(
                directory,
                []string{"exec", "--runtimeconfig", runtimeConfigPath, outputPath}
            )
            Assert.Equal(0, result.ExitCode)
            Assert.Equal(string.Empty, result.StandardError)
            return result.StandardOutput.ReplaceLineEndings(Environment.NewLine)
        }

        private func CaptureConsole(action() -> int32)(ExitCode int32, StandardOutput string, StandardError string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                let exitCode = action()
                return (
                    exitCode,
                    stdout.ToString().ReplaceLineEndings(Environment.NewLine),
                    stderr.ToString().ReplaceLineEndings(Environment.NewLine)
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
