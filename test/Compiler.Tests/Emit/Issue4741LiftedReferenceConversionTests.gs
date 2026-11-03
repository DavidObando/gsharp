// <copyright file="Issue4741LiftedReferenceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

class Issue4741LiftedReferenceConversionTests {
    @Theory
    @InlineData("ExplicitToken", "Box(value)", "(Box)value")
    @InlineData("ExplicitToken", "Box?(value)", "(Box?)value")
    @InlineData("ImplicitToken", "value", "value")
    @InlineData("GenericToken[int32]", "Box(value)", "(Box)value", "GenericToken<int>")
    @InlineData("ExplicitToken", "checked(Box(value))", "checked((Box)value)")
    @InlineData("ExplicitToken", "unchecked(Box(value))", "unchecked((Box)value)")
    func ImportedConversion_SkipsNullAndEvaluatesPresentOnce(
        token string,
        cast string,
        csharpCast string,
        csharpToken string? = nil
    ) {
        RunPair((`func Convert(present bool) Box? {
    return ` + "${cast.Replace("value", "Probe.Read[$token](present)", StringComparison.Ordinal)}" + `
}`), (`static Box? Convert(bool present) {
    return ` + "${csharpCast.Replace("value", "Probe.Read<${csharpToken ?? token}>(present)", StringComparison.Ordinal)}" + `;
}`))
    }

    @Theory
    @InlineData("NullableInputToken", "Box(value)", "(Box)value", "Box")
    @InlineData("NullableInputToken", "Box?(value)", "(Box?)value", "Box?")
    @InlineData("NullableImplicitInputToken", "value", "value", "Box")
    @InlineData("DualNullableInputToken", "value", "value", "Box")
    @InlineData("DualNullableInputToken", "value", "value", "Box?")
    @InlineData("GenericNullableInputToken[int32]", "Box(value)", "(Box)value", "Box", "GenericNullableInputToken<int>")
    @InlineData(
        "GenericNullableInputToken[string]",
        "Box(value)",
        "(Box)value",
        "Box",
        "GenericNullableInputToken<string>"
    )
    @InlineData("NullableReturningInputToken", "Box?(value)", "(Box?)value", "Box?", nil, "111,110,18,10,11,10")
    func ImportedNullableOperand_ActuallyRunsOnNullAndPreservesItsContract(
        token string,
        cast string,
        csharpCast string,
        result string,
        csharpToken string? = nil,
        expectedOutput string = "110,110,18,10,11,10"
    ) {
        RunPair((`func Raw(present bool) ` + "$result" + ` {
    return ` + "${cast.Replace("value", "Probe.Read[$token](present)", StringComparison.Ordinal)}" + `
}
func Convert(present bool) Box? -> Raw(present)`), (`static ` + "$result" + ` Raw(bool present) {
    return ` + "${csharpCast.Replace("value", "Probe.Read<${csharpToken ?? token}>(present)", StringComparison.Ordinal)}" + `;
}
static Box? Convert(bool present) => Raw(present);`), expectedOutput)
    }

    @Fact
    func ImportedNullableOperand_NullableReturnCannotSatisfyANonNullableContract() {
        RunPair(`func Raw(present bool) Box -> Probe.Read[NullableReturningImplicitInputToken](present)
func Convert(present bool) Box? -> Raw(present)`, `static Box Raw(bool present) => Probe.Read<NullableReturningImplicitInputToken>(present);
static Box? Convert(bool present) => Raw(present);`, expectedOutput: "111,110,18,10,11,10", expectedDiagnostic: "GS0155")
    }

    @Theory
    @InlineData("initializer")
    @InlineData("assignment")
    @InlineData("argument")
    @InlineData("tuple")
    func ContextualImplicitConversion_UsesTheSameNullBypass(sink string) {
        let bodies = switch sink {
            case "initializer": ("let result Box? = value\nreturn result", "Box? result = value; return result;")
            case "assignment": (`var result Box? = nil
result = value
return result`, "Box? result = null; result = value; return result;")
            case "argument": ("return Accept(value)", "return Accept(value);")
            case "tuple": (
                "let row (Value Box?, Code int32) = (value, 7)\nreturn row.Value",
                "(Box? Value, int Code) row = (value, 7); return row.Value;"
            )
            default: throw ArgumentOutOfRangeException("sink")
        }
        RunPair((`func Accept(value Box?) Box? -> value
func Convert(present bool) Box? {
    let value ImplicitToken? = Probe.Read[ImplicitToken](present)
    ` + "${bodies.Item1}" + `
}`), (`static Box? Accept(Box? value) => value;
static Box? Convert(bool present) {
    ImplicitToken? value = Probe.Read<ImplicitToken>(present);
    ` + "${bodies.Item2}" + `
}`))
    }

    @Theory
    @InlineData("return", false)
    @InlineData("initializer", false)
    @InlineData("assignment", false)
    @InlineData("argument", false)
    @InlineData("tuple", false)
    @InlineData("return", true)
    @InlineData("initializer", true)
    @InlineData("assignment", true)
    @InlineData("argument", true)
    @InlineData("tuple", true)
    func ContextualImplicitConversion_RejectsNonNullableSinks(sink string, sourceOwned bool) {
        let token = if sourceOwned {
            "LocalImplicit"
        } else {
            "ImplicitToken"
        }
        let gsharpDeclaration = if sourceOwned {
            `struct LocalImplicit {}
func operator implicit(value LocalImplicit) Box { Probe.Calls += 1
return Box() }`
        } else {
            string.Empty
        }
        let csharpDeclaration = if sourceOwned {
            "public struct LocalImplicit { public static implicit operator Box(LocalImplicit value) { Probe.Calls++; return new Box(); } }"
        } else {
            string.Empty
        }
        let bodies = switch sink {
            case "initializer": ("let result Box = value\nreturn result", "Box result = value; return result;")
            case "assignment": (`var result Box = Box()
result = value
return result`, "Box result = new Box(); result = value; return result;")
            case "argument": ("return Accept(value)", "return Accept(value);")
            case "tuple": (
                "let row (Value Box, Code int32) = (value, 7)\nreturn row.Value",
                "(Box Value, int Code) row = (value, 7); return row.Value;"
            )
            case "return": ("return value", "return value;")
            default: throw ArgumentOutOfRangeException("sink")
        }
        let name = if sink == "return" {
            "Raw"
        } else {
            "Convert"
        }
        let result = if sink == "return" {
            "Box"
        } else {
            "Box?"
        }
        RunPair(("" + "$gsharpDeclaration" + `
func Accept(value Box) Box? -> value
func ` + "$name" + `(present bool) ` + "$result" + ` {
    let value ` + "$token" + `? = Probe.Read[` + "$token" + `](present)
    ` + "${bodies.Item1}" + `
}
` + "${(if sink == "return" { "func Convert(present bool) Box? -> Raw(present)" } else { string.Empty })}"), (
                "" + "$csharpDeclaration" + `
static Box? Accept(Box value) => value;
static ` + "$result" + ` ` + "$name" + `(bool present) {
    ` + "$token" + `? value = Probe.Read<` + "$token" + `>(present);
    ` + "${bodies.Item2}" + `
}
` + "${(if sink == "return" { "static Box? Convert(bool present) => Raw(present);" } else { string.Empty })}"
            ), expectedDiagnostic: if sink == "argument" {
                "GS0154"
            } else {
                "GS0155"
            })
    }

    @Theory
    @InlineData("DualBox")
    @InlineData("DualBox?")
    func ExactNullableOperandOperator_TakesPrecedenceOverTheLift(result string) {
        RunPair((`struct DualToken {}
class DualBox {
    shared {
        func operator implicit(value DualToken) DualBox {
            Probe.Calls += 1
            return DualBox()
        }
        func operator implicit(value DualToken?) DualBox {
            Probe.Calls += 1
            return DualBox()
        }
    }
}
func Raw(present bool) ` + "$result" + ` -> Probe.Read[DualToken](present)
func Convert(present bool) DualBox? -> Raw(present)`), (`public struct DualToken {}
public sealed class DualBox {
    public static implicit operator DualBox(DualToken value) { Probe.Calls++; return new DualBox(); }
    public static implicit operator DualBox(DualToken? value) { Probe.Calls++; return new DualBox(); }
}
static ` + "$result" + ` Raw(bool present) => Probe.Read<DualToken>(present);
static DualBox? Convert(bool present) => Raw(present);`), expectedOutput: "110,110,18,10,11,10")
    }

    @Theory
    @InlineData("explicit", "Box(value)")
    @InlineData("implicit", "value")
    func SourceConversion_LiftsOnlyTheNonNullableValueOperand(kind string, cast string) {
        RunPair((`struct LocalToken {}
func operator ` + "$kind" + `(value LocalToken) Box {
    Probe.Calls += 1
    return Box()
}
func Convert(present bool) Box? {
    return ` + "${cast.Replace("value", "Probe.Read[LocalToken](present)", StringComparison.Ordinal)}" + `
}`), (`public struct LocalToken {
    public static ` + "$kind" + ` operator Box(LocalToken value) {
        Probe.Calls++;
        return new Box();
    }
}
static Box? Convert(bool present) {
    return ` + "${(if kind == "explicit" { "(Box)Probe.Read<LocalToken>(present)" } else { "Probe.Read<LocalToken>(present)" })}" + `;
}`))
    }

    @Fact
    func ReferenceConstrainedResult_PreservesTheLiftAndOperatorReturn() {
        RunPair(`struct RefWrapper[T class] {
    shared {
        func operator explicit(value RefWrapper[T]) T {
            Probe.Calls += 1
            return T(object(Box()))
        }
    }
}
func OpenConvert[T class](value RefWrapper[T]?) T? -> T?(value)
func Convert(present bool) Box? -> OpenConvert[Box](Probe.Read[RefWrapper[Box]](present))`, `public struct RefWrapper<T> where T : class {
    public static explicit operator T(RefWrapper<T> value) {
        Probe.Calls++;
        return (T)(object)new Box();
    }
}
static T? OpenConvert<T>(RefWrapper<T>? value) where T : class => (T?)value;
static Box? Convert(bool present) => OpenConvert(Probe.Read<RefWrapper<Box>>(present));`)
    }

    @Theory
    @InlineData(
        "int32",
        "int32(Probe.Read[NullAwareValueToken](present))",
        "int",
        "(int)Probe.Read<NullAwareValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32",
        "cast[int32](Probe.Read[NullAwareValueToken](present))",
        "int",
        "(int)Probe.Read<NullAwareValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32?",
        "int32?(Probe.Read[NullAwareValueToken](present))",
        "int?",
        "(int?)Probe.Read<NullAwareValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32?",
        "cast[int32?](Probe.Read[NullAwareValueToken](present))",
        "int?",
        "(int?)Probe.Read<NullAwareValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32",
        "int32(Probe.ReadValue[NullAwareValueToken]())",
        "int",
        "(int)Probe.ReadValue<NullAwareValueToken>()",
        "119,119"
    )
    @InlineData(
        "int32",
        "Probe.Read[NullAwareImplicitValueToken](present)",
        "int",
        "Probe.Read<NullAwareImplicitValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32?",
        "Probe.Read[NullAwareImplicitValueToken](present)",
        "int?",
        "Probe.Read<NullAwareImplicitValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32?",
        "int32?(Probe.ReadValue[OpaqueValueToken]())",
        "int?",
        "(int?)Probe.ReadValue<OpaqueValueToken>()",
        "111,111"
    )
    @InlineData(
        "int32?",
        "cast[int32?](Probe.ReadValue[OpaqueValueToken]())",
        "int?",
        "(int?)Probe.ReadValue<OpaqueValueToken>()",
        "111,111"
    )
    @InlineData(
        "int32?",
        "Probe.ReadValue[OpaqueImplicitValueToken]()",
        "int?",
        "Probe.ReadValue<OpaqueImplicitValueToken>()",
        "111,111"
    )
    @InlineData(
        "int32?",
        "int32?(Probe.Read[OpaqueValueToken](present))",
        "int?",
        "(int?)Probe.Read<OpaqueValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "Probe.Read[OpaqueImplicitValueToken](present)",
        "int?",
        "Probe.Read<OpaqueImplicitValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "int32?(Probe.Read[NullAwareOpaqueValueToken](present))",
        "int?",
        "(int?)Probe.Read<NullAwareOpaqueValueToken>(present)",
        "111,119"
    )
    @InlineData(
        "int32?",
        "cast[int32?](Probe.Read[NullAwareOpaqueValueToken](present))",
        "int?",
        "(int?)Probe.Read<NullAwareOpaqueValueToken>(present)",
        "111,119"
    )
    @InlineData(
        "int32?",
        "Probe.Read[NullAwareImplicitOpaqueValueToken](present)",
        "int?",
        "Probe.Read<NullAwareImplicitOpaqueValueToken>(present)",
        "111,119"
    )
    @InlineData(
        "int32",
        "Probe.Read[DualNullableValueToken](present)",
        "int",
        "Probe.Read<DualNullableValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32?",
        "Probe.Read[DualNullableValueToken](present)",
        "int?",
        "Probe.Read<DualNullableValueToken>(present)",
        "119,119"
    )
    @InlineData(
        "int32",
        "int32(Probe.ReadValue[DualReturnValueToken]())",
        "int",
        "(int)Probe.ReadValue<DualReturnValueToken>()",
        "117,117"
    )
    @InlineData(
        "int32?",
        "int32?(Probe.ReadValue[DualReturnValueToken]())",
        "int?",
        "(int?)Probe.ReadValue<DualReturnValueToken>()",
        "119,119"
    )
    @InlineData(
        "int32",
        "OpenNullAware[LocalItem](Probe.Read[GenericNullAwareValueToken[LocalItem]](present))",
        "int",
        "(int)Probe.Read<GenericNullAwareValueToken<int>>(present)",
        "119,119"
    )
    @InlineData(
        "int32?",
        "OpenOpaque[LocalItem](Probe.ReadValue[GenericOpaqueValueToken[LocalItem]]())",
        "int?",
        "(int?)Probe.ReadValue<GenericOpaqueValueToken<int>>()",
        "111,111"
    )
    @InlineData(
        "int32",
        "EvalTree[NullAwareValueToken, int32]((v NullAwareValueToken) -> int32(v), Probe.ReadValue[NullAwareValueToken]())",
        "int",
        "EvalTree<NullAwareValueToken, int>(v => (int)v, Probe.ReadValue<NullAwareValueToken>())",
        "119,119"
    )
    @InlineData(
        "int32?",
        "EvalTree[NullAwareValueToken, int32?]((v NullAwareValueToken) -> int32?(v), Probe.ReadValue[NullAwareValueToken]())",
        "int?",
        "EvalTree<NullAwareValueToken, int?>(v => (int?)v, Probe.ReadValue<NullAwareValueToken>())",
        "119,119"
    )
    @InlineData(
        "int32?",
        "EvalTree[NullAwareValueToken?, int32?]((v NullAwareValueToken?) -> int32?(v), Probe.Read[NullAwareValueToken](present))",
        "int?",
        "EvalTree<NullAwareValueToken?, int?>(v => (int?)v, Probe.Read<NullAwareValueToken>(present))",
        "119,119"
    )
    @InlineData(
        "int32?",
        "EvalTree[OpaqueValueToken, int32?]((v OpaqueValueToken) -> int32?(v), Probe.ReadValue[OpaqueValueToken]())",
        "int?",
        "EvalTree<OpaqueValueToken, int?>(v => (int?)v, Probe.ReadValue<OpaqueValueToken>())",
        "111,111"
    )
    @InlineData(
        "int32?",
        "EvalTree[GenericOpaqueValueToken[LocalItem], int32?]((v GenericOpaqueValueToken[LocalItem]) -> int32?(v), Probe.ReadValue[GenericOpaqueValueToken[LocalItem]]())",
        "int?",
        "EvalTree<GenericOpaqueValueToken<int>, int?>(v => (int?)v, Probe.ReadValue<GenericOpaqueValueToken<int>>())",
        "111,111"
    )
    @InlineData(
        "int32",
        "EvalTree[GenericNullAwareValueToken[LocalItem]?, int32]((v GenericNullAwareValueToken[LocalItem]?) -> int32(v), Probe.Read[GenericNullAwareValueToken[LocalItem]](present))",
        "int",
        "EvalTree<GenericNullAwareValueToken<int>?, int>(v => (int)v, Probe.Read<GenericNullAwareValueToken<int>>(present))",
        "119,119"
    )
    @InlineData(
        "int32",
        "EvalTree[GenericNullAwareValueToken[LocalItem], int32]((v GenericNullAwareValueToken[LocalItem]) -> int32(v), Probe.ReadValue[GenericNullAwareValueToken[LocalItem]]())",
        "int",
        "EvalTree<GenericNullAwareValueToken<int>, int>(v => (int)v, Probe.ReadValue<GenericNullAwareValueToken<int>>())",
        "119,119"
    )
    @InlineData(
        "int32",
        "Probe.AcceptSpan(Span[uint8]([]uint8{1, 2, 3})) + (if present { 0 } else { 0 }) + 10 * (Probe.Calls + 1) + 100 * Probe.Reads",
        "int",
        "Probe.AcceptSpan(new System.Span<byte>(new byte[] { 1, 2, 3 })) + (present ? 0 : 0) + 10 * (Probe.Calls + 1) + 100 * Probe.Reads",
        "13,13"
    )
    func ImportedNullableValueSignature_MatchesRoslynAndVerifies(
        gsharpResult string,
        gsharpBody string,
        csharpResult string,
        csharpBody string,
        expectedOutput string
    ) {
        RunValuePair((`import System.Linq.Expressions
struct LocalItem {}
func EvalTree[T, TResult](expr Expression[Func[T, TResult]], value T) TResult -> expr.Compile()(value)
func OpenNullAware[T](value GenericNullAwareValueToken[T]?) int32 -> int32(value)
func OpenOpaque[T](value GenericOpaqueValueToken[T]) int32? -> int32?(value)
func Raw(present bool) ` + "$gsharpResult" + ` -> ` + "$gsharpBody" + `
func Convert(present bool) int32? -> Raw(present)`), (`static TResult EvalTree<T, TResult>(System.Linq.Expressions.Expression<System.Func<T, TResult>> expr, T value) => expr.Compile()(value);
static ` + "$csharpResult" + ` Raw(bool present) => ` + "$csharpBody" + `;
static int? Convert(bool present) => Raw(present);`), expectedOutput)
    }

    @Theory
    @InlineData("int32(Probe.ReadValue[OpaqueValueToken]())")
    @InlineData("Probe.ReadValue[OpaqueImplicitValueToken]()")
    @InlineData("int32(Probe.Read[NullAwareOpaqueValueToken](present))")
    @InlineData("Probe.Read[NullAwareImplicitOpaqueValueToken](present)")
    @InlineData("int32(Probe.Read[NumericToken](present))")
    @InlineData("([]uint8(Span[uint8]([]uint8{1}))).Length")
    func ImportedNullableValueSignature_RejectsNonNullableValueTarget(gsharpBody string) {
        RunValuePair((`func Raw(present bool) int32 -> ` + "$gsharpBody" + `
func Convert(present bool) int32? -> Raw(present)`), `static int? Convert(bool present) => null;`, expectedOutput: "1,1", expectedDiagnostic: "GS0155")
    }

    @Fact
    func UnconstrainedNullableResult_IsNotMisclassifiedAsAReferenceLift() {
        const result = "T?"
        let directory = Path.Combine(AppContext.BaseDirectory, "issue4741-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let fixturePath = Path.Combine(directory, "Unknown4741.dll")
            EmitCSharp((`#nullable enable
using System;
public struct Wrapper<T> {
    public T Value;
    public static explicit operator T(Wrapper<T> value) {
        Oracle.Calls++;
        return value.Value;
    }
}
public static class Oracle {
    public static int Calls;
    static ` + "$result" + ` Convert<T>(Wrapper<T>? value) => (` + "$result" + `)value;
    public static string Run() {
        Calls = 0;
        try { Convert<int>(null); return "did not unwrap"; }
        catch (InvalidOperationException) {}
        var missing = 100 + 10 * Calls;
        Calls = 0;
        var present = Convert<int>(new Wrapper<int> { Value = 7 });
        return $"{missing},{present + 10 * Calls}";
    }
}`), fixturePath)
            let oracle = EmittedFixture.Load(fixturePath).GetType("Oracle", throwOnError: true) ??
                throw InvalidOperationException("Roslyn oracle type missing.")
            Assert.Equal("100,17", oracle.GetMethod("Run")?.Invoke(nil, nil))
            let sourcePath = Path.Combine(directory, "Unknown.gs")
            let assemblyPath = Path.Combine(directory, "Unknown.dll")
            File.WriteAllText(sourcePath, (`package Unknown4741
struct Wrapper[T] {
    var Value T
    shared {
        func operator explicit(value Wrapper[T]) T -> value.Value
    }
}
func Convert[T](value Wrapper[T]?) ` + "$result" + ` -> ` + "$result" + `(value)`))
            let compilation = CompileGSharp(sourcePath, assemblyPath, fixturePath)
            Assert.NotEqual(0, compilation.Exit)
            let errors = compilation
                .Diagnostics
                .Split('\n')
                .Where((line string) -> line.Contains(": error ", StringComparison.Ordinal))
                .ToArray()
            Assert.NotEmpty(errors)
            Assert.All(errors, (error string) -> Assert.Contains("GS0155", error, StringComparison.Ordinal))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func RunPair(
            gsharpConversion string,
            csharpConversion string,
            expectedOutput string = "101,110,18,10,11,10",
            expectedDiagnostic string? = nil
        ) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue4741-fixtures", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let fixturePath = Path.Combine(directory, "Fixture4741.dll")
                let fixtureSource = (`#nullable enable
namespace Fixture4741;
public sealed class Box {}
public struct ExplicitToken {
    public static explicit operator Box(ExplicitToken value) { Probe.Calls++; return new Box(); }
}
public struct ImplicitToken {
    public static implicit operator Box(ImplicitToken value) { Probe.Calls++; return new Box(); }
}
public struct GenericToken<T> {
    public static explicit operator Box(GenericToken<T> value) { Probe.Calls++; return new Box(); }
}
public struct NumericToken {
    public static explicit operator int(NumericToken value) { Probe.Calls++; return 7; }
}
public struct NullResultToken {
    public static explicit operator Box?(NullResultToken value) { Probe.Calls++; return null; }
}
public sealed class OrdinaryToken {
    public static explicit operator Box(OrdinaryToken? value) { Probe.Calls++; return new Box(); }
}
public struct NullableInputToken {
    public static explicit operator Box(NullableInputToken? value) { Probe.Calls++; return new Box(); }
}
public struct NullableImplicitInputToken {
    public static implicit operator Box(NullableImplicitInputToken? value) { Probe.Calls++; return new Box(); }
}
public struct DualNullableInputToken {
    public static implicit operator Box(DualNullableInputToken value) { Probe.Calls++; return new Box(); }
    public static implicit operator Box(DualNullableInputToken? value) { Probe.Calls++; return new Box(); }
}
public struct GenericNullableInputToken<T> {
    public static explicit operator Box(GenericNullableInputToken<T>? value) { Probe.Calls++; return new Box(); }
}
public struct NullableReturningInputToken {
    public static explicit operator Box?(NullableReturningInputToken? value) {
        Probe.Calls++;
        return value.HasValue ? new Box() : null;
    }
}
public struct NullableReturningImplicitInputToken {
    public static implicit operator Box?(NullableReturningImplicitInputToken? value) {
        Probe.Calls++;
        return value.HasValue ? new Box() : null;
    }
}
public struct NullAwareValueToken {
    public static explicit operator int(NullAwareValueToken? value) { Probe.Calls++; return 9; }
}
public struct NullAwareImplicitValueToken {
    public static implicit operator int(NullAwareImplicitValueToken? value) { Probe.Calls++; return 9; }
}
public struct OpaqueValueToken {
    public static explicit operator int?(OpaqueValueToken value) { Probe.Calls++; return null; }
}
public struct OpaqueImplicitValueToken {
    public static implicit operator int?(OpaqueImplicitValueToken value) { Probe.Calls++; return null; }
}
public struct NullAwareOpaqueValueToken {
    public static explicit operator int?(NullAwareOpaqueValueToken? value) {
        Probe.Calls++;
        return value.HasValue ? 9 : null;
    }
}
public struct NullAwareImplicitOpaqueValueToken {
    public static implicit operator int?(NullAwareImplicitOpaqueValueToken? value) {
        Probe.Calls++;
        return value.HasValue ? 9 : null;
    }
}
public struct DualNullableValueToken {
    public static implicit operator int(DualNullableValueToken value) { Probe.Calls++; return 7; }
    public static implicit operator int(DualNullableValueToken? value) { Probe.Calls++; return 9; }
}
public struct DualReturnValueToken {
    public static explicit operator int(DualReturnValueToken value) { Probe.Calls++; return 7; }
    public static explicit operator int?(DualReturnValueToken value) { Probe.Calls++; return 9; }
}
public struct GenericNullAwareValueToken<T> {
    public static explicit operator int(GenericNullAwareValueToken<T>? value) { Probe.Calls++; return 9; }
}
public struct GenericOpaqueValueToken<T> {
    public static explicit operator int?(GenericOpaqueValueToken<T> value) { Probe.Calls++; return null; }
}
public static class Probe {
    public static int Calls;
    public static int Reads;
    public static T? Read<T>(bool present) where T : struct {
        Reads++;
        return present ? new T() : null;
    }
    public static T ReadValue<T>() where T : struct {
        Reads++;
        return new T();
    }
    public static void Reset() { Calls = 0; Reads = 0; }
}
public static class Oracle {
    ` + "$csharpConversion" + `
    public struct NullAwareLocal {}
    public sealed class AwareBox {
        public static explicit operator AwareBox(NullAwareLocal? value) {
            Probe.Calls++;
            return new AwareBox();
        }
    }
    public static string Run() {
        Probe.Reset();
        var missing = Convert(false);
        var a = (missing == null ? 1 : 0) + 10 * Probe.Calls + 100 * Probe.Reads;
        Probe.Reset();
        var present = Convert(true);
        var b = (present == null ? 1 : 0) + 10 * Probe.Calls + 100 * Probe.Reads;
        Probe.Reset();
        NumericToken? absentNumber = null;
        NumericToken? liveNumber = new NumericToken();
        var x = (int?)absentNumber;
        var y = (int?)liveNumber;
        var c = (x == null ? 1 : 0) + y.GetValueOrDefault() + 10 * Probe.Calls;
        Probe.Reset();
        OrdinaryToken? ordinary = null;
        var z = (Box)ordinary;
        var d = (z == null ? 1 : 0) + 10 * Probe.Calls;
        Probe.Reset();
        NullResultToken? liveNullResult = new NullResultToken();
        var n = (Box?)liveNullResult;
        var e = (n == null ? 1 : 0) + 10 * Probe.Calls;
        Probe.Reset();
        NullAwareLocal? emptyAware = null;
        var aware = (AwareBox)emptyAware;
        var f = (aware == null ? 1 : 0) + 10 * Probe.Calls;
        return $"{a},{b},{c},{d},{e},{f}";
    }
}`)
                EmitCSharp(fixtureSource, fixturePath)
                let oracle = EmittedFixture.Load(fixturePath).GetType("Fixture4741.Oracle", throwOnError: true) ??
                    throw InvalidOperationException("Roslyn oracle type missing.")
                let expected object? = oracle.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(
                    nil,
                    nil
                )
                Assert.Equal(expectedOutput, expected)
                let source = (`package Test4741
import System
import Fixture4741
` + "$gsharpConversion" + `
struct NullAwareLocal {}
class AwareBox {
    shared {
        func operator explicit(value NullAwareLocal?) AwareBox {
            Probe.Calls += 1
            return AwareBox()
        }
    }
}
func Run() string {
    Probe.Reset()
    let missing = Convert(false)
    let a = (if missing == nil { 1 } else { 0 }) + 10 * Probe.Calls + 100 * Probe.Reads
    Probe.Reset()
    let present = Convert(true)
    let b = (if present == nil { 1 } else { 0 }) + 10 * Probe.Calls + 100 * Probe.Reads
    Probe.Reset()
    let absentNumber NumericToken? = nil
    let liveNumber NumericToken? = NumericToken()
    let x = int32?(absentNumber)
    let y = int32?(liveNumber)
    let c = (if x == nil { 1 } else { 0 }) + (y ?? 0) + 10 * Probe.Calls
    Probe.Reset()
    let ordinary OrdinaryToken? = nil
    let z = Box(ordinary)
    let d = (if z == nil { 1 } else { 0 }) + 10 * Probe.Calls
    Probe.Reset()
    let liveNullResult NullResultToken? = NullResultToken()
    let n = Box?(liveNullResult)
    let e = (if n == nil { 1 } else { 0 }) + 10 * Probe.Calls
    Probe.Reset()
    let emptyAware NullAwareLocal? = nil
    let aware = AwareBox(emptyAware)
    let f = (if aware == nil { 1 } else { 0 }) + 10 * Probe.Calls
    return a.ToString() + "," + b.ToString() + "," + c.ToString() + "," + d.ToString() + "," + e.ToString() + "," + f.ToString()
}`)
                let sourcePath = Path.Combine(directory, "App.gs")
                let assemblyPath = Path.Combine(directory, "App.dll")
                File.WriteAllText(sourcePath, source)
                let compilation = CompileGSharp(sourcePath, assemblyPath, fixturePath)
                if expectedDiagnostic != nil {
                    Assert.NotEqual(0, compilation.Exit)
                    Assert.True(
                        compilation.Diagnostics.Contains(expectedDiagnostic, StringComparison.Ordinal),
                        compilation.Diagnostics
                    )
                    return
                }
                Assert.True(compilation.Exit == 0, compilation.Diagnostics)
                let assembly = EmittedFixture.Load(assemblyPath)
                let program = assembly.GetTypes().Single(
                    (type Type) -> type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static) != nil
                )
                let actual object? = program.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(
                    nil,
                    nil
                )
                Assert.Equal(expected, actual)
                IlVerifier.Verify(assemblyPath, []string{fixturePath})
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func RunValuePair(
            gsharpConversion string,
            csharpConversion string,
            expectedOutput string,
            expectedDiagnostic string? = nil
        ) {
            let directory = Path.Combine(AppContext.BaseDirectory, "issue4741-fixtures", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let fixturePath = Path.Combine(directory, "Fixture4737.dll")
                let fixtureSource = (`#nullable enable
namespace Fixture4741;
public struct NumericToken {
    public static explicit operator int(NumericToken value) { Probe.Calls++; return 7; }
}
public struct NullAwareValueToken {
    public static explicit operator int(NullAwareValueToken? value) { Probe.Calls++; return 9; }
}
public struct NullAwareImplicitValueToken {
    public static implicit operator int(NullAwareImplicitValueToken? value) { Probe.Calls++; return 9; }
}
public struct OpaqueValueToken {
    public static explicit operator int?(OpaqueValueToken value) { Probe.Calls++; return null; }
}
public struct OpaqueImplicitValueToken {
    public static implicit operator int?(OpaqueImplicitValueToken value) { Probe.Calls++; return null; }
}
public struct NullAwareOpaqueValueToken {
    public static explicit operator int?(NullAwareOpaqueValueToken? value) {
        Probe.Calls++;
        return value.HasValue ? 9 : null;
    }
}
public struct NullAwareImplicitOpaqueValueToken {
    public static implicit operator int?(NullAwareImplicitOpaqueValueToken? value) {
        Probe.Calls++;
        return value.HasValue ? 9 : null;
    }
}
public struct DualNullableValueToken {
    public static implicit operator int(DualNullableValueToken value) { Probe.Calls++; return 7; }
    public static implicit operator int(DualNullableValueToken? value) { Probe.Calls++; return 9; }
}
public struct DualReturnValueToken {
    public static explicit operator int(DualReturnValueToken value) { Probe.Calls++; return 7; }
    public static explicit operator int?(DualReturnValueToken value) { Probe.Calls++; return 9; }
}
public struct GenericNullAwareValueToken<T> {
    public static explicit operator int(GenericNullAwareValueToken<T>? value) { Probe.Calls++; return 9; }
}
public struct GenericOpaqueValueToken<T> {
    public static explicit operator int?(GenericOpaqueValueToken<T> value) { Probe.Calls++; return null; }
}
public static class Probe {
    public static int Calls;
    public static int Reads;
    public static T? Read<T>(bool present) where T : struct {
        Reads++;
        return present ? new T() : null;
    }
    public static T ReadValue<T>() where T : struct {
        Reads++;
        return new T();
    }
    public static int AcceptSpan(byte[] values) => values.Length + 100;
    public static int AcceptSpan(System.ReadOnlySpan<byte> values) => values.Length;
    public static void Reset() { Calls = 0; Reads = 0; }
}
public static class Oracle {
    ` + "$csharpConversion" + `
    public static string Run() {
        Probe.Reset();
        var missing = Convert(false);
        var a = (missing == null ? 1 : missing.Value) + 10 * Probe.Calls + 100 * Probe.Reads;
        Probe.Reset();
        var present = Convert(true);
        var b = (present == null ? 1 : present.Value) + 10 * Probe.Calls + 100 * Probe.Reads;
        return $"{a},{b}";
    }
}`)
                EmitCSharp(fixtureSource, fixturePath)
                let oracle = EmittedFixture.Load(fixturePath).GetType("Fixture4741.Oracle", throwOnError: true) ??
                    throw InvalidOperationException("Roslyn oracle type missing.")
                let expected object? = oracle.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(
                    nil,
                    nil
                )
                Assert.Equal(expectedOutput, expected)
                let source = (`package Test4737
import System
import Fixture4741
` + "$gsharpConversion" + `
func Run() string {
    Probe.Reset()
    let missing = Convert(false)
    let a = (missing ?? 1) + 10 * Probe.Calls + 100 * Probe.Reads
    Probe.Reset()
    let present = Convert(true)
    let b = (present ?? 1) + 10 * Probe.Calls + 100 * Probe.Reads
    return a.ToString() + "," + b.ToString()
}`)
                let sourcePath = Path.Combine(directory, "App.gs")
                let assemblyPath = Path.Combine(directory, "App.dll")
                File.WriteAllText(sourcePath, source)
                let compilation = CompileGSharp(sourcePath, assemblyPath, fixturePath)
                if expectedDiagnostic != nil {
                    Assert.NotEqual(0, compilation.Exit)
                    Assert.True(
                        compilation.Diagnostics.Contains(expectedDiagnostic, StringComparison.Ordinal),
                        compilation.Diagnostics
                    )
                    return
                }
                Assert.True(compilation.Exit == 0, compilation.Diagnostics)
                let assembly = EmittedFixture.Load(assemblyPath)
                let program = assembly.GetTypes().Single(
                    (type Type) -> type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static) != nil
                )
                let actual object? = program.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(
                    nil,
                    nil
                )
                Assert.Equal(expected, actual)
                IlVerifier.Verify(assemblyPath, []string{fixturePath})
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }

        private func CompileGSharp(sourcePath string, assemblyPath string, fixturePath string)(
            Exit int32,
            Diagnostics string
        ) {
            let arguments = List[string]{
                "/target:library",
                "/targetframework:net10.0",
                "/out:" + assemblyPath,
                "/reference:" + fixturePath,
                sourcePath
            }
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousErr = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(arguments.ToArray()), stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousErr)
            }
        }

        private func EmitCSharp(source string, path string) {
            let tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ??
                throw InvalidOperationException("Framework references missing.")
            let references = tpa.Split(Path.PathSeparator).Select(
                (reference string) -> MetadataReference.CreateFromFile(reference)
            )
            let compilation = CSharpCompilation.Create(
                Path.GetFileNameWithoutExtension(path),
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let result = compilation.Emit(path)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
