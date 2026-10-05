// <copyright file="Issue4803QualifiedNestedConstructorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Reflection.Emit;
using GSharp.Core.Tests;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #4803: qualified nested construction retains its actual authored constructor.</summary>
/// <remarks>
/// ADR-0154: the unchanged final oracle is run red with the shared accessor root
/// exactly reverted, then green after restoring it. No field initializer or
/// unmerged initializer-ownership feature is involved.
/// </remarks>
public sealed class Issue4803QualifiedNestedConstructorTests
{
    [Theory]
    [InlineData("[T]", "Outer[int32]", "Outer<int>", "struct")]
    [InlineData("[T]", "Outer[string]", "Outer<string>", "struct")]
    [InlineData("", "Outer", "Outer", "struct")]
    [InlineData("[T]", "NestedAuthored4803.Outer[int32]", "Outer<int>", "struct")]
    [InlineData("[T]", "Outer[int32]", "Outer<int>", "class")]
    public void SourceQualifiedConstructor_TreeOrdinaryAndNativeCallsSelectSameOwner(
        string parameters, string qualifier, string nativeQualifier, string kind)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var typeQualifier = qualifier.Replace("NestedAuthored4803.", string.Empty, StringComparison.Ordinal);
        var library = fixture.Compile($$"""
            package NestedAuthored4803
            import System
            import System.Linq.Expressions
            public class Outer{{parameters}} {
                public {{kind}} User {
                    public var Value int32
                    public init() { Value = 99 }
                }
            }
            public class Api {
                shared {
                    public func Tree() Expression[Func[{{typeQualifier}}.User]] {
                        return () -> {{qualifier}}.User()
                    }
                    public func Ordinary() {{typeQualifier}}.User {
                        return {{qualifier}}.User()
                    }
                    public func Brace() {{typeQualifier}}.User {
                        return {{qualifier}}.User{}
                    }
                    public func Continuation() int32 { return {{qualifier}}.User().Value }
                    public func Initialized() int32 { return {{qualifier}}.User() { Value = 17 }.Value }
                }
            }
            """, "NestedAuthored4803", executable: false);
        using var consumer = new CSharpFixture($$"""
            using System;
            using System.Linq.Expressions;
            using NestedAuthored4803;
            public static class NativeConsumer {
                public static Expression<Func<{{nativeQualifier}}.User>> Tree() => Api.Tree();
                public static Expression<Func<{{nativeQualifier}}.User>> Control() =>
                    () => new {{nativeQualifier}}.User();
                public static {{nativeQualifier}}.User Ordinary() => new {{nativeQualifier}}.User();
            }
            """, new[] { MetadataReference.CreateFromFile(library) });
        IlVerifier.Verify(library);
        IlVerifier.Verify(consumer.AssemblyPath, new[] { library });
        var assemblies = EmittedFixture.LoadTogether(library, consumer.AssemblyPath);
        var api = assemblies[0].GetType("NestedAuthored4803.Api")
            ?? throw new InvalidOperationException("Missing source API.");
        var native = assemblies[1].GetType("NativeConsumer")
            ?? throw new InvalidOperationException("Missing native consumer.");
        AssertConstructorParity(api, native, assemblies[0].ManifestModule);
        var brace = Invoke(api, "Brace");
        Assert.Equal(GetMethod(api, "Ordinary").ReturnType, brace.GetType());
        Assert.Equal(99, Invoke(api, "Continuation"));
        Assert.Equal(17, Invoke(api, "Initialized"));
    }

    [Theory]
    [InlineData("User[string](41, \"own\")", false)]
    [InlineData("User(41, \"own\")", false)]
    [InlineData("User[string](41, \"own\")", true)]
    public void NestedOwnGenericArguments_ExplicitAndInferredRetainEnclosingConstruction(string call, bool homonym)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.Compile($$"""
            package NestedAuthored4803
            import System
            import System.Linq.Expressions
            public class Outer[T] {
                {{(homonym ? "public struct User { public var Wrong int32 }" : string.Empty)}}
                public struct User[U] {
                    public var Value T
                    public var Own U
                    public init(value T, own U) {
                        Value = value
                        Own = own
                    }
                    public init(value int32) {
                        Value = default(T)
                        Own = default(U)
                    }
                }
            }
            public class Api {
                shared {
                    public func Tree() Expression[Func[Outer[int32].User[string]]] {
                        return () -> Outer[int32].{{call}}
                    }
                    public func Ordinary() Outer[int32].User[string] {
                        return Outer[int32].{{call}}
                    }
                    public func Brace() Outer[int32].User[string] {
                        return Outer[int32].User[string]{Value: 41, Own: "own"}
                    }
                }
            }
            """, "NestedGeneric4803", executable: false, "/assemblyname:NestedGeneric4803");
        using var consumer = new CSharpFixture("""
            using System;
            using System.Linq.Expressions;
            using NestedAuthored4803;
            public static class NativeConsumer {
                public static Expression<Func<Outer<int>.User<string>>> Tree() => Api.Tree();
                public static Expression<Func<Outer<int>.User<string>>> Control() =>
                    () => new Outer<int>.User<string>(41, "own");
                public static Outer<int>.User<string> Ordinary() => new Outer<int>.User<string>(41, "own");
            }
            """, new[] { MetadataReference.CreateFromFile(library) });
        IlVerifier.Verify(library);
        IlVerifier.Verify(consumer.AssemblyPath, new[] { library });
        var assemblies = EmittedFixture.LoadTogether(library, consumer.AssemblyPath);
        var api = assemblies[0].GetType("NestedAuthored4803.Api")
            ?? throw new InvalidOperationException("Missing source API.");
        var native = assemblies[1].GetType("NativeConsumer")
            ?? throw new InvalidOperationException("Missing native consumer.");
        AssertConstructorParity(api, native, assemblies[0].ManifestModule, expectedValue: 41);
        var ordinary = Invoke(api, "Ordinary");
        Assert.Equal(new[] { typeof(int), typeof(string) }, ordinary.GetType().GenericTypeArguments);
        Assert.Equal("own", ordinary.GetType().GetField("Own")?.GetValue(ordinary));
        var brace = Invoke(api, "Brace");
        Assert.Equal(ordinary.GetType(), brace.GetType());
        Assert.Equal(41, ReadValue(brace));
        Assert.Equal("own", brace.GetType().GetField("Own")?.GetValue(brace));
    }

    [Fact]
    public void ImportedQualifiedConstructor_UsesNativeContractAndTreeControl()
    {
        using var contract = new CSharpFixture("""
            using System;
            using System.Linq.Expressions;
            namespace NativeNested4803;
            public class Outer {
                public struct User {
                    public int Value;
                    public User() { Value = 99; }
                }
            }
            public static class NativeConsumer {
                public static Expression<Func<Outer.User>> Control() => () => new Outer.User();
                public static Outer.User Ordinary() => new Outer.User();
            }
            """);
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.Compile("""
            package ImportedNested4803
            import System
            import System.Linq.Expressions
            import NativeNested4803
            public class Api {
                shared {
                    public func Tree() Expression[Func[Outer.User]] {
                        return () -> Outer.User()
                    }
                    public func Ordinary() Outer.User {
                        return Outer.User()
                    }
                    public func Brace() Outer.User {
                        return Outer.User{}
                    }
                }
            }
            """, "ImportedNested4803", executable: false, "/r:" + contract.AssemblyPath);
        IlVerifier.Verify(contract.AssemblyPath);
        IlVerifier.Verify(library, new[] { contract.AssemblyPath });
        var assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, library);
        var api = assemblies[1].GetType("ImportedNested4803.Api")
            ?? throw new InvalidOperationException("Missing imported API.");
        var native = assemblies[0].GetType("NativeNested4803.NativeConsumer")
            ?? throw new InvalidOperationException("Missing native contract.");
        AssertConstructorParity(api, native, assemblies[0].ManifestModule);
        Assert.Equal(GetMethod(api, "Ordinary").ReturnType, Invoke(api, "Brace").GetType());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NestedOwnerChain_DeepAndInheritedCallsRetainActualConstruction(bool inherited)
    {
        var declarations = inherited
            ? """
                public open class Base[T] {
                    public struct User {
                        public var Value int32
                        public init() { Value = 99 }
                    }
                }
                public class Outer[A, B] : Base[B] {}
                """
            : """
                public class Outer[T] {
                    public class Middle[U] {
                        public struct User {
                            public var Value int32
                            public init() { Value = 99 }
                        }
                    }
                }
                """;
        var qualifier = inherited ? "Outer[bool, int32]" : "Outer[int32].Middle[string]";
        var typeQualifier = inherited ? "Base[int32]" : qualifier;
        var nativeQualifier = inherited ? "Outer<bool, int>" : "Outer<int>.Middle<string>";
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.Compile($$"""
            package NestedOwner4803
            import System
            import System.Linq.Expressions
            {{declarations}}
            public struct User {
                public var Value int32
                public init() { Value = -7 }
            }
            public class Api {
                shared {
                    public func Tree() Expression[Func[{{typeQualifier}}.User]] {
                        return () -> {{qualifier}}.User()
                    }
                    public func Ordinary() {{typeQualifier}}.User {
                        return {{qualifier}}.User()
                    }
                    public func Brace() {{typeQualifier}}.User {
                        return {{qualifier}}.User{}
                    }
                    public func Simple() User { return User() }
                }
            }
            """, "NestedOwner4803", executable: false);
        using var consumer = new CSharpFixture($$"""
            using System;
            using System.Linq.Expressions;
            using NestedOwner4803;
            public static class NativeConsumer {
                public static Expression<Func<{{nativeQualifier}}.User>> Control() =>
                    () => new {{nativeQualifier}}.User();
                public static {{nativeQualifier}}.User Ordinary() => new {{nativeQualifier}}.User();
            }
            """, new[] { MetadataReference.CreateFromFile(library) });
        IlVerifier.Verify(library);
        IlVerifier.Verify(consumer.AssemblyPath, new[] { library });
        var assemblies = EmittedFixture.LoadTogether(library, consumer.AssemblyPath);
        var api = assemblies[0].GetType("NestedOwner4803.Api")
            ?? throw new InvalidOperationException("Missing source API.");
        var native = assemblies[1].GetType("NativeConsumer")
            ?? throw new InvalidOperationException("Missing native consumer.");
        AssertConstructorParity(api, native, assemblies[0].ManifestModule);
        Assert.Equal(GetMethod(api, "Ordinary").ReturnType, Invoke(api, "Brace").GetType());
        Assert.Equal(-7, ReadValue(Invoke(api, "Simple")));
        Assert.Equal(inherited ? new[] { typeof(int) } : new[] { typeof(int), typeof(string) },
            GetMethod(api, "Ordinary").ReturnType.GenericTypeArguments);
    }

    [Theory]
    [InlineData("User()", "GS0144")]
    [InlineData("User(\"wrong\")", "GS0154")]
    [InlineData("User[int32](1)", "GS0148")]
    public void QualifiedConstructor_InvalidArgumentsUseConstructorDiagnostics(string call, string diagnostic)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile($$"""
            package RejectedNested4803
            class Outer[T] {
                public struct User {
                    public var Value T
                    public init(value T) { Value = value }
                }
            }
            func Bad() { let rejected = Outer[int32].{{call}} }
            """, "RejectedNested4803", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains(diagnostic, output, StringComparison.Ordinal);
        Assert.Contains("RejectedNested4803.gs(8,", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0158", output, StringComparison.Ordinal);
        Assert.False(System.IO.File.Exists(System.IO.Path.Combine(fixture.Directory, "RejectedNested4803.dll")));
    }

    private static void AssertConstructorParity(
        Type api, Type native, Module ownerModule, int expectedValue = 99)
    {
        var tree = Assert.IsAssignableFrom<LambdaExpression>(Invoke(api, "Tree"));
        var control = Assert.IsAssignableFrom<LambdaExpression>(Invoke(native, "Control"));
        var construction = Assert.IsType<NewExpression>(tree.Body);
        var nativeConstruction = Assert.IsType<NewExpression>(control.Body);
        Assert.NotNull(construction.Constructor);
        Assert.NotNull(nativeConstruction.Constructor);
        Assert.Equal(nativeConstruction.Type, construction.Type);
        Assert.Equal(construction.Type, construction.Constructor.DeclaringType);
        Assert.Equal(ownerModule, construction.Constructor.Module);
        Assert.Equal(nativeConstruction.Constructor.MetadataToken, construction.Constructor.MetadataToken);
        Assert.Equal(nativeConstruction.Constructor.Module, construction.Constructor.Module);
        Assert.Equal(
            nativeConstruction.Constructor.GetParameters().Select(parameter => parameter.ParameterType),
            construction.Constructor.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.Equal(
            nativeConstruction.Arguments.Select(argument => Assert.IsType<ConstantExpression>(argument).Value),
            construction.Arguments.Select(argument => Assert.IsType<ConstantExpression>(argument).Value));
        Assert.NotEmpty(construction.Type.GetConstructors());
        Assert.Contains(construction.Type.GetConstructors(),
            constructor => constructor.MetadataToken == construction.Constructor.MetadataToken);
        foreach (var value in new[]
        {
            tree.Compile().DynamicInvoke(),
            control.Compile().DynamicInvoke(),
            Invoke(api, "Ordinary"),
            Invoke(native, "Ordinary"),
        })
        {
            Assert.NotNull(value);
            Assert.Equal(construction.Type, value.GetType());
            Assert.Equal(expectedValue, ReadValue(value));
        }

        var ordinary = GetMethod(api, "Ordinary");
        var body = ordinary.GetMethodBody()?.GetILAsByteArray()
            ?? throw new InvalidOperationException("Missing ordinary call IL.");
        var newObject = Assert.Single(IlInstructionReader.Read(body),
            instruction => instruction.OpCode == OpCodes.Newobj);
        var constructorTarget = ordinary.Module.ResolveMethod(
            newObject.MetadataToken ?? throw new InvalidOperationException("Missing constructor token."));
        Assert.Equal(construction.Type, constructorTarget?.DeclaringType);
        Assert.Equal(ownerModule, constructorTarget?.Module);
        Assert.Equal(construction.Constructor.MetadataToken, constructorTarget?.MetadataToken);
        Assert.Equal(0x06000000, construction.Constructor.MetadataToken & unchecked((int)0xff000000));
    }

    private static int ReadValue(object value) =>
        Assert.IsType<int>(value.GetType().GetField("Value")?.GetValue(value));

    private static MethodInfo GetMethod(Type type, string name) =>
        type.GetMethod(name, BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException("Missing method " + name);

    private static object Invoke(Type type, string name) =>
        GetMethod(type, name).Invoke(null, null)
            ?? throw new InvalidOperationException("Missing result from " + name);
}
