// <copyright file="Issue3394BoxingCastTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

/// Issue #3394: an explicit value-type-to-interface boxing cast retains its
/// target type without being misrendered as interface construction.
open class Issue3394BoxingCastTranslationTests {
    @Fact
    func OpcodePrefixCombination_WidensBeforeBitwiseOr() {
        const source = `
namespace Demo
{
    public static class C
    {
        public static short Decode(byte next)
        {
            int encodedKey = 0xFE00 | next;
            return unchecked((short)encodedKey);
        }
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("let encodedKey = 0xFE00 | int32(next)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("uint8(0xFE00)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func SameCompilationReferenceDowncast_UsesCheckedCast() {
        const source = `
namespace Demo
{
    public class Base {}
    public class Derived : Base {}

    public static class C
    {
        public static Derived Cast(Base value) => (Derived)value;
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("cast[Derived](value)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain(" as Derived", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    /// ADR-0166 / issue #3409: a type-parameter scrutinee with a constrained
    /// reference target is a native pattern variable — no scoped `if let`
    /// and no `as` conversion of the type parameter.
    @Fact
    func TypeParameterPatternBinding_UsesNativePatternVariable() {
        const source = `
using System.Reflection;

namespace Demo
{
    public static class C
    {
        public static bool Check<T>(T value) where T : MemberInfo
        {
            if (value is MethodInfo method && method.IsGenericMethod)
            {
                return method.GetGenericArguments().Length > 0;
            }

            return false;
        }
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("if value is MethodInfo method && method.IsGenericMethod {", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("if let", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("as MethodInfo", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    /// ADR-0166 / issue #3409: the binder read in the `&&` right
    /// operand is a native pattern variable, so no narrowing cast is emitted at
    /// all — neither the `(value as Candidate)!!` substitution nor the
    /// `Candidate(value)` construction misrender this issue guards against.
    @Fact
    func ShortCircuitPatternBinding_UsesNativePatternVariable() {
        const source = `
namespace Demo
{
    public class Base {}
    public sealed class Candidate : Base { public int Value; }

    public static class C
    {
        public static bool Check(Base value) =>
            value is Candidate candidate && candidate.Value > 0;
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("value is Candidate candidate && candidate.Value > 0", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("as Candidate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("Candidate(value)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("!!", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    /// ADR-0166 / issue #3409: a bare `{ } present` designation over a
    /// nullable value in a switch `when` guard is a native pattern variable
    /// scoped to the arm body, so the arm reads `present` directly — no
    /// `value!!` assertion and no `int32(value)` conversion.
    @Fact
    func BareRecursivePatternOnNullableValue_UsesNativePatternVariable() {
        const source = `
namespace Demo
{
    public static class C
    {
        public static int Read(int? value)
        {
            switch (0)
            {
                case 0 when value is { } present:
                    return present;
                default:
                    return 0;
            }
        }
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("case 0 when value is { } present {", rendered, StringComparison.Ordinal)
        Assert.Contains("return present", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("value!!", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("int32(value)", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func ImmutableArrayToReadOnlyList_UsesUnambiguousInterfaceCast() {
        const source = `
using System.Collections.Generic;
using System.Collections.Immutable;
namespace Demo
{
    public static class C
    {
        private static int Count(IReadOnlyList<string> values) => values.Count;

        public static int Read(ImmutableArray<string> values) =>
            Count((IReadOnlyList<string>)values);
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("cast[IReadOnlyList[string]](values)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__cast", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("values as IReadOnlyList[string]", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func InferredLocal_BoxingCastKeepsInterfaceTypeAndRuns() {
        const source = `
namespace Demo
{
    public interface IValue
    {
        int Read();
    }

    public struct Value : IValue
    {
        public int Read() => 7;
    }

    public sealed class C
    {
        public int Run()
        {
            var value = new Value();
            var boxed = (IValue)value;
            return boxed.Read();
        }
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("let boxed = cast[IValue](value)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__cast", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("value as IValue", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let result = EmittedOracle.Evaluate(rendered + Environment.NewLine + "C().Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal(7, result.Value)
    }

    @Fact
    func NullableInterfaceBoxingCast_PreservesNullableAnnotation() {
        const source = `
#nullable enable
namespace Demo
{
    public interface IValue { }
    public struct Value : IValue { }

    public static class C
    {
        public static IValue? Box(Value value) => (IValue?)value;
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("cast[IValue?](value)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("value as IValue?", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__cast", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
    }

    @Fact
    func NullableValueToNonNullableInterfaceBoxing_PreservesNilAndValue() {
        const source = `
#nullable enable
namespace Demo
{
    public interface IValue
    {
        int Read();
    }

    public struct Value : IValue
    {
        public int Read() => 7;
    }

    public sealed class C
    {
        public IValue Return(Value? value) => (IValue)value;

        public bool AssignIsNil(Value? value)
        {
            IValue boxed = (IValue)value;
            return boxed is null;
        }
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("cast[IValue](value)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("value as IValue", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("__cast", rendered, StringComparison.Ordinal)
        TranslationTestValidation.AssertBinds(rendered)
        let returnNil = EmittedOracle.Evaluate(rendered + Environment.NewLine + "C().Return(default(Value?))")
        Assert.Empty(returnNil.Diagnostics)
        Assert.Null(returnNil.UnhandledException)
        Assert.Null(returnNil.Value)
        let assignedNil = EmittedOracle.Evaluate(rendered + Environment.NewLine + "C().AssignIsNil(default(Value?))")
        Assert.Empty(assignedNil.Diagnostics)
        Assert.Null(assignedNil.UnhandledException)
        Assert.Equal(true, assignedNil.Value)
        let assignedValue = EmittedOracle.Evaluate(rendered + Environment.NewLine + "C().AssignIsNil(Value{})")
        Assert.Empty(assignedValue.Diagnostics)
        Assert.Null(assignedValue.UnhandledException)
        Assert.Equal(false, assignedValue.Value)
        let returnValue = EmittedOracle.Evaluate(rendered + Environment.NewLine + "C().Return(Value{}).Read()")
        Assert.Empty(returnValue.Diagnostics)
        Assert.Null(returnValue.UnhandledException)
        Assert.Equal(7, returnValue.Value)
    }

    @Fact
    func ReferenceTypedUserDefinedCast_UsesConversionCall() {
        const source = `
using System.Text.Json.Nodes;
namespace Demo
{
    public static class C
    {
        public static string? Read(JsonObject value) => (string?)value["name"];
    }
}
`
        let rendered = Translate(source)
        Assert.Contains("string?(value[\"name\"])", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("as string", rendered, StringComparison.Ordinal)
        let roundTrip = TranslationTestValidation.ValidateRoundTripOnly(
            rendered,
            "The standalone binder fixture does not reference System.Text.Json.Nodes."
        )
        Assert.True(roundTrip.Success, string.Join(Environment.NewLine, roundTrip.Errors))
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
