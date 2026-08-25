// <copyright file="Issue2398ExpressionTreeLiftedUserOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Numerics;
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

    [Fact]
    public void SameCompilationLiftedConversion_UsesResolvedConversionMethod()
    {
        var source = """
            package Issue2398Conversion
            import System
            import System.Linq.Expressions

            struct Source(Raw int32) { }
            struct Target(Code string) { }

            func operator implicit(value Source) Target -> Target(value.Raw.ToString())
            func (left Target) operator ==(right Target) bool -> left.Code == right.Code

            func Predicate() Expression[Func[Source?, Target?, bool]] {
                return (left Source?, right Target?) -> left == right
            }
            """;

        var (assembly, loadContext) = CompileToAssembly(
            source,
            nameof(SameCompilationLiftedConversion_UsesResolvedConversionMethod));
        try
        {
            var lambda = GetLambda(assembly, "Predicate");
            var binary = Assert.IsAssignableFrom<BinaryExpression>(lambda.Body);
            var conversion = Assert.IsAssignableFrom<UnaryExpression>(binary.Left);
            var sourceType = assembly.GetTypes().Single(t => t.Name == "Source");
            var targetType = assembly.GetTypes().Single(t => t.Name == "Target");

            Assert.Equal(ExpressionType.Convert, conversion.NodeType);
            Assert.True(conversion.IsLifted);
            Assert.True(conversion.IsLiftedToNull);
            Assert.Equal("op_Implicit", conversion.Method?.Name);
            Assert.Equal(sourceType, conversion.Method?.DeclaringType);

            var compiled = lambda.Compile();
            var sourceValue = Activator.CreateInstance(sourceType);
            sourceType.GetField("Raw")!.SetValue(sourceValue, 7);
            var equal = Activator.CreateInstance(targetType);
            targetType.GetField("Code")!.SetValue(equal, "7");
            var different = Activator.CreateInstance(targetType);
            targetType.GetField("Code")!.SetValue(different, "8");
            Assert.True((bool)compiled.DynamicInvoke(sourceValue, equal)!);
            Assert.False((bool)compiled.DynamicInvoke(sourceValue, different)!);
            Assert.False((bool)compiled.DynamicInvoke(null, equal)!);
            Assert.True((bool)compiled.DynamicInvoke(null, null)!);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void ImportedLiftedConversion_DirectLambdaBody_IsMaterialized()
    {
        var source = """
            package Issue2398ImportedConversion
            import System
            import System.Linq.Expressions
            import System.Numerics

            func Conversion() Expression[Func[int32?, BigInteger?]] {
                return (value int32?) -> value
            }
            """;

        var (assembly, loadContext) = CompileToAssembly(
            source,
            nameof(ImportedLiftedConversion_DirectLambdaBody_IsMaterialized));
        try
        {
            var lambda = GetLambda(assembly, "Conversion");
            var conversion = Assert.IsAssignableFrom<UnaryExpression>(lambda.Body);

            Assert.Equal(ExpressionType.Convert, conversion.NodeType);
            Assert.True(conversion.IsLifted);
            Assert.True(conversion.IsLiftedToNull);
            Assert.Equal("op_Implicit", conversion.Method?.Name);
            Assert.Equal(typeof(BigInteger), conversion.Method?.DeclaringType);

            var compiled = lambda.Compile();
            Assert.Equal(new BigInteger(7), compiled.DynamicInvoke(7));
            Assert.Null(compiled.DynamicInvoke(new object[] { null! }));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void ClosedGenericLiftedConversion_DirectLambdaBody_UsesClosedOwner()
    {
        var source = """
            package Issue2398ClosedConversion
            import System
            import System.Linq.Expressions

            struct Box[T] {
                var Value T
                var Rank int32
            }

            func operator implicit(value Box[T]) int32 -> value.Rank

            func Conversion() Expression[Func[Box[string]?, int32?]] {
                return (value Box[string]?) -> value
            }
            """;

        var (assembly, loadContext) = CompileToAssembly(
            source,
            nameof(ClosedGenericLiftedConversion_DirectLambdaBody_UsesClosedOwner));
        try
        {
            var lambda = GetLambda(assembly, "Conversion");
            var conversion = Assert.IsAssignableFrom<UnaryExpression>(lambda.Body);
            var method = Assert.IsAssignableFrom<MethodInfo>(conversion.Method);
            var boxType = assembly.GetTypes().Single(t => t.Name.StartsWith("Box`", StringComparison.Ordinal))
                .MakeGenericType(typeof(string));

            Assert.True(conversion.IsLifted);
            Assert.True(conversion.IsLiftedToNull);
            Assert.Equal("op_Implicit", method.Name);
            Assert.Equal(boxType, method.DeclaringType);
            Assert.Equal(boxType, method.GetParameters().Single().ParameterType);

            var value = Activator.CreateInstance(boxType);
            boxType.GetField("Rank")!.SetValue(value, 7);
            var compiled = lambda.Compile();
            Assert.Equal(7, compiled.DynamicInvoke(value));
            Assert.Null(compiled.DynamicInvoke(new object[] { null! }));
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
