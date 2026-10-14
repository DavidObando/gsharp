// <copyright file="Issue4755ExpressionTreeInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import GSharp.Tests
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import ExpressionsBlockExpression = System.Linq.Expressions.BlockExpression
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler
import GSharp.Compiler.Tests

class Issue4755ExpressionTreeInitializerEmitTests {
    @Theory
    @InlineData("int32", "7", "7", false)
    @InlineData("string", "\"text\"", "text", false)
    @InlineData("int32", "7", "7", true)
    func SuppliedPrimary_TreeConstructorOwnsTypedDeclarationInitializer(
        argument string,
        literal string,
        expected string,
        publicField bool
    ) {
        InDirectory(
            (directory string) -> {
                let native = EmitNative(directory)
                let image = Compile(directory, (`package PrimaryTree4755
import System
import System.Linq.Expressions
struct Holder[T](Value T) {
    ` + "${(if publicField { "public var" } else { "private let" })}" + ` Copy T = Value
    public func Read() T -> Copy
}
class Api {
    shared {
        public func Build() Expression[Func[Holder[` + "$argument" + `]]] -> () -> Holder[` + "$argument" + `]{Value: ` + "$literal" + `}
    }
}`), native)
                IlVerifier.Verify(image, []string{native})
                let assemblies = EmittedFixture.LoadTogether(native, image)
                let tree = Tree(assemblies[1], "PrimaryTree4755.Api", "Build")
                let construction = Assert.Single(Constructions(tree))
                let owner = tree.ReturnType
                Assert.Equal(owner, construction.Constructor!!.DeclaringType)
                Assert.Equal(
                    []Type{
                        if argument == "int32" {
                            typeof(int32)
                        } else {
                            typeof(string)
                        }
                    },
                    owner.GetGenericArguments()
                )
                Assert.Equal(
                    owner.GetGenericArguments()[0],
                    Assert.Single(construction.Constructor!!.GetParameters()).ParameterType
                )
                let copy FieldInfo? = owner.GetField(
                    "Copy",
                    BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public
                )
                Assert.Equal(owner, copy!!.DeclaringType)
                Assert.Equal(!publicField, copy!!.IsPrivate)
                Assert.Equal(!publicField, copy!!.IsInitOnly)
                let value object? = tree.Compile().DynamicInvoke()
                Assert.Equal(expected, owner.GetMethod("Read")!!.Invoke(value, nil)!!.ToString())
                let oracle = Tree(
                    assemblies[0],
                    "NativePrimaryTree4755.Oracle",
                    if argument == "int32" {
                        "Scalar"
                    } else {
                        "Text"
                    }
                )
                let nativeValue object? = oracle.Compile().DynamicInvoke()
                Assert.Equal(expected, oracle.ReturnType.GetMethod("Read")!!.Invoke(nativeValue, nil)!!.ToString())
            }
        )
    }

    @Fact
    func ReorderedPrimaryAndMemberInit_CaptureOncePerInvocationBeforeDeclarationInitialization() {
        InDirectory(
            (directory string) -> {
                let native = EmitNative(directory)
                let image = Compile(directory, `package OrderedTree4755
import System
import System.Linq.Expressions
import NativePrimaryTree4755
struct Pair[T](First T, Second T) {
    private let Copy T = Effects.Copy(First)
    public var Extra int32
    public func Read() T -> Copy
}
class Api {
    shared {
        public func Build() Expression[Func[Pair[int32]]] ->
            () -> Pair[int32]{Second: Effects.Mark("B", 2), First: Effects.Mark("A", 7), Extra: Effects.Mark("E", 9)}
        public func Ordinary() Pair[int32] ->
            Pair[int32]{Second: Effects.Mark("B", 2), First: Effects.Mark("A", 7), Extra: Effects.Mark("E", 9)}
    }
}`, native)
                IlVerifier.Verify(image, []string{native})
                let assemblies = EmittedFixture.LoadTogether(native, image)
                let effects Type? = assemblies[0].GetType("NativePrimaryTree4755.Effects", throwOnError: true)
                let trace FieldInfo? = effects!!.GetField("Trace")
                let tree = Tree(assemblies[1], "OrderedTree4755.Api", "Build")
                Assert.Equal(string.Empty, trace!!.GetValue(nil))
                let block = Assert.IsAssignableFrom[ExpressionsBlockExpression](tree.Body)
                Assert.Equal(2, block.Variables.Count)
                let memberInit = Assert.IsType[MemberInitExpression](block.Expressions.Last())
                Assert.Equal("Extra", Assert.Single(memberInit.Bindings).Member.Name)
                Assert.Equal(tree.ReturnType, memberInit.NewExpression.Constructor!!.DeclaringType)
                Assert.Equal(
                    []Type{typeof(int32), typeof(int32)},
                    memberInit.NewExpression.Constructor!!.GetParameters().Select(
                        (parameter ParameterInfo) -> parameter.ParameterType
                    )
                )
                let compiled = tree.Compile()
                for var invocation = 0; invocation < 2; invocation++ {
                    trace!!.SetValue(nil, string.Empty)
                    Assert.Equal("7/2/7/9", Describe(compiled.DynamicInvoke()))
                    Assert.Equal("BAIE", trace!!.GetValue(nil))
                }
                trace!!.SetValue(nil, string.Empty)
                let ordinary object? = assemblies[1].GetType("OrderedTree4755.Api", throwOnError: true)!!.GetMethod(
                    "Ordinary"
                )!!.Invoke(nil, nil)
                Assert.Equal("7/2/7/9", Describe(ordinary))
                Assert.Equal("BAIE", trace!!.GetValue(nil))
                trace!!.SetValue(nil, string.Empty)
                let oracle = Tree(assemblies[0], "NativePrimaryTree4755.Oracle", "Ordered")
                Assert.Equal(string.Empty, trace!!.GetValue(nil))
                Assert.Equal("7/2/7/9", Describe(oracle.Compile().DynamicInvoke()))
                Assert.Equal("BAIE", trace!!.GetValue(nil))
            }
        )
    }

    @Fact
    func CapturedAndParameterInputs_AreTreeLocalsNotCreationTimeConstants() {
        InDirectory(
            (directory string) -> {
                let native = EmitNative(directory)
                let image = Compile(directory, `package CapturedTree4755
import System
import System.Linq.Expressions
struct Holder[T](Value T) {
    private let Copy T = Value
    public func Read() T -> Copy
}
class Api {
    shared {
        public func Captured() Expression[Func[Holder[int32]]] {
            var value = 7
            let tree Expression[Func[Holder[int32]]] = () -> Holder[int32]{Value: value}
            value = 11
            return tree
        }
        public func Parameter() Expression[Func[int32, Holder[int32]]] ->
            (value int32) -> Holder[int32]{Value: value}
    }
}`, native)
                IlVerifier.Verify(image, []string{native})
                let assemblies = EmittedFixture.LoadTogether(native, image)
                let tree = Tree(assemblies[1], "CapturedTree4755.Api", "Captured")
                let oracle = Tree(assemblies[0], "NativePrimaryTree4755.Oracle", "Captured")
                Assert.Equal(11, tree.ReturnType.GetMethod("Read")!!.Invoke(tree.Compile().DynamicInvoke(), nil))
                Assert.Equal(11, oracle.ReturnType.GetMethod("Read")!!.Invoke(oracle.Compile().DynamicInvoke(), nil))
                let parameterized = Tree(assemblies[1], "CapturedTree4755.Api", "Parameter")
                Assert.Equal(typeof(int32), Assert.Single(parameterized.Parameters).Type)
                Assert.Equal(
                    13,
                    parameterized.ReturnType.GetMethod("Read")!!.Invoke(parameterized.Compile().DynamicInvoke(13), nil)
                )
            }
        )
    }

    @Fact
    func EnclosingGeneric_KeepsConstructorIdentity() {
        InDirectory(
            (directory string) -> {
                let native = EmitNative(directory)
                let image = Compile(directory, `package EnclosingTree4755
import System
import System.Linq.Expressions
class Outer[T] {
    public struct Holder(Value T) {
        private let Copy T = Value
        public func Read() T -> Copy
    }
}
class Api {
    shared {
        public func Nested() Expression[Func[Outer[int32].Holder]] -> () -> Outer[int32].Holder{Value: 17}
    }
}`, native)
                IlVerifier.Verify(image, []string{native})
                let assemblies = EmittedFixture.LoadTogether(native, image)
                let nested = Tree(assemblies[1], "EnclosingTree4755.Api", "Nested")
                Assert.Equal(nested.ReturnType, Assert.Single(Constructions(nested)).Constructor!!.DeclaringType)
                Assert.Equal([]Type{typeof(int32)}, nested.ReturnType.GetGenericArguments())
                Assert.Equal(17, nested.ReturnType.GetMethod("Read")!!.Invoke(nested.Compile().DynamicInvoke(), nil))
            }
        )
    }

    @Fact
    func OmittedPrimaryAndScalar_KeepExistingZeroAndExpressionTreeBehavior() {
        InDirectory(
            (directory string) -> {
                let native = EmitNative(directory)
                let image = Compile(directory, `package ZeroTree4755
import System
import System.Linq.Expressions
struct Holder[T](Value T) {
    private let Copy T = Value
    public func Read() T -> Copy
}
class Api {
    shared {
        public func Omitted() Expression[Func[Holder[int32]]] -> () -> Holder[int32]{}
        public func Scalar() Expression[Func[int32]] -> () -> 7
    }
}`, native)
                IlVerifier.Verify(image, []string{native})
                let assemblies = EmittedFixture.LoadTogether(native, image)
                let omitted = Tree(assemblies[1], "ZeroTree4755.Api", "Omitted")
                Assert.Equal(omitted.ReturnType, Assert.Single(Constructions(omitted)).Constructor!!.DeclaringType)
                Assert.Equal(0, omitted.ReturnType.GetMethod("Read")!!.Invoke(omitted.Compile().DynamicInvoke(), nil))
                Assert.Equal(7, Tree(assemblies[1], "ZeroTree4755.Api", "Scalar").Compile().DynamicInvoke())
            }
        )
    }

    private class ConstructorVisitor : ExpressionVisitor {
        init() {
            Constructors = List[NewExpression]()
        }

        prop Constructors List[NewExpression] {
            get;
        }

        protected override func VisitNew(node NewExpression) Expression {
            this.Constructors.Add(node)
            return base.VisitNew(node)
        }
    }

    shared {
        private func Tree(assembly Assembly, type string, method string) ExpressionsLambdaExpression -> Assert
            .IsAssignableFrom[ExpressionsLambdaExpression](
            assembly.GetType(type, throwOnError: true)!!.GetMethod(method)!!.Invoke(nil, nil)
        )

        private func Constructions(tree ExpressionsLambdaExpression) List[NewExpression] {
            let visitor = ConstructorVisitor()
            visitor.Visit(tree.Body)
            return visitor.Constructors
        }

        private func Describe(value object?) string {
            let type = value!!.GetType()
            return type.GetField("First")!!.GetValue(value)?.ToString() + "/" + type.GetField("Second")!!.GetValue(
                value
            )
                ?.ToString() + "/" + type.GetMethod("Read")!!.Invoke(value, nil)?.ToString() + "/" + type.GetField(
                "Extra"
            )!!
                .GetValue(value)?.ToString()
        }

        private func EmitNative(directory string) string {
            let path = Path.Combine(directory, "NativePrimaryTree4755.dll")
            let compilation = CSharpCompilation.Create("NativePrimaryTree4755", []SyntaxTree{CSharpSyntaxTree.ParseText(`using System;
using System.Linq.Expressions;
namespace NativePrimaryTree4755;
public static class Effects
{
    public static string Trace = "";
    public static int Mark(string label, int value) { Trace += label; return value; }
    public static T Copy<T>(T value) { Trace += "I"; return value; }
}
public struct Holder<T>(T value)
{
    public T Value = value;
    private readonly T copy = value;
    public T Read() => copy;
}
public struct Pair<T>(T first, T second)
{
    public T First = first;
    public T Second = second;
    private readonly T copy = Effects.Copy(first);
    public int Extra;
    public T Read() => copy;
}
public static class Oracle
{
    public static Expression<Func<Holder<int>>> Scalar() => () => new Holder<int>(7);
    public static Expression<Func<Holder<string>>> Text() => () => new Holder<string>("text");
    public static Expression<Func<Holder<int>>> Captured()
    {
        int value = 7;
        Expression<Func<Holder<int>>> tree = () => new Holder<int>(value);
        value = 11;
        return tree;
    }
    public static Expression<Func<Pair<int>>> Ordered()
    {
        Expression<Func<int>> second = () => Effects.Mark("B", 2);
        Expression<Func<int>> first = () => Effects.Mark("A", 7);
        Expression<Func<int>> extra = () => Effects.Mark("E", 9);
        var a = Expression.Parameter(typeof(int), "first");
        var b = Expression.Parameter(typeof(int), "second");
        var construction = Expression.New(typeof(Pair<int>).GetConstructor(new[] { typeof(int), typeof(int) }), a, b);
        return Expression.Lambda<Func<Pair<int>>>(Expression.Block(new[] { b, a },
            Expression.Assign(b, second.Body), Expression.Assign(a, first.Body),
            Expression.MemberInit(construction, Expression.Bind(typeof(Pair<int>).GetField("Extra"), extra.Body))));
    }
}`)}, RuntimeReferences().Select(
                    (reference string) -> MetadataReference.CreateFromFile(reference)
                ), CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            let result = compilation.Emit(path)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            IlVerifier.Verify(path)
            return path
        }

        private func Compile(directory string, source string, reference string) string {
            let sourcePath = Path.Combine(directory, "Fixture.gs")
            let path = Path.Combine(directory, "Fixture.dll")
            File.WriteAllText(sourcePath, source)
            let arguments = []string{
                "/target:library",
                "/assemblyname:Fixture",
                "/out:" + path,
                "/targetframework:net10.0"
            }
                .Concat(RuntimeReferences().Append(reference).Select((item string) -> ("/reference:" + item)))
                .Append(sourcePath)
                .ToArray()
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                let exit = Program.Main(arguments)
                Assert.True(exit == 0, stdout.ToString() + stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return path
        }

        private func RuntimeReferences()[]string -> Directory.GetFiles(
            Path.GetDirectoryName(typeof(object).Assembly.Location)!!,
            "*.dll"
        )

        private func InDirectory(test(string) -> void) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue4755Tree-" + Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                test(directory)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
        }
    }
}
