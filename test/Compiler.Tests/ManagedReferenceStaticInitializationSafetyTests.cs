// <copyright file="ManagedReferenceStaticInitializationSafetyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Gsharp.Values;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceStaticInitializationSafetyTests
{
    [Theory]
    [InlineData("class Bad { shared { prop Value managed[int32] { get; set; } } }")]
    [InlineData("struct Bad { shared { prop Value readonly managed[int32] { get; set; } } }")]
    [InlineData("class Bad { shared { var Value managed[int32] } }")]
    [InlineData("struct Bad[T] { shared { var Value readonly managed[T] } }")]
    [InlineData(
        """
        struct Wrapper { var Value managed[int32] }
        class Bad { shared { var Value Wrapper } }
        """)]
    public void StaticAutoPropertyStorageRequiresInitialization(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            "package StaticManagedReferenceReject\n" + declaration,
            "StaticManagedReferenceReject",
            executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void StaticInitializerMustAssignRequiredStorageOnEveryPath()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            """
            package StaticManagedReferencePathReject
            class Bad {
                shared {
                    var Value managed[int32]
                    init {
                        if DateTime.Now.Ticks > 0 {
                            var local = 1
                            Value = managed(local)
                        }
                    }
                }
            }
            """, "StaticManagedReferencePathReject", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void InitializedStaticFieldsPropertiesAndNullableControlsReimportAndVerify()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "StaticManagedReferenceApi.ref.dll");
        var api = fixture.Compile(
            """
            package StaticManagedReferenceApi
            public class Holder[T] {
                shared {
                    public var Field readonly managed[T]
                    public prop Property readonly managed[T] { get; set; }
                    public var Optional managed[T]?
                    public prop OptionalProperty readonly managed[T]? { get; set; }
                    init {
                        var first T = default
                        Field = readonly managed(first)
                        var second T = default
                        Property = readonly managed(second)
                    }
                }
            }
            """, "StaticManagedReferenceApi", executable: false, "/refout:" + reference);
        IlVerifier.Verify(api);
        var consumer = fixture.CompileCSharp(
            """
            using StaticManagedReferenceApi;
            public static class Consumer {
                public static int Run() {
                    ref readonly var field = ref Holder<int>.Field.Borrow();
                    ref readonly var property = ref Holder<int>.Property.Borrow();
                    return field + property
                        + (Holder<int>.Optional is null ? 20 : 0)
                        + (Holder<int>.OptionalProperty is null ? 22 : 0);
                }
            }
            """, "StaticManagedReferenceConsumer", api, reference);
        IlVerifier.Verify(consumer, new[] { api });
        var assemblies = EmittedFixture.LoadTogether(api, consumer);
        Assert.Equal(42, assemblies[1].GetType("Consumer")!.GetMethod("Run")!.Invoke(null, null));
    }

    [Fact]
    public void StaticRequiredInitializationSurvivesRepeatedEmitAndRefout()
    {
        const string source = """
            package RepeatedStaticManagedReference
            public struct Holder {
                shared {
                    public var Field managed[int32] = {
                        var value = 42
                        managed(value)
                    }
                }
            }
            """;
        using var references = ReferenceResolver.WithRuntimeReferences(new[] { typeof(ManagedRef<>).Assembly.Location });
        var compilation = new Compilation(references, SyntaxTree.Parse(source)) { IsLibrary = true };
        Assert.Empty(compilation.BoundProgram.Diagnostics);
        for (var i = 0; i < 2; i++)
        {
            using var pe = new MemoryStream();
            using var reference = new MemoryStream();
            var result = compilation.Emit(pe, null, reference);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
            Assert.True(pe.Length > 0);
            Assert.True(reference.Length > 0);
        }
    }
}
