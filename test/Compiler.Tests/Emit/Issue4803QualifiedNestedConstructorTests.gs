// <copyright file="Issue4803QualifiedNestedConstructorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Linq
import System.Linq.Expressions
import System.Reflection
import System.Reflection.Emit
import GSharp.Core.Tests
import GSharp.Tests
import Microsoft.CodeAnalysis
import Xunit
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler.Tests
import System.IO

/// Issue #4803: qualified nested construction retains its actual authored constructor.
/// @remarks ADR-0154: the unchanged final oracle is run red with the shared accessor root
/// exactly reverted, then green after restoring it. No field initializer or
/// unmerged initializer-ownership feature is involved.
class Issue4803QualifiedNestedConstructorTests {
    @Theory
    @InlineData("[T]", "Outer[int32]", "Outer<int>", "struct")
    @InlineData("[T]", "Outer[string]", "Outer<string>", "struct")
    @InlineData("", "Outer", "Outer", "struct")
    @InlineData("[T]", "NestedAuthored4803.Outer[int32]", "Outer<int>", "struct")
    @InlineData("[T]", "Outer[int32]", "Outer<int>", "class")
    func SourceQualifiedConstructor_TreeOrdinaryAndNativeCallsSelectSameOwner(
        parameters string,
        qualifier string,
        nativeQualifier string,
        kind string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let typeQualifier = qualifier.Replace("NestedAuthored4803.", string.Empty, StringComparison.Ordinal)
        let library = fixture.Compile((`package NestedAuthored4803
import System
import System.Linq.Expressions
public class Outer` + "$parameters" + ` {
    public ` + "$kind" + ` User {
        public var Value int32
        public init() { Value = 99 }
    }
}
public class Api {
    shared {
        public func Tree() Expression[Func[` + "$typeQualifier" + `.User]] {
            return () -> ` + "$qualifier" + `.User()
        }
        public func Ordinary() ` + "$typeQualifier" + `.User {
            return ` + "$qualifier" + `.User()
        }
        public func Brace() ` + "$typeQualifier" + `.User {
            return ` + "$qualifier" + `.User{}
        }
        public func Continuation() int32 { return ` + "$qualifier" + `.User().Value }
        public func Initialized() int32 { return ` + "$qualifier" + `.User() { Value = 17 }.Value }
    }
}`), "NestedAuthored4803", executable: false)
        using let consumer = CSharpFixture((`using System;
using System.Linq.Expressions;
using NestedAuthored4803;
public static class NativeConsumer {
    public static Expression<Func<` + "$nativeQualifier" + `.User>> Tree() => Api.Tree();
    public static Expression<Func<` + "$nativeQualifier" + `.User>> Control() =>
        () => new ` + "$nativeQualifier" + `.User();
    public static ` + "$nativeQualifier" + `.User Ordinary() => new ` + "$nativeQualifier" + `.User();
}`), []PortableExecutableReference{MetadataReference.CreateFromFile(library)})
        IlVerifier.Verify(library)
        IlVerifier.Verify(consumer.AssemblyPath, []string{library})
        let assemblies = EmittedFixture.LoadTogether(library, consumer.AssemblyPath)
        let api = assemblies[0].GetType("NestedAuthored4803.Api") ??
            throw InvalidOperationException("Missing source API.")
        let native = assemblies[1].GetType("NativeConsumer") ??
            throw InvalidOperationException("Missing native consumer.")
        AssertConstructorParity(api, native, assemblies[0].ManifestModule)
        let brace = Invoke(api, "Brace")
        Assert.Equal(GetMethod(api, "Ordinary").ReturnType, brace.GetType())
        Assert.Equal(99, Invoke(api, "Continuation"))
        Assert.Equal(17, Invoke(api, "Initialized"))
    }

    @Theory
    @InlineData("User[string](41, \"own\")", false)
    @InlineData("User(41, \"own\")", false)
    @InlineData("User[string](41, \"own\")", true)
    func NestedOwnGenericArguments_ExplicitAndInferredRetainEnclosingConstruction(call string, homonym bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile((`package NestedAuthored4803
import System
import System.Linq.Expressions
public class Outer[T] {
    ` + "${(if homonym { "public struct User { public var Wrong int32 }" } else { string.Empty })}" + `
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
            return () -> Outer[int32].` + "$call" + `
        }
        public func Ordinary() Outer[int32].User[string] {
            return Outer[int32].` + "$call" + `
        }
        public func Brace() Outer[int32].User[string] {
            return Outer[int32].User[string]{Value: 41, Own: "own"}
        }
    }
}`), "NestedGeneric4803", executable: false, "/assemblyname:NestedGeneric4803")
        using let consumer = CSharpFixture(`using System;
using System.Linq.Expressions;
using NestedAuthored4803;
public static class NativeConsumer {
    public static Expression<Func<Outer<int>.User<string>>> Tree() => Api.Tree();
    public static Expression<Func<Outer<int>.User<string>>> Control() =>
        () => new Outer<int>.User<string>(41, "own");
    public static Outer<int>.User<string> Ordinary() => new Outer<int>.User<string>(41, "own");
}`, []PortableExecutableReference{MetadataReference.CreateFromFile(library)})
        IlVerifier.Verify(library)
        IlVerifier.Verify(consumer.AssemblyPath, []string{library})
        let assemblies = EmittedFixture.LoadTogether(library, consumer.AssemblyPath)
        let api = assemblies[0].GetType("NestedAuthored4803.Api") ??
            throw InvalidOperationException("Missing source API.")
        let native = assemblies[1].GetType("NativeConsumer") ??
            throw InvalidOperationException("Missing native consumer.")
        AssertConstructorParity(api, native, assemblies[0].ManifestModule, expectedValue: 41)
        let ordinary = Invoke(api, "Ordinary")
        Assert.Equal([]Type{typeof(int32), typeof(string)}, ordinary.GetType().GenericTypeArguments)
        Assert.Equal("own", ordinary.GetType().GetField("Own")?.GetValue(ordinary))
        let brace = Invoke(api, "Brace")
        Assert.Equal(ordinary.GetType(), brace.GetType())
        Assert.Equal(41, ReadValue(brace))
        Assert.Equal("own", brace.GetType().GetField("Own")?.GetValue(brace))
    }

    @Fact
    func ImportedQualifiedConstructor_UsesNativeContractAndTreeControl() {
        using let contract = CSharpFixture(`using System;
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
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile(`package ImportedNested4803
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
}`, "ImportedNested4803", executable: false, "/r:" + contract.AssemblyPath)
        IlVerifier.Verify(contract.AssemblyPath)
        IlVerifier.Verify(library, []string{contract.AssemblyPath})
        let assemblies = EmittedFixture.LoadTogether(contract.AssemblyPath, library)
        let api = assemblies[1].GetType("ImportedNested4803.Api") ??
            throw InvalidOperationException("Missing imported API.")
        let native = assemblies[0].GetType("NativeNested4803.NativeConsumer") ??
            throw InvalidOperationException("Missing native contract.")
        AssertConstructorParity(api, native, assemblies[0].ManifestModule)
        Assert.Equal(GetMethod(api, "Ordinary").ReturnType, Invoke(api, "Brace").GetType())
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NestedOwnerChain_DeepAndInheritedCallsRetainActualConstruction(inherited bool) {
        let declarations = if inherited {
            `public open class Base[T] {
    public struct User {
        public var Value int32
        public init() { Value = 99 }
    }
}
public class Outer[A, B] : Base[B] {}`
        } else {
            `public class Outer[T] {
    public class Middle[U] {
        public struct User {
            public var Value int32
            public init() { Value = 99 }
        }
    }
}`
        }
        let qualifier = if inherited {
            "Outer[bool, int32]"
        } else {
            "Outer[int32].Middle[string]"
        }
        let typeQualifier = if inherited {
            "Base[int32]"
        } else {
            qualifier
        }
        let nativeQualifier = if inherited {
            "Outer<bool, int>"
        } else {
            "Outer<int>.Middle<string>"
        }
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.Compile((`package NestedOwner4803
import System
import System.Linq.Expressions
` + "$declarations" + `
public struct User {
    public var Value int32
    public init() { Value = -7 }
}
public class Api {
    shared {
        public func Tree() Expression[Func[` + "$typeQualifier" + `.User]] {
            return () -> ` + "$qualifier" + `.User()
        }
        public func Ordinary() ` + "$typeQualifier" + `.User {
            return ` + "$qualifier" + `.User()
        }
        public func Brace() ` + "$typeQualifier" + `.User {
            return ` + "$qualifier" + `.User{}
        }
        public func Simple() User { return User() }
    }
}`), "NestedOwner4803", executable: false)
        using let consumer = CSharpFixture((`using System;
using System.Linq.Expressions;
using NestedOwner4803;
public static class NativeConsumer {
    public static Expression<Func<` + "$nativeQualifier" + `.User>> Control() =>
        () => new ` + "$nativeQualifier" + `.User();
    public static ` + "$nativeQualifier" + `.User Ordinary() => new ` + "$nativeQualifier" + `.User();
}`), []PortableExecutableReference{MetadataReference.CreateFromFile(library)})
        IlVerifier.Verify(library)
        IlVerifier.Verify(consumer.AssemblyPath, []string{library})
        let assemblies = EmittedFixture.LoadTogether(library, consumer.AssemblyPath)
        let api = assemblies[0].GetType("NestedOwner4803.Api") ?? throw InvalidOperationException("Missing source API.")
        let native = assemblies[1].GetType("NativeConsumer") ??
            throw InvalidOperationException("Missing native consumer.")
        AssertConstructorParity(api, native, assemblies[0].ManifestModule)
        Assert.Equal(GetMethod(api, "Ordinary").ReturnType, Invoke(api, "Brace").GetType())
        Assert.Equal(-7, ReadValue(Invoke(api, "Simple")))
        Assert.Equal(
            if inherited {
                []Type{typeof(int32)}
            } else {
                []Type{typeof(int32), typeof(string)}
            },
            GetMethod(api, "Ordinary").ReturnType.GenericTypeArguments
        )
    }

    @Theory
    @InlineData("User()", "GS0144")
    @InlineData("User(\"wrong\")", "GS0154")
    @InlineData("User[int32](1)", "GS0148")
    func QualifiedConstructor_InvalidArgumentsUseConstructorDiagnostics(call string, diagnostic string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile((`package RejectedNested4803
class Outer[T] {
    public struct User {
        public var Value T
        public init(value T) { Value = value }
    }
}
func Bad() { let rejected = Outer[int32].` + "$call" + ` }`), "RejectedNested4803", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains(diagnostic, output, StringComparison.Ordinal)
        Assert.Contains("RejectedNested4803.gs(8,", output, StringComparison.Ordinal)
        Assert.DoesNotContain("GS0158", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "RejectedNested4803.dll")))
    }

    shared {
        private func AssertConstructorParity(api Type, native Type, ownerModule Module, expectedValue int32 = 99) {
            let tree = Assert.IsAssignableFrom[ExpressionsLambdaExpression](Invoke(api, "Tree"))
            let control = Assert.IsAssignableFrom[ExpressionsLambdaExpression](Invoke(native, "Control"))
            let construction = Assert.IsType[NewExpression](tree.Body)
            let nativeConstruction = Assert.IsType[NewExpression](control.Body)
            Assert.NotNull(construction.Constructor)
            Assert.NotNull(nativeConstruction.Constructor)
            Assert.Equal(nativeConstruction.Type, construction.Type)
            Assert.Equal(construction.Type, construction.Constructor!!.DeclaringType)
            Assert.Equal(ownerModule, construction.Constructor!!.Module)
            Assert.Equal(nativeConstruction.Constructor!!.MetadataToken, construction.Constructor!!.MetadataToken)
            Assert.Equal(nativeConstruction.Constructor!!.Module, construction.Constructor!!.Module)
            Assert.Equal(
                nativeConstruction.Constructor!!.GetParameters().Select(
                    (parameter ParameterInfo) -> parameter.ParameterType
                ),
                construction.Constructor!!.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType)
            )
            Assert.Equal(
                nativeConstruction.Arguments.Select(
                    (argument Expression) -> Assert.IsType[ConstantExpression](argument).Value
                ),
                construction.Arguments.Select(
                    (argument Expression) -> Assert.IsType[ConstantExpression](argument).Value
                )
            )
            Assert.NotEmpty(construction.Type.GetConstructors())
            Assert.Contains(
                construction.Type.GetConstructors(),
                (constructor ConstructorInfo) -> constructor.MetadataToken == construction.Constructor!!.MetadataToken
            )
            for value in[]object{
                tree.Compile().DynamicInvoke()!!,
                control.Compile().DynamicInvoke()!!,
                Invoke(api, "Ordinary"),
                Invoke(native, "Ordinary")
            } {
                Assert.NotNull(value)
                Assert.Equal(construction.Type, value.GetType())
                Assert.Equal(expectedValue, ReadValue(value))
            }
            let ordinary = GetMethod(api, "Ordinary")
            let body = ordinary.GetMethodBody()?.GetILAsByteArray() ??
                throw InvalidOperationException("Missing ordinary call IL.")
            let newObject = Assert.Single(
                IlInstructionReader.Read(body),
                (instruction IlInstruction) -> instruction.OpCode == OpCodes.Newobj
            )
            let constructorTarget MethodBase? = ordinary.Module.ResolveMethod(
                newObject.MetadataToken ?? throw InvalidOperationException("Missing constructor token.")
            )
            Assert.Equal(construction.Type, constructorTarget?.DeclaringType)
            Assert.Equal(ownerModule, constructorTarget?.Module)
            Assert.Equal(construction.Constructor!!.MetadataToken, constructorTarget?.MetadataToken)
            Assert.Equal(0x06000000, construction.Constructor!!.MetadataToken & unchecked(int32(0xff000000U)))
        }

        private func ReadValue(value object) int32 -> Assert.IsType[int32](
            value.GetType().GetField("Value")?.GetValue(value)
        )

        private func GetMethod(type Type, name string) MethodInfo -> type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.Static
        ) ??
            throw InvalidOperationException("Missing method " + name)

        private func Invoke(type Type, name string) object -> GetMethod(type, name).Invoke(nil, nil) ??
            throw InvalidOperationException("Missing result from " + name)
    }
}
