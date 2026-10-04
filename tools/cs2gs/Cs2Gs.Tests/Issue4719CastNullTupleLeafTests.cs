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

    [Theory]
    [InlineData("new object() as string")]
    [InlineData("(new object() as string)")]
    [InlineData("checked(new object() as string)")]
    [InlineData("unchecked(new object() as string)")]
    [InlineData("choose ? new object() as string : \"keep\"")]
    [InlineData("choose switch { true => new object() as string, false => \"keep\" }")]
    public void TryCastResult_PromotesTupleScalarAndLaterAssignment(string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            public static class Obj {
                public static (string Value, string Keep, int Code) Row(bool choose) => ({{value}}, "keep", 1);
                public static (string Value, string Keep, int Code) Forward(bool choose) => Row(choose);
                public static string Scalar(bool choose) => {{value}};
                public static string Later(bool choose) {
                    string text = "keep";
                    text = {{value}};
                    return text;
                }
                public static int Run() {
                    var row = Forward(true);
                    return row.Value == null && row.Keep == "keep" && row.Code == 1
                        && Scalar(true) == null && Later(true) == null ? 1 : -1;
                }
            }
            """, fixture);
        Assert.Contains("func Row(choose bool) (Value string?, Keep string, Code int32)", printed);
        Assert.Contains("func Forward(choose bool) (Value string?, Keep string, Code int32)", printed);
        Assert.Contains("func Scalar(choose bool) string?", printed);
        Assert.Contains("func Later(choose bool) string?", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Fact]
    public void TryCastInsideNonNullableUnboxing_PreservesValueResultAndException()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            public static class Obj {
                public static (object Value, int Code) Row() => ((int)(new object() as System.IConvertible), 1);
                public static object Scalar() => (int)(new object() as System.IConvertible);
            }
            """, fixture);
        Assert.Contains("func Row() (Value object, Code int32)", printed);
        Assert.Contains("func Scalar() object", printed);
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Row()");
    }

    [Theory]
    [InlineData("(MaybeBox?)\"x\"", false)]
    [InlineData("((MaybeBox?)\"x\")", false)]
    [InlineData("checked((MaybeBox?)\"x\")", false)]
    [InlineData("\"x\"", false)]
    [InlineData("(MaybeBox?)\"x\"", true)]
    [InlineData("((MaybeBox?)\"x\")", true)]
    [InlineData("checked((MaybeBox?)\"x\")", true)]
    [InlineData("\"x\"", true)]
    public void NullableOperatorConvertedResult_RetainsNonNullSinkAssertion(string value, bool initialize)
    {
        string make = initialize ? $"{{ MaybeBox result = {value}; return result; }}" : $"=> {value};";
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            #nullable enable
            using Issue4719Fixture;
            public static class Obj {
                public static MaybeBox Make() {{make}}
            }
            """, fixture);
        AssertBindsAndThrows(printed, fixture, typeof(NullReferenceException), "Obj.Make()");
        Assert.Contains("func Make() MaybeBox", printed);
        Assert.Contains("!!", printed);
    }

    [Theory]
    [InlineData("value")]
    [InlineData("(MaybeBox?)value")]
    public void NullableOperatorConvertedResult_PromotedTupleSinkStillAcceptsNull(string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using Issue4719Fixture;
            public static class Obj {
                public static (MaybeBox Value, int Code) Row(string value) => ({{value}}, 1);
                public static int Run() {
                    Probe.Reset();
                    var row = Row("x");
                    return row.Value == null && row.Code == 1 && Probe.Calls == 1 ? 1 : -1;
                }
            }
            """, fixture);
        Assert.Contains("func Row(value string) (Value MaybeBox?, Code int32)", printed);
        AssertBindsAndRuns(printed, fixture, expected: 1);
    }

    [Theory]
    [InlineData("Task", "value")]
    [InlineData("Task", "(MaybeBox?)value")]
    [InlineData("ValueTask", "value")]
    [InlineData("ValueTask", "(MaybeBox?)value")]
    public void AsyncNullableOperatorConvertedResult_PromotedTupleSinkExecutesWithoutAssertion(
        string envelope,
        string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public static class Obj {
                public static async {{envelope}}<(MaybeBox Value, int Code)> Row(string value) {
                    await Task.Delay(1);
                    return ({{value}}, 1);
                }
                public static void Main() {
                    Probe.Reset();
                    var row = Row("x").GetAwaiter().GetResult();
                    Console.WriteLine(row.Value == null && row.Code == 1 && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        string tuple = "(Value MaybeBox?, Code int32)";
        Assert.Contains("async func Row(value string) " + (envelope == "ValueTask" ? $"ValueTask[{tuple}]" : tuple), printed);
        Assert.DoesNotContain("MaybeBox?(value)!!", printed);
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void AsyncTupleOperatorContracts_PreserveNilInputsStrictSinksAndPropertyCounts(string envelope)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
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
                public static async {{envelope}}<MaybeBox> StrictResult(string value) {
                    await Task.Delay(1);
                    return value;
                }
                #nullable disable
                public static async {{envelope}}<(MaybeBox Value, int Code)> Guarded() {
                    await Task.Delay(1);
                    if (Text != null) { return (Text, 2); }
                    return ((MaybeBox)null, 2);
                }
                public static async {{envelope}}<(NullAcceptingBox Value, int Code)> Accepting() {
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
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("Text!!", printed);
        Assert.Contains("MaybeBox?(value)!!", printed);
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void AsyncTupleOperatorResult_FrozenParameterContractRetainsAssertion(string envelope)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public static class Obj {
                public static async {{envelope}}<int> Read(string value) {
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
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("MaybeBox?(value)!!", printed);
    }

    [Theory]
    [InlineData("Text")]
    [InlineData("(MaybeBox?)Text")]
    [InlineData("checked((MaybeBox?)Text)")]
    [InlineData("choose ? Text : Text")]
    public void ScalarYieldNullableOperatorResult_UsesTheEmittedElementContract(string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
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
                    if (Text != null) { yield return {{value}}; }
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
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("func Rows(choose bool) sequence[MaybeBox?]", printed);
        if (value == "Text" || value == "choose ? Text : Text")
        {
            Assert.Contains("Text!!", printed);
        }

        Assert.DoesNotContain("MaybeBox?(Text!!)!!", printed);
    }

    [Fact]
    public void ScalarYieldNullableOperatorInput_RemainsBareAndExecutesOnce()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System;
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
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("func Rows() sequence[NullAcceptingBox?]", printed);
        Assert.DoesNotContain("Text!!", printed);
    }

    [Theory]
    [InlineData("value")]
    [InlineData("(MaybeBox?)value")]
    public void ScalarYieldNullableOperatorResult_AnnotatedElementRetainsAssertion(string value)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            #nullable enable
            using System;
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                public static IEnumerable<MaybeBox> Rows(string value) {
                    yield return {{value}};
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
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("func Rows(value string) sequence[MaybeBox]", printed);
        Assert.Contains("MaybeBox?(value)!!", printed);
    }

    [Fact]
    public void ScalarYieldNullableOperatorResult_FrozenParameterContractRetainsAssertion()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System;
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
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("func Rows() sequence[MaybeBox?]", printed);
        Assert.Contains("FrozenTupleContract.Accept((item!!, 1))", printed);
    }

    [Theory]
    [InlineData(true, "return")]
    [InlineData(true, "array")]
    [InlineData(true, "list")]
    [InlineData(false, "return")]
    [InlineData(false, "array")]
    [InlineData(false, "list")]
    public void OperatorInputStoreBridge_ReportsTheActualParameterOnceAndExecutesOnce(bool genericParameter, string store)
    {
        string box = genericParameter ? "StrictInputBox<string>" : "StrictReferenceBox";
        string body = store switch
        {
            "array" => $"var rows = new {box}[] {{ Text }}; return rows[0];",
            "list" => $"var rows = new System.Collections.Generic.List<{box}>(); rows.Add(Text); return rows[0];",
            _ => "return Text;",
        };
        string fixture = this.EmitFixture();
        (string printed, TranslationContext context) = TranslateWithContext($$"""
            #nullable enable
            using System;
            using Issue4719Fixture;
            public static class Obj {
                private static string? text;
                public static int Reads;
                public static string? Text {
                    get { Reads++; return text; }
                    set { text = value; }
                }
                public static {{box}} Read() {
                    if (Text != null) { {{body}} }
                    return new {{box}}();
                }
                public static void Main() {
                    Probe.Reset();
                    Text = "keep";
                    Reads = 0;
                    var result = Read();
                    Console.WriteLine(result != null && Probe.Calls == 1 && Reads == 2 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Single(Regex.Matches(printed, @"Text!!").Cast<Match>());
        TranslationDiagnostic[] sites = context.Diagnostics
            .Where(diagnostic => diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId)
            .ToArray();
        if (genericParameter)
        {
            TranslationDiagnostic site = Assert.Single(sites);
            Assert.Equal(TranslationSeverity.Warning, site.Severity);
            Assert.StartsWith("kind=constructed-generic-member | target=StrictInputBox<string>.implicit operator", site.Message);
            Assert.Contains("parameter 'value' | slot-type=string (NotAnnotated) | result-depends-on-slot=yes | value=Text", site.Message);
            Assert.Equal("Text", site.Location.SourceTree.GetText().ToString(site.Location.SourceSpan));
        }
        else
        {
            Assert.Empty(sites);
        }
    }

    [Theory]
    [InlineData("return")]
    [InlineData("list")]
    public void NullableOperatorInputStoreBridge_RemainsBareAndUnreported(string store)
    {
        string body = store == "list"
            ? "var rows = new System.Collections.Generic.List<NullAcceptingInputBox<string>>(); rows.Add(Text); return rows[0];"
            : "return Text;";
        string fixture = this.EmitFixture();
        (string printed, TranslationContext context) = TranslateWithContext($$"""
            #nullable enable
            using System;
            using Issue4719Fixture;
            public static class Obj {
                public static int Reads;
                public static string? Text {
                    get { Reads++; return null; }
                    set { }
                }
                public static NullAcceptingInputBox<string> Read() { {{body}} }
                public static void Main() {
                    Probe.Reset();
                    Reads = 0;
                    var result = Read();
                    Console.WriteLine(result != null && Probe.Calls == 1 && Reads == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.DoesNotContain("Text!!", printed);
        Assert.DoesNotContain(context.Diagnostics, diagnostic =>
            diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId);
    }

    [Theory]
    [InlineData("array")]
    [InlineData("list")]
    public void OperatorInputAndResultStoreBridges_ReportDistinctSlotsWithoutRepeatingEvaluation(string store)
    {
        string body = store == "array"
            ? "var rows = new MaybeStrictInputBox<string>[] { Text }; return rows[0];"
            : "var rows = new System.Collections.Generic.List<MaybeStrictInputBox<string>>(); rows.Add(Text); return rows[0];";
        string fixture = this.EmitFixture();
        (string printed, TranslationContext context) = TranslateWithContext($$"""
            #nullable enable
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
                    if (Text != null) { {{body}} }
                    return new MaybeStrictInputBox<string>();
                }
                public static void Main() {
                    Probe.Reset();
                    Text = "keep";
                    Reads = 0;
                    var result = Read();
                    Console.WriteLine(result != null && Probe.Calls == 1 && Reads == 2 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Single(Regex.Matches(printed, @"Text!!").Cast<Match>());
        TranslationDiagnostic[] sites = context.Diagnostics
            .Where(diagnostic => diagnostic.DiagnosticId == CSharpToGSharpTranslator.GenericStoreBridgeDiagnosticId)
            .ToArray();
        Assert.Equal(2, sites.Length);
        Assert.Contains(sites, site => site.Message.Contains("target=MaybeStrictInputBox<string>.implicit operator", StringComparison.Ordinal)
            && site.Message.Contains("parameter 'value' | slot-type=string (NotAnnotated)", StringComparison.Ordinal));
        Assert.Contains(sites, site => store == "array"
            ? site.Message.StartsWith("kind=array-element | target=MaybeStrictInputBox<string>[]", StringComparison.Ordinal)
            : site.Message.StartsWith("kind=constructed-generic-member | target=List<MaybeStrictInputBox<string>>.Add", StringComparison.Ordinal));
        Assert.All(sites, site => Assert.Equal("Text", site.Location.SourceTree.GetText().ToString(site.Location.SourceSpan)));
    }

    [Theory]
    [InlineData(false, "return Text;")]
    [InlineData(false, "StrictBox result = Text; return result;")]
    [InlineData(false, "StrictBox result = new StrictBox(); result = Text; return result;")]
    [InlineData(true, "return Text;")]
    [InlineData(true, "StrictBox result = Text; return result;")]
    [InlineData(true, "StrictBox result = new StrictBox(); result = Text; return result;")]
    public void GuardedSettablePropertyOperatorInput_UsesTheActualParameterContract(bool acceptsNull, string body)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            #nullable enable
            using Issue4719Fixture;
            public sealed class StrictBox {
                public static implicit operator StrictBox(string{{(acceptsNull ? "?" : "")}} value) {
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
                    if (Text != null) { {{body}} }
                    return new StrictBox();
                }
                {{(acceptsNull ? "public static StrictBox Bare() => Text;" : string.Empty)}}
                public static int Run() {
                    Text = "keep";
                    Probe.Reset();
                    Reads = 0;
                    var result = Read();
                    if (result == null || Probe.Calls != 1 || Reads != 2) { return -1; }
                    {{(acceptsNull ? "Text = null; return Bare() != null && Probe.Calls == 2 && Reads == 3 ? 1 : -2;" : "return 1;")}}
                }
            }
            """, fixture);
        AssertBindsAndRuns(printed, fixture, expected: 1);
        if (acceptsNull)
        {
            Assert.DoesNotContain("Text!!", printed);
        }
        else
        {
            Assert.Contains("Text!!", printed);
        }
    }

    [Theory]
    [InlineData("(NullableResultBox?)\"keep\"")]
    [InlineData("\"keep\"")]
    public void TryCastAndOperatorAssertionBoundaries_RealDriverVerifiesAndExecutesOnce(string result)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
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
                public static NullableResultBox Make() => {{result}};
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
            }
            """, fixture);
        Assert.Contains("func Row() (Value string?, Code int32)", printed);
        Assert.Contains("func Later() string?", printed);
        Assert.Contains("Text!!", printed);
        Assert.Contains("func Make() NullableResultBox", printed);
        Assert.Contains("NullableResultBox?(\"keep\")!!", printed);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
    }

    [Theory]
    [InlineData("Task", false)]
    [InlineData("ValueTask", false)]
    [InlineData("Task", true)]
    [InlineData("ValueTask", true)]
    public void TupleContractEligibility_AnnotatedSourceRetainsPerLeafAssertions(string envelope, bool nested)
    {
        string fixture = this.EmitFixture();
        string tuple = nested
            ? "((NullableResultBox Required, NullAcceptingBox? Optional) Pair, int Code, int? Maybe)"
            : "(NullableResultBox Required, NullAcceptingBox? Optional, int Code, int? Maybe)";
        string result = nested ? "((value, (string?)null), 1, null)" : "(value, (string?)null, 1, null)";
        string required = nested ? "row.Pair.Required" : "row.Required";
        string optional = nested ? "row.Pair.Optional" : "row.Optional";
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public static class Obj {
                #nullable enable
                public static async {{envelope}}<{{tuple}}> Read(string value) {
                    await Task.Delay(1);
                    return {{result}};
                }
                #nullable disable
                public static void Main() {
                    Probe.Reset();
                    var row = Read("keep").GetAwaiter().GetResult();
                    bool valid = {{required}} != null && {{optional}} == null
                        && row.Code == 1 && row.Maybe == null && Probe.Calls == 2;
                    Probe.Reset();
                    bool asserted = false;
                    try { Read("miss").GetAwaiter().GetResult(); }
                    catch (NullReferenceException) { asserted = true; }
                    Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("Required NullableResultBox,", printed);
        Assert.Contains("Optional NullAcceptingBox?", printed);
        Assert.Contains("NullableResultBox?(value)!!", printed);
    }

    [Theory]
    [InlineData("Task", false)]
    [InlineData("ValueTask", false)]
    [InlineData("Task", true)]
    [InlineData("ValueTask", true)]
    public void TupleContractEligibility_ObliviousSourceContractsPromoteTogether(string envelope, bool enabledDefault)
    {
        string fixture = this.EmitFixture();
        string source = $$"""
            #nullable disable
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public interface ISourceRows {
                {{envelope}}<((NullAcceptingBox Missing, ReferenceBox Keep) Pair, int Code, int? Maybe)> Read(string value);
            }
            public sealed class Rows : ISourceRows {
                public async {{envelope}}<((NullAcceptingBox Missing, ReferenceBox Keep) Pair, int Code, int? Maybe)> Read(string value) {
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
            }
            """;
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Snippet.cs", source) },
            CSharpProjectLoader.RuntimeReferences().Append(MetadataReference.CreateFromFile(fixture)).ToArray());
        var compilation = project.Compilation.WithOptions(project.Compilation.Options.WithNullableContextOptions(
            enabledDefault ? NullableContextOptions.Enable : NullableContextOptions.Disable));
        Assert.DoesNotContain(compilation.GetDiagnostics(), diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        LoadedDocument document = Assert.Single(project.Documents);
        var model = compilation.GetSemanticModel(document.SyntaxTree);
        var context = new TranslationContext(compilation, model, document.FilePath);
        string printed = GSharpPrinter.Print(new CSharpToGSharpTranslator().TranslateDocument(
            new LoadedDocument(document.FilePath, document.SyntaxTree, model), context));
        Assert.Contains("Missing NullAcceptingBox?", printed);
        Assert.Contains("Keep ReferenceBox", printed);
        Assert.DoesNotContain("Keep ReferenceBox?", printed);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void TupleContractEligibility_NativeLockPropagatesAcrossSourceContractComponent(string envelope)
    {
        string fixture = this.EmitFixture();
        string suffix = envelope == "Task" ? "Task" : "ValueTask";
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public interface ISourceRows {
                {{envelope}}<(NullableResultBox Required, int Code)> Read(string value);
            }
            public sealed class Locked : RowsBase{{suffix}}, ISourceRows {
                public override async {{envelope}}<(NullableResultBox Required, int Code)> Read(string value) {
                    await Task.Delay(1);
                    return (value, 1);
                }
            }
            public sealed class Other : ISourceRows {
                public async {{envelope}}<(NullableResultBox Required, int Code)> Read(string value) {
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
            }
            """, fixture);
        Assert.DoesNotContain("Required NullableResultBox?", printed);
        Assert.Contains("NullableResultBox?(value)!!", printed);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
    }

    [Theory]
    [InlineData("Task", "interface")]
    [InlineData("ValueTask", "interface")]
    [InlineData("Task", "explicit")]
    [InlineData("ValueTask", "explicit")]
    [InlineData("Task", "base")]
    [InlineData("ValueTask", "base")]
    [InlineData("Task", "generic-interface")]
    [InlineData("ValueTask", "generic-interface")]
    [InlineData("Task", "generic-base")]
    [InlineData("ValueTask", "generic-base")]
    public void TupleContractEligibility_NativeInheritedReturnContractIsImmutable(string envelope, string contract)
    {
        string fixture = this.EmitFixture();
        string suffix = envelope == "Task" ? "Task" : "ValueTask";
        string inherited = contract switch
        {
            "base" => "RowsBase" + suffix,
            "generic-base" => $"GenericRowsBase{suffix}<NullableResultBox>",
            "generic-interface" => $"IGenericRows{suffix}<NullableResultBox>",
            _ => "IRows" + suffix,
        };
        string method = contract == "explicit" ? $"{inherited}.Read" : "Read";
        bool isBase = contract.Contains("base", StringComparison.Ordinal);
        string modifiers = isBase ? "public override async"
            : contract == "explicit" ? "async" : "public async";
        string tuple = isBase ? "(NullableResultBox Required, int Code)"
            : "(NullableResultBox Required, NullAcceptingBox Optional, int Code)";
        string result = isBase ? "(value, 1)" : "(value, (string?)null, 1)";
        string optional = isBase ? string.Empty : "&& row.Optional == null";
        int calls = isBase ? 1 : 2;
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public sealed class Rows : {{inherited}} {
                {{modifiers}} {{envelope}}<{{tuple}}> {{method}}(string value) {
                    await Task.Delay(1);
                    return {{result}};
                }
            }
            public static class Obj {
                public static void Main() {
                    Probe.Reset();
                    var row = NativeRows.Read(({{inherited}})new Rows(), "keep").GetAwaiter().GetResult();
                    bool valid = row.Required != null {{optional}}
                        && row.Code == 1 && Probe.Calls == {{calls}};
                    Probe.Reset();
                    bool asserted = false;
                    try { NativeRows.Read(({{inherited}})new Rows(), "miss").GetAwaiter().GetResult(); }
                    catch (NullReferenceException) { asserted = true; }
                    Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("Required NullableResultBox,", printed);
        if (!isBase)
        {
            Assert.Contains("Optional NullAcceptingBox?", printed);
        }
        Assert.Contains("NullableResultBox?(value)!!", printed);
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void TupleContractEligibility_ExactNativeNonNullContractRejectsNilOnce(string envelope)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public sealed class Rows : IAlwaysRows{{envelope}} {
                public async {{envelope}}<(MaybeBox Value, int Code)> Read(string value) {
                    await Task.Delay(1);
                    return (value, 1);
                }
            }
            public static class Obj {
                public static void Main() {
                    Probe.Reset();
                    bool asserted = false;
                    IAlwaysRows{{envelope}} rows = new Rows();
                    try { NativeRows.Read(rows, "x").GetAwaiter().GetResult(); }
                    catch (NullReferenceException) { asserted = true; }
                    Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        Assert.Contains("Value MaybeBox,", printed);
        Assert.Contains("MaybeBox?(value)!!", printed);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
    }

    [Theory]
    [InlineData("Task", false)]
    [InlineData("ValueTask", false)]
    [InlineData("Task", true)]
    [InlineData("ValueTask", true)]
    public void TupleContractEligibility_PartialDefinitionControlsOnlyItsOwnLeaves(string envelope, bool strict)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public static partial class Obj {
                #nullable {{(strict ? "enable" : "disable")}}
                public static partial {{envelope}}<(MaybeBox Value, int Code)> Read(string value);
                #nullable disable
                public static async partial {{envelope}}<(MaybeBox Value, int Code)> Read(string value) {
                    await Task.Delay(1);
                    return (value, 1);
                }
                public static void Main() {
                    Probe.Reset();
                    bool nil = false;
                    bool asserted = false;
                    try { nil = Read("x").GetAwaiter().GetResult().Value == null; }
                    catch (NullReferenceException) { asserted = true; }
                    bool valid = {{(strict ? "asserted" : "!asserted && nil")}};
                    Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        Assert.Contains(strict ? "MaybeBox?(value)!!" : "Value MaybeBox?", printed);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
    }

    [Theory]
    [InlineData("enable")]
    [InlineData("disable")]
    public void TupleContractEligibility_LocalMethodUsesItsDeclarationContext(string directive)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
            using Issue4719Fixture;
            public static class Obj {
                public static void Main() {
                    #nullable {{directive}}
                    (MaybeBox Value, int Code) Read(string value) => (value, 1);
                    #nullable disable
                    Probe.Reset();
                    bool nil = false;
                    bool asserted = false;
                    try { nil = Read("x").Value == null; }
                    catch (NullReferenceException) { asserted = true; }
                    bool valid = {{(directive == "enable" ? "asserted" : "!asserted && nil")}};
                    Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        Assert.Contains(directive == "enable" ? "MaybeBox?(value)!!" : "Value MaybeBox?", printed);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
    }

    [Theory]
    [InlineData("field")]
    [InlineData("property")]
    [InlineData("argument")]
    [InlineData("delegate")]
    public void TupleContractEligibility_FrozenNativeStoresRetainTheirResultBridge(string store)
    {
        string fixture = this.EmitFixture();
        string body = store switch
        {
            "field" => "NativeTupleSlots.Field = (value, 1); return NativeTupleSlots.Field.Code;",
            "property" => "NativeTupleSlots.Property = (value, 1); return NativeTupleSlots.Property.Code;",
            "argument" => "return NativeTupleSlots.Accept((value, 1));",
            _ => "NativeTupleSlots.Factory factory = Make; return factory(value).Code;",
        };
        string maker = store == "delegate"
            ? "public static (NullableResultBox Required, int Code) Make(string value) => (value, 1);"
            : string.Empty;
        string printed = Translate($$"""
            using System;
            using Issue4719Fixture;
            public static class Obj {
                {{maker}}
                public static int Store(string value) { {{body}} }
                public static void Main() {
                    Probe.Reset();
                    bool valid = Store("keep") == 1 && Probe.Calls == 1;
                    Probe.Reset();
                    bool asserted = false;
                    try { Store("miss"); }
                    catch (NullReferenceException) { asserted = true; }
                    Console.WriteLine(valid && asserted && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        Assert.Contains("NullableResultBox?(value)!!", printed);
        Assert.DoesNotContain("Required NullableResultBox?", printed);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void ScalarYieldNullableOperator_GuardedReadPreservesTheConvertedResult(bool local, bool strict)
    {
        string fixture = this.EmitFixture();
        string declaration = local ? "string text = value;" : string.Empty;
        string read = local ? "text" : "value";
        string printed = Translate($$"""
            using System;
            using System.Collections.Generic;
            using Issue4719Fixture;
            public static class Obj {
                #nullable {{(strict ? "enable" : "disable")}}
                public static IEnumerable<MaybeBox> Rows(string value) {
                    {{declaration}}
                    if ({{read}} != null) { yield return {{read}}; }
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
                    bool valid = {{(strict ? "asserted" : "!asserted && nil")}};
                    Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains(strict ? "sequence[MaybeBox]" : "sequence[MaybeBox?]", printed);
    }

    [Theory]
    [InlineData("Iterator", false, false)]
    [InlineData("Iterator", true, false)]
    [InlineData("Iterator", false, true)]
    [InlineData("Iterator", true, true)]
    [InlineData("Task", true, false)]
    [InlineData("ValueTask", true, false)]
    public void TupleContractProjection_ParenthesizedDestinationPreservesTheLeaf(
        string envelope,
        bool nested,
        bool strict)
    {
        string fixture = this.EmitFixture();
        string tuple = nested ? "((MaybeBox Value, string Keep) Pair, int Code)" : "(MaybeBox Value, int Code)";
        string value = nested ? "((((value, \"keep\")), 1))" : "((value, 1))";
        string check = nested ? "row.Pair.Value == null && row.Pair.Keep == \"keep\"" : "row.Value == null";
        string method = envelope == "Iterator"
            ? $"public static IEnumerable<{tuple}> Rows(string value) {{ yield return {value}; }}"
            : $"public static async {envelope}<{tuple}> Rows(string value) {{ await Task.Delay(1); return {value}; }}";
        string consume = envelope == "Iterator"
            ? $"foreach (var row in Rows(\"x\")) {{ nil = {check} && row.Code == 1; }}"
            : $"var row = Rows(\"x\").GetAwaiter().GetResult(); nil = {check} && row.Code == 1;";
        string printed = Translate($$"""
            using System;
            using System.Collections.Generic;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public static class Obj {
                #nullable {{(strict ? "enable" : "disable")}}
                {{method}}
                #nullable disable
                public static void Main() {
                    Probe.Reset();
                    bool nil = false;
                    bool asserted = false;
                    try { {{consume}} }
                    catch (NullReferenceException) { asserted = true; }
                    bool valid = {{(strict ? "asserted" : "!asserted && nil")}};
                    Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains(strict ? "Value MaybeBox," : "Value MaybeBox?", printed);
    }

    [Theory]
    [InlineData("interface", false)]
    [InlineData("interface", true)]
    [InlineData("base", false)]
    [InlineData("base", true)]
    public void TupleContractProjection_WholeNativeTypeArgumentRemainsCallerOwned(string contract, bool strict)
    {
        string fixture = this.EmitFixture();
        string inherited = contract == "interface" ? "IWholeRows" : "WholeRowsBase";
        string modifiers = contract == "base" ? "public override" : "public";
        string printed = Translate($$"""
            using System;
            using Issue4719Fixture;
            #nullable {{(strict ? "enable" : "disable")}}
            public sealed class Rows : {{inherited}}<(MaybeBox Value, int Code)> {
                {{modifiers}} (MaybeBox Value, int Code) Read(string value) => (value, 1);
            }
            #nullable disable
            public static class Obj {
                public static void Main() {
                    Probe.Reset();
                    bool nil = false;
                    bool asserted = false;
                    {{inherited}}<(MaybeBox Value, int Code)> rows = new Rows();
                    try {
                        var row = NativeRows.Read(rows, "x");
                        nil = row.Value == null && row.Code == 1;
                    }
                    catch (NullReferenceException) { asserted = true; }
                    bool valid = {{(strict ? "asserted" : "!asserted && nil")}};
                    Console.WriteLine(valid && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains(strict ? "Value MaybeBox," : "Value MaybeBox?", printed);
    }

    [Theory]
    [InlineData("Task")]
    [InlineData("ValueTask")]
    public void TupleContractProjection_UnrelatedTupleArgumentDoesNotUnlockNativeReferenceSlot(string envelope)
    {
        string fixture = this.EmitFixture();
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public sealed class Rows : IMixedRows{{envelope}}<MaybeBox, (string Text, int Code)> {
                public async {{envelope}}<(MaybeBox Value, int Code)> Read(string value) {
                    await Task.Delay(1);
                    return (value, 1);
                }
            }
            public static class Obj {
                public static void Main() {
                    Probe.Reset();
                    bool asserted = false;
                    IMixedRows{{envelope}}<MaybeBox, (string Text, int Code)> rows = new Rows();
                    try { rows.Read("x").GetAwaiter().GetResult(); }
                    catch (NullReferenceException) { asserted = true; }
                    Console.WriteLine(asserted && Probe.Calls == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("Value MaybeBox,", printed);
        Assert.Contains("MaybeBox?(value)!!", printed);
    }

    [Theory]
    [InlineData("Sync", false, false)]
    [InlineData("Sync", true, false)]
    [InlineData("Sync", false, true)]
    [InlineData("Sync", true, true)]
    [InlineData("Iterator", false, false)]
    [InlineData("Iterator", true, false)]
    [InlineData("Iterator", false, true)]
    [InlineData("Iterator", true, true)]
    [InlineData("Task", false, false)]
    [InlineData("Task", true, false)]
    [InlineData("Task", false, true)]
    [InlineData("Task", true, true)]
    [InlineData("ValueTask", false, false)]
    [InlineData("ValueTask", true, false)]
    [InlineData("ValueTask", false, true)]
    [InlineData("ValueTask", true, true)]
    public void TupleContractContext_MixedBranchArmsUseTheEmittedDestination(
        string envelope,
        bool switchArm,
        bool strict)
    {
        string fixture = this.EmitFixture();
        string value = switchArm
            ? "Choose(choose) switch { true => \"x\", false => new MaybeBox() }"
            : "Choose(choose) ? \"x\" : new MaybeBox()";
        string tuple = "(MaybeBox Value, int Code)";
        string method = envelope switch
        {
            "Sync" => $"public static {tuple} Rows(bool choose) => ({value}, 1);",
            "Iterator" => $"public static IEnumerable<{tuple}> Rows(bool choose) {{ yield return ({value}, 1); }}",
            _ => $"public static async {envelope}<{tuple}> Rows(bool choose) {{ await Task.Delay(1); return ({value}, 1); }}",
        };
        string consume = envelope switch
        {
            "Sync" => "var row = Rows(choose); nil = row.Value == null && row.Code == 1;",
            "Iterator" => "foreach (var row in Rows(choose)) { nil = row.Value == null && row.Code == 1; }",
            _ => "var row = Rows(choose).GetAwaiter().GetResult(); nil = row.Value == null && row.Code == 1;",
        };
        string printed = Translate($$"""
            using System;
            using System.Collections.Generic;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            public static class Obj {
                public static int Decisions;
                public static bool Choose(bool choose) { Decisions++; return choose; }
                #nullable {{(strict ? "enable" : "disable")}}
                {{method}}
                #nullable disable
                public static bool Check(bool choose) {
                    bool nil = false;
                    bool asserted = false;
                    try { {{consume}} }
                    catch (NullReferenceException) { asserted = true; }
                    bool valid = choose ? {{(strict ? "asserted" : "!asserted && nil")}} : !asserted && !nil;
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
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains(strict ? "Value MaybeBox," : "Value MaybeBox?", printed);
    }

    [Theory]
    [InlineData("Sync", "own", false)]
    [InlineData("Sync", "own", true)]
    [InlineData("Task", "own", false)]
    [InlineData("Task", "own", true)]
    [InlineData("ValueTask", "own", false)]
    [InlineData("ValueTask", "own", true)]
    [InlineData("Sync", "source", false)]
    [InlineData("Sync", "source", true)]
    public void TupleContractContext_SourceContainingGenericRetainsItsActualContract(
        string envelope,
        string contract,
        bool strict)
    {
        string fixture = this.EmitFixture();
        string method = envelope == "Sync"
            ? "public (T Value, int Code) Read(bool missing) => (missing ? null : (T)(object)\"keep\", 1);"
            : $"public async {envelope}<(T Value, int Code)> Read(bool missing) {{ await Task.Delay(1); return (missing ? null : (T)(object)\"keep\", 1); }}";
        string interfaceDeclaration = contract == "source"
            ? $"#nullable {(strict ? "enable" : "disable")}\npublic interface IRows<T> where T : class {{ (T Value, int Code) Read(bool missing); }}"
            : string.Empty;
        string inherited = contract switch
        {
            "source" => " : IRows<T>",
            _ => string.Empty,
        };
        string receiver = contract switch
        {
            "source" => "IRows<string>",
            _ => "Rows<string>",
        };
        string read = envelope == "Sync"
            ? "rows.Read(missing)"
            : "rows.Read(missing).GetAwaiter().GetResult()";
        string printed = Translate($$"""
            using System;
            using System.Threading.Tasks;
            using Issue4719Fixture;
            {{interfaceDeclaration}}
            #nullable {{(strict && contract == "own" ? "enable" : "disable")}}
            public sealed class Rows<T>{{inherited}} where T : class {
                {{method}}
            }
            #nullable disable
            public static class Obj {
                public static bool Check(bool missing) {
                    {{receiver}} rows = new Rows<string>();
                    bool nil = false;
                    bool asserted = false;
                    try {
                        var row = {{read}};
                        nil = row.Value == null && row.Code == 1;
                        if (!missing && (row.Value != "keep" || row.Code != 1)) { return false; }
                    }
                    catch (NullReferenceException) { asserted = true; }
                    return missing ? {{(strict ? "asserted" : "!asserted && nil")}} : !asserted && !nil;
                }
                public static void Main() { Console.WriteLine(Check(true) && Check(false) ? 15 : -1); }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains(strict ? "Value T," : "Value T?", printed);
    }

    [Fact]
    public void TupleContractContext_SourceGenericLiteralUsesNullableLeaf()
    {
        string fixture = this.EmitFixture();
        string printed = Translate("""
            using System;
            using Issue4719Fixture;
            public sealed class Rows<T> where T : class {
                public (T Value, int Code) Read() => (null, 1);
            }
            public static class Obj {
                public static void Main() {
                    var row = new Rows<string>().Read();
                    Console.WriteLine(row.Value == null && row.Code == 1 ? 15 : -1);
                }
            }
            """, fixture);
        AssertRealDriverVerifiesAndRuns(printed, fixture, "15");
        Assert.Contains("func Read() (Value T?, Code int32)", printed);
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

    private void AssertRealDriverVerifiesAndRuns(string printed, string fixture, string expected)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture });
        TranslationTestValidation.AssertBinds(resolver, printed);
        string source = Path.Combine(this.fixtureDirectory, "Boundaries.gs");
        string assembly = Path.Combine(this.fixtureDirectory, "Boundaries.dll");
        string compiler = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Compiler", "gsc.dll"));
        File.WriteAllText(source, printed);
        var compiled = RunDotnet(compiler, "/target:exe", "/targetframework:net10.0", $"/reference:{fixture}", $"/out:{assembly}", source);
        Assert.True(compiled.Exit == 0, printed + Environment.NewLine + compiled.Output);
        Assert.True(IlVerifyRunner.IsEnabled);
        IlVerifyResult verified = new IlVerifyRunner().Verify(assembly, new[] { fixture });
        Assert.Equal(IlVerifyStatus.Passed, verified.Status);
        Assert.Empty(verified.Errors);
        File.WriteAllText(
            Path.ChangeExtension(assembly, ".runtimeconfig.json"),
            "{\"runtimeOptions\":{\"tfm\":\"net10.0\",\"framework\":{\"name\":\"Microsoft.NETCore.App\",\"version\":\"10.0.0\"}}}");
        var executed = RunDotnet(assembly);
        Assert.True(executed.Exit == 0, printed + Environment.NewLine + executed.Output);
        Assert.True(executed.Output == expected + Environment.NewLine, printed + Environment.NewLine + executed.Output);
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
        Assert.False(result.Diagnostics.Any(diagnostic => diagnostic.IsError), printed + Environment.NewLine + string.Join(Environment.NewLine, result.Diagnostics));
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

    private static string Translate(string source, string fixture = null) =>
        TranslateWithContext(source, fixture).Printed;

    private static (string Printed, TranslationContext Context) TranslateWithContext(string source, string fixture)
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
        return (GSharpPrinter.Print(unit), context);
    }
}
