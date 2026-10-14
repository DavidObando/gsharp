// <copyright file="ImportAliasTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Phase 1.4: `import alias = path` introduces an alias for the imported
/// namespace. Member access through the alias resolves to the same CLR types
/// the un-aliased import would.
open class ImportAliasTests {
    @Fact
    func Aliased_Import_Resolves_Through_Alias() {
        let diagnostics = Bind(`import sys = System

func F() {
 sys.Console.WriteLine("hi")
 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Plain_Import_Still_Works() {
        let diagnostics = Bind(`import System

func F() {
 Console.WriteLine("hi")
 }
`)
        Assert.Empty(diagnostics)
    }

    @Fact
    func Alias_Symbol_Has_Distinct_Name_And_Target() {
        let tree = SyntaxTree.Parse(SourceText.From(`import sys = System

func F() {}
`))
        Assert.Empty(tree.Diagnostics)
        let importSyntax = tree.Root.Members.OfType[ImportSyntax]().Single()
        Assert.NotNull(importSyntax.AliasIdentifier)
        Assert.Equal("sys", importSyntax.AliasIdentifier!!.Text)
        Assert.Equal("System", importSyntax.Identifiers.Single().Text)
    }

    @Fact
    func Aliased_Dotted_Path_Resolves() {
        let diagnostics = Bind(`import io = System.IO

func F() {
 io.Directory.GetCurrentDirectory()
 }
`)
        Assert.Empty(diagnostics)
    }

    /// A C# `using R = Some.Type;` alias whose target is a *type* (not a
    /// namespace) must let a bare `R.StaticMember` resolve to that type's
    /// static member. The alias target itself names the type, and the accessor's
    /// right part is a static member of it — so the member access binds without a
    /// "cannot find type R" error.
    @Fact
    func Aliased_Type_Resolves_Static_Member_Access() {
        let diagnostics = Bind(`import R = System.Console

func F() {
 R.WriteLine("hi")
 }
`)
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics.ToImmutableArray()
        }
    }
}
