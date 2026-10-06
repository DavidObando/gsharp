// <copyright file="Issue4675RecordExpressionTreeConstructorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4675RecordExpressionTreeConstructorTests
{
    private const string ContractSource = """
        using System;
        using System.Linq.Expressions;
        using System.Reflection;
        namespace TreeContracts;
        public static class Checks
        {
            private static NewExpression Construction(LambdaExpression tree)
            {
                Expression body = tree.Body;
                while (true)
                {
                    if (body is UnaryExpression unary &&
                        (unary.NodeType == ExpressionType.Convert || unary.NodeType == ExpressionType.ConvertChecked))
                    {
                        body = unary.Operand;
                    }
                    else if (body is BlockExpression block)
                    {
                        body = block.Expressions[block.Expressions.Count - 1];
                    }
                    else
                    {
                        return body as NewExpression ?? throw new Exception("Expected a constructor expression");
                    }
                }
            }
            public static string Ordinary(LambdaExpression tree, Type owner, Type argumentType)
            {
                var construction = Construction(tree);
                var constructor = construction.Constructor ?? throw new Exception("Missing constructor");
                var parameters = constructor.GetParameters();
                if (construction.Members != null || construction.Type != owner ||
                    constructor.DeclaringType != owner || parameters.Length != 1 ||
                    parameters[0].ParameterType != argumentType || construction.Arguments.Count != 1 ||
                    construction.Arguments[0].Type != argumentType)
                    throw new Exception("Ordinary construction must use the constructor/arguments overload");
                return "ordinary";
            }
            public static string Anonymous(LambdaExpression tree)
            {
                var construction = Construction(tree);
                var members = construction.Members ?? throw new Exception("Missing anonymous members");
                if (members.Count != 2 || construction.Arguments.Count != 2)
                    throw new Exception("Expected two anonymous constructor/member entries");
                string[] names = { "Value", "Alias" };
                Type[] types = { typeof(int), typeof(string) };
                for (int i = 0; i < members.Count; i++)
                {
                    if (members[i] is not PropertyInfo property || property.Name != names[i] ||
                        property.DeclaringType != construction.Type || property.PropertyType != types[i] ||
                        construction.Arguments[i].Type != types[i])
                        throw new Exception("Anonymous members must preserve property identity and argument order");
                }
                var value = tree.Compile().DynamicInvoke() ?? throw new Exception("Missing anonymous value");
                if (!Equals(((PropertyInfo)members[0]).GetValue(value), 3) ||
                    !Equals(((PropertyInfo)members[1]).GetValue(value), "anon"))
                    throw new Exception("Anonymous constructor did not initialize the recorded members");
                return "anonymous:2:Value:Int32:Alias:String:3:anon";
            }
            public static string Tuple(LambdaExpression tree)
            {
                var construction = Construction(tree);
                var constructor = construction.Constructor ?? throw new Exception("Missing tuple constructor");
                var parameters = constructor.GetParameters();
                if (construction.Members != null || constructor.DeclaringType != typeof(ValueTuple<int, long>) ||
                    parameters.Length != 2 || parameters[0].ParameterType != typeof(int) ||
                    parameters[1].ParameterType != typeof(long) || construction.Arguments.Count != 2 ||
                    construction.Arguments[0].Type != typeof(int) || construction.Arguments[1].Type != typeof(long))
                    throw new Exception("Tuple construction must retain ordinary constructor metadata");
                if (tree.Compile().DynamicInvoke() is not ValueTuple<int, long> value ||
                    value.Item1 != 3 || value.Item2 != 9)
                    throw new Exception("Tuple construction lost its values");
                return "tuple:2:3:9";
            }
        }
        """;

    [Theory]
    [InlineData("Child{Value: 1}")]
    [InlineData("Child(1)")]
    public void HiddenInheritedProperty_DoesNotParticipateInConstructorTree(string construction)
    {
        Verify("""
            package HiddenTreeMember
            import System
            import System.Linq.Expressions
            import TreeContracts
            open class Base { public prop Value string -> "base" }
            data class Child(Value int32) : Base
            func Main() {
                let tree Expression[Func[Child]] = () -> CONSTRUCTION
                Console.WriteLine(Checks.Ordinary(tree, typeof(Child), typeof(int32)))
                let child = tree.Compile()()
                Console.WriteLine(child.Value)
                let parent Base = child
                Console.WriteLine(parent.Value)
            }
            """.Replace("CONSTRUCTION", construction, StringComparison.Ordinal), "ordinary\n1\nbase\n");
    }

    [Theory]
    [InlineData("data class", "Box{Value: int64(9)}")]
    [InlineData("data class", "Box(int64(9))")]
    [InlineData("data struct", "Box{Value: int64(9)}")]
    [InlineData("data struct", "Box(int64(9))")]
    [InlineData("class", "Box{Value: int64(9)}")]
    [InlineData("class", "Box(int64(9))")]
    public void NamedConstruction_UsesOrdinaryNewExpression(string kind, string construction)
    {
        Verify("""
            package NamedTreeConstruction
            import System
            import System.Linq.Expressions
            import TreeContracts
            KIND Box(Value int64)
            func Main() {
                let tree Expression[Func[Box]] = () -> CONSTRUCTION
                Console.WriteLine(Checks.Ordinary(tree, typeof(Box), typeof(int64)))
                Console.WriteLine(tree.Compile()().Value)
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal), "ordinary\n9\n");
    }

    [Theory]
    [InlineData("data class", "Box[T]{}", "0")]
    [InlineData("data class", "Box[T](value)", "9")]
    [InlineData("data struct", "Box[T]{}", "0")]
    [InlineData("data struct", "Box[T](value)", "9")]
    public void OpenGenericConstruction_KeepsOrdinaryMembersAndPreparedDefaults(string kind, string construction, string expected)
    {
        Verify("""
            package GenericTreeConstruction
            import System
            import System.Linq.Expressions
            import TreeContracts
            KIND Box[T](Value T)
            func make[T](value T) Expression[Func[Box[T]]] { return () -> CONSTRUCTION }
            func Main() {
                let tree = make[int64](int64(9))
                Console.WriteLine(Checks.Ordinary(tree, typeof(Box[int64]), typeof(int64)))
                Console.WriteLine(tree.Compile()().Value)
            }
            """.Replace("KIND", kind, StringComparison.Ordinal)
                .Replace("CONSTRUCTION", construction, StringComparison.Ordinal), "ordinary\n" + expected + "\n");
    }

    [Fact]
    public void AnonymousConstruction_RetainsActualOrderedPropertyMembers()
    {
        Verify("""
            package AnonymousTreeConstruction
            import System
            import System.Linq.Expressions
            import TreeContracts
            func Main() {
                let tree Expression[Func[object]] = () -> object { let Value = 3; let Alias = "anon" }
                Console.WriteLine(Checks.Anonymous(tree))
            }
            """, "anonymous:2:Value:Int32:Alias:String:3:anon\n");
    }

    [Fact]
    public void ImportedTupleConstruction_RetainsOrdinaryConstructorMetadataAndValues()
    {
        Verify("""
            package TupleTreeConstruction
            import System
            import System.Linq.Expressions
            import TreeContracts
            func Main() {
                let tree Expression[Func[ValueTuple[int32, int64]]] = () -> ValueTuple[int32, int64](3, int64(9))
                Console.WriteLine(Checks.Tuple(tree))
            }
            """, "tuple:2:3:9\n");
    }

    private static void Verify(string source, string stdout)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var contract = fixture.CompileCSharp(ContractSource, "TreeContract");
        var dll = fixture.Compile(source, "TreeConstruction", true, "/r:" + contract);
        IlVerifier.Verify(dll, additionalReferences: new[] { contract });
        Assert.Equal(stdout, fixture.Run(dll));
    }
}
