// <copyright file="Issue3695NullableDelegateReturnLambdaTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3695: an arrow lambda subscribed to an imported event whose delegate
/// RETURNS a nullable reference type inferred its return type from the body's
/// first <c>return</c> and then rejected the other branch's <c>return nil</c>
/// with GS0155 — the target's declared nullability never reached lambda return
/// inference. Two independent metadata paths dropped it:
/// <list type="bullet">
/// <item><description>a closed generic handler (<c>Func&lt;int, string?&gt;</c>)
/// carries its nullability on the EVENT declaration, which
/// <c>MemberLookup.GetClrEventHandlerTypeSymbol</c> discarded while
/// substituting the handler type symbolically;</description></item>
/// <item><description>a named delegate (<c>delegate string? Resolver(int)</c>)
/// carries it on the delegate's own <c>Invoke</c> return parameter, which
/// <c>MemberLookup.TryGetDelegateFunctionType</c> ignored even though it
/// already read nullability for every PARAMETER position.</description></item>
/// </list>
/// The negative controls matter as much as the positive ones: the fix widens
/// the target return type only for an EXPLICIT <c>?</c> annotation, so an
/// unannotated/non-null delegate return must keep rejecting <c>return nil</c>,
/// and a non-null delegate PARAMETER must stay non-null (no new <c>!!</c>
/// noise at the lambda's use sites).
/// </summary>
public class Issue3695NullableDelegateReturnLambdaTests
{
    private static readonly string LibraryPath = EmitCSharpLibrary();

    [Fact]
    public void GenericFuncEvent_NullableReturn_ArrowLambdaReturnsNil_Binds()
    {
        Assert.Empty(Bind("""
            package App
            import Lib3695

            func Main() {
                let r = Resolver()
                r.Transform += (x int32) -> {
                    if x > 0 {
                        return "positive"
                    }

                    return nil
                }
            }
            """));
    }

    [Fact]
    public void GenericFuncEvent_NullableReturn_ArrowLambdaReturnsOnlyNil_Binds()
    {
        // Expression-bodied form: the lambda has no non-null candidate at all,
        // so the target return type is the ONLY source of a shape.
        Assert.Empty(Bind("""
            package App
            import Lib3695

            func Main() {
                let r = Resolver()
                r.Transform += (x int32) -> nil
            }
            """));
    }

    [Fact]
    public void StaticGenericFuncEvent_NullableReturn_ArrowLambdaReturnsNil_Binds()
    {
        // A STATIC event is reached without a symbolic receiver, so its handler
        // type comes from the reflected fallback rather than the symbolic
        // substitution — the declaration flags must be applied there too.
        Assert.Empty(Bind("""
            package App
            import Lib3695

            func Main() {
                Resolver.StaticTransform += (x int32) -> {
                    if x > 0 {
                        return "positive"
                    }

                    return nil
                }
            }
            """));
    }

    [Fact]
    public void NamedDelegateEvent_NullableReturn_ArrowLambdaReturnsNil_Binds()
    {
        Assert.Empty(Bind("""
            package App
            import Lib3695

            func Main() {
                let r = Resolver()
                r.Resolve += (x int32) -> {
                    if x > 0 {
                        return "positive"
                    }

                    return nil
                }
            }
            """));
    }

    [Fact]
    public void GenericFuncEvent_NonNullReturn_ArrowLambdaReturnsNil_ReportsDiagnostic()
    {
        // Conservatism control: `Func<int, string>` (NOT annotated nullable)
        // must still reject `return nil`.
        var diagnostics = Bind("""
            package App
            import Lib3695

            func Main() {
                let r = Resolver()
                r.Strict += (x int32) -> {
                    if x > 0 {
                        return "positive"
                    }

                    return nil
                }
            }
            """);

        Assert.NotEmpty(diagnostics);
        Assert.Contains(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void NamedDelegateEvent_NonNullReturn_ArrowLambdaReturnsNil_ReportsDiagnostic()
    {
        var diagnostics = Bind("""
            package App
            import Lib3695

            func Main() {
                let r = Resolver()
                r.ResolveStrict += (x int32) -> {
                    if x > 0 {
                        return "positive"
                    }

                    return nil
                }
            }
            """);

        Assert.NotEmpty(diagnostics);
        Assert.Contains(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void GenericFuncEvent_NonNullParameter_StaysNonNull()
    {
        // The declaration flags annotate the return position only; the
        // parameter position stays non-null, so it is dereferenced without a
        // `!!` bridge exactly as before the fix.
        Assert.Empty(Bind("""
            package App
            import Lib3695

            func Main() {
                let r = Resolver()
                r.Describe += (text string) -> text.Length.ToString()
            }
            """));
    }

    [Fact]
    public void GenericFuncEvent_NullableReturn_ArrowLambdaReturnsWrongType_StillReportsDiagnostic()
    {
        // Shape control: widening the return to `string?` must not make the
        // target return type permissive about unrelated types.
        Assert.NotEmpty(Bind("""
            package App
            import Lib3695

            func Main() {
                let r = Resolver()
                r.Transform += (x int32) -> 42
            }
            """));
    }

    private static System.Collections.Generic.IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { LibraryPath });
        var tree = GsSyntaxTree.Parse(SourceText.From(source));
        var compilation = new GsCompilation(resolver, tree);

        // Mirrors Issue2389ImportedDelegateLambdaEventTests: the imported
        // library is loaded reflection-only, so bind (and lower) the program to
        // surface body-level diagnostics without executing anything.
        return tree.Diagnostics
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToList();
    }

    private static string EmitCSharpLibrary()
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue3695Binding");
        Directory.CreateDirectory(outputDir);
        var libraryPath = Path.Combine(outputDir, "Lib3695.dll");

        const string csharpSource = """
            #nullable enable
            using System;

            namespace Lib3695
            {
                public delegate string? NullableResolver(int x);

                public delegate string StrictResolver(int x);

                public class Resolver
                {
                    public event Func<int, string?>? Transform;

                    public event Func<int, string>? Strict;

                    public event Func<string, string?>? Describe;

                    public event NullableResolver? Resolve;

                    public event StrictResolver? ResolveStrict;

                    public static event Func<int, string?>? StaticTransform;
                }
            }
            """;

        var syntaxTree = CSharpSyntaxTree.ParseText(csharpSource, new CSharpParseOptions(LanguageVersion.Latest));

        var referencePaths = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
            ?.Split(Path.PathSeparator)
            ?? Array.Empty<string>();

        var references = referencePaths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "Lib3695",
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
