// <copyright file="Issue4755ExpressionTreeInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4755ExpressionTreeInitializerEmitTests
{
    [Theory]
    [InlineData("int32", "7", "7", false)]
    [InlineData("string", "\"text\"", "text", false)]
    [InlineData("int32", "7", "7", true)]
    public void SuppliedPrimary_TreeConstructorOwnsTypedDeclarationInitializer(string argument, string literal, string expected, bool publicField)
    {
        InDirectory(directory =>
        {
            var native = EmitNative(directory);
            var image = Compile(directory, $$"""
                package PrimaryTree4755
                import System
                import System.Linq.Expressions
                struct Holder[T](Value T) {
                    {{(publicField ? "public var" : "private let")}} Copy T = Value
                    public func Read() T -> Copy
                }
                class Api {
                    shared {
                        public func Build() Expression[Func[Holder[{{argument}}]]] -> () -> Holder[{{argument}}]{Value: {{literal}}}
                    }
                }
                """, native);
            IlVerifier.Verify(image, new[] { native });
            var assemblies = EmittedFixture.LoadTogether(native, image);
            var tree = Tree(assemblies[1], "PrimaryTree4755.Api", "Build");
            var construction = Assert.Single(Constructions(tree));
            var owner = tree.ReturnType;
            Assert.Equal(owner, construction.Constructor.DeclaringType);
            Assert.Equal(new[] { argument == "int32" ? typeof(int) : typeof(string) }, owner.GetGenericArguments());
            Assert.Equal(owner.GetGenericArguments()[0], Assert.Single(construction.Constructor.GetParameters()).ParameterType);
            var copy = owner.GetField("Copy", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            Assert.Equal(owner, copy.DeclaringType);
            Assert.Equal(!publicField, copy.IsPrivate);
            Assert.Equal(!publicField, copy.IsInitOnly);
            var value = tree.Compile().DynamicInvoke();
            Assert.Equal(expected, owner.GetMethod("Read").Invoke(value, null).ToString());
            var oracle = Tree(assemblies[0], "NativePrimaryTree4755.Oracle", argument == "int32" ? "Scalar" : "Text");
            var nativeValue = oracle.Compile().DynamicInvoke();
            Assert.Equal(expected, oracle.ReturnType.GetMethod("Read").Invoke(nativeValue, null).ToString());
        });
    }

    [Fact]
    public void ReorderedPrimaryAndMemberInit_CaptureOncePerInvocationBeforeDeclarationInitialization()
    {
        InDirectory(directory =>
        {
            var native = EmitNative(directory);
            var image = Compile(directory, """
                package OrderedTree4755
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
                }
                """, native);
            IlVerifier.Verify(image, new[] { native });
            var assemblies = EmittedFixture.LoadTogether(native, image);
            var effects = assemblies[0].GetType("NativePrimaryTree4755.Effects", throwOnError: true);
            var trace = effects.GetField("Trace");
            var tree = Tree(assemblies[1], "OrderedTree4755.Api", "Build");
            Assert.Equal(string.Empty, trace.GetValue(null));
            var block = Assert.IsAssignableFrom<BlockExpression>(tree.Body);
            Assert.Equal(2, block.Variables.Count);
            var memberInit = Assert.IsType<MemberInitExpression>(block.Expressions.Last());
            Assert.Equal("Extra", Assert.Single(memberInit.Bindings).Member.Name);
            Assert.Equal(tree.ReturnType, memberInit.NewExpression.Constructor.DeclaringType);
            Assert.Equal(new[] { typeof(int), typeof(int) }, memberInit.NewExpression.Constructor.GetParameters().Select(parameter => parameter.ParameterType));
            var compiled = tree.Compile();
            for (var invocation = 0; invocation < 2; invocation++)
            {
                trace.SetValue(null, string.Empty);
                Assert.Equal("7/2/7/9", Describe(compiled.DynamicInvoke()));
                Assert.Equal("BAIE", trace.GetValue(null));
            }

            trace.SetValue(null, string.Empty);
            var ordinary = assemblies[1].GetType("OrderedTree4755.Api", throwOnError: true).GetMethod("Ordinary").Invoke(null, null);
            Assert.Equal("7/2/7/9", Describe(ordinary));
            Assert.Equal("BAIE", trace.GetValue(null));
            trace.SetValue(null, string.Empty);
            var oracle = Tree(assemblies[0], "NativePrimaryTree4755.Oracle", "Ordered");
            Assert.Equal(string.Empty, trace.GetValue(null));
            Assert.Equal("7/2/7/9", Describe(oracle.Compile().DynamicInvoke()));
            Assert.Equal("BAIE", trace.GetValue(null));
        });
    }

    [Fact]
    public void CapturedAndParameterInputs_AreTreeLocalsNotCreationTimeConstants()
    {
        InDirectory(directory =>
        {
            var native = EmitNative(directory);
            var image = Compile(directory, """
                package CapturedTree4755
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
                }
                """, native);
            IlVerifier.Verify(image, new[] { native });
            var assemblies = EmittedFixture.LoadTogether(native, image);
            var tree = Tree(assemblies[1], "CapturedTree4755.Api", "Captured");
            var oracle = Tree(assemblies[0], "NativePrimaryTree4755.Oracle", "Captured");
            Assert.Equal(11, tree.ReturnType.GetMethod("Read").Invoke(tree.Compile().DynamicInvoke(), null));
            Assert.Equal(11, oracle.ReturnType.GetMethod("Read").Invoke(oracle.Compile().DynamicInvoke(), null));
            var parameterized = Tree(assemblies[1], "CapturedTree4755.Api", "Parameter");
            Assert.Equal(typeof(int), Assert.Single(parameterized.Parameters).Type);
            Assert.Equal(13, parameterized.ReturnType.GetMethod("Read").Invoke(parameterized.Compile().DynamicInvoke(13), null));
        });
    }

    [Fact]
    public void EnclosingGeneric_KeepsConstructorIdentity()
    {
        InDirectory(directory =>
        {
            var native = EmitNative(directory);
            var image = Compile(directory, """
                package EnclosingTree4755
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
                }
                """, native);
            IlVerifier.Verify(image, new[] { native });
            var assemblies = EmittedFixture.LoadTogether(native, image);
            var nested = Tree(assemblies[1], "EnclosingTree4755.Api", "Nested");
            Assert.Equal(nested.ReturnType, Assert.Single(Constructions(nested)).Constructor.DeclaringType);
            Assert.Equal(new[] { typeof(int) }, nested.ReturnType.GetGenericArguments());
            Assert.Equal(17, nested.ReturnType.GetMethod("Read").Invoke(nested.Compile().DynamicInvoke(), null));
        });
    }

    [Fact]
    public void OmittedPrimaryAndScalar_KeepExistingZeroAndExpressionTreeBehavior()
    {
        InDirectory(directory =>
        {
            var native = EmitNative(directory);
            var image = Compile(directory, """
                package ZeroTree4755
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
                }
                """, native);
            IlVerifier.Verify(image, new[] { native });
            var assemblies = EmittedFixture.LoadTogether(native, image);
            var omitted = Tree(assemblies[1], "ZeroTree4755.Api", "Omitted");
            Assert.Equal(omitted.ReturnType, Assert.Single(Constructions(omitted)).Constructor.DeclaringType);
            Assert.Equal(0, omitted.ReturnType.GetMethod("Read").Invoke(omitted.Compile().DynamicInvoke(), null));
            Assert.Equal(7, Tree(assemblies[1], "ZeroTree4755.Api", "Scalar").Compile().DynamicInvoke());
        });
    }

    private static LambdaExpression Tree(Assembly assembly, string type, string method) =>
        Assert.IsAssignableFrom<LambdaExpression>(assembly.GetType(type, throwOnError: true).GetMethod(method).Invoke(null, null));

    private static List<NewExpression> Constructions(LambdaExpression tree)
    {
        var visitor = new ConstructorVisitor();
        visitor.Visit(tree.Body);
        return visitor.Constructors;
    }

    private static string Describe(object value)
    {
        var type = value.GetType();
        return type.GetField("First").GetValue(value) + "/" + type.GetField("Second").GetValue(value) + "/" +
            type.GetMethod("Read").Invoke(value, null) + "/" + type.GetField("Extra").GetValue(value);
    }

    private static string EmitNative(string directory)
    {
        var path = Path.Combine(directory, "NativePrimaryTree4755.dll");
        var compilation = CSharpCompilation.Create(
            "NativePrimaryTree4755",
            new[] { CSharpSyntaxTree.ParseText("""
                using System;
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
                }
                """) },
            RuntimeReferences().Select(reference => MetadataReference.CreateFromFile(reference)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        IlVerifier.Verify(path);
        return path;
    }

    private static string Compile(string directory, string source, string reference)
    {
        var sourcePath = Path.Combine(directory, "Fixture.gs");
        var path = Path.Combine(directory, "Fixture.dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new[] { "/target:library", "/assemblyname:Fixture", "/out:" + path, "/targetframework:net10.0" }
            .Concat(RuntimeReferences().Append(reference).Select(item => "/reference:" + item)).Append(sourcePath).ToArray();
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            var exit = Program.Main(arguments);
            Assert.True(exit == 0, stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return path;
    }

    private static string[] RuntimeReferences() =>
        Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll");

    private static void InDirectory(Action<string> test)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "Issue4755Tree-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            test(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private sealed class ConstructorVisitor : ExpressionVisitor
    {
        public List<NewExpression> Constructors { get; } = new();

        protected override Expression VisitNew(NewExpression node)
        {
            this.Constructors.Add(node);
            return base.VisitNew(node);
        }
    }
}
