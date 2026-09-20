// <copyright file="InterfaceAdaptationReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.Loader;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class InterfaceAdaptationReviewTests
{
    [Fact]
    public void GenericRichLiteralOmittedReturnUsesTheEnclosingConstruction()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package GenericRichReturn
            import System
            interface Reader[T] { func Read() T; }
            private func Make[T](value T) -> object : Reader[T] {
                func Read() T -> value
            }
            func Main() {
                Console.WriteLine(Make[string]("generic").Read())
                Console.WriteLine(Make[int32](42).Read())
            }
            """,
            "generic-rich-return",
            executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("generic\n42\n", fixture.Run(dll));
    }

    [Fact]
    public void BorrowedCapturesRejectWhileSnapshotsAndManagedHandlesRemainSafe()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var invalid = new[]
        {
            "func Bad(in value int32) Reader { return object : Reader { func Read() int32 -> value } }",
            "func Bad(ref value int32) Reader { return object : Reader { func Read() int32 -> value } }",
            "func Bad(out value int32) Reader { value = 1; return object : Reader { func Read() int32 -> value } }",
            "func Bad() Reader { var value = 1; let ref alias = value; return object : Reader { func Read() int32 -> alias } }",
            "func Bad() Reader { var value = 1; let ref readonly alias = value; return object : Reader { func Read() int32 -> alias } }",
            "struct Owner { var Value int32; func Bad() Reader { let ref alias = this.Value; return object : Reader { func Read() int32 -> alias } } }",
        };
        for (var i = 0; i < invalid.Length; i++)
        {
            var (code, output) = fixture.TryCompile(
                "package BorrowedCapture\ninterface Reader { func Read() int32; }\n" + invalid[i],
                "borrowed-capture-" + i,
                executable: false);
            Assert.NotEqual(0, code);
            Assert.Contains("error GS0604:", output);
        }

        var valid = fixture.Compile(
            """
            package BorrowedCaptureControls
            import System
            interface Reader { func Read() int32; }
            func Snapshot(in value int32) Reader {
                return object : Reader {
                    let Snapshot = value
                    func Read() int32 -> Snapshot
                }
            }
            struct Source {
                var Value int32
                func Read() int32 -> Value
            }
            func Main() {
                var value = 7
                Console.WriteLine(Snapshot(in value).Read())
                var source = Source{Value: 9}
                let location = managed(source)
                Console.WriteLine(adapt[Reader](ref location).Read())
            }
            """,
            "borrowed-capture-controls",
            executable: true);
        IlVerifier.Verify(valid);
        Assert.Equal("7\n9\n", fixture.Run(valid));
    }

    [Fact]
    public void PointerAndFunctionPointerSourcesRejectEvenWithoutAbstractSlots()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            """
            package PointerAdapters
            interface Empty { }
            interface DefaultOnly { func Value() int32 { return 1 } }
            unsafe func ManagedTarget() int32 -> 1
            unsafe func Pointer(p *int32) { let adapted = adapt[Empty](p) }
            unsafe func ManagedFunctionPointer() {
                let p *func() int32 = &ManagedTarget
                let adapted = adapt[DefaultOnly](p)
            }
            unsafe func UnmanagedFunctionPointer(p unmanaged[Cdecl] () -> int32) {
                let adapted = adapt[Empty](p)
            }
            """,
            "pointer-adapters",
            executable: false);
        Assert.NotEqual(0, code);
        Assert.True(output.Split("error GS0606:").Length - 1 >= 3, output);

        var controls = fixture.Compile(
            """
            package PointerAdapterControls
            interface Empty { }
            class Source { }
            func Main() {
                let reference = adapt[Empty](Source())
                let scalar = adapt[Empty](42)
            }
            """,
            "pointer-adapter-controls",
            executable: true);
        IlVerifier.Verify(controls);
    }

    [Fact]
    public void RichShellsPreserveOwnerMethodNestedAndShadowedGenerics()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package RichGenericShells
            import System
            interface Pair[A, B] { func First() A; func Second() B; }
            interface Triple[A, B, C] { func First() A; func Second() B; func Third() C; }
            interface Mixed[T] { func Inner() T; func Outer() object; }

            class Owner[T class] {
                func PairWith[U struct](first T, second U) Pair[T, U] {
                    return object : Pair[T, U] {
                        func First() T -> first
                        func Second() U -> second
                    }
                }

                public struct Middle[V struct] {
                    func Make[W](first T, second V, third W) Triple[T, V, W] {
                        return object : Triple[T, V, W] {
                            func First() T -> first
                            func Second() V -> second
                            func Third() W -> third
                        }
                    }
                }
            }

            class Shadow[T class](Value T) {
                func Make[T struct](inner T) Mixed[T] {
                    let outer = this.Value
                    return object : Mixed[T] {
                        func Inner() T -> inner
                        func Outer() object -> outer
                    }
                }
            }

            func Main() {
                let pair = Owner[string]().PairWith[int32]("owner", 2)
                Console.WriteLine(pair.First())
                Console.WriteLine(pair.Second())
                let middle = Owner[string].Middle[int32]{}
                let triple = middle.Make[bool]("nested", 3, true)
                Console.WriteLine(triple.First())
                Console.WriteLine(triple.Second())
                Console.WriteLine(triple.Third())
                let mixed = Shadow[string]("shadow").Make[int32](4)
                Console.WriteLine(mixed.Inner())
                Console.WriteLine(mixed.Outer())
            }
            """,
            "rich-generic-shells",
            executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("owner\n2\nnested\n3\nTrue\n4\nshadow\n", fixture.Run(dll));

        var reference = Path.Combine(fixture.Directory, "RichGenericApi.ref.dll");
        var library = fixture.Compile(
            """
            package RichGenericApi
            public interface Pair[A, B] { func First() A; func Second() B; }
            public class Owner[T class] {
                public func Make[U struct](first T, second U) Pair[T, U] {
                    return object : Pair[T, U] {
                        func First() T -> first
                        func Second() U -> second
                    }
                }
            }
            """,
            "RichGenericApi",
            executable: false,
            "/refout:" + reference);
        IlVerifier.Verify(library);
        var consumer = fixture.Compile(
            """
            package RichGenericApiConsumer
            import System
            import RichGenericApi
            let pair = Owner[string]().Make[int32]("refout", 5)
            Console.WriteLine(pair.First())
            Console.WriteLine(pair.Second())
            """,
            "RichGenericApiConsumer",
            executable: true,
            "/r:" + reference);
        IlVerifier.Verify(consumer, new[] { library });
        Assert.Equal("refout\n5\n", fixture.Run(consumer));
    }

    [Fact]
    public void ImportedInterfaceSourceClosuresForwardPropertiesAndEvents()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = fixture.CompileCSharp(
            """
            using System;
            namespace ImportedSourceClosure;
            public interface IBaseProperty<T> { T Value { get; set; } }
            public interface IBaseEvent<T> { event Action<T> Changed; }
            public interface ILeft<T> : IBaseProperty<T>, IBaseEvent<T> { }
            public interface IRight<T> : IBaseProperty<T>, IBaseEvent<T> { }
            public interface IDiamond<T> : ILeft<T>, IRight<T> { }
            public interface ITarget<T> { T Value { get; set; } event Action<T> Changed; }
            public sealed class Source<T> : IDiamond<T>
            {
                public T Value { get; set; }
                public event Action<T>? Changed;
                public Source(T value) => Value = value;
                public void Raise(T value) => Changed?.Invoke(value);
            }
            public interface IA { int Value { get; } }
            public interface IB { int Value { get; } }
            public interface IAmbiguous : IA, IB { }
            public interface IGet { int Value { get; } }
            public sealed class Ambiguous : IAmbiguous { public int Value => 1; }
            """,
            "ImportedSourceClosure");
        var dll = fixture.Compile(
            """
            package ImportedSourceClosureConsumer
            import System
            import ImportedSourceClosure
            func Main() {
                let concrete = Source[int32](7)
                let source IDiamond[int32] = concrete
                let adapted = adapt[ITarget[int32]](source)
                adapted.Value = 8
                var observed = 0
                let handler = (value int32) -> { observed = value }
                adapted.Changed += handler
                concrete.Raise(9)
                adapted.Changed -= handler
                Console.WriteLine(adapted.Value)
                Console.WriteLine(observed)
            }
            """,
            "imported-source-closure-consumer",
            executable: true,
            "/r:" + contracts);
        IlVerifier.Verify(dll, new[] { contracts });
        Assert.Equal("8\n9\n", fixture.Run(dll));

        var (code, output) = fixture.TryCompile(
            """
            package ImportedSourceAmbiguity
            import ImportedSourceClosure
            func Bad(source IAmbiguous) { let adapted = adapt[IGet](source) }
            """,
            "imported-source-ambiguity",
            executable: false,
            "/r:" + contracts);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0606:", output);
        Assert.Contains("ambiguous", output);
    }

    [Fact]
    public void ImportedDefaultEventsInheritOrDiagnoseBeforeReadonlyForwarding()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = Path.Combine(fixture.Directory, "DefaultEvents.dll");
        BuildDefaultEventContractLibrary(contracts);
        var valid = fixture.Compile(
            """
            package DefaultEventConsumer
            import DefaultEvents
            func Main() {
                var value = 1
                let location = readonly managed(value)
                let adapted = adapt[IDefault](ref location)
            }
            """,
            "default-event-consumer",
            executable: true,
            "/r:" + contracts);
        IlVerifier.Verify(valid, new[] { contracts });

        foreach (var target in new[] { "IPartial", "IConflict" })
        {
            var (code, output) = fixture.TryCompile(
                $$"""
                package InvalidDefaultEvent
                import DefaultEvents
                func Bad() { let adapted = adapt[{{target}}](1) }
                """,
                "invalid-default-event-" + target,
                executable: false,
                "/r:" + contracts);
            Assert.NotEqual(0, code);
            Assert.Contains("error GS0606:", output);
        }
    }

    [Fact]
    public void DefaultPropertyDiamondsRequireOneMostSpecificImplementation()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (userCode, userOutput) = fixture.TryCompile(
            """
            package UserDefaultPropertyConflict
            interface IA { prop Value int32 { get { return 1 } } }
            interface IB { prop Value int32 { get { return 2 } } }
            interface IConflict : IA, IB { }
            class Source { }
            func Bad() { let adapted = adapt[IConflict](Source()) }
            """,
            "user-default-property-conflict",
            executable: false);
        Assert.NotEqual(0, userCode);
        Assert.Contains("error GS0606:", userOutput);
        Assert.Contains("no unique most-specific", userOutput);

        var contracts = fixture.CompileCSharp(
            """
            namespace ImportedDefaultProperties;
            public interface IA { int Value => 1; }
            public interface IB { int Value => 2; }
            public interface IConflict : IA, IB { }
            public interface IMostSpecific : IA, IB { new int Value => 3; }
            public sealed class Source { }
            """,
            "ImportedDefaultProperties");
        var valid = fixture.Compile(
            """
            package ImportedDefaultPropertyControl
            import ImportedDefaultProperties
            func Main() { let adapted = adapt[IMostSpecific](Source()) }
            """,
            "imported-default-property-control",
            executable: true,
            "/r:" + contracts);
        IlVerifier.Verify(valid, new[] { contracts });

        var (importedCode, importedOutput) = fixture.TryCompile(
            """
            package ImportedDefaultPropertyConflict
            import ImportedDefaultProperties
            func Bad() { let adapted = adapt[IConflict](Source()) }
            """,
            "imported-default-property-conflict",
            executable: false,
            "/r:" + contracts);
        Assert.NotEqual(0, importedCode);
        Assert.Contains("error GS0606:", importedOutput);
        Assert.Contains("no unique most-specific", importedOutput);
    }

    [Fact]
    public void ImportedAdapterEventsPreserveNestedNullabilityMetadata()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = fixture.CompileCSharp(
            """
            #nullable enable
            using System;
            namespace NullableAdapterEvents;
            public interface ITarget { event Action<string?> Changed; }
            public sealed class Source
            {
                public event Action<string?>? Changed;
                public void Raise(string? value) => Changed?.Invoke(value);
            }
            """,
            "NullableAdapterEvents");
        var reference = Path.Combine(fixture.Directory, "NullableAdapterEventApi.ref.dll");
        var dll = fixture.Compile(
            """
            package NullableAdapterEventApi
            import NullableAdapterEvents
            public func Create() ITarget { return adapt[ITarget](Source()) }
            """,
            "NullableAdapterEventApi",
            executable: false,
            "/r:" + contracts,
            "/refout:" + reference);
        IlVerifier.Verify(dll, new[] { contracts });
        Assert.True(File.Exists(reference));

        AssemblyLoadContext.Default.LoadFromAssemblyPath(contracts);
        var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(dll);
        var adapter = Assert.Single(
            assembly.GetTypes(),
            type => type.Name.StartsWith("<>Adapter", StringComparison.Ordinal));
        var eventInfo = adapter.GetEvent(
            "Changed",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(eventInfo);
        var addMethod = eventInfo.GetAddMethod(nonPublic: true);
        Assert.NotNull(addMethod);
        var addParameter = Assert.Single(addMethod.GetParameters());
        var addNullability = new NullabilityInfoContext().Create(addParameter);
        Assert.Equal(NullabilityState.Nullable, Assert.Single(addNullability.GenericTypeArguments).ReadState);
        var removeMethod = eventInfo.GetRemoveMethod(nonPublic: true);
        Assert.NotNull(removeMethod);
        var removeParameter = Assert.Single(removeMethod.GetParameters());
        var removeNullability = new NullabilityInfoContext().Create(removeParameter);
        Assert.Equal(NullabilityState.Nullable, Assert.Single(removeNullability.GenericTypeArguments).ReadState);
    }

    [Fact]
    public void ImportedGenericNullabilityAndConstraintMetadataRemainExact()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = fixture.CompileCSharp(
            """
            #nullable enable
            using System.Collections.Generic;
            namespace GenericAdapterContracts;
            public interface IFoo { }
            public interface IBar { }
            public sealed class Item : IFoo, IBar { public Item() { } }
            public interface INullable { T? Echo<T>(T? value); }
            public interface INonNullable { T Echo<T>(T value); }
            public interface INested { List<T?> Echo<T>(List<T?> value); }
            public sealed class NullableExact { public T? Echo<T>(T? value) => value; }
            public sealed class NonNullableExact { public T Echo<T>(T value) => value; }
            public sealed class NestedExact { public List<T?> Echo<T>(List<T?> value) => value; }
            public interface IOneBound { T Echo<T>(T value) where T : IFoo; }
            public sealed class OneBound { public T Echo<T>(T value) where T : IFoo => value; }
            public interface IMixedBound { T Echo<T>(T value) where T : class, IFoo, new(); }
            public sealed class MixedBound { public T Echo<T>(T value) where T : class, IFoo, new() => value; }
            public interface IValueBound { T Echo<T>(T value) where T : struct, IFoo; }
            public sealed class ValueBound { public T Echo<T>(T value) where T : struct, IFoo => value; }
            public interface ITwoBounds { T Echo<T>(T value) where T : IFoo, IBar; }
            public sealed class TwoBounds { public T Echo<T>(T value) where T : IFoo, IBar => value; }
            """,
            "GenericAdapterContracts");
        var reference = Path.Combine(fixture.Directory, "GenericAdapterApi.ref.dll");
        var valid = fixture.Compile(
            """
            package GenericAdapterApi
            import System.Collections.Generic
            import GenericAdapterContracts
            public func Nullable() INullable { return adapt[INullable](NullableExact()) }
            public func Nested() INested { return adapt[INested](NestedExact()) }
            public func One() IOneBound { return adapt[IOneBound](OneBound()) }
            public func Mixed() IMixedBound { return adapt[IMixedBound](MixedBound()) }
            public func Value() IValueBound { return adapt[IValueBound](ValueBound()) }
            """,
            "GenericAdapterApi",
            executable: false,
            "/r:" + contracts,
            "/refout:" + reference);
        IlVerifier.Verify(valid, new[] { contracts });
        Assert.True(File.Exists(reference));

        var invalidPrograms = new[]
        {
            "func Bad() { let value = adapt[INullable](NonNullableExact()) }",
            "func Bad() { let value = adapt[INonNullable](NullableExact()) }",
            "func Bad() { let value = adapt[ITwoBounds](TwoBounds()) }",
        };
        for (var i = 0; i < invalidPrograms.Length; i++)
        {
            var (code, output) = fixture.TryCompile(
                "package InvalidGenericAdapters\nimport GenericAdapterContracts\n" + invalidPrograms[i],
                "invalid-generic-adapter-" + i,
                executable: false,
                "/r:" + contracts);
            Assert.NotEqual(0, code);
            Assert.Contains("error GS0606:", output);
        }
    }

    [Fact]
    public void SourcePropertyInitOnlyContractMustMatchWhenSetterIsRequired()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var exact = fixture.Compile(
            """
            package InitOnlyAdapters
            interface InitTarget { prop Value int32 { get; init; } }
            interface GetTarget { prop Value int32 { get; } }
            class InitSource { prop Value int32 { get; init; } }
            func Main() {
                let exact = adapt[InitTarget](InitSource())
                let getter = adapt[GetTarget](InitSource())
            }
            """,
            "init-only-adapter-exact",
            executable: true);
        IlVerifier.Verify(exact);

        var invalid = new[]
        {
            "interface Target { prop Value int32 { get; set; } }\nclass Source { prop Value int32 { get; init; } }",
            "interface Target { prop Value int32 { get; init; } }\nclass Source { prop Value int32 { get; set; } }",
        };
        for (var i = 0; i < invalid.Length; i++)
        {
            var (code, output) = fixture.TryCompile(
                "package InvalidInitAdapter\n" + invalid[i] + "\nfunc Bad() { let value = adapt[Target](Source()) }",
                "invalid-init-adapter-" + i,
                executable: false);
            Assert.True(code != 0, $"init-only case {i} unexpectedly compiled: {output}");
            Assert.Contains("error GS0606:", output);
        }

        var imported = fixture.CompileCSharp(
            """
            namespace ImportedInitContracts;
            public interface IInit { int Value { get; init; } }
            public sealed class InitExact { public int Value { get; init; } }
            public sealed class SetMismatch { public int Value { get; set; } }
            """,
            "ImportedInitContracts");
        var importedExact = fixture.Compile(
            """
            package ImportedInitConsumer
            import ImportedInitContracts
            func Main() { let value = adapt[IInit](InitExact()) }
            """,
            "imported-init-exact",
            executable: true,
            "/r:" + imported);
        IlVerifier.Verify(importedExact, new[] { imported });
        var (importedCode, importedOutput) = fixture.TryCompile(
            """
            package InvalidImportedInitConsumer
            import ImportedInitContracts
            func Bad() { let value = adapt[IInit](SetMismatch()) }
            """,
            "imported-init-mismatch",
            executable: false,
            "/r:" + imported);
        Assert.NotEqual(0, importedCode);
        Assert.Contains("error GS0606:", importedOutput);
    }

    [Fact]
    public void StaticAbstractOperatorRequirementsDiagnoseBeforeSpecialNameFiltering()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contracts = fixture.CompileCSharp(
            """
            namespace StaticOperatorContracts;
            public interface IOperator
            {
                static abstract IOperator operator +(IOperator left, IOperator right);
                static virtual IOperator operator -(IOperator left, IOperator right) => left;
                int Read();
            }
            public interface IOperatorOnly
            {
                static abstract IOperatorOnly operator +(IOperatorOnly left, IOperatorOnly right);
            }
            public sealed class Source { public int Read() => 1; }
            """,
            "StaticOperatorContracts");
        var (code, output) = fixture.TryCompile(
            """
            package StaticOperatorConsumer
            import StaticOperatorContracts
            func Bad() {
                let mixed = adapt[IOperator](Source())
                let only = adapt[IOperatorOnly](Source())
            }
            """,
            "static-operator-consumer",
            executable: false,
            "/r:" + contracts);
        Assert.NotEqual(0, code);
        Assert.True(output.Split("error GS0606:").Length - 1 >= 2, output);
        Assert.Contains("op_Addition", output);
    }

    private static void BuildDefaultEventContractLibrary(string path)
    {
        var assembly = new PersistedAssemblyBuilder(
            new AssemblyName("DefaultEvents"),
            typeof(object).Assembly);
        var module = assembly.DefineDynamicModule("DefaultEvents");
        var first = DefineEventInterface(module, "DefaultEvents.IA", addDefault: true, removeDefault: true);
        var second = DefineEventInterface(module, "DefaultEvents.IB", addDefault: true, removeDefault: true);
        DefineEventInterface(module, "DefaultEvents.IDefault", addDefault: true, removeDefault: true);
        DefineEventInterface(module, "DefaultEvents.IPartial", addDefault: true, removeDefault: false);
        DefineEventInterface(
            module,
            "DefaultEvents.IConflict",
            addDefault: null,
            removeDefault: null,
            first,
            second);
        assembly.Save(path);
    }

    private static Type DefineEventInterface(
        ModuleBuilder module,
        string name,
        bool? addDefault,
        bool? removeDefault,
        params Type[] bases)
    {
        var type = module.DefineType(
            name,
            TypeAttributes.Public | TypeAttributes.Interface | TypeAttributes.Abstract);
        foreach (var baseInterface in bases)
        {
            type.AddInterfaceImplementation(baseInterface);
        }

        if (addDefault != null && removeDefault != null)
        {
            var eventBuilder = type.DefineEvent("Changed", EventAttributes.None, typeof(Action));
            eventBuilder.SetAddOnMethod(DefineEventAccessor(type, "add_Changed", addDefault.Value));
            eventBuilder.SetRemoveOnMethod(DefineEventAccessor(type, "remove_Changed", removeDefault.Value));
        }

        return type.CreateType();
    }

    private static MethodBuilder DefineEventAccessor(
        TypeBuilder owner,
        string name,
        bool hasBody)
    {
        var attributes = MethodAttributes.Public
            | MethodAttributes.Virtual
            | MethodAttributes.NewSlot
            | MethodAttributes.SpecialName
            | MethodAttributes.HideBySig;
        if (!hasBody)
        {
            attributes |= MethodAttributes.Abstract;
        }

        var method = owner.DefineMethod(
            name,
            attributes,
            typeof(void),
            new[] { typeof(Action) });
        if (hasBody)
        {
            method.GetILGenerator().Emit(OpCodes.Ret);
        }

        return method;
    }
}
