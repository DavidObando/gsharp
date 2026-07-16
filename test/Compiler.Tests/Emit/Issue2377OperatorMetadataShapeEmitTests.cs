// <copyright file="Issue2377OperatorMetadataShapeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.Loader;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2377 — real-assembly, reflection-metadata, IL-verification and
/// runtime-execution level regression coverage for the receiver-style user
/// operator CLR metadata shape fix. Before the fix,
/// <c>func (a T) operator ==(b T) bool</c> declared on a same-package
/// ("owned") struct/class emitted as an ordinary PUBLIC, HideBySig INSTANCE
/// method (no <c>SpecialName</c>, receiver hidden as an implicit
/// <c>this</c>), making it invisible to: (1) real C#-authored consuming
/// assemblies, which can only invoke <c>op_*</c> methods that are
/// <c>public static</c> with <c>SpecialName</c>; and (2) gsc's own
/// <c>ClrOperatorResolution</c> reflection-based fallback (Stream C), which
/// specifically queries <c>BindingFlags.Static</c> + <c>IsSpecialName</c>
/// when a G#-authored library is re-imported into a separate compilation.
/// After the fix, every receiver-style user operator emits as
/// <c>Public, Static, HideBySig, SpecialName</c> with the receiver preserved
/// only as an ordinary first parameter — exactly like the (already-correct)
/// <c>op_Implicit</c>/<c>op_Explicit</c> conversion-operator shape and the
/// (already-correct) extension-style-operator-on-non-owned-type shape. These
/// tests exercise the full, corrected pipeline end to end: raw reflection
/// metadata shape, a REAL C#-authored consuming assembly using native C#
/// operator syntax, a separate G#-authored consuming compilation exercising
/// the <c>ClrOperatorResolution</c> re-import fallback, expression-tree use
/// against a re-imported operator, inheritance through an open base, and a
/// negative control proving the fix does not make every struct universally
/// comparable.
/// </summary>
public class Issue2377OperatorMetadataShapeEmitTests
{
    [Theory]
    [InlineData("op_Equality", 2)]
    [InlineData("op_Inequality", 2)]
    [InlineData("op_Addition", 2)]
    [InlineData("op_Subtraction", 2)]
    [InlineData("op_LessThan", 2)]
    [InlineData("op_GreaterThan", 2)]
    [InlineData("op_UnaryNegation", 1)]
    public void ReceiverStyleOperator_EmitsAsPublicStaticHideBySigSpecialName(string clrName, int parameterCount)
    {
        var libraryPath = EmitGSharpLibrary(
            "Shape_" + clrName,
            """
            package Lib

            struct Meters(Value float64) {
            }

            func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
            func (a Meters) operator !=(b Meters) bool -> !(a == b)
            func (a Meters) operator +(b Meters) Meters -> Meters{Value: a.Value + b.Value}
            func (a Meters) operator -(b Meters) Meters -> Meters{Value: a.Value - b.Value}
            func (a Meters) operator -() Meters -> Meters{Value: -a.Value}
            func (a Meters) operator <(b Meters) bool -> a.Value < b.Value
            func (a Meters) operator >(b Meters) bool -> a.Value > b.Value
            """);

        var asm = Assembly.LoadFrom(libraryPath);
        var metersType = asm.GetTypes().Single(t => t.Name == "Meters");
        var method = metersType.GetMethod(
            clrName,
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance);

        Assert.NotNull(method);
        Assert.True(method!.IsStatic);
        Assert.True(method.IsPublic);
        Assert.True(method.IsSpecialName);
        Assert.True((method.Attributes & MethodAttributes.HideBySig) == MethodAttributes.HideBySig);
        Assert.Equal(parameterCount, method.GetParameters().Length);
        Assert.All(method.GetParameters(), p => Assert.Equal(metersType, p.ParameterType));
    }

    [Fact]
    public void CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax()
    {
        // The core claim of #2377: a REAL, separately Roslyn-compiled C#
        // consuming assembly can use ordinary C# `==`/`!=`/`+`/`-`/unary
        // `-`/`<` syntax against a G#-authored operator — which is only
        // possible because the operator is now emitted as a public static
        // SpecialName op_* method instead of a hidden instance method.
        var libraryPath = EmitGSharpLibrary(
            nameof(CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax),
            """
            package Lib

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
            }
            """);

        var consumerPath = EmitCSharpConsumer(
            nameof(CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax),
            """
            using Lib;

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
            }
            """,
            libraryPath);

        var loadContext = new AssemblyLoadContext(nameof(CSharpConsumer_CanUseGSharpAuthoredOperators_ViaNativeOperatorSyntax), isCollectible: true);
        try
        {
            var libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath);
            loadContext.Resolving += (ctx, name) => name.Name == libraryAsm.GetName().Name ? libraryAsm : null;
            var consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath);

            var metersType = libraryAsm.GetTypes().Single(t => t.Name == "Meters");
            var factoryType = libraryAsm.GetTypes().Single(t => t.Name == "Factory");
            var make = factoryType.GetMethod("Make", BindingFlags.Public | BindingFlags.Static)!;
            var m5 = make.Invoke(null, new object[] { 5.0 });
            var m5b = make.Invoke(null, new object[] { 5.0 });
            var m3 = make.Invoke(null, new object[] { 3.0 });

            var runnerType = consumerAsm.GetType("Consumer.Runner")!;
            Assert.True((bool)runnerType.GetMethod("RunEquality")!.Invoke(null, new[] { m5, m5b })!);
            Assert.True((bool)runnerType.GetMethod("RunInequality")!.Invoke(null, new[] { m5, m3 })!);

            var sum = runnerType.GetMethod("RunAdd")!.Invoke(null, new[] { m5, m3 });
            Assert.Equal(8.0, metersType.GetField("Value")!.GetValue(sum));

            var neg = runnerType.GetMethod("RunNeg")!.Invoke(null, new[] { m5 });
            Assert.Equal(-5.0, metersType.GetField("Value")!.GetValue(neg));

            Assert.True((bool)runnerType.GetMethod("RunLess")!.Invoke(null, new[] { m3, m5 })!);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void GSharpReimport_ClrOperatorResolutionFallback_DiscoversReceiverStyleOperator()
    {
        // Stream C ("ClrOperatorResolution"): a SEPARATE G# compilation
        // imports the library and uses the operator via ordinary G# `==`/`+`
        // syntax. Because the imported `Meters` is now backed by real CLR
        // metadata (ClrType != null), binding goes through the reflection
        // fallback rather than the same-compilation StaticMethods lookup —
        // this is exactly the path that was broken pre-fix, since reflection
        // could never find a non-static, non-SpecialName instance method
        // named `op_Equality`.
        var libraryPath = EmitGSharpLibrary(
            nameof(GSharpReimport_ClrOperatorResolutionFallback_DiscoversReceiverStyleOperator),
            """
            package Lib

            struct Meters(Value float64) {
            }

            func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value
            func (a Meters) operator +(b Meters) Meters -> Meters{Value: a.Value + b.Value}

            class Factory {
                shared {
                    func Make(v float64) Meters -> Meters{Value: v}
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumerAssemblyName = "Issue2377Emit.Consumer." + nameof(GSharpReimport_ClrOperatorResolutionFallback_DiscoversReceiverStyleOperator);
        var consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll");
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package App
                import Lib

                func UseEquality(a Meters, b Meters) bool {
                    return a == b
                }

                func UseAdd(a Meters, b Meters) Meters {
                    return a + b
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(consumerPath))
        {
            var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: consumerAssemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var loadContext = new AssemblyLoadContext(consumerAssemblyName, isCollectible: true);
        try
        {
            var libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath);
            loadContext.Resolving += (ctx, name) => name.Name == libraryAsm.GetName().Name ? libraryAsm : null;
            var consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath);

            var factoryType = libraryAsm.GetTypes().Single(t => t.Name == "Factory");
            var make = factoryType.GetMethod("Make", BindingFlags.Public | BindingFlags.Static)!;
            var m5 = make.Invoke(null, new object[] { 5.0 });
            var m5b = make.Invoke(null, new object[] { 5.0 });
            var m3 = make.Invoke(null, new object[] { 3.0 });

            var programType = consumerAsm.GetTypes().Single(t => t.Name == "<Program>");
            var useEquality = programType.GetMethod("UseEquality", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;
            var useAdd = programType.GetMethod("UseAdd", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;

            Assert.True((bool)useEquality.Invoke(null, new[] { m5, m5b })!);
            Assert.False((bool)useEquality.Invoke(null, new[] { m5, m3 })!);

            var sum = useAdd.Invoke(null, new[] { m5, m3 });
            var metersType = libraryAsm.GetTypes().Single(t => t.Name == "Meters");
            Assert.Equal(8.0, metersType.GetField("Value")!.GetValue(sum));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void ExpressionTree_ReimportedGSharpOperator_ResolvesStaticSpecialNameMethod_AndRuns()
    {
        var libraryPath = EmitGSharpLibrary(
            nameof(ExpressionTree_ReimportedGSharpOperator_ResolvesStaticSpecialNameMethod_AndRuns),
            """
            package Lib

            struct Meters(Value float64) {
            }

            func (a Meters) operator ==(b Meters) bool -> a.Value == b.Value

            class Factory {
                shared {
                    func Make(v float64) Meters -> Meters{Value: v}
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumerAssemblyName = "Issue2377Emit.Consumer." + nameof(ExpressionTree_ReimportedGSharpOperator_ResolvesStaticSpecialNameMethod_AndRuns);
        var consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll");
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package App
                import Lib
                import System
                import System.Linq.Expressions

                func Predicate() Expression[Func[Meters, Meters, bool]] {
                    return (a Meters, b Meters) -> a == b
                }
                """)))
        {
            IsLibrary = true,
        };

        using (var peStream = File.Create(consumerPath))
        {
            var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: consumerAssemblyName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        var loadContext = new AssemblyLoadContext(consumerAssemblyName, isCollectible: true);
        try
        {
            var libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath);
            loadContext.Resolving += (ctx, name) => name.Name == libraryAsm.GetName().Name ? libraryAsm : null;
            var consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath);

            var programType = consumerAsm.GetTypes().Single(t => t.Name == "<Program>");
            var predicate = programType.GetMethod("Predicate", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;
            var expr = predicate.Invoke(null, null);
            var lambda = Assert.IsAssignableFrom<LambdaExpression>(expr);
            var binary = Assert.IsAssignableFrom<BinaryExpression>(lambda.Body);

            Assert.NotNull(binary.Method);
            Assert.True(binary.Method!.IsStatic);
            Assert.True(binary.Method.IsSpecialName);
            Assert.Equal("op_Equality", binary.Method.Name);

            var compiled = lambda.Compile();

            var factoryType = libraryAsm.GetTypes().Single(t => t.Name == "Factory");
            var make = factoryType.GetMethod("Make", BindingFlags.Public | BindingFlags.Static)!;
            var m5 = make.Invoke(null, new object[] { 5.0 });
            var m5b = make.Invoke(null, new object[] { 5.0 });
            var m3 = make.Invoke(null, new object[] { 3.0 });

            Assert.True((bool)compiled.DynamicInvoke(m5, m5b)!);
            Assert.False((bool)compiled.DynamicInvoke(m5, m3)!);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived()
    {
        // Inheritance control: the operator is emitted ONLY once, on the
        // open base type (matching C#'s own inherited-operator shape), and a
        // real C# consumer using a DERIVED instance still resolves it via
        // ordinary overload resolution (operators are inherited, not
        // hidden), independent of the static-shape fix.
        var libraryPath = EmitGSharpLibrary(
            nameof(InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived),
            """
            package Lib

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
            }
            """);

        var asm = Assembly.LoadFrom(libraryPath);
        var baseType = asm.GetTypes().Single(t => t.Name == "BaseVec");
        var derivedType = asm.GetTypes().Single(t => t.Name == "DerivedVec");

        var addOnBase = baseType.GetMethod("op_Addition", BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(addOnBase);
        Assert.True(addOnBase!.IsSpecialName);

        // The derived type does NOT redeclare its own op_Addition — it is
        // found purely through inheritance from BaseVec.
        Assert.Null(derivedType.GetMethod("op_Addition", BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly));

        var consumerPath = EmitCSharpConsumer(
            nameof(InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived),
            """
            using Lib;

            namespace Consumer
            {
                public static class Runner
                {
                    public static int RunAdd(DerivedVec a, DerivedVec b) => a + b;
                }
            }
            """,
            libraryPath);

        var loadContext = new AssemblyLoadContext(nameof(InheritedOperator_DeclaredOnOpenBase_EmitsOnBaseType_AndCSharpConsumerBindsThroughDerived), isCollectible: true);
        try
        {
            var libraryAsm = loadContext.LoadFromAssemblyPath(libraryPath);
            loadContext.Resolving += (ctx, name) => name.Name == libraryAsm.GetName().Name ? libraryAsm : null;
            var consumerAsm = loadContext.LoadFromAssemblyPath(consumerPath);

            var factoryType = libraryAsm.GetTypes().Single(t => t.Name == "Factory");
            var makeDerived = factoryType.GetMethod("MakeDerived", BindingFlags.Public | BindingFlags.Static)!;
            var d5 = makeDerived.Invoke(null, new object[] { 5 });
            var d7 = makeDerived.Invoke(null, new object[] { 7 });

            var runnerType = consumerAsm.GetType("Consumer.Runner")!;
            var sum = runnerType.GetMethod("RunAdd")!.Invoke(null, new[] { d5, d7 });
            Assert.Equal(12, sum);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void UndefinedOperator_OnImportedType_NegativeControl_ReportsGS0129()
    {
        // Negative control: the ClrOperatorResolution fallback must still
        // reject comparisons on an imported type with NO `==` operator at
        // all — the fix must not make every re-imported type universally
        // comparable.
        var libraryPath = EmitGSharpLibrary(
            nameof(UndefinedOperator_OnImportedType_NegativeControl_ReportsGS0129),
            """
            package Lib

            struct Plain(Value int32) {
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                """
                package App
                import Lib

                func UseEquality(a Plain, b Plain) bool {
                    return a == b
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2377Emit.NegativeControl");
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0129");
    }

    private static string EmitGSharpLibrary(string caseName, string gsharpSource)
    {
        var libraryDir = LibraryDirectory();
        var assemblyPath = Path.Combine(libraryDir, "Issue2377Emit." + caseName + ".dll");
        var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(gsharpSource))) { IsLibrary = true };

        using (var peStream = File.Create(assemblyPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2377Emit." + caseName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(assemblyPath);

        return assemblyPath;
    }

    private static string EmitCSharpConsumer(string caseName, string csharpSource, string libraryPath)
    {
        var outputDir = Path.Combine(LibraryDirectory(), caseName);
        Directory.CreateDirectory(outputDir);
        var consumerPath = Path.Combine(outputDir, "CSharpConsumer2377.dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
        references.Add(MetadataReference.CreateFromFile(libraryPath));

        var compilation = CSharpCompilation.Create(
            "CSharpConsumer2377",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(consumerPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

        return consumerPath;
    }

    private static string LibraryDirectory()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue2377Emit");
        Directory.CreateDirectory(dir);
        return dir;
    }
}
