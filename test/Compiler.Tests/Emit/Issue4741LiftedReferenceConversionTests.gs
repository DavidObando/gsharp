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
        "int32?",
        "if GenericChainValueToken[List[LocalItem]]?(Probe.ReadValue[GenericChainValueToken[LocalItem]]()) == nil { default(int32?) } else { 5 }",
        "int?",
        "(GenericChainValueToken<System.Collections.Generic.List<int>>?)Probe.ReadValue<GenericChainValueToken<int>>() == null ? (int?)null : 5",
        "111,111"
    )
    @InlineData(
        "int32?",
        "if EvalTree[GenericChainValueToken[LocalItem], GenericChainValueToken[List[LocalItem]]?]((v GenericChainValueToken[LocalItem]) -> GenericChainValueToken[List[LocalItem]]?(v), Probe.ReadValue[GenericChainValueToken[LocalItem]]()) == nil { default(int32?) } else { 5 }",
        "int?",
        "EvalTree<GenericChainValueToken<int>, GenericChainValueToken<System.Collections.Generic.List<int>>?>(v => (GenericChainValueToken<System.Collections.Generic.List<int>>?)v, Probe.ReadValue<GenericChainValueToken<int>>()) == null ? (int?)null : 5",
        "111,111"
    )
    @InlineData(
        "int32?",
        "int32?(Probe.Read[LocalOpaque](present))",
        "int?",
        "(int?)Probe.Read<OpaqueValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "Probe.Read[LocalImplicitOpaque](present)",
        "int?",
        "Probe.Read<OpaqueImplicitValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "int32?(ObliviousGenericWrapper[LocalItem]().Self())",
        "int?",
        "(int?)new ObliviousGenericWrapper<int>().Self()",
        "111,111"
    )
    @InlineData(
        "int32?",
        "EvalTree[ObliviousGenericWrapper[LocalItem], int32?]((v ObliviousGenericWrapper[LocalItem]) -> int32?(v.Self()), ObliviousGenericWrapper[LocalItem]())",
        "int?",
        "EvalTree<ObliviousGenericWrapper<int>, int?>(v => (int?)v.Self(), new ObliviousGenericWrapper<int>())",
        "111,111"
    )
    @InlineData(
        "int32?",
        "if EvalTree[OpaqueValueToken, object?]((v OpaqueValueToken) -> object?(int32?(v)), Probe.ReadValue[OpaqueValueToken]()) == nil { default(int32?) } else { 5 }",
        "int?",
        "EvalTree<OpaqueValueToken, object?>(v => (object?)(int?)v, Probe.ReadValue<OpaqueValueToken>()) == null ? (int?)null : 5",
        "111,111"
    )
    @InlineData(
        "int32?",
        "EvalTree[OpaqueValueToken?, int32?]((v OpaqueValueToken?) -> int32?(v), Probe.Read[OpaqueValueToken](present))",
        "int?",
        "(int?)Probe.Read<OpaqueValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "EvalTree[bool, int32?]((flag bool) -> int32?(Probe.Read[OpaqueValueToken](flag)), present)",
        "int?",
        "(int?)Probe.Read<OpaqueValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "EvalTree[LocalOpaque?, int32?]((v LocalOpaque?) -> int32?(v), Probe.Read[LocalOpaque](present))",
        "int?",
        "(int?)Probe.Read<OpaqueValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "EvalTree[LocalImplicitOpaque?, int32?]((v LocalImplicitOpaque?) -> v, Probe.Read[LocalImplicitOpaque](present))",
        "int?",
        "Probe.Read<OpaqueImplicitValueToken>(present)",
        "101,111"
    )
    @InlineData(
        "int32?",
        "OpenUnwrapNullable[int32](GenericValueUnwrapper[int32?]{Value: Probe.Read[int32](present)})",
        "int?",
        "new GenericValueUnwrapper<int?> { Value = Probe.Read<int>(present) }",
        "111,110"
    )
    @InlineData(
        "int32?",
        "OpenUnwrapNullableTree[int32](GenericValueUnwrapper[int32?]{Value: Probe.Read[int32](present)})",
        "int?",
        "EvalTree<GenericValueUnwrapper<int?>, int?>(v => v, new GenericValueUnwrapper<int?> { Value = Probe.Read<int>(present) })",
        "111,110"
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
        RunValuePair((`import System.Collections.Generic
import System.Linq.Expressions
struct LocalItem {}
struct LocalOpaque {}
func operator explicit(value LocalOpaque) int32? {
    Probe.Calls += 1
    return nil
}
struct LocalImplicitOpaque {}
func operator implicit(value LocalImplicitOpaque) int32? {
    Probe.Calls += 1
    return nil
}
func EvalTree[T, TResult](expr Expression[Func[T, TResult]], value T) TResult -> expr.Compile()(value)
func OpenNullAware[T](value GenericNullAwareValueToken[T]?) int32 -> int32(value)
func OpenOpaque[T](value GenericOpaqueValueToken[T]) int32? -> int32?(value)
func OpenUnwrapNullable[T struct](x GenericValueUnwrapper[T?]) T? -> x
func OpenUnwrapNullableTree[T struct](x GenericValueUnwrapper[T?]) T? -> EvalTree[GenericValueUnwrapper[T?], T?]((v GenericValueUnwrapper[T?]) -> v, x)
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
    @InlineData("cast[GenericTarget[LocalClass]](GenericSource[LocalClass?]()).Tag")
    @InlineData(
        "RejectNullabilityMismatch(GenericSource[LocalClass?]()).Tag",
        "func RejectNullabilityMismatch(x GenericSource[LocalClass?]) GenericTarget[LocalClass] -> x"
    )
    func ImportedNullableValueSignature_RejectsNonNullableValueTarget(
        gsharpBody string,
        gsharpDeclaration string = ""
    ) {
        RunValuePair((`class LocalClass {}
` + "$gsharpDeclaration" + `
func Raw(present bool) int32 -> ` + "$gsharpBody" + `
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

    @Theory
    @InlineData("shared-object-initializer", "GS0155", "(7,49,7,64)")
    @InlineData("instance-object-initializer", "GS0155", "(8,45,8,60)")
    @InlineData("local-object-initializer", "GS0155", "(6,28,6,43)")
    @InlineData("lambda-init-object-initializer", "GS0155", "(7,50,7,54)")
    @InlineData("local-initializer", "GS0155", "(6,25,6,40)")
    @InlineData("argument", "GS0154", "(7,19,7,34)")
    @InlineData("explicit-cast", "GS0155", "(6,19,6,34)")
    func ImportedValueConversion_RejectsNonNullableValueSinksAndVerifiesLiftedAndAssertedInitializers(
        sink string,
        expectedDiagnostic string,
        expectedLocation string
    ) {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5587-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let fixturePath = Path.Combine(directory, "Fixture5587.dll")
            EmitCSharp(`#nullable enable
namespace Fixture5587;
public struct Length {
    public double Value;
    public static implicit operator Length(double value) => new Length { Value = value };
    public static implicit operator Length(int value) => new Length { Value = value };
}
public struct ActionButton {
    public double? FontSize;
}
public class Style {
    public Length FontSize { get; set; }
    public Length? OptionalFontSize { get; set; }
}
public class Text {
    public Length FontSize { get; init; }
    public Length? OptionalFontSize { get; init; }
}
public struct GenericNullableValueBox<T> where T : struct {
    public T? Value;
    public static implicit operator GenericNullableValueBox<T>(T? value) => new GenericNullableValueBox<T> { Value = value };
}`, fixturePath)
            let validSourcePath = Path.Combine(directory, "Valid5587.gs")
            let validAssemblyPath = Path.Combine(directory, "Valid5587.dll")
            File.WriteAllText(validSourcePath, `package Valid5587
import Fixture5587
import System

struct SourceLength {
    var Value float64
    func operator implicit(value float64) SourceLength -> SourceLength{Value: value}
}

class SourceText {
    prop FontSize SourceLength { get; init; }
    prop OptionalFontSize SourceLength? { get; init; }
}

class Theme {
    shared {
        let Button ActionButton = ActionButton{FontSize: 14}
        let EmptyButton ActionButton = ActionButton{FontSize: nil}
        let ButtonStyle Style = Style{FontSize: Button.FontSize!!, OptionalFontSize: Button.FontSize}
        let EmptyStyle Style = Style{OptionalFontSize: EmptyButton.FontSize}
    }
    var InstanceStyle Style = Style{FontSize: Theme.Button.FontSize!!, OptionalFontSize: Theme.Button.FontSize}
}

func WrapGeneric[T struct](value T?) GenericNullableValueBox[T] -> value

func Run() string {
    let instance = Theme()
    let localStyle = Style{FontSize: Theme.Button.FontSize!!, OptionalFontSize: Theme.Button.FontSize}
    let hasEmpty = Theme.EmptyStyle.OptionalFontSize == nil
    let wrappedPresent = WrapGeneric[int32](19)
    let wrappedEmpty = WrapGeneric[int32](nil)
    let size float64? = 12.0
    let emptySize float64? = nil
    let createText Func[Text] = () -> Text{FontSize: size!!, OptionalFontSize: size}
    let createEmptyText Func[Text] = () -> Text{OptionalFontSize: emptySize}
    let createSourceText Func[SourceText] = () -> SourceText{FontSize: size!!, OptionalFontSize: size}
    let createEmptySourceText Func[SourceText] = () -> SourceText{OptionalFontSize: emptySize}
    let text = createText()
    let emptyText = createEmptyText()
    let sourceText = createSourceText()
    let emptySourceText = createEmptySourceText()
    return "${Theme.ButtonStyle.FontSize.Value},${Theme.ButtonStyle.OptionalFontSize!!.Value},${instance.InstanceStyle.FontSize.Value},${localStyle.OptionalFontSize!!.Value},${hasEmpty},${wrappedPresent.Value!!},${wrappedEmpty.Value == nil},${text.FontSize.Value},${text.OptionalFontSize!!.Value},${emptyText.OptionalFontSize == nil},${sourceText.FontSize.Value},${sourceText.OptionalFontSize!!.Value},${emptySourceText.OptionalFontSize == nil}"
}`)
            let validCompilation = CompileGSharp(validSourcePath, validAssemblyPath, fixturePath)
            Assert.True(validCompilation.Exit == 0, validCompilation.Diagnostics)
            IlVerifier.Verify(validAssemblyPath, []string{fixturePath})
            let validAssembly = EmittedFixture.Load(validAssemblyPath)
            let validProgram = validAssembly.GetTypes().Single(
                (type Type) -> type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static) != nil
            )
            let actual object? = validProgram.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(
                nil,
                nil
            )
            Assert.Equal("14,14,14,14,True,19,True,12,12,True,12,12,True", actual)
            let invalidBody = switch sink {
                case "shared-object-initializer": `class Theme {
    shared {
        let Button ActionButton = ActionButton{FontSize: 14}
        let ButtonStyle Style = Style{FontSize: Button.FontSize}
    }
}`
                case "instance-object-initializer": `class Theme {
    shared {
        let Button ActionButton = ActionButton{FontSize: 14}
    }
    var ButtonStyle Style = Style{FontSize: Button.FontSize}
}`
                case "local-object-initializer": `func Build() Style {
    let Button = ActionButton{FontSize: 14}
    return Style{FontSize: Button.FontSize}
}`
                case "lambda-init-object-initializer": `import System
func Build() Func[Text] {
    let size float64? = 12.0
    let create Func[Text] = () -> Text{FontSize: size}
    return create
}`
                case "local-initializer": `func Build() Length {
    let Button = ActionButton{FontSize: 14}
    let length Length = Button.FontSize
    return length
}`
                case "argument": `func Accept(value Length) Length -> value
func Build() Length {
    let Button = ActionButton{FontSize: 14}
    return Accept(Button.FontSize)
}`
                case "explicit-cast": `func Build() Length {
    let Button = ActionButton{FontSize: 14}
    return Length(Button.FontSize)
}`
                default: throw ArgumentOutOfRangeException("sink")
            }
            let invalidSourcePath = Path.Combine(directory, "Invalid5587.gs")
            let invalidAssemblyPath = Path.Combine(directory, "Invalid5587.dll")
            File.WriteAllText(invalidSourcePath, `package Invalid5587
import Fixture5587

` + invalidBody)
            let invalidCompilation = CompileGSharp(invalidSourcePath, invalidAssemblyPath, fixturePath)
            Assert.NotEqual(0, invalidCompilation.Exit)
            Assert.DoesNotContain("GS9998", invalidCompilation.Diagnostics, StringComparison.Ordinal)
            let errors = invalidCompilation
                .Diagnostics
                .Split('\n')
                .Where((line string) -> line.Contains(": error ", StringComparison.Ordinal))
                .ToArray()
            let error = Assert.Single(errors)
            Assert.Contains(expectedDiagnostic, error, StringComparison.Ordinal)
            Assert.Contains(expectedLocation, error, StringComparison.Ordinal)
            if sink == "lambda-init-object-initializer" {
                let invalidSourceOnlyPath = Path.Combine(directory, "InvalidSource5777.gs")
                let invalidSourceOnlyAssemblyPath = Path.Combine(directory, "InvalidSource5777.dll")
                File.WriteAllText(invalidSourceOnlyPath, `package InvalidSource5777
import System

struct SourceLength {
    var Value float64
    func operator implicit(value float64) SourceLength -> SourceLength{Value: value}
}

class SourceText {
    prop FontSize SourceLength { get; init; }
}

func Build() Func[SourceText] {
    let size float64? = 12.0
    let create Func[SourceText] = () -> SourceText{FontSize: size}
    return create
}`)
                let invalidSourceOnlyCompilation = CompileGSharp(
                    invalidSourceOnlyPath,
                    invalidSourceOnlyAssemblyPath,
                    fixturePath
                )
                Assert.NotEqual(0, invalidSourceOnlyCompilation.Exit)
                Assert.DoesNotContain("GS9998", invalidSourceOnlyCompilation.Diagnostics, StringComparison.Ordinal)
                let sourceErrors = invalidSourceOnlyCompilation
                    .Diagnostics
                    .Split('\n')
                    .Where((line string) -> line.Contains(": error ", StringComparison.Ordinal))
                    .ToArray()
                let sourceError = Assert.Single(sourceErrors)
                Assert.Contains("GS0155", sourceError, StringComparison.Ordinal)
                Assert.Contains("(15,62,15,66)", sourceError, StringComparison.Ordinal)
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func Issue5883_NullableDelegateInitializerAndSinks_ApplyUserDefinedLambdaReturnConversion() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue5883-fixtures", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let librarySourcePath = Path.Combine(directory, "Types.gs")
            let libraryAssemblyPath = Path.Combine(directory, "LambdaLibrary.dll")
            File.WriteAllText(librarySourcePath, `package LambdaLibrary

import System

public class Node {
    public var Id int32 = 42
}

public class Other {}

public data struct Card {
    public var Id int32 = 7
    public func Build() Node -> Node{Id: Id}
    public func operator implicit (c Card) Node -> c.Build()
}

public delegate NodeMaker() Node;

public data struct Shell {
    public var Make Func[Node]?
    public var MakeFn (() -> Node)?
    public var MakeDel NodeMaker?
    public var MakeWithArg Func[int32, Node]?
}

public shared class ImportedOverloads {
    public func Pick(f Func[Node]?) int32 -> f!!().Id
    public func Pick(f Func[Other]?) int32 -> 0
    public func PickAction(f Func[Node]?) int32 -> f!!().Id
    public func PickAction(f Action?) int32 -> 0
    public func PickOrObject(f Func[Node]?, x int32) int32 -> f!!().Id
    public func PickOrObject(o object, x int64) int32 -> 21
}`)
            let libraryCompilation = CompileGSharp(librarySourcePath, libraryAssemblyPath, nil)
            Assert.True(libraryCompilation.Exit == 0, libraryCompilation.Diagnostics)
            let consumerSourcePath = Path.Combine(directory, "Program.gs")
            let consumerAssemblyPath = Path.Combine(directory, "Consumer5883.dll")
            File.WriteAllText(consumerSourcePath, `package LambdaConsumer

import System
import LambdaLibrary

class LocalNode {
    var Id int32 = 10
}

data struct LocalCard {
    var Id int32 = 11
    func Build() LocalNode -> LocalNode{Id: Id}
    func operator implicit (c LocalCard) LocalNode -> c.Build()
}

data struct LocalShell {
    var Make Func[LocalNode]?
}

func Pick(f Func[Node]?) int32 -> f!!().Id
func Pick(f Func[Other]?) int32 -> 0
func PickAction(f Func[Node]?) int32 -> f!!().Id
func PickAction(f Action?) int32 -> 0

public func Run() string {
    let expression = Shell{
        Make: () -> Card{Id: 1},
        MakeFn: () -> Card{Id: 2},
        MakeDel: () -> Card{Id: 3},
        MakeWithArg: (x) -> Card{Id: x}
    }
    let block = Shell{
        Make: () -> { return Card{Id: 4} },
        MakeFn: () -> { return Card{Id: 5} },
        MakeDel: () -> { return Card{Id: 6} },
        MakeWithArg: (x int32) -> { return Card{Id: x} }
    }
    let localExpr = LocalShell{Make: () -> LocalCard{Id: 7}}
    let localBlock = LocalShell{Make: () -> { return LocalCard{Id: 8} }}
    var s = Shell{}
    let fallback Func[Node]? = nil
    s.Make = (() -> Card{Id: 9}) ?? fallback
    let r9 = s.Make!!().Id
    s.Make = (true ? (() -> Card{Id: 10}) : nil)
    let r10 = s.Make!!().Id
    let sCoalesce1 = Shell{Make: (() -> Card{Id: 11}) ?? fallback}
    let sCoalesce2 = Shell{Make: fallback ?? (() -> Card{Id: 12})}
    let p1 = Pick(() -> Card{Id: 13})
    let p2 = Pick(() -> { return Card{Id: 14} })
    let p3 = PickAction(() -> Card{Id: 15})
    let p4 = PickAction(() -> { return Card{Id: 16} })
    let ip1 = ImportedOverloads.Pick(() -> Card{Id: 17})
    let ip2 = ImportedOverloads.Pick(() -> { return Card{Id: 18} })
    let ip3 = ImportedOverloads.PickAction(() -> Card{Id: 19})
    let ip4 = ImportedOverloads.PickAction(() -> { return Card{Id: 20} })
    let ip5 = ImportedOverloads.PickOrObject(cast[object](() -> Card{Id: 99}), 1)
    return "${expression.Make!!().Id},${expression.MakeFn!!().Id},${expression.MakeDel!!().Id},${expression.MakeWithArg!!(30).Id},${block.Make!!().Id},${block.MakeFn!!().Id},${block.MakeDel!!().Id},${block.MakeWithArg!!(40).Id},${localExpr.Make!!().Id},${localBlock.Make!!().Id},$r9,$r10,${sCoalesce1.Make!!().Id},${sCoalesce2.Make!!().Id},$p1,$p2,$p3,$p4,$ip1,$ip2,$ip3,$ip4,$ip5"
}`)
            let consumerCompilation = CompileGSharp(consumerSourcePath, consumerAssemblyPath, libraryAssemblyPath)
            Assert.True(consumerCompilation.Exit == 0, consumerCompilation.Diagnostics)
            IlVerifier.Verify(consumerAssemblyPath, []string{libraryAssemblyPath})
            let loaded = EmittedFixture.LoadTogether(libraryAssemblyPath, consumerAssemblyPath)
            let consumerAssembly = loaded[1]
            let program = consumerAssembly.GetTypes().Single(
                (type Type) -> type.GetMethod("Run", BindingFlags.Public | BindingFlags.Static) != nil
            )
            let actual object? = program.GetMethod("Run", BindingFlags.Public | BindingFlags.Static)?.Invoke(nil, nil)
            Assert.Equal("1,2,3,30,4,5,6,40,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21", actual)
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
public struct GenericChainValueToken<T> {
    public static explicit operator GenericChainValueToken<System.Collections.Generic.List<T>>?(GenericChainValueToken<T> value) {
        Probe.Calls++;
        return null;
    }
}
public struct GenericSource<T> {
    public static implicit operator GenericTarget<T>(GenericSource<T> value) => default;
}
public struct GenericTarget<T> {
    public int Tag;
}
public struct GenericValueUnwrapper<U> {
    public U Value;
    public static implicit operator U(GenericValueUnwrapper<U> value) {
        Probe.Calls++;
        return value.Value;
    }
}
#nullable disable
public sealed class ObliviousGenericWrapper<T> {
    public ObliviousGenericWrapper<T> Self() {
        Probe.Reads++;
        return this;
    }
    public static explicit operator int?(ObliviousGenericWrapper<T> value) {
        Probe.Calls++;
        return null;
    }
}
#nullable restore
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

        private func CompileGSharp(sourcePath string, assemblyPath string, fixturePath string?)(
            Exit int32,
            Diagnostics string
        ) {
            let arguments = List[string]{"/target:library", "/targetframework:net10.0", "/out:" + assemblyPath}
            if !string.IsNullOrEmpty(fixturePath) {
                arguments.Add("/reference:" + fixturePath)
            }
            arguments.Add(sourcePath)
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
