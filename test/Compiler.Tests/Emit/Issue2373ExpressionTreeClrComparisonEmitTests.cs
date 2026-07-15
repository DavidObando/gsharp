// <copyright file="Issue2373ExpressionTreeClrComparisonEmitTests.cs" company="GSharp">
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
/// Issue #2373 — real-assembly, IL-verification and runtime-execution level
/// regression coverage for <c>ExpressionTreeLowerer.BuildClrBinaryOperatorExpression</c>'s
/// comparison-factory overload-selection bug. Before the fix, lowering any
/// comparison (<c>==</c>/<c>!=</c>/<c>&lt;</c>/<c>&lt;=</c>/<c>&gt;</c>/<c>&gt;=</c>)
/// whose operand type resolved through Stream C (a CLR operator method found
/// on the operand's own type, rather than G#'s built-in operator table or a
/// same-compilation user operator) crashed with GS9998 because it requested a
/// non-existent 3-arg <see cref="Expression"/> factory overload — the six
/// relational/equality factories only expose a 4-arg
/// <c>(Expression, Expression, bool liftToNull, MethodInfo)</c> overload.
/// Getting the lowering call to succeed was only half the fix: an entirely
/// separate, equally pre-existing emitter gap (fixed alongside this one)
/// meant the resulting <see cref="MethodInfo"/> literal argument could never
/// actually be EMITTED — <c>MethodBodyEmitter.EmitLiteral</c> had no case for
/// a <see cref="MethodInfo"/>-valued <c>BoundLiteralExpression</c>, so even a
/// CORRECTLY-selected overload (e.g. any arithmetic CLR operator, which
/// already had the right 3-arg overload) crashed at emission time with
/// <c>NotSupportedException: Literal of CLR type 'RuntimeMethodInfo' is not
/// yet supported.</c> Both defects had to be fixed for a real two-assembly,
/// IL-verified, runtime-executed CLR comparison operator to work at all —
/// these tests exercise the full, corrected pipeline end to end.
/// </summary>
public class Issue2373ExpressionTreeClrComparisonEmitTests
{
    [Theory]
    [InlineData("==", true)]
    [InlineData("!=", false)]
    [InlineData("<", false)]
    [InlineData("<=", true)]
    [InlineData(">", false)]
    [InlineData(">=", true)]
    public void TimeSpanComparison_IlVerifiesAndRunsCorrectly(string op, bool expected)
    {
        // TimeSpan is the canonical Stream C example named in
        // ClrOperatorResolution's own doc comments ("TimeSpan + TimeSpan").
        // Both operands are equal TimeSpans, so every operator's expected
        // boolean result is fixed regardless of which two equal values are
        // used.
        var source = $$"""
            package Demo
            import System
            import System.Linq.Expressions

            func Predicate() Expression[Func[TimeSpan, bool]] {
                let other = TimeSpan.FromSeconds(5)
                return (t TimeSpan) -> t {{op}} other
            }
            """;

        var (asm, ctx) = CompileToAssembly(source, "TimeSpan_" + op.GetHashCode());
        try
        {
            var run = GetProgramMethod(asm, "Predicate");
            var expr = run.Invoke(null, null);
            var lambda = Assert.IsAssignableFrom<LambdaExpression>(expr);

            var binary = Assert.IsAssignableFrom<BinaryExpression>(lambda.Body);
            Assert.NotNull(binary.Method);
            Assert.Equal("System.TimeSpan", binary.Method!.DeclaringType!.FullName);
            Assert.False(binary.IsLiftedToNull);

            var compiled = (Func<TimeSpan, bool>)lambda.Compile();
            Assert.Equal(expected, compiled(TimeSpan.FromSeconds(5)));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void TimeSpanArithmetic_SiblingAudit_StillIlVerifiesAndRuns()
    {
        // Sibling-audit regression: the arithmetic (3-arg factory) CLR
        // operator path must be unaffected by the comparison-only overload
        // fix, but WAS affected by the separate MethodInfo-literal emission
        // gap fixed alongside it — this is real end-to-end proof that gap is
        // closed for the pre-existing (non-comparison) CLR operator paths.
        var source = """
            package Demo
            import System
            import System.Linq.Expressions

            func Sum() Expression[Func[TimeSpan, TimeSpan, TimeSpan]] {
                return (a TimeSpan, b TimeSpan) -> a + b
            }
            """;

        var (asm, ctx) = CompileToAssembly(source, nameof(TimeSpanArithmetic_SiblingAudit_StillIlVerifiesAndRuns));
        try
        {
            var run = GetProgramMethod(asm, "Sum");
            var expr = run.Invoke(null, null);
            var lambda = Assert.IsAssignableFrom<LambdaExpression>(expr);
            var compiled = (Func<TimeSpan, TimeSpan, TimeSpan>)lambda.Compile();
            Assert.Equal(TimeSpan.FromSeconds(8), compiled(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(3)));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Theory]
    [InlineData("==", false)]
    [InlineData("!=", true)]
    [InlineData("<", true)]
    [InlineData("<=", true)]
    [InlineData(">", false)]
    [InlineData(">=", false)]
    public void ImportedAsinStrongTypedId_AllSixOperators_IlVerifiesAndRunsCorrectly(string op, bool expected)
    {
        // Issue #2373's actual shape, end to end: a REAL, separately
        // C#-compiled ("imported", exactly like Oahu.Diagnostics/EF Core)
        // strongly-typed-ID struct wrapping a `string` (the common EF Core
        // "Asin"-style key pattern), consumed through
        // `Expression<Func<Book, bool>>` comparing an imported entity's
        // property against a caller-supplied value of the same imported
        // type. "aaa" < "bbb" for every ordinal-ordering operator below.
        var libraryPath = EmitCSharpLibrary(
            nameof(ImportedAsinStrongTypedId_AllSixOperators_IlVerifiesAndRunsCorrectly) + "_" + op.GetHashCode(),
            """
            namespace Lib
            {
                public readonly struct Asin
                {
                    public string Value { get; }
                    public Asin(string value) => Value = value;
                    public static bool operator ==(Asin a, Asin b) => a.Value == b.Value;
                    public static bool operator !=(Asin a, Asin b) => a.Value != b.Value;
                    public static bool operator <(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) < 0;
                    public static bool operator <=(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) <= 0;
                    public static bool operator >(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) > 0;
                    public static bool operator >=(Asin a, Asin b) => string.CompareOrdinal(a.Value, b.Value) >= 0;
                    public override bool Equals(object obj) => obj is Asin o && o.Value == Value;
                    public override int GetHashCode() => Value?.GetHashCode() ?? 0;
                }

                public class Book
                {
                    public Asin Asin { get; set; }
                }
            }
            """);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });
        var consumerAssemblyName = "Issue2373Emit.Consumer." + op.GetHashCode();
        var consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll");
        var consumer = new GsCompilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                $$"""
                package Demo
                import Lib
                import System
                import System.Linq.Expressions

                func Predicate(asin Asin) Expression[Func[Book, bool]] {
                    return (b Book) -> b.Asin {{op}} asin
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

            var asinType = libraryAsm.GetTypes().Single(t => t.Name == "Asin");
            var bookType = libraryAsm.GetTypes().Single(t => t.Name == "Book");

            var run = GetProgramMethod(consumerAsm, "Predicate");
            var asinA = Activator.CreateInstance(asinType, "aaa");
            var asinB = Activator.CreateInstance(asinType, "bbb");

            var expr = run.Invoke(null, new[] { asinB });
            var lambda = Assert.IsAssignableFrom<LambdaExpression>(expr);
            var compiled = lambda.Compile();

            var book = Activator.CreateInstance(bookType);
            bookType.GetProperty("Asin")!.SetValue(book, asinA);

            var invoked = compiled.DynamicInvoke(book);
            Assert.Equal(expected, invoked);
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static MethodInfo GetProgramMethod(Assembly asm, string name)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
    }

    private static (Assembly asm, AssemblyLoadContext ctx) CompileToAssembly(string source, string contextName)
    {
        var libraryDir = LibraryDirectory();
        var assemblyPath = Path.Combine(libraryDir, "Issue2373Emit." + contextName + ".dll");
        var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };

        using (var peStream = File.Create(assemblyPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2373Emit." + contextName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(assemblyPath);

        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        var asm = loadContext.LoadFromAssemblyPath(assemblyPath);
        return (asm, loadContext);
    }

    private static string LibraryDirectory()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue2373Emit");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string EmitCSharpLibrary(string caseName, string csharpSource)
    {
        var outputDir = Path.Combine(LibraryDirectory(), caseName);
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "CSharpLib2373.dll");

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "CSharpLib2373",
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using (var peStream = File.Create(libraryPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        return libraryPath;
    }
}
