// <copyright file="Issue2377OperatorMetadataShapeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import System.Runtime.Loader
import GSharp.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import ExpressionsBinaryExpression = System.Linq.Expressions.BinaryExpression
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis

/// Issue #2377 — real-assembly, reflection-metadata, IL-verification and
/// runtime-execution level regression coverage for the receiver-style user
/// operator CLR metadata shape fix. Before the fix,
/// `func (a T) operator ==(b T) bool` declared on a same-package
/// ("owned") struct/class emitted as an ordinary PUBLIC, HideBySig INSTANCE
/// method (no `SpecialName`, receiver hidden as an implicit
/// `this`), making it invisible to: (1) real C#-authored consuming
/// assemblies, which can only invoke `op_*` methods that are
/// `public static` with `SpecialName`; and (2) gsc's own
/// `ClrOperatorResolution` reflection-based fallback (Stream C), which
/// specifically queries `BindingFlags.Static` + `IsSpecialName`
/// when a G#-authored library is re-imported into a separate compilation.
/// After the fix, every receiver-style user operator emits as
/// `Public, Static, HideBySig, SpecialName` with the receiver preserved
/// only as an ordinary first parameter — exactly like the (already-correct)
/// `op_Implicit`/`op_Explicit` conversion-operator shape and the
/// (already-correct) extension-style-operator-on-non-owned-type shape. These
/// tests exercise the full, corrected pipeline end to end: raw reflection
/// metadata shape, a REAL C#-authored consuming assembly using native C#
/// operator syntax, a separate G#-authored consuming compilation exercising
/// the `ClrOperatorResolution` re-import fallback, expression-tree use
/// against a re-imported operator, inheritance through an open base, and a
/// negative control proving the fix does not make every struct universally
/// comparable.
open class Issue2377OperatorMetadataShapeEmitTests {
    @Theory
    @InlineData("op_Equality", int32(2))
    @InlineData("op_Inequality", int32(2))
    @InlineData("op_Addition", int32(2))
    @InlineData("op_Subtraction", int32(2))
    @InlineData("op_LessThan", int32(2))
    @InlineData("op_GreaterThan", int32(2))
    @InlineData("op_UnaryNegation", int32(1))
    func ReceiverStyleOperator_EmitsAsPublicStaticHideBySigSpecialName(clrName string, parameterCount int32) {
        let libraryPath = EmitGSharpLibrary("Shape_" + clrName, `package Lib

struct Meters(Value float64) {
}

func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
func (a Meters) operator !=(b Meters) bool -> !(a == b)
func (a Meters) operator +(b Meters) Meters -> Meters{Value: a.Value + b.Value}
func (a Meters) operator -(b Meters) Meters -> Meters{Value: a.Value - b.Value}
func (a Meters) operator -() Meters -> Meters{Value: -a.Value}
func (a Meters) operator <(b Meters) bool -> a.Value < b.Value
func (a Meters) operator >(b Meters) bool -> a.Value > b.Value`)
        let asm = EmittedFixture.Load(libraryPath)
        let metersType = asm.GetTypes().Single((t Type) -> t.Name == "Meters")
        let method MethodInfo? = metersType.GetMethod(
            clrName,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance
        )
        Assert.NotNull(method)
        Assert.True(method!!.IsStatic)
        Assert.True(method!!.IsPublic)
        Assert.True(method!!.IsSpecialName)
        Assert.True((method!!.Attributes & MethodAttributes.HideBySig) == MethodAttributes.HideBySig)
        Assert.Equal(parameterCount, method!!.GetParameters().Length)
        Assert.All(method!!.GetParameters(), (p ParameterInfo) -> Assert.Equal(metersType, p.ParameterType))
    }

    @Fact
    func CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax() {
        // The core claim of #2377: a REAL, separately Roslyn-compiled C#
        // consuming assembly can use ordinary C# `==`/`!=`/`+`/`-`/unary
        // `-`/`<` syntax against a G#-authored operator — which is only
        // possible because the operator is now emitted as a public static
        // SpecialName op_* method instead of a hidden instance method.
        let libraryPath = EmitGSharpLibrary("CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax", `package Lib

struct Meters(Value float64) {
}

func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
func (a Meters) operator !=(b Meters) bool -> !(a == b)
func (a Meters) operator +(b Meters) Meters -> Meters{Value: a.Value + b.Value}
func (a Meters) operator -() Meters -> Meters{Value: -a.Value}
func (a Meters) operator <(b Meters) bool -> a.Value < b.Value

class Factory {
    shared {
        func Make(v float64) Meters -> Meters{Value: v}
    }
}`)
        let consumerPath = EmitCSharpConsumer("CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax", `using Lib;

namespace Consumer
{
    public static class Runner
    {
        public static bool RunEquality(Meters a, Meters b) => a == b;

        public static bool RunInequality(Meters a, Meters b) => a != b;

        public static Meters RunAdd(Meters a, Meters b) => a + b;

        public static Meters RunNeg(Meters a) => -a;

        public static bool RunLess(Meters a, Meters b) => a < b;
    }
}`, libraryPath)
        let loadContext = AssemblyLoadContext(
            "CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax",
            isCollectible: true
        )
        try {
            let libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath)
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == libraryAsm
                .GetName().Name {
                libraryAsm
            } else {
                default(Assembly?)
            }
            let consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath)
            let metersType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Meters")
            let factoryType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Factory")
            let make = factoryType.GetMethod("Make", BindingFlags.Public | BindingFlags.Static)!!
            let m5 object? = make.Invoke(nil, []object{5.0})
            let m5b object? = make.Invoke(nil, []object{5.0})
            let m3 object? = make.Invoke(nil, []object{3.0})
            let runnerType = consumerAsm.GetType("Consumer.Runner")!!
            Assert.True(bool(runnerType.GetMethod("RunEquality")!!.Invoke(nil, []object{m5, m5b})!!))
            Assert.True(bool(runnerType.GetMethod("RunInequality")!!.Invoke(nil, []object{m5, m3})!!))
            let sum object? = runnerType.GetMethod("RunAdd")!!.Invoke(nil, []object{m5, m3})
            Assert.Equal(8.0, metersType.GetField("Value")!!.GetValue(sum))
            let neg object? = runnerType.GetMethod("RunNeg")!!.Invoke(nil, []object{m5})
            Assert.Equal(-5.0, metersType.GetField("Value")!!.GetValue(neg))
            Assert.True(bool(runnerType.GetMethod("RunLess")!!.Invoke(nil, []object{m3, m5})!!))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func GSharpReimport_ClrOperatorResolutionFallback_DiscoversReceiverStyleOperator() {
        // Stream C ("ClrOperatorResolution"): a SEPARATE G# compilation
        // imports the library and uses the operator via ordinary G# `==`/`+`
        // syntax. Because the imported `Meters` is now backed by real CLR
        // metadata (ClrType != null), binding goes through the reflection
        // fallback rather than the same-compilation StaticMethods lookup —
        // this is exactly the path that was broken pre-fix, since reflection
        // could never find a non-static, non-SpecialName instance method
        // named `op_Equality`.
        let libraryPath = EmitGSharpLibrary(
            "GSharpReimport_ClrOperatorResolutionFallback_DiscoversReceiverStyleOperator",
            `package Lib

struct Meters(Value float64) {
}

func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
func (a Meters) operator +(b Meters) Meters -> Meters{Value: a.Value + b.Value}

class Factory {
    shared {
        func Make(v float64) Meters -> Meters{Value: v}
    }
}`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumerAssemblyName = "Issue2377Emit.Consumer." +
            "GSharpReimport_ClrOperatorResolutionFallback_DiscoversReceiverStyleOperator"
        let consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll")
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package App
import Lib

func UseEquality(a Meters, b Meters) bool {
    return a == b
}

func UseAdd(a Meters, b Meters) Meters {
    return a + b
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(consumerPath)
            let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: consumerAssemblyName)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let loadContext = AssemblyLoadContext(consumerAssemblyName, isCollectible: true)
        try {
            let libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath)
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == libraryAsm
                .GetName().Name {
                libraryAsm
            } else {
                default(Assembly?)
            }
            let consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath)
            let factoryType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Factory")
            let make = factoryType.GetMethod("Make", BindingFlags.Public | BindingFlags.Static)!!
            let m5 object? = make.Invoke(nil, []object{5.0})
            let m5b object? = make.Invoke(nil, []object{5.0})
            let m3 object? = make.Invoke(nil, []object{3.0})
            let programType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let useEquality = programType.GetMethod(
                "UseEquality",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )!!
            let useAdd = programType.GetMethod(
                "UseAdd",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )!!
            Assert.True(bool(useEquality.Invoke(nil, []object{m5, m5b})!!))
            Assert.False(bool(useEquality.Invoke(nil, []object{m5, m3})!!))
            let sum object? = useAdd.Invoke(nil, []object{m5, m3})
            let metersType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Meters")
            Assert.Equal(8.0, metersType.GetField("Value")!!.GetValue(sum))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func ExpressionTree_ReimportedGSharpOperator_ResolvesStaticSpecialNameMethod_AndRuns() {
        let libraryPath = EmitGSharpLibrary(
            "ExpressionTree_ReimportedGSharpOperator_ResolvesStaticSpecialNameMethod_AndRuns",
            `package Lib

struct Meters(Value float64) {
}

func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value

class Factory {
    shared {
        func Make(v float64) Meters -> Meters{Value: v}
    }
}`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumerAssemblyName = "Issue2377Emit.Consumer." +
            "ExpressionTree_ReimportedGSharpOperator_ResolvesStaticSpecialNameMethod_AndRuns"
        let consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll")
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package App
import Lib
import System
import System.Linq.Expressions

func Predicate() Expression[Func[Meters, Meters, bool]] {
    return (a Meters, b Meters) -> a == b
}`))){IsLibrary = true}
        {
            using let peStream = File.Create(consumerPath)
            let result = consumer.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: consumerAssemblyName)
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
        IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
        let loadContext = AssemblyLoadContext(consumerAssemblyName, isCollectible: true)
        try {
            let libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath)
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == libraryAsm
                .GetName().Name {
                libraryAsm
            } else {
                default(Assembly?)
            }
            let consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath)
            let programType = consumerAsm.GetTypes().Single((t Type) -> t.Name == "<Program>")
            let predicate = programType.GetMethod(
                "Predicate",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )!!
            let expr object? = predicate.Invoke(nil, nil)
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](expr)
            let binary = Assert.IsAssignableFrom[ExpressionsBinaryExpression](lambda.Body)
            Assert.NotNull(binary.Method)
            Assert.True(binary.Method!!.IsStatic)
            Assert.True(binary.Method!!.IsSpecialName)
            Assert.Equal("op_Equality", binary.Method!!.Name)
            let compiled = lambda.Compile()
            let factoryType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Factory")
            let make = factoryType.GetMethod("Make", BindingFlags.Public | BindingFlags.Static)!!
            let m5 object? = make.Invoke(nil, []object{5.0})
            let m5b object? = make.Invoke(nil, []object{5.0})
            let m3 object? = make.Invoke(nil, []object{3.0})
            Assert.True(bool(compiled.DynamicInvoke(m5, m5b)!!))
            Assert.False(bool(compiled.DynamicInvoke(m5, m3)!!))
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived() {
        // Inheritance control: the operator is emitted ONLY once, on the
        // open base type (matching C#'s own inherited-operator shape), and a
        // real C# consumer using a DERIVED instance still resolves it via
        // ordinary overload resolution (operators are inherited, not
        // hidden), independent of the static-shape fix.
        let libraryPath = EmitGSharpLibrary(
            "InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived",
            `package Lib

open class BaseVec {
    var X int32
}

func (a BaseVec) operator +(b BaseVec) int32 -> a.X + b.X

class DerivedVec : BaseVec {
}

class Factory {
    shared {
        func MakeDerived(x int32) DerivedVec -> DerivedVec{X: x}
    }
}`
        )
        let asm = EmittedFixture.Load(libraryPath)
        let baseType = asm.GetTypes().Single((t Type) -> t.Name == "BaseVec")
        let derivedType = asm.GetTypes().Single((t Type) -> t.Name == "DerivedVec")
        let addOnBase MethodInfo? = baseType.GetMethod("op_Addition", BindingFlags.Public | BindingFlags.Static)
        Assert.NotNull(addOnBase)
        Assert.True(addOnBase!!.IsSpecialName)
        // The derived type does NOT redeclare its own op_Addition — it is
        // found purely through inheritance from BaseVec.
        Assert.Null(
            derivedType.GetMethod("op_Addition", BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
        )
        let consumerPath = EmitCSharpConsumer(
            "InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived",
            `using Lib;

namespace Consumer
{
    public static class Runner
    {
        public static int RunAdd(DerivedVec a, DerivedVec b) => a + b;
    }
}`,
            libraryPath
        )
        let loadContext = AssemblyLoadContext(
            "InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived",
            isCollectible: true
        )
        try {
            let libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath)
            loadContext.Resolving += (ctx AssemblyLoadContext, name AssemblyName) -> if name.Name == libraryAsm
                .GetName().Name {
                libraryAsm
            } else {
                default(Assembly?)
            }
            let consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath)
            let factoryType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Factory")
            let makeDerived = factoryType.GetMethod("MakeDerived", BindingFlags.Public | BindingFlags.Static)!!
            let d5 object? = makeDerived.Invoke(nil, []object{5})
            let d7 object? = makeDerived.Invoke(nil, []object{7})
            let runnerType = consumerAsm.GetType("Consumer.Runner")!!
            let sum object? = runnerType.GetMethod("RunAdd")!!.Invoke(nil, []object{d5, d7})
            Assert.Equal(12, sum)
        } finally {
            loadContext.Unload()
        }
    }

    @Fact
    func UndefinedOperator_OnImportedType_NegativeControl_ReportsGS0129() {
        // Negative control: the ClrOperatorResolution fallback must still
        // reject comparisons on an imported type with NO `==` operator at
        // all — the fix must not make every re-imported type universally
        // comparable.
        let libraryPath = EmitGSharpLibrary("UndefinedOperator_OnImportedType_NegativeControl_ReportsGS0129", `package Lib

struct Plain(Value int32) {
}`)
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package App
import Lib

func UseEquality(a Plain, b Plain) bool {
    return a == b
}`))){IsLibrary = true}
        using let peStream = MemoryStream()
        let result = consumer.Emit(
            peStream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2377Emit.NegativeControl"
        )
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0129")
    }

    @Fact
    func ImportedNonLiftableOperatorSignatures_ReportConversionErrorsNotEmitterFailures() {
        let libraryPath = EmitGSharpLibrary(
            "ImportedNonLiftableOperatorSignatures_ReportConversionErrorsNotEmitterFailures",
            `package Lib

struct ReferenceParameterValue(N int32) { }
func (left ReferenceParameterValue) operator +(right object) ReferenceParameterValue -> left

struct ReferenceResultValue(N int32) { }
func (left ReferenceResultValue) operator +(right ReferenceResultValue) object -> left`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(`package App
import Lib

func BadParameter(left ReferenceParameterValue?, right object) ReferenceParameterValue? {
    return left + right
}

func BadResult(left ReferenceResultValue?, right ReferenceResultValue?) object? {
    return left + right
}`))){IsLibrary = true}
        using let peStream = MemoryStream()
        let result = consumer.Emit(
            peStream,
            pdbStream: nil,
            refStream: nil,
            assemblyName: "Issue2377Emit.NonLiftableSignatures"
        )
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0129")
        Assert.DoesNotContain(result.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS9998")
    }

    shared {
        private func EmitGSharpLibrary(caseName string, gsharpSource string) string {
            let libraryDir = LibraryDirectory()
            let assemblyPath = Path.Combine(libraryDir, "Issue2377Emit." + caseName + ".dll")
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(gsharpSource))){IsLibrary = true}
            {
                using let peStream = File.Create(assemblyPath)
                let result = compilation.Emit(
                    peStream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "Issue2377Emit." + caseName
                )
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(assemblyPath)
            return assemblyPath
        }

        private func EmitCSharpConsumer(caseName string, csharpSource string, libraryPath string) string {
            let outputDir = Path.Combine(LibraryDirectory(), caseName)
            Directory.CreateDirectory(outputDir)
            let consumerPath = Path.Combine(outputDir, "CSharpConsumer2377.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            references.Add(MetadataReference.CreateFromFile(libraryPath))
            let compilation = CSharpCompilation.Create(
                "CSharpConsumer2377",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(consumerPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            IlVerifier.Verify(consumerPath, additionalReferences: []string{libraryPath})
            return consumerPath
        }

        private func LibraryDirectory() string {
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue2377Emit")
            Directory.CreateDirectory(dir)
            return dir
        }
    }
}
