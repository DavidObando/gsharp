// <copyright file="Issue2373ExpressionTreeClrComparisonEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import ExpressionsBinaryExpression = System.Linq.Expressions.BinaryExpression
import ExpressionsLambdaExpression = System.Linq.Expressions.LambdaExpression
import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.IO
import System.Linq
import System.Linq.Expressions
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2373 — real-assembly, IL-verification and runtime-execution level
/// regression coverage for `ExpressionTreeLowerer.BuildClrBinaryOperatorExpression`'s
/// comparison-factory overload-selection bug. Before the fix, lowering any
/// comparison (`==`/`!=`/`<`/`<=`/`>`/`>=`)
/// whose operand type resolved through Stream C (a CLR operator method found
/// on the operand's own type, rather than G#'s built-in operator table or a
/// same-compilation user operator) crashed with GS9998 because it requested a
/// non-existent 3-arg (cref:Expression) factory overload — the six
/// relational/equality factories only expose a 4-arg
/// `(Expression, Expression, bool liftToNull, MethodInfo)` overload.
/// Getting the lowering call to succeed was only half the fix: an entirely
/// separate, equally pre-existing emitter gap (fixed alongside this one)
/// meant the resulting (cref:MethodInfo) literal argument could never
/// actually be EMITTED — `MethodBodyEmitter.EmitLiteral` had no case for
/// a (cref:MethodInfo)-valued `BoundLiteralExpression`, so even a
/// CORRECTLY-selected overload (e.g. any arithmetic CLR operator, which
/// already had the right 3-arg overload) crashed at emission time with
/// `NotSupportedException: Literal of CLR type 'RuntimeMethodInfo' is not
/// yet supported.` Both defects had to be fixed for a real two-assembly,
/// IL-verified, runtime-executed CLR comparison operator to work at all —
/// these tests exercise the full, corrected pipeline end to end.
open class Issue2373ExpressionTreeClrComparisonEmitTests {
    @Theory
    @InlineData("==", true)
    @InlineData("!=", false)
    @InlineData("<", false)
    @InlineData("<=", true)
    @InlineData(">", false)
    @InlineData(">=", true)
    func TimeSpanComparison_IlVerifiesAndRunsCorrectly(op string, expected bool) {
        // TimeSpan is the canonical Stream C example named in
        // ClrOperatorResolution's own doc comments ("TimeSpan + TimeSpan").
        // Both operands are equal TimeSpans, so every operator's expected
        // boolean result is fixed regardless of which two equal values are
        // used.
        let source = (`package Demo
import System
import System.Linq.Expressions

func Predicate() Expression[Func[TimeSpan, bool]] {
    let other = TimeSpan.FromSeconds(5)
    return (t TimeSpan) -> t ` + "$op" + ` other
}`)
        let (asm, ctx) = CompileToAssembly(source, "TimeSpan_" + op.GetHashCode().ToString())
        try {
            let run = GetProgramMethod(asm, "Predicate")
            let expr object? = run.Invoke(nil, nil)
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](expr)
            let binary = Assert.IsAssignableFrom[ExpressionsBinaryExpression](lambda.Body)
            Assert.NotNull(binary.Method)
            Assert.Equal("System.TimeSpan", binary.Method!!.DeclaringType!!.FullName)
            Assert.False(binary.IsLiftedToNull)
            let compiled = cast[Func[TimeSpan, bool]](lambda.Compile())
            Assert.Equal(expected, compiled(TimeSpan.FromSeconds(5)))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func TimeSpanArithmetic_SiblingAudit_StillIlVerifiesAndRuns() {
        // Sibling-audit regression: the arithmetic (3-arg factory) CLR
        // operator path must be unaffected by the comparison-only overload
        // fix, but WAS affected by the separate MethodInfo-literal emission
        // gap fixed alongside it — this is real end-to-end proof that gap is
        // closed for the pre-existing (non-comparison) CLR operator paths.
        let source = `package Demo
import System
import System.Linq.Expressions

func Sum() Expression[Func[TimeSpan, TimeSpan, TimeSpan]] {
    return (a TimeSpan, b TimeSpan) -> a + b
}`
        let (asm, ctx) = CompileToAssembly(source, "TimeSpanArithmetic_SiblingAudit_StillIlVerifiesAndRuns")
        try {
            let run = GetProgramMethod(asm, "Sum")
            let expr object? = run.Invoke(nil, nil)
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](expr)
            let compiled = cast[Func[TimeSpan, TimeSpan, TimeSpan]](lambda.Compile())
            Assert.Equal(TimeSpan.FromSeconds(8), compiled(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(3)))
        } finally {
            ctx.Unload()
        }
    }

    @Theory
    @InlineData("==", false)
    @InlineData("!=", true)
    @InlineData("<", true)
    @InlineData("<=", true)
    @InlineData(">", false)
    @InlineData(">=", false)
    func ImportedAsinStrongTypedId_AllSixOperators_IlVerifiesAndRunsCorrectly(op string, expected bool) {
        // Issue #2373's actual shape, end to end: a REAL, separately
        // C#-compiled ("imported", exactly like Oahu.Diagnostics/EF Core)
        // strongly-typed-ID struct wrapping a `string` (the common EF Core
        // "Asin"-style key pattern), consumed through
        // `Expression<Func<Book, bool>>` comparing an imported entity's
        // property against a caller-supplied value of the same imported
        // type. "aaa" < "bbb" for every ordinal-ordering operator below.
        let libraryPath = EmitCSharpLibrary(
            "ImportedAsinStrongTypedId_AllSixOperators_IlVerifiesAndRunsCorrectly" + "_" + op.GetHashCode().ToString(),
            `namespace Lib
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
}`
        )
        using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
        let consumerAssemblyName = "Issue2373Emit.Consumer." + op.GetHashCode().ToString()
        let consumerPath = Path.Combine(LibraryDirectory(), consumerAssemblyName + ".dll")
        let consumer = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From((`package Demo
import Lib
import System
import System.Linq.Expressions

func Predicate(asin Asin) Expression[Func[Book, bool]] {
    return (b Book) -> b.Asin ` + "$op" + ` asin
}`)))){IsLibrary = true}
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
            let asinType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Asin")
            let bookType = libraryAsm.GetTypes().Single((t Type) -> t.Name == "Book")
            let run = GetProgramMethod(consumerAsm, "Predicate")
            let asinA object? = Activator.CreateInstance(asinType, "aaa")
            let asinB object? = Activator.CreateInstance(asinType, "bbb")
            let expr object? = run.Invoke(nil, []object{asinB})
            let lambda = Assert.IsAssignableFrom[ExpressionsLambdaExpression](expr)
            let compiled = lambda.Compile()
            let book object? = Activator.CreateInstance(bookType)
            bookType.GetProperty("Asin")!!.SetValue(book, asinA)
            let invoked object? = compiled.DynamicInvoke(book)
            Assert.Equal(expected, invoked)
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func GetProgramMethod(asm Assembly, name string) MethodInfo {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                name,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }

        private func CompileToAssembly(source string, contextName string)(asm Assembly, ctx AssemblyLoadContext) {
            let libraryDir = LibraryDirectory()
            let assemblyPath = Path.Combine(libraryDir, "Issue2373Emit." + contextName + ".dll")
            let compilation = GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
            {
                using let peStream = File.Create(assemblyPath)
                let result = compilation.Emit(
                    peStream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "Issue2373Emit." + contextName
                )
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            }
            IlVerifier.Verify(assemblyPath)
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            let asm = loadContext.LoadFromAssemblyPath(assemblyPath)
            return (asm, loadContext)
        }

        private func LibraryDirectory() string {
            let dir = Path.Combine(AppContext.BaseDirectory, "Issue2373Emit")
            Directory.CreateDirectory(dir)
            return dir
        }

        private func EmitCSharpLibrary(caseName string, csharpSource string) string {
            let outputDir = Path.Combine(LibraryDirectory(), caseName)
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "CSharpLib2373.dll")
            let syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, CSharpParseOptions(LanguageVersion.Latest))
            let referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(
                Path.PathSeparator
            ) ??
                Array.Empty[string]()
            let references = referencePaths
                .Where(File.Exists)
                .Select((p string) -> cast[MetadataReference](MetadataReference.CreateFromFile(p)))
                .ToList()
            let compilation = CSharpCompilation.Create(
                "CSharpLib2373",
                []Microsoft.CodeAnalysis.SyntaxTree{syntaxTree},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            {
                using let peStream = File.Create(libraryPath)
                let emitResult = compilation.Emit(peStream)
                Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            }
            return libraryPath
        }
    }
}
