// <copyright file="Issue4777InheritedDataEqualityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public class Issue4777InheritedDataEqualityTests
{
    [Theory]
    [InlineData("Leaf")]
    [InlineData("Root")]
    public void SourceObjectCallsAndMethodGroups_PreserveMostDerivedEquality(string owner)
    {
        var result = EmittedOracle.Evaluate($$"""
            import System
            open data class Root(Tag int32)
            data class Leaf(Tag int32, Extra int32) : Root(Tag)
            let receiver {{owner}} = Leaf(1, 2)
            let same Object = Leaf(1, 2)
            let different Object = Leaf(1, 3)
            let wrong Object = Root(1)
            let missing Object? = nil
            let equals Func[Object?, bool] = receiver.Equals
            receiver.Equals(same) && !receiver.Equals(different)
                && !receiver.Equals(wrong) && !receiver.Equals(missing)
                && receiver.Equals(obj: same)
                && equals(same) && !equals(different) && !equals(wrong) && !equals(nil)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SourceGenericValueData_ObjectCallsAndMethodGroupsPreserveBoxedEquality()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            data struct Payload[T any](Value T)
            let receiver = Payload[int32]{Value: 1}
            let same Object = Payload[int32]{Value: 1}
            let different Object = Payload[int32]{Value: 2}
            let wrong Object = Payload[string]{Value: "1"}
            let equals Func[Object?, bool] = receiver.Equals
            receiver.Equals(same) && !receiver.Equals(different)
                && !receiver.Equals(wrong) && !receiver.Equals(nil)
                && receiver.Equals(obj: same)
                && equals(same) && !equals(different) && !equals(wrong) && !equals(nil)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void SourceNestedGenericData_ObjectAndTypedMethodGroupsRetainConstructedOwner()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            package NestedCalls
            import System
            public class Owner[T any] {
                public open data class Root[U any](Value U)
                public data class Leaf[U any](Value U, Extra U) : Root[U](Value)
            }
            public func Compare(receiver Owner[int32].Root[string],
                same Owner[int32].Root[string], different Owner[int32].Root[string]) bool {
                let sameObject Object = same
                let differentObject Object = different
                let objectEquals Func[Object?, bool] = receiver.Equals
                let typedEquals Func[Owner[int32].Root[string]?, bool] = receiver.Equals
                return receiver.Equals(sameObject) && !receiver.Equals(differentObject)
                    && objectEquals(same) && !objectEquals(different) && !objectEquals(nil)
                    && typedEquals(same) && !typedEquals(different) && !typedEquals(nil)
            }
            """)) { IsLibrary = true };
        using var image = new MemoryStream();
        var result = compilation.Emit(image);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        image.Position = 0;
        var context = new AssemblyLoadContext(nameof(SourceNestedGenericData_ObjectAndTypedMethodGroupsRetainConstructedOwner), isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(image);
            var leaf = assembly.GetType("NestedCalls.Owner`1+Leaf`1", throwOnError: true).MakeGenericType(typeof(int), typeof(string));
            var first = Activator.CreateInstance(leaf, "value", "extra");
            var same = Activator.CreateInstance(leaf, "value", "extra");
            var different = Activator.CreateInstance(leaf, "value", "different");
            var compare = assembly.GetTypes().SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Static))
                .Single(method => method.Name == "Compare");
            Assert.Equal(true, compare.Invoke(null, new[] { first, same, different }));
        }
        finally
        {
            context.Unload();
        }
    }

    [Fact]
    public void SourceObjectMethodGroup_UsesTheSynthesizedNullableObjectSlot()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            data class Payload(Value int32)
            let receiver = Payload(1)
            let equals Func[Object?, bool] = receiver.Equals
            equals
            """);
        Assert.Empty(result.Diagnostics);
        var method = Assert.IsAssignableFrom<Delegate>(result.Value).Method;
        Assert.Equal("Payload", method.DeclaringType.Name);
        var parameter = Assert.Single(method.GetParameters());
        Assert.Equal(typeof(object), parameter.ParameterType);
        Assert.Equal("obj", parameter.Name);
        Assert.Equal(NullabilityState.Nullable, new NullabilityInfoContext().Create(parameter).ReadState);
        Assert.True(method.IsVirtual);
        Assert.False(method.IsFinal);
        Assert.Equal(typeof(object), method.GetBaseDefinition().DeclaringType);
    }

    [Fact]
    public void NativeNestedGenericData_EmitThenQueryRetainsSourceEqualityShape()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            package NativeNested
            public class Outer[T any] {
                public open data class Root[U any](Value U)
                public data class Leaf[U any](Value U, Extra U) : Root[U](Value)
                public data struct Payload[U any](Value U)
            }
            """)) { IsLibrary = true };
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation));
        var dataTypes = compilation.GlobalScope.Structs.Where(s => s.IsData).ToArray();
        Assert.Equal(3, dataTypes.Length);
        Assert.All(dataTypes, s => Assert.Single(s.TypeParameters));
        for (var emission = 0; emission < 2; emission++)
        {
            using var image = new MemoryStream();
            using var reference = new MemoryStream();
            var result = compilation.Emit(image, refStream: reference);
            Assert.True(result.Success, string.Join("\n", result.Diagnostics));
            Assert.True(reference.Length > 0);
            foreach (var type in dataTypes)
            {
                Assert.Single(type.TypeParameters);
                var methods = TypeMemberModel.GetMethods(type, "Equals", new MemberQuery(true, false, false, MemberKinds.Method));
                Assert.NotEmpty(methods);
                foreach (var method in methods)
                {
                    if (method.Parameters[0].Type.StripToBareShape() == TypeSymbol.Object)
                    {
                        Assert.Equal("obj", method.Parameters[0].Name);
                        Assert.True(TypeSymbol.ContainsReferenceNullableAnnotation(method.Parameters[0].Type));
                        continue;
                    }

                    var parameter = Assert.IsType<StructSymbol>(Assert.Single(method.Parameters).Type.StripToBareShape());
                    Assert.Single(parameter.TypeArguments);
                    Assert.Equal("U", parameter.TypeArguments[0].Name);
                }
            }

            image.Position = 0;
            var context = new AssemblyLoadContext(nameof(NativeNestedGenericData_EmitThenQueryRetainsSourceEqualityShape), isCollectible: true);
            try
            {
                var assembly = context.LoadFromStream(image);
                var root = assembly.GetType("NativeNested.Outer`1+Root`1", throwOnError: true).MakeGenericType(typeof(int), typeof(string));
                var leaf = assembly.GetType("NativeNested.Outer`1+Leaf`1", throwOnError: true).MakeGenericType(typeof(int), typeof(string));
                var first = Activator.CreateInstance(leaf, "value", "extra");
                var same = Activator.CreateInstance(leaf, "value", "extra");
                var different = Activator.CreateInstance(leaf, "value", "different");
                foreach (var owner in new[] { root, leaf })
                {
                    var method = owner.GetMethod("Equals", new[] { owner });
                    Assert.NotNull(method);
                    Assert.Equal(false, method.Invoke(first, new[] { different }));
                    Assert.Equal(true, method.Invoke(first, new[] { same }));
                    Assert.Equal(false, method.Invoke(first, new object[] { null }));
                }
            }
            finally
            {
                context.Unload();
            }
        }
    }

    [Fact]
    public void SourceMemberQueriesAndCompletion_ExposeTheSameTypedSlots()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            open data class Root(Tag int32)
            data class Leaf(Tag int32, Extra int32) : Root(Tag)
            """)) { IsLibrary = true };
        Assert.Empty(EmittedOracle.CompileDiagnostics(compilation));
        var leaf = Assert.Single(compilation.GlobalScope.Structs, s => s.Name == "Leaf");
        var query = new MemberQuery(true, false, false, MemberKinds.Method);
        var slots = leaf.GetMethods("Equals");
        Assert.Equal(3, slots.Length);
        Assert.Equal<FunctionSymbol>(slots, TypeMemberModel.GetMethods(leaf, "Equals", query));
        Assert.Same(slots[0], TypeMemberModel.LookupMember(leaf, "Equals", query));

        // ADR-0199: the compiler-owned PrintMembers slot is enumerated after the
        // equality slots.
        var printMembers = Assert.Single(leaf.GetMembers().OfType<FunctionSymbol>(), m => m.Name == "PrintMembers");
        Assert.Equal(slots.Add(printMembers), TypeMemberModel.EnumerateMembers(leaf, query).OfType<FunctionSymbol>());
        Assert.Equal(slots.Add(printMembers), leaf.GetMembers().OfType<FunctionSymbol>());
        Assert.Empty(TypeMemberModel.GetMethods(leaf, "Equals", MemberQuery.Static()));
    }

    [Fact]
    public void SourceNamedCallsAndMethodGroups_UseCompilerOwnedTypedSlots()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            open data class Root(Tag int32)
            data class Leaf(Tag int32, Extra int32) : Root(Tag)
            let first = Leaf(1, 2)
            let different = Leaf(1, 3)
            let same = Leaf(1, 2)
            let root Root = first
            let selfEquals Func[Leaf?, bool] = first.Equals
            let baseEquals Func[Root?, bool] = root.Equals
            !first.Equals(other: different)
                && first.Equals(other: same)
                && !root.Equals(other: different)
                && root.Equals(other: same)
                && !selfEquals(different) && selfEquals(same) && !selfEquals(nil)
                && !baseEquals(different) && baseEquals(same) && !baseEquals(nil)
            """);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Theory]
    [InlineData("Leaf")]
    [InlineData("Root")]
    public void SourceTypedMethodGroups_SelectTypedParameterNotObjectFallback(string owner)
    {
        var result = EmittedOracle.Evaluate($$"""
            import System
            open data class Root(Tag int32)
            data class Leaf(Tag int32, Extra int32) : Root(Tag)
            let receiver {{owner}} = Leaf(1, 2)
            let equals Func[{{owner}}?, bool] = receiver.Equals
            equals
            """);
        Assert.Empty(result.Diagnostics);
        var method = Assert.IsAssignableFrom<Delegate>(result.Value).Method;
        var parameter = Assert.Single(method.GetParameters());
        Assert.Equal(owner, parameter.ParameterType.Name);
        Assert.Equal("other", parameter.Name);
    }

    [Fact]
    public void NativeClrTypedCallsWithoutInterface_CompareMostDerivedFieldsAndPreservePlainMethods()
    {
        var compilation = new Compilation(SyntaxTree.Parse("""
            package NoInterface
            public open data class Root(Tag int32)
            public open data class Middle(Tag int32, Value int32) : Root(Tag)
            public data class Leaf(Tag int32, Value int32, Extra int32) : Middle(Tag, Value)
            public class Plain {
                public func Equals(other Plain?) bool -> false
            }
            """)) { IsLibrary = true };
        using var image = new MemoryStream();
        var result = compilation.Emit(image);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics));
        image.Position = 0;
        var context = new AssemblyLoadContext(nameof(Issue4777InheritedDataEqualityTests), isCollectible: true);
        try
        {
            var assembly = context.LoadFromStream(image);
            var root = assembly.GetType("NoInterface.Root", throwOnError: true);
            var middle = assembly.GetType("NoInterface.Middle", throwOnError: true);
            var leaf = assembly.GetType("NoInterface.Leaf", throwOnError: true);
            var plain = assembly.GetType("NoInterface.Plain", throwOnError: true);
            // ADR-0199: a data type implements IEquatable<Self> without naming
            // it, as a C# record does; an ordinary class with an `Equals(Self)`
            // method still implements nothing.
            Assert.Equal(new[] { typeof(IEquatable<>).MakeGenericType(root) }, root.GetInterfaces());
            Assert.Equal(
                new[] { root, middle, leaf }.Select(type => typeof(IEquatable<>).MakeGenericType(type)).ToHashSet(),
                leaf.GetInterfaces().ToHashSet());
            Assert.Empty(plain.GetInterfaces());
            var slot = middle.GetMethod("Equals", new[] { root });
            Assert.NotNull(slot);
            Assert.True(slot.IsVirtual);
            Assert.True(slot.IsFinal);
            Assert.Equal(root, slot.GetBaseDefinition().DeclaringType);
            var first = Activator.CreateInstance(leaf, 1, 2, 3);
            var different = Activator.CreateInstance(leaf, 1, 2, 4);
            var same = Activator.CreateInstance(leaf, 1, 2, 3);
            foreach (var owner in new[] { root, middle, leaf })
            {
                var equals = owner.GetMethod("Equals", new[] { owner });
                Assert.NotNull(equals);
                Assert.Equal(false, equals.Invoke(first, new[] { different }));
                Assert.Equal(true, equals.Invoke(first, new[] { same }));
                Assert.Equal(true, equals.Invoke(first, new[] { first }));
                Assert.Equal(false, equals.Invoke(first, new object[] { null }));
            }

            var ordinary = plain.GetMethod("Equals", new[] { plain });
            Assert.NotNull(ordinary);
            Assert.False(ordinary.IsVirtual);
        }
        finally
        {
            context.Unload();
        }
    }

    [Fact]
    public void UserAuthoredTypedBaseOverride_RemainsReserved()
    {
        var result = EmittedOracle.Evaluate("""
            open data class Root(Tag int32)
            data class Leaf(Tag int32, Extra int32) : Root(Tag) {
                public override func Equals(other Root?) bool -> false
            }
            0
            """);
        var diagnostic = Assert.Single(result.Diagnostics, d => d.Id == "GS0232");
        Assert.Contains("Data class 'Leaf' synthesizes member 'Equals'", diagnostic.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("class Plain : IEquatable[Plain] {}")]
    [InlineData("data class Wrong(Value int32) : IEquatable[string]")]
    public void CompilerOwnedEquality_DoesNotSatisfyWrongOrPlainContract(string declaration)
    {
        var compilation = new Compilation(SyntaxTree.Parse("import System\n" + declaration)) { IsLibrary = true };
        var diagnostics = EmittedOracle.CompileDiagnostics(compilation);
        Assert.Contains(diagnostics, d => d.Id == "GS0187");
    }
}
