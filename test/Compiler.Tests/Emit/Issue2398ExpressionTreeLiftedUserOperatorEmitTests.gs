// <copyright file="Issue2398ExpressionTreeLiftedUserOperatorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import ExpressionsBinaryExpression = System.Linq.Expressions.BinaryExpression
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import ExpressionsUnaryExpression = System.Linq.Expressions.UnaryExpression
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Numerics
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2398: nullable same-compilation user operators represented by a
/// FunctionSymbol must lower to expression-tree binary nodes with the emitted
/// operator MethodInfo and the same lifted metadata as C#.
open class Issue2398ExpressionTreeLiftedUserOperatorEmitTests {
    @Fact
    func SameCompilationEquality_UsesOperatorMethodAndLiftedBooleanSemantics() {
        let source = `package Issue2398Equality
import System
import System.Linq.Expressions

struct Token(Value int32) {
}

func (left Token) operator ==(right Token) bool -> left.Value == right.Value
func (left Token) operator !=(right Token) bool -> left.Value != right.Value

func Predicate() Expression[Func[Token?, Token?, bool]] {
    return (left Token?, right Token?) -> left == right
}`
        let (assembly, loadContext) = CompileToAssembly(
            source,
            "SameCompilationEquality_UsesOperatorMethodAndLiftedBooleanSemantics"
        )
        try {
            let lambda = GetLambda(assembly, "Predicate")
            let binary = Assert.IsAssignableFrom[ExpressionsBinaryExpression](lambda.Body)
            let tokenType = assembly.GetTypes().Single((t Type) -> t.Name == "Token")
            Assert.Equal(ExpressionType.Equal, binary.NodeType)
            Assert.True(binary.IsLifted)
            Assert.False(binary.IsLiftedToNull)
            Assert.Equal(typeof(bool), binary.Type)
            Assert.Equal("op_Equality", binary.Method?.Name)
            Assert.Equal(tokenType, binary.Method?.DeclaringType)
            let compiled = lambda.Compile()
            let present object? = Activator.CreateInstance(tokenType)
            Assert.True(bool(compiled.DynamicInvoke(present, present)!!))
            Assert.False(bool(compiled.DynamicInvoke(present, nil)!!))
            Assert.True(bool(compiled.DynamicInvoke(nil, nil)!!))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func SameCompilationArithmetic_IsLiftedToNullAndUsesOperatorMethod() {
        let source = `package Issue2398Arithmetic
import System
import System.Linq.Expressions

struct Count(Value int32) {
}

func (left Count) operator +(right Count) Count {
    return Count{ Value: left.Value + right.Value }
}

func Sum() Expression[Func[Count?, Count?, Count?]] {
    return (left Count?, right Count?) -> left + right
}`
        let (assembly, loadContext) = CompileToAssembly(
            source,
            "SameCompilationArithmetic_IsLiftedToNullAndUsesOperatorMethod"
        )
        try {
            let lambda = GetLambda(assembly, "Sum")
            let binary = Assert.IsAssignableFrom[ExpressionsBinaryExpression](lambda.Body)
            let countType = assembly.GetTypes().Single((t Type) -> t.Name == "Count")
            Assert.Equal(ExpressionType.Add, binary.NodeType)
            Assert.True(binary.IsLifted)
            Assert.True(binary.IsLiftedToNull)
            Assert.Equal("op_Addition", binary.Method?.Name)
            Assert.Equal(countType, binary.Method?.DeclaringType)
            Assert.Equal(typeof(Nullable[_]).MakeGenericType(countType), binary.Type)
            let compiled = lambda.Compile()
            let present object? = Activator.CreateInstance(countType)
            let result object? = compiled.DynamicInvoke(present, present)
            Assert.NotNull(result)
            Assert.Equal(countType, result!!.GetType())
            Assert.Null(compiled.DynamicInvoke(present, nil))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func ClosedGenericEquality_ResolvesMethodOnClosedDeclaringType() {
        let source = `package Issue2398Generic
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
}`
        let (assembly, loadContext) = CompileToAssembly(
            source,
            "ClosedGenericEquality_ResolvesMethodOnClosedDeclaringType"
        )
        try {
            let lambda = GetLambda(assembly, "Predicate")
            let binary = Assert.IsAssignableFrom[ExpressionsBinaryExpression](lambda.Body)
            let method = Assert.IsAssignableFrom[MethodInfo](binary.Method)
            let declaringType = Assert.IsAssignableFrom[Type](method.DeclaringType)
            Assert.True(binary.IsLifted)
            Assert.False(binary.IsLiftedToNull)
            Assert.Equal("op_Equality", method.Name)
            Assert.True(declaringType.IsConstructedGenericType)
            Assert.Equal(typeof(string), declaringType.GetGenericArguments().Single())
            Assert.All(method.GetParameters(), (p ParameterInfo) -> Assert.Equal(declaringType, p.ParameterType))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func SameCompilationLiftedConversion_UsesResolvedConversionMethod() {
        let source = `package Issue2398Conversion
import System
import System.Linq.Expressions

struct Source(Raw int32) { }
struct Target(Code string) { }

func operator implicit(value Source) Target -> Target(value.Raw.ToString())
func (left Target) operator ==(right Target) bool -> left.Code == right.Code

func Predicate() Expression[Func[Source?, Target?, bool]] {
    return (left Source?, right Target?) -> left == right
}`
        let (assembly, loadContext) = CompileToAssembly(
            source,
            "SameCompilationLiftedConversion_UsesResolvedConversionMethod"
        )
        try {
            let lambda = GetLambda(assembly, "Predicate")
            let binary = Assert.IsAssignableFrom[ExpressionsBinaryExpression](lambda.Body)
            let conversion = Assert.IsAssignableFrom[ExpressionsUnaryExpression](binary.Left)
            let sourceType = assembly.GetTypes().Single((t Type) -> t.Name == "Source")
            let targetType = assembly.GetTypes().Single((t Type) -> t.Name == "Target")
            Assert.Equal(ExpressionType.Convert, conversion.NodeType)
            Assert.True(conversion.IsLifted)
            Assert.True(conversion.IsLiftedToNull)
            Assert.Equal("op_Implicit", conversion.Method?.Name)
            Assert.Equal(sourceType, conversion.Method?.DeclaringType)
            let compiled = lambda.Compile()
            let sourceValue object? = Activator.CreateInstance(sourceType)
            sourceType.GetField("Raw")!!.SetValue(sourceValue, 7)
            let equal object? = Activator.CreateInstance(targetType)
            targetType.GetField("Code")!!.SetValue(equal, "7")
            let different object? = Activator.CreateInstance(targetType)
            targetType.GetField("Code")!!.SetValue(different, "8")
            Assert.True(bool(compiled.DynamicInvoke(sourceValue, equal)!!))
            Assert.False(bool(compiled.DynamicInvoke(sourceValue, different)!!))
            Assert.False(bool(compiled.DynamicInvoke(nil, equal)!!))
            Assert.True(bool(compiled.DynamicInvoke(nil, nil)!!))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func ImportedLiftedConversion_DirectLambdaBody_IsMaterialized() {
        let source = `package Issue2398ImportedConversion
import System
import System.Linq.Expressions
import System.Numerics

func Conversion() Expression[Func[int32?, BigInteger?]] {
    return (value int32?) -> value
}`
        let (assembly, loadContext) = CompileToAssembly(
            source,
            "ImportedLiftedConversion_DirectLambdaBody_IsMaterialized"
        )
        try {
            let lambda = GetLambda(assembly, "Conversion")
            let conversion = Assert.IsAssignableFrom[ExpressionsUnaryExpression](lambda.Body)
            Assert.Equal(ExpressionType.Convert, conversion.NodeType)
            Assert.True(conversion.IsLifted)
            Assert.True(conversion.IsLiftedToNull)
            Assert.Equal("op_Implicit", conversion.Method?.Name)
            Assert.Equal(typeof(BigInteger), conversion.Method?.DeclaringType)
            let compiled = lambda.Compile()
            Assert.Equal(BigInteger(7), compiled.DynamicInvoke(7))
            Assert.Null(compiled.DynamicInvoke([]object? {nil}))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func ClosedGenericLiftedConversion_DirectLambdaBody_UsesClosedOwner() {
        let source = `package Issue2398ClosedConversion
import System
import System.Linq.Expressions

struct Box[T] {
    var Value T
    var Rank int32
}

func operator implicit(value Box[T]) int32 -> value.Rank

func Conversion() Expression[Func[Box[string]?, int32?]] {
    return (value Box[string]?) -> value
}`
        let (assembly, loadContext) = CompileToAssembly(
            source,
            "ClosedGenericLiftedConversion_DirectLambdaBody_UsesClosedOwner"
        )
        try {
            let lambda = GetLambda(assembly, "Conversion")
            let conversion = Assert.IsAssignableFrom[ExpressionsUnaryExpression](lambda.Body)
            let method = Assert.IsAssignableFrom[MethodInfo](conversion.Method)
            let boxType = assembly
                .GetTypes()
                .Single((t Type) -> t.Name.StartsWith("Box`", StringComparison.Ordinal))
                .MakeGenericType(typeof(string))
            Assert.True(conversion.IsLifted)
            Assert.True(conversion.IsLiftedToNull)
            Assert.Equal("op_Implicit", method.Name)
            Assert.Equal(boxType, method.DeclaringType)
            Assert.Equal(boxType, method.GetParameters().Single().ParameterType)
            let value object? = Activator.CreateInstance(boxType)
            boxType.GetField("Rank")!!.SetValue(value, 7)
            let compiled = lambda.Compile()
            Assert.Equal(7, compiled.DynamicInvoke(value))
            Assert.Null(compiled.DynamicInvoke([]object? {nil}))
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func GetLambda(assembly Assembly, methodName string) ExpressionsLambdaExpression {
            let programType = assembly.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let method MethodInfo? = programType.GetMethod(
                methodName,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return Assert.IsAssignableFrom[ExpressionsLambdaExpression](method!!.Invoke(nil, nil))
        }

        private func CompileToAssembly(source string, caseName string)(
            Assembly Assembly,
            LoadContext AssemblyLoadContext
        ) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue2398ExpressionTreeLiftedUserOperatorEmitTests"
            )
            Directory.CreateDirectory(outputDirectory)
            let assemblyPath = Path.Combine(outputDirectory, caseName + ".dll")
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            {
                using let peStream = File.Create(assemblyPath)
                let result = compilation.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: caseName)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(assemblyPath)
            let loadContext = AssemblyLoadContext(caseName, isCollectible: true)
            return (loadContext.LoadFromAssemblyPath(assemblyPath), loadContext)
        }
    }
}
