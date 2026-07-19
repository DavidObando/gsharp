// <copyright file="Issue2398ExpressionTreeLiftedUserOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.Loader;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2398: nullable same-compilation user operators represented by a
/// FunctionSymbol must lower to expression-tree binary nodes with the emitted
/// operator MethodInfo and the same lifted metadata as C#.
/// </summary>
public class Issue2398ExpressionTreeLiftedUserOperatorEmitTests
{
    [Fact]
    public void SameCompilationEquality_UsesOperatorMethodAndLiftedBooleanSemantics()
    {
        var source = """
            package Issue2398Equality
            import System
            import System.Linq.Expressions

            struct Token(Value int32) {
            }

            func (left Token) operator ==(right Token) bool -> left.Value == right.Value
            func (left Token) operator !=(right Token) bool -> left.Value != right.Value

            func Predicate() Expression[Func[Token?, Token?, bool]] {
                return (left Token?, right Token?) -> left == right
            }
            """;

        var (assembly, loadContext) = CompileToAssembly(source, nameof(SameCompilationEquality_UsesOperatorMethodAndLiftedBooleanSemantics));
        try
        {
            var lambda = GetLambda(assembly, "Predicate");
            var binary = Assert.IsAssignableFrom<BinaryExpression>(lambda.Body);
            var tokenType = assembly.GetTypes().Single(t => t.Name == "Token");

            Assert.Equal(ExpressionType.Equal, binary.NodeType);
            Assert.True(binary.IsLifted);
            Assert.False(binary.IsLiftedToNull);
            Assert.Equal(typeof(bool), binary.Type);
            Assert.Equal("op_Equality", binary.Method?.Name);
            Assert.Equal(tokenType, binary.Method?.DeclaringType);

            var compiled = lambda.Compile();
            var present = Activator.CreateInstance(tokenType);
            Assert.True((bool)compiled.DynamicInvoke(present, present)!);
            Assert.False((bool)compiled.DynamicInvoke(present, null)!);
            Assert.True((bool)compiled.DynamicInvoke(null, null)!);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void SameCompilationArithmetic_IsLiftedToNullAndUsesOperatorMethod()
    {
        var source = """
            package Issue2398Arithmetic
            import System
            import System.Linq.Expressions

            struct Count(Value int32) {
            }

            func (left Count) operator +(right Count) Count {
                return Count{ Value: left.Value + right.Value }
            }

            func Sum() Expression[Func[Count?, Count?, Count?]] {
                return (left Count?, right Count?) -> left + right
            }
            """;

        var (assembly, loadContext) = CompileToAssembly(source, nameof(SameCompilationArithmetic_IsLiftedToNullAndUsesOperatorMethod));
        try
        {
            var lambda = GetLambda(assembly, "Sum");
            var binary = Assert.IsAssignableFrom<BinaryExpression>(lambda.Body);
            var countType = assembly.GetTypes().Single(t => t.Name == "Count");

            Assert.Equal(ExpressionType.Add, binary.NodeType);
            Assert.True(binary.IsLifted);
            Assert.True(binary.IsLiftedToNull);
            Assert.Equal("op_Addition", binary.Method?.Name);
            Assert.Equal(countType, binary.Method?.DeclaringType);
            Assert.Equal(typeof(Nullable<>).MakeGenericType(countType), binary.Type);

            var compiled = lambda.Compile();
            var present = Activator.CreateInstance(countType);
            var result = compiled.DynamicInvoke(present, present);
            Assert.NotNull(result);
            Assert.Equal(countType, result!.GetType());
            Assert.Null(compiled.DynamicInvoke(present, null));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void ClosedGenericEquality_ResolvesMethodOnClosedDeclaringType()
    {
        var source = """
            package Issue2398Generic
            import System
            import System.Linq.Expressions

            struct Box[T] {
                var Value T
                var Rank int32
            }

            func (left Box[T]) operator ==(right Box[T]) bool -> left.Rank == right.Rank
            func (left Box[T]) operator !=(right Box[T]) bool -> left.Rank != right.Rank

            func Predicate() Expression[Func[Box[string]?, Box[string]?, bool]] {
                return (left Box[string]?, right Box[string]?) -> left == right
            }
            """;

        var (assembly, loadContext) = CompileToAssembly(source, nameof(ClosedGenericEquality_ResolvesMethodOnClosedDeclaringType));
        try
        {
            var lambda = GetLambda(assembly, "Predicate");
            var binary = Assert.IsAssignableFrom<BinaryExpression>(lambda.Body);
            var method = Assert.IsAssignableFrom<MethodInfo>(binary.Method);
            var declaringType = Assert.IsAssignableFrom<Type>(method.DeclaringType);

            Assert.True(binary.IsLifted);
            Assert.False(binary.IsLiftedToNull);
            Assert.Equal("op_Equality", method.Name);
            Assert.True(declaringType.IsConstructedGenericType);
            Assert.Equal(typeof(string), declaringType.GetGenericArguments().Single());
            Assert.All(method.GetParameters(), p => Assert.Equal(declaringType, p.ParameterType));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static LambdaExpression GetLambda(Assembly assembly, string methodName)
    {
        var programType = assembly.GetTypes().Single(t => t.Name == "<Program>");
        var method = programType.GetMethod(methodName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return Assert.IsAssignableFrom<LambdaExpression>(method!.Invoke(null, null));
    }

    private static (Assembly Assembly, AssemblyLoadContext LoadContext) CompileToAssembly(string source, string caseName)
    {
        var outputDirectory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2398ExpressionTreeLiftedUserOperatorEmitTests));
        Directory.CreateDirectory(outputDirectory);
        var assemblyPath = Path.Combine(outputDirectory, caseName + ".dll");
        var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };

        using (var peStream = File.Create(assemblyPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: caseName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(assemblyPath);

        var loadContext = new AssemblyLoadContext(caseName, isCollectible: true);
        return (loadContext.LoadFromAssemblyPath(assemblyPath), loadContext);
    }
}
