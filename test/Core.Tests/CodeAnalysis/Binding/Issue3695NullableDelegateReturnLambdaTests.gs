// <copyright file="Issue3695NullableDelegateReturnLambdaTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis
import System.Collections.Generic

/// Issue #3695: an arrow lambda subscribed to an imported event whose delegate
/// RETURNS a nullable reference type inferred its return type from the body's
/// first `return` and then rejected the other branch's `return nil`
/// with GS0155 — the target's declared nullability never reached lambda return
/// inference. Two independent metadata paths dropped it:
/// - a closed generic handler (`Func<int, string?>`) carries its nullability on the EVENT declaration,
/// which `MemberLookup.GetClrEventHandlerTypeSymbol` discarded while substituting the handler type
/// symbolically;
/// - a named delegate (`delegate string? Resolver(int)`) carries it on the delegate's own `Invoke`
/// return parameter, which `MemberLookup.TryGetDelegateFunctionType` ignored even though it already
/// read nullability for every PARAMETER position.
/// The negative controls matter as much as the positive ones: the fix widens
/// the target return type only for an EXPLICIT `?` annotation, so an
/// unannotated/non-null delegate return must keep rejecting `return nil`,
/// and a non-null delegate PARAMETER must stay non-null (no new `!!`
/// noise at the lambda's use sites).
open class Issue3695NullableDelegateReturnLambdaTests {
    @Fact
    func GenericFuncEvent_NullableReturn_ArrowLambdaReturnsNil_Binds() {
        Assert.Empty(Bind(`package App
import Lib3695

func Main() {
    let r = Resolver()
    r.Transform += (x int32) -> {
        if x > 0 {
            return "positive"
        }

        return nil
    }
}`))
    }

    @Fact
    func GenericFuncEvent_NullableReturn_ArrowLambdaReturnsOnlyNil_Binds() {
        // Expression-bodied form: the lambda has no non-null candidate at all,
        // so the target return type is the ONLY source of a shape.
        Assert.Empty(Bind(`package App
import Lib3695

func Main() {
    let r = Resolver()
    r.Transform += (x int32) -> nil
}`))
    }

    @Fact
    func StaticGenericFuncEvent_NullableReturn_ArrowLambdaReturnsNil_Binds() {
        // A STATIC event is reached without a symbolic receiver, so its handler
        // type comes from the reflected fallback rather than the symbolic
        // substitution — the declaration flags must be applied there too.
        Assert.Empty(Bind(`package App
import Lib3695

func Main() {
    Resolver.StaticTransform += (x int32) -> {
        if x > 0 {
            return "positive"
        }

        return nil
    }
}`))
    }

    @Fact
    func NamedDelegateEvent_NullableReturn_ArrowLambdaReturnsNil_Binds() {
        Assert.Empty(Bind(`package App
import Lib3695

func Main() {
    let r = Resolver()
    r.Resolve += (x int32) -> {
        if x > 0 {
            return "positive"
        }

        return nil
    }
}`))
    }

    @Fact
    func GenericFuncEvent_NonNullReturn_ArrowLambdaReturnsNil_ReportsDiagnostic() {
        // Conservatism control: `Func<int, string>` (NOT annotated nullable)
        // must still reject `return nil`.
        let diagnostics = Bind(`package App
import Lib3695

func Main() {
    let r = Resolver()
    r.Strict += (x int32) -> {
        if x > 0 {
            return "positive"
        }

        return nil
    }
}`)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func NamedDelegateEvent_NonNullReturn_ArrowLambdaReturnsNil_ReportsDiagnostic() {
        let diagnostics = Bind(`package App
import Lib3695

func Main() {
    let r = Resolver()
    r.ResolveStrict += (x int32) -> {
        if x > 0 {
            return "positive"
        }

        return nil
    }
}`)
        Assert.NotEmpty(diagnostics)
        Assert.Contains(diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func GenericFuncEvent_NonNullParameter_StaysNonNull() {
        // The declaration flags annotate the return position only; the
        // parameter position stays non-null, so it is dereferenced without a
        // `!!` bridge exactly as before the fix.
        Assert.Empty(Bind(`package App
import Lib3695

func Main() {
    let r = Resolver()
    r.Describe += (text string) -> text.Length.ToString()
}`))
    }

    @Fact
    func GenericFuncEvent_NullableReturn_ArrowLambdaReturnsWrongType_StillReportsDiagnostic() {
        // Shape control: widening the return to `string?` must not make the
        // target return type permissive about unrelated types.
        Assert.NotEmpty(Bind(`package App
import Lib3695

func Main() {
    let r = Resolver()
    r.Transform += (x int32) -> 42
}`))
    }

    shared {
        private let LibraryPath string = EmitCSharpLibrary()

        private func Bind(source string) IReadOnlyList[GSharp.Core.CodeAnalysis.Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{LibraryPath})
            let tree = GsSyntaxTree.Parse(SourceText.From(source))
            let compilation = GsCompilation(resolver, tree)
            // Mirrors Issue2389ImportedDelegateLambdaEventTests: the imported
            // library is loaded reflection-only, so bind (and lower) the program to
            // surface body-level diagnostics without executing anything.
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .ToList()
        }

        private func EmitCSharpLibrary() string {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue3695Binding")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Lib3695.dll")
            const csharpSource = `#nullable enable
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
}`
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
                "Lib3695",
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
