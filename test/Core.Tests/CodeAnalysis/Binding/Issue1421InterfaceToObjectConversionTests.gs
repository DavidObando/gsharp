// <copyright file="Issue1421InterfaceToObjectConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #1421: a value of a user-declared `interface` type is
/// reference-convertible to `object` (an interface reference already IS an
/// object reference), so it must bind against an `object?` parameter such
/// as `ArgumentNullException.ThrowIfNull(object?)` — it previously failed
/// to resolve with GS0159 even though class- and slice-typed arguments worked.
/// The same implicit reference conversion also covers interface → base-interface
/// upcasts. These tests pin the binder (under both the live-reflection default
/// resolver and a MetadataLoadContext resolver) and the emitter.
open class Issue1421InterfaceToObjectConversionTests {
    @Fact
    func ThrowIfNull_OnUserInterfaceValue_BindsWithNoDiagnostics() {
        const source = `package t
import System
interface IBox { prop Type string }
func G(parent IBox) {
    ArgumentNullException.ThrowIfNull(parent)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ThrowIfNull_OnUserInterfaceValue_BindsUnderMetadataLoadContext() {
        const source = `package t
import System
interface IBox { prop Type string }
func G(parent IBox) {
    ArgumentNullException.ThrowIfNull(parent)
}`
        Assert.Empty(BindWithReferences(source))
    }

    @Fact
    func InterfaceValue_AssignedToObject_BindsWithNoDiagnostics() {
        const source = `package t
interface IBox { prop Type string }
func G(parent IBox) {
    var o object = parent
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func DerivedInterfaceValue_PassedToBaseInterfaceParameter_BindsWithNoDiagnostics() {
        const source = `package t
interface IAnimal { prop Name string }
interface IDog : IAnimal { prop Breed string }
func TakesAnimal(a IAnimal) {}
func G(d IDog) {
    TakesAnimal(d)
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func InterfaceValue_FlowsThroughObjectAndBaseInterface_AtRuntime() {
        const source = `package t
import System
interface IAnimal { prop Name string }
interface IDog : IAnimal { prop Breed string }
class Dog : IDog {
    prop Name string
    prop Breed string
}
func Describe(a IAnimal) string {
    return a.Name
}
func Main() {
    var d IDog = Dog{ Name: "Rex", Breed: "Lab" }
    ArgumentNullException.ThrowIfNull(d)
    var o object = d
    Console.WriteLine(o.ToString())
    Console.WriteLine(Describe(d))
}`
        let output = CompileLoadInvokeCaptureStdout(source, "Issue1421-InterfaceToObject")
        Assert.Contains("Rex", output)
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }

        private func BindWithReferences(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .BindGlobalScope(previous: nil, ImmutableArray.Create(tree), MetadataLoadContextResolver())
            let program = GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .BindProgram(globalScope, MetadataLoadContextResolver())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(ArgumentNullException).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let entry MethodInfo? = asm.EntryPoint
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
