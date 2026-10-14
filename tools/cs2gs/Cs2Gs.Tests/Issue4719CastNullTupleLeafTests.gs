// <copyright file="Issue4719CastNullTupleLeafTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import System
import System.Diagnostics
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import System.Text.RegularExpressions
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Collections.Generic

class Issue4719CastNullTupleLeafTests : IDisposable {
    private let fixtureDirectory string = Path.Combine(
        AppContext.BaseDirectory,
        "issue4719-fixtures",
        Guid.NewGuid().ToString("N")
    )

    @Theory
    @InlineData("(string)null")
    @InlineData("((string)null)")
    @InlineData("(string)default")
    @InlineData("(string)default(string)")
    @InlineData("(string)(object)null")
    @InlineData("choose ? (string)null : \"x\"")
    @InlineData("choose switch { true => (string)null, false => \"x\" }")
    func CastNullTupleLeaf_PromotesOnlyTheNullBearingLeaf(value string) {
        let printed = Translate((`public static class Obj {
    public static ((string Text, string Keep) Names, int Code) Rows(bool choose) {
        ((string Text, string Keep) Names, int Code) Missing() {
            return choose ? ((` + "$value" + `, "keep"), 1) : (("x", "keep"), 2);
        }
        return Missing();
    }
}`))
        Assert.Contains("let Missing = func () (Names (Text string?, Keep string), Code int32)", printed)
        Assert.Contains("func Rows(choose bool) (Names (Text string?, Keep string), Code int32)", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Fact
    func CastNullTupleAndScalarReturns_PreserveRuntimeNull() {
        let printed = Translate(`public static class Obj {
    public static string Missing() => (string)null;
    public static string Forward() => Missing();
    public static (string Text, int Code) Row() => ((string)null, 1);
    public static bool Run() {
        var row = Row();
        return row.Text is null && row.Code == 1 && Forward() is null;
    }
}`)
        Assert.Contains("func Missing() string?", printed)
        Assert.Contains("func Forward() string?", printed)
        Assert.Contains("func Row() (Text string?, Code int32)", printed)
        TranslationTestValidation.AssertBinds(printed)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()")
        Assert.False(
            result.Diagnostics.Any((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError),
            string.Join(Environment.NewLine, result.Diagnostics)
        )
        Assert.Null(result.UnhandledException)
        Assert.Equal(true, result.Value)
    }

    @Theory
    @InlineData("(string)(object)\"keep\"")
    @InlineData("(string)null ?? \"keep\"")
    @InlineData("(int)(object)null")
    @InlineData("(Box)(string)null")
    func CastWithoutNullResult_DoesNotPromoteItsTupleLeaf(value string) {
        let type = if value.StartsWith("(int)", StringComparison.Ordinal) {
            "int"
        } else {
            (
                if value.StartsWith("(Box)", StringComparison.Ordinal) {
                    "Box"
                } else {
                    "string"
                }
            )
        }
        let mappedType = if type == "int" {
            "int32"
        } else {
            type
        }
        let printed = Translate((`public sealed class Box {
    public static explicit operator Box(string text) => new Box();
}
public static class Obj {
    public static (` + "$type" + ` Value, int Code) Row() => (` + "$value" + `, 1);
}`))
        Assert.Contains("func Row() (Value $mappedType, Code int32)", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("struct", "default(T)")
    @InlineData("unmanaged", "default(T)")
    @InlineData("struct", "(T)default")
    @InlineData("unmanaged", "(T)default")
    func NonNullableGenericBoxing_PreservesTheNonNullTupleLeaf(constraint string, value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row<T>() where T : ` + "$constraint" + `
        => ((object)` + "$value" + `, 1);
    public static int Run() {
        var row = Row<int>();
        return (int)row.Value + row.Code;
    }
}`), fixture)
        Assert.Contains("func Row[T $constraint]() (Value object, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("int")
    @InlineData("bool")
    @InlineData("System.DateTime")
    func NonNullableConcreteBoxing_PreservesTheNonNullTupleLeaf(type string) {
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row() => ((object)default(` + "$type" + `), 1);
}`))
        Assert.Contains("func Row() (Value object, Code int32)", printed)
        TranslationTestValidation.AssertBinds(printed)
    }

    @Theory
    @InlineData("struct", "(T)(object)null", typeof(NullReferenceException))
    @InlineData("unmanaged", "(T)(object)null", typeof(NullReferenceException))
    @InlineData("struct", "(T)(object)(string)null", typeof(NullReferenceException))
    @InlineData("unmanaged", "(T)(object)(string)null", typeof(NullReferenceException))
    @InlineData("struct", "(T)(object)default(T?)", typeof(NullReferenceException))
    @InlineData("unmanaged", "(T)(object)default(T?)", typeof(NullReferenceException))
    @InlineData("struct", "(object)(T)(object)null", typeof(NullReferenceException))
    @InlineData("unmanaged", "(object)(T)(object)null", typeof(NullReferenceException))
    func NonNullableGenericCastResult_PreservesTheNonNullTupleLeafAndException(
        constraint string,
        value string,
        exception Type
    ) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row<T>() where T : ` + "$constraint" + ` => (` + "$value" + `, 1);
}`), fixture)
        Assert.Contains("func Row[T $constraint]() (Value object, Code int32)", printed)
        AssertBindsAndThrows(printed, fixture, exception, "Obj.Row[int32]()")
    }

    @Theory
    @InlineData("struct")
    @InlineData("unmanaged")
    func NonNullableGenericNullableUnboxResult_PreservesTheNonNullTupleLeaf(constraint string) {
        // Generic nullable unwrap binding is independently tracked in #4735.
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row<T>() where T : ` + "$constraint" + `
        => ((T)default(T?), 1);
}`))
        Assert.Contains("func Row[T $constraint]() (Value object, Code int32)", printed)
    }

    @Theory
    @InlineData("struct", false)
    @InlineData("unmanaged", false)
    @InlineData("struct", true)
    @InlineData("unmanaged", true)
    func NonNullableCastResult_DoesNotForwardScalarOrTupleSourceTaint(constraint string, tupleSource bool) {
        let fixture = this.EmitFixture()
        let setup = if tupleSource {
            "var source = Seed();"
        } else {
            "object source = null;"
        }
        let value = if tupleSource {
            "source.Value"
        } else {
            "source"
        }
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Seed() => (null, 1);
    public static (object Value, int Code) Row<T>() where T : ` + "$constraint" + ` {
        ` + "$setup" + `
        return ((T)` + "$value" + `, 1);
    }
    public static object Scalar<T>() where T : ` + "$constraint" + ` {
        ` + "$setup" + `
        return (T)` + "$value" + `;
    }
}`), fixture)
        Assert.Contains("func Row[T $constraint]() (Value object, Code int32)", printed)
        Assert.Contains("func Scalar[T $constraint]() object", printed)
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row[int32]()")
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Scalar[int32]()")
    }

    @Theory
    @InlineData("int")
    @InlineData("bool")
    @InlineData("System.DateTime")
    func NonNullableConcreteCastResult_PreservesTheNonNullTupleLeafAndException(type string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row() => ((` + "$type" + `)(object)null, 1);
}`), fixture)
        Assert.Contains("func Row() (Value object, Code int32)", printed)
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row()")
    }

    @Theory
    @InlineData("struct", "(T?)(object)null")
    @InlineData("unmanaged", "(T?)(object)null")
    @InlineData("struct", "(T?)default(T?)")
    @InlineData("unmanaged", "(T?)default(T?)")
    func NullableGenericCastResult_PreservesTheNullableTupleLeaf(constraint string, value string) {
        // Generic implicit nullable boxing is independently tracked in #4735.
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row<T>() where T : ` + "$constraint" + ` => (` + "$value" + `, 1);
}`))
        Assert.Contains("func Row[T $constraint]() (Value object?, Code int32)", printed)
    }

    @Theory
    @InlineData("struct", "(T?)(object)null")
    @InlineData("unmanaged", "(T?)(object)null")
    @InlineData("struct", "(T?)default(T?)")
    @InlineData("unmanaged", "(T?)default(T?)")
    func ExplicitlyBoxedNullableGenericCastResult_PreservesRuntimeNull(constraint string, value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row<T>() where T : ` + "$constraint" + ` => ((object)` + "$value" + `, 1);
    public static int Run() {
        var row = Row<int>();
        return row.Value == null && row.Code == 1 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row[T $constraint]() (Value object?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("(int?)1")
    @InlineData("((int?)1)")
    func ExplicitlyBoxedNullableLift_PreservesTheNonNullTupleLeaf(value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row() => ((object)` + "$value" + `, 1);
    public static int Run() {
        var row = Row();
        return (int)row.Value + row.Code;
    }
}`), fixture)
        Assert.Contains("func Row() (Value object, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 2)
    }

    @Fact
    func UserDefinedCastResult_DoesNotForwardItsNullableInputsTaint() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using Issue4719Fixture;
public static class Obj {
    public static (Box Value, int Code) Row() {
        string text = null;
        return ((Box)text, 1);
    }
    public static Box Scalar() {
        string text = null;
        return (Box)text;
    }
    public static int Run() {
        var row = Row();
        return row.Value != null && row.Code == 1 && Scalar() != null ? 1 : -1;
    }
}`, fixture)
        Assert.Contains("func Row() (Value Box, Code int32)", printed)
        Assert.Contains("func Scalar() Box", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("checked((int?)1)", false)
    @InlineData("unchecked((int?)1)", false)
    @InlineData("checked(value ?? (int?)1)", false)
    @InlineData("unchecked(value ?? (int?)1)", false)
    @InlineData("checked(choose ? (int?)1 : (int?)2)", false)
    @InlineData("unchecked(choose switch { true => (int?)1, false => (int?)2 })", false)
    @InlineData("checked(value)", true)
    @InlineData("unchecked(value)", true)
    @InlineData("checked(choose ? value : (int?)1)", true)
    @InlineData("unchecked(choose switch { true => value, false => (int?)1 })", true)
    func CheckedNullableOperands_PreserveCompositeTupleScalarAndSourceContracts(operand string, nullable bool) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row(bool choose, int? value) => ((object)` + "$operand" + `, 1);
    public static object Scalar(bool choose, int? value) => (object)` + "$operand" + `;
    public static object Local(bool choose, int? value) {
        object result = (object)` + "$operand" + `;
        return result;
    }
    public static (object Value, int Code) Forward(bool choose, int? value) => Row(choose, value);
    public static int Run() {
        var missing = Forward(true, null);
        var present = Forward(false, 7);
        return ` + "${(if nullable { "missing.Value == null && Scalar(true, null) == null && Local(true, null) == null" } else { "missing.Value != null && Scalar(true, null) != null && Local(true, null) != null" })}" + `
            && present.Value != null && Scalar(false, 7) != null && Local(false, 7) != null
            && missing.Code == 1 && present.Code == 1 ? 1 : -1;
    }
}`), fixture)
        let optional = if nullable {
            "?"
        } else {
            string.Empty
        }
        Assert.Contains("func Row(choose bool, value int32?) (Value object$optional, Code int32)", printed)
        Assert.Contains("func Forward(choose bool, value int32?) (Value object$optional, Code int32)", printed)
        Assert.Contains("func Scalar(choose bool, value int32?) object$optional", printed)
        Assert.Contains("func Local(choose bool, value int32?) object$optional", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("checked(value)")
    @InlineData("unchecked(value)")
    func CheckedGuardedNullableOperand_PreservesIteratorPrecision(operand string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(object Value, int Code)> Rows(int? value) {
        if (value != null) { yield return ((object)` + "$operand" + `, 1); }
    }
    public static int Run() {
        foreach (var row in Rows(null)) { return -1; }
        int count = 0;
        foreach (var row in Rows(7)) {
            if ((int)row.Value != 7 || row.Code != 1) { return -2; }
            count++;
        }
        return count;
    }
}`), fixture)
        Assert.Contains("func Rows(value int32?) sequence[(Value object, Code int32)]", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("value")
    @InlineData("(value)")
    @InlineData("checked(value)")
    @InlineData("unchecked(value)")
    @InlineData("choose ? value : (int?)1")
    @InlineData("choose switch { true => value, false => (int?)1 }")
    @InlineData("Probe.Number(!choose)")
    func ContextualOrdinaryNullableParameterOperator_DeclarationOnlyPreservesItsNonNullResult(operand string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using Issue4719Fixture;
public static class Obj {
    public static (Box Value, int Code) Row(bool choose, int? value) => (` + "$operand" + `, 1);
    public static Box Scalar(bool choose, int? value) => ` + "$operand" + `;
    public static Box Local(bool choose, int? value) {
        Box result = ` + "$operand" + `;
        return result;
    }
    public static int Run() {
        Probe.Reset();
        var missing = Row(true, null);
        var present = Row(false, 7);
        return missing.Value != null && present.Value != null
            && Scalar(true, null) != null && Scalar(false, 7) != null
            && Local(true, null) != null && Local(false, 7) != null
            && missing.Code == 1 && present.Code == 1 && Probe.Calls == ` + "${(if operand.StartsWith("Probe.", StringComparison.Ordinal) { 12 } else { 6 })}" + ` ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row(choose bool, value int32?) (Value Box, Code int32)", printed)
        Assert.Contains("func Scalar(choose bool, value int32?) Box", printed)
        Assert.Contains("func Local(choose bool, value int32?) Box", printed)
        // #4737 also covers native nullable-value contextual operator binding.

    }

    @Theory
    @InlineData("Input(missing)")
    @InlineData("(Input(missing))")
    @InlineData("checked(Input(missing))")
    @InlineData("missing ? Input(true) : \"x\"")
    @InlineData("Pair(missing).Text")
    func ContextualOrdinaryReferenceOperator_BlocksOperandSourceAndTupleEdges(operand string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using Issue4719Fixture;
public static class Obj {
    public static string Input(bool missing) => missing ? null : "x";
    public static (string Text, int Code) Pair(bool missing) => (Input(missing), 1);
    public static (ReferenceBox Value, int Code) Row(bool missing) => (` + "$operand" + `, 1);
    public static ReferenceBox Scalar(bool missing) => ` + "$operand" + `;
    public static ReferenceBox Local(bool missing) {
        ReferenceBox result = ` + "$operand" + `;
        return result;
    }
    public static int Run() {
        Probe.Reset();
        return Row(true).Value != null && Row(false).Value != null
            && Scalar(true) != null && Scalar(false) != null
            && Local(true) != null && Local(false) != null
            && Probe.Calls == 6 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Input(missing bool) string?", printed)
        Assert.Contains("func Pair(missing bool) (Text string?, Code int32)", printed)
        Assert.Contains("func Row(missing bool) (Value ReferenceBox, Code int32)", printed)
        Assert.Contains("func Scalar(missing bool) ReferenceBox", printed)
        Assert.Contains("func Local(missing bool) ReferenceBox", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func ContextualOrdinaryOperator_IteratorPreservesItsNonNullLeafAndTypedHoist() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static string Input(bool missing) => missing ? null : "x";
    public static IEnumerable<(ReferenceBox Value, int Code)> Rows(bool missing) {
        yield return missing ? (Input(true), 1) : (Input(false), 2);
    }
    public static int Run() {
        Probe.Reset();
        int count = 0;
        foreach (var row in Rows(true)) {
            if (row.Value == null || row.Code != 1) { return -1; }
            count++;
        }
        foreach (var row in Rows(false)) {
            if (row.Value == null || row.Code != 2) { return -2; }
            count++;
        }
        return count == 2 && Probe.Calls == 2 ? 1 : -3;
    }
}`, fixture)
        Assert.Contains("func Rows(missing bool) sequence[(Value ReferenceBox, Code int32)]", printed)
        AssertTypedHoists(printed, "(Value ReferenceBox, Code int32)", expectedCount: 1)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func ContextualNullableResultOperator_InputGuardDoesNotEraseTheOperatorsOwnNullResult() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<(MaybeBox Value, int Code)> Rows(string value) {
        if (value != null) { yield return (value, 1); }
    }
    public static int Run() {
        Probe.Reset();
        foreach (var row in Rows(null)) { return -1; }
        int count = 0;
        foreach (var row in Rows("x")) {
            if (row.Value != null || row.Code != 1) { return -2; }
            count++;
        }
        return count == 1 && Probe.Calls == 1 ? 1 : -3;
    }
}`, fixture)
        Assert.Contains("func Rows(value string?) sequence[(Value MaybeBox?, Code int32)]", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func ContextualOrdinaryOperator_DeclarationOnlyStaticInitializerPreservesNonNullStorage() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using Issue4719Fixture;
public static class Obj {
    public static Box Value = (int?)null;
    public static Box Read() => Value;
    public static int Run() => Read() != null ? 1 : -1;
}`, fixture)
        Assert.Contains("Value Box =", printed)
        Assert.Contains("func Read() Box", printed)
        // #4737: implicit int32? -> Box fails loudly before execution.

    }

    @Theory
    @InlineData("value", true)
    @InlineData("(object)(int?)value", true)
    @InlineData("choose ? value : (Token?)new Token()", true)
    @InlineData("choose switch { true => value, false => (Token?)new Token() }", true)
    @InlineData("value ?? (Token?)new Token()", false)
    @InlineData("(Token?)new Token()", false)
    func LiftedUserDefinedCast_UsesItsEffectiveNullContractAndInvokesOnlyForPresentValues(
        operand string,
        nullable bool
    ) {
        let fixture = this.EmitFixture()
        let converted = if operand.StartsWith("(object)", StringComparison.Ordinal) {
            operand
        } else {
            "(int?)($operand)"
        }
        let printed = Translate((`using Issue4719Fixture;
public static class Obj {
    public static (object Value, int Code) Row(bool choose) {
        Token? value = choose ? null : new Token();
        return (` + "$converted" + `, 1);
    }
    public static object Scalar(bool choose) {
        Token? value = choose ? null : new Token();
        return ` + "$converted" + `;
    }
    public static int Run() {
        Probe.Reset();
        var missing = Row(true);
        var present = Row(false);
        var scalarMissing = Scalar(true);
        var scalarPresent = Scalar(false);
        return ` + "${(if nullable { "missing.Value == null && scalarMissing == null" } else { "(int)missing.Value == 7 && (int)scalarMissing == 7" })}" + `
            && (int)present.Value == 7 && (int)scalarPresent == 7
            && missing.Code == 1 && present.Code == 1
            && Probe.Calls == ` + "${(if nullable { 2 } else { 4 })}" + ` ? 1 : -1;
    }
}`), fixture)
        let optional = if nullable {
            "?"
        } else {
            string.Empty
        }
        Assert.Contains("func Row(choose bool) (Value object$optional, Code int32)", printed)
        Assert.Contains("func Scalar(choose bool) object$optional", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("OpaqueToken", "int?", true, int32(0))
    @InlineData("NullAwareToken", "int", false, int32(9))
    func OrdinaryNullableValueUserDefinedCast_DeclarationOnlyPreservesItsOwnResultContract(
        token string,
        resultType string,
        nullable bool,
        expectedValue int32
    ) {
        let fixture = this.EmitFixture()
        let input = if token == "NullAwareToken" {
            "choose ? null : new NullAwareToken()"
        } else {
            "new OpaqueToken()"
        }
        let printed = Translate((`using Issue4719Fixture;
public static class Obj {
    public static (object Value, int Code) Row(bool choose) {
        ` + "$token" + "${(if token == "NullAwareToken" { "?" } else { "" })}" + ` value = ` + "$input" + `;
        return ((` + "$resultType" + `)value, 1);
    }
    public static int Run() {
        Probe.Reset();
        var first = Row(true);
        var second = Row(false);
        return ` + "${(if nullable { "first.Value == null && second.Value == null" } else { "(int)first.Value == $expectedValue && (int)second.Value == $expectedValue" })}" + `
            && first.Code == 1 && second.Code == 1 && Probe.Calls == 2 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row(choose bool) (Value object${(if nullable { "?" } else { "" })}, Code int32)", printed)
        // #4737 tracks these two ordinary nullable-signature operator binding gaps.

    }

    @Fact
    func GuardedLiftedUserDefinedCast_PreservesItsNonNullIteratorLeaf() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<(object Value, int Code)> Rows(Token? value) {
        if (value != null) {
            yield return ((int?)value, 1);
        }
    }
    public static int Run() {
        Probe.Reset();
        foreach (var row in Rows(null)) { return -1; }
        int count = 0;
        foreach (var row in Rows(new Token())) {
            if ((int)row.Value != 7 || row.Code != 1) { return -2; }
            count++;
        }
        return count == 1 && Probe.Calls == 1 ? 1 : -1;
    }
}`, fixture)
        Assert.Contains("func Rows(value Token?) sequence[(Value object, Code int32)]", printed)
        Assert.DoesNotContain("value!!", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func LiftedUserDefinedReferenceResult_DeclarationOnlyPreservesTheEffectiveNullContract() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using Issue4719Fixture;
public static class Obj {
    public static (object Value, int Code) Row(bool missing) {
        ReferenceToken? value = missing ? null : new ReferenceToken();
        return ((Box)value, 1);
    }
    public static int Run() {
        Probe.Reset();
        var missing = Row(true);
        var present = Row(false);
        return missing.Value == null && present.Value != null
            && missing.Code == 1 && present.Code == 1 && Probe.Calls == 1 ? 1 : -1;
    }
}`, fixture)
        Assert.Contains("func Row(missing bool) (Value object?, Code int32)", printed)
        // #4741 tracks the independent Core null-short-circuit runtime divergence.

    }

    @Theory
    @InlineData("value ?? (int?)1", int32(0))
    @InlineData("Probe.Choose(choose) ? (int?)1 : (int?)2", int32(8))
    @InlineData("Probe.Choose(choose) switch { true => (int?)1, false => (int?)2 }", int32(8))
    @InlineData("(Probe.Choose(choose) ? value : (int?)null) ?? (int?)1", int32(8))
    func BoxedNonNullNullableComposite_PreservesTupleAndScalarPrecisionAndSingleEvaluation(
        operand string,
        calls int32
    ) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using Issue4719Fixture;
public static class Obj {
    public static (object Value, int Code) Row(bool choose, int? value) => ((object)(` + "$operand" + `), 1);
    public static object Scalar(bool choose, int? value) => (object)(` + "$operand" + `);
    public static int Run() {
        Probe.Reset();
        var a = Row(true, null);
        var b = Row(false, null);
        var c = Row(true, 7);
        var d = Row(false, 7);
        return a.Value != null && b.Value != null && c.Value != null && d.Value != null
            && Scalar(true, null) != null && Scalar(false, null) != null
            && Scalar(true, 7) != null && Scalar(false, 7) != null
            && a.Code + b.Code + c.Code + d.Code == 4 && Probe.Calls == ` + "$calls" + ` ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row(choose bool, value int32?) (Value object, Code int32)", printed)
        Assert.Contains("func Scalar(choose bool, value int32?) object", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("Probe.Choose(choose) ? value : (int?)1")
    @InlineData("Probe.Choose(choose) switch { true => value, false => (int?)1 }")
    func BoxedGuardedNullableComposite_PreservesIteratorLeafAndGuard(operand string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<(object Value, int Code)> Rows(bool choose, int? value) {
        if (value != null) {
            yield return ((object)(` + "$operand" + `), 1);
        }
    }
    public static int Run() {
        Probe.Reset();
        foreach (var row in Rows(true, null)) { return -1; }
        int count = 0;
        foreach (var row in Rows(true, 7)) {
            if ((int)row.Value != 7 || row.Code != 1) { return -2; }
            count++;
        }
        foreach (var row in Rows(false, 7)) {
            if ((int)row.Value != 1 || row.Code != 1) { return -3; }
            count++;
        }
        return count == 2 && Probe.Calls == 2 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Rows(choose bool, value int32?) sequence[(Value object, Code int32)]", printed)
        Assert.DoesNotContain("value!!", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("Probe.Choose(choose) ? value : (int?)1")
    @InlineData("Probe.Choose(choose) switch { true => value, false => (int?)1 }")
    @InlineData("value ?? (int?)null")
    @InlineData("Probe.Number(!choose)")
    func BoxedNullableCompositeOrOpaqueRead_PreservesNullAndPresentValues(operand string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using Issue4719Fixture;
public static class Obj {
    public static (object Value, int Code) Row(bool choose, int? value) => ((object)(` + "$operand" + `), 1);
    public static int Run() {
        Probe.Reset();
        var missing = Row(true, null);
        var present = Row(false, 7);
        return missing.Value == null && present.Value != null
            && missing.Code == 1 && present.Code == 1 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row(choose bool, value int32?) (Value object?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func LiftedAndCompositeCastProgram_CompilesWithRealDriverVerifiesAndPreservesMetadata() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System;
using Issue4719Fixture;
public static class Obj {
    public static (object Value, int Code) Lift(bool missing) {
        Token? value = missing ? null : new Token();
        return ((int?)value, 1);
    }
    public static (object Value, int Code) Known(bool choose, int? value)
        => ((object)checked(Probe.Choose(choose) ? (value ?? (int?)1) : (int?)2), 1);
    public static (ReferenceBox Value, int Code) Ordinary(bool missing) {
        string value = missing ? null : "x";
        return (value, 1);
    }
    public static void Main() {
        Probe.Reset();
        var missing = Lift(true);
        var present = Lift(false);
        var first = Known(true, null);
        var second = Known(false, null);
        var ordinaryMissing = Ordinary(true);
        var ordinaryPresent = Ordinary(false);
        Console.WriteLine(missing.Value == null && (int)present.Value == 7
            && (int)first.Value == 1 && (int)second.Value == 2
            && missing.Code + present.Code + first.Code + second.Code == 4
            && ordinaryMissing.Value != null && ordinaryPresent.Value != null
            && ordinaryMissing.Code + ordinaryPresent.Code == 2
            && Probe.Calls == 5 ? 15 : -1);
    }
}`, fixture)
        Assert.Contains("func Lift(missing bool) (Value object?, Code int32)", printed)
        Assert.Contains("func Known(choose bool, value int32?) (Value object, Code int32)", printed)
        Assert.Contains("func Ordinary(missing bool) (Value ReferenceBox, Code int32)", printed)
        let source = Path.Combine(this.fixtureDirectory, "Program.gs")
        let assemblyPath = Path.Combine(this.fixtureDirectory, "Program.dll")
        let compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
        Assert.True(File.Exists(compiler), "The graph build must build the real gsc driver.")
        File.WriteAllText(source, printed)
        let compiled = RunDotnet(
            compiler,
            "/target:exe",
            "/targetframework:net10.0",
            "/reference:$fixture",
            "/out:$assemblyPath",
            source
        )
        Assert.True(compiled.Exit == 0, compiled.Output)
        Assert.DoesNotContain("GS0523", compiled.Output)
        Assert.True(IlVerifyRunner.IsEnabled, "This witness requires real IL verification, not its bypass.")
        let verified = IlVerifyRunner().Verify(assemblyPath, []string{fixture})
        Assert.Equal(IlVerifyStatus.Passed, verified.Status)
        Assert.Empty(verified.Errors)
        File.WriteAllText(
            Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
            "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"" +
                Environment
                .Version
                .Major
                .ToString() +
                ".0.0\"}}}"
        )
        let executed = RunDotnet(assemblyPath)
        Assert.Equal(0, executed.Exit)
        Assert.Equal("15" + Environment.NewLine, executed.Output)
        let loadContext = AssemblyLoadContext("issue4719-metadata", isCollectible: true)
        try {
            loadContext.LoadFromAssemblyPath(fixture)
            let owner = Assert.Single(
                loadContext.LoadFromAssemblyPath(assemblyPath).GetTypes(),
                (type Type) -> type.Name == "Obj"
            )
            let nullability = NullabilityInfoContext()
            let lift = Assert.IsAssignableFrom[MethodInfo](owner.GetMethod("Lift"))
            let known = Assert.IsAssignableFrom[MethodInfo](owner.GetMethod("Known"))
            let ordinary = Assert.IsAssignableFrom[MethodInfo](owner.GetMethod("Ordinary"))
            Assert.Equal(
                NullabilityState.Nullable,
                nullability.Create(lift.ReturnParameter).GenericTypeArguments[0].ReadState
            )
            Assert.Equal(
                NullabilityState.NotNull,
                nullability.Create(known.ReturnParameter).GenericTypeArguments[0].ReadState
            )
            Assert.Equal(
                NullabilityState.NotNull,
                nullability.Create(ordinary.ReturnParameter).GenericTypeArguments[0].ReadState
            )
        } finally {
            loadContext.Unload()
        }
    }

    @Theory
    @InlineData("(int?)(object)null")
    @InlineData("(int?)default(int?)")
    func NullableConcreteCastResult_PreservesTheNullableTupleLeafAndRuntimeNull(value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row() => (` + "$value" + `, 1);
    public static int Run() {
        var row = Row();
        return row.Value == null && row.Code == 1 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row() (Value object?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("", "")
    @InlineData("where T : class", " class")
    func ReferenceOrUnconstrainedCastResult_PreservesTheNullableTupleLeafAndRuntimeNull(
        constraint string,
        mappedConstraint string
    ) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row<T>() ` + "$constraint" + ` => ((T)(object)null, 1);
    public static int Run() {
        var row = Row<string>();
        return row.Value == null && row.Code == 1 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row[T$mappedConstraint]() (Value object?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
        if constraint.Length == 0 {
            AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row[int32]()")
        }
    }

    @Theory
    @InlineData("default(int?)", true)
    @InlineData("(int?)default", true)
    @InlineData("(int?)null", true)
    @InlineData("choose ? (int?)null : 1", false)
    @InlineData("choose switch { true => default(int?), false => 1 }", false)
    func NullableValueBoxing_PreservesNullAndThePromotedTupleLeaf(value string, alwaysNull bool) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row(bool choose) => ((object)(` + "$value" + `), 1);
    public static int Run() {
        var missing = Row(true);
        var present = Row(false);
        return missing.Value == null && missing.Code == 1
            && ` + "${(if alwaysNull { "present.Value == null" } else { "(int)present.Value == 1" })}" + `
            && present.Code == 1 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row(choose bool) (Value object?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("", "")
    @InlineData("where T : class", " class")
    func ReferenceOrUnconstrainedDefaultCast_PreservesTheNullableTupleLeaf(constraint string, mappedConstraint string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (object Value, int Code) Row<T>() ` + "$constraint" + ` => ((object)default(T), 1);
    public static int Run() {
        var row = Row<string>();
        ` + "${(if constraint.Length == 0 { "if ((int)Row<int>().Value != 0) { return -2; }" } else { "" })}" + `
        return row.Value == null && row.Code == 1 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row[T$mappedConstraint]() (Value object?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func NullableGenericValueBoxing_PreservesNullAndThePromotedTupleLeaf() {
        let fixture = this.EmitFixture()
        let printed = Translate(`public static class Obj {
    public static (object Value, int Code) Row<T>() where T : struct => ((object)default(T?), 1);
    public static int Run() {
        var row = Row<int>();
        return row.Value == null && row.Code == 1 ? 1 : -1;
    }
}`, fixture)
        Assert.Contains("func Row[T struct]() (Value object?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func GuardedReferenceTypeParameterCast_PreservesTheNonNullIteratorLeaf() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(object Value, int Code)> Rows<T>(T? value) where T : class {
        if (value != null) {
            yield return ((object)value, 1);
        }
    }
    public static int Run() {
        foreach (var row in Rows<string>(null)) { return -1; }
        int count = 0;
        foreach (var row in Rows<string>("keep")) {
            if ((string)row.Value != "keep" || row.Code != 1) { return -2; }
            count++;
        }
        return count;
    }
}`, fixture)
        Assert.Contains("func Rows[T class](value T?) sequence[(Value object, Code int32)]", printed)
        Assert.DoesNotContain("value!!", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func GuardedNullableValueBoxing_PreservesTheNonNullIteratorLeaf() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System.Collections.Generic;
public static class Obj {
    public static IEnumerable<(object Value, int Code)> Rows(int? value) {
        if (value != null) {
            yield return ((object)value, 1);
        }
    }
    public static int Run() {
        foreach (var row in Rows(null)) { return -1; }
        int count = 0;
        foreach (var row in Rows(7)) {
            if ((int)row.Value != 7 || row.Code != 1) { return -2; }
            count++;
        }
        return count;
    }
}`, fixture)
        Assert.Contains("func Rows(value int32?) sequence[(Value object, Code int32)]", printed)
        Assert.DoesNotContain("value!!", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func OriginalNestedIteratorAndCastYield_PreserveContractsAndDeferredEvaluation() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        IEnumerable<(string Text, int Code)> Missing() {
            yield return choose ? ((string)null, 1) : ("x", 2);
        }
        if (choose) { yield break; }
        yield return ("keep", 2);
    }

    public static IEnumerable<(string Text, int Code)> MissingRows(bool choose) {
        IEnumerable<(string Text, int Code)> Missing() {
            yield return Probe.Choose(choose) ? ((string)null, 1) : ("x", 2);
        }
        return Missing();
    }

    public static IEnumerable<(string Text, int Code)> CastRows(bool choose) {
        yield return ((string Text, int Code))
            (Probe.Choose(choose) ? ((string)(null), 1) : ("x", 2));
        yield return (Probe.Text(choose), 3);
    }

    public static int Run() {
        int total = 0;
        foreach (var row in Rows(true)) { return -1; }
        foreach (var row in Rows(false)) {
            if (row.Text != "keep" || row.Code != 2) { return -2; }
            total += row.Code;
        }
        Probe.Reset();
        var missing = MissingRows(true);
        if (Probe.Calls != 0) { return -3; }
        foreach (var row in missing) {
            if (row.Text != null || row.Code != 1 || Probe.Calls != 1) { return -4; }
            total += row.Code;
        }
        foreach (var row in MissingRows(false)) {
            if (row.Text != "x" || row.Code != 2 || Probe.Calls != 2) { return -5; }
            total += row.Code;
        }
        Probe.Reset();
        var deferred = CastRows(true);
        if (Probe.Calls != 0) { return -6; }
        foreach (var row in deferred) {
            if (row.Text != null || row.Code != 1 || Probe.Calls != 1) { return -7; }
            total += row.Code;
            break;
        }
        if (Probe.Calls != 1) { return -8; }
        Probe.Reset();
        foreach (var row in CastRows(true)) {
            if (row.Text != null || Probe.Calls != (row.Code == 1 ? 1 : 2)) { return -9; }
            total += row.Code;
        }
        if (Probe.Calls != 2) { return -10; }
        Probe.Reset();
        foreach (var row in CastRows(false)) {
            if (row.Text != "x" || Probe.Calls != (row.Code == 2 ? 1 : 2)) { return -11; }
            total += row.Code;
        }
        if (Probe.Calls != 2) { return -12; }
        return total;
    }
}`, fixture)
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        Assert.Equal(2, printed.Split("let Missing = func () IEnumerable[(Text string?, Code int32)]").Length - 1)
        Assert.Contains("func CastRows(choose bool) sequence[(Text string?, Code int32)]", printed)
        AssertTypedHoists(printed, "(Text string?, Code int32)", expectedCount: 3)
        AssertBindsAndRuns(printed, fixture, expected: 15)
    }

    @Theory
    @InlineData("IEnumerable", "", "sequence")
    @InlineData("IEnumerator", "", "IEnumerator")
    @InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable")
    @InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator")
    func CastTupleYield_UsesPromotedElementTypeForItsMaterializedLocal(
        envelope string,
        modifier string,
        mappedEnvelope string
    ) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static ` + "$modifier" + "$envelope" + `<(string Text, int Code)> Rows(bool choose) {
        yield return ((string Text, int Code))
            (Probe.Choose(choose) ? ((string)null, 1) : ("x", 2));
    }
}`), fixture)
        Assert.Contains("func Rows(choose bool) $mappedEnvelope[(Text string?, Code int32)]", printed)
        AssertTypedHoists(printed, "(Text string?, Code int32)", expectedCount: 1)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture})
        TranslationTestValidation.AssertBinds(resolver, printed)
    }

    @Theory
    @InlineData("choose ? ((string)text, 1) : (\"x\", 2)", true)
    @InlineData("choose switch { true => ((string)text, 1), false => (\"x\", 2) }", true)
    @InlineData("(choose ? (string)text : \"x\", 1)", false)
    @InlineData("(choose switch { true => (string)text, false => \"x\" }, 1)", false)
    func GuardedCastTupleLeaf_PreservesTheNonNullContractAndRuntimeGuard(yielded string, materialized bool) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
        string? text = choose ? null : "x";
        if (text != null) {
            Probe.Choose(choose);
            yield return ` + "$yielded" + `;
        }
    }
    public static int Run() {
        Probe.Reset();
        foreach (var row in Rows(true)) { return -1; }
        if (Probe.Calls != 0) { return -2; }
        var present = Rows(false);
        if (Probe.Calls != 0) { return -3; }
        int count = 0;
        foreach (var row in present) {
            if (row.Text != "x" || Probe.Calls != 1) { return -4; }
            count++;
        }
        return count;
    }
}`), fixture)
        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed)
        Assert.DoesNotContain("text!!", printed)
        if materialized {
            AssertTypedHoists(printed, "(Text string, Code int32)", expectedCount: 1)
        }
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func GuardedNestedCastTupleLeaf_StillPromotesTheNullSibling() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<((string Text, string Missing) Names, int Code)> Rows(bool choose) {
        string? text = choose ? null : "x";
        if (text != null) {
            yield return choose
                ? (((string)text, (string)null), 1)
                : (((string)text, (string)(null)), 2);
        }
    }
    public static int Run() {
        foreach (var row in Rows(true)) { return -1; }
        int count = 0;
        foreach (var row in Rows(false)) {
            if (row.Names.Text != "x" || row.Names.Missing != null || row.Code != 2) { return -2; }
            count++;
        }
        return count;
    }
}`, fixture)
        const tuple = "(Names (Text string, Missing string?), Code int32)"
        Assert.Contains("func Rows(choose bool) sequence[" + tuple + "]", printed)
        AssertTypedHoists(printed, tuple, expectedCount: 1)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("(string)(object)\"keep\"", "string", "\"keep\"", "string")
    @InlineData("(string)null ?? \"keep\"", "string", "\"keep\"", "string")
    @InlineData("(int)(object)null", "int", "1", "int32")
    @InlineData("(Box)(string)null", "Box", "new Box()", "Box")
    func IteratorCastWithoutNullResult_PreservesElementAndHoistPrecision(
        value string,
        type string,
        fallback string,
        mappedType string
    ) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<(` + "$type" + ` Value, int Code)> Rows(bool choose) {
        yield return choose ? (` + "$value" + `, 1) : (` + "$fallback" + `, 2);
    }
}`), fixture)
        let tuple = "(Value $mappedType, Code int32)"
        Assert.Contains("func Rows(choose bool) sequence[" + tuple + "]", printed)
        AssertTypedHoists(printed, tuple, expectedCount: 1)
        using let resolver = ReferenceResolver.WithReferences([]string{fixture})
        TranslationTestValidation.AssertBinds(resolver, printed)
    }

    @Theory
    @InlineData("new object() as string")
    @InlineData("(new object() as string)")
    @InlineData("checked(new object() as string)")
    @InlineData("unchecked(new object() as string)")
    @InlineData("choose ? new object() as string : \"keep\"")
    @InlineData("choose switch { true => new object() as string, false => \"keep\" }")
    func TryCastResult_PromotesTupleScalarAndLaterAssignment(value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`public static class Obj {
    public static (string Value, string Keep, int Code) Row(bool choose) => (` + "$value" + `, "keep", 1);
    public static (string Value, string Keep, int Code) Forward(bool choose) => Row(choose);
    public static string Scalar(bool choose) => ` + "$value" + `;
    public static string Later(bool choose) {
        string text = "keep";
        text = ` + "$value" + `;
        return text;
    }
    public static int Run() {
        var row = Forward(true);
        return row.Value == null && row.Keep == "keep" && row.Code == 1
            && Scalar(true) == null && Later(true) == null ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row(choose bool) (Value string?, Keep string, Code int32)", printed)
        Assert.Contains("func Forward(choose bool) (Value string?, Keep string, Code int32)", printed)
        Assert.Contains("func Scalar(choose bool) string?", printed)
        Assert.Contains("func Later(choose bool) string?", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Fact
    func TryCastInsideNonNullableUnboxing_PreservesValueResultAndException() {
        let fixture = this.EmitFixture()
        let printed = Translate(`public static class Obj {
    public static (object Value, int Code) Row() => ((int)(new object() as System.IConvertible), 1);
    public static object Scalar() => (int)(new object() as System.IConvertible);
}`, fixture)
        Assert.Contains("func Row() (Value object, Code int32)", printed)
        Assert.Contains("func Scalar() object", printed)
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row()")
    }

    @Theory
    @InlineData("(MaybeBox?)\"x\"", false)
    @InlineData("((MaybeBox?)\"x\")", false)
    @InlineData("checked((MaybeBox?)\"x\")", false)
    @InlineData("\"x\"", false)
    @InlineData("(MaybeBox?)\"x\"", true)
    @InlineData("((MaybeBox?)\"x\")", true)
    @InlineData("checked((MaybeBox?)\"x\")", true)
    @InlineData("\"x\"", true)
    func NullableOperatorConvertedResult_RetainsNonNullSinkAssertion(value string, initialize bool) {
        let make = if initialize {
            "{ MaybeBox result = $value; return result; }"
        } else {
            "=> $value;"
        }
        let fixture = this.EmitFixture()
        let printed = Translate((`#nullable enable
using Issue4719Fixture;
public static class Obj {
    public static MaybeBox Make() ` + "$make" + `
}`), fixture)
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Make()")
        Assert.Contains("func Make() MaybeBox", printed)
        Assert.Contains("!!", printed)
    }

    @Theory
    @InlineData("value")
    @InlineData("(MaybeBox?)value")
    func NullableOperatorConvertedResult_PromotedTupleSinkStillAcceptsNull(value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using Issue4719Fixture;
public static class Obj {
    public static (MaybeBox Value, int Code) Row(string value) => (` + "$value" + `, 1);
    public static int Run() {
        Probe.Reset();
        var row = Row("x");
        return row.Value == null && row.Code == 1 && Probe.Calls == 1 ? 1 : -1;
    }
}`), fixture)
        Assert.Contains("func Row(value string) (Value MaybeBox?, Code int32)", printed)
        AssertBindsAndRuns(printed, fixture, expected: 1)
    }

    @Theory
    @InlineData("Task", "value")
    @InlineData("Task", "(MaybeBox?)value")
    @InlineData("ValueTask", "value")
    @InlineData("ValueTask", "(MaybeBox?)value")
    func AsyncNullableOperatorConvertedResult_PromotedTupleSinkExecutesWithoutAssertion(envelope string, value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public static class Obj {
    public static async ` + "$envelope" + `<(MaybeBox Value, int Code)> Row(string value) {
        await Task.Delay(1);
        return (` + "$value" + `, 1);
    }
    public static void Main() {
        Probe.Reset();
        var row = Row("x").GetAwaiter().GetResult();
        Console.WriteLine(row.Value == null && row.Code == 1 && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        let tuple = "(Value MaybeBox?, Code int32)"
        Assert.Contains(
            "async func Row(value string) " +
                (
                if envelope == "ValueTask" {
                    "ValueTask[$tuple]"
                } else {
                    tuple
                }
            ),
            printed
        )
        Assert.DoesNotContain("MaybeBox?(value)!!", printed)
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func AsyncTupleOperatorContracts_PreserveNilInputsStrictSinksAndPropertyCounts(envelope string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public static class Obj {
    #nullable enable
    private static string? text;
    public static int Reads;
    public static string? Text {
        get { Reads++; return text; }
        set { text = value; }
    }
    public static async ` + "$envelope" + `<MaybeBox> StrictResult(string value) {
        await Task.Delay(1);
        return value;
    }
    #nullable disable
    public static async ` + "$envelope" + `<(MaybeBox Value, int Code)> Guarded() {
        await Task.Delay(1);
        if (Text != null) { return (Text, 2); }
        return ((MaybeBox)null, 2);
    }
    public static async ` + "$envelope" + `<(NullAcceptingBox Value, int Code)> Accepting() {
        await Task.Delay(1);
        return (Text, 1);
    }
    public static void Main() {
        Probe.Reset();
        Text = null;
        Reads = 0;
        var accepting = Accepting().GetAwaiter().GetResult();
        bool accepts = accepting.Value == null && accepting.Code == 1
            && Probe.Calls == 1 && Reads == 1;
        Probe.Reset();
        Text = "keep";
        Reads = 0;
        var guarded = Guarded().GetAwaiter().GetResult();
        bool guards = guarded.Value == null && guarded.Code == 2
            && Probe.Calls == 1 && Reads == 2;
        Probe.Reset();
        bool asserted = false;
        try { StrictResult("x").GetAwaiter().GetResult(); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(accepts && guards && asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Text!!", printed)
        Assert.Contains("MaybeBox?(value)!!", printed)
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func AsyncTupleOperatorResult_FrozenParameterContractRetainsAssertion(envelope string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public static class Obj {
    public static async ` + "$envelope" + `<int> Read(string value) {
        await Task.Delay(1);
        return FrozenTupleContract.Accept((value, 1));
    }
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        try { Read("x").GetAwaiter().GetResult(); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("MaybeBox?(value)!!", printed)
    }

    @Theory
    @InlineData("Text")
    @InlineData("(MaybeBox?)Text")
    @InlineData("checked((MaybeBox?)Text)")
    @InlineData("choose ? Text : Text")
    func ScalarYieldNullableOperatorResult_UsesTheEmittedElementContract(value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    #nullable enable
    private static string? text;
    public static int Reads;
    public static string? Text {
        get { Reads++; return text; }
        set { text = value; }
    }
    #nullable disable
    public static IEnumerable<MaybeBox> Rows(bool choose) {
        if (Text != null) { yield return ` + "$value" + `; }
    }
    public static void Main() {
        Probe.Reset();
        Text = "keep";
        Reads = 0;
        int missing = 0;
        foreach (var item in Rows(true)) {
            if (item == null) { missing++; }
        }
        Console.WriteLine(missing == 1 && Probe.Calls == 1 && Reads == 2 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("func Rows(choose bool) sequence[MaybeBox?]", printed)
        if value == "Text" || value == "choose ? Text : Text" {
            Assert.Contains("Text!!", printed)
        }
        Assert.DoesNotContain("MaybeBox?(Text!!)!!", printed)
    }

    @Fact
    func ScalarYieldNullableOperatorInput_RemainsBareAndExecutesOnce() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System;
using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    #nullable enable
    public static int Reads;
    public static string? Text {
        get { Reads++; return null; }
        set { }
    }
    #nullable disable
    public static IEnumerable<NullAcceptingBox> Rows() {
        yield return Text;
    }
    public static void Main() {
        Probe.Reset();
        Reads = 0;
        int missing = 0;
        foreach (var item in Rows()) {
            if (item == null) { missing++; }
        }
        Console.WriteLine(missing == 1 && Probe.Calls == 1 && Reads == 1 ? 15 : -1);
    }
}`, fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("func Rows() sequence[NullAcceptingBox?]", printed)
        Assert.DoesNotContain("Text!!", printed)
    }

    @Theory
    @InlineData("value")
    @InlineData("(MaybeBox?)value")
    func ScalarYieldNullableOperatorResult_AnnotatedElementRetainsAssertion(value string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`#nullable enable
using System;
using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<MaybeBox> Rows(string value) {
        yield return ` + "$value" + `;
    }
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        try {
            foreach (var item in Rows("x")) { }
        }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("func Rows(value string) sequence[MaybeBox]", printed)
        Assert.Contains("MaybeBox?(value)!!", printed)
    }

    @Fact
    func ScalarYieldNullableOperatorResult_FrozenParameterContractRetainsAssertion() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System;
using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    public static IEnumerable<MaybeBox> Rows() {
        yield return "x";
    }
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        try {
            foreach (var item in Rows()) {
                FrozenTupleContract.Accept((item, 1));
            }
        }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`, fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("func Rows() sequence[MaybeBox?]", printed)
        Assert.Contains("FrozenTupleContract.Accept((item!!, 1))", printed)
    }

    @Theory
    @InlineData(true, "return")
    @InlineData(true, "array")
    @InlineData(true, "list")
    @InlineData(false, "return")
    @InlineData(false, "array")
    @InlineData(false, "list")
    func OperatorInputStoreBridge_ReportsTheActualParameterOnceAndExecutesOnce(genericParameter bool, store string) {
        let box = if genericParameter {
            "StrictInputBox<string>"
        } else {
            "StrictReferenceBox"
        }
        let body = switch store {
            case "array": "var rows = new $box[] { Text }; return rows[0];"
            case "list": "var rows = new System.Collections.Generic.List<$box>(); rows.Add(Text); return rows[0];"
            default: "return Text;"
        }
        let fixture = this.EmitFixture()
        let (printed, context) = TranslateWithContext((`#nullable enable
using System;
using Issue4719Fixture;
public static class Obj {
    private static string? text;
    public static int Reads;
    public static string? Text {
        get { Reads++; return text; }
        set { text = value; }
    }
    public static ` + "$box" + ` Read() {
        if (Text != null) { ` + "$body" + ` }
        return new ` + "$box" + `();
    }
    public static void Main() {
        Probe.Reset();
        Text = "keep";
        Reads = 0;
        var result = Read();
        Console.WriteLine(result != null && Probe.Calls == 1 && Reads == 2 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Single(Regex.Matches(printed, "Text!!").Cast[Match]())
        let sites = context
            .Diagnostics
            .Where(
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
            .ToArray()
        if genericParameter {
            let site = Assert.Single(sites)
            Assert.Equal(TranslationSeverity.Warning, site.Severity)
            Assert.StartsWith(
                "kind=constructed-generic-member | target=StrictInputBox<string>.implicit operator",
                site.Message
            )
            Assert.Contains(
                "parameter 'value' | slot-type=string (NotAnnotated) | result-depends-on-slot=yes | value=Text",
                site.Message
            )
            Assert.Equal("Text", site.Location!!.SourceTree!!.GetText().ToString(site.Location!!.SourceSpan))
        } else {
            Assert.Empty(sites)
        }
    }

    @Theory
    @InlineData("return")
    @InlineData("list")
    func NullableOperatorInputStoreBridge_RemainsBareAndUnreported(store string) {
        let body = if store == "list" {
            "var rows = new System.Collections.Generic.List<NullAcceptingInputBox<string>>(); rows.Add(Text); return rows[0];"
        } else {
            "return Text;"
        }
        let fixture = this.EmitFixture()
        let (printed, context) = TranslateWithContext((`#nullable enable
using System;
using Issue4719Fixture;
public static class Obj {
    public static int Reads;
    public static string? Text {
        get { Reads++; return null; }
        set { }
    }
    public static NullAcceptingInputBox<string> Read() { ` + "$body" + ` }
    public static void Main() {
        Probe.Reset();
        Reads = 0;
        var result = Read();
        Console.WriteLine(result != null && Probe.Calls == 1 && Reads == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.DoesNotContain("Text!!", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
    }

    @Theory
    @InlineData("array")
    @InlineData("list")
    func OperatorInputAndResultStoreBridges_ReportDistinctSlotsWithoutRepeatingEvaluation(store string) {
        let body = if store == "array" {
            "var rows = new MaybeStrictInputBox<string>[] { Text }; return rows[0];"
        } else {
            "var rows = new System.Collections.Generic.List<MaybeStrictInputBox<string>>(); rows.Add(Text); return rows[0];"
        }
        let fixture = this.EmitFixture()
        let (printed, context) = TranslateWithContext((`#nullable enable
using System;
using Issue4719Fixture;
public static class Obj {
    private static string? text;
    public static int Reads;
    public static string? Text {
        get { Reads++; return text; }
        set { text = value; }
    }
    public static MaybeStrictInputBox<string> Read() {
        if (Text != null) { ` + "$body" + ` }
        return new MaybeStrictInputBox<string>();
    }
    public static void Main() {
        Probe.Reset();
        Text = "keep";
        Reads = 0;
        var result = Read();
        Console.WriteLine(result != null && Probe.Calls == 1 && Reads == 2 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Single(Regex.Matches(printed, "Text!!").Cast[Match]())
        let sites = context
            .Diagnostics
            .Where(
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
            .ToArray()
        Assert.Equal(2, sites.Length)
        Assert.Contains(
            sites,
            (site TranslationDiagnostic) -> site.Message!!.Contains(
                "target=MaybeStrictInputBox<string>.implicit operator",
                StringComparison.Ordinal
            ) &&
                site.Message!!.Contains("parameter 'value' | slot-type=string (NotAnnotated)", StringComparison.Ordinal)
        )
        Assert.Contains(
            sites,
            (site TranslationDiagnostic) -> if store == "array" {
                site.Message!!.StartsWith(
                    "kind=array-element | target=MaybeStrictInputBox<string>[]",
                    StringComparison.Ordinal
                )
            } else {
                site.Message!!.StartsWith(
                    "kind=constructed-generic-member | target=List<MaybeStrictInputBox<string>>.Add",
                    StringComparison.Ordinal
                )
            }
        )
        Assert.All(
            sites,
            (site TranslationDiagnostic) -> Assert.Equal(
                "Text",
                site.Location!!.SourceTree!!.GetText().ToString(site.Location!!.SourceSpan)
            )
        )
    }

    @Theory
    @InlineData(false, "return Text;")
    @InlineData(false, "StrictBox result = Text; return result;")
    @InlineData(false, "StrictBox result = new StrictBox(); result = Text; return result;")
    @InlineData(true, "return Text;")
    @InlineData(true, "StrictBox result = Text; return result;")
    @InlineData(true, "StrictBox result = new StrictBox(); result = Text; return result;")
    func GuardedSettablePropertyOperatorInput_UsesTheActualParameterContract(acceptsNull bool, body string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`#nullable enable
using Issue4719Fixture;
public sealed class StrictBox {
    public static implicit operator StrictBox(string` + "${(if acceptsNull { "?" } else { "" })}" + ` value) {
        Probe.Calls++;
        return new StrictBox();
    }
}
public static class Obj {
    private static string? text;
    public static int Reads;
    public static string? Text {
        get { Reads++; return text; }
        set { text = value; }
    }
    public static StrictBox Read() {
        if (Text != null) { ` + "$body" + ` }
        return new StrictBox();
    }
    ` + "${(if acceptsNull { "public static StrictBox Bare() => Text;" } else { string.Empty })}" + `
    public static int Run() {
        Text = "keep";
        Probe.Reset();
        Reads = 0;
        var result = Read();
        if (result == null || Probe.Calls != 1 || Reads != 2) { return -1; }
        ` + "${(if acceptsNull { "Text = null; return Bare() != null && Probe.Calls == 2 && Reads == 3 ? 1 : -2;" } else { "return 1;" })}" + `
    }
}`), fixture)
        AssertBindsAndRuns(printed, fixture, expected: 1)
        if acceptsNull {
            Assert.DoesNotContain("Text!!", printed)
        } else {
            Assert.Contains("Text!!", printed)
        }
    }

    @Theory
    @InlineData("(NullableResultBox?)\"keep\"")
    @InlineData("\"keep\"")
    func TryCastAndOperatorAssertionBoundaries_RealDriverVerifiesAndExecutesOnce(result string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using Issue4719Fixture;
#nullable enable
public sealed class StrictBox {
    public static implicit operator StrictBox(string value) {
        Probe.Calls++;
        return new StrictBox();
    }
}
public static class Obj {
    private static string? text;
    public static int Reads;
    public static string? Text {
        get { Reads++; return text; }
        set { text = value; }
    }
    public static StrictBox Read() {
        if (Text != null) { return Text; }
        return new StrictBox();
    }
    public static NullableResultBox Make() => ` + "$result" + `;
    #nullable disable
    public static (string Value, int Code) Row() => (new object() as string, 1);
    public static string Later() {
        string value = "keep";
        value = new object() as string;
        return value;
    }
    #nullable enable
    public static void Main() {
        Probe.Reset();
        Text = "keep";
        Reads = 0;
        Console.WriteLine(Make() != null && Read() != null && Reads == 2
            && Probe.Calls == 2 && Row().Value == null && Later() == null ? 15 : -1);
    }
}`), fixture)
        Assert.Contains("func Row() (Value string?, Code int32)", printed)
        Assert.Contains("func Later() string?", printed)
        Assert.Contains("Text!!", printed)
        Assert.Contains("func Make() NullableResultBox", printed)
        Assert.Contains("NullableResultBox?(\"keep\")!!", printed)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData("Task", false)
    @InlineData("ValueTask", false)
    @InlineData("Task", true)
    @InlineData("ValueTask", true)
    func TupleContractEligibility_AnnotatedSourceRetainsPerLeafAssertions(envelope string, nested bool) {
        let fixture = this.EmitFixture()
        let tuple = if nested {
            "((NullableResultBox Required, NullAcceptingBox? Optional) Pair, int Code, int? Maybe)"
        } else {
            "(NullableResultBox Required, NullAcceptingBox? Optional, int Code, int? Maybe)"
        }
        let result = if nested {
            "((value, (string?)null), 1, null)"
        } else {
            "(value, (string?)null, 1, null)"
        }
        let required = if nested {
            "row.Pair.Required"
        } else {
            "row.Required"
        }
        let optional = if nested {
            "row.Pair.Optional"
        } else {
            "row.Optional"
        }
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public static class Obj {
    #nullable enable
    public static async ` + "$envelope" + `<` + "$tuple" + `> Read(string value) {
        await Task.Delay(1);
        return ` + "$result" + `;
    }
    #nullable disable
    public static void Main() {
        Probe.Reset();
        var row = Read("keep").GetAwaiter().GetResult();
        bool valid = ` + "$required" + ` != null && ` + "$optional" + ` == null
            && row.Code == 1 && row.Maybe == null && Probe.Calls == 2;
        Probe.Reset();
        bool asserted = false;
        try { Read("miss").GetAwaiter().GetResult(); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Required NullableResultBox,", printed)
        Assert.Contains("Optional NullAcceptingBox?", printed)
        Assert.Contains("NullableResultBox?(value)!!", printed)
    }

    @Theory
    @InlineData("Task", false)
    @InlineData("ValueTask", false)
    @InlineData("Task", true)
    @InlineData("ValueTask", true)
    func TupleContractEligibility_ObliviousSourceContractsPromoteTogether(envelope string, enabledDefault bool) {
        let fixture = this.EmitFixture()
        let source = (`#nullable disable
using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public interface ISourceRows {
    ` + "$envelope" + `<((NullAcceptingBox Missing, ReferenceBox Keep) Pair, int Code, int? Maybe)> Read(string value);
}
public sealed class Rows : ISourceRows {
    public async ` + "$envelope" + `<((NullAcceptingBox Missing, ReferenceBox Keep) Pair, int Code, int? Maybe)> Read(string value) {
        await Task.Delay(1);
        return (((string)null, value), 1, null);
    }
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        ISourceRows rows = new Rows();
        var row = rows.Read("keep").GetAwaiter().GetResult();
        Console.WriteLine(row.Pair.Missing == null && row.Pair.Keep != null
            && row.Code == 1 && row.Maybe == null && Probe.Calls == 2 ? 15 : -1);
    }
}`)
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, source string){("Snippet.cs", source)},
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(fixture)).ToArray()
        )
        let compilation = project.Compilation.WithOptions(
            project
                .Compilation
                .Options
                .WithNullableContextOptions(
                if enabledDefault {
                    NullableContextOptions.Enable
                } else {
                    NullableContextOptions.Disable
                }
            )
        )
        Assert.DoesNotContain(
            compilation.GetDiagnostics(),
            (diagnostic Microsoft.CodeAnalysis.Diagnostic) -> diagnostic.Severity == Microsoft
                .CodeAnalysis
                .DiagnosticSeverity
                .Error
        )
        let document = Assert.Single(project.Documents)
        let model = compilation.GetSemanticModel(document.SyntaxTree)
        let context = TranslationContext(compilation, model, document.FilePath)
        let printed = GSharpPrinter.Print(
            CSharpToGSharpTranslator().TranslateDocument(
                LoadedDocument(document.FilePath, document.SyntaxTree, model),
                context
            )
        )
        Assert.Contains("Missing NullAcceptingBox?", printed)
        Assert.Contains("Keep ReferenceBox", printed)
        Assert.DoesNotContain("Keep ReferenceBox?", printed)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func TupleContractEligibility_NativeLockPropagatesAcrossSourceContractComponent(envelope string) {
        let fixture = this.EmitFixture()
        let suffix = if envelope == "Task" {
            "Task"
        } else {
            "ValueTask"
        }
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public interface ISourceRows {
    ` + "$envelope" + `<(NullableResultBox Required, int Code)> Read(string value);
}
public sealed class Locked : RowsBase` + "$suffix" + `, ISourceRows {
    public override async ` + "$envelope" + `<(NullableResultBox Required, int Code)> Read(string value) {
        await Task.Delay(1);
        return (value, 1);
    }
}
public sealed class Other : ISourceRows {
    public async ` + "$envelope" + `<(NullableResultBox Required, int Code)> Read(string value) {
        await Task.Delay(1);
        return (value, 1);
    }
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        ISourceRows locked = new Locked();
        ISourceRows other = new Other();
        bool valid = locked.Read("keep").GetAwaiter().GetResult().Required != null
            && other.Read("keep").GetAwaiter().GetResult().Required != null && Probe.Calls == 2;
        Probe.Reset();
        bool asserted = false;
        try { other.Read("miss").GetAwaiter().GetResult(); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        Assert.DoesNotContain("Required NullableResultBox?", printed)
        Assert.Contains("NullableResultBox?(value)!!", printed)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData("Task", "interface")
    @InlineData("ValueTask", "interface")
    @InlineData("Task", "explicit")
    @InlineData("ValueTask", "explicit")
    @InlineData("Task", "base")
    @InlineData("ValueTask", "base")
    @InlineData("Task", "generic-interface")
    @InlineData("ValueTask", "generic-interface")
    @InlineData("Task", "generic-base")
    @InlineData("ValueTask", "generic-base")
    func TupleContractEligibility_NativeInheritedReturnContractIsImmutable(envelope string, contract string) {
        let fixture = this.EmitFixture()
        let suffix = if envelope == "Task" {
            "Task"
        } else {
            "ValueTask"
        }
        let inherited = switch contract {
            case "base": "RowsBase" + suffix
            case "generic-base": "GenericRowsBase$suffix<NullableResultBox>"
            case "generic-interface": "IGenericRows$suffix<NullableResultBox>"
            default: "IRows" + suffix
        }
        let method = if contract == "explicit" {
            "$inherited.Read"
        } else {
            "Read"
        }
        let isBase = contract.Contains("base", StringComparison.Ordinal)
        let modifiers = if isBase {
            "public override async"
        } else {
            (
                if contract == "explicit" {
                    "async"
                } else {
                    "public async"
                }
            )
        }
        let tuple = if isBase {
            "(NullableResultBox Required, int Code)"
        } else {
            "(NullableResultBox Required, NullAcceptingBox Optional, int Code)"
        }
        let result = if isBase {
            "(value, 1)"
        } else {
            "(value, (string?)null, 1)"
        }
        let optional = if isBase {
            string.Empty
        } else {
            "&& row.Optional == null"
        }
        let calls = if isBase {
            1
        } else {
            2
        }
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public sealed class Rows : ` + "$inherited" + ` {
    ` + "$modifiers" + ` ` + "$envelope" + `<` + "$tuple" + `> ` + "$method" + `(string value) {
        await Task.Delay(1);
        return ` + "$result" + `;
    }
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        var row = NativeRows.Read((` + "$inherited" + `)new Rows(), "keep").GetAwaiter().GetResult();
        bool valid = row.Required != null ` + "$optional" + `
            && row.Code == 1 && Probe.Calls == ` + "$calls" + `;
        Probe.Reset();
        bool asserted = false;
        try { NativeRows.Read((` + "$inherited" + `)new Rows(), "miss").GetAwaiter().GetResult(); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Required NullableResultBox,", printed)
        if !isBase {
            Assert.Contains("Optional NullAcceptingBox?", printed)
        }
        Assert.Contains("NullableResultBox?(value)!!", printed)
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func TupleContractEligibility_ExactNativeNonNullContractRejectsNilOnce(envelope string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public sealed class Rows : IAlwaysRows` + "$envelope" + ` {
    public async ` + "$envelope" + `<(MaybeBox Value, int Code)> Read(string value) {
        await Task.Delay(1);
        return (value, 1);
    }
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        IAlwaysRows` + "$envelope" + ` rows = new Rows();
        try { NativeRows.Read(rows, "x").GetAwaiter().GetResult(); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        Assert.Contains("Value MaybeBox,", printed)
        Assert.Contains("MaybeBox?(value)!!", printed)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData("Task", false)
    @InlineData("ValueTask", false)
    @InlineData("Task", true)
    @InlineData("ValueTask", true)
    func TupleContractEligibility_PartialDefinitionControlsOnlyItsOwnLeaves(envelope string, strict bool) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public static partial class Obj {
    #nullable ` + "${(if strict { "enable" } else { "disable" })}" + `
    public static partial ` + "$envelope" + `<(MaybeBox Value, int Code)> Read(string value);
    #nullable disable
    public static async partial ` + "$envelope" + `<(MaybeBox Value, int Code)> Read(string value) {
        await Task.Delay(1);
        return (value, 1);
    }
    public static void Main() {
        Probe.Reset();
        bool nil = false;
        bool asserted = false;
        try { nil = Read("x").GetAwaiter().GetResult().Value == null; }
        catch (NullReferenceException) { asserted = true; }
        bool valid = ` + "${(if strict { "asserted" } else { "!asserted && nil" })}" + `;
        Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        Assert.Contains(
            if strict {
                "MaybeBox?(value)!!"
            } else {
                "Value MaybeBox?"
            },
            printed
        )
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData("enable")
    @InlineData("disable")
    func TupleContractEligibility_LocalMethodUsesItsDeclarationContext(directive string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static void Main() {
        #nullable ` + "$directive" + `
        (MaybeBox Value, int Code) Read(string value) => (value, 1);
        #nullable disable
        Probe.Reset();
        bool nil = false;
        bool asserted = false;
        try { nil = Read("x").Value == null; }
        catch (NullReferenceException) { asserted = true; }
        bool valid = ` + "${(if directive == "enable" { "asserted" } else { "!asserted && nil" })}" + `;
        Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        Assert.Contains(
            if directive == "enable" {
                "MaybeBox?(value)!!"
            } else {
                "Value MaybeBox?"
            },
            printed
        )
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData("field")
    @InlineData("property")
    @InlineData("argument")
    @InlineData("delegate")
    func TupleContractEligibility_FrozenNativeStoresRetainTheirResultBridge(store string) {
        let fixture = this.EmitFixture()
        let body = switch store {
            case "field": "NativeTupleSlots.Field = (value, 1); return NativeTupleSlots.Field.Code;"
            case "property": "NativeTupleSlots.Property = (value, 1); return NativeTupleSlots.Property.Code;"
            case "argument": "return NativeTupleSlots.Accept((value, 1));"
            default: "NativeTupleSlots.Factory factory = Make; return factory(value).Code;"
        }
        let maker = if store == "delegate" {
            "public static (NullableResultBox Required, int Code) Make(string value) => (value, 1);"
        } else {
            string.Empty
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    ` + "$maker" + `
    public static int Store(string value) { ` + "$body" + ` }
    public static void Main() {
        Probe.Reset();
        bool valid = Store("keep") == 1 && Probe.Calls == 1;
        Probe.Reset();
        bool asserted = false;
        try { Store("miss"); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        Assert.Contains("NullableResultBox?(value)!!", printed)
        Assert.DoesNotContain("Required NullableResultBox?", printed)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractConversion_AssertedOperatorInputDoesNotSkipOuterOperator(switchArm bool) {
        let fixture = this.EmitFixture()
        let branch = if switchArm {
            "choose switch { true => (CastInputBox?)Text, false => new CastOutputBox() }"
        } else {
            "choose ? (CastInputBox?)Text : new CastOutputBox()"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static bool Missing;
    public static int Reads;
    #nullable enable
    public static string? Text { get { Reads++; return Missing ? null : "keep"; } }
    #nullable disable
    public static (CastOutputBox Value, int Code) Row(bool choose) => (` + "$branch" + `, 1);
    public static bool Check(bool choose, bool missing) {
        Missing = missing;
        Reads = 0;
        Probe.Reset();
        bool asserted = false;
        bool present = false;
        try { present = Row(choose).Value != null; }
        catch (NullReferenceException) { asserted = true; }
        return asserted == (choose && missing) && (asserted || present)
            && Reads == (choose ? 1 : 0)
            && Probe.Calls == (choose ? (missing ? 1 : 2) : 0);
    }
    public static void Main() {
        Console.WriteLine(Check(true, false) && Check(true, true)
            && Check(false, false) && Check(false, true) ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Value CastOutputBox?", printed)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func ScalarYieldNullableOperator_GuardedReadPreservesTheConvertedResult(local bool, strict bool) {
        let fixture = this.EmitFixture()
        let declaration = if local {
            "string text = value;"
        } else {
            string.Empty
        }
        let read = if local {
            "text"
        } else {
            "value"
        }
        let printed = Translate((`using System;
using System.Collections.Generic;
using Issue4719Fixture;
public static class Obj {
    #nullable ` + "${(if strict { "enable" } else { "disable" })}" + `
    public static IEnumerable<MaybeBox> Rows(string value) {
        ` + "$declaration" + `
        if (` + "$read" + ` != null) { yield return ` + "$read" + `; }
    }
    #nullable disable
    public static void Main() {
        Probe.Reset();
        bool nil = false;
        bool asserted = false;
        try {
            foreach (var row in Rows("x")) { nil = row == null; }
        }
        catch (NullReferenceException) { asserted = true; }
        bool valid = ` + "${(if strict { "asserted" } else { "!asserted && nil" })}" + `;
        Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "sequence[MaybeBox]"
            } else {
                "sequence[MaybeBox?]"
            },
            printed
        )
    }

    @Theory
    @InlineData("Iterator", false, false)
    @InlineData("Iterator", true, false)
    @InlineData("Iterator", false, true)
    @InlineData("Iterator", true, true)
    @InlineData("Task", true, false)
    @InlineData("ValueTask", true, false)
    func TupleContractProjection_ParenthesizedDestinationPreservesTheLeaf(envelope string, nested bool, strict bool) {
        let fixture = this.EmitFixture()
        let tuple = if nested {
            "((MaybeBox Value, string Keep) Pair, int Code)"
        } else {
            "(MaybeBox Value, int Code)"
        }
        let value = if nested {
            "((((value, \"keep\")), 1))"
        } else {
            "((value, 1))"
        }
        let check = if nested {
            "row.Pair.Value == null && row.Pair.Keep == \"keep\""
        } else {
            "row.Value == null"
        }
        let method = if envelope == "Iterator" {
            "public static IEnumerable<$tuple> Rows(string value) { yield return $value; }"
        } else {
            "public static async $envelope<$tuple> Rows(string value) { await Task.Delay(1); return $value; }"
        }
        let consume = if envelope == "Iterator" {
            "foreach (var row in Rows(\"x\")) { nil = $check && row.Code == 1; }"
        } else {
            "var row = Rows(\"x\").GetAwaiter().GetResult(); nil = $check && row.Code == 1;"
        }
        let printed = Translate((`using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Issue4719Fixture;
public static class Obj {
    #nullable ` + "${(if strict { "enable" } else { "disable" })}" + `
    ` + "$method" + `
    #nullable disable
    public static void Main() {
        Probe.Reset();
        bool nil = false;
        bool asserted = false;
        try { ` + "$consume" + ` }
        catch (NullReferenceException) { asserted = true; }
        bool valid = ` + "${(if strict { "asserted" } else { "!asserted && nil" })}" + `;
        Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "Value MaybeBox,"
            } else {
                "Value MaybeBox?"
            },
            printed
        )
    }

    @Theory
    @InlineData("interface", false)
    @InlineData("interface", true)
    @InlineData("base", false)
    @InlineData("base", true)
    func TupleContractProjection_WholeNativeTypeArgumentRemainsCallerOwned(contract string, strict bool) {
        let fixture = this.EmitFixture()
        let inherited = if contract == "interface" {
            "IWholeRows"
        } else {
            "WholeRowsBase"
        }
        let modifiers = if contract == "base" {
            "public override"
        } else {
            "public"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
#nullable ` + "${(if strict { "enable" } else { "disable" })}" + `
public sealed class Rows : ` + "$inherited" + `<(MaybeBox Value, int Code)> {
    ` + "$modifiers" + ` (MaybeBox Value, int Code) Read(string value) => (value, 1);
}
#nullable disable
public static class Obj {
    public static void Main() {
        Probe.Reset();
        bool nil = false;
        bool asserted = false;
        ` + "$inherited" + `<(MaybeBox Value, int Code)> rows = new Rows();
        try {
            var row = NativeRows.Read(rows, "x");
            nil = row.Value == null && row.Code == 1;
        }
        catch (NullReferenceException) { asserted = true; }
        bool valid = ` + "${(if strict { "asserted" } else { "!asserted && nil" })}" + `;
        Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "Value MaybeBox,"
            } else {
                "Value MaybeBox?"
            },
            printed
        )
    }

    @Theory
    @InlineData("Task")
    @InlineData("ValueTask")
    func TupleContractProjection_UnrelatedTupleArgumentDoesNotUnlockNativeReferenceSlot(envelope string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public sealed class Rows : IMixedRows` + "$envelope" + `<MaybeBox, (string Text, int Code)> {
    public async ` + "$envelope" + `<(MaybeBox Value, int Code)> Read(string value) {
        await Task.Delay(1);
        return (value, 1);
    }
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        IMixedRows` + "$envelope" + `<MaybeBox, (string Text, int Code)> rows = new Rows();
        try { rows.Read("x").GetAwaiter().GetResult(); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Value MaybeBox,", printed)
        Assert.Contains("MaybeBox?(value)!!", printed)
    }

    @Theory
    @InlineData("Sync", false, false)
    @InlineData("Sync", true, false)
    @InlineData("Sync", false, true)
    @InlineData("Sync", true, true)
    @InlineData("Iterator", false, false)
    @InlineData("Iterator", true, false)
    @InlineData("Iterator", false, true)
    @InlineData("Iterator", true, true)
    @InlineData("Task", false, false)
    @InlineData("Task", true, false)
    @InlineData("Task", false, true)
    @InlineData("Task", true, true)
    @InlineData("ValueTask", false, false)
    @InlineData("ValueTask", true, false)
    @InlineData("ValueTask", false, true)
    @InlineData("ValueTask", true, true)
    func TupleContractContext_MixedBranchArmsUseTheEmittedDestination(envelope string, switchArm bool, strict bool) {
        let fixture = this.EmitFixture()
        let value = if switchArm {
            "Choose(choose) switch { true => \"x\", false => new MaybeBox() }"
        } else {
            "Choose(choose) ? \"x\" : new MaybeBox()"
        }
        let tuple = "(MaybeBox Value, int Code)"
        let method = switch envelope {
            case "Sync": "public static $tuple Rows(bool choose) => ($value, 1);"
            case "Iterator": "public static IEnumerable<$tuple> Rows(bool choose) { yield return ($value, 1); }"
            default: "public static async $envelope<$tuple> Rows(bool choose) { await Task.Delay(1); return ($value, 1); }"
        }
        let consume = switch envelope {
            case "Sync": "var row = Rows(choose); nil = row.Value == null && row.Code == 1;"
            case "Iterator": "foreach (var row in Rows(choose)) { nil = row.Value == null && row.Code == 1; }"
            default: "var row = Rows(choose).GetAwaiter().GetResult(); nil = row.Value == null && row.Code == 1;"
        }
        let printed = Translate((`using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Issue4719Fixture;
public static class Obj {
    public static int Decisions;
    public static bool Choose(bool choose) { Decisions++; return choose; }
    #nullable ` + "${(if strict { "enable" } else { "disable" })}" + `
    ` + "$method" + `
    #nullable disable
    public static bool Check(bool choose) {
        bool nil = false;
        bool asserted = false;
        try { ` + "$consume" + ` }
        catch (NullReferenceException) { asserted = true; }
        bool valid = choose ? ` + "${(if strict { "asserted" } else { "!asserted && nil" })}" + ` : !asserted && !nil;
        return valid && Decisions == 1 && Probe.Calls == (choose ? 1 : 0);
    }
    public static void Main() {
        Probe.Reset();
        Decisions = 0;
        bool missing = Check(true);
        Probe.Reset();
        Decisions = 0;
        bool present = Check(false);
        Console.WriteLine(missing && present ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "Value MaybeBox,"
            } else {
                "Value MaybeBox?"
            },
            printed
        )
    }

    @Theory
    @InlineData("Sync", "own", false)
    @InlineData("Sync", "own", true)
    @InlineData("Task", "own", false)
    @InlineData("Task", "own", true)
    @InlineData("ValueTask", "own", false)
    @InlineData("ValueTask", "own", true)
    @InlineData("Sync", "source", false)
    @InlineData("Sync", "source", true)
    func TupleContractContext_SourceContainingGenericRetainsItsActualContract(
        envelope string,
        contract string,
        strict bool
    ) {
        let fixture = this.EmitFixture()
        let method = if envelope == "Sync" {
            "public (T Value, int Code) Read(bool missing) => (missing ? null : (T)(object)\"keep\", 1);"
        } else {
            "public async $envelope<(T Value, int Code)> Read(bool missing) { await Task.Delay(1); return (missing ? null : (T)(object)\"keep\", 1); }"
        }
        let interfaceDeclaration = if contract == "source" {
            (`#nullable ` + "${(if strict { "enable" } else { "disable" })}" + `
public interface IRows<T> where T : class { (T Value, int Code) Read(bool missing); }`)
        } else {
            string.Empty
        }
        let inherited = switch contract {
            case "source": " : IRows<T>"
            default: string.Empty
        }
        let receiver = switch contract {
            case "source": "IRows<string>"
            default: "Rows<string>"
        }
        let read = if envelope == "Sync" {
            "rows.Read(missing)"
        } else {
            "rows.Read(missing).GetAwaiter().GetResult()"
        }
        let printed = Translate((`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
` + "$interfaceDeclaration" + `
#nullable ` + "${(if strict && contract == "own" { "enable" } else { "disable" })}" + `
public sealed class Rows<T>` + "$inherited" + ` where T : class {
    ` + "$method" + `
}
#nullable disable
public static class Obj {
    public static bool Check(bool missing) {
        ` + "$receiver" + ` rows = new Rows<string>();
        bool nil = false;
        bool asserted = false;
        try {
            var row = ` + "$read" + `;
            nil = row.Value == null && row.Code == 1;
            if (!missing && (row.Value != "keep" || row.Code != 1)) { return false; }
        }
        catch (NullReferenceException) { asserted = true; }
        return missing ? ` + "${(if strict { "asserted" } else { "!asserted && nil" })}" + ` : !asserted && !nil;
    }
    public static void Main() { Console.WriteLine(Check(true) && Check(false) ? 15 : -1); }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "Value T,"
            } else {
                "Value T?"
            },
            printed
        )
    }

    @Fact
    func TupleContractContext_SourceGenericLiteralUsesNullableLeaf() {
        let fixture = this.EmitFixture()
        let printed = Translate(`using System;
using Issue4719Fixture;
public sealed class Rows<T> where T : class {
    public (T Value, int Code) Read() => (null, 1);
}
public static class Obj {
    public static void Main() {
        var row = new Rows<string>().Read();
        Console.WriteLine(row.Value == null && row.Code == 1 ? 15 : -1);
    }
}`, fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("func Read() (Value T?, Code int32)", printed)
    }

    @Theory
    @InlineData("Sync", false, false)
    @InlineData("Sync", true, false)
    @InlineData("Sync", false, true)
    @InlineData("Sync", true, true)
    @InlineData("Iterator", false, false)
    @InlineData("Iterator", true, false)
    @InlineData("Iterator", false, true)
    @InlineData("Iterator", true, true)
    @InlineData("Task", false, false)
    @InlineData("Task", true, false)
    @InlineData("Task", false, true)
    @InlineData("Task", true, true)
    @InlineData("ValueTask", false, false)
    @InlineData("ValueTask", true, false)
    @InlineData("ValueTask", false, true)
    @InlineData("ValueTask", true, true)
    func TupleContractBoundary_CoalescingConvertedArmsObserveNilBeforeTheStrictSink(
        envelope string,
        switchArm bool,
        explicitConversion bool
    ) {
        let fixture = this.EmitFixture()
        let converted = if explicitConversion {
            "(MaybeBox)Value"
        } else {
            "Value"
        }
        let branch = if switchArm {
            "Choose(choose) switch { true => $converted, false => new MaybeBox() }"
        } else {
            "Choose(choose) ? $converted : new MaybeBox()"
        }
        let value = "($branch) ?? Fallback()"
        let tuple = "(MaybeBox Value, int Code)"
        let method = switch envelope {
            case "Sync": "public static $tuple Rows(bool choose) => ($value, 1);"
            case "Iterator": "public static IEnumerable<$tuple> Rows(bool choose) { yield return ($value, 1); }"
            default: "public static async $envelope<$tuple> Rows(bool choose) { await Task.Delay(1); return ($value, 1); }"
        }
        let consume = switch envelope {
            case "Sync": "valid = FrozenTupleContract.Accept(Rows(choose)) == 1;"
            case "Iterator": "foreach (var row in Rows(choose)) { valid = FrozenTupleContract.Accept(row) == 1; }"
            default: "valid = FrozenTupleContract.Accept(Rows(choose).GetAwaiter().GetResult()) == 1;"
        }
        let printed = Translate((`using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Issue4719Fixture;
public static class Obj {
    public static int Decisions;
    public static int Reads;
    public static int Fallbacks;
    public static string Value { get { Reads++; return "x"; } }
    public static bool Choose(bool choose) { Decisions++; return choose; }
    public static MaybeBox Fallback() { Fallbacks++; return new MaybeBox(); }
    ` + "$method" + `
    public static bool Check(bool choose) {
        bool valid = false;
        ` + "$consume" + `
        return valid && Decisions == 1 && Reads == (choose ? 1 : 0)
            && Fallbacks == (choose ? 1 : 0) && Probe.Calls == (choose ? 1 : 0);
    }
    public static void Main() {
        Probe.Reset();
        Decisions = Reads = Fallbacks = 0;
        bool missing = Check(true);
        Probe.Reset();
        Decisions = Reads = Fallbacks = 0;
        bool present = Check(false);
        Console.WriteLine(missing && present ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Value MaybeBox,", printed)
        Assert.DoesNotContain("Value MaybeBox?", printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractBoundary_ConvertedCoalescingArmRetainsItsWiderReferenceTarget(missing bool) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static int Reads;
    public static int Decisions;
    public static int Fallbacks;
    public static ReferenceInput Value { get { Reads++; return new ReferenceInput(` + "${(if missing { "true" } else { "false" })}" + `); } }
    public static bool Choose(bool choose) { Decisions++; return choose; }
    public static ReferenceBase Fallback() { Fallbacks++; return new ReferenceBase(); }
    public static (ReferenceBase Value, int Code) Row(bool choose) =>
        ((Choose(choose) ? Value : new ReferenceBase()) ?? Fallback(), 1);
    public static bool Check(bool choose) {
        var row = Row(choose);
        return row.Value != null && row.Code == 1 && Decisions == 1
            && Reads == (choose ? 1 : 0) && Probe.Calls == (choose ? 1 : 0)
            && Fallbacks == (choose && ` + "${(if missing { "true" } else { "false" })}" + ` ? 1 : 0);
    }
    public static void Main() {
        Probe.Reset();
        Reads = Decisions = Fallbacks = 0;
        bool converted = Check(true);
        Probe.Reset();
        Reads = Decisions = Fallbacks = 0;
        Console.WriteLine(converted && Check(false) ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Value ReferenceBase,", printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractBoundary_CoalescingResultsKeepTheirOwnOperatorInputContract(strictInput bool) {
        let fixture = this.EmitFixture()
        let box = if strictInput {
            "MaybeStrictInputBox<string>"
        } else {
            "NullAcceptingBox"
        }
        let (printed, context) = TranslateWithContext((`#nullable enable
using System;
using Issue4719Fixture;
public static class Obj {
    public static int Reads;
    public static int Fallbacks;
    public static string? Value { get { Reads++; return null; } }
    public static ` + "$box" + ` Fallback() { Fallbacks++; return new ` + "$box" + `(); }
    public static (` + "$box" + ` Value, int Code) Row(bool choose) =>
        ((choose ? Value : new ` + "$box" + `()) ?? Fallback(), 1);
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        bool present = false;
        try { present = Row(true).Value != null; }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(Reads == 1 && ` + "${(if strictInput { "asserted && Probe.Calls == 0 && Fallbacks == 0" } else { "!asserted && present && Probe.Calls == 1 && Fallbacks == 1" })}" + ` ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        let sites = context
            .Diagnostics
            .Where(
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
            .ToArray()
        if strictInput {
            let site = Assert.Single(sites)
            Assert.Contains("target=MaybeStrictInputBox<string>.implicit operator", site.Message)
            Assert.Contains("parameter 'value'", site.Message)
            Assert.Contains("slot-type=string (NotAnnotated)", site.Message)
        } else {
            Assert.Empty(sites)
            Assert.DoesNotContain("Value!!", printed)
        }
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(false, true, false)
    @InlineData(true, false, false)
    @InlineData(true, true, false)
    @InlineData(false, false, true)
    @InlineData(false, true, true)
    @InlineData(true, false, true)
    @InlineData(true, true, true)
    func TupleContractBoundary_GettersQueryTheirPropertyContract(indexer bool, arrow bool, strict bool) {
        let fixture = this.EmitFixture()
        let declaration = if indexer {
            "public (NullableResultBox Value, int Code) this[int code]"
        } else {
            "public (NullableResultBox Value, int Code) Row"
        }
        let value = if indexer {
            "(Value, code)"
        } else {
            "(Value, 1)"
        }
        let body = if arrow {
            " => $value;"
        } else {
            " { get { return $value; } }"
        }
        let consume = if indexer {
            "rows[NextIndex()]"
        } else {
            "rows.Row"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
public sealed class Rows {
    public static int Reads;
    public static string Input = "keep";
    public string Value { get { Reads++; return Input; } }
    #nullable ` + "${(if strict { "enable" } else { "disable" })}" + `
    ` + "$declaration" + "$body" + `
}
#nullable disable
public static class Obj {
    public static int Indices;
    public static int NextIndex() { Indices++; return 1; }
    public static bool Check(bool missing) {
        Probe.Reset();
        Rows.Reads = Indices = 0;
        Rows.Input = missing ? "miss" : "keep";
        var rows = new Rows();
        bool nil = false;
        bool asserted = false;
        try {
            var row = ` + "$consume" + `;
            nil = row.Value == null && row.Code == 1;
            if (row.Code != 1) { return false; }
        }
        catch (NullReferenceException) { asserted = true; }
        bool valid = missing ? ` + "${(if strict { "asserted" } else { "!asserted && nil" })}" + ` : !asserted && !nil;
        return valid && Probe.Calls == 1 && Rows.Reads == 1 && Indices == ` + "${(if indexer { 1 } else { 0 })}" + `;
    }
    public static void Main() { Console.WriteLine(Check(true) && Check(false) ? 15 : -1); }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "Value NullableResultBox,"
            } else {
                "Value NullableResultBox?"
            },
            printed
        )
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(false, true, false)
    @InlineData(true, false, false)
    @InlineData(true, true, false)
    @InlineData(false, false, true)
    @InlineData(true, false, true)
    func TupleContractBoundary_PartialPropertyPreservesBothDeclarationContracts(
        strictDefinition bool,
        strictImplementation bool,
        forwarded bool
    ) {
        let strict = strictDefinition || strictImplementation
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using Issue4719Fixture;
public static partial class Obj {
    public static int Reads;
    public static string Value { get { Reads++; return "x"; } }
    #nullable ` + "${(if strictDefinition { "enable" } else { "disable" })}" + `
    public static partial (MaybeBox Value, NullAcceptingBox? Optional, int Code) Row { get; }
    #nullable ` + "${(if strictImplementation { "enable" } else { "disable" })}" + `
    public static partial (MaybeBox Value, NullAcceptingBox? Optional, int Code) Row {
        get { return (Value, (string)null, 1); }
    }
    #nullable disable
    ` + "${(if forwarded { "public static (MaybeBox Value, NullAcceptingBox? Optional, int Code) Forward() => Row;" } else { string.Empty })}" + `
    public static void Main() {
        Probe.Reset();
        bool nil = false;
        bool asserted = false;
        try {
            var row = ` + "${(if forwarded { "Forward()" } else { "Row" })}" + `;
            nil = row.Value == null && row.Optional == null && row.Code == 1;
        }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(Reads == 1 && ` + "${(if strict { "asserted && Probe.Calls == 1" } else { "!asserted && nil && Probe.Calls == 2" })}" + ` ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "Value MaybeBox,"
            } else {
                "Value MaybeBox?"
            },
            printed
        )
        Assert.Contains("Optional NullAcceptingBox?", printed)
        if forwarded {
            Assert.Contains(
                if strict {
                    "func Forward() (Value MaybeBox,"
                } else {
                    "func Forward() (Value MaybeBox?,"
                },
                printed
            )
        }
    }

    @Theory
    @InlineData("Task", false, false)
    @InlineData("Task", true, false)
    @InlineData("ValueTask", false, false)
    @InlineData("ValueTask", true, false)
    @InlineData("Task", false, true)
    @InlineData("Task", true, true)
    @InlineData("ValueTask", false, true)
    @InlineData("ValueTask", true, true)
    func TupleContractBoundary_SiblingSourceComponentsShareNativeLocks(
        envelope string,
        nativeLock bool,
        reverseOrder bool
    ) {
        let fixture = this.EmitFixture()
        let inherited = if nativeLock {
            "RowsBase$envelope, ISourceRows"
        } else {
            "ISourceRows"
        }
        let modifiers = if nativeLock {
            "public override async"
        } else {
            "public async"
        }
        // Issue #4772 tracks tuple-label metadata separately from the CLR leaf contract.
        let sources[]string = []string{(`using System.Threading.Tasks;
using Issue4719Fixture;
public interface ISourceRows {
    ` + "$envelope" + `<(NullableResultBox Required, int Code)> Read(string value);
}`), (`using System.Threading.Tasks;
using Issue4719Fixture;
public sealed class Locked : ` + "$inherited" + ` {
    ` + "$modifiers" + ` ` + "$envelope" + `<(NullableResultBox Required, int Code)> Read(string value) {
        await Task.Delay(1);
        return (value, 1);
    }
}`), (`using System;
using System.Threading.Tasks;
using Issue4719Fixture;
public sealed class Other : ISourceRows {
    public async ` + "$envelope" + `<(NullableResultBox Required, int Code)> Read(string value) {
        await Task.Delay(1);
        return (value, 1);
    }
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        ISourceRows locked = new Locked();
        ISourceRows other = new Other();
        bool valid = locked.Read("keep").GetAwaiter().GetResult().Item1 != null
            && other.Read("keep").GetAwaiter().GetResult().Item1 != null && Probe.Calls == 2;
        Probe.Reset();
        bool nil = false;
        bool asserted = false;
        try { nil = other.Read("miss").GetAwaiter().GetResult().Item1 == null; }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(valid && ` + "${(if nativeLock { "asserted" } else { "!asserted && nil" })}" + `
            && Probe.Calls == 1 ? 15 : -1);
    }
}`)}
        let printedProjects = this.AssertSplitProjectsVerifyAndRun(sources, fixture, reverseOrder)
        Assert.All(
            printedProjects,
            (printed string) -> Assert.Contains(
                if nativeLock {
                    "Required NullableResultBox,"
                } else {
                    "Required NullableResultBox?"
                },
                printed
            )
        )
    }

    @Theory
    @InlineData(false, false, false)
    @InlineData(true, false, false)
    @InlineData(false, true, false)
    @InlineData(true, true, false)
    @InlineData(false, false, true)
    @InlineData(true, false, true)
    @InlineData(false, true, true)
    @InlineData(true, true, true)
    func TupleContractSink_CheckedWholeTuplePreservesDestination(
        uncheckedWrapper bool,
        fixedDestination bool,
        nullableInput bool
    ) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static bool Missing;
    public static int Reads;
    public static int Decisions;
    #nullable enable
    public static string` + "${(if nullableInput { "?" } else { string.Empty })}" + ` Value {
        get {
            Reads++;
            return Missing ? ` + "${(if nullableInput { "null" } else { "\"miss\"" })}" + ` : "keep";
        }
    }
    #nullable disable
    public static bool Choose(bool choose) { Decisions++; return choose; }
    ` + "${(if fixedDestination { "#nullable enable" } else { string.Empty })}" + `
    public static (NullableResultBox Value, int Code) Row(bool choose) =>
        ` + "${(if uncheckedWrapper { "unchecked" } else { "checked" })}" + `(
            ((Choose(choose) ? Value : new NullableResultBox(), 1)));
    #nullable disable
    public static bool Check(bool choose, bool missing) {
        Missing = missing;
        Reads = Decisions = 0;
        Probe.Reset();
        bool asserted = false;
        bool absent = false;
        int code = 0;
        try { var row = Row(choose); absent = row.Value == null; code = row.Code; }
        catch (NullReferenceException) { asserted = true; }
        bool expectedAssertion = choose && missing
            && ` + "${(if fixedDestination || nullableInput { "true" } else { "false" })}" + `;
        return asserted == expectedAssertion
            && (asserted || (absent == (choose && missing) && code == 1))
            && Reads == (choose ? 1 : 0) && Decisions == 1
            && Probe.Calls == (choose && !(missing
                && ` + "${(if nullableInput { "true" } else { "false" })}" + `) ? 1 : 0);
    }
    public static void Main() {
        Console.WriteLine(Check(true, false) && Check(true, true)
            && Check(false, false) && Check(false, true) ? 15 : -1);
    }
}`), fixture)
        Assert.Contains(
            if fixedDestination {
                "Value NullableResultBox,"
            } else {
                "Value NullableResultBox?"
            },
            printed
        )
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData(false, false, false, false)
    @InlineData(true, false, false, false)
    @InlineData(false, true, false, false)
    @InlineData(true, true, false, false)
    @InlineData(false, false, true, false)
    @InlineData(true, false, true, false)
    @InlineData(false, true, true, false)
    @InlineData(true, true, true, false)
    @InlineData(false, false, false, true)
    @InlineData(true, false, false, true)
    func TupleContractConsumer_IntermediateResultUsesImmediateOperatorInput(
        switchArm bool,
        strictInput bool,
        generic bool,
        nested bool
    ) {
        let fixture = this.EmitFixture()
        let envelope = (
            if strictInput {
                "StrictConsumerEnvelope"
            } else {
                "ConsumerEnvelope"
            }
        ) +
            (
            if generic {
                "<string>"
            } else {
                string.Empty
            }
        )
        var branch = if switchArm {
            "Choose(choose) switch { true => Value, false => new NullableResultBox() }"
        } else {
            "Choose(choose) ? Value : new NullableResultBox()"
        }
        if generic {
            branch = "${(if switchArm { "checked" } else { "unchecked" })}(($branch))"
        }
        if nested {
            branch = "Nested ? ($branch) : ($envelope)new NullableResultBox()"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static bool Missing;
    public static bool Nested = true;
    public static int Reads;
    public static int Decisions;
    public static string Value { get { Reads++; return Missing ? "miss" : "keep"; } }
    public static bool Choose(bool choose) { Decisions++; return choose; }
    public static ` + "$envelope" + ` Make(bool choose) => ` + "$branch" + `;
    public static bool Check(bool choose, bool missing) {
        Missing = missing;
        Reads = Decisions = 0;
        Probe.Reset();
        bool asserted = false;
        bool observed = false;
        try { observed = Make(choose).Missing; }
        catch (NullReferenceException) { asserted = true; }
        bool expectedAssertion = ` + "${(if strictInput { "choose && missing" } else { "false" })}" + `;
        return asserted == expectedAssertion
            && (asserted || observed == (choose && missing))
            && Reads == (choose ? 1 : 0) && Decisions == 1
            && Probe.Calls == (asserted ? 1 : choose ? 2 : 1);
    }
    public static void Main() {
        Console.WriteLine(Check(true, false) && Check(true, true)
            && Check(false, false) && Check(false, true) ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractConsumer_FinalResultRetainsItsOwnFixedContract(switchArm bool) {
        let fixture = this.EmitFixture()
        let branch = if switchArm {
            "Choose(choose) switch { true => Value, false => new NullableResultBox() }"
        } else {
            "Choose(choose) ? Value : new NullableResultBox()"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static bool Missing;
    public static int Reads;
    public static int Decisions;
    public static string Value { get { Reads++; return Missing ? "miss" : "keep"; } }
    public static bool Choose(bool choose) { Decisions++; return choose; }
    #nullable enable
    public static NullableConsumerEnvelope Make(bool choose) => ` + "$branch" + `;
    #nullable disable
    public static bool Check(bool choose, bool missing) {
        Missing = missing;
        Reads = Decisions = 0;
        Probe.Reset();
        bool asserted = false;
        bool present = false;
        try { present = Make(choose) != null; }
        catch (NullReferenceException) { asserted = true; }
        return asserted == (choose && missing) && (asserted || present)
            && Reads == (choose ? 1 : 0) && Decisions == 1
            && Probe.Calls == (choose ? 2 : 1);
    }
    public static void Main() {
        Console.WriteLine(Check(true, false) && Check(true, true)
            && Check(false, false) && Check(false, true) ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    func TupleContractConsumer_UnrelatedGenericMembersDoNotShareFixedLocks(overload bool, fixedSeed bool) {
        let (printed, fixture) = this.TranslateUnrelatedGenericMemberContracts(
            nativeContract: false,
            overload,
            fixedSeed
        )
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    func TupleContractConsumer_NativeGenericDeclarationsKeepSeparateLockIdentity(overload bool, fixedSeed bool) {
        // Native open-generic tuple implementation matching is independently tracked in #4626.
        this.TranslateUnrelatedGenericMemberContracts(nativeContract: true, overload, fixedSeed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractConsumer_SiblingGenericMembersKeepSeparateLockIdentity(overload bool) {
        let fixture = this.EmitFixture()
        let optional = if overload {
            "Required"
        } else {
            "Optional"
        }
        let sources[]string = []string{(`#nullable enable
public interface IStrictRows<T> where T : class {
    (T Value, int Code) Required(T value);
}
#nullable disable
public sealed class Rows<T> : IStrictRows<T> where T : class {
    public (T Value, int Code) Required(T value) => (value, 1);
    public (T Value, int Code) ` + "$optional" + `(T value, bool missing) =>
        (missing ? null : value, 2);
}`), (`using System;
public static class Obj {
    public static void Main() {
        var rows = new Rows<string>();
        IStrictRows<string> strict = rows;
        Console.WriteLine(rows.` + "$optional" + `("keep", false).Item1 == "keep"
            && rows.` + "$optional" + `("keep", true).Item1 == null
            && strict.Required("keep").Item1 == "keep" ? 15 : -1);
    }
}`)}
        let printed = this.AssertSplitProjectsVerifyAndRun(sources, fixture, reverseOrder: false)
        Assert.Contains("$optional(value T, missing bool) (Value T?, Code int32)", printed[0])
        Assert.Contains("Required(value T) (Value T, Code int32)", printed[0])
    }

    private func TranslateUnrelatedGenericMemberContracts(nativeContract bool, overload bool, fixedSeed bool)(
        Printed string,
        Fixture string
    ) {
        let fixture = this.EmitFixture()
        let contract = if nativeContract {
            "IStrictGenericRows<T>"
        } else {
            "IStrictRows<T>"
        }
        let declaration = if nativeContract {
            string.Empty
        } else {
            `#nullable enable
public interface IStrictRows<T> where T : class {
    (T Value, int Code) Required(T value);
}
#nullable disable`
        }
        let optional = if overload {
            "Required"
        } else {
            "Optional"
        }
        let requiredValue = if fixedSeed {
            "TupleContractSources.Missing(value)"
        } else {
            "value"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
` + "$declaration" + `
public sealed class Rows<T> : ` + "$contract" + ` where T : class {
    public (T Value, int Code) Required(T value) => (` + "$requiredValue" + `, 1);
    public (T Value, int Code) ` + "$optional" + `(T value, bool missing) =>
        (missing ? null : value, 2);
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        var rows = new Rows<string>();
        bool optional = rows.` + "$optional" + `("keep", false).Value == "keep"
            && rows.` + "$optional" + `("keep", true).Value == null;
        bool asserted = false;
        bool required = false;
        try { required = ((` + "${contract.Replace("<T>", "<string>", StringComparison.Ordinal)}" + `)rows).Required("keep").Value == "keep"; }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(optional && asserted == ` + "${(if fixedSeed { "true" } else { "false" })}" + `
            && (asserted || required) && Probe.Calls == ` + "${(if fixedSeed { "1" } else { "0" })}" + ` ? 15 : -1);
    }
}`), fixture)
        Assert.Contains("$optional(value T, missing bool) (Value T?, Code int32)", printed)
        Assert.Contains("Required(value T) (Value T, Code int32)", printed)
        return (printed, fixture)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractConversion_NullableDestinationPreservesImplicitOperator(switchArm bool) {
        let fixture = this.EmitFixture()
        let branch = if switchArm {
            "Choose(choose) switch { true => Text, false => new NullAcceptingBox() }"
        } else {
            "Choose(choose) ? Text : new NullAcceptingBox()"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static bool Missing;
    public static int Reads;
    public static int Decisions;
    #nullable enable
    public static string? Text { get { Reads++; return Missing ? null : "keep"; } }
    #nullable disable
    public static bool Choose(bool choose) { Decisions++; return choose; }
    public static (NullAcceptingBox Value, int Code) Row(bool choose) => (` + "$branch" + `, 1);
    public static bool Check(bool choose, bool missing) {
        Missing = missing;
        Reads = Decisions = 0;
        Probe.Reset();
        var row = Row(choose);
        return (row.Value == null) == (choose && missing) && row.Code == 1
            && Reads == (choose ? 1 : 0) && Decisions == 1
            && Probe.Calls == (choose ? 1 : 0);
    }
    public static void Main() {
        Console.WriteLine(Check(true, false) && Check(true, true)
            && Check(false, false) && Check(false, true) ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Value NullAcceptingBox?", printed)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func TupleContractConversion_IndexerParametersPreserveInheritedContracts(baseClass bool, enabledCompilation bool) {
        let fixture = this.EmitFixture()
        let inherited = if baseClass {
            "TupleIndexerBase"
        } else {
            "ITupleIndexer"
        }
        let modifier = if baseClass {
            "override "
        } else {
            string.Empty
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
` + "${(if enabledCompilation { `#nullable enable
public sealed class AnnotationAnchor { public string Value = "keep"; }
#nullable disable` } else { string.Empty })}" + `
public sealed class Rows : ` + "$inherited" + ` {
    public ` + "$modifier" + `int this[(string Required, int Code) row] => row.Code;
}
public static class Obj {
    public static bool Missing;
    public static int Reads;
    #nullable enable
    public static string? Text { get { Reads++; return Missing ? null : "keep"; } }
    #nullable disable
    public static bool Check(bool missing, bool dispatch) {
        Missing = missing;
        Reads = 0;
        bool asserted = false;
        int code = 0;
        var rows = new Rows();
        try {
            code = dispatch ? ((` + "$inherited" + `)rows)[(Text, 1)]
                : rows[(Text, 1)];
        }
        catch (NullReferenceException) { asserted = true; }
        return Reads == 1 && asserted == missing && (missing || code == 1);
    }
    public static void Main() {
        Console.WriteLine(Check(false, false) && Check(true, false)
            && Check(false, true) && Check(true, true) ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("row (Required string, Code int32)", printed)
        Assert.DoesNotContain("row (Required string?", printed)
    }

    @Theory
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(false, false)
    @InlineData(true, true)
    func TupleContractConversion_PartialIndexerParametersPreserveBothDeclarations(
        strictDefinition bool,
        strictImplementation bool
    ) {
        let strict = strictDefinition || strictImplementation
        let project = CSharpProjectLoader.LoadInMemory([](string, string){("Rows.cs", (`public sealed partial class Rows {
    #nullable ` + "${(if strictDefinition { "enable" } else { "disable" })}" + `
    public partial int this[(string Required, string? Optional, int Code) row] { get; }
    #nullable ` + "${(if strictImplementation { "enable" } else { "disable" })}" + `
    public partial int this[(string Required, string? Optional, int Code) row] {
        get { return row.Code; }
    }
}`))}, CSharpProjectLoader.RuntimeReferences())
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let analyzer = Assert.IsAssignableFrom[Type](
            typeof(CSharpTypeMapper).Assembly.GetType("Cs2Gs.Translator.ObliviousNullabilityAnalyzer")
        )
        let method MethodInfo? = analyzer.GetMethod(
            "CanPromoteTuplePosition",
            BindingFlags.NonPublic | BindingFlags.Static,
            nil,
            []Type{typeof(Compilation), typeof(ISymbol), typeof(string)},
            nil
        )
        Assert.NotNull(method)
        let eligible = method!!.CreateDelegate[(Compilation, ISymbol, string) -> bool]()
        let document = Assert.Single(project.Documents)
        let indexers = document
            .SyntaxTree
            .GetRoot()
            .DescendantNodes()
            .OfType[IndexerDeclarationSyntax]()
            .Select(
            (node IndexerDeclarationSyntax) -> Assert.IsAssignableFrom[IPropertySymbol](
                document.SemanticModel.GetDeclaredSymbol(node)
            )
        )
            .ToArray()
        Assert.Equal(2, indexers.Length)
        Assert.NotNull(indexers[0].PartialImplementationPart)
        Assert.NotNull(indexers[1].PartialDefinitionPart)
        Assert.All(
            indexers,
            (indexer IPropertySymbol) -> Assert.Equal(
                !strict,
                eligible(project.Compilation, Assert.Single(indexer.Parameters), "0")
            )
        )
    }

    @Theory
    @InlineData("checked", false, false)
    @InlineData("checked", true, false)
    @InlineData("unchecked", false, false)
    @InlineData("unchecked", true, false)
    @InlineData("checked", false, true)
    @InlineData("checked", true, true)
    @InlineData("unchecked", false, true)
    @InlineData("unchecked", true, true)
    func TupleContractRemapping_CheckedBranchesPreserveConvertedNil(
        wrapper string,
        switchArm bool,
        explicitConversion bool
    ) {
        let fixture = this.EmitFixture()
        let converted = if explicitConversion {
            "(MaybeBox)Value"
        } else {
            "Value"
        }
        let branch = if switchArm {
            "Choose(choose) switch { true => $converted, false => new MaybeBox() }"
        } else {
            "Choose(choose) ? $converted : new MaybeBox()"
        }
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static int Reads;
    public static int Decisions;
    public static int Fallbacks;
    public static string Value { get { Reads++; return "x"; } }
    public static bool Choose(bool choose) { Decisions++; return choose; }
    public static MaybeBox Fallback() { Fallbacks++; return new MaybeBox(); }
    public static (MaybeBox Value, int Code) Row(bool choose) =>
        (` + "$wrapper" + `(` + "$branch" + `) ?? Fallback(), 1);
    public static bool Check(bool choose) {
        Probe.Reset();
        Reads = Decisions = Fallbacks = 0;
        var row = Row(choose);
        return row.Value != null && row.Code == 1 && Decisions == 1
            && Reads == (choose ? 1 : 0) && Probe.Calls == (choose ? 1 : 0)
            && Fallbacks == (choose ? 1 : 0);
    }
    public static void Main() { Console.WriteLine(Check(true) && Check(false) ? 15 : -1); }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Value MaybeBox,", printed)
    }

    @Theory
    @InlineData("checked", false)
    @InlineData("checked", true)
    @InlineData("unchecked", false)
    @InlineData("unchecked", true)
    func TupleContractRemapping_CheckedResultsKeepStrictOperatorInputs(wrapper string, strictInput bool) {
        let fixture = this.EmitFixture()
        let box = if strictInput {
            "MaybeStrictInputBox<string>"
        } else {
            "NullAcceptingBox"
        }
        let (printed, context) = TranslateWithContext((`#nullable enable
using System;
using Issue4719Fixture;
public static class Obj {
    public static int Reads;
    public static int Fallbacks;
    public static string? Value { get { Reads++; return null; } }
    public static ` + "$box" + ` Fallback() { Fallbacks++; return new ` + "$box" + `(); }
    public static (` + "$box" + ` Value, int Code) Row(bool choose) =>
        (` + "$wrapper" + `(choose ? Value : new ` + "$box" + `()) ?? Fallback(), 1);
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        bool present = false;
        try { present = Row(true).Value != null; }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(Reads == 1 && ` + "${(if strictInput { "asserted && Probe.Calls == 0 && Fallbacks == 0" } else { "!asserted && present && Probe.Calls == 1 && Fallbacks == 1" })}" + ` ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        let sites = context
            .Diagnostics
            .Where(
            (
                diagnostic TranslationDiagnostic
            ) -> diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
            .ToArray()
        if strictInput {
            Assert.Contains("parameter 'value'", Assert.Single(sites).Message)
        } else {
            Assert.Empty(sites)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func TupleContractRemapping_SiblingOverloadsKeepTheirOwnContract(genericOwner bool, reverseOrder bool) {
        let fixture = this.EmitFixture()
        let owner = if genericOwner {
            "Rows<T>"
        } else {
            "Rows"
        }
        let constraint = if genericOwner {
            "where T : class"
        } else {
            string.Empty
        }
        let constructed = if genericOwner {
            "Rows<string>"
        } else {
            "Rows"
        }
        let printed = this.AssertSplitProjectsVerifyAndRun([]string{(`using Issue4719Fixture;
public sealed class ` + "$owner" + ` : IOverloadedRows ` + "$constraint" + ` {
    public (NullableResultBox Required, int Code) Read(int value) =>
        (value == 0 ? "miss" : "keep", value);
    public (NullableResultBox Required, int Code) Read(string value) => (value, 1);
}`), (`using System;
using Issue4719Fixture;
public static class Obj {
    public static void Main() {
        var rows = new ` + "$constructed" + `();
        Probe.Reset();
        bool valid = rows.Read("keep").Item1 != null && Probe.Calls == 1;
        Probe.Reset();
        valid = valid && rows.Read("miss").Item1 == null && Probe.Calls == 1;
        Probe.Reset();
        IOverloadedRows native = rows;
        valid = valid && native.Read(1).Required != null && Probe.Calls == 1;
        Probe.Reset();
        bool asserted = false;
        try { native.Read(0); }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`)}, fixture, reverseOrder)
        Assert.Contains("func Read(value int32) (Required NullableResultBox,", printed[0])
        Assert.Contains("func Read(value string) (Required NullableResultBox?,", printed[0])
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractRemapping_UnrelatedAssemblyNamesDoNotShareLocks(reverseOrder bool) {
        let fixture = this.EmitFixture()
        let unrelated = CSharpProjectLoader.LoadInMemory([](string, string){("Rows.cs", `using Issue4719Fixture;
public sealed class Rows : IOverloadedRows, IStringRows {
    public (NullableResultBox Required, int Code) Read(int value) => ("keep", value);
    public (NullableResultBox Required, int Code) Read(string value) => ("keep", 1);
}`)}, CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]PortableExecutableReference{MetadataReference.CreateFromFile(fixture)})
                .ToArray(), "Unrelated" + Guid.NewGuid().ToString("N"))
        let current = CSharpProjectLoader.LoadInMemory([](string, string){("Rows.cs", `using System;
using Issue4719Fixture;
public sealed class Rows {
    public (NullableResultBox Required, int Code) Read(string value) => (value, 1);
}
public static class Obj {
    public static void Main() {
        Probe.Reset();
        var row = new Rows().Read("miss");
        Console.WriteLine(row.Required == null && row.Code == 1 && Probe.Calls == 1 ? 15 : -1);
    }
}`)}, CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]PortableExecutableReference{MetadataReference.CreateFromFile(fixture)})
                .ToArray(), "Current" + Guid.NewGuid().ToString("N"))
        Assert.True(unrelated.BoundWithoutErrors, string.Join(Environment.NewLine, unrelated.ErrorDiagnostics))
        Assert.True(current.BoundWithoutErrors, string.Join(Environment.NewLine, current.ErrorDiagnostics))
        let siblings = []CSharpCompilation{current.Compilation, unrelated.Compilation}
        if reverseOrder {
            Array.Reverse(siblings)
        }
        let document = Assert.Single(current.Documents)
        let context = TranslationContext(current.Compilation, document.SemanticModel, document.FilePath, siblings)
        let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("Required NullableResultBox?", printed)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractRemapping_LocalClosureQueriesStayBounded(registerCurrent bool) {
        const count = 1600
        let implementations = string.Join(
            Environment.NewLine,
            Enumerable.Range(0, count).Select(
                (
                    index int32
                ) -> "public sealed class Rows$index : IRows { public (string Value,int Code) Read() => (null,1); }"
            )
        )
        let project = CSharpProjectLoader.LoadInMemory(
            [](string, string){
                ("Rows.cs", "public interface IRows { (string Value,int Code) Read(); }\n" + implementations)
            },
            CSharpProjectLoader.RuntimeReferences(),
            "Local" + Guid.NewGuid().ToString("N")
        )
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let analyzer = Assert.IsAssignableFrom[Type](
            typeof(CSharpTypeMapper).Assembly.GetType("Cs2Gs.Translator.ObliviousNullabilityAnalyzer")
        )
        let method MethodInfo? = analyzer.GetMethod(
            "IsTupleElementTainted",
            []Type{
                typeof(CSharpCompilation),
                typeof(ISymbol),
                typeof(IReadOnlyList[int32]),
                typeof(IReadOnlyList[CSharpCompilation])
            }
        )
        Assert.NotNull(method)
        let query = cast[Issue4719CastNullTupleLeafTests_TupleElementTaintQuery](
            method!!.CreateDelegate(typeof(Issue4719CastNullTupleLeafTests_TupleElementTaintQuery))
        )
        let siblings IReadOnlyList[CSharpCompilation]? = if registerCurrent {
            []CSharpCompilation{project.Compilation}
        } else {
            default([]?CSharpCompilation)
        }
        let path[]int32 = []int32{0}
        let contract = Assert.Single(project.Compilation.GetTypeByMetadataName("IRows")!!.GetMembers("Read"))
        Assert.True(query(project.Compilation, contract, path, siblings))
        let symbols = Enumerable
            .Range(0, count)
            .Select(
            (index int32) -> Assert.Single(
                project.Compilation.GetTypeByMetadataName("Rows" + index.ToString())!!.GetMembers("Read")
            )
        )
            .ToArray()
        let elapsed = Stopwatch.StartNew()
        for symbol in symbols {
            Assert.True(query(project.Compilation, symbol, path, siblings))
            Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(10), "Cached local queries took ${elapsed.Elapsed}.")
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(true, false)
    @InlineData(false, true)
    @InlineData(true, true)
    func TupleContractRemapping_ConstructedSignaturesRetainActualArguments(genericMethod bool, targetSource bool) {
        let source = CSharpProjectLoader.LoadInMemory([](string, string){("Rows.cs", `public sealed class Rows<T> {
    public (T Value,int Code) Read(int value) => (default,1);
    public (T Value,int Code) Read(string value) => (default,1);
    public (U Value,int Code) Read<U>(U value) => (value,1);
}`)}, CSharpProjectLoader.RuntimeReferences(), "Owner" + Guid.NewGuid().ToString("N"))
        Assert.True(source.BoundWithoutErrors, string.Join(Environment.NewLine, source.ErrorDiagnostics))
        Directory.CreateDirectory(this.fixtureDirectory)
        let assembly = Path.Combine(this.fixtureDirectory, source.Compilation.AssemblyName + ".dll")
        let emitted = source.Compilation.Emit(assembly)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let consumer = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Consumer.cs", "public sealed class Consumer { }")},
            CSharpProjectLoader
                .RuntimeReferences()
                .Concat([]PortableExecutableReference{MetadataReference.CreateFromFile(assembly)})
                .ToArray(),
            "Consumer" + Guid.NewGuid().ToString("N")
        )
        Assert.True(consumer.BoundWithoutErrors, string.Join(Environment.NewLine, consumer.ErrorDiagnostics))
        let text ITypeSymbol = source.Compilation.GetSpecialType(SpecialType.System_String)
        let owner = source.Compilation.GetTypeByMetadataName("Rows`1")!!.Construct(text)
        var input = owner
            .GetMembers("Read")
            .OfType[IMethodSymbol]()
            .Single(
            (method IMethodSymbol) -> if genericMethod {
                method.Arity == 1
            } else {
                method.Arity == 0 && method.Parameters[0].Type.SpecialType == SpecialType.System_Int32
            }
        )
        if genericMethod {
            input = input.Construct(text)
        }
        let analyzer = Assert.IsAssignableFrom[Type](
            typeof(CSharpTypeMapper).Assembly.GetType("Cs2Gs.Translator.ObliviousNullabilityAnalyzer")
        )
        let remapper MethodInfo? = analyzer.GetMethod(
            "RemapToCompilation",
            BindingFlags.NonPublic | BindingFlags.Static
        )
        Assert.NotNull(remapper)
        let output = Assert.IsAssignableFrom[IMethodSymbol](
            remapper!!.Invoke(
                nil,
                []object{
                    (
                        if targetSource {
                            source.Compilation
                        } else {
                            consumer.Compilation
                        }
                    ),
                    input
                }
            )
        )
        Assert.Equal(source.Compilation.Assembly.Identity, output.ContainingAssembly.Identity)
        Assert.Equal(SpecialType.System_String, Assert.Single(output.ContainingType.TypeArguments).SpecialType)
        Assert.Equal(
            if genericMethod {
                SpecialType.System_String
            } else {
                SpecialType.System_Int32
            },
            output.Parameters[0].Type.SpecialType
        )
        Assert.Equal(
            SpecialType.System_String,
            Assert.IsAssignableFrom[INamedTypeSymbol](output.ReturnType).TupleElements[0].Type.SpecialType
        )
        if genericMethod {
            Assert.Equal(SpecialType.System_String, Assert.Single(output.TypeArguments).SpecialType)
        }
    }

    @Theory
    @InlineData("(object)(Choose(choose) ? Value : new MaybeBox())")
    @InlineData("(object)(MaybeBox)(Choose(choose) ? Value : new MaybeBox())")
    @InlineData("(object)checked((MaybeBox)(Choose(choose) ? Value : new MaybeBox()))")
    @InlineData("(object)(Choose(choose) switch { true => Value, false => new MaybeBox() })")
    func TupleContractRemapping_ReferenceCastsPreserveCoalescingNil(converted string) {
        let fixture = this.EmitFixture()
        let printed = Translate((`using System;
using Issue4719Fixture;
public static class Obj {
    public static int Reads;
    public static int Decisions;
    public static int Fallbacks;
    public static string Value { get { Reads++; return "x"; } }
    public static bool Choose(bool choose) { Decisions++; return choose; }
    public static object Fallback() { Fallbacks++; return new object(); }
    public static (object Value, int Code) Row(bool choose) =>
        (` + "$converted" + ` ?? Fallback(), 1);
    public static bool Check(bool choose) {
        Probe.Reset();
        Reads = Decisions = Fallbacks = 0;
        var row = Row(choose);
        return row.Value != null && row.Code == 1 && Decisions == 1
            && Reads == (choose ? 1 : 0) && Probe.Calls == (choose ? 1 : 0)
            && Fallbacks == (choose ? 1 : 0);
    }
    public static void Main() { Console.WriteLine(Check(true) && Check(false) ? 15 : -1); }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractRemapping_ReferenceCastsKeepStrictOperatorInputs(strictInput bool) {
        let fixture = this.EmitFixture()
        let box = if strictInput {
            "MaybeStrictInputBox<string>"
        } else {
            "NullAcceptingBox"
        }
        let (printed, context) = TranslateWithContext((`#nullable enable
using System;
using Issue4719Fixture;
public static class Obj {
    public static int Reads;
    public static int Fallbacks;
    public static string? Value { get { Reads++; return null; } }
    public static object Fallback() { Fallbacks++; return new object(); }
    public static (object Value, int Code) Row(bool choose) =>
        ((object)(choose ? Value : new ` + "$box" + `()) ?? Fallback(), 1);
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        bool present = false;
        try { present = Row(true).Value != null; }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(Reads == 1 && ` + "${(if strictInput { "asserted && Probe.Calls == 0 && Fallbacks == 0" } else { "!asserted && present && Probe.Calls == 1 && Fallbacks == 1" })}" + ` ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        let sites = context
            .Diagnostics
            .Where(
            (site TranslationDiagnostic) -> site.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
        )
            .ToArray()
        if strictInput {
            let input = Assert.Single(sites)
            Assert.Contains("parameter 'value'", input.Message)
            Assert.Equal("Value", input.Location!!.SourceTree!!.GetText().ToString(input.Location!!.SourceSpan))
        } else {
            Assert.Empty(sites)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractRemapping_ReferenceCastsStopAtConversionConsumers(unboxing bool) {
        let fixture = this.EmitFixture()
        let result = if unboxing {
            "(int)(object)(choose ? \"miss\" : new NullableResultBox())"
        } else {
            "((StrictConsumerEnvelope)(choose ? \"miss\" : new NullableResultBox())) ?? (StrictConsumerEnvelope)new NullableResultBox()"
        }
        let (printed, context) = TranslateWithContext((`using System;
using Issue4719Fixture;
public static class Obj {
    public static void Main() {
        Probe.Reset();
        bool asserted = false;
        bool choose = true;
        try { var converted = ` + "$result" + `; }
        catch (NullReferenceException) { asserted = true; }
        Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("NullableResultBox?(\"miss\")!!", printed)
        Assert.DoesNotContain(
            context.Diagnostics,
            (site TranslationDiagnostic) -> site.Severity == TranslationSeverity.Unsupported
        )
        if !unboxing {
            Assert.DoesNotContain(
                context.Diagnostics,
                (
                    site TranslationDiagnostic
                ) -> site.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            )
        } else {
            let resultSite = Assert.Single(
                context.Diagnostics,
                (
                    site TranslationDiagnostic
                ) -> site.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId
            )
            Assert.Equal(
                "\"miss\"",
                resultSite.Location!!.SourceTree!!.GetText().ToString(resultSite.Location!!.SourceSpan)
            )
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractRemapping_MixedConstructedAnnotationsKeepSeparateLocks(matchingContract bool) {
        let fixture = this.EmitFixture()
        let (printed, context) = TranslateWithContext((`using System;
using Issue4719Fixture;
#nullable enable
public sealed class FixedRows : IWholeRows<(MaybeBox Value, int Code)> {
    #nullable disable
    public (MaybeBox Value, int Code) Read(string value) => (value, 1);
}
#nullable ` + "${(if matchingContract { "enable" } else { "disable" })}" + `
public sealed class OtherRows : IWholeRows<(MaybeBox Value, int Code)> {
    #nullable disable
    public (MaybeBox Value, int Code) Read(string value) => (value, 1);
}
public static class Obj {
    public static bool Check(string value) {
        Probe.Reset();
        bool asserted = false;
        bool nil = false;
        try { var row = new OtherRows().Read(value); nil = row.Value == null && row.Code == 1; }
        catch (NullReferenceException) { asserted = true; }
        return Probe.Calls == 1 && ` + "${(if matchingContract { "asserted && !nil" } else { "!asserted && nil" })}" + `;
    }
    public static void Main() { Console.WriteLine(Check("miss") && Check("keep") ? 15 : -1); }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        let other = Assert.Single(context.Compilation.GetTypeByMetadataName("OtherRows")!!.GetMembers("Read"))
        Assert.Equal(
            !matchingContract,
            ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                context.Compilation,
                other,
                []int32{0},
                context.SiblingCompilations
            )
        )
    }

    @Theory
    @InlineData("string")
    @InlineData("string?")
    @InlineData("(string Value, int Code)")
    @InlineData("(string? Value, int Code)")
    @InlineData("System.Collections.Generic.List<string?>")
    @InlineData("string?[]")
    func TupleContractRemapping_ConstructedTypeArgumentsRetainNestedAnnotations(argument string) {
        let source = CSharpProjectLoader.LoadInMemory([](string, string){("Rows.cs", (`#nullable enable
public sealed class Rows<T> { public T Read() => default!; }
public sealed class Consumer { public Rows<` + "$argument" + `> Value; }`))}, CSharpProjectLoader.RuntimeReferences(), "Annotations" +
                Guid
                .NewGuid().ToString("N"))
        Assert.True(source.BoundWithoutErrors, string.Join(Environment.NewLine, source.ErrorDiagnostics))
        Directory.CreateDirectory(this.fixtureDirectory)
        let assembly = Path.Combine(this.fixtureDirectory, source.Compilation.AssemblyName + ".dll")
        let emitted = source.Compilation.Emit(assembly)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        let target = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Other.cs", "public sealed class Other { }")},
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(assembly)).ToArray()
        )
        let field = Assert.Single(
            source.Compilation.GetTypeByMetadataName("Consumer")!!.GetMembers("Value").OfType[IFieldSymbol]()
        )
        let input = Assert.IsAssignableFrom[INamedTypeSymbol](field.Type)
        let analyzer Type? = typeof(CSharpTypeMapper).Assembly.GetType("Cs2Gs.Translator.ObliviousNullabilityAnalyzer")
        let remapper MethodInfo? = analyzer!!.GetMethod(
            "RemapToCompilation",
            BindingFlags.NonPublic | BindingFlags.Static
        )
        let output = Assert.IsAssignableFrom[INamedTypeSymbol](
            remapper!!.Invoke(nil, []object{target.Compilation, input})
        )
        AssertAnnotations(input, output)
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func TupleContractRemapping_SiblingConstructedAnnotationsKeepSeparateLocks(
        matchingContract bool,
        reverseOrder bool
    ) {
        let fixture = this.EmitFixture()
        this.AssertSplitProjectsVerifyAndRun([]string{`using Issue4719Fixture;
#nullable enable
public sealed class FixedRows : IWholeRows<(MaybeBox Value, int Code)> {
    #nullable disable
    public (MaybeBox Value, int Code) Read(string value) => (value, 1);
}`, (`using System;
using Issue4719Fixture;
#nullable ` + "${(if matchingContract { "enable" } else { "disable" })}" + `
public sealed class OtherRows : IWholeRows<(MaybeBox Value, int Code)> {
    #nullable disable
    public (MaybeBox Value, int Code) Read(string value) => (value, 1);
}
public static class Obj {
    public static bool Check(string value) {
        Probe.Reset();
        bool asserted = false;
        bool nil = false;
        try { var row = new OtherRows().Read(value); nil = row.Value == null && row.Code == 1; }
        catch (NullReferenceException) { asserted = true; }
        return Probe.Calls == 1 && ` + "${(if matchingContract { "asserted && !nil" } else { "!asserted && nil" })}" + `;
    }
    public static void Main() { Console.WriteLine(Check("miss") && Check("keep") ? 15 : -1); }
}`)}, fixture, reverseOrder)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func TupleContractRemapping_NestedOwnersAndMethodArgumentsRetainAnnotations(genericMethod bool) {
        let source = CSharpProjectLoader.LoadInMemory([](string, string){("Rows.cs", `#nullable enable
public sealed class Outer<T> {
    public sealed class Rows<U> {
        public U Read() => default!;
        public V Read<V>(V value) => value;
    }
}
public sealed class Consumer { public Outer<string?>.Rows<object?> Value; }`)}, CSharpProjectLoader.RuntimeReferences(), "Nested" +
                Guid
                .NewGuid().ToString("N"))
        Assert.True(source.BoundWithoutErrors, string.Join(Environment.NewLine, source.ErrorDiagnostics))
        Directory.CreateDirectory(this.fixtureDirectory)
        let assembly = Path.Combine(this.fixtureDirectory, source.Compilation.AssemblyName + ".dll")
        Assert.True(source.Compilation.Emit(assembly).Success)
        let target = CSharpProjectLoader.LoadInMemory(
            [](string, string){("Other.cs", "public sealed class Other { }")},
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(assembly)).ToArray()
        )
        let field = Assert.Single(
            source.Compilation.GetTypeByMetadataName("Consumer")!!.GetMembers("Value").OfType[IFieldSymbol]()
        )
        let owner = Assert.IsAssignableFrom[INamedTypeSymbol](field.Type)
        var input = owner
            .GetMembers("Read")
            .OfType[IMethodSymbol]()
            .Single(
            (method IMethodSymbol) -> method.Arity == (
                if genericMethod {
                    1
                } else {
                    0
                }
            )
        )
        if genericMethod {
            input = input.Construct(
                source
                    .Compilation
                    .GetSpecialType(SpecialType.System_String)
                    .WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            )
        }
        let analyzer Type? = typeof(CSharpTypeMapper).Assembly.GetType("Cs2Gs.Translator.ObliviousNullabilityAnalyzer")
        let remapper MethodInfo? = analyzer!!.GetMethod(
            "RemapToCompilation",
            BindingFlags.NonPublic | BindingFlags.Static
        )
        let output = Assert.IsAssignableFrom[IMethodSymbol](remapper!!.Invoke(nil, []object{target.Compilation, input}))
        AssertAnnotations(input.ContainingType, output.ContainingType)
        AssertAnnotations(input.ReturnType, output.ReturnType)
        if genericMethod {
            AssertAnnotations(Assert.Single(input.TypeArguments), Assert.Single(output.TypeArguments))
        }
    }

    private func AssertSplitProjectsVerifyAndRun(sources[]string, fixture string, reverseOrder bool)[]string {
        Directory.CreateDirectory(Path.Combine(this.fixtureDirectory, "csharp"))
        let projects = [sources.Length]LoadedCSharpProject
        let sourceReferences = []PortableExecutableReference{MetadataReference.CreateFromFile(fixture)}
            .Cast[MetadataReference]().ToList()
        for var i = 0; i < sources.Length; i++ {
            let name = "Sibling" + i.ToString() + Guid.NewGuid().ToString("N")
            projects[i] = CSharpProjectLoader.LoadInMemory(
                [](string, string){(name + ".cs", sources[i])},
                CSharpProjectLoader.RuntimeReferences().Concat(sourceReferences).ToArray(),
                name
            )
            Assert.True(projects[i].BoundWithoutErrors, string.Join(Environment.NewLine, projects[i].ErrorDiagnostics))
            let assembly = Path.Combine(this.fixtureDirectory, "csharp", name + ".dll")
            let emitted = projects[i].Compilation.Emit(assembly)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            sourceReferences.Add(MetadataReference.CreateFromFile(assembly))
        }
        let siblings = projects.Select((project LoadedCSharpProject) -> project.Compilation).ToArray()
        if reverseOrder {
            Array.Reverse(siblings)
        }
        let compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
        let translatedReferences = []string{fixture}.ToList()
        let printedProjects = [projects.Length]string
        for var i = 0; i < projects.Length; i++ {
            let document = Assert.Single(projects[i].Documents)
            let context = TranslationContext(
                projects[i].Compilation,
                document.SemanticModel,
                document.FilePath,
                siblings
            )
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            printedProjects[i] = printed
            let assembly = Path.Combine(this.fixtureDirectory, projects[i].Compilation.AssemblyName + ".dll")
            let source = Path.ChangeExtension(assembly, ".gs")
            File.WriteAllText(source, printed)
            let arguments = []string{
                compiler,
                if i == projects.Length - 1 {
                    "/target:exe"
                } else {
                    "/target:library"
                },
                "/targetframework:net10.0",
                "/assemblyname:${projects[i].Compilation.AssemblyName}",
                "/out:$assembly",
                source
            }
                .Concat(translatedReferences.Select((reference string) -> ("/reference:" + reference))).ToArray()
            let compiled = RunDotnet(arguments)
            Assert.True(compiled.Exit == 0, printed + Environment.NewLine + compiled.Output)
            Assert.True(IlVerifyRunner.IsEnabled)
            let verified = IlVerifyRunner().Verify(assembly, translatedReferences)
            Assert.True(verified.Status == IlVerifyStatus.Passed, verified.Output)
            Assert.Empty(verified.Errors)
            translatedReferences.Add(assembly)
        }
        let program = translatedReferences.Last()
        File.WriteAllText(
            Path.ChangeExtension(program, ".runtimeconfig.json"),
            "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"10.0.0\"}}}"
        )
        let executed = RunDotnet(program)
        Assert.True(executed.Exit == 0, executed.Output)
        Assert.True(
            executed.Output == "15" + Environment.NewLine,
            string.Join(Environment.NewLine, printedProjects) + Environment.NewLine + executed.Output
        )
        return printedProjects
    }

    func Dispose() {
        try {
            if Directory.Exists(this.fixtureDirectory) {
                Directory.Delete(this.fixtureDirectory, recursive: true)
            }
        } catch (IOException) {
            // A collectible oracle assembly can still hold the fixture on Windows.

        } catch (UnauthorizedAccessException) {
            // Best-effort cleanup, as above.

        }
    }

    private func AssertRealDriverVerifiesAndRuns(printed string, fixture string, expected string) {
        using let resolver = ReferenceResolver.WithReferences([]string{fixture})
        TranslationTestValidation.AssertBinds(resolver, printed)
        let source = Path.Combine(this.fixtureDirectory, "Boundaries.gs")
        let assembly = Path.Combine(this.fixtureDirectory, "Boundaries.dll")
        let compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"))
        File.WriteAllText(source, printed)
        let compiled = RunDotnet(
            compiler,
            "/target:exe",
            "/targetframework:net10.0",
            "/reference:$fixture",
            "/out:$assembly",
            source
        )
        Assert.True(compiled.Exit == 0, printed + Environment.NewLine + compiled.Output)
        Assert.True(IlVerifyRunner.IsEnabled)
        let verified = IlVerifyRunner().Verify(assembly, []string{fixture})
        Assert.Equal(IlVerifyStatus.Passed, verified.Status)
        Assert.Empty(verified.Errors)
        File.WriteAllText(
            Path.ChangeExtension(assembly, ".runtimeconfig.json"),
            "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"10.0.0\"}}}"
        )
        let executed = RunDotnet(assembly)
        Assert.True(executed.Exit == 0, printed + Environment.NewLine + executed.Output)
        Assert.True(executed.Output == expected + Environment.NewLine, printed + Environment.NewLine + executed.Output)
    }

    @Theory
    @InlineData("interface", false, false)
    @InlineData("interface", true, false)
    @InlineData("base", true, false)
    @InlineData("shared", false, false)
    @InlineData("shared", true, false)
    @InlineData("interface", false, true)
    @InlineData("interface", true, true)
    @InlineData("base", true, true)
    @InlineData("shared", false, true)
    @InlineData("shared", true, true)
    func TupleContractImport_PlatformEndpointsDoNotFreezeSourceComponents(
        contract string,
        strict bool,
        strictInput bool
    ) {
        let fixture = this.EmitFixture()
        let native = if strict {
            "IStrictRows"
        } else {
            "IObliviousRows"
        }
        let inherited = if contract == "base" {
            (
                if strict {
                    "StrictRowsBase"
                } else {
                    "ObliviousRowsBase"
                }
            )
        } else {
            (
                if contract == "shared" {
                    "ISourceRows"
                } else {
                    native
                }
            )
        }
        let sourceContract = if contract == "shared" {
            (`public interface ISourceRows {
    (NullableResultBox Value, int Code) Read(bool choose);
}
public sealed class NativeAnchor : ` + "$native" + `, ISourceRows {
    public (NullableResultBox Value, int Code) Read(bool choose) =>
        (new NullableResultBox(), 1);
}`)
        } else {
            string.Empty
        }
        let (printed, context) = TranslateWithContext((`using System;
using Issue4719Fixture;
` + "$sourceContract" + `
public sealed class Rows : ` + "$inherited" + ` {
    public static int Reads;
    public static int Decisions;
    public static bool Missing;
    public static bool NullInput;
    public static bool Choose(bool choose) { Decisions++; return choose; }
    #nullable ` + "${(if strictInput { "enable" } else { "disable" })}" + `
    public static string` + "${(if strictInput { "?" } else { string.Empty })}" + ` Input {
        get { Reads++; return ` + "${(if strictInput { "NullInput ? null :" } else { string.Empty })}" + ` Missing ? "miss" : "keep"; }
    }
    #nullable disable
    public ` + "${(if contract == "base" { "override " } else { string.Empty })}" + `(NullableResultBox Value, int Code) Read(bool choose) =>
        (Choose(choose) ? Input : new NullableResultBox(), 1);
}
public static class Obj {
    public static bool Check(bool choose, bool missing, bool nullInput) {
        Probe.Reset();
        Rows.Reads = Rows.Decisions = 0;
        Rows.Missing = missing;
        Rows.NullInput = nullInput;
        ` + "$inherited" + ` rows = new Rows();
        bool nil = false;
        bool asserted = false;
        try {
            var row = rows.Read(choose);
            nil = row.Value == null;
            if (row.Code != 1) { return false; }
        }
        catch (NullReferenceException) { asserted = true; }
        bool rejectedInput = choose && nullInput && ` + "${(if strictInput { "true" } else { "false" })}" + `;
        bool expectedAssertion = rejectedInput || choose && missing && ` + "${(if strict { "true" } else { "false" })}" + `;
        return asserted == expectedAssertion && (asserted || nil == (choose && missing))
            && Rows.Decisions == 1 && Rows.Reads == (choose ? 1 : 0)
            && Probe.Calls == (choose && !rejectedInput ? 1 : 0);
    }
    public static void Main() {
        bool valid = Check(false, false, false) && Check(true, false, false)
            && Check(false, true, false) && Check(true, true, false)
            && Check(false, true, true) && Check(true, true, true);
        Console.WriteLine(valid ? 15 : -1);
    }
}`), fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains(
            if strict {
                "Value NullableResultBox,"
            } else {
                "Value NullableResultBox?"
            },
            printed
        )
        let nativeType = Assert.IsAssignableFrom[INamedTypeSymbol](
            context.Compilation.GetTypeByMetadataName("Issue4719Fixture." + native)
        )
        let method = Assert.Single(nativeType.GetMembers("Read").OfType[IMethodSymbol]())
        let tuple = Assert.IsAssignableFrom[INamedTypeSymbol](method.ReturnType)
        Assert.Equal(
            if strict {
                Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated
            } else {
                Microsoft.CodeAnalysis.NullableAnnotation.None
            },
            tuple.TupleElements[0].Type.NullableAnnotation
        )
        Assert.False(
            ObliviousNullabilityAnalyzer.IsTupleElementTainted(
                context.Compilation,
                method,
                []int32{0},
                context.SiblingCompilations
            )
        )
    }

    @Fact
    func TupleContractImport_OpenSlotsKeepReferenceValueAndUnconstrainedContracts() {
        let fixture = this.EmitFixture()
        let (printed, context) = TranslateWithContext(`using System;
using Issue4719Fixture;
public static class Scope<T> {
    public static T Read() => NativeNullableSlots.Row<T>(default(T)).Item1;
}
public static class Obj {
    public static void Main() {
        var reference = NativeNullableSlots.Row<NullableResultBox>(new NullableResultBox());
        var value = NativeNullableSlots.Row<int>(7);
        object scopedReference = Scope<NullableResultBox>.Read();
        Console.WriteLine(reference.Item1 == null && reference.Item2 == 1
            && value.Item1 == 0 && value.Item2 == 1 && Scope<int>.Read() == 0
            && scopedReference == null ? 15 : -1);
    }
}`, fixture)
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15")
        Assert.Contains("func Read() T", printed)
        Assert.DoesNotContain("func Read() T?", printed)
        let nativeType = Assert.IsAssignableFrom[INamedTypeSymbol](
            context.Compilation.GetTypeByMetadataName("Issue4719Fixture.NativeNullableSlots")
        )
        let method = Assert.Single(nativeType.GetMembers("Row").OfType[IMethodSymbol]())
        let tuple = Assert.IsAssignableFrom[INamedTypeSymbol](method.ReturnType)
        let slot = Assert.IsAssignableFrom[ITypeParameterSymbol](tuple.TupleElements[0].Type)
        Assert.Equal(Microsoft.CodeAnalysis.NullableAnnotation.Annotated, slot.NullableAnnotation)
        Assert.False(slot.IsReferenceType)
    }

    private func EmitFixture() string {
        Directory.CreateDirectory(this.fixtureDirectory)
        let assemblyName = "Issue4719Fixture" + Guid.NewGuid().ToString("N")
        let path = Path.Combine(this.fixtureDirectory, assemblyName + ".dll")
        let fixture = CSharpProjectLoader.LoadInMemory([](string, string){("Fixture.cs", `namespace Issue4719Fixture {
    public sealed class Box {
        public static explicit operator Box(string text) => new Box();
        public static implicit operator Box(int? value) { Probe.Calls++; return new Box(); }
    }
    public sealed class ReferenceBox {
        public static implicit operator ReferenceBox(string value) { Probe.Calls++; return new ReferenceBox(); }
    }
#nullable enable
    public sealed class MaybeBox {
        public static implicit operator MaybeBox?(string value) { Probe.Calls++; return null; }
    }
    public class ReferenceBase { }
    public sealed class DerivedReference : ReferenceBase { }
    public sealed class ReferenceInput {
        public ReferenceInput(bool missing) { this.Missing = missing; }
        public bool Missing { get; }
        public static implicit operator DerivedReference?(ReferenceInput value) {
            Probe.Calls++;
            return value.Missing ? null : new DerivedReference();
        }
    }
    public sealed class NullableResultBox {
        public static implicit operator NullableResultBox?(string value) {
            Probe.Calls++;
            return value == "keep" ? new NullableResultBox() : null;
        }
    }
    public sealed class NullAcceptingBox {
        public static implicit operator NullAcceptingBox?(string? value) {
            Probe.Calls++;
            return value == null ? null : new NullAcceptingBox();
        }
    }
    public sealed class CastInputBox {
        public static explicit operator CastInputBox?(string? value) {
            Probe.Calls++;
            return value == null ? null : new CastInputBox();
        }
    }
    public sealed class CastOutputBox {
        public static implicit operator CastOutputBox?(CastInputBox value) {
            Probe.Calls++;
            return new CastOutputBox();
        }
    }
    public sealed class ConsumerEnvelope {
        private ConsumerEnvelope(bool missing) { this.Missing = missing; }
        public bool Missing { get; }
        public static implicit operator ConsumerEnvelope(NullableResultBox? value) {
            Probe.Calls++;
            return new ConsumerEnvelope(value == null);
        }
    }
    public sealed class ConsumerEnvelope<T> {
        private ConsumerEnvelope(bool missing) { this.Missing = missing; }
        public bool Missing { get; }
        public static implicit operator ConsumerEnvelope<T>(NullableResultBox? value) {
            Probe.Calls++;
            return new ConsumerEnvelope<T>(value == null);
        }
    }
    public sealed class StrictConsumerEnvelope {
        private StrictConsumerEnvelope(bool missing) { this.Missing = missing; }
        public bool Missing { get; }
        public static implicit operator StrictConsumerEnvelope(NullableResultBox value) {
            Probe.Calls++;
            return new StrictConsumerEnvelope(value == null);
        }
    }
    public sealed class StrictConsumerEnvelope<T> {
        private StrictConsumerEnvelope(bool missing) { this.Missing = missing; }
        public bool Missing { get; }
        public static implicit operator StrictConsumerEnvelope<T>(NullableResultBox value) {
            Probe.Calls++;
            return new StrictConsumerEnvelope<T>(value == null);
        }
    }
    public sealed class NullableConsumerEnvelope {
        public static implicit operator NullableConsumerEnvelope?(NullableResultBox? value) {
            Probe.Calls++;
            return value == null ? null : new NullableConsumerEnvelope();
        }
    }
    public interface IStrictGenericRows<T> where T : class {
        (T Value, int Code) Required(T value);
    }
    public interface IStrictRows {
        (NullableResultBox Value, int Code) Read(bool choose);
    }
    public abstract class StrictRowsBase {
        public abstract (NullableResultBox Value, int Code) Read(bool choose);
    }
    public static class NativeNullableSlots {
        public static (T? Value, int Code) Row<T>(T value) => (default(T), 1);
    }
    public static class TupleContractSources {
        public static T? Missing<T>(T value) where T : class {
            Probe.Calls++;
            return null;
        }
    }
    public sealed class StrictInputBox<T> where T : class {
        public static implicit operator StrictInputBox<T>(T value) {
            Probe.Calls++;
            return new StrictInputBox<T>();
        }
    }
    public sealed class StrictReferenceBox {
        public static implicit operator StrictReferenceBox(string value) {
            Probe.Calls++;
            return new StrictReferenceBox();
        }
    }
    public sealed class MaybeStrictInputBox<T> where T : class {
        public static implicit operator MaybeStrictInputBox<T>?(T value) {
            Probe.Calls++;
            return new MaybeStrictInputBox<T>();
        }
    }
    public sealed class NullAcceptingInputBox<T> where T : class {
        public static implicit operator NullAcceptingInputBox<T>(T? value) {
            Probe.Calls++;
            return new NullAcceptingInputBox<T>();
        }
    }
    public static class FrozenTupleContract {
        public static int Accept((MaybeBox Value, int Code) row) => row.Code;
    }
    public static class NativeTupleSlots {
        public static (NullableResultBox Required, int Code) Field;
        public static (NullableResultBox Required, int Code) Property { get; set; }
        public static int Accept((NullableResultBox Required, int Code) row) => row.Code;
        public delegate (NullableResultBox Required, int Code) Factory(string value);
    }
    public interface IAlwaysRowsTask {
        System.Threading.Tasks.Task<(MaybeBox Value, int Code)> Read(string value);
    }
    public interface IWholeRows<T> {
        T Read(string value);
    }
    public interface IOverloadedRows {
        (NullableResultBox Required, int Code) Read(int value);
    }
    public interface IStringRows {
        (NullableResultBox Required, int Code) Read(string value);
    }
    public interface ITupleIndexer {
        int this[(string Required, int Code) row] { get; }
    }
    public abstract class TupleIndexerBase {
        public abstract int this[(string Required, int Code) row] { get; }
    }
    public abstract class WholeRowsBase<T> {
        public abstract T Read(string value);
    }
    public interface IMixedRowsTask<T, TUnrelated> where T : class {
        System.Threading.Tasks.Task<(T Value, int Code)> Read(string value);
    }
    public interface IMixedRowsValueTask<T, TUnrelated> where T : class {
        System.Threading.Tasks.ValueTask<(T Value, int Code)> Read(string value);
    }
    public interface IAlwaysRowsValueTask {
        System.Threading.Tasks.ValueTask<(MaybeBox Value, int Code)> Read(string value);
    }
    public interface IRowsTask {
        System.Threading.Tasks.Task<(NullableResultBox Required, NullAcceptingBox? Optional, int Code)> Read(string value);
    }
    public interface IRowsValueTask {
        System.Threading.Tasks.ValueTask<(NullableResultBox Required, NullAcceptingBox? Optional, int Code)> Read(string value);
    }
    public abstract class RowsBaseTask {
        public abstract System.Threading.Tasks.Task<(NullableResultBox Required, int Code)> Read(string value);
    }
    public abstract class RowsBaseValueTask {
        public abstract System.Threading.Tasks.ValueTask<(NullableResultBox Required, int Code)> Read(string value);
    }
    public interface IGenericRowsTask<T> where T : class {
        System.Threading.Tasks.Task<(T Required, NullAcceptingBox? Optional, int Code)> Read(string value);
    }
    public interface IGenericRowsValueTask<T> where T : class {
        System.Threading.Tasks.ValueTask<(T Required, NullAcceptingBox? Optional, int Code)> Read(string value);
    }
    public abstract class GenericRowsBaseTask<T> where T : class {
        public abstract System.Threading.Tasks.Task<(T Required, int Code)> Read(string value);
    }
    public abstract class GenericRowsBaseValueTask<T> where T : class {
        public abstract System.Threading.Tasks.ValueTask<(T Required, int Code)> Read(string value);
    }
    public static class NativeRows {
        public static T Read<T>(IWholeRows<T> rows, string value) => rows.Read(value);
        public static T Read<T>(WholeRowsBase<T> rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.Task<(MaybeBox Value, int Code)> Read(IAlwaysRowsTask rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.ValueTask<(MaybeBox Value, int Code)> Read(IAlwaysRowsValueTask rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.Task<(NullableResultBox Required, NullAcceptingBox? Optional, int Code)> Read(IRowsTask rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.ValueTask<(NullableResultBox Required, NullAcceptingBox? Optional, int Code)> Read(IRowsValueTask rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.Task<(NullableResultBox Required, int Code)> Read(RowsBaseTask rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.ValueTask<(NullableResultBox Required, int Code)> Read(RowsBaseValueTask rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.Task<(NullableResultBox Required, NullAcceptingBox? Optional, int Code)> Read(IGenericRowsTask<NullableResultBox> rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.ValueTask<(NullableResultBox Required, NullAcceptingBox? Optional, int Code)> Read(IGenericRowsValueTask<NullableResultBox> rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.Task<(NullableResultBox Required, int Code)> Read(GenericRowsBaseTask<NullableResultBox> rows, string value) => rows.Read(value);
        public static System.Threading.Tasks.ValueTask<(NullableResultBox Required, int Code)> Read(GenericRowsBaseValueTask<NullableResultBox> rows, string value) => rows.Read(value);
    }
#nullable disable
    public interface IObliviousRows {
        (NullableResultBox Value, int Code) Read(bool choose);
    }
    public abstract class ObliviousRowsBase {
        public abstract (NullableResultBox Value, int Code) Read(bool choose);
    }
    public sealed class NativeObliviousRows : IObliviousRows {
        public (NullableResultBox Value, int Code) Read(bool choose) =>
            (choose ? "miss" : "keep", 1);
    }
    public struct Token {
        public static explicit operator int(Token value) { Probe.Calls++; return 7; }
    }
    public struct ReferenceToken {
        public static explicit operator Box(ReferenceToken value) { Probe.Calls++; return new Box(); }
    }
    public struct OpaqueToken {
        public static explicit operator int?(OpaqueToken value) { Probe.Calls++; return null; }
    }
    public struct NullAwareToken {
        public static explicit operator int(NullAwareToken? value) { Probe.Calls++; return 9; }
    }
    public static class Probe {
        public static int Calls;
        public static void Reset() { Calls = 0; }
        public static bool Choose(bool choose) { Calls++; return choose; }
        public static string Text(bool missing) { Calls++; return missing ? null : "x"; }
        public static int? Number(bool present) { Calls++; return present ? 7 : null; }
    }
}`)})
        Assert.True(fixture.BoundWithoutErrors, string.Join(Environment.NewLine, fixture.ErrorDiagnostics))
        let emitted = fixture.Compilation.WithAssemblyName(assemblyName).Emit(path)
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
        return path
    }

    shared {
        private func AssertAnnotations(input ITypeSymbol?, output ITypeSymbol?) {
            Assert.Equal(input!!.NullableAnnotation, output!!.NullableAnnotation)
            Assert.Equal(input!!.SpecialType, output!!.SpecialType)
            if input is IArrayTypeSymbol array {
                let mapped = Assert.IsAssignableFrom[IArrayTypeSymbol](output)
                Assert.Equal(array.Rank, mapped.Rank)
                AssertAnnotations(array.ElementType, mapped.ElementType)
            } else if input is INamedTypeSymbol named {
                let mapped = Assert.IsAssignableFrom[INamedTypeSymbol](output)
                Assert.Equal(
                    named.TypeArgumentNullableAnnotations.ToArray(),
                    mapped.TypeArgumentNullableAnnotations.ToArray()
                )
                Assert.Equal(named.TypeArguments.Length, mapped.TypeArguments.Length)
                for var index = 0; index < named.TypeArguments.Length; index++ {
                    AssertAnnotations(named.TypeArguments[index], mapped.TypeArguments[index])
                }
                if named.ContainingType != nil {
                    AssertAnnotations(named.ContainingType, mapped.ContainingType)
                }
            }
        }

        private func AssertTypedHoists(printed string, tuple string, expectedCount int32) {
            let locals = Regex.Matches(printed, "let (?<name>item(_\\d+)?) " + Regex.Escape(tuple) + " =")
            // Issue #4859: a yield value only gets a temporary when it prints with
            // a leading `(` or a nonempty `[`, or when a branching expression is
            // yielded, or a lambda is yielded (delegate target); other shapes yield inline, so the count
            // is an upper bound and the behavioural assertions in each test
            // carry the contract.
            Assert.True(locals.Count <= expectedCount, printed)
            Assert.DoesNotContain("__yielded", printed, StringComparison.Ordinal)
            Assert.All(
                locals.Cast[Match](),
                (local Match) -> Assert.Matches("\\byield " + Regex.Escape(local.Groups["name"].Value) + "\\b", printed)
            )
        }

        private func AssertBindsAndRuns(printed string, fixture string, expected int32) {
            using let resolver = ReferenceResolver.WithReferences([]string{fixture})
            TranslationTestValidation.AssertBinds(resolver, printed)
            let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()", []string{fixture})
            Assert.False(
                result.Diagnostics.Any((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError),
                printed + Environment.NewLine + string.Join(Environment.NewLine, result.Diagnostics)
            )
            Assert.Null(result.UnhandledException)
            Assert.Equal(expected, result.Value)
        }

        private func AssertBindsAndThrows(printed string, fixture string, exception Type, invocation string) {
            using let resolver = ReferenceResolver.WithReferences([]string{fixture})
            TranslationTestValidation.AssertBinds(resolver, printed)
            let result = EmittedOracle.Evaluate(printed + Environment.NewLine + invocation, []string{fixture})
            Assert.IsType(exception, result.UnhandledException)
            Assert.Equal(
                "GS9999",
                Assert.Single(
                    result.Diagnostics.Where((diagnostic GSharp.Core.CodeAnalysis.Diagnostic) -> diagnostic.IsError)
                )
                    .Id
            )
        }

        private func RunDotnet(arguments ...string)(Exit int32, Output string) {
            let start = ProcessStartInfo("dotnet"){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            for argument in arguments {
                start.ArgumentList.Add(argument)
            }
            using let process Process? = Process.Start(start)
            let stdout = process!!.StandardOutput.ReadToEndAsync()
            let stderr = process!!.StandardError.ReadToEndAsync()
            process!!.WaitForExit()
            return (process!!.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult())
        }

        private func Translate(source string, fixture string? = nil) string -> TranslateWithContext(
            source,
            fixture
        ).Printed

        private func TranslateWithContext(source string, fixture string?)(Printed string, Context TranslationContext) {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Snippet.cs", source)},
                if fixture == nil {
                    default([]?MetadataReference)
                } else {
                    CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(fixture)).ToArray()
                }
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return (GSharpPrinter.Print(unit), context)
        }
    }
}

internal delegate Issue4719CastNullTupleLeafTests_TupleElementTaintQuery(
    compilation CSharpCompilation,
    symbol ISymbol,
    path IReadOnlyList[int32],
    @AllowNull siblings IReadOnlyList[CSharpCompilation]?
) bool;
