// <copyright file="Issue4785InheritedTupleReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;
using static GSharp.Compiler.Tests.Emit.Issue4738InheritedTupleArgumentEmitTests;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4785InheritedTupleReturnEmitTests
{
    [Theory]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(3, false)]
    [InlineData(4, false)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    [InlineData(3, true)]
    [InlineData(4, true)]
    public void GenericReturn_PreservesDeclaringOwnerAndMethodVectors(int owner, bool valueElement)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue4785InheritedTupleReturnEmitTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var contractPath = CompileContract(directory);
            var declaration = owner switch
            {
                0 => "",
                1 => "class Leaf[T] : ReturnOwner[string, T] {}",
                2 => "open class Middle[A, B] : ReturnOwner[B, A] {}\nclass Leaf[T] : Middle[T, string] {}",
                3 => "class Leaf[T] : ReorderedReturnOwner[T, string] {}",
                _ => "class Leaf[T] : NestedReturnOwner[string, T] {}",
            };
            var receiver = owner == 0 ? "ReturnOwner[string, Item]" : "Leaf[Item]";
            var element = owner == 4 ? "List[Item]" : "Item";
            var source = $$"""
                package Issue4785.Consumer
                import System.Collections.Generic
                import Issue4738.Contracts
                {{(valueElement ? "struct" : "class")}} Item(Label int32) {}
                {{declaration}}
                public func Fail[U](item {{element}}, value U) ({{element}}, U) ->
                    {{receiver}}().Mix[U]((item, value))
                public func Ordered[U, V](item {{element}}, first U, second V) ({{element}}, V, U, string) ->
                    {{receiver}}().Vector[U, V]((item, second, first, "owner"))
                public func NewItem() Item -> Item(37)
                """;
            var outputPath = Compile(directory, source, contractPath);
            IlVerifier.Verify(outputPath, additionalReferences: new[] { contractPath });
            var loaded = EmittedFixture.LoadTogether(contractPath, outputPath);
            var assembly = loaded[1];
            var item = Assert.IsAssignableFrom<object>(FindMethod(assembly, "NewItem").Invoke(null, null));
            var itemType = item.GetType();
            object argument = item;
            if (owner == 4)
            {
                var list = Assert.IsAssignableFrom<IList>(Activator.CreateInstance(typeof(System.Collections.Generic.List<>).MakeGenericType(itemType)));
                list.Add(item);
                argument = list;
            }

            var elementType = argument.GetType();
            var fail = FindMethod(assembly, "Fail");
            var u = Assert.Single(fail.GetGenericArguments());
            Assert.Equal("U", u.Name);
            Assert.Equal(typeof(ValueTuple<,>).MakeGenericType(elementType, u), fail.ReturnType);
            Assert.Equal(new[] { elementType, u }, fail.GetParameters().Select(parameter => parameter.ParameterType));
            AssertCallVectors(fail, "Mix", loaded[0], elementType);
            if (owner != 0)
            {
                var leaf = Assert.Single(assembly.GetTypes(), type => type.Name == "Leaf`1").MakeGenericType(itemType);
                var declaringOwner = leaf.BaseType;
                while (declaringOwner.GetGenericTypeDefinition().Name != "ReturnOwner`2")
                {
                    declaringOwner = declaringOwner.BaseType;
                }

                Assert.Equal(loaded[0].GetType("Issue4738.Contracts.ReturnOwner`2"), declaringOwner.GetGenericTypeDefinition());
                Assert.Equal(new[] { typeof(string), elementType }, declaringOwner.GetGenericArguments());
            }

            var markerType = Assert.Single(loaded[0].GetTypes(), type => type.Name == "Marker");
            var marker = Assert.IsAssignableFrom<object>(Activator.CreateInstance(markerType, 41));
            foreach (var value in new[] { item, marker, (object)43 })
            {
                var closed = fail.MakeGenericMethod(value.GetType());
                var tuple = typeof(ValueTuple<,>).MakeGenericType(elementType, value.GetType());
                Assert.Equal(tuple, closed.ReturnType);
                var result = Assert.IsAssignableFrom<object>(closed.Invoke(null, new[] { argument, value }));
                Assert.Equal(tuple, result.GetType());
                AssertElement(argument, tuple.GetField("Item1").GetValue(result));
                AssertElement(value, tuple.GetField("Item2").GetValue(result));
            }

            var ordered = FindMethod(assembly, "Ordered");
            var methodArguments = ordered.GetGenericArguments();
            Assert.Equal(new[] { "U", "V" }, methodArguments.Select(type => type.Name));
            Assert.Equal(
                typeof(ValueTuple<,,,>).MakeGenericType(elementType, methodArguments[1], methodArguments[0], typeof(string)),
                ordered.ReturnType);
            AssertCallVectors(ordered, "Vector", loaded[0], elementType);
            foreach (var values in new[] { new[] { marker, (object)47 }, new[] { (object)53, marker } })
            {
                var closed = ordered.MakeGenericMethod(values.Select(value => value.GetType()).ToArray());
                var tuple = typeof(ValueTuple<,,,>).MakeGenericType(elementType, values[1].GetType(), values[0].GetType(), typeof(string));
                Assert.Equal(tuple, closed.ReturnType);
                var result = Assert.IsAssignableFrom<object>(closed.Invoke(null, new[] { argument, values[0], values[1] }));
                Assert.Equal(tuple, result.GetType());
                AssertElement(argument, tuple.GetField("Item1").GetValue(result));
                AssertElement(values[1], tuple.GetField("Item2").GetValue(result));
                AssertElement(values[0], tuple.GetField("Item3").GetValue(result));
                Assert.Equal("owner", tuple.GetField("Item4").GetValue(result));
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ConstrainedGenericReturns_PreserveForwardedMethodConstraints()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue4785InheritedTupleReturnEmitTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var contractPath = CompileContract(directory);
            var outputPath = Compile(directory, """
                package Issue4785.Constrained
                import Issue4738.Contracts
                class Item(Label int32) {}
                class Leaf[T] : ReorderedReturnOwner[T, string] {}
                public func Reference[U class](item Item, value U) (Item, U) ->
                    Leaf[Item]().Reference[U]((item, value))
                public func Value[U struct](item Item, value U) (Item, U) ->
                    Leaf[Item]().Value[U]((item, value))
                public func Open[T, U](item T, value U) (T, U) ->
                    Leaf[T]().Mix[U]((item, value))
                public func Closed(item Marker, value int32) (Marker, int32) ->
                    Leaf[Marker]().Mix[int32]((item, value))
                public func NewItem() Item -> Item(37)
                """, contractPath);
            IlVerifier.Verify(outputPath, additionalReferences: new[] { contractPath });
            var loaded = EmittedFixture.LoadTogether(contractPath, outputPath);
            var assembly = loaded[1];
            var item = Assert.IsAssignableFrom<object>(FindMethod(assembly, "NewItem").Invoke(null, null));
            foreach (var name in new[] { "Reference", "Value" })
            {
                var method = FindMethod(assembly, name);
                var parameter = Assert.Single(method.GetGenericArguments());
                Assert.True((parameter.GenericParameterAttributes & (name == "Reference"
                    ? GenericParameterAttributes.ReferenceTypeConstraint
                    : GenericParameterAttributes.NotNullableValueTypeConstraint)) != 0);
                var value = name == "Reference" ? item : (object)59;
                var closed = method.MakeGenericMethod(value.GetType());
                var result = Assert.IsAssignableFrom<object>(closed.Invoke(null, new[] { item, value }));
                Assert.Equal(typeof(ValueTuple<,>).MakeGenericType(item.GetType(), value.GetType()), result.GetType());
                Assert.Same(item, result.GetType().GetField("Item1").GetValue(result));
                AssertElement(value, result.GetType().GetField("Item2").GetValue(result));
            }

            var open = FindMethod(assembly, "Open");
            var arguments = open.GetGenericArguments();
            Assert.Equal(new[] { "T", "U" }, arguments.Select(type => type.Name));
            Assert.Equal(typeof(ValueTuple<,>).MakeGenericType(arguments), open.ReturnType);
            foreach (var first in new[] { item, (object)61 })
            {
                var result = Assert.IsAssignableFrom<object>(open.MakeGenericMethod(first.GetType(), typeof(int)).Invoke(null, new[] { first, (object)67 }));
                Assert.Equal(typeof(ValueTuple<,>).MakeGenericType(first.GetType(), typeof(int)), result.GetType());
                AssertElement(first, result.GetType().GetField("Item1").GetValue(result));
                Assert.Equal(67, result.GetType().GetField("Item2").GetValue(result));
            }

            var markerType = Assert.Single(loaded[0].GetTypes(), type => type.Name == "Marker");
            var marker = Assert.IsAssignableFrom<object>(Activator.CreateInstance(markerType, 71));
            var closedControl = FindMethod(assembly, "Closed");
            Assert.Equal(typeof(ValueTuple<,>).MakeGenericType(markerType, typeof(int)), closedControl.ReturnType);
            var pair = Assert.IsAssignableFrom<object>(closedControl.Invoke(null, new[] { marker, (object)73 }));
            Assert.Same(marker, pair.GetType().GetField("Item1").GetValue(pair));
            Assert.Equal(73, pair.GetType().GetField("Item2").GetValue(pair));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("public func Wrong[U](item Item, value U) (string, U) -> Leaf[Item]().Mix[U]((item, value))", "GS0155")]
    [InlineData("public func Wrong(item Item) (Item, int32) -> Leaf[Item]().Reference[int32]((item, 1))", "GS0159")]
    [InlineData("public func Wrong(item Item) (Item, Item) -> Leaf[Item]().Value[Item]((item, item))", "GS0159")]
    public void GenericReturn_InvalidOwnerOrConstraintIsRejected(string function, string diagnostic)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue4785InheritedTupleReturnEmitTests), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var contractPath = CompileContract(directory);
            var sourcePath = Path.Combine(directory, "Rejected.gs");
            var outputPath = Path.Combine(directory, "Rejected.dll");
            File.WriteAllText(sourcePath, $$"""
                package Issue4785.Rejected
                import Issue4738.Contracts
                class Item {}
                class Leaf[T] : ReorderedReturnOwner[T, string] {}
                {{function}}
                """);
            var (exitCode, output) = RunCompiler(sourcePath, outputPath, contractPath);
            Assert.NotEqual(0, exitCode);
            Assert.Contains("error " + diagnostic + ":", output, StringComparison.Ordinal);
            Assert.Contains(sourcePath + "(5,", output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal);
            Assert.False(File.Exists(outputPath));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static void AssertCallVectors(MethodInfo method, string name, Assembly contract, Type elementType)
    {
        var calls = IlInstructionReader.Read(method.GetMethodBody().GetILAsByteArray())
            .Where(instruction => instruction.MetadataToken.HasValue)
            .Select(instruction => method.Module.ResolveMethod(instruction.MetadataToken.GetValueOrDefault(), null, method.GetGenericArguments()))
            .OfType<MethodInfo>()
            .Where(call => call.Name == name);
        var call = Assert.Single(calls);
        Assert.Equal(
            contract.GetType("Issue4738.Contracts.ReturnOwner`2").MakeGenericType(typeof(string), elementType),
            call.DeclaringType);
        Assert.Equal(method.GetGenericArguments(), call.GetGenericArguments());
    }

    private static void AssertElement(object expected, object actual)
    {
        if (expected.GetType().IsValueType)
        {
            Assert.Equal(expected, actual);
        }
        else
        {
            Assert.Same(expected, actual);
        }
    }
}
