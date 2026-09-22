// <copyright file="ManagedReferenceScopedValueTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceScopedValueTests
{
    [Theory]
    [InlineData("managed[int32]", "return (*location, 7)")]
    [InlineData("managed[int32]?", "return (*(location!!), 7)")]
    [InlineData("managed[int32]?", "let copied = *(location!!)\nreturn (copied, 7)")]
    [InlineData("managed[int32]?", "return (*(location!!) + 1 - 1, 7)")]
    [InlineData("managed[int32]?", "return (location != nil ? *(location!!) : 0, 7)")]
    [InlineData("managed[int32]?", "return Values(*(location!!))")]
    [InlineData("managed[int32]?", "return (ReadScoped(location!!), 7)")]
    [InlineData("managed[int32]?", "return (ReadNullableScoped(location), 7)")]
    [InlineData("managed[int32]", "let nested = (*location, (*location, 7))\nreturn (nested.Item1, nested.Item2.Item2)")]
    [InlineData("managed[int32]?", "let values = []int32{*(location!!)}\nreturn (values[0], 7)")]
    [InlineData("managed[int32]?", "let holder = Holder{Number: *(location!!)}\nreturn (holder.Number, 7)")]
    [InlineData("managed[int32]?", "let copied = *(location!!)\nlet read = func () int32 { return copied }\nreturn (read(), 7)")]
    [InlineData("managed[int32]?", "let value = location?.Borrow() ?? 0\nreturn (value, 7)")]
    [InlineData("managed[int32]", "return (switch *location { case 42: *location default: 0 }, 7)")]
    public void CopiedResultsDoNotRetainScopedHandle(string parameterType, string body)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ScopedManagedCopies
            import System
            class Holder { var Number int32 }
            func Values(value int32) (int32, int32) { return (value, 7) }
            func ReadScoped(scoped value managed[int32]) int32 { return *value }
            func ReadNullableScoped(scoped value managed[int32]?) int32 { return *(value!!) }
            func Copy(scoped location {{parameterType}}) (int32, int32) {
                {{body}}
            }
            func Main() {
                var value = 42
                let location = managed(value)
                let copied = Copy(location)
                value = 99
                Console.WriteLine(copied.Item1)
                Console.WriteLine(copied.Item2)
            }
            """;
        var dll = fixture.Compile(source, "ScopedManagedCopies", executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("42\n7\n", fixture.Run(dll));
    }

    [Theory]
    [InlineData("managed[int32]", "return location!!")]
    [InlineData("managed[int32]?", "return location")]
    [InlineData("managed[int32]", "let refined = location!!\nreturn refined")]
    [InlineData("readonly managed[int32]", "return (location!!).AsReadOnly()")]
    [InlineData("managed[int32]", "return managed(*(location!!))")]
    [InlineData("void", "let holder = Holder()\nholder.Value = location!!")]
    [InlineData("void", "let holder = Holder{Value: location!!}")]
    [InlineData("void", "let slots = []managed[int32]?{nil}\nslots[0] = location!!")]
    [InlineData("void", "Take(location!!)")]
    [InlineData("void", "let refined = location!!\nlet retained = func () int32 { return *refined }")]
    [InlineData("void", "let retained = func () int32 { return *(location!!) }")]
    [InlineData("(managed[int32], int32)", "return (location!!, 7)")]
    [InlineData("(int32, (managed[int32], int32))", "return (7, (location!!, 9))")]
    [InlineData("object", "let erased object = location!!\nreturn erased")]
    [InlineData("object?", "return location as object")]
    [InlineData("managed[int32]", "var local = 0\nlet fallback = managed(local)\nreturn location ?? fallback")]
    [InlineData("managed[int32]", "let fallback managed[int32]? = nil\nreturn fallback ?? location!!")]
    [InlineData("managed[int32]?", "return switch true { case true: location default: nil }")]
    [InlineData("readonly managed[int32]?", "return location?.AsReadOnly()")]
    public void RefinementDoesNotPermitRealEscapes(string returnType, string body)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ScopedManagedEscapes
            class Holder { var Value managed[int32]? }
            func Take(value managed[int32]) { }
            func Escape(scoped location managed[int32]?) {{returnType}} {
                {{body}}
            }
            """;
        var (code, output) = fixture.TryCompile(source, "ScopedManagedEscapes", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void RefinedEscapeDiagnosticPointsAtReturnSite()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        const string source = """
            package ScopedManagedLocation
            func Escape(scoped location managed[int32]?) managed[int32] {
                return location!!
            }
            """;
        var (code, output) = fixture.TryCompile(source, "ScopedManagedLocation", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("ScopedManagedLocation.gs(3,5,3,22): error GS0604:", output, StringComparison.Ordinal);
    }
}
