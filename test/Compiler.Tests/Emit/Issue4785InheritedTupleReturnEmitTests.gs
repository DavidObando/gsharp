// <copyright file="Issue4785InheritedTupleReturnEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests.Emit.Issue4738InheritedTupleArgumentEmitTests
import GSharp.Compiler.Tests

class Issue4785InheritedTupleReturnEmitTests {
    @Theory
    @InlineData(int32(0), false)
    @InlineData(int32(1), false)
    @InlineData(int32(2), false)
    @InlineData(int32(3), false)
    @InlineData(int32(4), false)
    @InlineData(int32(0), true)
    @InlineData(int32(1), true)
    @InlineData(int32(2), true)
    @InlineData(int32(3), true)
    @InlineData(int32(4), true)
    func GenericReturn_PreservesDeclaringOwnerAndMethodVectors(owner int32, valueElement bool) {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4785InheritedTupleReturnEmitTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contractPath = CompileContract(directory)
            let declaration = switch owner {
                case 0: ""
                case 1: "class Leaf[T] : ReturnOwner[string, T] {}"
                case 2: "open class Middle[A, B] : ReturnOwner[B, A] {}\nclass Leaf[T] : Middle[T, string] {}"
                case 3: "class Leaf[T] : ReorderedReturnOwner[T, string] {}"
                default: "class Leaf[T] : NestedReturnOwner[string, T] {}"
            }
            let receiver = if owner == 0 {
                "ReturnOwner[string, Item]"
            } else {
                "Leaf[Item]"
            }
            let element = if owner == 4 {
                "List[Item]"
            } else {
                "Item"
            }
            let source = (`package Issue4785.Consumer
import System.Collections.Generic
import Issue4738.Contracts
` + "${(if valueElement { "struct" } else { "class" })}" + ` Item(Label int32) {}
` + "$declaration" + `
public func Fail[U](item ` + "$element" + `, value U) (` + "$element" + `, U) ->
    ` + "$receiver" + `().Mix[U]((item, value))
public func Ordered[U, V](item ` + "$element" + `, first U, second V) (` + "$element" + `, V, U, string) ->
    ` + "$receiver" + `().Vector[U, V]((item, second, first, "owner"))
public func NewItem() Item -> Item(37)`)
            let outputPath = Compile(directory, source, contractPath)
            IlVerifier.Verify(outputPath, additionalReferences: []string{contractPath})
            let loaded = EmittedFixture.LoadTogether(contractPath, outputPath)
            let assembly = loaded[1]
            let item = Assert.IsAssignableFrom[object](FindMethod(assembly, "NewItem").Invoke(nil, nil))
            let itemType = item.GetType()
            var argument = item
            if owner == 4 {
                let list = Assert.IsAssignableFrom[IList](
                    Activator.CreateInstance(typeof(System.Collections.Generic.List[_]).MakeGenericType(itemType))
                )
                list.Add(item)
                argument = list
            }
            let elementType = argument.GetType()
            let fail = FindMethod(assembly, "Fail")
            let u = Assert.Single(fail.GetGenericArguments())
            Assert.Equal("U", u.Name)
            Assert.Equal(typeof(ValueTuple[_, _]).MakeGenericType(elementType, u), fail.ReturnType)
            Assert.Equal(
                []Type{elementType, u},
                fail.GetParameters().Select((parameter ParameterInfo) -> parameter.ParameterType)
            )
            AssertCallVectors(fail, "Mix", loaded[0], elementType)
            if owner != 0 {
                let leaf = Assert.Single(assembly.GetTypes(), (type Type) -> type.Name == "Leaf`1").MakeGenericType(
                    itemType
                )
                var declaringOwner Type? = leaf.BaseType
                while declaringOwner!!.GetGenericTypeDefinition().Name != "ReturnOwner`2" {
                    declaringOwner = declaringOwner!!.BaseType
                }
                Assert.Equal(
                    loaded[0].GetType("Issue4738.Contracts.ReturnOwner`2"),
                    declaringOwner!!.GetGenericTypeDefinition()
                )
                Assert.Equal([]Type{typeof(string), elementType}, declaringOwner!!.GetGenericArguments())
            }
            let markerType = Assert.Single(loaded[0].GetTypes(), (type Type) -> type.Name == "Marker")
            let marker = Assert.IsAssignableFrom[object](Activator.CreateInstance(markerType, 41))
            for value in[]object{item, marker, object(43)} {
                let closed = fail.MakeGenericMethod(value.GetType())
                let tuple = typeof(ValueTuple[_, _]).MakeGenericType(elementType, value.GetType())
                Assert.Equal(tuple, closed.ReturnType)
                let result = Assert.IsAssignableFrom[object](closed.Invoke(nil, []object{argument, value}))
                Assert.Equal(tuple, result.GetType())
                AssertElement(argument, tuple.GetField("Item1")!!.GetValue(result))
                AssertElement(value, tuple.GetField("Item2")!!.GetValue(result))
            }
            let ordered = FindMethod(assembly, "Ordered")
            let methodArguments = ordered.GetGenericArguments()
            Assert.Equal([]string{"U", "V"}, methodArguments.Select((type Type) -> type.Name))
            Assert.Equal(
                typeof(ValueTuple[_, _, _, _]).MakeGenericType(
                    elementType,
                    methodArguments[1],
                    methodArguments[0],
                    typeof(string)
                ),
                ordered.ReturnType
            )
            AssertCallVectors(ordered, "Vector", loaded[0], elementType)
            for values in[][]object{[]object{marker, object(47)}, []object{object(53), marker}} {
                let closed = ordered.MakeGenericMethod(values.Select((value object) -> value.GetType()).ToArray())
                let tuple = typeof(ValueTuple[_, _, _, _]).MakeGenericType(
                    elementType,
                    values[1].GetType(),
                    values[0].GetType(),
                    typeof(string)
                )
                Assert.Equal(tuple, closed.ReturnType)
                let result = Assert.IsAssignableFrom[object](
                    closed.Invoke(nil, []object{argument, values[0], values[1]})
                )
                Assert.Equal(tuple, result.GetType())
                AssertElement(argument, tuple.GetField("Item1")!!.GetValue(result))
                AssertElement(values[1], tuple.GetField("Item2")!!.GetValue(result))
                AssertElement(values[0], tuple.GetField("Item3")!!.GetValue(result))
                Assert.Equal("owner", tuple.GetField("Item4")!!.GetValue(result))
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Fact
    func ConstrainedGenericReturns_PreserveForwardedMethodConstraints() {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4785InheritedTupleReturnEmitTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contractPath = CompileContract(directory)
            let outputPath = Compile(directory, `package Issue4785.Constrained
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
public func NewItem() Item -> Item(37)`, contractPath)
            IlVerifier.Verify(outputPath, additionalReferences: []string{contractPath})
            let loaded = EmittedFixture.LoadTogether(contractPath, outputPath)
            let assembly = loaded[1]
            let item = Assert.IsAssignableFrom[object](FindMethod(assembly, "NewItem").Invoke(nil, nil))
            for name in[]string{"Reference", "Value"} {
                let method = FindMethod(assembly, name)
                let parameter = Assert.Single(method.GetGenericArguments())
                Assert.True(
                    (
                        parameter.GenericParameterAttributes & (
                            if name == "Reference" {
                                GenericParameterAttributes.ReferenceTypeConstraint
                            } else {
                                GenericParameterAttributes.NotNullableValueTypeConstraint
                            }
                        )
                    ) != 0
                )
                let value = if name == "Reference" {
                    item
                } else {
                    object(59)
                }
                let closed = method.MakeGenericMethod(value.GetType())
                let result = Assert.IsAssignableFrom[object](closed.Invoke(nil, []object{item, value}))
                Assert.Equal(
                    typeof(ValueTuple[_, _]).MakeGenericType(item.GetType(), value.GetType()),
                    result.GetType()
                )
                Assert.Same(item, result.GetType().GetField("Item1")!!.GetValue(result))
                AssertElement(value, result.GetType().GetField("Item2")!!.GetValue(result))
            }
            let open_ = FindMethod(assembly, "Open")
            let arguments = open_.GetGenericArguments()
            Assert.Equal([]string{"T", "U"}, arguments.Select((type Type) -> type.Name))
            Assert.Equal(typeof(ValueTuple[_, _]).MakeGenericType(arguments), open_.ReturnType)
            for first in[]object{item, object(61)} {
                let result = Assert.IsAssignableFrom[object](
                    open_.MakeGenericMethod(first.GetType(), typeof(int32)).Invoke(nil, []object{first, object(67)})
                )
                Assert.Equal(typeof(ValueTuple[_, _]).MakeGenericType(first.GetType(), typeof(int32)), result.GetType())
                AssertElement(first, result.GetType().GetField("Item1")!!.GetValue(result))
                Assert.Equal(67, result.GetType().GetField("Item2")!!.GetValue(result))
            }
            let markerType = Assert.Single(loaded[0].GetTypes(), (type Type) -> type.Name == "Marker")
            let marker = Assert.IsAssignableFrom[object](Activator.CreateInstance(markerType, 71))
            let closedControl = FindMethod(assembly, "Closed")
            Assert.Equal(typeof(ValueTuple[_, _]).MakeGenericType(markerType, typeof(int32)), closedControl.ReturnType)
            let pair = Assert.IsAssignableFrom[object](closedControl.Invoke(nil, []object{marker, object(73)}))
            Assert.Same(marker, pair.GetType().GetField("Item1")!!.GetValue(pair))
            Assert.Equal(73, pair.GetType().GetField("Item2")!!.GetValue(pair))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    @Theory
    @InlineData("public func Wrong[U](item Item, value U) (string, U) -> Leaf[Item]().Mix[U]((item, value))", "GS0155")
    @InlineData("public func Wrong(item Item) (Item, int32) -> Leaf[Item]().Reference[int32]((item, 1))", "GS0159")
    @InlineData("public func Wrong(item Item) (Item, Item) -> Leaf[Item]().Value[Item]((item, item))", "GS0159")
    func GenericReturn_InvalidOwnerOrConstraintIsRejected(function string, diagnostic string) {
        let directory = Path.Combine(
            AppContext.BaseDirectory,
            "Issue4785InheritedTupleReturnEmitTests",
            Guid.NewGuid().ToString("N")
        )
        Directory.CreateDirectory(directory)
        try {
            let contractPath = CompileContract(directory)
            let sourcePath = Path.Combine(directory, "Rejected.gs")
            let outputPath = Path.Combine(directory, "Rejected.dll")
            File.WriteAllText(sourcePath, (`package Issue4785.Rejected
import Issue4738.Contracts
class Item {}
class Leaf[T] : ReorderedReturnOwner[T, string] {}
` + "$function"))
            let (exitCode, output) = RunCompiler(sourcePath, outputPath, contractPath)
            Assert.NotEqual(0, exitCode)
            Assert.Contains("error " + diagnostic + ":", output, StringComparison.Ordinal)
            Assert.Contains(sourcePath + "(5,", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
            Assert.False(File.Exists(outputPath))
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private func AssertCallVectors(method MethodInfo, name string, contract Assembly, elementType Type) {
            let calls = IlInstructionReader
                .Read(method.GetMethodBody()!!.GetILAsByteArray())
                .Where((instruction IlInstruction) -> (instruction.MetadataToken != nil))
                .Select(
                (instruction IlInstruction) -> method.Module.ResolveMethod(
                    instruction.MetadataToken.GetValueOrDefault(),
                    nil,
                    method.GetGenericArguments()
                )
            )
                .OfType[MethodInfo]()
                .Where((call MethodInfo) -> call.Name == name)
            let call = Assert.Single(calls)
            Assert.Equal(
                contract.GetType("Issue4738.Contracts.ReturnOwner`2")!!.MakeGenericType(typeof(string), elementType),
                call.DeclaringType
            )
            Assert.Equal(method.GetGenericArguments(), call.GetGenericArguments())
        }

        private func AssertElement(expected object, actual object?) {
            if expected.GetType().IsValueType {
                Assert.Equal(expected, actual)
            } else {
                Assert.Same(expected, actual)
            }
        }
    }
}
