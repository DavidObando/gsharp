// <copyright file="Issue4719CastNullTupleLeafTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Pipeline;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace Cs2Gs.Tests;

public sealed class Issue4719CastNullTupleLeafTests : IDisposable
{
    private readonly string fixtureDirectory = Path.Combine(
        AppContext.BaseDirectory,
        "issue4719-fixtures",
        Guid.NewGuid().ToString("N"));

    [Theory]
    [InlineData("(string)null")]
    [InlineData("((string)null)")]
    [InlineData("(string)default")]
    [InlineData("(string)default(string)")]
    [InlineData("(string)(object)null")]
    [InlineData("choose ? (string)null : \"x\"")]
    [InlineData("choose switch { true => (string)null, false => \"x\" }")]
    public void CastNullTupleLeaf_PromotesOnlyTheNullBearingLeaf(string value)
    {
        string printed = Translate($$"""
            public static class Obj {
                public static ((string Text, string Keep) Names, int Code) Rows(bool choose) {
                    ((string Text, string Keep) Names, int Code) Missing() {
                        return choose ? (({{value}}, "keep"), 1) : (("x", "keep"), 2);
                    }
                    return Missing();
                }
            }
            """);

        Assert.Contains("let Missing = func () (Names (Text string?, Keep string), Code int32)", printed);
        Assert.Contains("func Rows(choose bool) (Names (Text string?, Keep string), Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Fact]
    public void CastNullTupleAndScalarReturns_PreserveRuntimeNull()
    {
        string printed = Translate("""
            public static class Obj {
                public static string Missing() => (string)null;
                public static string Forward() => Missing();
                public static (string Text, int Code) Row() => ((string)null, 1);
                public static bool Run() {
                    var row = Row();
                    return row.Text is null && row.Code == 1 && Forward() is null;
                }
            }
            """);

        Assert.Contains("func Missing() string?", printed);
        Assert.Contains("func Forward() string?", printed);
        Assert.Contains("func Row() (Text string?, Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Obj.Run()");
        Assert.False(result.Diagnostics.Any(diagnostic => diagnostic.IsError), string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Null(result.UnhandledException);
        Assert.Equal(true, result.Value);
    }

    [Theory]
    [InlineData("(string)(object)\"keep\"")]
    [InlineData("(string)null ?? \"keep\"")]
    [InlineData("(int)(object)null")]
    [InlineData("(Box)(string)null")]
    public void CastWithoutNullResult_DoesNotPromoteItsTupleLeaf(string value)
    {
        string type = value.StartsWith("(int)", StringComparison.Ordinal) ? "int"
            : value.StartsWith("(Box)", StringComparison.Ordinal) ? "Box" : "string";
        string mappedType = type == "int" ? "int32" : type;
        string printed = Translate($$"""
            public sealed class Box {
                public static explicit operator Box(string text) => new Box();
            }
            public static class Obj {
                public static ({{type}} Value, int Code) Row() => ({{value}}, 1);
            }
            """);

        Assert.Contains($"func Row() (Value {mappedType}, Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("struct", "default(T)")]
    [InlineData("unmanaged", "default(T)")]
    [InlineData("struct", "(T)default")]
    [InlineData("unmanaged", "(T)default")]
    public void NonNullableGenericBoxing_PreservesTheNonNullTupleLeaf(string constraint, string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row<T>() where T : {{constraint}}
                    => ((object){{value}}, 1);
                public static int Run() {
                    var row = Row<int>();
                    return (int)row.Value + row.Code;
                }
            }
            """, fixture);

        Assert.Contains($"func Row[T {constraint}]() (Value object, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("int")]
    [InlineData("bool")]
    [InlineData("System.DateTime")]
    public void NonNullableConcreteBoxing_PreservesTheNonNullTupleLeaf(string type)
    {
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row() => ((object)default({{type}}), 1);
            }
            """);

        Assert.Contains("func Row() (Value object, Code int32)", printed);
        TranslationTestValidation.AssertBinds(printed);
    }

    [Theory]
    [InlineData("struct", "(T)(object)null", typeof(NullReferenceException))]
    [InlineData("unmanaged", "(T)(object)null", typeof(NullReferenceException))]
    [InlineData("struct", "(T)(object)(string)null", typeof(NullReferenceException))]
    [InlineData("unmanaged", "(T)(object)(string)null", typeof(NullReferenceException))]
    [InlineData("struct", "(T)(object)default(T?)", typeof(NullReferenceException))]
    [InlineData("unmanaged", "(T)(object)default(T?)", typeof(NullReferenceException))]
    [InlineData("struct", "(object)(T)(object)null", typeof(NullReferenceException))]
    [InlineData("unmanaged", "(object)(T)(object)null", typeof(NullReferenceException))]
    public void NonNullableGenericCastResult_PreservesTheNonNullTupleLeafAndException(
        string constraint,
        string value,
        Type exception)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row<T>() where T : {{constraint}} => ({{value}}, 1);
            }
            """, fixture);

        Assert.Contains($"func Row[T {constraint}]() (Value object, Code int32)", printed);
        AssertBindsAndThrows(printed, fixture, exception, "Obj.Row[int32]()");
    }

    [Theory]
    [InlineData("struct")]
    [InlineData("unmanaged")]
    public void NonNullableGenericNullableUnboxResult_PreservesTheNonNullTupleLeaf(string constraint)
    {
        // Generic nullable unwrap binding is independently tracked in #4735.
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row<T>() where T : {{constraint}}
                    => ((T)default(T?), 1);
            }
            """);

        Assert.Contains($"func Row[T {constraint}]() (Value object, Code int32)", printed);
    }

    [Theory]
    [InlineData("struct", false)]
    [InlineData("unmanaged", false)]
    [InlineData("struct", true)]
    [InlineData("unmanaged", true)]
    public void NonNullableCastResult_DoesNotForwardScalarOrTupleSourceTaint(string constraint, bool tupleSource)
    {
        string fixture = this.EmitFixture();
        string setup = tupleSource ? "var source = Seed();" : "object source = null;";
        string value = tupleSource ? "source.Value" : "source";
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Seed() => (null, 1);
                public static (object Value, int Code) Row<T>() where T : {{constraint}} {
                    {{setup}}
                    return ((T){{value}}, 1);
                }
                public static object Scalar<T>() where T : {{constraint}} {
                    {{setup}}
                    return (T){{value}};
                }
            }
            """, fixture);

        Assert.Contains($"func Row[T {constraint}]() (Value object, Code int32)", printed);
        Assert.Contains($"func Scalar[T {constraint}]() object", printed);
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row[int32]()");
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Scalar[int32]()");
    }

    [Theory]
    [InlineData("int")]
    [InlineData("bool")]
    [InlineData("System.DateTime")]
    public void NonNullableConcreteCastResult_PreservesTheNonNullTupleLeafAndException(string type)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row() => (({{type}})(object)null, 1);
            }
            """, fixture);

        Assert.Contains("func Row() (Value object, Code int32)", printed);
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row()");
    }

    [Theory]
    [InlineData("struct", "(T?)(object)null")]
    [InlineData("unmanaged", "(T?)(object)null")]
    [InlineData("struct", "(T?)default(T?)")]
    [InlineData("unmanaged", "(T?)default(T?)")]
    public void NullableGenericCastResult_PreservesTheNullableTupleLeaf(
        string constraint,
        string value)
    {
        // Generic implicit nullable boxing is independently tracked in #4735.
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row<T>() where T : {{constraint}} => ({{value}}, 1);
            }
            """);

        Assert.Contains($"func Row[T {constraint}]() (Value object?, Code int32)", printed);
    }

    [Theory]
    [InlineData("struct", "(T?)(object)null")]
    [InlineData("unmanaged", "(T?)(object)null")]
    [InlineData("struct", "(T?)default(T?)")]
    [InlineData("unmanaged", "(T?)default(T?)")]
    public void ExplicitlyBoxedNullableGenericCastResult_PreservesRuntimeNull(string constraint, string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row<T>() where T : {{constraint}} => ((object){{value}}, 1);
                public static int Run() {
                    var row = Row<int>();
                    return row.Value == null && row.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains($"func Row[T {constraint}]() (Value object?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("(int?)1")]
    [InlineData("((int?)1)")]
    public void ExplicitlyBoxedNullableLift_PreservesTheNonNullTupleLeaf(string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row() => ((object){{value}}, 1);
                public static int Run() {
                    var row = Row();
                    return (int)row.Value + row.Code;
                }
            }
            """, fixture);

        Assert.Contains("func Row() (Value object, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 2);
    }

    [Fact]
    public void UserDefinedCastResult_DoesNotForwardItsNullableInputsTaint()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using Issue4719Fixture;
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
            }
            """, fixture);

        Assert.Contains("func Row() (Value Box, Code int32)", printed);
        Assert.Contains("func Scalar() Box", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("checked((int?)1)", false)]
    [InlineData("unchecked((int?)1)", false)]
    [InlineData("checked(value ?? (int?)1)", false)]
    [InlineData("unchecked(value ?? (int?)1)", false)]
    [InlineData("checked(choose ? (int?)1 : (int?)2)", false)]
    [InlineData("unchecked(choose switch { true => (int?)1, false => (int?)2 })", false)]
    [InlineData("checked(value)", true)]
    [InlineData("unchecked(value)", true)]
    [InlineData("checked(choose ? value : (int?)1)", true)]
    [InlineData("unchecked(choose switch { true => value, false => (int?)1 })", true)]
    public void CheckedNullableOperands_PreserveCompositeTupleScalarAndSourceContracts(string operand, bool nullable)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row(bool choose, int? value) => ((object){{operand}}, 1);
                public static object Scalar(bool choose, int? value) => (object){{operand}};
                public static object Local(bool choose, int? value) {
                    object result = (object){{operand}};
                    return result;
                }
                public static (object Value, int Code) Forward(bool choose, int? value) => Row(choose, value);
                public static int Run() {
                    var missing = Forward(true, null);
                    var present = Forward(false, 7);
                    return {{(nullable ? "missing.Value == null && Scalar(true, null) == null && Local(true, null) == null" : "missing.Value != null && Scalar(true, null) != null && Local(true, null) != null")}}
                        && present.Value != null && Scalar(false, 7) != null && Local(false, 7) != null
                        && missing.Code == 1 && present.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);
        string optional = nullable ? "?" : string.Empty;
        Assert.Contains($"func Row(choose bool, value int32?) (Value object{optional}, Code int32)", printed);
        Assert.Contains($"func Forward(choose bool, value int32?) (Value object{optional}, Code int32)", printed);
        Assert.Contains($"func Scalar(choose bool, value int32?) object{optional}", printed);
        Assert.Contains($"func Local(choose bool, value int32?) object{optional}", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("checked(value)")]
    [InlineData("unchecked(value)")]
    public void CheckedGuardedNullableOperand_PreservesIteratorPrecision(string operand)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            public static class Obj {
                public static IEnumerable<(object Value, int Code)> Rows(int? value) {
                    if (value != null) { yield return ((object){{operand}}, 1); }
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
            }
            """, fixture);
        Assert.Contains("func Rows(value int32?) sequence[(Value object, Code int32)]", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("value")]
    [InlineData("(value)")]
    [InlineData("checked(value)")]
    [InlineData("unchecked(value)")]
    [InlineData("choose ? value : (int?)1")]
    [InlineData("choose switch { true => value, false => (int?)1 }")]
    [InlineData("Probe.Number(!choose)")]
    public void ContextualOrdinaryNullableParameterOperator_DeclarationOnlyPreservesItsNonNullResult(string operand)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using Issue4719Fixture;
            public static class Obj {
                public static (Box Value, int Code) Row(bool choose, int? value) => ({{operand}}, 1);
                public static Box Scalar(bool choose, int? value) => {{operand}};
                public static Box Local(bool choose, int? value) {
                    Box result = {{operand}};
                    return result;
                }
                public static int Run() {
                    Probe.Reset();
                    var missing = Row(true, null);
                    var present = Row(false, 7);
                    return missing.Value != null && present.Value != null
                        && Scalar(true, null) != null && Scalar(false, 7) != null
                        && Local(true, null) != null && Local(false, 7) != null
                        && missing.Code == 1 && present.Code == 1 && Probe.Calls == {{(operand.StartsWith("Probe.", StringComparison.Ordinal) ? 12 : 6)}} ? 1 : -1;
                }
            }
            """, fixture);
        Assert.Contains("func Row(choose bool, value int32?) (Value Box, Code int32)", printed);
        Assert.Contains("func Scalar(choose bool, value int32?) Box", printed);
        Assert.Contains("func Local(choose bool, value int32?) Box", printed);
        // #4737 also covers native nullable-value contextual operator binding.
    }

    [Theory]
    [InlineData("Input(missing)")]
    [InlineData("(Input(missing))")]
    [InlineData("checked(Input(missing))")]
    [InlineData("missing ? Input(true) : \"x\"")]
    [InlineData("Pair(missing).Text")]
    public void ContextualOrdinaryReferenceOperator_BlocksOperandSourceAndTupleEdges(string operand)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using Issue4719Fixture;
            public static class Obj {
                public static string Input(bool missing) => missing ? null : "x";
                public static (string Text, int Code) Pair(bool missing) => (Input(missing), 1);
                public static (ReferenceBox Value, int Code) Row(bool missing) => ({{operand}}, 1);
                public static ReferenceBox Scalar(bool missing) => {{operand}};
                public static ReferenceBox Local(bool missing) {
                    ReferenceBox result = {{operand}};
                    return result;
                }
                public static int Run() {
                    Probe.Reset();
                    return Row(true).Value != null && Row(false).Value != null
                        && Scalar(true) != null && Scalar(false) != null
                        && Local(true) != null && Local(false) != null
                        && Probe.Calls == 6 ? 1 : -1;
                }
            }
            """, fixture);
        Assert.Contains("func Input(missing bool) string?", printed);
        Assert.Contains("func Pair(missing bool) (Text string?, Code int32)", printed);
        Assert.Contains("func Row(missing bool) (Value ReferenceBox, Code int32)", printed);
        Assert.Contains("func Scalar(missing bool) ReferenceBox", printed);
        Assert.Contains("func Local(missing bool) ReferenceBox", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void ContextualOrdinaryOperator_IteratorPreservesItsNonNullLeafAndTypedHoist()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
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
            }
            """, fixture);
        Assert.Contains("func Rows(missing bool) sequence[(Value ReferenceBox, Code int32)]", printed);
        AssertTypedHoists(printed, "(Value ReferenceBox, Code int32)", expectedCount: 1);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void ContextualNullableResultOperator_InputGuardDoesNotEraseTheOperatorsOwnNullResult()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
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
            }
            """, fixture);
        Assert.Contains("func Rows(value string?) sequence[(Value MaybeBox?, Code int32)]", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void ContextualOrdinaryOperator_DeclarationOnlyStaticInitializerPreservesNonNullStorage()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using Issue4719Fixture;
            public static class Obj {
                public static Box Value = (int?)null;
                public static Box Read() => Value;
                public static int Run() => Read() != null ? 1 : -1;
            }
            """, fixture);
        Assert.Contains("Value Box =", printed);
        Assert.Contains("func Read() Box", printed);
        // #4737: implicit int32? -> Box fails loudly before execution.
    }

    [Theory]
    [InlineData("value", true)]
    [InlineData("(object)(int?)value", true)]
    [InlineData("choose ? value : (Token?)new Token()", true)]
    [InlineData("choose switch { true => value, false => (Token?)new Token() }", true)]
    [InlineData("value ?? (Token?)new Token()", false)]
    [InlineData("(Token?)new Token()", false)]
    public void LiftedUserDefinedCast_UsesItsEffectiveNullContractAndInvokesOnlyForPresentValues(
        string operand,
        bool nullable)
    {
        string fixture = this.EmitFixture();
        string converted = operand.StartsWith("(object)", StringComparison.Ordinal) ? operand : $"(int?)({operand})";
        string printed = Translate($$"""
            using Issue4719Fixture;
            public static class Obj {
                public static (object Value, int Code) Row(bool choose) {
                    Token? value = choose ? null : new Token();
                    return ({{converted}}, 1);
                }
                public static object Scalar(bool choose) {
                    Token? value = choose ? null : new Token();
                    return {{converted}};
                }
                public static int Run() {
                    Probe.Reset();
                    var missing = Row(true);
                    var present = Row(false);
                    var scalarMissing = Scalar(true);
                    var scalarPresent = Scalar(false);
                    return {{(nullable ? "missing.Value == null && scalarMissing == null" : "(int)missing.Value == 7 && (int)scalarMissing == 7")}}
                        && (int)present.Value == 7 && (int)scalarPresent == 7
                        && missing.Code == 1 && present.Code == 1
                        && Probe.Calls == {{(nullable ? 2 : 4)}} ? 1 : -1;
                }
            }
            """, fixture);

        string optional = nullable ? "?" : string.Empty;
        Assert.Contains($"func Row(choose bool) (Value object{optional}, Code int32)", printed);
        Assert.Contains($"func Scalar(choose bool) object{optional}", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("OpaqueToken", "int?", true, 0)]
    [InlineData("NullAwareToken", "int", false, 9)]
    public void OrdinaryNullableValueUserDefinedCast_DeclarationOnlyPreservesItsOwnResultContract(
        string token,
        string resultType,
        bool nullable,
        int expectedValue)
    {
        string fixture = this.EmitFixture();
        string input = token == "NullAwareToken" ? "choose ? null : new NullAwareToken()" : "new OpaqueToken()";
        string printed = Translate($$"""
            using Issue4719Fixture;
            public static class Obj {
                public static (object Value, int Code) Row(bool choose) {
                    {{token}}{{(token == "NullAwareToken" ? "?" : "")}} value = {{input}};
                    return (({{resultType}})value, 1);
                }
                public static int Run() {
                    Probe.Reset();
                    var first = Row(true);
                    var second = Row(false);
                    return {{(nullable ? "first.Value == null && second.Value == null" : $"(int)first.Value == {expectedValue} && (int)second.Value == {expectedValue}")}}
                        && first.Code == 1 && second.Code == 1 && Probe.Calls == 2 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains($"func Row(choose bool) (Value object{(nullable ? "?" : "")}, Code int32)", printed);
        // #4737 tracks these two ordinary nullable-signature operator binding gaps.
    }

    [Fact]
    public void GuardedLiftedUserDefinedCast_PreservesItsNonNullIteratorLeaf()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
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
            }
            """, fixture);

        Assert.Contains("func Rows(value Token?) sequence[(Value object, Code int32)]", printed);
        Assert.DoesNotContain("value!!", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void LiftedUserDefinedReferenceResult_DeclarationOnlyPreservesTheEffectiveNullContract()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using Issue4719Fixture;
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
            }
            """, fixture);

        Assert.Contains("func Row(missing bool) (Value object?, Code int32)", printed);
        // #4741 tracks the independent Core null-short-circuit runtime divergence.
    }

    [Theory]
    [InlineData("value ?? (int?)1", 0)]
    [InlineData("Probe.Choose(choose) ? (int?)1 : (int?)2", 8)]
    [InlineData("Probe.Choose(choose) switch { true => (int?)1, false => (int?)2 }", 8)]
    [InlineData("(Probe.Choose(choose) ? value : (int?)null) ?? (int?)1", 8)]
    public void BoxedNonNullNullableComposite_PreservesTupleAndScalarPrecisionAndSingleEvaluation(
        string operand,
        int calls)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using Issue4719Fixture;
            public static class Obj {
                public static (object Value, int Code) Row(bool choose, int? value) => ((object)({{operand}}), 1);
                public static object Scalar(bool choose, int? value) => (object)({{operand}});
                public static int Run() {
                    Probe.Reset();
                    var a = Row(true, null);
                    var b = Row(false, null);
                    var c = Row(true, 7);
                    var d = Row(false, 7);
                    return a.Value != null && b.Value != null && c.Value != null && d.Value != null
                        && Scalar(true, null) != null && Scalar(false, null) != null
                        && Scalar(true, 7) != null && Scalar(false, 7) != null
                        && a.Code + b.Code + c.Code + d.Code == 4 && Probe.Calls == {{calls}} ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains("func Row(choose bool, value int32?) (Value object, Code int32)", printed);
        Assert.Contains("func Scalar(choose bool, value int32?) object", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("Probe.Choose(choose) ? value : (int?)1")]
    [InlineData("Probe.Choose(choose) switch { true => value, false => (int?)1 }")]
    public void BoxedGuardedNullableComposite_PreservesIteratorLeafAndGuard(string operand)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<(object Value, int Code)> Rows(bool choose, int? value) {
                    if (value != null) {
                        yield return ((object)({{operand}}), 1);
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
            }
            """, fixture);

        Assert.Contains("func Rows(choose bool, value int32?) sequence[(Value object, Code int32)]", printed);
        Assert.DoesNotContain("value!!", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("Probe.Choose(choose) ? value : (int?)1")]
    [InlineData("Probe.Choose(choose) switch { true => value, false => (int?)1 }")]
    [InlineData("value ?? (int?)null")]
    [InlineData("Probe.Number(!choose)")]
    public void BoxedNullableCompositeOrOpaqueRead_PreservesNullAndPresentValues(string operand)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using Issue4719Fixture;
            public static class Obj {
                public static (object Value, int Code) Row(bool choose, int? value) => ((object)({{operand}}), 1);
                public static int Run() {
                    Probe.Reset();
                    var missing = Row(true, null);
                    var present = Row(false, 7);
                    return missing.Value == null && present.Value != null
                        && missing.Code == 1 && present.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains("func Row(choose bool, value int32?) (Value object?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void LiftedAndCompositeCastProgram_CompilesWithRealDriverVerifiesAndPreservesMetadata()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System;
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
            }
            """, fixture);

        Assert.Contains("func Lift(missing bool) (Value object?, Code int32)", printed);
        Assert.Contains("func Known(choose bool, value int32?) (Value object, Code int32)", printed);
        Assert.Contains("func Ordinary(missing bool) (Value ReferenceBox, Code int32)", printed);
        string source = Path.Combine(this.fixtureDirectory, "Program.gs");
        string assemblyPath = Path.Combine(this.fixtureDirectory, "Program.dll");
        string compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"));
        Assert.True(File.Exists(compiler), "The graph build must build the real gsc driver.");
        File.WriteAllText(source, printed);
        var compiled = RunDotnet(compiler, "/target:exe", "/targetframework:net10.0", $"/reference:{fixture}", $"/out:{assemblyPath}", source);
        Assert.True(compiled.Exit == 0, compiled.Output);
        Assert.DoesNotContain("GS0523", compiled.Output);
        Assert.True(IlVerifyRunner.IsEnabled, "This witness requires real IL verification, not its bypass.");
        IlVerifyResult verified = new IlVerifyRunner().Verify(assemblyPath, new[] { fixture });
        Assert.Equal(IlVerifyStatus.Passed, verified.Status);
        Assert.Empty(verified.Errors);
        File.WriteAllText(
            Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
            "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\""
                + Environment.Version.Major + ".0.0\"}}}");
        var executed = RunDotnet(assemblyPath);
        Assert.Equal(0, executed.Exit);
        Assert.Equal("15" + Environment.NewLine, executed.Output);

        var loadContext = new AssemblyLoadContext("issue4719-metadata", isCollectible: true);
        try
        {
            loadContext.LoadFromAssemblyPath(fixture);
            Type owner = Assert.Single(loadContext.LoadFromAssemblyPath(assemblyPath).GetTypes(), type => type.Name == "Obj");
            var nullability = new NullabilityInfoContext();
            MethodInfo lift = Assert.IsAssignableFrom<MethodInfo>(owner.GetMethod("Lift"));
            MethodInfo known = Assert.IsAssignableFrom<MethodInfo>(owner.GetMethod("Known"));
            MethodInfo ordinary = Assert.IsAssignableFrom<MethodInfo>(owner.GetMethod("Ordinary"));
            Assert.Equal(NullabilityState.Nullable, nullability.Create(lift.ReturnParameter).GenericTypeArguments[0].ReadState);
            Assert.Equal(NullabilityState.NotNull, nullability.Create(known.ReturnParameter).GenericTypeArguments[0].ReadState);
            Assert.Equal(NullabilityState.NotNull, nullability.Create(ordinary.ReturnParameter).GenericTypeArguments[0].ReadState);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Theory]
    [InlineData("(int?)(object)null")]
    [InlineData("(int?)default(int?)")]
    public void NullableConcreteCastResult_PreservesTheNullableTupleLeafAndRuntimeNull(string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row() => ({{value}}, 1);
                public static int Run() {
                    var row = Row();
                    return row.Value == null && row.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains("func Row() (Value object?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("", "")]
    [InlineData("where T : class", " class")]
    public void ReferenceOrUnconstrainedCastResult_PreservesTheNullableTupleLeafAndRuntimeNull(
        string constraint,
        string mappedConstraint)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row<T>() {{constraint}} => ((T)(object)null, 1);
                public static int Run() {
                    var row = Row<string>();
                    return row.Value == null && row.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains($"func Row[T{mappedConstraint}]() (Value object?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
        if (constraint.Length == 0)
        {
            AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row[int32]()");
        }
    }

    [Theory]
    [InlineData("default(int?)", true)]
    [InlineData("(int?)default", true)]
    [InlineData("(int?)null", true)]
    [InlineData("choose ? (int?)null : 1", false)]
    [InlineData("choose switch { true => default(int?), false => 1 }", false)]
    public void NullableValueBoxing_PreservesNullAndThePromotedTupleLeaf(string value, bool alwaysNull)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row(bool choose) => ((object)({{value}}), 1);
                public static int Run() {
                    var missing = Row(true);
                    var present = Row(false);
                    return missing.Value == null && missing.Code == 1
                        && {{(alwaysNull ? "present.Value == null" : "(int)present.Value == 1")}}
                        && present.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains("func Row(choose bool) (Value object?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("", "")]
    [InlineData("where T : class", " class")]
    public void ReferenceOrUnconstrainedDefaultCast_PreservesTheNullableTupleLeaf(
        string constraint,
        string mappedConstraint)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (object Value, int Code) Row<T>() {{constraint}} => ((object)default(T), 1);
                public static int Run() {
                    var row = Row<string>();
                    {{(constraint.Length == 0 ? "if ((int)Row<int>().Value != 0) { return -2; }" : "")}}
                    return row.Value == null && row.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains($"func Row[T{mappedConstraint}]() (Value object?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void NullableGenericValueBoxing_PreservesNullAndThePromotedTupleLeaf()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            public static class Obj {
                public static (object Value, int Code) Row<T>() where T : struct => ((object)default(T?), 1);
                public static int Run() {
                    var row = Row<int>();
                    return row.Value == null && row.Code == 1 ? 1 : -1;
                }
            }
            """, fixture);

        Assert.Contains("func Row[T struct]() (Value object?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void GuardedReferenceTypeParameterCast_PreservesTheNonNullIteratorLeaf()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
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
            }
            """, fixture);

        Assert.Contains("func Rows[T class](value T?) sequence[(Value object, Code int32)]", printed);
        Assert.DoesNotContain("value!!", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void GuardedNullableValueBoxing_PreservesTheNonNullIteratorLeaf()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
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
            }
            """, fixture);

        Assert.Contains("func Rows(value int32?) sequence[(Value object, Code int32)]", printed);
        Assert.DoesNotContain("value!!", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void OriginalNestedIteratorAndCastYield_PreserveContractsAndDeferredEvaluation()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
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
            }
            """, fixture);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        Assert.Equal(2, printed.Split("let Missing = func () IEnumerable[(Text string?, Code int32)]").Length - 1);
        Assert.Contains("func CastRows(choose bool) sequence[(Text string?, Code int32)]", printed);
        AssertTypedHoists(printed, "(Text string?, Code int32)", expectedCount: 3);
        AssertBindsAndRuns(printed, fixture, expected: 15);
    }

    [Theory]
    [InlineData("IEnumerable", "", "sequence")]
    [InlineData("IEnumerator", "", "IEnumerator")]
    [InlineData("IAsyncEnumerable", "async ", "IAsyncEnumerable")]
    [InlineData("IAsyncEnumerator", "async ", "IAsyncEnumerator")]
    public void CastTupleYield_UsesPromotedElementTypeForItsMaterializedLocal(
        string envelope,
        string modifier,
        string mappedEnvelope)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static {{modifier}}{{envelope}}<(string Text, int Code)> Rows(bool choose) {
                    yield return ((string Text, int Code))
                        (Probe.Choose(choose) ? ((string)null, 1) : ("x", 2));
                }
            }
            """, fixture);

        Assert.Contains($"func Rows(choose bool) {mappedEnvelope}[(Text string?, Code int32)]", printed);
        AssertTypedHoists(printed, "(Text string?, Code int32)", expectedCount: 1);
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
    }

    [Theory]
    [InlineData("choose ? ((string)text, 1) : (\"x\", 2)", true)]
    [InlineData("choose switch { true => ((string)text, 1), false => (\"x\", 2) }", true)]
    [InlineData("(choose ? (string)text : \"x\", 1)", false)]
    [InlineData("(choose switch { true => (string)text, false => \"x\" }, 1)", false)]
    public void GuardedCastTupleLeaf_PreservesTheNonNullContractAndRuntimeGuard(string yielded, bool materialized)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<(string Text, int Code)> Rows(bool choose) {
                    string? text = choose ? null : "x";
                    if (text != null) {
                        Probe.Choose(choose);
                        yield return {{yielded}};
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
            }
            """, fixture);

        Assert.Contains("func Rows(choose bool) sequence[(Text string, Code int32)]", printed);
        Assert.DoesNotContain("text!!", printed);
        if (materialized)
        {
            AssertTypedHoists(printed, "(Text string, Code int32)", expectedCount: 1);
        }

        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void GuardedNestedCastTupleLeaf_StillPromotesTheNullSibling()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System.Collections.Generic;
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
            }
            """, fixture);

        const string tuple = "(Names (Text string, Missing string?), Code int32)";
        Assert.Contains("func Rows(choose bool) sequence[" + tuple + "]", printed);
        AssertTypedHoists(printed, tuple, expectedCount: 1);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("(string)(object)\"keep\"", "string", "\"keep\"", "string")]
    [InlineData("(string)null ?? \"keep\"", "string", "\"keep\"", "string")]
    [InlineData("(int)(object)null", "int", "1", "int32")]
    [InlineData("(Box)(string)null", "Box", "new Box()", "Box")]
    public void IteratorCastWithoutNullResult_PreservesElementAndHoistPrecision(
        string value,
        string type,
        string fallback,
        string mappedType)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<({{type}} Value, int Code)> Rows(bool choose) {
                    yield return choose ? ({{value}}, 1) : ({{fallback}}, 2);
                }
            }
            """, fixture);

        string tuple = $"(Value {mappedType}, Code int32)";
        Assert.Contains("func Rows(choose bool) sequence[" + tuple + "]", printed);
        AssertTypedHoists(printed, tuple, expectedCount: 1);
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(this.fixtureDirectory))
            {
                Directory.Delete(this.fixtureDirectory, recursive: true);
            }
        }
        catch (IOException)
        {
            // A collectible oracle assembly can still hold the fixture on Windows.
        }
        catch (UnauthorizedAccessException)
        {
            // Best-effort cleanup, as above.
        }
    }

    private string EmitFixture()
    {
        Directory.CreateDirectory(this.fixtureDirectory);
        string assemblyName = "Issue4719Fixture" + Guid.NewGuid().ToString("N");
        string path = Path.Combine(this.fixtureDirectory, assemblyName + ".dll");
        LoadedCSharpProject fixture = CSharpProjectLoader.LoadInMemory(new[]
        {
            ("Fixture.cs", """
                namespace Issue4719Fixture {
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
                #nullable disable
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
                }
                """),
        });
        Assert.True(fixture.BoundWithoutErrors, string.Join(Environment.NewLine, fixture.ErrorDiagnostics));
        var emitted = fixture.Compilation.WithAssemblyName(assemblyName).Emit(path);
        Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
        return path;
    }

    private static void AssertTypedHoists(string printed, string tuple, int expectedCount)
    {
        MatchCollection locals = Regex.Matches(printed, @"let (?<name>__yielded\d+) " + Regex.Escape(tuple) + " =");
        Assert.NotEmpty(locals);
        Assert.Equal(expectedCount, locals.Count);
        Assert.All(
            locals.Cast<Match>(),
            local => Assert.Matches(@"\byield " + Regex.Escape(local.Groups["name"].Value) + @"\b", printed));
    }

    private static void AssertBindsAndRuns(string printed, string fixture, int expected)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + "Obj.Run()",
            new[] { fixture });
        Assert.False(result.Diagnostics.Any(diagnostic => diagnostic.IsError), string.Join(Environment.NewLine, result.Diagnostics));
        Assert.Null(result.UnhandledException);
        Assert.Equal(expected, result.Value);
    }

    private static void AssertBindsAndThrows(string printed, string fixture, Type exception, string invocation)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
        EmittedOracleResult result = EmittedOracle.Evaluate(
            printed + Environment.NewLine + invocation,
            new[] { fixture });
        Assert.IsType(exception, result.UnhandledException);
        Assert.Equal("GS9999", Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.IsError)).Id);
    }

    private static (int Exit, string Output) RunDotnet(params string[] arguments)
    {
        var start = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(start);
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        return (process.ExitCode, stdout.GetAwaiter().GetResult() + stderr.GetAwaiter().GetResult());
    }

    private static string Translate(string source, string fixture = null)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            fixture is null
                ? null
                : CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(fixture)).ToArray());
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics));
        Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions);
        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        Assert.DoesNotContain(context.Diagnostics, diagnostic => diagnostic.Severity == TranslationSeverity.Unsupported);
        return GSharpPrinter.Print(unit);
    }
}
